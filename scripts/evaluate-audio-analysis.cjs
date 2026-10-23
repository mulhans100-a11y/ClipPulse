const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const compiledRoot = path.join(root, 'evaluation', '.local', 'audio-eval-build');
const currentModule = require(path.join(compiledRoot, 'src', 'core', 'audioAnalysis.js'));
const baselineModule = require(path.join(compiledRoot, 'evaluation', 'audioAnalysisV4Baseline.js'));
const OUTPUT_PATH = path.join(root, 'reports', 'audio-analysis-evaluation.json');
const BEAT_TOLERANCE_SECONDS = 0.08;
const DOWNBEAT_TOLERANCE_SECONDS = 0.12;
const ACCENT_TOLERANCE_SECONDS = 0.08;
const DROP_TOLERANCE_SECONDS = 1.5;
const TEMPO_BOUNDARY_TOLERANCE_SECONDS = 2;
const INTERVAL_IOU_TOLERANCE = 0.5;

function f1({ tp, fp, fn }) {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

function matchTimes(predictions, references, tolerance) {
  const unused = new Set(predictions.map((_value, index) => index));
  const errors = [];
  for (const reference of references) {
    let bestIndex = -1;
    let bestError = Infinity;
    for (const index of unused) {
      const error = Math.abs(predictions[index] - reference);
      if (error < bestError) { bestError = error; bestIndex = index; }
    }
    if (bestIndex >= 0 && bestError <= tolerance) {
      errors.push(bestError);
      unused.delete(bestIndex);
    }
  }
  const counts = { tp: errors.length, fp: unused.size, fn: references.length - errors.length };
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    ...counts,
    ...f1(counts),
    errors,
    matchedMeanAbsoluteErrorSeconds: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    matchedMedianAbsoluteErrorSeconds: errors.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    matchedP95AbsoluteErrorSeconds: errors.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null
  };
}

function combine(rows, key) {
  const tp = rows.reduce((sum, row) => sum + row[key].tp, 0);
  const fp = rows.reduce((sum, row) => sum + row[key].fp, 0);
  const fn = rows.reduce((sum, row) => sum + row[key].fn, 0);
  const errors = rows.flatMap((row) => row[key].errors ?? []);
  return { ...f1({ tp, fp, fn }), tp, fp, fn, meanAbsoluteErrorSeconds: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null };
}

function measureAnalysis(analysis, references, downbeats = []) {
  const beats = matchTimes(analysis.beats ?? [], references, BEAT_TOLERANCE_SECONDS);
  const downbeatMetrics = matchTimes(analysis.downbeats ?? [], downbeats, DOWNBEAT_TOLERANCE_SECONDS);
  beats.errors = errorsFor(analysis.beats ?? [], references, BEAT_TOLERANCE_SECONDS);
  downbeatMetrics.errors = errorsFor(analysis.downbeats ?? [], downbeats, DOWNBEAT_TOLERANCE_SECONDS);
  return { beats, downbeats: downbeatMetrics, estimatedBpm: analysis.estimatedBpm ?? null, tempoSegments: analysis.tempoSegments ?? [] };
}

function errorsFor(predictions, references, tolerance) {
  const unmatched = new Set(predictions.map((_value, index) => index));
  const errors = [];
  for (const reference of references) {
    let best = -1, delta = Infinity;
    for (const index of unmatched) {
      const current = Math.abs(predictions[index] - reference);
      if (current < delta) { delta = current; best = index; }
    }
    if (best >= 0 && delta <= tolerance) { unmatched.delete(best); errors.push(delta); }
  }
  return errors;
}

function sumMetric(rows, selector) {
  const counts = rows.reduce((out, row) => ({ tp: out.tp + selector(row).tp, fp: out.fp + selector(row).fp, fn: out.fn + selector(row).fn }), { tp: 0, fp: 0, fn: 0 });
  const errors = rows.flatMap((row) => selector(row).errors ?? []);
  return { ...f1(counts), ...counts, matchedMeanAbsoluteErrorSeconds: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null };
}

