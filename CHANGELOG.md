# Changelog

## 0.1.2 Beta — Music-aligned agent editing (2026-10-23)

- Reworked the public README around the implemented desktop, shared-core agent workflow, installation requirements, beta limitations, and documentation links; added repository-metadata and demo-video proposals without changing GitHub settings or releases.
- Clarified the two-input agent montage workflow after one-time project/library setup, including automatic selection across project videos and the remaining explicit project-path requirement.
- Corrected stale user-facing OpenMontage branding while preserving legacy project/API identifiers and added a v0.1.1 release-description draft that is explicitly separate from the already published release.
- Added adaptive local-tempo beat tracking, a confidence-bearing beat grid, distinct transient/accent events, and build-up/drop/quiet section cues while preserving legacy audio fields and the v1 agent contract.
- Added accent-aware montage anchors and a Smooth pacing preset; stronger highlight events receive an explainable preference on strong musical anchors.
- Added a deterministic v4-versus-v5 audio evaluation runner and measured ARTBeaT/synthetic results with tolerances and documented failure cases.
- Documented relative confidence semantics and the cache-version invalidation; v5 recomputes older cached audio analyses once.
- Fixed the macOS release hook to find resources inside `ClipPulse.app/Contents/Resources`; added regression coverage for macOS, Windows, and Linux resource paths.
- Added typed, modular Valorant HUD phrase recognition with explicit evidence levels and normalized-coordinate tentative kill-feed change cues.
- Combined audio, motion, and HUD provenance in explainable highlight scores; added fast-action and low-motion passage candidates with uncertainties.
- Persisted manual event-type corrections through project metadata, montage planning, desktop review controls, and the versioned agent API.
- Added event-type precision/recall/F1 and timestamp-error evaluation to local annotation reports, plus a deterministic synthetic text fixture compared with the legacy substring rules.
- Documented that no representative authorized Valorant gameplay benchmark or compatible trained gameplay model is available; fixture scores are parser regression results only.

## 0.1.1 — ClipPulse branding and documentation

- Renamed the desktop application, installer, command-line interface, and automation identity to ClipPulse.
- Rewrote the README as a user-facing project guide covering setup, editing, local media, montage generation, and known limitations.
- Updated project, automation, and release documentation to use the ClipPulse name.

## 0.1.0 — Phase A–H draft release

- Added electron-builder targets and native GitHub Actions release builds for Windows x64, Linux x64, macOS arm64, and macOS Intel.
- Added a Windows fresh-runner installer/start smoke test, production dependency audit, CycloneDX SBOM, SHA-256 checksums, and draft-only GitHub release assembly.
- Added signing-secret setup and manual artifact review instructions. The v0.1.0 release remained a draft; v0.1.1 later became the first published application pre-release.
- Added per-platform production dependency license manifests and license text files to packaged application resources, including native `sharp`/libvips, version-matched ONNX Runtime, and `guid-typescript` notices.
- Added Chokidar for cross-platform recursive media-folder watching, canonicalized Windows short paths before watch startup, and made watcher readiness and shutdown explicit.
- Made optional OCR evaluation checks follow the detector's actual availability on each CI runner.
- Corrected FFT-window onset timestamp bias and meter estimation so the local music-analysis regression tests pass.

- Added Electron/React desktop shell with media bin, source preview, multitrack timeline, and clip inspector.
- Added rational-time project model, media probing/import, thumbnail caching, duplicate detection, and project backups.
- Added a SQLite media index with folder watches, search, tags, favorites, game labels, and local capture-folder import.
- Added persistent 0–5 highlight ratings, inspector controls, CLI updates, and top-rated library sorting.
- Added per-asset audio-analysis status in the virtualized media list, restored from source-validated cache files.
- Increased cached audio waveform resolution to support sharper timeline display across the 50–400% zoom range, with a bounded image width.
- Expanded local music analysis with relative energy curves, coarse energy sections, energy-rise markers, and cautious meter/downbeat estimates; markers appear on audio clips.
- Added a typed detector-plugin extension point and ranked audio-activity/scene-change event cues with timestamp windows, evidence, provenance, and a CLI entry point.
- Added persistent accept/reject/correct review controls and a per-asset reviewed-proposal precision summary for detector cues.
- Added timeline track/clip operations and FFmpeg H.264/AAC export.
- Added a frame-snapped composite timeline preview with track-order overlays and a separate source playback monitor.
- Added cached FFmpeg waveform images for imported audio files and timeline clips.
- Added direct frame-snapped dragging on clip edges to trim source ranges.
- Added persistent undo/redo with branch handling, no-op save detection, and a 50-state history limit.
- Added missing-source detection and a relink action that preserves timeline references.
- Added undoable project profile settings for resolution and frame rate, plus adjustable timeline zoom.
- Added clip duplication and working mute, solo, and lock track controls in the editor and CLI.
- Added beat ticks to analyzed audio clips and optional magnetic snapping to beats and clip edges.
- Added media library sorting and virtualized card rendering for large collections.
- Added clip audio enable, volume, fade-in, and fade-out controls to the editor, CLI, project model, and export graph.
- Added a structured JSON CLI and first-pass local beat/transient analysis with BPM hypotheses.
- Added generated-media integration tests, Windows CI, and Medal API/licensing research.
- Phase C adds local music/highlight analysis, persistent cue review/correction, optional OCR, and independent-annotation evaluation. Trained gameplay models, calibrated ranking, and populated real-media benchmarks remain unavailable.
- Phase D adds automatic montage planning, scoring, style strategies, separate editable variants, timeline preview, duration/source validation, and normal FFmpeg export.
- Phase E adds shared preview/export filter semantics, keyframes, speed ramps, dissolve/wipe transitions, title overlays, transforms, color/LUT controls, track/clip audio automation, normalization, ducking, gain envelopes, and FFmpeg parity tests.
- Phase F adds normalized polygon/Bézier masks, feather and expansion controls, chroma keying, alpha-aware layer blending, manually corrected mask tracking, and shared preview/export composition.
- Phase F adds optional local ONNX instance segmentation by COCO object class, overlap-based instance following, temporally stabilized contours, editable generated mask keyframes, and editor, CLI, and MCP entry points.
- Phase G adds versioned agent tools through the JSON CLI, loopback REST API, and MCP stdio server. Gameplay event models and game-specific reference data remain future work.
