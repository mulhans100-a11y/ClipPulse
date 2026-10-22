import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { analyzeAudio, readCachedAudioAnalysis } from '../core/audioAnalysis';
import { analyzeHighlightCues } from '../core/highlightAnalysis';
import { AppError } from '../core/errors';
import { addTrack, addClip, createProject, duplicateClip, fileExists, findMissingMedia, getProjectHistory, importMedia, loadProject, moveClip, projectCachePath, redoProject, relinkMedia, removeClip, saveProject, setClipAudio, splitClip, trimClip, undoProject, updateProjectProfile, updateMediaMetadata, updateTrackSettings, searchMedia, getImportRoots, setImportRootWatching } from '../core/project';
import { exportVideo } from '../core/export';
import { ffmpegAvailable } from '../core/ffmpeg';
import { frameTime } from '../core/time';
import { watchFolder } from '../core/folderWatcher';
import { medalCaptureFolderPreset } from '../core/medal';
import { renderTimelineFrame } from '../core/timelinePreview';
import type { Project, TrackKind } from '../core/types';
import { toFrame } from '../core/time';

const here = __dirname;
let mainWindow: BrowserWindow | null = null;
const projectLocks = new Map<string, Promise<void>>();
let folderWatchers = new Map<string, FSWatcher>();
let watchedProjectPath: string | null = null;
const previewFrameCounts = new Map<string, number>();

async function pruneTimelinePreviews(directory: string, keepPath: string): Promise<void> {
  const files = await fs.readdir(directory).catch(() => [] as string[]);
  if (files.length <= 120) return;
  const ranked = await Promise.all(files.filter((file) => file.endsWith('.png')).map(async (file) => {
    const fullPath = path.join(directory, file);
    try { return { fullPath, modified: (await fs.stat(fullPath)).mtimeMs }; }
    catch { return { fullPath, modified: 0 }; }
  }));
  ranked.sort((a, b) => b.modified - a.modified);
  const keep = new Set([keepPath, ...ranked.slice(0, 120).map((file) => file.fullPath)]);
  await Promise.all(ranked.filter((file) => !keep.has(file.fullPath)).map((file) => fs.rm(file.fullPath, { force: true })));
}

