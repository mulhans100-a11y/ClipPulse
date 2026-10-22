# Dependency and codec notes

The application source is offered under GPL-3.0-or-later. A formal release still requires a fresh review of the complete production dependency tree, notices, encoder build configuration, and any optional models. This document records the development build's approach and known limits.

## Application packages

The app uses Electron (MIT), React and React DOM (MIT), Lucide React icons (ISC), Vite and the React Vite plugin (MIT), TypeScript (Apache-2.0), and small development process utilities. Their installed package metadata can be summarized with:

```powershell
npx license-checker --summary
```

`package-lock.json` records the resolved dependency tree. Re-run the license summary after dependency changes. The npm audit should also be rerun for each release.

On the development checkout's installed npm tree (22 October 2026), the package metadata summary reported 75 MIT, 10 ISC, 8 BSD-3-Clause, 5 Apache-2.0, 2 MPL-2.0, and 1 GPL-3.0-or-later packages. This includes development tooling and is not a count of binaries shipped by a release. The two MPL-2.0 packages were Lightning CSS and its Windows binary package in the Vite development toolchain; they are not production runtime dependencies. The complete resolved tree should be reviewed again before packaging.

## FFmpeg

OpenMontage shells out to the user's installed `ffmpeg` and `ffprobe`; this repository does not bundle either binary or link FFmpeg libraries. The development machine's FFmpeg 9 build advertises GPL-enabled components and `libx264`. FFmpeg's official licensing page explains that its default code base is LGPL-2.1-or-later, while enabling optional GPL parts makes the FFmpeg build GPL. The FFmpeg legal page also identifies `libx264` as GPL and discusses separate codec patent considerations.

This project is GPL-3.0-or-later and does not redistribute the development machine's FFmpeg binary. A future installer must either document a separately installed FFmpeg requirement (as this build does) or package a specifically configured FFmpeg build with its corresponding notices/source and a reviewed configuration. No legal conclusion about codec patents is made here.

## AI models

No model runtime, model weights, or network model download is included in Phase A. A later model integration must record exact model provenance, license, distribution rights, hardware needs, and whether the model runs locally before it is offered in the UI.

## Audio analysis

Beat analysis uses the user's separately installed FFmpeg to decode mono PCM. The implementation is first-party TypeScript and adds no analysis package or downloaded model. Its current BPM values are autocorrelation matches over short-time amplitude onsets, not calibrated confidence probabilities or a full music transcription.

## Official references

- [GNU GPLv3 text](https://www.gnu.org/licenses/gpl-3.0.html)
- [FFmpeg licensing and legal considerations](https://ffmpeg.org/legal.html)
- [GNU license compatibility information](https://www.gnu.org/licenses/license-list.html)
- [Mozilla Public License 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)
