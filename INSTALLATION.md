# Installation and development

## Requirements

- Windows 10/11 (current supported development platform).
- Node.js 24+ and npm 10+.
- FFmpeg/FFprobe 6+ on `PATH`; confirm with `ffmpeg -version` and `ffprobe -version`.
- Git for source checkout.

The app and CLI use Node's built-in SQLite support, so Node.js 24+ is required for development and headless CLI use. Electron 45 embeds Node 24 for the desktop app.

## Optional Tesseract OCR

Tesseract enables sampled HUD-text recognition during local highlight analysis. It is optional and is not bundled with OpenMontage. On Windows, install the UB Mannheim build with WinGet:

```powershell
winget install --id UB-Mannheim.TesseractOCR --exact
```

Open a new terminal and confirm that `tesseract --version` works. If the command is not found, add the folder containing `tesseract.exe` to the user `PATH`, then restart OpenMontage so it inherits the updated environment. English language data (`eng`) is used by default; additional language data must be selected or installed separately.

To confirm that OpenMontage can use the OCR runtime, run `npm run cli -- analysis-runtimes` from the project directory. The `tesseract-ocr` entry should report `ready`; if it is missing, confirm that Tesseract is on `PATH`. Without Tesseract, OCR is skipped and the other available local detectors continue to run.

The current editor uses the CPU `libx264` encoder by default for compatibility. Optional `h264_amf`, `h264_nvenc`, and `h264_qsv` CLI encoders depend on the installed FFmpeg build and compatible drivers. Availability does not guarantee that a particular GPU can initialize the encoder.

## Optional AI mask segmentation

The clip inspector can generate masks for common COCO object classes such as `person`, `car`, `dog`, `cat`, and `chair`. The first use downloads a pinned ONNX model from Hugging Face into OpenMontage's user-data model cache. Subsequent inference runs locally; extracted frames are temporary and removed after processing. The model tracks one matching instance across sampled frames and creates editable mask keyframes. It may not recognize game-specific meshes or HUD objects; use a manual mask or chroma key for those.

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

The workflow creates a draft GitHub release with installers, a CycloneDX SBOM, and SHA-256 checksums. It only publishes a draft so the release can be reviewed first. Windows signing uses the optional `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` repository secrets. macOS signing and notarization use `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. No certificate or signing secret belongs in the repository. Without configured signing credentials, the package is unsigned and macOS may block it by default.

See [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) before publishing a draft release.

## Diagnose the CLI runtime

```powershell
npm run build
npm run cli -- doctor
```

The command returns platform, Node version, and whether both FFmpeg tools are callable.

## Known setup limits

The clean Windows install smoke test is defined in the release workflow and still needs a successful hosted run. Release signing requires maintainer-provided GitHub Actions secrets. Linux/macOS packages need installation checks on target machines after their first workflow build. Auto-updates are not implemented.