function intervalMetric(predictions, references, minimumIou = INTERVAL_IOU_TOLERANCE) {
  const unused = new Set(predictions.map((_value, index) => index));
  let tp = 0;
  const errors = [];
  for (const reference of references) {
    let bestIndex = -1, bestIou = 0;
    for (const index of unused) {
      const candidate = predictions[index];
      const intersection = Math.max(0, Math.min(candidate[1], reference[1]) - Math.max(candidate[0], reference[0]));
      const union = Math.max(candidate[1], reference[1]) - Math.min(candidate[0], reference[0]);
      const iou = union > 0 ? intersection / union : 0;
      if (iou > bestIou) { bestIou = iou; bestIndex = index; }
    }
    if (bestIndex >= 0 && bestIou >= minimumIou) {
      tp++;
      errors.push(Math.abs(predictions[bestIndex][0] - reference[0]));
      unused.delete(bestIndex);
    }
  }
  const counts = { tp, fp: unused.size, fn: references.length - tp };
  return { ...f1(counts), ...counts, errors, intervalStartMeanAbsoluteErrorSeconds: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null, minimumIntersectionOverUnion: minimumIou };
}

function tempoAt(tempo, timeSeconds, durationSeconds) {
  if (tempo.kind === 'constant') return tempo.bpm;
  if (tempo.kind === 'abrupt') return timeSeconds < tempo.atSeconds ? tempo.fromBpm : tempo.toBpm;
  const fraction = Math.min(1, Math.max(0, timeSeconds / durationSeconds));
  return tempo.fromBpm + (tempo.toBpm - tempo.fromBpm) * fraction;
}

function localTempoMae(segments, tempo, durationSeconds) {
  if (!segments.length) return null;
  const errors = [];
  for (let second = 1; second < durationSeconds; second++) {
    const segment = segments.find((item) => second >= item.startSeconds && second < item.endSeconds) ?? segments[segments.length - 1];
    errors.push(Math.abs(segment.bpm - tempoAt(tempo, second, durationSeconds)));
  }
  return errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null;
}

function tempoBoundaryError(segments, expectedSeconds) {
  if (expectedSeconds === undefined) return null;
  const changes = [];
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1], current = segments[index];
    const ratio = Math.max(previous.bpm, current.bpm) / Math.max(1, Math.min(previous.bpm, current.bpm));
    if (ratio >= 1.18) changes.push(current.startSeconds);
  }
  return changes.length ? Math.min(...changes.map((time) => Math.abs(time - expectedSeconds))) : null;
}

function eventTimes(events, type) { return events.filter((event) => event.type === type).map((event) => event.timeSeconds); }
function eventIntervals(events, type) { return events.filter((event) => event.type === type && event.endSeconds !== undefined).map((event) => [event.timeSeconds, event.endSeconds]); }

function summarizeRows(rows, tempoItems) {
  const bpmErrors = tempoItems.flatMap((row) => row.estimatedBpm === null ? [] : [Math.abs(row.estimatedBpm - row.referenceBpm)]);
  const localTempoErrors = rows.map((row) => row.localTempoMeanAbsoluteErrorBpm).filter(Number.isFinite);
  return {
    tracks: rows.length,
    beats: sumMetric(rows, (row) => row.beats),
    downbeats: sumMetric(rows, (row) => row.downbeats),
    localTempoMeanAbsoluteErrorBpm: localTempoErrors.length ? localTempoErrors.reduce((sum, error) => sum + error, 0) / localTempoErrors.length : null,
    bpmMeanAbsoluteError: bpmErrors.length ? bpmErrors.reduce((sum, error) => sum + error, 0) / bpmErrors.length : null,
    bpmReferences: bpmErrors.length
  };
}

