import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentService } from '../src/main/agent';
import { startAgentRest } from '../src/main/agentRest';
import { runAgentMcp } from '../src/main/agentMcp';
import { getProjectHistory, loadProject } from '../src/core/project';
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
  const outside = path.join(path.dirname(root), 'outside.omproj');
  await assert.rejects(service.call('project_create', { projectPath: outside }), (error: any) => error.code === 'PATH_PERMISSION_DENIED');
  await assert.rejects(service.call('render_status', { projectPath: path.join(root, 'agent.omproj'), jobId: '..\\..\\outside' }), (error: any) => error.code === 'INVALID_ARGUMENTS');
  assert.equal((await service.call('diagnostics', {})).schemaVersion, 1);
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
  } finally { await server.close(); }
});

test('MCP stdio supports initialization, typed tools, and structured tool results', async () => {
  const { service, projectPath } = await setup(); const input = new PassThrough(); const output = new PassThrough();
  let stdout = ''; output.setEncoding('utf8'); output.on('data', (chunk) => { stdout += chunk; });
  const running = runAgentMcp(service, input, output);
  input.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project_inspect', arguments: { projectPath } } })
  ].join('\n') + '\n');
  await running;
  const replies = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.ok(replies[1].result.tools.some((item: any) => item.name === 'preview_render'));
  assert.equal(replies[2].result.structuredContent.data.project.name, 'Agent test');
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
  const initial = await loadProject(projectPath); const videoTrack = initial.tracks.find((track) => track.kind === 'video')!; const audioTrack = initial.tracks.find((track) => track.kind === 'audio')!;
  const audio = await service.call('audio_analyze', { projectPath, mediaId: musicAsset.id });
  assert.ok(Array.isArray(audio.beatGrid.beats));
  const videoClip = await service.call('timeline_add_clip', { projectPath, mediaId: videoAsset.id, trackId: videoTrack.id, start: '0', sourceIn: '0', duration: '2' });
  const audioClip = await service.call('timeline_add_clip', { projectPath, mediaId: musicAsset.id, trackId: audioTrack.id, start: '0', sourceIn: '0', duration: '2' });
  assert.ok(videoClip.id); assert.ok(audioClip.id);
  const effected = await service.call('effect_add', { projectPath, clipId: videoClip.id, effects: { blendMode: 'screen', mask: { path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', featherPx: 0, expansionPx: 0 } } });
  assert.equal(effected.blendMode, 'screen');
  await service.call('effect_remove', { projectPath, clipId: videoClip.id, fields: ['mask', 'blendMode'] });
  const inspected = await service.call('project_inspect', { projectPath }); assert.equal(inspected.clipCount, 2);
  const preview = await service.call('preview_render', { projectPath, time: '1/2' }); assert.equal(preview.mimeType, 'image/png'); assert.ok(preview.data.length > 100);
  const job = await service.call('video_export', { projectPath, outputPath: path.join(root, 'montage.mp4') });
  let status = job;
  const deadline = Date.now() + 55_000;
  while (status.status === 'running' && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); status = await service.call('render_status', { projectPath, jobId: job.id }); }
  assert.equal(status.status, 'complete', JSON.stringify(status.error));
  await access(path.join(root, 'montage.mp4'));
});

