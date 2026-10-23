import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAudio, readCachedAudioAnalysis } from '../core/audioAnalysis';
import { analyzeHighlightCues } from '../core/highlightAnalysis';
import { getPublicAnalysisRuntimeStatuses } from '../core/analysisRuntimes';
import { generateAutomaticMontages } from '../core/autoMontage';
import { AppError } from '../core/errors';
import { addTrack, addClip, createProject, duplicateClip, fileExists, findMissingMedia, getProjectHistory, importMedia, loadProject, moveClip, projectCachePath, redoProject, relinkMedia, removeClip, saveProject, setClipAudio, setClipEffects, splitClip, timelineDuration, trimClip, undoProject, updateProjectProfile, updateMediaMetadata, updateTrackSettings, searchMedia, getImportRoots, setImportRootWatching } from '../core/project';
import { exportVideo } from '../core/export';
import { ffmpegAvailable } from '../core/ffmpeg';
import { add, compare, frameTime } from '../core/time';
import { watchFolder } from '../core/folderWatcher';
import type { FSWatcher } from 'chokidar';
import { medalCaptureFolderPreset } from '../core/medal';
import { renderTimelineFrame, timelinePreviewCacheKey, timelinePreviewRangeAt } from '../core/timelinePreview';
import { prunePreviewCache } from '../core/previewCache';
import { generateClipModelMask } from '../core/modelSegmentation';
import { PersistentMediaJobQueue, mediaJobQueuePath, type MediaJobSource } from '../core/mediaJobs';
import type { AutoMontageOptions, MediaAsset, Project, Rational, SegmentationOptions, TimelineClip, TimelineTrack, TrackKind } from '../core/types';
import { toFrame } from '../core/time';
import { buildMcpServerArgs, canonicalizeAllowedRoots, getExistingMcpConfiguration, installMcpConfiguration, testMcpConnection, type McpClientTarget } from './mcpSetup';

const here = __dirname;
let mainWindow: BrowserWindow | null = null;
const projectLocks = new Map<string, Promise<void>>();
let folderWatchers = new Map<string, FSWatcher>();
let watchedProjectPath: string | null = null;
const previewFrameCounts = new Map<string, number>();
const playbackRenderJobs = new Map<string, Map<string, { controller: AbortController; promise: Promise<void> }>>();
const mediaJobQueues = new Map<string, Promise<PersistentMediaJobQueue>>();

async function mediaJobQueue(filePath: string): Promise<PersistentMediaJobQueue> {
  const project = await loadProject(filePath);
  const cacheDirectory = projectCachePath(filePath, project.id);
  const cacheKey = path.resolve(cacheDirectory).toLocaleLowerCase();
  let queue = mediaJobQueues.get(cacheKey);
  if (!queue) {
    const projectPath = path.resolve(filePath);
    queue = Promise.resolve(new PersistentMediaJobQueue(cacheDirectory, mediaJobQueuePath(cacheDirectory), (snapshot) => {
      mainWindow?.webContents.send('media:jobsUpdated', { projectPath, ...snapshot });
    }));
    mediaJobQueues.set(cacheKey, queue);
  }
  return queue;
}

async function mediaJobSource(asset: MediaAsset): Promise<MediaJobSource> {
  const stat = await fs.stat(asset.path);
  if (!stat.isFile() || stat.size !== asset.sizeBytes || stat.mtime.toISOString() !== asset.modifiedAt) {
    throw new Error(`Source media changed since import: ${asset.name}. Re-import or relink it before generating derived media.`);
  }
  return {
    mediaId: asset.id, sourcePath: asset.path, contentHash: asset.contentHash, sourceSizeBytes: stat.size,
    sourceMtimeMs: stat.mtimeMs, durationSeconds: Number(asset.duration.num) / Number(asset.duration.den)
  };
}

async function pruneTimelinePreviews(directory: string, keepPath: string): Promise<void> {
  await prunePreviewCache(directory, keepPath, { maxFiles: 120, maxBytes: 128 * 1024 * 1024, maxAgeMs: 14 * 24 * 60 * 60 * 1000, matches: (name) => name.endsWith('.png') });
}

