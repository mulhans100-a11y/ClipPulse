import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addClip, addTrack, createProject, findMissingMedia, getImportRoots, getProjectHistory, importMedia, loadProject, redoProject, relinkMedia, removeClip, saveProject, searchMedia, setClipAudio, setImportRootWatching, splitClip, trimClip, undoProject, updateMediaMetadata, updateProjectProfile, updateTrackSettings } from '../src/core/project';
import { analyzeAudio } from '../src/core/audioAnalysis';
import { renderTimelineFrame } from '../src/core/timelinePreview';
import { exportVideo } from '../src/core/export';
import { runCommand } from '../src/core/ffmpeg';
import { libraryDatabasePath } from '../src/core/library';
import { watchFolder } from '../src/core/folderWatcher';
import { medalCaptureFolderPreset } from '../src/core/medal';
import { add, compare, decimal, frameTime, parseDecimal, rational, toFrame } from '../src/core/time';
import { audioClipBeatOffsets, collectTimelineSnapPoints, snapTimelineTime } from '../src/core/timelineSnapping';
import { mediaVirtualWindow } from '../src/renderer/ui/mediaVirtualization';
import type { Project, TimelineClip } from '../src/core/types';

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

test('Medal capture preset follows the Windows system drive and stays opt-in elsewhere', () => {
  assert.equal(medalCaptureFolderPreset('win32', 'D:'), 'D:\\Medal');
  assert.equal(medalCaptureFolderPreset('win32', undefined), 'C:\\Medal');
  assert.equal(medalCaptureFolderPreset('linux', undefined), null);
});

test('timeline snap points include clip edges and analyzed beats within an audio source range', () => {
  const clip: TimelineClip = { id: 'music-clip', mediaId: 'music', start: rational(2), sourceIn: rational(1), duration: rational(2), audioEnabled: true, volume: 1 };
  const project: Project = {
    schemaVersion: 1, id: 'project', name: 'Beat test', createdAt: '', updatedAt: '', frameRate: rational(30), width: 640, height: 360,
    media: [{ id: 'music', path: 'music.wav', name: 'music.wav', kind: 'audio', duration: rational(5), hasAudio: true, sizeBytes: 1, modifiedAt: '', contentHash: 'music-hash', importedAt: '' }],
    tracks: [{ id: 'audio-track', name: 'A1', kind: 'audio', muted: false, locked: false, clips: [clip] }]
  };
  const analysis = { method: 'rms-onset-autocorrelation-v1' as const, sampleRate: 11025, hopSeconds: 0.02, durationSeconds: 5, beats: [0.5, 1, 1.5, 2, 2.5, 3], onsets: [], bpmHypotheses: [] };
  assert.deepEqual(audioClipBeatOffsets(clip, analysis), [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(collectTimelineSnapPoints(project, { music: analysis }), [2, 2.5, 3, 3.5, 4]);
  assert.equal(snapTimelineTime(project, 3.53, 96, { music: analysis }), 3.5);
  assert.equal(snapTimelineTime(project, 3.8, 96, { music: analysis }), 3.8, 'snap only catches positions near a beat or clip edge');
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

  const updated = await updateMediaMetadata(projectFile, first.added[0].id, { favorite: true, game: 'Valorant', tags: ['headshot', 'round win'] });
  assert.equal(updated.media[0].favorite, true);
  const results = await searchMedia(projectFile, 'headshot', true);
  assert.equal(results.length, 1);
  assert.equal(results[0].game, 'Valorant');
  assert.deepEqual(results[0].tags, ['headshot', 'round win']);

  await undoProject(projectFile);
  assert.equal((await searchMedia(projectFile, 'headshot', true)).length, 0, 'undo restores SQLite tags and favorite state along with project JSON');
  await redoProject(projectFile);
  assert.equal((await searchMedia(projectFile, 'headshot', true))[0].game, 'Valorant');

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
    await writeFile(path.join(nested, 'capture.mp4'), 'new capture');
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([changed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('No file-system change notification arrived.')), 5000); })]);
    if (timeout) clearTimeout(timeout);
    assert.equal(changeCount, 1);
  } finally { watcher.close(); }
});

test('local audio analysis finds a synthetic 120 BPM click track and reuses its cache', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmontage-audio-analysis-'));
  scratch.push(directory);
  const source = path.join(directory, 'clicks.wav');
  const cache = path.join(directory, 'analysis', 'clicks.json');
  await writeClickTrack(source, 120, 16);
  const result = await analyzeAudio(source, cache);
  assert.ok(result.estimatedBpm, 'a tempo hypothesis was found');
  assert.ok(Math.abs(result.estimatedBpm - 120) <= 4, `expected about 120 BPM, got ${result.estimatedBpm}`);
  assert.ok(result.beats.length >= 25, `expected beat positions, got ${result.beats.length}`);
  assert.ok(result.onsets.length >= 25, `expected detected onsets, got ${result.onsets.length}`);
  assert.ok(result.beatPhaseSeconds !== undefined && result.beatPhaseSeconds < 0.1);
  assert.ok((await stat(cache)).size > 100);
  assert.deepEqual(await analyzeAudio(source, cache), result, 'a matching source size and mtime reuse the saved result');
  for (const bpm of [90, 150]) {
    const variant = path.join(directory, `clicks-${bpm}.wav`);
    await writeClickTrack(variant, bpm, 16);
    const detected = await analyzeAudio(variant);
    assert.ok(detected.estimatedBpm, `a tempo hypothesis was found for ${bpm} BPM`);
    assert.ok(Math.abs(detected.estimatedBpm - bpm) <= 5, `expected about ${bpm} BPM, got ${detected.estimatedBpm}`);
  }
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
  const musicAsset = imported.data.added.find((asset: any) => asset.kind === 'audio');
  assert.ok(musicAsset.thumbnailPath, 'audio import includes a cached waveform image');
  assert.ok((await stat(musicAsset.thumbnailPath)).size > 100);
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

async function writeClickTrack(filePath: string, bpm: number, durationSeconds: number): Promise<void> {
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
      value = Math.sin(2 * Math.PI * 1_000 * clickIndex / sampleRate) * envelope * 0.85;
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
