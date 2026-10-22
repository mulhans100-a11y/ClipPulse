# Roadmap

Status reflects the repository at `0.1.0`.

## Phase A — Working editing core (complete)

- [x] Electron desktop shell and React editor layout.
- [x] Create, open, validate, and save versioned projects.
- [x] Import files and recursively scan local media folders; probe metadata; create thumbnails; identify exact duplicate content.
- [x] Video/audio tracks, adding tracks, inserting/moving/removing clips, source trim, split, save, basic undo/redo.
- [x] Duplicate clips, per-kind track mute and solo that affect both preview and export, and track locks that prevent edits.
- [x] Source preview and basic FFmpeg MP4 export with video compositing and audio mix.
- [x] JSON CLI for project/media/timeline/export operations.
- [x] Synthetic-media integration tests and Windows CI workflow.
- [x] Frame-snapped still composite preview at the timeline playhead, with video tracks layered in export order.
- [x] Audio waveform images are created locally on import and shown on audio timeline clips.
- [x] Timeline playback renders a revision-cached MP4 through the export pipeline, with play/pause, audio, seeking, and frame stepping.
- [x] Undo/redo persists up to 50 project states, survives reopen, and branches correctly after undo.
- [x] Direct clip-edge drag handles with frame-snapped source and timeline trimming.
- [x] Project profile dialog for output dimensions and rational frame rate; profile changes are undoable.
- [x] Adjustable timeline zoom from 50% to 400%.
- [x] Optional magnetic snapping to clip edges and analyzed music beats.

## Phase B — Media library (complete)

- [x] SQLite index and incremental path/size/mtime reuse, with exact SHA-256 duplicate detection.
- [x] Search by name/path/tag/game, plus tags, favorites, and game assignment.
- [x] Debounced recursive local folder watcher with UI pause/resume controls.
- [x] Missing-file detection and relinking that preserves clip IDs and rejects incompatible or too-short replacements.
- [x] Manual 0–5 highlight ratings, persisted in project and SQLite, editable in the inspector and CLI, with a top-rated sort.
- [x] Per-asset audio-analysis state (not analyzed, running, ready, failed) in virtualized media cards, with ready state validated against the source file's size and modification time.
- [x] Sort by modified date, name, or duration, and virtualize media cards while scrolling.
- [x] Per-clip waveform rendering at the active timeline zoom, cached by source content, clip range, and zoom; output width is capped at 16,384 px and the waveform cache at 512 MiB.
- [x] Project-persistent proxy and waveform job queue with restart recovery, pause/resume, retries, single-job/single-thread processing, bounded proxy dimensions and file/cache sizes, and content-based thumbnail/proxy/waveform invalidation on relink.
- [x] Medal capture-folder preset detection on Windows, custom-folder fallback, recursive import, and new-file watcher registration.
- [x] Verify and document whether Medal offers a public user-authorized cloud API before considering cloud access; no documented personal-library API was found.

## Phase C — Music and highlight analysis

- [x] Local spectral-flux plus RMS onset analysis, autocorrelation tempo hypotheses, and tempo-tolerant dynamic beat tracking; source-versioned caches invalidate earlier RMS-only results.
- [x] Import personal music from the montage generator (MP3, WAV, FLAC, M4A, AAC, OGG, OPUS, WMA), add it to the project media bin, and select it for montage analysis.
- [x] Show analyzed beat positions on audio timeline clips and snap editing positions to them.
- [x] Audio-analysis outputs: downbeats, heuristic meter, one-second relative energy, coarse sections, and energy-rise markers; independent reference manifests can report BPM/beat/downbeat errors and tempo-score calibration diagnostics.
- [x] Populate and evaluate a varied music reference set with the 25-track ARTBeaT release (CC BY 4.0); report per-rhythm-category beat/downbeat F1, BPM error, meter accuracy/coverage, and raw-score calibration diagnostics. The 24-track v4 run achieved BPM MAE 11.70 on eight fixed-tempo references and aggregate beat F1 0.678, but zero downbeat true positives and zero meter accuracy; audio scores remain uncalibrated heuristics. One source item was excluded because its beat labels extend 2 seconds past the audio duration.
- [x] Typed detector plugin interface with built-in local audio-activity and FFmpeg scene-change detectors.
- [x] Versioned annotation manifest template and CLI evaluator with strict-majority consensus, source-hash pinning, and negative review intervals.
- [x] Timestamped scene-change, audio-activity, and motion event windows with detector provenance, evidence, and heuristic cue ranking.
- [x] Optional Tesseract HUD OCR and explicit game-event phrase profiles with provenance; missing Tesseract is reported as skipped, and trained gameplay models remain unavailable.
- [x] Accept/reject/correct review UI with project-persisted event times and per-asset reviewed-proposal precision summaries.
- [x] Per-detector precision/recall/F1, false-positive/negative, confidence-calibration, BPM, beat, and downbeat reporting from independently reviewed manifest data.
- [x] Optional runtime inventory for FFmpeg, Tesseract OCR, and gameplay-model availability, with an honest no-model fallback.

