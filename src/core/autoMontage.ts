import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyzeAudio } from './audioAnalysis';
import { analyzeHighlightCues } from './highlightAnalysis';
import { newId } from './ids';
import { newTrack, projectCachePath, saveProject, timelineDuration, validateProject, loadProject } from './project';
import { compare, frameTime, parseDecimal, rational, seconds } from './time';
import type { AnalysisEvent, AudioAnalysis, AutoMontageAnalysisInput, AutoMontageCustomRules, AutoMontageFormat, AutoMontageOptions, AutoMontagePlan, AutoMontageSegment, AutoMontageStyle, GeneratedAutoMontages, GeneratedAutoMontageVariant, HighlightAnalysis, MediaAsset, Project, Rational, TimelineClip } from './types';
import { AppError } from './errors';

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
    anchorPreference: { drop: 1, downbeat: 0.95, beat: 0.62, onset: 0.25, paced: 0.05 }
  },
  aggressive: {
    targetShotSeconds: 1.9, minShotSeconds: 0.8, maxShotSeconds: 3.5, leadSeconds: 0.65, tailSeconds: 0.6, cutRatio: 0.5,
    videoAudioVolume: 0.2, musicVolume: 1, fadeSeconds: 0.04,
    anchorPreference: { drop: 1, downbeat: 0.85, beat: 0.8, onset: 0.62, paced: 0.05 }
  },
  cinematic: {
    targetShotSeconds: 5.8, minShotSeconds: 3.2, maxShotSeconds: 9.5, leadSeconds: 2, tailSeconds: 1.8, cutRatio: 0.43,
    videoAudioVolume: 0.3, musicVolume: 0.86, fadeSeconds: 0.34,
    anchorPreference: { drop: 1, downbeat: 0.95, beat: 0.48, onset: 0.2, paced: 0.05 }
  },
  velocity: {
    targetShotSeconds: 2.8, minShotSeconds: 1.1, maxShotSeconds: 5.2, leadSeconds: 0.95, tailSeconds: 0.9, cutRatio: 0.5,
    videoAudioVolume: 0.2, musicVolume: 1, fadeSeconds: 0.06,
    anchorPreference: { drop: 1, downbeat: 0.88, beat: 0.78, onset: 0.58, paced: 0.05 }
  },
  custom: {
    targetShotSeconds: 3.5, minShotSeconds: 1.2, maxShotSeconds: 7, leadSeconds: 1, tailSeconds: 1, cutRatio: 0.5,
    videoAudioVolume: 0.25, musicVolume: 0.95, fadeSeconds: 0.1,
    anchorPreference: { drop: 1, downbeat: 0.9, beat: 0.68, onset: 0.4, paced: 0.05 }
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
  highlightScore: number;
  framingScore: number;
  eventLabel: string;
}

