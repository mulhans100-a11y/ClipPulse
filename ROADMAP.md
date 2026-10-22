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

## Phase B — Media library (in progress)

- [x] SQLite index and incremental path/size/mtime reuse, with exact SHA-256 duplicate detection.
- [x] Search by name/path/tag/game, plus tags, favorites, and game assignment.
- [x] Debounced recursive local folder watcher with UI pause/resume controls.
- [x] Missing-file detection and relinking that preserves clip IDs and rejects incompatible or too-short replacements.
- [ ] Highlight ratings and per-asset analysis progress for very large libraries.
- [x] Sort by modified date, name, or duration, and virtualize media cards while scrolling.
- [ ] Waveform rendering that adapts to timeline zoom.
- [ ] Proxy jobs, resumable queue, resource limits, and thumbnail cache invalidation.
- [ ] Medal local capture-folder presets and new-file watcher.
- [x] Verify and document whether Medal offers a public user-authorized cloud API before considering cloud access; no documented personal-library API was found.

## Phase C — Music and highlight analysis

- [x] Initial local audio analysis: BPM hypotheses, beat positions, and amplitude-transient timestamps, with cached JSON results.
- [x] Show analyzed beat positions on audio timeline clips and snap editing positions to them.
- [ ] Improve audio analysis with downbeats, meter, energy sections/drops, confidence calibration, and varied real-music evaluation.
- [ ] Plugin interface and initial game-specific detector evaluation set.
- [ ] Scene, motion, audio-transient and OCR detector provenance with timestamped event results.
- [ ] Review/correction UI and per-detector precision/recall reporting.
- [ ] Optional model/runtime management with honest no-model fallback.

## Phase D — Automatic editing

- [ ] Edit-plan data model and explainable scoring.
- [ ] Select diverse highlights and anchor event frames to suitable music impacts.
- [ ] Clean, aggressive, cinematic, and velocity strategies that alter actual edit parameters.
- [ ] Create comparable variants without replacing the user's source timeline.
- [ ] Preview generated timeline, validate durations, and export.

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
