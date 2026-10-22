# OpenMontage AI

OpenMontage AI is a local-first, open-source desktop video editor focused on gaming montages and music-synchronized edits. The current `0.1.0` development build implements the first usable editing slice: import local media, preview it, assemble clips on multiple tracks, trim and split clips, save a non-destructive project, and render an MP4 with FFmpeg.

Phases A–G are implemented. Phase C provides local music analysis, audio/scene/motion/HUD-text cues, explicit game-event phrase rules, persisted event review/correction, and an independent-annotation evaluation workflow. Phase D builds scored, beat-anchored montage plans from those cues and creates separate editable project variants. Phase E adds shared preview/export effects, keyframes, speed ramps, transitions, titles, transforms, LUTs, and track/clip audio automation. Phase F adds editable polygon/Bézier masks, chroma key, alpha compositing, blend modes, manual tracking corrections, and optional local ONNX object segmentation with temporal stabilization. Phase G exposes versioned CLI JSON, a path-granted loopback REST service, typed MCP stdio tools, project transactions, preview frames, render jobs, and structured recovery/validation. Detector and edit scores remain heuristics: no trained gameplay event detector, calibrated highlight ranking, or real game benchmark is bundled. Medal cloud access remains future work.

## Current capabilities

- Electron + React + TypeScript desktop shell with isolated renderer context.
- `.omproj` project files with versioned JSON, rational time values, autosaved edits, a `.bak` previous snapshot, and persistent 50-state undo/redo history.
- Editable project name, output dimensions, and rational frame rate, plus four-step timeline zoom from 50% to 400%.
- Local single-file and recursive folder import, SHA-256 duplicate detection, FFprobe metadata, content-addressed video thumbnails, and audio waveform images. Original media files are referenced and never modified.
- Import personal music directly in the montage generator from MP3, WAV, FLAC, M4A, AAC, OGG, OPUS, or WMA files; it is added to the project media bin and selected for analysis and editing.
- Audio-track clips render their own source-trimmed waveform at the current timeline zoom. Results are cached by source content, clip range, and zoom; the waveform cache is capped at 512 MiB.
- Video proxies can be generated in the source inspector. The source monitor uses a completed proxy automatically; timeline preview and final export continue to use original media.
- Proxy and clip-waveform jobs share a project-persistent queue with pause/resume, retry, restart recovery, and one derived-media FFmpeg job at a time. Resource limits cap proxies at 960×540, 1.5 GB per file, and 12 GB total; jobs use one FFmpeg thread. Completed proxy caches can be cleared from the inspector. Relinking to different source content invalidates thumbnails, waveforms, proxies, and audio analysis.
- A project-adjacent SQLite index accelerates unchanged imports, supports search/tags/favorites/game names and manual 0–5 highlight ratings, and watches selected folders for new local clips.
- The Medal import shortcut checks Medal's documented Windows default capture folder (`<system drive>:\Medal`); if it is not present, choose the custom folder from Medal's storage settings. Imports recurse and register the folder for new-file watching.
- Media library sorting by modified date, name, duration, or highlight rating, with a virtualized list that only mounts nearby cards and thumbnails.
- Missing source files are marked in the media bin and can be relinked to a replacement file without breaking existing clip references.
- Video and audio tracks; additional tracks can be added, muted, soloed, or locked. Clips can be inserted, duplicated, moved between tracks, trimmed, split, and removed.
- Clip audio can be enabled, adjusted, and faded in or out; the settings are editable in the inspector and render through FFmpeg.
- Video clips support keyframed opacity and color controls, constant playback speed and linear speed ramps, dissolves and directional wipes, title overlays, scale/position/rotation, brightness/contrast/saturation, and external `.cube` 3D LUTs. Still preview and export share the same filter semantics.
- Track and clip audio support gain automation, fades, loudness normalization, and dialogue-triggered music ducking. Audio tracks expose standard/dialogue/music roles, gain keyframes, normalization and ducking controls; gain envelopes appear over cached waveforms.
- Drag clip edges for frame-snapped source trimming while preserving the opposite edit point.
- Preview of imported source video, timeline playhead, persistent undo/redo, and keyboard shortcuts for save/undo/redo/delete/playback.
- Frame-snapped composite still preview for the timeline, plus a separate source monitor for video playback. The timeline can render a revision-cached MP4 using the same FFmpeg pipeline as export; that preview supports playback, audio, seeking, and frame stepping.
- FFmpeg MP4/H.264 + AAC rendering with video layer compositing, source audio mixing, output validation, and a CPU H.264 default. Hardware encoders can be selected by CLI.
- A JSON-output CLI for project creation, media import/search/metadata, timeline operations, validation, frame extraction, and export.
- Local audio analysis uses 2,048-sample spectral-flux frames plus RMS change, tempo/subdivision-aware autocorrelation hypotheses, and a tempo-tolerant dynamic beat path. Beat and downbeat positions, bass-accent meter hypotheses (including odd meters), relative energy curves, coarse sections, energy-rise markers, and onsets appear in the inspector and CLI. Analysis caches are versioned so older RMS-only results are recomputed.
- Beat, downbeat, and energy-rise ticks on analyzed audio clips; optional timeline snapping uses detected beats and clip edges.
- Ranked local audio-activity, video scene-change, sampled-frame motion, and optional Tesseract HUD-text cues with event windows, detector provenance, confidence/evidence, a cache, and a CLI command. Missing Tesseract is shown as a skipped detector.
- OCR phrase rules turn explicit HUD notices into game-event cues for Valorant, Counter-Strike, Fortnite, Apex Legends, Overwatch, Call of Duty, OpenArena, and Anarch. Custom profiles can be supplied through `OPENMONTAGE_GAME_RULES`; rules are heuristic and require Tesseract.
- Detector and music evaluation with strict-majority consensus from independent annotations. Reports per-detector precision/recall/F1, false positives/negatives, confidence calibration diagnostics, BPM error, and beat/downbeat precision/recall. See [evaluation/README.md](evaluation/README.md) and the manifest template.
- Runtime inventory in the inspector and CLI reports FFmpeg, optional Tesseract, and gameplay detector availability. Optional mask segmentation uses a separately cached ONNX model and downloads weights on first use.
- Automatic montage generation analyzes the chosen music and video sources, excludes rejected cues, uses corrected/accepted event reviews and manual clip ratings, and anchors each selected decisive event to a music drop, downbeat, beat, or disclosed pacing fallback.
- Clean Competitive, Aggressive Gaming, Cinematic, Velocity Pacing, and Custom styles change shot cadence, cut placement, music-anchor preferences, and audio mix. Custom rules are editable in the desktop UI or supplied as validated JSON.
- Generates one to five separately saved `.omproj` variants and matching `.edit-plan.json` reports. The source project and its timeline are untouched; each variant can be opened, edited, previewed through the timeline playback renderer, and exported normally.

