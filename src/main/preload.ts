import { contextBridge, ipcRenderer } from 'electron';
import type { OpenMontageApi } from '../shared/electron';
import type { AudioAnalysis } from '../core/types';

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
  saveProject: (filePath, project) => ipcRenderer.invoke('project:save', filePath, project),
  updateProjectProfile: (filePath, patch) => ipcRenderer.invoke('project:updateProfile', filePath, patch),
  getProjectHistory: (filePath) => ipcRenderer.invoke('project:history', filePath),
  undoProject: (filePath) => ipcRenderer.invoke('project:undo', filePath),
  redoProject: (filePath) => ipcRenderer.invoke('project:redo', filePath),
  importMedia: (filePath) => ipcRenderer.invoke('media:import', filePath),
  findMissingMedia: (filePath) => ipcRenderer.invoke('media:findMissing', filePath),
  relinkMedia: (filePath, mediaId) => ipcRenderer.invoke('media:relink', filePath, mediaId),
  updateMediaMetadata: (filePath, mediaId, patch) => ipcRenderer.invoke('media:updateMetadata', filePath, mediaId, patch),
  searchMedia: (filePath, query, favoriteOnly) => ipcRenderer.invoke('media:search', filePath, query, favoriteOnly),
  getImportRoots: (filePath) => ipcRenderer.invoke('media:getImportRoots', filePath),
  setImportRootWatching: (filePath, rootPath, watching) => ipcRenderer.invoke('media:setRootWatching', filePath, rootPath, watching),
  analyzeAudio: (filePath, mediaId) => ipcRenderer.invoke('media:analyzeAudio', filePath, mediaId) as Promise<AudioAnalysis>,
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
