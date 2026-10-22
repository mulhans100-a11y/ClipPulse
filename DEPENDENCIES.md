# Dependency and codec notes

The application source is offered under GPL-3.0-or-later. This document records the current packaging decisions and dependency inventory; review them again on every release tag.

## Application packages

The app uses Electron (MIT), React and React DOM (MIT), Lucide React icons (ISC), Vite and the React Vite plugin (MIT), TypeScript (Apache-2.0), and small development process utilities. Their installed package metadata can be summarized with:

```powershell
npx license-checker --summary
```

`package-lock.json` records the resolved dependency tree. On 22 October 2026, the Windows x64 production-tree metadata summary reported 24 MIT, 11 BSD-3-Clause, 6 Apache-2.0, 3 ISC, 1 Apache-2.0 AND LGPL-3.0-or-later, 1 GPL-3.0-or-later, and 1 MIT OR CC0-1.0 package. The Windows installer now includes a generated `resources/third-party-licenses/THIRD_PARTY_NOTICES.md` and available production package license files. It also includes native `@img/sharp-*` README files, which list licenses for bundled libvips components, and version-matched MIT plus upstream third-party notices for the locked ONNX Runtime packages. `guid-typescript@1.0.9` declares ISC in its npm metadata but omits a license file, so the matching ISC text and its package author attribution are included separately. This confirms the Windows x64 package contents; the same generated notices still need review after Linux and macOS release builds. Electron itself is a build-time dependency whose runtime and Chromium notices are included in the packaged Electron distribution. The tag workflow creates a CycloneDX SBOM from the lockfile and re-runs `npm audit --omit=dev`; this production audit found 0 vulnerabilities on 22 October 2026. Re-run both checks after dependency changes and on each release tag.

Before the optional Transformers.js segmentation runtime was added, the development checkout's package metadata summary (22 October 2026) reported 75 MIT, 10 ISC, 8 BSD-3-Clause, 5 Apache-2.0, 2 MPL-2.0, and 1 GPL-3.0-or-later packages. This is a historical snapshot that includes development tooling; it is not a count of binaries shipped by a release. The two MPL-2.0 packages were Lightning CSS and its Windows binary package in the Vite development toolchain; they are not production runtime dependencies. Re-run the license summary and review the complete resolved tree before packaging.

## FFmpeg

OpenMontage shells out to the user's installed `ffmpeg` and `ffprobe`; this repository does not bundle either binary or link FFmpeg libraries. The development machine's FFmpeg 9 build advertises GPL-enabled components and `libx264`. FFmpeg's official licensing page explains that its default code base is LGPL-2.1-or-later, while enabling optional GPL parts makes the FFmpeg build GPL. The FFmpeg legal page also identifies `libx264` as GPL and discusses separate codec patent considerations.

This project is GPL-3.0-or-later and does not redistribute the development machine's FFmpeg binary. A future installer must either document a separately installed FFmpeg requirement (as this build does) or package a specifically configured FFmpeg build with its corresponding notices/source and a reviewed configuration. No legal conclusion about codec patents is made here.

## AI models

Optional mask segmentation uses `@huggingface/transformers` 4.3.1 and its ONNX Runtime Node backend. The pinned `Xenova/detr-resnet-50-panoptic` ONNX model is downloaded on first use into the platform user-data model cache; no weights ship in the source tree or installer by default. The model card identifies the model as derived from Meta's Apache-2.0 DETR panoptic model; users should review the model card and dataset terms for their own deployment. Inference is local after download, and source frames are not uploaded. The model recognizes COCO classes, so its coverage on rendered game characters is limited. This is separate from Phase C gameplay-event detection, which still has no trained model.

The installer does not bundle FFmpeg. This avoids redistributing the development build's GPL-enabled FFmpeg binary and leaves users free to install a compatible FFmpeg/FFprobe build. The welcome screen checks for both commands. Windows and macOS code signing is enabled by the release workflow only when the documented GitHub Actions secrets are present; a tagged workflow creates a draft release for review.

## Audio analysis

Beat analysis uses the user's separately installed FFmpeg to decode mono PCM. The implementation is first-party TypeScript and adds no analysis package or downloaded model. Its current BPM values are autocorrelation matches over short-time amplitude onsets, not calibrated confidence probabilities or a full music transcription.

## Official references

- [GNU GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.html)
- [FFmpeg licensing and legal considerations](https://ffmpeg.org/legal.html)
- [GNU license compatibility information](https://www.gnu.org/licenses/license-list.html)
- [Mozilla Public License 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
- [electron-builder v26 configuration](https://www.electron.build/v26/docs/configuration/)
- [electron-builder code signing](https://www.electron.build/docs/features/code-signing/)
- [npm SBOM command](https://docs.npmjs.com/cli/commands/npm-sbom/)
