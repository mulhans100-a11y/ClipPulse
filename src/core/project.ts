import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { clipPlaybackRateAt, clipSourceDuration, clipSourceOffsetAt, extendClipAnimation, splitClipAnimation } from './clipEffects';
import { extendMaskAnimation, maskPathPoints, splitMaskAnimation } from './maskPath';
import { runCommand } from './ffmpeg';
import { newId } from './ids';
import { libraryDatabasePath, MediaLibrary, type LibraryAsset } from './library';
import { add, clampNonNegative, compare, decimal, parseDecimal, rational, sub } from './time';
import { waveformWidthForDuration } from './waveform';
import type { AnalysisEventReview, ImportResult, ImportRoot, MediaAsset, Project, Rational, TimelineClip, TimelineTrack, TrackKind } from './types';

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

export async function updateProjectProfile(filePath: string, patch: Partial<Pick<Project, 'name' | 'frameRate' | 'width' | 'height'>>): Promise<Project> {
  const project = await loadProject(filePath);
  if (patch.name !== undefined) project.name = patch.name.trim();
  if (patch.frameRate !== undefined) project.frameRate = patch.frameRate;
  if (patch.width !== undefined) project.width = patch.width;
  if (patch.height !== undefined) project.height = patch.height;
  validateProject(project);
  await saveProject(filePath, project);
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
  for (const asset of project.media) {
    if (asset?.analysisEventReviews !== undefined && asset.duration && validTime(asset.duration)) validateEventReviews(asset.analysisEventReviews, Number(asset.duration.num) / Number(asset.duration.den));
  }
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
      const asset = project.media.find((item) => item.id === clip.mediaId)!;
      if (!validTime(clip.start) || !validTime(clip.sourceIn) || !validTime(clip.duration)) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid rational time value.`);
      if (BigInt(clip.duration.num) <= 0n || BigInt(clip.duration.den) <= 0n) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} must have a positive duration.`);
      for (const [label, fade] of [['fade-in', clip.fadeIn], ['fade-out', clip.fadeOut]] as const) {
        if (fade !== undefined && (!validTime(fade) || BigInt(fade.num) < 0n || compare(fade, clip.duration) > 0))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid ${label} duration.`);
      }
      clampNonNegative(clip.start, 'Clip start'); clampNonNegative(clip.sourceIn, 'Clip source in');
      if (!Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 8) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid volume.`);
        if (clip.playbackRate !== undefined && (!validTime(clip.playbackRate) || Number(clip.playbackRate.num) / Number(clip.playbackRate.den) < 0.25 || Number(clip.playbackRate.num) / Number(clip.playbackRate.den) > 4))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid playback rate (expected 0.25–4).`);
        if (clip.speedKeyframes !== undefined) {
          if (!Array.isArray(clip.speedKeyframes) || clip.speedKeyframes.length > 256) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has too many speed keyframes.`);
          let previous: Rational | undefined;
          for (const frame of clip.speedKeyframes) {
            if (!validTime(frame.time) || BigInt(frame.time.num) < 0n || compare(frame.time, clip.duration) > 0 || !validTime(frame.rate))
              throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid speed keyframe.`);
            const rate = Number(frame.rate.num) / Number(frame.rate.den);
            if (rate < 0.25 || rate > 4 || (previous && compare(previous, frame.time) >= 0)) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} speed keyframes must be ordered and use rates from 0.25 to 4.`);
            previous = frame.time;
          }
        }
        if (clip.transform !== undefined && (!Number.isFinite(clip.transform.scale) || clip.transform.scale < 0.1 || clip.transform.scale > 4 || !Number.isFinite(clip.transform.x) || Math.abs(clip.transform.x) > project.width * 2 || !Number.isFinite(clip.transform.y) || Math.abs(clip.transform.y) > project.height * 2 || !Number.isFinite(clip.transform.rotationDegrees) || Math.abs(clip.transform.rotationDegrees) > 360))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid transform values.`);
        if (clip.color !== undefined && (!Number.isFinite(clip.color.brightness) || clip.color.brightness < -1 || clip.color.brightness > 1 || !Number.isFinite(clip.color.contrast) || clip.color.contrast < 0 || clip.color.contrast > 4 || !Number.isFinite(clip.color.saturation) || clip.color.saturation < 0 || clip.color.saturation > 4 || (clip.color.lutPath !== undefined && (typeof clip.color.lutPath !== 'string' || clip.color.lutPath.length > 4096))))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid color settings.`);
        if (clip.blendMode !== undefined && !['normal', 'multiply', 'screen', 'add', 'difference'].includes(clip.blendMode))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid blend mode.`);
        if (clip.chromaKey !== undefined && (!/^#[0-9a-fA-F]{6}$/.test(clip.chromaKey.color) || !Number.isFinite(clip.chromaKey.similarity) || clip.chromaKey.similarity < 0 || clip.chromaKey.similarity > 1 || !Number.isFinite(clip.chromaKey.blend) || clip.chromaKey.blend < 0 || clip.chromaKey.blend > 1))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid chroma-key settings.`);
        if (clip.mask !== undefined) {
          if (!Number.isFinite(clip.mask.featherPx) || clip.mask.featherPx < 0 || clip.mask.featherPx > 256 || !Number.isFinite(clip.mask.expansionPx) || clip.mask.expansionPx < -256 || clip.mask.expansionPx > 256 || (clip.mask.keyframes !== undefined && (!Array.isArray(clip.mask.keyframes) || clip.mask.keyframes.length > 256)))
            throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid mask feather, expansion, or tracking data.`);
          if (clip.mask.provenance !== undefined && (!clip.mask.provenance || typeof clip.mask.provenance.modelId !== 'string' || clip.mask.provenance.modelId.length > 200 || typeof clip.mask.provenance.revision !== 'string' || clip.mask.provenance.revision.length > 100 || typeof clip.mask.provenance.className !== 'string' || clip.mask.provenance.className.length > 80 || !Number.isInteger(clip.mask.provenance.sampleCount) || clip.mask.provenance.sampleCount < 1 || clip.mask.provenance.sampleCount > 96 || !['temporal-majority-v1', 'single-frame-v1'].includes(clip.mask.provenance.stabilization)))
            throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid model segmentation provenance.`);
          let maskPoints: ReturnType<typeof maskPathPoints>;
          try { maskPoints = maskPathPoints(clip.mask.path); }
          catch (error) { throw new AppError('INVALID_PROJECT', `Clip ${clip.id} mask path is invalid: ${error instanceof Error ? error.message : String(error)}`); }
          let previousMaskTime: Rational | undefined;
          for (const frame of clip.mask.keyframes ?? []) {
            if (!validTime(frame.time) || BigInt(frame.time.num) < 0n || compare(frame.time, clip.duration) > 0 || (previousMaskTime && compare(previousMaskTime, frame.time) >= 0))
              throw new AppError('INVALID_PROJECT', `Clip ${clip.id} mask tracking times must be ordered and inside the clip.`);
            try {
              if (maskPathPoints(frame.path).length !== maskPoints.length) throw new Error('Tracking corrections must preserve the mask path point count.');
            } catch (error) { throw new AppError('INVALID_PROJECT', `Clip ${clip.id} mask tracking path is invalid: ${error instanceof Error ? error.message : String(error)}`); }
            previousMaskTime = frame.time;
          }
          if (asset.kind !== 'video') throw new AppError('INVALID_PROJECT', `Clip ${clip.id} compositing settings require video media.`);
        }
        if (clip.chromaKey !== undefined && asset.kind !== 'video') throw new AppError('INVALID_PROJECT', `Clip ${clip.id} chroma key requires video media.`);
        if (clip.blendMode !== undefined && clip.blendMode !== 'normal' && asset.kind !== 'video') throw new AppError('INVALID_PROJECT', `Clip ${clip.id} blend modes require video media.`);
        if (clip.keyframes !== undefined) {
          if (!Array.isArray(clip.keyframes) || clip.keyframes.length > 1024) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has too many effect keyframes.`);
          const seen = new Set<string>();
          for (const frame of clip.keyframes) {
            if (!['opacity', 'brightness', 'contrast', 'saturation', 'volume'].includes(frame.property) || !validTime(frame.time) || BigInt(frame.time.num) < 0n || compare(frame.time, clip.duration) > 0 || !Number.isFinite(frame.value) || (frame.interpolation !== undefined && !['linear', 'hold'].includes(frame.interpolation)))
              throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid effect keyframe.`);
            const limits: Record<string, [number, number]> = { opacity: [0, 1], brightness: [-1, 1], contrast: [0, 4], saturation: [0, 4], volume: [0, 8] };
            const [min, max] = limits[frame.property];
            if (frame.value < min || frame.value > max) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an out-of-range ${frame.property} keyframe.`);
            const key = `${frame.property}:${frame.time.num}/${frame.time.den}`;
            if (seen.has(key)) throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has duplicate ${frame.property} keyframes at the same time.`);
            seen.add(key);
          }
        }
        if (clip.transitionIn !== undefined && (!['dissolve', 'wipe-left', 'wipe-right'].includes(clip.transitionIn.type) || !validTime(clip.transitionIn.duration) || BigInt(clip.transitionIn.duration.num) <= 0n || compare(clip.transitionIn.duration, clip.duration) > 0))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has an invalid video transition.`);
        if (clip.title !== undefined && (typeof clip.title.text !== 'string' || clip.title.text.length > 500 || !Number.isFinite(clip.title.fontSize) || clip.title.fontSize < 8 || clip.title.fontSize > 256 || !/^#[0-9a-fA-F]{6}$/.test(clip.title.color) || !Number.isFinite(clip.title.x) || clip.title.x < 0 || clip.title.x > 1 || !Number.isFinite(clip.title.y) || clip.title.y < 0 || clip.title.y > 1 || !validTime(clip.title.start) || !validTime(clip.title.duration) || BigInt(clip.title.start.num) < 0n || BigInt(clip.title.duration.num) <= 0n || compare(add(clip.title.start, clip.title.duration), clip.duration) > 0 || (clip.title.fontFile !== undefined && (typeof clip.title.fontFile !== 'string' || clip.title.fontFile.length > 4096))))
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid title settings.`);
        if (clip.normalizeAudio !== undefined && typeof clip.normalizeAudio !== 'boolean') throw new AppError('INVALID_PROJECT', `Clip ${clip.id} has invalid audio normalization settings.`);
        if (validTime(asset.duration) && compare(add(clip.sourceIn, clipSourceDuration(clip)), asset.duration) > 0)
          throw new AppError('INVALID_PROJECT', `Clip ${clip.id} playback exceeds the available source media range.`);
    }
    if (track.volume !== undefined && (!Number.isFinite(track.volume) || track.volume < 0 || track.volume > 8)) throw new AppError('INVALID_PROJECT', `Track ${track.id} has invalid volume.`);
    if (track.audioRole !== undefined && !['standard', 'dialogue', 'music'].includes(track.audioRole)) throw new AppError('INVALID_PROJECT', `Track ${track.id} has an invalid audio role.`);
    if (track.normalizeAudio !== undefined && typeof track.normalizeAudio !== 'boolean') throw new AppError('INVALID_PROJECT', `Track ${track.id} has invalid normalization settings.`);
    if (track.duckUnderDialogue !== undefined && (typeof track.duckUnderDialogue !== 'boolean' || (track.kind !== 'audio' && track.duckUnderDialogue))) throw new AppError('INVALID_PROJECT', `Track ${track.id} has invalid ducking settings.`);
    if (track.volumeKeyframes !== undefined) {
      if (!Array.isArray(track.volumeKeyframes) || track.volumeKeyframes.length > 1024) throw new AppError('INVALID_PROJECT', `Track ${track.id} has too many volume keyframes.`);
      let previous: Rational | undefined;
      for (const frame of track.volumeKeyframes) {
        if (!validTime(frame.time) || BigInt(frame.time.num) < 0n || !Number.isFinite(frame.value) || frame.value < 0 || frame.value > 8 || (frame.interpolation !== undefined && !['linear', 'hold'].includes(frame.interpolation)) || (previous && compare(previous, frame.time) >= 0)) throw new AppError('INVALID_PROJECT', `Track ${track.id} has invalid volume keyframes.`);
        previous = frame.time;
      }
    }
  }
}

