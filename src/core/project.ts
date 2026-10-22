import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { runCommand } from './ffmpeg';
import { newId } from './ids';
import { libraryDatabasePath, MediaLibrary, type LibraryAsset } from './library';
import { add, clampNonNegative, compare, decimal, parseDecimal, rational } from './time';
import type { ImportResult, ImportRoot, MediaAsset, Project, Rational, TimelineClip, TimelineTrack, TrackKind } from './types';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.wmv', '.flv']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

export function projectCachePath(projectFile: string, projectId: string): string {
  return path.join(path.dirname(projectFile), `.openmontage-cache-${projectId}`);
}

export function projectHistoryPath(projectFile: string, projectId: string): string {
  return path.join(path.dirname(path.resolve(projectFile)), `.openmontage-history-${projectId}`);
}

export async function createProject(filePath: string, options: Partial<Pick<Project, 'name' | 'frameRate' | 'width' | 'height'>> = {}): Promise<Project> {
  const target = path.resolve(filePath);
  if (await exists(target)) throw new AppError('PROJECT_EXISTS', `Project already exists: ${target}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: 1,
    id: newId(),
    name: options.name?.trim() || path.basename(target, path.extname(target)),
    createdAt: now,
    updatedAt: now,
    frameRate: options.frameRate ?? rational(60),
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    media: [],
    tracks: [newTrack('V1', 'video'), newTrack('A1', 'audio')]
  };
  validateProject(project);
  await saveProject(target, project);
  return project;
}

export async function loadProject(filePath: string): Promise<Project> {
  const target = path.resolve(filePath);
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(target, 'utf8')); }
  catch (error) { throw new AppError('PROJECT_READ_FAILED', `Could not read project ${target}: ${error instanceof Error ? error.message : error}`); }
  validateProject(parsed as Project);
  return parsed as Project;
}

export async function saveProject(filePath: string, project: Project, options: { recordHistory?: boolean } = {}): Promise<void> {
  validateProject(project);
  const target = path.resolve(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const previous = await fileExists(target) ? await loadProject(target) : undefined;
  if (previous && projectSignature(previous) === projectSignature(project)) {
    project.updatedAt = previous.updatedAt;
    return;
  }
  project.updatedAt = new Date().toISOString();
  const temp = `${target}.${newId()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    if (await exists(target)) await fs.copyFile(target, `${target}.bak`);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw new AppError('PROJECT_SAVE_FAILED', `Could not save project ${target}: ${error instanceof Error ? error.message : error}`);
  }
  if (options.recordHistory !== false) {
    try { await recordProjectHistory(projectHistoryPath(target, project.id), previous, project); }
    catch (error) {
      try {
        if (previous) await fs.copyFile(`${target}.bak`, target);
        else await fs.rm(target, { force: true });
      } catch (rollbackError) {
        throw new AppError('PROJECT_HISTORY_ROLLBACK_FAILED', `History could not be written and the project file could not be restored: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`, { cause: error });
      }
      throw new AppError('PROJECT_HISTORY_FAILED', `Project history could not be written; the project save was rolled back: ${error instanceof Error ? error.message : error}`);
    }
  }
}

export interface ProjectHistoryState { canUndo: boolean; canRedo: boolean; undoCount: number; redoCount: number; }
interface HistoryEntry { file: string; signature: string; savedAt: string; }
interface HistoryDocument { schemaVersion: 1; cursor: number; entries: HistoryEntry[]; }
const MAX_HISTORY = 50;

export async function getProjectHistory(filePath: string): Promise<ProjectHistoryState> {
  const project = await loadProject(filePath);
  const directory = projectHistoryPath(filePath, project.id);
  const history = await readHistoryDocument(directory);
  if (!history || !history.entries[history.cursor] || history.entries[history.cursor].signature !== projectSignature(project)) return { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 };
  return { canUndo: history.cursor > 0, canRedo: history.cursor < history.entries.length - 1, undoCount: history.cursor, redoCount: history.entries.length - history.cursor - 1 };
}

export async function undoProject(filePath: string): Promise<Project> { return moveHistory(filePath, -1); }
export async function redoProject(filePath: string): Promise<Project> { return moveHistory(filePath, 1); }

async function moveHistory(filePath: string, direction: -1 | 1): Promise<Project> {
  const project = await loadProject(filePath);
  const directory = projectHistoryPath(filePath, project.id);
  const history = await readHistoryDocument(directory);
  if (!history || !history.entries[history.cursor] || history.entries[history.cursor].signature !== projectSignature(project)) {
    throw new AppError('HISTORY_UNAVAILABLE', 'Project history is missing or does not match the current project state.');
  }
  const nextCursor = history.cursor + direction;
  const entry = history.entries[nextCursor];
  if (!entry) throw new AppError(direction < 0 ? 'NOTHING_TO_UNDO' : 'NOTHING_TO_REDO', direction < 0 ? 'There is no earlier project state to restore.' : 'There is no later project state to restore.');
  let restored: Project;
  try { restored = JSON.parse(await fs.readFile(path.join(directory, entry.file), 'utf8')) as Project; }
  catch (error) { throw new AppError('HISTORY_READ_FAILED', `Could not read project history snapshot: ${error instanceof Error ? error.message : error}`); }
  validateProject(restored);
  const previousCursor = history.cursor;
  history.cursor = nextCursor;
  await writeHistoryDocument(directory, history);
  let saved = false;
  try {
    await saveProject(filePath, restored, { recordHistory: false });
    saved = true;
    await synchronizeProjectLibrary(filePath, restored);
  }
  catch (error) {
    history.cursor = previousCursor;
    await writeHistoryDocument(directory, history).catch(() => undefined);
    if (saved) {
      try { await fs.copyFile(`${path.resolve(filePath)}.bak`, path.resolve(filePath)); }
      catch (rollbackError) { throw new AppError('PROJECT_HISTORY_ROLLBACK_FAILED', `History restore failed and the project file could not be recovered: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}`, { cause: error }); }
    }
    throw error;
  }
  return restored;
}

async function synchronizeProjectLibrary(filePath: string, project: Project): Promise<void> {
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try { library.synchronizeAssets(project.media); }
  finally { library.close(); }
}

async function recordProjectHistory(directory: string, previous: Project | undefined, next: Project): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  let history = await readHistoryDocument(directory) ?? { schemaVersion: 1 as const, cursor: -1, entries: [] as HistoryEntry[] };
  if (!previous) history = { schemaVersion: 1, cursor: -1, entries: [] };
  if (previous && (history.cursor < 0 || history.entries[history.cursor]?.signature !== projectSignature(previous))) {
    history = { schemaVersion: 1, cursor: -1, entries: [] };
    history.entries.push(await writeHistorySnapshot(directory, previous));
    history.cursor = 0;
  }
  history.entries = history.entries.slice(0, history.cursor + 1);
  history.entries.push(await writeHistorySnapshot(directory, next));
  history.cursor = history.entries.length - 1;
  if (history.entries.length > MAX_HISTORY) {
    const removed = history.entries.length - MAX_HISTORY;
    history.entries = history.entries.slice(removed);
    history.cursor -= removed;
  }
  await writeHistoryDocument(directory, history);
  const retained = new Set(history.entries.map((entry) => entry.file));
  const snapshots = await fs.readdir(directory).catch(() => [] as string[]);
  await Promise.all(snapshots.filter((file) => file.startsWith('snapshot-') && !retained.has(file)).map((file) => fs.rm(path.join(directory, file), { force: true }).catch(() => undefined)));
}

