import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMcpServerArgs, canonicalizeAllowedRoots, getExistingMcpConfiguration, getMcpClientConfigPath, installMcpConfiguration, testMcpConnection } from '../src/main/mcpSetup';

const temporaryFolders: string[] = [];
test.after(async () => { await Promise.all(temporaryFolders.map((folder) => fs.rm(folder, { recursive: true, force: true }))); });

async function createScratch(): Promise<string> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'clippulse-mcp-'));
  temporaryFolders.push(folder);
  return folder;
}

test('MCP client configuration paths honor custom homes and native separators', () => {
  const root = path.parse(process.cwd()).root;
  const codex = getMcpClientConfigPath('codex', { CODEX_HOME: path.join(root, 'codex-home') }, root);
  const claude = getMcpClientConfigPath('claude-code', { CLAUDE_CONFIG_DIR: path.join(root, 'claude-home') }, root);
  assert.equal(codex, path.join(root, 'codex-home', 'config.toml'));
  assert.equal(claude, path.join(root, 'claude-home', '.claude.json'));
  const cliEntry = path.join(root, 'ClipPulse', 'dist', 'src', 'main', 'cli.js');
  const args = buildMcpServerArgs(cliEntry, [path.join(root, 'Gaming Clips'), path.join(root, 'Projects')]);
  assert.deepEqual(args, [cliEntry, 'mcp-server', '--allow-root', path.join(root, 'Gaming Clips'), '--allow-root', path.join(root, 'Projects')]);
});

test('Codex configuration preserves existing entries and backs up the original', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'Media and Projects'); await fs.mkdir(root);
  const configPath = path.join(directory, 'config.toml');
  const original = '# User settings\nmodel = "gpt-6"\n\n[mcp_servers.existing]\ncommand = "other-tool"\nargs = []\n';
  await fs.writeFile(configPath, original, { mode: 0o600 });
  const result = await installMcpConfiguration({
    client: 'codex', roots: [root], configPath,
    launch: { command: 'C:\\Program Files\\ClipPulse\\ClipPulse.exe', args: buildMcpServerArgs('C:\\Program Files\\ClipPulse\\resources\\app.asar\\dist\\src\\main\\cli.js', [root]), env: { ELECTRON_RUN_AS_NODE: '1' } }
  });
  const written = await fs.readFile(configPath, 'utf8');
  assert.ok(written.startsWith(original));
  assert.match(written, /\[mcp_servers\.clippulse\]/);
  assert.match(written, /ELECTRON_RUN_AS_NODE = "1"/);
  assert.ok(written.includes(JSON.stringify('C:\\Program Files\\ClipPulse\\ClipPulse.exe')));
  assert.ok(written.includes(JSON.stringify(root)));
  assert.equal(result.serverName, 'clippulse');
  assert.equal(result.allowedRoots[0], await fs.realpath(root));
  assert.ok(result.backupPath);
  assert.equal(await fs.readFile(result.backupPath!, 'utf8'), original);
});

