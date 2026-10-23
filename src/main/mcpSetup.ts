import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export type McpClientTarget = 'codex' | 'claude-code';
export interface McpLaunchConfiguration { command: string; args: string[]; env?: Record<string, string>; }
export interface McpConfigurationResult {
  client: McpClientTarget;
  serverName: string;
  action: 'created' | 'updated';
  removedDuplicateEntries: number;
  configPath: string;
  backupPath?: string;
  command: string;
  args: string[];
  allowedRoots: string[];
}
export interface McpExistingConfiguration {
  serverNames: string[];
  allowedRoots: string[];
  duplicateEntries: number;
}

const MAX_ALLOWED_ROOTS = 24;

export function getMcpClientConfigPath(client: McpClientTarget, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (client === 'codex') return path.join(env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'), 'config.toml');
  if (client === 'claude-code') return path.join(env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : home, '.claude.json');
  throw new Error('Choose Codex or Claude Code.');
}

export function buildMcpServerArgs(cliEntryPath: string, allowedRoots: string[]): string[] {
  return [
    cliEntryPath,
    'mcp-server',
    ...allowedRoots.flatMap((root) => ['--allow-root', root])
  ];
}

export async function canonicalizeAllowedRoots(roots: unknown): Promise<string[]> {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > MAX_ALLOWED_ROOTS || roots.some((root) => typeof root !== 'string' || !root.trim())) {
    throw new Error(`Select between 1 and ${MAX_ALLOWED_ROOTS} existing folders for project and media access.`);
  }
  const normalized = await Promise.all((roots as string[]).map(async (root) => {
    const absolute = path.resolve(root.trim());
    const canonical = await fs.realpath(absolute).catch(() => { throw new Error(`The selected folder is no longer available: ${absolute}`); });
    const info = await fs.stat(canonical);
    if (!info.isDirectory()) throw new Error(`The selected path is not a folder: ${absolute}`);
    return canonical;
  }));
  const unique: string[] = [];
  for (const root of normalized) {
    const key = process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root;
    if (!unique.some((item) => (process.platform === 'win32' ? item.toLocaleLowerCase('en-US') : item) === key)) unique.push(root);
  }
  if (!unique.length) throw new Error('Choose at least one project or media folder.');
  return unique;
}

export async function getExistingMcpConfiguration(client: McpClientTarget, configPath?: string): Promise<McpExistingConfiguration> {
  const resolvedConfigPath = path.resolve(configPath ?? getMcpClientConfigPath(client));
  const existing = await readRegularConfig(resolvedConfigPath);
  if (!existing) return { serverNames: [], allowedRoots: [], duplicateEntries: 0 };

  let entries: Array<{ name: string; args: unknown }>;
  if (client === 'codex') {
    entries = findManagedCodexEntries(existing.contents).map(({ name, start, end }) => ({
      name,
      args: readCodexArgs(existing.contents.slice(start, end))
    }));
  } else {
    const current = parseClaudeConfig(existing.contents, resolvedConfigPath);
    const servers = asPlainObject(current.mcpServers, 'mcpServers', resolvedConfigPath);
    entries = Object.entries(servers).filter(([name, value]) => isManagedClaudeEntry(name, value)).map(([name, value]) => ({
      name,
      args: (value as Record<string, unknown>).args
    }));
  }

  const allowedRoots = uniqueRoots(entries.flatMap((entry) => rootsFromArgs(entry.args)));
  return { serverNames: entries.map(({ name }) => name), allowedRoots, duplicateEntries: Math.max(0, entries.length - 1) };
}

