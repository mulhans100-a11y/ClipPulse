import { createReadStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors';
import { analyzeAudio } from './audioAnalysis';
import { analyzeHighlightCues, builtInDetectors } from './highlightAnalysis';
import type { DetectorContext } from './highlightAnalysis';
import type { AnalysisEvent, AudioAnalysis, HighlightAnalysis } from './types';

export interface EvaluationAnnotator { id: string; independent: boolean; }
export interface EvaluationAnnotation {
  annotationId: string;
  annotatorId: string;
  eventType: string;
  startSeconds: number;
  decisiveSeconds: number;
  endSeconds: number;
}
export interface EvaluationDatasetItem {
  mediaPath: string;
  mediaKind: 'video' | 'audio';
  hasAudio: boolean;
  durationSeconds: number;
  sha256?: string;
  /** IDs of annotators who reviewed the complete interval, including negative intervals. */
  reviewedBy: string[];
  annotations: EvaluationAnnotation[];
  musicAnnotations?: Array<{ annotatorId: string; bpm?: number; beatTimesSeconds: number[]; downbeatTimesSeconds: number[] }>;
}
export interface EvaluationDataset {
  schemaVersion: 1;
  datasetId: string;
  game: string;
  annotators: EvaluationAnnotator[];
  items: EvaluationDatasetItem[];
}

interface ConsensusLabel { eventType: string; startSeconds: number; decisiveSeconds: number; endSeconds: number; annotators: string[]; }
interface Prediction { mediaIndex: number; event: AnalysisEvent; detectorId: string; confidence: number; }

export interface DetectorEvaluationResult {
  detectorId: string;
  evaluatedMediaItems: number;
  skippedMediaItems: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  confidenceCalibration: { brierScore: number; expectedCalibrationError: number; bins: Array<{ lowerBound: number; upperBound: number; count: number; meanConfidence: number; observedPrecision: number }> } | null;
}

export interface HighlightEvaluationReport {
  datasetId: string;
  game: string;
  mediaItems: number;
  consensusEvents: number;
  disputedAnnotations: number;
  matchToleranceSeconds: number;
  detectorResults: DetectorEvaluationResult[];
  musicResults: MusicEvaluationResult[];
  musicSummary: { bpmMeanAbsoluteError: number | null; beatPrecision: number | null; beatRecall: number | null; beatF1: number | null; downbeatPrecision: number | null; downbeatRecall: number | null; downbeatF1: number | null; tempoScoreCalibration: { brierScore: number; expectedCalibrationError: number } | null };
  items: Array<{ mediaPath: string; analysis: HighlightAnalysis; consensusEvents: number }>;
}

export interface MusicEvaluationResult {
  mediaPath: string;
  referenceBpm: number | null;
  estimatedBpm: number | null;
  absoluteBpmError: number | null;
  topTempoScore: number | null;
  beatTruePositives: number;
  beatFalsePositives: number;
  beatFalseNegatives: number;
  downbeatTruePositives: number;
  downbeatFalsePositives: number;
  downbeatFalseNegatives: number;
}

export async function evaluateHighlightDataset(datasetPath: string, matchToleranceSeconds = 2): Promise<HighlightEvaluationReport> {
  if (!Number.isFinite(matchToleranceSeconds) || matchToleranceSeconds < 0 || matchToleranceSeconds > 30) {
    throw new AppError('INVALID_EVALUATION_TOLERANCE', 'Match tolerance must be between 0 and 30 seconds.');
  }
  const absoluteDatasetPath = path.resolve(datasetPath);
  let dataset: EvaluationDataset;
  try { dataset = JSON.parse(await fs.readFile(absoluteDatasetPath, 'utf8')) as EvaluationDataset; }
  catch (error) { throw new AppError('EVALUATION_DATASET_READ_FAILED', `Could not read evaluation dataset: ${error instanceof Error ? error.message : error}`); }
  validateDataset(dataset);

  const analyses: Array<{ mediaPath: string; analysis: HighlightAnalysis; consensus: ConsensusLabel[]; disputedAnnotations: number; audioAnalysis?: AudioAnalysis }> = [];
  for (const item of dataset.items) {
    const mediaPath = path.resolve(path.dirname(absoluteDatasetPath), item.mediaPath);
    const stat = await fs.stat(mediaPath).catch(() => null);
    if (!stat?.isFile()) throw new AppError('EVALUATION_MEDIA_MISSING', `Evaluation media file is missing: ${mediaPath}`);
    if (item.sha256) {
      const actual = await sha256File(mediaPath);
      if (actual.toLowerCase() !== item.sha256.toLowerCase()) throw new AppError('EVALUATION_MEDIA_HASH_MISMATCH', `Evaluation media hash does not match the annotation manifest: ${mediaPath}`);
    }
    const consensus = buildConsensus(item.annotations, item.reviewedBy, item.durationSeconds);
    const context: DetectorContext = {
      mediaId: `evaluation-${createHash('sha1').update(mediaPath).digest('hex').slice(0, 16)}`,
      mediaPath, mediaKind: item.mediaKind, durationSeconds: item.durationSeconds, game: dataset.game
    };
    if (item.hasAudio) {
      try { context.audioAnalysis = await analyzeAudio(mediaPath); }
      catch (error) { context.audioAnalysisError = error instanceof Error ? error.message : String(error); }
    }
    const analysis = await analyzeHighlightCues(context);
    analyses.push({ mediaPath: item.mediaPath, analysis, consensus: consensus.labels, disputedAnnotations: consensus.disputed, audioAnalysis: context.audioAnalysis });
  }

  const detectorIds = new Set<string>(builtInDetectors.map((detector) => detector.id));
  const predictions: Prediction[] = [];
  const evaluatedMediaByDetector = new Map<string, Set<number>>();
  analyses.forEach(({ analysis }, mediaIndex) => {
    for (const status of analysis.detectors) {
      detectorIds.add(status.detectorId);
      if (status.status === 'complete') {
        const evaluated = evaluatedMediaByDetector.get(status.detectorId) ?? new Set<number>();
        evaluated.add(mediaIndex);
        evaluatedMediaByDetector.set(status.detectorId, evaluated);
      }
    }
    for (const event of analysis.events) for (const detector of event.detectors) {
      detectorIds.add(detector.detectorId);
      predictions.push({ mediaIndex, event, detectorId: detector.detectorId, confidence: detector.confidence });
    }
  });
  const detectorResults = [...detectorIds].sort().map((detectorId) => {
    const evaluatedMedia = evaluatedMediaByDetector.get(detectorId) ?? new Set<number>();
    const detectorPredictions = predictions.filter((prediction) => prediction.detectorId === detectorId && evaluatedMedia.has(prediction.mediaIndex));
    const matchedPredictionIndexes = new Set<number>();
    let truePositives = 0;
    const truthLabels = analyses.flatMap((entry, mediaIndex) => entry.consensus.map((label) => ({ mediaIndex, label }))).filter((truth) => evaluatedMedia.has(truth.mediaIndex));
    for (const truth of truthLabels) {
      const candidateIndex = detectorPredictions
        .map((prediction, index) => ({ prediction, index, delta: Math.abs(prediction.event.decisiveSeconds - truth.label.decisiveSeconds) }))
        .filter((candidate) => candidate.prediction.mediaIndex === truth.mediaIndex && !matchedPredictionIndexes.has(candidate.index) && candidate.delta <= matchToleranceSeconds)
        .sort((a, b) => a.delta - b.delta || b.prediction.confidence - a.prediction.confidence)[0]?.index;
      if (candidateIndex !== undefined) { matchedPredictionIndexes.add(candidateIndex); truePositives++; }
    }
    const falsePositives = detectorPredictions.length - truePositives;
    const falseNegatives = truthLabels.length - truePositives;
    const precision = safeRatio(truePositives, truePositives + falsePositives) ?? (falseNegatives > 0 ? 0 : null);
    const recall = safeRatio(truePositives, truePositives + falseNegatives);
    const f1 = precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall);
    return {
      detectorId, evaluatedMediaItems: evaluatedMedia.size, skippedMediaItems: analyses.length - evaluatedMedia.size, truePositives, falsePositives, falseNegatives, precision, recall, f1,
      confidenceCalibration: calculateConfidenceCalibration(detectorPredictions.map((prediction, index) => ({ confidence: prediction.confidence, correct: matchedPredictionIndexes.has(index) })))
    };
  });
  const musicEntries = dataset.items.flatMap((item, index) => item.musicAnnotations?.length ? [{ item, analysis: analyses[index].audioAnalysis, mediaPath: analyses[index].mediaPath }] : []);
  const musicResults = musicEntries.map(({ item, analysis, mediaPath }) => evaluateMusicItem(item, analysis, mediaPath));
  const beatCounts = musicResults.reduce((counts, item) => ({ tp: counts.tp + item.beatTruePositives, fp: counts.fp + item.beatFalsePositives, fn: counts.fn + item.beatFalseNegatives }), { tp: 0, fp: 0, fn: 0 });
  const downbeatCounts = musicResults.reduce((counts, item) => ({ tp: counts.tp + item.downbeatTruePositives, fp: counts.fp + item.downbeatFalsePositives, fn: counts.fn + item.downbeatFalseNegatives }), { tp: 0, fp: 0, fn: 0 });
  const tempoCalibrationSamples = musicEntries.flatMap(({ item, analysis }) => {
    const referenceBpm = consensusBpm(item.musicAnnotations ?? [], item.reviewedBy);
    const top = analysis?.bpmHypotheses[0];
    return referenceBpm !== null && top ? [{ confidence: clamp(top.score, 0, 1), correct: Math.abs(top.bpm - referenceBpm) <= 2 }] : [];
  });
  const tempoCalibration = calculateConfidenceCalibration(tempoCalibrationSamples);
  return {
    datasetId: dataset.datasetId, game: dataset.game, mediaItems: dataset.items.length,
    consensusEvents: analyses.reduce((sum, entry) => sum + entry.consensus.length, 0),
    disputedAnnotations: analyses.reduce((sum, entry) => sum + entry.disputedAnnotations, 0),
    matchToleranceSeconds,
    detectorResults,
    musicResults,
    musicSummary: {
      bpmMeanAbsoluteError: meanOrNull(musicResults.flatMap((item) => item.absoluteBpmError === null ? [] : [item.absoluteBpmError])),
      beatPrecision: safeRatio(beatCounts.tp, beatCounts.tp + beatCounts.fp), beatRecall: safeRatio(beatCounts.tp, beatCounts.tp + beatCounts.fn), beatF1: f1Score(beatCounts.tp, beatCounts.fp, beatCounts.fn),
      downbeatPrecision: safeRatio(downbeatCounts.tp, downbeatCounts.tp + downbeatCounts.fp), downbeatRecall: safeRatio(downbeatCounts.tp, downbeatCounts.tp + downbeatCounts.fn), downbeatF1: f1Score(downbeatCounts.tp, downbeatCounts.fp, downbeatCounts.fn),
      tempoScoreCalibration: tempoCalibration ? { brierScore: tempoCalibration.brierScore, expectedCalibrationError: tempoCalibration.expectedCalibrationError } : null
    },
    items: analyses.map(({ mediaPath, analysis, consensus }) => ({ mediaPath, analysis, consensusEvents: consensus.length }))
  };
}

