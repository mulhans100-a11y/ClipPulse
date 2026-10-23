'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const { buildMcpServerArgs, testMcpConnection } = require('../dist/src/main/mcpSetup.js');
const expectedVersion = require('../package.json').version;

async function main() {
  const [applicationExecutable, cliEntryPath] = process.argv.slice(2);
  if (!applicationExecutable || !cliEntryPath) {
    throw new Error('Usage: node scripts/smoke-test-packaged-mcp.cjs <ClipPulse executable> <packaged cli.js path>');
  }

  const result = await testMcpConnection({
    command: applicationExecutable,
    args: buildMcpServerArgs(cliEntryPath, [os.tmpdir()]),
    env: { ELECTRON_RUN_AS_NODE: '1' }
  });
  assert.equal(result.server.name, 'clippulse');
  assert.equal(result.server.version, expectedVersion);
  assert.equal(result.protocol, 'stdio');
  assert.ok(result.toolCount >= 10, 'Packaged MCP server should expose the current Agent API tools.');
  assert.equal(result.diagnostics.platform, process.platform);

  console.log(`Packaged MCP smoke test passed on ${process.platform}/${process.arch}: ${result.server.name} ${result.server.version}, ${result.toolCount} tools, diagnostics responded.`);
}

main().catch((error) => {
  console.error(`Packaged ClipPulse MCP smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
