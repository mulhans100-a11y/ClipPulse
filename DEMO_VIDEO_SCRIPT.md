# ClipPulse demo video — storyboard and capture plan

**Status:** storyboard only; no video has been recorded. One real first-launch screenshot exists, but a populated timeline and agent-setup screen have not been captured.

The repository now includes a genuine first-launch capture from a Windows x64 development build at [`docs/screenshots/clippulse-welcome-windows-x64.png`](docs/screenshots/clippulse-welcome-windows-x64.png). It shows the app start screen only; a populated timeline and agent setup are not captured yet.

## 75-second walkthrough

| Time | Picture / action | Voice-over / caption |
| --- | --- | --- |
| 0–6 s | Show the ClipPulse project window and a short preview of authorized gameplay footage. | “ClipPulse is a local-first video editor for gaming montages, with an editing core that AI agents can operate.” |
| 6–17 s | Import several clips and a music track from a clean demo folder; show the media bin and waveform. | “Bring in your own clips and soundtrack. ClipPulse references the source files and leaves them unchanged.” |
| 17–29 s | In the Agent setup dialog, choose Codex or Claude Code, select narrow project/media folders, run the connection check. Do not show tokens or personal paths. | “Connect your preferred supported coding agent, choose the folders it can access, and test the MCP connection.” |
| 29–47 s | Ask the connected agent to analyze available cues and create a 30-second editable montage. Show tool activity and the generated project opening. | “The agent uses ClipPulse’s shared project and timeline tools. Music and gameplay analysis provide reviewable suggestions, not guaranteed event recognition.” |
| 47–62 s | Show the final timeline, music track, a selected transition or speed ramp, and play the rendered preview. | “Review the edit in the timeline, adjust any cuts, and preview the result before export.” |
| 62–75 s | Export `montage.mp4`; show the completed export and a playback frame, then the release/docs link. | “Export a standard MP4. ClipPulse is open source under GPL-3.0-or-later; FFmpeg is installed separately.” |

## Capture checklist

- Use self-recorded, redistributable, or otherwise authorized gameplay footage and music. Do not commit source clips to the repository.
- Use a clean demo project and generic folder names. Hide user names, full local paths, client account details, credentials, MCP tokens, and unrelated desktop content.
- Record the actual UI state. Only narrate a connection or export after it succeeds in the recording session.
- Show one real agent workflow. If only Codex or Claude Code was tested during the recording, name only that client in the video.
- Keep a copy of the exported MP4 and inspect its codec, duration, and audio/video streams before saying it exported successfully.
- Include captions for the setup and permission steps; keep cursor movements and agent wait periods trimmed, but do not alter application results.

## Suggested deliverables

- `docs/screenshots/editor-timeline.png` — real editor UI with an authorized demo project open.
- `docs/screenshots/agent-setup.png` — real setup dialog with personal paths and configuration details hidden.
- A 1080p MP4 walkthrough with captions and a short text transcript.

These filenames are suggestions only. The image and video files must be captured from the application; this storyboard does not imply they already exist.