export async function installMcpConfiguration(input: {
  client: McpClientTarget;
  roots: string[];
  launch: McpLaunchConfiguration;
  configPath?: string;
}): Promise<McpConfigurationResult> {
  const allowedRoots = await canonicalizeAllowedRoots(input.roots);
  if (!input.launch.command.trim() || input.launch.args.some((arg) => typeof arg !== 'string')) throw new Error('The ClipPulse MCP launch command is invalid.');
  const configPath = path.resolve(input.configPath ?? getMcpClientConfigPath(input.client));
  await fs.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const existing = await readRegularConfig(configPath);
  let serverName: string;
  let nextContents: string;
  let action: McpConfigurationResult['action'];
  let removedDuplicateEntries = 0;

  if (input.client === 'codex') {
    const current = existing?.contents ?? '';
    if (/^\s*mcp_servers\s*=\s*\{/m.test(current)) {
      throw new Error('Codex uses an inline mcp_servers table that ClipPulse cannot safely extend. The file was left unchanged; use the copied TOML example in MCP Setup documentation.');
    }
    const managed = findManagedCodexEntries(current);
    const cleaned = removeRanges(current, managed.map(({ start, end }) => ({ start, end })));
    const existingNames = managed.map((entry) => entry.name);
    serverName = chooseTomlServerName(cleaned, existingNames);
    action = managed.length ? 'updated' : 'created';
    removedDuplicateEntries = Math.max(0, managed.length - 1);
    nextContents = appendCodexEntry(cleaned, serverName, input.launch);
  } else {
    const current = existing?.contents ? parseClaudeConfig(existing.contents, configPath) : {};
    const servers = asPlainObject(current.mcpServers, 'mcpServers', configPath);
    const managed = Object.entries(servers).filter(([name, value]) => isManagedClaudeEntry(name, value));
    for (const [name] of managed) delete servers[name];
    serverName = chooseJsonServerName(servers, managed.map(([name]) => name));
    action = managed.length ? 'updated' : 'created';
    removedDuplicateEntries = Math.max(0, managed.length - 1);
    servers[serverName] = { type: 'stdio', command: input.launch.command, args: [...input.launch.args], ...(input.launch.env ? { env: { ...input.launch.env } } : {}) };
    current.mcpServers = servers;
    nextContents = `${JSON.stringify(current, null, 2)}\n`;
  }

  const backupPath = existing ? await createConfigBackup(configPath, existing.mode) : undefined;
  await writeConfigAtomically(configPath, nextContents, existing?.mode ?? 0o600);
  return { client: input.client, serverName, action, removedDuplicateEntries, configPath, ...(backupPath ? { backupPath } : {}), command: input.launch.command, args: [...input.launch.args], allowedRoots };
}

export interface McpConnectionTestResult {
  server: { name: string; version: string };
  protocol: 'stdio';
  toolCount: number;
  diagnostics: { platform?: string; node?: string; ffmpeg?: { ffmpeg?: boolean; ffprobe?: boolean; compatible?: boolean; message?: string } };
}

export async function testMcpConnection(launch: McpLaunchConfiguration): Promise<McpConnectionTestResult> {
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: { ...getDefaultEnvironment(), ...launch.env },
    cwd: process.cwd(),
    stderr: 'pipe',
    maxBufferSize: 2 * 1024 * 1024
  });
  let startupStderr = '';
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    if (startupStderr.length < 8192) startupStderr += chunk.toString().slice(0, 8192 - startupStderr.length);
  });
  const client = new Client({ name: 'clippulse-onboarding-check', version: '1.0.0' }, { capabilities: {} });
  let timeout: NodeJS.Timeout | undefined;
  try {
    const test = async (): Promise<McpConnectionTestResult> => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      if (!tools.some((tool) => tool.name === 'diagnostics')) throw new Error('The server initialized but did not provide the safe diagnostics tool.');
      const response = await client.callTool({ name: 'diagnostics', arguments: {} }) as { isError?: boolean; structuredContent?: unknown; content?: unknown };
      if (response.isError) throw new Error('The diagnostics tool returned an MCP error.');
      const structured = response.structuredContent as { data?: McpConnectionTestResult['diagnostics'] } | undefined;
      let diagnostics = structured?.data;
      if (!diagnostics) {
        const content = Array.isArray(response.content) ? response.content as Array<{ type?: string; text?: string }> : [];
        const textContent = content.find((block) => block.type === 'text');
        if (typeof textContent?.text === 'string') {
          try { diagnostics = (JSON.parse(textContent.text) as { data?: McpConnectionTestResult['diagnostics'] }).data; } catch { /* Legacy text may not contain structured JSON. */ }
        }
      }
      if (!diagnostics || typeof diagnostics.platform !== 'string') throw new Error('The diagnostics response was missing required server details.');
      const server = client.getServerVersion();
      return {
        server: { name: server?.name ?? 'unknown', version: server?.version ?? 'unknown' },
        protocol: 'stdio',
        toolCount: tools.length,
        diagnostics: {
          platform: diagnostics.platform,
          node: diagnostics.node,
          ffmpeg: diagnostics.ffmpeg ? {
            ffmpeg: diagnostics.ffmpeg.ffmpeg,
            ffprobe: diagnostics.ffmpeg.ffprobe,
            compatible: diagnostics.ffmpeg.compatible,
            message: diagnostics.ffmpeg.message
          } : undefined
        }
      };
    };
    return await Promise.race([
      test(),
      new Promise<McpConnectionTestResult>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('ClipPulse did not answer within 20 seconds. Check the installation and the selected folders.')), 20_000);
      })
    ]);
  } catch (error) {
    if (error instanceof Error && /20 seconds|safe diagnostics|diagnostics response|diagnostics tool/.test(error.message)) throw error;
    const startupMessage = readCliStartupError(startupStderr);
    if (startupMessage) throw new Error(`ClipPulse MCP server could not start: ${startupMessage}`);
    throw new Error('ClipPulse could not initialize over MCP stdio. Confirm that the installed application is intact and the selected folders still exist.');
  } finally {
    if (timeout) clearTimeout(timeout);
    await transport.close().catch(() => undefined);
  }
}