export function newTrack(name: string, kind: TrackKind): TimelineTrack {
  return { id: newId(), name, kind, muted: false, solo: false, locked: false, volume: 1, audioRole: 'standard', normalizeAudio: false, duckUnderDialogue: false, clips: [] };
}

export function isTrackEnabled(project: Project, track: TimelineTrack): boolean {
  if (track.muted) return false;
  const kindTracks = project.tracks.filter((candidate) => candidate.kind === track.kind && !candidate.muted);
  return !kindTracks.some((candidate) => candidate.solo) || track.solo === true;
}

export async function updateTrackSettings(filePath: string, trackId: string, patch: { muted?: boolean; solo?: boolean; locked?: boolean; volume?: number; audioRole?: TimelineTrack['audioRole']; normalizeAudio?: boolean; duckUnderDialogue?: boolean; volumeKeyframes?: TimelineTrack['volumeKeyframes'] }): Promise<Project> {
  const project = await loadProject(filePath);
  const track = project.tracks.find((item) => item.id === trackId);
  if (!track) throw new AppError('TRACK_NOT_FOUND', `Track not found: ${trackId}`);
  if (patch.muted !== undefined) track.muted = patch.muted;
  if (patch.solo !== undefined) track.solo = patch.solo;
  if (patch.locked !== undefined) track.locked = patch.locked;
  if (patch.volume !== undefined) track.volume = patch.volume;
  if (patch.audioRole !== undefined) track.audioRole = patch.audioRole;
  if (patch.normalizeAudio !== undefined) track.normalizeAudio = patch.normalizeAudio;
  if (patch.duckUnderDialogue !== undefined) track.duckUnderDialogue = patch.duckUnderDialogue;
  if (patch.volumeKeyframes !== undefined) track.volumeKeyframes = structuredClone(patch.volumeKeyframes);
  validateProject(project);
  await saveProject(filePath, project);
  return project;
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
            importedAt: new Date().toISOString(), favorite: false, rating: 0, tags: []
          };
        }
      }
      asset.path = mediaPath;
      asset.name = path.basename(mediaPath);
      asset.thumbnailPath = await ensureMediaThumbnail(thumbDir, asset, mediaPath);
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
    asset.thumbnailPath = await ensureMediaThumbnail(thumbDir, asset, target, false);
    await saveProject(filePath, project);
    library.upsert(asset);
    await pruneMediaThumbnails(thumbDir, asset.id, asset.thumbnailPath);
    await invalidateAnalysisCache(filePath, project.id, asset.id);
  } finally { library.close(); }
  return project;
}

