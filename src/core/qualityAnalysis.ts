import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { clipSourceDuration } from './clipEffects';
import { exportVideo } from './export';
import { runCommand } from './ffmpeg';
import { isTrackEnabled, timelineDuration, validateProject } from './project';
import { renderTimelineFrame } from './timelinePreview';
import { add, compare, decimal, frameTime, parseDecimal, rational, seconds, sub, toFrame } from './time';
import type { Project, Rational, TimelineClip, TimelineTrack } from './types';

export type QualitySeverity = 'critical' | 'warning' | 'info';
export type QualityEvidence = 'objective' | 'heuristic' | 'subjective';

export interface QualityCorrection {
  tool: string;
  arguments: Record<string, unknown>;
  automaticallySafe?: boolean;
}

export interface QualityFinding {
  id: string;
  code: string;
  category: 'structure' | 'video' | 'audio' | 'timing' | 'effects' | 'subjective';
  severity: QualitySeverity;
  evidence: QualityEvidence;
  title: string;
  description: string;
  start?: Rational;
  end?: Rational;
  clipIds?: string[];
  measurements?: Record<string, string | number | boolean | null>;
  correction?: QualityCorrection;
}

export interface QualityPreviewFrame {
  time: Rational;
  frame: number;
  path: string;
  mimeType: 'image/png';
  activeClipIds: string[];
  statistics?: Record<string, number>;
  blackLike: boolean;
}

export interface QualityReport {
  schemaVersion: 1;
  reportId: string;
  createdAt: string;
  projectId: string;
  projectUpdatedAt: string;
  duration: Rational;
  frameRate: Rational;
  timeline: Array<{
    trackId: string;
    trackName: string;
    trackKind: TimelineTrack['kind'];
    enabled: boolean;
    clips: Array<{ clipId: string; mediaId: string; start: Rational; end: Rational; duration: Rational; sourceIn: Rational; sourceEnd: Rational; audioEnabled: boolean; transitionIn?: TimelineClip['transitionIn']; effectKeyframeCount: number; speedKeyframeCount: number }>;
  }>;
  summary: {
    status: 'pass' | 'issues' | 'incomplete';
    objectiveChecks: 'pass' | 'issues' | 'incomplete';
    findings: number;
    critical: number;
    warnings: number;
    info: number;
    previewFrames: number;
    subjectiveAssessment: 'not_performed';
  };
  checks: Record<string, { status: 'pass' | 'issues' | 'incomplete' | 'not_applicable'; details?: string }>;
  findings: QualityFinding[];
  previewFrames: QualityPreviewFrame[];
  beatAlignment?: { targets: number; toleranceMs: number; measured: number; deviations: number };
  improvement?: { iteration: number; maxIterations: number; previousReportId?: string; appliedTransactions: string[]; rolledBackIterations?: number };
}

export interface QualityAnalysisOptions {
  outputDirectory: string;
  selectedBeatTargets?: Rational[];
  beatToleranceMs?: number;
  maxAutomaticGapSeconds?: number;
  renderAudio?: boolean;
}

const MAX_PREVIEW_FRAMES = 12;
const AUDIO_SAMPLE_LIMIT = 24;