function readCliStartupError(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
      if (parsed.ok === false && typeof parsed.error?.code === 'string' && typeof parsed.error.message === 'string') {
        return `${parsed.error.code}: ${parsed.error.message.slice(0, 1000)}`;
      }
    } catch { /* Ignore non-protocol runtime diagnostics instead of surfacing arbitrary stderr. */ }
  }
  return undefined;
}

type ExistingConfig = { contents: string; mode: number };
async function readRegularConfig(filePath: string): Promise<ExistingConfig | undefined> {
  const info = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to modify a non-regular client configuration file: ${filePath}`);
  return { contents: await fs.readFile(filePath, 'utf8'), mode: info.mode & 0o777 };
}

async function createConfigBackup(filePath: string, mode: number): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let suffix = 0; suffix < 100; suffix++) {
    const backupPath = `${filePath}.clippulse-${stamp}${suffix ? `-${suffix}` : ''}.bak`;
    try {
      await fs.copyFile(filePath, backupPath, constants.COPYFILE_EXCL);
      await fs.chmod(backupPath, mode).catch(() => undefined);
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a unique backup of the client configuration. No changes were made.');
}

async function writeConfigAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  const temporary = `${filePath}.clippulse-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
    await fs.chmod(temporary, mode).catch(() => undefined);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function appendCodexEntry(current: string, serverName: string, launch: McpLaunchConfiguration): string {
  const command = JSON.stringify(launch.command);
  const args = JSON.stringify(launch.args);
  const env = launch.env ? `env = { ${Object.entries(launch.env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')} }\n` : '';
  const section = `# Added by ClipPulse MCP Setup\n[mcp_servers.${serverName}]\ncommand = ${command}\nargs = ${args}\n${env}`;
  return `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current.trimEnd() ? '\n' : ''}${section}`;
}

interface ManagedCodexEntry { name: string; start: number; end: number; }

function findManagedCodexEntries(current: string): ManagedCodexEntry[] {
  const marker = /^# Added by ClipPulse MCP Setup[ \t]*\r?\n[ \t]*\[mcp_servers\.([A-Za-z0-9_-]+)\][^\r\n]*(?:\r?\n|$)/gm;
  const result: ManagedCodexEntry[] = [];
  const matches = [...current.matchAll(marker)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const start = match.index;
    const headerEnd = start + match[0].length;
    const nextSection = /^\s*\[(?!\[)[^\]\r\n]+\][ \t]*(?:#.*)?\r?$/gm;
    nextSection.lastIndex = headerEnd;
    const following = nextSection.exec(current);
    const nextManagedStart = matches[index + 1]?.index ?? current.length;
    result.push({ name: match[1], start, end: Math.min(following?.index ?? current.length, nextManagedStart) });
  }
  return result;
}

function removeRanges(source: string, ranges: Array<{ start: number; end: number }>): string {
  if (!ranges.length) return source;
  let result = '';
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    result += source.slice(cursor, range.start);
    cursor = range.end;
  }
  return result + source.slice(cursor);
}

function chooseTomlServerName(cleanedConfig: string, managedNames: string[]): string {
  const existingNames = new Set(getTomlServerNames(cleanedConfig));
  if (managedNames.length) {
    // Prefer the stable base name when it is available. If a user-owned entry
    // already uses it, keep the name of the ClipPulse-managed entry instead.
    if (!existingNames.has('clippulse')) return 'clippulse';
    const managedName = managedNames.find((name) => !existingNames.has(name));
    if (managedName) return managedName;
  }
  return findFreeTomlServerName(cleanedConfig);
}

function chooseJsonServerName(servers: Record<string, unknown>, managedNames: string[]): string {
  if (managedNames.length) {
    if (!Object.prototype.hasOwnProperty.call(servers, 'clippulse')) return 'clippulse';
    const managedName = managedNames.find((name) => !Object.prototype.hasOwnProperty.call(servers, name));
    if (managedName) return managedName;
  }
  return findFreeJsonServerName(servers);
}

function getTomlServerNames(current: string): string[] {
  const names: string[] = [];
  const section = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\s*\]|\s*\.)/gm;
  for (const match of current.matchAll(section)) names.push(match[1] ?? match[2] ?? match[3]);
  return names;
}

