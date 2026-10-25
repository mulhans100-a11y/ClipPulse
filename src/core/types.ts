export type Rational = { num: string; den: string };
export type TrackKind = 'video' | 'audio';
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'add' | 'difference';

export interface ClipMaskKeyframe { time: Rational; path: string; }
export interface ClipMask {
  /** Closed SVG path in normalized frame coordinates (0–1). Supports M, L, Q, C, Z. */
  path: string;
  featherPx: number;
  expansionPx: number;
  keyframes?: ClipMaskKeyframe[];
  /** Optional reproducibility metadata for a locally generated model mask. */
  provenance?: {
    modelId: string;
    revision: string;
    className: string;
    sampleCount: number;
    stabilization: 'temporal-majority-v1' | 'single-frame-v1';
  };
}
export interface SegmentationProgress {
  stage: 'loading-model' | 'extracting' | 'segmenting' | 'stabilizing';
  current: number;
  total: number;
}
export interface SegmentationOptions {
  className?: string;
  sampleFps?: number;
  scoreThreshold?: number;
}
export interface ClipChromaKey { color: string; similarity: number; blend: number; }

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
  denominator: 4 | 8;
  downbeatPhase: number;
  confidence: number;
}

export interface EnergySection {
  startSeconds: number;
  endSeconds: number;
  level: 'low' | 'medium' | 'high';
  meanEnergy: number;
}

/** A locally estimated tempo interval. Values are heuristic estimates in quarter-note BPM. */
export interface TempoSegment {
  startSeconds: number;
  endSeconds: number;
  bpm: number;
  confidence: number;
}

/** One point on the analyzed pulse grid. Confidence is a relative signal score, not a probability. */
export interface BeatGridPoint {
  timeSeconds: number;
  index: number;
  confidence: number;
  strength: number;
  downbeat: boolean;
}

/** A detected transient that may be a beat, subdivision, or offbeat event. */
export interface AudioOnset {
  timeSeconds: number;
  strength: number;
  confidence: number;
}

export type MusicStructureEventType = 'strong_accent' | 'build_up' | 'drop' | 'quiet' | 'section_change';

/** Larger musical events, distinct from individual onset detections and regular beats. */
export interface MusicStructureEvent {
  type: MusicStructureEventType;
  timeSeconds: number;
  endSeconds?: number;
  confidence: number;
  strength: number;
  signals: string[];
}

export interface AudioAnalysis {
  /** v4 remains readable for projects and fixtures created by earlier releases. */
  method: 'spectral-flux-dynamic-beat-v4' | 'spectral-flux-adaptive-beat-v5';
  sampleRate: number;
  hopSeconds: number;
  durationSeconds: number;
  estimatedBpm?: number;
  bpmHypotheses: BpmHypothesis[];
  beatPhaseSeconds?: number;
  beats: number[];
  /** Additive, confidence-bearing view of `beats`. */
  beatGrid?: BeatGridPoint[];
  /** Local tempo estimates; can reveal a tempo change hidden by the global BPM. */
  tempoSegments?: TempoSegment[];
  meter?: MeterEstimate;
  downbeats: number[];
  energyHopSeconds: number;
  energyCurve: number[];
  energySections: EnergySection[];
  drops: number[];
  onsets: number[];
  /** Strong rhythmic/accent positions, separate from every onset. */
  accents?: number[];
  /** Confidence-bearing individual transients, including offbeat and subdivision onsets. */
  onsetEvents?: AudioOnset[];
  /** Build-ups, drops, quiet intervals and other section-scale changes. */
  structureEvents?: MusicStructureEvent[];
}

