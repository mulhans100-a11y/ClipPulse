# Installation and development

## Requirements

- Windows 10/11 (current supported development platform).
- Node.js 24+ and npm 10+.
- FFmpeg/FFprobe 6+ on `PATH`; confirm with `ffmpeg -version` and `ffprobe -version`.
- Git for source checkout.

The app and CLI use Node's built-in SQLite support, so Node.js 24+ is required for development and headless CLI use. Electron 45 embeds Node 24 for the desktop app.

The current editor uses the CPU `libx264` encoder by default for compatibility. Optional `h264_amf`, `h264_nvenc`, and `h264_qsv` CLI encoders depend on the installed FFmpeg build and compatible drivers. Availability does not guarantee that a particular GPU can initialize the encoder.

## Run from source

```powershell
git clone <repository-url>
cd OpenMontage-AI
npm ci
npm run dev
```

## Build

```powershell
npm run build
npm test
```

Native Windows installer generation is a later milestone. FFmpeg is a separately installed dependency.

## Diagnose the CLI runtime

```powershell
npm run build
npm run cli -- doctor
```

The command returns platform, Node version, and whether both FFmpeg tools are callable.

## Known setup limits

The project has not yet been validated on a clean Windows machine or signed. Installation requires a development machine with Node/npm and an FFmpeg installation. A packaged app dependency-check screen, bundled FFmpeg distribution, Linux/macOS installers, and auto-updates are future work.
