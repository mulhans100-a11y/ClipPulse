# Connect Codex or Claude Code to ClipPulse

ClipPulse exposes its existing versioned Agent API through an MCP stdio server. The desktop setup dialog registers the server with Codex or Claude Code, selects explicit filesystem roots, and performs a real MCP handshake before writing a client configuration.

## Set up from ClipPulse

1. Install and open ClipPulse.
2. Select **Agent** in the top toolbar, or **Connect AI agent** on the welcome screen.
3. Choose **OpenAI Codex** or **Claude Code**.
4. Add the folders containing source media and ClipPulse projects/exports. ClipPulse resolves and displays the exact folder grants.
5. Select **Test connection**. ClipPulse starts its local stdio server, initializes MCP, lists the tools, then calls only `diagnostics`. The test does not create projects or modify selected folders or source media.
6. Select **Create configuration**, then restart the chosen client.

The connected agent can read and write files inside every selected folder. Agent tools enforce those roots for projects, imports, analysis caches, and exports. Grant only the folders needed. A folder grant is not read-only: do not select a source folder if the agent must not be allowed to change its contents. Keep source media outside project/export folders when possible. ClipPulse itself does not modify imported original media during editing or export.

When a client configuration already exists, setup preserves other entries and first writes a timestamped `.bak` backup. It chooses a unique server name (`clippulse`, `clippulse-2`, and so on) rather than replacing an existing entry. Symbolic-link configuration files, malformed Claude JSON, and Codex's unsupported inline `mcp_servers = { ... }` layout are left unchanged with an explanation.

## How the installed MCP process starts

The client runs the installed ClipPulse executable with Electron's bundled Node runtime (`ELECTRON_RUN_AS_NODE=1`) and the packaged `dist/src/main/cli.js` entry point. It does not need a system Node.js installation or access to the development checkout. The MCP server uses the same CLI, AgentService, versioned API contract, and root permission checks as the existing CLI and REST interfaces.

The package enables Electron's `runAsNode` fuse so this launch mode works. This is a deliberate capability: a local process that can invoke the installed executable with that environment can run Node.js code as the current OS user. MCP does not elevate privileges, but it shares that user's permissions. Only connect clients you trust and grant narrow folders. Electron documents that disabling this fuse makes `ELECTRON_RUN_AS_NODE` be ignored; see its [environment variable documentation](https://www.electronjs.org/docs/latest/api/environment-variables) and [fuse guide](https://www.electronjs.org/docs/latest/tutorial/fuses).

The examples below show the config shape the setup dialog writes. Replace the sample install and folder paths with yours. In normal use, the dialog discovers the executable and packaged CLI path and writes the correct native Windows, Linux, or macOS paths for you.

## Codex configuration example

Codex reads user MCP servers from `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Its documented stdio shape uses `command`, `args`, and optional `env`:

```toml
[mcp_servers.clippulse]
command = "C:\\Program Files\\ClipPulse\\ClipPulse.exe"
args = ["C:\\Program Files\\ClipPulse\\resources\\app.asar\\dist\\src\\main\\cli.js", "mcp-server", "--allow-root", "D:\\Gaming\\Clips", "--allow-root", "D:\\Gaming\\Projects"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

To confirm Codex read the entry, run `codex mcp list`. In the Codex CLI/TUI, `/mcp` shows server connection status. The setup dialog updates the documented user config directly, so the Codex command-line tool does not need to be installed or on `PATH` during setup. Codex's [MCP guide](https://developers.openai.com/codex/mcp) documents both the CLI and TOML forms.

## Claude Code configuration example

Claude Code stores user-scoped servers in `~/.claude.json` (or the directory selected through `CLAUDE_CONFIG_DIR`). The setup dialog merges this standard stdio entry into the existing JSON:

```json
{
  "mcpServers": {
    "clippulse": {
      "type": "stdio",
      "command": "C:\\Program Files\\ClipPulse\\ClipPulse.exe",
      "args": [
        "C:\\Program Files\\ClipPulse\\resources\\app.asar\\dist\\src\\main\\cli.js",
        "mcp-server",
        "--allow-root", "D:\\Gaming\\Clips",
        "--allow-root", "D:\\Gaming\\Projects"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

After setup, run `claude mcp list` or `/mcp` in Claude Code to check its server. Anthropic documents the stdio transport and user scope in the [Claude Code MCP guide](https://docs.anthropic.com/en/docs/claude-code/mcp).

Claude Desktop is a separate product from Claude Code. Anthropic currently documents local Desktop Extensions (`.dxt`) under Settings > Extensions. ClipPulse does not yet ship a `.dxt` extension, and this dialog does not configure Claude Desktop. See Anthropic's [local MCP server guidance for Claude Desktop](https://support.anthropic.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

## What the connection test checks

- MCP stdio starts and completes `initialize`.
- The server provides `tools/list` and includes the safe `diagnostics` tool.
- A harmless `diagnostics` call responds with server/platform/runtime information.
- FFmpeg and FFprobe availability and compatibility are reported separately. An MCP connection can succeed while media export still needs FFmpeg setup.

The test has a 20-second timeout and does not create/open a project, write in selected folders, export media, or change source files.

## Troubleshooting

- **The client does not show ClipPulse tools:** restart Codex or Claude Code, then inspect `codex mcp list` or `claude mcp list` / `/mcp`.
- **ClipPulse fails to start after moving the app:** reopen Agent Setup and recreate the entry. The configuration contains both the app executable and the packaged CLI path.
- **Connection test times out or initialization fails:** confirm the installation is complete, the configured app executable still exists, and selected folders remain accessible to your OS account. Reinstall the same ClipPulse version if packaged files are missing.
- **Folder permission error:** reselect existing folders. A parent folder grants access to all content below it; keep roots narrow.
- **MCP connects but export is unavailable:** install compatible FFmpeg and FFprobe and restart the agent client. ClipPulse needs FFmpeg 6+ with `drawtext` and `libx264`.
- **Codex inline configuration error:** ClipPulse leaves that file unchanged. Review the current file, then use Codex's standard `[mcp_servers.<name>]` table or its `codex mcp add` command.
- **Claude configuration is invalid JSON:** ClipPulse leaves it unchanged. Repair or restore the file from its backup before retrying.
- **A different ClipPulse server entry already exists:** setup preserves it and adds a numbered entry. Remove an old entry through the client's own MCP management command after checking which entry is active.

## Verification status

On the current Windows x64 host, `npm run build`, all 58 automated tests, the MCP connection test through Electron, Codex's CLI config parsing, and a separately packaged unpacked app's MCP initialize/tools/diagnostics smoke test passed. The public NSIS installer has not been built in this run. A fully authenticated Codex agent request has not been verified. Claude Code is not installed in this environment, so a Claude Code client session is not claimed as tested. Linux and macOS packaging/runtime behavior has not been tested in this local run.

See [`AGENT_API.md`](AGENT_API.md) for the versioned tool, transport, and filesystem permission contract.
