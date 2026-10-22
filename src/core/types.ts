export type Rational = { num: string; den: string };
export type TrackKind = 'video' | 'audio';

export interface BpmHypothesis {
  bpm: number;
  score: number;
}

export interface AudioAnalysis {
  method: 'rms-onset-autocorrelation-v1';
  sampleRate: number;
  hopSeconds: number;
  durationSeconds: number;
  estimatedBpm?: number;
  bpmHypotheses: BpmHypothesis[];
  beatPhaseSeconds?: number;
  beats: number[];
  onsets: number[];
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
