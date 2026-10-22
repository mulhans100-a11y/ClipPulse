# CLI and project API (Phase A/B/C)

The desktop app and CLI use the same `src/core` operations. The CLI supports project, media library, audio analysis, timeline, and export operations; there is no REST or MCP server yet.

Run `npm run build` once, then invoke `npm run cli -- <command> ...`.

## Commands

```text
create --project FILE [--name NAME] [--fps NUM/DEN] [--width PIXELS --height PIXELS]
import --project FILE PATH... [--no-recursive]
media-search --project FILE [--query TEXT] [--favorites]
media-update --project FILE --media ID [--favorite true|false] [--rating 0-5] [--tag TAG] [--game NAME]
media-relink --project FILE --media ID --path FILE
analyze-audio --project FILE --media ID
history --project FILE
undo --project FILE
redo --project FILE
inspect --project FILE
validate --project FILE
track-add --project FILE --kind video|audio [--name NAME]
track-set --project FILE --track ID [--mute true|false] [--solo true|false] [--lock true|false]
clip-add --project FILE --media ID --track ID [--start TIME] [--source-in TIME] [--duration TIME]
clip-duplicate --project FILE --clip ID [--start TIME]
clip-audio --project FILE --clip ID [--enabled true|false] [--volume 0-8] [--fade-in TIME] [--fade-out TIME]
clip-trim --project FILE --clip ID [--start TIME] [--source-in TIME] [--duration TIME]
clip-move --project FILE --clip ID --start TIME [--track ID]
clip-split --project FILE --clip ID --at TIME
clip-remove --project FILE --clip ID
frame --project FILE --media ID --time TIME [--output IMAGE]
timeline-frame --project FILE --time TIME [--output IMAGE] [--overwrite]
export --project FILE --output FILE [--overwrite] [--encoder libx264|h264_amf|h264_nvenc|h264_qsv]
doctor
```

`--rating` accepts an integer from 0 to 5. A value of `0` clears the rating; values 1–5 rank the asset as a highlight. The rating is saved in the project and the SQLite media index.

The desktop media list restores completed audio-analysis status only when its cache matches the source file size and modification time. Running and failed states are tracked per asset while the editor is open.

`media-search --project FILE [--query TEXT] [--favorites]` searches indexed names, paths, games, and tags. `media-update --project FILE --media ID [--favorite true|false] [--rating 0-5] [--tag TAG] [--game NAME]` writes library metadata; rating zero clears a manual highlight score, while 1–5 ranks a clip. The score is stored in the project and SQLite index. `analyze-audio --project FILE --media ID` decodes a media asset's audio locally and returns estimated BPM hypotheses, beat positions, and transient timestamps. Results are cached beside the project using file size and modification time. Autocorrelation scores are comparative matches, not calibrated probabilities.

`media-relink --project FILE --media ID --path FILE` replaces a missing source path while retaining its ID. The replacement must have the same audio/video kind and cover every existing clip source range.

In the desktop timeline, analyzed audio clips display beat ticks. The Snap toggle aligns playhead placement, clip insertion, and clip moves to detected beats and clip boundaries within a 10-pixel threshold; timing resolves to the nearest project frame.

`track-set` updates track mute, solo, and lock state. Solo is applied independently to video and audio track groups in both the timeline preview and final export. `clip-duplicate` copies a clip's source range and audio settings to the same track immediately after it; `--start` overrides that timeline position.

`clip-audio` changes the selected clip's audio enable flag, linear volume multiplier, and fade durations. Fade durations are nonnegative project-time values no longer than the clip; export applies them to the trimmed source audio before timeline mixing.

`timeline-frame --project FILE --time TIME` renders one frame-snapped composite from the active, unmuted video tracks. The desktop Timeline monitor uses this command's shared core operation for its still preview; source video playback remains available in the Source monitor.

`history` reports persistent undo/redo availability. `undo` and `redo` restore a project snapshot from the adjacent `.openmontage-history-<id>` folder. The journal holds up to 50 states and starts a new branch after an edit made while redo states exist.

`TIME` is a nonnegative rational number of seconds, entered either as a decimal (`2.5`) or a fraction (`5/2`). An omitted clip duration extends from `source-in` to the end of the source. Video-only media cannot be placed on an audio track's video output; audio-only media cannot be placed on a video track.

## JSON response and errors

Success:

```json
{ "ok": true, "data": { "...": "command result" } }
```

Failure (exit code 1):

```json
{ "ok": false, "error": { "code": "TRACK_NOT_FOUND", "message": "Track not found: ..." } }
```

Stable error codes include `INVALID_ARGUMENTS`, `UNKNOWN_COMMAND`, `PROJECT_READ_FAILED`, `INVALID_PROJECT`, `PROJECT_EXISTS`, `MEDIA_NOT_FOUND`, `TRACK_NOT_FOUND`, `CLIP_NOT_FOUND`, `TRACK_LOCKED`, `MEDIA_TYPE_MISMATCH`, `SOURCE_RANGE_EXCEEDED`, `SPLIT_OUTSIDE_CLIP`, `MISSING_MEDIA`, `OUTPUT_EXISTS`, `SOURCE_OVERWRITE_BLOCKED`, `EMPTY_TIMELINE`, and `EXPORT_FAILED`.

## Project time fields

All time fields are reduced rational seconds encoded as strings:

```json
{ "num": "3003", "den": "1000" }
```

`frameRate` is frames per second as a rational pair, such as `{"num":"30000","den":"1001"}`. Frame positions are derived using integer arithmetic. Stable IDs are UUIDs except imported media IDs, which are the first 32 hexadecimal characters of the SHA-256 source hash.

## Core operation contracts

- `addClip` validates track/media compatibility and ensures `sourceIn + duration` does not exceed media duration.
- `trimClip` changes start/source-in/duration without changing source media.
- `moveClip` can reposition and move a clip to another compatible track.
- `splitClip` keeps the source ranges contiguous and creates a new right-hand clip.
- `exportVideo` refuses to replace any imported source path and only finalizes output after FFprobe confirms a video stream.

Desktop IPC is private to the app renderer and is defined by `src/shared/electron.d.ts`. A stable external network API and MCP JSON Schemas are roadmap items, not current capabilities.
