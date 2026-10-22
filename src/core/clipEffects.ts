import { existsSync } from 'node:fs';
import { add, compare, decimal, parseDecimal, rational, sub } from './time';
import { maskPathPoints } from './maskPath';
import type { Project, Rational, TimelineClip } from './types';

export const DEFAULT_PLAYBACK_RATE = rational(1);

interface SpeedPoint { time: Rational; rate: Rational; }
interface SpeedSpan { startTime: number; endTime: number; startSource: number; endSource: number; startRate: number; endRate: number; }

function timeValue(value: Rational): number { return Number(value.num) / Number(value.den); }
function rateValue(value: Rational): number { return timeValue(value); }
function safeNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number(value.toFixed(10)).toString();
}
function multiply(a: Rational, b: Rational): Rational { return rational(BigInt(a.num) * BigInt(b.num), BigInt(a.den) * BigInt(b.den)); }
function divide(a: Rational, b: Rational): Rational { return rational(BigInt(a.num) * BigInt(b.den), BigInt(a.den) * BigInt(b.num)); }
function average(a: Rational, b: Rational): Rational { return divide(add(a, b), rational(2)); }

function speedPoints(clip: TimelineClip): SpeedPoint[] {
  const duration = clip.duration;
  const base = clip.playbackRate ?? DEFAULT_PLAYBACK_RATE;
  const points = [{ time: rational(0), rate: base }, ...(clip.speedKeyframes ?? []).map((frame) => ({ time: frame.time, rate: frame.rate }))]
    .sort((a, b) => compare(a.time, b.time));
  const unique: SpeedPoint[] = [];
  for (const point of points) {
    if (unique.length && compare(unique[unique.length - 1].time, point.time) === 0) unique[unique.length - 1] = point;
    else unique.push(point);
  }
  if (!unique.length || compare(unique[0].time, rational(0)) > 0) unique.unshift({ time: rational(0), rate: base });
  if (compare(unique[unique.length - 1].time, duration) < 0) unique.push({ time: duration, rate: unique[unique.length - 1].rate });
  return unique;
}

function rateAt(points: SpeedPoint[], time: Rational): Rational {
  if (compare(time, points[0].time) <= 0) return points[0].rate;
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i];
    if (compare(time, right.time) <= 0) {
      const elapsed = sub(time, left.time), span = sub(right.time, left.time);
      const ratio = divide(elapsed, span);
      const delta = sub(right.rate, left.rate);
      return add(left.rate, multiply(delta, ratio));
    }
  }
  return points[points.length - 1].rate;
}

export function clipPlaybackRateAt(clip: TimelineClip, time: Rational): Rational {
  return rateAt(speedPoints(clip), time);
}

