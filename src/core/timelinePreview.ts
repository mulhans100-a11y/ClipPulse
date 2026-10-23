import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors';
import { buildClipPreviewFilters, clipSourceOffsetAt } from './clipEffects';
import { appendCompositeLayer } from './compositing';
import { runCommand, tail } from './ffmpeg';
import { add, compare, decimal, frameTime, rational, sub, toFrame } from './time';
import { isTrackEnabled, timelineDuration, validateProject } from './project';
import type { Project, Rational } from './types';

export interface TimelinePreviewRange { start: Rational; duration: Rational; }

/** Align playback previews to small frame-exact chunks so edits only invalidate ranges they touch. */
export function timelinePreviewRangeAt(project: Project, requestedTime: Rational, chunkSeconds = 5): TimelinePreviewRange {
  const total = timelineDuration(project);
  if (compare(total, rational(0)) <= 0) throw new AppError('EMPTY_TIMELINE', 'Add at least one clip to the timeline before previewing.');
  if (compare(requestedTime, rational(0)) < 0 || !Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new AppError('INVALID_TIME', 'Preview time and chunk duration must be nonnegative and finite.');
  }
  const totalFrames = Math.max(1, toFrame(total, project.frameRate));
  const requestedFrame = Math.min(totalFrames - 1, toFrame(requestedTime, project.frameRate));
  const chunkFrames = Math.max(1, Math.round(chunkSeconds * Number(project.frameRate.num) / Number(project.frameRate.den)));
  const firstFrame = Math.floor(requestedFrame / chunkFrames) * chunkFrames;
  const start = frameTime(firstFrame, project.frameRate);
  const maxChunk = frameTime(Math.min(chunkFrames, totalFrames - firstFrame), project.frameRate);
  const remaining = sub(total, start);
  return { start, duration: compare(remaining, maxChunk) < 0 ? remaining : maxChunk };
}

/** Hash only inputs that can affect a range, leaving cached, unrelated timeline sections reusable. */
export function timelinePreviewCacheKey(project: Project, range: TimelinePreviewRange, quality: 'preview' | 'final' = 'preview'): string {
  const end = add(range.start, range.duration);
  const usedMediaIds = new Set<string>();
  const tracks = project.tracks.flatMap((track) => {
    if (!isTrackEnabled(project, track)) return [];
    const clips = track.clips.filter((clip) => compare(clip.start, end) < 0 && compare(add(clip.start, clip.duration), range.start) > 0);
    if (!clips.length) return [];
    for (const clip of clips) usedMediaIds.add(clip.mediaId);
    const hasAudioOutput = clips.some((clip) => {
      const asset = project.media.find((item) => item.id === clip.mediaId);
      return asset?.hasAudio && clip.audioEnabled && (track.kind === 'audio' || track.kind === 'video');
    });
    const renderSettings = {
      kind: track.kind,
      ...(hasAudioOutput ? {
        volume: track.volume, volumeKeyframes: track.volumeKeyframes,
        audioRole: track.audioRole, normalizeAudio: track.normalizeAudio, duckUnderDialogue: track.duckUnderDialogue
      } : {})
    };
    return [{ ...renderSettings, clips: clips.map(({ id: _id, ...clip }) => clip) }];
  });
  const media = project.media.filter((asset) => usedMediaIds.has(asset.id)).map((asset) => ({
    id: asset.id, path: asset.path, kind: asset.kind, hasAudio: asset.hasAudio,
    contentHash: asset.contentHash, sizeBytes: asset.sizeBytes, modifiedAt: asset.modifiedAt,
    width: asset.width, height: asset.height, frameRate: asset.frameRate
  }));
  const inputs = {
    version: 2, quality, projectId: project.id,
    profile: { width: project.width, height: project.height, frameRate: project.frameRate },
    range, tracks, media
  };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex').slice(0, 32);
}

/** Render one frame of the visible video-track composite at a timeline time. */
export async function renderTimelineFrame(project: Project, timelineTime: Rational, outputPath: string, overwrite = true): Promise<string> {
  validateProject(project);
  if (BigInt(timelineTime.den) <= 0n || BigInt(timelineTime.num) < 0n) throw new AppError('INVALID_TIME', 'Preview time must be nonnegative.');
  const output = path.resolve(outputPath);
  if (project.media.some((asset) => path.resolve(asset.path).toLocaleLowerCase() === output.toLocaleLowerCase())) {
    throw new AppError('SOURCE_OVERWRITE_BLOCKED', 'A preview image cannot overwrite an imported original media file.');
  }
  try {
    await fs.access(output);
    if (!overwrite) throw new AppError('OUTPUT_EXISTS', `Preview output already exists: ${output}`);
  } catch (error) { if (error instanceof AppError) throw error; }
  await fs.mkdir(path.dirname(output), { recursive: true });

  const active = project.tracks.flatMap((track) => {
    if (!isTrackEnabled(project, track) || track.kind !== 'video') return [];
    return track.clips.flatMap((clip) => {
      const end = add(clip.start, clip.duration);
      if (compare(timelineTime, clip.start) < 0 || compare(timelineTime, end) >= 0) return [];
      const media = project.media.find((asset) => asset.id === clip.mediaId);
      const localTime = sub(timelineTime, clip.start);
      return media?.kind === 'video' ? [{ clip, media, localTime, sourceTime: add(clip.sourceIn, clipSourceOffsetAt(clip, localTime)) }] : [];
    });
  });
  const args: string[] = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  for (const item of active) {
    try { await fs.access(item.media.path); }
    catch { throw new AppError('MISSING_MEDIA', `Media file is missing: ${item.media.path}`); }
    args.push('-ss', decimal(item.sourceTime, 9), '-i', item.media.path);
  }
  const fps = `${project.frameRate.num}/${project.frameRate.den}`;
  const filter: string[] = [`color=c=black:s=${project.width}x${project.height}:r=${fps}:d=1,format=rgba[vbase0]`];
  let base = 'vbase0';
  for (let i = 0; i < active.length; i++) {
    const item = active[i];
    const clip = `preview${i}`;
    const next = `vbase${i + 1}`;
    filter.push(`[${i}:v:0]setpts=PTS-STARTPTS+(${decimal(item.localTime, 9)})/TB,${buildClipPreviewFilters(item.clip, project, item.localTime).join(',')},fps=${fps},setpts=PTS-STARTPTS[${clip}]`);
    appendCompositeLayer(filter, base, clip, next, item.clip, project, fps, '1', i, true);
    base = next;
  }
  filter.push(`[${base}]trim=end_frame=1,format=rgb24[vout]`);
  const temp = `${output}.${process.pid}.${Date.now()}.tmp.png`;
  args.push('-filter_complex', filter.join(';'), '-map', '[vout]', '-frames:v', '1', '-c:v', 'png', temp);
  try {
    await runCommand('ffmpeg', args);
    const verify = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', temp]);
    const info = JSON.parse(verify.stdout);
    const video = info.streams?.[0];
    if (!video || video.width !== project.width || video.height !== project.height) throw new AppError('PREVIEW_VERIFY_FAILED', 'Timeline preview frame has unexpected dimensions.');
    await fs.rename(temp, output);
    return output;
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError('PREVIEW_RENDER_FAILED', `Could not render timeline preview: ${tail(error instanceof Error ? error.message : String(error))}`);
  }
}
