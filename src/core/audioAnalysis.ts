import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import type { AudioAnalysis, BpmHypothesis, EnergySection, MeterEstimate } from './types';

const SAMPLE_RATE = 11_025;
const FFT_SIZE = 2_048;
const HOP_SAMPLES = 256; // about 23 ms
const FFT_WINDOW = Float64Array.from({ length: FFT_SIZE }, (_value, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (FFT_SIZE - 1)));
const FFT_BIT_REVERSE = makeBitReverseTable(FFT_SIZE);
const FFT_STAGES = makeFftStages(FFT_SIZE);

/**
 * Decode audio to mono PCM, derive a spectrally weighted onset-strength curve,
 * then track a tempo-tolerant beat path locally. Scores are comparative
 * autocorrelation values, not calibrated probabilities.
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
    const beats = best ? trackBeats(onsetEnvelope, 60 / best.bpm / hopSeconds, hopSeconds) : [];
    const phase = beats[0] === undefined ? undefined : beats[0] / hopSeconds;
    const meter = estimateMeter(onsetData.rms, onsetData.bassEnergy, onsetEnvelope, beats, hopSeconds);
    const tempoScale = meter?.denominator === 8 ? 0.5 : 1;
    const bpmHypotheses = pulseHypotheses.map((hypothesis) => ({ ...hypothesis, bpm: roundBpm(hypothesis.bpm * tempoScale) }));
    const downbeats = meter ? beats.filter((_beat, index) => index % meter.beatsPerBar === meter.downbeatPhase) : [];
    const energyCurve = normalizeEnergy(onsetData.energyBySecond);
    const energySections = findEnergySections(energyCurve);
    const drops = findEnergyDrops(energyCurve);
    const onsets = pickOnsets(onsetEnvelope, hopSeconds);
    const result: AudioAnalysis = {
      method: 'spectral-flux-dynamic-beat-v4',
      sampleRate: SAMPLE_RATE,
      hopSeconds,
      durationSeconds: onsetEnvelope.length * hopSeconds,
      estimatedBpm: bpmHypotheses[0]?.bpm,
      bpmHypotheses,
      beatPhaseSeconds: phase === undefined ? undefined : phase * hopSeconds,
      beats,
      ...(meter ? { meter } : {}),
      downbeats,
      energyHopSeconds: 1,
      energyCurve,
      energySections,
      drops,
      onsets
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
    if (cached.analysis?.method !== 'spectral-flux-dynamic-beat-v4' || !Array.isArray(cached.analysis.beats) || !Array.isArray(cached.analysis.onsets) || !Array.isArray(cached.analysis.downbeats) || !Array.isArray(cached.analysis.energyCurve)) return null;
    return cached.analysis;
  } catch { return null; }
}

function decodePcm(source: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', source,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-y', output
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.on('error', (error) => reject(new AppError('AUDIO_DECODE_FAILED', `Could not start FFmpeg for audio analysis: ${error.message}`, { cause: error })));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new AppError('AUDIO_DECODE_FAILED', `Could not decode audio from ${source}. ${stderr.trim()}`));
    });
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

function estimateMeter(rms: Float64Array, bassEnergy: Float64Array, onset: Float64Array, beats: number[], hopSeconds: number): MeterEstimate | undefined {
  if (beats.length < 12) return undefined;
  const localPeaks = (values: Float64Array) => beats.map((beat) => {
    const center = Math.round(beat / hopSeconds);
    let strongest = 0;
    for (let index = Math.max(0, center - 2); index <= Math.min(values.length - 1, center + 2); index++) strongest = Math.max(strongest, values[index]);
    return strongest;
  });
  const robustZ = (values: number[]) => {
    const logged = values.map((value) => Math.log1p(Math.max(0, value)));
    const mean = logged.reduce((sum, value) => sum + value, 0) / logged.length;
    const deviation = Math.sqrt(logged.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logged.length);
    return deviation < 1e-5 ? logged.map(() => 0) : logged.map((value) => Math.max(-2.5, Math.min(2.5, (value - mean) / deviation)));
  };
  const rmsAccent = robustZ(localPeaks(rms));
  const bassAccent = robustZ(localPeaks(bassEnergy));
  const onsetAccent = robustZ(localPeaks(onset));
  const strengths = beats.map((_beat, index) => 0.5 * bassAccent[index] + 0.3 * rmsAccent[index] + 0.2 * onsetAccent[index]);
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
    const phase = profile.indexOf(Math.max(...profile));
    const otherMean = (profile.reduce((sum, value) => sum + value, 0) - profile[phase]) / (profile.length - 1);
    const contrast = (profile[phase] - otherMean) / Math.max(0.2, deviation);
    candidates.push({ beatsPerBar, phase, score: contrast * Math.min(1, Math.sqrt(bars / 6)) - (beatsPerBar === 2 ? 0.05 : 0) });
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

function findEnergyDrops(curve: number[]): number[] {
  const drops: number[] = [];
  for (let index = 4; index + 1 < curve.length; index++) {
    const before = curve.slice(index - 4, index).reduce((sum, value) => sum + value, 0) / 4;
    const after = (curve[index] + curve[index + 1]) / 2;
    if (before < 0.35 && after - before >= 0.35 && (!drops.length || index - drops[drops.length - 1] >= 4)) drops.push(index);
  }
  return drops;
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

function trackBeats(envelope: Float64Array, period: number, hopSeconds: number): number[] {
  if (envelope.length < 2 || !Number.isFinite(period) || period < 2) return [];
  const scores = new Float64Array(envelope.length);
  const previous = new Int32Array(envelope.length).fill(-1);
  const minGap = Math.max(1, Math.floor(period * 0.68));
  const maxGap = Math.ceil(period * 1.48);
  let bestEnd = -1, bestScore = -Infinity;
  for (let index = 0; index < envelope.length; index++) {
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
  const beats: number[] = [];
  for (let position = 0; position < path.length; position++) {
    const predicted = path[position];
    const gap = position === 0 ? period : path[position] - path[position - 1];
    const radius = Math.max(1, Math.round(Math.min(period * 0.1, gap * 0.2)));
    let strongest = predicted;
    for (let index = Math.max(0, predicted - radius); index <= Math.min(envelope.length - 1, predicted + radius); index++) {
      if (envelope[index] > envelope[strongest]) strongest = index;
    }
    const seconds = Number((strongest * hopSeconds).toFixed(4));
    if (!beats.length || seconds - beats[beats.length - 1] > hopSeconds * 2) beats.push(seconds);
  }
  return beats;
}

function pickOnsets(envelope: Float64Array, hopSeconds: number): number[] {
  const average = envelope.reduce((sum, value) => sum + value, 0) / Math.max(1, envelope.length);
  const peak = envelope.reduce((max, value) => Math.max(max, value), 0);
  if (peak < 1e-5) return [];
  const threshold = Math.max(average * 2.25, peak * 0.08, 0.015);
  const onsets: number[] = [];
  for (let i = 1; i < envelope.length - 1; i++) {
    if (envelope[i] >= threshold && envelope[i] >= envelope[i - 1] && envelope[i] > envelope[i + 1]) {
      const seconds = Number((i * hopSeconds).toFixed(4));
      if (!onsets.length || seconds - onsets[onsets.length - 1] >= 0.08) onsets.push(seconds);
    }
  }
  return onsets;
}

function roundBpm(value: number): number { return Number(value.toFixed(1)); }
