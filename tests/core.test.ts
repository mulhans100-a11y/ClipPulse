import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addClip, addTrack, createProject, findMissingMedia, getImportRoots, getProjectHistory, importMedia, loadProject, redoProject, relinkMedia, removeClip, saveProject, searchMedia, setClipAudio, setClipEffects, setImportRootWatching, splitClip, timelineDuration, trimClip, undoProject, updateMediaMetadata, updateProjectProfile, updateTrackSettings } from '../src/core/project';
import { analyzeAudio, readCachedAudioAnalysis } from '../src/core/audioAnalysis';
import { analyzeHighlightCues, type DetectorPlugin } from '../src/core/highlightAnalysis';
import { classifyValorantHudText, detectValorantKillFeedChanges, legacyValorantTextMatch } from '../src/core/gameplay/valorant';
import { evaluateHighlightDataset } from '../src/core/analysisEvaluation';
import { buildAutomaticMontagePlans, materializeAutomaticMontageProject } from '../src/core/autoMontage';
import { gameRuleCacheKey, matchGameEvent } from '../src/core/gameRules';
import { renderTimelineFrame, timelinePreviewCacheKey, timelinePreviewRangeAt } from '../src/core/timelinePreview';
import { exportVideo } from '../src/core/export';
import { prunePreviewCache } from '../src/core/previewCache';
import { ffmpegCompatibilityProblems, runCommand } from '../src/core/ffmpeg';
import { libraryDatabasePath, MediaLibrary } from '../src/core/library';
import { watchFolder } from '../src/core/folderWatcher';
import { medalCaptureFolderPreset } from '../src/core/medal';
import { waveformWidthForDuration } from '../src/core/waveform';
import { add, compare, decimal, frameTime, parseDecimal, rational, toFrame } from '../src/core/time';
import { audioClipBeatOffsets, audioClipDownbeatOffsets, audioClipDropOffsets, collectTimelineSnapPoints, snapTimelineTime } from '../src/core/timelineSnapping';
import { mediaVirtualWindow } from '../src/renderer/ui/mediaVirtualization';
import { clipAudioSpeedChunks, clipSetptsExpression, clipSourceDuration, clipSourceOffsetAt } from '../src/core/clipEffects';
import { maskPathPoints } from '../src/core/maskPath';
import type { AudioAnalysis, HighlightAnalysis, MediaAsset, Project, TimelineClip } from '../src/core/types';

const scratch: string[] = [];
test.after(async () => { for (const directory of scratch) await rm(directory, { recursive: true, force: true }); });

test('rational time arithmetic stays exact across non-integer frame rates', () => {
  const fps = rational(30000, 1001);
  const oneFrame = frameTime(1, fps);
  assert.deepEqual(oneFrame, { num: '1001', den: '30000' });
  assert.equal(toFrame(add(oneFrame, oneFrame), fps), 2);
  assert.deepEqual(parseDecimal('5/2'), { num: '5', den: '2' });
  assert.equal(decimal(parseDecimal('12.500000')), '12.5');
  assert.equal(compare(rational(1, 3), rational(2, 5)), -1);
});

test('FFmpeg compatibility diagnostics require supported versions, drawtext, and libx264', () => {
  assert.deepEqual(ffmpegCompatibilityProblems(
    'ffmpeg version 9.0.2', 'ffprobe version 9.0.2', ' ... drawtext V->V Draw text', ' ... libx264 V.... H.264 encoder'
  ), []);
  const problems = ffmpegCompatibilityProblems('ffmpeg version 5.1.2', 'ffprobe version 5.1.2', 'filters without the required text filter', 'encoders without the required H.264 encoder');
  assert.ok(problems.some((problem) => problem.includes('ffmpeg 5 is too old')));
  assert.ok(problems.some((problem) => problem.includes('drawtext')));
  assert.ok(problems.some((problem) => problem.includes('libx264')));
});

test('mask paths flatten cubic and quadratic Bezier segments into stable tracking points', () => {
  const points = maskPathPoints('M 0.1 0.1 C 0.1 0 0.5 0 0.5 0.1 Q 0.8 0.2 0.5 0.5 L 0.1 0.5 Z');
  assert.equal(points.length, 14);
  assert.deepEqual(points[0], [0.1, 0.1]);
  assert.deepEqual(points.at(-1), [0.1, 0.5]);
  assert.throws(() => maskPathPoints('M 0 0 L 1 1 L 1 0'), /closed shape/i);
});

test('Medal capture preset follows the Windows system drive and stays opt-in elsewhere', () => {
  assert.equal(medalCaptureFolderPreset('win32', 'D:'), 'D:\\Medal');
  assert.equal(medalCaptureFolderPreset('win32', undefined), 'C:\\Medal');
  assert.equal(medalCaptureFolderPreset('linux', undefined), null);
});

test('waveform cache sizing covers short sources and caps large source images', () => {
  assert.equal(waveformWidthForDuration(1), 640);
  assert.equal(waveformWidthForDuration(8), 3072);
  assert.equal(waveformWidthForDuration(120), 16_384);
  assert.equal(waveformWidthForDuration(Number.NaN), 640);
});

