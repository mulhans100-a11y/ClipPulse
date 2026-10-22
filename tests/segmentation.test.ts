import assert from 'node:assert/strict';
import test from 'node:test';
import { maskPathPoints } from '../src/core/maskPath';
import { binaryMaskToPolygonPath, selectTrackedInstance, stabilizeMaskSequence, type BinaryMask } from '../src/core/modelSegmentation';

function rectangle(width: number, height: number, left: number, top: number, right: number, bottom: number): BinaryMask {
  const data = new Uint8Array(width * height);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) data[y * width + x] = 1;
  return { data, width, height };
}

test('model masks become a bounded closed polygon and ignore disconnected specks', () => {
  const mask = rectangle(20, 12, 3, 2, 12, 10);
  mask.data[0] = 1;
  const polygon = binaryMaskToPolygonPath(mask);
  assert.ok(polygon);
  const points = maskPathPoints(polygon);
  assert.equal(points.length, 32);
  assert.ok(Math.abs(Math.min(...points.map(([x]) => x)) - 0.15) < 0.01);
  assert.ok(Math.abs(Math.max(...points.map(([x]) => x)) - 0.6) < 0.01);
  assert.ok(Math.abs(Math.min(...points.map(([, y]) => y)) - 2 / 12) < 0.01);
  assert.ok(Math.abs(Math.max(...points.map(([, y]) => y)) - 10 / 12) < 0.01);
});

test('instance tracking follows overlap instead of switching to a higher-score object', () => {
  const first = rectangle(16, 10, 2, 2, 7, 8);
  const distractor = rectangle(16, 10, 10, 1, 15, 9);
  const tracked = selectTrackedInstance([
    { label: 'person', score: 0.45, mask: { ...first, channels: 1 } },
    { label: 'person', score: 0.99, mask: { ...distractor, channels: 1 } },
    { label: 'car', score: 0.99, mask: { ...distractor, channels: 1 } }
  ], 'PERSON', first, 0.3);
  assert.ok(tracked);
  assert.deepEqual(tracked.data, first.data);
});

test('temporal majority stabilization removes isolated mask flicker', () => {
  const previous = rectangle(12, 12, 2, 2, 10, 10);
  const flicker = rectangle(12, 12, 2, 2, 10, 10);
  flicker.data[5 * 12 + 5] = 0;
  const next = rectangle(12, 12, 2, 2, 10, 10);
  const stable = stabilizeMaskSequence([previous, flicker, next]);
  assert.equal(stable[1].data[5 * 12 + 5], 1);
});

test('successive generated contours preserve point topology and align their starting point', () => {
  const firstPath = binaryMaskToPolygonPath(rectangle(32, 20, 3, 3, 14, 16));
  assert.ok(firstPath);
  const reference = maskPathPoints(firstPath);
  const nextPath = binaryMaskToPolygonPath(rectangle(32, 20, 4, 3, 15, 16), reference);
  assert.ok(nextPath);
  const next = maskPathPoints(nextPath);
  assert.equal(next.length, reference.length);
  const meanStep = next.reduce((sum, point, index) => sum + Math.hypot(point[0] - reference[index][0], point[1] - reference[index][1]), 0) / next.length;
  assert.ok(meanStep < 0.1, `stable contour alignment should avoid point-order jumps, got ${meanStep}`);
});
