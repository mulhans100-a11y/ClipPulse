# Timeline quality control

ClipPulse quality control uses the existing project model, timeline preview, export graph, agent tools, project transactions, and undo/redo history. It does not create or mutate source media. Analysis frames and reports are stored beside the project in `.openmontage-cache-<project-id>/quality-reports/`.

## Agent workflow

1. Call `quality_analyze` after edits. It validates the project, checks video coverage and clip source ranges, inspects transition/effect state, renders up to 12 representative timeline frames, and optionally exports a temporary analysis render to measure final audio peaks and sustained near-silence.
2. Read findings by severity and evidence level. `objective` denotes a directly checked project or signal property. `heuristic` denotes measured evidence that still needs editorial interpretation (for example, near-black footage or a quiet interval). `subjective` is reserved for an optional visual reviewer; no subjective model is enabled by default.
3. Inspect the included `previewFrames` paths and timeline positions. For a cut-to-beat check, pass exact `selectedBeatTargets` and `beatToleranceMs` to `quality_analyze`.
4. Apply suggested edits through the existing tools, preferably `project_transaction`. Then call `quality_analyze` again. Use `project_undo` if an edit has an unwanted result; committed edits remain available through `project_redo`.
5. For a bounded automatic pass, call `quality_improve`. It defaults to three analyze/fix/recheck iterations and rejects a limit above three. It automatically closes only short uncovered gaps where a preceding and following clip on the same video track exactly bound that gap. It uses the ordinary move-clip tool inside a project transaction. A failed verification restores both the project and its history before the tool returns. All other findings remain suggestions for the agent.
6. Retrieve history with `quality_report_list` or `quality_report_get`.

Example:

```json
{
  "projectPath": "C:/Projects/edit.omproj",
  "maxIterations": 3,
  "maxAutomaticGapSeconds": 0.5
}
```

## Checks and interpretation

- A video gap is an objective absence of enabled video coverage. The visible result is black, although that may be intentional. Only a short, same-track, exactly bounded gap is eligible for automatic movement.
- A near-black sample inside active video is a heuristic warning. It may be an intended fade, blackout, or dark scene. The report includes measured luma statistics and a rendered frame.
- The current shared compositor does not render stored `transitionIn` values. Such configuration is reported as unsupported so agents do not assume the transition appears in a preview or export.
- Audio peak and silence checks run on a temporary render of the actual timeline mix. Used source segments are also checked before the export limiter, which can otherwise hide clipped source peaks. Silence below -55 dB for at least 0.5 seconds is reported as a heuristic because quiet sections can be intentional. At up to 24 unfaded cuts, short windows on either side are compared for large level jumps; these remain a heuristic, not a proven audible defect.
- Beat findings only run when the caller explicitly supplies selected beat positions. They compare each target with the nearest video clip start using exact rational project times and the requested tolerance.
- Effects and keyframes are validated by the same core validator used for editing and export. Invalid project files that cannot load still fail with the core project error.
- A report's `subjectiveAssessment` is `not_performed`; ClipPulse does not label aesthetic quality as objectively true. An optional visual AI reviewer can be added later as a separately identified opinion source.

## Reproducible verification

Run the full regression suite with:

```powershell
npm test
```

The quality cycle test generates a short color-bar video with FFmpeg, introduces a rational 1/4-second timeline gap, verifies the stored report and representative black-gap frame, calls the bounded improvement tool, checks the re-rendered report, and verifies undo/redo. It uses no external model or API key.