export function splitClipAnimation(clip: TimelineClip, offset: Rational): {
  leftSpeedKeyframes: NonNullable<TimelineClip['speedKeyframes']>;
  rightPlaybackRate: Rational;
  rightSpeedKeyframes: NonNullable<TimelineClip['speedKeyframes']>;
  leftKeyframes: NonNullable<TimelineClip['keyframes']>;
  rightKeyframes: NonNullable<TimelineClip['keyframes']>;
} {
  const speedAtSplit = clipPlaybackRateAt(clip, offset);
  const leftSpeedKeyframes = (clip.speedKeyframes ?? []).filter((frame) => compare(frame.time, offset) < 0).map((frame) => structuredClone(frame));
  if (!leftSpeedKeyframes.some((frame) => compare(frame.time, offset) === 0)) leftSpeedKeyframes.push({ time: offset, rate: speedAtSplit });
  const rightSpeedKeyframes = (clip.speedKeyframes ?? []).filter((frame) => compare(frame.time, offset) > 0)
    .map((frame) => ({ time: sub(frame.time, offset), rate: structuredClone(frame.rate) }));

  const properties = new Set((clip.keyframes ?? []).map((frame) => frame.property));
  const leftKeyframes: NonNullable<TimelineClip['keyframes']> = [];
  const rightKeyframes: NonNullable<TimelineClip['keyframes']> = [];
  for (const property of properties) {
    const frames = (clip.keyframes ?? []).filter((frame) => frame.property === property).sort((a, b) => compare(a.time, b.time));
    const base = property === 'volume' ? clip.volume : property === 'brightness' ? clip.color?.brightness ?? 0
      : property === 'contrast' ? clip.color?.contrast ?? 1 : property === 'saturation' ? clip.color?.saturation ?? 1 : 1;
    const localSeconds = timeValue(offset);
    let value = base;
    if (frames.length) {
      if (compare(offset, frames[0].time) >= 0) {
        value = frames[0].value;
        for (let i = 1; i < frames.length; i++) {
          if (compare(offset, frames[i].time) < 0) {
            const previous = frames[i - 1], next = frames[i];
            if ((previous.interpolation ?? 'linear') === 'linear') {
              const fraction = (localSeconds - timeValue(previous.time)) / (timeValue(next.time) - timeValue(previous.time));
              value = previous.value + (next.value - previous.value) * fraction;
            } else value = previous.value;
            break;
          }
          value = frames[i].value;
        }
      }
    }
    const atSplit = frames.filter((frame) => compare(frame.time, offset) < 0).map((frame) => structuredClone(frame));
    atSplit.push({ time: offset, property, value, interpolation: 'linear' });
    leftKeyframes.push(...atSplit);
    rightKeyframes.push({ time: rational(0), property, value, interpolation: 'linear' });
    rightKeyframes.push(...frames.filter((frame) => compare(frame.time, offset) > 0)
      .map((frame) => ({ ...structuredClone(frame), time: sub(frame.time, offset) })));
  }
  return { leftSpeedKeyframes, rightPlaybackRate: speedAtSplit, rightSpeedKeyframes, leftKeyframes, rightKeyframes };
}

export function extendClipAnimation(clip: TimelineClip, extension: Rational): {
  playbackRate: Rational;
  speedKeyframes: NonNullable<TimelineClip['speedKeyframes']>;
  keyframes: NonNullable<TimelineClip['keyframes']>;
} {
  const firstRate = clipPlaybackRateAt(clip, rational(0));
  const speedKeyframes = [
    { time: extension, rate: firstRate },
    ...(clip.speedKeyframes ?? []).filter((frame) => compare(frame.time, rational(0)) > 0)
      .map((frame) => ({ time: add(extension, frame.time), rate: structuredClone(frame.rate) }))
  ].sort((a, b) => compare(a.time, b.time));
  const keyframes: NonNullable<TimelineClip['keyframes']> = [];
  const properties = new Set((clip.keyframes ?? []).map((frame) => frame.property));
  for (const property of properties) {
    const frames = (clip.keyframes ?? []).filter((frame) => frame.property === property).sort((a, b) => compare(a.time, b.time));
    const base = property === 'volume' ? clip.volume : property === 'brightness' ? clip.color?.brightness ?? 0
      : property === 'contrast' ? clip.color?.contrast ?? 1 : property === 'saturation' ? clip.color?.saturation ?? 1 : 1;
    const atOriginalStart = frames.length && compare(frames[0].time, rational(0)) === 0 ? frames[0].value : base;
    keyframes.push({ time: rational(0), property, value: atOriginalStart, interpolation: 'hold' });
    keyframes.push({ time: extension, property, value: atOriginalStart, interpolation: 'linear' });
    keyframes.push(...frames.filter((frame) => compare(frame.time, rational(0)) > 0)
      .map((frame) => ({ ...structuredClone(frame), time: add(extension, frame.time) })));
  }
  return { playbackRate: firstRate, speedKeyframes, keyframes };
}

/** Exact integral of the piecewise-linear playback rate over the clip duration. */
export function clipSourceDuration(clip: TimelineClip): Rational {
  const points = speedPoints(clip);
  let source = rational(0);
  for (let i = 1; i < points.length; i++) {
    const timelineSpan = sub(points[i].time, points[i - 1].time);
    source = add(source, multiply(timelineSpan, average(points[i - 1].rate, points[i].rate)));
  }
  return source;
}

