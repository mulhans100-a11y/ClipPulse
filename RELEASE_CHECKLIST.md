# Release checklist

The GitHub repository is `mulhans100-a11y/ClipPulse`; the desktop product remains named OpenMontage AI. Pushing a version tag starts `.github/workflows/release.yml`. The workflow checks the tag against `package.json`, builds on native Windows, Linux, and macOS runners, runs the build and tests, creates a Windows NSIS installer and Linux/macOS packages, generates a CycloneDX SBOM and SHA-256 checksums, and opens a **draft** GitHub release.

## Before tagging

- Confirm the build-and-test Actions matrix is green for Windows x64, Linux x64, macOS arm64, and macOS Intel.
- Run `npm audit --omit=dev` and review `DEPENDENCIES.md` against the current dependency and codec choices.
- Configure signing credentials as repository Actions secrets if signed installers are intended:
  - Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.
  - macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; App Store Connect API credentials can be used instead.
- Update `package.json` and `package-lock.json` to the release version, update `CHANGELOG.md`, and commit the changes to `main`.

## Review the draft

- Confirm all expected Windows, Linux, and macOS artifacts, `*-sbom.cdx.json`, `SHA256SUMS.txt`, and `RELEASE-STATUS.md` are present.
- Review `resources/third-party-licenses/THIRD_PARTY_NOTICES.md` and its `LICENSES/` directory in each platform package; platform packages can resolve different native dependencies.
- Verify checksums with `sha256sum -c SHA256SUMS.txt` on Linux/macOS or `Get-FileHash` on Windows.
- Install and launch the Windows installer on a clean Windows machine. The automated workflow also does a silent install and launch smoke test on a fresh hosted runner.
- Install and launch the Linux and macOS packages on target machines. Unsigned macOS packages can be blocked by Gatekeeper; signed distribution requires Apple signing and notarization credentials.
- Confirm the app reports FFmpeg/FFprobe availability. FFmpeg is not bundled; model weights download on first use and are not part of the installer or SBOM.
- Publish the draft from GitHub only after reviewing signatures, install results, license notices, the SBOM, and release notes.

The workflow does not create a public release automatically. A tag creates a draft so a maintainer can review the artifacts first.