export async function analyzeProjectQuality(project: Project, options: QualityAnalysisOptions): Promise<QualityReport> {
  const reportId = randomUUID();
  await fs.mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  const duration = timelineDuration(project);
  const findings: QualityFinding[] = [];
  const checks: QualityReport['checks'] = {
    projectStructure: { status: 'pass' }, timelineCoverage: { status: 'pass' }, sourceBounds: { status: 'pass' },
    transitions: { status: 'pass' }, effectsAndKeyframes: { status: 'pass' }, previewFrames: { status: 'incomplete' },
    audioLevels: { status: 'not_applicable', details: 'No enabled audio clips are present.' },
    audioTransitions: { status: 'not_applicable', details: 'No enabled audio clips are present.' }, beatAlignment: { status: options.selectedBeatTargets?.length ? 'incomplete' : 'not_applicable' }
  };
  const finding = (item: Omit<QualityFinding, 'id'>) => findings.push({ id: randomUUID(), ...item });

  try { validateProject(project); }
  catch (error) {
    checks.projectStructure = { status: 'issues', details: error instanceof Error ? error.message : String(error) };
    finding({ code: 'invalid_project', category: 'structure', severity: 'critical', evidence: 'objective', title: 'Project validation failed', description: checks.projectStructure.details! });
  }

  const videoTracks = project.tracks.filter((track) => track.kind === 'video' && isTrackEnabled(project, track));
  const visibleVideoClips = videoTracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).filter(({ clip }) => project.media.some((media) => media.id === clip.mediaId && media.kind === 'video'));
  if (compare(duration, rational(0)) <= 0 || visibleVideoClips.length === 0) {
    checks.timelineCoverage = { status: 'issues', details: 'The project has no visible video content.' };
    finding({ code: 'empty_video_timeline', category: 'structure', severity: 'critical', evidence: 'objective', title: 'No visible video content', description: 'The timeline has no enabled video clip to render.' });
  }

  const videoEnd = duration;
  const intervals = visibleVideoClips.map(({ clip }) => ({ start: clip.start, end: add(clip.start, clip.duration) })).sort((a, b) => compare(a.start, b.start));
  const merged: Array<{ start: Rational; end: Rational }> = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (!last || compare(interval.start, last.end) > 0) merged.push({ ...interval });
    else if (compare(interval.end, last.end) > 0) last.end = interval.end;
  }
  let cursor = rational(0);
  const uncovered: Array<{ start: Rational; end: Rational }> = [];
  for (const interval of merged) {
    if (compare(interval.start, cursor) > 0) uncovered.push({ start: cursor, end: interval.start });
    if (compare(interval.end, cursor) > 0) cursor = interval.end;
  }
  if (compare(videoEnd, cursor) > 0) uncovered.push({ start: cursor, end: videoEnd });
  let gapCount = 0;
  for (const gap of uncovered) {
    if (compare(gap.start, gap.end) >= 0) continue;
    gapCount++;
    const gapSeconds = seconds(sub(gap.end, gap.start));
    const sameTrackPair = videoTracks.flatMap((track) => {
      const sorted = [...track.clips].filter((clip) => project.media.some((media) => media.id === clip.mediaId && media.kind === 'video')).sort((a, b) => compare(a.start, b.start));
      return sorted.slice(0, -1).flatMap((previous, index) => {
        const next = sorted[index + 1];
        return compare(add(previous.start, previous.duration), gap.start) === 0 && compare(next.start, gap.end) === 0 ? [{ previous, next }] : [];
      });
    })[0];
    const safeMax = options.maxAutomaticGapSeconds ?? 0.5;
    const safe = sameTrackPair !== undefined && gapSeconds <= safeMax;
    finding({
      code: 'video_gap', category: 'video', severity: gapSeconds > safeMax ? 'critical' : 'warning', evidence: 'objective',
      title: 'Uncovered video interval', description: `No enabled video track covers this ${gapSeconds.toFixed(3)} second interval; the rendered background will be black.`,
      start: gap.start, end: gap.end, clipIds: sameTrackPair ? [sameTrackPair.previous.id, sameTrackPair.next.id] : undefined,
      measurements: { durationSeconds: gapSeconds },
      correction: safe && sameTrackPair ? { tool: 'timeline_move_clip', arguments: { clipId: sameTrackPair.next.id, start: decimal(gap.start, 9) }, automaticallySafe: true } : undefined
    });
  }
  checks.timelineCoverage = gapCount ? { status: 'issues', details: `${gapCount} uncovered video interval(s) found.` } : visibleVideoClips.length ? { status: 'pass' } : checks.timelineCoverage;

  let sourceRangeProblems = 0;
  let effectProblems = 0;
  let transitionProblems = 0;
  for (const track of project.tracks) for (const clip of track.clips) {
    const media = project.media.find((item) => item.id === clip.mediaId);
    if (media && compare(add(clip.sourceIn, clipSourceDuration(clip)), media.duration) > 0) {
      sourceRangeProblems++;
      finding({ code: 'source_range_exceeded', category: 'structure', severity: 'critical', evidence: 'objective', title: 'Clip extends beyond source media', description: `Clip ${clip.id} requests source time beyond ${media.name}.`, start: clip.start, end: add(clip.start, clip.duration), clipIds: [clip.id], correction: { tool: 'timeline_trim_clip', arguments: { clipId: clip.id, duration: decimal(sub(media.duration, clip.sourceIn), 9) } } });
    }
    if (clip.transitionIn && track.kind !== 'video') {
      transitionProblems++;
      finding({ code: 'transition_wrong_track', category: 'effects', severity: 'warning', evidence: 'objective', title: 'Video transition is attached to an audio track', description: 'Clip transitions are only meaningful on video tracks.', start: clip.start, clipIds: [clip.id], correction: { tool: 'effect_remove', arguments: { clipId: clip.id, fields: ['transitionIn'] } } });
    } else if (clip.transitionIn) {
      transitionProblems++;
      finding({ code: 'transition_not_rendered', category: 'effects', severity: 'warning', evidence: 'objective', title: 'Transition configuration is not rendered', description: `The project stores a ${clip.transitionIn.type} transition, but the current shared preview/export compositor does not apply transitionIn.`, start: clip.start, end: add(clip.start, clip.transitionIn.duration), clipIds: [clip.id], correction: { tool: 'effect_remove', arguments: { clipId: clip.id, fields: ['transitionIn'] } } });
    }
    const invalidKeyframe = clip.keyframes?.find((keyframe) => compare(keyframe.time, clip.duration) > 0 || Number(keyframe.time.den) <= 0 || !Number.isFinite(keyframe.value));
    const invalidSpeedPoint = clip.speedKeyframes?.find((keyframe) => compare(keyframe.time, clip.duration) > 0 || Number(keyframe.time.den) <= 0 || Number(keyframe.rate.den) <= 0);
    if (invalidKeyframe || invalidSpeedPoint) {
      effectProblems++;
      finding({ code: 'invalid_effect_keyframe', category: 'effects', severity: 'critical', evidence: 'objective', title: 'Invalid effect keyframe configuration', description: `Clip ${clip.id} contains a keyframe outside its clip or with invalid values.`, start: clip.start, clipIds: [clip.id] });
    }
  }
  checks.sourceBounds = sourceRangeProblems ? { status: 'issues', details: `${sourceRangeProblems} source range violation(s) found.` } : { status: 'pass' };
  checks.transitions = transitionProblems ? { status: 'issues', details: `${transitionProblems} unsupported or misplaced transition(s) found.` } : { status: 'pass' };
  checks.effectsAndKeyframes = effectProblems ? { status: 'issues', details: `${effectProblems} invalid keyframe configuration(s) found.` } : { status: 'pass' };

  const targets = options.selectedBeatTargets ?? [];
  const toleranceMs = options.beatToleranceMs ?? 80;
  let measured = 0;
  let deviations = 0;
  if (targets.length) {
    const cuts = [...new Map(visibleVideoClips.map(({ clip }) => [
      `${clip.start.num}/${clip.start.den}`, clip.start
    ])).values()].filter((time) => compare(time, rational(0)) > 0);
    for (const target of targets) {
      if (!cuts.length) break;
      const nearest = cuts.reduce((best, cut) => compare(abs(sub(cut, target)), abs(sub(best, target))) < 0 ? cut : best);
      const error = abs(sub(nearest, target)); measured++;
      if (compare(error, parseDecimal((toleranceMs / 1000).toString())) > 0) {
        deviations++;
        finding({ code: 'beat_alignment_deviation', category: 'timing', severity: 'warning', evidence: 'objective', title: 'Selected beat has no nearby edit', description: `The nearest video cut is ${decimal(error, 6)} seconds from the selected beat.`, start: target, end: nearest, measurements: { deviationSeconds: seconds(error), toleranceMs }, correction: { tool: 'timeline_move_clip', arguments: { clipId: visibleVideoClips.find(({ clip }) => compare(clip.start, nearest) === 0)?.clip.id, start: decimal(target, 9) } } });
      }
    }
    checks.beatAlignment = deviations ? { status: 'issues', details: `${deviations} of ${measured} selected beat targets exceed ${toleranceMs} ms.` } : { status: 'pass', details: `All ${measured} selected beat target(s) are within tolerance.` };
  }

  const previewFrames: QualityPreviewFrame[] = [];
  const sampleTimes = choosePreviewTimes(project, visibleVideoClips.map(({ clip }) => clip), uncovered, MAX_PREVIEW_FRAMES);
  for (let index = 0; index < sampleTimes.length; index++) {
    const time = sampleTimes[index];
    const output = path.join(options.outputDirectory, `frame-${String(index + 1).padStart(2, '0')}.png`);
    const activeClipIds = visibleVideoClips.filter(({ clip }) => compare(time, clip.start) >= 0 && compare(time, add(clip.start, clip.duration)) < 0).map(({ clip }) => clip.id);
    try {
      await renderTimelineFrame(project, time, output, true);
      await fs.chmod(output, 0o600).catch(() => undefined);
      const result = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-i', output, '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']);
      const text = `${result.stdout}\n${result.stderr}`;
      const statistics: Record<string, number> = {};
      for (const key of ['YAVG', 'YMIN', 'YMAX', 'UAVG', 'VAVG']) {
        const match = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(text);
        if (match) statistics[key.toLowerCase()] = Number(match[1]);
      }
      // FFmpeg signalstats reports limited-range black as luma 16 for PNG/BT.709.
      const blackLike = (statistics.yavg ?? 255) <= 18 && (statistics.ymax ?? 255) <= 22;
      const preview = { time, frame: Math.max(0, toFrame(time, project.frameRate)), path: output, mimeType: 'image/png' as const, activeClipIds, statistics, blackLike };
      previewFrames.push(preview);
      if (blackLike && activeClipIds.length) finding({ code: 'black_like_frame', category: 'video', severity: 'warning', evidence: 'heuristic', title: 'Near-black frame inside a video clip', description: 'Signal statistics indicate an almost black rendered frame while a video clip is active. The source may intentionally contain darkness; inspect the attached frame before changing the edit.', start: time, clipIds: activeClipIds, measurements: statistics });
    } catch (error) {
      checks.previewFrames = { status: 'incomplete', details: error instanceof Error ? error.message : String(error) };
      break;
    }
  }
  if (!sampleTimes.length) checks.previewFrames = { status: 'not_applicable', details: 'There is no video timeline from which to select preview frames.' };
  else if (previewFrames.length === sampleTimes.length) checks.previewFrames = { status: 'pass', details: `${previewFrames.length} representative frame(s) rendered and inspected.` };

  const enabledAudioClips = project.tracks.filter((track) => isTrackEnabled(project, track)).flatMap((track) => track.clips.map((clip) => ({ track, clip, media: project.media.find((asset) => asset.id === clip.mediaId) }))).filter((item) => item.clip.audioEnabled && item.media?.hasAudio);
  if (enabledAudioClips.length && options.renderAudio !== false && compare(duration, rational(0)) > 0) {
    const renderPath = path.join(options.outputDirectory, 'audio-analysis-render.mp4');
    try {
      await exportVideo(project, { outputPath: renderPath });
      await fs.chmod(renderPath, 0o600).catch(() => undefined);
      const silence = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-i', renderPath, '-af', 'silencedetect=noise=-55dB:d=0.5,volumedetect,astats=metadata=0:reset=0', '-f', 'null', '-']);
      const text = `${silence.stdout}\n${silence.stderr}`;
      const maxVolume = /max_volume:\s*(-?inf|-?[0-9.]+) dB/i.exec(text)?.[1];
      const rmsVolume = /RMS level dB:\s*(-?inf|-?[0-9.]+)/i.exec(text)?.[1];
      const silenceRanges = parseSilenceRanges(text, seconds(duration));
      const levelMeasurements: Record<string, string | number | boolean | null> = { maxVolumeDb: maxVolume ? Number(maxVolume) : null, rmsLevelDb: rmsVolume ? Number(rmsVolume) : null, detectedSilenceRanges: silenceRanges.length };
      if (maxVolume && maxVolume !== '-inf' && Number(maxVolume) >= -0.1) finding({ code: 'audio_clipping_risk', category: 'audio', severity: 'warning', evidence: 'objective', title: 'Audio peak is at the clipping threshold', description: 'The rendered mix reaches within 0.1 dB of full scale. Check the loudest sections for audible distortion.', measurements: levelMeasurements });
      if (silenceRanges.some((range) => range.duration >= 0.5)) {
        for (const range of silenceRanges.filter((item) => item.duration >= 0.5).slice(0, 20)) finding({ code: 'sustained_audio_silence', category: 'audio', severity: 'warning', evidence: 'heuristic', title: 'Sustained near-silence detected', description: 'The rendered mix stayed below -55 dB for at least 0.5 seconds. This may be intentional; review the section before editing.', start: parseDecimal(range.start.toFixed(3)), end: parseDecimal(range.end.toFixed(3)), measurements: { durationSeconds: range.duration, thresholdDb: -55 } });
      }
      checks.audioLevels = { status: findings.some((item) => item.code === 'audio_clipping_risk' || item.code === 'sustained_audio_silence') ? 'issues' : 'pass', details: `Rendered audio measured; max ${maxVolume ?? 'unavailable'} dB, RMS ${rmsVolume ?? 'unavailable'} dB.` };
      const transitionStats = await analyzeAudioTransitions(renderPath, enabledAudioClips, finding);
      checks.audioTransitions = transitionStats.candidates ? { status: transitionStats.warnings ? 'issues' : 'pass', details: `${transitionStats.warnings} of ${transitionStats.sampled} measured un-faded cut(s) have a large local level jump (${transitionStats.candidates} candidate cut(s) total).` } : { status: 'pass', details: 'No adjacent audio clips without edge fades were found.' };
      const sourceClipping = await analyzeSourcePeaks(enabledAudioClips, finding);
      if (sourceClipping) checks.audioLevels = { status: 'issues', details: `${checks.audioLevels.details ?? ''} ${sourceClipping} source segment(s) peak within 0.1 dB of full scale before the final mix limiter.` };
      checks.audioLevels.details += ` ${silenceRanges.length} near-silence interval(s) measured.`;
    } catch (error) {
      checks.audioLevels = { status: 'incomplete', details: error instanceof Error ? error.message : String(error) };
      checks.audioTransitions = { status: 'incomplete', details: 'Could not render the timeline audio for analysis.' };
      finding({ code: 'audio_analysis_incomplete', category: 'audio', severity: 'info', evidence: 'objective', title: 'Rendered audio analysis incomplete', description: error instanceof Error ? error.message : String(error) });
    } finally { await fs.rm(renderPath, { force: true }).catch(() => undefined); }
  }

  const objective = findings.filter((item) => item.evidence === 'objective' && item.severity !== 'info');
  const incomplete = Object.values(checks).some((item) => item.status === 'incomplete');
  const hasIssues = findings.some((item) => item.severity === 'critical' || item.severity === 'warning');
  return {
    schemaVersion: 1, reportId, createdAt: new Date().toISOString(), projectId: project.id, projectUpdatedAt: project.updatedAt,
    duration, frameRate: project.frameRate,
    timeline: project.tracks.map((track) => ({
      trackId: track.id, trackName: track.name, trackKind: track.kind, enabled: isTrackEnabled(project, track),
      clips: [...track.clips].sort((a, b) => compare(a.start, b.start)).map((clip) => ({ clipId: clip.id, mediaId: clip.mediaId, start: clip.start, end: add(clip.start, clip.duration), duration: clip.duration, sourceIn: clip.sourceIn, sourceEnd: add(clip.sourceIn, clipSourceDuration(clip)), audioEnabled: clip.audioEnabled, ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {}), effectKeyframeCount: clip.keyframes?.length ?? 0, speedKeyframeCount: clip.speedKeyframes?.length ?? 0 }))
    })),
    summary: { status: incomplete ? 'incomplete' : hasIssues ? 'issues' : 'pass', objectiveChecks: incomplete ? 'incomplete' : objective.length ? 'issues' : 'pass', findings: findings.length, critical: findings.filter((item) => item.severity === 'critical').length, warnings: findings.filter((item) => item.severity === 'warning').length, info: findings.filter((item) => item.severity === 'info').length, previewFrames: previewFrames.length, subjectiveAssessment: 'not_performed' },
    checks, findings, previewFrames,
    ...(targets.length ? { beatAlignment: { targets: targets.length, toleranceMs, measured, deviations } } : {})
  };
}

