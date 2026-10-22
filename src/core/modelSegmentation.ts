import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors';
import { clipSourceOffsetAt } from './clipEffects';
import { runCommand } from './ffmpeg';
import { polygonPath } from './maskPath';
import { add, compare, decimal, rational, sub } from './time';
import type { ClipMask, Project, Rational, SegmentationOptions, SegmentationProgress, TimelineClip } from './types';

export const MODEL_SEGMENTATION_MODEL = 'Xenova/detr-resnet-50-panoptic';
export const MODEL_SEGMENTATION_REVISION = 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de';
export const MODEL_SEGMENTATION_MAX_FRAMES = 96;
const MODEL_SEGMENTATION_WIDTH = 512;
const PATH_VERTEX_COUNT = 32;

export interface BinaryMask {
  data: Uint8Array;
  width: number;
  height: number;
}

interface SegmentOutput {
  label: string | null;
  score: number | null;
  mask: { data: ArrayLike<number>; width: number; height: number; channels: number };
}

type Segmenter = (image: string, options: Record<string, unknown>) => Promise<SegmentOutput[]>;
type TransformerModule = {
  env: { cacheDir: string | null; logLevel: number };
  pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Segmenter>;
};

const modelPipelines = new Map<string, Promise<Segmenter>>();

async function loadSegmenter(cacheDirectory: string): Promise<Segmenter> {
  const key = path.resolve(cacheDirectory);
  const existing = modelPipelines.get(key);
  if (existing) return existing;
  const pending = (async () => {
    await fs.mkdir(key, { recursive: true });
    // Keep the heavyweight native inference runtime out of startup and load it only when requested.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<TransformerModule>;
    const transformers = await dynamicImport('@huggingface/transformers');
    transformers.env.cacheDir = key;
    transformers.env.logLevel = 40;
    return transformers.pipeline('image-segmentation', MODEL_SEGMENTATION_MODEL, {
      revision: MODEL_SEGMENTATION_REVISION,
      dtype: 'q8'
    });
  })();
  modelPipelines.set(key, pending);
  try { return await pending; }
  catch (error) { modelPipelines.delete(key); throw error; }
}

function normalizedLabel(label: string | null | undefined): string {
  return (label ?? '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function outputToBinaryMask(mask: SegmentOutput['mask']): BinaryMask {
  const channels = Math.max(1, mask.channels || 1);
  const expected = mask.width * mask.height * channels;
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 1 || mask.height < 1 || mask.data.length < expected) {
    throw new AppError('SEGMENTATION_INVALID_OUTPUT', 'The segmentation model returned an invalid mask image.');
  }
  const data = new Uint8Array(mask.width * mask.height);
  for (let index = 0; index < data.length; index++) {
    const pixel = mask.data[index * channels];
    data[index] = Number(pixel) > 0 ? 1 : 0;
  }
  return { data, width: mask.width, height: mask.height };
}

function maskArea(mask: BinaryMask): number {
  let area = 0;
  for (const value of mask.data) area += value ? 1 : 0;
  return area;
}

function intersectionOverUnion(left: BinaryMask, right: BinaryMask): number {
  if (left.width !== right.width || left.height !== right.height) return 0;
  let intersection = 0, union = 0;
  for (let index = 0; index < left.data.length; index++) {
    const a = left.data[index] !== 0, b = right.data[index] !== 0;
    if (a || b) union++;
    if (a && b) intersection++;
  }
  return union ? intersection / union : 0;
}

/** Selects one instance by class and follows the most-overlapping instance on later frames. */
export function selectTrackedInstance(outputs: SegmentOutput[], className: string, previous?: BinaryMask, scoreThreshold = 0.35): BinaryMask | null {
  const target = normalizedLabel(className);
  const candidates = outputs.filter((item) => normalizedLabel(item.label) === target && (item.score ?? 0.5) >= scoreThreshold)
    .map((item) => ({ mask: outputToBinaryMask(item.mask), score: item.score ?? 0.5 }))
    .filter((item) => item.mask.width * item.mask.height > 0 && maskArea(item.mask) >= item.mask.width * item.mask.height * 0.0005);
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const scoreA = previous ? intersectionOverUnion(previous, a.mask) * 0.85 + a.score * 0.15 : a.score;
    const scoreB = previous ? intersectionOverUnion(previous, b.mask) * 0.85 + b.score * 0.15 : b.score;
    return scoreB - scoreA;
  });
  return candidates[0].mask;
}