Gameplay detectors remain heuristic and are not measured against a representative game-specific reference set. Personal clip annotation is optional and is not a project-completion requirement.

## Phase D — Automatic editing

- [x] Versioned edit-plan data model with per-event explanations and highlight, music-alignment, diversity, pacing, framing, and duration scores.
- [x] Select accepted/corrected, non-rejected analyzed events with source-window checks; diversify assets, games, and event types; anchor each decisive frame to a drop, downbeat, beat, or explicitly reported pacing fallback.
- [x] Clean Competitive, Aggressive Gaming, Cinematic, Velocity Pacing, and configurable Custom rules change shot intervals, anchor weights, cut placement, and audio mix.
- [x] Generate one to five score-comparable variants as separate editable `.omproj` files and `.edit-plan.json` reports; source projects and timelines remain untouched.
- [x] UI and CLI workflow analyzes music/highlights and validates frame-exact duration/source coverage. The UI opens variants for shared timeline playback; the CLI exposes timeline-frame inspection and verified FFmpeg export.

Phase D scores use detector and music heuristics; they are not calibrated gameplay-quality predictions. Personal gameplay annotation is not required to use or complete the editor.

## Phase E — Effects and audio controls

- [x] Per-clip audio enable, volume, fade-in, and fade-out controls with FFmpeg export and CLI support.
- [x] Shared preview/export effect semantics and clip keyframes for opacity, brightness, contrast, saturation, and gain; timeline still preview and rendered playback share the export graph.
- [x] Constant speed changes and linear speed ramps; dissolves and directional wipes; title overlays; scale, position, and rotation; brightness, contrast, saturation, and external `.cube` LUTs.
- [x] Track/clip gain automation, clip fades, per-clip or per-track loudness normalization, dialogue-triggered music ducking, and visible audio gain envelopes over cached waveforms.
- [x] Automated FFmpeg parity coverage for representative preview/export frames, speed-ramped edits, wipe boundaries, gain fades, normalization, and sidechain ducking.

## Phase F — Compositing

- [x] Manual closed polygon and Bézier-path masks, feather and expansion.
- [x] Chroma key, multiply/screen/add/difference blend modes, and alpha-aware preview and export.
- [x] Time-keyed mask paths interpolate between manual corrections and split/trim with clip timing.
- [x] Optional local ONNX instance segmentation by object class, overlap-based instance following, temporally stabilized masks, and editable path keyframes.

Phase F masks can be generated from common COCO object classes with a pinned DETR panoptic model. The model is downloaded on first use and inference stays local. The generated contour is editable and rendered by the shared preview/export graph. It samples the clip rather than tracking every source frame; unknown game-specific meshes still need a manual path or chroma key.

## Phase G — Agent control

- [x] Stable versioned JSON envelopes, CLI schema command, checked-in tool JSON Schemas, and API documentation.
- [x] Optional loopback-only REST service with bearer authentication, canonical path grants, symlink/import checks, per-project operation serialization, and rollback-capable edit transactions.
- [x] MCP stdio server with typed schemas, structured results, image preview content, and asynchronous export status.
- [x] Agent-only end-to-end montage path for project creation, media import, audio analysis, timeline assembly, frame preview, validated MP4 export, plus undo/redo, validation, interrupted-render reporting, and transaction rollback.

Phase G tools use the shared core; filesystem grants are explicitly passed at service startup. Render jobs are recoverable by status after process restart, but an interrupted FFmpeg render must be started again. Phase F manual and model-generated masks can be controlled through MCP.

## Phase H — Release

- [x] Record the package choices: FFmpeg stays user-installed; model weights are fetched on first use; production npm dependency metadata, audit results, and model/codec licensing notes are documented.
- [x] Generate and package platform-specific production dependency notices and available license texts, including native `sharp`/libvips, ONNX Runtime, and `guid-typescript` notices; Windows x64 package contents verified locally.
- [ ] Review generated notices after Linux x64, macOS arm64, and macOS Intel release builds.
- [x] Configure an NSIS Windows installer and an automated fresh-runner silent-install/start smoke check.
- [ ] Confirm a successful clean Windows installation/diagnostics run in GitHub Actions.
- [x] Configure native Linux x64, macOS arm64, macOS Intel, and Windows x64 release builds with pinned Node/npm and the lockfile; attach a CycloneDX SBOM and SHA-256 checksums to a draft release.
- [ ] Confirm successful Linux/macOS package builds and install checks on target machines.
- [ ] Configure Windows/macOS signing secrets and verify signed/notarized artifacts.
- [x] Publish the source repository at https://github.com/mulhans100-a11y/ClipPulse.
- [ ] Create and review the first tagged application release; the workflow deliberately creates a draft only.