async function pruneTimelinePlaybacks(directory: string, keepPath: string): Promise<void> {
  await prunePreviewCache(directory, keepPath, { maxFiles: 24, maxBytes: 512 * 1024 * 1024, maxAgeMs: 14 * 24 * 60 * 60 * 1000, matches: (name) => name.endsWith('.mp4') });
}

function cancelPlaybackJobs(projectKey: string, keepOutputPath?: string): void {
  const jobs = playbackRenderJobs.get(projectKey);
  if (!jobs) return;
  for (const [outputPath, job] of jobs) {
    if (outputPath === keepOutputPath) continue;
    job.controller.abort();
    jobs.delete(outputPath);
  }
  if (!jobs.size) playbackRenderJobs.delete(projectKey);
}

async function ensureTimelinePlaybackCache(
  filePath: string, project: Project, range: { start: Rational; duration: Rational },
  outputPath: string, progress?: (fraction: number) => void
): Promise<boolean> {
  if (await fileExists(outputPath)) {
    const accessedAt = new Date();
    await fs.utimes(outputPath, accessedAt, accessedAt).catch(() => undefined);
    return true;
  }
  const projectKey = path.resolve(filePath).toLocaleLowerCase();
  let jobs = playbackRenderJobs.get(projectKey);
  if (!jobs) { jobs = new Map(); playbackRenderJobs.set(projectKey, jobs); }
  let job = jobs.get(outputPath);
  if (!job) {
    const controller = new AbortController();
    const currentJobs = jobs;
    const promise = (async () => {
      if (!(await fileExists(outputPath))) {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await exportVideo(project, { outputPath, overwrite: true, range, quality: 'preview', signal: controller.signal, onProgress: progress });
      }
      await pruneTimelinePlaybacks(path.dirname(outputPath), outputPath);
    })().finally(() => {
      if (currentJobs.get(outputPath)?.controller === controller) currentJobs.delete(outputPath);
      if (!currentJobs.size && playbackRenderJobs.get(projectKey) === currentJobs) playbackRenderJobs.delete(projectKey);
    });
    job = { controller, promise };
    jobs.set(outputPath, job);
  }
  try { await job.promise; return !job.controller.signal.aborted && await fileExists(outputPath); }
  catch (error) { if (job.controller.signal.aborted) return false; throw error; }
}

async function withProjectLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLocaleLowerCase();
  const previous = projectLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  projectLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (projectLocks.get(key) === current) projectLocks.delete(key); }
}

async function stopFolderWatchers(): Promise<void> {
  const closing = [...folderWatchers.values()];
  folderWatchers = new Map();
  watchedProjectPath = null;
  await Promise.all(closing.map((watcher) => watcher.close()));
}

async function activateFolderWatchers(filePath: string): Promise<void> {
  await stopFolderWatchers();
  const absoluteProjectPath = path.resolve(filePath);
  watchedProjectPath = absoluteProjectPath;
  const roots = await getImportRoots(absoluteProjectPath);
  for (const root of roots.filter((item) => item.watching)) {
    const key = path.resolve(root.path).toLocaleLowerCase();
    try {
      const watcher = watchFolder(root.path, () => {
        const activeProject = watchedProjectPath;
        if (!activeProject) return;
        void withProjectLock(activeProject, async () => {
          if (watchedProjectPath?.toLocaleLowerCase() !== activeProject.toLocaleLowerCase()) return;
          try {
            const result = await importMedia(activeProject, [root.path], root.recursive);
            if (result.added.length && watchedProjectPath?.toLocaleLowerCase() === activeProject.toLocaleLowerCase()) {
              const project = await loadProject(activeProject);
              mainWindow?.webContents.send('media:updated', { project, result });
            }
          } catch (error) { console.error(`Folder scan failed for ${root.path}:`, error); }
        });
      }, root.recursive, 1200);
      watcher.on('error', (error) => console.error(`Folder watcher failed for ${root.path}:`, error));
      folderWatchers.set(key, watcher);
    } catch (error) { console.error(`Could not watch imported folder ${root.path}:`, error); }
  }
}