/** A temporal majority filter removes one-frame flicker while avoiding smoothing across scene cuts. */
export function stabilizeMaskSequence(input: BinaryMask[], minimumNeighborIou = 0.04): BinaryMask[] {
  if (!input.length) return [];
  const copies = input.map((mask) => ({ ...mask, data: new Uint8Array(mask.data) }));
  return copies.map((mask, index) => {
    if (index === 0 || index === copies.length - 1) return mask;
    const previous = copies[index - 1], next = copies[index + 1];
    if (mask.width !== previous.width || mask.width !== next.width || mask.height !== previous.height || mask.height !== next.height) return mask;
    if (intersectionOverUnion(mask, previous) < minimumNeighborIou || intersectionOverUnion(mask, next) < minimumNeighborIou) return mask;
    const data = new Uint8Array(mask.data.length);
    for (let pixel = 0; pixel < data.length; pixel++) {
      data[pixel] = Number(mask.data[pixel] !== 0) + Number(previous.data[pixel] !== 0) + Number(next.data[pixel] !== 0) >= 2 ? 1 : 0;
    }
    return { ...mask, data };
  });
}

function fillMissingInstances(input: BinaryMask[]): BinaryMask[] {
  const visible = input.map((mask, index) => maskArea(mask) > 0 ? index : -1).filter((index) => index >= 0);
  if (!visible.length) return input;
  return input.map((mask, index) => {
    if (maskArea(mask) > 0) return mask;
    const nearest = visible.reduce((best, candidate) => Math.abs(candidate - index) < Math.abs(best - index) ? candidate : best, visible[0]);
    return { ...input[nearest], data: new Uint8Array(input[nearest].data) };
  });
}

function largestComponent(mask: BinaryMask): BinaryMask | null {
  const { width, height, data } = mask;
  const visited = new Uint8Array(data.length);
  const queue = new Int32Array(data.length);
  let largest: number[] = [];
  const neighbors = [-width, -1, 1, width];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || visited[start]) continue;
    let head = 0, tail = 0;
    const component: number[] = [];
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head++];
      component.push(pixel);
      const x = pixel % width;
      for (const offset of neighbors) {
        const adjacent = pixel + offset;
        if (adjacent < 0 || adjacent >= data.length || visited[adjacent] || !data[adjacent]) continue;
        if ((offset === -1 && x === 0) || (offset === 1 && x === width - 1)) continue;
        visited[adjacent] = 1;
        queue[tail++] = adjacent;
      }
    }
    if (component.length > largest.length) largest = component;
  }
  if (!largest.length) return null;
  const result = new Uint8Array(data.length);
  for (const index of largest) result[index] = 1;
  return { data: result, width, height };
}

interface Edge { from: number; to: number; direction: number; used: boolean; }
function vertexKey(x: number, y: number): number { return y * 65536 + x; }
function vertexFromKey(key: number): readonly [number, number] { return [key % 65536, Math.floor(key / 65536)]; }

