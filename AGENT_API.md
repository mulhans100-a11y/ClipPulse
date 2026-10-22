# Agent API (schema version 1)

OpenMontage exposes one shared editing service through the CLI, loopback REST, and MCP stdio. All three call `src/core`; they do not maintain separate editing rules. Times accepted by tools are decimal or rational strings (for example `1.25` or `5/4`) and project times returned by the service are exact `{ "num": "5", "den": "4" }` pairs.

The checked-in tool contracts are in [`config/agent-api-v1.schema.json`](config/agent-api-v1.schema.json). The live contract can be regenerated with `npm run cli -- schema`. Successful CLI responses use `{ "schemaVersion": 1, "ok": true, "data": ... }`; failures use `{ "schemaVersion": 1, "ok": false, "error": { "code": ..., "message": ... } }`. MCP `tools/list` returns the same input schemas, and `tools/call` returns both `structuredContent` and ordinary MCP content blocks. Preview frames are MCP image blocks; REST/CLI tool results carry base64 image data.

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

`GET /v1` returns service/version information, `GET /v1/tools` lists typed schemas, and `GET /v1/schema` returns the versioned contract. `POST /v1/tools/<tool-name>` runs one tool; `POST /v1/transactions` accepts a `project_transaction` payload. Request bodies are limited to 10 MiB. Permission roots are canonicalized at startup. Reads, writes, exports, effect LUT/font files, and imported media must remain inside those roots. Recursive folder import rejects symbolic links. Existing project references outside the grants are reported by `project_validate` and cannot be previewed, analyzed, or exported.

## MCP stdio

Configure the MCP host to launch the compiled CLI as a child process. Every `--allow-root` is a separate grant:

```json
{
  "mcpServers": {
    "openmontage": {
      "command": "node",
      "args": [
        "C:\\path\\to\\OpenMontage-AI\\dist\\src\\main\\cli.js",
        "mcp-server",
        "--allow-root", "C:\\Medal\\Clips",
        "--allow-root", "C:\\Medal\\Exports"
      ]
    }
  }
}
```

The process speaks newline-delimited MCP JSON-RPC on stdin/stdout; diagnostics go nowhere on stdout. It implements `initialize`, `ping`, `tools/list`, and `tools/call`. No network listener is created for MCP.

## Editing workflow and recovery

An agent can create/open/inspect/validate a project, change its profile, import/search/update assets and event reviews, analyze music and event cues, retrieve source/composite frames, add tracks/clips, trim/move/split/align/remove clips, set audio/effects/keyframes/masks/blends, create montage variants, preview, and export. `project_inspect` returns the saved project model with exact time pairs and effect/mask data; `project_open` also returns undo/redo availability.

Every project operation is serialized per project in a service instance and each edit uses the core's atomic save/history journal. `project_transaction` accepts up to 32 timeline/effect edits. Other operation classes (such as export or montage generation) are rejected inside a transaction. If any step fails, the service restores the original project and history before returning `TRANSACTION_ROLLED_BACK`. Undo/redo remain available after successful commits.

`video_export` returns a UUID job immediately. Poll `render_status` for `running`, `complete`, or `failed` and progress; the export is written to a temporary file and validated by FFprobe before finalization. Render-job status is stored in the project cache. After a process restart, an unfinished job is reported as `RENDER_INTERRUPTED`; start another export to recover. Source files are never overwritten.

Errors preserve stable application codes. Agent-specific codes include `UNKNOWN_TOOL`, `PATH_PERMISSION_REQUIRED`, `PATH_PERMISSION_INVALID`, `PATH_PERMISSION_DENIED`, `PATH_NOT_FOUND`, `PATH_SYMLINK_DENIED`, `INVALID_JSON`, `REQUEST_TOO_LARGE`, `TRANSACTION_OPERATION_DENIED`, `TRANSACTION_PROJECT_MISMATCH`, `TRANSACTION_ROLLED_BACK`, `JOB_NOT_FOUND`, and `RENDER_INTERRUPTED`. Editing and rendering also return core codes such as `INVALID_ARGUMENTS`, `PROJECT_READ_FAILED`, `INVALID_PROJECT`, `MEDIA_NOT_FOUND`, `TRACK_NOT_FOUND`, `CLIP_NOT_FOUND`, `TRACK_LOCKED`, `SOURCE_RANGE_EXCEEDED`, `MISSING_MEDIA`, `OUTPUT_EXISTS`, `SOURCE_OVERWRITE_BLOCKED`, `EMPTY_TIMELINE`, and `EXPORT_FAILED`.

## Tool groups

- Project and recovery: `project_create`, `project_update_profile`, `project_open`, `project_inspect`, `project_validate`, `project_save`, `project_undo`, `project_redo`, `project_transaction`.
- Media and analysis: `media_import`, `media_search`, `media_get`, `media_update`, `media_relink`, `media_get_frames`, `media_analyze`, `audio_analyze`, `audio_get_beat_grid`, `highlights_detect`, `highlights_rank`.
- Timeline and compositing: `timeline_inspect`, `timeline_add_track`, `timeline_add_clip`, `timeline_duplicate_clip`, `timeline_trim_clip`, `timeline_move_clip`, `timeline_split_clip`, `timeline_remove_clip`, `timeline_align_event`, `timeline_set_track`, `timeline_set_clip_audio`, `effect_add`, `effect_update`, `effect_remove`, `keyframe_set`, `mask_create`, `mask_track`, `mask_segment`, `composition_create`.
- Montage and render: `montage_generate`, `preview_render`, `preview_analyze`, `video_export`, `render_status`, `diagnostics`.

`mask_segment` runs the pinned DETR ONNX model locally, downloads its weights on first use, and writes editable keyframes for a recognized object class. The model cache is inside the granted project cache. It follows instances by mask overlap and stabilizes sampled contours; it does not provide dense optical flow or arbitrary text-prompt segmentation. Detector and montage scores remain heuristics as described in [`ROADMAP.md`](ROADMAP.md).

