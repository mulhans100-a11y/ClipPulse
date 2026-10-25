import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { runCommand } from './ffmpeg';
import type { AudioAnalysis, AudioOnset, BeatGridPoint, BpmHypothesis, EnergySection, MeterEstimate, MusicStructureEvent, TempoSegment } from './types';

const SAMPLE_RATE = 11_025;
const FFT_SIZE = 2_048;
const HOP_SAMPLES = 256; // about 23 ms
// The positive half of the centered FFT window contains the samples after its nominal center.
const ONSET_TIME_CORRECTION_SECONDS = FFT_SIZE / (2 * SAMPLE_RATE);
const AUDIO_ANALYSIS_METHOD: AudioAnalysis['method'] = 'spectral-flux-adaptive-beat-v5';
const FFT_WINDOW = Float64Array.from({ length: FFT_SIZE }, (_value, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (FFT_SIZE - 1)));
const FFT_BIT_REVERSE = makeBitReverseTable(FFT_SIZE);
const FFT_STAGES = makeFftStages(FFT_SIZE);

/**
 * Decode audio to mono PCM, derive a spectrally weighted onset-strength curve,
 * then track a tempo-tolerant beat grid. Per-beat and per-tempo confidence
 * values are comparative signal scores, not calibrated probabilities.
 */
