export type Rational = { num: string; den: string };
export type TrackKind = 'video' | 'audio';

export interface BpmHypothesis {
  bpm: number;
  score: number;
}

export interface MeterEstimate {
  beatsPerBar: number;
  denominator: 4;
  downbeatPhase: number;
  confidence: number;
}

export interface EnergySection {
  startSeconds: number;
  endSeconds: number;
  level: 'low' | 'medium' | 'high';
  meanEnergy: number;
}

export interface AudioAnalysis {
  method: 'rms-onset-autocorrelation-v2';
  sampleRate: number;
  hopSeconds: number;
  durationSeconds: number;
  estimatedBpm?: number;
  bpmHypotheses: BpmHypothesis[];
  beatPhaseSeconds?: number;
  beats: number[];
  meter?: MeterEstimate;
  downbeats: number[];
  energyHopSeconds: number;
  energyCurve: number[];
  energySections: EnergySection[];
  drops: number[];
  onsets: number[];
}

export type DetectorModality = 'audio' | 'video' | 'text';
export type AnalysisEventKind = 'audio_activity' | 'scene_change' | 'coincident_activity';

export interface DetectorProvenance {
  detectorId: string;
  version: string;
  modality: DetectorModality;
  confidence: number;
  evidence: Record<string, string | number | boolean>;
}

export interface AnalysisEvent {
  id: string;
  mediaId: string;
  kind: AnalysisEventKind;
  startSeconds: number;
  decisiveSeconds: number;
  endSeconds: number;
  /** Heuristic detector score, not a calibrated probability. */
  confidence: number;
  /** Relative technical cue strength, not a gameplay-quality judgment. */
  interestingness: number;
  /** Configurable heuristic rank from 0 to 100. */
  rankScore: number;
  rank: number;
  detectors: DetectorProvenance[];
}

export interface DetectorRunStatus {
  detectorId: string;
  version: string;
  modality: DetectorModality;
  status: 'complete' | 'skipped' | 'failed';
  message?: string;
}

export interface HighlightScoringWeights {
  confidence: number;
  interestingness: number;
  corroboration: number;
}

export interface HighlightAnalysis {
  method: 'heuristic-detector-pipeline-v1';
  durationSeconds: number;
  scoreWeights: HighlightScoringWeights;
  detectors: DetectorRunStatus[];
  warnings: string[];
  events: AnalysisEvent[];
}

export interface AnalysisEventReview {
  eventId: string;
  detectorIds: string[];
  status: 'accepted' | 'rejected' | 'corrected';
  startSeconds: number;
  decisiveSeconds: number;
  endSeconds: number;
  updatedAt: string;
}

export interface MediaAsset {
  id: string;
  path: string;
  name: string;
  kind: 'video' | 'audio';
  duration: Rational;
  width?: number;
  height?: number;
  frameRate?: Rational;
  hasAudio: boolean;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: string;
  thumbnailPath?: string;
  importedAt: string;
  favorite?: boolean;
  /** Manual highlight score; zero means unranked. */
  rating?: number;
  analysisEventReviews?: AnalysisEventReview[];
  tags?: string[];
  game?: string;
}

export interface TimelineClip {
  id: string;
  mediaId: string;
  start: Rational;
  sourceIn: Rational;
  duration: Rational;
  audioEnabled: boolean;
  volume: number;
  fadeIn?: Rational;
  fadeOut?: Rational;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TrackKind;
  muted: boolean;
  solo?: boolean;
  locked: boolean;
  clips: TimelineClip[];
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  frameRate: Rational;
  width: number;
  height: number;
  media: MediaAsset[];
  tracks: TimelineTrack[];
}

export interface ProjectSummary {
  filePath: string;
  project: Project;
}

export interface ImportResult {
  added: MediaAsset[];
  duplicates: Array<{ path: string; existingId: string }>;
  errors: Array<{ path: string; code: string; message: string }>;
  watchedRoots: string[];
}

export interface ImportRoot {
  path: string;
  recursive: boolean;
  watching: boolean;
  lastScan?: string;
}

export interface ExportOptions {
  outputPath: string;
  overwrite?: boolean;
  videoBitrate?: string;
  audioBitrate?: string;
  encoder?: 'libx264' | 'h264_amf' | 'h264_nvenc' | 'h264_qsv';
  onProgress?: (fraction: number) => void;
}
