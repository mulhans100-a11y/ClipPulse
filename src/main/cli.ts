#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppError, asAppError } from '../core/errors';
import { analyzeAudio } from '../core/audioAnalysis';
import { analyzeHighlightCues } from '../core/highlightAnalysis';
import { evaluateHighlightDataset } from '../core/analysisEvaluation';
import { getOptionalAnalysisRuntimes } from '../core/analysisRuntimes';
import { generateAutomaticMontages } from '../core/autoMontage';
import { renderTimelineFrame } from '../core/timelinePreview';
import { exportVideo } from '../core/export';
import { ffmpegAvailable, runCommand } from '../core/ffmpeg';
import { addClip, addTrack, createProject, duplicateClip, getProjectHistory, importMedia, loadProject, moveClip, projectCachePath, redoProject, relinkMedia, removeClip, searchMedia, setClipAudio, setClipEffects, splitClip, timelineDuration, trimClip, undoProject, updateMediaMetadata, updateTrackSettings, validateProject } from '../core/project';
import { decimal, frameTime, parseDecimal, rational, toFrame } from '../core/time';
import type { AutoMontageCustomRules, AutoMontageFormat, AutoMontageStyle } from '../core/types';

interface ParsedArgs { command: string; flags: Map<string, string[]>; positional: string[]; }
function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] ?? 'help';
  const flags = new Map<string, string[]>(), positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const current = args[i];
    if (current.startsWith('--')) {
      const key = current.slice(2);
      if (key === 'no-recursive' || key === 'overwrite' || key === 'help') flags.set(key, ['true']);
      else {
        const value = args[++i];
        if (value === undefined || value.startsWith('--')) throw new AppError('INVALID_ARGUMENTS', `Missing value for --${key}`);
        flags.set(key, [...(flags.get(key) ?? []), value]);
      }
    } else positional.push(current);
  }
  return { command, flags, positional };
}
function one(args: ParsedArgs, key: string, required = false): string | undefined {
  const value = args.flags.get(key)?.at(-1);
  if (required && !value) throw new AppError('INVALID_ARGUMENTS', `Required option --${key} is missing.`);
  return value;
}
function secondsFlag(args: ParsedArgs, key: string, fallback?: string) {
  const value = one(args, key) ?? fallback;
  return value === undefined ? undefined : parseDecimal(value);
}
function json(data: unknown): void { process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`); }
function help(): void {
  process.stdout.write(`OpenMontage AI CLI (Phase A/B/C/D/E)\n\nCommands:\n  create --project FILE [--name NAME] [--fps 60/1] [--width 1920 --height 1080]\n  import --project FILE PATH... [--no-recursive]\n  media-search --project FILE [--query TEXT] [--favorites]\n  media-update --project FILE --media ID [--favorite true|false] [--rating 0-5] [--tag TAG] [--game NAME]\n  media-relink --project FILE --media ID --path FILE\n  analyze-audio --project FILE --media ID\n  analyze-highlights --project FILE --media ID\n  generate-montage --project FILE --music ID --duration SEC [--style clean|aggressive|cinematic|velocity|custom] [--custom-rules JSON] [--video ID ...] [--variants 1-5] [--intensity 0-100] [--format project|landscape-1080p|portrait-1080p|square-1080p] [--output-dir DIR]\n  evaluate-highlights --dataset FILE [--max-gap SEC] [--output REPORT.json]\n  analysis-runtimes\n  history --project FILE\n  undo --project FILE\n  redo --project FILE\n  inspect --project FILE\n  validate --project FILE\n  track-add --project FILE --kind video|audio [--name NAME]\n  track-set --project FILE --track ID [--mute true|false] [--solo true|false] [--lock true|false] [--volume 0-8] [--role standard|dialogue|music] [--normalize true|false] [--duck-under-dialogue true|false] [--volume-keyframes FILE.json]\n  clip-add --project FILE --media ID --track ID [--start SEC] [--source-in SEC] [--duration SEC]\n  clip-duplicate --project FILE --clip ID [--start SEC]\n  clip-audio --project FILE --clip ID [--enabled true|false] [--volume 0-8] [--fade-in SEC] [--fade-out SEC]\n  clip-effects --project FILE --clip ID --effects FILE.json\n  clip-trim --project FILE --clip ID [--start SEC] [--source-in SEC] [--duration SEC]\n  clip-move --project FILE --clip ID --start SEC [--track ID]\n  clip-split --project FILE --clip ID --at SEC\n  clip-remove --project FILE --clip ID\n  frame --project FILE --media ID --time SEC [--output IMAGE]\n  timeline-frame --project FILE --time SEC [--output IMAGE] [--overwrite]\n  export --project FILE --output FILE [--overwrite] [--encoder libx264|h264_amf|h264_nvenc|h264_qsv]\n  doctor\n\nGenerated montage variants are separate editable .omproj files; the source project is not modified. Preview by opening a variant, then use export as usual. All successful commands return JSON on stdout. Errors return {ok:false,error:{code,message}} and exit 1.\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.flags.has('help')) { help(); return; }
  if (args.command === 'doctor') { json({ platform: process.platform, node: process.version, ffmpeg: await ffmpegAvailable() }); return; }
  if (args.command === 'analysis-runtimes') { json(await getOptionalAnalysisRuntimes().then((items) => items.map(({ executablePath: _path, ...item }) => item))); return; }
  if (args.command === 'evaluate-highlights') {
    const maxGap = one(args, 'max-gap') === undefined ? 2 : Number(one(args, 'max-gap'));
    const report = await evaluateHighlightDataset(one(args, 'dataset', true)!, maxGap);
    const output = one(args, 'output');
    if (output) { const outputPath = path.resolve(output); await fs.mkdir(path.dirname(outputPath), { recursive: true }); await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
    json({ report, outputPath: output ? path.resolve(output) : undefined }); return;
  }
  if (args.command === 'create') {
    const fps = one(args, 'fps', false);
    const project = await createProject(one(args, 'project', true)!, {
      name: one(args, 'name'),
      frameRate: fps ? parseDecimal(fps) : rational(60),
      width: Number(one(args, 'width') ?? 1920), height: Number(one(args, 'height') ?? 1080)
    });
    json(project); return;
  }
  const file = one(args, 'project', true)!;
  if (args.command === 'generate-montage') {
    const style = (one(args, 'style') ?? 'clean') as AutoMontageStyle;
    const customRulesPath = one(args, 'custom-rules');
    let customRules: AutoMontageCustomRules | undefined;
    if (customRulesPath) {
      try { customRules = JSON.parse(await fs.readFile(path.resolve(customRulesPath), 'utf8')) as AutoMontageCustomRules; }
      catch (error) { throw new AppError('INVALID_CUSTOM_RULES', `Could not read custom montage rules: ${error instanceof Error ? error.message : error}`); }
    }
    const selectedVideoIds = args.flags.get('video')?.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
    const outputDirectory = one(args, 'output-dir') ?? path.join(path.dirname(path.resolve(file)), 'auto-montages');
    const generated = await generateAutomaticMontages(file, outputDirectory, {
      musicMediaId: one(args, 'music', true)!,
      ...(selectedVideoIds?.length ? { videoMediaIds: selectedVideoIds } : {}),
      style,
      durationSeconds: Number(one(args, 'duration', true)),
      variants: Number(one(args, 'variants') ?? 3),
      intensity: Number(one(args, 'intensity') ?? 50) / 100,
      format: (one(args, 'format') ?? 'project') as AutoMontageFormat,
      ...(customRules ? { customRules } : {})
    });
    json({ outputDirectory: generated.outputDirectory, variants: generated.variants.map(({ projectPath, planPath, plan }) => ({ projectPath, planPath, variant: plan.variant, style: plan.style, score: plan.score, scoreBreakdown: plan.scoreBreakdown, durationSeconds: plan.durationSeconds, segments: plan.segments.length, warnings: plan.warnings })) });
    return;
  }
  if (args.command === 'history') { json(await getProjectHistory(file)); return; }
  if (args.command === 'undo') { json(await undoProject(file)); return; }
  if (args.command === 'redo') { json(await redoProject(file)); return; }
  if (args.command === 'import') {
    if (!args.positional.length) throw new AppError('INVALID_ARGUMENTS', 'Provide one or more files or folders to import.');
    json(await importMedia(file, args.positional, !args.flags.has('no-recursive'))); return;
  }
  if (args.command === 'media-search') {
    json(await searchMedia(file, one(args, 'query') ?? '', args.flags.has('favorites'))); return;
  }
  if (args.command === 'media-relink') {
    const mediaId = one(args, 'media', true)!;
    const project = await relinkMedia(file, mediaId, one(args, 'path', true)!);
    json(project.media.find((asset) => asset.id === mediaId)); return;
  }
  if (args.command === 'media-update') {
    const patch: { favorite?: boolean; rating?: number; tags?: string[]; game?: string | null } = {};
    const favorite = one(args, 'favorite');
    if (favorite !== undefined) {
      if (favorite !== 'true' && favorite !== 'false') throw new AppError('INVALID_ARGUMENTS', '--favorite must be true or false.');
      patch.favorite = favorite === 'true';
    }
    const rating = one(args, 'rating');
    if (rating !== undefined) patch.rating = Number(rating);
    const tags = args.flags.get('tag');
    if (tags) patch.tags = tags.flatMap((value) => value.split(',')).map((tag) => tag.trim()).filter(Boolean);
    const game = one(args, 'game');
    if (game !== undefined) patch.game = game.toLowerCase() === 'none' ? null : game;
    if (!Object.keys(patch).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one metadata field to update.');
    const mediaId = one(args, 'media', true)!;
    const project = await updateMediaMetadata(file, mediaId, patch);
    json(project.media.find((asset) => asset.id === mediaId)); return;
  }
  if (args.command === 'analyze-audio') {
    const project = await loadProject(file);
    const mediaId = one(args, 'media', true)!;
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
    if (!asset.hasAudio) throw new AppError('NO_AUDIO_STREAM', `Media asset has no audio stream: ${asset.name}`);
    const cachePath = path.join(projectCachePath(file, project.id), 'analysis', `${asset.id}.json`);
    json({ mediaId, ...await analyzeAudio(asset.path, cachePath) }); return;
  }
  if (args.command === 'analyze-highlights') {
    const project = await loadProject(file);
    const mediaId = one(args, 'media', true)!;
    const asset = project.media.find((item) => item.id === mediaId);
    if (!asset) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found: ${mediaId}`);
    const analysisDirectory = path.join(projectCachePath(file, project.id), 'analysis');
    let audioAnalysis;
    let audioAnalysisError: string | undefined;
    if (asset.hasAudio) {
      try { audioAnalysis = await analyzeAudio(asset.path, path.join(analysisDirectory, `${asset.id}.json`)); }
      catch (error) { audioAnalysisError = error instanceof Error ? error.message : String(error); }
    }
    const result = await analyzeHighlightCues({
      mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind,
      durationSeconds: Number(asset.duration.num) / Number(asset.duration.den), game: asset.game, audioAnalysis, audioAnalysisError
    }, path.join(analysisDirectory, `cues-${asset.id}.json`));
    json(result); return;
  }
  if (args.command === 'inspect') {
    const project = await loadProject(file);
    json({ project, duration: timelineDuration(project), mediaCount: project.media.length, trackCount: project.tracks.length, clipCount: project.tracks.reduce((n, t) => n + t.clips.length, 0) }); return;
  }
  if (args.command === 'validate') {
    const project = await loadProject(file);
    validateProject(project);
    const missingFiles = project.media.filter((asset) => !require('node:fs').existsSync(asset.path)).map((asset) => ({ id: asset.id, path: asset.path }));
    json({ valid: missingFiles.length === 0, structuralValid: true, missingFiles }); return;
  }
  if (args.command === 'track-add') {
    const kind = one(args, 'kind', true)!;
    if (kind !== 'video' && kind !== 'audio') throw new AppError('INVALID_ARGUMENTS', '--kind must be video or audio.');
    const project = await addTrack(file, kind, one(args, 'name'));
    json(project.tracks.at(-1)); return;
  }
  if (args.command === 'track-set') {
    const patch: Parameters<typeof updateTrackSettings>[2] = {};
    for (const [flag, property] of [['mute', 'muted'], ['solo', 'solo'], ['lock', 'locked']] as const) {
      const value = one(args, flag);
      if (value === undefined) continue;
      if (value !== 'true' && value !== 'false') throw new AppError('INVALID_ARGUMENTS', `--${flag} must be true or false.`);
      patch[property] = value === 'true';
    }
    const volume = one(args, 'volume'); if (volume !== undefined) patch.volume = Number(volume);
    const role = one(args, 'role');
    if (role !== undefined) {
      if (!['standard', 'dialogue', 'music'].includes(role)) throw new AppError('INVALID_ARGUMENTS', '--role must be standard, dialogue, or music.');
      patch.audioRole = role as NonNullable<typeof patch.audioRole>;
    }
    for (const [flag, property] of [['normalize', 'normalizeAudio'], ['duck-under-dialogue', 'duckUnderDialogue']] as const) {
      const value = one(args, flag);
      if (value !== undefined) {
        if (value !== 'true' && value !== 'false') throw new AppError('INVALID_ARGUMENTS', `--${flag} must be true or false.`);
        patch[property] = value === 'true';
      }
    }
    const volumeKeyframes = one(args, 'volume-keyframes');
    if (volumeKeyframes) {
      try { patch.volumeKeyframes = JSON.parse(await fs.readFile(path.resolve(volumeKeyframes), 'utf8')); }
      catch (error) { throw new AppError('INVALID_ARGUMENTS', `Could not read volume keyframes: ${error instanceof Error ? error.message : error}`); }
    }
    if (!Object.keys(patch).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one track setting.');
    const trackId = one(args, 'track', true)!;
    const project = await updateTrackSettings(file, trackId, patch);
    json(project.tracks.find((track) => track.id === trackId)); return;
  }
  if (args.command === 'clip-add') {
    const before = await loadProject(file);
    const previousIds = new Set(before.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    const project = await addClip(file, one(args, 'media', true)!, one(args, 'track', true)!, secondsFlag(args, 'start', '0')!, secondsFlag(args, 'source-in', '0')!, secondsFlag(args, 'duration'));
    json(project.tracks.flatMap((track) => track.clips).find((clip) => !previousIds.has(clip.id))); return;
  }
  if (args.command === 'clip-duplicate') {
    const before = await loadProject(file);
    const previousIds = new Set(before.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    const project = await duplicateClip(file, one(args, 'clip', true)!, secondsFlag(args, 'start'));
    json(project.tracks.flatMap((track) => track.clips).find((clip) => !previousIds.has(clip.id))); return;
  }
  if (args.command === 'clip-audio') {
    const patch: { audioEnabled?: boolean; volume?: number; fadeIn?: ReturnType<typeof parseDecimal>; fadeOut?: ReturnType<typeof parseDecimal> } = {};
    const enabled = one(args, 'enabled');
    if (enabled !== undefined) {
      if (enabled !== 'true' && enabled !== 'false') throw new AppError('INVALID_ARGUMENTS', '--enabled must be true or false.');
      patch.audioEnabled = enabled === 'true';
    }
    const volume = one(args, 'volume');
    if (volume !== undefined) patch.volume = Number(volume);
    const fadeIn = secondsFlag(args, 'fade-in');
    if (fadeIn !== undefined) patch.fadeIn = fadeIn;
    const fadeOut = secondsFlag(args, 'fade-out');
    if (fadeOut !== undefined) patch.fadeOut = fadeOut;
    if (!Object.keys(patch).length) throw new AppError('INVALID_ARGUMENTS', 'Provide --enabled, --volume, --fade-in or --fade-out.');
    const project = await setClipAudio(file, one(args, 'clip', true)!, patch);
    const clipId = one(args, 'clip');
    json(project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)); return;
  }
  if (args.command === 'clip-effects') {
    const effectsPath = path.resolve(one(args, 'effects', true)!);
    let patch;
    try { patch = JSON.parse(await fs.readFile(effectsPath, 'utf8')); }
    catch (error) { throw new AppError('INVALID_ARGUMENTS', `Could not read clip effects JSON: ${error instanceof Error ? error.message : error}`); }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('INVALID_ARGUMENTS', 'Clip effects JSON must contain an object.');
    for (const field of ['playbackRate', 'speedKeyframes', 'transform', 'color', 'keyframes', 'transitionIn', 'title']) if (patch[field] === null) patch[field] = undefined;
    const clipId = one(args, 'clip', true)!;
    const project = await setClipEffects(file, clipId, patch);
    json(project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId)); return;
  }
  if (args.command === 'clip-trim') {
    const patch: Record<string, any> = {};
    for (const key of ['start', 'source-in', 'duration']) {
      const value = secondsFlag(args, key);
      if (value) patch[key === 'source-in' ? 'sourceIn' : key] = value;
    }
    if (!Object.keys(patch).length) throw new AppError('INVALID_ARGUMENTS', 'Provide at least one of --start, --source-in or --duration.');
    const project = await trimClip(file, one(args, 'clip', true)!, patch);
    json(project); return;
  }
  if (args.command === 'clip-move') {
    const project = await moveClip(file, one(args, 'clip', true)!, secondsFlag(args, 'start', '0')!, one(args, 'track'));
    json(project); return;
  }
  if (args.command === 'clip-split') {
    const before = await loadProject(file);
    const clipId = one(args, 'clip', true)!;
    const source = before.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId);
    if (!source) throw new AppError('CLIP_NOT_FOUND', `Timeline clip not found: ${clipId}`);
    const previousIds = new Set(before.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    await splitClip(file, clipId, parseDecimal(one(args, 'at', true)!));
    const updated = await loadProject(file);
    const resultTrack = updated.tracks.find((track) => track.clips.some((clip) => clip.id === clipId))!;
    json(resultTrack.clips.filter((clip) => clip.id === clipId || !previousIds.has(clip.id))); return;
  }
  if (args.command === 'clip-remove') { await removeClip(file, one(args, 'clip', true)!); json({ removed: one(args, 'clip') }); return; }
  if (args.command === 'frame') {
    const project = await loadProject(file);
    const asset = project.media.find((item) => item.id === one(args, 'media', true));
    if (!asset || asset.kind !== 'video') throw new AppError('MEDIA_NOT_FOUND', 'A video media ID is required.');
    const time = secondsFlag(args, 'time', '0')!;
    const output = path.resolve(one(args, 'output') ?? path.join(path.dirname(file), `.openmontage-cache-${project.id}`, 'frames', `${asset.id}-${decimal(time, 3).replace(/\./g, '_')}.jpg`));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', decimal(time), '-i', asset.path, '-frames:v', '1', '-q:v', '3', output]);
    json({ mediaId: asset.id, time, outputPath: output }); return;
  }
  if (args.command === 'timeline-frame') {
    const project = await loadProject(file);
    const requested = secondsFlag(args, 'time', undefined);
    if (!requested) throw new AppError('INVALID_ARGUMENTS', 'Provide --time in timeline seconds.');
    const frame = toFrame(requested, project.frameRate);
    const time = frameTime(frame, project.frameRate);
    const revision = createHash('sha256').update(JSON.stringify(project)).digest('hex').slice(0, 16);
    const output = path.resolve(one(args, 'output') ?? path.join(projectCachePath(file, project.id), 'timeline-preview', `${revision}-${frame}.png`));
    if (one(args, 'output') || !(await fs.access(output).then(() => true, () => false))) await renderTimelineFrame(project, time, output, args.flags.has('overwrite'));
    json({ time, frame, outputPath: output }); return;
  }
  if (args.command === 'export') {
    const project = await loadProject(file);
    const output = one(args, 'output', true)!;
    const result = await exportVideo(project, { outputPath: output, overwrite: args.flags.has('overwrite'), encoder: one(args, 'encoder') as any, onProgress: (progress) => process.stderr.write(`progress ${Math.round(progress * 100)}%\n`) });
    json(result); return;
  }
  throw new AppError('UNKNOWN_COMMAND', `Unknown command: ${args.command}`);
}

main().catch((error) => {
  const appError = asAppError(error);
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: appError.code, message: appError.message } })}\n`);
  process.exitCode = 1;
});