async function writeSyntheticWav(filePath, spec) {
  const sampleRate = 22050;
  const sampleCount = Math.floor(spec.durationSeconds * sampleRate);
  const samples = new Float32Array(sampleCount);
  const beats = [];
  const periodAt = (time) => {
    return 60 / tempoAt(spec.tempo, time, spec.durationSeconds);
  };
  for (let time = 0, guard = 0; time < spec.durationSeconds && guard < sampleCount; guard++) {
    beats.push(time);
    const period = periodAt(time);
    if (spec.tempo.kind === 'ramp') {
      const middle = time + period / 2;
      const bpm = tempoAt(spec.tempo, middle, spec.durationSeconds);
      time += 60 / bpm;
    } else time += period;
  }
  const accents = beats.filter((_time, index) => index % 4 === 0);
  const addPulse = (timeSeconds, kind, amplitude) => {
    const start = Math.round(timeSeconds * sampleRate);
    const length = Math.min(Math.floor(sampleRate * (kind === 'hat' ? 0.045 : 0.17)), sampleCount - start);
    if (length <= 0) return;
    for (let offset = 0; offset < length; offset++) {
      const elapsed = offset / sampleRate;
      let value = 0;
      if (kind === 'kick') value = Math.sin(2 * Math.PI * 62 * elapsed) * Math.exp(-elapsed * 30);
      else if (kind === 'snare') value = (Math.sin(2 * Math.PI * 190 * elapsed) * 0.65 + Math.sin(2 * Math.PI * 480 * elapsed) * 0.15) * Math.exp(-elapsed * 21);
      else if (kind === 'hat') value = Math.sin(2 * Math.PI * 6100 * elapsed) * Math.exp(-elapsed * 86);
      else value = Math.sin(2 * Math.PI * 850 * elapsed) * Math.exp(-elapsed * 12);
      const at = timeSeconds + elapsed;
      let gain = 1;
      if (spec.pause && at >= spec.pause.startSeconds && at < spec.pause.endSeconds) gain = 0.035;
      if (spec.build && at >= spec.build.startSeconds && at < spec.build.endSeconds) {
        gain = 0.2 + 0.75 * (at - spec.build.startSeconds) / (spec.build.endSeconds - spec.build.startSeconds);
      }
      if (spec.dropSeconds !== undefined && at >= spec.dropSeconds) gain = Math.max(gain, 0.98);
      const index = start + offset;
      if (index < sampleCount) samples[index] += value * amplitude * gain;
    }
  };

  for (let index = 0; index < beats.length; index++) {
    const isAccent = index % 4 === 0;
    const amplitude = isAccent ? 0.95 : 0.62;
    const time = beats[index];
    if (spec.genre === 'ambient') addPulse(time, 'bell', amplitude * 0.6);
    else if (spec.genre === 'rock') {
      addPulse(time, index % 4 === 1 || index % 4 === 3 ? 'snare' : 'kick', amplitude);
      addPulse(time + periodAt(time) / 2, 'hat', 0.22);
    } else if (spec.genre === 'metal') {
      addPulse(time, 'kick', amplitude);
      addPulse(time + periodAt(time) / 2, 'kick', 0.35);
      if (index % 4 === 2) addPulse(time + periodAt(time) * 0.75, 'snare', 0.3);
    } else {
      addPulse(time, 'kick', amplitude);
      addPulse(time + periodAt(time) / 2, 'hat', 0.32);
      if (index % 4 === 2) addPulse(time, 'snare', 0.35);
    }
  }
  const header = Buffer.alloc(44 + sampleCount * 2);
  header.write('RIFF', 0); header.writeUInt32LE(header.length - 8, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index++) header.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), 44 + index * 2);
  await writeFile(filePath, header);
  const downbeats = beats.filter((_time, index) => index % 4 === 0);
  return { beats, downbeats, accents };
}