## Quick start on Windows

Requirements: Windows 10/11, Node.js 24 or newer, npm, Git, and FFmpeg 6 or newer (`ffmpeg` and `ffprobe` available on `PATH`). The desktop build is currently developed with Node.js 24 and FFmpeg 9.

```powershell
git clone <repository-url>
cd OpenMontage-AI
npm ci
npm run dev
```

Native Windows installer packaging is a later milestone. FFmpeg must currently be installed separately; Linux and macOS packaging are future work.

Tesseract OCR is optional. See [INSTALLATION.md](INSTALLATION.md) for Windows setup and PATH checks.

## CLI example

```powershell
npm run build
npm run cli -- create --project .\montage.omproj --fps 60/1
npm run cli -- import --project .\montage.omproj D:\Captures\Valorant
npm run cli -- inspect --project .\montage.omproj
npm run cli -- analyze-highlights --project .\montage.omproj --media <VIDEO_ID>
npm run cli -- analyze-audio --project .\montage.omproj --media <MUSIC_ID>
npm run cli -- generate-montage --project .\montage.omproj --music <MUSIC_ID> --duration 30 --style aggressive --variants 3 --format portrait-1080p
```

The `import` command returns asset IDs. Use those IDs to build a timeline and render. Agent interfaces and filesystem grants are documented in [AGENT_API.md](AGENT_API.md):

