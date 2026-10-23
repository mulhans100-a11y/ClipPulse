# Phase C evaluation workflow

ClipPulse ships the evaluation runner and a manifest template. It does not ship gameplay or commercial music recordings. Use material you are authorized to evaluate; keep private recordings outside the repository.

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

### Adaptive beat grid v5 evaluation

Run `npm run evaluate:audio` to compile the frozen v4 reference analyzer and run it side by side with the current v5 analyzer. The runner creates deterministic local WAV stimuli across ambient, rock, metal, EDM, tempo-change, syncopation, build/drop, and silence cases, then scores both generations against the exact generated references. If the ignored local ARTBeaT dataset is available under `evaluation/.local/artbeat/`, the same run also scores those 24 eligible licensed tracks. It writes the machine-readable output to `reports/audio-analysis-evaluation.json`; the report includes Node/FFmpeg versions, evaluation time, explicit tolerances, per-case values, aggregate/category metrics, and the low-scoring tracks.

Evaluation matching uses one-to-one nearest-event matching with 80 ms beat/accent tolerance, 120 ms downbeat tolerance, and 1.5 s drop tolerance. Quiet and build-up intervals require intersection-over-union of at least 0.5. Synthetic tempo maps are sampled once each second; abrupt tempo boundaries count as detected within 2 s. Global BPM MAE is only scored on constant-tempo references. Tempo values, meter, beats, and event confidence are heuristic and are not calibrated probabilities. ARTBeaT supplies beat/downbeat labels but not independently reviewed accents or section/drop labels, so section-structure precision/recall is reported only on synthetic stimuli. The comparison does not establish transfer to commercial soundtracks or all genres.

The checked-in run was refreshed on 2026-10-23 (Node 24.16.0 / FFmpeg 9.0.2; 5.72 s). It measured ARTBeaT beat F1 0.6731 → 0.7175 (+0.0445 absolute) and matched timing MAE 45.3 ms → 44.4 ms. BPM MAE on eight fixed-tempo references was 35.46 → 17.55 BPM. ARTBeaT downbeat F1 remains very poor (0.0215 → 0.0225 at 120 ms), with 2 true positives and 142 false positives for v5. In seven synthetic cases, beat F1 changed 0.8426 → 0.8483 and MAE 27.32 → 27.27 ms; downbeat F1 changed 0.5658 → 0.6460. Local-tempo MAE changed 36.47 → 34.30 BPM, but this aggregate is dominated by pulse ambiguity in fast/syncopated cases. The continuous 90→150 BPM ramp was tracked at 2.41 BPM local MAE; an abrupt 75→150 BPM change was not split into local tempo segments. Synthetic accent F1 was 0.5686 (P 0.4754, R 0.7073, 29.9 ms matched MAE); drop F1 0.50 (1 TP, 2 FP); build-up F1 0.50 (1 TP, 2 FP); and quiet-interval F1 1.00 on the single labeled pause. These are deliberately small deterministic stimuli, not listener ratings. ARTBeaT remains a controlled rhythm challenge, not representative commercial music. Known weaknesses include a rhythmic-deception track with F1 0 in both analyzers and the syncopation track regressing from F1 0.5176 to 0.4267. The exact per-category/per-track data and the failure examples are in `reports/audio-analysis-evaluation.json`; treat that machine report as authoritative for reruns.

Run the report after building:

```powershell
npm run build
npm run cli -- evaluate-highlights --dataset .\evaluation\my-game.json --max-gap 2 --output .\evaluation\report.json
npm run cli -- analysis-runtimes
```

The report includes per-detector precision, recall, F1, false positives and false negatives, per-event-type precision/recall/F1 and mean absolute timing error, plus a clearly labeled time-only activity-cue baseline and score calibration diagnostics. `--max-gap` controls the allowed difference between predicted and annotated decisive timestamps. A missing Tesseract runtime is recorded as an OCR detector skip; the other local detectors continue. No gameplay model weights are downloaded or bundled.

## Game event phrase rules

When a media asset has a game name, sampled OCR text is checked against explicit event phrases. Built-in phrase profiles cover Valorant, Counter-Strike, Fortnite, Apex Legends, Overwatch, Call of Duty, OpenArena, and Anarch. Valorant additionally has a modular game adapter for typed HUD phrases and a normalized-coordinate tentative feed-row-change cue; the latter is not a kill claim. Other profiles retain phrase cues without claiming a trained game model. To customize terms, copy `config/game-rules.example.json`, edit the profile aliases and event keywords, then set `OPENMONTAGE_GAME_RULES` to the JSON file before launching the desktop app or CLI. Matching normalizes case and punctuation and uses literal phrases; it does not run arbitrary expressions or download code. Install Tesseract separately to enable OCR; use `analysis-runtimes` to check the detected state.

The deterministic parser regression fixture and its legacy substring-rule comparison are documented in [`GAMEPLAY_HIGHLIGHTS.md`](../GAMEPLAY_HIGHLIGHTS.md). That synthetic text fixture does not measure OCR image recognition or gameplay event accuracy. No representative, independently annotated Valorant media is currently checked in or reported.

## Interpreting scores

Detector confidence and the tempo correlation score are raw heuristics. Brier score and expected calibration error describe their agreement with this manifest; they do not rewrite those scores or guarantee transfer to another game, recording setup, or music collection. Evaluate on a held-out set before treating calibration as general. OCR text is sampled at no more than 120 frames per asset, and motion is estimated from 64×36 grayscale frames sampled at 4 fps.

`phase-c-dataset.template.json` contains illustrative timestamps only. It is not a measured or independently annotated benchmark, and it must be replaced before reporting performance for a game.