const SYNTHETIC_CASES = [
  { id: 'low-60-ambient', genre: 'ambient', tempo: { kind: 'constant', bpm: 60 }, durationSeconds: 24 },
  { id: 'mid-120-rock', genre: 'rock', tempo: { kind: 'constant', bpm: 120 }, durationSeconds: 24 },
  { id: 'fast-180-metal', genre: 'metal', tempo: { kind: 'constant', bpm: 180 }, durationSeconds: 24 },
  { id: 'abrupt-75-to-150-edm', genre: 'edm', tempo: { kind: 'abrupt', fromBpm: 75, toBpm: 150, atSeconds: 12 }, durationSeconds: 24 },
  { id: 'continuous-90-to-150-edm', genre: 'edm', tempo: { kind: 'ramp', fromBpm: 90, toBpm: 150 }, durationSeconds: 24 },
  { id: 'build-drop-pause-rock', genre: 'rock', tempo: { kind: 'constant', bpm: 100 }, durationSeconds: 24, pause: { startSeconds: 5, endSeconds: 8 }, build: { startSeconds: 8, endSeconds: 12 }, dropSeconds: 12 },
  { id: 'syncopated-94-metal', genre: 'metal', tempo: { kind: 'constant', bpm: 94 }, durationSeconds: 24 }
];

async function runSynthetic(directory) {
  const rows = [];
  for (const spec of SYNTHETIC_CASES) {
    const filePath = path.join(directory, `${spec.id}.wav`);
    const reference = await writeSyntheticWav(filePath, spec);
    const [legacyAnalysis, adaptiveAnalysis] = await Promise.all([
      baselineModule.analyzeAudio(filePath),
      currentModule.analyzeAudio(filePath)
    ]);
    const legacy = measureAnalysis(legacyAnalysis, reference.beats, reference.downbeats);
    const adaptive = measureAnalysis(adaptiveAnalysis, reference.beats, reference.downbeats);
    legacy.localTempoMeanAbsoluteErrorBpm = localTempoMae([{ startSeconds: 0, endSeconds: spec.durationSeconds, bpm: legacy.estimatedBpm ?? 0 }], spec.tempo, spec.durationSeconds);
    const events = adaptiveAnalysis.structureEvents ?? [];
    const accents = matchTimes(adaptiveAnalysis.accents ?? [], reference.accents, ACCENT_TOLERANCE_SECONDS);
    const drops = matchTimes(eventTimes(events, 'drop'), spec.dropSeconds === undefined ? [] : [spec.dropSeconds], DROP_TOLERANCE_SECONDS);
    const quietIntervals = intervalMetric(eventIntervals(events, 'quiet'), spec.pause ? [[spec.pause.startSeconds, spec.pause.endSeconds]] : []);
    const buildUps = intervalMetric(eventIntervals(events, 'build_up'), spec.build ? [[spec.build.startSeconds, spec.build.endSeconds]] : []);
    const boundaryError = tempoBoundaryError(adaptiveAnalysis.tempoSegments ?? [], spec.tempo.kind === 'abrupt' ? spec.tempo.atSeconds : undefined);
    rows.push({
      id: spec.id,
      genre: spec.genre,
      tempo: spec.tempo,
      referenceBeatCount: reference.beats.length,
      legacy: { beats: legacy.beats, downbeats: legacy.downbeats, estimatedBpm: legacy.estimatedBpm, localTempoMeanAbsoluteErrorBpm: legacy.localTempoMeanAbsoluteErrorBpm },
      adaptive: { beats: adaptive.beats, downbeats: adaptive.downbeats, estimatedBpm: adaptive.estimatedBpm, bpmHypotheses: adaptiveAnalysis.bpmHypotheses, meter: adaptiveAnalysis.meter ?? null, beatGridCount: adaptiveAnalysis.beatGrid?.length ?? 0, tempoSegments: adaptiveAnalysis.tempoSegments ?? [], relativeEnergy: adaptiveAnalysis.energyCurve, localTempoMeanAbsoluteErrorBpm: localTempoMae(adaptiveAnalysis.tempoSegments ?? [], spec.tempo, spec.durationSeconds), tempoBoundaryAbsoluteErrorSeconds: boundaryError, tempoBoundaryWithinTolerance: boundaryError !== null && boundaryError <= TEMPO_BOUNDARY_TOLERANCE_SECONDS, accents, drops, detectedAccents: adaptiveAnalysis.accents?.length ?? 0, detectedBuildUps: events.filter((event) => event.type === 'build_up').length, detectedDrops: eventTimes(events, 'drop'), detectedQuietIntervals: eventIntervals(events, 'quiet'), quietIntervals, detectedBuildUpIntervals: eventIntervals(events, 'build_up'), buildUps }
    });
  }
  const constantCases = rows.filter((row) => row.tempo.kind === 'constant');
  const legacyTempoReferences = constantCases.map((row) => ({ estimatedBpm: row.legacy.estimatedBpm, referenceBpm: row.tempo.bpm }));
  const adaptiveTempoReferences = constantCases.map((row) => ({ estimatedBpm: row.adaptive.estimatedBpm, referenceBpm: row.tempo.bpm }));
  return {
    cases: rows,
    baseline: summarizeRows(rows.map((row) => row.legacy), legacyTempoReferences),
    adaptive: summarizeRows(rows.map((row) => row.adaptive), adaptiveTempoReferences),
    adaptiveStructure: {
      accents: combine(rows.map((row) => row.adaptive), 'accents'),
      drops: combine(rows.map((row) => row.adaptive), 'drops'),
      quietIntervals: combine(rows.map((row) => row.adaptive), 'quietIntervals'),
      buildUps: combine(rows.map((row) => row.adaptive), 'buildUps'),
      localTempoMeanAbsoluteErrorBpm: rows.map((row) => row.adaptive.localTempoMeanAbsoluteErrorBpm).filter(Number.isFinite).reduce((sum, value, _index, values) => sum + value / values.length, 0),
      abruptTempoBoundaryCases: rows.filter((row) => row.tempo.kind === 'abrupt').map((row) => ({ id: row.id, errorSeconds: row.adaptive.tempoBoundaryAbsoluteErrorSeconds, withinTolerance: row.adaptive.tempoBoundaryWithinTolerance }))
    },
    note: 'All cases are deterministic, locally synthesized WAV signals. These results do not represent general music or commercial soundtrack accuracy.'
  };
}

