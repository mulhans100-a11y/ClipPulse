import { AppError } from './errors';
import { add, compare, rational, sub } from './time';
import type { ClipMask, Rational } from './types';

export type MaskPoint = readonly [number, number];

/** Parse a bounded, closed SVG path into a polygon. Cubic and quadratic curves are flattened deterministically. */
export function maskPathPoints(path: string): MaskPoint[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new AppError('INVALID_MASK', 'Mask paths must contain 1–4096 characters.');
  }
  const tokens = path.match(/[MLCQZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  if (path.replace(/[\s,]/g, '').toUpperCase() !== tokens.join('').toUpperCase()) {
    throw new AppError('INVALID_MASK', 'Mask paths may use only M, L, Q, C, Z and numeric coordinates.');
  }
  let index = 0;
  let command = '';
  let current: MaskPoint = [0, 0];
  let origin: MaskPoint = [0, 0];
  let started = false;
  let closed = false;
  const points: MaskPoint[] = [];
  const read = (): number => {
    const token = tokens[index++];
    const value = Number(token);
    if (token === undefined || !Number.isFinite(value) || Math.abs(value) > 4) throw new AppError('INVALID_MASK', 'Mask coordinates must be finite normalized values between -4 and 4.');
    return value;
  };
  const add = (point: MaskPoint) => {
    points.push(point);
    if (points.length > 64) throw new AppError('INVALID_MASK', 'A mask may contain at most 64 flattened path points.');
  };

  while (index < tokens.length) {
    if (/^[A-Z]$/i.test(tokens[index])) command = tokens[index++].toUpperCase();
    if (!command) throw new AppError('INVALID_MASK', 'Mask path must start with M.');
    if (command === 'Z') {
      if (!started) throw new AppError('INVALID_MASK', 'Mask path must start with M.');
      closed = true;
      current = origin;
      command = '';
      continue;
    }
    if (command === 'M' || command === 'L') {
      const point: MaskPoint = [read(), read()];
      if (command === 'M') {
        if (started) throw new AppError('INVALID_MASK', 'Only one closed contour is supported per mask.');
        origin = point;
        started = true;
      }
      current = point;
      add(point);
      if (command === 'M') command = 'L';
      continue;
    }
    if (command === 'C') {
      if (!started) throw new AppError('INVALID_MASK', 'Mask path must start with M.');
      const p0 = current;
      const p1: MaskPoint = [read(), read()], p2: MaskPoint = [read(), read()], p3: MaskPoint = [read(), read()];
      for (let step = 1; step <= 6; step++) {
        const t = step / 6, u = 1 - t;
        add([u ** 3 * p0[0] + 3 * u ** 2 * t * p1[0] + 3 * u * t ** 2 * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u ** 2 * t * p1[1] + 3 * u * t ** 2 * p2[1] + t ** 3 * p3[1]]);
      }
      current = p3;
      continue;
    }
    if (command === 'Q') {
      if (!started) throw new AppError('INVALID_MASK', 'Mask path must start with M.');
      const p0 = current, p1: MaskPoint = [read(), read()], p2: MaskPoint = [read(), read()];
      for (let step = 1; step <= 6; step++) {
        const t = step / 6, u = 1 - t;
        add([u ** 2 * p0[0] + 2 * u * t * p1[0] + t ** 2 * p2[0], u ** 2 * p0[1] + 2 * u * t * p1[1] + t ** 2 * p2[1]]);
      }
      current = p2;
      continue;
    }
    throw new AppError('INVALID_MASK', `Unsupported mask path command: ${command}`);
  }
  if (!closed || points.length < 3) throw new AppError('INVALID_MASK', 'Mask path must be a closed shape with at least three points (end with Z).');
  return points;
}

export function polygonPath(points: readonly MaskPoint[]): string {
  return points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${Number(x.toFixed(6))} ${Number(y.toFixed(6))}`).join(' ') + ' Z';
}

export function maskPathAt(mask: ClipMask, time: Rational): string {
  const frames = [{ time: rational(0), path: mask.path }, ...(mask.keyframes ?? [])].sort((a, b) => compare(a.time, b.time));
  const unique: typeof frames = [];
  for (const frame of frames) {
    if (unique.length && compare(unique[unique.length - 1].time, frame.time) === 0) unique[unique.length - 1] = frame;
    else unique.push(frame);
  }
  if (compare(time, unique[0].time) <= 0) return unique[0].path;
  for (let index = 1; index < unique.length; index++) {
    if (compare(time, unique[index].time) <= 0) {
      const left = unique[index - 1], right = unique[index];
      const start = Number(left.time.num) / Number(left.time.den), end = Number(right.time.num) / Number(right.time.den);
      const current = Number(time.num) / Number(time.den);
      const fraction = Math.max(0, Math.min(1, (current - start) / (end - start)));
      const a = maskPathPoints(left.path), b = maskPathPoints(right.path);
      if (a.length !== b.length) throw new AppError('INVALID_MASK', 'Tracked mask corrections must keep the same flattened path point count.');
      return polygonPath(a.map((point, pointIndex) => [point[0] + (b[pointIndex][0] - point[0]) * fraction, point[1] + (b[pointIndex][1] - point[1]) * fraction] as const));
    }
  }
  return unique[unique.length - 1].path;
}

export function splitMaskAnimation(mask: ClipMask, offset: Rational): { left: ClipMask; right: ClipMask } {
  const atSplit = maskPathAt(mask, offset);
  const leftFrames = (mask.keyframes ?? []).filter((frame) => compare(frame.time, offset) < 0).map((frame) => structuredClone(frame));
  leftFrames.push({ time: offset, path: atSplit });
  return {
    left: { ...structuredClone(mask), keyframes: leftFrames },
    right: {
      ...structuredClone(mask), path: atSplit,
      keyframes: (mask.keyframes ?? []).filter((frame) => compare(frame.time, offset) > 0).map((frame) => ({ ...structuredClone(frame), time: sub(frame.time, offset) }))
    }
  };
}

export function extendMaskAnimation(mask: ClipMask, extension: Rational): ClipMask {
  return { ...structuredClone(mask), keyframes: (mask.keyframes ?? []).map((frame) => ({ ...structuredClone(frame), time: add(frame.time, extension) })) };
}
