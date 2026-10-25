'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runAgentE2E, retryReadOnly, transientTransportError } = require('../scripts/agent-e2e.cjs');

test('bounded recovery retries transient failures only for non-editing agent operations', async () => {
  let attempts = 0;
  let reconnects = 0;
  const result = await retryReadOnly(async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('pipe reset'), { code: 'ECONNRESET' });
    return 'recovered';
  }, transientTransportError, 3, async () => { reconnects++; });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(reconnects, 1);
  assert.equal(transientTransportError(Object.assign(new Error('bad input'), { code: 'INVALID_ARGUMENTS' })), false);
});

test('MCP client creates a music-length beat-synced montage, edits it, previews it, and verifies its MP4', { timeout: 300_000 }, async () => {
  const report = await runAgentE2E();
  assert.equal(report.status, 'passed', JSON.stringify(report, null, 2));
  assert.equal(report.sourceMode, 'synthetic-ffmpeg-media');
  assert.equal(report.successRate, 100);
  assert.deepEqual(report.failedActions, []);
  assert.equal(report.montage.durationSeconds, 35);
  assert.ok(report.montagePerformance.timingsMs.totalClipPulseWallMs > 0);
  assert.ok(Number.isFinite(report.montagePerformance.externalWork.ffmpegChildProcessWallMs));
  assert.ok(report.montagePerformance.externalWork.ffmpegChildProcessCount >= 0);
  assert.ok(report.montage.segmentCount >= 5);
  assert.ok(report.montage.alignmentErrorsFrames.every((error) => error === 0));
  assert.ok(Object.values(report.exportQuality.checks).every(Boolean));
  assert.equal(report.sourceMediaUnchanged, true);
});
