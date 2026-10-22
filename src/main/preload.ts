import { contextBridge, ipcRenderer } from 'electron';
import type { OpenMontageApi } from '../shared/electron';
import type { AnalysisRuntimeStatus, AudioAnalysis, GeneratedAutoMontages, HighlightAnalysis, MediaJob, MediaJobQueueSnapshot } from '../core/types';

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encodeParts = (parts: string[]) => parts.map((part) => encodeURIComponent(part)).join('/');
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized.slice(0, 2);
    return `file:///${drive}/${encodeParts(normalized.slice(3).split('/'))}`;
  }
  if (normalized.startsWith('//')) {
    const [, , host, ...parts] = normalized.split('/');
    return `file://${encodeURIComponent(host)}/${encodeParts(parts)}`;
  }
  return `file://${encodeParts(normalized.split('/'))}`;
}

const api: OpenMontageApi = {
  version: () => ipcRenderer.invoke('app:version'),
  createProject: () => ipcRenderer.invoke('project:create'),
  openProject: () => ipcRenderer.invoke('project:open'),
  openProjectFile: (filePath) => ipcRenderer.invoke('project:openFile', filePath),
  saveProject: (filePath, project) => ipcRenderer.invoke('project:save', filePath, project),
  updateProjectProfile: (filePath, patch) => ipcRenderer.invoke('project:updateProfile', filePath, patch),
  getProjectHistory: (filePath) => ipcRenderer.invoke('project:history', filePath),
  undoProject: (filePath) => ipcRenderer.invoke('project:undo', filePath),
  redoProject: (filePath) => ipcRenderer.invoke('project:redo', filePath),
  importMedia: (filePath) => ipcRenderer.invoke('media:import', filePath),
  importMedalFolder: (filePath) => ipcRenderer.invoke('media:importMedalFolder', filePath),
  findMissingMedia: (filePath) => ipcRenderer.invoke('media:findMissing', filePath),
  relinkMedia: (filePath, mediaId) => ipcRenderer.invoke('media:relink', filePath, mediaId),
  getMediaJobs: (filePath) => ipcRenderer.invoke('media:getJobs', filePath) as Promise<MediaJobQueueSnapshot>,
  queueProxy: (filePath, mediaId) => ipcRenderer.invoke('media:queueProxy', filePath, mediaId) as Promise<MediaJob>,
  queueClipWaveform: (filePath, clipId, pixelsPerSecond) => ipcRenderer.invoke('media:queueClipWaveform', filePath, clipId, pixelsPerSecond) as Promise<MediaJob>,
  pauseMediaJobs: (filePath) => ipcRenderer.invoke('media:pauseJobs', filePath),
  resumeMediaJobs: (filePath) => ipcRenderer.invoke('media:resumeJobs', filePath),
  clearCachedProxies: (filePath) => ipcRenderer.invoke('media:clearCachedProxies', filePath) as Promise<number>,
  retryMediaJob: (filePath, jobId) => ipcRenderer.invoke('media:retryJob', filePath, jobId) as Promise<MediaJob>,
  onMediaJobsUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: { projectPath: string } & MediaJobQueueSnapshot) => callback(event);
    ipcRenderer.on('media:jobsUpdated', listener);
    return () => ipcRenderer.removeListener('media:jobsUpdated', listener);
  },
  updateMediaMetadata: (filePath, mediaId, patch) => ipcRenderer.invoke('media:updateMetadata', filePath, mediaId, patch),
  searchMedia: (filePath, query, favoriteOnly) => ipcRenderer.invoke('media:search', filePath, query, favoriteOnly),
  getImportRoots: (filePath) => ipcRenderer.invoke('media:getImportRoots', filePath),
  setImportRootWatching: (filePath, rootPath, watching) => ipcRenderer.invoke('media:setRootWatching', filePath, rootPath, watching),
  analyzeAudio: (filePath, mediaId) => ipcRenderer.invoke('media:analyzeAudio', filePath, mediaId) as Promise<AudioAnalysis>,
  analyzeHighlightCues: (filePath, mediaId) => ipcRenderer.invoke('media:analyzeHighlightCues', filePath, mediaId) as Promise<HighlightAnalysis>,
  generateAutomaticMontages: (filePath, options) => ipcRenderer.invoke('montage:generate', filePath, options) as Promise<GeneratedAutoMontages | null>,
  getAnalysisRuntimes: () => ipcRenderer.invoke('media:getAnalysisRuntimes') as Promise<AnalysisRuntimeStatus[]>,
  getAudioAnalysisStatuses: (filePath) => ipcRenderer.invoke('media:getAudioAnalysisStatuses', filePath) as Promise<string[]>,
  addTrack: (filePath, kind) => ipcRenderer.invoke('timeline:addTrack', filePath, kind),
  updateTrack: (filePath, trackId, patch) => ipcRenderer.invoke('timeline:updateTrack', filePath, trackId, patch),
  addClip: (filePath, mediaId, trackId, start) => ipcRenderer.invoke('timeline:addClip', filePath, mediaId, trackId, start),
  duplicateClip: (filePath, clipId, start) => ipcRenderer.invoke('timeline:duplicateClip', filePath, clipId, start),
  setClipAudio: (filePath, clipId, patch) => ipcRenderer.invoke('timeline:setClipAudio', filePath, clipId, patch),
  trimClip: (filePath, clipId, patch) => ipcRenderer.invoke('timeline:trimClip', filePath, clipId, patch),
  moveClip: (filePath, clipId, start, trackId) => ipcRenderer.invoke('timeline:moveClip', filePath, clipId, start, trackId),
  splitClip: (filePath, clipId, at) => ipcRenderer.invoke('timeline:splitClip', filePath, clipId, at),
  removeClip: (filePath, clipId) => ipcRenderer.invoke('timeline:removeClip', filePath, clipId),
  renderTimelineFrame: (filePath, time) => ipcRenderer.invoke('timeline:previewFrame', filePath, time),
  renderTimelinePlayback: (filePath) => ipcRenderer.invoke('timeline:playbackPreview', filePath),
  onTimelinePlaybackProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: number) => callback(progress);
    ipcRenderer.on('timeline:playbackProgress', listener);
    return () => ipcRenderer.removeListener('timeline:playbackProgress', listener);
  },
  exportVideo: (filePath) => ipcRenderer.invoke('video:export', filePath),
  onExportProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: number) => callback(progress);
    ipcRenderer.on('video:progress', listener);
    return () => ipcRenderer.removeListener('video:progress', listener);
  },
  onMediaUpdated: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, result: { project: import('../core/types').Project; result: import('../core/types').ImportResult }) => callback(result);
    ipcRenderer.on('media:updated', listener);
    return () => ipcRenderer.removeListener('media:updated', listener);
  },
  toFileUrl,
  reveal: (filePath) => ipcRenderer.invoke('shell:reveal', filePath)
};

contextBridge.exposeInMainWorld('openmontage', api);
