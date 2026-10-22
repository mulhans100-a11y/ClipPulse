import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors';
import { runCommand } from './ffmpeg';
import { findExecutable } from './analysisRuntimes';
import { gameRuleCacheKey, loadGameRuleProfiles, matchGameEvent } from './gameRules';
import type { AudioAnalysis, AnalysisEvent, AnalysisEventKind, DetectorModality, DetectorProvenance, DetectorRunStatus, HighlightAnalysis, HighlightScoringWeights } from './types';

export interface DetectorContext {
  mediaId: string;
  mediaPath: string;
  mediaKind: 'video' | 'audio';
  durationSeconds: number;
  game?: string;
  audioAnalysis?: AudioAnalysis;
  audioAnalysisError?: string;
}

export interface DetectorProposal {
  kind: AnalysisEventKind;
  startSeconds: number;
  decisiveSeconds: number;
  endSeconds: number;
  confidence: number;
  interestingness: number;
  evidence: Record<string, string | number | boolean>;
}

/** Extension point for deterministic local, model-backed, or game-specific detectors. */
export interface DetectorPlugin {
  id: string;
  version: string;
  modality: DetectorModality;
  cacheKey?(): Promise<string>;
  checkAvailability?(context: DetectorContext): Promise<{ available: boolean; message?: string }>;
  detect(context: DetectorContext): Promise<DetectorProposal[]>;
}

export const HIGHLIGHT_SCORE_WEIGHTS: HighlightScoringWeights = { confidence: 0.5, interestingness: 0.35, corroboration: 0.15 };

export const builtInDetectors: DetectorPlugin[] = [
  {
    id: 'openmontage.audio-activity', version: '1.0.0', modality: 'audio',
    async detect(context) {
      const analysis = context.audioAnalysis;
      if (!analysis) return [];
      const proposals: DetectorProposal[] = [];
      let lastSelected = -Infinity;
      for (const time of analysis.onsets) {
        if (time - lastSelected < 2.5) continue;
        lastSelected = time;
        const energyIndex = Math.min(analysis.energyCurve.length - 1, Math.floor(time / analysis.energyHopSeconds));
        const localEnergy = energyIndex >= 0 ? analysis.energyCurve[energyIndex] : 0.5;
        const nearbyTransients = analysis.onsets.filter((onset) => Math.abs(onset - time) <= 0.45).length;
        proposals.push({
          kind: 'audio_activity',
          startSeconds: Math.max(0, time - 0.65), decisiveSeconds: time,
          endSeconds: Math.min(context.durationSeconds, time + 1.1),
          confidence: 0.55,
          interestingness: clamp(0.3 + localEnergy * 0.35 + Math.min(nearbyTransients, 4) * 0.06),
          evidence: { nearbyTransients, relativeEnergy: round(localEnergy), analysisMethod: analysis.method }
        });
      }
      return proposals;
    }
  },
  {
    id: 'openmontage.ffmpeg-scene-change', version: '1.0.0', modality: 'video',
    async detect(context) {
      if (context.mediaKind !== 'video') return [];
      return detectSceneChanges(context.mediaPath, context.durationSeconds);
    }
  },
  {
    id: 'openmontage.frame-difference-motion', version: '1.0.0', modality: 'video',
    async detect(context) {
      if (context.mediaKind !== 'video') return [];
      return detectMotionActivity(context.mediaPath, context.durationSeconds);
    }
  },
  {
    id: 'openmontage.tesseract-hud-ocr', version: '1.0.0', modality: 'text',
    async cacheKey() {
      const executable = await findExecutable('tesseract');
      if (!executable) return `${await gameRuleCacheKey()}#tesseract-missing`;
      try {
        const { stdout, stderr } = await runCommand(executable, ['--version']);
        return `${await gameRuleCacheKey()}#${`${stdout}\n${stderr}`.split(/\r?\n/)[0]}`;
      } catch { return `${await gameRuleCacheKey()}#tesseract-unavailable`; }
    },
    async checkAvailability(context) {
      if (context.mediaKind !== 'video') return { available: false, message: 'Video media is required for frame OCR.' };
      const executable = await findExecutable('tesseract');
      return executable
        ? { available: true }
        : { available: false, message: 'Tesseract is not installed or is not on PATH; OCR was skipped.' };
    },
    async detect(context) {
      if (context.mediaKind !== 'video') return [];
      return detectHudText(context.mediaPath, context.durationSeconds, context.game);
    }
  }
];