/** Source offset consumed by a local timeline time, including a linear speed ramp. */
export function clipSourceOffsetAt(clip: TimelineClip, localTimelineTime: Rational): Rational {
  const bounded = compare(localTimelineTime, clip.duration) > 0 ? clip.duration : localTimelineTime;
  const points = speedPoints(clip);
  let source = rational(0);
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i];
    if (compare(bounded, right.time) >= 0) {
      source = add(source, multiply(sub(right.time, left.time), average(left.rate, right.rate)));
      continue;
    }
    if (compare(bounded, left.time) <= 0) break;
    const partialTime = sub(bounded, left.time);
    const partialRate = rateAt(points, bounded);
    source = add(source, multiply(partialTime, average(left.rate, partialRate)));
    break;
  }
  return source;
}

export function clipSourceOffsetForDelta(clip: TimelineClip, timelineDelta: Rational): Rational {
  if (compare(timelineDelta, rational(0)) >= 0) return clipSourceOffsetAt(clip, timelineDelta);
  return multiply(timelineDelta, clipPlaybackRateAt(clip, rational(0)));
}

function sourceSpans(clip: TimelineClip): SpeedSpan[] {
  const points = speedPoints(clip);
  let startSource = rational(0);
  const spans: SpeedSpan[] = [];
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const sourceSpan = multiply(sub(end.time, start.time), average(start.rate, end.rate));
    const endSource = add(startSource, sourceSpan);
    spans.push({
      startTime: timeValue(start.time), endTime: timeValue(end.time), startSource: timeValue(startSource), endSource: timeValue(endSource),
      startRate: rateValue(start.rate), endRate: rateValue(end.rate)
    });
    startSource = endSource;
  }
  return spans;
}

/** Map source timestamps back to local timeline timestamps for FFmpeg setpts. */
export function clipSetptsExpression(clip: TimelineClip): string {
  const spans = sourceSpans(clip);
  if (spans.length === 1 && Math.abs(spans[0].startRate - spans[0].endRate) < 1e-9) return `setpts=(PTS-STARTPTS)/${safeNumber(spans[0].startRate)}`;
  let expression = safeNumber(spans[spans.length - 1]?.endTime ?? timeValue(clip.duration));
  const sourceTime = '((PTS-STARTPTS)*TB)';
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i], sourceSpan = span.endSource - span.startSource, timelineSpan = span.endTime - span.startTime;
    const slope = (span.endRate - span.startRate) / timelineSpan;
    let mapped: string;
    if (Math.abs(slope) < 1e-9) mapped = `${safeNumber(span.startTime)}+(${sourceTime}-${safeNumber(span.startSource)})/${safeNumber(span.startRate)}`;
    else mapped = `${safeNumber(span.startTime)}+(sqrt(${safeNumber(span.startRate * span.startRate)}+${safeNumber(2 * slope)}*(${sourceTime}-${safeNumber(span.startSource)}))-${safeNumber(span.startRate)})/${safeNumber(slope)}`;
    const sourceBoundary = safeNumber(span.endSource);
    expression = `if(lt(${sourceTime},${sourceBoundary}),${mapped},${expression})`;
    // Keep the final expression well formed even when FFmpeg simplifies the last span.
    if (!Number.isFinite(sourceSpan)) throw new Error('Invalid speed curve source duration.');
  }
  return `setpts='${expression}/TB'`;
}

export function keyframeExpression(clip: TimelineClip, property: 'opacity' | 'brightness' | 'contrast' | 'saturation' | 'volume', baseValue: number): string {
  const points = (clip.keyframes ?? []).filter((frame) => frame.property === property)
    .map((frame) => ({ time: timeValue(frame.time), value: frame.value, interpolation: frame.interpolation ?? 'linear' }))
    .sort((a, b) => a.time - b.time);
  return keyframePointsExpression(points, baseValue, 't');
}