export function buildAutomaticMontagePlans(input: AutoMontageAnalysisInput): AutoMontagePlan[] {
  const { project, options, musicAnalysis } = input;
  validateOptions(options);
  const music = project.media.find((asset) => asset.id === options.musicMediaId);
  if (!music || !music.hasAudio) throw new AppError('MUSIC_ASSET_REQUIRED', 'Choose an imported audio asset with an audio stream for the montage music.');
  const musicDuration = seconds(music.duration);
  const fps = Number(project.frameRate.num) / Number(project.frameRate.den);
  const durationFrames = Math.round(options.durationSeconds * fps);
  const durationSeconds = seconds(frameTime(durationFrames, project.frameRate));
  if (durationFrames < 1 || durationSeconds > musicDuration + (1 / fps)) throw new AppError('MUSIC_TOO_SHORT', `The music is ${musicDuration.toFixed(2)} seconds long; the requested montage is ${durationSeconds.toFixed(2)} seconds. Shorten the montage or choose longer music.`);

  const selectedIds = options.videoMediaIds ? new Set(options.videoMediaIds) : null;
  const videos = project.media.filter((asset) => asset.kind === 'video' && (!selectedIds || selectedIds.has(asset.id)));
  if (selectedIds && videos.length !== selectedIds.size) throw new AppError('VIDEO_ASSET_NOT_FOUND', 'One or more selected video assets are not part of the project.');
  if (!videos.length) throw new AppError('VIDEO_ASSET_REQUIRED', 'Import or select at least one video asset for the montage.');

  const analyses = new Map(input.highlightAnalyses.map((item) => [item.mediaId, item.analysis]));
  const eventCandidates = videos.flatMap((asset) => {
    const analysis = analyses.get(asset.id);
    if (!analysis) return [];
    return analysis.events.flatMap((event) => {
      const review = asset.analysisEventReviews?.find((item) => item.eventId === event.id);
      if (review?.status === 'rejected') return [];
      const start = review?.status === 'corrected' ? review.startSeconds : event.startSeconds;
      const decisive = review?.status === 'corrected' ? review.decisiveSeconds : event.decisiveSeconds;
      const end = review?.status === 'corrected' ? review.endSeconds : event.endSeconds;
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
      const highlightScore = clamp(
        event.rankScore * 0.42 + event.confidence * 100 * 0.2 + event.interestingness * 100 * 0.13 + rating * 0.13 + corroboration * 0.07 + framingScore * 0.05 + (asset.favorite ? 3 : 0) + reviewBonus,
        0, 100
      );
      return [{ asset, event, start, decisive, end, reviewStatus: review?.status === 'accepted' || review?.status === 'corrected' ? review.status : undefined, highlightScore: round(highlightScore), framingScore, eventLabel: labelForEvent(event) }];
    });
  });
  if (!eventCandidates.length) throw new AppError('NO_HIGHLIGHTS_FOUND', 'No usable highlight events were found in the selected videos. Run highlight analysis, review its cues, or select videos that contain detected events. Rejected events are excluded.');

  const preset = getPreset(options.style, options.customRules);
  const intensity = options.intensity;
  const minShot = Math.max(0.55, preset.minShotSeconds * (1.4 - 0.62 * intensity));
  const maxShot = preset.maxShotSeconds * (1.38 - 0.58 * intensity);
  const targetShot = clamp(preset.targetShotSeconds * (1.3 - 0.6 * intensity), minShot, maxShot);
  const sourceUsageAcrossVariants = new Map<string, number>();
  const eventUsageAcrossVariants = new Set<string>();
  const plans: AutoMontagePlan[] = [];

  for (let variant = 1; variant <= options.variants; variant++) {
    const warnings = new Set<string>();
    const anchors = chooseMusicAnchors(musicAnalysis, durationSeconds, project.frameRate, preset, targetShot, minShot, maxShot, variant, intensity);
    if (anchors.some((anchor) => anchor.kind === 'paced')) warnings.add('Some scene anchors use even pacing because no suitable beat, downbeat, onset, or drop was available nearby.');
    const planned = placeEvents(anchors, eventCandidates, durationFrames, project, preset, options, variant, sourceUsageAcrossVariants, eventUsageAcrossVariants, targetShot, minShot, maxShot, warnings);
    for (const segment of planned) {
      sourceUsageAcrossVariants.set(segment.mediaId, (sourceUsageAcrossVariants.get(segment.mediaId) ?? 0) + 1);
      eventUsageAcrossVariants.add(`${segment.mediaId}:${segment.eventId}`);
    }
    const scoreBreakdown = scorePlan(planned, durationSeconds, targetShot, fps);
    const score = round(scoreBreakdown.highlightQuality * 0.35 + scoreBreakdown.musicAlignment * 0.25 + scoreBreakdown.sceneDiversity * 0.15 + scoreBreakdown.pacing * 0.15 + scoreBreakdown.framing * 0.05 + scoreBreakdown.duration * 0.05);
    const variantWarnings = [...warnings];
    if (planned.some((segment) => segment.eventKind === 'audio_activity')) variantWarnings.push('Audio-activity cues are technical heuristics; a high cue score is not a gameplay-quality judgment.');
    variantWarnings.push('Visual effects, transitions, and playback-speed ramps are not applied by this Phase D planner; generated clips remain editable in the timeline.');
    plans.push({
      schemaVersion: 1,
      method: 'ranked-highlight-beat-planner-v1',
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
      score,
      scoreBreakdown,
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
      ...(fade.num === '0' ? {} : { fadeIn: fade, fadeOut: fade })
    };
    videoTrack.clips.push(clip);
  }
  const targetDuration = frameTime(plan.durationFrames, project.frameRate);
  const musicFade = fadeFor(Math.min(preset.fadeSeconds * 3, 0.8), targetDuration, project.frameRate);
  audioTrack.clips.push({
    id: newId(), mediaId: music.id, start: rational(0), sourceIn: rational(0), duration: targetDuration,
    audioEnabled: true, volume: preset.musicVolume,
    ...(musicFade.num === '0' ? {} : { fadeIn: musicFade, fadeOut: musicFade })
  });
  for (const track of project.tracks) track.clips.sort((a, b) => compare(a.start, b.start));
  validateProject(project);
  if (compare(timelineDuration(project), targetDuration) !== 0) throw new AppError('MONTAGE_DURATION_MISMATCH', 'Generated timeline does not match its requested frame duration.');
  return project;
}

export async function generateAutomaticMontages(projectFile: string, outputDirectory: string, options: AutoMontageOptions): Promise<GeneratedAutoMontages> {
  const sourcePath = path.resolve(projectFile);
  const project = await loadProject(sourcePath);
  validateOptions(options);
  const music = project.media.find((asset) => asset.id === options.musicMediaId);
  if (!music || !music.hasAudio) throw new AppError('MUSIC_ASSET_REQUIRED', 'Choose an imported audio asset with an audio stream for the montage music.');
  const selectedIds = options.videoMediaIds ? new Set(options.videoMediaIds) : null;
  const videos = project.media.filter((asset) => asset.kind === 'video' && (!selectedIds || selectedIds.has(asset.id)));
  if (!videos.length) throw new AppError('VIDEO_ASSET_REQUIRED', 'Import or select at least one video asset for the montage.');
  const selected = [music, ...videos];
  for (const asset of selected) {
    let sourceStat;
    try { sourceStat = await fs.stat(asset.path); }
    catch { throw new AppError('MISSING_MEDIA', `Selected media is missing: ${asset.path}`); }
    if (!sourceStat.isFile()) throw new AppError('INVALID_MEDIA_SOURCE', `Selected media is not a regular file: ${asset.path}`);
    if (sourceStat.size !== asset.sizeBytes || sourceStat.mtime.toISOString() !== asset.modifiedAt)
      throw new AppError('SOURCE_MEDIA_CHANGED', `Selected source changed since import: ${asset.name}. Re-import or relink it before generating a montage.`);
  }
  const analysisDirectory = path.join(projectCachePath(sourcePath, project.id), 'analysis');
  const musicAnalysis = await analyzeAudio(music.path, path.join(analysisDirectory, `${music.id}.json`));
  const highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }> = [];
  for (const asset of videos) {
    let audioAnalysis: AudioAnalysis | undefined;
    let audioAnalysisError: string | undefined;
    if (asset.hasAudio) {
      try { audioAnalysis = await analyzeAudio(asset.path, path.join(analysisDirectory, `${asset.id}.json`)); }
      catch (error) { audioAnalysisError = error instanceof Error ? error.message : String(error); }
    }
    const analysis = await analyzeHighlightCues({
      mediaId: asset.id, mediaPath: asset.path, mediaKind: asset.kind,
      durationSeconds: seconds(asset.duration), game: asset.game, audioAnalysis, audioAnalysisError
    }, path.join(analysisDirectory, `cues-${asset.id}.json`));
    highlightAnalyses.push({ mediaId: asset.id, analysis });
  }
  const plans = buildAutomaticMontagePlans({ project, musicAnalysis, highlightAnalyses, options });
  const root = path.resolve(outputDirectory);
  await fs.mkdir(root, { recursive: true });
  const safeName = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 64) || 'OpenMontage';
  const runName = `${safeName}-${options.style}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const runDirectory = path.join(root, runName);
  await fs.mkdir(runDirectory, { recursive: false });
  const createdFiles: string[] = [];
  try {
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
    return { outputDirectory: runDirectory, variants };
  } catch (error) {
    await Promise.all(createdFiles.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
    await fs.rm(runDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
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
        const sourceIn = candidate.decisive - preEvent;
        const sourceEnd = sourceIn + duration;
        const assetDuration = seconds(candidate.asset.duration);
        const tolerance = 1 / fps;
        if (sourceIn < -tolerance || sourceEnd > assetDuration + tolerance) return [];
        if (candidate.start < sourceIn - tolerance || candidate.end > sourceEnd + tolerance) return [];
        const snappedSourceIn = Math.max(0, sourceIn);
        const framing = candidate.framingScore;
        const musicFit = musicFitScore(anchor, preset);
        const pacing = round(clamp(1 - Math.abs(duration - targetShot) / Math.max(maxShot, 0.1), 0, 1) * 100);
        const sameAssetPenalty = (assetCounts.get(candidate.asset.id) ?? 0) * 20 + (priorAssetUses.get(candidate.asset.id) ?? 0) * (variant > 1 ? 12 : 0);
        const sameGamePenalty = candidate.asset.game ? (gameCounts.get(candidate.asset.game.toLowerCase()) ?? 0) * 8 : 0;
        const sameKindPenalty = (kindCounts.get(candidate.event.kind) ?? 0) * 5;
        const priorEventPenalty = priorEvents.has(uniqueEventKey) ? 18 : 0;
        const usableEvent: AutoMontageSegment = {
          index: index + 1,
          mediaId: candidate.asset.id,
          mediaName: candidate.asset.name,
          sourceContentHash: candidate.asset.contentHash,
          game: candidate.asset.game,
          eventId: candidate.event.id,
          eventKind: candidate.event.kind,
          eventLabel: candidate.eventLabel,
          reviewStatus: candidate.reviewStatus,
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
          alignmentErrorFrames: Math.round((preEvent - (candidate.decisive - snappedSourceIn)) * fps),
          score: { highlight: candidate.highlightScore, musicFit, framing, pacing },
          detectors: structuredClone(candidate.event.detectors),
          explanation: ''
        };
        const utility = candidate.highlightScore * 0.53 + musicFit * 0.27 + framing * 0.06 + pacing * 0.14 - sameAssetPenalty - sameGamePenalty - sameKindPenalty - priorEventPenalty;
        return [{ usableEvent, utility, candidate, uniqueEventKey }];
      });
      if (!possible.length) { failedIndex = index; break; }
      possible.sort((a, b) => b.utility - a.utility || a.candidate.asset.name.localeCompare(b.candidate.asset.name) || a.candidate.event.id.localeCompare(b.candidate.event.id));
      const choice = possible[0];
      const segment = choice.usableEvent;
      const rationale = [
        `highlight ${segment.score.highlight}/100`,
        `${segment.anchorKind} music anchor ${segment.targetAnchorSeconds.toFixed(3)}s`,
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
      kindCounts.set(choice.candidate.event.kind, (kindCounts.get(choice.candidate.event.kind) ?? 0) + 1);
    }
    if (failedIndex < 0) {
      const maxAllowed = maxShot * 1.18 + 1 / fps;
      if (selected.some((segment) => segment.durationSeconds > maxAllowed)) {
        throw new AppError('INSUFFICIENT_HIGHLIGHT_COVERAGE', `The selected clips do not provide enough distinct analyzed highlight windows for a ${options.durationSeconds.toFixed(1)} second ${options.style} edit. Add clips or events, choose a slower style, or reduce the requested duration.`);
      }
      return selected;
    }
    if (anchors.length === 1) break;
    warnings.add('A music anchor was removed because no distinct analyzed event had enough source footage around it.');
    anchors.splice(failedIndex, 1);
  }
  throw new AppError('INSUFFICIENT_HIGHLIGHT_COVERAGE', `The selected clips do not provide enough distinct analyzed highlight windows for a ${options.durationSeconds.toFixed(1)} second ${options.style} edit. Add clips or events, choose a slower style, or reduce the requested duration.`);
}

function chooseMusicAnchors(analysis: AudioAnalysis, duration: number, fps: Rational, preset: Preset, targetShot: number, minShot: number, maxShot: number, variant: number, intensity: number): MusicAnchor[] {
  const frameRate = Number(fps.num) / Number(fps.den);
  const candidates = buildMusicAnchors(analysis, fps).filter((anchor) => anchor.time >= 0.35 && anchor.time <= duration - 0.25);
  const lead = Math.min(duration * 0.3, preset.leadSeconds * (1.25 - 0.35 * intensity));
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
    const expected = previous + desiredGap;
    if (expected > duration - Math.max(preset.tailSeconds, minShot * 0.45)) break;
    const choices = candidates.filter((candidate) => candidate.time >= previous + minShot && candidate.time <= Math.min(previous + maxShot, duration - preset.tailSeconds));
    const chosen = choices.sort((a, b) => anchorUtility(b, preset, expected, variant) - anchorUtility(a, preset, expected, variant))[0];
    const anchor = chosen ?? { time: snapToFrame(expected, fps), kind: 'paced' as const, strength: 0.18 };
    if (anchor.time <= previous || anchor.time >= duration - 0.15) break;
    anchors.push(anchor);
    previous = anchor.time;
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
  const addCandidates = (times: number[], kind: MusicAnchor['kind'], strength: number) => {
    for (const time of times) {
      if (!Number.isFinite(time) || time < 0) continue;
      const snapped = snapToFrame(time, fps);
      const energyIndex = Math.floor(time / Math.max(analysis.energyHopSeconds, 0.001));
      const energy = analysis.energyCurve[energyIndex] ?? 0.5;
      candidates.push({ time: snapped, kind, strength: round(clamp(strength * 0.72 + energy * 0.28, 0, 1)) });
    }
  };
  addCandidates(analysis.drops, 'drop', 1);
  addCandidates(analysis.downbeats, 'downbeat', 0.88);
  addCandidates(analysis.beats, 'beat', 0.62);
  addCandidates(analysis.onsets, 'onset', 0.42);
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
    musicAlignment: round(avg(segments.map((segment) => segment.score.musicFit))),
    sceneDiversity: round(assetDiversity + gameDiversity + eventDiversity),
    pacing: round(shotFit),
    framing: round(framing),
    duration: round(durationFit)
  };
}

function validateOptions(options: AutoMontageOptions): void {
  if (!options || typeof options.musicMediaId !== 'string' || !options.musicMediaId) throw new AppError('INVALID_MONTAGE_OPTIONS', 'A music media ID is required.');
  if (!['clean', 'aggressive', 'cinematic', 'velocity', 'custom'].includes(options.style)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Choose a supported montage style.');
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 1800) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Montage duration must be between 1 and 1800 seconds.');
  if (!Number.isInteger(options.variants) || options.variants < 1 || options.variants > 5) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Generate between one and five montage variants.');
  if (!Number.isFinite(options.intensity) || options.intensity < 0 || options.intensity > 1) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Cut intensity must be between 0 and 1.');
  if (!['project', 'landscape-1080p', 'portrait-1080p', 'square-1080p'].includes(options.format)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Choose a supported output format.');
  if (options.videoMediaIds && (!Array.isArray(options.videoMediaIds) || options.videoMediaIds.length < 1 || options.videoMediaIds.length > 5000 || new Set(options.videoMediaIds).size !== options.videoMediaIds.length)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Select between one and 5000 unique video assets.');
  if (options.style === 'custom') validateCustomRules(options.customRules);
  else if (options.customRules) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom rules are only valid with the custom style.');
}

function validateCustomRules(rules: AutoMontageCustomRules | undefined): asserts rules is AutoMontageCustomRules {
  if (!rules) throw new AppError('INVALID_MONTAGE_OPTIONS', 'The custom style needs a complete custom rule set.');
  const bounded = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  if (!bounded(rules.targetShotSeconds, 0.5, 30) || !bounded(rules.minShotSeconds, 0.5, 30) || !bounded(rules.maxShotSeconds, 0.5, 30) || rules.minShotSeconds > rules.targetShotSeconds || rules.targetShotSeconds > rules.maxShotSeconds)
    throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom shot lengths must satisfy 0.5 ≤ minimum ≤ target ≤ maximum ≤ 30 seconds.');
  if (!bounded(rules.leadSeconds, 0, 15) || !bounded(rules.tailSeconds, 0, 15)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom lead-in and tail context must be between 0 and 15 seconds.');
  if (!bounded(rules.cutRatio, 0.25, 0.75)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom cut position ratio must be between 0.25 and 0.75.');
  if (!bounded(rules.videoAudioVolume, 0, 1) || !bounded(rules.musicVolume, 0, 2)) throw new AppError('INVALID_MONTAGE_OPTIONS', 'Custom game audio must be between 0× and 1×; music volume must be between 0× and 2×.');
  if (!rules.anchorPreference || !['drop', 'downbeat', 'beat', 'onset'].every((key) => bounded(rules.anchorPreference[key as keyof AutoMontageCustomRules['anchorPreference']], 0, 1)))
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
  return ({ clean: 'Clean Competitive', aggressive: 'Aggressive Gaming', cinematic: 'Cinematic', velocity: 'Velocity Pacing', custom: 'Custom' })[style];
}

function labelForEvent(event: AnalysisEvent): string {
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

function candidatePriority(kind: MusicAnchor['kind']): number { return ({ drop: 5, downbeat: 4, beat: 3, onset: 2, paced: 1 })[kind]; }

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
