const { spawnSync } = require('node:child_process');

const signingVariables = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
];

const env = { ...process.env };
for (const name of signingVariables) {
  if (!env[name]?.trim()) delete env[name];
}

const builderCli = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [builderCli, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Could not start electron-builder: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