test('Codex reuses its managed server entry and refreshes the granted roots', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'root'); await fs.mkdir(root);
  const nextRoot = path.join(directory, 'next-root'); await fs.mkdir(nextRoot);
  const configPath = path.join(directory, 'config.toml');
  const first = await installMcpConfiguration({ client: 'codex', roots: [root], configPath, launch: { command: 'ClipPulse', args: buildMcpServerArgs('resources/app.asar/dist/src/main/cli.js', [root]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const firstContents = await fs.readFile(configPath, 'utf8');
  const second = await installMcpConfiguration({ client: 'codex', roots: [nextRoot], configPath, launch: { command: 'ClipPulse', args: buildMcpServerArgs('resources/app.asar/dist/src/main/cli.js', [nextRoot]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const updated = await fs.readFile(configPath, 'utf8');
  assert.equal(first.serverName, 'clippulse');
  assert.equal(second.serverName, first.serverName);
  assert.equal(second.action, 'updated');
  assert.equal(second.removedDuplicateEntries, 0);
  assert.ok(updated.includes('[mcp_servers.clippulse]'));
  assert.ok(updated.includes(JSON.stringify(nextRoot)));
  assert.ok(!updated.includes(JSON.stringify(root)));
  assert.ok(second.backupPath);
  assert.equal(await fs.readFile(second.backupPath!, 'utf8'), firstContents);
});

test('Codex setup consolidates ClipPulse-owned duplicates while preserving other servers', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'approved output'); await fs.mkdir(root);
  const configPath = path.join(directory, 'config.toml');
  const original = [
    'model = "gpt-6"',
    '',
    '# Added by ClipPulse MCP Setup',
    '[mcp_servers.clippulse]',
    'command = "ClipPulse.exe"',
    'args = ["cli.js", "mcp-server", "--allow-root", "old"]',
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    '',
    '# Added by ClipPulse MCP Setup',
    '[mcp_servers.clippulse-2]',
    'command = "ClipPulse.exe"',
    'args = ["cli.js", "mcp-server", "--allow-root", "old-2"]',
    '',
    '[mcp_servers.other]',
    'command = "other-tool"',
    'args = []',
    ''
  ].join('\n');
  await fs.writeFile(configPath, original);
  const existing = await getExistingMcpConfiguration('codex', configPath);
  assert.deepEqual(existing.serverNames, ['clippulse', 'clippulse-2']);
  assert.deepEqual(existing.allowedRoots, ['old', 'old-2']);
  assert.equal(existing.duplicateEntries, 1);
  const result = await installMcpConfiguration({ client: 'codex', roots: [root], configPath, launch: { command: 'ClipPulse.exe', args: buildMcpServerArgs('resources/app.asar/dist/src/main/cli.js', [root]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const saved = await fs.readFile(configPath, 'utf8');
  assert.equal(result.serverName, 'clippulse');
  assert.equal(result.action, 'updated');
  assert.equal(result.removedDuplicateEntries, 1);
  assert.equal((saved.match(/# Added by ClipPulse MCP Setup/g) ?? []).length, 1);
  assert.equal((saved.match(/\[mcp_servers\.clippulse-2\]/g) ?? []).length, 0);
  assert.match(saved, /\[mcp_servers\.other\]\ncommand = "other-tool"/);
  assert.ok(saved.includes(JSON.stringify(root)));
  assert.equal(await fs.readFile(result.backupPath!, 'utf8'), original);
});

test('Codex setup preserves an unmanaged clippulse entry and updates its own numbered entry', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'root'); await fs.mkdir(root);
  const nextRoot = path.join(directory, 'next'); await fs.mkdir(nextRoot);
  const configPath = path.join(directory, 'config.toml');
  const original = '[mcp_servers.clippulse]\ncommand = "my-custom-server"\nargs = []\n';
  await fs.writeFile(configPath, original);
  const first = await installMcpConfiguration({ client: 'codex', roots: [root], configPath, launch: { command: 'ClipPulse.exe', args: buildMcpServerArgs('resources/app.asar/dist/src/main/cli.js', [root]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const second = await installMcpConfiguration({ client: 'codex', roots: [nextRoot], configPath, launch: { command: 'ClipPulse.exe', args: buildMcpServerArgs('resources/app.asar/dist/src/main/cli.js', [nextRoot]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const saved = await fs.readFile(configPath, 'utf8');
  assert.equal(first.serverName, 'clippulse-2');
  assert.equal(second.serverName, 'clippulse-2');
  assert.match(saved, /\[mcp_servers\.clippulse\]\ncommand = "my-custom-server"/);
  assert.ok(saved.includes(JSON.stringify(nextRoot)));
  assert.ok(!saved.includes(JSON.stringify(root)));
});

test('Claude Code config merge keeps other settings and records a private backup', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'Gameplay'); await fs.mkdir(root);
  const configPath = path.join(directory, '.claude.json');
  const original = '{\n  "projects": {},\n  "mcpServers": {"other": {"type":"stdio","command":"other"}}\n}\n';
  await fs.writeFile(configPath, original, { mode: 0o600 });
  const result = await installMcpConfiguration({ client: 'claude-code', roots: [root], configPath, launch: { command: '/Applications/ClipPulse.app/Contents/MacOS/ClipPulse', args: buildMcpServerArgs('/Applications/ClipPulse.app/Contents/Resources/app.asar/dist/src/main/cli.js', [root]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(saved.projects, {});
  assert.equal(saved.mcpServers.other.command, 'other');
  assert.deepEqual(saved.mcpServers.clippulse, { type: 'stdio', command: '/Applications/ClipPulse.app/Contents/MacOS/ClipPulse', args: ['/Applications/ClipPulse.app/Contents/Resources/app.asar/dist/src/main/cli.js', 'mcp-server', '--allow-root', root], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(result.serverName, 'clippulse');
  assert.equal(result.action, 'created');
  assert.equal(await fs.readFile(result.backupPath!, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);

  const nextRoot = path.join(directory, 'More Gameplay'); await fs.mkdir(nextRoot);
  const updated = await installMcpConfiguration({ client: 'claude-code', roots: [nextRoot], configPath, launch: { command: '/Applications/ClipPulse.app/Contents/MacOS/ClipPulse', args: buildMcpServerArgs('/Applications/ClipPulse.app/Contents/Resources/app.asar/dist/src/main/cli.js', [nextRoot]), env: { ELECTRON_RUN_AS_NODE: '1' } } });
  const updatedConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const loaded = await getExistingMcpConfiguration('claude-code', configPath);
  assert.equal(updated.serverName, 'clippulse');
  assert.equal(updated.action, 'updated');
  assert.equal(updated.removedDuplicateEntries, 0);
  assert.deepEqual(loaded.serverNames, ['clippulse']);
  assert.deepEqual(loaded.allowedRoots, [nextRoot]);
  assert.deepEqual(updatedConfig.mcpServers.clippulse.args, ['/Applications/ClipPulse.app/Contents/Resources/app.asar/dist/src/main/cli.js', 'mcp-server', '--allow-root', nextRoot]);
  assert.equal(updatedConfig.mcpServers.other.command, 'other');
});

test('invalid Claude config is left unchanged and denied roots fail before install', async () => {
  const directory = await createScratch();
  const root = path.join(directory, 'root'); await fs.mkdir(root);
  const configPath = path.join(directory, '.claude.json');
  await fs.writeFile(configPath, '{ broken json');
  await assert.rejects(installMcpConfiguration({ client: 'claude-code', roots: [root], configPath, launch: { command: 'ClipPulse', args: [] } }), /not valid JSON/);
  assert.equal(await fs.readFile(configPath, 'utf8'), '{ broken json');
  await assert.rejects(canonicalizeAllowedRoots([path.join(directory, 'missing')]), /no longer available/);
  await assert.rejects(canonicalizeAllowedRoots([]), /Select between 1 and/);
});

test('MCP connection test initializes a real stdio client, lists tools, and calls diagnostics', { timeout: 30_000 }, async () => {
  const root = await createScratch();
  const cliPath = path.resolve(process.cwd(), 'dist/src/main/cli.js');
  const result = await testMcpConnection({ command: process.execPath, args: [cliPath, 'mcp-server', '--allow-root', root] });
  assert.equal(result.server.name, 'clippulse');
  assert.equal(result.protocol, 'stdio');
  assert.ok(result.toolCount >= 10);
  assert.equal(result.diagnostics.platform, process.platform);
});

const electronExecutable = path.resolve(process.cwd(), 'node_modules/electron/dist/electron.exe');
test('Electron runtime starts the MCP server without a separate Node process', { timeout: 30_000, skip: process.platform !== 'win32' || !existsSync(electronExecutable) }, async () => {
  const root = await createScratch();
  const cliPath = path.resolve(process.cwd(), 'dist/src/main/cli.js');
  const result = await testMcpConnection({ command: electronExecutable, args: buildMcpServerArgs(cliPath, [root]), env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(result.server.name, 'clippulse');
  assert.equal(result.diagnostics.platform, process.platform);
});