function validateDataset(dataset: EvaluationDataset): void {
  if (!dataset || dataset.schemaVersion !== 1 || typeof dataset.datasetId !== 'string' || !dataset.datasetId.trim() || typeof dataset.game !== 'string' || !dataset.game.trim() || !Array.isArray(dataset.items) || dataset.items.length === 0) {
    throw new AppError('INVALID_EVALUATION_DATASET', 'Dataset needs schemaVersion 1, a datasetId, a game name, and at least one annotated media item.');
  }
  if (!Array.isArray(dataset.annotators) || dataset.annotators.length < 2 || dataset.annotators.some((item) => !item.id?.trim() || item.independent !== true) || new Set(dataset.annotators.map((item) => item.id)).size !== dataset.annotators.length) {
    throw new AppError('INVALID_EVALUATION_ANNOTATORS', 'At least two uniquely named annotators must be declared independent.');
  }
  const knownAnnotators = new Set(dataset.annotators.map((item) => item.id));
  for (const [itemIndex, item] of dataset.items.entries()) {
    if (!item || typeof item.mediaPath !== 'string' || !item.mediaPath.trim() || !['video', 'audio'].includes(item.mediaKind) || typeof item.hasAudio !== 'boolean' || !Number.isFinite(item.durationSeconds) || item.durationSeconds <= 0 || !Array.isArray(item.reviewedBy) || !Array.isArray(item.annotations)) {
      throw new AppError('INVALID_EVALUATION_ITEM', `Evaluation media item ${itemIndex + 1} has invalid media metadata or annotations.`);
    }
    if (new Set(item.reviewedBy).size < 2 || item.reviewedBy.some((id) => !knownAnnotators.has(id))) throw new AppError('INSUFFICIENT_INDEPENDENT_ANNOTATIONS', `Media item ${itemIndex + 1} must be completely reviewed by at least two declared annotators.`);
    const ids = new Set<string>();
    for (const [annotationIndex, annotation] of item.annotations.entries()) {
      if (!annotation?.annotationId?.trim() || ids.has(annotation.annotationId) || !knownAnnotators.has(annotation.annotatorId) || !annotation.eventType?.trim() || ![annotation.startSeconds, annotation.decisiveSeconds, annotation.endSeconds].every(Number.isFinite) || annotation.startSeconds < 0 || annotation.startSeconds > annotation.decisiveSeconds || annotation.decisiveSeconds > annotation.endSeconds || annotation.endSeconds > item.durationSeconds) {
        throw new AppError('INVALID_EVALUATION_ANNOTATION', `Annotation ${annotationIndex + 1} in media item ${itemIndex + 1} has invalid ids, annotator, event type, or time range.`);
      }
      ids.add(annotation.annotationId);
    }
    if (item.annotations.some((annotation) => !item.reviewedBy.includes(annotation.annotatorId))) throw new AppError('INVALID_EVALUATION_ANNOTATION', `Every label in media item ${itemIndex + 1} must belong to an annotator who reviewed that item.`);
    if (item.musicAnnotations !== undefined && (!Array.isArray(item.musicAnnotations) || new Set(item.musicAnnotations.map((annotation) => annotation.annotatorId)).size < 2 || item.musicAnnotations.some((annotation) => !knownAnnotators.has(annotation.annotatorId) || !item.reviewedBy.includes(annotation.annotatorId) || (annotation.bpm !== undefined && (!Number.isFinite(annotation.bpm) || annotation.bpm < 30 || annotation.bpm > 300)) || !Array.isArray(annotation.beatTimesSeconds) || !Array.isArray(annotation.downbeatTimesSeconds) || [...annotation.beatTimesSeconds, ...annotation.downbeatTimesSeconds].some((time) => !Number.isFinite(time) || time < 0 || time > item.durationSeconds)))) {
      throw new AppError('INVALID_MUSIC_ANNOTATIONS', `Music annotations in media item ${itemIndex + 1} must contain valid independent beat references.`);
    }
    if (item.musicAnnotations?.length && !item.hasAudio) throw new AppError('INVALID_MUSIC_ANNOTATIONS', `Music annotations in media item ${itemIndex + 1} require an audio stream.`);
  }
}

