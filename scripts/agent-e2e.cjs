'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { mkdir, mkdtemp, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'main', 'cli.js');
const packageInfo = require('../package.json');
const commandTimeoutMs = 180_000;
const actionResults = [];

function run(command, args, timeout = commandTimeoutMs) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-4000);
    throw new Error(`${path.basename(command)} exited with ${result.status ?? 'unknown'}.${details ? ` ${details}` : ''}`);
  }
  return result;
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function transientTransportError(error) {
  const codes = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ERR_STREAM_PREMATURE_CLOSE']);
  for (let current = error; current; current = current.cause) if (codes.has(current.code)) return true;
  return /transport.*closed|connection.*closed|process.*exited/i.test(error?.message ?? '');
}

async function retryReadOnly(operation, retry, attempts = 3, onRetry = async () => undefined) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || !retry(error)) throw error;
      await onRetry(error, attempt);
      await delay(100 * (2 ** (attempt - 1)));
    }
  }
}

class McpSession {
  constructor(allowedRoots) {
    this.allowedRoots = allowedRoots;
    this.client = undefined;
    this.transport = undefined;
    this.lastContent = [];
    this.retries = 0;
  }

  async connect() {
    const client = new Client({ name: 'clippulse-agent-e2e', version: packageInfo.version });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'mcp-server', ...this.allowedRoots.flatMap((root) => ['--allow-root', root])],
      cwd: projectRoot
    });
    this.client = client;
    this.transport = transport;
    await client.connect(transport);
    return { server: client.getServerVersion() };
  }

  async call(name, args = {}, retryable = false) {
    const execute = async () => {
      if (!this.client) await this.connect();
      const result = await this.client.callTool({ name, arguments: args });
      if (result.isError) {
        const envelope = result.structuredContent;
        const detail = envelope?.error ?? result.content?.find((item) => item.type === 'text')?.text ?? 'MCP tool call failed.';
        const error = new Error(typeof detail === 'string' ? detail : `${detail.code}: ${detail.message}`);
        error.code = detail?.code ?? envelope?.error?.code ?? 'MCP_TOOL_FAILED';
        throw error;
      }
      const envelope = result.structuredContent;
      if (!envelope || envelope.ok !== true || envelope.schemaVersion !== 1) throw new Error(`MCP ${name} returned no valid versioned result.`);
      this.lastContent = result.content ?? [];
      return envelope.data;
    };
    if (!retryable) return execute();
    return retryReadOnly(execute, transientTransportError, 3, async () => {
      this.retries++;
      await this.close();
      await this.connect();
    });
  }

  async close() {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}

async function action(name, work, retries = () => 0) {
  const started = performance.now();
  const retriesBefore = retries();
  try {
    const value = await work();
    actionResults.push({ name, status: 'passed', attempts: 1 + retries() - retriesBefore, durationMs: Math.round(performance.now() - started) });
    return value;
  } catch (error) {
    actionResults.push({ name, status: 'failed', attempts: 1 + retries() - retriesBefore, durationMs: Math.round(performance.now() - started), error: { code: error.code ?? 'UNEXPECTED_ERROR', message: String(error.message).slice(0, 500) } });
    throw error;
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function rationalText(value) { return `${value.num}/${value.den}`; }
function rationalHalfText(value) { return `${value.num}/${BigInt(value.den) * 2n}`; }
function fileName(filePath) { return path.basename(filePath); }
function redact(value, paths) {
  if (typeof value === 'string') return paths.reduce((result, sourcePath) => result.split(sourcePath).join('[local media]'), value);
  if (Array.isArray(value)) return value.map((item) => redact(item, paths));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, paths)]));
  return value;
}

async function loadRealManifest(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.videoPaths) || manifest.videoPaths.length !== 20 || typeof manifest.musicPath !== 'string') {
    throw new Error('A real-media manifest must contain exactly 20 videoPaths and one musicPath.');
  }
  const paths = [...manifest.videoPaths, manifest.musicPath].map((value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Every real-media path must be absolute.');
    return path.resolve(value);
  });
  if (new Set(paths).size !== paths.length) throw new Error('The real-media manifest must list 20 distinct videos and a separate music file.');
  return { videoPaths: paths.slice(0, 20), musicPath: paths[20] };
}