export async function analyzeAudio(filePath: string, cacheFilePath?: string): Promise<AudioAnalysis> {
  const source = path.resolve(filePath);
  const sourceStat = await fs.stat(source);
  if (cacheFilePath) {
    const cached = await readCachedAudioAnalysis(source, cacheFilePath, sourceStat.size, sourceStat.mtimeMs);
    if (cached) return cached;
  }
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openmontage-audio-'));
  const pcmPath = path.join(temporaryDirectory, 'analysis.pcm');
  try {
    await decodePcm(source, pcmPath);
    const onsetData = await buildOnsetEnvelope(pcmPath);
    const onsetEnvelope = onsetData.transients;
    if (onsetEnvelope.length < 25) throw new AppError('AUDIO_TOO_SHORT', 'Audio is too short for beat analysis.');
    const hopSeconds = HOP_SAMPLES / SAMPLE_RATE;
    const pulseHypotheses = findBpmHypotheses(onsetEnvelope, hopSeconds);
    const best = pulseHypotheses[0];
    const rawTempoSegments = best ? estimateTempoSegments(onsetEnvelope, hopSeconds, best.bpm) : [];
    const trackedBeats = best ? trackAdaptiveBeatGrid(onsetEnvelope, hopSeconds, rawTempoSegments, best.bpm, onsetData.rms, onsetData.bassEnergy) : [];
    const beats = trackedBeats.map((beat) => beat.timeSeconds);
    const periodSeconds = best ? 60 / best.bpm : undefined;
    const phase = beats[0] === undefined || periodSeconds === undefined
      ? undefined
      : beats[0] % periodSeconds;
    const firstBeatIndex = beats[0] === undefined || periodSeconds === undefined ? 0 : Math.floor(beats[0] / periodSeconds);
    const meter = estimateMeter(onsetData.rms, onsetData.bassEnergy, beats, hopSeconds, periodSeconds, trackedBeats.map((beat) => beat.strength));
    const tempoScale = meter?.denominator === 8 && meter.confidence >= 0.72 ? 0.5 : 1;
    const bpmHypotheses = pulseHypotheses.map((hypothesis) => ({ ...hypothesis, bpm: roundBpm(hypothesis.bpm * tempoScale) }));
    const beatGrid: BeatGridPoint[] = trackedBeats.map((beat) => ({
      timeSeconds: beat.timeSeconds,
      index: beat.index,
      confidence: beat.confidence,
      strength: beat.strength,
      downbeat: meter ? modulo(beat.index + firstBeatIndex, meter.beatsPerBar) === meter.downbeatPhase : false
    }));
    const downbeats = beatGrid.filter((beat) => beat.downbeat).map((beat) => beat.timeSeconds);
    const energyCurve = normalizeEnergy(onsetData.energyBySecond);
    const energySections = findEnergySections(energyCurve);
    const onsetPeaks = findOnsetPeaks(onsetEnvelope, hopSeconds);
    const onsets = onsetPeaks.map((onset) => onset.timeSeconds);
    const onsetEvents: AudioOnset[] = onsetPeaks.map((onset) => ({ ...onset, confidence: Number((0.25 + onset.strength * 0.7).toFixed(3)) }));
    const accentEvents = findAccents(beatGrid, onsetPeaks);
    const accents = accentEvents.map((accent) => accent.timeSeconds);
    const structureEvents = findMusicStructureEvents(energyCurve, onsetData.energyBySecond, energySections, accentEvents);
    const drops = structureEvents.filter((event) => event.type === 'drop').map((event) => event.timeSeconds);
    const tempoSegments: TempoSegment[] = rawTempoSegments.map((segment) => ({ ...segment, bpm: roundBpm(segment.bpm * tempoScale) }));
    const result: AudioAnalysis = {
      method: AUDIO_ANALYSIS_METHOD,
      sampleRate: SAMPLE_RATE,
      hopSeconds,
      durationSeconds: onsetEnvelope.length * hopSeconds,
      estimatedBpm: bpmHypotheses[0]?.bpm,
      bpmHypotheses,
      beatPhaseSeconds: phase,
      beats,
      beatGrid,
      tempoSegments,
      ...(meter ? { meter } : {}),
      downbeats,
      energyHopSeconds: 1,
      energyCurve,
      energySections,
      drops,
      onsets,
      onsetEvents,
      accents,
      structureEvents
    };
    if (cacheFilePath) {
      await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
      const tempCache = `${cacheFilePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempCache, `${JSON.stringify({ sourceSizeBytes: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs, analysis: result }, null, 2)}\n`);
      await fs.rename(tempCache, cacheFilePath).catch(async (error) => {
        await fs.rm(tempCache, { force: true });
        throw error;
      });
    }
    return result;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function readCachedAudioAnalysis(filePath: string, cacheFilePath: string, sourceSizeBytes?: number, sourceMtimeMs?: number): Promise<AudioAnalysis | null> {
  try {
    const sourceStat = sourceSizeBytes === undefined || sourceMtimeMs === undefined ? await fs.stat(filePath) : undefined;
    const cached = JSON.parse(await fs.readFile(cacheFilePath, 'utf8')) as { sourceSizeBytes: number; sourceMtimeMs: number; analysis: AudioAnalysis };
    if (cached.sourceSizeBytes !== (sourceSizeBytes ?? sourceStat!.size) || cached.sourceMtimeMs !== (sourceMtimeMs ?? sourceStat!.mtimeMs)) return null;
    if (cached.analysis?.method !== AUDIO_ANALYSIS_METHOD || !Array.isArray(cached.analysis.beats) || !Array.isArray(cached.analysis.onsets) || !Array.isArray(cached.analysis.downbeats) || !Array.isArray(cached.analysis.energyCurve) || !Array.isArray(cached.analysis.beatGrid) || !Array.isArray(cached.analysis.tempoSegments) || !Array.isArray(cached.analysis.onsetEvents) || !Array.isArray(cached.analysis.structureEvents)) return null;
    return cached.analysis;
  } catch { return null; }
}

function decodePcm(source: string, output: string): Promise<void> {
  return runCommand('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', source,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-y', output
    ]).then(() => undefined).catch((error) => {
      if (error instanceof AppError && error.code === 'FFMPEG_NOT_FOUND') throw error;
      throw new AppError('AUDIO_DECODE_FAILED', `Could not decode audio from ${source}. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
}

async function buildOnsetEnvelope(pcmPath: string): Promise<{ transients: Float64Array; rms: Float64Array; bassEnergy: Float64Array; energyBySecond: number[] }> {
  const novelty: number[] = [];
  const rmsLevels: number[] = [];
  const bassLevels: number[] = [];
  const energyBySecond: number[] = [];
  const ring = new Float64Array(FFT_SIZE);
  const previousSpectrum = new Float64Array(FFT_SIZE / 2 + 1);
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  let writeIndex = 0;
  let totalSamples = 0;
  let previousLogRms = 0;
  let hasPreviousSpectrum = false;
  let pending = Buffer.alloc(0);
  let secondEnergy = 0;
  let secondSamples = 0;
  for await (const chunk of createReadStream(pcmPath)) {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const completeBytes = data.length - (data.length % 2);
    const completeSamples = completeBytes / 2;
    for (let i = 0; i < completeSamples; i++) {
      consumeSample(data.readInt16LE(i * 2) / 32768, true);
    }
    pending = completeBytes < data.length ? data.subarray(completeBytes) : Buffer.alloc(0);
  }
  if (secondSamples) energyBySecond.push(Math.sqrt(secondEnergy / secondSamples));

  // Zero padding completes centered FFT frames up to the final source sample.
  for (let index = 0; index < FFT_SIZE / 2; index++) consumeSample(0, false);
  return { transients: normalizeNovelty(novelty, HOP_SAMPLES / SAMPLE_RATE), rms: Float64Array.from(rmsLevels), bassEnergy: Float64Array.from(bassLevels), energyBySecond };

  function consumeSample(sample: number, includeInEnergy: boolean): void {
    ring[writeIndex] = sample;
    writeIndex = (writeIndex + 1) % FFT_SIZE;
    totalSamples++;
    if (includeInEnergy) {
      secondEnergy += sample * sample;
      secondSamples++;
      if (secondSamples === SAMPLE_RATE) {
        energyBySecond.push(Math.sqrt(secondEnergy / secondSamples));
        secondEnergy = 0;
        secondSamples = 0;
      }
    }
    if (totalSamples < FFT_SIZE / 2 || (totalSamples - FFT_SIZE / 2) % HOP_SAMPLES !== 0) return;

    let frameEnergy = 0;
    for (let index = 0; index < FFT_SIZE; index++) {
      const value = ring[(writeIndex + index) % FFT_SIZE] * FFT_WINDOW[index];
      real[index] = value;
      imaginary[index] = 0;
      frameEnergy += value * value;
    }
    fft(real, imaginary);
    let spectralFlux = 0;
    let spectralMass = 0;
    let bassMass = 0;
    for (let bin = 1; bin <= FFT_SIZE / 2; bin++) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]);
      const compressed = Math.sqrt(magnitude);
      if (hasPreviousSpectrum) spectralFlux += Math.max(0, compressed - previousSpectrum[bin]);
      spectralMass += compressed;
      if (bin <= 64) bassMass += magnitude;
      previousSpectrum[bin] = compressed;
    }
    const rms = Math.sqrt(frameEnergy / FFT_SIZE);
    const logRms = Math.log1p(rms * 100);
    const rmsRise = hasPreviousSpectrum ? Math.max(0, logRms - previousLogRms) : 0;
    novelty.push((hasPreviousSpectrum ? spectralFlux / Math.max(spectralMass, 1e-8) : 0) + 0.35 * rmsRise);
    rmsLevels.push(rms);
    bassLevels.push(Math.log1p(bassMass / FFT_SIZE));
    previousLogRms = logRms;
    hasPreviousSpectrum = true;
  }
}

