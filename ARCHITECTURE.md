# Architecture

## Current implementation

OpenMontage AI is split into three local layers:

1. **Electron main process** (`src/main`) owns native dialogs, project and media file access, FFmpeg process execution, and renderer IPC.
2. **Core editing engine** (`src/core`) owns the versioned project model, validation, rational time arithmetic, media probing/import, timeline edits, and rendering. The CLI and desktop app call the same core functions.
3. **React renderer** (`src/renderer`) presents the media bin, source preview, timeline, transport, and inspector. It cannot access Node.js or arbitrary filesystem APIs directly; operations go through a narrow preload bridge.

The current desktop API is Electron IPC. The CLI is the first stable headless interface. REST and MCP are planned, but are not exposed in this build.

## Project and time model

An `.omproj` is a JSON document with `schemaVersion`, output profile, media records, tracks, and clips. Clip times are reduced rational seconds (`{ "num": "5", "den": "2" }` means 2.5 seconds), stored as decimal strings so integer arithmetic can use `BigInt` without float drift. The project frame rate is also rational (for example, `30000/1001`). UI timing edits snap to exact project frames; the CLI accepts decimal or `numerator/denominator` time values.

Imported assets retain their absolute source path, basic FFprobe metadata, a SHA-256 content identity, and a cached preview image. Video assets use a thumbnail frame; audio-only assets use a local FFmpeg `showwavespic` image displayed on media cards and timeline clips. Import never copies, transcodes, or modifies the source. Images are stored in a project-adjacent `.openmontage-cache-<project-id>` directory.

That cache also contains a SQLite index for import roots, media metadata, tags, favorites, and game names. When a file's path, size, and modification timestamp match an indexed record, re-import reuses its metadata without probing or hashing the file again. Changed files are hashed and exact duplicates are detected across paths. Folders explicitly selected for import are watched with a debounced local filesystem watcher; the media panel can pause or resume each root. The `.omproj` remains the project state and the SQLite index can be rebuilt.

Missing source paths are checked when a project opens. Relinking a file requires the same media kind and enough duration for all existing clip source ranges; it updates metadata and thumbnails while retaining the media ID, so clip references remain valid.

Edits are non-destructive: clips refer to media and record a timeline start, source in point, duration, and audio settings. Saving writes a temporary JSON file and renames it into place. Before replacement the previous project becomes `<project>.bak`; a project-adjacent history journal stores up to 50 complete states with a cursor for persistent undo/redo. Restoring a snapshot also synchronizes project media metadata in SQLite so tags and favorites follow undo/redo.

## Export path

The renderer builds one FFmpeg filter graph from project state. A generated black canvas establishes the output profile. Video clips are trimmed, timestamped into timeline position, scaled with aspect ratio preserved, padded, and overlaid in track order. Clip audio is trimmed, timestamped, mixed, and limited. FFmpeg encodes H.264/AAC into a temporary MP4; FFprobe checks that the result has a video stream before the file is installed at the requested path. Source overwrite is rejected.

The Timeline monitor requests a frame-snapped still image from `renderTimelineFrame` when the playhead moves. It composites active, unmuted video clips over black in the same track order as export and caches frames under the project cache. The Source monitor plays original source media in the browser video element. Timeline playback is not real time yet; effects, transitions, waveform display, and full preview/export parity remain future work.

## Security and reliability boundaries

- Renderer Node integration is disabled, context isolation and sandboxing are enabled, and the preload exposes explicit editing operations only.
- The app listens on no network port. The current CLI is local and does not implement a network service.
- Project operations validate references and source ranges before writing.
- Export writes to a temporary file and validates the output before finalizing.
- FFmpeg and FFprobe are external runtime dependencies, not bundled binaries.
- Media paths are local absolute paths. Permission-scoped directory grants, path relinking, and portable project packaging remain future work.
- The application uses Node 24's built-in `node:sqlite` API for the local index; the CLI currently requires Node 24 or newer.

## Planned expansion

The `DetectorPlugin` interface in `src/core/highlightAnalysis.ts` is the extension point for local, model-backed, and game-specific detectors. Current built-ins emit audio-activity and FFmpeg scene-change cues; the pipeline groups coincident signals, ranks them with configurable heuristic weights, records timestamp windows and detector evidence, and caches results by source metadata and detector versions. These are activity cues, not gameplay predictions. Varied real-media evaluation, motion/OCR/game-specific detectors, review and correction, and calibrated quality ranking remain outstanding. The next editing increment should create ordinary editable timeline clips from a reviewable edit plan. Effects should be serialized as typed clip properties and compiled by a renderer used by both preview and export. Masks and tracking should likewise produce persisted frame/time data and use that same compositor. API/MCP should be thin validated adapters around core operations rather than a second editor implementation.

OpenTimelineIO may be added for interchange, but it will not replace the FFmpeg rendering engine.