async function runAgentE2E(options = {}) {
  actionResults.length = 0;
  const started = performance.now();
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z');
  const reportDirectory = path.resolve(options.reportDirectory ?? path.join(projectRoot, 'test-results'));
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `agent-e2e-v${packageInfo.version}-${process.platform}-${process.arch}-${stamp}.json`);
  const report = {
    schemaVersion: 1,
    appVersion: packageInfo.version,
    platform: `${process.platform}/${process.arch}`,
    sourceMode: options.manifestPath ? 'optional-local-20-clip-manifest' : 'synthetic-ffmpeg-media',
    status: 'running',
    actions: actionResults,
    failedActions: [],
    retryCount: 0,
    corrections: { agentOperationCorrectionsRequired: 0, acceptedHighlightReviews: 0, timelineEffectsApplied: 0, automaticRetries: 0 },
    exportQuality: null
  };
  let workspace;
  let session;
  let importedHashes = [];
  let exportPath;
  let realSourcePaths = [];
  let keepWorkspace = options.keepArtifacts ?? process.env.CLIPPULSE_KEEP_AGENT_E2E_ARTIFACTS === '1';
  try {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'ClipPulse agent E2E '));
    const mediaDirectory = path.join(workspace, 'synthetic media');
    await mkdir(mediaDirectory, { recursive: true });
    const videoPaths = [];
    let musicPath;
    if (options.manifestPath) {
      const manifest = await action('read local 20-clip manifest', () => loadRealManifest(options.manifestPath));
      videoPaths.push(...manifest.videoPaths);
      musicPath = manifest.musicPath;
    } else {
      const videoPath = path.join(mediaDirectory, 'synthetic-gameplay.mp4');
      musicPath = path.join(mediaDirectory, 'synthetic-beat-track.wav');
      await action('generate synthetic scene-change gameplay with FFmpeg', async () => {
        run('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=35',
          '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=red:t=fill:enable='lt(mod(t,2),1)',drawbox=x=0:y=0:w=iw:h=ih:color=lime:t=fill:enable='gte(mod(t,2),1)'",
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoPath
        ]);
        run('ffmpeg', [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
          'aevalsrc=if(lt(mod(t\\,0.5)\\,0.02)\\,0.8*sin(2*PI*1200*t)\\,0):s=48000:d=35', '-c:a', 'pcm_s16le', musicPath
        ]);
      });
      videoPaths.push(videoPath);
    }
    const rootGrants = [...new Set([workspace, ...videoPaths.map((file) => path.dirname(file)), path.dirname(musicPath)])];
    const projectPath = path.join(workspace, 'agent montage.omproj');
    exportPath = path.join(workspace, `ClipPulse-${packageInfo.version}-agent-e2e.mp4`);
    const sourceFiles = [...videoPaths, musicPath];
    if (options.manifestPath) realSourcePaths = sourceFiles;
    const sourceStats = await Promise.all(sourceFiles.map(async (file) => {
      const info = await stat(file);
      if (!info.isFile()) throw new Error(`Media source must be a regular file: ${fileName(file)}`);
      return { name: fileName(file), sizeBytes: info.size, mtimeMs: info.mtimeMs };
    }));

    session = new McpSession(rootGrants);
    const connected = await action('connect through the official MCP TypeScript client', () => session.connect(), () => session.retries);
    assert.equal(connected.server?.name, 'clippulse');
    assert.equal(connected.server?.version, packageInfo.version);
    const listed = await action('discover tools through MCP tools/list', () => session.client.listTools(), () => session.retries);
    const toolNames = new Set(listed.tools.map((item) => item.name));
    for (const name of ['diagnostics', 'project_create', 'media_import', 'audio_analyze', 'highlights_detect', 'montage_generate', 'effect_update', 'project_validate', 'preview_render', 'preview_analyze', 'quality_analyze', 'quality_report_get', 'quality_report_list', 'quality_improve', 'video_export', 'render_status']) assert.ok(toolNames.has(name), `MCP tools/list is missing ${name}`);

    const diagnostics = await action('diagnose FFmpeg and FFprobe', () => session.call('diagnostics', {}, true), () => session.retries);
    assert.equal(diagnostics.ffmpeg.ffmpeg, true, diagnostics.ffmpeg.message);
    assert.equal(diagnostics.ffmpeg.ffprobe, true, diagnostics.ffmpeg.message);
    assert.equal(diagnostics.ffmpeg.compatible, true, diagnostics.ffmpeg.message);

    const created = await action('create project', () => session.call('project_create', { projectPath, name: 'Agent 30-second edit', width: 320, height: 180, frameRate: '24/1' }));
    assert.equal(created.project.name, 'Agent 30-second edit');
    const opened = await action('open created project', () => session.call('project_open', { projectPath }, true), () => session.retries);
    assert.equal(opened.project.id, created.project.id);

    const imported = await action('import video clips and music', () => session.call('media_import', { projectPath, paths: [...videoPaths, musicPath], recursive: false }));
    const videoAssets = imported.added.filter((item) => item.kind === 'video');
    const musicAsset = imported.added.find((item) => item.kind === 'audio');
    assert.equal(videoAssets.length, videoPaths.length, `Expected ${videoPaths.length} imported videos, got ${videoAssets.length}.`);
    assert.ok(musicAsset?.hasAudio, 'The imported music must contain an audio stream.');
    importedHashes = [...videoAssets, musicAsset].map((asset) => asset.contentHash);

    const music = await action('analyze music and beats', () => session.call('audio_analyze', { projectPath, mediaId: musicAsset.id }, true), () => session.retries);
    assert.ok(music.beatGrid.beats.length >= 20, `Expected a useful beat grid, received ${music.beatGrid.beats.length} beats.`);
    report.musicAnalysis = { bpm: music.beatGrid.bpm, beatCount: music.beatGrid.beats.length, downbeatCount: music.beatGrid.downbeats.length, meter: music.beatGrid.meter ?? null };

    const rankedByVideo = [];
    for (const [videoIndex, video] of videoAssets.entries()) {
      const videoLabel = options.manifestPath ? `local clip ${String(videoIndex + 1).padStart(2, '0')}` : fileName(video.path);
      const detected = await action(`analyze video highlights: ${videoLabel}`, () => session.call('highlights_detect', { projectPath, mediaId: video.id }, true), () => session.retries);
      const ranked = await action(`rank highlights: ${videoLabel}`, () => session.call('highlights_rank', { projectPath, mediaId: video.id, minimumScore: 1 }, true), () => session.retries);
      const selected = ranked.events.slice(0, options.manifestPath ? 3 : 24);
      if (selected.length) {
        await action(`select accepted highlights: ${videoLabel}`, () => session.call('media_update', {
          projectPath, mediaId: video.id,
          favorite: false,
          analysisEventReviews: selected.map((event) => ({
            eventId: event.id,
            detectorIds: event.detectors.map((detector) => detector.detectorId),
            status: 'accepted', startSeconds: event.startSeconds, decisiveSeconds: event.decisiveSeconds,
            endSeconds: event.endSeconds, updatedAt: new Date().toISOString()
          }))
        }));
        report.corrections.acceptedHighlightReviews += selected.length;
      }
      rankedByVideo.push({ mediaId: video.id, detected: detected.events.length, ranked: ranked.events.length, selected: selected.length });
    }
    const selectedVideos = videoAssets.filter((video) => rankedByVideo.find((item) => item.mediaId === video.id)?.selected > 0);
    assert.ok(selectedVideos.length, 'At least one video must produce a selectable highlight.');
    report.highlights = { videoCount: videoAssets.length, selectedVideoCount: selectedVideos.length, detectedEventCount: rankedByVideo.reduce((sum, item) => sum + item.detected, 0), selectedEventCount: rankedByVideo.reduce((sum, item) => sum + item.selected, 0) };
    const sampleEvent = (await session.call('highlights_rank', { projectPath, mediaId: selectedVideos[0].id }, true)).events[0];
    if (sampleEvent) await action('inspect source video frames at selected highlight', () => session.call('media_get_frames', { projectPath, mediaId: selectedVideos[0].id, times: [sampleEvent.decisiveSeconds] }, true), () => session.retries);

    const montage = await action('generate editable 30-second beat-aligned montage', () => session.call('montage_generate', {
      projectPath, musicId: musicAsset.id, durationSeconds: 30, style: 'velocity', videoIds: selectedVideos.map((item) => item.id), variants: 1, intensity: 55, format: 'project', outputDirectory: path.join(workspace, 'generated montages')
    }));
    assert.equal(montage.variants.length, 1);
    const variant = montage.variants[0];
    const plan = JSON.parse(await readFile(variant.planPath, 'utf8'));
    assert.equal(plan.durationSeconds, 30);
    assert.ok(plan.segments.length >= 5, 'A 30-second montage should contain multiple edited shots.');
    assert.ok(plan.segments.every((segment) => segment.alignmentErrorFrames === 0), 'Every shot should map its decisive event to its selected music beat without a frame error.');
    report.montage = { project: fileName(variant.projectPath), style: variant.style, durationSeconds: plan.durationSeconds, segmentCount: plan.segments.length, anchorKinds: [...new Set(plan.segments.map((segment) => segment.anchorKind))], alignmentErrorsFrames: plan.segments.map((segment) => segment.alignmentErrorFrames), score: variant.score };

    const generated = await action('open generated montage project', () => session.call('project_open', { projectPath: variant.projectPath }, true), () => session.retries);
    const videoTrack = generated.project.tracks.find((track) => track.kind === 'video');
    const clip = videoTrack?.clips[0];
    assert.ok(clip, 'Generated montage must have a video clip.');
    await action('apply zoom, color effect, transition and speed ramp', () => session.call('effect_update', {
      projectPath: variant.projectPath, clipId: clip.id,
      effects: {
        transform: { scale: 1.12, x: 0, y: 0, rotationDegrees: 0 },
        color: { brightness: 0.02, contrast: 1, saturation: 1.05 },
        transitionIn: { type: 'dissolve', duration: '1/4' },
        speedKeyframes: [
          { time: '0/1', rate: '1/1' },
          { time: rationalHalfText(clip.duration), rate: '3/4' },
          { time: rationalText(clip.duration), rate: '1/1' }
        ]
      }
    }));
    report.corrections.timelineEffectsApplied = 4;

    const timeline = await action('inspect edited timeline', () => session.call('timeline_inspect', { projectPath: variant.projectPath }, true), () => session.retries);
    assert.equal(BigInt(timeline.duration.num) / BigInt(timeline.duration.den), 30n);
    assert.equal(timeline.clipCount, plan.segments.length + 1, 'Montage timeline should contain each video segment and one music clip.');
    const validation = await action('validate project and granted media', () => session.call('project_validate', { projectPath: variant.projectPath }, true), () => session.retries);
    assert.equal(validation.valid, true, JSON.stringify(validation.media.filter((item) => !item.exists || !item.permitted)));

    const preview = await action('render composite preview frame', () => session.call('preview_render', { projectPath: variant.projectPath, time: '15/1' }, true), () => session.retries);
    assert.equal(preview.mimeType, 'image/png');
    const previewImage = session.lastContent.find((item) => item.type === 'image' && item.mimeType === 'image/png');
    assert.ok(previewImage && Buffer.from(previewImage.data ?? '', 'base64').length > 100, 'MCP preview should be returned as a valid image content block.');
    const previewAnalysis = await action('analyze preview frame', () => session.call('preview_analyze', { projectPath: variant.projectPath, time: '15/1' }, true), () => session.retries);
    const averageLuma = previewAnalysis.statistics?.yavg;
    assert.ok(Number.isFinite(averageLuma) && averageLuma > 2, `Preview frame appears empty or black (YAVG=${averageLuma}).`);
    report.preview = { width: previewAnalysis.width, height: previewAnalysis.height, frame: previewAnalysis.frame, averageLuma };

    const qualityReport = await action('inspect montage quality through MCP', () => session.call('quality_analyze', { projectPath: variant.projectPath, renderAudio: false }, true), () => session.retries);
    assert.equal(qualityReport.schemaVersion, 1);
    assert.ok(qualityReport.previewFrames.length > 0, 'Quality analysis should return representative preview frames.');
    assert.ok(qualityReport.findings.some((item) => item.code === 'transition_not_rendered'), 'The stored transition must be reported when the shared renderer cannot apply it.');
    const savedQuality = await action('retrieve persisted quality report through MCP', () => session.call('quality_report_get', { projectPath: variant.projectPath, reportId: qualityReport.reportId }, true), () => session.retries);
    assert.equal(savedQuality.reportId, qualityReport.reportId);
    report.quality = { reportId: qualityReport.reportId, summary: qualityReport.summary, findingCodes: qualityReport.findings.map((item) => item.code), previewFrames: qualityReport.previewFrames.length, persisted: true };

    const job = await action('start validated MP4 export', () => session.call('video_export', { projectPath: variant.projectPath, outputPath: exportPath, overwrite: false }));
    let status = job;
    const deadline = Date.now() + 240_000;
    while (status.status === 'running' && Date.now() < deadline) {
      await delay(250);
      status = await action('poll export job', () => session.call('render_status', { projectPath: variant.projectPath, jobId: job.id }, true), () => session.retries);
    }
    assert.equal(status.status, 'complete', JSON.stringify(status.error));

    const probe = JSON.parse(run('ffprobe', [
      '-v', 'error', '-count_frames', '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,bit_rate', '-of', 'json', exportPath
    ]).stdout);
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video');
    const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
    const expectedFrameCount = Math.round(30 * 24);
    const outputStat = await stat(exportPath);
    const quality = {
      fileName: fileName(exportPath), sizeBytes: outputStat.size,
      durationSeconds: Number(probe.format.duration), videoCodec: videoStream?.codec_name, audioCodec: audioStream?.codec_name,
      width: videoStream?.width, height: videoStream?.height, pixelFormat: videoStream?.pix_fmt,
      frameRate: videoStream?.avg_frame_rate, frameCount: Number(videoStream?.nb_read_frames),
      bitrate: Number(probe.format.bit_rate ?? videoStream?.bit_rate ?? 0),
      checks: {
        nonEmpty: outputStat.size > 10_000,
        h264Video: videoStream?.codec_name === 'h264',
        aacAudio: audioStream?.codec_name === 'aac',
        dimensions: videoStream?.width === 320 && videoStream?.height === 180,
        frameCount: Number(videoStream?.nb_read_frames) === expectedFrameCount,
        duration: Math.abs(Number(probe.format.duration) - 30) <= 1 / 24
      }
    };
    assert.ok(Object.values(quality.checks).every(Boolean), `FFprobe export quality checks failed: ${JSON.stringify(quality)}`);
    report.exportQuality = quality;

    const finalHashes = await Promise.all(sourceFiles.map((file) => sha256File(file)));
    assert.deepEqual(finalHashes, importedHashes, 'All original video and music files must remain unchanged.');
    report.sourceMediaUnchanged = true;
    report.recovery = { retryPolicy: 'Only non-editing MCP requests are retried, at most three attempts with exponential backoff and reconnection; editing requests are never replayed automatically.', interruptedTransactions: 'Recovered from the persistent per-project transaction snapshot on the next request.', interruptedExports: 'render_status reports RENDER_INTERRUPTED; a fresh video_export can resume the workflow.' };
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { code: error.code ?? 'UNEXPECTED_ERROR', message: String(error.message).slice(0, 1000) };
    if (!actionResults.some((item) => item.status === 'failed')) actionResults.push({ name: 'end-to-end validation', status: 'failed', attempts: 1, durationMs: 0, error: report.error });
  } finally {
    if (session) await session.close();
    report.elapsedMs = Math.round(performance.now() - started);
    report.actions = [...actionResults];
    report.failedActions = report.actions.filter((item) => item.status === 'failed');
    report.retryCount = session?.retries ?? 0;
    report.corrections.automaticRetries = report.retryCount;
    report.successRate = report.actions.length ? Number((100 * (report.actions.length - report.failedActions.length) / report.actions.length).toFixed(2)) : 0;
    report.reportFile = fileName(reportPath);
    if (keepWorkspace && workspace) report.retainedWorkspace = workspace;
    if (options.writeReport ?? true) await writeFile(reportPath, `${JSON.stringify(redact(report, realSourcePaths), null, 2)}\n`, 'utf8');
    if (workspace && !keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
  return report;
}

function parseArguments(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--real-manifest') result.manifestPath = path.resolve(argv[++i]);
    else if (argv[i] === '--keep-artifacts') result.keepArtifacts = true;
    else if (argv[i] === '--report-directory') result.reportDirectory = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!result.manifestPath && process.env.CLIPPULSE_REAL_MEDIA_MANIFEST) result.manifestPath = path.resolve(process.env.CLIPPULSE_REAL_MEDIA_MANIFEST);
  return result;
}

if (require.main === module) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
  if (options) runAgentE2E(options).then((report) => {
    console.log(JSON.stringify({ status: report.status, successRate: report.successRate, failedActions: report.failedActions.length, retryCount: report.retryCount, elapsedMs: report.elapsedMs, exportQuality: report.exportQuality, reportFile: report.reportFile, ...(report.retainedWorkspace ? { retainedWorkspace: report.retainedWorkspace } : {}), ...(report.error ? { error: report.error } : {}) }, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { runAgentE2E, retryReadOnly, transientTransportError };