interface TrackedBeat {
  timeSeconds: number;
  index: number;
  confidence: number;
  strength: number;
}

/** Estimate a short-time pulse curve so a single global BPM cannot dominate an entire song. */
function estimateTempoSegments(envelope: Float64Array, hopSeconds: number, fallbackBpm: number): TempoSegment[] {
  const duration = envelope.length * hopSeconds;
  if (!duration) return [];
  const windowSeconds = Math.min(8, duration);
  if (duration < 5.5 || !Number.isFinite(fallbackBpm)) {
    return [{ startSeconds: 0, endSeconds: duration, bpm: fallbackBpm, confidence: 0.35 }];
  }
  const strideSeconds = 2;
  const centers: number[] = [];
  if (duration <= windowSeconds) centers.push(duration / 2);
  else {
    for (let center = windowSeconds / 2; center <= duration - windowSeconds / 2; center += strideSeconds) centers.push(center);
    if (centers[centers.length - 1] < duration - windowSeconds / 2) centers.push(duration - windowSeconds / 2);
  }
  const samples: Array<{ center: number; bpm: number; confidence: number }> = [];
  for (const center of centers) {
    const start = Math.max(0, center - windowSeconds / 2);
    const end = Math.min(duration, center + windowSeconds / 2);
    const first = Math.max(0, Math.floor(start / hopSeconds));
    const last = Math.min(envelope.length, Math.ceil(end / hopSeconds));
    const local = envelope.slice(first, last);
    const hypotheses = findBpmHypotheses(local, hopSeconds);
    if (!hypotheses.length) continue;
    const priorBpm = samples[samples.length - 1]?.bpm ?? fallbackBpm;
    const top = hypotheses[0];
    const runner = hypotheses[1];
    const chosen = hypotheses.reduce((best, candidate) => {
      const continuityPenalty = Math.min(0.12, Math.abs(Math.log2(candidate.bpm / priorBpm)) * 0.035);
      const bestPenalty = Math.min(0.12, Math.abs(Math.log2(best.bpm / priorBpm)) * 0.035);
      return candidate.score - continuityPenalty > best.score - bestPenalty ? candidate : best;
    }, top);
    const margin = runner ? Math.max(0, top.score - runner.score) : Math.max(0, top.score);
    const confidence = clamp(0.25 + Math.max(-0.2, top.score) * 0.38 + Math.min(0.5, margin) * 0.55, 0.08, 0.96);
    samples.push({ center, bpm: chosen.bpm, confidence });
  }
  if (!samples.length) return [{ startSeconds: 0, endSeconds: duration, bpm: fallbackBpm, confidence: 0.35 }];
  if (samples[0].center > 0) samples.unshift({ ...samples[0], center: 0 });
  if (samples[samples.length - 1].center < duration) samples.push({ ...samples[samples.length - 1], center: duration });

  // Median smoothing removes isolated half/double-tempo jumps while preserving clear changes.
  const smoothed = samples.map((sample, index) => {
    const adjacent = samples.slice(Math.max(0, index - 1), Math.min(samples.length, index + 2));
    const bpmValues = adjacent.map((item) => item.bpm).sort((a, b) => a - b);
    const medianBpm = bpmValues[Math.floor(bpmValues.length / 2)];
    const differsByChange = adjacent.some((item) => Math.abs(Math.log2(item.bpm / sample.bpm)) > 0.28);
    return { ...sample, bpm: differsByChange ? sample.bpm : medianBpm };
  });
  const segments: TempoSegment[] = [];
  for (let index = 0; index < smoothed.length - 1; index++) {
    const current = smoothed[index], next = smoothed[index + 1];
    const startSeconds = Math.max(0, current.center);
    const endSeconds = Math.min(duration, next.center);
    if (endSeconds <= startSeconds) continue;
    const previous = segments[segments.length - 1];
    if (previous && Math.abs(Math.log2(previous.bpm / current.bpm)) < 0.035) {
      const oldDuration = previous.endSeconds - previous.startSeconds;
      const addedDuration = endSeconds - startSeconds;
      previous.bpm = (previous.bpm * oldDuration + current.bpm * addedDuration) / (oldDuration + addedDuration);
      previous.confidence = (previous.confidence * oldDuration + current.confidence * addedDuration) / (oldDuration + addedDuration);
      previous.endSeconds = endSeconds;
    } else segments.push({ startSeconds, endSeconds, bpm: current.bpm, confidence: current.confidence });
  }
  if (!segments.length) segments.push({ startSeconds: 0, endSeconds: duration, bpm: fallbackBpm, confidence: 0.35 });
  segments[0].startSeconds = 0;
  segments[segments.length - 1].endSeconds = duration;
  return segments;
}

