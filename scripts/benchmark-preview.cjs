const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { exportVideo } = require('../dist/src/core/export.js');
const { runCommand } = require('../dist/src/core/ffmpeg.js');
const { timelinePreviewCacheKey, timelinePreviewRangeAt } = require('../dist/src/core/timelinePreview.js');
const { parseDecimal, rational } = require('../dist/src/core/time.js');

const baselineFromBeforeChanges = {
  10: { firstFullRenderMs: 327.8, fullRenderAfterEditMs: 339.7 },
  60: { firstFullRenderMs: 1339, fullRenderAfterEditMs: 1336.6 }
};

async function renderCached(project, range, directory) {
  const key = timelinePreviewCacheKey(project, range, 'preview');
  const outputPath = path.join(directory, `${key}.mp4`);
  const started = performance.now();
  try { await fs.access(outputPath); return { hit: true, elapsedMs: Number((performance.now() - started).toFixed(1)), outputPath }; }
  catch { /* cache miss */ }
  await exportVideo(project, { outputPath, range, quality: 'preview' });
  return { hit: false, elapsedMs: Number((performance.now() - started).toFixed(1)), outputPath };
}

async function directoryBytes(directory) {
  const names = await fs.readdir(directory);
  const sizes = await Promise.all(names.map(async (name) => (await fs.stat(path.join(directory, name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clippulse-preview-benchmark-'));
  const rssBeforeBytes = process.memoryUsage().rss;
  try {
    const source = path.join(root, 'synthetic.mp4');
    await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source]);
    const stat = await fs.stat(source);
    const rows = [];
    for (const duration of [10, 60]) {
      const count = duration / 2;
      const project = {
        schemaVersion: 1, id: `preview-benchmark-${duration}`, name: `Synthetic ${duration}s`, createdAt: '', updatedAt: '',
        frameRate: rational(24), width: 320, height: 180,
        media: [{ id: 'synthetic-video', path: source, name: 'synthetic.mp4', kind: 'video', duration: rational(2), width: 320, height: 180, frameRate: rational(24), hasAudio: false, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), contentHash: 'synthetic-benchmark-media', importedAt: '' }],
        tracks: [{ id: 'video-1', name: 'V1', kind: 'video', muted: false, locked: false, clips: Array.from({ length: count }, (_unused, index) => ({
          id: `clip-${index}`, mediaId: 'synthetic-video', start: rational(index * 2), sourceIn: rational(0), duration: rational(2), audioEnabled: false, volume: 1
        })) }]
      };
      const fullTimings = [];
      for (let iteration = 0; iteration < 2; iteration++) {
        if (iteration === 1) project.tracks[0].clips[Math.floor(count / 2)].transform = { scale: 1.02, x: 0, y: 0, rotationDegrees: 0 };
        const started = performance.now();
        await exportVideo(project, { outputPath: path.join(root, `full-${duration}-${iteration}.mp4`), overwrite: true });
        fullTimings.push(Number((performance.now() - started).toFixed(1)));
      }
      const previewDirectory = path.join(root, `preview-cache-${duration}`);
      await fs.mkdir(previewDirectory);
      const range = timelinePreviewRangeAt(project, parseDecimal(String(duration / 2)));
      const firstPreview = await renderCached(project, range, previewDirectory);
      const repeatPreview = await renderCached(project, range, previewDirectory);
      const unrelatedEdit = structuredClone(project);
      const rangeStart = Number(range.start.num) / Number(range.start.den);
      const rangeEnd = rangeStart + Number(range.duration.num) / Number(range.duration.den);
      const outsideClip = unrelatedEdit.tracks[0].clips.find((clip) => {
        const clipStart = Number(clip.start.num) / Number(clip.start.den);
        const clipEnd = clipStart + Number(clip.duration.num) / Number(clip.duration.den);
        return clipStart >= rangeEnd || clipEnd <= rangeStart;
      });
      outsideClip.transform = { scale: 1.03, x: 0, y: 0, rotationDegrees: 0 };
      const unaffectedRange = await renderCached(unrelatedEdit, range, previewDirectory);
      const relevantEdit = structuredClone(unrelatedEdit);
      const changedClip = relevantEdit.tracks[0].clips.find((clip) => Number(clip.start.num) / Number(clip.start.den) < rangeEnd && Number(clip.start.num) / Number(clip.start.den) + Number(clip.duration.num) / Number(clip.duration.den) > rangeStart);
      changedClip.transform = { scale: 1.04, x: 0, y: 0, rotationDegrees: 0 };
      const affectedRange = await renderCached(relevantEdit, range, previewDirectory);
      const previewStat = await fs.stat(firstPreview.outputPath);
      const baseline = baselineFromBeforeChanges[duration];
      rows.push({
        timelineSeconds: duration,
        baselineFullRenderMs: baseline.firstFullRenderMs,
        baselineFullRenderAfterEditMs: baseline.fullRenderAfterEditMs,
        fullRenderMeasuredNowMs: fullTimings[0],
        fullRenderAfterEditMeasuredNowMs: fullTimings[1],
        prioritizedRangeSeconds: Number(range.duration.num) / Number(range.duration.den),
        previewCacheMissMs: firstPreview.elapsedMs,
        identicalPreviewCacheHitMs: repeatPreview.elapsedMs,
        unrelatedEditCacheHit: unaffectedRange.hit,
        unrelatedEditCacheHitMs: unaffectedRange.elapsedMs,
        inRangeEditCacheMiss: !affectedRange.hit,
        inRangeEditRenderMs: affectedRange.elapsedMs,
        previewCacheBytesAfterEditCases: await directoryBytes(previewDirectory),
        previewFileBytes: previewStat.size,
        fullFinalFileBytes: (await fs.stat(path.join(root, `full-${duration}-1.mp4`))).size
      });
    }
    const result = {
      benchmark: 'synthetic-timeline-preview-v1', platform: process.platform,
      ffmpeg: (await runCommand('ffmpeg', ['-version'])).stdout.split('\n')[0].trim(),
      sampledNodeRssBeforeBytes: rssBeforeBytes,
      sampledNodeRssBytes: process.memoryUsage().rss,
      sampledNodeRssDeltaBytes: process.memoryUsage().rss - rssBeforeBytes,
      note: 'RSS samples cover the benchmark Node process; FFmpeg child peak working set is not sampled.',
      cachePolicyBytes: 512 * 1024 * 1024,
      baselineFromBeforeChanges, results: rows
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const reportDirectory = path.resolve('reports');
    await fs.mkdir(reportDirectory, { recursive: true });
    await fs.writeFile(path.join(reportDirectory, 'preview-performance-latest.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