function buildConsensus(annotations: EvaluationAnnotation[], reviewedBy: string[], durationSeconds: number): { labels: ConsensusLabel[]; disputed: number } {
  const requiredAnnotators = Math.floor(reviewedBy.length / 2) + 1;
  const sorted = [...annotations].sort((a, b) => a.decisiveSeconds - b.decisiveSeconds);
  const groups: EvaluationAnnotation[][] = [];
  for (const annotation of sorted) {
    const group = groups
      .filter((candidate) => candidate[0].eventType === annotation.eventType && !candidate.some((member) => member.annotatorId === annotation.annotatorId))
      .sort((a, b) => Math.abs(median(a.map((member) => member.decisiveSeconds)) - annotation.decisiveSeconds) - Math.abs(median(b.map((member) => member.decisiveSeconds)) - annotation.decisiveSeconds))[0];
    if (group && Math.abs(median(group.map((member) => member.decisiveSeconds)) - annotation.decisiveSeconds) <= 2) group.push(annotation);
    else groups.push([annotation]);
  }
  const labels: ConsensusLabel[] = [];
  let included = 0;
  for (const group of groups) {
    if (new Set(group.map((member) => member.annotatorId)).size < requiredAnnotators) continue;
    included += group.length;
    labels.push({
      eventType: group[0].eventType,
      startSeconds: clamp(median(group.map((member) => member.startSeconds)), 0, durationSeconds),
      decisiveSeconds: clamp(median(group.map((member) => member.decisiveSeconds)), 0, durationSeconds),
      endSeconds: clamp(median(group.map((member) => member.endSeconds)), 0, durationSeconds),
      annotators: [...new Set(group.map((member) => member.annotatorId))]
    });
  }
  return { labels: labels.sort((a, b) => a.decisiveSeconds - b.decisiveSeconds), disputed: annotations.length - included };
}

