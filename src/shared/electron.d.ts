import type { AudioAnalysis, ImportResult, ImportRoot, MediaAsset, Project, Rational, TimelineClip, TrackKind } from '../core/types';

export interface OpenMontageApi {
  version(): Promise<{ appVersion: string; ffmpeg: boolean; ffprobe: boolean; message?: string }>;
  createProject(): Promise<{ project: Project; path: string } | null>;
  openProject(): Promise<{ project: Project; path: string } | null>;
  saveProject(path: string, project: Project): Promise<void>;
  getProjectHistory(path: string): Promise<{ canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number }>;
  undoProject(path: string): Promise<Project>;
  redoProject(path: string): Promise<Project>;
  importMedia(path: string): Promise<{ project: Project; result: ImportResult }>;
  findMissingMedia(path: string): Promise<string[]>;
  relinkMedia(path: string, mediaId: string): Promise<Project | null>;
  updateMediaMetadata(path: string, mediaId: string, patch: { favorite?: boolean; tags?: string[]; game?: string | null }): Promise<Project>;
  searchMedia(path: string, query: string, favoriteOnly: boolean): Promise<MediaAsset[]>;
  getImportRoots(path: string): Promise<ImportRoot[]>;
  setImportRootWatching(path: string, rootPath: string, watching: boolean): Promise<ImportRoot[]>;
  analyzeAudio(path: string, mediaId: string): Promise<AudioAnalysis>;
  addTrack(path: string, kind: TrackKind): Promise<Project>;
  addClip(path: string, mediaId: string, trackId: string, start: number): Promise<Project>;
  trimClip(path: string, clipId: string, patch: { start?: number; sourceIn?: number; duration?: number }): Promise<Project>;
  moveClip(path: string, clipId: string, start: number, trackId?: string): Promise<Project>;
  splitClip(path: string, clipId: string, at: number): Promise<Project>;
  removeClip(path: string, clipId: string): Promise<Project>;
  renderTimelineFrame(path: string, time: number): Promise<{ frame: number; time: Rational; path: string }>;
  exportVideo(path: string): Promise<{ outputPath: string } | null>;
  onExportProgress(callback: (progress: number) => void): () => void;
  onMediaUpdated(callback: (result: { project: Project; result: ImportResult }) => void): () => void;
  toFileUrl(path: string): string;
  reveal(path: string): Promise<void>;
}

declare global { interface Window { openmontage: OpenMontageApi; } }
