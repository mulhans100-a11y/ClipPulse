# Agent end-to-end validation

This test exercises the existing ClipPulse editing core through a real MCP stdio process and the official MCP TypeScript client. It does not create a second editing path. Synthetic media, generated projects, cache data, and exports live in a temporary directory; imported sources are checked against their SHA-256 identities after export.

## Run the synthetic workflow

Requirements: Node.js 24 or newer, npm, and FFmpeg/FFprobe 6 or newer with `drawtext` and `libx264`.

```powershell
npm ci
npm run build
npm test
npm run agent-e2e
```

`npm test` includes the synthetic 30-second workflow. The separate `agent-e2e` command runs it again and prints a concise result. JSON reports are written under `test-results/` and include app version, platform, action success rate, failed actions, retries, selected highlights, timeline changes, elapsed time, and FFprobe export checks. CI uploads reports as test artifacts. They are not included in release files.

The workflow generates a 35-second synthetic video with scene changes and a 120 BPM click track. MCP calls create/open a project, import both sources, analyze music and highlights, accept selected events, generate a 30-second montage, check beat alignment, apply a zoom/color/transition/speed ramp, validate and preview the edit, export an MP4, and verify H.264/AAC, dimensions, duration, frame count, and non-empty output with FFprobe. The report's quality metrics are technical checks, not a subjective assessment of gameplay or edit quality.

To retain the temporary project and MP4 for inspection:

```powershell
$env:CLIPPULSE_KEEP_AGENT_E2E_ARTIFACTS = '1'
npm run agent-e2e
Remove-Item Env:CLIPPULSE_KEEP_AGENT_E2E_ARTIFACTS
```

The command reports the temporary workspace path when it keeps the artifacts. The test does not modify any input media.

## Optional run with local gaming footage

Create a local UTF-8 JSON file containing exactly 20 distinct video paths and one separate music path. The paths must be absolute; keep this file and the footage out of Git.

```json
{
  "videoPaths": [
    "D:/Captures/clip-01.mp4",
    "D:/Captures/clip-02.mp4",
    "D:/Captures/clip-03.mp4",
    "D:/Captures/clip-04.mp4",
    "D:/Captures/clip-05.mp4",
    "D:/Captures/clip-06.mp4",
    "D:/Captures/clip-07.mp4",
    "D:/Captures/clip-08.mp4",
    "D:/Captures/clip-09.mp4",
    "D:/Captures/clip-10.mp4",
    "D:/Captures/clip-11.mp4",
    "D:/Captures/clip-12.mp4",
    "D:/Captures/clip-13.mp4",
    "D:/Captures/clip-14.mp4",
    "D:/Captures/clip-15.mp4",
    "D:/Captures/clip-16.mp4",
    "D:/Captures/clip-17.mp4",
    "D:/Captures/clip-18.mp4",
    "D:/Captures/clip-19.mp4",
    "D:/Captures/clip-20.mp4"
  ],
  "musicPath": "D:/Music/montage-track.wav"
}
```

Run the same agent workflow against those files:

```powershell
npm run agent-e2e -- --real-manifest D:/Private/ClipPulse/agent-media.json
```

The harness imports the sources read-only, analyzes each video, accepts up to three highest-ranked cues per clip, and attempts the same 30-second edit and export. The edit can fail honestly when the selected footage/music is too short, unsupported, inaccessible under the granted roots, or yields too few usable events. The report records the failure and avoids including the manifest's absolute source paths.

## Recovery and retries

The harness retries only non-editing MCP operations after recognized transport failures, up to three attempts with exponential backoff and a fresh stdio connection. It never automatically replays editing calls after a lost response. Agent edit batches use `project_transaction`; failed steps roll back, and a later request restores its project/history snapshot if the service process exited mid-transaction. An interrupted export is reported by `render_status` as `RENDER_INTERRUPTED`; inspect the project and start a new `video_export` job to resume.

The test starts the MCP server as a child process and connects with the official TypeScript SDK. It does not claim that Codex-hosted or Claude-hosted model agents completed the workflow. Those require the respective host environment and are reported separately from the SDK client test.

The latest checked-in environment results, including any separate Codex/Claude host checks and platform limitations, are recorded in [AGENT_TEST_REPORT.md](AGENT_TEST_REPORT.md).