export async function analyzeHighlightCues(
  context: DetectorContext,
  cacheFilePath?: string,
  detectors: DetectorPlugin[] = builtInDetectors,
  scoreWeights: HighlightScoringWeights = HIGHLIGHT_SCORE_WEIGHTS
): Promise<HighlightAnalysis> {
  validateWeights(scoreWeights);
  const source = await fs.stat(context.mediaPath);
  const key = await detectorKey(detectors, scoreWeights, context);
  if (cacheFilePath) {
    const cached = await readCachedHighlightAnalysis(context.mediaPath, cacheFilePath, detectors, scoreWeights, context, key);
    if (cached) return cached;
  }

  const warnings: string[] = [];
  const statuses: DetectorRunStatus[] = [];
  const proposals: Array<{ proposal: DetectorProposal; provenance: DetectorProvenance }> = [];
  for (const detector of detectors) {
    if ((detector.modality === 'audio' && !context.audioAnalysis) || ((detector.modality === 'video' || detector.modality === 'text') && context.mediaKind !== 'video')) {
      const failed = detector.modality === 'audio' && !!context.audioAnalysisError;
      const message = failed ? context.audioAnalysisError : detector.modality === 'audio' ? 'Audio analysis is unavailable.' : 'Video media is required.';
      statuses.push({ detectorId: detector.id, version: detector.version, modality: detector.modality, status: failed ? 'failed' : 'skipped', message });
      if (failed && message) warnings.push(`${detector.id}: ${message}`);
      continue;
    }
    try {
      const availability = await detector.checkAvailability?.(context);
      if (availability && !availability.available) {
        statuses.push({ detectorId: detector.id, version: detector.version, modality: detector.modality, status: 'skipped', message: availability.message ?? 'Detector runtime is unavailable.' });
        continue;
      }
      const detected = await detector.detect(context);
      statuses.push({ detectorId: detector.id, version: detector.version, modality: detector.modality, status: 'complete' });
      for (const proposal of detected) {
        const normalized = normalizeProposal(proposal, context.durationSeconds);
        proposals.push({ proposal: normalized, provenance: {
          detectorId: detector.id, version: detector.version, modality: detector.modality,
          confidence: normalized.confidence, evidence: normalized.evidence
        } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push({ detectorId: detector.id, version: detector.version, modality: detector.modality, status: 'failed', message });
      warnings.push(`${detector.id}: ${message}`);
    }
  }

  const events = rankProposals(context.mediaId, proposals, scoreWeights);
  const result: HighlightAnalysis = {
    method: 'heuristic-detector-pipeline-v1',
    durationSeconds: context.durationSeconds,
    scoreWeights: { ...scoreWeights },
    detectors: statuses,
    warnings,
    events
  };
  if (cacheFilePath && !statuses.some((status) => status.status === 'failed')) {
    await fs.mkdir(path.dirname(cacheFilePath), { recursive: true });
    const temporaryPath = `${cacheFilePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify({ sourceSizeBytes: source.size, sourceMtimeMs: source.mtimeMs, detectorKey: key, analysis: result }, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, cacheFilePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new AppError('ANALYSIS_CACHE_WRITE_FAILED', `Could not save highlight analysis cache: ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}

export async function readCachedHighlightAnalysis(filePath: string, cacheFilePath: string, detectors: DetectorPlugin[] = builtInDetectors, scoreWeights: HighlightScoringWeights = HIGHLIGHT_SCORE_WEIGHTS, context?: DetectorContext, cacheKeyOverride?: string): Promise<HighlightAnalysis | null> {
  try {
    validateWeights(scoreWeights);
    const [source, raw] = await Promise.all([fs.stat(filePath), fs.readFile(cacheFilePath, 'utf8')]);
    const cached = JSON.parse(raw) as { sourceSizeBytes: number; sourceMtimeMs: number; detectorKey: string; analysis: HighlightAnalysis };
    if (cached.sourceSizeBytes !== source.size || cached.sourceMtimeMs !== source.mtimeMs || cached.detectorKey !== (cacheKeyOverride ?? await detectorKey(detectors, scoreWeights, context))) return null;
    if (cached.analysis?.method !== 'heuristic-detector-pipeline-v1' || !Array.isArray(cached.analysis.events) || !Array.isArray(cached.analysis.detectors)) return null;
    return cached.analysis;
  } catch { return null; }
}

async function detectSceneChanges(filePath: string, durationSeconds: number): Promise<DetectorProposal[]> {
  const args = [
    '-hide_banner', '-nostats', '-i', filePath,
    '-vf', "scale=320:180:force_original_aspect_ratio=decrease,format=gray,select='gt(scene,0.28)',metadata=mode=print",
    '-an', '-f', 'null', '-'
  ];
  const { stderr, stdout } = await runCommand('ffmpeg', args);
  const output = `${stderr}\n${stdout}`;
  const records = output.split(/(?=frame:\s*\d+)/g);
  const proposals: DetectorProposal[] = [];
  let lastTime = -Infinity;
  for (const record of records) {
    const timeMatch = record.match(/pts_time:([\d.]+)/);
    const scoreMatch = record.match(/lavfi\.scene_score=([\d.]+)/);
    if (!timeMatch || !scoreMatch) continue;
    const time = Number(timeMatch[1]);
    const score = Number(scoreMatch[1]);
    if (!Number.isFinite(time) || !Number.isFinite(score) || time < 0 || time > durationSeconds || time - lastTime < 0.35) continue;
    lastTime = time;
    proposals.push({
      kind: 'scene_change',
      startSeconds: Math.max(0, time - 0.45), decisiveSeconds: time,
      endSeconds: Math.min(durationSeconds, time + 0.65),
      confidence: clamp(score * 1.4), interestingness: clamp(score * 1.6),
      evidence: { sceneScore: round(score), threshold: 0.28, frameTimeSeconds: round(time) }
    });
  }
  return proposals;
}

const MOTION_SAMPLE_FPS = 4;
const MOTION_FRAME_WIDTH = 64;
const MOTION_FRAME_HEIGHT = 36;

async function detectMotionActivity(filePath: string, durationSeconds: number): Promise<DetectorProposal[]> {
  const frameBytes = MOTION_FRAME_WIDTH * MOTION_FRAME_HEIGHT;
  const scores: Array<{ time: number; score: number }> = [];
  let pending = Buffer.alloc(0);
  let previous: Buffer | undefined;
  let frameIndex = 0;
  let stderr = '';
  let processError: Error | undefined;
  const child = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', filePath,
    '-an', '-vf', `setpts=PTS-STARTPTS,fps=${MOTION_SAMPLE_FPS},scale=${MOTION_FRAME_WIDTH}:${MOTION_FRAME_HEIGHT}:flags=fast_bilinear,format=gray`,
    '-filter_threads', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  const completion = new Promise<{ code: number | null }>((resolve) => {
    child.once('error', (error) => { processError = error; resolve({ code: null }); });
    child.once('close', (code) => resolve({ code }));
  });
  for await (const chunk of child.stdout) {
    const data = pending.length ? Buffer.concat([pending, chunk]) : chunk as Buffer;
    let offset = 0;
    while (offset + frameBytes <= data.length) {
      const frame = data.subarray(offset, offset + frameBytes);
      if (previous) {
        let difference = 0;
        for (let index = 0; index < frameBytes; index++) difference += Math.abs(frame[index] - previous[index]);
        scores.push({ time: frameIndex / MOTION_SAMPLE_FPS, score: difference / (frameBytes * 255) });
      }
      previous = Buffer.from(frame);
      frameIndex++;
      offset += frameBytes;
    }
    pending = offset < data.length ? Buffer.from(data.subarray(offset)) : Buffer.alloc(0);
  }
  const result = await completion;
  if (processError) throw new AppError('MOTION_ANALYSIS_FAILED', `Could not start FFmpeg for motion analysis: ${processError.message}`, { cause: processError });
  if (result.code !== 0) throw new AppError('MOTION_ANALYSIS_FAILED', `FFmpeg could not decode video for motion analysis. ${stderr.trim()}`);
  if (!scores.length) return [];

  const ordered = scores.map((entry) => entry.score).sort((a, b) => a - b);
  const percentile60 = ordered[Math.floor((ordered.length - 1) * 0.6)];
  const peak = ordered[ordered.length - 1];
  if (peak < 0.02) return [];
  const threshold = Math.min(peak * 0.9, Math.max(0.025, percentile60 * 1.25));
  const active = scores.filter((entry) => entry.score >= threshold);
  const groups: Array<typeof active> = [];
  for (const entry of active) {
    const group = groups[groups.length - 1];
    if (group && entry.time - group[group.length - 1].time <= 0.75) group.push(entry);
    else groups.push([entry]);
  }
  return groups.filter((group) => group.length >= 2).map((group) => {
    const start = Math.max(0, group[0].time - 0.25);
    const end = Math.min(durationSeconds, group[group.length - 1].time + 0.5);
    const maximum = Math.max(...group.map((entry) => entry.score));
    const mean = group.reduce((sum, entry) => sum + entry.score, 0) / group.length;
    return {
      kind: 'motion_activity' as const,
      startSeconds: start, decisiveSeconds: group[Math.floor(group.length / 2)].time, endSeconds: Math.max(start, end),
      confidence: clamp(0.2 + (maximum - threshold) / Math.max(0.02, 0.35 - threshold), 0.15, 0.95),
      interestingness: clamp(mean * 2.5),
      evidence: { method: 'sampled-frame-mean-absolute-luma-difference', sampleFps: MOTION_SAMPLE_FPS, frameWidth: MOTION_FRAME_WIDTH, frameHeight: MOTION_FRAME_HEIGHT, threshold: round(threshold), meanDifference: round(mean), peakDifference: round(maximum) }
    };
  });
}

async function detectHudText(filePath: string, durationSeconds: number, game?: string): Promise<DetectorProposal[]> {
  const tesseract = await findExecutable('tesseract');
  if (!tesseract) throw new AppError('OCR_RUNTIME_MISSING', 'Tesseract is not installed or is not on PATH.');
  const maxFrames = 120;
  const gameRuleProfiles = game?.trim() ? await loadGameRuleProfiles() : [];
  const intervalSeconds = Math.max(1, durationSeconds / maxFrames);
  const framesPerSecond = 1 / intervalSeconds;
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openmontage-ocr-'));
  try {
    const framePattern = path.join(temporaryDirectory, 'frame-%03d.jpg');
    await runCommand('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', filePath, '-an',
      '-vf', `fps=${framesPerSecond.toFixed(6)},scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2`,
      '-frames:v', String(maxFrames), '-start_number', '0', '-q:v', '5', framePattern
    ]);
    const files = (await fs.readdir(temporaryDirectory)).filter((name) => /^frame-\d+\.jpg$/.test(name)).sort();
    const proposals: DetectorProposal[] = [];
    const lastSeenByText = new Map<string, number>();
    for (let frameIndex = 0; frameIndex < files.length; frameIndex++) {
      const framePath = path.join(temporaryDirectory, files[frameIndex]);
      const { stdout } = await runCommand(tesseract, [framePath, 'stdout', '--psm', '11', 'tsv']);
      const recognized = stdout.split(/\r?\n/).slice(1).flatMap((line) => {
        const columns = line.split('\t');
        const confidence = Number(columns[10]);
        const word = (columns[11] ?? '').trim();
        return Number.isFinite(confidence) && confidence >= 45 && word ? [{ word, confidence }] : [];
      });
      if (!recognized.length) continue;
      const text = recognized.map((item) => item.word).join(' ').replace(/\s+/g, ' ').slice(0, 160);
      const time = Math.min(durationSeconds, frameIndex / framesPerSecond);
      const signature = text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      if (signature.length < 3) continue;
      const gameEvent = await matchGameEvent(text, game, gameRuleProfiles);
      const dedupeKey = gameEvent ? `game:${gameEvent.profileId}:${gameEvent.eventId}` : `text:${signature}`;
      if (time - (lastSeenByText.get(dedupeKey) ?? -Infinity) < Math.max(4, intervalSeconds * 2)) continue;
      lastSeenByText.set(dedupeKey, time);
      const meanConfidence = recognized.reduce((sum, item) => sum + item.confidence, 0) / recognized.length;
      const start = Math.max(0, time - intervalSeconds / 2);
      const end = Math.min(durationSeconds, time + intervalSeconds / 2);
      proposals.push({
        kind: gameEvent ? 'gameplay_event' : 'text_recognition', startSeconds: start, decisiveSeconds: time, endSeconds: Math.max(start, end),
        confidence: clamp(meanConfidence / 100), interestingness: clamp((meanConfidence / 100) * Math.min(1, recognized.length / 3)),
        evidence: { engine: 'tesseract', recognizedText: text, wordCount: recognized.length, meanWordConfidence: round(meanConfidence / 100), sampleIntervalSeconds: round(intervalSeconds), frameIndex, ...(gameEvent ? { gameProfile: gameEvent.profileId, gameEvent: gameEvent.eventId, matchedKeyword: gameEvent.matchedKeyword } : {}) }
      });
    }
    return proposals;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function rankProposals(mediaId: string, items: Array<{ proposal: DetectorProposal; provenance: DetectorProvenance }>, weights: HighlightScoringWeights): AnalysisEvent[] {
  const sorted = [...items].sort((a, b) => a.proposal.decisiveSeconds - b.proposal.decisiveSeconds);
  const groups: typeof sorted[] = [];
  for (const item of sorted) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (previous && item.proposal.decisiveSeconds - previous.proposal.decisiveSeconds <= 0.8) current.push(item);
    else groups.push([item]);
  }
  const events = groups.map((group) => {
    const strongest = [...group].sort((a, b) => proposalSignal(b.proposal) - proposalSignal(a.proposal))[0];
    const kinds = new Set(group.map((item) => item.proposal.kind));
    const detectorsById = new Map<string, DetectorProvenance>();
    for (const item of group) {
      const existing = detectorsById.get(item.provenance.detectorId);
      if (!existing || item.provenance.confidence > existing.confidence) detectorsById.set(item.provenance.detectorId, item.provenance);
    }
    const detectors = [...detectorsById.values()];
    const confidence = average(group.map((item) => item.proposal.confidence));
    const interestingness = Math.max(...group.map((item) => item.proposal.interestingness));
    const corroboration = detectors.length > 1 ? 1 : 0;
    const weightTotal = weights.confidence + weights.interestingness + weights.corroboration;
    const rankScore = Math.round(clamp((confidence * weights.confidence + interestingness * weights.interestingness + corroboration * weights.corroboration) / weightTotal) * 100);
    const startSeconds = Math.min(...group.map((item) => item.proposal.startSeconds));
    const endSeconds = Math.max(...group.map((item) => item.proposal.endSeconds));
    const decisiveSeconds = strongest.proposal.decisiveSeconds;
    const kind: AnalysisEventKind = kinds.size > 1 ? 'coincident_activity' : strongest.proposal.kind;
    return {
      id: `${mediaId}:${kind}:${decisiveSeconds.toFixed(3)}`,
      mediaId, kind, startSeconds, decisiveSeconds, endSeconds,
      confidence: round(confidence), interestingness: round(interestingness), rankScore,
      rank: 0, detectors
    } satisfies AnalysisEvent;
  });
  events.sort((a, b) => b.rankScore - a.rankScore || a.decisiveSeconds - b.decisiveSeconds);
  events.forEach((event, index) => { event.rank = index + 1; });
  return events;
}

function normalizeProposal(proposal: DetectorProposal, durationSeconds: number): DetectorProposal {
  if (![proposal.startSeconds, proposal.decisiveSeconds, proposal.endSeconds, proposal.confidence, proposal.interestingness].every(Number.isFinite)) {
    throw new AppError('INVALID_DETECTOR_RESULT', 'A detector returned non-finite event values.');
  }
  const startSeconds = clamp(proposal.startSeconds, 0, durationSeconds);
  const endSeconds = clamp(proposal.endSeconds, startSeconds, durationSeconds);
  const decisiveSeconds = clamp(proposal.decisiveSeconds, startSeconds, endSeconds);
  return { ...proposal, startSeconds, decisiveSeconds, endSeconds, confidence: clamp(proposal.confidence), interestingness: clamp(proposal.interestingness) };
}

async function detectorKey(detectors: DetectorPlugin[], weights: HighlightScoringWeights, context?: DetectorContext): Promise<string> {
  const keys = await Promise.all(detectors.map(async (detector) => `${detector.id}@${detector.version}${detector.cacheKey ? `#${await detector.cacheKey()}` : ''}`));
  return `${keys.sort().join('|')}|weights:${weights.confidence},${weights.interestingness},${weights.corroboration}|game:${context?.game?.trim().toLocaleLowerCase() ?? ''}`;
}
function validateWeights(weights: HighlightScoringWeights): void {
  const values = [weights.confidence, weights.interestingness, weights.corroboration];
  if (!values.every((value) => Number.isFinite(value) && value >= 0) || values.every((value) => value === 0)) throw new AppError('INVALID_SCORING_WEIGHTS', 'Highlight ranking weights must be finite, nonnegative, and have a positive total.');
}
function proposalSignal(proposal: DetectorProposal): number { return proposal.confidence * 0.5 + proposal.interestingness * 0.5; }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function round(value: number): number { return Number(value.toFixed(3)); }
function clamp(value: number, min = 0, max = 1): number { return Math.min(max, Math.max(min, value)); }
