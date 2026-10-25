import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeAudio } from './audioAnalysis';
import { analyzeHighlightCues, detectSceneCutTimes, inspectValorantHudEvent, readCachedHighlightAnalysis } from './highlightAnalysis';
import { clipSourceDuration, clipSourceOffsetAt } from './clipEffects';
import { newId } from './ids';
import { newTrack, projectCachePath, saveProject, timelineDuration, validateProject, loadProject } from './project';
import { add, compare, frameTime, parseDecimal, rational, seconds } from './time';
import { createExternalProcessMetrics, withExternalProcessMetrics, type ExternalProcessMetrics } from './processMetrics';
import type { AnalysisEvent, AudioAnalysis, AutoMontageAnalysisInput, AutoMontageCustomRules, AutoMontageFormat, AutoMontageOptions, AutoMontagePlan, AutoMontageRangePolicy, AutoMontageSelectionMode, AutoMontageSegment, AutoMontageStyle, GeneratedAutoMontages, GeneratedAutoMontageVariant, HighlightAnalysis, MediaAsset, Project, Rational, TimelineClip } from './types';
import { AppError } from './errors';
import { inferGameplayGame } from './gameplay/valorant';

interface Preset {
  targetShotSeconds: number;
  minShotSeconds: number;
  maxShotSeconds: number;
  leadSeconds: number;
  tailSeconds: number;
  cutRatio: number;
  videoAudioVolume: number;
  musicVolume: number;
  fadeSeconds: number;
  anchorPreference: Record<AutoMontageSegment['anchorKind'], number>;
}

const PRESETS: Record<AutoMontageStyle, Preset> = {
  clean: {
    targetShotSeconds: 4.2, minShotSeconds: 2.4, maxShotSeconds: 7.4, leadSeconds: 1.2, tailSeconds: 1.1, cutRatio: 0.48,
    videoAudioVolume: 0.28, musicVolume: 0.92, fadeSeconds: 0.12,
    anchorPreference: { drop: 1, accent: 0.92, downbeat: 0.95, beat: 0.62, onset: 0.25, paced: 0.05 }
  },
  aggressive: {
    targetShotSeconds: 1.9, minShotSeconds: 0.8, maxShotSeconds: 3.5, leadSeconds: 0.65, tailSeconds: 0.6, cutRatio: 0.5,
    videoAudioVolume: 0.2, musicVolume: 1, fadeSeconds: 0.04,
    anchorPreference: { drop: 1, accent: 0.98, downbeat: 0.85, beat: 0.8, onset: 0.62, paced: 0.05 }
  },
  cinematic: {
    targetShotSeconds: 5.8, minShotSeconds: 3.2, maxShotSeconds: 9.5, leadSeconds: 2, tailSeconds: 1.8, cutRatio: 0.43,
    videoAudioVolume: 0.3, musicVolume: 0.86, fadeSeconds: 0.34,
    anchorPreference: { drop: 1, accent: 0.94, downbeat: 0.95, beat: 0.48, onset: 0.2, paced: 0.05 }
  },
  smooth: {
    targetShotSeconds: 4.8, minShotSeconds: 3, maxShotSeconds: 7.2, leadSeconds: 1.6, tailSeconds: 1.4, cutRatio: 0.46,
    videoAudioVolume: 0.28, musicVolume: 0.9, fadeSeconds: 0.24,
    anchorPreference: { drop: 0.82, accent: 0.88, downbeat: 1, beat: 0.56, onset: 0.18, paced: 0.08 }
  },
  velocity: {
    targetShotSeconds: 2.8, minShotSeconds: 1.1, maxShotSeconds: 5.2, leadSeconds: 0.95, tailSeconds: 0.9, cutRatio: 0.5,
    videoAudioVolume: 0.2, musicVolume: 1, fadeSeconds: 0.06,
    anchorPreference: { drop: 1, accent: 0.96, downbeat: 0.88, beat: 0.78, onset: 0.58, paced: 0.05 }
  },
  custom: {
    targetShotSeconds: 3.5, minShotSeconds: 1.2, maxShotSeconds: 7, leadSeconds: 1, tailSeconds: 1, cutRatio: 0.5,
    videoAudioVolume: 0.25, musicVolume: 0.95, fadeSeconds: 0.1,
    anchorPreference: { drop: 1, accent: 0.9, downbeat: 0.9, beat: 0.68, onset: 0.4, paced: 0.05 }
  }
};

interface MusicAnchor {
  time: number;
  kind: AutoMontageSegment['anchorKind'];
  strength: number;
}

interface EventCandidate {
  asset: MediaAsset;
  event: AnalysisEvent;
  start: number;
  decisive: number;
  end: number;
  reviewStatus?: 'accepted' | 'corrected';
  eventType?: AnalysisEvent['eventType'];
  evidenceLevel: NonNullable<AnalysisEvent['evidenceLevel']>;
  uncertainties: string[];
  sourceRange?: { startSeconds: number; endSeconds: number; startText: string; endText: string; start: Rational; end: Rational; policy: AutoMontageRangePolicy };
  highlightScore: number;
  framingScore: number;
  eventLabel: string;
}