function calculateConfidenceCalibration(samples: Array<{ confidence: number; correct: boolean }>): DetectorEvaluationResult['confidenceCalibration'] {
  if (!samples.length) return null;
  const binCount = 10;
  const bins = Array.from({ length: binCount }, (_value, index) => {
    const lowerBound = index / binCount;
    const upperBound = (index + 1) / binCount;
    const values = samples.filter((sample) => sample.confidence >= lowerBound && (index === binCount - 1 ? sample.confidence <= upperBound : sample.confidence < upperBound));
    return { lowerBound, upperBound, count: values.length, meanConfidence: values.length ? values.reduce((sum, sample) => sum + sample.confidence, 0) / values.length : 0, observedPrecision: values.length ? values.filter((sample) => sample.correct).length / values.length : 0 };
  });
  return {
    brierScore: samples.reduce((sum, sample) => sum + (sample.confidence - Number(sample.correct)) ** 2, 0) / samples.length,
    expectedCalibrationError: bins.reduce((sum, bin) => sum + bin.count / samples.length * Math.abs(bin.meanConfidence - bin.observedPrecision), 0),
    bins
  };
}

function evaluateMusicItem(item: EvaluationDatasetItem, analysis: AudioAnalysis | undefined, mediaPath: string): MusicEvaluationResult {
  const references = item.musicAnnotations ?? [];
  const referenceBeats = consensusTimes(references.map((annotation) => ({ id: annotation.annotatorId, values: annotation.beatTimesSeconds })), 0.08, item.reviewedBy.length);
  const referenceDownbeats = consensusTimes(references.map((annotation) => ({ id: annotation.annotatorId, values: annotation.downbeatTimesSeconds })), 0.12, item.reviewedBy.length);
  const referenceBpm = consensusBpm(references, item.reviewedBy);
  const beatCounts = matchTimes(analysis?.beats ?? [], referenceBeats, 0.08);
  const downbeatCounts = matchTimes(analysis?.downbeats ?? [], referenceDownbeats, 0.12);
  const estimatedBpm = analysis?.estimatedBpm ?? null;
  return {
    mediaPath, referenceBpm, estimatedBpm,
    absoluteBpmError: estimatedBpm === null || referenceBpm === null ? null : Math.abs(estimatedBpm - referenceBpm),
    topTempoScore: analysis?.bpmHypotheses[0]?.score ?? null,
    beatTruePositives: beatCounts.tp, beatFalsePositives: beatCounts.fp, beatFalseNegatives: beatCounts.fn,
    downbeatTruePositives: downbeatCounts.tp, downbeatFalsePositives: downbeatCounts.fp, downbeatFalseNegatives: downbeatCounts.fn
  };
}

