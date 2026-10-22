# Security policy

ClipPulse is an early local desktop application. It does not currently run a network service, upload media, or use cloud accounts.

## Reporting a vulnerability

Until a private security contact is configured for a public repository, do not post sensitive exploit details publicly. Contact the repository maintainers privately through the channel associated with the repository, and include the affected version, steps to reproduce, and impact. Remove private footage, credentials, and personal paths from reports where possible.

## Current boundaries

- The renderer runs with Node integration disabled, context isolation enabled, and Electron sandboxing enabled.
- The preload exposes only explicit project, media, timeline, export, and reveal operations.
- FFmpeg and FFprobe process local files using argument arrays rather than shell command strings.
- Project JSON and imported file paths are user-controlled local data. Malformed projects are structurally validated before editing.
- CLI operations inherit the permissions of the current user; path-level permission grants are not implemented yet.

This policy and the app's security surface should be reviewed before adding a local REST/MCP server, plugins, external model downloads, or cloud integrations.
