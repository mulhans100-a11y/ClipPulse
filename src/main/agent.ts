import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { analyzeAudio } from '../core/audioAnalysis';
import { analyzeHighlightCues } from '../core/highlightAnalysis';
import { getOptionalAnalysisRuntimes } from '../core/analysisRuntimes';
import { generateAutomaticMontages } from '../core/autoMontage';
import { clipSourceOffsetAt } from '../core/clipEffects';
import { generateClipModelMask } from '../core/modelSegmentation';
import { AppError, asAppError } from '../core/errors';
import { exportVideo } from '../core/export';
import { ffmpegAvailable, runCommand } from '../core/ffmpeg';
import { addClip, addTrack, createProject, duplicateClip, fileExists, getProjectHistory, importMedia, loadProject, moveClip, projectCachePath, projectHistoryPath, redoProject, relinkMedia, removeClip, saveProject, searchMedia, setClipAudio, setClipEffects, splitClip, timelineDuration, trimClip, undoProject, updateMediaMetadata, updateProjectProfile, updateTrackSettings, validateProject } from '../core/project';
import { renderTimelineFrame, timelinePreviewCacheKey } from '../core/timelinePreview';
import { prunePreviewCache } from '../core/previewCache';
import { analyzeProjectQuality, persistQualityReport, type QualityReport } from '../core/qualityAnalysis';
import { add, frameTime, parseDecimal, rational, sub, toFrame, compare, decimal } from '../core/time';
import type { AutoMontageFormat, AutoMontageStyle, HighlightAnalysis, Project, Rational, TimelineClip } from '../core/types';