export type DetectorModality = 'audio' | 'video' | 'text';
export type AnalysisEventKind = 'audio_activity' | 'scene_change' | 'motion_activity' | 'text_recognition' | 'gameplay_event' | 'coincident_activity';
export type GameplayEventType = 'kill' | 'headshot' | 'multi_kill' | 'ace' | 'clutch' | 'clutch_situation' | 'round_end' | 'round_objective' | 'kill_feed_change' | 'combat_activity' | 'fast_action_candidate' | 'quiet_passage' | 'audio_activity' | 'scene_change' | 'text_recognition' | 'unknown';
export type EvidenceLevel = 'explicit' | 'corroborated' | 'heuristic' | 'unknown';

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
  /** Semantic event label. Older cached/project data may not provide one. */
  eventType?: GameplayEventType;
  /** Evidence quality, not a calibrated probability. */
  evidenceLevel?: EvidenceLevel;
  /** Human-readable signal IDs that explain the classification. */
  signals?: string[];
  /** Explicit reasons an event could be misclassified or is not proven. */
  uncertainties?: string[];
  /** Normalized, inspectable components used to produce rankScore. */
  scoreBreakdown?: { confidence: number; cueStrength: number; corroboration: number; semanticPriority: number; total: number };
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
  /** Optional manual semantic correction; present only after an explicit user correction. */
  correctedEventType?: GameplayEventType;
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
  /** Playback rate as source seconds consumed per timeline second. Defaults to 1. */
  playbackRate?: Rational;
  /** Linear speed-ramp keyframes, relative to the start of this clip. */
  speedKeyframes?: Array<{ time: Rational; rate: Rational }>;
  transform?: { scale: number; x: number; y: number; rotationDegrees: number };
  color?: { brightness: number; contrast: number; saturation: number; lutPath?: string };
  keyframes?: Array<{ property: 'opacity' | 'brightness' | 'contrast' | 'saturation' | 'volume'; time: Rational; value: number; interpolation?: 'linear' | 'hold' }>;
  transitionIn?: { type: 'dissolve' | 'wipe-left' | 'wipe-right'; duration: Rational };
  title?: { text: string; fontSize: number; color: string; x: number; y: number; start: Rational; duration: Rational; box?: boolean; fontFile?: string };
  normalizeAudio?: boolean;
  /** Optional non-destructive foreground isolation and compositing settings. */
  blendMode?: BlendMode;
  chromaKey?: ClipChromaKey;
  mask?: ClipMask;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: TrackKind;
  muted: boolean;
  solo?: boolean;
  locked: boolean;
  volume?: number;
  volumeKeyframes?: Array<{ time: Rational; value: number; interpolation?: 'linear' | 'hold' }>;
  audioRole?: 'standard' | 'dialogue' | 'music';
  normalizeAudio?: boolean;
  duckUnderDialogue?: boolean;
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
  /** Render only this exact project-time interval; final export is unchanged when omitted. */
  range?: { start: Rational; duration: Rational };
  /** Preview uses a reduced output size, frame rate, and bitrate while sharing the export graph. */
  quality?: 'preview' | 'final';
  videoBitrate?: string;
  audioBitrate?: string;
  encoder?: 'libx264' | 'h264_amf' | 'h264_nvenc' | 'h264_qsv';
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export type AutoMontageStyle = 'clean' | 'aggressive' | 'cinematic' | 'smooth' | 'velocity' | 'custom';
export type AutoMontageFormat = 'project' | 'landscape-1080p' | 'portrait-1080p' | 'square-1080p';
export type AutoMontageSelectionMode = 'library' | 'selected' | 'ranges';
export type AutoMontageRangePolicy = 'strict' | 'flexible';
/** User-marked source search interval. Times are exact decimal or rational seconds. */
export interface AutoMontageSourceRange { mediaId: string; startSeconds: string; endSeconds: string; }
export interface AutoMontageCustomRules {
  targetShotSeconds: number;
  minShotSeconds: number;
  maxShotSeconds: number;
  leadSeconds: number;
  tailSeconds: number;
  cutRatio: number;
  videoAudioVolume: number;
  musicVolume: number;
  anchorPreference: { drop: number; accent?: number; downbeat: number; beat: number; onset: number };
}

export interface AutoMontageOptions {
  musicMediaId: string;
  /** Defaults to selected when legacy callers pass videoMediaIds, otherwise library. */
  selectionMode?: AutoMontageSelectionMode;
  videoMediaIds?: string[];
  /** Required for ranges mode; each listed clip is analyzed only inside its marked source window. */
  sourceRanges?: AutoMontageSourceRange[];
  sourceRangePolicy?: AutoMontageRangePolicy;
  referenceMediaId?: string;
  style: AutoMontageStyle;
  /** Defaults to the full music asset duration, capped by the 30 minute montage limit. */
  durationSeconds?: number;
  variants: number;
  /** 0 is a relaxed pace, 1 is the fastest pace for the selected preset. */
  intensity: number;
  format: AutoMontageFormat;
  customRules?: AutoMontageCustomRules;
}

export interface AutoMontageReferenceProfile {
  mediaId: string;
  mediaName: string;
  detectedCuts: number;
  sampledShots: number;
  cutTimesSeconds: number[];
  shotDurationsSeconds: number[];
  medianShotSeconds: number;
  p75ShotSeconds: number;
}

export interface AutoMontageEffectPlan {
  cropScale: number;
  impactZoom: boolean;
  speedKeyframes?: Array<{ timeSeconds: number; rate: number }>;
  notes: string[];
}

export interface AutoMontageSegment {
  index: number;
  mediaId: string;
  mediaName: string;
  sourceContentHash: string;
  game?: string;
  eventId: string;
  eventKind: AnalysisEvent['kind'];
  eventType?: GameplayEventType;
  eventLabel: string;
  reviewStatus?: 'accepted' | 'corrected';
  sourceRange?: { mediaId: string; startSeconds: string; endSeconds: string; policy: AutoMontageRangePolicy };
  sourceEventStartSeconds: number;
  sourceDecisiveSeconds: number;
  sourceEventEndSeconds: number;
  sourceInSeconds: number;
  timelineStartSeconds: number;
  timelineStartFrame: number;
  durationSeconds: number;
  durationFrames: number;
  targetAnchorSeconds: number;
  anchorKind: 'drop' | 'accent' | 'downbeat' | 'beat' | 'onset' | 'paced';
  anchorStrength: number;
  alignmentErrorFrames: number;
  evidenceLevel?: EvidenceLevel;
  uncertainties?: string[];
  effectPlan: AutoMontageEffectPlan;
  score: { highlight: number; musicFit: number; framing: number; pacing: number };
  detectors: DetectorProvenance[];
  explanation: string;
}

export interface AutoMontagePlan {
  schemaVersion: 1;
  method: 'ranked-highlight-beat-planner-v2';
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
  selection: { mode: AutoMontageSelectionMode; videoCount: number; rangePolicy?: AutoMontageRangePolicy };
  score: number;
  scoreBreakdown: { highlightQuality: number; gameplayEvidence: number; musicAlignment: number; sceneDiversity: number; pacing: number; framing: number; duration: number };
  referenceStyle?: AutoMontageReferenceProfile;
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
  performanceReportPath: string;
  variants: GeneratedAutoMontageVariant[];
}

export interface AutoMontageAnalysisInput {
  project: Project;
  musicAnalysis: AudioAnalysis;
  highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }>;
  referenceAnalysis?: HighlightAnalysis;
  referenceCutTimesSeconds?: number[];
  options: AutoMontageOptions;
}
