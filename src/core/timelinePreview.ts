import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { buildClipPreviewFilters, clipSourceOffsetAt, clipVideoOverlayPosition } from './clipEffects';
import { runCommand, tail } from './ffmpeg';
import { add, compare, decimal, rational, sub } from './time';
import { isTrackEnabled, validateProject } from './project';
import type { Project, Rational } from './types';

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
    const position = clipVideoOverlayPosition(item.clip, project);
    filter.push(`[${i}:v:0]setpts=PTS-STARTPTS+(${decimal(item.localTime, 9)})/TB,${buildClipPreviewFilters(item.clip, project, item.localTime).join(',')},fps=${fps},setpts=PTS-STARTPTS[${clip}]`);
    filter.push(`[${base}][${clip}]overlay=x='${position.x}':y='${position.y}':shortest=1:eof_action=pass:repeatlast=0[${next}]`);
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
