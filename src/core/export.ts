import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppError } from './errors';
import { atempoFilters, buildClipVideoFilters, clipAudioSpeedChunks, clipSetptsExpression, clipSourceDuration, clipAudioVolumeExpression, trackVolumeExpression } from './clipEffects';
import { appendCompositeLayer } from './compositing';
import { runCommand, tail } from './ffmpeg';
import { add, compare, decimal, rational, sub } from './time';
import { isTrackEnabled, timelineDuration, validateProject } from './project';
import type { ExportOptions, MediaAsset, Project, Rational, TimelineClip, TimelineTrack } from './types';

interface RenderClip { track: TimelineTrack; clip: TimelineClip; media: MediaAsset; input: number; }

export async function exportVideo(project: Project, options: ExportOptions): Promise<{ outputPath: string; duration: Rational; frameRate: Rational }> {
  validateProject(project);
  const output = path.resolve(options.outputPath);
  const duration = timelineDuration(project);
  if (compare(duration, rational(0)) <= 0) throw new AppError('EMPTY_TIMELINE', 'Add at least one clip to the timeline before exporting.');
  const renderStart = options.range?.start ?? rational(0);
  const renderDuration = options.range?.duration ?? sub(duration, renderStart);
  const renderEnd = add(renderStart, renderDuration);
  if (compare(renderStart, rational(0)) < 0 || compare(renderDuration, rational(0)) <= 0 || compare(renderEnd, duration) > 0) {
    throw new AppError('INVALID_RENDER_RANGE', 'Preview range must be positive and remain inside the project timeline.');
  }
  for (const asset of project.media) {
    if (path.resolve(asset.path).toLowerCase() === output.toLowerCase()) throw new AppError('SOURCE_OVERWRITE_BLOCKED', 'Export cannot overwrite an imported original media file.');
  }
  try { await fs.access(output); if (!options.overwrite) throw new AppError('OUTPUT_EXISTS', `Output already exists: ${output}`); }
  catch (error) { if (error instanceof AppError) throw error; }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temp = path.join(path.dirname(output), `.${path.basename(output, path.extname(output))}.${randomUUID()}.rendering.mp4`);

  const active = project.tracks.flatMap((track) => isTrackEnabled(project, track) ? track.clips
    .filter((clip) => compare(clip.start, renderEnd) < 0 && compare(add(clip.start, clip.duration), renderStart) > 0)
    .map((clip) => ({ track, clip, media: project.media.find((item) => item.id === clip.mediaId)! })) : []);
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
  const totalSeconds = decimal(renderDuration, 6);
  const startSeconds = decimal(renderStart, 9);
  const videoClips = inputs.filter((item) => item.track.kind === 'video' && item.media.kind === 'video');
  filter.push(`color=c=black:s=${project.width}x${project.height}:r=${fps}:d=${totalSeconds},format=rgba[vbase0]`);
  let base = 'vbase0';
  for (let i = 0; i < videoClips.length; i++) {
    const item = videoClips[i];
    const source = decimal(item.clip.sourceIn, 9);
    const clipDuration = decimal(clipSourceDuration(item.clip), 9);
    const start = decimal(sub(item.clip.start, renderStart), 9);
    const clipLabel = `vclip${i}`;
    const next = `vbase${i + 1}`;
    filter.push(`[${item.input}:v:0]trim=start=${source}:duration=${clipDuration},${clipSetptsExpression(item.clip)},fps=${fps},${buildClipVideoFilters(item.clip, project).join(',')},setpts=PTS-STARTPTS+(${start})/TB[${clipLabel}]`);
    appendCompositeLayer(filter, base, clipLabel, next, item.clip, project, fps, totalSeconds, i, false);
    base = next;
  }
  filter.push(`[${base}]trim=duration=${totalSeconds},setpts=PTS-STARTPTS[vout]`);

  const audioClips = inputs.filter((item) => item.media.hasAudio && item.clip.audioEnabled && (item.track.kind === 'audio' || item.track.kind === 'video'));
  const audioRecords: Array<{ track: TimelineTrack; label: string }> = [];
  if (!audioClips.length) {
    const silentInput = inputs.length;
    args.push('-f', 'lavfi', '-t', totalSeconds, '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    filter.push(`[${silentInput}:a]atrim=duration=${totalSeconds},asetpts=PTS-STARTPTS[aout]`);
  } else {
    audioClips.forEach((item, i) => {
      const source = decimal(item.clip.sourceIn, 9);
      const sourceDuration = decimal(clipSourceDuration(item.clip), 9);
      const clipDuration = decimal(item.clip.duration, 9);
      const timelineStart = decimal(item.clip.start, 9);
      const fadeIn = item.clip.fadeIn ?? rational(0);
      const fadeOut = item.clip.fadeOut ?? rational(0);
      const sourceLabel = `asource${i}`;
      const chunks = clipAudioSpeedChunks(item.clip);
      filter.push(`[${item.input}:a:0]atrim=start=${source}:duration=${sourceDuration},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[${sourceLabel}]`);
      const splitLabels = chunks.map((_, chunkIndex) => `asplit${i}_${chunkIndex}`);
      if (chunks.length > 1) filter.push(`[${sourceLabel}]asplit=${chunks.length}${splitLabels.map((label) => `[${label}]`).join('')}`);
      const pieceLabels: string[] = [];
      chunks.forEach((chunk, chunkIndex) => {
        const splitInput = chunks.length > 1 ? splitLabels[chunkIndex] : sourceLabel;
        const piece = `aspeed${i}_${chunkIndex}`;
        const speedFilters = atempoFilters(chunk.rate).join(',');
        filter.push(`[${splitInput}]atrim=start=${decimal(chunk.sourceStart, 9)}:duration=${decimal(chunk.sourceDuration, 9)},asetpts=PTS-STARTPTS,${speedFilters}[${piece}]`);
        pieceLabels.push(`[${piece}]`);
      });
      const assembled = `aspeedclip${i}`;
      if (pieceLabels.length > 1) filter.push(`${pieceLabels.join('')}concat=n=${pieceLabels.length}:v=0:a=1,atrim=duration=${clipDuration}[${assembled}]`);
      else filter.push(`${pieceLabels[0]}atrim=duration=${clipDuration}[${assembled}]`);
      const label = `aclip${i}`;
      const audioEffects: string[] = [];
      if (item.clip.normalizeAudio || item.track.normalizeAudio) audioEffects.push('loudnorm=I=-16:TP=-1.5:LRA=11');
      if (compare(fadeIn, rational(0)) > 0) audioEffects.push(`afade=t=in:st=0:d=${decimal(fadeIn, 9)}`);
      if (compare(fadeOut, rational(0)) > 0) audioEffects.push(`afade=t=out:st=${decimal(sub(item.clip.duration, fadeOut), 9)}:d=${decimal(fadeOut, 9)}`);
      const clipVolume = clipAudioVolumeExpression(item.clip);
      audioEffects.push(`volume='${clipVolume}':eval=frame`);
      filter.push(`[${assembled}]${audioEffects.join(',')},asetpts=PTS-STARTPTS+(${timelineStart})/TB,volume='${trackVolumeExpression(item.track)}':eval=frame,asetpts=PTS-(${startSeconds})/TB[${label}]`);
      audioRecords.push({ track: item.track, label });
    });
    const dialogue = audioRecords.filter((record) => record.track.audioRole === 'dialogue');
    const duckedMusic = audioRecords.filter((record) => record.track.audioRole === 'music' && record.track.duckUnderDialogue);
    const regular = audioRecords.filter((record) => !dialogue.includes(record) && !duckedMusic.includes(record));
    let finalLabels: string[] = [];
    const addMix = (records: typeof audioRecords, label: string, includeInFinal = true) => {
      if (!records.length) return;
      if (records.length === 1) filter.push(`[${records[0].label}]anull[${label}]`);
      else filter.push(`${records.map((record) => `[${record.label}]`).join('')}amix=inputs=${records.length}:duration=longest:dropout_transition=0:normalize=0[${label}]`);
      if (includeInFinal) finalLabels.push(`[${label}]`);
    };
    if (dialogue.length && duckedMusic.length) {
      addMix(dialogue, 'dialoguebus', false);
      addMix(duckedMusic, 'musicbus', false);
      filter.push(`[musicbus][dialoguebus]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[duckedmusic]`);
      finalLabels.push('[duckedmusic]');
    } else {
      regular.push(...dialogue, ...duckedMusic);
    }
    addMix(regular, 'regularbus');
    if (finalLabels.length === 1) filter.push(`${finalLabels[0]}atrim=start=0:duration=${totalSeconds},asetpts=PTS-STARTPTS,alimiter=limit=0.95[aout]`);
    else filter.push(`${finalLabels.join('')}amix=inputs=${finalLabels.length}:duration=longest:dropout_transition=0:normalize=0,atrim=start=0:duration=${totalSeconds},asetpts=PTS-STARTPTS,alimiter=limit=0.95[aout]`);
  }

  let outputFrameRate = project.frameRate;
  if (options.quality === 'preview' && compare(outputFrameRate, rational(24)) > 0) outputFrameRate = rational(24);
  const outputFps = `${outputFrameRate.num}/${outputFrameRate.den}`;
  const outputWidth = options.quality === 'preview' ? Math.min(project.width, 960) : project.width;
  const outputHeight = options.quality === 'preview'
    ? Math.max(2, Math.round((project.height * outputWidth / project.width) / 2) * 2)
    : project.height;
  if (options.quality === 'preview') {
    filter.push(`[vout]scale=${outputWidth}:${outputHeight}:flags=fast_bilinear,fps=${outputFps},setpts=PTS-STARTPTS[vpreview]`);
  }
  args.push('-filter_complex', filter.join(';'), '-map', options.quality === 'preview' ? '[vpreview]' : '[vout]', '-map', '[aout]', '-t', totalSeconds,
    '-r', outputFps, '-c:v', options.encoder ?? 'libx264', '-b:v', options.videoBitrate ?? (options.quality === 'preview' ? '3500k' : '16M'), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', options.audioBitrate ?? (options.quality === 'preview' ? '160k' : '320k'), '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', temp);
  try {
    await runCommand('ffmpeg', args, (chunk) => {
      const match = /out_time_ms=(\d+)/.exec(chunk);
      if (match) options.onProgress?.(Math.min(0.99, Number(match[1]) / 1_000_000 / Number(totalSeconds)));
    }, options.signal);
    const verify = await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,width,height,r_frame_rate', '-of', 'json', temp], undefined, options.signal);
    const info = JSON.parse(verify.stdout);
    const video = info.streams?.find((stream: any) => stream.codec_type === 'video');
    if (!video) throw new AppError('EXPORT_VERIFY_FAILED', 'Rendered file has no video stream.');
    if (video.width !== outputWidth || video.height !== outputHeight) throw new AppError('EXPORT_VERIFY_FAILED', `Rendered video has unexpected dimensions (${video.width}x${video.height}; expected ${outputWidth}x${outputHeight}).`);
    if (options.signal?.aborted) throw new AppError('PROCESS_ABORTED', 'Preview rendering was cancelled because a newer timeline state is available.');
    if (options.overwrite) await fs.rm(output, { force: true });
    await fs.rename(temp, output);
    options.onProgress?.(1);
    return { outputPath: output, duration: renderDuration, frameRate: outputFrameRate };
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError('EXPORT_FAILED', `Video export failed: ${tail(error instanceof Error ? error.message : String(error))}`);
  }
}
