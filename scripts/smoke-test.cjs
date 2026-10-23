'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, mkdir, rm, readFile } = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const cliPath = path.join(projectRoot, 'dist', 'src', 'main', 'cli.js');
const appVersion = require('../package.json').version;
const maxBuffer = 16 * 1024 * 1024;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    maxBuffer,
    ...(options.input !== undefined ? { input: options.input } : {})
  });
  if (result.error) throw new Error(`Could not start ${program}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim().slice(-4000);
    throw new Error(`${path.basename(program)} exited with code ${result.status ?? 'unknown'}.${detail ? `\n${detail}` : ''}`);
  }
  return result;
}

function cli(command, ...args) {
  const result = run(process.execPath, [cliPath, command, ...args]);
  let envelope;
  try { envelope = JSON.parse(result.stdout); }
  catch (error) { throw new Error(`CLI ${command} did not return JSON: ${error.message}`); }
  if (envelope.schemaVersion !== 1 || envelope.ok !== true) {
    throw new Error(`CLI ${command} returned an invalid response: ${JSON.stringify(envelope).slice(0, 1000)}`);
  }
  return envelope.data;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'clippulse-smoke-'));
  const workspace = path.join(tempRoot, 'workspace with spaces');
  await mkdir(workspace);
  try {
    const help = run(process.execPath, [cliPath, 'help']);
    assert.match(help.stdout, /ClipPulse CLI/);

    const diagnosis = cli('doctor');
    assert.equal(diagnosis.ffmpeg.ffmpeg, true, diagnosis.ffmpeg.message);
    assert.equal(diagnosis.ffmpeg.ffprobe, true, diagnosis.ffmpeg.message);
    assert.equal(diagnosis.ffmpeg.compatible, true, diagnosis.ffmpeg.message);

    const projectPath = path.join(workspace, 'smoke project.omproj');
    const created = cli('create', '--project', projectPath, '--name', 'Pipeline smoke', '--fps', '30/1', '--width', '320', '--height', '180');
    assert.equal(created.name, 'Pipeline smoke');

    const opened = cli('inspect', '--project', projectPath);
    assert.equal(opened.project.id, created.id);
    assert.equal(cli('validate', '--project', projectPath).valid, true);

    const sourcePath = path.join(workspace, 'capture source.mp4');
    run('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
      '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourcePath
    ]);
    const sourceHash = sha256(await readFile(sourcePath));
    cli('import', '--project', projectPath, sourcePath);

    let project = cli('inspect', '--project', projectPath).project;
    const videoAsset = project.media.find((asset) => asset.kind === 'video');
    assert.ok(videoAsset, 'The generated video should be imported into the project.');
    let videoTrack = project.tracks.find((track) => track.kind === 'video');
    if (!videoTrack) {
      cli('track-add', '--project', projectPath, '--kind', 'video', '--name', 'Smoke video');
      project = cli('inspect', '--project', projectPath).project;
      videoTrack = project.tracks.find((track) => track.kind === 'video');
    }
    assert.ok(videoTrack, 'The project should contain a video track.');
    cli('clip-add', '--project', projectPath, '--media', videoAsset.id, '--track', videoTrack.id, '--start', '0', '--source-in', '0', '--duration', '2');
    project = cli('inspect', '--project', projectPath).project;
    const originalClip = project.tracks.find((track) => track.id === videoTrack.id).clips[0];
    cli('clip-split', '--project', projectPath, '--clip', originalClip.id, '--at', '1');
    project = cli('inspect', '--project', projectPath).project;
    let clips = project.tracks.find((track) => track.id === videoTrack.id).clips;
    assert.equal(clips.length, 2, 'Splitting a clip should create two timeline segments.');
    const secondClip = [...clips].sort((a, b) => Number(a.start.num) / Number(a.start.den) - Number(b.start.num) / Number(b.start.den))[1];
    cli('clip-move', '--project', projectPath, '--clip', secondClip.id, '--start', '5/4');
    project = cli('inspect', '--project', projectPath).project;
    clips = project.tracks.find((track) => track.id === videoTrack.id).clips;
    assert.equal(clips.length, 2);

    const outputPath = path.join(workspace, 'final smoke export.mp4');
    cli('export', '--project', projectPath, '--output', outputPath);
    const probe = JSON.parse(run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', outputPath
    ]).stdout);
    const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
    assert.ok(videoStream, 'Exported MP4 should contain video.');
    assert.equal(videoStream.width, 320);
    assert.equal(videoStream.height, 180);
    assert.ok(Number(probe.format?.duration) >= 2.2, 'Export should include the moved timeline clip.');
    assert.equal(sha256(await readFile(sourcePath)), sourceHash, 'Importing and rendering must not modify source media.');

    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' }
    ].map((request) => JSON.stringify(request)).join('\n') + '\n';
    const mcp = run(process.execPath, [cliPath, 'mcp-server', '--allow-root', workspace], { input: requests, timeout: 20_000 });
    const replies = mcp.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(replies.map((reply) => reply.id), [1, 2, 3]);
    assert.equal(replies[0].result.serverInfo.name, 'clippulse');
    assert.equal(replies[0].result.serverInfo.version, appVersion);
    assert.deepEqual(replies[1].result, {});
    assert.ok(replies[2].result.tools.some((tool) => tool.name === 'project_create'));
    assert.ok(replies[2].result.tools.some((tool) => tool.name === 'video_export'));

    console.log(`Smoke test passed on ${process.platform}/${process.arch}: CLI, project create/open, import, timeline split/move, FFmpeg/FFprobe, MP4 export, and MCP stdio (${appVersion}).`);
  } finally {
    if (process.env.CLIPPULSE_KEEP_SMOKE_ARTIFACTS === '1') console.log(`Smoke files retained at ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`ClipPulse smoke test failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
