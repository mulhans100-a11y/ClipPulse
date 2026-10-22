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

- [x] Initial local audio analysis: BPM hypotheses, beat positions, and amplitude-transient timestamps, with cached JSON results.
- [x] Show analyzed beat positions on audio timeline clips and snap editing positions to them.
- [x] Audio-analysis outputs: downbeats, heuristic meter, one-second relative energy, coarse sections, and energy-rise markers; independent reference manifests can report BPM/beat/downbeat errors and tempo-score calibration diagnostics.
- [ ] Populate and evaluate a varied real-music reference set; runtime tempo and meter scores remain raw heuristics.
- [x] Typed detector plugin interface with built-in local audio-activity and FFmpeg scene-change detectors.
- [x] Versioned annotation manifest template and CLI evaluator with strict-majority consensus, source-hash pinning, and negative review intervals.
- [ ] Add a real game-specific evaluation set with licensed source media and independent annotation records; the repository contains no gameplay footage to label.
- [x] Timestamped scene-change, audio-activity, and motion event windows with detector provenance, evidence, and heuristic cue ranking.
- [x] Optional Tesseract HUD OCR and explicit game-event phrase profiles with provenance; missing Tesseract is reported as skipped, and trained gameplay models remain unavailable.
- [x] Accept/reject/correct review UI with project-persisted event times and per-asset reviewed-proposal precision summaries.
- [x] Per-detector precision/recall/F1, false-positive/negative, confidence-calibration, BPM, beat, and downbeat reporting from independently reviewed manifest data.
- [ ] Run and save a benchmark report from a populated game-specific dataset; no matching media or independent annotations are present in this checkout.
- [x] Optional runtime inventory for FFmpeg, Tesseract OCR, and gameplay-model availability, with an honest no-model fallback.

## Phase D — Automatic editing

- [x] Versioned edit-plan data model with per-event explanations and highlight, music-alignment, diversity, pacing, framing, and duration scores.
- [x] Select accepted/corrected, non-rejected analyzed events with source-window checks; diversify assets, games, and event types; anchor each decisive frame to a drop, downbeat, beat, or explicitly reported pacing fallback.
- [x] Clean Competitive, Aggressive Gaming, Cinematic, Velocity Pacing, and configurable Custom rules change shot intervals, anchor weights, cut placement, and audio mix.
- [x] Generate one to five score-comparable variants as separate editable `.omproj` files and `.edit-plan.json` reports; source projects and timelines remain untouched.
- [x] UI and CLI workflow analyzes music/highlights and validates frame-exact duration/source coverage. The UI opens variants for shared timeline playback; the CLI exposes timeline-frame inspection and verified FFmpeg export.

Phase D scores use detector and music heuristics; they are not calibrated gameplay-quality predictions. Velocity changes edit pacing, while playback speed/ramping, transitions, and visual effects remain in the later effect pipeline. A real gameplay benchmark remains an open Phase C evaluation task.

## Phase E — Effects and audio controls

- [x] Per-clip audio enable, volume, fade-in, and fade-out controls with FFmpeg export and CLI support.
- [ ] Shared preview/export effect semantics and keyframes.
- [ ] Speed changes and ramps, transitions, titles, transforms, LUT/color controls.
- [ ] Track/clip audio automation, fades, normalization, ducking and waveform display.
- [ ] Automated parity tests across representative frames and audio boundaries.

## Phase F — Compositing

- [ ] Manual polygon and Bézier masks, feather and expansion.
- [ ] Chroma key, blend modes, alpha-aware preview and export.
- [ ] Tracking data and manual corrections.
- [ ] Optional model-backed segmentation and temporal consistency.

## Phase G — Agent control

- [ ] Stable versioned CLI schemas and API documentation.
- [ ] Local REST service with explicit path permissions and operation transactions.
- [ ] MCP server with typed tools, structured outputs, preview frames and render status.
- [ ] Agent-only end-to-end montage workflow and recovery/validation behaviors.

## Phase H — Release

- [ ] Dependency, model, and FFmpeg distribution/license review for chosen packaging.
- [ ] Windows installer and clean-machine install/diagnostics validation.
- [ ] Linux/macOS builds, reproducible releases, SBOM and release signing.
- [ ] Public GitHub repository and first tagged release after the project has a configured remote and a release-ready build.
