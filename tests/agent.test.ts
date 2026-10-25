import assert from 'node:assert/strict';
import { access, copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentService, normalizePacingIntensity } from '../src/main/agent';
import { startAgentRest } from '../src/main/agentRest';
import { runAgentMcp } from '../src/main/agentMcp';
import { APP_VERSION } from '../src/core/appVersion';
import { getProjectHistory, loadProject, projectHistoryPath } from '../src/core/project';
import { projectCachePath } from '../src/core/project';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../src/core/ffmpeg';

const scratch: string[] = [];
test.after(async () => { for (const folder of scratch) await rm(folder, { recursive: true, force: true }); });

async function setup(): Promise<{ root: string; service: AgentService; projectPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmontage-agent-')); scratch.push(root);
  const service = new AgentService({ allowedRoots: [root] }); await service.initialize();
  const projectPath = path.join(root, 'agent.omproj'); await service.call('project_create', { projectPath, name: 'Agent test', width: 320, height: 180, frameRate: '24/1' });
  return { root, service, projectPath };
}

test('agent service exposes versioned tools and rejects paths outside granted roots', async () => {
  const { root, service } = await setup();
  const schema = await service.schemaDocument() as any;
  assert.equal(schema.schemaVersion, 1);
  assert.ok(schema.tools.some((item: any) => item.name === 'timeline_add_clip'));
  assert.ok(schema.tools.some((item: any) => item.name === 'mask_segment'));
  const montageTool = schema.tools.find((item: any) => item.name === 'montage_generate');
  assert.ok(montageTool.inputSchema.properties.referenceMediaId);
  assert.deepEqual(montageTool.inputSchema.properties.selectionMode.enum, ['library', 'selected', 'ranges']);
  assert.ok(montageTool.inputSchema.properties.sourceRanges);
  assert.ok(!montageTool.inputSchema.required.includes('durationSeconds'), 'agents may let the selected music define montage duration');
  assert.equal(normalizePacingIntensity(0.72), 0.72);
  assert.equal(normalizePacingIntensity(72), 0.72);
  assert.equal(normalizePacingIntensity(100), 1);
  const outside = path.join(path.dirname(root), 'outside.omproj');
  await assert.rejects(service.call('project_create', { projectPath: outside }), (error: any) => error.code === 'PATH_PERMISSION_DENIED' && /Choose a project\/export location inside an allowed folder/.test(error.message));
  const nestedOutput = await service.call('project_create', { projectPath: path.join(root, 'Edits', 'inside-granted-root.omproj') });
  assert.equal(nestedOutput.filePath, path.join(root, 'Edits', 'inside-granted-root.omproj'));
  await assert.rejects(service.call('render_status', { projectPath: path.join(root, 'agent.omproj'), jobId: '..\\..\\outside' }), (error: any) => error.code === 'INVALID_ARGUMENTS');
  assert.equal((await service.call('diagnostics', {})).schemaVersion, 1);
});

test('agent path grants reject directory-link escapes and recursive linked-folder imports', async () => {
  const { root, service, projectPath } = await setup();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'openmontage-agent-outside-')); scratch.push(outside);
  await writeFile(path.join(outside, 'outside.omproj'), '{}\n');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, path.join(root, 'outside-link'), linkType);
  await assert.rejects(service.call('project_open', { projectPath: path.join(root, 'outside-link', 'outside.omproj') }), (error: any) => error.code === 'PATH_PERMISSION_DENIED');

  const importFolder = path.join(root, 'imports'); await mkdir(importFolder);
  await symlink(outside, path.join(importFolder, 'linked-folder'), linkType);
  await assert.rejects(service.call('media_import', { projectPath, paths: [importFolder] }), (error: any) => error.code === 'PATH_SYMLINK_DENIED');
});

