# Installation and development

## Requirements

- Windows 10/11 (the locally verified development and desktop-install platform; Linux and macOS packages are built in CI, but target-machine installation is not yet verified).
- Node.js 24+ and npm 10+.
- FFmpeg/FFprobe 6+ on `PATH`, with the `drawtext` filter and `libx264` encoder.
- Git for source checkout.

ClipPulse checks both executable versions and the required FFmpeg filter/encoder at startup. If the app reports **FFmpeg needs attention**, hover over the status for the diagnostic, or run `npm run cli -- doctor` from a source checkout. A missing command means FFmpeg is not on `PATH`; an incompatible-build message names missing features. Install a complete FFmpeg build that provides `drawtext` and `libx264`, ensure `ffprobe` is installed beside it, then restart ClipPulse. FFmpeg is intentionally not bundled with the installer.

The app and CLI use Node's built-in SQLite support, so Node.js 24+ is required for development and headless CLI use. Electron 45 embeds Node 24 for the desktop app.

## Install a beta release

Download the asset matching your computer from the ClipPulse [GitHub Releases page](https://github.com/mulhans100-a11y/ClipPulse/releases). Verify its SHA-256 hash against the release's `ClipPulse-<tag>-SHA256SUMS.txt` file before opening it. The Windows installer is an `.exe`; Linux offers an `.AppImage` and a `.deb`; macOS offers a `.dmg` and `.zip`. Pick the macOS architecture that matches your Mac (Apple silicon/arm64 or Intel/x64).

- **Windows:** run the x64 Setup installer and follow its prompts. Windows may show a SmartScreen prompt because the beta installer is unsigned. FFmpeg is installed separately.
- **Linux:** install the `.deb` with your distribution's package installer, or mark the AppImage executable (`chmod +x ClipPulse-*.AppImage`) and launch it. Install a compatible FFmpeg package separately.
- **macOS:** open the matching DMG or ZIP and move ClipPulse into Applications. Unsigned builds may be blocked by Gatekeeper; do not bypass that warning unless you trust the source and have verified the checksum. Signing and notarization are not confirmed for this beta.

To verify a downloaded Windows installer, run `Get-FileHash .\<installer-file>.exe -Algorithm SHA256` in PowerShell and compare the hash with its line in the checksum file. On Linux or macOS, place the downloaded assets and checksum file in one directory and run `sha256sum -c ClipPulse-<tag>-SHA256SUMS.txt`.

Node.js and npm are not needed to run an installed desktop build. FFmpeg and FFprobe are separate dependencies used for media probing and export; install both, check that they are available on `PATH`, then restart ClipPulse. In the app, hover over **FFmpeg needs attention** to see the detected issue. FFmpeg 6 or newer must include the `drawtext` filter and `libx264` encoder.

To connect an installed build to OpenAI Codex or Claude Code, open **Agent** in ClipPulse and follow the folder-permission and connection-test steps in [`MCP_SETUP.md`](MCP_SETUP.md). The packaged MCP server uses ClipPulse's Electron runtime; no separate Node.js installation or AI-client credentials are required. Its `runAsNode` capability is enabled for this server launch mode and runs with the current user's permissions. Claude Desktop has a separate Desktop Extensions flow and is not configured by this dialog.

## Optional Tesseract OCR

Tesseract enables sampled HUD-text recognition during local highlight analysis. It is optional and is not bundled with ClipPulse. On Windows, install the UB Mannheim build with WinGet:

```powershell
winget install --id UB-Mannheim.TesseractOCR --exact
```

Open a new terminal and confirm that `tesseract --version` works. If the command is not found, add the folder containing `tesseract.exe` to the user `PATH`, then restart ClipPulse so it inherits the updated environment. English language data (`eng`) is used by default; additional language data must be selected or installed separately.

To confirm that ClipPulse can use the OCR runtime, run `npm run cli -- analysis-runtimes` from the project directory. The `tesseract-ocr` entry should report `ready`; if it is missing, confirm that Tesseract is on `PATH`. Without Tesseract, OCR is skipped and the other available local detectors continue to run.

The current editor uses the CPU `libx264` encoder by default for compatibility. Optional `h264_amf`, `h264_nvenc`, and `h264_qsv` CLI encoders depend on the installed FFmpeg build and compatible drivers. Availability does not guarantee that a particular GPU can initialize the encoder.

## Optional AI mask segmentation

The clip inspector can generate masks for common COCO object classes such as `person`, `car`, `dog`, `cat`, and `chair`. The first use downloads a pinned ONNX model from Hugging Face into ClipPulse's user-data model cache. Subsequent inference runs locally; extracted frames are temporary and removed after processing. The model tracks one matching instance across sampled frames and creates editable mask keyframes. It may not recognize game-specific meshes or HUD objects; use a manual mask or chroma key for those.

The CLI exposes the same operation as `segment-mask`; pass `--model-cache DIR` to choose a different cache folder. Model download needs an internet connection the first time. No model weights are bundled by default.

## Run from source

```powershell
git clone https://github.com/mulhans100-a11y/ClipPulse.git
cd ClipPulse
npm ci
npm run dev
```

## Build

```powershell
npm run build
npm test
```

## Build an installer

The desktop application packages can be built on their matching operating systems:

```powershell
npm run package:win
```

On macOS use `npm run package:mac`; on Linux use `npm run package:linux`. Outputs are written to `release/`. The GitHub Actions release workflow builds Windows x64, macOS arm64 and Intel, and Linux x64 packages from a version tag. Each platform build runs on a fresh hosted runner; the Windows job silently installs its NSIS installer and launches the installed app as a smoke check.

FFmpeg and FFprobe remain separate requirements. Install a compatible FFmpeg build and ensure both commands are on `PATH`; the welcome screen reports their availability. The installers include the Electron runtime, so users do not need Node.js or npm to launch the packaged editor.

The workflow creates a draft GitHub release with installers, a CycloneDX SBOM, and versioned SHA-256 checksums. It does not publish or replace an existing release. Windows signing uses the optional `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` repository secrets. macOS signing and notarization use `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. No certificate or signing secret belongs in the repository. Without configured signing credentials, the package is unsigned and macOS may block it by default.

See [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) before publishing a draft release.

## Diagnose the CLI runtime

```powershell
npm run build
npm run cli -- doctor
```

The command returns platform, Node version, and whether both FFmpeg tools are callable.

## Known setup limits

The v0.1.1 GitHub Actions build/test matrix and package builds completed on Windows x64, Linux x64, macOS arm64, and macOS Intel. Its Windows installer passed the hosted clean-install/start smoke test. Linux/macOS target-machine installation and platform signing/notarization have not been verified; package creation alone does not verify installation on those systems. Auto-updates are not implemented. The project-level [test report](AGENT_TEST_REPORT.md) records local results and explicitly untested clients/platforms.

## Troubleshooting

- **FFmpeg or FFprobe not found:** install FFmpeg 6 or newer, make sure both `ffmpeg` and `ffprobe` are available in `PATH`, then restart ClipPulse. From a development checkout, `npm run cli -- doctor` prints the detected status.
- **FFmpeg build is incompatible:** install a build that includes the `drawtext` filter and `libx264` encoder. Check `ffmpeg -filters`, `ffmpeg -encoders`, `ffmpeg -version`, and `ffprobe -version`.
- **`npm ci` fails with `EPERM` or `EBUSY` on Windows:** close ClipPulse and any `npm run dev` process that uses this checkout, then retry. Windows cannot replace native Node modules while a running editor or Vite process has them loaded.
- **macOS blocks an installer:** unsigned builds may be rejected by Gatekeeper. Signing and notarization require maintainer-configured credentials and have not been confirmed for v0.1.1.