async function pruneTimelinePlaybacks(directory: string, keepPath: string): Promise<void> {
  const files = await fs.readdir(directory).catch(() => [] as string[]);
  const ranked = await Promise.all(files.filter((file) => file.endsWith('.mp4')).map(async (file) => {
    const fullPath = path.join(directory, file);
    try { return { fullPath, modified: (await fs.stat(fullPath)).mtimeMs }; }
    catch { return { fullPath, modified: 0 }; }
  }));
  if (ranked.length <= 4) return;
  ranked.sort((a, b) => b.modified - a.modified);
  const keep = new Set([keepPath, ...ranked.slice(0, 4).map((file) => file.fullPath)]);
  await Promise.all(ranked.filter((file) => !keep.has(file.fullPath)).map((file) => fs.rm(file.fullPath, { force: true }).catch(() => undefined)));
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

function stopFolderWatchers(): void {
  for (const watcher of folderWatchers.values()) watcher.close();
  folderWatchers = new Map();
  watchedProjectPath = null;
}

async function activateFolderWatchers(filePath: string): Promise<void> {
  stopFolderWatchers();
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
    title: 'OpenMontage AI',
    webPreferences: {
      preload: path.join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`Preload failed (${preloadPath}):`, error));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(here, '../../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', stopFolderWatchers);

ipcMain.handle('app:version', async () => ({ appVersion: app.getVersion(), ...await ffmpegAvailable() }));
ipcMain.handle('project:create', async () => {
  const response = await dialog.showSaveDialog(mainWindow!, { title: 'New OpenMontage project', defaultPath: 'Untitled.omproj', filters: [{ name: 'OpenMontage project', extensions: ['omproj'] }] });
  if (response.canceled || !response.filePath) return null;
  const filePath = response.filePath.endsWith('.omproj') ? response.filePath : `${response.filePath}.omproj`;
  stopFolderWatchers();
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
  return withProjectLock(filePath, () => relinkMedia(filePath, mediaId, response.filePaths[0]));
});
ipcMain.handle('media:updateMetadata', (_event, filePath: string, mediaId: string, patch) => withProjectLock(filePath, () => updateMediaMetadata(filePath, mediaId, patch)));
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
    durationSeconds: Number(asset.duration.num) / Number(asset.duration.den), audioAnalysis, audioAnalysisError
  }, cachePath);
});
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
ipcMain.handle('timeline:updateTrack', (_event, filePath: string, trackId: string, patch: { muted?: boolean; solo?: boolean; locked?: boolean }) => withProjectLock(filePath, () => updateTrackSettings(filePath, trackId, patch)));
ipcMain.handle('timeline:addClip', (_event, filePath: string, mediaId: string, trackId: string, start: number) => withProjectLock(filePath, async () => addClip(filePath, mediaId, trackId, await uiFrameTime(filePath, start))));
ipcMain.handle('timeline:duplicateClip', (_event, filePath: string, clipId: string, start?: number) => withProjectLock(filePath, async () => duplicateClip(filePath, clipId, start === undefined ? undefined : await uiFrameTime(filePath, start))));
ipcMain.handle('timeline:setClipAudio', async (_event, filePath: string, clipId: string, patch: { audioEnabled?: boolean; volume?: number; fadeIn?: number; fadeOut?: number }) => {
  const converted = { ...patch, fadeIn: patch.fadeIn === undefined ? undefined : await uiFrameTime(filePath, patch.fadeIn), fadeOut: patch.fadeOut === undefined ? undefined : await uiFrameTime(filePath, patch.fadeOut) };
  return withProjectLock(filePath, () => setClipAudio(filePath, clipId, converted));
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
  const revision = createHash('sha256').update(JSON.stringify(project)).digest('hex').slice(0, 16);
  const outputPath = path.join(projectCachePath(filePath, project.id), 'timeline-preview', `${revision}-${frame}.png`);
  if (!(await fileExists(outputPath))) {
    await renderTimelineFrame(project, time, outputPath);
    const count = (previewFrameCounts.get(path.resolve(filePath)) ?? 0) + 1;
    previewFrameCounts.set(path.resolve(filePath), count);
    if (count % 40 === 0) await pruneTimelinePreviews(path.dirname(outputPath), outputPath);
  }
  return { frame, time, path: outputPath };
}));
ipcMain.handle('timeline:playbackPreview', (_event, filePath: string) => withProjectLock(filePath, async () => {
  const project = await loadProject(filePath);
  const revision = createHash('sha256').update(JSON.stringify(project)).digest('hex').slice(0, 24);
  const outputPath = path.join(projectCachePath(filePath, project.id), 'timeline-playback', `${revision}.mp4`);
  if (!(await fileExists(outputPath))) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await exportVideo(project, {
      outputPath,
      overwrite: true,
      onProgress: (progress) => mainWindow?.webContents.send('timeline:playbackProgress', progress)
    });
  }
  await pruneTimelinePlaybacks(path.dirname(outputPath), outputPath);
  return { path: outputPath, revision: project.updatedAt };
}));
ipcMain.handle('video:export', async (_event, filePath: string) => {
  const response = await dialog.showSaveDialog(mainWindow!, { title: 'Export video', defaultPath: 'Montage.mp4', filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
  if (response.canceled || !response.filePath) return null;
  const outputPath = response.filePath.toLowerCase().endsWith('.mp4') ? response.filePath : `${response.filePath}.mp4`;
  const project = await loadProject(filePath);
  await exportVideo(project, { outputPath, overwrite: true, onProgress: (progress) => mainWindow?.webContents.send('video:progress', progress) });
  return { outputPath };
});
ipcMain.handle('shell:reveal', (_event, filePath: string) => shell.showItemInFolder(filePath));