/** Dynamic-program a beat path against local tempo periods, allowing gradual tempo drift and changes. */
function trackAdaptiveBeatGrid(envelope: Float64Array, hopSeconds: number, tempoSegments: TempoSegment[], fallbackBpm: number, _rms: Float64Array, _bassEnergy: Float64Array): TrackedBeat[] {
  if (envelope.length < 2 || !Number.isFinite(fallbackBpm) || fallbackBpm <= 0) return [];
  const segmentAt = (time: number) => tempoSegments.find((item) => time >= item.startSeconds && time < item.endSeconds) ?? tempoSegments[time < 0 ? 0 : tempoSegments.length - 1];
  const periodFramesAt = (frame: number): number => {
    const segment = segmentAt(frame * hopSeconds);
    const bpm = clamp(segment?.bpm ?? fallbackBpm, 40, 300);
    return 60 / bpm / hopSeconds;
  };
  const scores = new Float64Array(envelope.length);
  const previous = new Int32Array(envelope.length).fill(-1);
  let bestEnd = -1, bestScore = -Infinity;
  for (let index = 0; index < envelope.length; index++) {
    const period = periodFramesAt(index);
    const minGap = Math.max(1, Math.floor(period * 0.68));
    const maxGap = Math.ceil(period * 1.48);
    let score = envelope[index];
    const firstPrevious = Math.max(0, index - maxGap);
    const lastPrevious = index - minGap;
    for (let prior = firstPrevious; prior <= lastPrevious; prior++) {
      const ratio = (index - prior) / period;
      const penalty = 2.4 * Math.log2(ratio) ** 2;
      const candidate = scores[prior] + envelope[index] - penalty;
      if (candidate > score) { score = candidate; previous[index] = prior; }
    }
    scores[index] = score;
    if (score > bestScore) { bestScore = score; bestEnd = index; }
  }
  const path: number[] = [];
  for (let cursor = bestEnd; cursor >= 0; cursor = previous[cursor]) path.push(cursor);
  path.reverse();
  if (path.length < 3) return [];
  const beats: TrackedBeat[] = [];
  for (let position = 0; position < path.length; position++) {
    const predicted = path[position];
    const gap = position === 0 ? periodFramesAt(predicted) : predicted - path[position - 1];
    const radius = Math.max(1, Math.round(Math.min(periodFramesAt(predicted) * 0.1, gap * 0.2)));
    let strongest = predicted;
    for (let index = Math.max(0, predicted - radius); index <= Math.min(envelope.length - 1, predicted + radius); index++) if (envelope[index] > envelope[strongest]) strongest = index;
    const timeSeconds = Number((strongest * hopSeconds + ONSET_TIME_CORRECTION_SECONDS).toFixed(4));
    if (beats.length && timeSeconds <= beats[beats.length - 1].timeSeconds + hopSeconds * 2) continue;
    const segment = segmentAt(timeSeconds);
    const intervalFit = position === 0 ? 0.5 : 1 - Math.min(1, Math.abs(Math.log2(Math.max(1, gap) / periodFramesAt(predicted))));
    const strength = clamp(envelope[strongest] / 0.72, 0, 1);
    const confidence = clamp(0.18 + (segment?.confidence ?? 0.35) * 0.35 + strength * 0.35 + intervalFit * 0.12, 0.05, 0.98);
    beats.push({ timeSeconds, index: beats.length, confidence: Number(confidence.toFixed(3)), strength: Number(strength.toFixed(3)) });
  }
  return beats;
}