async function uiFrameTime(filePath: string, value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error('Timeline time must be a finite, nonnegative value.');
  const project = await loadProject(filePath);
  const frame = Math.round(value * Number(project.frameRate.num) / Number(project.frameRate.den));
  if (!Number.isSafeInteger(frame)) throw new Error('Timeline position is too large.');
  return frameTime(frame, project.frameRate);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#101114',
    title: 'ClipPulse',
    webPreferences: {
      preload: path.join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`Preload failed (${preloadPath}):`, error));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const rendererPath = path.resolve(here, '../../renderer/index.html');
  const configuredDevUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
  let devOrigin: string | undefined;
  if (configuredDevUrl) {
    try {
      const parsed = new URL(configuredDevUrl);
      if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) devOrigin = parsed.origin;
    } catch { /* Invalid development URLs fall back to the local renderer file. */ }
  }
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    let allowed = false;
    if (devOrigin) {
      try { allowed = new URL(navigationUrl).origin === devOrigin; } catch { allowed = false; }
    } else {
      try {
        const target = new URL(navigationUrl);
        allowed = target.protocol === 'file:' && path.resolve(fileURLToPath(target)) === rendererPath;
      } catch { allowed = false; }
    }
    if (!allowed) event.preventDefault();
  });
  if (devOrigin && configuredDevUrl) void mainWindow.loadURL(configuredDevUrl);
  else void mainWindow.loadFile(rendererPath);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', () => { void stopFolderWatchers().catch((error) => console.error('Could not close folder watchers:', error)); });

