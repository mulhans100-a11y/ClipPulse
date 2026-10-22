# OpenMontage AI

OpenMontage AI is a local-first, open-source desktop video editor focused on gaming montages and music-synchronized edits. The current `0.1.0` development build implements the first usable editing slice: import local media, preview it, assemble clips on multiple tracks, trim and split clips, save a non-destructive project, and render an MP4 with FFmpeg.

The Phase A editing core is complete. The project also contains partial media-library and music-analysis work; gameplay highlight detection, automatic montage planning, advanced effects, object masking, Medal cloud access, and MCP tools are not implemented yet. The app labels planned inspector controls accordingly.

## Current capabilities

- Electron + React + TypeScript desktop shell with isolated renderer context.
- `.omproj` project files with versioned JSON, rational time values, autosaved edits, a `.bak` previous snapshot, and persistent 50-state undo/redo history.
- Editable project name, output dimensions, and rational frame rate, plus four-step timeline zoom from 50% to 400%.
- Local single-file and recursive folder import, SHA-256 duplicate detection, FFprobe metadata, cached video thumbnails, and audio waveform images. Original media files are referenced and never modified.
- A project-adjacent SQLite index accelerates unchanged imports, supports search/tags/favorites/game names and manual 0–5 highlight ratings, and watches selected folders for new local clips.
- The Medal import shortcut checks Medal's documented Windows default capture folder (`<system drive>:\Medal`); if it is not present, choose the custom folder from Medal's storage settings. Imports recurse and register the folder for new-file watching.
- Media library sorting by modified date, name, duration, or highlight rating, with a virtualized list that only mounts nearby cards and thumbnails.
- Missing source files are marked in the media bin and can be relinked to a replacement file without breaking existing clip references.
- Video and audio tracks; additional tracks can be added, muted, soloed, or locked. Clips can be inserted, duplicated, moved between tracks, trimmed, split, and removed.
- Clip audio can be enabled, adjusted, and faded in or out; the settings are editable in the inspector and render through FFmpeg.
- Drag clip edges for frame-snapped source trimming while preserving the opposite edit point.
- Preview of imported source video, timeline playhead, persistent undo/redo, and keyboard shortcuts for save/undo/redo/delete/playback.
- Frame-snapped composite still preview for the timeline, plus a separate source monitor for video playback. The timeline can render a revision-cached MP4 using the same FFmpeg pipeline as export; that preview supports playback, audio, seeking, and frame stepping.
- FFmpeg MP4/H.264 + AAC rendering with video layer compositing, source audio mixing, output validation, and a CPU H.264 default. Hardware encoders can be selected by CLI.
- A JSON-output CLI for project creation, media import/search/metadata, timeline operations, validation, frame extraction, and export.
- Local audio beat analysis with BPM hypotheses, beat positions, and transient timestamps, exposed in the media inspector and CLI. The virtualized media list shows per-asset analysis state and restores completed status from valid caches.
- Beat ticks on analyzed audio clips and optional timeline snapping to detected beats and clip edges.

## Quick start on Windows

Requirements: Windows 10/11, Node.js 24 or newer, npm, Git, and FFmpeg 6 or newer (`ffmpeg` and `ffprobe` available on `PATH`). The desktop build is currently developed with Node.js 24 and FFmpeg 9.

```powershell
git clone <repository-url>
cd OpenMontage-AI
npm ci
npm run dev
```

Native Windows installer packaging is a later milestone. FFmpeg must currently be installed separately; Linux and macOS packaging are future work.

## CLI example

```powershell
npm run build
npm run cli -- create --project .\montage.omproj --fps 60/1
npm run cli -- import --project .\montage.omproj D:\Captures\Valorant
npm run cli -- inspect --project .\montage.omproj
```

The `import` command returns asset IDs. Use those IDs to build a timeline and render:

```powershell
npm run cli -- clip-add --project .\montage.omproj --media <MEDIA_ID> --track <VIDEO_TRACK_ID> --start 0 --source-in 4.2 --duration 3.5
npm run cli -- export --project .\montage.omproj --output .\montage.mp4
```

`inspect` reports the project, track IDs, asset IDs, and clip IDs. All successful CLI commands write structured JSON to stdout; errors use stable `code` and `message` fields and exit with code 1. See [API.md](API.md).

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
- Timeline zoom is an editor view setting and resets to 100% when the app starts. Waveform images currently stretch with clips rather than being regenerated at each zoom level.
- Scrubbing shows a still composite frame. Timeline playback first renders the full edit to a revision-cached MP4, then plays that file; edits invalidate the cached playback and require another render. This is not live playback during editing. Audio clips show a cached waveform image that stretches with the clip source range; zoom-aware waveform rendering, proxies, transitions, effect parity, and a render queue are not implemented.
- Rendering composites visible clips in track order over a black canvas. There is no color/effect pipeline or alpha-mask editor yet.
- Media references are absolute file paths. Relinking keeps the existing media ID, requires the same media kind, and rejects a replacement that is too short for existing clip ranges. SQLite is a rebuildable cache adjacent to the project.
- The `.bak` auto-backup is a single snapshot. Undo/redo snapshots are stored in a project-adjacent `.openmontage-history-<id>` folder, capped at 50 states; each timeline operation writes the project immediately.
- The Medal integration currently means authorized local-folder import only. No cloud API integration is claimed.
- Beat analysis detects amplitude rises with onset autocorrelation; it does not identify downbeats, meter, harmonic content, or musical sections.
- Beat snapping uses those estimated beat positions; it does not yet distinguish strong impacts or drops from regular beats.
- No GitHub remote is configured in this local checkout, so no public repository or release has been published.