```powershell
npm run cli -- clip-add --project .\montage.omproj --media <MEDIA_ID> --track <VIDEO_TRACK_ID> --start 0 --source-in 4.2 --duration 3.5
npm run cli -- export --project .\montage.omproj --output .\montage.mp4
```

`inspect` reports the project, track IDs, asset IDs, and clip IDs. All successful CLI commands write structured JSON to stdout; errors use stable `code` and `message` fields and exit with code 1. See [API.md](API.md).

`generate-montage` analyzes selected video assets and the chosen music when valid cached results are unavailable, then creates variants in a new output folder. Open a returned variant project to review and edit it; run `export --project <VARIANT.omproj> --output <OUTPUT.mp4>` to render it. The `.edit-plan.json` file records the selected events, source and timeline ranges, anchor types, per-cue rationale, score breakdown, and warnings. Use `--video <ID>` more than once to restrict the source set; omit it to use every project video. Cut intensity ranges from 0–100. Custom style requires `--custom-rules config/auto-montage-rules.example.json` or another file matching that shape.

Search indexed assets and add library metadata:

```powershell
npm run cli -- media-search --project .\montage.omproj --query headshot
npm run cli -- media-update --project .\montage.omproj --media <MEDIA_ID> --favorite true --tag headshot --game Valorant
```

## Development

```powershell
npm run dev
npm run build
npm test
```

The tests generate their own short synthetic video and audio with FFmpeg. No personal or copyrighted media is included. CI installs FFmpeg on its Windows runner and runs the same build and tests.

## Architecture and status

See [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md), [INSTALLATION.md](INSTALLATION.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md). This repository is licensed under GPL-3.0-or-later; see [LICENSE](LICENSE).

## Current limitations

- Timeline editing currently uses rational seconds; the inspector also shows project-frame positions. UI fields are rounded to microsecond precision when they call the editor core.
- Timeline zoom is an editor view setting and resets to 100% when the app starts. Waveform output is capped at 16,384 pixels per clip; extremely long clips therefore stop gaining resolution above that limit.
- Scrubbing shows a still composite frame. Timeline playback first renders the full edit to a revision-cached MP4, then plays that file; edits invalidate the cached playback and require another render. This is not live playback during editing.
- Rendering composites visible clips in track order over a black canvas. Polygon/Bézier masks, chroma key, blend modes, manually keyframed tracking, and optional model-generated masks are supported. The model recognizes common COCO classes and follows sampled frames; it does not segment arbitrary game-specific meshes or provide dense optical-flow tracking.
- Media references are absolute file paths. Relinking keeps the existing media ID, requires the same media kind, and rejects a replacement that is too short for existing clip ranges. SQLite is a rebuildable cache adjacent to the project.
- The `.bak` auto-backup is a single snapshot. Undo/redo snapshots are stored in a project-adjacent `.openmontage-history-<id>` folder, capped at 50 states; each timeline operation writes the project immediately.
- The Medal integration currently means authorized local-folder import only. No cloud API integration is claimed.
- Beat and meter estimates use local spectral-flux/RMS heuristics, not a trained music model. On ARTBeaT, analyzer v4 reduced BPM MAE on eight fixed-tempo references from 26.48 to 11.70 and raised aggregate beat F1 across 24 tracks from 0.537 to 0.678; downbeat tracking still had zero true positives and meter estimates remained inaccurate. Meter and tempo scores are not calibrated probabilities.
- Beat snapping uses those estimated beat positions; it does not yet distinguish strong impacts or drops from regular beats.
- The Phase D planner can only select detected event windows and includes a bounded amount of surrounding context. It reports insufficient highlight coverage instead of filling a long request with unscored footage. The Velocity preset changes cut pacing; actual playback speed and ramps are available through Phase E clip controls.
- No GitHub remote is configured in this local checkout, so no public repository or release has been published.
