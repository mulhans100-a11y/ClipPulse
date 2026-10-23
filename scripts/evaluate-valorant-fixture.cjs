const fs = require('node:fs');
const path = require('node:path');
const { classifyValorantHudText, legacyValorantTextMatch } = require('../dist/src/core/gameplay/valorant.js');

const fixturePath = path.resolve(__dirname, '../tests/fixtures/valorant-hud-text-v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
if (fixture.schemaVersion !== 1 || !Array.isArray(fixture.cases)) throw new Error('Unsupported Valorant HUD fixture format.');

function summarize(predict) {
  let tp = 0, fp = 0, fn = 0, typeCorrect = 0;
  const deltas = [];
  for (const item of fixture.cases) {
    const prediction = predict(item.text);
    const expected = item.expectedEventType !== null;
    if (prediction && expected) {
      tp++;
      if (prediction.eventType === item.expectedEventType) typeCorrect++;
      if (Number.isFinite(item.sampledAtSeconds) && Number.isFinite(item.eventTimeSeconds)) deltas.push(Math.abs(item.sampledAtSeconds - item.eventTimeSeconds));
    } else if (prediction) fp++;
    else if (expected) fn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision,
    recall,
    f1: precision !== null && recall !== null && precision + recall ? 2 * precision * recall / (precision + recall) : null,
    exactEventTypeAccuracy: tp ? typeCorrect / tp : null,
    meanAbsoluteSampleOffsetSeconds: deltas.length ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : null,
    maxSampleOffsetSeconds: deltas.length ? Math.max(...deltas) : null
  };
}

const report = {
  schemaVersion: 1,
  datasetId: fixture.datasetId,
  purpose: fixture.purpose,
  caseCount: fixture.cases.length,
  positiveCases: fixture.cases.filter((item) => item.expectedEventType !== null).length,
  negativeCases: fixture.cases.filter((item) => item.expectedEventType === null).length,
  legacySubstringRules: summarize((text) => {
    const result = legacyValorantTextMatch(text);
    return result ? { eventType: result.eventId } : null;
  }),
  typedValorantAdapter: summarize((text) => classifyValorantHudText(text, 'Valorant')),
  timingMetricNote: 'Sample offset compares the fixture timestamp of the OCR frame to its synthetic event timestamp; it is not measured from decoded gameplay media and must not be presented as a real-media detector timing benchmark.'
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
