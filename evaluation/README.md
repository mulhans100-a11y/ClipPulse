# Phase C evaluation workflow

OpenMontage ships the evaluation runner and a manifest template. It does not ship gameplay or commercial music recordings. Use material you are authorized to evaluate; keep private recordings outside the repository.

## Prepare a manifest

Copy `phase-c-dataset.template.json` beside a folder containing your authorized clips and music. Replace the game name, media paths, durations, and example labels. Paths are resolved relative to the manifest. Add `sha256` to a media item when the source should be pinned to an exact file version.

Two or more annotators must independently review the full duration of every item before sharing labels. List those reviewers in `reviewedBy`. Record every target gameplay event with its type and start, decisive, and end times. A reviewed clip with no target events has `annotations: []`; it is a true negative interval for detecting false positives. Event labels become consensus only when a strict majority of reviewers labeled the same event type within two seconds of one another. The evaluator uses the median annotated times and reports disagreements separately.

For music items, add one `musicAnnotations` entry per independent reviewer. Each entry can include BPM, beat timestamps, and downbeat timestamps. The evaluator forms timestamp consensus within 80 ms for beats and 120 ms for downbeats, then reports BPM mean absolute error and beat/downbeat precision, recall, and F1. Music tempo scores are compared with the independently labeled BPM to produce Brier score and expected calibration error diagnostics.

Run the report after building:

```powershell
npm run build
npm run cli -- evaluate-highlights --dataset .\evaluation\my-game.json --max-gap 2 --output .\evaluation\report.json
npm run cli -- analysis-runtimes
```

The report includes per-detector precision, recall, F1, false positives and false negatives, plus score calibration diagnostics. `--max-gap` controls the allowed difference between predicted and annotated decisive timestamps. A missing Tesseract runtime is recorded as an OCR detector skip; the other local detectors continue. No model weights are downloaded or bundled.

## Game event phrase rules

When a media asset has a game name, sampled OCR text is checked against explicit event phrases. Built-in profiles cover Valorant, Counter-Strike, Fortnite, Apex Legends, Overwatch, Call of Duty, OpenArena, and Anarch. To customize terms, copy `config/game-rules.example.json`, edit the profile aliases and event keywords, then set `OPENMONTAGE_GAME_RULES` to the JSON file before launching the desktop app or CLI. Matching normalizes case and punctuation and uses literal phrases; it does not run arbitrary expressions or download code. Phrase rules produce heuristic cues, not model predictions. Install Tesseract separately to enable OCR; use `analysis-runtimes` to check the detected state.

## Interpreting scores

Detector confidence and the tempo correlation score are raw heuristics. Brier score and expected calibration error describe their agreement with this manifest; they do not rewrite those scores or guarantee transfer to another game, recording setup, or music collection. Evaluate on a held-out set before treating calibration as general. OCR text is sampled at no more than 120 frames per asset, and motion is estimated from 64×36 grayscale frames sampled at 4 fps.

`phase-c-dataset.template.json` contains illustrative timestamps only. It is not a measured or independently annotated benchmark, and it must be replaced before reporting performance for a game.