function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }

function findOnsetPeaks(envelope: Float64Array, hopSeconds: number): Array<{ timeSeconds: number; strength: number }> {
  const average = envelope.reduce((sum, value) => sum + value, 0) / Math.max(1, envelope.length);
  const peak = envelope.reduce((max, value) => Math.max(max, value), 0);
  if (peak < 1e-5) return [];
  const threshold = Math.max(average * 2.25, peak * 0.08, 0.015);
  const onsets: Array<{ timeSeconds: number; strength: number }> = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    if (envelope[i] >= threshold && envelope[i] >= envelope[i - 1] && envelope[i] > envelope[i + 1]) {
      const timeSeconds = Number((i * hopSeconds + ONSET_TIME_CORRECTION_SECONDS).toFixed(4));
      if (!onsets.length || timeSeconds - onsets[onsets.length - 1].timeSeconds >= 0.08) {
        const strength = clamp((envelope[i] - threshold) / Math.max(peak - threshold, 1e-8), 0, 1);
        onsets.push({ timeSeconds, strength });
      }
    }
  }
  return onsets;
}

function findAccents(beatGrid: BeatGridPoint[], onsets: Array<{ timeSeconds: number; strength: number }>): Array<{ timeSeconds: number; strength: number; confidence: number }> {
  const beatStrengths = beatGrid.map((beat) => beat.strength).sort((a, b) => a - b);
  const percentile = (fraction: number) => beatStrengths[Math.min(beatStrengths.length - 1, Math.floor(beatStrengths.length * fraction))] ?? 0;
  const beatMedian = percentile(0.5), beatHigh = percentile(0.9), beatContrast = beatHigh - beatMedian;
  // Keep accent anchors sparse; lower-strength transients remain available in onsetEvents.
  const candidates = [
    ...(beatContrast >= 0.08 ? beatGrid.filter((beat) => beat.strength >= beatMedian + beatContrast * 0.65 && beat.strength >= 0.55).map((beat) => ({ timeSeconds: beat.timeSeconds, strength: beat.strength, confidence: clamp((beat.strength - beatMedian) / Math.max(beatContrast, 0.08) * beat.confidence, 0, 0.98) })) : []),
    ...onsets.filter((onset) => onset.strength >= 0.82).map((onset) => ({ ...onset, confidence: onset.strength * 0.8 }))
  ].sort((a, b) => a.timeSeconds - b.timeSeconds || b.strength - a.strength);
  const merged: typeof candidates = [];
  for (const candidate of candidates) {
    const prior = merged[merged.length - 1];
    if (prior && candidate.timeSeconds - prior.timeSeconds < 0.12) {
      if (candidate.strength > prior.strength) merged[merged.length - 1] = candidate;
    } else merged.push(candidate);
  }
  return merged;
}