async function writeHistorySnapshot(directory: string, project: Project): Promise<HistoryEntry> {
  const file = `snapshot-${Date.now()}-${randomUUID()}.json`;
  const temp = path.join(directory, `${file}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await fs.rename(temp, path.join(directory, file));
  return { file, signature: projectSignature(project), savedAt: project.updatedAt };
}

async function writeHistoryDocument(directory: string, history: HistoryDocument): Promise<void> {
  const file = path.join(directory, 'history.json');
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

async function readHistoryDocument(directory: string): Promise<HistoryDocument | null> {
  try {
    const history = JSON.parse(await fs.readFile(path.join(directory, 'history.json'), 'utf8')) as HistoryDocument;
    if (history.schemaVersion !== 1 || !Array.isArray(history.entries) || !Number.isSafeInteger(history.cursor) || history.cursor < 0 || history.cursor >= history.entries.length) return null;
    if (!history.entries.every((entry) => typeof entry.file === 'string' && /^snapshot-\d+-[0-9a-f-]{36}\.json$/.test(entry.file) && typeof entry.signature === 'string' && typeof entry.savedAt === 'string')) return null;
    return history;
  } catch { return null; }
}

function projectSignature(project: Project): string {
  const state = structuredClone(project);
  state.updatedAt = '';
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export function validateProject(project: Project): void {
  if (!project || project.schemaVersion !== 1 || typeof project.id !== 'string' || !Array.isArray(project.media) || !Array.isArray(project.tracks) || !project.frameRate)
    throw new AppError('INVALID_PROJECT', 'Project structure is invalid or uses an unsupported schema version.');
  if (!project.name || !Number.isSafeInteger(project.width) || !Number.isSafeInteger(project.height) || project.width < 2 || project.height < 2 || project.width % 2 || project.height % 2)
    throw new AppError('INVALID_PROJECT', 'Project name and even output dimensions of at least 2 pixels are required.');
  if (BigInt(project.frameRate.num) <= 0n || BigInt(project.frameRate.den) <= 0n) throw new AppError('INVALID_PROJECT', 'Project frame rate must be positive.');
  const validTime = (value: Rational | undefined): boolean => !!value && /^-?\d+$/.test(value.num) && /^\d+$/.test(value.den) && BigInt(value.den) > 0n;
  const mediaIds = new Set(project.media.map((asset) => asset.id));
  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  for (const track of project.tracks) {
    if (!track.id || trackIds.has(track.id) || !['video', 'audio'].includes(track.kind) || !Array.isArray(track.clips))
      throw new AppError('INVALID_PROJECT', 'Project contains an invalid or duplicate track.');
    trackIds.add(track.id);
    for (const clip of track.clips) {
      if (!clip.id || clipIds.has(clip.id) || !mediaIds.has(clip.mediaId)) throw new AppError('INVALID_PROJECT', `Clip ${clip.id || '(without ID)'} references an invalid or missing media asset.`);
      clipIds.add(clip.id);
      if (!validTime(clip.start) || !validTime(clip.sourceIn) || !validTime(clip.duration)) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid rational time value.`);
      if (BigInt(clip.duration.num) <= 0n || BigInt(clip.duration.den) <= 0n) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} must have a positive duration.`);
      clampNonNegative(clip.start, 'Clip start'); clampNonNegative(clip.sourceIn, 'Clip source in');
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 8) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid volume.`);
    }
  }
}