test('generic CLI dispatches registered tools with the versioned response envelope', async () => {
  const { root, projectPath } = await setup();
  const argumentsJson = JSON.stringify({ projectPath }); const cli = path.join(process.cwd(), 'dist', 'src', 'main', 'cli.js');
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'agent-call', '--allow-root', root, '--tool', 'project_inspect', '--arguments', argumentsJson], { windowsHide: true });
    let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Agent CLI failed (${code}): ${stderr}`)));
  });
  const response = JSON.parse(output); assert.equal(response.schemaVersion, 1); assert.equal(response.ok, true); assert.equal(response.data.project.name, 'Agent test');
});

test('failed project transaction restores project and history snapshots', async () => {
  const { service, projectPath } = await setup();
  const before = await loadProject(projectPath); const historyBefore = await getProjectHistory(projectPath);
  await assert.rejects(service.call('project_transaction', { projectPath, operations: [
    { name: 'timeline_add_track', arguments: { kind: 'video', name: 'Overlay' } },
    { name: 'timeline_add_clip', arguments: { mediaId: 'missing-media', trackId: before.tracks[0].id, start: '0' } }
  ] }), (error: any) => error.code === 'TRANSACTION_ROLLED_BACK');
  assert.deepEqual(await loadProject(projectPath), before);
  assert.deepEqual(await getProjectHistory(projectPath), historyBefore);
});

test('quality report persists visual evidence and bounded improve cycle closes a safe gap with undo and redo', async () => {
  const { root, service, projectPath } = await setup();
  const video = path.join(root, 'quality-source.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  const imported = await service.call('media_import', { projectPath, paths: [video] });
  const mediaId = imported.added[0].id;
  const project = await loadProject(projectPath);
  const trackId = project.tracks.find((track) => track.kind === 'video')!.id;
  const first = await service.call('timeline_add_clip', { projectPath, mediaId, trackId, start: '0', sourceIn: '0', duration: '1' });
  const second = await service.call('timeline_add_clip', { projectPath, mediaId, trackId, start: '5/4', sourceIn: '1', duration: '1' });

  const report = await service.call('quality_analyze', { projectPath, selectedBeatTargets: ['6/5'], beatToleranceMs: 10, renderAudio: false });
  assert.equal(report.summary.status, 'issues');
  assert.equal(report.checks.timelineCoverage.status, 'issues');
  assert.ok(report.findings.some((item: any) => item.code === 'video_gap' && item.correction?.automaticallySafe));
  assert.ok(report.findings.some((item: any) => item.code === 'beat_alignment_deviation'));
  assert.ok(report.previewFrames.some((frame: any) => frame.blackLike && frame.activeClipIds.length === 0), JSON.stringify(report.previewFrames));
  const persisted = await service.call('quality_report_get', { projectPath, reportId: report.reportId });
  assert.equal(persisted.reportId, report.reportId);
  assert.ok(persisted.previewFrames.every((frame: any) => frame.path.startsWith(root)));
  assert.equal((await service.call('quality_report_list', { projectPath })).reports.length, 1);

  const improved = await service.call('quality_improve', { projectPath });
  assert.equal(improved.maxIterations, 3);
  assert.equal(improved.iterations[0].correctionCount, 1);
  assert.equal(improved.finalReport.checks.timelineCoverage.status, 'pass');
  assert.equal(improved.finalReport.improvement.appliedTransactions.length, 1);
  assert.equal((await loadProject(projectPath)).tracks.find((track) => track.id === trackId)!.clips.find((clip) => clip.id === second.id)!.start.num, '1');
  assert.ok(improved.finalReport.previewFrames.length > 0, 'post-correction preview frames were rendered');
  const reports = await service.call('quality_report_list', { projectPath });
  assert.equal(reports.reports.length, 3, 'initial, pre-fix, and post-fix reports are retained');

  await service.call('project_undo', { projectPath });
  assert.equal((await loadProject(projectPath)).tracks.find((track) => track.id === trackId)!.clips.find((clip) => clip.id === second.id)!.start.num, '5');
  await service.call('project_redo', { projectPath });
  assert.equal((await loadProject(projectPath)).tracks.find((track) => track.id === trackId)!.clips.find((clip) => clip.id === second.id)!.start.num, '1');
  await assert.rejects(service.call('quality_improve', { projectPath, maxIterations: 4 }), (error: any) => error.code === 'INVALID_ARGUMENTS');
  assert.ok(first.id);
});

test('quality audio checks measure the rendered mix and report clipped source audio', async () => {
  const { root, service, projectPath } = await setup();
  const video = path.join(root, 'clipped-source.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-filter:a', 'volume=10', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', video]);
  const imported = await service.call('media_import', { projectPath, paths: [video] });
  const project = await loadProject(projectPath);
  const trackId = project.tracks.find((track) => track.kind === 'video')!.id;
  await service.call('timeline_add_clip', { projectPath, mediaId: imported.added[0].id, trackId, start: '0', duration: '2' });
  const report = await service.call('quality_analyze', { projectPath, renderAudio: true });
  assert.equal(report.checks.audioLevels.status, 'issues');
  assert.match(report.checks.audioLevels.details, /source segment\(s\) peak within 0.1 dB/);
  assert.ok(report.findings.some((item: any) => item.code === 'source_audio_clipping_risk' && item.evidence === 'objective'));
  assert.equal(report.checks.audioTransitions.status, 'pass');
});

test('the next agent operation restores an edit transaction interrupted by process exit', async () => {
  const { root, service, projectPath } = await setup();
  const before = await loadProject(projectPath); const historyBefore = await getProjectHistory(projectPath); const historyPath = projectHistoryPath(projectPath, before.id);
  const historyExists = await access(historyPath).then(() => true, () => false);
  const journal = await mkdtemp(path.join(root, '.openmontage-transaction-'));
  await copyFile(projectPath, path.join(journal, 'before.omproj'));
  if (historyExists) await cp(historyPath, path.join(journal, 'history'), { recursive: true });
  await writeFile(path.join(journal, 'transaction.json'), `${JSON.stringify({ transactionId: randomUUID(), projectPath, projectId: before.id, historyExists })}\n`);
  await writeFile(projectPath, `${JSON.stringify({ ...before, name: 'Partially committed state' }, null, 2)}\n`);

  const restarted = new AgentService({ allowedRoots: [root] }); await restarted.initialize();
  const opened = await restarted.call('project_open', { projectPath });
  assert.equal(opened.project.name, before.name);
  assert.deepEqual(await loadProject(projectPath), before);
  assert.deepEqual(await getProjectHistory(projectPath), historyBefore);
  assert.ok(!(await readdir(root)).includes(path.basename(journal)), 'recovered journals are cleaned up');
});

test('render status after restart marks active persisted jobs interrupted so agents can resume with a new export', async () => {
  const { root, projectPath } = await setup();
  const project = await loadProject(projectPath); const jobId = randomUUID();
  const directory = path.join(projectCachePath(projectPath, project.id), 'agent-jobs');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${jobId}.json`), `${JSON.stringify({
    id: jobId, projectPath, status: 'running', progress: 0.42, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), outputPath: path.join(root, 'interrupted.mp4')
  })}\n`);
  const restarted = new AgentService({ allowedRoots: [root] }); await restarted.initialize();
  const recovered = await restarted.call('render_status', { projectPath, jobId });
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error?.code, 'RENDER_INTERRUPTED');
  assert.match(recovered.error?.message, /Start a new export/);
});