function findMusicStructureEvents(curve: number[], rawEnergy: number[], sections: EnergySection[], accents: Array<{ timeSeconds: number; strength: number; confidence: number }>): MusicStructureEvent[] {
  const events: MusicStructureEvent[] = [];
  const positiveEnergy = rawEnergy.filter((value) => value > 1e-5).sort((a, b) => a - b);
  const referenceEnergy = positiveEnergy[Math.floor((positiveEnergy.length - 1) * 0.75)] ?? 0;
  const quietThreshold = referenceEnergy * 0.22;
  let quietStart: number | undefined;
  for (let index = 0; index <= rawEnergy.length; index++) {
    const quiet = index < rawEnergy.length && referenceEnergy > 1e-5 && rawEnergy[index] <= quietThreshold;
    if (quiet && quietStart === undefined) quietStart = index;
    if ((!quiet || index === rawEnergy.length) && quietStart !== undefined) {
      const end = index;
      if (end - quietStart >= 2) {
        const mean = rawEnergy.slice(quietStart, end).reduce((sum, value) => sum + value, 0) / (end - quietStart);
        events.push({ type: 'quiet', timeSeconds: quietStart, endSeconds: end, confidence: clamp(0.55 + 0.45 * (1 - mean / Math.max(quietThreshold, 1e-5)), 0, 0.98), strength: clamp(1 - mean / Math.max(referenceEnergy, 1e-5), 0, 1), signals: ['source RMS below 22% of upper-quartile level'] });
      }
      quietStart = undefined;
    }
  }
  for (let index = 1; index < sections.length; index++) {
    const previous = sections[index - 1], current = sections[index];
    if (previous.level !== current.level) {
      const change = current.meanEnergy - previous.meanEnergy;
      events.push({ type: 'section_change', timeSeconds: current.startSeconds, confidence: clamp(0.45 + Math.abs(change) * 0.8, 0, 0.9), strength: clamp(Math.abs(change), 0, 1), signals: [`energy ${previous.level}-to-${current.level}`] });
    }
  }
  for (let index = 4; index + 1 < curve.length; index++) {
    const before = curve.slice(index - 4, index).reduce((sum, value) => sum + value, 0) / 4;
    const after = (curve[index] + curve[index + 1]) / 2;
    const rise = after - before;
    if (rise >= 0.28 && after >= 0.62 && before <= 0.58 && !events.some((event) => event.type === 'drop' && Math.abs(event.timeSeconds - index) < 4)) {
      events.push({ type: 'drop', timeSeconds: index, confidence: clamp(0.5 + rise * 0.8, 0, 0.96), strength: clamp(rise, 0, 1), signals: ['four-second energy rise', ...(accents.some((accent) => Math.abs(accent.timeSeconds - index) <= 1) ? ['nearby strong accent'] : [])] });
    }
  }
  for (let end = 4; end <= curve.length; end++) {
    const start = end - 4;
    const before = (curve[start] + curve[start + 1]) / 2;
    const after = (curve[end - 2] + curve[end - 1]) / 2;
    const rise = after - before;
    const increasingSteps = curve.slice(start + 1, end).filter((value, index) => value >= curve[start + index] - 0.04).length;
    const nearDrop = events.some((event) => event.type === 'drop' && Math.abs(event.timeSeconds - end) <= 1.5);
    const nearBuildUp = events.some((event) => event.type === 'build_up' && event.endSeconds !== undefined && Math.abs(event.endSeconds - end) <= 2);
    // Require a low-energy starting point to avoid labeling later energy fluctuations as builds.
    if (rise >= 0.12 && before <= 0.58 && after >= 0.52 && increasingSteps >= 2 && !nearDrop && !nearBuildUp) {
      events.push({ type: 'build_up', timeSeconds: start, endSeconds: end, confidence: clamp(0.42 + rise * 0.75, 0, 0.9), strength: clamp(rise, 0, 1), signals: ['four-second sustained relative-energy increase'] });
    }
  }
  for (const accent of accents) events.push({ type: 'strong_accent', timeSeconds: accent.timeSeconds, confidence: accent.confidence, strength: accent.strength, signals: ['high onset or beat-grid strength'] });
  return events.sort((a, b) => a.timeSeconds - b.timeSeconds || a.type.localeCompare(b.type));
}

function makeBitReverseTable(size: number): Uint32Array {
  const bits = Math.log2(size);
  return Uint32Array.from({ length: size }, (_value, index) => {
    let source = index, reversed = 0;
    for (let bit = 0; bit < bits; bit++) { reversed = (reversed << 1) | (source & 1); source >>>= 1; }
    return reversed;
  });
}

function makeFftStages(size: number): Array<{ half: number; cos: Float64Array; sin: Float64Array }> {
  const stages = [];
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    stages.push({
      half,
      cos: Float64Array.from({ length: half }, (_value, index) => Math.cos(2 * Math.PI * index / width)),
      sin: Float64Array.from({ length: half }, (_value, index) => -Math.sin(2 * Math.PI * index / width))
    });
  }
  return stages;
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  for (let index = 0; index < real.length; index++) {
    const reversed = FFT_BIT_REVERSE[index];
    if (reversed <= index) continue;
    const realValue = real[index], imaginaryValue = imaginary[index];
    real[index] = real[reversed]; imaginary[index] = imaginary[reversed];
    real[reversed] = realValue; imaginary[reversed] = imaginaryValue;
  }
  for (let stageIndex = 0, width = 2; width <= real.length; stageIndex++, width *= 2) {
    const stage = FFT_STAGES[stageIndex];
    for (let base = 0; base < real.length; base += width) {
      for (let offset = 0; offset < stage.half; offset++) {
        const even = base + offset, odd = even + stage.half;
        const oddReal = real[odd] * stage.cos[offset] - imaginary[odd] * stage.sin[offset];
        const oddImaginary = real[odd] * stage.sin[offset] + imaginary[odd] * stage.cos[offset];
        const evenReal = real[even], evenImaginary = imaginary[even];
        real[even] = evenReal + oddReal;
        imaginary[even] = evenImaginary + oddImaginary;
        real[odd] = evenReal - oddReal;
        imaginary[odd] = evenImaginary - oddImaginary;
      }
    }
  }
}

function normalizeNovelty(raw: number[], hopSeconds: number): Float64Array {
  if (!raw.length) return new Float64Array();
  const radius = Math.max(1, Math.round(0.75 / hopSeconds));
  const prefix = new Float64Array(raw.length + 1);
  raw.forEach((value, index) => { prefix[index + 1] = prefix[index] + value; });
  const residual = raw.map((value, index) => {
    const start = Math.max(0, index - radius), end = Math.min(raw.length, index + radius + 1);
    const baseline = (prefix[end] - prefix[start]) / (end - start);
    return Math.max(0, value - baseline * 0.8);
  });
  const sorted = [...residual].sort((a, b) => a - b);
  const scale = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || residual.reduce((maximum, value) => Math.max(maximum, value), 1e-8);
  return Float64Array.from(residual, (value) => Math.min(2, value / scale));
}