function consensusBpm(annotations: NonNullable<EvaluationDatasetItem['musicAnnotations']>, reviewedBy: string[]): number | null {
  const valid = annotations.filter((annotation) => annotation.bpm !== undefined && reviewedBy.includes(annotation.annotatorId));
  if (new Set(valid.map((annotation) => annotation.annotatorId)).size < Math.floor(reviewedBy.length / 2) + 1) return null;
  return median(valid.map((annotation) => annotation.bpm!));
}

function consensusTimes(annotations: Array<{ id: string; values: number[] }>, tolerance: number, reviewerCount: number): number[] {
  const required = Math.floor(reviewerCount / 2) + 1;
  const entries = annotations.flatMap((annotation) => annotation.values.map((time) => ({ id: annotation.id, time }))).sort((a, b) => a.time - b.time);
  const groups: Array<typeof entries> = [];
  for (const entry of entries) {
    const group = groups.find((candidate) => Math.abs(median(candidate.map((item) => item.time)) - entry.time) <= tolerance && !candidate.some((item) => item.id === entry.id));
    if (group) group.push(entry); else groups.push([entry]);
  }
  return groups.filter((group) => new Set(group.map((item) => item.id)).size >= required).map((group) => median(group.map((item) => item.time)));
}

function matchTimes(predictions: number[], reference: number[], tolerance: number): { tp: number; fp: number; fn: number } {
  const unmatched = new Set(predictions.map((_time, index) => index));
  let tp = 0;
  for (const expected of reference) {
    const best = [...unmatched].map((index) => ({ index, delta: Math.abs(predictions[index] - expected) })).filter((entry) => entry.delta <= tolerance).sort((a, b) => a.delta - b.delta)[0];
    if (best) { unmatched.delete(best.index); tp++; }
  }
  return { tp, fp: predictions.length - tp, fn: reference.length - tp };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function safeRatio(numerator: number, denominator: number): number | null { return denominator ? numerator / denominator : null; }
function meanOrNull(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function f1Score(tp: number, fp: number, fn: number): number | null { const precision = safeRatio(tp, tp + fp), recall = safeRatio(tp, tp + fn); return precision === null || recall === null || precision + recall === 0 ? null : 2 * precision * recall / (precision + recall); }
function median(values: number[]): number { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