function outerContour(mask: BinaryMask): Array<readonly [number, number]> | null {
  const component = largestComponent(mask);
  if (!component) return null;
  const { width, height, data } = component;
  const edges: Edge[] = [];
  const outgoing = new Map<number, number[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number, direction: number) => {
    const edgeIndex = edges.length;
    const key = vertexKey(x1, y1);
    edges.push({ from: key, to: vertexKey(x2, y2), direction, used: false });
    const entries = outgoing.get(key) ?? [];
    entries.push(edgeIndex);
    outgoing.set(key, entries);
  };
  const has = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && data[y * width + x] !== 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!has(x, y)) continue;
    if (!has(x, y - 1)) addEdge(x, y, x + 1, y, 0);
    if (!has(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, 1);
    if (!has(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, 2);
    if (!has(x - 1, y)) addEdge(x, y + 1, x, y, 3);
  }
  let best: Array<readonly [number, number]> = [];
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex++) {
    if (edges[firstIndex].used) continue;
    const start = edges[firstIndex].from;
    let edgeIndex = firstIndex;
    const contour: Array<readonly [number, number]> = [];
    for (let step = 0; step <= edges.length; step++) {
      const edge = edges[edgeIndex];
      if (edge.used) break;
      edge.used = true;
      contour.push(vertexFromKey(edge.from));
      if (edge.to === start) break;
      const available = (outgoing.get(edge.to) ?? []).filter((index) => !edges[index].used);
      if (!available.length) break;
      const priority = [(edge.direction + 1) % 4, edge.direction, (edge.direction + 3) % 4, (edge.direction + 2) % 4];
      edgeIndex = available.sort((a, b) => priority.indexOf(edges[a].direction) - priority.indexOf(edges[b].direction))[0];
    }
    if (contour.length < 4 || edges[edgeIndex]?.to !== start) continue;
    const area = Math.abs(contour.reduce((sum, point, index) => {
      const next = contour[(index + 1) % contour.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0));
    const bestArea = Math.abs(best.reduce((sum, point, index) => {
      const next = best[(index + 1) % best.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0));
    if (area > bestArea) best = contour;
  }
  return best.length ? best : null;
}

function resampleContour(contour: Array<readonly [number, number]>, count: number, reference?: Array<readonly [number, number]>): Array<readonly [number, number]> {
  const lengths: number[] = [];
  let perimeter = 0;
  for (let index = 0; index < contour.length; index++) {
    const from = contour[index], to = contour[(index + 1) % contour.length];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    lengths.push(length);
    perimeter += length;
  }
  if (perimeter === 0) return [];
  const sampled: Array<readonly [number, number]> = [];
  for (let sample = 0; sample < count; sample++) {
    let distance = perimeter * sample / count;
    let index = 0;
    while (index < lengths.length - 1 && distance > lengths[index]) distance -= lengths[index++];
    const from = contour[index], to = contour[(index + 1) % contour.length];
    const fraction = lengths[index] ? distance / lengths[index] : 0;
    sampled.push([from[0] + (to[0] - from[0]) * fraction, from[1] + (to[1] - from[1]) * fraction]);
  }
  if (reference?.length === count) {
    let best = sampled, bestCost = Infinity;
    for (const reversed of [false, true]) for (let shift = 0; shift < count; shift++) {
      let cost = 0;
      for (let index = 0; index < count; index++) {
        const sourceIndex = reversed ? (shift - index + count * 2) % count : (shift + index) % count;
        const dx = sampled[sourceIndex][0] - reference[index][0], dy = sampled[sourceIndex][1] - reference[index][1];
        cost += dx * dx + dy * dy;
      }
      if (cost < bestCost) { bestCost = cost; best = Array.from({ length: count }, (_, index) => sampled[reversed ? (shift - index + count * 2) % count : (shift + index) % count]); }
    }
    return best;
  }
  let first = 0;
  for (let index = 1; index < sampled.length; index++) {
    if (sampled[index][1] < sampled[first][1] || (sampled[index][1] === sampled[first][1] && sampled[index][0] < sampled[first][0])) first = index;
  }
  return Array.from({ length: count }, (_, index) => sampled[(first + index) % count]);
}

/** Convert a binary model mask to a simple, fixed-topology polygon path. */
export function binaryMaskToPolygonPath(mask: BinaryMask, reference?: Array<readonly [number, number]>, pointCount = PATH_VERTEX_COUNT): string | null {
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 2 || mask.height < 2 || mask.data.length !== mask.width * mask.height) return null;
  const contour = outerContour(mask);
  if (!contour) return null;
  const points = resampleContour(contour, pointCount, reference);
  if (points.length !== pointCount) return null;
  return polygonPath(points.map(([x, y]) => [Math.max(0, Math.min(1, x / mask.width)), Math.max(0, Math.min(1, y / mask.height))] as const));
}

function sampleTimes(duration: Rational, requestedFps: number, frameRate: Rational): Rational[] {
  const lastVisible = compare(duration, rational(BigInt(frameRate.den), BigInt(frameRate.num))) > 0
    ? sub(duration, rational(BigInt(frameRate.den), BigInt(frameRate.num)))
    : rational(0);
  const seconds = Number(lastVisible.num) / Number(lastVisible.den);
  if (!Number.isFinite(seconds) || seconds < 0) throw new AppError('INVALID_CLIP_DURATION', 'Segmentation requires a positive clip duration.');
  const fps = Math.min(requestedFps, (MODEL_SEGMENTATION_MAX_FRAMES - 1) / seconds);
  const count = seconds <= 0 ? 1 : Math.max(2, Math.min(MODEL_SEGMENTATION_MAX_FRAMES, Math.ceil(seconds * fps) + 1));
  if (count === 1) return [rational(0)];
  return Array.from({ length: count }, (_, index) => rational(BigInt(index) * BigInt(lastVisible.num), BigInt(count - 1) * BigInt(lastVisible.den)));
}

function extractionFilters(clip: TimelineClip, project: Project): string {
  const targetHeight = Math.max(2, Math.round(MODEL_SEGMENTATION_WIDTH * project.height / project.width));
  const filters = [
    `scale=${MODEL_SEGMENTATION_WIDTH}:${targetHeight}:force_original_aspect_ratio=decrease`,
    `pad=${MODEL_SEGMENTATION_WIDTH}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1'
  ];
  const transform = clip.transform ?? { scale: 1, x: 0, y: 0, rotationDegrees: 0 };
  if (transform.scale !== 1) filters.push(`scale=round(iw*${transform.scale}/2)*2:round(ih*${transform.scale}/2)*2`);
  if (transform.rotationDegrees !== 0) filters.push(`rotate=${transform.rotationDegrees}*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0`);
  filters.push("scale=512:512:force_original_aspect_ratio=decrease");
  return filters.join(',');
}

export async function generateClipModelMask(
  sourcePath: string,
  clip: TimelineClip,
  project: Project,
  cacheDirectory: string,
  options: SegmentationOptions = {},
  onProgress?: (progress: SegmentationProgress) => void
): Promise<ClipMask> {
  const className = (options.className ?? 'person').trim();
  const sampleFps = options.sampleFps ?? 2;
  const scoreThreshold = options.scoreThreshold ?? 0.35;
  if (!className || className.length > 80) throw new AppError('INVALID_ARGUMENTS', 'Segmentation class name must contain 1–80 characters.');
  if (!Number.isFinite(sampleFps) || sampleFps < 0.25 || sampleFps > 8) throw new AppError('INVALID_ARGUMENTS', 'Segmentation sample rate must be between 0.25 and 8 frames per second.');
  if (!Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) throw new AppError('INVALID_ARGUMENTS', 'Segmentation score threshold must be between 0 and 1.');
  const times = sampleTimes(clip.duration, sampleFps, project.frameRate);
  const workDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openmontage-segmentation-'));
  try {
    onProgress?.({ stage: 'loading-model', current: 0, total: times.length });
    const segmenter = await loadSegmenter(cacheDirectory);
    const filters = extractionFilters(clip, project);
    const rawMasks: BinaryMask[] = [];
    let previous: BinaryMask | undefined;
    let emptyTemplate: BinaryMask | undefined;
    for (let index = 0; index < times.length; index++) {
      const localTime = times[index];
      const sourceTime = add(clip.sourceIn, clipSourceOffsetAt(clip, localTime));
      const framePath = path.join(workDirectory, `frame-${String(index).padStart(4, '0')}.png`);
      onProgress?.({ stage: 'extracting', current: index + 1, total: times.length });
      await runCommand('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', decimal(sourceTime, 9), '-i', sourcePath,
        '-vf', filters, '-frames:v', '1', '-update', '1', framePath
      ]);
      if (!emptyTemplate) {
        const probe = await runCommand('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', framePath]);
        const dimensions = JSON.parse(probe.stdout).streams?.[0];
        if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height)) throw new AppError('SEGMENTATION_INVALID_FRAME', 'FFmpeg could not read the extracted segmentation frame dimensions.');
        emptyTemplate = { data: new Uint8Array(dimensions.width * dimensions.height), width: dimensions.width, height: dimensions.height };
      }
      onProgress?.({ stage: 'segmenting', current: index + 1, total: times.length });
      // Let Transformers.js infer and bind the processor's panoptic postprocessor. Passing
      // `subtask: 'panoptic'` explicitly currently leaves that callback unbound in v4.3.1.
      const outputs = await segmenter(framePath, { threshold: scoreThreshold, mask_threshold: 0.5 });
      const mask = selectTrackedInstance(outputs, className, previous, scoreThreshold);
      if (mask) { rawMasks.push(mask); previous = mask; }
      else {
        const sampleSize = previous ?? (outputs[0] ? outputToBinaryMask(outputs[0].mask) : emptyTemplate)!;
        rawMasks.push({ data: new Uint8Array(sampleSize.data.length), width: sampleSize.width, height: sampleSize.height });
      }
    }
    if (!rawMasks.some((mask) => maskArea(mask) > 0)) throw new AppError('SEGMENTATION_NO_MATCH', `The model found no "${className}" instance in this clip. Try a COCO class such as person, car, cat, dog, chair, or bottle, or use a manual mask.`);
    onProgress?.({ stage: 'stabilizing', current: times.length, total: times.length });
    const stabilized = stabilizeMaskSequence(fillMissingInstances(rawMasks));
    const paths: string[] = [];
    let previousPoints: Array<readonly [number, number]> | undefined;
    for (const mask of stabilized) {
      const polygon = binaryMaskToPolygonPath(mask, previousPoints);
      if (!polygon) throw new AppError('SEGMENTATION_INVALID_OUTPUT', 'The model mask could not be converted to a stable closed outline.');
      paths.push(polygon);
      previousPoints = polygonToNormalizedPoints(polygon).map(([x, y]) => [x * mask.width, y * mask.height] as const);
    }
    const keyframes = times.slice(1).map((time, index) => ({ time, path: paths[index + 1] }));
    return {
      path: paths[0], featherPx: 2, expansionPx: 0, keyframes,
      provenance: {
        modelId: MODEL_SEGMENTATION_MODEL,
        revision: MODEL_SEGMENTATION_REVISION,
        className,
        sampleCount: times.length,
        stabilization: times.length > 1 ? 'temporal-majority-v1' : 'single-frame-v1'
      }
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SEGMENTATION_FAILED', `Could not generate the model mask: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function polygonToNormalizedPoints(pathData: string): Array<readonly [number, number]> {
  const values = pathData.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const points: Array<readonly [number, number]> = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push([values[index], values[index + 1]]);
  return points;
}