export const AGENT_SCHEMA_VERSION = 1;
type Schema = { type: 'object'; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean };
export interface AgentTool { name: string; description: string; inputSchema: Schema; outputSchema?: Schema; }
const str = (description: string, maxLength?: number) => ({ type: 'string', description, ...(maxLength === undefined ? {} : { maxLength }) });
const bool = (description: string) => ({ type: 'boolean', description });
const num = (description: string, minimum?: number, maximum?: number) => ({ type: 'number', description, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) });
const arr = (items: any, description: string, minItems?: number, maxItems?: number) => ({ type: 'array', items, description, ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) });
const obj = (properties: Record<string, any>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const projectPath = str('Absolute path to an .omproj file inside a granted root.');
const nullable = (schema: Record<string, any>) => ({ ...schema, type: Array.isArray(schema.type) ? [...schema.type, 'null'] : [schema.type, 'null'] });
const effectProperties: Record<string, any> = {
  playbackRate: nullable(str('Source-seconds per timeline-second, for example 3/2.')),
  speedKeyframes: nullable(arr(obj({ time: str('Clip-local time.'), rate: str('Exact source-seconds per timeline-second.') }, ['time', 'rate']), 'Linear speed-ramp points.', 0, 256)),
  transform: nullable(obj({ scale: num('Scale.', 0.1, 4), x: num('Horizontal position in pixels.'), y: num('Vertical position in pixels.'), rotationDegrees: num('Rotation angle.', -360, 360) }, ['scale', 'x', 'y', 'rotationDegrees'])),
  color: nullable(obj({ brightness: num('Brightness adjustment.', -1, 1), contrast: num('Contrast multiplier.', 0, 4), saturation: num('Saturation multiplier.', 0, 4), lutPath: nullable(str('Optional granted .cube file path.', 4096)) }, ['brightness', 'contrast', 'saturation'])),
  keyframes: nullable(arr(obj({ property: { type: 'string', enum: ['opacity', 'brightness', 'contrast', 'saturation', 'volume'] }, time: str('Clip-local time.'), value: num('Keyframe value.'), interpolation: { type: 'string', enum: ['linear', 'hold'] } }, ['property', 'time', 'value']), 'Animated property points.', 0, 1024)),
  transitionIn: nullable(obj({ type: { type: 'string', enum: ['dissolve', 'wipe-left', 'wipe-right'] }, duration: str('Transition duration.') }, ['type', 'duration'])),
  title: nullable(obj({ text: str('Title text.', 500), fontSize: num('Font size.', 8, 256), color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, x: num('Horizontal position.', 0, 1), y: num('Vertical position.', 0, 1), start: str('Clip-local start.'), duration: str('Title duration.'), box: bool('Draw a backing box.'), fontFile: nullable(str('Optional granted font file path.', 4096)) }, ['text', 'fontSize', 'color', 'x', 'y', 'start', 'duration'])),
  normalizeAudio: nullable(bool('Normalize clip loudness.')),
  blendMode: nullable({ type: 'string', enum: ['normal', 'multiply', 'screen', 'add', 'difference'] }),
  chromaKey: nullable(obj({ color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, similarity: num('Similarity threshold.', 0, 1), blend: num('Edge blend.', 0, 1) }, ['color', 'similarity', 'blend'])),
  mask: nullable(obj({ path: str('Closed normalized SVG path.', 4096), featherPx: num('Feather in pixels.', 0, 256), expansionPx: num('Expansion in pixels.', -256, 256), keyframes: arr(obj({ time: str('Clip-local correction time.'), path: str('Closed normalized SVG mask path.', 4096) }, ['time', 'path']), 'Manual tracking corrections.', 0, 256), provenance: obj({ modelId: str('Pinned model repository.'), revision: str('Pinned model revision.'), className: str('Tracked object class.'), sampleCount: num('Number of temporal samples.', 1, 96), stabilization: { type: 'string', enum: ['temporal-majority-v1', 'single-frame-v1'] } }, ['modelId', 'revision', 'className', 'sampleCount', 'stabilization']) }, ['path', 'featherPx', 'expansionPx']))
};
const effectPatchSchema = { type: 'object', description: 'Patch matching config/clip-effects.schema.json.', properties: effectProperties, additionalProperties: false };
const trackSettingsSchema = obj({ muted: bool('Mute this track.'), solo: bool('Solo this track.'), locked: bool('Lock editing.'), volume: num('Track gain multiplier.', 0, 8), audioRole: { type: 'string', enum: ['standard', 'dialogue', 'music'] }, normalizeAudio: bool('Normalize track loudness.'), duckUnderDialogue: bool('Duck this music track under dialogue.'), volumeKeyframes: arr(obj({ time: str('Track-local time.'), value: num('Gain multiplier.', 0, 8), interpolation: { type: 'string', enum: ['linear', 'hold'] } }, ['time', 'value']), 'Track gain automation.', 0, 1024) });
const clipAudioSchema = obj({ audioEnabled: bool('Enable source audio.'), volume: num('Clip gain multiplier.', 0, 8), fadeIn: str('Fade-in time.'), fadeOut: str('Fade-out time.') });
const tool = (name: string, description: string, properties: Record<string, any>, required: string[] = []): AgentTool => ({ name, description, inputSchema: obj(properties, required), outputSchema: { type: 'object', properties: {}, additionalProperties: true } });

export const AGENT_TOOLS: AgentTool[] = [
  tool('project_create', 'Create a versioned editable project.', { projectPath, name: str('Project name.'), width: num('Output width in pixels.', 16, 8192), height: num('Output height in pixels.', 16, 8192), frameRate: str('Exact rational FPS, e.g. 30000/1001.') }, ['projectPath']),
  tool('project_update_profile', 'Update project name, output dimensions, or exact rational frame rate.', { projectPath, name: str('Project name.'), width: num('Output width in pixels.', 16, 8192), height: num('Output height in pixels.', 16, 8192), frameRate: str('Exact rational FPS, e.g. 30000/1001.') }, ['projectPath']),
  tool('project_open', 'Open and return the complete machine-readable project state.', { projectPath }, ['projectPath']),
  tool('project_inspect', 'Return exact timeline timecodes, tracks, clips, media references, effects, and history.', { projectPath }, ['projectPath']),
  tool('project_validate', 'Validate project structure and report missing or ungranted media.', { projectPath }, ['projectPath']),
  tool('project_save', 'Validate and atomically save the current project representation.', { projectPath }, ['projectPath']),
  tool('project_undo', 'Restore the previous persistent project state.', { projectPath }, ['projectPath']),
  tool('project_redo', 'Restore the next persistent project state.', { projectPath }, ['projectPath']),
  tool('project_transaction', 'Run up to 32 timeline/effect edits atomically; a failed step restores project and history.', { projectPath, operations: arr(obj({ name: str('Editing tool name.'), arguments: { type: 'object', description: 'Arguments for that editing tool.' } }, ['name', 'arguments']), 'Ordered editing operations.', 1, 32) }, ['projectPath', 'operations']),
  tool('media_import', 'Import files or recursively scan granted folders; source media remains read-only.', { projectPath, paths: arr(str('Absolute local file or folder path.'), 'Media files or directories.', 1, 64), recursive: bool('Scan folders recursively; defaults to true.') }, ['projectPath', 'paths']),
  tool('media_search', 'Search the project library by name, path, tags, and game.', { projectPath, query: str('Optional search text.'), favoritesOnly: bool('Only return favorites.') }, ['projectPath']),
  tool('media_get', 'Return metadata for one imported media asset.', { projectPath, mediaId: str('Media asset ID.') }, ['projectPath', 'mediaId']),
  tool('media_update', 'Set asset tags, game, favorite/rating, and accept, reject, or correct analyzed event proposals.', { projectPath, mediaId: str('Media asset ID.'), favorite: bool('Favorite state.'), rating: num('Manual highlight rating.', 0, 5), tags: arr(str('Tag.'), 'Replacement tag list.', 0, 100), game: { type: ['string', 'null'], description: 'Game label, or null to clear.' }, analysisEventReviews: arr(obj({ eventId: str('Stable detected event ID.'), detectorIds: arr(str('Detector provenance ID.'), 'Detector IDs.', 0, 16), status: { type: 'string', enum: ['accepted', 'rejected', 'corrected'] }, startSeconds: num('Reviewed event window start.', 0), decisiveSeconds: num('Decisive event time.', 0), endSeconds: num('Reviewed event window end.', 0), correctedEventType: { type: 'string', enum: ['kill', 'headshot', 'multi_kill', 'ace', 'clutch', 'clutch_situation', 'round_end', 'round_objective', 'kill_feed_change', 'combat_activity', 'fast_action_candidate', 'quiet_passage', 'audio_activity', 'scene_change', 'text_recognition', 'unknown'], description: 'Optional manually corrected semantic event type.' }, updatedAt: str('Review timestamp in ISO-8601 form.') }, ['eventId', 'detectorIds', 'status', 'startSeconds', 'decisiveSeconds', 'endSeconds', 'updatedAt']), 'Full replacement review list.', 0, 5000) }, ['projectPath', 'mediaId']),
  tool('media_relink', 'Relink a missing asset to a compatible granted source file.', { projectPath, mediaId: str('Media asset ID.'), path: str('Replacement media path.') }, ['projectPath', 'mediaId', 'path']),
  tool('media_get_frames', 'Extract up to 12 source preview frames as JPEG images.', { projectPath, mediaId: str('Video media asset ID.'), times: arr(num('Source time in seconds.', 0), 'Frame times in source seconds.', 1, 12) }, ['projectPath', 'mediaId', 'times']),
  tool('media_analyze', 'Analyze audio beats or detect highlight cues for an imported asset.', { projectPath, mediaId: str('Media asset ID.'), kind: { type: 'string', enum: ['audio', 'highlights'], description: 'Analysis type.' } }, ['projectPath', 'mediaId', 'kind']),
  tool('audio_analyze', 'Analyze music locally and cache BPM hypotheses, beats, downbeats, energy and drops.', { projectPath, mediaId: str('Audio-capable asset ID.') }, ['projectPath', 'mediaId']),
  tool('audio_get_beat_grid', 'Return the cached or newly computed exact beat-grid data.', { projectPath, mediaId: str('Audio-capable asset ID.') }, ['projectPath', 'mediaId']),
  tool('highlights_detect', 'Run available local event detectors and return timestamped, provenance-tagged proposals.', { projectPath, mediaId: str('Media asset ID.') }, ['projectPath', 'mediaId']),
  tool('highlights_rank', 'Return detected proposals ordered by their heuristic rank score.', { projectPath, mediaId: str('Media asset ID.'), minimumScore: num('Optional minimum heuristic score.', 0, 100) }, ['projectPath', 'mediaId']),
  tool('timeline_inspect', 'Return frame-snapped timeline state with exact rational clip times.', { projectPath }, ['projectPath']),
  tool('timeline_add_track', 'Add a video or audio track.', { projectPath, kind: { type: 'string', enum: ['video', 'audio'] }, name: str('Optional track name.') }, ['projectPath', 'kind']),
  tool('timeline_add_clip', 'Insert a media source range on a compatible track.', { projectPath, mediaId: str('Media asset ID.'), trackId: str('Track ID.'), start: str('Timeline start in seconds or rational form.'), sourceIn: str('Source in point; defaults to zero.'), duration: str('Optional duration; defaults to remaining source.') }, ['projectPath', 'mediaId', 'trackId']),
  tool('timeline_duplicate_clip', 'Duplicate a clip and its effects/audio settings.', { projectPath, clipId: str('Timeline clip ID.'), start: str('Optional new timeline start.') }, ['projectPath', 'clipId']),
  tool('timeline_trim_clip', 'Change clip timeline start, source in point, or duration.', { projectPath, clipId: str('Timeline clip ID.'), start: str('New timeline start.'), sourceIn: str('New source in point.'), duration: str('New duration.') }, ['projectPath', 'clipId']),
  tool('timeline_move_clip', 'Move a clip to a new timeline position and optional track.', { projectPath, clipId: str('Timeline clip ID.'), start: str('New timeline start.'), trackId: str('Optional destination track ID.') }, ['projectPath', 'clipId', 'start']),
  tool('timeline_split_clip', 'Split a clip at a timeline time.', { projectPath, clipId: str('Timeline clip ID.'), at: str('Timeline split point in seconds.') }, ['projectPath', 'clipId', 'at']),
  tool('timeline_remove_clip', 'Remove a clip from the timeline.', { projectPath, clipId: str('Timeline clip ID.') }, ['projectPath', 'clipId']),
  tool('timeline_align_event', 'Move a clip so a source event lands on an exact target timeline time.', { projectPath, clipId: str('Timeline clip ID.'), sourceTime: str('Decisive source time in seconds.'), targetTime: str('Desired timeline time in seconds.') }, ['projectPath', 'clipId', 'sourceTime', 'targetTime']),
  tool('timeline_set_track', 'Set track mute/solo/lock, gain, role, normalization, ducking, or gain automation.', { projectPath, trackId: str('Track ID.'), settings: trackSettingsSchema }, ['projectPath', 'trackId', 'settings']),
  tool('timeline_set_clip_audio', 'Set clip audio enable, gain and fade durations.', { projectPath, clipId: str('Timeline clip ID.'), settings: clipAudioSchema }, ['projectPath', 'clipId', 'settings']),
  tool('effect_add', 'Apply clip effect parameters through the shared preview/export engine.', { projectPath, clipId: str('Timeline clip ID.'), effects: effectPatchSchema }, ['projectPath', 'clipId', 'effects']),
  tool('effect_update', 'Update selected clip effects without replacing unrelated effect fields.', { projectPath, clipId: str('Timeline clip ID.'), effects: effectPatchSchema }, ['projectPath', 'clipId', 'effects']),
  tool('effect_remove', 'Clear selected effect fields by setting them to null.', { projectPath, clipId: str('Timeline clip ID.'), fields: arr({ type: 'string', enum: ['playbackRate', 'speedKeyframes', 'transform', 'color', 'keyframes', 'transitionIn', 'title', 'normalizeAudio', 'blendMode', 'chromaKey', 'mask'] }, 'Fields to clear; defaults to all effect fields.') }, ['projectPath', 'clipId']),
  tool('keyframe_set', 'Insert or replace a clip keyframe at an exact local clip time.', { projectPath, clipId: str('Timeline clip ID.'), property: { type: 'string', enum: ['opacity', 'brightness', 'contrast', 'saturation', 'volume'] }, time: str('Clip-local seconds.'), value: num('Keyframe value.'), interpolation: { type: 'string', enum: ['linear', 'hold'] } }, ['projectPath', 'clipId', 'property', 'time', 'value']),
  tool('mask_create', 'Set a closed normalized polygon or Bézier path mask.', { projectPath, clipId: str('Timeline clip ID.'), path: str('Closed SVG M/L/Q/C/Z path in normalized 0–1 frame coordinates.', 4096), featherPx: num('Feather radius in pixels.', 0, 256), expansionPx: num('Mask expansion in pixels.', -256, 256) }, ['projectPath', 'clipId', 'path']),
  tool('mask_track', 'Set manually corrected time-keyed mask paths; points must correspond across corrections.', { projectPath, clipId: str('Timeline clip ID.'), keyframes: arr(obj({ time: str('Clip-local time.'), path: str('Closed normalized SVG mask path.', 4096) }, ['time', 'path']), 'Ordered correction keyframes.', 1, 256) }, ['projectPath', 'clipId', 'keyframes']),
  tool('mask_segment', 'Generate a local ONNX object mask for a recognized class; track the matching instance and temporally stabilize its path.', { projectPath, clipId: str('Video timeline clip ID.'), className: str('Recognized object class such as person, car, dog, cat, or chair.', 80), sampleFps: num('Mask inference samples per second.', 0.25, 8), scoreThreshold: num('Minimum instance score.', 0, 1) }, ['projectPath', 'clipId']),
  tool('composition_create', 'Configure blend modes and masks on one or more existing compositing layers.', { projectPath, layers: arr(obj({ clipId: str('Timeline clip ID.'), blendMode: { type: 'string', enum: ['normal', 'multiply', 'screen', 'add', 'difference'] } }, ['clipId']), 'Layer effect settings.') }, ['projectPath', 'layers']),
  tool('montage_generate', 'Generate explainable editable montage project variants without modifying the source project.', { projectPath, musicId: str('Music media asset ID.'), durationSeconds: num('Target montage duration.', 1, 3600), style: { type: 'string', enum: ['clean', 'aggressive', 'cinematic', 'smooth', 'velocity', 'custom'] }, videoIds: arr(str('Optional video media ID.'), 'Optional video asset selection.'), variants: num('Number of variants.', 1, 5), intensity: num('Pacing intensity.', 0, 100), format: { type: 'string', enum: ['project', 'landscape-1080p', 'portrait-1080p', 'square-1080p'] }, outputDirectory: str('Output directory inside a granted root.') }, ['projectPath', 'musicId', 'durationSeconds']),
  tool('preview_render', 'Render the composite timeline frame at the exact project frame nearest the requested time.', { projectPath, time: str('Timeline time in seconds.') }, ['projectPath', 'time']),
  tool('preview_analyze', 'Render and inspect a composite frame using FFmpeg signal statistics.', { projectPath, time: str('Timeline time in seconds.') }, ['projectPath', 'time']),
  tool('quality_analyze', 'Create and persist an objective timeline/render quality report with representative preview frames. Optional selected beat targets are checked exactly; subjective aesthetics are not scored.', { projectPath, selectedBeatTargets: arr(str('A selected timeline beat time, preserving exact rational notation.'), 'Optional beat targets to check against video edit points.', 0, 500), beatToleranceMs: num('Allowed edit-to-beat deviation in milliseconds; defaults to 80.', 0, 1000), maxAutomaticGapSeconds: num('Largest same-track video gap eligible for an automatic move suggestion.', 0, 5), renderAudio: bool('Render the current timeline once to measure clipping and sustained silence; defaults to true.') }, ['projectPath']),
  tool('quality_report_get', 'Load a previously persisted quality report by its ID.', { projectPath, reportId: str('Quality report UUID.') }, ['projectPath', 'reportId']),
  tool('quality_report_list', 'List recent persisted quality reports for a project.', { projectPath, limit: num('Maximum reports to return; defaults to 20.', 1, 100) }, ['projectPath']),
  tool('quality_improve', 'Run a bounded quality-feedback loop: analyze, transactionally close safe small same-track video gaps, render a new preview, and recheck. Defaults to at most three iterations; all other findings remain suggestions for the agent.', { projectPath, maxIterations: num('Maximum analyze/fix/recheck iterations (default 3).', 1, 3), maxAutomaticGapSeconds: num('Largest same-track video gap eligible for automatic correction; defaults to 0.5.', 0, 5), beatToleranceMs: num('Allowed edit-to-beat deviation in milliseconds; defaults to 80.', 0, 1000), selectedBeatTargets: arr(str('A selected timeline beat time, preserving exact rational notation.'), 'Optional beat targets.', 0, 500) }, ['projectPath']),
  tool('video_export', 'Start a validated asynchronous MP4 export; poll render_status for progress.', { projectPath, outputPath: str('Output MP4 inside a granted root.'), overwrite: bool('Replace an existing output after validation.'), encoder: { type: 'string', enum: ['libx264', 'h264_amf', 'h264_nvenc', 'h264_qsv'] } }, ['projectPath', 'outputPath']),
  tool('render_status', 'Read progress, completion, or failure for an export job, including after service restart.', { projectPath, jobId: str('Render job ID.') }, ['projectPath', 'jobId']),
  tool('diagnostics', 'Report platform, Node, FFmpeg, and optional local analysis runtimes.', {}),
];

type Job = { id: string; projectPath: string; status: 'queued' | 'running' | 'complete' | 'failed'; progress: number; createdAt: string; updatedAt: string; outputPath: string; result?: unknown; error?: { code: string; message: string } };
export interface AgentServiceOptions { allowedRoots: string[]; }

export class AgentService {
  readonly tools = AGENT_TOOLS;
  readonly allowedRoots: string[];
  private readonly locks = new Map<string, Promise<void>>();
  private readonly jobs = new Map<string, Job>();
  private readonly jobWrites = new Map<string, Promise<void>>();
  constructor(options: AgentServiceOptions) {
    if (!options.allowedRoots.length) throw new AppError('PATH_PERMISSION_REQUIRED', 'At least one --allow-root directory is required.');
    this.allowedRoots = options.allowedRoots.map((root) => path.resolve(root));
  }

  async initialize(): Promise<void> {
    this.allowedRoots.splice(0, this.allowedRoots.length, ...await Promise.all(this.allowedRoots.map(async (root) => {
      const canonical = await fs.realpath(root).catch(() => { throw new AppError('PATH_PERMISSION_INVALID', `Granted root does not exist: ${root}`); });
      if (!(await fs.stat(canonical)).isDirectory()) throw new AppError('PATH_PERMISSION_INVALID', `Granted root is not a directory: ${root}`);
      return canonical;
    })));
  }

  async call(name: string, input: unknown): Promise<any> {
    const definition = this.tools.find((item) => item.name === name);
    if (!definition) throw new AppError('UNKNOWN_TOOL', `Unknown agent tool: ${name}`);
    const args = validateInput(definition.inputSchema, input);
    if (args.projectPath && name !== 'project_create') return this.withProjectLock(args.projectPath, async () => {
      const recoveryPath = await this.assertPath(args.projectPath, 'write');
      await this.recoverInterruptedTransactions(recoveryPath);
      return name === 'project_transaction' ? this.transaction(args) : this.execute(name, args);
    });
    if (args.projectPath) return this.withProjectLock(args.projectPath, () => this.execute(name, args));
    return this.execute(name, args);
  }

  async schemaDocument(): Promise<unknown> {
    return { schemaVersion: AGENT_SCHEMA_VERSION, protocol: 'OpenMontage Agent API', tools: this.tools,
      envelopes: { success: { type: 'object', required: ['schemaVersion', 'ok', 'data'], properties: { schemaVersion: { const: AGENT_SCHEMA_VERSION }, ok: { const: true }, data: {} } }, error: { type: 'object', required: ['schemaVersion', 'ok', 'error'], properties: { schemaVersion: { const: AGENT_SCHEMA_VERSION }, ok: { const: false }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } } } } };
  }

  private async withProjectLock<T>(projectFile: string, action: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectFile).toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  private async execute(name: string, a: any): Promise<any> {
    const projectFile = a.projectPath && name !== 'project_create' ? await this.assertPath(a.projectPath, 'read') : undefined;
    if (name === 'project_create') {
      const target = await this.assertPath(a.projectPath, 'write');
      const project = await createProject(target, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.width !== undefined ? { width: a.width } : {}), ...(a.height !== undefined ? { height: a.height } : {}), ...(a.frameRate ? { frameRate: parseDecimal(a.frameRate) } : {}) });
      return { filePath: target, project };
    }
    if (name === 'diagnostics') return { schemaVersion: AGENT_SCHEMA_VERSION, platform: process.platform, node: process.version, ffmpeg: await ffmpegAvailable(), runtimes: (await getOptionalAnalysisRuntimes()).map(({ executablePath: _path, ...runtime }) => runtime) };
    if (!projectFile) throw new AppError('INVALID_ARGUMENTS', 'projectPath is required.');
    const project = await loadProject(projectFile);
    // Core operations own these project-adjacent sidecars; reject redirected/symlinked locations before touching them.
    await this.assertPath(projectCachePath(projectFile, project.id), 'write');
    await this.assertPath(projectHistoryPath(projectFile, project.id), 'write');
    if (name === 'project_open') return { filePath: projectFile, project, history: await getProjectHistory(projectFile) };
    if (name === 'project_update_profile') {
      if (!['name', 'width', 'height', 'frameRate'].some((field) => field in a)) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one project profile field.');
      const updated = await updateProjectProfile(projectFile, { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.width !== undefined ? { width: a.width } : {}), ...(a.height !== undefined ? { height: a.height } : {}), ...(a.frameRate !== undefined ? { frameRate: parseDecimal(a.frameRate) } : {}) });
      return { project: updated, history: await getProjectHistory(projectFile) };
    }
    if (name === 'project_inspect' || name === 'timeline_inspect') return { ...inspectProject(projectFile, project), history: await getProjectHistory(projectFile) };
    if (name === 'project_validate') {
      validateProject(project);
      const media = await Promise.all(project.media.map(async (asset) => {
        try { await this.assertPath(asset.path, 'read'); return { id: asset.id, path: asset.path, exists: true, permitted: true }; }
        catch (error) { const e = asAppError(error); return { id: asset.id, path: asset.path, exists: e.code !== 'ENOENT' && e.code !== 'PATH_NOT_FOUND', permitted: e.code !== 'PATH_PERMISSION_DENIED', error: e.code }; }
      }));
      return { valid: media.every((item) => item.exists && item.permitted), structuralValid: true, media, history: await getProjectHistory(projectFile) };
    }
    if (name === 'project_save') { validateProject(project); await this.assertProjectMedia(project, false); await saveProject(projectFile, project, { recordHistory: false }); return { saved: true, filePath: projectFile, updatedAt: project.updatedAt }; }
    if (name === 'project_undo') return { project: await undoProject(projectFile), history: await getProjectHistory(projectFile) };
    if (name === 'project_redo') return { project: await redoProject(projectFile), history: await getProjectHistory(projectFile) };
    if (name === 'media_import') {
      if (!Array.isArray(a.paths) || a.paths.length < 1 || a.paths.length > 64) throw new AppError('INVALID_ARGUMENTS', 'paths must contain between 1 and 64 entries.');
      for (const item of a.paths) await this.preflightImport(item, a.recursive !== false);
      return importMedia(projectFile, a.paths.map((item: string) => path.resolve(item)), a.recursive !== false);
    }
    if (name === 'media_search') return searchMedia(projectFile, a.query ?? '', a.favoritesOnly ?? false);
    if (name === 'media_get') { const asset = project.media.find((item) => item.id === a.mediaId); if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${a.mediaId}`); return asset; }
    if (name === 'media_update') {
      const patch: Record<string, unknown> = {}; for (const field of ['favorite', 'rating', 'tags', 'game', 'analysisEventReviews']) if (field in a) patch[field] = a[field];
      if (!Object.keys(patch).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one media metadata or event-review field.');
      const updated = await updateMediaMetadata(projectFile, a.mediaId, patch as Parameters<typeof updateMediaMetadata>[2]); return updated.media.find((asset) => asset.id === a.mediaId);
    }
    if (name === 'media_relink') { const replacement = await this.assertPath(a.path, 'read'); return relinkMedia(projectFile, a.mediaId, replacement); }
    if (name === 'media_get_frames') return this.sourceFrames(projectFile, project, a.mediaId, a.times);
    if (name === 'audio_analyze' || name === 'audio_get_beat_grid' || (name === 'media_analyze' && a.kind === 'audio')) return this.audioAnalysis(projectFile, project, a.mediaId);
    if (name === 'highlights_detect' || name === 'highlights_rank' || (name === 'media_analyze' && a.kind === 'highlights')) {
      const result = await this.highlightAnalysis(projectFile, project, a.mediaId);
      if (name === 'highlights_rank') return { ...result, events: result.events.filter((event) => event.rankScore >= (a.minimumScore ?? 0)).sort((x, y) => y.rankScore - x.rankScore) };
      return result;
    }
    if (name === 'timeline_add_track') { const updated = await addTrack(projectFile, a.kind, a.name); return updated.tracks.at(-1); }
    if (name === 'timeline_add_clip') { const previous = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id))); const updated = await addClip(projectFile, a.mediaId, a.trackId, parseDecimal(a.start ?? '0'), parseDecimal(a.sourceIn ?? '0'), a.duration === undefined ? undefined : parseDecimal(a.duration)); return updated.tracks.flatMap((track) => track.clips).find((clip) => !previous.has(clip.id)); }
    if (name === 'timeline_duplicate_clip') { const previous = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id))); const updated = await duplicateClip(projectFile, a.clipId, a.start === undefined ? undefined : parseDecimal(a.start)); return updated.tracks.flatMap((track) => track.clips).find((clip) => !previous.has(clip.id)); }
    if (name === 'timeline_trim_clip') { const updated = await trimClip(projectFile, a.clipId, { ...(a.start !== undefined ? { start: parseDecimal(a.start) } : {}), ...(a.sourceIn !== undefined ? { sourceIn: parseDecimal(a.sourceIn) } : {}), ...(a.duration !== undefined ? { duration: parseDecimal(a.duration) } : {}) }); return findClip(updated, a.clipId).clip; }
    if (name === 'timeline_move_clip') { const updated = await moveClip(projectFile, a.clipId, parseDecimal(a.start), a.trackId); return findClip(updated, a.clipId).clip; }
    if (name === 'timeline_split_clip') { const before = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id))); const updated = await splitClip(projectFile, a.clipId, parseDecimal(a.at)); return updated.tracks.flatMap((track) => track.clips).filter((clip) => clip.id === a.clipId || !before.has(clip.id)); }
    if (name === 'timeline_remove_clip') { await removeClip(projectFile, a.clipId); return { removed: a.clipId }; }
    if (name === 'timeline_align_event') return this.alignEvent(projectFile, project, a.clipId, parseDecimal(a.sourceTime), parseDecimal(a.targetTime));
    if (name === 'timeline_set_track') { if (!Object.keys(a.settings).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one track setting.'); const settings = a.settings as Parameters<typeof updateTrackSettings>[2]; await this.assertEffectPaths(settings); const updated = await updateTrackSettings(projectFile, a.trackId, settings); return updated.tracks.find((item) => item.id === a.trackId); }
    if (name === 'timeline_set_clip_audio') { if (!Object.keys(a.settings).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one clip audio setting.'); const updated = await setClipAudio(projectFile, a.clipId, normalizeRationals(a.settings)); return findClip(updated, a.clipId).clip; }
    if (name === 'effect_add' || name === 'effect_update') { if (!Object.keys(a.effects).length) throw new AppError('INVALID_ARGUMENTS', 'effects patch cannot be empty.'); const effects = normalizeEffects(a.effects); await this.assertEffectPaths(effects); const updated = await setClipEffects(projectFile, a.clipId, effects); return findClip(updated, a.clipId).clip; }
    if (name === 'effect_remove') {
      const fields = a.fields?.length ? a.fields : ['playbackRate', 'speedKeyframes', 'transform', 'color', 'keyframes', 'transitionIn', 'title', 'normalizeAudio', 'blendMode', 'chromaKey', 'mask'];
      const patch: Record<string, null> = {}; for (const field of fields) patch[field] = null;
      const updated = await setClipEffects(projectFile, a.clipId, normalizeEffects(patch)); return findClip(updated, a.clipId).clip;
    }
    if (name === 'keyframe_set') {
      const clip = findClip(project, a.clipId).clip; const time = parseDecimal(a.time); const keyframes = (clip.keyframes ?? []).filter((frame) => !(frame.property === a.property && compare(frame.time, time) === 0));
      keyframes.push({ property: a.property, time, value: a.value, ...(a.interpolation ? { interpolation: a.interpolation } : {}) }); keyframes.sort((x, y) => compare(x.time, y.time));
      const updated = await setClipEffects(projectFile, a.clipId, { keyframes }); return findClip(updated, a.clipId).clip;
    }
    if (name === 'mask_segment') {
      const { track, clip } = findClip(project, a.clipId);
      const media = project.media.find((asset) => asset.id === clip.mediaId);
      if (track.kind !== 'video' || media?.kind !== 'video') throw new AppError('SEGMENTATION_NOT_VIDEO', 'Model masks require a video clip on a video track.');
      await this.assertPath(media.path, 'read');
      const stat = await fs.stat(media.path);
      if (!stat.isFile() || stat.size !== media.sizeBytes || stat.mtime.toISOString() !== media.modifiedAt) throw new AppError('SEGMENTATION_SOURCE_CHANGED', 'The source video changed since import. Re-import or relink it before generating a mask.');
      const cacheDirectory = path.join(projectCachePath(projectFile, project.id), 'models');
      await this.assertPath(cacheDirectory, 'write');
      const mask = await generateClipModelMask(media.path, clip, project, cacheDirectory, {
        ...(a.className ? { className: a.className } : {}),
        ...(a.sampleFps !== undefined ? { sampleFps: a.sampleFps } : {}),
        ...(a.scoreThreshold !== undefined ? { scoreThreshold: a.scoreThreshold } : {})
      });
      const updated = await setClipEffects(projectFile, a.clipId, { mask });
      return findClip(updated, a.clipId).clip;
    }
    if (name === 'mask_create' || name === 'mask_track') {
      const current = findClip(project, a.clipId).clip;
      const mask = name === 'mask_create' ? { path: a.path, featherPx: a.featherPx ?? current.mask?.featherPx ?? 0, expansionPx: a.expansionPx ?? current.mask?.expansionPx ?? 0, ...(current.mask?.keyframes ? { keyframes: current.mask.keyframes } : {}) }
        : { path: current.mask?.path ?? a.keyframes[0]?.path, featherPx: current.mask?.featherPx ?? 0, expansionPx: current.mask?.expansionPx ?? 0, keyframes: a.keyframes.map((item: any) => ({ time: parseDecimal(item.time), path: item.path })) };
      if (!mask.path) throw new AppError('INVALID_MASK', 'Create a base mask path before adding tracking corrections.');
      const updated = await setClipEffects(projectFile, a.clipId, { mask }); return findClip(updated, a.clipId).clip;
    }
    if (name === 'composition_create') {
      const transaction = await this.transaction({ projectPath: projectFile, operations: a.layers.map((layer: any) => ({
        name: 'effect_update', arguments: { clipId: layer.clipId, effects: { blendMode: layer.blendMode ?? 'normal' } }
      })) });
      return { layers: transaction.results };
    }
    if (name === 'montage_generate') {
      const outputDirectory = await this.assertPath(a.outputDirectory ?? path.join(path.dirname(projectFile), 'auto-montages'), 'write');
      await this.assertProjectMedia(project, true);
      const generated = await generateAutomaticMontages(projectFile, outputDirectory, { musicMediaId: a.musicId, durationSeconds: a.durationSeconds, style: (a.style ?? 'clean') as AutoMontageStyle, ...(a.videoIds?.length ? { videoMediaIds: a.videoIds } : {}), variants: a.variants ?? 3, intensity: (a.intensity ?? 50) / 100, format: (a.format ?? 'project') as AutoMontageFormat });
      return { outputDirectory: generated.outputDirectory, variants: generated.variants.map(({ projectPath: file, planPath, plan }) => ({ projectPath: file, planPath, variant: plan.variant, style: plan.style, score: plan.score, scoreBreakdown: plan.scoreBreakdown, durationSeconds: plan.durationSeconds, segments: plan.segments.length, warnings: plan.warnings })) };
    }
    if (name === 'quality_analyze') return this.analyzeQuality(projectFile, project, a);
    if (name === 'quality_report_get') return this.getQualityReport(projectFile, project, a.reportId);
    if (name === 'quality_report_list') return this.listQualityReports(projectFile, project, a.limit ?? 20);
    if (name === 'quality_improve') return this.improveQuality(projectFile, project, a);
    if (name === 'preview_render' || name === 'preview_analyze') return this.renderPreview(projectFile, project, a.time, name === 'preview_analyze');
    if (name === 'video_export') return this.startRender(projectFile, project, a);
    if (name === 'render_status') return this.renderStatus(projectFile, a.jobId, project);
    throw new AppError('UNKNOWN_TOOL', `Tool is not implemented: ${name}`);
  }

  private async transaction(a: any, verifyAfterEdits?: () => Promise<void>): Promise<any> {
    if (!Array.isArray(a.operations) || a.operations.length < 1 || a.operations.length > 32) throw new AppError('INVALID_ARGUMENTS', 'A transaction must contain 1 to 32 editing operations.');
    const allowed = new Set(['project_update_profile', 'timeline_add_track', 'timeline_add_clip', 'timeline_duplicate_clip', 'timeline_trim_clip', 'timeline_move_clip', 'timeline_split_clip', 'timeline_remove_clip', 'timeline_align_event', 'timeline_set_track', 'timeline_set_clip_audio', 'effect_add', 'effect_update', 'effect_remove', 'keyframe_set', 'mask_create', 'mask_track', 'composition_create']);
    for (const op of a.operations) {
      if (!allowed.has(op.name)) throw new AppError('TRANSACTION_OPERATION_DENIED', `Tool ${op.name} is not permitted in a project transaction.`);
      if (op.arguments?.projectPath && path.resolve(op.arguments.projectPath).toLowerCase() !== path.resolve(a.projectPath).toLowerCase()) throw new AppError('TRANSACTION_PROJECT_MISMATCH', 'All operations in a transaction must target the same project.');
    }
    const file = await this.assertPath(a.projectPath, 'read'); const before = await loadProject(file); const historyPath = projectHistoryPath(file, before.id);
    const backup = await fs.mkdtemp(path.join(path.dirname(file), '.openmontage-transaction-'));
    const projectBackup = path.join(backup, 'before.omproj'); const historyBackup = path.join(backup, 'history');
    const transactionId = randomUUID(); let historyExists = false; let snapshotReady = false;
    const results: any[] = [];
    try {
      await fs.copyFile(file, projectBackup);
      historyExists = await fs.access(historyPath).then(() => true, () => false);
      if (historyExists) await fs.cp(historyPath, historyBackup, { recursive: true });
      await fs.writeFile(path.join(backup, 'transaction.json'), `${JSON.stringify({ transactionId, projectPath: path.resolve(file), projectId: before.id, historyExists, processId: process.pid, host: hostname() })}\n`, 'utf8');
      snapshotReady = true;
      for (const operation of a.operations) results.push(await this.execute(operation.name, { ...operation.arguments, projectPath: file }));
      await verifyAfterEdits?.();
      const result = { transactionId, committed: true, operationCount: results.length, results, project: await loadProject(file), history: await getProjectHistory(file) };
      await fs.writeFile(path.join(backup, 'COMMITTED'), 'committed\n', 'utf8');
      return result;
    } catch (cause) {
      if (!snapshotReady) throw cause;
      let rolledBack = 0;
      try {
        for (let attempt = 0; attempt < a.operations.length + 1; attempt++) {
          const current = await loadProject(file);
          if (JSON.stringify(current) === JSON.stringify(before)) break;
          await undoProject(file); rolledBack++;
        }
      } catch { /* fall through to the exact file backup below */ }
      const afterRollback = await loadProject(file).catch(() => undefined);
      if (!afterRollback || JSON.stringify(afterRollback) !== JSON.stringify(before)) await fs.copyFile(projectBackup, file);
      await fs.rm(historyPath, { recursive: true, force: true });
      if (historyExists) await fs.cp(historyBackup, historyPath, { recursive: true });
      const error = asAppError(cause);
      throw new AppError('TRANSACTION_ROLLED_BACK', `Transaction failed after ${results.length} operation(s); project state was restored. Cause ${error.code}: ${error.message}`, { cause });
    } finally { await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined); }
  }

  private async analyzeQuality(projectFile: string, project: Project, args: any): Promise<QualityReport> {
    const directory = path.join(projectCachePath(projectFile, project.id), 'quality-reports');
    const selectedBeatTargets = Array.isArray(args.selectedBeatTargets) ? args.selectedBeatTargets.map((value: string) => parseDecimal(value)) : undefined;
    for (const target of selectedBeatTargets ?? []) if (BigInt(target.num) < 0n || compare(target, timelineDuration(project)) > 0) throw new AppError('INVALID_TIME', 'Selected beat targets must be within the project timeline.');
    await this.assertPath(directory, 'write');
    const frameDirectory = path.join(directory, 'frames', randomUUID());
    await this.assertPath(path.dirname(frameDirectory), 'write');
    await this.assertPath(frameDirectory, 'write');
    await this.assertProjectMedia(project, true);
    const report = await analyzeProjectQuality(project, {
      outputDirectory: frameDirectory,
      ...(selectedBeatTargets ? { selectedBeatTargets } : {}),
      ...(args.beatToleranceMs !== undefined ? { beatToleranceMs: args.beatToleranceMs } : {}),
      ...(args.maxAutomaticGapSeconds !== undefined ? { maxAutomaticGapSeconds: args.maxAutomaticGapSeconds } : {}),
      ...(args.renderAudio !== undefined ? { renderAudio: args.renderAudio } : {})
    });
    await persistQualityReport(directory, report);
    return report;
  }

  private async getQualityReport(projectFile: string, project: Project, reportId: string): Promise<QualityReport> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reportId)) throw new AppError('INVALID_ARGUMENTS', 'reportId must be a UUID returned by quality_analyze or quality_improve.');
    const directory = path.join(projectCachePath(projectFile, project.id), 'quality-reports');
    const file = path.join(directory, `${reportId}.json`);
    await this.assertPath(file, 'read');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new AppError('QUALITY_REPORT_UNSAFE', 'Quality report must be a regular file.');
    const report = JSON.parse(await fs.readFile(file, 'utf8')) as QualityReport;
    if (report.schemaVersion !== 1 || report.projectId !== project.id || report.reportId !== reportId) throw new AppError('QUALITY_REPORT_INVALID', 'The saved quality report does not match this project.');
    return report;
  }

  private async listQualityReports(projectFile: string, project: Project, limit: number): Promise<{ reports: QualityReport[] }> {
    const directory = path.join(projectCachePath(projectFile, project.id), 'quality-reports');
    await this.assertPath(directory, 'write');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    const reports: QualityReport[] = [];
    for (const entry of entries.filter((item) => item.isFile() && !item.isSymbolicLink() && /^[0-9a-f-]{36}\.json$/i.test(item.name))) {
      const file = path.join(directory, entry.name);
      await this.assertPath(file, 'read');
      try {
        const report = JSON.parse(await fs.readFile(file, 'utf8')) as QualityReport;
        if (report.schemaVersion === 1 && report.projectId === project.id) reports.push(report);
      } catch { /* malformed historic entries are ignored; get-by-id reports a useful error */ }
    }
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { reports: reports.slice(0, limit) };
  }

  private async improveQuality(projectFile: string, initialProject: Project, args: any): Promise<any> {
    const maxIterations = args.maxIterations ?? 3;
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 3) throw new AppError('INVALID_ARGUMENTS', 'maxIterations must be from 1 through 3.');
    const iterations: Array<{ iteration: number; reportId: string; correctionCount: number; transactionId?: string; rolledBack?: boolean; errorCode?: string }> = [];
    let project = initialProject;
    let previousReportId: string | undefined;
    let finalReport = await this.analyzeQuality(projectFile, project, { ...args, renderAudio: true });
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      const report = finalReport;
      const corrections = report.findings.filter((item) => item.correction?.automaticallySafe && item.correction.tool === 'timeline_move_clip').slice(0, 32);
      if (!corrections.length) {
        iterations.push({ iteration, reportId: report.reportId, correctionCount: 0 });
        break;
      }
      let verifiedReport: QualityReport | undefined;
      let transaction: any;
      try {
        transaction = await this.transaction({ projectPath: projectFile, operations: corrections.map((item) => ({ name: item.correction!.tool, arguments: item.correction!.arguments })) }, async () => {
          const edited = await loadProject(projectFile);
          verifiedReport = await this.analyzeQuality(projectFile, edited, { ...args, renderAudio: true });
          const remaining = verifiedReport.findings.filter((item) => item.correction?.automaticallySafe).length;
          if (verifiedReport.summary.status === 'incomplete' || remaining >= corrections.length) throw new AppError('QUALITY_CORRECTION_NOT_VERIFIED', 'The safe correction did not reduce the reported issues or the verification pass was incomplete.');
        });
      } catch (cause) {
        const error = asAppError(cause);
        iterations.push({ iteration, reportId: report.reportId, correctionCount: corrections.length, rolledBack: true, errorCode: error.code });
        if (verifiedReport) {
          await fs.rm(path.join(projectCachePath(projectFile, project.id), 'quality-reports', `${verifiedReport.reportId}.json`), { force: true }).catch(() => undefined);
          if (verifiedReport.previewFrames[0]) await fs.rm(path.dirname(verifiedReport.previewFrames[0].path), { recursive: true, force: true }).catch(() => undefined);
        }
        project = await loadProject(projectFile);
        finalReport = await this.analyzeQuality(projectFile, project, { ...args, renderAudio: true });
        finalReport.findings.push({ id: randomUUID(), code: 'automatic_correction_rolled_back', category: 'structure', severity: 'warning', evidence: 'objective', title: 'Automatic correction was rolled back', description: `The improvement transaction was restored because its verification failed (${error.code}).` });
        finalReport.summary.findings++;
        finalReport.summary.warnings++;
        finalReport.summary.status = 'issues';
        await persistQualityReport(path.join(projectCachePath(projectFile, project.id), 'quality-reports'), finalReport);
        break;
      }
      iterations.push({ iteration, reportId: report.reportId, correctionCount: corrections.length, transactionId: transaction.transactionId, rolledBack: false });
      previousReportId = report.reportId;
      project = await loadProject(projectFile);
      finalReport = verifiedReport!;
      if (!finalReport.findings.some((item) => item.correction?.automaticallySafe)) break;
    }
    if (iterations.some((item) => item.transactionId || item.rolledBack)) {
      finalReport.improvement = { iteration: iterations.length, maxIterations, ...(previousReportId ? { previousReportId } : {}), appliedTransactions: iterations.flatMap((item) => item.transactionId ? [item.transactionId] : []), ...(iterations.some((item) => item.rolledBack) ? { rolledBackIterations: iterations.filter((item) => item.rolledBack).length } : {}) };
      await persistQualityReport(path.join(projectCachePath(projectFile, project.id), 'quality-reports'), finalReport);
    }
    return { maxIterations, iterations, finalReport, history: await getProjectHistory(projectFile) };
  }

  private async recoverInterruptedTransactions(projectFile: string): Promise<void> {
    const parent = path.dirname(projectFile);
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.name.startsWith('.openmontage-transaction-')) continue;
      const directory = path.join(parent, entry.name);
      const directoryInfo = await fs.lstat(directory).catch(() => undefined);
      if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) continue;
      const manifestPath = path.join(directory, 'transaction.json');
      let manifest: { transactionId?: string; projectPath?: string; projectId?: string; historyExists?: boolean; processId?: number; host?: string };
      try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new AppError('AGENT_RECOVERY_FAILED', `An interrupted project transaction has an unreadable recovery record at ${manifestPath}.`, { cause: error });
      }
      if (typeof manifest.projectPath !== 'string' || !samePath(manifest.projectPath, projectFile)) continue;
      if (typeof manifest.projectId !== 'string' || !manifest.projectId || typeof manifest.transactionId !== 'string' || typeof manifest.historyExists !== 'boolean') {
        throw new AppError('AGENT_RECOVERY_FAILED', `The recovery record at ${manifestPath} is incomplete.`);
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(manifest.projectId)) throw new AppError('AGENT_RECOVERY_FAILED', `The recovery record at ${manifestPath} contains an invalid project ID.`);
      if (manifest.host === hostname() && Number.isInteger(manifest.processId) && manifest.processId! > 0 && isProcessRunning(manifest.processId!)) continue;
      const markerPath = path.join(directory, 'COMMITTED');
      const markerInfo = await fs.lstat(markerPath).catch(() => undefined);
      const committed = markerInfo?.isFile() && !markerInfo.isSymbolicLink() && await fs.readFile(markerPath, 'utf8').then((value) => value === 'committed\n', () => false);
      if (committed) { await fs.rm(directory, { recursive: true, force: true }); continue; }
      const projectBackup = path.join(directory, 'before.omproj');
      const backupInfo = await fs.lstat(projectBackup).catch(() => undefined);
      if (!backupInfo?.isFile() || backupInfo.isSymbolicLink()) throw new AppError('AGENT_RECOVERY_FAILED', `The recovery snapshot for transaction ${manifest.transactionId ?? '(unknown)'} is missing or unsafe.`);
      const snapshot = await loadProject(projectBackup);
      if (snapshot.id !== manifest.projectId) throw new AppError('AGENT_RECOVERY_FAILED', `The recovery snapshot for transaction ${manifest.transactionId} does not match its project ID.`);
      const historyBackup = path.join(directory, 'history');
      if (manifest.historyExists) {
        const historyInfo = await fs.lstat(historyBackup).catch(() => undefined);
        if (!historyInfo?.isDirectory() || historyInfo.isSymbolicLink()) throw new AppError('AGENT_RECOVERY_FAILED', `The recovery history snapshot for transaction ${manifest.transactionId ?? '(unknown)'} is missing or unsafe.`);
      }
      const historyPath = projectHistoryPath(projectFile, manifest.projectId ?? '');
      await this.assertPath(historyPath, 'write');
      await replaceFromSnapshot(projectBackup, projectFile);
      await fs.rm(historyPath, { recursive: true, force: true });
      if (manifest.historyExists) await fs.cp(historyBackup, historyPath, { recursive: true });
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  private async assertPath(value: string, access: 'read' | 'write'): Promise<string> {
    if (typeof value !== 'string' || !value.trim()) throw new AppError('INVALID_ARGUMENTS', 'Path must be a non-empty string.');
    const requested = path.resolve(value);
    let canonical: string;
    if (access === 'read') {
      try { canonical = await fs.realpath(requested); }
      catch (error) {
        const targetInfo = await fs.lstat(requested).catch(() => undefined);
        if (targetInfo?.isSymbolicLink()) throw new AppError('PATH_SYMLINK_DENIED', `Unreadable symbolic link is not allowed: ${requested}`, { cause: error });
        canonical = await this.resolveProspectivePath(requested);
        if (!this.allowedRoots.some((root) => isWithin(root, canonical))) throw new AppError('PATH_PERMISSION_DENIED', `Path is outside granted roots: ${requested}`);
        throw new AppError('PATH_NOT_FOUND', `Granted path does not exist: ${requested}`, { cause: error });
      }
    } else {
      const existing = await fs.lstat(requested).catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (existing?.isSymbolicLink()) {
        try { canonical = await fs.realpath(requested); }
        catch (error) { throw new AppError('PATH_SYMLINK_DENIED', `Output path is a dangling symbolic link: ${requested}`, { cause: error }); }
        if (!this.allowedRoots.some((root) => isWithin(root, canonical))) throw new AppError('PATH_PERMISSION_DENIED', `Symbolic link target is outside granted roots: ${requested}`);
      } else if (existing) canonical = await fs.realpath(requested);
      else canonical = await this.resolveProspectivePath(requested);
    }
    const allowed = this.allowedRoots.some((root) => isWithin(root, canonical));
    if (!allowed) throw new AppError('PATH_PERMISSION_DENIED', `Path is outside granted roots: ${requested}`);
    return requested;
  }

  private async resolveProspectivePath(requested: string): Promise<string> {
    let parent = path.dirname(requested); const tail: string[] = [path.basename(requested)];
    while (true) {
      const info = await fs.lstat(parent).catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined; throw error; });
      if (info?.isSymbolicLink()) {
        try { return path.join(await fs.realpath(parent), ...tail.reverse()); }
        catch (error) { throw new AppError('PATH_SYMLINK_DENIED', `Path traverses a dangling symbolic link: ${parent}`, { cause: error }); }
      }
      try { return path.join(await fs.realpath(parent), ...tail.reverse()); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
        tail.push(path.basename(parent)); const next = path.dirname(parent);
        if (next === parent) throw new AppError('PATH_PERMISSION_DENIED', 'Could not resolve path within the granted roots.');
        parent = next;
      }
    }
  }

  private async preflightImport(value: string, recursive: boolean): Promise<void> {
    const target = await this.assertPath(value, 'read'); const info = await fs.lstat(target);
    if (info.isSymbolicLink()) throw new AppError('PATH_SYMLINK_DENIED', `Media import through a symbolic link is not allowed: ${target}`);
    if (info.isFile()) return;
    if (!info.isDirectory() || !recursive) throw new AppError('INVALID_MEDIA_PATH', `Import path must be a file${recursive ? ' or folder' : ''}: ${target}`);
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isSymbolicLink()) throw new AppError('PATH_SYMLINK_DENIED', `Media folder contains a symbolic link: ${child}`);
      if (entry.isDirectory()) await this.preflightImport(child, true);
      else if (entry.isFile()) await this.assertPath(child, 'read');
    }
  }

  private async assertProjectMedia(project: Project, requireExists: boolean): Promise<void> {
    for (const asset of project.media) {
      const allowed = await this.assertPath(asset.path, 'read').catch((error) => { if (!requireExists && asAppError(error).code === 'PATH_NOT_FOUND') return null; throw error; });
      if (allowed && requireExists && !(await fs.stat(allowed)).isFile()) throw new AppError('INVALID_MEDIA_PATH', `Media source is not a regular file: ${asset.path}`);
    }
  }

  private async assertEffectPaths(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'lutPath' || key === 'fontFile') && typeof child === 'string' && child) await this.assertPath(child, 'read');
      else if (child && typeof child === 'object') await this.assertEffectPaths(child);
    }
  }

  private async audioAnalysis(file: string, project: Project, mediaId: string): Promise<any> {
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
    if (!asset.hasAudio) throw new AppError('NO_AUDIO_STREAM', `Media asset has no audio stream: ${asset.name}`);
    await this.assertPath(asset.path, 'read');
    const analysis = await analyzeAudio(asset.path, path.join(projectCachePath(file, project.id), 'analysis', `${asset.id}.json`));
    return { mediaId, analysis, beatGrid: { bpm: analysis.estimatedBpm, hypotheses: analysis.bpmHypotheses, phaseSeconds: analysis.beatPhaseSeconds, beats: analysis.beats, points: analysis.beatGrid ?? [], downbeats: analysis.downbeats, meter: analysis.meter, tempoSegments: analysis.tempoSegments ?? [], accents: analysis.accents ?? [], drops: analysis.drops, onsets: analysis.onsets, onsetEvents: analysis.onsetEvents ?? [], structureEvents: analysis.structureEvents ?? [], confidenceModel: 'relative-heuristic-not-probability' } };
  }

  private async highlightAnalysis(file: string, project: Project, mediaId: string): Promise<HighlightAnalysis> {
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
    await this.assertPath(asset.path, 'read');
    const directory = path.join(projectCachePath(file, project.id), 'analysis'); let audio; let audioError: string | undefined;
    if (asset.hasAudio) try { audio = await analyzeAudio(asset.path, path.join(directory, `${asset.id}.json`)); } catch (error) { audioError = asAppError(error).message; }
    return analyzeHighlightCues({ mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind, durationSeconds: Number(asset.duration.num) / Number(asset.duration.den), game: asset.game, audioAnalysis: audio, audioAnalysisError: audioError }, path.join(directory, `cues-${asset.id}.json`));
  }

  private async sourceFrames(file: string, project: Project, mediaId: string, times: number[]): Promise<any> {
    if (!Array.isArray(times) || times.length < 1 || times.length > 12 || times.some((value) => !Number.isFinite(value) || value < 0)) throw new AppError('INVALID_ARGUMENTS', 'times must contain 1 to 12 nonnegative numbers.');
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset || asset.kind !== 'video') throw new AppError('MEDIA_NOT_FOUND', 'A video mediaId is required.');
    await this.assertPath(asset.path, 'read'); const directory = path.join(projectCachePath(file, project.id), 'agent-previews'); await fs.mkdir(directory, { recursive: true });
    const frames = [];
    for (const time of times) {
      if (time > Number(asset.duration.num) / Number(asset.duration.den)) throw new AppError('INVALID_TIME', `Frame time ${time} is beyond media duration.`);
      const output = path.join(directory, `${randomUUID()}.jpg`);
      await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(time), '-i', asset.path, '-frames:v', '1', '-q:v', '5', output]);
      frames.push({ mediaId, timeSeconds: time, mimeType: 'image/jpeg', data: (await fs.readFile(output)).toString('base64') }); await fs.rm(output, { force: true });
    }
    return { frames };
  }

  private async alignEvent(file: string, project: Project, clipId: string, sourceTime: Rational, targetTime: Rational): Promise<any> {
    const { clip } = findClip(project, clipId); const sourceOffset = sub(sourceTime, clip.sourceIn);
    if (BigInt(sourceOffset.num) < 0n) throw new AppError('INVALID_TIME', 'Event time occurs before this clip source range.');
    if (compare(sourceOffset, clipSourceOffsetAt(clip, clip.duration)) > 0) throw new AppError('SOURCE_RANGE_EXCEEDED', 'Event is outside the clip source range.');
    const maxFrame = toFrame(clip.duration, project.frameRate); let lo = 0, hi = maxFrame;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const offset = clipSourceOffsetAt(clip, frameTime(mid, project.frameRate)); if (compare(offset, sourceOffset) < 0) lo = mid + 1; else hi = mid; }
    const candidates = [Math.max(0, lo - 1), lo].map((frame) => frameTime(frame, project.frameRate));
    const absolute = (value: Rational): Rational => rational(BigInt(value.num) < 0n ? -BigInt(value.num) : BigInt(value.num), value.den);
    const distance = (localTime: Rational): Rational => absolute(sub(clipSourceOffsetAt(clip, localTime), sourceOffset));
    const local = candidates.reduce((best, current) => compare(distance(current), distance(best)) < 0 ? current : best);
    const start = sub(targetTime, local); if (BigInt(start.num) < 0n) throw new AppError('INVALID_TIME', 'Target time would place the clip before timeline zero.');
    const actualTime = add(start, local);
    const updated = await moveClip(file, clipId, start); return { clip: findClip(updated, clipId).clip, alignedSourceTime: sourceTime, targetTime, actualTimelineTime: { requestedTargetTime: targetTime, clipLocalTime: local, frame: toFrame(local, project.frameRate), actualTime, error: sub(actualTime, targetTime) } };
  }

  private async renderPreview(file: string, project: Project, timeValue: string, analyze: boolean): Promise<any> {
    await this.assertProjectMedia(project, true); const requested = parseDecimal(timeValue); const frame = toFrame(requested, project.frameRate); const time = frameTime(frame, project.frameRate);
    const directory = path.join(projectCachePath(file, project.id), 'agent-previews', 'timeline-frames'); await fs.mkdir(directory, { recursive: true });
    const key = timelinePreviewCacheKey(project, { start: time, duration: frameTime(1, project.frameRate) }, 'final');
    const output = path.join(directory, `${key}-${frame}.png`);
    if (await fileExists(output)) {
      const accessedAt = new Date();
      await fs.utimes(output, accessedAt, accessedAt).catch(() => undefined);
    } else await renderTimelineFrame(project, time, output, true);
    const data = (await fs.readFile(output)).toString('base64'); const metadata: any = { filePath: file, time, frame, width: project.width, height: project.height, mimeType: 'image/png', data };
    if (analyze) {
      const statsPath = path.join(directory, `${key}-${frame}.analysis.json`);
      let stats: Record<string, number> | undefined;
      if (await fileExists(statsPath)) {
        try {
          stats = JSON.parse(await fs.readFile(statsPath, 'utf8'));
          const accessedAt = new Date(); await fs.utimes(statsPath, accessedAt, accessedAt).catch(() => undefined);
        } catch { await fs.rm(statsPath, { force: true }); }
      }
      if (!stats) {
        const result = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'info', '-i', output, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
        const statsText = `${result.stdout}\n${result.stderr}`; stats = {};
        for (const statName of ['YAVG', 'YMIN', 'YMAX', 'UAVG', 'VAVG']) { const match = new RegExp(`lavfi\\.signalstats\\.${statName}=([0-9.]+)`).exec(statsText); if (match) stats[statName.toLowerCase()] = Number(match[1]); }
        await fs.writeFile(statsPath, JSON.stringify(stats), 'utf8');
      }
      metadata.statistics = stats;
    }
    await pruneAgentPreviewFrames(directory, output);
    return metadata;
  }

  private async startRender(file: string, project: Project, a: any): Promise<Job> {
    await this.assertProjectMedia(project, true); const outputPath = await this.assertPath(a.outputPath, 'write'); const id = randomUUID();
    const job: Job = { id, projectPath: file, status: 'running', progress: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputPath };
    await this.persistJob(project, job);
    this.jobs.set(id, job);
    void this.runRender(project, job, a);
    return job;
  }

  private async runRender(project: Project, job: Job, options: any): Promise<void> {
    let persistenceError: AppError | undefined;
    try {
      const result = await exportVideo(project, {
        outputPath: job.outputPath, overwrite: options.overwrite ?? false, encoder: options.encoder,
        onProgress: (progress) => {
          job.progress = progress; job.updatedAt = new Date().toISOString();
          void this.persistJob(project, job).catch((error) => { persistenceError = asAppError(error); });
        }
      });
      job.status = 'complete'; job.progress = 1; job.result = result; job.updatedAt = new Date().toISOString();
    } catch (cause) {
      const error = asAppError(cause); job.status = 'failed'; job.error = { code: error.code, message: error.message }; job.updatedAt = new Date().toISOString();
    }
    try {
      await this.persistJob(project, job);
    } catch (cause) {
      const error = asAppError(cause);
      const previous = job.error ? `${job.error.code}: ${job.error.message}. ` : '';
      const progressIssue = persistenceError ? ` An earlier progress update also failed: ${persistenceError.code}.` : '';
      job.status = 'failed'; job.error = { code: 'RENDER_STATUS_WRITE_FAILED', message: `${previous}The export status could not be saved: ${error.message}.${progressIssue}` }; job.updatedAt = new Date().toISOString();
    }
  }

  private async renderStatus(file: string, jobId: string, project: Project): Promise<Job> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) throw new AppError('INVALID_ARGUMENTS', 'jobId must be a UUID returned by video_export.');
    const cached = this.jobs.get(jobId); if (cached) { if (path.resolve(cached.projectPath).toLowerCase() !== path.resolve(file).toLowerCase()) throw new AppError('JOB_NOT_FOUND', 'Render job does not belong to this project.'); return cached; }
    const jobFile = path.join(projectCachePath(file, project.id), 'agent-jobs', `${jobId}.json`);
    try {
      await this.assertPath(jobFile, 'read');
      const job = JSON.parse(await fs.readFile(jobFile, 'utf8')) as Job;
      if (job.status === 'running' || job.status === 'queued') { job.status = 'failed'; job.error = { code: 'RENDER_INTERRUPTED', message: 'The service stopped while this render was active. Start a new export to recover.' }; job.updatedAt = new Date().toISOString(); await this.persistJob(project, job); }
      this.jobs.set(jobId, job); return job;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('JOB_NOT_FOUND', `Render job not found: ${jobId}`); throw error; }
  }

  private async persistJob(project: Project, job: Job): Promise<void> {
    const previous = this.jobWrites.get(job.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const file = path.join(projectCachePath(job.projectPath, project.id), 'agent-jobs', `${job.id}.json`); await this.assertPath(file, 'write'); await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`);
      try { await fs.rename(temporary, file); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error;
        try { await fs.copyFile(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
      }
    });
    this.jobWrites.set(job.id, current);
    try { await current; } finally { if (this.jobWrites.get(job.id) === current) this.jobWrites.delete(job.id); }
  }
}