test('media library upgrades a v1 database and preserves the default unranked score', () => {
  const directory = mkdtemp(path.join(os.tmpdir(), 'openmontage-library-migration-'));
  return directory.then(async (root) => {
    scratch.push(root);
    const databasePath = path.join(root, 'legacy.sqlite');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE media (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('video','audio')), duration_num TEXT NOT NULL, duration_den TEXT NOT NULL,
      width INTEGER, height INTEGER, fps_num TEXT, fps_den TEXT, has_audio INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE,
      thumbnail_path TEXT, imported_at TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, game TEXT
    ); PRAGMA user_version=1;`);
    legacy.close();

    const library = new MediaLibrary(databasePath);
    const asset: MediaAsset = {
      id: 'rating-migration', path: path.join(root, 'clip.mp4'), name: 'clip.mp4', kind: 'video',
      duration: rational(1), width: 320, height: 180, frameRate: rational(30), hasAudio: false,
      sizeBytes: 1, modifiedAt: '', contentHash: 'rating-migration-hash', importedAt: ''
    };
    try {
      library.upsert(asset);
      assert.equal(library.findById(asset.id)?.rating, 0);
      library.updatePreferences(asset.id, { rating: 4 });
      assert.equal(library.findById(asset.id)?.rating, 4);
    } finally { library.close(); }
  });
});

test('timeline snap points include clip edges and analyzed beats within an audio source range', () => {
  const clip: TimelineClip = { id: 'music-clip', mediaId: 'music', start: rational(2), sourceIn: rational(1), duration: rational(2), audioEnabled: true, volume: 1 };
  const project: Project = {
    schemaVersion: 1, id: 'project', name: 'Beat test', createdAt: '', updatedAt: '', frameRate: rational(30), width: 640, height: 360,
    media: [{ id: 'music', path: 'music.wav', name: 'music.wav', kind: 'audio', duration: rational(5), hasAudio: true, sizeBytes: 1, modifiedAt: '', contentHash: 'music-hash', importedAt: '' }],
    tracks: [{ id: 'audio-track', name: 'A1', kind: 'audio', muted: false, locked: false, clips: [clip] }]
  };
  const analysis = { method: 'spectral-flux-dynamic-beat-v4' as const, sampleRate: 11025, hopSeconds: 0.02, durationSeconds: 5, beats: [0.5, 1, 1.5, 2, 2.5, 3], downbeats: [1, 1.5, 2.5], energyHopSeconds: 1, energyCurve: [0, 0.5, 1], energySections: [], drops: [1.75], onsets: [], bpmHypotheses: [] };
  assert.deepEqual(audioClipBeatOffsets(clip, analysis), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(audioClipDownbeatOffsets(clip, analysis), [0, 0.25, 0.75]);
  assert.deepEqual(audioClipDropOffsets(clip, analysis), [0.375]);
  assert.deepEqual(collectTimelineSnapPoints(project, { music: analysis }), [2, 2.5, 3, 3.5, 4]);
  assert.equal(snapTimelineTime(project, 3.53, 96, { music: analysis }), 3.5);
  assert.equal(snapTimelineTime(project, 3.8, 96, { music: analysis }), 3.8, 'snap only catches positions near a beat or clip edge');
});

test('automatic montage planner aligns reviewed highlights to music, diversifies variants, and preserves the source timeline', () => {
  const videos: MediaAsset[] = Array.from({ length: 7 }, (_item, index) => ({
    id: `montage-video-${index}`, path: `C:\\media\\clip-${index}.mp4`, name: `Clip ${index + 1}.mp4`, kind: 'video',
    duration: rational(20), width: 1280, height: 720, frameRate: rational(60), hasAudio: true,
    sizeBytes: 1000, modifiedAt: '', contentHash: `montage-video-hash-${index}`, importedAt: '',
    game: index % 2 ? 'Valorant' : 'Counter-Strike', rating: index === 1 ? 5 : 0,
    ...(index === 0 ? { analysisEventReviews: [{ eventId: `event-${index}`, detectorIds: ['test'], status: 'rejected' as const, startSeconds: 7.8, decisiveSeconds: 8, endSeconds: 8.3, updatedAt: '' }] } : {}),
    ...(index === 1 ? { analysisEventReviews: [{ eventId: `event-${index}`, detectorIds: ['test'], status: 'accepted' as const, startSeconds: 8.05, decisiveSeconds: 8.25, endSeconds: 8.55, updatedAt: '' }] } : {}),
    ...(index === 3 ? { analysisEventReviews: [{ eventId: 'feed-change', detectorIds: ['test'], status: 'corrected' as const, correctedEventType: 'kill' as const, startSeconds: 9.8, decisiveSeconds: 10, endSeconds: 10.2, updatedAt: '' }] } : {})
  }));
  const music: MediaAsset = { id: 'montage-music', path: 'C:\\media\\music.wav', name: 'music.wav', kind: 'audio', duration: rational(20), hasAudio: true, sizeBytes: 1000, modifiedAt: '', contentHash: 'montage-music-hash', importedAt: '' };
  const project: Project = {
    schemaVersion: 1, id: 'montage-source', name: 'Montage source', createdAt: '', updatedAt: '', frameRate: rational(30), width: 640, height: 360,
    media: [...videos, music], tracks: [
      { id: 'source-v1', name: 'V1', kind: 'video', muted: false, locked: false, clips: [{ id: 'source-edit', mediaId: videos[0].id, start: rational(0), sourceIn: rational(0), duration: rational(2), audioEnabled: true, volume: 1 }] },
      { id: 'source-a1', name: 'A1', kind: 'audio', muted: false, locked: false, clips: [] }
    ]
  };
  const sourceBefore = JSON.stringify(project);
  const musicAnalysis: AudioAnalysis = {
    method: 'spectral-flux-dynamic-beat-v4', sampleRate: 11025, hopSeconds: 0.02, durationSeconds: 20, estimatedBpm: 120,
    bpmHypotheses: [{ bpm: 120, score: 0.9 }], beatPhaseSeconds: 0, beats: Array.from({ length: 40 }, (_value, index) => index * 0.5), accents: [2, 4, 8, 10],
    meter: { beatsPerBar: 4, denominator: 4, downbeatPhase: 0, confidence: 0.7 }, downbeats: Array.from({ length: 10 }, (_value, index) => index * 2),
    energyHopSeconds: 1, energyCurve: Array(20).fill(0.75), energySections: [], drops: [6, 12], onsets: [],
    structureEvents: [
      { type: 'strong_accent', timeSeconds: 4, confidence: 0.25, strength: 0.2, signals: ['weak test accent'] },
      { type: 'strong_accent', timeSeconds: 10, confidence: 0.95, strength: 0.95, signals: ['strong test accent'] }
    ]
  };
  const highlightAnalyses: Array<{ mediaId: string; analysis: HighlightAnalysis }> = videos.map((asset, index) => {
    const decisiveSeconds = 8 + index * 0.35;
    const event = {
      id: `event-${index}`, mediaId: asset.id, kind: 'gameplay_event' as const,
      startSeconds: decisiveSeconds - 0.2, decisiveSeconds, endSeconds: decisiveSeconds + 0.25,
      confidence: 0.86, interestingness: 0.84, rankScore: 82 + index % 3, rank: index + 1,
      eventType: 'headshot' as const, evidenceLevel: 'explicit' as const,
      detectors: [{ detectorId: 'test-hud', version: '1', modality: 'text' as const, confidence: 0.86, evidence: { gameEvent: 'headshot' } }]
    };
    const quiet = { ...event, id: `quiet-${index}`, eventType: 'quiet_passage' as const, evidenceLevel: 'heuristic' as const, rankScore: 99 };
    const feedChange = { ...event, id: 'feed-change', eventType: 'kill_feed_change' as const, evidenceLevel: 'heuristic' as const, rankScore: 100 };
    const events = [event, ...(index === 2 ? [quiet] : []), ...(index === 3 ? [feedChange] : [])];
    return { mediaId: asset.id, analysis: { method: 'heuristic-detector-pipeline-v1', durationSeconds: 20, scoreWeights: { confidence: 0.4, interestingness: 0.4, corroboration: 0.2 }, detectors: [], warnings: [], events } };
  });
  const plans = buildAutomaticMontagePlans({
    project, musicAnalysis, highlightAnalyses,
    options: { musicMediaId: music.id, videoMediaIds: videos.map((asset) => asset.id), style: 'clean', durationSeconds: 15, variants: 3, intensity: 0.5, format: 'portrait-1080p' }
  });
  assert.equal(plans.length, 3);
  assert.ok(plans.every((plan) => plan.durationSeconds === 15 && plan.scoreBreakdown.duration === 100));
  assert.ok(plans.every((plan) => plan.segments.length >= 3));
  assert.ok(plans.every((plan) => plan.segments.every((segment) => segment.alignmentErrorFrames === 0)));
  assert.ok(plans[0].segments.every((segment) => segment.mediaId !== videos[0].id), 'rejected events are excluded from planning');
  assert.ok(plans[0].segments.every((segment) => segment.eventType !== 'quiet_passage'), 'unreviewed low-activity passages are not used as montage highlights');
  assert.ok(plans[0].segments.every((segment) => segment.eventId !== 'feed-change' || segment.eventType === 'kill'), 'a user correction is applied to a possible feed-change cue before planning');
  assert.ok(plans[0].segments.some((segment) => segment.eventId === 'feed-change' && segment.eventType === 'kill'), 'a manually corrected event remains eligible for montage selection');
  assert.ok(plans[0].segments.some((segment) => segment.eventType === 'headshot'), 'semantic event types pass through to the generated plan');
  assert.ok(plans[0].segments.some((segment) => segment.anchorKind === 'accent' || segment.anchorKind === 'drop'), 'strong accents and drops are preferred musical edit anchors');
  assert.ok(plans[0].segments.some((segment) => segment.anchorKind === 'accent' && segment.anchorStrength > 0.8), 'high-strength structured accents retain their signal strength in montage alignment');
  assert.ok(plans[0].segments.some((segment) => segment.reviewStatus === 'accepted'), 'accepted review state contributes to event provenance');
  assert.notDeepEqual(plans[0].segments.map((segment) => segment.eventId), plans[1].segments.map((segment) => segment.eventId), 'later variants prefer different events from the same source pool');
  for (const segment of plans[0].segments) {
    assert.ok(Math.abs((segment.sourceDecisiveSeconds - segment.sourceInSeconds) - (segment.targetAnchorSeconds - segment.timelineStartSeconds)) < 1e-8, 'the selected event time maps exactly to its music anchor');
  }
  const generated = materializeAutomaticMontageProject(project, plans[0]);
  assert.equal(generated.width, 1080);
  assert.equal(generated.height, 1920);
  assert.notEqual(generated.id, project.id);
  assert.equal(decimal(timelineDuration(generated)), '15');
  assert.equal(JSON.stringify(project), sourceBefore, 'building a variant does not mutate the source project');
  assert.deepEqual(project.tracks[0].clips.map((clip) => clip.id), ['source-edit']);
  const customRules = { targetShotSeconds: 3, minShotSeconds: 2, maxShotSeconds: 5, leadSeconds: 1, tailSeconds: 1, cutRatio: 0.6, videoAudioVolume: 0.1, musicVolume: 0.65, anchorPreference: { drop: 1, downbeat: 0.8, beat: 0.4, onset: 0.2 } };
  const customPlan = buildAutomaticMontagePlans({ project, musicAnalysis, highlightAnalyses, options: { musicMediaId: music.id, style: 'custom', durationSeconds: 6, variants: 1, intensity: 0.5, format: 'project', customRules } })[0];
  const customProject = materializeAutomaticMontageProject(project, customPlan);
  assert.equal(customProject.tracks.find((track) => track.kind === 'audio')!.clips[0].volume, 0.65, 'custom rules change the rendered music level');
  assert.equal(customProject.tracks.find((track) => track.kind === 'video')!.clips[0].volume, 0.1, 'custom rules change the game-audio mix');
  const smoothPlan = buildAutomaticMontagePlans({ project, musicAnalysis, highlightAnalyses, options: { musicMediaId: music.id, style: 'smooth', durationSeconds: 6, variants: 1, intensity: 0.4, format: 'project' } })[0];
  assert.equal(smoothPlan.style, 'smooth', 'the smooth pacing preset is supported by the shared core');
});

test('automatic montage variants assemble into a continuous editable timeline that exports a playable MP4', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-auto-montage-'));
  scratch.push(directory);
  const videoPath = path.join(directory, 'gameplay.mp4');
  const musicPath = path.join(directory, 'music.wav');
  const outputPath = path.join(directory, 'auto-montage.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', videoPath]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-c:a', 'pcm_s16le', musicPath]);
  const video: MediaAsset = { id: 'export-video', path: videoPath, name: 'gameplay.mp4', kind: 'video', duration: rational(12), width: 320, height: 180, frameRate: rational(30), hasAudio: false, sizeBytes: (await stat(videoPath)).size, modifiedAt: '', contentHash: 'export-video-hash', importedAt: '' };
  const music: MediaAsset = { id: 'export-music', path: musicPath, name: 'music.wav', kind: 'audio', duration: rational(10), hasAudio: true, sizeBytes: (await stat(musicPath)).size, modifiedAt: '', contentHash: 'export-music-hash', importedAt: '' };
  const project: Project = { schemaVersion: 1, id: 'export-source', name: 'Export source', createdAt: '', updatedAt: '', frameRate: rational(30), width: 320, height: 180, media: [video, music], tracks: [] };
  const musicAnalysis: AudioAnalysis = {
    method: 'spectral-flux-dynamic-beat-v4', sampleRate: 11025, hopSeconds: 0.02, durationSeconds: 10, estimatedBpm: 120,
    bpmHypotheses: [{ bpm: 120, score: 0.9 }], beatPhaseSeconds: 0, beats: Array.from({ length: 20 }, (_value, index) => index * 0.5),
    downbeats: [0, 2, 4, 6, 8], energyHopSeconds: 1, energyCurve: Array(10).fill(0.8), energySections: [], drops: [6], onsets: []
  };
  const events = [
    { id: 'early', mediaId: video.id, kind: 'gameplay_event' as const, startSeconds: 2.8, decisiveSeconds: 3, endSeconds: 3.2, confidence: 0.9, interestingness: 0.9, rankScore: 96, rank: 1, detectors: [{ detectorId: 'test', version: '1', modality: 'text' as const, confidence: 0.9, evidence: { gameEvent: 'headshot' } }] },
    { id: 'late', mediaId: video.id, kind: 'gameplay_event' as const, startSeconds: 7.8, decisiveSeconds: 8, endSeconds: 8.2, confidence: 0.85, interestingness: 0.85, rankScore: 85, rank: 2, detectors: [{ detectorId: 'test', version: '1', modality: 'text' as const, confidence: 0.85, evidence: { gameEvent: 'elimination' } }] }
  ];
  const plans = buildAutomaticMontagePlans({
    project, musicAnalysis,
    highlightAnalyses: [{ mediaId: video.id, analysis: { method: 'heuristic-detector-pipeline-v1', durationSeconds: 12, scoreWeights: { confidence: 0.4, interestingness: 0.4, corroboration: 0.2 }, detectors: [], warnings: [], events } }],
    options: { musicMediaId: music.id, videoMediaIds: [video.id], style: 'clean', durationSeconds: 10, variants: 1, intensity: 0.5, format: 'project' }
  });
  assert.equal(plans[0].segments.length, 2);
  const generated = materializeAutomaticMontageProject(project, plans[0]);
  const rendered = await exportVideo(generated, { outputPath });
  assert.equal(decimal(rendered.duration), '10');
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,width,height,nb_read_frames', '-of', 'json', outputPath]);
  const info = JSON.parse(stdout);
  const outputVideo = info.streams.find((stream: any) => stream.codec_type === 'video');
  assert.equal(outputVideo.width, 320);
  assert.equal(outputVideo.height, 180);
  assert.equal(outputVideo.nb_read_frames, '300');
  assert.ok(info.streams.some((stream: any) => stream.codec_type === 'audio'));
  assert.ok((await stat(outputPath)).size > 10_000);
});

test('range previews reuse unaffected ranges, preserve timeline AV sync, and cancel stale renders', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-range-preview-'));
  scratch.push(directory);
  const videoPath = path.join(directory, 'synthetic-av.mp4');
  await runCommand('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath
  ]);
  const sourceStat = await stat(videoPath);
  const asset: MediaAsset = { id: 'range-av', path: videoPath, name: 'synthetic-av.mp4', kind: 'video', duration: rational(12), width: 320, height: 180, frameRate: rational(30), hasAudio: true, sizeBytes: sourceStat.size, modifiedAt: sourceStat.mtime.toISOString(), contentHash: 'range-av-fixture-v1', importedAt: '' };
  const project: Project = {
    schemaVersion: 1, id: 'range-preview-project', name: 'Range preview', createdAt: '', updatedAt: '',
    frameRate: rational(30), width: 1280, height: 720, media: [asset],
    tracks: [{ id: 'video-1', name: 'V1', kind: 'video', muted: false, solo: false, locked: false, volume: 1, clips: [
      { id: 'before-range', mediaId: asset.id, start: rational(0), sourceIn: rational(0), duration: rational(2), audioEnabled: true, volume: 1 },
      { id: 'crossing-range', mediaId: asset.id, start: rational(2), sourceIn: rational(2), duration: rational(10), audioEnabled: true, volume: 1 }
    ] }]
  };
  const requested = rational(5);
  const range = timelinePreviewRangeAt(project, requested);
  assert.deepEqual(range, { start: rational(5), duration: rational(5) }, 'preview ranges are aligned to exact frame boundaries');
  const selectedRange = { start: rational(4), duration: rational(3) };
  const originalKey = timelinePreviewCacheKey(project, selectedRange);
  const nonRenderEdit = structuredClone(project);
  nonRenderEdit.tracks[0].name = 'Renamed track'; nonRenderEdit.tracks[0].locked = true; nonRenderEdit.tracks[0].clips[1].id = 'renamed-clip';
  assert.equal(timelinePreviewCacheKey(nonRenderEdit, selectedRange), originalKey, 'editor labels, locks, and identifiers do not invalidate rendered pixels');
  const outsideEdit = structuredClone(project);
  outsideEdit.tracks[0].clips[0].transform = { scale: 1.1, x: 0, y: 0, rotationDegrees: 0 };
  assert.equal(timelinePreviewCacheKey(outsideEdit, selectedRange), originalKey, 'an edit to a clip outside this range preserves its cache key');
  const insideEdit = structuredClone(project);
  insideEdit.tracks[0].clips[1].transform = { scale: 1.1, x: 0, y: 0, rotationDegrees: 0 };
  assert.notEqual(timelinePreviewCacheKey(insideEdit, selectedRange), originalKey, 'an edit to a clip intersecting this range invalidates it');

  const previewPath = path.join(directory, 'range-preview.mp4');
  const preview = await exportVideo(project, { outputPath: previewPath, range: selectedRange, quality: 'preview' });
  assert.equal(decimal(preview.duration), '3');
  assert.equal(decimal(preview.frameRate), '24');
  const previewProbe = JSON.parse((await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,start_time,duration', '-of', 'json', previewPath])).stdout);
  const previewVideo = previewProbe.streams.find((stream: any) => stream.codec_type === 'video');
  const previewAudio = previewProbe.streams.find((stream: any) => stream.codec_type === 'audio');
  assert.deepEqual([previewVideo.width, previewVideo.height], [960, 540]);
  assert.ok(previewAudio, 'range preview keeps the corresponding audio stream');
  assert.ok(Math.abs(Number(previewVideo.start_time) - Number(previewAudio.start_time)) < 0.05, 'audio and video start in sync after range extraction');
  assert.ok(Math.abs(Number(previewProbe.format.duration) - 3) < 0.08, 'range duration stays aligned to the requested timeline window');

  const controller = new AbortController();
  const cancelPath = path.join(directory, 'cancelled-preview.mp4');
  const pending = exportVideo(project, { outputPath: cancelPath, range: selectedRange, quality: 'preview', signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(pending, (error: any) => error.code === 'PROCESS_ABORTED');
  await assert.rejects(stat(cancelPath), (error: any) => error.code === 'ENOENT');
  const leftovers = (await readdir(directory)).filter((name) => name.includes('cancelled-preview') && name.endsWith('.rendering.mp4'));
  assert.deepEqual(leftovers, [], 'cancelled FFmpeg renders remove their temporary output');
});

test('preview cache pruning enforces file count, byte, and age budgets while retaining the active entry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-preview-cache-'));
  scratch.push(directory);
  const active = path.join(directory, 'active.mp4');
  const newest = path.join(directory, 'newest.mp4');
  const small = path.join(directory, 'small.mp4');
  const expired = path.join(directory, 'expired.mp4');
  await writeFile(active, Buffer.alloc(50));
  await writeFile(newest, Buffer.alloc(40));
  await writeFile(small, Buffer.alloc(20));
  await writeFile(expired, Buffer.alloc(5));
  const now = Date.now();
  await utimes(active, new Date(now - 300), new Date(now - 300));
  await utimes(newest, new Date(now), new Date(now));
  await utimes(small, new Date(now - 100), new Date(now - 100));
  await utimes(expired, new Date(now - 60_000), new Date(now - 60_000));
  const removed = await prunePreviewCache(directory, active, { maxFiles: 2, maxBytes: 80, maxAgeMs: 10_000, matches: (name) => name.endsWith('.mp4') });
  assert.ok(removed.some((file) => file.endsWith('newest.mp4')), 'the cache byte cap excludes a newer but too-large entry');
  assert.ok(removed.some((file) => file.endsWith('expired.mp4')), 'expired cache files are removed');
  assert.equal((await stat(active)).size, 50, 'the active preview stays available even when it alone exceeds normal recency');
  assert.equal((await stat(small)).size, 20, 'a recent entry that fits the remaining budget is retained');
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.mp4')).length, 2, 'the retained cache stays inside the configured file limit');
});

test('media library virtual window bounds rendered rows and preserves total scroll height', () => {
  assert.deepEqual(mediaVirtualWindow(1000, 6400, 640), { start: 95, end: 115, topPadding: 6080, bottomPadding: 56640 });
  assert.deepEqual(mediaVirtualWindow(10, 100000, 640), { start: 0, end: 10, topPadding: 0, bottomPadding: 0 });
  assert.deepEqual(mediaVirtualWindow(0, 0, 640), { start: 0, end: 0, topPadding: 0, bottomPadding: 0 });
});

test('project undo and redo survive reloads, skip no-op saves, and clear a redo branch after edits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-history-'));
  scratch.push(directory);
  const projectFile = path.join(directory, 'history.omproj');
  const created = await createProject(projectFile);
  await saveProject(projectFile, structuredClone(created));
  assert.deepEqual(await getProjectHistory(projectFile), { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });

  await addTrack(projectFile, 'video', 'V2');
  assert.equal((await getProjectHistory(projectFile)).canUndo, true);
  const undone = await undoProject(projectFile);
  assert.equal(undone.tracks.filter((track) => track.kind === 'video').length, 1);
  assert.deepEqual(await getProjectHistory(projectFile), { canUndo: false, canRedo: true, undoCount: 0, redoCount: 1 });

  await loadProject(projectFile); // A fresh read stands in for reopening the editor.
  const redone = await redoProject(projectFile);
  assert.equal(redone.tracks.filter((track) => track.kind === 'video').length, 2);
  assert.equal((await getProjectHistory(projectFile)).canRedo, false);

  await undoProject(projectFile);
  await addTrack(projectFile, 'audio', 'A2');
  const branched = await getProjectHistory(projectFile);
  assert.equal(branched.canUndo, true);
  assert.equal(branched.canRedo, false, 'a new edit removes the abandoned redo branch');
});

test('project profile changes validate dimensions and frame rate and participate in undo history', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-profile-'));
  scratch.push(directory);
  const projectFile = path.join(directory, 'profile.omproj');
  const initial = await createProject(projectFile);
  const updated = await updateProjectProfile(projectFile, { name: 'Cinematic Cut', width: 1280, height: 720, frameRate: rational(30000, 1001) });
  assert.equal(updated.name, 'Cinematic Cut');
  assert.equal(updated.width, 1280);
  assert.equal(updated.height, 720);
  assert.deepEqual(updated.frameRate, rational(30000, 1001));
  assert.equal((await getProjectHistory(projectFile)).canUndo, true);

  const undone = await undoProject(projectFile);
  assert.equal(undone.name, initial.name);
  assert.equal(undone.width, 1920);
  assert.equal(undone.height, 1080);
  assert.deepEqual(undone.frameRate, rational(60));
  const redone = await redoProject(projectFile);
  assert.equal(redone.name, 'Cinematic Cut');
  assert.deepEqual(redone.frameRate, rational(30000, 1001));

  await assert.rejects(updateProjectProfile(projectFile, { width: 1279 }), /even output dimensions/);
  const stillValid = await loadProject(projectFile);
  assert.equal(stillValid.width, 1280, 'invalid profile edits leave the saved project unchanged');
});

test('imports, backs up, trims, splits and exports real media without modifying its source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-integration-'));
  scratch.push(directory);
  const source = path.join(directory, 'synthetic.mp4');
  const exactDuplicate = path.join(directory, 'synthetic-copy.mp4');
  const projectFile = path.join(directory, 'cut.omproj');
  const output = path.join(directory, 'render.mp4');
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
  ]);
  const before = createHash('sha256').update(await readFile(source)).digest('hex');
  await copyFile(source, exactDuplicate);

  await createProject(projectFile, { name: 'Integration cut', frameRate: rational(30), width: 640, height: 360 });
  const imported = await importMedia(projectFile, [source, exactDuplicate]);
  assert.equal(imported.added.length, 1, 'exact duplicate content is indexed once');
  assert.equal(imported.duplicates.length, 1);
  assert.ok(imported.added[0].thumbnailPath);
  assert.ok((await stat(imported.added[0].thumbnailPath!)).size > 0);

  const project = await loadProject(projectFile);
  const videoTrack = project.tracks.find((track) => track.kind === 'video')!;
  const inserted = await addClip(projectFile, imported.added[0].id, videoTrack.id, rational(1, 2), rational(1), rational(2));
  const insertedClip = inserted.tracks.find((track) => track.id === videoTrack.id)!.clips[0];
  const trimmed = await trimClip(projectFile, insertedClip.id, { sourceIn: rational(1, 2), duration: rational(5, 2) });
  const originalClip = trimmed.tracks.find((track) => track.id === videoTrack.id)!.clips[0];
  assert.deepEqual(originalClip.sourceIn, rational(1, 2));
  const split = await splitClip(projectFile, originalClip.id, rational(3, 2));
  const splitClips = split.tracks.find((track) => track.id === videoTrack.id)!.clips;
  assert.equal(splitClips.length, 2);
  assert.deepEqual(splitClips.map((clip) => clip.duration), [rational(1), rational(3, 2)]);
  await removeClip(projectFile, splitClips[1].id);

  const multiTrackProject = await addTrack(projectFile, 'video', 'V2');
  assert.equal(multiTrackProject.tracks.filter((track) => track.kind === 'video').length, 2);
  const renderedProject = await loadProject(projectFile);
  const result = await exportVideo(renderedProject, { outputPath: output });
  assert.equal(decimal(result.duration), '1.5');
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate,nb_read_frames', '-of', 'json', output]);
  const info = JSON.parse(stdout);
  const video = info.streams.find((stream: any) => stream.codec_type === 'video');
  const audio = info.streams.find((stream: any) => stream.codec_type === 'audio');
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(video.nb_read_frames, '45');
  assert.ok(audio, 'source audio is included in the rendered timeline');
  assert.ok((await stat(output)).size > 10_000);
  assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), before, 'source file remains byte-for-byte unchanged');
});

test('clip audio fades are validated, persisted, and audible in the rendered output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-fades-'));
  scratch.push(directory);
  const source = path.join(directory, 'tone.wav');
  const projectFile = path.join(directory, 'fade.omproj');
  const output = path.join(directory, 'fade.mp4');
  const rawAudio = path.join(directory, 'fade-samples.raw');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:a', 'pcm_s16le', source]);
  await createProject(projectFile, { frameRate: rational(24), width: 320, height: 180 });
  const imported = await importMedia(projectFile, [source]);
  const audioTrack = (await loadProject(projectFile)).tracks.find((track) => track.kind === 'audio')!;
  const withClip = await addClip(projectFile, imported.added[0].id, audioTrack.id, rational(0), rational(0), rational(2));
  const clip = withClip.tracks.find((track) => track.id === audioTrack.id)!.clips[0];
  const faded = await setClipAudio(projectFile, clip.id, { fadeIn: rational(1), fadeOut: rational(1) });
  const fadedClip = faded.tracks.find((track) => track.id === audioTrack.id)!.clips[0];
  assert.deepEqual(fadedClip.fadeIn, rational(1));
  assert.deepEqual(fadedClip.fadeOut, rational(1));
  await assert.rejects(setClipAudio(projectFile, clip.id, { fadeIn: rational(3) }), /cannot exceed the clip duration/);
  await exportVideo(faded, { outputPath: output });
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', output, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', rawAudio]);
  const early = await rawRms(rawAudio, 0.1, 0.1);
  const peak = await rawRms(rawAudio, 0.9, 0.1);
  const late = await rawRms(rawAudio, 1.85, 0.1);
  assert.ok(peak > early * 3, `fade in should raise audio level, early=${early}, peak=${peak}`);
  assert.ok(peak > late * 3, `fade out should lower audio level, late=${late}, peak=${peak}`);
});

test('Phase E speed ramps, shared preview/export effects, titles, transitions, LUTs, and audio automation render consistently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-effects-'));
  scratch.push(directory);
  const red = path.join(directory, 'red.mp4'), blue = path.join(directory, 'blue.mp4');
  const music = path.join(directory, 'music.wav'), dialogue = path.join(directory, 'dialogue.wav');
  const lut = path.join(directory, 'identity.cube'), projectFile = path.join(directory, 'effects.omproj');
  const mixedOutput = path.join(directory, 'effects-mixed.mp4'), isolatedOutput = path.join(directory, 'effects-isolated.mp4'), noDuckOutput = path.join(directory, 'effects-no-duck.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', music]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', dialogue]);
  await writeFile(lut, 'TITLE "Identity"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  await createProject(projectFile, { frameRate: rational(24), width: 320, height: 180 });
  const imported = await importMedia(projectFile, [red, blue, music, dialogue]);
  const tracks = await addTrack(projectFile, 'video', 'V2');
  const audioTracks = await addTrack(projectFile, 'audio', 'A2');
  const videoTracks = tracks.tracks.filter((track) => track.kind === 'video');
  const audio = audioTracks.tracks.filter((track) => track.kind === 'audio');
  const redClip = (await addClip(projectFile, imported.added.find((asset) => asset.path === red)!.id, videoTracks[0].id, rational(0), rational(0), rational(5, 2))).tracks.find((track) => track.id === videoTracks[0].id)!.clips[0];
  const blueClip = (await addClip(projectFile, imported.added.find((asset) => asset.path === blue)!.id, videoTracks[1].id, rational(0), rational(0), rational(5, 2))).tracks.find((track) => track.id === videoTracks[1].id)!.clips[0];
  const musicClip = (await addClip(projectFile, imported.added.find((asset) => asset.path === music)!.id, audio[0].id, rational(0), rational(0), rational(5, 2))).tracks.find((track) => track.id === audio[0].id)!.clips[0];
  const dialogueClip = (await addClip(projectFile, imported.added.find((asset) => asset.path === dialogue)!.id, audio[1].id, rational(0), rational(0), rational(3, 5))).tracks.find((track) => track.id === audio[1].id)!.clips[0];
  await setClipEffects(projectFile, redClip.id, {
    playbackRate: rational(1), speedKeyframes: [{ time: rational(0), rate: rational(1) }, { time: rational(5, 2), rate: rational(2) }],
    transform: { scale: 0.8, x: 12, y: -4, rotationDegrees: 0 },
    color: { brightness: 0.08, contrast: 1.1, saturation: 0.8, lutPath: lut },
    keyframes: [{ property: 'opacity', time: rational(0), value: 0.65 }, { property: 'opacity', time: rational(5, 2), value: 0.9 }],
    transitionIn: { type: 'dissolve', duration: rational(2, 5) },
    title: { text: 'Ranked: win!', fontSize: 24, color: '#ffffff', x: 0.5, y: 0.1, start: rational(0), duration: rational(2), box: true }
  });
  await setClipEffects(projectFile, blueClip.id, { transitionIn: { type: 'wipe-left', duration: rational(7, 10) } });
  await setClipAudio(projectFile, musicClip.id, { volume: 0.8, fadeIn: rational(1, 5), fadeOut: rational(1, 5) });
  await setClipEffects(projectFile, musicClip.id, { normalizeAudio: true, playbackRate: rational(1), speedKeyframes: [{ time: rational(0), rate: rational(1) }, { time: rational(5, 2), rate: rational(2) }] });
  await updateTrackSettings(projectFile, audio[0].id, { audioRole: 'music', duckUnderDialogue: true, volume: 0.75, volumeKeyframes: [{ time: rational(0), value: 1 }, { time: rational(2), value: 0.7 }] });
  await updateTrackSettings(projectFile, audio[1].id, { audioRole: 'dialogue', volume: 1.5 });

  const saved = await loadProject(projectFile);
  const savedRed = saved.tracks.flatMap((track) => track.clips).find((clip) => clip.id === redClip.id)!;
  assert.equal(decimal(clipSourceDuration(savedRed)), '3.75', 'a linear 1×→2× ramp over 2.5 s consumes exactly 3.75 source seconds');
  assert.equal(decimal(clipSourceOffsetAt(savedRed, rational(5, 4))), '1.5625');
  assert.match(clipSetptsExpression(savedRed), /sqrt\(/, 'video speed ramps use the inverse integrated rate curve');
  assert.ok(clipAudioSpeedChunks(savedRed).length > 2, 'audio speed ramps are split into short pitch-preserving tempo sections');
  assert.equal(saved.tracks.find((track) => track.id === audio[0].id)?.duckUnderDialogue, true);
  const splitProject = await splitClip(projectFile, redClip.id, rational(5, 4));
  const splitRed = splitProject.tracks.find((track) => track.id === videoTracks[0].id)!.clips;
  const rightRed = splitRed.find((clip) => compare(clip.start, rational(5, 4)) === 0)!;
  assert.equal(decimal(rightRed.sourceIn), '1.5625', 'splitting a speed-ramped clip advances source-in by its integrated speed');
  assert.equal(decimal(add(clipSourceDuration(splitRed[0]), clipSourceDuration(rightRed))), '3.75', 'splitting preserves total source coverage');
  const extendedProject = await trimClip(projectFile, rightRed.id, { start: rational(1), sourceIn: rational(19, 16), duration: rational(3, 2) });
  const extendedRed = extendedProject.tracks.find((track) => track.id === videoTracks[0].id)!.clips.find((clip) => clip.id === rightRed.id)!;
  assert.equal(decimal(extendedRed.sourceIn), '1.1875');
  assert.equal(decimal(clipSourceOffsetAt(extendedRed, rational(1, 2))), '0.7625', 'extending a clip head repositions its speed curve and preserves the original frame mapping');

  const wipePreview = path.join(directory, 'wipe-preview.png');
  await renderTimelineFrame(saved, rational(5, 24), wipePreview);
  const leftWipe = await pixelAt(wipePreview, directory, 'wipe-left.rgb', 20, 90);
  const rightWipe = await pixelAt(wipePreview, directory, 'wipe-right.rgb', 270, 90);
  assert.ok(leftWipe[2] > leftWipe[0] * 3, `wipe-left should reveal the upper blue image first on the left, got ${leftWipe.join(',')}`);
  assert.ok(rightWipe[0] > rightWipe[2] * 3, `wipe-left should leave the red image visible on the right, got ${rightWipe.join(',')}`);

  const mixed = await exportVideo(saved, { outputPath: mixedOutput });
  assert.equal(decimal(mixed.duration), '2.5');
  const isolated = await updateTrackSettings(projectFile, videoTracks[1].id, { muted: true });
  const previewFrame = path.join(directory, 'effect-preview.png');
  await renderTimelineFrame(isolated, rational(3, 2), previewFrame);
  await exportVideo(isolated, { outputPath: isolatedOutput });
  const exportFrame = path.join(directory, 'effect-export.png');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', isolatedOutput, '-frames:v', '1', exportFrame]);
  const previewPixel = await firstRgb(previewFrame, directory, 'effect-preview.rgb');
  const exportPixel = await firstRgb(exportFrame, directory, 'effect-export.rgb');
  assert.ok(Math.abs(previewPixel[0] - exportPixel[0]) < 35 && Math.abs(previewPixel[1] - exportPixel[1]) < 35 && Math.abs(previewPixel[2] - exportPixel[2]) < 35, `preview and export should agree after effects; preview=${previewPixel.join(',')} export=${exportPixel.join(',')}`);
  const probe = JSON.parse((await runCommand('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', mixedOutput])).stdout);
  assert.ok(probe.streams.some((stream: any) => stream.codec_type === 'audio'), 'normalized, faded, sidechain-ducked audio is encoded');
  assert.ok(probe.streams.some((stream: any) => stream.codec_type === 'video' && stream.width === 320 && stream.height === 180));
  const noDuck = await updateTrackSettings(projectFile, audio[0].id, { duckUnderDialogue: false });
  await exportVideo(noDuck, { outputPath: noDuckOutput });
  const duckRaw = path.join(directory, 'duck.raw'), noDuckRaw = path.join(directory, 'no-duck.raw');
  for (const [input, output] of [[mixedOutput, duckRaw], [noDuckOutput, noDuckRaw]]) await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', output]);
  const duckedMusicMix = await rawRms(duckRaw, 0.25, 0.1), unDuckedMusicMix = await rawRms(noDuckRaw, 0.25, 0.1);
  assert.ok(unDuckedMusicMix > duckedMusicMix * 1.05, `dialogue ducking should lower the concurrent music mix, ducked=${duckedMusicMix}, un-ducked=${unDuckedMusicMix}`);
});

test('core rejects source overwrite and invalid split positions with stable errors', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-errors-'));
  scratch.push(directory);
  const source = path.join(directory, 'source.mp4');
  const projectFile = path.join(directory, 'guard.omproj');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:rate=24:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await createProject(projectFile, { frameRate: rational(24), width: 320, height: 240 });
  const imported = await importMedia(projectFile, [source]);
  const project = await loadProject(projectFile);
  const track = project.tracks.find((item) => item.kind === 'video')!;
  const withClip = await addClip(projectFile, imported.added[0].id, track.id, rational(0), rational(0), rational(1));
  const clip = withClip.tracks.find((item) => item.id === track.id)!.clips[0];
  await assert.rejects(() => splitClip(projectFile, clip.id, rational(1)), (error: any) => error.code === 'SPLIT_OUTSIDE_CLIP');
  await assert.rejects(() => exportVideo(withClip, { outputPath: source, overwrite: true }), (error: any) => error.code === 'SOURCE_OVERWRITE_BLOCKED');
});

test('SQLite library caches folder imports and persists game, tags, favorites, and watcher settings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-library-'));
  scratch.push(directory);
  const captures = path.join(directory, 'Medal');
  const source = path.join(captures, 'round.mp4');
  const projectFile = path.join(directory, 'library.omproj');
  await mkdir(captures);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await createProject(projectFile, { frameRate: rational(30), width: 320, height: 180 });
  const first = await importMedia(projectFile, [captures]);
  assert.equal(first.added.length, 1);
  assert.deepEqual(first.watchedRoots, [captures]);
  const project = await loadProject(projectFile);
  assert.ok((await stat(libraryDatabasePath(projectFile, project.id))).size > 0);
  assert.equal((await getImportRoots(projectFile))[0].watching, true);

  const updated = await updateMediaMetadata(projectFile, first.added[0].id, { favorite: true, rating: 4, game: 'Valorant', tags: ['headshot', 'round win'] });
  assert.equal(updated.media[0].favorite, true);
  assert.equal(updated.media[0].rating, 4);
  const results = await searchMedia(projectFile, 'headshot', true);
  assert.equal(results.length, 1);
  assert.equal(results[0].game, 'Valorant');
  assert.equal(results[0].rating, 4);
  assert.deepEqual(results[0].tags, ['headshot', 'round win']);

  await undoProject(projectFile);
  assert.equal((await loadProject(projectFile)).media[0].rating ?? 0, 0, 'undo restores the score and SQLite metadata together');
  assert.equal((await searchMedia(projectFile, 'headshot', true)).length, 0, 'undo restores SQLite tags and favorite state along with project JSON');
  await redoProject(projectFile);
  assert.equal((await searchMedia(projectFile, 'headshot', true))[0].game, 'Valorant');
  assert.equal((await loadProject(projectFile)).media[0].rating, 4);
  await assert.rejects(updateMediaMetadata(projectFile, first.added[0].id, { rating: 6 }), (error: any) => error.code === 'INVALID_RATING');

  const second = await importMedia(projectFile, [captures]);
  assert.equal(second.added.length, 0, 'unchanged files are reused from the SQLite path/stat cache');
  assert.equal(second.duplicates.length, 1);
  assert.equal((await setImportRootWatching(projectFile, captures, false))[0].watching, false);
});

test('missing project media can be relinked without changing clip references and can be undone', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-relink-'));
  scratch.push(directory);
  const original = path.join(directory, 'original.mp4');
  const replacement = path.join(directory, 'moved', 'replacement.mp4');
  const tooShort = path.join(directory, 'too-short.mp4');
  const projectFile = path.join(directory, 'relink.omproj');
  await mkdir(path.dirname(replacement), { recursive: true });
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', original]);
  await copyFile(original, replacement);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=30:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tooShort]);
  await createProject(projectFile, { frameRate: rational(30), width: 320, height: 180 });
  const imported = await importMedia(projectFile, [original]);
  const asset = imported.added[0];
  const project = await loadProject(projectFile);
  const videoTrack = project.tracks.find((track) => track.kind === 'video')!;
  const withClip = await addClip(projectFile, asset.id, videoTrack.id, rational(0), rational(0), rational(3, 2));
  assert.deepEqual(await findMissingMedia(projectFile), []);
  await rm(original);
  assert.deepEqual(await findMissingMedia(projectFile), [asset.id]);
  await assert.rejects(() => relinkMedia(projectFile, asset.id, tooShort), (error: any) => error.code === 'RELINK_DURATION_TOO_SHORT');
  const relinked = await relinkMedia(projectFile, asset.id, replacement);
  assert.equal(relinked.media[0].id, asset.id);
  assert.equal(relinked.media[0].path, replacement);
  assert.equal(relinked.tracks.find((track) => track.id === videoTrack.id)!.clips[0].id, withClip.tracks.find((track) => track.id === videoTrack.id)!.clips[0].id);
  assert.deepEqual(await findMissingMedia(projectFile), []);
  await undoProject(projectFile);
  assert.deepEqual(await findMissingMedia(projectFile), [asset.id]);
  await redoProject(projectFile);
  assert.deepEqual(await findMissingMedia(projectFile), []);
});

test('recursive folder watcher reports new nested media files and closes cleanly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-watch-'));
  scratch.push(directory);
  const nested = path.join(directory, 'game', 'session');
  await mkdir(nested, { recursive: true });
  let resolveChange!: () => void;
  let changeCount = 0;
  const changed = new Promise<void>((resolve) => { resolveChange = resolve; });
  const watcher = watchFolder(directory, () => { changeCount++; resolveChange(); }, true, 100);
  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => { watcher.off('error', onError); resolve(); };
      const onError = (error: unknown) => { watcher.off('ready', onReady); reject(error); };
      watcher.once('ready', onReady);
      watcher.once('error', onError);
    });
    await writeFile(path.join(nested, 'capture.mp4'), 'new capture');
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([changed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('No file-system change notification arrived.')), 10000); })]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    assert.equal(changeCount, 1);
  } finally {
    await watcher.close();
  }
});

test('local audio analysis finds a synthetic 120 BPM click track and reuses its cache', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-audio-analysis-'));
  scratch.push(directory);
  const source = path.join(directory, 'clicks.wav');
  const cache = path.join(directory, 'analysis', 'clicks.json');
  await writeClickTrack(source, 120, 16);
  assert.equal(await readCachedAudioAnalysis(source, cache), null);
  const result = await analyzeAudio(source, cache);
  assert.ok(result.estimatedBpm, 'a tempo hypothesis was found');
  assert.ok(Math.abs(result.estimatedBpm - 120) <= 4, `expected about 120 BPM, got ${result.estimatedBpm}`);
  assert.ok(result.beats.length >= 25, `expected beat positions, got ${result.beats.length}`);
  assert.ok(result.onsets.length >= 25, `expected detected onsets, got ${result.onsets.length}`);
  assert.ok(result.beatPhaseSeconds !== undefined && Math.abs(result.beatPhaseSeconds - (result.beats[0] % (60 / result.estimatedBpm!))) < 0.001, 'beat phase remains expressed in seconds relative to the detected pulse period');
  assert.equal(result.method, 'spectral-flux-adaptive-beat-v5');
  assert.ok(result.beatGrid && result.beatGrid.length === result.beats.length, 'structured beat-grid points align one-to-one with legacy beat timestamps');
  assert.ok(result.beatGrid!.every((point, index) => point.index === index && point.confidence >= 0 && point.confidence <= 1));
  assert.ok(result.beatGrid!.every((point, index, grid) => index === 0 || point.timeSeconds > grid[index - 1].timeSeconds), 'the confidence grid is strictly time ordered');
  assert.ok(result.tempoSegments && result.tempoSegments.length > 0 && result.tempoSegments[0].startSeconds === 0);
  assert.equal(result.onsetEvents?.length, result.onsets.length, 'individual transients include confidence while legacy onset timestamps remain');
  assert.ok(result.onsetEvents?.every((onset) => onset.confidence >= 0 && onset.confidence <= 1));
  assert.ok(Array.isArray(result.accents) && Array.isArray(result.structureEvents));
  assert.ok(result.energyCurve.length >= 15);
  assert.ok(result.energySections.length > 0);
  assert.equal(result.meter, undefined, 'even beats without bar accents do not invent a meter');
  assert.deepEqual(result.drops, [], 'a steady click track does not produce a false energy rise');
  assert.equal(result.energyHopSeconds, 1);
  assert.ok((await stat(cache)).size > 100);
  assert.deepEqual(await readCachedAudioAnalysis(source, cache), result, 'the library can identify a fresh completed analysis cache');
  assert.deepEqual(await analyzeAudio(source, cache), result, 'a matching source size and mtime reuse the saved result');
  const sourceInfo = await stat(source);
  await writeFile(cache, JSON.stringify({ sourceSizeBytes: sourceInfo.size, sourceMtimeMs: sourceInfo.mtimeMs, analysis: { ...result, method: 'spectral-flux-dynamic-beat-v4' } }));
  assert.equal(await readCachedAudioAnalysis(source, cache), null, 'an older analysis method invalidates the cache after an algorithm change');
  await analyzeAudio(source, cache);
  await writeFile(source, Buffer.concat([await readFile(source), Buffer.from([0])]));
  assert.equal(await readCachedAudioAnalysis(source, cache), null, 'a source change invalidates the visible analysis status');
  for (const bpm of [90, 150]) {
    const variant = path.join(directory, `clicks-${bpm}.wav`);
    await writeClickTrack(variant, bpm, 16);
    const detected = await analyzeAudio(variant);
    assert.ok(detected.estimatedBpm, `a tempo hypothesis was found for ${bpm} BPM`);
    assert.ok(Math.abs(detected.estimatedBpm - bpm) <= 5, `expected about ${bpm} BPM, got ${detected.estimatedBpm}`);
  }
});

test('audio analysis reports accented meter, downbeats, and a high-energy transition', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-audio-structure-'));
  scratch.push(directory);
  const source = path.join(directory, 'accented.wav');
  await writeClickTrack(source, 120, 24, { accentEvery: 4, highEnergyAt: 12 });
  const analysis = await analyzeAudio(source);
  assert.ok(analysis.estimatedBpm && Math.abs(analysis.estimatedBpm - 120) <= 4);
  assert.equal(analysis.meter?.beatsPerBar, 4, `expected accented 4/4, got ${JSON.stringify(analysis.meter)}`);
  assert.ok(analysis.downbeats.length >= 10);
  assert.ok((analysis.accents?.length ?? 0) > 0, 'strong beats or transients are exposed as accent anchors');
  assert.ok(analysis.drops.some((time) => Math.abs(time - 12) <= 2), `expected an energy rise near 12 seconds, got ${analysis.drops.join(', ')}`);
  assert.ok(analysis.structureEvents?.some((event) => event.type === 'drop' && event.signals.length > 0));
});

test('motion and optional OCR detectors report their availability and motion evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-motion-analysis-'));
  scratch.push(directory);
  const source = path.join(directory, 'motion.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source]);
  const analysis = await analyzeHighlightCues({ mediaId: 'motion-sample', mediaPath: source, mediaKind: 'video', durationSeconds: 5, game: 'OpenArena' });
  const motionDetector = analysis.detectors.find((detector) => detector.detectorId === 'openmontage.frame-difference-motion');
  assert.equal(motionDetector?.status, 'complete');
  const motionEvent = analysis.events.find((event) => event.detectors.some((detector) => detector.detectorId === 'openmontage.frame-difference-motion'));
  assert.ok(motionEvent, 'moving frames produce timestamped motion activity');
  assert.equal(motionEvent.detectors.find((detector) => detector.detectorId === 'openmontage.frame-difference-motion')?.evidence.method, 'sampled-frame-mean-absolute-luma-difference');
  const ocrDetector = analysis.detectors.find((detector) => detector.detectorId === 'openmontage.tesseract-hud-ocr');
  assert.ok(ocrDetector?.status === 'complete' || ocrDetector?.status === 'skipped');
});

test('game rules reload changed local profiles and emit explicit game event labels', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-game-rules-'));
  scratch.push(directory);
  const rulesPath = path.join(directory, 'rules.json');
  const previousPath = process.env.OPENMONTAGE_GAME_RULES;
  process.env.OPENMONTAGE_GAME_RULES = rulesPath;
  try {
    await writeFile(rulesPath, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'test-arena', gameAliases: ['Test Arena'], events: [{ id: 'round_win', eventType: 'round_end', keywords: ['victorious squad'] }] }] }));
    const initialKey = await gameRuleCacheKey();
    assert.deepEqual(await matchGameEvent('Victorious Squad!', 'Test Arena'), { profileId: 'test-arena', eventId: 'round_win', matchedKeyword: 'victorious squad', eventType: 'round_end', evidenceLevel: 'explicit' });
    await writeFile(rulesPath, JSON.stringify({ schemaVersion: 1, profiles: [{ id: 'test-arena', gameAliases: ['Test Arena'], events: [{ id: 'objective', eventType: 'round_objective', keywords: ['objective secured'] }] }] }));
    assert.notEqual(await gameRuleCacheKey(), initialKey, 'custom rule changes invalidate the detector cache key');
    assert.deepEqual(await matchGameEvent('Objective secured', 'Test Arena'), { profileId: 'test-arena', eventId: 'objective', matchedKeyword: 'objective secured', eventType: 'round_objective', evidenceLevel: 'explicit' });
  } finally {
    if (previousPath === undefined) delete process.env.OPENMONTAGE_GAME_RULES;
    else process.env.OPENMONTAGE_GAME_RULES = previousPath;
  }
});

test('Valorant adapter classifies explicit HUD labels without inventing kills from ordinary text', async () => {
  assert.equal(classifyValorantHudText('Enemy eliminated · Headshot')?.eventType, 'headshot');
  assert.equal(classifyValorantHudText('Double Kill')?.eventType, 'multi_kill');
  assert.equal(classifyValorantHudText('ACE')?.evidenceLevel, 'explicit');
  assert.equal(classifyValorantHudText('1v3')?.evidenceLevel, 'heuristic');
  assert.equal(classifyValorantHudText('Round won')?.eventType, 'round_end');
  assert.equal(classifyValorantHudText('Spike defused')?.eventType, 'round_objective');
  assert.equal(classifyValorantHudText('Space'), null, 'word-boundary matching avoids the old substring false positive');
  assert.equal(classifyValorantHudText('Headshots are allowed'), null, 'plural HUD text does not become a headshot');
  assert.equal(classifyValorantHudText('Enemy eliminated', 'Counter-Strike'), null, 'the Valorant adapter does not classify other games');
  assert.equal(legacyValorantTextMatch('Space')?.eventId, 'ace', 'fixture baseline preserves the prior substring matcher behavior');
  assert.equal((await matchGameEvent('Double Kill', 'Valorant'))?.eventType, 'multi_kill');
  assert.equal((await matchGameEvent('Counter-Terrorists win', 'CS2'))?.eventType, 'round_end', 'other built-in profiles retain typed event semantics');
});

test('Valorant kill-feed row changes are normalized, debounced, and remain uncertain cues', () => {
  const word = (text: string, x: number, lineId = 'feed') => ({ text, confidence: 90, x, y: 0.1, width: 0.07, height: 0.02, lineId });
  const changes = detectValorantKillFeedChanges([
    { timeSeconds: 1, words: [word('Jett', 0.72), word('Vandal', 0.81)] },
    { timeSeconds: 1.25, words: [word('Jett', 0.72), word('Vandal', 0.81)] },
    { timeSeconds: 1.5, words: [word('Jett', 0.72), word('Vandal', 0.81), word('Sage', 0.9)] },
    { timeSeconds: 2, words: [word('Score', 0.2), word('13', 0.29)] }
  ]);
  assert.equal(changes.length, 1, 'the first frame establishes a baseline; later changed rows are only possible feed events');
  assert.equal(changes[0].signature, 'jett vandal sage');
  assert.ok(changes.every((change) => change.confidence <= 0.75));
});

test('highlight fusion retains explicit gameplay types and explains audio-motion candidates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-gameplay-fusion-'));
  scratch.push(directory);
  const mediaPath = path.join(directory, 'generated-media-marker.dat');
  await writeFile(mediaPath, 'synthetic-marker');
  const detectors: DetectorPlugin[] = [
    { id: 'test.motion', version: '1', modality: 'video', async detect() { return [{ kind: 'motion_activity', startSeconds: 4.8, decisiveSeconds: 5, endSeconds: 5.4, confidence: 0.7, interestingness: 0.8, evidence: { metric: 'frame-difference' } }]; } },
    { id: 'test.audio', version: '1', modality: 'audio', async detect() { return [{ kind: 'audio_activity', startSeconds: 4.9, decisiveSeconds: 5.1, endSeconds: 5.5, confidence: 0.65, interestingness: 0.75, evidence: { transientCount: 3 } }]; } },
    { id: 'test.hud', version: '1', modality: 'text', async detect() { return [{ kind: 'gameplay_event', eventType: 'headshot', evidenceLevel: 'explicit', uncertainties: ['OCR can misread text.'], startSeconds: 5, decisiveSeconds: 5.2, endSeconds: 5.3, confidence: 0.93, interestingness: 0.9, evidence: { recognizedText: 'Headshot', matchedKeyword: 'headshot' } }]; } }
  ];
  const audioAnalysis: AudioAnalysis = { method: 'spectral-flux-dynamic-beat-v4', sampleRate: 48000, hopSeconds: 0.01, durationSeconds: 10, bpmHypotheses: [], beats: [], downbeats: [], energyHopSeconds: 1, energyCurve: Array(10).fill(0.5), energySections: [], drops: [], onsets: [] };
  const analysis = await analyzeHighlightCues({ mediaId: 'fused', mediaPath, mediaKind: 'video', durationSeconds: 10, game: 'Valorant', audioAnalysis }, undefined, detectors);
  assert.equal(analysis.events.length, 1);
  const event = analysis.events[0];
  assert.equal(event.eventType, 'headshot');
  assert.equal(event.evidenceLevel, 'explicit');
  assert.equal(event.kind, 'coincident_activity');
  assert.ok(event.signals?.includes('test.motion'));
  assert.ok(event.signals?.includes('test.audio'));
  assert.ok(event.signals?.includes('matchedKeyword=headshot'));
  assert.ok(event.uncertainties?.includes('OCR can misread text.'));
  assert.ok(event.scoreBreakdown && Math.abs(event.scoreBreakdown.total - event.rankScore / 100) <= 0.01);
  const activityOnly = await analyzeHighlightCues({ mediaId: 'activity-only', mediaPath, mediaKind: 'video', durationSeconds: 10, game: 'Valorant', audioAnalysis }, undefined, detectors.slice(0, 2));
  assert.equal(activityOnly.events[0].eventType, 'combat_activity');
  assert.equal(activityOnly.events[0].evidenceLevel, 'corroborated');
  assert.ok(activityOnly.events[0].uncertainties?.some((item) => item.includes('do not prove a fight')));
});

test('evaluation reports independent gameplay consensus and real-music beat metrics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-phase-c-evaluation-'));
  scratch.push(directory);
  const video = path.join(directory, 'game.mp4');
  const music = path.join(directory, 'music.wav');
  const manifest = path.join(directory, 'dataset.json');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video]);
  await writeClickTrack(music, 120, 8, { accentEvery: 4 });
  const reviewerIds = ['reviewer-a', 'reviewer-b'];
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1, datasetId: 'synthetic-phase-c-check', game: 'OpenArena',
    annotators: reviewerIds.map((id) => ({ id, independent: true })),
    items: [
      { mediaPath: 'game.mp4', mediaKind: 'video', hasAudio: false, durationSeconds: 5, reviewedBy: reviewerIds, annotations: [
        { annotationId: 'a-kill', annotatorId: reviewerIds[0], eventType: 'kill', startSeconds: 1, decisiveSeconds: 1.5, endSeconds: 2 },
        { annotationId: 'b-kill', annotatorId: reviewerIds[1], eventType: 'kill', startSeconds: 1.1, decisiveSeconds: 1.6, endSeconds: 2.1 }
      ] },
      { mediaPath: 'music.wav', mediaKind: 'audio', hasAudio: true, durationSeconds: 8, reviewedBy: reviewerIds, annotations: [], musicAnnotations: reviewerIds.map((annotatorId) => ({
        annotatorId, bpm: 120, meter: { beatsPerBar: 4, denominator: 4, downbeatPhase: 0 }, beatTimesSeconds: Array.from({ length: 16 }, (_value, index) => index / 2), downbeatTimesSeconds: [0, 2, 4, 6]
      })) }
    ]
  }));
  const report = await evaluateHighlightDataset(manifest);
  assert.equal(report.referenceEvents, 1);
  assert.equal(report.disputedAnnotations, 0);
  const syntheticKillMetrics = report.gameplayEventResults.find((result) => result.eventType === 'kill');
  assert.equal(syntheticKillMetrics?.truePositives, 0, 'generic generated motion cannot be labeled as a kill without proof');
  assert.equal(syntheticKillMetrics?.falseNegatives, 1);
  assert.equal(syntheticKillMetrics?.meanAbsoluteTimingErrorSeconds, null);
  assert.equal(report.gameplayCueBaseline.method, 'legacy-time-only-activity-cues');
  assert.equal(report.detectorResults.find((result) => result.detectorId === 'openmontage.frame-difference-motion')?.evaluatedMediaItems, 1);
  const ocrResult = report.detectorResults.find((result) => result.detectorId === 'openmontage.tesseract-hud-ocr');
  const ocrStatus = report.items[0].analysis.detectors.find((detector) => detector.detectorId === 'openmontage.tesseract-hud-ocr')?.status;
  assert.equal(ocrResult?.evaluatedMediaItems, ocrStatus === 'complete' ? 1 : 0, 'optional OCR is evaluated when available and skipped when unavailable');
  assert.equal(report.detectorResults.find((result) => result.detectorId === 'openmontage.audio-activity')?.evaluatedMediaItems, 0, 'audio-only music items are excluded from gameplay detector recall');
  const sceneMetrics = report.detectorResults.find((result) => result.detectorId === 'openmontage.ffmpeg-scene-change');
  assert.equal(sceneMetrics?.falseNegatives, 1, 'annotated events missed by a completed detector count toward recall');
  assert.ok(report.musicSummary.bpmMeanAbsoluteError !== null && report.musicSummary.bpmMeanAbsoluteError <= 2);
  assert.ok(report.musicSummary.beatF1 !== null && report.musicSummary.beatF1 > 0.7);
  assert.ok(report.musicSummary.tempoScoreCalibration, 'tempo score calibration diagnostics are reported');
  assert.equal(report.musicSummary.meterAccuracy, 1);
  assert.equal(report.musicSummary.meterCoverage, 1);
  assert.equal(report.musicByCategory.find((item) => item.category === 'uncategorized')?.items, 1);

  const publishedManifest = path.join(directory, 'published-music.json');
  await writeFile(publishedManifest, JSON.stringify({
    schemaVersion: 1, datasetId: 'published-reference-check', game: 'Music reference',
    referenceSource: { kind: 'published-music-reference', name: 'Test reference set', sourceUrl: 'https://example.org/reference', license: 'CC BY 4.0', citation: 'Test citation', annotationMethod: 'Published reference timestamps.' },
    annotators: [{ id: 'published-reference', independent: true, kind: 'published-reference' }],
    items: [{ mediaPath: 'music.wav', mediaKind: 'audio', hasAudio: true, durationSeconds: 8, reviewedBy: ['published-reference'], annotations: [], musicAnnotations: [{
      annotatorId: 'published-reference', bpm: 120, meter: { beatsPerBar: 4, denominator: 4, downbeatPhase: 0 }, beatTimesSeconds: Array.from({ length: 16 }, (_value, index) => index / 2), downbeatTimesSeconds: [0, 2, 4, 6]
    }], musicProfile: { category: 'steady-meter' } }]
  }));
  const referenceReport = await evaluateHighlightDataset(publishedManifest);
  assert.equal(referenceReport.referenceSource?.name, 'Test reference set');
  assert.equal(referenceReport.musicByCategory.find((item) => item.category === 'steady-meter')?.items, 1);
});

test('timeline preview composites active video tracks in track order and renders black across gaps', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-preview-'));
  scratch.push(directory);
  const red = path.join(directory, 'red.mp4'), blue = path.join(directory, 'blue.mp4');
  const projectFile = path.join(directory, 'preview.omproj');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  await createProject(projectFile, { frameRate: rational(24), width: 320, height: 180 });
  const imported = await importMedia(projectFile, [red, blue]);
  const project = await addTrack(projectFile, 'video', 'V2');
  const videoTracks = project.tracks.filter((track) => track.kind === 'video');
  const redAsset = imported.added.find((asset) => asset.path === red)!;
  const blueAsset = imported.added.find((asset) => asset.path === blue)!;
  await addClip(projectFile, redAsset.id, videoTracks[0].id, rational(0), rational(0), rational(2));
  await addClip(projectFile, blueAsset.id, videoTracks[1].id, rational(1, 2), rational(0), rational(3, 2));
  const edited = await loadProject(projectFile);
  const redFrame = path.join(directory, 'red-frame.png');
  const blueFrame = path.join(directory, 'blue-frame.png');
  const blackFrame = path.join(directory, 'black-frame.png');
  await renderTimelineFrame(edited, rational(1, 4), redFrame);
  await renderTimelineFrame(edited, rational(3, 4), blueFrame);
  await renderTimelineFrame(edited, rational(2), blackFrame);
  const redPixel = await firstRgb(redFrame, directory, 'red.rgb');
  const bluePixel = await firstRgb(blueFrame, directory, 'blue.rgb');
  const blackPixel = await firstRgb(blackFrame, directory, 'black.rgb');
  assert.ok(redPixel[0] > redPixel[2] * 4, `expected red frame, got ${redPixel.join(',')}`);
  assert.ok(bluePixel[2] > bluePixel[0] * 4, `expected upper blue track to overlay red, got ${bluePixel.join(',')}`);
  assert.ok(blackPixel.every((value) => value < 8), `expected black gap, got ${blackPixel.join(',')}`);

  const soloedProject = await updateTrackSettings(projectFile, videoTracks[0].id, { solo: true });
  const soloFrame = path.join(directory, 'solo-frame.png');
  await renderTimelineFrame(soloedProject, rational(3, 4), soloFrame);
  const soloPixel = await firstRgb(soloFrame, directory, 'solo.rgb');
  assert.ok(soloPixel[0] > soloPixel[2] * 4, `soloing the lower video track should hide the upper blue track, got ${soloPixel.join(',')}`);
  const soloExport = path.join(directory, 'solo-export.mp4');
  const soloExportFrame = path.join(directory, 'solo-export-frame.png');
  await exportVideo(soloedProject, { outputPath: soloExport });
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.75', '-i', soloExport, '-frames:v', '1', soloExportFrame]);
  const soloExportPixel = await firstRgb(soloExportFrame, directory, 'solo-export.rgb');
  assert.ok(soloExportPixel[0] > soloExportPixel[2] * 4, `solo export should match its preview, got ${soloExportPixel.join(',')}`);
});

test('Phase F masks interpolate tracking corrections and match export, chroma key, and blend modes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-compositing-'));
  scratch.push(directory);
  const red = path.join(directory, 'red.mp4'), blue = path.join(directory, 'blue.mp4');
  const projectFile = path.join(directory, 'compositing.omproj');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', red]);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blue]);
  await createProject(projectFile, { frameRate: rational(24), width: 320, height: 180 });
  const imported = await importMedia(projectFile, [red, blue]);
  let project = await addTrack(projectFile, 'video', 'V2');
  const [baseTrack, foregroundTrack] = project.tracks.filter((track) => track.kind === 'video');
  const redAsset = imported.added.find((asset) => asset.path === red)!;
  const blueAsset = imported.added.find((asset) => asset.path === blue)!;
  await addClip(projectFile, redAsset.id, baseTrack.id, rational(0), rational(0), rational(2));
  project = await addClip(projectFile, blueAsset.id, foregroundTrack.id, rational(0), rational(0), rational(2));
  const foreground = project.tracks.find((track) => track.id === foregroundTrack.id)!.clips[0];
  const left = 'M 0.05 0.25 L 0.3 0.25 L 0.3 0.75 L 0.05 0.75 Z';
  const right = 'M 0.7 0.25 L 0.95 0.25 L 0.95 0.75 L 0.7 0.75 Z';
  project = await setClipEffects(projectFile, foreground.id, { mask: { path: left, featherPx: 2, expansionPx: 0, keyframes: [{ time: rational(1), path: right }] } });

  const leftFrame = path.join(directory, 'mask-left.png'), rightFrame = path.join(directory, 'mask-right.png');
  await renderTimelineFrame(project, rational(1, 24), leftFrame);
  await renderTimelineFrame(project, rational(3, 2), rightFrame);
  const leftBlue = await pixelAt(leftFrame, directory, 'mask-left-blue.rgb', 50, 90);
  const leftRed = await pixelAt(leftFrame, directory, 'mask-left-red.rgb', 270, 90);
  const rightRed = await pixelAt(rightFrame, directory, 'mask-right-red.rgb', 50, 90);
  const rightBlue = await pixelAt(rightFrame, directory, 'mask-right-blue.rgb', 270, 90);
  assert.ok(leftBlue[2] > leftBlue[0] * 4, `left tracking position should reveal the blue foreground, got ${leftBlue}`);
  assert.ok(leftRed[0] > leftRed[2] * 4, `outside the mask should show the red background, got ${leftRed}`);
  assert.ok(rightRed[0] > rightRed[2] * 4, `the corrected mask should leave its old position, got ${rightRed}`);
  assert.ok(rightBlue[2] > rightBlue[0] * 4, `the corrected mask should reveal the new position, got ${rightBlue}`);

  const output = path.join(directory, 'compositing.mp4');
  await exportVideo(project, { outputPath: output });
  const exportedFrame = path.join(directory, 'exported-mask.png');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.5', '-i', output, '-frames:v', '1', exportedFrame]);
  const exportedBlue = await pixelAt(exportedFrame, directory, 'exported-mask-blue.rgb', 270, 90);
  assert.ok(exportedBlue[2] > exportedBlue[0] * 4, `export should preserve the corrected mask, got ${exportedBlue}`);

  project = await setClipEffects(projectFile, foreground.id, { mask: undefined, chromaKey: { color: '#0000ff', similarity: 0.2, blend: 0.05 } });
  const keyedFrame = path.join(directory, 'keyed.png');
  await renderTimelineFrame(project, rational(1, 2), keyedFrame);
  const keyedPixel = await pixelAt(keyedFrame, directory, 'keyed.rgb', 160, 90);
  assert.ok(keyedPixel[0] > keyedPixel[2] * 4, `the keyed blue foreground should reveal red, got ${keyedPixel}`);

  project = await setClipEffects(projectFile, foreground.id, { chromaKey: undefined, blendMode: 'multiply' });
  const blendedFrame = path.join(directory, 'multiply.png');
  await renderTimelineFrame(project, rational(1, 2), blendedFrame);
  const blendedPixel = await pixelAt(blendedFrame, directory, 'multiply.rgb', 160, 90);
  assert.ok(blendedPixel.every((value) => value < 20), `red multiplied by blue should be near black, got ${blendedPixel}`);

  project = await setClipEffects(projectFile, foreground.id, { blendMode: 'normal', mask: { path: left, featherPx: 0, expansionPx: 4 } });
  const expandedFrame = path.join(directory, 'expanded.png');
  await renderTimelineFrame(project, rational(1, 2), expandedFrame);
  const expandedEdge = await pixelAt(expandedFrame, directory, 'expanded-edge.rgb', 13, 90);
  assert.ok(expandedEdge[2] > expandedEdge[0] * 3, `mask expansion should include pixels outside the original path, got ${expandedEdge}`);
});

test('headless CLI creates a project, imports media, assembles a timeline and exports MP4', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-cli-'));
  scratch.push(directory);
  const source = path.join(directory, 'cli-source.mp4');
  const music = path.join(directory, 'cli-music.wav');
  const projectPath = path.join(directory, 'cli-project.omproj');
  const output = path.join(directory, 'cli-output.mp4');
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source]);
  await writeClickTrack(music, 120, 8);
  const cliPath = path.join(process.cwd(), 'dist', 'src', 'main', 'cli.js');
  const invoke = (...args: string[]) => new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: process.cwd(), windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`CLI failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`CLI returned invalid JSON: ${stdout}`, { cause: error })); }
    });
  });
  const created = await invoke('create', '--project', projectPath, '--fps', '24/1', '--width', '320', '--height', '180');
  assert.equal(created.ok, true);
  const imported = await invoke('import', '--project', projectPath, source, music);
  assert.equal(imported.data.added.length, 2);
  const ratedAsset = await invoke('media-update', '--project', projectPath, '--media', imported.data.added[0].id, '--rating', '5');
  assert.equal(ratedAsset.data.rating, 5);
  const musicAsset = imported.data.added.find((asset: any) => asset.kind === 'audio');
  assert.ok(musicAsset.thumbnailPath, 'audio import includes a cached waveform image');
  assert.ok((await stat(musicAsset.thumbnailPath)).size > 100);
  assert.equal((await readFile(musicAsset.thumbnailPath)).readUInt32BE(16), waveformWidthForDuration(Number(musicAsset.duration.num) / Number(musicAsset.duration.den)), 'waveform cache resolution follows source duration and the editor zoom range');
  const analysis = await invoke('analyze-audio', '--project', projectPath, '--media', musicAsset.id);
  assert.ok(Math.abs(analysis.data.estimatedBpm - 120) <= 4);
  assert.ok(analysis.data.beats.length > 0);
  const inspected = await invoke('inspect', '--project', projectPath);
  const videoTrack = inspected.data.project.tracks.find((track: any) => track.kind === 'video');
  const inserted = await invoke('clip-add', '--project', projectPath, '--media', imported.data.added[0].id, '--track', videoTrack.id, '--start', '0', '--source-in', '1/2', '--duration', '1');
  assert.equal(inserted.data.mediaId, imported.data.added[0].id);
  const audioSettings = await invoke('clip-audio', '--project', projectPath, '--clip', inserted.data.id, '--volume', '0.8', '--fade-in', '0.2', '--fade-out', '0.25');
  assert.deepEqual(audioSettings.data.fadeIn, rational(1, 5));
  assert.deepEqual(audioSettings.data.fadeOut, rational(1, 4));
  assert.equal(audioSettings.data.volume, 0.8);
  const effectsFile = path.join(directory, 'cli-effects.json');
  const maskPath = 'M 0.1 0.1 L 0.5 0.1 L 0.5 0.9 L 0.1 0.9 Z';
  await writeFile(effectsFile, JSON.stringify({
    blendMode: 'screen', chromaKey: { color: '#00ff00', similarity: 0.2, blend: 0.05 },
    mask: { path: maskPath, featherPx: 2, expansionPx: 1, keyframes: [{ time: rational(1, 2), path: 'M 0.2 0.1 L 0.6 0.1 L 0.6 0.9 L 0.2 0.9 Z' }] }
  }));
  const compositeSettings = await invoke('clip-effects', '--project', projectPath, '--clip', inserted.data.id, '--effects', effectsFile);
  assert.equal(compositeSettings.data.blendMode, 'screen');
  assert.equal(compositeSettings.data.chromaKey.color, '#00ff00');
  assert.equal(compositeSettings.data.mask.keyframes.length, 1);
  const duplicate = await invoke('clip-duplicate', '--project', projectPath, '--clip', inserted.data.id);
  assert.notEqual(duplicate.data.id, inserted.data.id);
  assert.deepEqual(duplicate.data.sourceIn, inserted.data.sourceIn);
  assert.deepEqual(duplicate.data.duration, inserted.data.duration);
  assert.deepEqual(duplicate.data.start, { num: '1', den: '1' });
  assert.deepEqual(duplicate.data.fadeIn, rational(1, 5));
  await invoke('clip-remove', '--project', projectPath, '--clip', duplicate.data.id);
  const soloed = await invoke('track-set', '--project', projectPath, '--track', videoTrack.id, '--solo', 'true');
  assert.equal(soloed.data.solo, true);
  await invoke('track-set', '--project', projectPath, '--track', videoTrack.id, '--solo', 'false');
  await invoke('clip-remove', '--project', projectPath, '--clip', inserted.data.id);
  await invoke('clip-add', '--project', projectPath, '--media', imported.data.added[0].id, '--track', videoTrack.id, '--start', '0', '--source-in', '1/2', '--duration', '1');
  const validation = await invoke('validate', '--project', projectPath);
  assert.equal(validation.data.valid, true);
  const exported = await invoke('export', '--project', projectPath, '--output', output);
  assert.equal(exported.data.outputPath, output);
  assert.ok((await stat(output)).size > 5000);
  const preview = await invoke('timeline-frame', '--project', projectPath, '--time', '1');
  assert.equal(preview.data.frame, 24);
  assert.ok((await stat(preview.data.outputPath)).size > 100);
  assert.equal((await invoke('history', '--project', projectPath)).data.canUndo, true);
  await invoke('undo', '--project', projectPath);
  assert.equal((await invoke('inspect', '--project', projectPath)).data.clipCount, 0);
  await invoke('redo', '--project', projectPath);
  assert.equal((await invoke('inspect', '--project', projectPath)).data.clipCount, 1);
  const movedSource = path.join(directory, 'moved-source.mp4');
  await copyFile(source, movedSource);
  await rm(source);
  const relinked = await invoke('media-relink', '--project', projectPath, '--media', imported.data.added.find((asset: any) => asset.kind === 'video').id, '--path', movedSource);
  assert.equal(relinked.data.path, movedSource);
  assert.equal((await invoke('validate', '--project', projectPath)).data.valid, true);
});

