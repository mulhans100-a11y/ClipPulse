import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import { runCommand, tail } from './ffmpeg';
import { add, compare, decimal, rational } from './time';
import { isTrackEnabled, timelineDuration, validateProject } from './project';
import type { ExportOptions, MediaAsset, Project, Rational, TimelineClip, TimelineTrack } from './types';

interface RenderClip { track: TimelineTrack; clip: TimelineClip; media: MediaAsset; input: number; }

export async function exportVideo(project: Project, options: ExportOptions): Promise<{ outputPath: string; duration: Rational; frameRate: Rational }> {
  validateProject(project);
  const output = path.resolve(options.outputPath);
  const duration = timelineDuration(project);
  if (compare(duration, rational(0)) <= 0) throw new AppError('EMPTY_TIMELINE', 'Add at least one clip to the timeline before exporting.');
  for (const asset of project.media) {
    if (path.resolve(asset.path).toLowerCase() === output.toLowerCase()) throw new AppError('SOURCE_OVERWRITE_BLOCKED', 'Export cannot overwrite an imported original media file.');
  }
  try { await fs.access(output); if (!options.overwrite) throw new AppError('OUTPUT_EXISTS', `Output already exists: ${output}`); }
  catch (error) { if (error instanceof AppError) throw error; }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temp = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.${Date.now()}.rendering.mp4`);

  const active = project.tracks.flatMap((track) => isTrackEnabled(project, track) ? track.clips.map((clip) => ({ track, clip, media: project.media.find((item) => item.id === clip.mediaId)! })) : []);
  const inputs: RenderClip[] = [];
  const args: string[] = ['-hide_banner', '-y'];
  for (const item of active) {
    try { await fs.access(item.media.path); }
    catch { throw new AppError('MISSING_MEDIA', `Media file is missing: ${item.media.path}`); }
    const inputIndex = inputs.length;
    args.push('-i', item.media.path);
    inputs.push({ ...item, input: inputIndex });
  }
  const filter: string[] = [];
  const fps = `${project.frameRate.num}/${project.frameRate.den}`;
  const totalSeconds = decimal(duration, 6);
  const videoClips = inputs.filter((item) => item.track.kind === 'video' && item.media.kind === 'video');
  filter.push(`color=c=black:s=${project.width}x${project.height}:r=${fps}:d=${totalSeconds},format=rgba[vbase0]`);
  let base = 'vbase0';
  for (let i = 0; i < videoClips.length; i++) {
    const item = videoClips[i];
    const source = decimal(item.clip.sourceIn, 9);
    const clipDuration = decimal(item.clip.duration, 9);
    const start = decimal(item.clip.start, 9);
    const finish = decimal(add(item.clip.start, item.clip.duration), 9);
    const clipLabel = `vclip${i}`;
    const next = `vbase${i + 1}`;
    filter.push(`[${item.input}:v:0]trim=start=${source}:duration=${clipDuration},setpts=PTS-STARTPTS+(${start})/TB,fps=${fps},scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease,pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgba[${clipLabel}]`);
    filter.push(`[${base}][${clipLabel}]overlay=shortest=0:eof_action=pass:repeatlast=0:enable='gte(t,${start})*lt(t,${finish})'[${next}]`);
    base = next;
  }
  filter.push(`[${base}]trim=duration=${totalSeconds},setpts=PTS-STARTPTS[vout]`);

  const audioClips = inputs.filter((item) => item.media.hasAudio && item.clip.audioEnabled && (item.track.kind === 'audio' || item.track.kind === 'video'));
  if (!audioClips.length) {
    const silentInput = inputs.length;
    args.push('-f', 'lavfi', '-t', totalSeconds, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    filter.push(`[${silentInput}:a]atrim=duration=${totalSeconds},asetpts=PTS-STARTPTS[aout]`);
  } else {
    const audioLabels: string[] = [];
    audioClips.forEach((item, i) => {
      const source = decimal(item.clip.sourceIn, 9);
      const clipDuration = decimal(item.clip.duration, 9);
      const start = decimal(item.clip.start, 9);
      const label = `aclip${i}`;
      filter.push(`[${item.input}:a:0]atrim=start=${source}:duration=${clipDuration},aresample=48000,asetpts=N/SR/TB+(${start})/TB,volume=${item.clip.volume}[${label}]`);
      audioLabels.push(`[${label}]`);
    });
    filter.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${totalSeconds},alimiter=limit=0.95[aout]`);
  }

  args.push('-filter_complex', filter.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', totalSeconds,
    '-r', fps, '-c:v', options.encoder ?? 'libx264', '-b:v', options.videoBitrate ?? '16M', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', options.audioBitrate ?? '320k', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temp);
  try {
    await runCommand('ffmpeg', args, (chunk) => {
      const match = /out_time_ms=(\d+)/.exec(chunk);
      if (match) options.onProgress?.(Math.min(0.99, Number(match[1]) / 1_000_000 / Number(totalSeconds)));
    });
    const verify = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,width,height,r_frame_rate', '-of', 'json', temp]);
    const info = JSON.parse(verify.stdout);
    if (!info.streams?.some((stream: any) => stream.codec_type === 'video')) throw new AppError('EXPORT_VERIFY_FAILED', 'Rendered file has no video stream.');
    if (options.overwrite) await fs.rm(output, { force: true });
    await fs.rename(temp, output);
    options.onProgress?.(1);
    return { outputPath: output, duration, frameRate: project.frameRate };
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError('EXPORT_FAILED', `Video export failed: ${tail(error instanceof Error ? error.message : String(error))}`);
  }
}