ipcMain.handle('app:version', async () => ({ appVersion: app.getVersion(), ...await ffmpegAvailable() }));
ipcMain.handle('agentMcp:chooseRoot', async (event, purpose: 'media' | 'project-export' = 'media') => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('MCP setup is available only in the ClipPulse window.');
  if (purpose !== 'media' && purpose !== 'project-export') throw new Error('Choose a media or project/export folder.');
  const title = purpose === 'project-export' ? 'Choose a permanent project or export folder' : 'Choose a source media or music folder';
  const response = await dialog.showOpenDialog(mainWindow, { title, properties: ['openDirectory'] });
  if (response.canceled || !response.filePaths[0]) return null;
  return (await canonicalizeAllowedRoots([response.filePaths[0]]))[0];
});
ipcMain.handle('agentMcp:load', async (event, client: McpClientTarget) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('MCP setup is available only in the ClipPulse window.');
  if (client !== 'codex' && client !== 'claude-code') throw new Error('Choose Codex or Claude Code.');
  return getExistingMcpConfiguration(client);
});
ipcMain.handle('agentMcp:configure', async (event, client: McpClientTarget, roots: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('MCP setup is available only in the ClipPulse window.');
  if (client !== 'codex' && client !== 'claude-code') throw new Error('Choose Codex or Claude Code.');
  const allowedRoots = await canonicalizeAllowedRoots(roots);
  const launch = { command: app.getPath('exe'), args: buildMcpServerArgs(path.join(here, 'cli.js'), allowedRoots), env: { ELECTRON_RUN_AS_NODE: '1' } };
  return installMcpConfiguration({ client, roots: allowedRoots, launch });
});
ipcMain.handle('agentMcp:test', async (event, roots: unknown) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('MCP setup is available only in the ClipPulse window.');
  const allowedRoots = await canonicalizeAllowedRoots(roots);
  const launch = { command: app.getPath('exe'), args: buildMcpServerArgs(path.join(here, 'cli.js'), allowedRoots), env: { ELECTRON_RUN_AS_NODE: '1' } };
  return testMcpConnection(launch);
});
ipcMain.handle('project:create', async () => {
  const response = await dialog.showSaveDialog(mainWindow!, { title: 'New OpenMontage project', defaultPath: 'Untitled.omproj', filters: [{ name: 'OpenMontage project', extensions: ['omproj'] }] });
  if (response.canceled || !response.filePath) return null;
  const filePath = response.filePath.endsWith('.omproj') ? response.filePath : `${response.filePath}.omproj`;
  await stopFolderWatchers();
  return { project: await createProject(filePath), path: filePath };
});
ipcMain.handle('project:open', async () => {
  const response = await dialog.showOpenDialog(mainWindow!, { title: 'Open project', properties: ['openFile'], filters: [{ name: 'OpenMontage project', extensions: ['omproj'] }, { name: 'JSON', extensions: ['json'] }] });
  const filePath = response.filePaths[0];
  if (response.canceled || !filePath) return null;
  const project = await loadProject(filePath);
  await activateFolderWatchers(filePath);
  return { project, path: filePath };
});
ipcMain.handle('project:openFile', async (_event, filePath: string) => {
  const target = path.resolve(filePath);
  const project = await loadProject(target);
  await activateFolderWatchers(target);
  return { project, path: target };
});
ipcMain.handle('project:save', (_event, filePath, project) => withProjectLock(filePath, () => saveProject(filePath, project)));
ipcMain.handle('project:updateProfile', (_event, filePath: string, patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'frameRate'>>) => withProjectLock(filePath, () => updateProjectProfile(filePath, patch)));
ipcMain.handle('project:history', (_event, filePath: string) => withProjectLock(filePath, () => getProjectHistory(filePath)));
ipcMain.handle('project:undo', (_event, filePath: string) => withProjectLock(filePath, () => undoProject(filePath)));
ipcMain.handle('project:redo', (_event, filePath: string) => withProjectLock(filePath, () => redoProject(filePath)));
ipcMain.handle('media:import', async (_event, filePath: string) => {
  const response = await dialog.showOpenDialog(mainWindow!, { title: 'Import media', properties: ['openFile', 'openDirectory', 'multiSelections'] });
  if (response.canceled || !response.filePaths.length) return { project: await loadProject(filePath), result: { added: [], duplicates: [], errors: [], watchedRoots: [] } };
  const result = await withProjectLock(filePath, () => importMedia(filePath, response.filePaths, true));
  await activateFolderWatchers(filePath);
  return { project: await loadProject(filePath), result };
});
ipcMain.handle('media:importMusic', async (_event, filePath: string) => {
  const response = await dialog.showOpenDialog(mainWindow!, {
    title: 'Import your music',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio files', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] }]
  });
  if (response.canceled || !response.filePaths.length) return null;
  const result = await withProjectLock(filePath, () => importMedia(filePath, response.filePaths, false));
  return { project: await loadProject(filePath), result };
});
ipcMain.handle('media:importMedalFolder', async (_event, filePath: string) => {
  const preset = medalCaptureFolderPreset();
  let captureFolder: string | null = null;
  if (preset) {
    try { if ((await fs.stat(preset)).isDirectory()) captureFolder = preset; }
    catch { /* The user may have changed Medal's capture location. */ }
  }
  if (!captureFolder) {
    const response = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select Medal capture folder',
      defaultPath: preset ? path.dirname(preset) : undefined,
      properties: ['openDirectory']
    });
    if (response.canceled || !response.filePaths[0]) return null;
    captureFolder = response.filePaths[0];
  }
  const result = await withProjectLock(filePath, () => importMedia(filePath, [captureFolder!], true));
  await activateFolderWatchers(filePath);
  return { project: await loadProject(filePath), result, captureFolder };
});
ipcMain.handle('media:findMissing', (_event, filePath: string) => findMissingMedia(filePath));
ipcMain.handle('media:relink', async (_event, filePath: string, mediaId: string) => {
  const response = await dialog.showOpenDialog(mainWindow!, { title: 'Relink missing media', properties: ['openFile'], filters: [{ name: 'Video and audio media', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'wmv', 'flv', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'] }] });
  if (response.canceled || !response.filePaths[0]) return null;
  return withProjectLock(filePath, async () => {
    const next = await relinkMedia(filePath, mediaId, response.filePaths[0]);
    const asset = next.media.find((item) => item.id === mediaId);
    if (asset) await (await mediaJobQueue(filePath)).invalidateMedia(mediaId, asset.contentHash);
    return next;
  });
});
ipcMain.handle('media:updateMetadata', (_event, filePath: string, mediaId: string, patch) => withProjectLock(filePath, () => updateMediaMetadata(filePath, mediaId, patch)));
ipcMain.handle('media:getJobs', async (_event, filePath: string) => (await mediaJobQueue(filePath)).status());
ipcMain.handle('media:queueProxy', async (_event, filePath: string, mediaId: string) => {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  if (asset.kind !== 'video') throw new AppError('MEDIA_TYPE_MISMATCH', 'Proxy jobs are available for video media only.');
  return (await mediaJobQueue(filePath)).enqueueProxy(await mediaJobSource(asset));
});
ipcMain.handle('media:queueClipWaveform', async (_event, filePath: string, clipId: string, pixelsPerSecond: number) => {
  const project = await loadProject(filePath);
  const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
  const clip = track?.clips.find((item) => item.id === clipId);
  if (!clip) throw new AppError('CLIP_NOT_FOUND', `Timeline clip not found: ${clipId}`);
  const asset = project.media.find((item) => item.id === clip.mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${clip.mediaId}`);
  if (track?.kind !== 'audio' || !asset.hasAudio) throw new AppError('NO_AUDIO_STREAM', 'Per-clip waveforms require an audio-track clip with an audio stream.');
  const source = await mediaJobSource(asset);
  return (await mediaJobQueue(filePath)).enqueueClipWaveform(source, {
    clipId, sourceInSeconds: Number(clip.sourceIn.num) / Number(clip.sourceIn.den),
    durationSeconds: Number(clip.duration.num) / Number(clip.duration.den)
  }, pixelsPerSecond);
});
ipcMain.handle('media:pauseJobs', async (_event, filePath: string) => (await mediaJobQueue(filePath)).pause());
ipcMain.handle('media:resumeJobs', async (_event, filePath: string) => (await mediaJobQueue(filePath)).resume());
ipcMain.handle('media:clearCachedProxies', async (_event, filePath: string) => (await mediaJobQueue(filePath)).clearCompletedProxies());
ipcMain.handle('media:retryJob', async (_event, filePath: string, jobId: string) => (await mediaJobQueue(filePath)).retry(jobId));
ipcMain.handle('media:search', (_event, filePath: string, query: string, favoriteOnly: boolean) => searchMedia(filePath, query, favoriteOnly));
ipcMain.handle('media:getImportRoots', (_event, filePath: string) => getImportRoots(filePath));
ipcMain.handle('media:analyzeAudio', async (_event, filePath: string, mediaId: string) => {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  if (!asset.hasAudio) throw new AppError('NO_AUDIO_STREAM', `Media asset has no audio stream: ${asset.name}`);
  const cachePath = path.join(projectCachePath(filePath, project.id), 'analysis', `${asset.id}.json`);
  return analyzeAudio(asset.path, cachePath);
});
ipcMain.handle('media:analyzeHighlightCues', async (_event, filePath: string, mediaId: string) => {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  const analysisDirectory = path.join(projectCachePath(filePath, project.id), 'analysis');
  let audioAnalysis;
  let audioAnalysisError: string | undefined;
  if (asset.hasAudio) {
    try { audioAnalysis = await analyzeAudio(asset.path, path.join(analysisDirectory, `${asset.id}.json`)); }
    catch (error) { audioAnalysisError = error instanceof Error ? error.message : String(error); }
  }
  const cachePath = path.join(analysisDirectory, `cues-${asset.id}.json`);
  return analyzeHighlightCues({
    mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind,
    durationSeconds: Number(asset.duration.num) / Number(asset.duration.den), game: asset.game, audioAnalysis, audioAnalysisError
  }, cachePath);
});
ipcMain.handle('montage:generate', async (_event, filePath: string, options: AutoMontageOptions) => {
  const response = await dialog.showOpenDialog(mainWindow!, {
    title: 'Choose where to save editable montage variants',
    defaultPath: path.dirname(path.resolve(filePath)),
    properties: ['openDirectory']
  });
  if (response.canceled || !response.filePaths[0]) return null;
  return generateAutomaticMontages(filePath, response.filePaths[0], options);
});
ipcMain.handle('media:getAnalysisRuntimes', () => getPublicAnalysisRuntimeStatuses());
ipcMain.handle('media:getAudioAnalysisStatuses', async (_event, filePath: string) => {
  const project = await loadProject(filePath);
  const cacheDirectory = path.join(projectCachePath(filePath, project.id), 'analysis');
  const cacheFiles = new Set(await fs.readdir(cacheDirectory).catch(() => [] as string[]));
  const candidates = project.media.filter((asset) => asset.hasAudio && cacheFiles.has(`${asset.id}.json`));
  const ready: string[] = [];
  for (let offset = 0; offset < candidates.length; offset += 24) {
    const batch = await Promise.all(candidates.slice(offset, offset + 24).map(async (asset) => {
      const cachePath = path.join(cacheDirectory, `${asset.id}.json`);
      return await readCachedAudioAnalysis(asset.path, cachePath) ? asset.id : null;
    }));
    ready.push(...batch.filter((id): id is string => id !== null));
  }
  return ready;
});
ipcMain.handle('media:setRootWatching', async (_event, filePath: string, rootPath: string, watching: boolean) => {
  const roots = await withProjectLock(filePath, () => setImportRootWatching(filePath, rootPath, watching));
  await activateFolderWatchers(filePath);
  return roots;
});
ipcMain.handle('timeline:addTrack', (_event, filePath: string, kind: TrackKind) => withProjectLock(filePath, () => addTrack(filePath, kind)));
ipcMain.handle('timeline:updateTrack', (_event, filePath: string, trackId: string, patch: { muted?: boolean; solo?: boolean; locked?: boolean; volume?: number; audioRole?: TimelineTrack['audioRole']; normalizeAudio?: boolean; duckUnderDialogue?: boolean; volumeKeyframes?: TimelineTrack['volumeKeyframes'] }) => withProjectLock(filePath, () => updateTrackSettings(filePath, trackId, patch)));
ipcMain.handle('timeline:addClip', (_event, filePath: string, mediaId: string, trackId: string, start: number) => withProjectLock(filePath, async () => addClip(filePath, mediaId, trackId, await uiFrameTime(filePath, start))));
ipcMain.handle('timeline:duplicateClip', (_event, filePath: string, clipId: string, start?: number) => withProjectLock(filePath, async () => duplicateClip(filePath, clipId, start === undefined ? undefined : await uiFrameTime(filePath, start))));
ipcMain.handle('timeline:setClipAudio', async (_event, filePath: string, clipId: string, patch: { audioEnabled?: boolean; volume?: number; fadeIn?: number; fadeOut?: number }) => {
  const converted = { ...patch, fadeIn: patch.fadeIn === undefined ? undefined : await uiFrameTime(filePath, patch.fadeIn), fadeOut: patch.fadeOut === undefined ? undefined : await uiFrameTime(filePath, patch.fadeOut) };
  return withProjectLock(filePath, () => setClipAudio(filePath, clipId, converted));
});
ipcMain.handle('timeline:setClipEffects', (_event, filePath: string, clipId: string, patch: Partial<Pick<TimelineClip, 'playbackRate' | 'speedKeyframes' | 'transform' | 'color' | 'keyframes' | 'transitionIn' | 'title' | 'normalizeAudio' | 'blendMode' | 'chromaKey' | 'mask'>>) => withProjectLock(filePath, () => setClipEffects(filePath, clipId, patch)));
ipcMain.handle('timeline:generateModelMask', async (_event, filePath: string, clipId: string, options: SegmentationOptions = {}) => {
  const source = await withProjectLock(filePath, async () => {
    const project = await loadProject(filePath);
    const track = project.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const clip = track?.clips.find((item) => item.id === clipId);
    const media = clip ? project.media.find((item) => item.id === clip.mediaId) : undefined;
    if (!clip || !media || media.kind !== 'video' || track?.kind !== 'video') throw new AppError('SEGMENTATION_NOT_VIDEO', 'Select a video clip on a video track before generating an AI mask.');
    const stat = await fs.stat(media.path);
    if (!stat.isFile() || stat.size !== media.sizeBytes || stat.mtime.toISOString() !== media.modifiedAt) throw new AppError('SEGMENTATION_SOURCE_CHANGED', 'The source video changed since it was imported. Re-import or relink it before generating a mask.');
    return { project, clip: structuredClone(clip), media: structuredClone(media) };
  });
  const mask = await generateClipModelMask(source.media.path, source.clip, source.project, path.join(app.getPath('userData'), 'models'), options,
    (progress) => mainWindow?.webContents.send('timeline:segmentationProgress', { clipId, ...progress }));
  return withProjectLock(filePath, async () => {
    const current = await loadProject(filePath);
    const currentTrack = current.tracks.find((item) => item.clips.some((clip) => clip.id === clipId));
    const currentClip = currentTrack?.clips.find((item) => item.id === clipId);
    const currentMedia = currentClip ? current.media.find((item) => item.id === currentClip.mediaId) : undefined;
    const clipSignature = (clip: TimelineClip) => JSON.stringify({ mediaId: clip.mediaId, sourceIn: clip.sourceIn, duration: clip.duration, playbackRate: clip.playbackRate, speedKeyframes: clip.speedKeyframes, transform: clip.transform });
    const currentStat = currentMedia ? await fs.stat(currentMedia.path).catch(() => undefined) : undefined;
    const profileChanged = current.width !== source.project.width || current.height !== source.project.height || JSON.stringify(current.frameRate) !== JSON.stringify(source.project.frameRate);
    if (!currentClip || !currentMedia || currentMedia.contentHash !== source.media.contentHash || !currentStat || currentStat.size !== source.media.sizeBytes || currentStat.mtime.toISOString() !== source.media.modifiedAt || profileChanged || clipSignature(currentClip) !== clipSignature(source.clip) || JSON.stringify(currentClip.mask ?? null) !== JSON.stringify(source.clip.mask ?? null)) {
      throw new AppError('SEGMENTATION_PROJECT_CHANGED', 'The selected clip changed while the model was generating its mask. Select it again and retry.');
    }
    return setClipEffects(filePath, clipId, { mask });
  });
});
ipcMain.handle('timeline:trimClip', async (_event, filePath: string, clipId: string, patch: { start?: number; sourceIn?: number; duration?: number }) => {
  const converted = Object.fromEntries(await Promise.all(Object.entries(patch).map(async ([key, value]) => [key, value === undefined ? undefined : await uiFrameTime(filePath, value)])));
  return withProjectLock(filePath, () => trimClip(filePath, clipId, converted));
});
ipcMain.handle('timeline:moveClip', (_event, filePath: string, clipId: string, start: number, trackId?: string) => withProjectLock(filePath, async () => moveClip(filePath, clipId, await uiFrameTime(filePath, start), trackId)));
ipcMain.handle('timeline:splitClip', (_event, filePath: string, clipId: string, at: number) => withProjectLock(filePath, async () => splitClip(filePath, clipId, await uiFrameTime(filePath, at))));
ipcMain.handle('timeline:removeClip', (_event, filePath: string, clipId: string) => withProjectLock(filePath, () => removeClip(filePath, clipId)));
ipcMain.handle('timeline:previewFrame', (_event, filePath: string, requestedTime: number) => withProjectLock(filePath, async () => {
  const project = await loadProject(filePath);
  const time = await uiFrameTime(filePath, requestedTime);
  const frame = toFrame(time, project.frameRate);
  const key = timelinePreviewCacheKey(project, { start: time, duration: frameTime(1, project.frameRate) }, 'final');
  const outputPath = path.join(projectCachePath(filePath, project.id), 'timeline-preview', `${key}-${frame}.png`);
  if (await fileExists(outputPath)) {
    const accessedAt = new Date();
    await fs.utimes(outputPath, accessedAt, accessedAt).catch(() => undefined);
  } else {
    await renderTimelineFrame(project, time, outputPath);
    const count = (previewFrameCounts.get(path.resolve(filePath)) ?? 0) + 1;
    previewFrameCounts.set(path.resolve(filePath), count);
    if (count % 40 === 0) await pruneTimelinePreviews(path.dirname(outputPath), outputPath);
  }
  return { frame, time, path: outputPath };
}));
ipcMain.handle('timeline:cancelPlaybackPreview', (_event, filePath: string) => {
  const key = path.resolve(filePath).toLocaleLowerCase();
  cancelPlaybackJobs(key);
  return { cancelled: true };
});
ipcMain.handle('timeline:playbackPreview', async (_event, filePath: string, requestedTime: number) => {
  const requestKey = path.resolve(filePath).toLocaleLowerCase();
  try {
    const { project, playhead } = await withProjectLock(filePath, async () => {
      const loaded = await loadProject(filePath);
      if (!Number.isFinite(requestedTime) || requestedTime < 0) throw new AppError('INVALID_TIME', 'Preview time must be a finite, nonnegative value.');
      const frame = Math.round(requestedTime * Number(loaded.frameRate.num) / Number(loaded.frameRate.den));
      if (!Number.isSafeInteger(frame)) throw new AppError('TIME_OVERFLOW', 'Timeline position is too large.');
      return { project: loaded, playhead: frameTime(frame, loaded.frameRate) };
    });
    const range = timelinePreviewRangeAt(project, playhead);
    const key = timelinePreviewCacheKey(project, range, 'preview');
    const outputPath = path.join(projectCachePath(filePath, project.id), 'timeline-playback', `${key}.mp4`);
    cancelPlaybackJobs(requestKey, outputPath);
    const ready = await ensureTimelinePlaybackCache(filePath, project, range, outputPath,
      (progress) => mainWindow?.webContents.send('timeline:playbackProgress', progress));
    if (!ready) return { cancelled: true as const };
    const nextStart = add(range.start, range.duration);
    if (compare(nextStart, timelineDuration(project)) < 0) {
      const nextRange = timelinePreviewRangeAt(project, nextStart);
      const nextKey = timelinePreviewCacheKey(project, nextRange, 'preview');
      const nextPath = path.join(projectCachePath(filePath, project.id), 'timeline-playback', `${nextKey}.mp4`);
      if (nextPath !== outputPath) void ensureTimelinePlaybackCache(filePath, project, nextRange, nextPath).catch(() => undefined);
    }
    return {
      path: outputPath, revision: project.updatedAt, startTime: range.start, duration: range.duration,
      hasMore: compare(add(range.start, range.duration), timelineDuration(project)) < 0
    };
  } catch (error) {
    throw error;
  }
});
ipcMain.handle('video:export', async (_event, filePath: string) => {
  const response = await dialog.showSaveDialog(mainWindow!, { title: 'Export video', defaultPath: 'Montage.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  if (response.canceled || !response.filePath) return null;
  const outputPath = response.filePath.toLowerCase().endsWith('.mp4') ? response.filePath : `${response.filePath}.mp4`;
  const project = await loadProject(filePath);
  await exportVideo(project, { outputPath, overwrite: true, onProgress: (progress) => mainWindow?.webContents.send('video:progress', progress) });
  return { outputPath };
});
ipcMain.handle('shell:reveal', (_event, filePath: string) => shell.showItemInFolder(filePath));
