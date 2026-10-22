# Changelog

## 0.1.0 — Initial Phase A/B/C development build

- Added Electron/React desktop shell with media bin, source preview, multitrack timeline, and clip inspector.
- Added rational-time project model, media probing/import, thumbnail caching, duplicate detection, and project backups.
- Added a SQLite media index with folder watches, search, tags, favorites, game labels, and local capture-folder import.
- Added timeline track/clip operations and FFmpeg H.264/AAC export.
- Added a frame-snapped composite timeline preview with track-order overlays and a separate source playback monitor.
- Added cached FFmpeg waveform images for imported audio files and timeline clips.
- Added direct frame-snapped dragging on clip edges to trim source ranges.
- Added persistent undo/redo with branch handling, no-op save detection, and a 50-state history limit.
- Added missing-source detection and a relink action that preserves timeline references.
- Added undoable project profile settings for resolution and frame rate, plus adjustable timeline zoom.
- Added clip duplication and working mute, solo, and lock track controls in the editor and CLI.
- Added a structured JSON CLI and first-pass local beat/transient analysis with BPM hypotheses.
- Added generated-media integration tests, Windows CI, and Medal API/licensing research.
- Automatic highlight detection, deeper music analysis, effects, compositing masks, REST, and MCP remain future work.
