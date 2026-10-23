# Agent API (schema version 1)

ClipPulse exposes one shared editing service through the CLI, loopback REST, and MCP stdio. All three call `src/core`; they do not maintain separate editing rules. Times accepted by tools are decimal or rational strings (for example `1.25` or `5/4`) and project times returned by the service are exact `{ "num": "5", "den": "4" }` pairs. Legacy internal identifiers and existing `.omproj` files remain unchanged for compatibility.

The checked-in tool contracts are in [`config/agent-api-v1.schema.json`](config/agent-api-v1.schema.json). The live contract can be regenerated with `npm run cli -- schema`. Successful CLI responses use `{ "schemaVersion": 1, "ok": true, "data": ... }`; failures use `{ "schemaVersion": 1, "ok": false, "error": { "code": ..., "message": ... } }`. MCP `tools/list` returns the same input schemas. MCP negotiates protocol versions from 2025-11-25 back to 2024-11-05; `structuredContent` and tool `outputSchema` are sent only when the negotiated version supports structured tool output. Preview frames are MCP image blocks; REST/CLI tool results carry base64 image data.

The generic CLI command exposes every registered tool with the same validation and path grants:

```powershell
$arguments = @{ projectPath = 'C:\Medal\Exports\montage.omproj'; name = 'Montage'; width = 1920; height = 1080; frameRate = '60/1' } | ConvertTo-Json -Compress
npm run cli -- agent-call --allow-root C:\Medal --tool project_create --arguments $arguments
```

The older concise CLI commands remain available for shell workflows. Their outputs now also include `schemaVersion: 1`.

## Local REST

Build first, then start the service with explicit filesystem grants:

```powershell
npm run build
npm run cli -- serve --allow-root C:\Medal\Clips --allow-root C:\Medal\Exports --port 43173
```

It binds only to `127.0.0.1`. Startup prints the generated bearer token once as versioned JSON; pass `--token` to use a caller-managed token of at least 24 characters. Send `Authorization: Bearer <token>` with every request. Browser `Origin` requests are rejected to reduce localhost CSRF exposure. The service has no remote bind option.

```powershell
$headers = @{ Authorization = 'Bearer <token>' }
Invoke-RestMethod http://127.0.0.1:43173/v1/tools -Headers $headers
Invoke-RestMethod http://127.0.0.1:43173/v1/tools/project_create -Method Post `
  -Headers $headers -ContentType 'application/json' `
  -Body '{"projectPath":"C:\\Medal\\Exports\\montage.omproj","name":"Test","width":1920,"height":1080,"frameRate":"60/1"}'
```

`GET /v1` returns service/version information, `GET /v1/tools` lists typed schemas, and `GET /v1/schema` returns the versioned contract. `POST /v1/tools/<tool-name>` runs one tool; `POST /v1/transactions` accepts a `project_transaction` payload. Request bodies are limited to 10 MiB and oversized requests return HTTP 413. Invalid JSON/arguments return 400, unknown tools return 404, denied paths return 403, and output conflicts return 409. Permission roots are canonicalized at startup. Reads, writes, exports, effect LUT/font files, and imported media must remain inside those roots. Recursive folder import rejects symbolic links. Existing project references outside the grants are reported by `project_validate` and cannot be previewed, analyzed, or exported.

## MCP stdio

The desktop app's **Agent** setup dialog configures Codex or Claude Code and tests MCP without creating a project. The installed app starts the packaged CLI through Electron's bundled Node runtime, so a separate Node.js installation is not required. Every `--allow-root` is a separate read/write grant. Example for an installed Windows app (the exact paths are discovered and written by the dialog):

