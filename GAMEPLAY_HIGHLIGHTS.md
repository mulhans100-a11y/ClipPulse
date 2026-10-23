# Gameplay highlight analysis

## What the analyzer reports

Highlight analysis lives in the shared `src/core` pipeline used by the desktop, CLI, REST, and MCP adapters. New analysis events retain the existing `kind` field and add:

- `eventType`: semantic label such as `headshot`, `combat_activity`, or `quiet_passage`.
- `evidenceLevel`: `explicit`, `corroborated`, `heuristic`, or `unknown`. These are evidence categories, not probabilities.
- `signals` and `detectors`: machine-readable provenance for the matched words and detector sources.
- `uncertainties`: reasons the result may be wrong or does not prove the named event.
- `scoreBreakdown`: normalized confidence, cue-strength, corroboration, and event-priority contributions whose sum produces `rankScore`.

The current base-score weights are confidence `0.50`, cue strength `0.35`, and detector corroboration `0.15`; semantic priority adds at most `0.08`. The final rank is bounded to 0–100. Scores are relative ranking heuristics and are not calibrated event probabilities.

## Valorant adapter

`src/core/gameplay/valorant.ts` is a game-specific adapter behind the existing detector plugin pipeline. Optional Tesseract OCR classifies explicit English text phrases for kills, headshots, multi-kills, aces, clutches, spike objectives, and round results. A visible `1vN` string is only a heuristic `clutch_situation`; it cannot prove a clutch win.

The adapter also tracks changes in OCR text rows in the conventional upper-right feed area using normalized frame coordinates. Resolution and ordinary HUD scale do not affect those normalized coordinates. A changed row is labeled `kill_feed_change` with heuristic evidence and a warning that it could be another HUD change or OCR noise. It is never silently converted into a `kill`. Valorant's usual feed is largely icon-based, so OCR may not expose a kill or headshot phrase at all; those events remain unknown unless a supported phrase is actually visible. Custom HUD placement can also defeat the feed-location heuristic.

Correlated audio transients and sampled frame motion produce `combat_activity` at `corroborated` evidence level, not a verified fight or kill. Motion-only peaks produce `fast_action_candidate`. Four-second low-motion windows, optionally gated by low relative audio energy, produce `quiet_passage` with explicit uncertainty. Unreviewed quiet, unknown-text, and tentative feed-change cues are excluded from automatic montage selection. The user can accept/reject events and correct their time and event type; these reviews persist on the project media asset and flow into generated plans. Re-analysis writes to its analysis cache and does not replace those project reviews.

Tesseract is optional and local. Without it, audio and video heuristics still run, but the adapter cannot produce OCR-derived event types. No gameplay model, external inference service, credentials, or model weights are included. `analysis-runtimes` reports the model adapter as unavailable instead of implying inference.

## Reproducible checks and evaluation

Run the checks from the repository root:

```sh
npm run build
npm test
npm run evaluate:valorant-fixture
```

`tests/fixtures/valorant-hud-text-v1.json` contains 8 positive and 3 hard-negative synthetic text cases, including the old `Space`/`Headshots` substring false-positive patterns. `npm run evaluate:valorant-fixture` compares the new typed parser with the prior substring rules and prints deterministic precision, recall, F1, exact event-type accuracy, and the synthetic sample-time offset. Its checked output is in [`reports/valorant-hud-fixture-report.json`](reports/valorant-hud-fixture-report.json).

That fixture checks parser behavior only: it does not decode a game recording, exercise Tesseract image recognition, or estimate gameplay accuracy. The sample-time offset is supplied synthetic OCR-frame time compared with a synthetic event timestamp, not a measured video-detector timing result. Thus it must not be presented as a real-media benchmark.

For actual authorized local material, use the existing independently annotated dataset format in [`evaluation/phase-c-dataset.template.json`](evaluation/phase-c-dataset.template.json) and run:

```sh
npm run cli -- evaluate-highlights --dataset /absolute/path/to/authorized-dataset.json --max-gap 0.75 --output /absolute/path/to/report.json
```

The resulting report includes per-detector precision/recall/F1, exact event-type precision/recall/F1 and mean absolute timestamp error, plus a time-only general-activity-cue baseline that intentionally ignores event labels. Supply complete-interval reviews from at least two independent annotators for benchmark claims; a one-reviewer pilot is explicitly identified as such. Keep recordings outside the repository and optionally pin their SHA-256 hashes in the manifest. No authorized, independently annotated Valorant gameplay recording was provided for this change, so real-game precision, recall, F1, and timing accuracy remain unmeasured.

## Current boundaries

- OCR samples are capped at 120 frames per asset. Fast or short-lived UI text can be missed, especially in long recordings.
- Text rules are literal and primarily English. HUD icons, weapon glyphs, kill-feed semantics, teammate/enemy state, and game-state transitions are not visually modeled.
- Audio/motion and low-motion outputs are heuristics. The visual motion detector uses coarse full-frame luma differences and may respond to camera turns, transitions, or static but important plays.
- Clutch wins are not inferred from player counts. A `1vN` OCR match is only a possible clutch situation; a kill-feed change is never itself a kill claim.
- A trained visual-model adapter has not been implemented because this repository has no compatible model and no representative labeled set to validate it.
- No cross-platform OCR or game-footage benchmark is claimed. `npm test` runs on the current host only; other platforms must be verified by their own CI jobs.

The analysis only reads original source media and writes derived OCR frames into a temporary directory, which it removes after use. Manual reviews are ordinary project metadata, and all event windows remain relative to the source media timeline.
