# Agent instructions

- Read `ARCHITECTURE.md`, `ROADMAP.md`, and `API.md` before changing project storage, time arithmetic, or editing operations.
- Preserve the shared core: desktop IPC and CLI should call `src/core` rather than reimplement editing rules.
- Project times are exact reduced rational seconds stored as string pairs. Avoid floating-point arithmetic for core timeline changes; use `src/core/time.ts`.
- Never write into source media. Export to a temporary file and validate before finalizing.
- Keep renderer Node integration disabled. Add native capabilities only through narrow, typed preload APIs.
- Do not represent planned features as working. Update documentation when capability status changes.
- Tests use temporary generated media. Never check in user footage, music, model weights, or credentials.
- Phase C evaluation manifests may point to authorized local media; keep source media out of Git and require independent full-clip reviewers before calling a manifest benchmark data.
- Treat audio, frame-difference, OCR, and game-phrase scores as heuristics. Tesseract is optional; report skipped status when unavailable, and do not claim gameplay-model inference without a compatible model adapter.
- Before claiming an implementation works, build and run the appropriate tests and report any unverified platforms or encoders.