export function buildAutomaticMontagePlans(input: AutoMontageAnalysisInput): AutoMontagePlan[] {
  const { project, musicAnalysis } = input;
  const requestedOptions = input.options;
  validateOptions(requestedOptions);
  const music = project.media.find((asset) => asset.id === requestedOptions.musicMediaId);
  if (!music || !music.hasAudio) throw new AppError('MUSIC_ASSET_REQUIRED', 'Choose an imported audio asset with an audio stream for the montage music.');
  const musicDuration = seconds(music.duration);
  const options = { ...requestedOptions, durationSeconds: requestedOptions.durationSeconds ?? Math.min(musicDuration, 1800) };
  const fps = Number(project.frameRate.num) / Number(project.frameRate.den);
  const durationFrames = Math.round(options.durationSeconds * fps);
  const durationSeconds = seconds(frameTime(durationFrames, project.frameRate));
  if (durationFrames < 1 || durationSeconds > musicDuration + (1 / fps)) throw new AppError('MUSIC_TOO_SHORT', `The music is ${musicDuration.toFixed(2)} seconds long; the requested montage is ${durationSeconds.toFixed(2)} seconds. Shorten the montage or choose longer music.`);

  const referenceAsset = options.referenceMediaId ? project.media.find((asset) => asset.id === options.referenceMediaId) : undefined;
  if (options.referenceMediaId && (!referenceAsset || referenceAsset.kind !== 'video')) throw new AppError('REFERENCE_VIDEO_REQUIRED', 'Choose an imported video asset as the local edit-style reference.');
  const selectionMode = selectionModeFor(options);
  const ranges = resolveSourceRanges(project, options, selectionMode);
  const selectedIds = selectionMode === 'library' ? null : new Set(options.videoMediaIds?.length ? options.videoMediaIds : ranges.map((range) => range.mediaId));
  const requestedVideos = project.media.filter((asset) => asset.kind === 'video' && (!selectedIds || selectedIds.has(asset.id)));
  if (selectedIds && requestedVideos.length !== selectedIds.size) throw new AppError('VIDEO_ASSET_NOT_FOUND', 'One or more selected video assets are not part of the project.');
  const videos = requestedVideos.filter((asset) => asset.id !== referenceAsset?.id);
  if (!videos.length) throw new AppError('VIDEO_ASSET_REQUIRED', 'Import or select at least one video asset for the montage.');

  const analyses = new Map(input.highlightAnalyses.map((item) => [item.mediaId, item.analysis]));
  const referenceAnalysis = input.referenceAnalysis ?? (options.referenceMediaId ? analyses.get(options.referenceMediaId) : undefined);
  const referenceStyle = referenceAsset ? buildReferenceProfile(referenceAsset, referenceAnalysis, input.referenceCutTimesSeconds) : undefined;
  const eventCandidates = videos.flatMap((asset) => {
    const analysis = analyses.get(asset.id);
    if (!analysis) return [];
    return analysis.events.flatMap((event) => {
      const review = asset.analysisEventReviews?.find((item) => item.eventId === event.id);
      if (review?.status === 'rejected') return [];
      const eventType = review?.status === 'corrected' && review.correctedEventType ? review.correctedEventType : event.eventType;
      const reviewed = review?.status === 'accepted' || review?.status === 'corrected';
      const evidenceLevel = event.evidenceLevel ?? 'unknown';
      const genericTypes = ['quiet_passage', 'unknown', 'kill_feed_change', 'audio_activity', 'scene_change', 'text_recognition', 'clutch_situation'];
      const actionTypes = ['kill', 'headshot', 'multi_kill', 'ace', 'clutch'];
      const explicitGameplay = evidenceLevel === 'explicit' && event.kind === 'gameplay_event' && actionTypes.includes(eventType ?? '');
      const corroboratedActivity = isStrongCorroboratedGameplayActivity(event, eventType, evidenceLevel);
      if (!reviewed && !explicitGameplay && !corroboratedActivity) return [];
      if (!reviewed && genericTypes.includes(eventType ?? '')) return [];
      const nearbyStatusUi = !reviewed && corroboratedActivity && analysis.events.some((candidate) => {
        const statusType = candidate.eventType;
        const isExplicitStatus = candidate.evidenceLevel === 'explicit'
          && candidate.kind === 'gameplay_event'
          && (statusType === 'quiet_passage' || statusType === 'round_end')
          && candidate.detectors.some((detector) => detector.modality === 'text');
        return isExplicitStatus && Math.abs(candidate.decisiveSeconds - event.decisiveSeconds) <= 1.1;
      });
      if (nearbyStatusUi) return [];
      const rawStart = review?.status === 'corrected' ? review.startSeconds : event.startSeconds;
      const decisive = review?.status === 'corrected' ? review.decisiveSeconds : event.decisiveSeconds;
      const sourceRange = ranges.find((range) => range.mediaId === asset.id);
      if (selectionMode === 'ranges' && !sourceRange) return [];
      if (sourceRange && (decisive < sourceRange.startSeconds || decisive > sourceRange.endSeconds)) return [];
      const rawEnd = review?.status === 'corrected' ? review.endSeconds : event.endSeconds;
      const strictRange = sourceRange && (options.sourceRangePolicy ?? 'strict') === 'strict' ? sourceRange : undefined;
      const start = strictRange ? Math.max(rawStart, strictRange.startSeconds) : rawStart;
      const end = strictRange ? Math.min(rawEnd, strictRange.endSeconds) : rawEnd;
      if (![start, decisive, end].every(Number.isFinite) || start < 0 || start > decisive || decisive > end || end > seconds(asset.duration)) return [];
      const resolution = asset.width && asset.height ? asset.width * asset.height : 0;
      const targetPixels = targetDimensions(options.format, project).width * targetDimensions(options.format, project).height;
      const resolutionScore = resolution ? clamp(Math.sqrt(resolution / targetPixels), 0, 1) * 100 : 50;
      const sourceAspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
      const targetSize = targetDimensions(options.format, project);
      const targetAspect = targetSize.width / targetSize.height;
      const aspectScore = clamp(1 - Math.abs(Math.log(sourceAspect / targetAspect)) / Math.log(3), 0, 1) * 100;
      const framingScore = round(resolutionScore * 0.65 + aspectScore * 0.35);
      const rating = asset.rating && asset.rating > 0 ? (asset.rating / 5) * 100 : 50;
      const detectorKinds = new Set(event.detectors.map((detector) => detector.modality)).size;
      const reviewBonus = review?.status === 'corrected' ? 10 : review?.status === 'accepted' ? 6 : 0;
      const corroboration = Math.min(100, detectorKinds * 28);
      const evidenceScore = reviewed ? 100 : evidenceLevel === 'explicit' ? 100 : evidenceLevel === 'corroborated' ? 68 : evidenceLevel === 'heuristic' ? 22 : 0;
      const highlightScore = clamp(
        event.rankScore * 0.35 + event.confidence * 100 * 0.15 + event.interestingness * 100 * 0.1 + rating * 0.1 + corroboration * 0.07 + framingScore * 0.05 + evidenceScore * 0.18 + (asset.favorite ? 3 : 0) + reviewBonus,
        0, 100
      );
      const inferredGame = inferGameFromAsset(asset);
      const candidateAsset = !asset.game && inferredGame ? { ...asset, game: inferredGame } : asset;
      return [{ asset: candidateAsset, event, start, decisive, end, reviewStatus: reviewed ? review.status as 'accepted' | 'corrected' : undefined, eventType, evidenceLevel, uncertainties: [...(event.uncertainties ?? [])], ...(sourceRange ? { sourceRange: { ...sourceRange, policy: options.sourceRangePolicy ?? 'strict' } } : {}), highlightScore: round(highlightScore), framingScore, eventLabel: labelForEvent(event, eventType) }];
    });
  });
  if (!eventCandidates.length) throw new AppError('NO_HIGHLIGHTS_FOUND', 'No usable highlight events were found in the selected videos. Run highlight analysis, review its cues, or select videos that contain detected events. Rejected events are excluded.');

  const preset = getPreset(options.style, options.customRules);
  const intensity = options.intensity;
  let minShot = Math.max(0.55, preset.minShotSeconds * (1.4 - 0.62 * intensity));
  let maxShot = preset.maxShotSeconds * (1.38 - 0.58 * intensity);
  let targetShot = clamp(preset.targetShotSeconds * (1.3 - 0.6 * intensity), minShot, maxShot);
  if (referenceStyle) {
    const paceMultiplier = 1.3 - 0.6 * intensity;
    targetShot = referenceStyle.medianShotSeconds * paceMultiplier;
    minShot = Math.min(targetShot, Math.max(0.55, targetShot * 0.55));
    maxShot = Math.max(targetShot, Math.min(maxShot, Math.max(targetShot * 1.55, referenceStyle.p75ShotSeconds * paceMultiplier * 1.25)));
    targetShot = clamp(targetShot, minShot, maxShot);
  }
  const sourceUsageAcrossVariants = new Map<string, number>();
  const eventUsageAcrossVariants = new Set<string>();
  const plans: AutoMontagePlan[] = [];

  for (let variant = 1; variant <= options.variants; variant++) {
    const warnings = new Set<string>();
    const anchors = chooseMusicAnchors(musicAnalysis, durationSeconds, project.frameRate, preset, targetShot, minShot, maxShot, variant, intensity, referenceStyle?.shotDurationsSeconds);
    if (anchors.some((anchor) => anchor.kind === 'paced')) warnings.add('Some scene anchors use even pacing because no suitable beat, downbeat, onset, or drop was available nearby.');
    const planned = placeEvents(anchors, eventCandidates, durationFrames, project, preset, options, variant, sourceUsageAcrossVariants, eventUsageAcrossVariants, targetShot, minShot, maxShot, warnings);
    for (const segment of planned) {
      sourceUsageAcrossVariants.set(segment.mediaId, (sourceUsageAcrossVariants.get(segment.mediaId) ?? 0) + 1);
      eventUsageAcrossVariants.add(`${segment.mediaId}:${segment.eventId}`);
    }
    const scoreBreakdown = scorePlan(planned, durationSeconds, targetShot, fps);
    const score = round(scoreBreakdown.highlightQuality * 0.3 + scoreBreakdown.gameplayEvidence * 0.2 + scoreBreakdown.musicAlignment * 0.25 + scoreBreakdown.sceneDiversity * 0.1 + scoreBreakdown.pacing * 0.1 + scoreBreakdown.framing * 0.025 + scoreBreakdown.duration * 0.025);
    const variantWarnings = [...warnings];
    if (planned.some((segment) => segment.evidenceLevel === 'corroborated' && !segment.reviewStatus)) variantWarnings.push('Corroborated combat/activity cues are not verified kills; review them before presenting as specific gameplay events.');
    if (options.referenceMediaId && !referenceStyle) variantWarnings.push('The local style reference had fewer than three reliable scene cuts; the selected preset pacing was used instead.');
    if (planned.some((segment) => segment.effectPlan.impactZoom || segment.effectPlan.speedKeyframes?.length)) variantWarnings.push('Selective punch-ins and speed ramps require explicit high-impact or high-scoring corroborated activity at strong musical anchors; cuts remain hard cuts to preserve beat timing.');
    plans.push({
      schemaVersion: 1,
      method: 'ranked-highlight-beat-planner-v2',
      createdAt: new Date().toISOString(),
      sourceProjectId: project.id,
      variant,
      style: options.style,
      durationSeconds,
      durationFrames,
      format: options.format,
      intensity,
      ...(options.customRules ? { customRules: structuredClone(options.customRules) } : {}),
      music: { mediaId: music.id, name: music.name, contentHash: music.contentHash, estimatedBpm: musicAnalysis.estimatedBpm, analysisMethod: musicAnalysis.method },
      selection: { mode: selectionMode, videoCount: selectedIds?.size ?? requestedVideos.length, ...(selectionMode === 'ranges' ? { rangePolicy: options.sourceRangePolicy ?? 'strict' } : {}) },
      score,
      scoreBreakdown,
      ...(referenceStyle ? { referenceStyle } : {}),
      segments: planned,
      warnings: variantWarnings
    });
  }
  return plans;
}

