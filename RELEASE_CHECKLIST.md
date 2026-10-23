# Release checklist

The GitHub repository and desktop product are named ClipPulse. Pushing a version tag starts `.github/workflows/release.yml`. The workflow checks the tag against `package.json`, builds on native Windows, Linux, and macOS runners, runs the build and tests, creates a Windows NSIS installer and Linux/macOS packages, generates a CycloneDX SBOM and SHA-256 checksums, and opens a **draft** GitHub release.

## Current release status — 23 October 2026

Version [v0.1.1](https://github.com/mulhans100-a11y/ClipPulse/releases/tag/v0.1.1) was published as a public pre-release on 22 October 2026. The [build-and-test workflow](https://github.com/mulhans100-a11y/ClipPulse/actions/runs/39803355171) and [package-release workflow](https://github.com/mulhans100-a11y/ClipPulse/actions/runs/39803382892) completed successfully for commit `94e87c981d00aa1e58b2e6dc5f5d29f642423ee8`. The package workflow includes the clean Windows installer/start smoke test.

Linux and macOS target-machine installation, manual review of each platform's packaged license notices, and Windows/macOS signing or notarization have not been confirmed. Keep those checks open for future release work.

## v0.1.2 local validation — 23 October 2026

On Windows x64, `npm ci`, `npm run build`, `npm test` (64 passed, 0 failed/skipped), `npm run smoke-test`, and full `npm audit` passed. `npm run package:win` created `ClipPulse Setup 0.1.2.exe` (161,463,269 bytes). The local installer was silently installed into a unique temporary directory; the packaged MCP server listed 49 tools and answered diagnostics, and the desktop process stayed open for 12 seconds. The local installer SHA-256 is `6D64B2FEC8AF12A28E3F68BCBF8B2BA81492733FA16EA0EEE5901616B1685EC3`. The tests also loaded the native Windows ONNX Runtime 1.23.2 binding successfully.

The installer and app executable are unsigned (`NotSigned`). The build used Electron's default icon because no product icon is configured. These are visible release-quality limitations. The [previous Build and test run](https://github.com/mulhans100-a11y/ClipPulse/actions/runs/39920583607) found that ONNX Runtime 1.30.0's npm package lacks a macOS-x64 binding. Its first fix attempt with 1.22.0 exposed a malformed Linux CUDA path, so that lockfile was not accepted. The current candidate uses 1.23.2, whose package includes both macOS architectures and corrected Linux metadata; it keeps `adm-zip` at fixed 0.6.1, verifies the electron-builder target architecture, and includes matching upstream notices. Tag-triggered verification of this exact candidate is still required. No v0.1.2 GitHub release exists yet.

The release workflow generates a separate platform-asset checksum manifest and Linux CycloneDX SBOM after the native package jobs complete. Its draft-release step refuses to modify an existing release and does not publish automatically.

## Before tagging

- Confirm the build-and-test Actions matrix is green for Windows x64, Linux x64, macOS arm64, and macOS Intel.
- Run `npm audit --omit=dev` and review `DEPENDENCIES.md` against the current dependency and codec choices.
- Configure signing credentials as repository Actions secrets if signed installers are intended:
  - Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
  - macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; App Store Connect API credentials can be used instead.
- Update `package.json` and `package-lock.json` to the release version, update `CHANGELOG.md`, and commit the changes to `main`.

## Review the draft

- Confirm all expected Windows, Linux, and macOS artifacts, the versioned SBOM, `ClipPulse-<tag>-SHA256SUMS.txt`, and the versioned release-status file are present.
- The workflow explicitly refuses to create assets if a GitHub release already exists for the tag. Review/publish only a newly assembled draft.
- Confirm the CI artifact names and generated `ClipPulse-<tag>-SHA256SUMS.txt` identify the exact release tag.
- Review the CLI/media/export/MCP smoke-test result on each runner and the Windows installed-app smoke-test result.
- Review `resources/third-party-licenses/THIRD_PARTY_NOTICES.md` and its `LICENSES/` directory in each platform package; platform packages can resolve different native dependencies.
- Verify checksums with `sha256sum -c ClipPulse-<tag>-SHA256SUMS.txt` on Linux/macOS or `Get-FileHash` on Windows.
- Install and launch the Windows installer on a clean Windows machine. The automated workflow also does a silent install and launch smoke test on a fresh hosted runner.
- Install and launch the Linux and macOS packages on target machines. Unsigned macOS packages can be blocked by Gatekeeper; signed distribution requires Apple signing and notarization credentials.
- Confirm the app reports FFmpeg/FFprobe availability. FFmpeg is not bundled; model weights download on first use and are not part of the installer or SBOM.
- Publish the draft from GitHub only after reviewing signatures, install results, license notices, the SBOM, and release notes.

The workflow does not publish a release automatically. A tag can create a new draft for review; the job stops if a release already exists for that tag.
