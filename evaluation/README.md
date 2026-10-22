# Phase C evaluation workflow

OpenMontage ships the evaluation runner and a manifest template. It does not ship gameplay or commercial music recordings. Use material you are authorized to evaluate; keep private recordings outside the repository.

## Prepare a manifest

Copy `phase-c-dataset.template.json` beside a folder containing your authorized clips and music. Replace the game name, media paths, durations, and example labels. Paths are resolved relative to the manifest. Add `sha256` to a media item when the source should be pinned to an exact file version.

The evaluator can score gameplay manifests that already contain independently reviewed reference labels. It does not require users to create or review a personal gameplay dataset. A reviewed clip with no target events has `annotations: []`; it is a true negative interval for detecting false positives. Event labels become reference events only when a strict majority of reviewers labeled the same event type within two seconds of one another. The evaluator uses median annotated times and reports disagreements separately.

For music items, add one `musicAnnotations` entry per independent reviewer. Each entry can include BPM, beat timestamps, and downbeat timestamps. The evaluator forms timestamp consensus within 80 ms for beats and 120 ms for downbeats, then reports BPM mean absolute error and beat/downbeat precision, recall, and F1. Music tempo scores are compared with the independently labeled BPM to produce Brier score and expected calibration error diagnostics.

Music annotations may also include `meter` (`beatsPerBar`, `denominator`, and optional `downbeatPhase`) and an item `musicProfile` with a category and description. The report includes meter accuracy, coverage, confidence calibration, and per-category summaries. An abstention counts against accuracy and is also visible in coverage; raw heuristic scores remain unchanged.

### Published music reference sets

An audio-only manifest may use `referenceSource` when it contains a published music reference set with its license and citation. Declare one `published-reference` annotator, copy the source labels into `musicAnnotations`, and state the source annotation method accurately. This mode is rejected for gameplay items. It does not fabricate per-listener labels: if a source only publishes an aggregate, the manifest must say so and must not claim individual-reviewer agreement.

The optional `scripts/evaluate-artbeat.ps1` downloads the 25-track ARTBeaT reference set from its official page, verifies and records an archive SHA-256, creates a manifest from its supplied beat timestamps, and saves the result under the ignored `evaluation/.local/artbeat/` directory. ARTBeaT is CC BY 4.0 and includes controlled rhythm challenges (tempo changes, syncopation, polyrhythms, odd meters), a Debussy piano excerpt, and a metal example; it is a stress set, not a representative sample of commercial montage soundtracks. The individual listening-study records are not included in its download. Use the supplied labels as published ground truth only, not as two named annotators.

### Optional local Medal review helper

The scripts `prepare-medal-review.ps1`, `record-medal-times.ps1`, and `merge-medal-review.ps1` can create a private, local gameplay pilot. This is optional and is not a project-completion requirement. No user needs to review clips; gameplay detector quality simply remains unverified without a suitable labeled reference set.

Run from the repository root in PowerShell:

```powershell
.\scripts\evaluate-artbeat.ps1
```

The script builds the project and writes a local JSON report. It never copies the audio into tracked files. The license, citation, source URL, archive hash, and source-file hashes are recorded in the generated manifest.

Historical baseline for analyzer `rms-onset-autocorrelation-v2` (22 October 2026): 24 tracks analyzed; item 21 excluded because its source beat labels exceeded the WAV duration by 2 seconds; BPM MAE 26.48 on constant-tempo references, beat F1 0.537, downbeat F1 0.047, meter accuracy/coverage 0.20/0.20.

Analyzer `spectral-flux-dynamic-beat-v4` was evaluated against the same 24 tracks: BPM MAE 11.70 on the eight fixed-tempo references, aggregate beat F1 0.678, and meter coverage 0.40. That is a 56% lower BPM error and a 0.141 absolute increase in beat F1 over the old baseline. Downbeat evaluation recorded zero true positives, and all meter estimates in the covered subset were wrong. The v4 tempo and beat results improved substantially; meter and downbeat tracking remain weak and uncalibrated. These scores come from a deliberately difficult reference set and are not a representative estimate for all music. The user-provided `Cornfield` track was analyzed at an estimated 96 BPM with 211 beat positions; it has no reference labels, so that result is exploratory, not scored.

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
