# Contributing

OpenMontage AI is an early project. Contributions should keep the core editing model usable without optional AI models or GPU hardware.

## Local setup

Follow [INSTALLATION.md](INSTALLATION.md), then run:

```powershell
npm run build
npm test
```

## Changes

- Keep editing operations in `src/core` so desktop IPC and CLI can share them.
- Validate time ranges and IDs before changing project state.
- Do not modify imported originals. Tests should generate small synthetic assets or use redistributable fixtures.
- Keep renderer filesystem access inside the Electron main/preload boundary.
- Document any incomplete user-facing controls as planned; do not present placeholders as working features.
- Add/adjust automated tests for core behavior and real FFmpeg rendering when changing the export pipeline.
- Update `ROADMAP.md`, `API.md`, and `CHANGELOG.md` when behavior or milestone status changes.

## Pull requests

Include a concise problem statement, design notes, validation commands and observed output, platform/runtime details, and screenshots for visible UI changes. Do not submit private media, secrets, non-redistributable models, or copyrighted song/game footage.

## Code of conduct

Be respectful, assume good faith, explain technical disagreements, and focus review on concrete behavior and maintainability. A formal community code of conduct may be adopted before public release.