async function writeClickTrack(filePath: string, bpm: number, durationSeconds: number, options: { accentEvery?: number; highEnergyAt?: number } = {}): Promise<void> {
  const sampleRate = 22_050;
  const sampleCount = sampleRate * durationSeconds;
  const dataBytes = sampleCount * 2;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write('RIFF', 0); wave.writeUInt32LE(36 + dataBytes, 4); wave.write('WAVE', 8);
  wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(dataBytes, 40);
  const beatStep = 60 / bpm;
  const clickSamples = Math.round(sampleRate * 0.035);
  for (let sample = 0; sample < sampleCount; sample++) {
    const time = sample / sampleRate;
    const nearestBeat = Math.round(time / beatStep);
    const offset = time - nearestBeat * beatStep;
    const clickIndex = Math.round(offset * sampleRate);
    let value = 0;
    if (clickIndex >= 0 && clickIndex < clickSamples) {
      const envelope = Math.exp(-clickIndex / (sampleRate * 0.012));
      const accent = nearestBeat % (options.accentEvery ?? 1) === 0 ? 0.85 : 0.22;
      const sectionGain = options.highEnergyAt !== undefined && time < options.highEnergyAt ? 0.22 : 1;
      value = Math.sin(2 * Math.PI * 1_000 * clickIndex / sampleRate) * envelope * accent * sectionGain;
    }
    wave.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
  }
  await writeFile(filePath, wave);
}

async function firstRgb(imagePath: string, directory: string, fileName: string): Promise<Buffer> {
  const rawPath = path.join(directory, fileName);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-vf', 'scale=1:1:flags=neighbor', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
  return readFile(rawPath);
}

async function pixelAt(imagePath: string, directory: string, fileName: string, x: number, y: number): Promise<number[]> {
  const rawPath = path.join(directory, fileName);
  await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
  const bytes = await readFile(rawPath);
  const offset = (y * 320 + x) * 3;
  return [bytes[offset], bytes[offset + 1], bytes[offset + 2]];
}

async function rawRms(filePath: string, startSeconds: number, durationSeconds: number): Promise<number> {
  const samples = await readFile(filePath);
  const first = Math.floor(startSeconds * 48_000);
  const end = Math.min(samples.length / 2, first + Math.floor(durationSeconds * 48_000));
  let total = 0;
  for (let index = first; index < end; index++) {
    const sample = samples.readInt16LE(index * 2) / 32768;
    total += sample * sample;
  }
  return Math.sqrt(total / Math.max(1, end - first));
}
