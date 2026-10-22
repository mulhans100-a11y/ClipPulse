import type { AnalysisEventReview, AnalysisRuntimeStatus, AudioAnalysis, AutoMontageOptions, GeneratedAutoMontages, HighlightAnalysis, ImportResult, ImportRoot, MediaAsset, MediaJob, MediaJobQueueSnapshot, Project, Rational, TimelineClip, TimelineTrack, TrackKind } from '../core/types';

export interface OpenMontageApi {
  version(): Promise<{ appVersion: string; ffmpeg: boolean; ffprobe: boolean; message?: string }>;
  createProject(): Promise<{ project: Project; path: string } | null>;
  openProject(): Promise<{ project: Project; path: string } | null>;
  openProjectFile(path: string): Promise<{ project: Project; path: string }>;
  saveProject(path: string, project: Project): Promise<void>;
  updateProjectProfile(path: string, patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'frameRate'>>): Promise<Project>;
  getProjectHistory(path: string): Promise<{ canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number }>;
  undoProject(path: string): Promise<Project>;
  redoProject(path: string): Promise<Project>;
  importMedia(path: string): Promise<{ project: Project; result: ImportResult }>;
  importMedalFolder(path: string): Promise<{ project: Project; result: ImportResult; captureFolder: string } | null>;
  findMissingMedia(path: string): Promise<string[]>;
  relinkMedia(path: string, mediaId: string): Promise<Project | null>;
  getMediaJobs(path: string): Promise<MediaJobQueueSnapshot>;
  queueProxy(path: string, mediaId: string): Promise<MediaJob>;
  queueClipWaveform(path: string, clipId: string, pixelsPerSecond: number): Promise<MediaJob>;
  pauseMediaJobs(path: string): Promise<void>;
  resumeMediaJobs(path: string): Promise<void>;
  clearCachedProxies(path: string): Promise<number>;
  retryMediaJob(path: string, jobId: string): Promise<MediaJob>;
  onMediaJobsUpdated(callback: (event: { projectPath: string } & MediaJobQueueSnapshot) => void): () => void;
  updateMediaMetadata(path: string, mediaId: string, patch: { favorite?: boolean; rating?: number; tags?: string[]; game?: string | null; analysisEventReviews?: AnalysisEventReview[] }): Promise<Project>;
  searchMedia(path: string, query: string, favoriteOnly: boolean): Promise<MediaAsset[]>;
  getImportRoots(path: string): Promise<ImportRoot[]>;
  setImportRootWatching(path: string, rootPath: string, watching: boolean): Promise<ImportRoot[]>;
  analyzeAudio(path: string, mediaId: string): Promise<AudioAnalysis>;
  analyzeHighlightCues(path: string, mediaId: string): Promise<HighlightAnalysis>;
  generateAutomaticMontages(path: string, options: AutoMontageOptions): Promise<GeneratedAutoMontages | null>;
  getAnalysisRuntimes(): Promise<AnalysisRuntimeStatus[]>;
  getAudioAnalysisStatuses(path: string): Promise<string[]>;
  addTrack(path: string, kind: TrackKind): Promise<Project>;
  updateTrack(path: string, trackId: string, patch: { muted?: boolean; solo?: boolean; locked?: boolean; volume?: number; audioRole?: TimelineTrack['audioRole']; normalizeAudio?: boolean; duckUnderDialogue?: boolean; volumeKeyframes?: TimelineTrack['volumeKeyframes'] }): Promise<Project>;
  addClip(path: string, mediaId: string, trackId: string, start: number): Promise<Project>;
  duplicateClip(path: string, clipId: string, start?: number): Promise<Project>;
  setClipAudio(path: string, clipId: string, patch: { audioEnabled?: boolean; volume?: number; fadeIn?: number; fadeOut?: number }): Promise<Project>;
  setClipEffects(path: string, clipId: string, patch: Partial<Pick<TimelineClip, 'playbackRate' | 'speedKeyframes' | 'transform' | 'color' | 'keyframes' | 'transitionIn' | 'title' | 'normalizeAudio' | 'blendMode' | 'chromaKey' | 'mask'>>): Promise<Project>;
  trimClip(path: string, clipId: string, patch: { start?: number; sourceIn?: number; duration?: number }): Promise<Project>;
  moveClip(path: string, clipId: string, start: number, trackId?: string): Promise<Project>;
  splitClip(path: string, clipId: string, at: number): Promise<Project>;
  removeClip(path: string, clipId: string): Promise<Project>;
  renderTimelineFrame(path: string, time: number): Promise<{ frame: number; time: Rational; path: string }>;
  renderTimelinePlayback(path: string): Promise<{ path: string; revision: string }>;
  onTimelinePlaybackProgress(callback: (progress: number) => void): () => void;
  exportVideo(path: string): Promise<{ outputPath: string } | null>;
  onExportProgress(callback: (progress: number) => void): () => void;
  onMediaUpdated(callback: (result: { project: Project; result: ImportResult }) => void): () => void;
  toFileUrl(path: string): string;
  reveal(path: string): Promise<void>;
}

declare global { interface Window { openmontage: OpenMontageApi; } }