export function trackVolumeExpression(track: Project['tracks'][number]): string {
  const points = (track.volumeKeyframes ?? []).map((frame) => ({ time: timeValue(frame.time), value: frame.value, interpolation: frame.interpolation ?? 'linear' }));
  return keyframePointsExpression(points, track.volume ?? 1, 't');
}

function keyframePointsExpression(points: Array<{ time: number; value: number; interpolation: 'linear' | 'hold' }>, baseValue: number, timeVariable: string): string {
  if (!points.length || points[0].time > 0) points.unshift({ time: 0, value: baseValue, interpolation: 'linear' });
  let expression = safeNumber(points[points.length - 1].value);
  for (let i = points.length - 2; i >= 0; i--) {
    const left = points[i], right = points[i + 1];
    const span = right.time - left.time;
    const value = left.interpolation === 'hold' || span <= 0
      ? safeNumber(left.value)
      : `${safeNumber(left.value)}+(${safeNumber(right.value - left.value)})*(${timeVariable}-${safeNumber(left.time)})/${safeNumber(span)}`;
    expression = `if(lt(${timeVariable},${safeNumber(right.time)}),${value},${expression})`;
  }
  return expression;
}

function escapeFilterText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll(':', '\\:').replaceAll(',', '\\,').replaceAll('%', '\\%').replaceAll('[', '\\[').replaceAll(']', '\\]');
}
function escapeFilterPath(value: string): string { return escapeFilterText(value.replaceAll('\\', '/')); }

function defaultTitleFont(): string | undefined {
  const candidates = process.platform === 'win32'
    ? [`${process.env.WINDIR ?? 'C:/Windows'}/Fonts/arial.ttf`, 'C:/Windows/Fonts/arial.ttf']
    : process.platform === 'darwin'
      ? ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Supplemental/Helvetica.ttc']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'];
  return candidates.find((candidate) => existsSync(candidate));
}

function maskCoordinateExpression(base: number, keyframes: NonNullable<NonNullable<TimelineClip['mask']>['keyframes']>, pointIndex: number, axis: 0 | 1, frameRate: Rational): string {
  const entries = [{ time: rational(0), value: base }, ...keyframes.map((frame) => ({ time: frame.time, value: maskPathPoints(frame.path)[pointIndex][axis] }))]
    .sort((a, b) => compare(a.time, b.time));
  const unique: typeof entries = [];
  for (const entry of entries) {
    if (unique.length && compare(unique[unique.length - 1].time, entry.time) === 0) unique[unique.length - 1] = entry;
    else unique.push(entry);
  }
  if (unique.length === 1) return safeNumber(unique[0].value);
  const times = unique.map((entry) => timeValue(entry.time));
  let expression = safeNumber(unique[unique.length - 1].value);
  for (let index = unique.length - 2; index >= 0; index--) {
    const start = times[index], end = times[index + 1];
    const span = Math.max(1 / Math.max(1, timeValue(frameRate)), end - start);
    const value = `${safeNumber(unique[index].value)}+(${safeNumber(unique[index + 1].value - unique[index].value)})*(T-${safeNumber(start)})/${safeNumber(span)}`;
    expression = `if(lt(T,${safeNumber(end)}),${value},${expression})`;
  }
  return expression;
}

