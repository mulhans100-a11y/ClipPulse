# Changelog

## 0.1.0 — Initial Phase A/B/C development build

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
- Gameplay highlight classification and review, detector evaluation, deeper music analysis, effects, compositing masks, REST, and MCP remain future work.