function inspectProject(filePath: string, project: Project): any {
  return { filePath, schemaVersion: project.schemaVersion, project: { ...project }, duration: timelineDuration(project), mediaCount: project.media.length, trackCount: project.tracks.length, clipCount: project.tracks.reduce((count, track) => count + track.clips.length, 0) };
}
function findClip(project: Project, clipId: string): { clip: TimelineClip; track: Project['tracks'][number] } {
  for (const track of project.tracks) { const clip = track.clips.find((item) => item.id === clipId); if (clip) return { clip, track }; }
  throw new AppError('CLIP_NOT_FOUND', `Timeline clip not found: ${clipId}`);
}
function normalizeRationals(value: any): any { if (!value || typeof value !== 'object') return value; const copy = structuredClone(value); for (const key of ['fadeIn', 'fadeOut']) if (typeof copy[key] === 'string') copy[key] = parseDecimal(copy[key]); if (Array.isArray(copy.volumeKeyframes)) copy.volumeKeyframes = copy.volumeKeyframes.map((frame: any) => ({ ...frame, time: typeof frame.time === 'string' ? parseDecimal(frame.time) : frame.time })); return copy; }
function normalizeEffects(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_ARGUMENTS', 'effects must be an object.');
  const patch = structuredClone(value);
  for (const field of ['playbackRate', 'speedKeyframes', 'transform', 'color', 'keyframes', 'transitionIn', 'title', 'normalizeAudio', 'blendMode', 'chromaKey', 'mask']) if (patch[field] === null) patch[field] = undefined;
  if (patch.color && patch.color.lutPath === null) patch.color.lutPath = undefined;
  if (patch.title && patch.title.fontFile === null) patch.title.fontFile = undefined;
  if (typeof patch.playbackRate === 'string') patch.playbackRate = parseDecimal(patch.playbackRate);
  for (const field of ['playbackRate', 'transitionIn']) if (patch[field] && typeof patch[field] === 'object') { if (typeof patch[field].num === 'string') continue; if (typeof patch[field].duration === 'string') patch[field].duration = parseDecimal(patch[field].duration); }
  for (const field of ['speedKeyframes', 'keyframes']) if (Array.isArray(patch[field])) patch[field] = patch[field].map((item: any) => ({ ...item, time: typeof item.time === 'string' ? parseDecimal(item.time) : item.time, ...(typeof item.rate === 'string' ? { rate: parseDecimal(item.rate) } : {}) }));
  if (patch.mask?.keyframes) patch.mask.keyframes = patch.mask.keyframes.map((item: any) => ({ ...item, time: typeof item.time === 'string' ? parseDecimal(item.time) : item.time }));
  return patch;
}
function validateInput(schema: Schema, input: unknown): any {
  validateValue(schema, input, 'arguments');
  const value = input as Record<string, any>;
  return value;
}
function validateValue(rule: any, value: unknown, location: string): void {
  if (Array.isArray(rule.type)) {
    const selected = rule.type.find((type: string) => type === 'null' ? value === null : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'array' ? Array.isArray(value) : typeof value === type);
    if (!selected) throw new AppError('INVALID_ARGUMENTS', `${location} has an unsupported type.`);
    if (selected === 'null') return;
    rule = { ...rule, type: selected };
  }
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_ARGUMENTS', `${location} must be an object.`);
    const record = value as Record<string, unknown>; const properties = rule.properties ?? {};
    for (const required of rule.required ?? []) if (!(required in record)) throw new AppError('INVALID_ARGUMENTS', `Required field is missing: ${location}.${required}`);
    for (const key of Object.keys(record)) {
      if (!(key in properties) && rule.additionalProperties === false) throw new AppError('INVALID_ARGUMENTS', `Unknown field: ${location}.${key}`);
      if (key in properties) validateValue(properties[key], record[key], `${location}.${key}`);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) throw new AppError('INVALID_ARGUMENTS', `${location} must be an array.`);
    if (rule.minItems !== undefined && value.length < rule.minItems) throw new AppError('INVALID_ARGUMENTS', `${location} must contain at least ${rule.minItems} item(s).`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) throw new AppError('INVALID_ARGUMENTS', `${location} must contain no more than ${rule.maxItems} item(s).`);
    value.forEach((item, index) => validateValue(rule.items ?? {}, item, `${location}[${index}]`));
  } else if (rule.type === 'string') {
    if (typeof value !== 'string' || (rule.minLength !== undefined && value.length < rule.minLength) || (rule.maxLength !== undefined && value.length > rule.maxLength)) throw new AppError('INVALID_ARGUMENTS', `${location} must be a string within its supported length.`);
    if (rule.pattern && !(new RegExp(rule.pattern)).test(value)) throw new AppError('INVALID_ARGUMENTS', `${location} has an invalid format.`);
  } else if (rule.type === 'number' || rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value)) || (rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) throw new AppError('INVALID_ARGUMENTS', `${location} is outside its supported numeric range.`);
  } else if (rule.type === 'boolean' && typeof value !== 'boolean') throw new AppError('INVALID_ARGUMENTS', `${location} must be a boolean.`);
  if (rule.enum && value !== null && !rule.enum.includes(value)) throw new AppError('INVALID_ARGUMENTS', `${location} must be one of: ${rule.enum.join(', ')}.`);
}
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function pruneAgentPreviewFrames(directory: string, keepPath: string): Promise<void> {
  const removed = await prunePreviewCache(directory, keepPath, {
    maxFiles: 120, maxBytes: 128 * 1024 * 1024, maxAgeMs: 14 * 24 * 60 * 60 * 1000,
    matches: (name) => name.endsWith('.png')
  });
  await Promise.all(removed.map((file) => fs.rm(file.replace(/\.png$/, '.analysis.json'), { force: true }).catch(() => undefined)));
}

async function replaceFromSnapshot(snapshot: string, destination: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.recovery.tmp`;
  await fs.copyFile(snapshot, temporary);
  try { await fs.rename(temporary, destination); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw error;
    try { await fs.copyFile(temporary, destination); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}