test('agent event alignment keeps exact rational frame arithmetic at fractional frame rates', async () => {
  const { root, service, projectPath } = await setup();
  const video = path.join(root, 'alignment.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  const imported = await service.call('media_import', { projectPath, paths: [video] });
  const media = imported.added[0];
  await service.call('project_update_profile', { projectPath, frameRate: '30000/1001' });
  const project = await loadProject(projectPath); const track = project.tracks.find((item) => item.kind === 'video')!;
  const clip = await service.call('timeline_add_clip', { projectPath, mediaId: media.id, trackId: track.id, start: '0', duration: '2' });
  const aligned = await service.call('timeline_align_event', { projectPath, clipId: clip.id, sourceTime: '1/3', targetTime: '3/2' });
  assert.equal(aligned.actualTimelineTime.frame, 10);
  assert.deepEqual(aligned.actualTimelineTime.actualTime, { num: '3', den: '2' });
  assert.deepEqual(aligned.actualTimelineTime.error, { num: '0', den: '1' });
  await assert.rejects(service.call('timeline_align_event', { projectPath, clipId: clip.id, sourceTime: '3', targetTime: '4' }), (error: any) => error.code === 'SOURCE_RANGE_EXCEEDED');
});

test('REST API requires bearer auth and serves versioned tool schemas on loopback', async () => {
  const { service } = await setup(); const server = await startAgentRest(service, { port: 0, token: 'a'.repeat(32) });
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${server.port}/v1/tools`);
    assert.equal(unauthenticated.status, 401);
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/tools`, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200); const payload = await response.json() as any;
    assert.equal(payload.schemaVersion, 1); assert.equal(payload.ok, true); assert.ok(payload.data.tools.length > 30);
    const forbiddenOrigin = await fetch(`http://127.0.0.1:${server.port}/v1`, { headers: { Authorization: `Bearer ${server.token}`, Origin: 'http://127.0.0.1:5173' } });
    assert.equal(forbiddenOrigin.status, 403);
    const invalidJson = await fetch(`http://127.0.0.1:${server.port}/v1/tools/project_open`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json() as any).error.code, 'INVALID_JSON');
    const oversized = await fetch(`http://127.0.0.1:${server.port}/v1/tools/project_open`, { method: 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(10 * 1024 * 1024) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as any).error.code, 'REQUEST_TOO_LARGE');
  } finally { await server.close(); }
});