export function newTrack(name: string, kind: TrackKind): TimelineTrack {
  return { id: newId(), name, kind, muted: false, locked: false, clips: [] };
}

export async function addTrack(filePath: string, kind: TrackKind, name?: string): Promise<Project> {
  const project = await loadProject(filePath);
  const index = project.tracks.filter((track) => track.kind === kind).length + 1;
  project.tracks.push(newTrack(name?.trim() || `${kind === 'video' ? 'V' : 'A'}${index}`, kind));
  await saveProject(filePath, project);
  return project;
}

export async function importMedia(filePath: string, inputPaths: string[], recursive = true): Promise<ImportResult> {
  const project = await loadProject(filePath);
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try {
  const discovered: string[] = [];
  const errors: ImportResult['errors'] = [];
  const watchedRoots: string[] = [];
  for (const input of inputPaths) {
    const absolute = path.resolve(input);
    try {
      const stat = await fs.stat(absolute);
      if (stat.isDirectory()) {
        if (!recursive) throw new AppError('DIRECTORY_NOT_ALLOWED', 'The source is a directory and recursive import is disabled.');
        library.setImportRoot({ path: absolute, recursive: true, watching: true });
        watchedRoots.push(absolute);
        for await (const candidate of walk(absolute)) if (isSupported(candidate)) discovered.push(candidate);
      } else if (stat.isFile()) {
        if (isSupported(absolute)) discovered.push(absolute);
        else errors.push({ path: absolute, code: 'UNSUPPORTED_MEDIA', message: `Unsupported media extension: ${path.extname(absolute) || '(none)'}` });
      }
    } catch (error) {
      errors.push({ path: absolute, code: error instanceof AppError ? error.code : 'SOURCE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) });
    }
  }
  const uniquePaths = [...new Set(discovered)];
  const added: MediaAsset[] = [];
  const duplicates: ImportResult['duplicates'] = [];
  const cache = projectCachePath(filePath, project.id);
  const thumbDir = path.join(cache, 'thumbnails');
  await fs.mkdir(thumbDir, { recursive: true });
  for (const mediaPath of uniquePaths) {
    try {
      const stat = await fs.stat(mediaPath);
      const modifiedAt = stat.mtime.toISOString();
      let cached = library.findByPath(mediaPath);
      let asset: LibraryAsset | null = cached && cached.sizeBytes === stat.size && cached.modifiedAt === modifiedAt ? cached : null;
      if (!asset) {
        const hash = await hashFile(mediaPath);
        if (cached?.contentHash === hash) {
          cached.sizeBytes = stat.size;
          cached.modifiedAt = modifiedAt;
          asset = cached;
        } else {
          const inProject = project.media.find((item) => item.contentHash === hash);
          const inLibrary = library.findByHash(hash);
          const existing = inProject ?? inLibrary;
          if (existing) { duplicates.push({ path: mediaPath, existingId: existing.id }); continue; }
          const metadata = await probe(mediaPath);
          asset = {
            id: hash.slice(0, 32), path: mediaPath, name: path.basename(mediaPath), kind: metadata.kind,
            duration: metadata.duration, width: metadata.width, height: metadata.height, frameRate: metadata.frameRate,
            hasAudio: metadata.hasAudio, sizeBytes: stat.size, modifiedAt, contentHash: hash,
            importedAt: new Date().toISOString(), favorite: false, tags: []
          };
        }
      }
      asset.path = mediaPath;
      asset.name = path.basename(mediaPath);
      if (asset.kind === 'video' && (!asset.thumbnailPath || !(await fileExists(asset.thumbnailPath)))) {
        const thumb = path.join(thumbDir, `${asset.id}.jpg`);
        await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', decimal(rational(BigInt(asset.duration.num), BigInt(asset.duration.den) * 2n)), '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb]);
        asset.thumbnailPath = thumb;
      } else if (asset.kind === 'audio' && (!asset.thumbnailPath || !(await fileExists(asset.thumbnailPath)))) {
        const waveform = path.join(thumbDir, `${asset.id}-waveform.png`);
        await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', mediaPath, '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=640x144:colors=0xa6e85f:scale=lin[wave]', '-map', '[wave]', '-frames:v', '1', '-update', '1', waveform]);
        asset.thumbnailPath = waveform;
      }
      const existingProjectAsset = project.media.find((item) => item.id === asset!.id);
      if (existingProjectAsset) {
        Object.assign(existingProjectAsset, asset);
        duplicates.push({ path: mediaPath, existingId: existingProjectAsset.id });
      } else {
        project.media.push(asset);
        added.push(asset);
      }
      library.upsert(asset);
    } catch (error) {
      errors.push({ path: mediaPath, code: error instanceof AppError ? error.code : 'MEDIA_IMPORT_FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (added.length) await saveProject(filePath, project);
  return { added, duplicates, errors, watchedRoots };
  } finally { library.close(); }
}

export async function findMissingMedia(filePath: string): Promise<string[]> {
  const project = await loadProject(filePath);
  const results = await Promise.all(project.media.map(async (asset) => {
    try { await fs.access(asset.path); return null; }
    catch { return asset.id; }
  }));
  return results.filter((id): id is string => id !== null);
}

export async function relinkMedia(filePath: string, mediaId: string, replacementPath: string): Promise<Project> {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  const target = path.resolve(replacementPath);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try { stat = await fs.stat(target); }
  catch { throw new AppError('SOURCE_UNAVAILABLE', `Replacement media file is not available: ${target}`); }
  if (!stat.isFile()) throw new AppError('INVALID_MEDIA_PATH', `Replacement media path is not a file: ${target}`);
  const hash = await hashFile(target);
  const projectDuplicate = project.media.find((item) => item.id !== mediaId && item.contentHash === hash);
  if (projectDuplicate) throw new AppError('DUPLICATE_MEDIA', `Replacement file is already in this project as ${projectDuplicate.name}.`);
  const metadata = await probe(target);
  if (metadata.kind !== asset.kind) throw new AppError('MEDIA_TYPE_MISMATCH', `Replacement must be ${asset.kind} media.`);
  for (const track of project.tracks) for (const clip of track.clips) {
    if (clip.mediaId === mediaId && compare(add(clip.sourceIn, clip.duration), metadata.duration) > 0) {
      throw new AppError('RELINK_DURATION_TOO_SHORT', `Replacement media is shorter than a source range used by clip ${clip.id}.`);
    }
  }
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try {
    const libraryDuplicate = library.findByHash(hash);
    if (libraryDuplicate && libraryDuplicate.id !== mediaId) {
      throw new AppError('DUPLICATE_MEDIA', `Replacement file is already indexed as ${libraryDuplicate.name}.`);
    }
    const modifiedAt = stat.mtime.toISOString();
    asset.path = target;
    asset.name = path.basename(target);
    asset.duration = metadata.duration;
    asset.width = metadata.width;
    asset.height = metadata.height;
    asset.frameRate = metadata.frameRate;
    asset.hasAudio = metadata.hasAudio;
    asset.sizeBytes = stat.size;
    asset.modifiedAt = modifiedAt;
    asset.contentHash = hash;
    const thumbDir = path.join(projectCachePath(filePath, project.id), 'thumbnails');
    await fs.mkdir(thumbDir, { recursive: true });
    if (asset.kind === 'video') {
      const thumbnail = path.join(thumbDir, `${asset.id}.jpg`);
      const tempThumbnail = path.join(thumbDir, `${asset.id}.${newId()}.tmp.jpg`);
      await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', decimal(rational(BigInt(asset.duration.num), BigInt(asset.duration.den) * 2n)), '-i', target, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', tempThumbnail]);
      await fs.rename(tempThumbnail, thumbnail);
      asset.thumbnailPath = thumbnail;
    } else {
      const waveform = path.join(thumbDir, `${asset.id}-waveform.png`);
      const tempWaveform = path.join(thumbDir, `${asset.id}.${newId()}.tmp.png`);
      await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', target, '-filter_complex', '[0:a:0]aformat=channel_layouts=mono,showwavespic=s=640x144:colors=0xa6e85f:scale=lin[wave]', '-map', '[wave]', '-frames:v', '1', '-update', '1', tempWaveform]);
      await fs.rename(tempWaveform, waveform);
      asset.thumbnailPath = waveform;
    }
    await saveProject(filePath, project);
    library.upsert(asset);
  } finally { library.close(); }
  return project;
}

async function* walk(root: string): AsyncGenerator<string> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function isSupported(filePath: string): boolean {
  return VIDEO_EXT.has(path.extname(filePath).toLowerCase()) || AUDIO_EXT.has(path.extname(filePath).toLowerCase());
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

interface ProbeMetadata { kind: 'video' | 'audio'; duration: Rational; width?: number; height?: number; frameRate?: Rational; hasAudio: boolean; }

async function probe(filePath: string): Promise<ProbeMetadata> {
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
  let info: any;
  try { info = JSON.parse(stdout); } catch { throw new AppError('PROBE_FAILED', `ffprobe returned invalid metadata for ${filePath}`); }
  const streams: any[] = info.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.some((stream) => stream.codec_type === 'audio');
  const durationValue = video?.duration ?? info.format?.duration ?? streams.find((s) => s.codec_type === 'audio')?.duration;
  if (!durationValue) throw new AppError('PROBE_FAILED', `Could not determine media duration for ${filePath}`);
  const duration = parseDecimal(durationValue);
  if (BigInt(duration.num) <= 0n) throw new AppError('PROBE_FAILED', `Media has no usable duration: ${filePath}`);
  if (!video && !audio) throw new AppError('PROBE_FAILED', `No video or audio stream found in ${filePath}`);
  return {
    kind: video ? 'video' : 'audio',
    duration,
    width: video?.width,
    height: video?.height,
    frameRate: video ? parseRationalOrUndefined(video.avg_frame_rate) : undefined,
    hasAudio: audio
  };
}

function parseRationalOrUndefined(value?: string): Rational | undefined {
  if (!value || value === '0/0') return undefined;
  try { return parseDecimal(value); } catch { return undefined; }
}

export async function addClip(filePath: string, mediaId: string, trackId: string, start: Rational, sourceIn = rational(0), duration?: Rational): Promise<Project> {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  const track = project.tracks.find((item) => item.id === trackId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  if (!track) throw new AppError('TRACK_NOT_FOUND', `Track not found: ${trackId}`);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  if (track.kind === 'video' && asset.kind !== 'video') throw new AppError('MEDIA_TYPE_MISMATCH', 'Audio-only media cannot be placed on a video track.');
  clampNonNegative(start, 'Clip start'); clampNonNegative(sourceIn, 'Source in');
  const resolvedDuration = duration ?? subSafe(asset.duration, sourceIn);
  if (BigInt(resolvedDuration.num) <= 0n) throw new AppError('INVALID_DURATION', 'Clip duration must be positive.');
  if (compare(add(sourceIn, resolvedDuration), asset.duration) > 0) throw new AppError('SOURCE_RANGE_EXCEEDED', `The selected source range exceeds ${asset.name}'s duration (${decimal(asset.duration)} s).`);
  const clip: TimelineClip = { id: newId(), mediaId, start, sourceIn, duration: resolvedDuration, audioEnabled: true, volume: 1 };
  track.clips.push(clip);
  track.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

function subSafe(a: Rational, b: Rational): Rational {
  const n = BigInt(a.num) * BigInt(b.den) - BigInt(b.num) * BigInt(a.den);
  if (n <= 0n) throw new AppError('INVALID_SOURCE_RANGE', 'Source in must be before the end of the media.');
  return rational(n, BigInt(a.den) * BigInt(b.den));
}

export async function trimClip(filePath: string, clipId: string, patch: { start?: Rational; sourceIn?: Rational; duration?: Rational }): Promise<Project> {
  const project = await loadProject(filePath);
  const { clip, track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  const asset = project.media.find((item) => item.id === clip.mediaId)!;
  const next = { ...clip, ...patch };
  clampNonNegative(next.start, 'Clip start'); clampNonNegative(next.sourceIn, 'Source in');
  if (BigInt(next.duration.num) <= 0n || compare(add(next.sourceIn, next.duration), asset.duration) > 0) throw new AppError('SOURCE_RANGE_EXCEEDED', 'The trimmed source range is invalid or exceeds the media duration.');
  Object.assign(clip, patch);
  track.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

export async function moveClip(filePath: string, clipId: string, start: Rational, trackId?: string): Promise<Project> {
  const project = await loadProject(filePath);
  const found = findClip(project, clipId);
  if (found.track.locked) throw new AppError('TRACK_LOCKED', `Track ${found.track.name} is locked.`);
  clampNonNegative(start, 'Clip start');
  if (trackId && trackId !== found.track.id) {
    const destination = project.tracks.find((track) => track.id === trackId);
    if (!destination) throw new AppError('TRACK_NOT_FOUND', `Track not found: ${trackId}`);
    if (destination.locked) throw new AppError('TRACK_LOCKED', `Track ${destination.name} is locked.`);
    const asset = project.media.find((item) => item.id === found.clip.mediaId)!;
    if (destination.kind === 'video' && asset.kind !== 'video') throw new AppError('MEDIA_TYPE_MISMATCH', 'Audio-only media cannot be moved to a video track.');
    found.track.clips = found.track.clips.filter((clip) => clip.id !== clipId);
    destination.clips.push(found.clip);
    destination.clips.sort((a, b) => compare(a.start, b.start));
  }
  found.clip.start = start;
  const destination = project.tracks.find((track) => track.id === (trackId || found.track.id))!;
  destination.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

export async function splitClip(filePath: string, clipId: string, atTimeline: Rational): Promise<Project> {
  const project = await loadProject(filePath);
  const { clip, track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  const offset = subSafe(atTimeline, clip.start);
  if (compare(offset, rational(0)) <= 0 || compare(offset, clip.duration) >= 0) throw new AppError('SPLIT_OUTSIDE_CLIP', 'Split point must fall strictly inside the selected clip.');
  const oldDuration = clip.duration;
  const right: TimelineClip = { ...clip, id: newId(), start: atTimeline, sourceIn: add(clip.sourceIn, offset), duration: subSafe(oldDuration, offset) };
  clip.duration = offset;
  track.clips.push(right);
  track.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

export async function removeClip(filePath: string, clipId: string): Promise<Project> {
  const project = await loadProject(filePath);
  const { track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  track.clips = track.clips.filter((clip) => clip.id !== clipId);
  await saveProject(filePath, project);
  return project;
}

export async function updateMediaMetadata(filePath: string, mediaId: string, patch: { favorite?: boolean; tags?: string[]; game?: string | null }): Promise<Project> {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  if (patch.favorite !== undefined) asset.favorite = patch.favorite;
  if (patch.tags !== undefined) asset.tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 100);
  if (patch.game !== undefined) asset.game = patch.game?.trim() || undefined;
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try {
    library.upsert(asset);
    library.updatePreferences(mediaId, { favorite: patch.favorite, tags: asset.tags, game: patch.game });
    await saveProject(filePath, project);
  } finally { library.close(); }
  return project;
}

export async function searchMedia(filePath: string, query = '', favoriteOnly = false): Promise<LibraryAsset[]> {
  const project = await loadProject(filePath);
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try {
    for (const asset of project.media) if (!library.findById(asset.id)) library.upsert(asset);
    return library.search(query, favoriteOnly);
  } finally { library.close(); }
}

export async function getImportRoots(filePath: string): Promise<ImportRoot[]> {
  const project = await loadProject(filePath);
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try { return library.importRoots(); } finally { library.close(); }
}

export async function setImportRootWatching(filePath: string, rootPath: string, watching: boolean): Promise<ImportRoot[]> {
  const project = await loadProject(filePath);
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try { library.setRootWatching(rootPath, watching); return library.importRoots(); } finally { library.close(); }
}

function findClip(project: Project, clipId: string): { clip: TimelineClip; track: TimelineTrack } {
  for (const track of project.tracks) {
    const clip = track.clips.find((item) => item.id === clipId);
    if (clip) return { clip, track };
  }
  throw new AppError('CLIP_NOT_FOUND', `Timeline clip not found: ${clipId}`);
}

export function timelineDuration(project: Project): Rational {
  let duration = rational(0);
  for (const track of project.tracks) for (const clip of track.clips) {
    const candidate = add(clip.start, clip.duration);
    if (compare(candidate, duration) > 0) duration = candidate;
  }
  return duration;
}

export function fileExists(filePath: string): Promise<boolean> { return exists(filePath); }
async function exists(filePath: string): Promise<boolean> { try { await fs.access(filePath); return true; } catch { return false; } }