export async function persistQualityReport(directory: string, report: QualityReport): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${report.reportId}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await fs.rename(temporary, file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') { await fs.rm(temporary, { force: true }); throw error; }
    try { await fs.copyFile(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  }
  return file;
}

function choosePreviewTimes(project: Project, clips: TimelineClip[], gaps: Array<{ start: Rational; end: Rational }>, limit: number): Rational[] {
  const candidates: Rational[] = [];
  for (const clip of clips) {
    const middle = add(clip.start, rational(BigInt(clip.duration.num), BigInt(clip.duration.den) * 2n));
    candidates.push(clip.start, middle);
  }
  for (const gap of gaps) candidates.push(add(gap.start, rational(BigInt(sub(gap.end, gap.start).num), BigInt(sub(gap.end, gap.start).den) * 2n)));
  if (compare(timelineDuration(project), rational(0)) > 0) candidates.push(sub(timelineDuration(project), frameTime(1, project.frameRate)));
  const unique = [...new Map(candidates.filter((time) => compare(time, rational(0)) >= 0 && compare(time, timelineDuration(project)) < 0).map((time) => [`${time.num}/${time.den}`, time])).values()].sort(compare);
  if (unique.length <= limit) return unique;
  return Array.from({ length: limit }, (_unused, index) => unique[Math.round(index * (unique.length - 1) / (limit - 1))]);
}

async function analyzeAudioTransitions(renderPath: string, clips: Array<{ track: TimelineTrack; clip: TimelineClip; media: Project['media'][number] | undefined }>, finding: (item: Omit<QualityFinding, 'id'>) => void): Promise<{ candidates: number; sampled: number; warnings: number }> {
  const candidates: Array<{ previous: TimelineClip; next: TimelineClip; boundary: Rational }> = [];
  const tracks = new Map<string, TimelineClip[]>();
  for (const item of clips) tracks.set(item.track.id, [...(tracks.get(item.track.id) ?? []), item.clip]);
  for (const trackClips of tracks.values()) {
    const sorted = trackClips.sort((a, b) => compare(a.start, b.start));
    for (let index = 0; index < sorted.length - 1; index++) {
      const previous = sorted[index], next = sorted[index + 1];
      const previousEnd = add(previous.start, previous.duration);
      if (compare(previousEnd, next.start) !== 0 || compare(previous.fadeOut ?? rational(0), rational(0)) > 0 || compare(next.fadeIn ?? rational(0), rational(0)) > 0) continue;
      candidates.push({ previous, next, boundary: next.start });
    }
  }
  let warnings = 0;
  for (const candidate of candidates.slice(0, AUDIO_SAMPLE_LIMIT)) {
    const boundary = seconds(candidate.boundary);
    const before = await measureWindowLevel(renderPath, Math.max(0, boundary - 0.12));
    const after = await measureWindowLevel(renderPath, boundary + 0.005);
    if (before === null || after === null || Math.abs(before - after) < 18) continue;
    warnings++;
    finding({ code: 'abrupt_audio_transition', category: 'audio', severity: 'warning', evidence: 'heuristic', title: 'Large audio level change at an unfaded cut', description: 'The rendered mix changes by at least 18 dB across this edit. This may be intentional, but can sound abrupt; listen before applying the suggested short edge fades.', start: candidate.boundary, clipIds: [candidate.previous.id, candidate.next.id], measurements: { beforeMeanDb: before, afterMeanDb: after, differenceDb: Math.abs(before - after), measurementWindowMs: 100 }, correction: { tool: 'project_transaction', arguments: { operations: [ { name: 'timeline_set_clip_audio', arguments: { clipId: candidate.previous.id, settings: { fadeOut: '0.03' } } }, { name: 'timeline_set_clip_audio', arguments: { clipId: candidate.next.id, settings: { fadeIn: '0.03' } } } ] } } });
  }
  return { candidates: candidates.length, sampled: Math.min(candidates.length, AUDIO_SAMPLE_LIMIT), warnings };
}

async function measureWindowLevel(renderPath: string, start: number): Promise<number | null> {
  const result = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-ss', start.toFixed(3), '-t', '0.1', '-i', renderPath, '-af', 'volumedetect', '-f', 'null', '-']);
  const text = `${result.stdout}\n${result.stderr}`;
  const value = /mean_volume:\s*(-?inf|-?[0-9.]+) dB/i.exec(text)?.[1];
  return !value || value === '-inf' ? null : Number(value);
}

async function analyzeSourcePeaks(clips: Array<{ track: TimelineTrack; clip: TimelineClip; media: Project['media'][number] | undefined }>, finding: (item: Omit<QualityFinding, 'id'>) => void): Promise<number> {
  const sampled = clips.slice(0, AUDIO_SAMPLE_LIMIT);
  let clipped = 0;
  for (const { clip, media } of sampled) {
    if (!media) continue;
    const sourceDuration = clipSourceDuration(clip);
    const result = await runCommand('ffmpeg', ['-nostdin', '-hide_banner', '-ss', decimal(clip.sourceIn, 9), '-t', decimal(sourceDuration, 9), '-i', media.path, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
    const text = `${result.stdout}\n${result.stderr}`;
    const peak = /max_volume:\s*(-?inf|-?[0-9.]+) dB/i.exec(text)?.[1];
    if (!peak || peak === '-inf' || Number(peak) < -0.1) continue;
    clipped++;
    finding({ code: 'source_audio_clipping_risk', category: 'audio', severity: 'warning', evidence: 'objective', title: 'Source audio peaks at the clipping threshold', description: 'This clip source reaches within 0.1 dB of full scale before the final mix limiter; an upstream recording or encode may already be distorted.', start: clip.start, end: add(clip.start, clip.duration), clipIds: [clip.id], measurements: { sourceMaxVolumeDb: Number(peak), mediaId: media.id } });
  }
  return clipped;
}

function abs(time: Rational): Rational { return BigInt(time.num) < 0n ? rational(-BigInt(time.num), time.den) : time; }

function parseSilenceRanges(text: string, totalDuration: number): Array<{ start: number; end: number; duration: number }> {
  const events: Array<{ index: number; kind: 'start' | 'end'; time: number; duration?: number }> = [];
  for (const match of text.matchAll(/silence_start:\s*([0-9.]+)/g)) events.push({ index: match.index ?? 0, kind: 'start', time: Number(match[1]) });
  for (const match of text.matchAll(/silence_end:\s*([0-9.]+)(?:\s*\|\s*silence_duration:\s*([0-9.]+))?/g)) events.push({ index: match.index ?? 0, kind: 'end', time: Number(match[1]), ...(match[2] !== undefined ? { duration: Number(match[2]) } : {}) });
  events.sort((a, b) => a.index - b.index);
  const ranges: Array<{ start: number; end: number; duration: number }> = [];
  let start: number | undefined;
  for (const event of events) {
    if (event.kind === 'start') start = event.time;
    else if (start !== undefined && event.time >= start) {
      ranges.push({ start, end: event.time, duration: event.duration ?? event.time - start });
      start = undefined;
    }
  }
  if (start !== undefined && totalDuration >= start) ranges.push({ start, end: totalDuration, duration: totalDuration - start });
  return ranges;
}
