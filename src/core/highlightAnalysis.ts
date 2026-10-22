import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { runCommand } from './ffmpeg';
import type { AudioAnalysis, AnalysisEvent, AnalysisEventKind, DetectorModality, DetectorProvenance, DetectorRunStatus, HighlightAnalysis, HighlightScoringWeights } from './types';

export interface DetectorContext {
  mediaId: string;
  mediaPath: string;
  mediaKind: 'video' | 'audio';
  durationSeconds: number;
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
  if (cacheFilePath) {
    const cached = await readCachedHighlightAnalysis(context.mediaPath, cacheFilePath, detectors, scoreWeights);
    if (cached) return cached;
  }

  const warnings: string[] = [];
  const statuses: DetectorRunStatus[] = [];
  const proposals: Array<{ proposal: DetectorProposal; provenance: DetectorProvenance }> = [];
  for (const detector of detectors) {
    if ((detector.modality === 'audio' && !context.audioAnalysis) || (detector.modality === 'video' && context.mediaKind !== 'video')) {
      const failed = detector.modality === 'audio' && !!context.audioAnalysisError;
      const message = failed ? context.audioAnalysisError : 'Required media stream is unavailable.';
      statuses.push({ detectorId: detector.id, version: detector.version, modality: detector.modality, status: failed ? 'failed' : 'skipped', message });
      if (failed && message) warnings.push(`${detector.id}: ${message}`);
      continue;
    }
    try {
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
      await fs.writeFile(temporaryPath, `${JSON.stringify({ sourceSizeBytes: source.size, sourceMtimeMs: source.mtimeMs, detectorKey: detectorKey(detectors, scoreWeights), analysis: result }, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, cacheFilePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new AppError('ANALYSIS_CACHE_WRITE_FAILED', `Could not save highlight analysis cache: ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}

export async function readCachedHighlightAnalysis(filePath: string, cacheFilePath: string, detectors: DetectorPlugin[] = builtInDetectors, scoreWeights: HighlightScoringWeights = HIGHLIGHT_SCORE_WEIGHTS): Promise<HighlightAnalysis | null> {
  try {
    validateWeights(scoreWeights);
    const [source, raw] = await Promise.all([fs.stat(filePath), fs.readFile(cacheFilePath, 'utf8')]);
    const cached = JSON.parse(raw) as { sourceSizeBytes: number; sourceMtimeMs: number; detectorKey: string; analysis: HighlightAnalysis };
    if (cached.sourceSizeBytes !== source.size || cached.sourceMtimeMs !== source.mtimeMs || cached.detectorKey !== detectorKey(detectors, scoreWeights)) return null;
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

function detectorKey(detectors: DetectorPlugin[], weights: HighlightScoringWeights): string { return `${detectors.map((detector) => `${detector.id}@${detector.version}`).sort().join('|')}|weights:${weights.confidence},${weights.interestingness},${weights.corroboration}`; }
function validateWeights(weights: HighlightScoringWeights): void {
  const values = [weights.confidence, weights.interestingness, weights.corroboration];
  if (!values.every((value) => Number.isFinite(value) && value >= 0) || values.every((value) => value === 0)) throw new AppError('INVALID_SCORING_WEIGHTS', 'Highlight ranking weights must be finite, nonnegative, and have a positive total.');
}
function proposalSignal(proposal: DetectorProposal): number { return proposal.confidence * 0.5 + proposal.interestingness * 0.5; }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function round(value: number): number { return Number(value.toFixed(3)); }
function clamp(value: number, min = 0, max = 1): number { return Math.min(max, Math.max(min, value)); }