async function runArtbeat() {
  const datasetPath = path.join(root, 'evaluation', '.local', 'artbeat', 'dataset.json');
  let dataset;
  try { dataset = JSON.parse(await readFile(datasetPath, 'utf8')); }
  catch { return { status: 'skipped', reason: 'Local ARTBeaT files were not present. Run scripts/evaluate-artbeat.ps1 to download the CC BY 4.0 reference set.' }; }
  const directory = path.dirname(datasetPath);
  const rows = [];
  for (const item of dataset.items ?? []) {
    if (!item.musicAnnotations?.length) continue;
    const filePath = path.resolve(directory, item.mediaPath);
    const reference = item.musicAnnotations[0];
    const [legacyAnalysis, adaptiveAnalysis] = await Promise.all([
      baselineModule.analyzeAudio(filePath),
      currentModule.analyzeAudio(filePath)
    ]);
    rows.push({
      file: path.basename(filePath), category: item.musicProfile?.category ?? 'unknown',
      referenceBpm: reference.bpm ?? null,
      legacy: measureAnalysis(legacyAnalysis, reference.beatTimesSeconds, reference.downbeatTimesSeconds ?? []),
      adaptive: measureAnalysis(adaptiveAnalysis, reference.beatTimesSeconds, reference.downbeatTimesSeconds ?? [])
    });
  }
  const tempoRowsLegacy = rows.filter((row) => row.referenceBpm !== null).map((row) => ({ ...row.legacy, referenceBpm: row.referenceBpm }));
  const tempoRowsAdaptive = rows.filter((row) => row.referenceBpm !== null).map((row) => ({ ...row.adaptive, referenceBpm: row.referenceBpm }));
  const categories = [...new Set(rows.map((row) => row.category))].sort().map((category) => {
    const values = rows.filter((row) => row.category === category);
    return { category, legacy: summarizeRows(values.map((row) => row.legacy), []), adaptive: summarizeRows(values.map((row) => row.adaptive), []) };
  });
  const failures = rows.map((row) => ({ file: row.file, category: row.category, legacyF1: row.legacy.beats.f1, adaptiveF1: row.adaptive.beats.f1, deltaF1: row.adaptive.beats.f1 - row.legacy.beats.f1, adaptiveMeanTimingErrorSeconds: row.adaptive.beats.matchedMeanAbsoluteErrorSeconds }))
    .sort((a, b) => a.adaptiveF1 - b.adaptiveF1).slice(0, 8);
  const report = {
    status: 'measured',
    datasetId: dataset.datasetId,
    sourceRevision: dataset.referenceSource?.sourceRevision,
    license: dataset.referenceSource?.license,
    referenceTracks: rows.length,
    tolerancesSeconds: { beat: BEAT_TOLERANCE_SECONDS, downbeat: DOWNBEAT_TOLERANCE_SECONDS },
    legacy: summarizeRows(rows.map((row) => row.legacy), tempoRowsLegacy),
    adaptive: summarizeRows(rows.map((row) => row.adaptive), tempoRowsAdaptive),
    categories,
    perTrack: rows,
    lowestAdaptiveBeatF1: failures,
    note: 'The ARTBeaT release is a controlled rhythm challenge set, not representative commercial soundtrack music. One item excluded by the published manifest because its labels exceed the audio duration is not present in dataset.items.'
  };
  return report;
}