```json
{
  "mcpServers": {
    "clippulse": {
      "type": "stdio",
      "command": "C:\\Program Files\\ClipPulse\\ClipPulse.exe",
      "args": [
        "C:\\Program Files\\ClipPulse\\resources\\app.asar\\dist\\src\\main\\cli.js",
        "mcp-server",
        "--allow-root", "C:\\Medal\\Clips",
        "--allow-root", "C:\\Medal\\Exports"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Claude Code reads user servers from `~/.claude.json`; Codex reads stdio servers from `~/.codex/config.toml`. Both paths can be customized by their client environment variables. The configuration manager creates dated backups, preserves other entries, and chooses a numbered server name if `clippulse` already exists. See [`MCP_SETUP.md`](MCP_SETUP.md) for the current documented formats, app onboarding, troubleshooting, and the Claude Desktop limitation.

The process speaks newline-delimited MCP JSON-RPC on stdin/stdout; diagnostics go nowhere on stdout. It implements `initialize`, `ping`, `tools/list`, and `tools/call`; malformed JSON/requests produce protocol errors without terminating the server. No network listener is created for MCP. The legacy development CLI remains supported:

```sh
npm run build:main
npm run cli -- mcp-server --allow-root "/path/to/Clips" --allow-root "/path/to/Projects"
```

`npm test` also connects an MCP SDK client over stdio, lists the server tools, and calls the harmless `diagnostics` tool. On Windows it additionally starts the MCP server through the Electron runtime bundled with the application. The packaged app enables Electron's `runAsNode` fuse to support this; see [`MCP_SETUP.md`](MCP_SETUP.md) for the local-process security tradeoff and cross-platform setup examples.

## Editing workflow and recovery

An agent can create/open/inspect/validate a project, change its profile, import/search/update assets and event reviews, analyze music and event cues, retrieve source/composite frames, add tracks/clips, trim/move/split/align/remove clips, set audio/effects/keyframes/masks/blends, create montage variants, preview, and export. `project_inspect` returns the saved project model with exact time pairs and effect/mask data; `project_open` also returns undo/redo availability.

For an existing project library, `media_search` can filter indexed asset names, paths, games, and tags. `montage_generate` requires a project path, music asset ID, and target duration; its `videoIds` field is optional. When omitted, the generator analyzes all video assets in that project and selects eligible reviewed/high-scoring event windows itself, so the agent does not need to supply a hand-picked clip list. The music can be added first with `media_import` if the user provides a file that is not yet in the project. The MCP server does not currently expose the desktop's active-project path implicitly: the agent must already know the project path, and that project and its media must be inside the configured grants.

`highlights_detect` and `highlights_rank` return backward-compatible event `kind` fields plus `eventType`, `evidenceLevel`, `signals`, `uncertainties`, and normalized `scoreBreakdown` fields on newly analyzed events. `explicit` means a configured phrase was recognized in OCR; it is still subject to OCR error. Audio/motion agreement is only `corroborated` combat activity. A normalized top-right OCR row change is `kill_feed_change` with `heuristic` evidence and is not a confirmed kill. OCR-dependent results require local Tesseract; no external model or API key is required or used. The desktop and `media_update.analysisEventReviews` support persisting a manually corrected timestamp and optional `correctedEventType`.

`audio_analyze` and `audio_get_beat_grid` preserve the existing `analysis.beats`, `beatGrid.beats`, `downbeats`, `bpm`, and `hypotheses` fields. The response additively includes confidence-bearing `beatGrid.points`, local `tempoSegments`, `onsetEvents`, stronger `accents`, and section-scale `structureEvents` (`build_up`, `drop`, `quiet`, `section_change`, `strong_accent`). Grid/segment/event confidence values are relative heuristic signal scores, not calibrated probabilities. Onset events can be offbeat or subdivisions and must not be treated as the beat grid. The audio analysis cache version changed to v5, so older cached results are recomputed once; the version 1 agent contract is unchanged.

The local evaluator command `npm run cli -- evaluate-highlights --dataset <manifest.json> --output <report.json>` emits per-event-type precision/recall/F1 and mean absolute event-time error, along with a time-only activity-cue baseline. Use authorized source media and independent complete-interval annotations as described in [`GAMEPLAY_HIGHLIGHTS.md`](GAMEPLAY_HIGHLIGHTS.md); the synthetic parser fixture is not a gameplay accuracy benchmark.

Every project operation is serialized per project in a service instance and each edit uses the core's atomic save/history journal. `project_transaction` accepts up to 32 timeline/effect edits. Other operation classes (such as export or montage generation) are rejected inside a transaction. If any step fails, the service restores the original project and history before returning `TRANSACTION_ROLLED_BACK`. A transaction also writes a project-adjacent recovery snapshot; if the process exits during a transaction, the next agent operation restores the project and history before proceeding. Undo/redo remain available after successful commits.

`video_export` returns a UUID job immediately. Poll `render_status` for `running`, `complete`, or `failed` and progress; the export is written to a temporary file and validated by FFprobe before finalization. Render-job status is stored in the project cache. After a process restart, an unfinished job is reported as `RENDER_INTERRUPTED`; inspect the project and start another export to resume. Source files are never overwritten. The client test harness retries transient transport failures only for non-editing operations, with three attempts and exponential backoff. Mutating calls are never replayed automatically after a lost response; inspect the project first. An interrupted transaction is restored automatically on the next request.

`quality_analyze` reports structural and measured render issues, representative preview frame paths/statistics, severity, evidence level, and possible edits. Pass explicit `selectedBeatTargets` to measure edit timing against caller-selected beats. `quality_report_list` and `quality_report_get` retrieve the project-adjacent report history. `quality_improve` runs at most three analyze/fix/recheck iterations and uses `project_transaction` for its sole automatic correction: closing a short video gap bounded by adjacent clips on the same track. Reports distinguish objective checks from heuristics; subjective aesthetic scoring is not run. Audio analysis uses a temporary export render and removes it after measurement. See [`QUALITY_CONTROL.md`](QUALITY_CONTROL.md) for thresholds, workflow, and limitations.

Errors preserve stable application codes. Agent-specific codes include `UNKNOWN_TOOL`, `PATH_PERMISSION_REQUIRED`, `PATH_PERMISSION_INVALID`, `PATH_PERMISSION_DENIED`, `PATH_NOT_FOUND`, `PATH_SYMLINK_DENIED`, `INVALID_JSON`, `REQUEST_TOO_LARGE`, `TRANSACTION_OPERATION_DENIED`, `TRANSACTION_PROJECT_MISMATCH`, `TRANSACTION_ROLLED_BACK`, `AGENT_RECOVERY_FAILED`, `JOB_NOT_FOUND`, and `RENDER_INTERRUPTED`. Editing and rendering also return core codes such as `INVALID_ARGUMENTS`, `PROJECT_READ_FAILED`, `INVALID_PROJECT`, `MEDIA_NOT_FOUND`, `TRACK_NOT_FOUND`, `CLIP_NOT_FOUND`, `TRACK_LOCKED`, `SOURCE_RANGE_EXCEEDED`, `MISSING_MEDIA`, `OUTPUT_EXISTS`, `SOURCE_OVERWRITE_BLOCKED`, `EMPTY_TIMELINE`, and `EXPORT_FAILED`.

For a reproducible 30-second synthetic-media workflow, report format, and optional 20-clip local run, see [`AGENT_E2E.md`](AGENT_E2E.md).

## Tool groups

- Project and recovery: `project_create`, `project_update_profile`, `project_open`, `project_inspect`, `project_validate`, `project_save`, `project_undo`, `project_redo`, `project_transaction`.
- Media and analysis: `media_import`, `media_search`, `media_get`, `media_update`, `media_relink`, `media_get_frames`, `media_analyze`, `audio_analyze`, `audio_get_beat_grid`, `highlights_detect`, `highlights_rank`.
- Timeline and compositing: `timeline_inspect`, `timeline_add_track`, `timeline_add_clip`, `timeline_duplicate_clip`, `timeline_trim_clip`, `timeline_move_clip`, `timeline_split_clip`, `timeline_remove_clip`, `timeline_align_event`, `timeline_set_track`, `timeline_set_clip_audio`, `effect_add`, `effect_update`, `effect_remove`, `keyframe_set`, `mask_create`, `mask_track`, `mask_segment`, `composition_create`.
- Quality control: `quality_analyze`, `quality_report_get`, `quality_report_list`, `quality_improve`.
- Montage and render: `montage_generate`, `preview_render`, `preview_analyze`, `video_export`, `render_status`, `diagnostics`.

`mask_segment` runs the pinned DETR ONNX model locally, downloads its weights on first use, and writes editable keyframes for a recognized object class. The model cache is inside the granted project cache. It follows instances by mask overlap and stabilizes sampled contours; it does not provide dense optical flow or arbitrary text-prompt segmentation. Detector and montage scores remain heuristics as described in [`ROADMAP.md`](ROADMAP.md).