function maskAlphaExpression(clip: TimelineClip, project: Project): string {
  const mask = clip.mask!;
  const points = maskPathPoints(mask.path);
  const keyframes = mask.keyframes ?? [];
  const dynamicPoints = points.map((point, index) => [
    `(${maskCoordinateExpression(point[0], keyframes, index, 0, project.frameRate)})*W`,
    `(${maskCoordinateExpression(point[1], keyframes, index, 1, project.frameRate)})*H`
  ] as const);
  const crossings: string[] = [];
  const distances: string[] = [];
  for (let index = 0; index < dynamicPoints.length; index++) {
    const [x1, y1] = dynamicPoints[index];
    const [x2, y2] = dynamicPoints[(index + 1) % dynamicPoints.length];
    const dy = `((${y2})-(${y1}))`, dx = `((${x2})-(${x1}))`;
    const xCross = `((${x1})+(Y-(${y1}))*(${dx})/if(eq(${dy},0),1,${dy}))`;
    crossings.push(`if(gt(${y1},Y),if(lt(${y2},Y),lt(X,${xCross}),0),if(gt(${y2},Y),lt(X,${xCross}),0))`);
    const lengthSquared = `((${dx})*(${dx})+(${dy})*(${dy}))`;
    const projection = `clip(((X-(${x1}))*(${dx})+(Y-(${y1}))*(${dy}))/if(eq(${lengthSquared},0),1,${lengthSquared}),0,1)`;
    distances.push(`sqrt((X-((${x1})+${projection}*(${dx})))^2+(Y-((${y1})+${projection}*(${dy})))^2)`);
  }
  const inside = `mod(${crossings.join('+')},2)`;
  if (mask.expansionPx === 0) return `if(gt(${inside},0.5),255,0)`;
  const edgeDistance = distances.reduce((left, right) => `min(${left},${right})`);
  const signedDistance = `if(gt(${inside},0.5),${edgeDistance},-${edgeDistance})`;
  return `if(gt(${signedDistance}+${safeNumber(mask.expansionPx)},0),255,0)`;
}

/** Video filter chain shared by the timeline frame monitor and full export. Input PTS must be local clip time. */
export function buildClipVideoFilters(clip: TimelineClip, project: Project): string[] {
  const transform = clip.transform ?? { scale: 1, x: 0, y: 0, rotationDegrees: 0 };
  const color = clip.color ?? { brightness: 0, contrast: 1, saturation: 1 };
  const filters = [
    `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease`,
    `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `setsar=1`
  ];
  if (transform.scale !== 1) filters.push(`scale=round(iw*${safeNumber(transform.scale)}/2)*2:round(ih*${safeNumber(transform.scale)}/2)*2`);
  if (transform.rotationDegrees !== 0) filters.push(`rotate=${safeNumber(transform.rotationDegrees)}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`);
  filters.push('format=rgba');
  if (clip.color?.lutPath) filters.push(`lut3d=file='${escapeFilterPath(clip.color.lutPath)}':interp=tetrahedral`);
  const brightness = keyframeExpression(clip, 'brightness', color.brightness);
  const contrast = keyframeExpression(clip, 'contrast', color.contrast);
  const saturation = keyframeExpression(clip, 'saturation', color.saturation);
  if (color.brightness !== 0 || color.contrast !== 1 || color.saturation !== 1 || clip.keyframes?.some((frame) => ['brightness', 'contrast', 'saturation'].includes(frame.property))) {
    filters.push(`eq=brightness='${brightness}':contrast='${contrast}':saturation='${saturation}':eval=frame`);
  }
  if (clip.chromaKey) {
    const { color: keyColor, similarity, blend } = clip.chromaKey;
    filters.push(`format=yuva444p,chromakey=0x${keyColor.slice(1)}:${safeNumber(similarity)}:${safeNumber(blend)},format=rgba`);
  }
  if (clip.mask) {
    const alpha = maskAlphaExpression(clip, project);
    filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':alpha_expr='alpha(X,Y)*(${alpha})/255'`);
    if (clip.mask.featherPx > 0) filters.push(`gblur=sigma=${safeNumber(clip.mask.featherPx)}:planes=8`);
  }
  const opacity = keyframeExpression(clip, 'opacity', 1);
  if (opacity !== '1') filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':alpha_expr='alpha(X,Y)*(${opacity.replace(/\bt\b/g, 'T')})'`);
  if (clip.transitionIn && compare(clip.transitionIn.duration, rational(0)) > 0) {
    const transition = timeValue(clip.transitionIn.duration);
    if (clip.transitionIn.type === 'wipe-left') filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':alpha_expr='alpha(X,Y)*if(lt(X/W,T/${safeNumber(transition)}),1,0)'`);
    else if (clip.transitionIn.type === 'wipe-right') filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':alpha_expr='alpha(X,Y)*if(gt(X/W,1-T/${safeNumber(transition)}),1,0)'`);
    else filters.push(`fade=t=in:st=0:d=${safeNumber(transition)}:alpha=1`);
  }
  if (clip.title?.text) {
    const title = clip.title;
    const start = timeValue(title.start), end = start + timeValue(title.duration);
    const fontFile = title.fontFile ?? defaultTitleFont();
    filters.push(`drawtext=${fontFile ? `fontfile='${escapeFilterPath(fontFile)}':` : ''}text='${escapeFilterText(title.text)}':fontsize=${title.fontSize}:fontcolor=${title.color}:x=(w-text_w)*${safeNumber(title.x)}:y=(h-text_h)*${safeNumber(title.y)}:enable='between(t,${safeNumber(start)},${safeNumber(end)})'${title.box ? ':box=1:boxcolor=black@0.55:boxborderw=12' : ''}`);
  }
  return filters;
}