async function main() {
  const started = Date.now();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'clippulse-audio-eval-'));
  try {
    const synthetic = await runSynthetic(temporaryDirectory);
    const artbeat = await runArtbeat();
    const report = {
      schemaVersion: 1,
      evaluatedAtUtc: new Date().toISOString(),
      analyzer: { legacy: 'spectral-flux-dynamic-beat-v4', current: 'spectral-flux-adaptive-beat-v5' },
      tolerances: { beatSeconds: BEAT_TOLERANCE_SECONDS, downbeatSeconds: DOWNBEAT_TOLERANCE_SECONDS, accentSeconds: ACCENT_TOLERANCE_SECONDS, dropSeconds: DROP_TOLERANCE_SECONDS, tempoBoundarySeconds: TEMPO_BOUNDARY_TOLERANCE_SECONDS, intervalMinimumIntersectionOverUnion: INTERVAL_IOU_TOLERANCE },
      runtime: { node: process.version, ffmpeg: ffmpegVersion(), durationSeconds: Number(((Date.now() - started) / 1000).toFixed(2)) },
      synthetic,
      artbeat
    };
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ output: path.relative(root, OUTPUT_PATH), runtime: report.runtime, synthetic: { legacy: synthetic.baseline.beats, adaptive: synthetic.adaptive.beats }, artbeat: artbeat.status === 'measured' ? { tracks: artbeat.referenceTracks, legacy: artbeat.legacy.beats, adaptive: artbeat.adaptive.beats, bpmMae: { legacy: artbeat.legacy.bpmMeanAbsoluteError, adaptive: artbeat.adaptive.bpmMeanAbsoluteError }, worstCases: artbeat.lowestAdaptiveBeatF1 } : artbeat }, null, 2));
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

function ffmpegVersion() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `FFmpeg is required to run the audio evaluation: ${result.stderr}`);
  return result.stdout.split(/\r?\n/)[0];
}

main().catch((error) => { console.error(error?.stack ?? error); process.exitCode = 1; });
