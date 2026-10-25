# CLI and project API (Phase A/B/C/D/E/F/G)

The desktop app, CLI, loopback REST service, and MCP stdio server use the same `src/core` operations. The stable agent interfaces and typed tool catalog are documented in [`AGENT_API.md`](AGENT_API.md); generated JSON Schemas are in [`config/agent-api-v1.schema.json`](config/agent-api-v1.schema.json).

Run `npm run build` once, then invoke `npm run cli -- <command> ...`.

## Commands

```text
create --project FILE [--name NAME] [--fps NUM/DEN] [--width PIXELS --height PIXELS]
import --project FILE PATH... [--no-recursive]
media-search --project FILE [--query TEXT] [--favorites]
media-update --project FILE --media ID [--favorite true|false] [--rating 0-5] [--tag TAG] [--game NAME]
media-relink --project FILE --media ID --path FILE
analyze-audio --project FILE --media ID
analyze-highlights --project FILE --media ID
generate-montage --project FILE --music ID [--duration SEC] [--selection library|selected|ranges] [--video ID ...] [--source-range ID@START@END ...] [--range-policy strict|flexible] [--style clean|aggressive|cinematic|smooth|velocity|custom] [--custom-rules FILE.json] [--reference ID] [--variants 1-5] [--intensity 0-100] [--format project|landscape-1080p|portrait-1080p|square-1080p] [--output-dir DIR]
evaluate-highlights --dataset FILE [--max-gap SEC] [--output REPORT.json]
segment-mask --project FILE --clip ID [--class person] [--sample-fps 2] [--model-cache DIR]
analysis-runtimes
history --project FILE
undo --project FILE
redo --project FILE
inspect --project FILE
validate --project FILE
track-add --project FILE --kind video|audio [--name NAME]
track-set --project FILE --track ID [--mute true|false] [--solo true|false] [--lock true|false] [--volume 0-8] [--role standard|dialogue|music] [--normalize true|false] [--duck-under-dialogue true|false] [--volume-keyframes FILE.json]
clip-add --project FILE --media ID --track ID [--start TIME] [--source-in TIME] [--duration TIME]
clip-duplicate --project FILE --clip ID [--start TIME]
clip-audio --project FILE --clip ID [--enabled true|false] [--volume 0-8] [--fade-in TIME] [--fade-out TIME]
clip-effects --project FILE --clip ID --effects FILE.json
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

`generate-montage` validates cached local analyses first and analyzes additional project videos only if the cached pool cannot cover the requested edit. Without `--duration`, the selected music asset determines the edit length (up to the existing 30-minute limit); pass a shorter duration for a short music section. `--selection library` uses all videos imported into the project. `--selection selected` uses only repeated `--video ID` inputs. `--selection ranges` requires a `--source-range ID@START@END` for each selected video and uses only those media windows for video, motion, and HUD sampling. `--range-policy strict` keeps output inside each range; `flexible` allows the selected preset's bounded lead/tail context. A local `--reference ID` transfers measured cut cadence and excludes that reference from target footage. The command produces one to five separate editable `.omproj` variants, one `.edit-plan.json` report per variant, and a `performance-report.json` in a unique child folder. It does not save or rewrite the source project. Stage timings include ClipPulse orchestration and child-process wait. The report also records accumulated child-process wall times for FFmpeg, FFprobe, Tesseract, and other executables; overlapping process times can sum to more than overall wall time. Export after generation, external AI wait, and Codex/Claude planning time are outside this report.

Styles change real cut cadence, anchor preferences, cut placement, and source/music audio levels. `clean`, `aggressive`, `cinematic`, and `velocity` use built-in presets. `custom` requires `--custom-rules FILE.json`; use [`config/auto-montage-rules.example.json`](config/auto-montage-rules.example.json), validated against [`config/auto-montage-rules.schema.json`](config/auto-montage-rules.schema.json). `--intensity` is a 0–100 cut-pacing control. Output format can preserve the source project profile or create 16:9, 9:16, or square 1080p projects.

In the desktop app, select **Auto edit**, choose audio and a selection mode, then choose style, output format, intensity, and variant count. The initial length follows the selected song; set a shorter duration when you want a music section. In selected-clip or range mode, check the permitted clips. Range mode provides a preview, editable start/end marks, reset, and strict/flexible behavior. Generated projects appear in the same modal. Open one to inspect or edit the timeline, then use the regular Export command. The source timeline remains a separate project.

`media-search --project FILE [--query TEXT] [--favorites]` searches indexed names, paths, games, and tags. `media-update --project FILE --media ID [--favorite true|false] [--rating 0-5] [--tag TAG] [--game NAME]` writes library metadata; rating zero clears a manual highlight score, while 1–5 ranks a clip. The score is stored in the project and SQLite index. `analyze-audio --project FILE --media ID` decodes audio locally and returns BPM hypotheses, beat and downbeat positions, a cautious meter estimate, relative one-second energy, coarse energy sections, energy-rise markers, and transient timestamps. Results are cached beside the project using file size and modification time. Rhythm and meter values are heuristic; scores are not calibrated probabilities.

`analyze-highlights --project FILE --media ID` runs built-in audio-activity, FFmpeg scene-change, sampled-frame motion, and optional Tesseract HUD-text detectors when their media streams and runtimes are available. It returns ranked event windows with start, decisive, and end times, detector IDs/versions, evidence, confidence, and relative cue scores. Coincident cues are combined into one event. These scores are technical heuristics; they do not classify gameplay or measure highlight quality. Results are cached by source file metadata, detector versions, and scoring weights. The core `DetectorPlugin` interface accepts additional local or model-backed detectors; callers can pass alternate scoring weights to `analyzeHighlightCues`.

`analysis-runtimes` reports the local FFmpeg and optional Tesseract status, whether custom game rules are configured, and whether a gameplay-model inference adapter is available. Tesseract OCR skips cleanly when the executable is missing; OCR samples up to 120 resized frames per asset. Motion cues compare 64×36 grayscale frames at 4 fps. Built-in game phrase profiles and optional `OPENMONTAGE_GAME_RULES` JSON rules classify explicit OCR phrases as heuristic events. No gameplay model is bundled or claimed.

`evaluate-highlights --dataset FILE [--max-gap SEC] [--output REPORT.json]` reads a version 1 evaluation manifest with local media paths and at least two independently reviewing annotators per item. Paths resolve relative to the manifest; optional SHA-256 values pin sources. `reviewedBy` records complete review coverage, including negative clips with an empty `annotations` array. Events become consensus when a strict majority label the same event type within two seconds; their median timestamps form the reference. The report includes per-detector precision/recall/F1, false positives and false negatives, raw-score Brier/ECE diagnostics, plus BPM error and beat/downbeat precision/recall for music annotations. These are diagnostics for the supplied dataset and do not recalibrate runtime confidence values. A template and workflow are in `evaluation/`.

In the desktop inspector, each event can be accepted, rejected, or corrected by editing its start, decisive, and end times. Reviews are stored in the `.omproj`. The displayed per-detector reviewed-proposal precision is the acceptance rate among decisions on that asset. Recall remains unreported until missed events are independently labeled.

`media-relink --project FILE --media ID --path FILE` replaces a missing source path while retaining its ID. The replacement must have the same audio/video kind and cover every existing clip source range.

In the desktop timeline, analyzed audio clips display beat ticks. The Snap toggle aligns playhead placement, clip insertion, and clip moves to detected beats and clip boundaries within a 10-pixel threshold; timing resolves to the nearest project frame.

`track-set` updates track mute, solo, lock, gain, audio role, normalization, ducking, and gain keyframes. The volume-keyframe JSON file is an array of `{ "time": Rational, "value": number, "interpolation": "linear"|"hold" }` entries; times are timeline times. Use [`config/track-volume-keyframes.example.json`](config/track-volume-keyframes.example.json) as a starting point. Set a music track to `--role music --duck-under-dialogue true` and dialogue tracks to `--role dialogue` to apply sidechain compression while they overlap. Solo is applied independently to video and audio track groups in both the timeline preview and final export. `clip-duplicate` copies a clip's source range and audio/effect settings to the same track immediately after it; `--start` overrides that timeline position.

`clip-audio` changes the selected clip's audio enable flag, linear volume multiplier, and fade durations. Fade durations are nonnegative project-time values no longer than the clip; export applies them to the trimmed source audio before timeline mixing.

`clip-effects --project FILE --clip ID --effects FILE.json` applies a JSON patch to a clip. Start from [`config/clip-effects.example.json`](config/clip-effects.example.json), validated by [`config/clip-effects.schema.json`](config/clip-effects.schema.json). Use `null` for optional fields to clear them. Playback rate and speed-keyframe rates are rational source-seconds-per-timeline-second values from 0.25× to 4×. Speed-keyframe times are relative to the clip's timeline start; linear rates are integrated to choose source frames. The clip's source range must cover that integral. Video keyframes support opacity, brightness, contrast, saturation, and clip gain. Interpolation is linear by default; `hold` keeps the previous value until the next keyframe.

`segment-mask --project FILE --clip ID [--class person] [--sample-fps 2] [--model-cache DIR]` generates a model-based mask for a video clip. It downloads the pinned ONNX instance-segmentation model on first use, runs inference locally on sampled clip frames, follows the matching object by mask overlap, stabilizes isolated one-frame flicker, and writes an editable, time-keyed mask into the project. The default model recognizes common COCO classes such as `person`, `car`, `dog`, `cat`, and `chair`; it does not know arbitrary in-game meshes. Model weights are stored in the platform user cache (or the supplied `--model-cache` folder). The desktop inspector provides the same control and progress status. The MCP API exposes the `mask_segment` tool.

Clip effects also support scale, pixel position, rotation, brightness/contrast/saturation, an optional `.cube` LUT file, dissolve/wipe transitions, and a title with font, color, position, timing, and optional backing box. Phase F adds alpha-aware polygon and Bézier path masks (`M`, `L`, `Q`, `C`, `Z`; normalized 0–1 coordinates), feather and expansion in pixels, time-keyed paths for manually corrected or model-generated tracking, a YUV chroma key, and normal/multiply/screen/add/difference layer blending. Model masks use sampled ONNX instance segmentation, overlap-based instance following, and temporal majority stabilization. Example mask syntax and the JSON schema are in `config/clip-effects.example.json` and `config/clip-effects.schema.json`. Tracking corrections interpolate corresponding flattened path points; each correction must produce the same flattened point count. Dense optical-flow tracking and arbitrary text-prompt segmentation are unavailable. LUT and custom font paths are read-only render inputs. Timeline still preview and final export use the same video and compositing filters. Audio speed ramps are rendered as pitch-preserving tempo sections averaging the linear rate over at most 250 ms chunks. Clip and track loudness normalization uses FFmpeg `loudnorm`; music ducking uses `sidechaincompress` keyed by dialogue-role tracks. Audio gain keyframes are shown as an envelope over the cached waveform.

`timeline-frame --project FILE --time TIME` renders one frame-snapped composite from the active, unmuted video tracks. The desktop Timeline monitor uses this command's shared core operation for its still preview; source video playback remains available in the Source monitor.

`history` reports persistent undo/redo availability. `undo` and `redo` restore a project snapshot from the adjacent `.openmontage-history-<id>` folder. The journal holds up to 50 states and starts a new branch after an edit made while redo states exist.

`TIME` is a nonnegative rational number of seconds, entered either as a decimal (`2.5`) or a fraction (`5/2`). An omitted clip duration extends from `source-in` to the end of the source. Video-only media cannot be placed on an audio track's video output; audio-only media cannot be placed on a video track.

## JSON response and errors

Success:

```json
{ "schemaVersion": 1, "ok": true, "data": { "...": "command result" } }
```

Failure (exit code 1):

```json
{ "schemaVersion": 1, "ok": false, "error": { "code": "TRACK_NOT_FOUND", "message": "Track not found: ..." } }
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

Desktop IPC is private to the app renderer and is defined by `src/shared/electron.d.ts`. Agent REST and MCP are loopback/local-process interfaces with explicit path grants; see [`AGENT_API.md`](AGENT_API.md) for startup, authentication, transaction, job-recovery, and tool-call details.