/** Build a frame-specific equivalent of the export chain at a clip-local time. */
export function buildClipPreviewFilters(clip: TimelineClip, project: Project, localTime: Rational): string[] {
  void localTime;
  const previewClip: TimelineClip = { ...clip, speedKeyframes: [], playbackRate: rational(1) };
  // Local-time keyframes stay on the original clip. The still source is seeked to the matching source time.
  return buildClipVideoFilters(previewClip, project);
}

export function clipVideoOverlayPosition(clip: TimelineClip, project: Project): { x: string; y: string } {
  const transform = clip.transform ?? { scale: 1, x: 0, y: 0, rotationDegrees: 0 };
  return { x: `(W-w)/2+${safeNumber(transform.x)}`, y: `(H-h)/2+${safeNumber(transform.y)}` };
}

export function clipAudioVolumeExpression(clip: TimelineClip, trackVolume = 1): string {
  const clipExpression = keyframeExpression(clip, 'volume', clip.volume);
  return `(${clipExpression})*${safeNumber(trackVolume)}`;
}

/** Audio speed-ramp chunks keep pitch correction enabled while approximating each linear segment at 250 ms. */
export function clipAudioSpeedChunks(clip: TimelineClip, maxChunkSeconds = 0.25): Array<{ sourceStart: Rational; sourceDuration: Rational; rate: Rational }> {
  const points = speedPoints(clip);
  const chunks: Array<{ sourceStart: Rational; sourceDuration: Rational; rate: Rational }> = [];
  let consumed = rational(0);
  for (let i = 1; i < points.length; i++) {
    const left = points[i - 1], right = points[i];
    const span = sub(right.time, left.time);
    const varying = compare(left.rate, right.rate) !== 0;
    const steps = varying ? Math.max(1, Math.ceil(timeValue(span) / maxChunkSeconds)) : 1;
    for (let step = 0; step < steps; step++) {
      const localStart = add(left.time, multiply(span, rational(step, steps)));
      const localEnd = add(left.time, multiply(span, rational(step + 1, steps)));
      const rateStart = rateAt(points, localStart), rateEnd = rateAt(points, localEnd);
      const sourceDuration = multiply(sub(localEnd, localStart), average(rateStart, rateEnd));
      chunks.push({ sourceStart: consumed, sourceDuration, rate: average(rateStart, rateEnd) });
      consumed = add(consumed, sourceDuration);
    }
  }
  return chunks;
}

export function atempoFilters(rate: Rational): string[] {
  let value = rateValue(rate);
  const filters: string[] = [];
  while (value < 0.5) { filters.push('atempo=0.5'); value /= 0.5; }
  while (value > 2) { filters.push('atempo=2'); value /= 2; }
  filters.push(`atempo=${safeNumber(value)}`);
  return filters;
}

export function parseEffectRate(value: number | string): Rational {
  const parsed = parseDecimal(value);
  return parsed;
}