async function ensureMediaThumbnail(directory: string, asset: MediaAsset, sourcePath: string, pruneOld = true): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const variant = asset.kind === 'video' ? 'video.jpg' : 'source-waveform.png';
  const outputPath = path.join(directory, `asset-${asset.id}-${asset.contentHash}-${variant}`);
  const existing = await fs.stat(outputPath).catch(() => null);
  if (!existing?.isFile() || existing.size === 0) {
    const temporaryPath = `${outputPath}.${newId()}.tmp${path.extname(outputPath)}`;
    try {
      const threads = ['-threads', '1', '-filter_threads', '1'];
      if (asset.kind === 'video') {
        const midpoint = decimal(rational(BigInt(asset.duration.num), BigInt(asset.duration.den) * 2n));
        await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...threads, '-ss', midpoint, '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', temporaryPath]);
      } else {
        const width = waveformWidthForDuration(Number(asset.duration.num) / Number(asset.duration.den));
        await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...threads, '-i', sourcePath, '-filter_complex', `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${width}x144:colors=0xa6e85f:scale=lin[wave]`, '-map', '[wave]', '-frames:v', '1', '-update', '1', temporaryPath]);
      }
      const stat = await fs.stat(temporaryPath);
      if (!stat.isFile() || stat.size === 0) throw new Error('FFmpeg created an empty media thumbnail.');
      await fs.rm(outputPath, { force: true });
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  if (pruneOld) await pruneMediaThumbnails(directory, asset.id, outputPath);
  return outputPath;
}