function isManagedClaudeEntry(name: string, value: unknown): boolean {
  if (!/^clippulse(?:-\d+)?$/i.test(name) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const server = value as Record<string, unknown>;
  if (server.type !== 'stdio' || typeof server.command !== 'string' || !/clippulse/i.test(server.command) || !Array.isArray(server.args)) return false;
  const args = server.args.filter((arg): arg is string => typeof arg === 'string');
  return args.includes('mcp-server') && args.some((arg) => /(?:^|[\\/])cli\.js$/i.test(arg)) && args.includes('--allow-root');
}

function readCodexArgs(section: string): unknown {
  const match = /^\s*args\s*=\s*(\[[^\r\n]*\])\s*(?:#.*)?$/m.exec(section);
  if (!match) return undefined;
  try { return JSON.parse(match[1]) as unknown; } catch { return undefined; }
}

function rootsFromArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const args = value.filter((arg): arg is string => typeof arg === 'string');
  const roots: string[] = [];
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] === '--allow-root') roots.push(args[index + 1]);
  }
  return roots;
}

function uniqueRoots(roots: string[]): string[] {
  return roots.filter((root, index) => roots.findIndex((candidate) => (process.platform === 'win32' ? candidate.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US') : candidate === root)) === index);
}

function findFreeTomlServerName(current: string): string {
  for (let suffix = 1; suffix <= 999; suffix++) {
    const name = suffix === 1 ? 'clippulse' : `clippulse-${suffix}`;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exists = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})(?:\\s*\\]|\\s*\\.)`, 'm').test(current);
    if (!exists) return name;
  }
  throw new Error('No free ClipPulse server name is available in the Codex configuration.');
}

function parseClaudeConfig(contents: string, filePath: string): Record<string, any> {
  let parsed: unknown;
  try { parsed = JSON.parse(contents) as unknown; }
  catch (error) { throw new Error(`Claude Code configuration is not valid JSON and was left unchanged: ${filePath} (${error instanceof Error ? error.message : 'parse error'})`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Claude Code configuration must contain a JSON object: ${filePath}`);
  return parsed as Record<string, any>;
}

function asPlainObject(value: unknown, key: string, filePath: string): Record<string, any> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Claude Code configuration field ${key} must be an object: ${filePath}`);
  return value as Record<string, any>;
}

function findFreeJsonServerName(servers: Record<string, unknown>): string {
  for (let suffix = 1; suffix <= 999; suffix++) {
    const name = suffix === 1 ? 'clippulse' : `clippulse-${suffix}`;
    if (!Object.prototype.hasOwnProperty.call(servers, name)) return name;
  }
  throw new Error('No free ClipPulse server name is available in the Claude Code configuration.');
}
