export type Rational = { num: string; den: string };
export type TrackKind = 'video' | 'audio';

export type MediaJobKind = 'proxy' | 'clip-waveform';
export type MediaJobState = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

/** Public, serializable view of a durable derived-media job. Source paths stay in the main process. */
export interface MediaJob {
  id: string;
  key: string;
  kind: MediaJobKind;
  mediaId: string;
  sourceContentHash?: string;
  state: MediaJobState;
  progress: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  outputPath: string;
  outputBytes?: number;
  error?: string;
  clipId?: string;
  sourceInSeconds?: number;
  clipDurationSeconds?: number;
  zoomPixelsPerSecond?: number;
  waveformWidth?: number;
}

export interface MediaJobQueueSnapshot {
  jobs: MediaJob[];
  paused: boolean;
}

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
export type AnalysisEventKind = 'audio_activity' | 'scene_change' | 'motion_activity' | 'text_recognition' | 'gameplay_event' | 'coincident_activity';

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

export interface AnalysisRuntimeStatus {
  id: string;
  label: string;
  status: 'ready' | 'missing' | 'not-configured';
  version?: string;
  message: string;
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

export type AutoMontageStyle = 'clean' | 'aggressive' | 'cinematic' | 'velocity' | 'custom';
export type AutoMontageFormat = 'project' | 'landscape-1080p' | 'portrait-1080p' | 'square-1080p';
export interface AutoMontageCustomRules {
  targetShotSeconds: number;
  minShotSeconds: number;
  maxShotSeconds: number;
  leadSeconds: number;
  tailSeconds: number;
  cutRatio: number;
  videoAudioVolume: number;
  musicVolume: number;
  anchorPreference: { drop: number; downbeat: number; beat: number; onset: number };
}

export interface AutoMontageOptions {
  musicMediaId: string;
  videoMediaIds?: string[];
  style: AutoMontageStyle;
  durationSeconds: number;
  variants: number;
  /** 0 is a relaxed pace, 1 is the fastest pace for the selected preset. */
  intensity: number;
  format: AutoMontageFormat;
  customRules?: AutoMontageCustomRules;
}

export interface AutoMontageSegment {
  index: number;
  mediaId: string;
  mediaName: string;
  sourceContentHash: string;
  game?: string;
  eventId: string;
  eventKind: AnalysisEvent['kind'];
  eventLabel: string;
  reviewStatus?: 'accepted' | 'corrected';
  sourceEventStartSeconds: number;
  sourceDecisiveSeconds: number;
  sourceEventEndSeconds: number;
  sourceInSeconds: number;
  timelineStartSeconds: number;
  timelineStartFrame: number;
  durationSeconds: number;
  durationFrames: number;
  targetAnchorSeconds: number;
  anchorKind: 'drop' | 'downbeat' | 'beat' | 'onset' | 'paced';
  anchorStrength: number;
  alignmentErrorFrames: number;
  score: { highlight: number; musicFit: number; framing: number; pacing: number };
  detectors: DetectorProvenance[];
  explanation: string;
}

export interface AutoMontagePlan {
  schemaVersion: 1;
  method: 'ranked-highlight-beat-planner-v1';
  createdAt: string;
  sourceProjectId: string;
  variant: number;
  style: AutoMontageStyle;
  durationSeconds: number;
  durationFrames: number;
  format: AutoMontageFormat;
  intensity: number;
  customRules?: AutoMontageCustomRules;
  music: { mediaId: string; name: string; contentHash: string; estimatedBpm?: number; analysisMethod: AudioAnalysis['method'] };
  score: number;
  scoreBreakdown: { highlightQuality: number; musicAlignment: number; sceneDiversity: number; pacing: number; framing: number; duration: number };
  segments: AutoMontageSegment[];
  warnings: string[];
}

export interface GeneratedAutoMontageVariant {
  projectPath: string;
  planPath: string;
  plan: AutoMontagePlan;
}

export interface GeneratedAutoMontages {
  outputDirectory: string;
  variants: GeneratedAutoMontageVariant[];
}

export interface AutoMontageAnalysisInput {
  project: Project;
  musicAnalysis: AudioAnalysis;
  highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }>;
  options: AutoMontageOptions;
}