function estimateMeter(rms: Float64Array, bassEnergy: Float64Array, beats: number[], hopSeconds: number, periodSeconds?: number, beatStrengths: number[] = []): MeterEstimate | undefined {
  if (beats.length < 12) return undefined;
  const localPeaks = (values: Float64Array) => beats.map((beat) => {
    const center = Math.round(beat / hopSeconds);
    let strongest = 0;
    for (let index = Math.max(0, center - 2); index <= Math.min(values.length - 1, center + 2); index++) strongest = Math.max(strongest, values[index]);
    return strongest;
  });
  const robustZ = (values: number[]) => {
    const baseline = values.reduce((sum, value) => sum + Math.max(0, value), 0) / Math.max(1, values.length);
    const logged = values.map((value) => Math.log1p(Math.max(0, value) / Math.max(baseline, 1e-8)));
    const mean = logged.reduce((sum, value) => sum + value, 0) / logged.length;
    const deviation = Math.sqrt(logged.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logged.length);
    // Do not amplify small window-alignment differences into apparent bar accents.
    return deviation < 0.04 ? logged.map(() => 0) : logged.map((value) => Math.max(-2.5, Math.min(2.5, (value - mean) / deviation)));
  };
  const rmsAccent = robustZ(localPeaks(rms));
  const bassAccent = robustZ(localPeaks(bassEnergy));
  // Onset novelty can drift between neighboring frames as beat periods fall
  // between FFT hops, so bar accents rely on measured energy instead.
  const onsetAccent = beatStrengths.length === beats.length ? robustZ(beatStrengths) : beats.map(() => 0);
  const strengths = beats.map((_beat, index) => 0.45 * bassAccent[index] + 0.3 * rmsAccent[index] + 0.25 * onsetAccent[index]);
  const candidates: Array<{ beatsPerBar: number; phase: number; score: number }> = [];
  for (let beatsPerBar = 2; beatsPerBar <= 12; beatsPerBar++) {
    const bars = strengths.length / beatsPerBar;
    if (bars < 3) continue;
    const sums = Array.from({ length: beatsPerBar }, () => 0);
    const counts = Array.from({ length: beatsPerBar }, () => 0);
    strengths.forEach((strength, index) => { sums[index % beatsPerBar] += strength; counts[index % beatsPerBar]++; });
    const profile = sums.map((sum, index) => sum / Math.max(1, counts[index]));
    const mean = profile.reduce((sum, value) => sum + value, 0) / profile.length;
    const variance = profile.reduce((sum, value) => sum + (value - mean) ** 2, 0) / profile.length;
    const deviation = Math.sqrt(variance);
    if (deviation < 0.15) continue;
    const relativePhase = profile.indexOf(Math.max(...profile));
    const firstBeatIndex = periodSeconds && beats[0] !== undefined ? Math.floor(beats[0] / periodSeconds) : 0;
    const phase = (relativePhase + firstBeatIndex) % beatsPerBar;
    const otherMean = (profile.reduce((sum, value) => sum + value, 0) - profile[relativePhase]) / (profile.length - 1);
    const contrast = (profile[relativePhase] - otherMean) / Math.max(0.2, deviation);
    // Two-beat cycles are often a subcycle of stronger 4/4 accents.
    candidates.push({ beatsPerBar, phase, score: contrast * Math.min(1, Math.sqrt(bars / 6)) - (beatsPerBar === 2 ? 0.3 : 0) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0], runnerUp = candidates[1];
  if (!best || best.score < 0.45 || (runnerUp && best.score - runnerUp.score < 0.12)) return undefined;
  const denominator = [5, 6, 7, 9, 10, 11, 12].includes(best.beatsPerBar) ? 8 : 4;
  return { beatsPerBar: best.beatsPerBar, denominator, downbeatPhase: best.phase, confidence: Math.max(0, Math.min(1, best.score / (best.score + 1))) };
}

function normalizeEnergy(raw: number[]): number[] {
  if (!raw.length) return [];
  const ordered = [...raw].sort((a, b) => a - b);
  const low = ordered[Math.floor((ordered.length - 1) * 0.1)];
  const high = ordered[Math.ceil((ordered.length - 1) * 0.9)];
  const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const deviation = Math.sqrt(raw.reduce((sum, value) => sum + (value - mean) ** 2, 0) / raw.length);
  if (high - low < 1e-4 || deviation / Math.max(mean, 1e-4) < 0.15) return raw.map(() => 0.5);
  return raw.map((value) => Math.max(0, Math.min(1, (value - low) / (high - low))));
}

function findEnergySections(curve: number[]): EnergySection[] {
  if (!curve.length) return [];
  const blockSize = 4;
  const blocks: Array<{ start: number; end: number; energy: number }> = [];
  for (let start = 0; start < curve.length; start += blockSize) {
    const end = Math.min(curve.length, start + blockSize);
    const values = curve.slice(start, end);
    blocks.push({ start, end, energy: values.reduce((sum, value) => sum + value, 0) / values.length });
  }
  const values = blocks.map((block) => block.energy).sort((a, b) => a - b);
  const low = values[Math.floor((values.length - 1) / 3)];
  const high = values[Math.ceil((values.length - 1) * 2 / 3)];
  const levelOf = (energy: number): EnergySection['level'] => high - low < 1e-6 ? 'medium' : energy <= low ? 'low' : energy >= high ? 'high' : 'medium';
  const sections: EnergySection[] = [];
  for (const block of blocks) {
    const level = levelOf(block.energy);
    const previous = sections[sections.length - 1];
    if (previous?.level === level) {
      const oldDuration = previous.endSeconds - previous.startSeconds;
      const blockDuration = block.end - block.start;
      previous.meanEnergy = (previous.meanEnergy * oldDuration + block.energy * blockDuration) / (oldDuration + blockDuration);
      previous.endSeconds = block.end;
    } else sections.push({ startSeconds: block.start, endSeconds: block.end, level, meanEnergy: block.energy });
  }
  return sections;
}

function findBpmHypotheses(envelope: Float64Array, hopSeconds: number): BpmHypothesis[] {
  const minLag = Math.max(1, Math.ceil(60 / (300 * hopSeconds)));
  const maxLag = Math.min(envelope.length - 2, Math.floor(60 / (40 * hopSeconds)));
  if (maxLag <= minLag) return [];
  const mean = envelope.reduce((sum, value) => sum + value, 0) / envelope.length;
  const centered = Float64Array.from(envelope, (value) => value - mean);
  const energy = centered.reduce((sum, value) => sum + value * value, 0);
  if (energy < 1e-8) return [];
  const correlationMaxLag = Math.min(envelope.length - 2, maxLag * 2);
  const correlation = new Float64Array(correlationMaxLag + 2);
  for (let lag = 1; lag <= correlationMaxLag; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let index = lag; index < centered.length; index++) {
      const a = centered[index], b = centered[index - lag];
      xy += a * b; xx += a * a; yy += b * b;
    }
    correlation[lag] = xx && yy ? xy / Math.sqrt(xx * yy) : 0;
  }
  const correlationAt = (lag: number) => {
    const lower = Math.max(1, Math.floor(lag)), fraction = lag - lower;
    const smooth = (index: number) => (correlation[index - 1] + 2 * correlation[index] + correlation[index + 1]) / 4;
    return smooth(lower) * (1 - fraction) + smooth(lower + 1) * fraction;
  };
  const candidates: Array<{ bpm: number; score: number }> = [];
  const candidateLags = new Set<number>();
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (correlation[lag] <= 0 || correlation[lag] < correlation[lag - 1] || correlation[lag] < correlation[lag + 1]) continue;
    candidateLags.add(lag);
    candidateLags.add(Math.round(lag / 2));
    candidateLags.add(Math.round(lag * 2 / 3));
    candidateLags.add(Math.round(lag * 2));
  }
  for (const lag of candidateLags) {
    if (lag < minLag || lag > maxLag) continue;
    const bpm = 60 / (lag * hopSeconds);
    const baseScore = correlationAt(lag);
    const subdivisionEvidence = Math.max(0, correlationAt(lag / 2), correlationAt(lag * 2 / 3), correlationAt(lag * 3 / 4));
    const tempoPrior = 0.22 * Math.exp(-0.5 * (Math.log2(bpm / 112) / 0.6) ** 2);
    const score = baseScore - 0.42 * subdivisionEvidence + tempoPrior;
    const left = correlation[lag - 1], center = correlation[lag], right = correlation[lag + 1];
    const curvature = left - 2 * center + right;
    const offset = Math.abs(curvature) < 1e-8 ? 0 : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / curvature));
    candidates.push({ bpm: roundBpm(60 / ((lag + offset) * hopSeconds)), score: Number(score.toFixed(4)) });
  }
  candidates.sort((a, b) => b.score - a.score || Math.abs(Math.log2(a.bpm / 112)) - Math.abs(Math.log2(b.bpm / 112)));
  const selected: BpmHypothesis[] = [];
  for (const candidate of candidates) {
    if (selected.every((item) => Math.abs(item.bpm - candidate.bpm) > Math.max(3, candidate.bpm * 0.035))) selected.push(candidate);
    if (selected.length === 5) break;
  }
  return selected;
}

function roundBpm(value: number): number { return Number(value.toFixed(1)); }