test('MCP stdio supports initialization, typed tools, and structured tool results', async () => {
  const { service, projectPath } = await setup(); const input = new PassThrough(); const output = new PassThrough();
  let stdout = ''; output.setEncoding('utf8'); output.on('data', (chunk) => { stdout += chunk; });
  const running = runAgentMcp(service, input, output);
  input.end([
    'null',
    '{invalid json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_inspect', arguments: { projectPath } } })
  ].join('\n') + '\n');
  await running;
  const replies = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(replies[0].error.code, -32600);
  assert.equal(replies[1].error.code, -32700);
  assert.equal(replies[2].result.protocolVersion, '2025-11-25');
  assert.equal(replies[2].result.serverInfo.version, APP_VERSION);
  assert.ok(replies[3].result.tools.some((item: any) => item.name === 'preview_render'));
  assert.equal(replies[4].result.structuredContent.data.project.name, 'Agent test');
  assert.equal(replies[4].result.isError, false);
});

test('legacy MCP clients receive legacy tool schemas and content-only results', async () => {
  const { service } = await setup(); const input = new PassThrough(); const output = new PassThrough();
  let stdout = ''; output.setEncoding('utf8'); output.on('data', (chunk) => { stdout += chunk; });
  const running = runAgentMcp(service, input, output);
  input.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'diagnostics', arguments: {} } })
  ].join('\n') + '\n');
  await running;
  const replies = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(replies.length, 3, 'notifications must not receive JSON-RPC responses');
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.ok(replies[1].result.tools.every((item: any) => item.outputSchema === undefined));
  assert.equal(replies[2].result.structuredContent, undefined);
  assert.ok(replies[2].result.content[0].text.includes('"ok":true'));
});