async function pruneMediaThumbnails(directory: string, mediaId: string, keepPath: string): Promise<void> {
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const obsolete = names.filter((name) => (name.startsWith(`asset-${mediaId}-`) || name === `${mediaId}.jpg` || name === `${mediaId}-waveform-zoom.png`) && path.join(directory, name) !== keepPath);
  await Promise.all(obsolete.map((name) => fs.rm(path.join(directory, name), { force: true }).catch(() => undefined)));
}

async function invalidateAnalysisCache(filePath: string, projectId: string, mediaId: string): Promise<void> {
  const directory = path.join(projectCachePath(filePath, projectId), 'analysis');
  await Promise.all([
    fs.rm(path.join(directory, `${mediaId}.json`), { force: true }),
    fs.rm(path.join(directory, `cues-${mediaId}.json`), { force: true })
  ]);
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
  const clip: TimelineClip = { id: newId(), mediaId, start, sourceIn, duration: resolvedDuration, audioEnabled: true, volume: 1, fadeIn: rational(0), fadeOut: rational(0), playbackRate: rational(1), transform: { scale: 1, x: 0, y: 0, rotationDegrees: 0 }, color: { brightness: 0, contrast: 1, saturation: 1 } };
  track.clips.push(clip);
  track.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

export async function duplicateClip(filePath: string, clipId: string, start?: Rational): Promise<Project> {
  const project = await loadProject(filePath);
  const { clip, track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  const duplicate: TimelineClip = { ...structuredClone(clip), id: newId(), start: start ?? add(clip.start, clip.duration) };
  clampNonNegative(duplicate.start, 'Clip start');
  track.clips.push(duplicate);
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
  if (patch.start !== undefined && patch.sourceIn !== undefined && compare(patch.start, clip.start) > 0 && patch.duration !== undefined && compare(patch.duration, clip.duration) < 0) {
    const offset = sub(patch.start, clip.start);
    const animation = splitClipAnimation(clip, offset);
    next.playbackRate = animation.rightPlaybackRate;
    next.speedKeyframes = animation.rightSpeedKeyframes;
    next.keyframes = animation.rightKeyframes;
    if (clip.mask) next.mask = splitMaskAnimation(clip.mask, offset).right;
    if (clip.title) {
      const titleEnd = add(clip.title.start, clip.title.duration);
      const start = compare(clip.title.start, offset) < 0 ? offset : clip.title.start;
      const end = compare(titleEnd, add(offset, next.duration)) > 0 ? add(offset, next.duration) : titleEnd;
      next.title = compare(end, start) > 0 ? { ...clip.title, start: sub(start, offset), duration: sub(end, start) } : undefined;
    }
    next.transitionIn = undefined;
  } else if (patch.start !== undefined && patch.sourceIn !== undefined && compare(patch.start, clip.start) < 0 && patch.duration !== undefined && compare(patch.duration, clip.duration) > 0) {
    const extension = sub(clip.start, patch.start);
    const animation = extendClipAnimation(clip, extension);
    next.playbackRate = animation.playbackRate;
    next.speedKeyframes = animation.speedKeyframes;
    next.keyframes = animation.keyframes;
    if (clip.mask) next.mask = extendMaskAnimation(clip.mask, extension);
    if (clip.title) next.title = { ...clip.title, start: add(clip.title.start, extension) };
  } else if (patch.duration !== undefined && compare(patch.duration, clip.duration) < 0) {
    const animation = splitClipAnimation(clip, patch.duration);
    next.speedKeyframes = animation.leftSpeedKeyframes;
    next.keyframes = animation.leftKeyframes;
    if (clip.mask) next.mask = splitMaskAnimation(clip.mask, patch.duration).left;
    if (next.transitionIn && compare(next.transitionIn.duration, patch.duration) > 0) next.transitionIn = { ...next.transitionIn, duration: patch.duration };
    if (next.title) {
      if (compare(next.title.start, patch.duration) >= 0) next.title = undefined;
      else if (compare(add(next.title.start, next.title.duration), patch.duration) > 0) next.title = { ...next.title, duration: sub(patch.duration, next.title.start) };
    }
  }
  if (BigInt(next.duration.num) <= 0n || compare(add(next.sourceIn, clipSourceDuration(next)), asset.duration) > 0) throw new AppError('SOURCE_RANGE_EXCEEDED', 'The trimmed source range is invalid or exceeds the media duration at the selected playback speed.');
  Object.assign(clip, next);
  if (clip.fadeIn && compare(clip.fadeIn, clip.duration) > 0) clip.fadeIn = clip.duration;
  if (clip.fadeOut && compare(clip.fadeOut, clip.duration) > 0) clip.fadeOut = clip.duration;
  track.clips.sort((a, b) => compare(a.start, b.start));
  await saveProject(filePath, project);
  return project;
}

export async function setClipAudio(filePath: string, clipId: string, patch: { audioEnabled?: boolean; volume?: number; fadeIn?: Rational; fadeOut?: Rational }): Promise<Project> {
  const project = await loadProject(filePath);
  const { clip, track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  const next = { ...clip, ...patch };
  if (patch.fadeIn !== undefined) clampNonNegative(patch.fadeIn, 'Fade in');
  if (patch.fadeOut !== undefined) clampNonNegative(patch.fadeOut, 'Fade out');
  if ((patch.fadeIn !== undefined && compare(patch.fadeIn, next.duration) > 0) || (patch.fadeOut !== undefined && compare(patch.fadeOut, next.duration) > 0))
    throw new AppError('INVALID_FADE', 'Audio fade durations cannot exceed the clip duration.');
  if (patch.volume !== undefined && (!Number.isFinite(patch.volume) || patch.volume < 0 || patch.volume > 8))
    throw new AppError('INVALID_VOLUME', 'Clip volume must be between 0 and 8.');
  Object.assign(clip, patch);
  await saveProject(filePath, project);
  return project;
}

export async function setClipEffects(filePath: string, clipId: string, patch: Partial<Pick<TimelineClip, 'playbackRate' | 'speedKeyframes' | 'transform' | 'color' | 'keyframes' | 'transitionIn' | 'title' | 'normalizeAudio' | 'blendMode' | 'chromaKey' | 'mask'>>): Promise<Project> {
  const project = await loadProject(filePath);
  const { clip, track } = findClip(project, clipId);
  if (track.locked) throw new AppError('TRACK_LOCKED', `Track ${track.name} is locked.`);
  const updated = { ...clip, ...structuredClone(patch) };
  const asset = project.media.find((item) => item.id === clip.mediaId)!;
  if (compare(add(updated.sourceIn, clipSourceDuration(updated)), asset.duration) > 0) throw new AppError('SOURCE_RANGE_EXCEEDED', 'The selected speed curve consumes more source media than is available.');
  Object.assign(clip, structuredClone(patch));
  validateProject(project);
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
  const rightDuration = subSafe(oldDuration, offset);
  const oldFadeIn = clip.fadeIn ?? rational(0), oldFadeOut = clip.fadeOut ?? rational(0);
  const fadeOutStart = subSafe(oldDuration, oldFadeOut);
  const leftFadeIn = compare(oldFadeIn, offset) > 0 ? offset : oldFadeIn;
  const rightFadeIn = compare(oldFadeIn, offset) > 0 ? subSafe(oldFadeIn, offset) : rational(0);
  const leftFadeOut = compare(offset, fadeOutStart) > 0 ? subSafe(offset, fadeOutStart) : rational(0);
  const rightFadeOut = compare(oldFadeOut, rightDuration) > 0 ? rightDuration : oldFadeOut;
  const animation = splitClipAnimation(clip, offset);
  const rightTitle = clip.title ? (() => {
    const titleEnd = add(clip.title!.start, clip.title!.duration);
    const start = compare(clip.title!.start, offset) < 0 ? offset : clip.title!.start;
    const end = compare(titleEnd, oldDuration) > 0 ? oldDuration : titleEnd;
    return compare(end, offset) > 0 ? { ...clip.title!, start: sub(start, offset), duration: sub(end, start) } : undefined;
  })() : undefined;
  if (clip.title) {
    const titleEnd = add(clip.title.start, clip.title.duration);
    const end = compare(titleEnd, offset) > 0 ? offset : titleEnd;
    clip.title = compare(end, clip.title.start) > 0 ? { ...clip.title, duration: sub(end, clip.title.start) } : undefined;
  }
  const right: TimelineClip = {
    ...structuredClone(clip), id: newId(), start: atTimeline, sourceIn: add(clip.sourceIn, clipSourceOffsetAt(clip, offset)), duration: rightDuration,
    playbackRate: animation.rightPlaybackRate, speedKeyframes: animation.rightSpeedKeyframes, keyframes: animation.rightKeyframes,
    title: rightTitle, transitionIn: undefined, fadeIn: rightFadeIn, fadeOut: rightFadeOut
  };
  clip.speedKeyframes = animation.leftSpeedKeyframes;
  clip.keyframes = animation.leftKeyframes;
  if (clip.transitionIn && compare(clip.transitionIn.duration, offset) > 0) clip.transitionIn = { ...clip.transitionIn, duration: offset };
  clip.duration = offset;
  clip.fadeIn = leftFadeIn;
  clip.fadeOut = leftFadeOut;
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

export async function updateMediaMetadata(filePath: string, mediaId: string, patch: { favorite?: boolean; rating?: number; tags?: string[]; game?: string | null; analysisEventReviews?: AnalysisEventReview[] }): Promise<Project> {
  const project = await loadProject(filePath);
  const asset = project.media.find((item) => item.id === mediaId);
  if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
  if (patch.rating !== undefined && (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5)) {
    throw new AppError('INVALID_RATING', 'Highlight rating must be an integer from 0 to 5.');
  }
  if (patch.analysisEventReviews !== undefined) validateEventReviews(patch.analysisEventReviews, Number(asset.duration.num) / Number(asset.duration.den));
  if (patch.favorite !== undefined) asset.favorite = patch.favorite;
  if (patch.rating !== undefined) asset.rating = patch.rating;
  if (patch.tags !== undefined) asset.tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 100);
  if (patch.game !== undefined) asset.game = patch.game?.trim() || undefined;
  if (patch.analysisEventReviews !== undefined) asset.analysisEventReviews = patch.analysisEventReviews.map((review) => ({ ...review, detectorIds: [...review.detectorIds] }));
  const library = new MediaLibrary(libraryDatabasePath(filePath, project.id));
  try {
    library.upsert(asset);
    library.updatePreferences(mediaId, { favorite: patch.favorite, rating: patch.rating, tags: asset.tags, game: patch.game });
    await saveProject(filePath, project);
  } finally { library.close(); }
  return project;
}

function validateEventReviews(reviews: AnalysisEventReview[], durationSeconds: number): void {
  if (!Array.isArray(reviews) || reviews.length > 5000) throw new AppError('INVALID_EVENT_REVIEW', 'Event review list must contain at most 5000 entries.');
  const ids = new Set<string>();
  for (const review of reviews) {
    if (!review || typeof review.eventId !== 'string' || !review.eventId || review.eventId.length > 256 || ids.has(review.eventId)) {
      throw new AppError('INVALID_EVENT_REVIEW', 'Event review IDs must be unique, non-empty strings of at most 256 characters.');
    }
    ids.add(review.eventId);
    if (!['accepted', 'rejected', 'corrected'].includes(review.status) || !Array.isArray(review.detectorIds) || review.detectorIds.length > 16 || review.detectorIds.some((id) => typeof id !== 'string' || id.length > 128)) {
      throw new AppError('INVALID_EVENT_REVIEW', `Event review ${review.eventId} has an invalid status or detector list.`);
    }
    const times = [review.startSeconds, review.decisiveSeconds, review.endSeconds];
    if (!times.every(Number.isFinite) || review.startSeconds < 0 || review.startSeconds > review.decisiveSeconds || review.decisiveSeconds > review.endSeconds || review.endSeconds > durationSeconds + 0.001 || typeof review.updatedAt !== 'string') {
      throw new AppError('INVALID_EVENT_REVIEW', `Event review ${review.eventId} has invalid timestamps.`);
    }
  }
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
