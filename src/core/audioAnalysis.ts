import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors';
import type { AudioAnalysis, BpmHypothesis, EnergySection, MeterEstimate } from './types';

const SAMPLE_RATE = 11_025;
const WINDOW_SAMPLES = 220; // about 20 ms

/**
 * Decode audio to a small mono PCM stream, then estimate rhythmic energy
 * transients and BPM locally. Scores are comparative autocorrelation values,
 * not calibrated probabilities; ambiguous music should keep multiple options.
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
    const hopSeconds = WINDOW_SAMPLES / SAMPLE_RATE;
    const bpmHypotheses = findBpmHypotheses(onsetEnvelope, hopSeconds);
    const best = bpmHypotheses[0];
    const phase = best ? findBeatPhase(onsetEnvelope, 60 / best.bpm / hopSeconds) : undefined;
    const beats = best && phase !== undefined
      ? refineBeatPositions(onsetEnvelope, phase, 60 / best.bpm / hopSeconds, hopSeconds)
      : [];
    const meter = estimateMeter(onsetData.rms, beats, hopSeconds);
    const downbeats = meter ? beats.filter((_beat, index) => index % meter.beatsPerBar === meter.downbeatPhase) : [];
    const energyCurve = normalizeEnergy(onsetData.energyBySecond);
    const energySections = findEnergySections(energyCurve);
    const drops = findEnergyDrops(energyCurve);
    const onsets = pickOnsets(onsetEnvelope, hopSeconds);
    const result: AudioAnalysis = {
      method: 'rms-onset-autocorrelation-v2',
      sampleRate: SAMPLE_RATE,
      hopSeconds,
      durationSeconds: onsetEnvelope.length * hopSeconds,
      estimatedBpm: best?.bpm,
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
    if (cached.analysis?.method !== 'rms-onset-autocorrelation-v2' || !Array.isArray(cached.analysis.beats) || !Array.isArray(cached.analysis.onsets) || !Array.isArray(cached.analysis.downbeats) || !Array.isArray(cached.analysis.energyCurve)) return null;
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

async function buildOnsetEnvelope(pcmPath: string): Promise<{ transients: Float64Array; rms: Float64Array; energyBySecond: number[] }> {
  const transients: number[] = [];
  const rmsLevels: number[] = [];
  const energyBySecond: number[] = [];
  let pending = Buffer.alloc(0);
  let energy = 0;
  let samples = 0;
  let secondEnergy = 0;
  let secondSamples = 0;
  let previousRms = 0;
  for await (const chunk of createReadStream(pcmPath)) {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const completeBytes = data.length - (data.length % 2);
    const completeSamples = completeBytes / 2;
    for (let i = 0; i < completeSamples; i++) {
      const sample = data.readInt16LE(i * 2) / 32768;
      energy += sample * sample;
      samples++;
      secondEnergy += sample * sample;
      secondSamples++;
      if (secondSamples === SAMPLE_RATE) {
        energyBySecond.push(Math.sqrt(secondEnergy / secondSamples));
        secondEnergy = 0;
        secondSamples = 0;
      }
      if (samples === WINDOW_SAMPLES) {
        const rms = Math.sqrt(energy / samples);
        const logRms = Math.log1p(rms * 100);
        transients.push(Math.max(0, logRms - Math.log1p(previousRms * 100)));
        rmsLevels.push(rms);
        previousRms = rms;
        energy = 0;
        samples = 0;
      }
    }
    pending = completeBytes < data.length ? data.subarray(completeBytes) : Buffer.alloc(0);
  }
  if (secondSamples) energyBySecond.push(Math.sqrt(secondEnergy / secondSamples));
  return { transients: Float64Array.from(transients), rms: Float64Array.from(rmsLevels), energyBySecond };
}

function estimateMeter(rms: Float64Array, beats: number[], hopSeconds: number): MeterEstimate | undefined {
  if (beats.length < 12) return undefined;
  const strengths = beats.map((beat) => {
    const center = Math.round(beat / hopSeconds);
    let strongest = 0;
    for (let index = Math.max(0, center - 2); index <= Math.min(rms.length - 1, center + 2); index++) strongest = Math.max(strongest, rms[index]);
    return strongest;
  });
  const candidates: Array<{ beatsPerBar: number; phase: number; score: number }> = [];
  for (let beatsPerBar = 2; beatsPerBar <= 6; beatsPerBar++) {
    const bars = strengths.length / beatsPerBar;
    if (bars < 3) continue;
    const sums = Array.from({ length: beatsPerBar }, () => 0);
    const counts = Array.from({ length: beatsPerBar }, () => 0);
    strengths.forEach((strength, index) => { sums[index % beatsPerBar] += strength; counts[index % beatsPerBar]++; });
    const profile = sums.map((sum, index) => sum / Math.max(1, counts[index]));
    const mean = profile.reduce((sum, value) => sum + value, 0) / profile.length;
    if (mean < 1e-5) continue;
    const variance = profile.reduce((sum, value) => sum + (value - mean) ** 2, 0) / profile.length;
    const confidence = Math.sqrt(variance) / mean;
    const phase = profile.indexOf(Math.max(...profile));
    candidates.push({ beatsPerBar, phase, score: confidence * Math.min(1, Math.sqrt(bars / 6)) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0], runnerUp = candidates[1];
  if (!best || best.score < 0.16 || (runnerUp && best.score - runnerUp.score < 0.035)) return undefined;
  return { beatsPerBar: best.beatsPerBar, denominator: 4, downbeatPhase: best.phase, confidence: Math.min(1, best.score) };
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
  const minLag = Math.max(1, Math.floor(60 / (200 * hopSeconds)));
  const maxLag = Math.min(envelope.length - 2, Math.ceil(60 / (60 * hopSeconds)));
  const scores: BpmHypothesis[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = lag; i < envelope.length; i++) {
      const x = envelope[i];
      const y = envelope[i - lag];
      xy += x * y;
      xx += x * x;
      yy += y * y;
    }
    if (xx === 0 || yy === 0) continue;
    const score = xy / Math.sqrt(xx * yy);
    scores.push({ bpm: roundBpm(60 / (lag * hopSeconds)), score: Number(score.toFixed(4)) });
  }
  scores.sort((a, b) => b.score - a.score || b.bpm - a.bpm);
  const selected: BpmHypothesis[] = [];
  for (const candidate of scores) {
    if (selected.every((item) => Math.abs(item.bpm - candidate.bpm) > 4)) selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}

function findBeatPhase(envelope: Float64Array, period: number): number {
  const maxPhase = Math.ceil(period);
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < maxPhase; phase++) {
    let score = 0;
    for (let beat = phase; beat < envelope.length; beat += period) {
      const center = Math.round(beat);
      for (let offset = -1; offset <= 1; offset++) {
        const index = center + offset;
        if (index >= 0 && index < envelope.length) score += envelope[index] * (offset === 0 ? 1 : 0.5);
      }
    }
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  return bestPhase;
}

function refineBeatPositions(envelope: Float64Array, phase: number, period: number, hopSeconds: number): number[] {
  const beats: number[] = [];
  for (let predicted = phase; predicted < envelope.length; predicted += period) {
    const center = Math.round(predicted);
    let strongest = center;
    for (let index = Math.max(0, center - 2); index <= Math.min(envelope.length - 1, center + 2); index++) {
      if (envelope[index] > envelope[strongest]) strongest = index;
    }
    const seconds = Number((strongest * hopSeconds).toFixed(4));
    if (!beats.length || seconds - beats[beats.length - 1] > hopSeconds) beats.push(seconds);
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