test('structured tools can assemble, preview, and export a complete local montage', { timeout: 60_000 }, async () => {
  const { root, service, projectPath } = await setup();
  const video = path.join(root, 'gameplay.mp4'); const music = path.join(root, 'music.wav');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', music]);
  const imported = await service.call('media_import', { projectPath, paths: [video, music] });
  assert.equal(imported.added.length, 2);
  const musicAsset = imported.added.find((asset: any) => asset.kind === 'audio');
  const videoAsset = imported.added.find((asset: any) => asset.kind === 'video');
  const tagged = await service.call('media_update', { projectPath, mediaId: videoAsset.id, favorite: true, rating: 5, tags: ['agent-test'], game: 'Test game' });
  assert.equal(tagged.favorite, true); assert.equal(tagged.rating, 5);
  const reviewed = await service.call('media_update', { projectPath, mediaId: videoAsset.id, analysisEventReviews: [{ eventId: 'manual-event', detectorIds: ['test.hud'], status: 'corrected', startSeconds: 0.2, decisiveSeconds: 0.4, endSeconds: 0.8, correctedEventType: 'headshot', updatedAt: new Date().toISOString() }] });
  assert.equal(reviewed.analysisEventReviews[0].correctedEventType, 'headshot', 'manual semantic event corrections pass through the versioned agent API and persist');
  const highlightResult = await service.call('highlights_detect', { projectPath, mediaId: videoAsset.id });
  assert.ok(Array.isArray(highlightResult.events));
  assert.ok(highlightResult.events.every((event: any) => event.eventType && event.evidenceLevel && Array.isArray(event.signals) && Array.isArray(event.uncertainties)));
  const initial = await loadProject(projectPath); const videoTrack = initial.tracks.find((track) => track.kind === 'video')!; const audioTrack = initial.tracks.find((track) => track.kind === 'audio')!;
  const audio = await service.call('audio_analyze', { projectPath, mediaId: musicAsset.id });
  assert.ok(Array.isArray(audio.beatGrid.beats));
  assert.ok(Array.isArray(audio.beatGrid.points) && audio.beatGrid.points.every((point: any) => typeof point.confidence === 'number'));
  assert.ok(Array.isArray(audio.beatGrid.tempoSegments));
  assert.ok(Array.isArray(audio.beatGrid.onsetEvents));
  assert.ok(Array.isArray(audio.beatGrid.accents));
  assert.ok(Array.isArray(audio.beatGrid.structureEvents));
  assert.ok(audio.beatGrid.structureEvents.every((event: any) => typeof event.type === 'string' && typeof event.confidence === 'number'));
  assert.equal(audio.beatGrid.confidenceModel, 'relative-heuristic-not-probability');
  const videoClip = await service.call('timeline_add_clip', { projectPath, mediaId: videoAsset.id, trackId: videoTrack.id, start: '0', sourceIn: '0', duration: '2' });
  const audioClip = await service.call('timeline_add_clip', { projectPath, mediaId: musicAsset.id, trackId: audioTrack.id, start: '0', sourceIn: '0', duration: '2' });
  assert.ok(videoClip.id); assert.ok(audioClip.id);
  const effected = await service.call('effect_add', { projectPath, clipId: videoClip.id, effects: { blendMode: 'screen', mask: { path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', featherPx: 0, expansionPx: 0 } } });
  assert.equal(effected.blendMode, 'screen');
  await service.call('effect_remove', { projectPath, clipId: videoClip.id, fields: ['mask', 'blendMode'] });
  const inspected = await service.call('project_inspect', { projectPath }); assert.equal(inspected.clipCount, 2);
  const preview = await service.call('preview_render', { projectPath, time: '1/2' }); assert.equal(preview.mimeType, 'image/png'); assert.ok(preview.data.length > 100);
  const repeatedPreview = await service.call('preview_render', { projectPath, time: '1/2' }); assert.equal(repeatedPreview.data, preview.data, 'agent frame preview is stable when served from its keyed cache');
  const analyzedPreview = await service.call('preview_analyze', { projectPath, time: '1/2' });
  assert.equal(analyzedPreview.mimeType, 'image/png'); assert.ok(Number.isFinite(analyzedPreview.statistics?.yavg));
  const repeatedAnalysis = await service.call('preview_analyze', { projectPath, time: '1/2' });
  assert.deepEqual(repeatedAnalysis.statistics, analyzedPreview.statistics, 'agent frame signal statistics are re-used for the same range key');
  const job = await service.call('video_export', { projectPath, outputPath: path.join(root, 'montage.mp4') });
  let status = job;
  const deadline = Date.now() + 55_000;
  while (status.status === 'running' && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); status = await service.call('render_status', { projectPath, jobId: job.id }); }
  assert.equal(status.status, 'complete', JSON.stringify(status.error));
  await access(path.join(root, 'montage.mp4'));
});

