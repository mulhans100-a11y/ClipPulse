const { spawnSync } = require('node:child_process');

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run ffmpeg: ${result.error.message}`);
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

const filters = runFfmpeg(['-hide_banner', '-filters']);
const encoders = runFfmpeg(['-hide_banner', '-encoders']);
const missing = [];
if (!/\bdrawtext\b/.test(filters)) missing.push('drawtext filter');
if (!/\blibx264\b/.test(encoders)) missing.push('libx264 encoder');

if (missing.length) {
  console.error(`The CI FFmpeg build is missing required features: ${missing.join(', ')}`);
  console.error(runFfmpeg(['-version']).trim());
  process.exitCode = 1;
} else {
  console.log('FFmpeg provides drawtext and libx264.');
  console.log(runFfmpeg(['-version']).split(/\r?\n/, 1)[0]);
}
