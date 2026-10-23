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
  configPath: string;
  backupPath?: string;
  command: string;
  args: string[];
  allowedRoots: string[];
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

  if (input.client === 'codex') {
    const current = existing?.contents ?? '';
    if (/^\s*mcp_servers\s*=\s*\{/m.test(current)) {
      throw new Error('Codex uses an inline mcp_servers table that ClipPulse cannot safely extend. The file was left unchanged; use the copied TOML example in MCP Setup documentation.');
    }
    serverName = findFreeTomlServerName(current);
    nextContents = appendCodexEntry(current, serverName, input.launch);
  } else {
    const current = existing?.contents ? parseClaudeConfig(existing.contents, configPath) : {};
    const servers = asPlainObject(current.mcpServers, 'mcpServers', configPath);
    serverName = findFreeJsonServerName(servers);
    servers[serverName] = { type: 'stdio', command: input.launch.command, args: [...input.launch.args], ...(input.launch.env ? { env: { ...input.launch.env } } : {}) };
    current.mcpServers = servers;
    nextContents = `${JSON.stringify(current, null, 2)}\n`;
  }

  const backupPath = existing ? await createConfigBackup(configPath, existing.mode) : undefined;
  await writeConfigAtomically(configPath, nextContents, existing?.mode ?? 0o600);
  return { client: input.client, serverName, configPath, ...(backupPath ? { backupPath } : {}), command: input.launch.command, args: [...input.launch.args], allowedRoots };
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