export function materializeAutomaticMontageProject(source: Project, plan: AutoMontagePlan): Project {
  const music = source.media.find((asset) => asset.id === plan.music.mediaId);
  if (!music || !music.hasAudio) throw new AppError('MUSIC_ASSET_REQUIRED', 'The plan music asset is missing or has no audio stream.');
  const segmentAssets = new Set(plan.segments.map((segment) => segment.mediaId));
  const requiredAssets = new Set([...segmentAssets, music.id]);
  const media = source.media.filter((asset) => requiredAssets.has(asset.id)).map((asset) => structuredClone(asset));
  const size = targetDimensions(plan.format, source);
  const timestamp = new Date().toISOString();
  const project: Project = {
    ...structuredClone(source),
    id: newId(),
    name: `${source.name} — ${styleLabel(plan.style)} ${String(plan.variant).padStart(2, '0')}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    width: size.width,
    height: size.height,
    media,
    tracks: [newTrack('V1', 'video'), newTrack('A1', 'audio')]
  };
  const videoTrack = project.tracks[0];
  const audioTrack = project.tracks[1];
  const preset = getPreset(plan.style, plan.customRules);
  for (const segment of plan.segments) {
    const asset = media.find((item) => item.id === segment.mediaId)!;
    const start = frameTime(segment.timelineStartFrame, project.frameRate);
    const duration = frameTime(segment.durationFrames, project.frameRate);
    const sourceIn = parseDecimal(segment.sourceInSeconds.toFixed(9));
    const fade = fadeFor(preset.fadeSeconds, duration, project.frameRate);
    const clip: TimelineClip = {
      id: newId(), mediaId: asset.id, start, sourceIn, duration,
      audioEnabled: asset.hasAudio, volume: preset.videoAudioVolume,
      ...(segment.effectPlan.speedKeyframes?.length ? { speedKeyframes: segment.effectPlan.speedKeyframes.map((point) => ({ time: parseDecimal(point.timeSeconds.toFixed(9)), rate: parseDecimal(point.rate.toFixed(9)) })) } : {}),
      transform: { scale: segment.effectPlan.cropScale * (segment.effectPlan.impactZoom ? 1.04 : 1), x: 0, y: 0, rotationDegrees: 0 },
      ...(fade.num === '0' ? {} : { fadeIn: fade, fadeOut: fade })
    };
    videoTrack.clips.push(clip);
  }
  const targetDuration = frameTime(plan.durationFrames, project.frameRate);
  const musicDuration = compare(music.duration, targetDuration) < 0 ? music.duration : targetDuration;
  const musicFade = fadeFor(Math.min(preset.fadeSeconds * 3, 0.8), musicDuration, project.frameRate);
  audioTrack.clips.push({
    id: newId(), mediaId: music.id, start: rational(0), sourceIn: rational(0), duration: musicDuration,
    audioEnabled: true, volume: preset.musicVolume,
    ...(musicFade.num === '0' ? {} : { fadeIn: musicFade, fadeOut: musicFade })
  });
  for (const track of project.tracks) track.clips.sort((a, b) => compare(a.start, b.start));
  validateProject(project);
  if (compare(timelineDuration(project), targetDuration) !== 0) throw new AppError('MONTAGE_DURATION_MISMATCH', 'Generated timeline does not match its requested frame duration.');
  return project;
}

export function generateAutomaticMontages(projectFile: string, outputDirectory: string, requestedOptions: AutoMontageOptions): Promise<GeneratedAutoMontages> {
  const externalProcesses = createExternalProcessMetrics();
  return withExternalProcessMetrics(externalProcesses, () => generateAutomaticMontagesMeasured(projectFile, outputDirectory, requestedOptions, externalProcesses));
}

async function generateAutomaticMontagesMeasured(projectFile: string, outputDirectory: string, requestedOptions: AutoMontageOptions, externalProcesses: ExternalProcessMetrics): Promise<GeneratedAutoMontages> {
  const runStarted = performance.now();
  const timings = { sourceValidationMs: 0, musicAnalysisMs: 0, highlightCacheLookupMs: 0, sourceAudioAnalysisMs: 0, gameplayAnalysisMs: 0, referenceAnalysisMs: 0, planningMs: 0, hudValidationMs: 0, artifactPersistenceMs: 0 };
  let cacheHits = 0;
  let cacheMisses = 0;
  const sourcePath = path.resolve(projectFile);
  const project = await loadProject(sourcePath);
  validateOptions(requestedOptions);
  const music = project.media.find((asset) => asset.id === requestedOptions.musicMediaId);
  if (!music || !music.hasAudio) throw new AppError('MUSIC_ASSET_REQUIRED', 'Choose an imported audio asset with an audio stream for the montage music.');
  const options = { ...requestedOptions, durationSeconds: requestedOptions.durationSeconds ?? Math.min(seconds(music.duration), 1800) };
  const selectionMode = selectionModeFor(options);
  const sourceRanges = resolveSourceRanges(project, options, selectionMode);
  const sourceRangeById = new Map(sourceRanges.map((range) => [range.mediaId, range]));
  const selectedIds = selectionMode === 'library' ? null : new Set(options.videoMediaIds?.length ? options.videoMediaIds : sourceRanges.map((range) => range.mediaId));
  const referenceAsset = options.referenceMediaId ? project.media.find((asset) => asset.id === options.referenceMediaId) : undefined;
  if (options.referenceMediaId && (!referenceAsset || referenceAsset.kind !== 'video')) throw new AppError('REFERENCE_VIDEO_REQUIRED', 'Choose an imported video asset as the local edit-style reference.');
  const requestedVideos = project.media.filter((asset) => asset.kind === 'video' && (!selectedIds || selectedIds.has(asset.id)));
  if (selectedIds && requestedVideos.length !== selectedIds.size) throw new AppError('VIDEO_ASSET_NOT_FOUND', 'One or more selected video assets are not part of the project.');
  const videos = requestedVideos.filter((asset) => asset.id !== referenceAsset?.id);
  if (!videos.length) throw new AppError('VIDEO_ASSET_REQUIRED', 'Import or select at least one video asset for the montage.');
  const analysisVideos = videos;
  const selected = [music, ...analysisVideos, ...(referenceAsset ? [referenceAsset] : [])];
  const validationStarted = performance.now();
  for (const asset of selected) {
    let sourceStat;
    try { sourceStat = await fs.stat(asset.path); }
    catch { throw new AppError('MISSING_MEDIA', `Selected media is missing: ${asset.path}`); }
    if (!sourceStat.isFile()) throw new AppError('INVALID_MEDIA_SOURCE', `Selected media is not a regular file: ${asset.path}`);
    if (sourceStat.size !== asset.sizeBytes || sourceStat.mtime.toISOString() !== asset.modifiedAt)
      throw new AppError('SOURCE_MEDIA_CHANGED', `Selected source changed since import: ${asset.name}. Re-import or relink it before generating a montage.`);
  }
  timings.sourceValidationMs = performance.now() - validationStarted;
  const analysisDirectory = path.join(projectCachePath(sourcePath, project.id), 'analysis');
  const musicStarted = performance.now();
  const musicAnalysis = await analyzeAudio(music.path, path.join(analysisDirectory, `${music.id}.json`));
  timings.musicAnalysisMs = performance.now() - musicStarted;
  const highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }> = [];
  const existingCaches = new Set(await fs.readdir(analysisDirectory).catch(() => []));
  const pendingVideos: MediaAsset[] = [];
  const cacheLookupStarted = performance.now();
  for (const asset of analysisVideos) {
    const sourceRange = sourceRangeById.get(asset.id);
    const rangeKey = sourceRange ? `-range-${createHash('sha256').update(`${sourceRange.start.num}/${sourceRange.start.den}:${sourceRange.end.num}/${sourceRange.end.den}`).digest('hex').slice(0, 16)}` : '';
    const cacheFile = path.join(analysisDirectory, `cues-${asset.id}${rangeKey}.json`);
    const analysisWindow = sourceRange ? { startSeconds: sourceRange.startSeconds, endSeconds: sourceRange.endSeconds } : undefined;
    if (!existingCaches.has(path.basename(cacheFile))) {
      cacheMisses++;
      pendingVideos.push(asset);
      continue;
    }
    const cached = await readCachedHighlightAnalysis(asset.path, cacheFile, undefined, undefined, {
      mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind, durationSeconds: seconds(asset.duration), game: asset.game, ...(analysisWindow ? { analysisWindow } : {})
    });
    if (cached) { cacheHits++; highlightAnalyses.push({ mediaId: asset.id, analysis: cached }); }
    else { cacheMisses++; pendingVideos.push(asset); }
  }
  timings.highlightCacheLookupMs = performance.now() - cacheLookupStarted;
  const referenceStarted = performance.now();
  const referenceCutTimesSeconds = referenceAsset ? await detectSceneCutTimes(referenceAsset.path, seconds(referenceAsset.duration)) : undefined;
  timings.referenceAnalysisMs = performance.now() - referenceStarted;
  let plans: AutoMontagePlan[] | undefined;
  let lastPlanningError: unknown;
  const tryPlan = () => {
    const planningStarted = performance.now();
    try {
      plans = buildAutomaticMontagePlans({ project, musicAnalysis, highlightAnalyses, referenceAnalysis: options.referenceMediaId ? highlightAnalyses.find((item) => item.mediaId === options.referenceMediaId)?.analysis : undefined, referenceCutTimesSeconds, options });
      return true;
    } catch (error) {
      if (error instanceof AppError && ['NO_HIGHLIGHTS_FOUND', 'INSUFFICIENT_HIGHLIGHT_COVERAGE'].includes(error.code)) {
        lastPlanningError = error;
        return false;
      }
      throw error;
    } finally {
      timings.planningMs += performance.now() - planningStarted;
    }
  };
  if (!tryPlan()) {
    for (const asset of pendingVideos) {
      let audioAnalysis: AudioAnalysis | undefined;
      let audioAnalysisError: string | undefined;
      if (asset.hasAudio) {
        const audioStarted = performance.now();
        try { audioAnalysis = await analyzeAudio(asset.path, path.join(analysisDirectory, `${asset.id}.json`)); }
        catch (error) { audioAnalysisError = error instanceof Error ? error.message : String(error); }
        finally { timings.sourceAudioAnalysisMs += performance.now() - audioStarted; }
      }
      const sourceRange = sourceRangeById.get(asset.id);
      const rangeKey = sourceRange ? `-range-${createHash('sha256').update(`${sourceRange.start.num}/${sourceRange.start.den}:${sourceRange.end.num}/${sourceRange.end.den}`).digest('hex').slice(0, 16)}` : '';
      const cacheFile = path.join(analysisDirectory, `cues-${asset.id}${rangeKey}.json`);
      const gameplayStarted = performance.now();
      const analysis = await analyzeHighlightCues({
        mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind,
        durationSeconds: seconds(asset.duration), game: inferGameFromAsset(asset), audioAnalysis, audioAnalysisError,
        ...(sourceRange ? { analysisWindow: { startSeconds: sourceRange.startSeconds, endSeconds: sourceRange.endSeconds } } : {})
      }, cacheFile);
      timings.gameplayAnalysisMs += performance.now() - gameplayStarted;
      highlightAnalyses.push({ mediaId: asset.id, analysis });
      if (tryPlan()) break;
    }
  }
  let hudStatusCount = 0;
  let hudActionCount = 0;
  let hudValidationFallback = false;
  for (let iteration = 0; plans && iteration < 3; iteration++) {
    const hudStarted = performance.now();
    const inspection = await inspectPlannedValorantEvents(project, plans, highlightAnalyses);
    timings.hudValidationMs += performance.now() - hudStarted;
    if (!inspection.statusCount && !inspection.actionCount) break;
    hudStatusCount += inspection.statusCount;
    hudActionCount += inspection.actionCount;
    const previousPlans = plans;
    plans = undefined;
    if (!tryPlan()) {
      plans = previousPlans;
      hudValidationFallback = true;
      break;
    }
    if (iteration === 2) hudValidationFallback = true;
  }
  if (!plans) throw lastPlanningError ?? new AppError('NO_HIGHLIGHTS_FOUND', 'No eligible events were found in the project video library.');
  if (hudStatusCount) for (const plan of plans) plan.warnings.push(`Targeted Valorant HUD inspection rejected ${hudStatusCount} corroborated activity shot(s) containing buy-phase or round-result UI.`);
  if (hudActionCount) for (const plan of plans) plan.warnings.push(`Targeted Valorant HUD OCR promoted ${hudActionCount} visible action cue(s); OCR text is not independent proof of a kill.`);
  if (hudValidationFallback) for (const plan of plans) plan.warnings.push('Valorant HUD inspection found status UI but no safe replacement was available; review the flagged shot or ending manually.');
  const unscannedVideoCount = analysisVideos.length - highlightAnalyses.length;
  if (unscannedVideoCount > 0) {
    for (const plan of plans) plan.warnings.push(`Automatic library scan stopped after ${highlightAnalyses.length} of ${analysisVideos.length} target videos provided enough eligible highlights for the requested edit; ${unscannedVideoCount} unscanned videos may contain stronger events.`);
  }
  const root = path.resolve(outputDirectory);
  await fs.mkdir(root, { recursive: true });
  const safeName = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 64) || 'OpenMontage';
  const runName = `${safeName}-${options.style}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDirectory = path.join(root, runName);
  await fs.mkdir(runDirectory, { recursive: false });
  const createdFiles: string[] = [];
  try {
    const persistenceStarted = performance.now();
    const variants: GeneratedAutoMontageVariant[] = [];
    for (const plan of plans) {
      const basename = `${options.style}-${String(plan.variant).padStart(2, '0')}`;
      const generatedProject = materializeAutomaticMontageProject(project, plan);
      const projectPath = path.join(runDirectory, `${basename}.omproj`);
      const planPath = path.join(runDirectory, `${basename}.edit-plan.json`);
      await saveProject(projectPath, generatedProject, { recordHistory: false });
      createdFiles.push(projectPath);
      const temporaryPlan = `${planPath}.${randomUUID()}.tmp`;
      await fs.writeFile(temporaryPlan, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPlan, planPath);
      createdFiles.push(planPath);
      variants.push({ projectPath, planPath, plan });
    }
    timings.artifactPersistenceMs = performance.now() - persistenceStarted;
    const performanceReportPath = path.join(runDirectory, 'performance-report.json');
    const performanceReport = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      selection: { mode: selectionMode, candidateVideoCount: analysisVideos.length, sourceRangeCount: sourceRanges.length },
      analysis: { cacheHits, cacheMisses, analyzedVideoCount: highlightAnalyses.length, outputVariantCount: variants.length, durationSeconds: options.durationSeconds },
      timingsMs: {
        ...Object.fromEntries(Object.entries(timings).map(([key, value]) => [key, Math.round(value * 100) / 100])),
        totalClipPulseWallMs: Math.round((performance.now() - runStarted) * 100) / 100
      },
      externalWork: {
        childProcessWallMs: Object.values(externalProcesses).reduce((sum, metric) => sum + metric.totalWallMs, 0),
        ffmpegChildProcessCount: externalProcesses.ffmpeg.count,
        ffmpegChildProcessWallMs: externalProcesses.ffmpeg.totalWallMs,
        ffprobeChildProcessCount: externalProcesses.ffprobe.count,
        ffprobeChildProcessWallMs: externalProcesses.ffprobe.totalWallMs,
        tesseractChildProcessCount: externalProcesses.tesseract.count,
        tesseractChildProcessWallMs: externalProcesses.tesseract.totalWallMs,
        otherChildProcessCount: externalProcesses.other.count,
        otherChildProcessWallMs: externalProcesses.other.totalWallMs,
        externalAiWaitMs: 0,
        agentToolCallCount: null,
        agentPlanningMs: null,
        notes: [
          'Child-process values are summed process wall times inside measured montage generation; concurrent child processes can make the sum exceed the outer wall time. Stage timings remain inclusive and include ClipPulse orchestration.',
          'No external AI service is called by this generator.',
          'Agent call counts and Codex/Claude planning time are outside the ClipPulse process and are not measurable here.',
          'Library discovery/import happens before montage generation; this report covers assets already imported into the project.'
        ]
      }
    };
    const temporaryReport = `${performanceReportPath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporaryReport, `${JSON.stringify(performanceReport, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryReport, performanceReportPath);
    createdFiles.push(performanceReportPath);
    return { outputDirectory: runDirectory, performanceReportPath, variants };
  } catch (error) {
    await Promise.all(createdFiles.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function inspectPlannedValorantEvents(
  project: Project,
  plans: AutoMontagePlan[],
  highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }>
): Promise<{ statusCount: number; actionCount: number }> {
  const mediaById = new Map(project.media.map((asset) => [asset.id, asset]));
  const analysesById = new Map(highlightAnalyses.map((item) => [item.mediaId, item.analysis]));
  const visited = new Set<string>();
  const targets: Array<{ segment: AutoMontageSegment; asset: MediaAsset; analysis: HighlightAnalysis; time: number }> = [];
  const flaggedSegments = new Set<string>();
  for (const plan of plans) for (const segment of plan.segments) {
    const asset = mediaById.get(segment.mediaId);
    const analysis = analysesById.get(segment.mediaId);
    if (!asset || !analysis || segment.evidenceLevel !== 'corroborated' || segment.reviewStatus || inferGameFromAsset(asset) !== 'Valorant') continue;
    const sourceDuration = seconds(asset.duration);
    const sourceClip: TimelineClip = {
      id: segment.eventId, mediaId: segment.mediaId, start: rational(0), sourceIn: parseDecimal(segment.sourceInSeconds),
      duration: parseDecimal(segment.durationSeconds), audioEnabled: false, volume: 0,
      ...(segment.effectPlan.speedKeyframes?.length ? { speedKeyframes: segment.effectPlan.speedKeyframes.map((point) => ({ time: parseDecimal(point.timeSeconds), rate: parseDecimal(point.rate) })) } : {})
    };
    const midpointSourceTime = segment.sourceInSeconds + seconds(clipSourceOffsetAt(sourceClip, parseDecimal(segment.durationSeconds / 2)));
    const time = clamp(midpointSourceTime, 0, sourceDuration);
    const visitKey = `${asset.id}:${time.toFixed(3)}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    targets.push({ segment, asset, analysis, time });
  }
  const matches: Array<{ target: typeof targets[number]; match: Awaited<ReturnType<typeof inspectValorantHudEvent>> }> = [];
  let nextTarget = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (nextTarget < targets.length) {
      const target = targets[nextTarget++];
      matches.push({ target, match: await inspectValorantHudEvent(target.asset.path, target.time) });
    }
  }));
  let actionCount = 0;
  for (const { target, match } of matches) {
    if (!match) continue;
    const { asset, analysis, segment, time } = target;
    const sourceDuration = seconds(asset.duration);
    const isStatus = match.classification.eventType === 'quiet_passage' || match.classification.eventType === 'round_end';
    const eventId = `${asset.id}:targeted-hud:${time.toFixed(3)}:${match.classification.eventId}`;
    if (!analysis.events.some((event) => event.id === eventId)) {
      const event: AnalysisEvent = {
        id: eventId, mediaId: asset.id, kind: 'gameplay_event', startSeconds: Math.max(0, time - 0.05), decisiveSeconds: time,
        endSeconds: Math.min(sourceDuration, time + 0.05), confidence: isStatus ? 0.9 : 0.86, interestingness: isStatus ? 0.05 : 0.92,
        rankScore: isStatus ? 90 : 96, rank: 0, eventType: match.classification.eventType, evidenceLevel: 'explicit',
        detectors: [{ detectorId: 'openmontage.valorant-targeted-hud-ocr', version: '1.1.0', modality: 'text', confidence: isStatus ? 0.9 : 0.86, evidence: { gameEvent: match.classification.eventId, matchedKeyword: match.classification.matchedKeyword, recognizedText: match.recognizedText } }],
        signals: ['targeted-hud-frame-inspection', `matchedKeyword=${match.classification.matchedKeyword}`],
        uncertainties: [...match.classification.uncertainties, 'Targeted OCR inspects only selected shot windows and does not verify kills.']
      };
      analysis.events.push(event);
      if (!isStatus) actionCount++;
    }
    if (isStatus) flaggedSegments.add(`${segment.mediaId}:${segment.eventId}`);
  }
  return { statusCount: flaggedSegments.size, actionCount };
}

function placeEvents(
  initialAnchors: MusicAnchor[], candidates: EventCandidate[], durationFrames: number, project: Project, preset: Preset, options: AutoMontageOptions, variant: number,
  priorAssetUses: Map<string, number>, priorEvents: Set<string>, targetShot: number, minShot: number, maxShot: number, warnings: Set<string>
): AutoMontageSegment[] {
  const fps = Number(project.frameRate.num) / Number(project.frameRate.den);
  let anchors = [...initialAnchors];
  for (let attempt = 0; attempt <= initialAnchors.length; attempt++) {
    if (!anchors.length) break;
    const targetDuration = durationFrames / fps;
    const boundaries = [0];
    for (let index = 1; index < anchors.length; index++) {
      const raw = anchors[index - 1].time + (anchors[index].time - anchors[index - 1].time) * preset.cutRatio;
      boundaries.push(snapToFrame(raw, project.frameRate));
    }
    boundaries.push(targetDuration);
    const selected: AutoMontageSegment[] = [];
    const usedEvents = new Set<string>();
    const assetCounts = new Map<string, number>();
    const gameCounts = new Map<string, number>();
    const kindCounts = new Map<string, number>();
    let failedIndex = -1;
    for (let index = 0; index < anchors.length; index++) {
      const anchor = anchors[index];
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const duration = end - start;
      const durationFramesForSegment = Math.round(duration * fps);
      const timelineStartFrame = Math.round(start * fps);
      const preEvent = anchor.time - start;
      const possible = candidates.flatMap((candidate) => {
        const uniqueEventKey = `${candidate.asset.id}:${candidate.event.id}`;
        if (usedEvents.has(uniqueEventKey)) return [];
        const assetDuration = seconds(candidate.asset.duration);
        const tolerance = 1 / fps;
        let effectPlan = buildEffectPlan(candidate, anchor, preEvent, durationFramesForSegment / fps, project, options);
        let speedClip = makeSpeedPlanClip(durationFramesForSegment, project.frameRate, effectPlan.speedKeyframes);
        let sourceIn = candidate.decisive - seconds(clipSourceOffsetAt(speedClip, parseDecimal(preEvent.toFixed(9))));
        let sourceEnd = sourceIn + seconds(clipSourceDuration(speedClip));
        if ((sourceIn < -tolerance || sourceEnd > assetDuration + tolerance) && effectPlan.speedKeyframes?.length) {
          effectPlan = { ...effectPlan, speedKeyframes: undefined, notes: [...effectPlan.notes, 'Speed ramp skipped because source coverage is limited.'] };
          speedClip = makeSpeedPlanClip(durationFramesForSegment, project.frameRate);
          sourceIn = candidate.decisive - preEvent;
          sourceEnd = sourceIn + duration;
        }
        if (sourceIn < -tolerance || sourceEnd > assetDuration + tolerance) return [];
        if (candidate.sourceRange) {
          const outputSourceIn = Math.max(0, sourceIn);
          const outputSourceEnd = outputSourceIn + seconds(clipSourceDuration(speedClip));
          if (candidate.sourceRange.policy === 'strict') {
            const exactSourceIn = parseDecimal(outputSourceIn.toFixed(9));
            const exactSourceEnd = add(exactSourceIn, clipSourceDuration(speedClip));
            if (compare(exactSourceIn, candidate.sourceRange.start) < 0 || compare(exactSourceEnd, candidate.sourceRange.end) > 0) return [];
          } else {
            const extension = Math.max(preset.leadSeconds, preset.tailSeconds, 0.75);
            const allowedStart = Math.max(0, candidate.sourceRange.startSeconds - extension);
            const allowedEnd = Math.min(assetDuration, candidate.sourceRange.endSeconds + extension);
            if (outputSourceIn < allowedStart - tolerance || outputSourceEnd > allowedEnd + tolerance) return [];
          }
        }
        const contextTrimmed = candidate.start < sourceIn - tolerance || candidate.end > sourceEnd + tolerance;
        const snappedSourceIn = Math.max(0, sourceIn);
        const mappedEventOffset = seconds(clipSourceOffsetAt(speedClip, parseDecimal(preEvent.toFixed(9))));
        const framing = candidate.framingScore;
        const musicFit = musicFitScore(anchor, preset);
        const pacing = round(clamp(1 - Math.abs(duration - targetShot) / Math.max(maxShot, 0.1), 0, 1) * 100);
        const sameAssetPenalty = (assetCounts.get(candidate.asset.id) ?? 0) * 20 + (priorAssetUses.get(candidate.asset.id) ?? 0) * (variant > 1 ? 12 : 0);
        const sameGamePenalty = candidate.asset.game ? (gameCounts.get(candidate.asset.game.toLowerCase()) ?? 0) * 8 : 0;
        const eventKindKey = candidate.eventType ?? candidate.event.kind;
        const sameKindPenalty = (kindCounts.get(eventKindKey) ?? 0) * 5;
        const priorEventPenalty = priorEvents.has(uniqueEventKey) ? 18 : 0;
        const usableEvent: AutoMontageSegment = {
          index: index + 1,
          mediaId: candidate.asset.id,
          mediaName: candidate.asset.name,
          sourceContentHash: candidate.asset.contentHash,
          game: candidate.asset.game,
          eventId: candidate.event.id,
          eventKind: candidate.event.kind,
          ...(candidate.eventType ? { eventType: candidate.eventType } : {}),
          eventLabel: candidate.eventLabel,
          reviewStatus: candidate.reviewStatus,
           ...(candidate.sourceRange ? { sourceRange: { mediaId: candidate.asset.id, startSeconds: candidate.sourceRange.startText, endSeconds: candidate.sourceRange.endText, policy: candidate.sourceRange.policy } } : {}),
          evidenceLevel: candidate.evidenceLevel,
          uncertainties: [...candidate.uncertainties, ...(contextTrimmed ? ['Detector event context was cropped to maintain the selected shot cadence; the decisive timestamp remains inside the shot.'] : [])],
          sourceEventStartSeconds: candidate.start,
          sourceDecisiveSeconds: candidate.decisive,
          sourceEventEndSeconds: candidate.end,
          sourceInSeconds: snappedSourceIn,
          timelineStartSeconds: start,
          timelineStartFrame,
          durationSeconds: duration,
          durationFrames: durationFramesForSegment,
          targetAnchorSeconds: anchor.time,
          anchorKind: anchor.kind,
          anchorStrength: anchor.strength,
          alignmentErrorFrames: Math.round((mappedEventOffset - (candidate.decisive - snappedSourceIn)) * fps),
          effectPlan,
          score: { highlight: candidate.highlightScore, musicFit, framing, pacing },
          detectors: structuredClone(candidate.event.detectors),
          explanation: ''
        };
        const impact = eventImpact(candidate.eventType);
        const strongMoment = ['drop', 'accent', 'downbeat'].includes(anchor.kind) ? 1 : anchor.kind === 'beat' ? 0.35 : 0;
        const impactAlignmentBonus = impact * strongMoment * anchor.strength * 0.16;
        const evidenceScore = evidenceQuality(candidate.evidenceLevel, candidate.reviewStatus);
        const closingBonus = index === anchors.length - 1 ? impact * 0.08 : 0;
        const utility = candidate.highlightScore * 0.46 + evidenceScore * 0.12 + musicFit * 0.25 + framing * 0.05 + pacing * 0.12 + impactAlignmentBonus + closingBonus - sameAssetPenalty - sameGamePenalty - sameKindPenalty - priorEventPenalty;
        return [{ usableEvent, utility, candidate, uniqueEventKey }];
      });
      if (!possible.length) { failedIndex = index; break; }
      possible.sort((a, b) => b.utility - a.utility || a.candidate.asset.name.localeCompare(b.candidate.asset.name) || a.candidate.event.id.localeCompare(b.candidate.event.id));
      const choice = possible[0];
      const segment = choice.usableEvent;
      const rationale = [
      `highlight ${segment.score.highlight}/100`,
        `${segment.anchorKind} music anchor ${segment.targetAnchorSeconds.toFixed(3)}s`,
      ...(eventImpact(segment.eventType) >= 45 && ['drop', 'accent', 'downbeat'].includes(segment.anchorKind) ? ['high-impact event prioritized on a strong musical accent'] : []),
        `${segment.alignmentErrorFrames} output-frame sync error`,
        `${segment.score.pacing}/100 pacing`,
        segment.game ? `game ${segment.game}` : undefined,
        segment.reviewStatus ? `${segment.reviewStatus} review` : undefined
      ].filter(Boolean).join('; ');
      segment.explanation = `${segment.eventLabel} from ${segment.mediaName}: ${rationale}. Scores are explainable heuristics, not calibrated gameplay probabilities.`;
      selected.push(segment);
      usedEvents.add(choice.uniqueEventKey);
      assetCounts.set(choice.candidate.asset.id, (assetCounts.get(choice.candidate.asset.id) ?? 0) + 1);
      if (choice.candidate.asset.game) {
        const game = choice.candidate.asset.game.toLowerCase();
        gameCounts.set(game, (gameCounts.get(game) ?? 0) + 1);
      }
      const eventKindKey = choice.candidate.eventType ?? choice.candidate.event.kind;
      kindCounts.set(eventKindKey, (kindCounts.get(eventKindKey) ?? 0) + 1);
    }
    if (failedIndex < 0) {
      const maxAllowed = maxShot + 1 / fps;
      if (selected.some((segment) => segment.durationSeconds > maxAllowed)) {
        const longestShots = selected.map((segment) => segment.durationSeconds).sort((a, b) => b - a).slice(0, 3).map((duration) => duration.toFixed(2)).join(', ');
        throw new AppError('INSUFFICIENT_HIGHLIGHT_COVERAGE', `The selected footage cannot cover the requested edit without a ${Math.max(...selected.map((segment) => segment.durationSeconds)).toFixed(1)} second gameplay passage, above the ${maxShot.toFixed(1)} second shot limit (${selected.length} events placed into ${anchors.length} planned shots from ${candidates.length} eligible events; longest shots: ${longestShots}s). Add reviewed highlights, choose a slower style, or reduce the edit duration.`);
      }
      return selected;
    }
    if (anchors.length === 1) break;
    warnings.add('A music anchor was removed because no distinct analyzed event had enough source footage around it.');
    anchors.splice(failedIndex, 1);
  }
  throw new AppError('INSUFFICIENT_HIGHLIGHT_COVERAGE', `The selected clips do not provide enough distinct analyzed highlight windows for a ${(durationFrames / fps).toFixed(1)} second ${options.style} edit. Add clips or events, choose a slower style, or reduce the requested duration.`);
}

function chooseMusicAnchors(analysis: AudioAnalysis, duration: number, fps: Rational, preset: Preset, targetShot: number, minShot: number, maxShot: number, variant: number, intensity: number, referenceShotPattern: number[] = []): MusicAnchor[] {
  const frameRate = Number(fps.num) / Number(fps.den);
  const candidates = buildMusicAnchors(analysis, fps).filter((anchor) => anchor.time >= 0.35 && anchor.time <= duration - 0.25);
  const leadSource = referenceShotPattern?.[0] ?? preset.leadSeconds;
  const lead = Math.min(duration * 0.3, leadSource * (1.25 - 0.35 * intensity));
  const firstLow = Math.max(0.35, lead * 0.5);
  const firstHigh = Math.min(duration - Math.max(preset.tailSeconds, minShot * 0.35), lead + targetShot * 0.55);
  const firstOptions = candidates.filter((candidate) => candidate.time >= firstLow && candidate.time <= firstHigh);
  const first = firstOptions.sort((a, b) => anchorUtility(b, preset, lead, variant) - anchorUtility(a, preset, lead, variant))[0]
    ?? { time: snapToFrame(lead, fps), kind: 'paced' as const, strength: 0.2 };
  const anchors = [first];
  let previous = first.time;
  const variantFactor = variant % 3 === 2 ? 1.07 : variant % 3 === 0 ? 0.94 : 1;
  const desiredGap = targetShot * variantFactor;
  for (let guard = 0; guard < 10_000; guard++) {
    const referenceGap = referenceShotPattern.length
      ? referenceShotPattern[(anchors.length - 1) % referenceShotPattern.length] * (1.3 - 0.6 * intensity)
      : desiredGap;
    const expected = previous + clamp(referenceGap * variantFactor, minShot, maxShot);
    if (expected > duration - Math.max(preset.tailSeconds, minShot * 0.45)) break;
    const choices = candidates.filter((candidate) => candidate.time >= previous + minShot && candidate.time <= Math.min(previous + maxShot, duration - preset.tailSeconds));
    const chosen = choices.sort((a, b) => anchorUtility(b, preset, expected, variant) - anchorUtility(a, preset, expected, variant))[0];
    const anchor = chosen ?? { time: snapToFrame(expected, fps), kind: 'paced' as const, strength: 0.18 };
    if (anchor.time <= previous || anchor.time >= duration - 0.15) break;
    anchors.push(anchor);
    previous = anchor.time;
  }
  const terminalHold = Math.min(preset.tailSeconds, Math.max(0.18, targetShot * 0.25));
  const terminalTime = snapToFrame(duration - terminalHold, fps);
  const previousAnchor = anchors.length > 1 ? anchors[anchors.length - 2].time : 0;
  const finalStartWithoutTerminal = previousAnchor + (previous - previousAnchor) * preset.cutRatio;
  const needsTerminal = duration - finalStartWithoutTerminal > maxShot;
  if (terminalTime - previous > minShot || (needsTerminal && terminalTime - previous > 0.15)) {
    const terminalTolerance = Math.min(0.35, targetShot * 0.25);
    const finalCandidates = candidates.filter((candidate) => candidate.time >= terminalTime - terminalTolerance && candidate.time <= duration - 0.15 && candidate.time - previous >= minShot);
    const terminal = finalCandidates.sort((a, b) => anchorUtility(b, preset, terminalTime, variant) - anchorUtility(a, preset, terminalTime, variant))[0]
      ?? { time: terminalTime, kind: 'paced' as const, strength: 0.18 };
    while (terminal.time - previous > maxShot) {
      const expected = previous + clamp(targetShot, minShot, maxShot);
      if (terminal.time - expected < minShot) break;
      const choices = candidates.filter((candidate) => candidate.time >= previous + minShot && candidate.time <= Math.min(previous + maxShot, expected + minShot * 0.35));
      const intermediate = choices.sort((a, b) => anchorUtility(b, preset, expected, variant) - anchorUtility(a, preset, expected, variant))[0]
        ?? { time: snapToFrame(expected, fps), kind: 'paced' as const, strength: 0.18 };
      anchors.push(intermediate);
      previous = intermediate.time;
    }
    if (terminal.time - previous > 0.15) anchors.push(terminal);
  }
  const unique: MusicAnchor[] = [];
  for (const anchor of anchors) {
    if (unique.length && Math.abs(anchor.time - unique[unique.length - 1].time) < 1 / frameRate) continue;
    unique.push({ ...anchor, time: snapToFrame(anchor.time, fps) });
  }
  return unique;
}

function buildMusicAnchors(analysis: AudioAnalysis, fps: Rational): MusicAnchor[] {
  const candidates: MusicAnchor[] = [];
  type SignalAnchor = number | { timeSeconds: number; strength: number; confidence?: number };
  const addCandidates = (items: SignalAnchor[], kind: MusicAnchor['kind'], fallbackStrength: number) => {
    for (const item of items) {
      const time = typeof item === 'number' ? item : item.timeSeconds;
      if (!Number.isFinite(time) || time < 0) continue;
      const snapped = snapToFrame(time, fps);
      const energyIndex = Math.floor(time / Math.max(analysis.energyHopSeconds, 0.001));
      const energy = analysis.energyCurve[energyIndex] ?? 0.5;
      const signalStrength = typeof item === 'number'
        ? fallbackStrength
        : clamp(item.strength * (0.55 + 0.45 * (item.confidence ?? 0.5)), 0, 1);
      candidates.push({ time: snapped, kind, strength: round(clamp(signalStrength * 0.72 + energy * 0.28, 0, 1)) });
    }
  };
  const structureEvents = analysis.structureEvents ?? [];
  const drops = structureEvents.filter((event) => event.type === 'drop');
  const accents = structureEvents.filter((event) => event.type === 'strong_accent');
  const gridDownbeats = analysis.beatGrid?.filter((point) => point.downbeat) ?? [];
  addCandidates(drops.length ? drops : analysis.drops, 'drop', 1);
  addCandidates(accents.length ? accents : (analysis.accents ?? []), 'accent', 0.92);
  addCandidates(gridDownbeats.length ? gridDownbeats : analysis.downbeats, 'downbeat', 0.88);
  addCandidates(analysis.beatGrid?.length ? analysis.beatGrid : analysis.beats, 'beat', 0.62);
  addCandidates(analysis.onsetEvents?.length ? analysis.onsetEvents : analysis.onsets, 'onset', 0.42);
  candidates.sort((a, b) => a.time - b.time || b.strength - a.strength);
  const merged: MusicAnchor[] = [];
  const tolerance = 1 / (Number(fps.num) / Number(fps.den));
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.time - candidate.time) <= tolerance) {
      if (candidatePriority(candidate.kind) > candidatePriority(previous.kind) || (candidatePriority(candidate.kind) === candidatePriority(previous.kind) && candidate.strength > previous.strength)) merged[merged.length - 1] = candidate;
    } else merged.push(candidate);
  }
  return merged;
}

function scorePlan(segments: AutoMontageSegment[], duration: number, targetShot: number, fps: number): AutoMontagePlan['scoreBreakdown'] {
  const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const uniqueAssets = new Set(segments.map((segment) => segment.mediaId)).size;
  const uniqueGames = new Set(segments.map((segment) => segment.game?.toLowerCase()).filter(Boolean)).size;
  const uniqueKinds = new Set(segments.map((segment) => segment.eventKind)).size;
  const assetDiversity = segments.length ? (uniqueAssets / segments.length) * 72 : 0;
  const gameDiversity = segments.length ? Math.min(1, uniqueGames / Math.min(segments.length, 3)) * 18 : 0;
  const eventDiversity = segments.length ? Math.min(1, uniqueKinds / Math.min(segments.length, 4)) * 10 : 0;
  const framing = avg(segments.map((segment) => segment.score.framing));
  const shotFit = avg(segments.map((segment) => clamp(1 - Math.abs(segment.durationSeconds - targetShot) / Math.max(targetShot, 0.1), 0, 1) * 100));
  const totalDuration = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const durationFit = Math.abs(totalDuration - duration) <= 1 / fps ? 100 : 0;
  return {
    highlightQuality: round(avg(segments.map((segment) => segment.score.highlight))),
    gameplayEvidence: round(avg(segments.map((segment) => evidenceQuality(segment.evidenceLevel ?? 'unknown', segment.reviewStatus)))),
    musicAlignment: round(avg(segments.map((segment) => segment.score.musicFit))),
    sceneDiversity: round(assetDiversity + gameDiversity + eventDiversity),
    pacing: round(shotFit),
    framing: round(framing),
    duration: round(durationFit)
  };
}

function buildReferenceProfile(asset: MediaAsset, analysis?: HighlightAnalysis, measuredCuts?: number[]): AutoMontagePlan['referenceStyle'] | undefined {
  const duration = seconds(asset.duration);
  const cuts: number[] = [];
  const cutTimes = [...(measuredCuts ?? analysis?.events.filter((item) => item.kind === 'scene_change' || item.eventType === 'scene_change').map((item) => item.decisiveSeconds) ?? [])];
  for (const time of cutTimes.sort((a, b) => a - b)) {
    if (!Number.isFinite(time) || time < 0.15 || time > duration - 0.15) continue;
    if (!cuts.length || time - cuts[cuts.length - 1] >= 0.15) cuts.push(time);
  }
  if (cuts.length < 3) return undefined;
  const boundaries = [0, ...cuts, duration];
  const shots = boundaries.slice(1).map((time, index) => time - boundaries[index]).filter((shot) => shot >= 0.2);
  if (shots.length < 3) return undefined;
  const percentile = (fraction: number) => {
    const sorted = [...shots].sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return round(sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower));
  };
  return {
    mediaId: asset.id,
    mediaName: asset.name,
    detectedCuts: cuts.length,
    sampledShots: shots.length,
    cutTimesSeconds: cuts.map((time) => round(time)),
    shotDurationsSeconds: shots.map((shot) => round(shot)),
    medianShotSeconds: percentile(0.5),
    p75ShotSeconds: percentile(0.75)
  };
}

function evidenceQuality(level: NonNullable<AnalysisEvent['evidenceLevel']>, reviewStatus?: 'accepted' | 'corrected'): number {
  if (reviewStatus) return 100;
  return ({ explicit: 100, corroborated: 68, heuristic: 22, unknown: 0 } as const)[level];
}

function buildEffectPlan(candidate: EventCandidate, anchor: MusicAnchor, eventOffset: number, duration: number, project: Project, options: AutoMontageOptions): AutoMontageSegment['effectPlan'] {
  const target = targetDimensions(options.format, project);
  const width = candidate.asset.width ?? target.width;
  const height = candidate.asset.height ?? target.height;
  const fitScale = Math.min(target.width / width, target.height / height);
  const cropScale = fitScale > 0 ? round(Math.max(target.width / (width * fitScale), target.height / (height * fitScale))) : 1;
  const verified = candidate.evidenceLevel === 'explicit' || Boolean(candidate.reviewStatus);
  const strongAnchor = ['drop', 'accent', 'downbeat'].includes(anchor.kind) || (anchor.kind === 'beat' && anchor.strength >= 0.85);
  const strongHighlight = (verified && eventImpact(candidate.eventType) >= 62) || (candidate.evidenceLevel === 'corroborated' && candidate.highlightScore >= 70);
  const strongMoment = strongHighlight && strongAnchor;
  const canPunch = strongMoment && ['aggressive', 'velocity', 'cinematic'].includes(options.style);
  const impactZoom = canPunch && options.style !== 'cinematic';
  const speedRate = options.style === 'cinematic' ? 0.82 : options.style === 'velocity' ? 0.58 : 0.68;
  let speedKeyframes: Array<{ timeSeconds: number; rate: number }> | undefined;
  if (canPunch && ['aggressive', 'velocity', 'cinematic'].includes(options.style)) {
    const frameSeconds = Number(project.frameRate.den) / Number(project.frameRate.num);
    const lastRampTime = Math.max(0, duration - frameSeconds);
    const approach = Math.min(lastRampTime, snapToFrame(Math.max(0, eventOffset - 0.36), project.frameRate));
    const peak = Math.min(lastRampTime, snapToFrame(eventOffset, project.frameRate));
    const recovery = Math.min(lastRampTime, snapToFrame(Math.min(lastRampTime, eventOffset + 0.45), project.frameRate));
    if (peak - approach >= 0.08 && recovery - peak >= 0.08) {
      speedKeyframes = [{ timeSeconds: approach, rate: 1 }, { timeSeconds: peak, rate: speedRate }, { timeSeconds: recovery, rate: 1 }];
    }
  }
  const notes = [`Centered fill crop for ${target.width}×${target.height}.`];
  if (impactZoom) notes.push(`Subtle 4% punch-in on a ${verified ? 'verified high-impact event' : 'high-scoring corroborated activity cue'} at a strong musical accent.`);
  if (speedKeyframes?.length) notes.push(`Short ${speedRate.toFixed(2)}× event ramp returns to real time before the clip ends.`);
  notes.push('Hard cut retained; no unverified transition overlay.');
  return { cropScale, impactZoom, ...(speedKeyframes ? { speedKeyframes } : {}), notes };
}

function makeSpeedPlanClip(durationFrames: number, fps: Rational, keyframes?: AutoMontageSegment['effectPlan']['speedKeyframes']): TimelineClip {
  const durationSeconds = seconds(frameTime(durationFrames, fps));
  const validKeyframes = keyframes?.length === 3
    && keyframes.every((point, index) => Number.isFinite(point.timeSeconds) && point.timeSeconds >= 0 && point.timeSeconds < durationSeconds && Number.isFinite(point.rate) && point.rate >= 0.25 && point.rate <= 4 && (index === 0 || point.timeSeconds > keyframes[index - 1].timeSeconds))
    ? keyframes
    : undefined;
  return {
    id: 'auto-montage-speed-plan',
    mediaId: 'auto-montage-speed-plan',
    start: rational(0),
    sourceIn: rational(0),
    duration: frameTime(durationFrames, fps),
    audioEnabled: false,
    volume: 0,
    ...(validKeyframes ? { speedKeyframes: validKeyframes.map((point) => ({ time: parseDecimal(point.timeSeconds.toFixed(9)), rate: parseDecimal(point.rate.toFixed(9)) })) } : {})
  };
}

function validateOptions(options: AutoMontageOptions): void {
  if (!options || typeof options.musicMediaId !== 'string' || !options.musicMediaId) throw new AppError('INVALID_MONTAGE_OPTIONS', 'A music media ID is required.');
  if (!['clean', 'aggressive', 'cinematic', 'smooth', 'velocity', 'custom'].includes(options.style)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Choose a supported montage style.');
  if (options.selectionMode !== undefined && !['library', 'selected', 'ranges'].includes(options.selectionMode)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Choose library, selected clips, or selected search ranges.');
  if (options.sourceRangePolicy !== undefined && !['strict', 'flexible'].includes(options.sourceRangePolicy)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Source range policy must be strict or flexible.');
  if (options.sourceRanges !== undefined && (!Array.isArray(options.sourceRanges) || options.sourceRanges.length > 5000)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Source ranges must be a list of at most 5000 clips.');
  if (options.durationSeconds !== undefined && (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 1800)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Montage duration must be between 1 and 1800 seconds.');
  if (!Number.isInteger(options.variants) || options.variants < 1 || options.variants > 5) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Generate between one and five montage variants.');
  if (!Number.isFinite(options.intensity) || options.intensity < 0 || options.intensity > 1) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Cut intensity must be between 0 and 1.');
  if (!['project', 'landscape-1080p', 'portrait-1080p', 'square-1080p'].includes(options.format)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Choose a supported output format.');
  if (options.videoMediaIds && (!Array.isArray(options.videoMediaIds) || options.videoMediaIds.length < 1 || options.videoMediaIds.length > 5000 || new Set(options.videoMediaIds).size !== options.videoMediaIds.length)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Select between one and 5000 unique video assets.');
  if (options.selectionMode === 'library' && options.videoMediaIds?.length) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Library mode cannot also specify a restricted video list.');
  if (options.selectionMode === 'selected' && options.sourceRanges?.length) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Source ranges are only valid in ranges mode.');
  if (options.selectionMode === 'selected' && !options.videoMediaIds?.length) throw new AppError('VIDEO_ASSET_REQUIRED', 'Select at least one video for selected-clips mode.');
  if (options.style === 'custom') validateCustomRules(options.customRules);
  else if (options.customRules) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom rules are only valid with the custom style.');
}

function selectionModeFor(options: AutoMontageOptions): AutoMontageSelectionMode {
  return options.selectionMode ?? (options.videoMediaIds?.length ? 'selected' : 'library');
}

function resolveSourceRanges(project: Project, options: AutoMontageOptions, selectionMode: AutoMontageSelectionMode): Array<{ mediaId: string; start: Rational; end: Rational; startSeconds: number; endSeconds: number; startText: string; endText: string }> {
  if (selectionMode !== 'ranges') {
    if (options.sourceRanges?.length) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Source ranges are only valid in ranges mode.');
    return [];
  }
  if (!options.sourceRanges?.length) throw new AppError('SOURCE_RANGES_REQUIRED', 'Ranges mode needs at least one marked video range.');
  const seen = new Set<string>();
  const ranges = options.sourceRanges.map((range) => {
    if (!range || typeof range.mediaId !== 'string' || seen.has(range.mediaId)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Each selected video can have only one source search range.');
    seen.add(range.mediaId);
    const asset = project.media.find((item) => item.id === range.mediaId && item.kind === 'video');
    if (!asset) throw new AppError('VIDEO_ASSET_NOT_FOUND', `A source range references a video that is not imported: ${range.mediaId}`);
    const start = parseDecimal(range.startSeconds);
    const end = parseDecimal(range.endSeconds);
    if (BigInt(start.num) < 0n || compare(start, end) >= 0 || compare(end, asset.duration) > 0) {
      throw new AppError('INVALID_SOURCE_RANGE', `The marked source range for ${asset.name} must satisfy 0 ≤ start < end ≤ ${seconds(asset.duration).toFixed(3)} seconds.`);
    }
    return { mediaId: range.mediaId, start, end, startSeconds: seconds(start), endSeconds: seconds(end), startText: range.startSeconds, endText: range.endSeconds };
  });
  if (options.videoMediaIds?.length) {
    const selected = new Set(options.videoMediaIds);
    if (selected.size !== seen.size || [...selected].some((id) => !seen.has(id))) throw new AppError('INVALID_MONTAGE_OPTIONS', 'In ranges mode, videoMediaIds must exactly match the clips with marked ranges.');
  }
  return ranges;
}

function validateCustomRules(rules: AutoMontageCustomRules | undefined): asserts rules is AutoMontageCustomRules {
  if (!rules) throw new AppError('INVALID_MONTAGE_OPTIONS', 'The custom style needs a complete custom rule set.');
  const bounded = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (!bounded(rules.targetShotSeconds, 0.5, 30) || !bounded(rules.minShotSeconds, 0.5, 30) || !bounded(rules.maxShotSeconds, 0.5, 30) || rules.minShotSeconds > rules.targetShotSeconds || rules.targetShotSeconds > rules.maxShotSeconds)
    throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom shot lengths must satisfy 0.5 ≤ minimum ≤ target ≤ maximum ≤ 30 seconds.');
  if (!bounded(rules.leadSeconds, 0, 15) || !bounded(rules.tailSeconds, 0, 15)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom lead-in and tail context must be between 0 and 15 seconds.');
  if (!bounded(rules.cutRatio, 0.25, 0.75)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom cut position ratio must be between 0.25 and 0.75.');
  if (!bounded(rules.videoAudioVolume, 0, 1) || !bounded(rules.musicVolume, 0, 2)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom game audio must be between 0× and 1×; music volume must be between 0× and 2×.');
  if (!rules.anchorPreference || !(['drop', 'downbeat', 'beat', 'onset'] as const).every((key) => bounded(rules.anchorPreference[key], 0, 1)) || (rules.anchorPreference.accent !== undefined && !bounded(rules.anchorPreference.accent, 0, 1)))
    throw new AppError('INVALID_MONTAGE_OPTIONS', 'Each custom music-anchor weight must be between 0 and 1.');
}

function targetDimensions(format: AutoMontageFormat, project: Project): { width: number; height: number } {
  switch (format) {
    case 'landscape-1080p': return { width: 1920, height: 1080 };
    case 'portrait-1080p': return { width: 1080, height: 1920 };
    case 'square-1080p': return { width: 1080, height: 1080 };
    default: return { width: project.width, height: project.height };
  }
}

function inferGameFromAsset(asset: MediaAsset): string | undefined {
  return inferGameplayGame(asset.game, `${asset.name} ${path.basename(asset.path)}`);
}

function isStrongCorroboratedGameplayActivity(event: AnalysisEvent, eventType: AnalysisEvent['eventType'], evidenceLevel: NonNullable<AnalysisEvent['evidenceLevel']>): boolean {
  if (evidenceLevel !== 'corroborated' || eventType !== 'combat_activity' || event.kind !== 'coincident_activity') return false;
  const sceneChange = event.detectors.some((detector) => detector.detectorId === 'openmontage.ffmpeg-scene-change');
  if (sceneChange) return false;
  const audioEvidence = event.detectors.find((detector) => detector.detectorId === 'openmontage.audio-activity')?.evidence;
  const motionEvidence = event.detectors.find((detector) => detector.detectorId === 'openmontage.frame-difference-motion')?.evidence;
  const energy = audioEvidence?.relativeEnergy;
  const transients = audioEvidence?.nearbyTransients;
  const motion = motionEvidence?.meanDifference;
  return typeof energy === 'number' && energy >= 0.35
    && typeof transients === 'number' && transients >= 2
    && typeof motion === 'number' && motion >= 0.06;
}

function getPreset(style: AutoMontageStyle, rules?: AutoMontageCustomRules): Preset {
  const base = PRESETS[style];
  if (style !== 'custom' || !rules) return base;
  return {
    ...base,
    targetShotSeconds: rules.targetShotSeconds,
    minShotSeconds: rules.minShotSeconds,
    maxShotSeconds: rules.maxShotSeconds,
    leadSeconds: rules.leadSeconds,
    tailSeconds: rules.tailSeconds,
    cutRatio: rules.cutRatio,
    videoAudioVolume: rules.videoAudioVolume,
    musicVolume: rules.musicVolume,
    anchorPreference: { ...base.anchorPreference, ...rules.anchorPreference }
  };
}

function styleLabel(style: AutoMontageStyle): string {
  return ({ clean: 'Clean Competitive', aggressive: 'Aggressive Gaming', cinematic: 'Cinematic', smooth: 'Smooth', velocity: 'Velocity Pacing', custom: 'Custom' })[style];
}

function eventImpact(type?: AnalysisEvent['eventType']): number {
  return ({ ace: 100, multi_kill: 88, clutch: 80, headshot: 72, kill: 62, round_end: 45, round_objective: 38 } as Partial<Record<NonNullable<AnalysisEvent['eventType']>, number>>)[type ?? 'unknown'] ?? 0;
}

function labelForEvent(event: AnalysisEvent, overrideType = event.eventType): string {
  if (overrideType) {
    const labels: Record<NonNullable<AnalysisEvent['eventType']>, string> = {
      kill: 'Kill', headshot: 'Headshot', multi_kill: 'Multi-kill', ace: 'Ace', clutch: 'Clutch', clutch_situation: 'Possible clutch situation',
      round_end: 'Round end', round_objective: 'Round objective', kill_feed_change: 'Possible kill-feed change', combat_activity: 'Combat activity',
      fast_action_candidate: 'Fast action candidate', quiet_passage: 'Low-activity passage', audio_activity: 'Audio activity',
      scene_change: 'Scene change', text_recognition: 'HUD text', unknown: 'Unclassified event'
    };
    return labels[overrideType];
  }
  const gameEvent = event.detectors.find((detector) => typeof detector.evidence.gameEvent === 'string')?.evidence.gameEvent;
  if (typeof gameEvent === 'string') return gameEvent.replaceAll('_', ' ');
  return ({ audio_activity: 'Audio activity', scene_change: 'Scene change', motion_activity: 'Motion activity', text_recognition: 'HUD text', gameplay_event: 'Gameplay event', coincident_activity: 'Combined activity' })[event.kind];
}

function musicFitScore(anchor: MusicAnchor, preset: Preset): number {
  return round(clamp(preset.anchorPreference[anchor.kind] * 66 + anchor.strength * 34, 0, 100));
}

function anchorUtility(anchor: MusicAnchor, preset: Preset, expectedTime: number, variant: number): number {
  const distance = Math.abs(anchor.time - expectedTime);
  const variantTieBreak = variant > 1 ? (anchor.time * (variant % 2 ? 0.013 : -0.009)) : 0;
  return preset.anchorPreference[anchor.kind] * 70 + anchor.strength * 28 - distance * 5 + variantTieBreak;
}

function candidatePriority(kind: MusicAnchor['kind']): number { return ({ drop: 6, accent: 5, downbeat: 4, beat: 3, onset: 2, paced: 1 })[kind]; }

function snapToFrame(value: number, fps: Rational): number {
  const frame = Math.round(value * Number(fps.num) / Number(fps.den));
  return seconds(frameTime(frame, fps));
}

function fadeFor(requestedSeconds: number, clipDuration: Rational, fps: Rational): Rational {
  const clip = seconds(clipDuration);
  const frameRate = Number(fps.num) / Number(fps.den);
  const actual = Math.min(requestedSeconds, clip / 2);
  return frameTime(Math.max(0, Math.round(actual * frameRate)), fps);
}

function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }
function round(value: number): number { return Number(value.toFixed(2)); }
