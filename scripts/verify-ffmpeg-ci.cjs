'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const cliPath = path.resolve(__dirname, '..', 'dist', 'src', 'main', 'cli.js');
const result = spawnSync(process.execPath, [cliPath, 'doctor'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
if (result.error) {
  console.error(`Could not run ClipPulse diagnostics: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`ClipPulse diagnostics exited with code ${result.status ?? 'unknown'}.`);
  if (result.stderr?.trim()) console.error(result.stderr.trim());
  process.exit(1);
}

let response;
try { response = JSON.parse(result.stdout); }
catch (error) {
  console.error(`ClipPulse diagnostics returned invalid JSON: ${error.message}`);
  process.exit(1);
}

const status = response?.data?.ffmpeg;
if (!response?.ok || !status?.ffmpeg || !status?.ffprobe || !status?.compatible) {
  console.error(status?.message || 'ClipPulse requires FFmpeg/FFprobe 6 or newer with the drawtext filter and libx264 encoder.');
  process.exit(1);
}
console.log('ClipPulse diagnostics confirm compatible FFmpeg and FFprobe.');
