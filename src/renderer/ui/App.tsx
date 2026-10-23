import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AudioLines, Bot, Check, ChevronDown, Clapperboard, Clock3, Copy, FilePlus2, Film, FolderOpen, FolderSync, Gauge, HardDrive, Import, Layers2, Magnet, Medal, Music2, Pause, Play, Plus, Redo2, Scissors, Settings2, Sparkles, Star, Trash2, Undo2, Upload, Video, Volume2, WandSparkles } from 'lucide-react';
import type { AnalysisEventReview, AnalysisRuntimeStatus, AudioAnalysis, AutoMontageCustomRules, AutoMontageFormat, AutoMontageOptions, AutoMontageStyle, GameplayEventType, GeneratedAutoMontageVariant, GeneratedAutoMontages, HighlightAnalysis, ImportResult, ImportRoot, MediaAsset, MediaJob, MediaJobQueueSnapshot, Project, Rational, SegmentationOptions, SegmentationProgress, TimelineClip, TimelineTrack, TrackKind } from '../../core/types';
import type { McpClientTarget, McpConnectionTest, McpExistingConfiguration, McpSetupConfiguration } from '../../shared/electron';
import { add as addTime, compare, decimal, frameTime, parseDecimal, rational, seconds, toFrame } from '../../core/time';
import { audioClipBeatOffsets, audioClipDownbeatOffsets, audioClipDropOffsets, snapTimelineTime } from '../../core/timelineSnapping';
import { mediaVirtualWindow } from './mediaVirtualization';
import { maskPathAt } from '../../core/maskPath';

const MEDIA_CARD_HEIGHT = 64;
type AudioAnalysisStatus = 'running' | 'complete' | 'failed';

function secondsOf(value: { num: string; den: string }): number { return Number(value.num) / Number(value.den); }
function formatTime(value: number): string {
  const ms = Math.max(0, Math.floor(value * 1000));
  const minutes = Math.floor(ms / 60000), seconds = Math.floor(ms / 1000) % 60, centis = Math.floor(ms / 10) % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
const GAMEPLAY_EVENT_TYPES: GameplayEventType[] = ['kill', 'headshot', 'multi_kill', 'ace', 'clutch', 'clutch_situation', 'round_end', 'round_objective', 'kill_feed_change', 'combat_activity', 'fast_action_candidate', 'quiet_passage', 'audio_activity', 'scene_change', 'text_recognition', 'unknown'];
function analysisEventLabel(event: HighlightAnalysis['events'][number], correctedType?: GameplayEventType): string {
  const eventType = correctedType ?? event.eventType;
  if (eventType) return eventType.replaceAll('_', ' ');
  const gameEvent = event.detectors.find((detector) => typeof detector.evidence.gameEvent === 'string')?.evidence.gameEvent;
  if (typeof gameEvent === 'string') return gameEvent.replaceAll('_', ' ');
  if (event.kind === 'coincident_activity') return 'Combined activity';
  if (event.kind === 'scene_change') return 'Scene change';
  if (event.kind === 'motion_activity') return 'Motion activity';
  if (event.kind === 'text_recognition') return 'HUD text';
  if (event.kind === 'gameplay_event') return 'Gameplay event';
  return 'Audio activity';
}
function frameLabel(value: { num: string; den: string }, fps: Project['frameRate']): string {
  return String(toFrame(value, fps));
}
function clipEnd(clip: TimelineClip): number { return secondsOf(clip.start) + secondsOf(clip.duration); }
function clipSourceOffsetAtSeconds(clip: TimelineClip, localTime: number): number {
  const base = secondsOf(clip.playbackRate ?? rational(1));
  if (localTime < 0) return localTime * base;
  const byTime = new Map<number, { time: number; rate: number }>([[0, { time: 0, rate: base }]]);
  for (const frame of clip.speedKeyframes ?? []) byTime.set(secondsOf(frame.time), { time: secondsOf(frame.time), rate: secondsOf(frame.rate) });
  const unique = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (unique[0].time > 0) unique.unshift({ time: 0, rate: base });
  let source = 0;
  let currentTime = 0;
  let currentRate = unique[0].rate;
  for (let index = 1; index < unique.length; index++) {
    const next = unique[index];
    if (localTime <= currentTime) return source;
    const step = Math.min(localTime, next.time) - currentTime;
    const fraction = step / (next.time - currentTime);
    const rateAtEnd = currentRate + (next.rate - currentRate) * fraction;
    source += step * (currentRate + rateAtEnd) / 2;
    currentTime += step;
    currentRate = rateAtEnd;
    if (localTime <= next.time) return source;
    currentRate = next.rate;
  }
  return source + Math.max(0, localTime - currentTime) * currentRate;
}
function getTrack(project: Project, clipId: string): TimelineTrack | undefined { return project.tracks.find((track) => track.clips.some((clip) => clip.id === clipId)); }
function getClip(project: Project | null, id: string | null): { track: TimelineTrack; clip: TimelineClip } | null {
  if (!project || !id) return null;
  const track = getTrack(project, id);
  const clip = track?.clips.find((item) => item.id === id);
  return track && clip ? { track, clip } : null;
}
function toastMessage(result: ImportResult): string {
  const errors = result.errors.length ? ` · ${result.errors.length} skipped` : '';
  const watch = result.watchedRoots.length ? ` · watching ${result.watchedRoots.length} folder${result.watchedRoots.length === 1 ? '' : 's'}` : '';
  return `${result.added.length} imported · ${result.duplicates.length} duplicate${watch}${errors}`;
}

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [projectPath, setProjectPath] = useState('');
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [timelineScale, setTimelineScale] = useState(96);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [audioAnalyses, setAudioAnalyses] = useState<Record<string, AudioAnalysis>>({});
  const [audioAnalysisStatuses, setAudioAnalysisStatuses] = useState<Record<string, AudioAnalysisStatus>>({});
  const [mediaJobs, setMediaJobs] = useState<MediaJob[]>([]);
  const [mediaJobsPaused, setMediaJobsPaused] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [showMcpSetup, setShowMcpSetup] = useState(false);
  const [showMontageGenerator, setShowMontageGenerator] = useState(false);
  const [previewMode, setPreviewMode] = useState<'timeline' | 'source'>('timeline');
  const [timelineFramePath, setTimelineFramePath] = useState<string | null>(null);
  const [timelinePreviewBusy, setTimelinePreviewBusy] = useState(false);
  const [timelinePlayback, setTimelinePlayback] = useState<{ path: string; revision: string; startTime: Rational; duration: Rational; hasMore: boolean } | null>(null);
  const [timelinePlaybackBusy, setTimelinePlaybackBusy] = useState(false);
  const [timelinePlaybackProgress, setTimelinePlaybackProgress] = useState<number | null>(null);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [trimDraft, setTrimDraft] = useState<{ clipId: string; start: number; sourceIn: number; duration: number } | null>(null);
  const [notice, setNotice] = useState('Ready');
  const [error, setError] = useState('');
  const [ffmpeg, setFfmpeg] = useState(false);
  const [ffmpegMessage, setFfmpegMessage] = useState('');
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [filter, setFilter] = useState('');
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [mediaSort, setMediaSort] = useState<'recent' | 'name' | 'duration' | 'rating'>('recent');
  const [mediaScrollTop, setMediaScrollTop] = useState(0);
  const [mediaViewportHeight, setMediaViewportHeight] = useState(0);
  const [importRoots, setImportRoots] = useState<ImportRoot[]>([]);
  const [missingMediaIds, setMissingMediaIds] = useState<string[]>([]);
  const mediaRef = useRef<HTMLVideoElement>(null);
  const timelinePlaybackRef = useRef<HTMLVideoElement>(null);
  const sourcePreviewPosition = useRef<{ mediaId: string; contentHash: string; time: number } | null>(null);
  const timelinePlaybackStart = useRef(0);
  const autoplayTimelinePlayback = useRef(false);
  const previewRequest = useRef(0);
  const historyRequest = useRef(0);
  const missingRequest = useRef(0);
  const analysisStatusRequest = useRef(0);
  const mediaJobsRequest = useRef(0);
  const projectPathRef = useRef('');
  const timelineRef = useRef<HTMLDivElement>(null);
  const mediaListRef = useRef<HTMLDivElement>(null);
  const currentClip = getClip(project, selectedClipId);
  const selectedMedia = project?.media.find((asset) => asset.id === selectedMediaId) ?? null;
  const activeMedia = currentClip ? project?.media.find((asset) => asset.id === currentClip.clip.mediaId) ?? null : selectedMedia;
  const activeProxyJob = activeMedia ? mediaJobs.filter((job) => job.kind === 'proxy' && job.mediaId === activeMedia.id && job.sourceContentHash === activeMedia.contentHash).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] : undefined;
  const sourcePreviewPath = activeProxyJob?.state === 'complete' ? activeProxyJob.outputPath : activeMedia?.path;
  const currentTimelinePlayback = project && timelinePlayback?.revision === project.updatedAt ? timelinePlayback : null;
  const duration = project ? Math.max(20, ...project.tracks.flatMap((track) => track.clips.map(clipEnd))) : 20;
  const visibleMedia = useMemo(() => {
    const items = project?.media.filter((asset) => {
      const matches = `${asset.name} ${asset.game ?? ''} ${(asset.tags ?? []).join(' ')}`.toLowerCase().includes(filter.toLowerCase());
      return matches && (!favoriteOnly || asset.favorite);
    }) ?? [];
    return items.sort((a, b) => mediaSort === 'name'
      ? a.name.localeCompare(b.name)
      : mediaSort === 'duration'
        ? secondsOf(b.duration) - secondsOf(a.duration)
        : mediaSort === 'rating'
          ? (b.rating ?? 0) - (a.rating ?? 0) || Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.name.localeCompare(b.name)
          : Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  }, [project, filter, favoriteOnly, mediaSort]);
  const mediaWindow = mediaVirtualWindow(visibleMedia.length, mediaScrollTop, mediaViewportHeight, MEDIA_CARD_HEIGHT);

  async function refreshHistory(filePath: string) {
    const request = ++historyRequest.current;
    try {
      const history = await window.openmontage.getProjectHistory(filePath);
      if (request === historyRequest.current) { setCanUndo(history.canUndo); setCanRedo(history.canRedo); }
    } catch { if (request === historyRequest.current) { setCanUndo(false); setCanRedo(false); } }
  }
  async function refreshMissingMedia(filePath: string) {
    const request = ++missingRequest.current;
    try { const missing = await window.openmontage.findMissingMedia(filePath); if (request === missingRequest.current) setMissingMediaIds(missing); }
    catch { if (request === missingRequest.current) setMissingMediaIds([]); }
  }

  useEffect(() => {
    if (!window.openmontage) { setError('Desktop bridge unavailable. Start the editor with npm run dev or npm start.'); return; }
    void window.openmontage.version().then((info) => { setAppVersion(info.appVersion); setFfmpeg(info.ffmpeg && info.ffprobe && info.compatible); setFfmpegMessage(info.message ?? ''); }).catch((cause) => setError(String(cause)));
  }, []);
  useEffect(() => {
    const element = mediaListRef.current;
    if (!element) return;
    const measure = () => setMediaViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => observer.disconnect();
  }, [project?.id]);
  useEffect(() => {
    if (mediaListRef.current) mediaListRef.current.scrollTop = 0;
    setMediaScrollTop(0);
  }, [filter, favoriteOnly, mediaSort, project?.id]);
  useEffect(() => {
    if (!project || !projectPath || previewMode !== 'timeline') return;
    if (timelinePlayback && timelinePlayback.revision === project.updatedAt) {
      const start = secondsOf(timelinePlayback.startTime);
      const end = start + secondsOf(timelinePlayback.duration);
      if (playhead >= start && playhead < end) return;
    }
    const requestId = ++previewRequest.current;
    const timer = setTimeout(() => {
      setTimelinePreviewBusy(true);
      void window.openmontage.renderTimelineFrame(projectPath, playhead).then((result) => {
        if (requestId === previewRequest.current) setTimelineFramePath(result.path);
      }).catch((cause) => {
        if (requestId === previewRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => {
        if (requestId === previewRequest.current) setTimelinePreviewBusy(false);
      });
    }, 180);
    return () => { clearTimeout(timer); previewRequest.current++; };
  }, [project, projectPath, playhead, previewMode, timelinePlayback]);
  useEffect(() => {
    const removeProgress = window.openmontage?.onTimelinePlaybackProgress((progress) => setTimelinePlaybackProgress(progress));
    return () => removeProgress?.();
  }, []);
  useEffect(() => {
    const video = timelinePlaybackRef.current;
    if (!currentTimelinePlayback || previewMode !== 'timeline' || timelinePlaying || !video || video.readyState === 0) return;
    const target = playhead - secondsOf(currentTimelinePlayback.startTime);
    if (target < 0 || target > secondsOf(currentTimelinePlayback.duration)) return;
    if (Math.abs(video.currentTime - target) > 0.02) video.currentTime = target;
  }, [playhead, currentTimelinePlayback, previewMode, timelinePlaying]);
  useEffect(() => {
    if (currentTimelinePlayback && previewMode === 'timeline') return;
    timelinePlaybackRef.current?.pause();
    setTimelinePlaying(false);
  }, [currentTimelinePlayback, previewMode]);
  useEffect(() => {
    const removeProgress = window.openmontage?.onExportProgress((progress) => setExportProgress(progress));
    const removeMediaUpdate = window.openmontage?.onMediaUpdated(({ project: next, result }) => {
      setProject(next); setNotice(`${result.added.length} new clip${result.added.length === 1 ? '' : 's'} found in watched folders`);
      if (projectPathRef.current) void refreshMissingMedia(projectPathRef.current);
    });
    return () => { removeProgress?.(); removeMediaUpdate?.(); };
  }, []);

  useEffect(() => window.openmontage?.onMediaJobsUpdated((event) => {
    if (event.projectPath.toLocaleLowerCase() !== projectPathRef.current.toLocaleLowerCase()) return;
    setMediaJobs(event.jobs); setMediaJobsPaused(event.paused);
  }), []);

  const load = useCallback((result: { project: Project; path: string }) => {
    setProject(result.project); setProjectPath(result.path); projectPathRef.current = result.path; setSelectedClipId(null);
    setMediaJobs([]); setMediaJobsPaused(false);
    setAudioAnalyses({});
    setAudioAnalysisStatuses({});
    const statusRequest = ++analysisStatusRequest.current;
    void window.openmontage?.getAudioAnalysisStatuses(result.path).then((mediaIds) => {
      if (statusRequest === analysisStatusRequest.current && projectPathRef.current === result.path) {
        setAudioAnalysisStatuses((current) => ({ ...Object.fromEntries(mediaIds.map((mediaId) => [mediaId, 'complete'])), ...current }));
      }
    }).catch(() => undefined);
    const jobsRequest = ++mediaJobsRequest.current;
    void window.openmontage?.getMediaJobs(result.path).then((snapshot) => {
      if (jobsRequest === mediaJobsRequest.current && projectPathRef.current.toLocaleLowerCase() === result.path.toLocaleLowerCase()) {
        setMediaJobs(snapshot.jobs); setMediaJobsPaused(snapshot.paused);
      }
    }).catch(() => undefined);
    void window.openmontage?.getImportRoots(result.path).then(setImportRoots).catch(() => setImportRoots([]));
    void refreshHistory(result.path);
    void refreshMissingMedia(result.path);
    setSelectedMediaId(result.project.media[0]?.id ?? null); setPlayhead(0);
    setError(''); setNotice(`Opened ${result.project.name}`);
  }, []);

  useEffect(() => {
    if (!project || !projectPath) return;
    for (const track of project.tracks) if (track.kind === 'audio') for (const clip of track.clips) {
      const asset = project.media.find((item) => item.id === clip.mediaId);
      if (!asset?.hasAudio || missingMediaIds.includes(asset.id)) continue;
      void window.openmontage.queueClipWaveform(projectPath, clip.id, timelineScale).then((job) => {
        setMediaJobs((current) => current.some((item) => item.id === job.id)
          ? current.map((item) => item.id === job.id ? job : item)
          : [...current, job]);
      }).catch(() => undefined);
    }
  }, [project, projectPath, timelineScale, missingMediaIds]);

  async function run<T>(operation: () => Promise<T>, update: (value: T) => Project | void, label: string) {
    if (!project || !projectPath) return;
    try {
      setError('');
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      const result = await operation();
      const next = update(result);
      if (next) { setProject(next); await refreshHistory(projectPath); }
      setNotice(label);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function cacheAudioAnalysis(mediaId: string, analysis: AudioAnalysis) {
    setAudioAnalyses((current) => ({ ...current, [mediaId]: analysis }));
    setAudioAnalysisStatuses((current) => ({ ...current, [mediaId]: 'complete' }));
  }
  function setAudioAnalysisStatus(mediaId: string, status: AudioAnalysisStatus) {
    setAudioAnalysisStatuses((current) => ({ ...current, [mediaId]: status }));
  }

  async function generateProxy(mediaId: string) {
    try {
      const job = await window.openmontage.queueProxy(projectPath, mediaId);
      setMediaJobs((current) => current.some((item) => item.id === job.id) ? current.map((item) => item.id === job.id ? job : item) : [...current, job]);
      setNotice(job.state === 'complete' ? 'Proxy is ready for source preview' : 'Proxy added to media queue');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function setMediaQueuePaused(paused: boolean) {
    try {
      if (paused) await window.openmontage.pauseMediaJobs(projectPath);
      else await window.openmontage.resumeMediaJobs(projectPath);
      setMediaJobsPaused(paused);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function retryMediaJob(jobId: string) {
    try {
      const job = await window.openmontage.retryMediaJob(projectPath, jobId);
      setMediaJobs((current) => current.map((item) => item.id === job.id ? job : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function clearProxyCache() {
    try {
      mediaRef.current?.pause();
      const removed = await window.openmontage.clearCachedProxies(projectPath);
      setNotice(`${removed} cached ${removed === 1 ? 'proxy' : 'proxies'} cleared`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function createProject() {
    try { const result = await window.openmontage.createProject(); if (result) load(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function openProject() {
    try { const result = await window.openmontage.openProject(); if (result) load(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function importMedia() {
    if (!project) return;
    try {
      const { project: next, result } = await window.openmontage.importMedia(projectPath);
      if (result.added.length) { setProject(next); setSelectedMediaId(result.added[0].id); await refreshHistory(projectPath); }
      setNotice(toastMessage(result));
      setImportRoots(await window.openmontage.getImportRoots(projectPath));
      await refreshMissingMedia(projectPath);
      if (result.errors.length) setError(result.errors.map((item) => `${item.path}: ${item.message}`).join('\n'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function importMusicForMontage(): Promise<MediaAsset | null> {
    if (!project) return null;
    const imported = await window.openmontage.importMusic(projectPath);
    if (!imported) return null;
    setProject(imported.project);
    await refreshHistory(projectPath);
    const musicId = imported.result.added[0]?.id ?? imported.result.duplicates
      .map((duplicate) => duplicate.existingId)
      .find((id) => imported.project.media.some((asset) => asset.id === id && asset.hasAudio));
    const asset = imported.project.media.find((item) => item.id === musicId && item.hasAudio) ?? null;
    if (asset) setSelectedMediaId(asset.id);
    setNotice(`Music import · ${toastMessage(imported.result)}`);
    if (imported.result.errors.length) setError(imported.result.errors.map((item) => `${item.path}: ${item.message}`).join('\n'));
    return asset;
  }
  async function importMedalFolder() {
    if (!project) return;
    try {
      const imported = await window.openmontage.importMedalFolder(projectPath);
      if (!imported) return;
      if (imported.result.added.length) {
        setProject(imported.project); setSelectedMediaId(imported.result.added[0].id);
        await refreshHistory(projectPath);
      }
      setImportRoots(await window.openmontage.getImportRoots(projectPath));
      await refreshMissingMedia(projectPath);
      setNotice(`Medal captures · ${toastMessage(imported.result)}`);
      if (imported.result.errors.length) setError(imported.result.errors.map((item) => `${item.path}: ${item.message}`).join('\n'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function addMediaToTimeline(asset: MediaAsset, start = 0, trackOverride?: string) {
    if (!project) return;
    if (missingMediaIds.includes(asset.id)) { setError('Relink this missing file before adding it to the timeline.'); return; }
    const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const track = project.tracks.find((item) => item.id === trackOverride) ?? project.tracks.find((item) => item.kind === kind);
    if (!track) { setError(`Create a ${kind} track first.`); return; }
    const position = snapEnabled ? snapTimelineTime(project, start, timelineScale, audioAnalyses) : start;
    const previousIds = new Set(project.tracks.flatMap((item) => item.clips.map((clip) => clip.id)));
    await run(() => window.openmontage.addClip(projectPath, asset.id, track.id, position), (next) => {
      const created = next.tracks.flatMap((item) => item.clips).find((clip) => !previousIds.has(clip.id));
      if (created) { setSelectedClipId(created.id); setSelectedMediaId(asset.id); setPlayhead(position); }
      return next;
    }, `Added ${asset.name}`);
  }
  async function addTrack(kind: TrackKind) {
    await run(() => window.openmontage.addTrack(projectPath, kind), (next) => next, `Added ${kind} track`);
  }
  async function undo() {
    if (!project || !projectPath || !canUndo) return;
    try {
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      const previous = await window.openmontage.undoProject(projectPath); setProject(previous);
      await refreshHistory(projectPath); setNotice('Undo complete');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function redo() {
    if (!project || !projectPath || !canRedo) return;
    try {
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      const next = await window.openmontage.redoProject(projectPath); setProject(next);
      await refreshHistory(projectPath); setNotice('Redo complete');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function exportVideo() {
    if (!project) return;
    try {
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      setExportProgress(0); setError('');
      const result = await window.openmontage.exportVideo(projectPath);
      if (result) { setNotice(`Export complete · ${result.outputPath}`); await window.openmontage.reveal(result.outputPath); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExportProgress(null); }
  }
  async function generateAutomaticMontage(options: AutoMontageOptions): Promise<GeneratedAutoMontages | null> {
    if (!project || !projectPath) return null;
    return window.openmontage.generateAutomaticMontages(projectPath, options);
  }
  async function openAutomaticMontageVariant(variant: GeneratedAutoMontageVariant) {
    try {
      const result = await window.openmontage.openProjectFile(variant.projectPath);
      load(result);
      setShowMontageGenerator(false);
      setNotice(`Opened variant ${variant.plan.variant} · source project remains unchanged`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function loadTimelinePlaybackAt(time: number) {
    if (!project || !projectPath || timelinePlaybackBusy) return;
    try {
      setError(''); setTimelinePlaybackBusy(true); setTimelinePlaybackProgress(0); setNotice('Rendering playhead preview…');
      const result = await window.openmontage.renderTimelinePlayback(projectPath, time);
      if ('cancelled' in result) return;
      timelinePlaybackStart.current = secondsOf(result.startTime);
      autoplayTimelinePlayback.current = true;
      setTimelinePlayback(result);
      setNotice('Timeline preview ready');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTimelinePlaybackBusy(false); setTimelinePlaybackProgress(null);
    }
  }
  async function togglePlayback() {
    if (previewMode === 'source') {
      const video = mediaRef.current;
      if (video) video.paused ? void video.play() : video.pause();
      return;
    }
    const video = timelinePlaybackRef.current;
    if (video && !video.paused) { video.pause(); return; }
    const segmentStart = currentTimelinePlayback ? secondsOf(currentTimelinePlayback.startTime) : 0;
    const segmentEnd = currentTimelinePlayback ? segmentStart + secondsOf(currentTimelinePlayback.duration) : 0;
    if (currentTimelinePlayback && video && playhead >= segmentStart && playhead <= segmentEnd) {
      video.currentTime = Math.min(playhead - segmentStart, Number.isFinite(video.duration) ? video.duration : playhead - segmentStart);
      void video.play().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    await loadTimelinePlaybackAt(playhead);
  }
  function seekTo(time: number) {
    const video = timelinePlaybackRef.current;
    setPlayhead(time);
    if (previewMode === 'timeline' && currentTimelinePlayback && video) {
      const localTime = time - secondsOf(currentTimelinePlayback.startTime);
      if (localTime >= 0 && localTime <= secondsOf(currentTimelinePlayback.duration)) video.currentTime = localTime;
      else if (!video.paused) video.pause();
    }
  }
  async function splitSelected() {
    if (!project || !currentClip) return;
    await run(() => window.openmontage.splitClip(projectPath, currentClip.clip.id, playhead), (next) => next, `Split at ${formatTime(playhead)}`);
  }
  async function duplicateSelected() {
    if (!project || !currentClip) return;
    const previousIds = new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
    await run(() => window.openmontage.duplicateClip(projectPath, currentClip.clip.id), (next) => {
      const duplicate = next.tracks.flatMap((track) => track.clips).find((clip) => !previousIds.has(clip.id));
      if (duplicate) { setSelectedClipId(duplicate.id); setPlayhead(secondsOf(duplicate.start)); }
      return next;
    }, 'Clip duplicated');
  }
  async function removeSelected() {
    if (!project || !currentClip) return;
    const id = currentClip.clip.id;
    await run(() => window.openmontage.removeClip(projectPath, id), (next) => next, 'Clip removed');
    setSelectedClipId(null);
  }
  async function patchClip(patch: { start?: number; sourceIn?: number; duration?: number }) {
    if (!project || !currentClip) return;
    await run(() => window.openmontage.trimClip(projectPath, currentClip.clip.id, patch), (next) => next, 'Clip updated');
  }
  async function patchClipAudio(patch: { audioEnabled?: boolean; volume?: number; fadeIn?: number; fadeOut?: number }) {
    if (!project || !currentClip) return;
    await run(() => window.openmontage.setClipAudio(projectPath, currentClip.clip.id, patch), (next) => next, 'Clip audio updated');
  }
  async function patchClipEffects(patch: Partial<Pick<TimelineClip, 'playbackRate' | 'speedKeyframes' | 'transform' | 'color' | 'keyframes' | 'transitionIn' | 'title' | 'normalizeAudio' | 'blendMode' | 'chromaKey' | 'mask'>>) {
    if (!project || !currentClip) return;
    await run(() => window.openmontage.setClipEffects(projectPath, currentClip.clip.id, patch), (next) => next, 'Clip effects updated');
  }
  async function generateModelMask(clipId: string, options: SegmentationOptions) {
    if (!project || !projectPath) return;
    try {
      setError('');
      const next = await window.openmontage.generateClipModelMask(projectPath, clipId, options);
      setProject(next);
      await refreshHistory(projectPath);
      setNotice('AI mask generated');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      throw cause;
    }
  }
  function beginClipTrim(event: React.PointerEvent<HTMLSpanElement>, clip: TimelineClip, asset: MediaAsset, edge: 'left' | 'right') {
    if (!project) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const frameStep = Number(project.frameRate.den) / Number(project.frameRate.num);
    const start = secondsOf(clip.start), sourceIn = secondsOf(clip.sourceIn), duration = secondsOf(clip.duration);
    let latest = { clipId: clip.id, start, sourceIn, duration };
    setTrimDraft(latest);
    const move = (pointer: PointerEvent) => {
      const deltaFrames = Math.round((pointer.clientX - originX) / timelineScale / frameStep);
      const rawDelta = deltaFrames * frameStep;
      if (edge === 'left') {
        const startRate = secondsOf(clip.playbackRate ?? rational(1));
        const delta = Math.max(Math.max(-start, -sourceIn / Math.max(startRate, 0.001)), Math.min(duration - frameStep, rawDelta));
        latest = { clipId: clip.id, start: start + delta, sourceIn: sourceIn + clipSourceOffsetAtSeconds(clip, delta), duration: duration - delta };
      } else {
        const maxDelta = secondsOf(asset.duration) - sourceIn - duration;
        const delta = Math.max(frameStep - duration, Math.min(maxDelta, rawDelta));
        latest = { clipId: clip.id, start, sourceIn, duration: duration + delta };
      }
      setTrimDraft(latest);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    };
    const finish = () => {
      cleanup(); setTrimDraft(null);
      void run(() => window.openmontage.trimClip(projectPath, clip.id, { start: latest.start, sourceIn: latest.sourceIn, duration: latest.duration }), (next) => next, 'Clip trimmed');
    };
    const cancel = () => { cleanup(); setTrimDraft(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', cancel, { once: true });
  }
  async function save() {
    if (!project) return;
    try { await window.openmontage.saveProject(projectPath, project); await refreshHistory(projectPath); setNotice('Project saved'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function relinkAsset(mediaId: string) {
    try {
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      const next = await window.openmontage.relinkMedia(projectPath, mediaId);
      if (!next) return;
      setProject(next); await refreshMissingMedia(projectPath); await refreshHistory(projectPath);
      setNotice(`Relinked ${next.media.find((asset) => asset.id === mediaId)?.name ?? 'media file'}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function saveProjectSettings(patch: { name: string; width: number; height: number; frameRate: Project['frameRate'] }) {
    try {
      await window.openmontage.cancelTimelinePlayback(projectPath).catch(() => undefined);
      const next = await window.openmontage.updateProjectProfile(projectPath, patch);
      setProject(next); await refreshHistory(projectPath); setShowProjectSettings(false); setNotice('Project settings saved');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message); throw cause;
    }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void (event.shiftKey ? redo() : undo()); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); void createProject(); }
      else if (event.key === 'Delete' && currentClip) { event.preventDefault(); void removeSelected(); }
      else if (event.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { event.preventDefault(); void togglePlayback(); }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  });

  function timelineClick(event: React.MouseEvent<HTMLDivElement>, track: TimelineTrack) {
    const rect = event.currentTarget.getBoundingClientRect();
    const rawAt = Math.max(0, (event.clientX - rect.left) / timelineScale);
    const at = snapEnabled && project ? snapTimelineTime(project, rawAt, timelineScale, audioAnalyses) : rawAt;
    seekTo(at);
    if (selectedMedia) void addMediaToTimeline(selectedMedia, at, track.id);
  }

  if (!project) return <div className="welcome">
    <div className="welcome-card">
      <div className="brand-mark"><Clapperboard size={28} /></div>
      <div className="eyebrow">LOCAL-FIRST VIDEO EDITOR</div>
      <h1>ClipPulse</h1>
      <p>Create, cut, and export music-driven video edits. Your source files stay where they are.</p>
      <div className="welcome-actions"><button className="primary" onClick={() => void createProject()}><Plus size={16} /> New project</button><button onClick={() => void openProject()}><FolderOpen size={16} /> Open project</button><button onClick={() => setShowMcpSetup(true)}><Bot size={16} /> Connect AI agent</button></div>
      <div className="runtime" title={ffmpegMessage || undefined}><span className={ffmpeg ? 'dot online' : 'dot'} />{ffmpeg ? 'FFmpeg ready' : 'FFmpeg needs attention'} · ClipPulse{appVersion ? ` v${appVersion}` : ''}</div>
      {error && <div className="error-box">{error}</div>}
    </div>
  </div>;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark small"><Clapperboard size={17} /></div><strong>ClipPulse</strong></div>
      <div className="project-title"><span className="project-dot" />{project.name}<span className="path-label">{projectPath}</span></div>
      <div className="toolbar">
        <button className="toolbar-button" title="New project (Ctrl+N)" onClick={() => void createProject()}><FilePlus2 size={14} /> New</button>
        <button className="toolbar-button" title="Open project (Ctrl+O)" onClick={() => void openProject()}><FolderOpen size={14} /> Open</button>
        <button className="icon-button" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => void undo()}><Undo2 size={16} /></button>
        <button className="icon-button" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => void redo()}><Redo2 size={16} /></button>
        <button className="toolbar-button" onClick={() => void save()}><Check size={15} /> Save</button>
        <button className="toolbar-button" title="Connect Codex or Claude Code" onClick={() => setShowMcpSetup(true)}><Bot size={14} /> Agent</button>
        <button className="toolbar-button montage-button" title="Generate separate editable montage variants" onClick={() => setShowMontageGenerator(true)}><Sparkles size={14} /> Auto edit</button>
        <button className="export-button" disabled={!ffmpeg || exportProgress !== null} onClick={() => void exportVideo()}><Upload size={15} />{exportProgress === null ? 'Export' : `${Math.round(exportProgress * 100)}%`}</button>
      </div>
    </header>

    <div className="workspace">
      <aside className="media-panel panel">
        <div className="panel-heading"><div><span className="eyebrow">PROJECT</span><h2>Media</h2></div><div className="panel-actions"><button className="square-button" title="Import Medal capture folder" onClick={() => void importMedalFolder()}><Medal size={16} /></button><button className="square-button" title="Import media" onClick={() => void importMedia()}><Import size={16} /></button></div></div>
        <div className="search-wrap"><span>⌕</span><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search media" /><kbd>⌘ K</kbd></div>
        <div className="media-count"><span>{visibleMedia.length} / {project.media.length} ASSETS</span><div><select className="media-sort" value={mediaSort} onChange={(event) => setMediaSort(event.target.value as typeof mediaSort)} aria-label="Sort media"><option value="recent">Recent</option><option value="name">Name</option><option value="duration">Longest</option><option value="rating">Top rated</option></select><button className={`favorite-filter ${favoriteOnly ? "enabled" : ""}`} title="Show favorites only" onClick={() => setFavoriteOnly((value) => !value)}><Star size={12} fill={favoriteOnly ? "currentColor" : "none"} /></button></div></div>
        {importRoots.length > 0 && <details className="watch-folders"><summary><FolderSync size={12} /> {importRoots.filter((root) => root.watching).length} folder{importRoots.filter((root) => root.watching).length === 1 ? '' : 's'} watched <ChevronDown size={11} /></summary><div className="watch-root-list">{importRoots.map((root) => <div className="watch-root" key={root.path}><span title={root.path}>{root.path}</span><button className={`switch mini-switch ${root.watching ? 'on' : ''}`} title={root.watching ? 'Stop watching folder' : 'Watch folder for new clips'} onClick={async () => { try { setImportRoots(await window.openmontage.setImportRootWatching(projectPath, root.path, !root.watching)); setNotice(root.watching ? 'Folder watch paused' : 'Folder watch enabled'); } catch (cause) { setError(String(cause)); } }}><i /></button></div>)}</div></details>}
        <div ref={mediaListRef} className="media-list" onScroll={(event) => setMediaScrollTop(event.currentTarget.scrollTop)}>
          {visibleMedia.length === 0 && <div className="empty-small"><HardDrive size={22} /><span>No media imported</span><button onClick={() => void importMedia()}>Browse files</button></div>}
          {mediaWindow.topPadding > 0 && <div className="media-virtual-spacer" style={{ height: mediaWindow.topPadding }} aria-hidden="true" />}
          {visibleMedia.slice(mediaWindow.start, mediaWindow.end).map((asset) => <button key={asset.id} className={`media-card ${selectedMediaId === asset.id ? 'selected' : ''} ${missingMediaIds.includes(asset.id) ? 'missing' : ''}`} onClick={() => { setSelectedMediaId(asset.id); setSelectedClipId(null); }} onDoubleClick={() => void addMediaToTimeline(asset)}>
            <div className="media-thumb">{asset.thumbnailPath ? <img src={window.openmontage.toFileUrl(asset.thumbnailPath)} /> : <div className="audio-art"><Music2 size={20} /></div>}<span className="duration-pill">{formatTime(secondsOf(asset.duration))}</span>{asset.hasAudio && <span className={`analysis-status ${audioAnalysisStatuses[asset.id] ?? 'not-started'}`}>{audioAnalysisStatuses[asset.id] === 'running' ? 'ANALYZING' : audioAnalysisStatuses[asset.id] === 'complete' ? 'ANALYZED' : audioAnalysisStatuses[asset.id] === 'failed' ? 'FAILED' : 'NOT RUN'}</span>}</div>
            <div className="media-info"><strong title={asset.name}>{asset.name}</strong><span>{asset.kind === 'video' ? `${asset.width ?? '?'} × ${asset.height ?? '?'} · ${asset.frameRate ? `${Number(asset.frameRate.num) / Number(asset.frameRate.den)} fps` : 'Video'}` : 'Audio'}</span>{(asset.tags?.length || asset.game) && <small>{[asset.game, ...(asset.tags ?? [])].filter(Boolean).join(' · ')}</small>}</div>
            {asset.kind === 'video' ? <Film className="type-icon" size={14} /> : <AudioLines className="type-icon" size={14} />}
            {missingMediaIds.includes(asset.id) && <span className="missing-badge">MISSING</span>}
            <span className="favorite-control" onClick={(event) => { event.stopPropagation(); void run(() => window.openmontage.updateMediaMetadata(projectPath, asset.id, { favorite: !asset.favorite }), (next) => next, asset.favorite ? 'Removed from favorites' : 'Added to favorites'); }} title={asset.favorite ? 'Remove favorite' : 'Add to favorites'}><Star size={13} fill={asset.favorite ? 'currentColor' : 'none'} /></span>
          </button>)}
          {mediaWindow.bottomPadding > 0 && <div className="media-virtual-spacer" style={{ height: mediaWindow.bottomPadding }} aria-hidden="true" />}
        </div>
        <div className="panel-footer" title={ffmpegMessage || undefined}><span className={ffmpeg ? 'status-light good' : 'status-light'} />{ffmpeg ? 'FFmpeg ready' : 'FFmpeg needs attention'}{appVersion && <span className="footer-version">v{appVersion}</span>}</div>
      </aside>

      <main className="center-panel">
        <section className="monitor panel">
          <div className="monitor-toolbar"><div className="monitor-tabs"><button className={previewMode === 'timeline' ? 'active-tab' : ''} onClick={() => setPreviewMode('timeline')}><Layers2 size={14} /> Timeline</button><button className={previewMode === 'source' ? 'active-tab' : ''} onClick={() => setPreviewMode('source')}><Video size={14} /> Source</button></div><div className="monitor-meta"><span>{project.width} × {project.height}</span><span>{Number(project.frameRate.num) / Number(project.frameRate.den)} FPS</span><button className="square-button small-square" onClick={() => setShowProjectSettings(true)} title="Project settings"><Settings2 size={14} /></button></div></div>
          <div className="monitor-stage">
            {previewMode === 'timeline' ? <>{currentTimelinePlayback ? <video ref={timelinePlaybackRef} key={currentTimelinePlayback.path} src={window.openmontage.toFileUrl(currentTimelinePlayback.path)} onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                video.currentTime = Math.min(Math.max(0, playhead - timelinePlaybackStart.current), video.duration || 0);
                if (autoplayTimelinePlayback.current) {
                  autoplayTimelinePlayback.current = false;
                  void video.play().catch(() => setNotice('Preview rendered — press Play to start'));
                }
              }} onTimeUpdate={(event) => setPlayhead(timelinePlaybackStart.current + event.currentTarget.currentTime)} onPlay={() => setTimelinePlaying(true)} onPause={() => setTimelinePlaying(false)} onEnded={(event) => {
                const end = timelinePlaybackStart.current + event.currentTarget.duration;
                setTimelinePlaying(false); setPlayhead(end);
                if (currentTimelinePlayback?.hasMore) void loadTimelinePlaybackAt(end);
              }} /> : timelineFramePath ? <img className="timeline-preview-image" src={`${window.openmontage.toFileUrl(timelineFramePath)}?v=${project.updatedAt}`} /> : <div className="monitor-placeholder"><div className="placeholder-grid" /><div className="placeholder-icon"><Layers2 size={32} /></div><strong>Timeline preview</strong><span>Scrub the playhead to view the edit</span><div className="playhead-time">{formatTime(playhead)}</div></div>}{(timelinePlaybackBusy || timelinePreviewBusy) && <span className="preview-busy">{timelinePlaybackBusy ? `Rendering playhead${timelinePlaybackProgress === null ? '…' : ` ${Math.round(timelinePlaybackProgress * 100)}%`}` : 'Rendering frame…'}</span>}</> : activeMedia?.kind === 'video' ? <video ref={mediaRef} key={`${activeMedia.id}:${sourcePreviewPath}`} src={window.openmontage.toFileUrl(sourcePreviewPath!)} controls onTimeUpdate={(event) => {
              const videoTime = event.currentTarget.currentTime;
              sourcePreviewPosition.current = { mediaId: activeMedia.id, contentHash: activeMedia.contentHash, time: videoTime };
              if (currentClip) setPlayhead(secondsOf(currentClip.clip.start) + Math.max(0, videoTime - secondsOf(currentClip.clip.sourceIn)));
              else setPlayhead(videoTime);
            }} onLoadedMetadata={(event) => {
              if (currentClip) event.currentTarget.currentTime = secondsOf(currentClip.clip.sourceIn) + Math.max(0, playhead - secondsOf(currentClip.clip.start));
              else event.currentTarget.currentTime = sourcePreviewPosition.current?.mediaId === activeMedia.id && sourcePreviewPosition.current.contentHash === activeMedia.contentHash
                ? Math.min(sourcePreviewPosition.current.time, event.currentTarget.duration || sourcePreviewPosition.current.time)
                : 0;
            }} /> : <div className="monitor-placeholder"><div className="placeholder-grid" /><div className="placeholder-icon">{activeMedia ? <Music2 size={32} /> : <Clapperboard size={38} />}</div><strong>{activeMedia ? activeMedia.name : 'Source monitor'}</strong><span>{activeMedia ? 'Audio asset selected' : 'Select a clip or import footage to begin'}</span><div className="playhead-time">{formatTime(playhead)}</div></div>}
          </div>
          <div className="monitor-bottom"><div className="transport"><button className="transport-button" onClick={() => { const step = Number(project.frameRate.den) / Number(project.frameRate.num); if (previewMode === 'source' && mediaRef.current) mediaRef.current.currentTime = Math.max(0, mediaRef.current.currentTime - step); else seekTo(Math.max(0, playhead - step)); }} title="Previous frame"><span>◀|</span></button><button className="play-button" disabled={!ffmpeg || timelinePlaybackBusy || (previewMode === 'timeline' && !project.tracks.some((track) => track.clips.length > 0)) || (previewMode === 'source' && activeMedia?.kind !== 'video')} title={previewMode === 'timeline' ? (timelinePlaying ? 'Pause timeline' : 'Render and play timeline') : 'Play source video'} onClick={() => void togglePlayback()}>{timelinePlaying || (previewMode === 'source' && mediaRef.current?.paused === false) ? <Pause size={17} /> : <Play size={17} fill="currentColor" />}</button><button className="transport-button" onClick={() => { const step = Number(project.frameRate.den) / Number(project.frameRate.num); if (previewMode === 'source' && mediaRef.current) mediaRef.current.currentTime += step; else seekTo(Math.min(duration, playhead + step)); }} title="Next frame"><span>|▶</span></button></div><div className="time-readout">{formatTime(playhead)} <span>/ {formatTime(duration)}</span></div><div className="monitor-right"><Volume2 size={15} /><span>Fit</span><ChevronDown size={13} /></div></div>
        </section>

        <section className="timeline-panel panel">
          <div className="timeline-header"><div className="timeline-title"><span className="eyebrow">EDIT</span><h2>Timeline</h2><span className="timeline-duration"><Clock3 size={13} />{formatTime(duration)}</span></div><div className="timeline-actions"><button className="tool-chip" disabled={!currentClip} onClick={() => void splitSelected()} title="Split at playhead"><Scissors size={14} /> Split</button><button className="tool-chip" disabled={!currentClip} onClick={() => void duplicateSelected()} title="Duplicate selected clip"><Copy size={14} /> Duplicate</button><button className="tool-chip" disabled={!currentClip} onClick={() => void removeSelected()}><Trash2 size={14} /></button><span className="divider" /><button className="tool-chip" onClick={() => void addTrack('video')}><Plus size={14} /> Video</button><button className="tool-chip" onClick={() => void addTrack('audio')}><Plus size={14} /> Audio</button><button className={`tool-chip snap-toggle ${snapEnabled ? "active" : ""}`} onClick={() => setSnapEnabled((enabled) => !enabled)} title={snapEnabled ? "Disable snapping to beats and clip edges" : "Enable snapping to beats and clip edges"}><Magnet size={14} />{snapEnabled ? "Snap" : "Snap off"}</button><button className="tool-chip" onClick={() => setTimelineScale((scale) => scale >= 384 ? 48 : scale * 2)} title={`Timeline zoom · ${timelineScale} pixels per second`}><Gauge size={14} />{Math.round(timelineScale / 96 * 100)}%</button></div></div>
          <div className="timeline-scroll" ref={timelineRef}>
            <div className="timeline-content" style={{ width: Math.max(920, duration * timelineScale + 50) }}>
              <div className="ruler"><div className="track-gutter ruler-gutter">TIME</div><div className="ruler-track">{Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => <div key={i} className="ruler-tick" style={{ left: i * timelineScale }}><span>{formatTime(i).slice(3)}</span><i /></div>)}<div className="timeline-cursor" style={{ left: playhead * timelineScale }}><div /></div></div></div>
              <div className="track-stack">
                {project.tracks.slice().reverse().map((track) => <div key={track.id} className="track-row">
                  <div className="track-gutter">
                    <div className={`track-type ${track.kind}`}><span>{track.kind === 'video' ? <Video size={14} /> : <AudioLines size={14} />}</span><div><strong>{track.name}</strong><small>{track.kind === 'video' ? 'VIDEO' : 'AUDIO'}</small></div></div>
                    <div className="track-controls">
                      <button title={track.muted ? 'Unmute track' : 'Mute track'} className={track.muted ? 'muted' : ''} onClick={() => void run(() => window.openmontage.updateTrack(projectPath, track.id, { muted: !track.muted }), (next) => next, track.muted ? 'Track unmuted' : 'Track muted')}>{track.kind === 'video' ? <EyeIcon muted={track.muted} /> : <Volume2 size={12} />}</button>
                      <button className={`track-solo ${track.solo ? 'solo-active' : ''}`} title={track.solo ? 'Disable track solo' : 'Solo track'} onClick={() => void run(() => window.openmontage.updateTrack(projectPath, track.id, { solo: !track.solo }), (next) => next, track.solo ? 'Track solo disabled' : 'Track solo enabled')}><span>S</span></button>
                      <button title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => void run(() => window.openmontage.updateTrack(projectPath, track.id, { locked: !track.locked }), (next) => next, track.locked ? 'Track unlocked' : 'Track locked')}><span className={track.locked ? 'lock-active' : ''}>⌑</span></button>
                    </div>
                    {track.kind === 'audio' && <TrackAudioControls track={track} project={project} playhead={playhead} onUpdate={(patch) => void run(() => window.openmontage.updateTrack(projectPath, track.id, patch), (next) => next, 'Track audio updated')} />}
                  </div>
                  <div className="track-lane" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
                    event.preventDefault(); const clipId = event.dataTransfer.getData('text/clip-id'); if (!clipId) return;
                    const bounds = event.currentTarget.getBoundingClientRect(); const rawAt = Math.max(0, (event.clientX - bounds.left + event.currentTarget.scrollLeft) / timelineScale); const at = snapEnabled ? snapTimelineTime(project, rawAt, timelineScale, audioAnalyses) : rawAt;
                    void run(() => window.openmontage.moveClip(projectPath, clipId, at, track.id), (next) => next, 'Clip moved');
                  }} onClick={(event) => timelineClick(event, track)}>
                    {Array.from({ length: Math.ceil(duration) + 1 }, (_, i) => <span className="gridline" key={i} style={{ left: i * timelineScale }} />)}
                    {track.clips.map((clip, index) => {
                      const asset = project.media.find((item) => item.id === clip.mediaId)!;
                      const trimmed = trimDraft?.clipId === clip.id ? trimDraft : null;
                      const start = trimmed?.start ?? secondsOf(clip.start), clipDuration = trimmed?.duration ?? secondsOf(clip.duration), width = Math.max(22, clipDuration * timelineScale);
                      const clipWaveform = !trimmed && track.kind === 'audio' && asset.hasAudio ? mediaJobs.find((job) => job.kind === 'clip-waveform' && job.mediaId === asset.id && job.sourceContentHash === asset.contentHash && job.clipId === clip.id && job.zoomPixelsPerSecond === timelineScale && job.sourceInSeconds === secondsOf(clip.sourceIn) && job.clipDurationSeconds === secondsOf(clip.duration) && job.state === 'complete') : undefined;
                      const artworkPath = clipWaveform?.outputPath ?? asset.thumbnailPath;
                      const clipArtworkStyle: React.CSSProperties | undefined = asset.kind === 'audio' && artworkPath && artworkPath === asset.thumbnailPath ? {
                        width: `${secondsOf(asset.duration) / clipDuration * 100}%`,
                        left: `${-(trimmed?.sourceIn ?? secondsOf(clip.sourceIn)) / clipDuration * 100}%`,
                        objectFit: 'fill', opacity: 0.72
                      } : clipWaveform ? { width: '100%', left: 0, objectFit: 'fill', opacity: 0.8 } : undefined;
                      const beatOffsets = asset.kind === 'audio' ? audioClipBeatOffsets(clip, audioAnalyses[asset.id]) : [];
                      const downbeatOffsets = asset.kind === 'audio' ? audioClipDownbeatOffsets(clip, audioAnalyses[asset.id]) : [];
                      const dropOffsets = asset.kind === 'audio' ? audioClipDropOffsets(clip, audioAnalyses[asset.id]) : [];
                      const fadeInSeconds = secondsOf(clip.fadeIn ?? rational(0)), fadeOutSeconds = secondsOf(clip.fadeOut ?? rational(0));
                      const envelopeFrames = track.kind === 'audio' ? [
                        { time: 0, value: fadeInSeconds > 0 ? 0 : clip.volume * (track.volume ?? 1) },
                        ...(fadeInSeconds > 0 ? [{ time: fadeInSeconds, value: clip.volume * (track.volume ?? 1) }] : []),
                        ...(clip.keyframes ?? []).filter((frame) => frame.property === 'volume').map((frame) => ({ time: secondsOf(frame.time), value: frame.value * (track.volume ?? 1) })),
                        ...(track.volumeKeyframes ?? []).filter((frame) => secondsOf(frame.time) >= start && secondsOf(frame.time) <= start + clipDuration).map((frame) => ({ time: secondsOf(frame.time) - start, value: frame.value * clip.volume })),
                        ...(fadeOutSeconds > 0 ? [{ time: clipDuration - fadeOutSeconds, value: clip.volume * (track.volume ?? 1) }, { time: clipDuration, value: 0 }] : []),
                        { time: clipDuration, value: fadeOutSeconds > 0 ? 0 : clip.volume * (track.volume ?? 1) }
                      ].sort((a, b) => a.time - b.time) : [];
                      const envelopePoints = envelopeFrames.map((frame) => `${Math.max(0, Math.min(100, frame.time / Math.max(clipDuration, 0.001) * 100))},${100 - Math.max(0, Math.min(100, frame.value / 8 * 90 + 5))}`).join(' ');
                      return <div key={clip.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/clip-id', clip.id)} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); setSelectedMediaId(asset.id); setPlayhead(start); }} className={`timeline-clip ${track.kind} ${selectedClipId === clip.id ? 'active' : ''}`} style={{ left: start * timelineScale, width, '--clip-hue': `${(index * 61 + asset.name.length * 13) % 360}` } as React.CSSProperties}>
                        {artworkPath && <img className="clip-filmstrip" style={clipArtworkStyle} src={`${window.openmontage.toFileUrl(artworkPath)}${clipWaveform ? `?v=${clipWaveform.updatedAt}` : ''}`} />}
                        {track.kind === 'audio' && envelopeFrames.length > 2 && <svg className="clip-audio-envelope" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Audio gain automation"><polyline points={envelopePoints} /></svg>}
                        {beatOffsets.length > 0 && <span className="timeline-beat-markers" aria-hidden="true">{beatOffsets.map((offset, beatIndex) => <i key={beatIndex} className={downbeatOffsets.includes(offset) ? 'downbeat' : ''} style={{ left: `${offset * 100}%` }} />)}{dropOffsets.map((offset, dropIndex) => <i key={`drop-${dropIndex}`} className="drop" style={{ left: `${offset * 100}%` }} />)}</span>}
                        <div className="clip-content"><strong>{asset.name}</strong><span>{formatTime(clipDuration)}</span></div>
                        <span className="clip-edge left" onPointerDown={(event) => beginClipTrim(event, clip, asset, 'left')} title="Drag to trim clip start" /><span className="clip-edge right" onPointerDown={(event) => beginClipTrim(event, clip, asset, 'right')} title="Drag to trim clip end" />
                      </div>;
                    })}
                    <div className="lane-playhead" style={{ left: playhead * timelineScale }} />
                  </div>
                </div>)}
              </div>
            </div>
          </div>
          <div className="timeline-foot"><span>Drag clips to move · drag edges to trim · click an empty lane to add selected media</span><span>{project.tracks.length} tracks <i /> {project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} clips</span></div>
        </section>
      </main>

      <aside className="inspector-panel panel">
        <div className="panel-heading inspector-heading"><div><span className="eyebrow">DETAILS</span><h2>Inspector</h2></div><button className="square-button" title="Inspector settings"><Settings2 size={15} /></button></div>
        {currentClip && project ? <>
          <div className="inspector-asset"><div className="inspector-thumb">{project.media.find((item) => item.id === currentClip.clip.mediaId)?.thumbnailPath ? <img src={window.openmontage.toFileUrl(project.media.find((item) => item.id === currentClip.clip.mediaId)!.thumbnailPath!)} /> : <Film size={19} />}</div><div><strong>{project.media.find((item) => item.id === currentClip.clip.mediaId)?.name}</strong><small>{currentClip.track.name} · {currentClip.clip.id.slice(0, 8)}</small></div></div>
          <section className="inspector-section"><div className="section-label"><span>TRANSFORM</span><button><ChevronDown size={14} /></button></div><NumberField label="Timeline start" unit="s" value={secondsOf(currentClip.clip.start)} step={1 / Number(project.frameRate.num) * Number(project.frameRate.den)} onCommit={(start) => void patchClip({ start })} /><NumberField label="Source in" unit="s" value={secondsOf(currentClip.clip.sourceIn)} step={1 / Number(project.frameRate.num) * Number(project.frameRate.den)} onCommit={(sourceIn) => void patchClip({ sourceIn })} /><NumberField label="Duration" unit="s" value={secondsOf(currentClip.clip.duration)} step={1 / Number(project.frameRate.num) * Number(project.frameRate.den)} onCommit={(duration) => void patchClip({ duration })} /><div className="frame-info"><span>START FRAME</span><strong>{frameLabel(currentClip.clip.start, project.frameRate)}</strong><span>END FRAME</span><strong>{frameLabel(addTime(currentClip.clip.start, currentClip.clip.duration), project.frameRate)}</strong></div></section>
          <section className="inspector-section"><div className="section-label"><span>AUDIO</span><button><ChevronDown size={14} /></button></div><div className="toggle-row"><span><Volume2 size={14} /> Clip audio</span><button className={`switch ${currentClip.clip.audioEnabled ? 'on' : ''}`} onClick={() => void patchClipAudio({ audioEnabled: !currentClip.clip.audioEnabled })}><i /></button></div>
            <NumberField label="Volume" unit="×" value={currentClip.clip.volume} min={0} max={8} step={0.05} onCommit={(volume) => void patchClipAudio({ volume })} />
            <NumberField label="Fade in" unit="s" value={secondsOf(currentClip.clip.fadeIn ?? rational(0))} max={secondsOf(currentClip.clip.duration)} step={Number(project.frameRate.den) / Number(project.frameRate.num)} onCommit={(fadeIn) => void patchClipAudio({ fadeIn })} />
            <NumberField label="Fade out" unit="s" value={secondsOf(currentClip.clip.fadeOut ?? rational(0))} max={secondsOf(currentClip.clip.duration)} step={Number(project.frameRate.den) / Number(project.frameRate.num)} onCommit={(fadeOut) => void patchClipAudio({ fadeOut })} />
            <div className="toggle-row"><span><Activity size={14} /> Loudness normalization</span><button className={`switch ${currentClip.clip.normalizeAudio ? 'on' : ''}`} onClick={() => void patchClipEffects({ normalizeAudio: !currentClip.clip.normalizeAudio })}><i /></button></div>
          </section>
          <ClipEffectsInspector key={currentClip.clip.id} clip={currentClip.clip} project={project} playhead={playhead} onPatch={(patch) => void patchClipEffects(patch)} onGenerateModelMask={(options) => generateModelMask(currentClip.clip.id, options)} />
        </> : selectedMedia ? <MediaInspector asset={selectedMedia} projectPath={projectPath} missing={missingMediaIds.includes(selectedMedia.id)} analysisStatus={audioAnalysisStatuses[selectedMedia.id]} onAnalysisStatus={setAudioAnalysisStatus} mediaJobs={mediaJobs} queuePaused={mediaJobsPaused} onQueueProxy={() => void generateProxy(selectedMedia.id)} onClearProxies={() => void clearProxyCache()} onPauseQueue={() => void setMediaQueuePaused(true)} onResumeQueue={() => void setMediaQueuePaused(false)} onRetryJob={(jobId) => void retryMediaJob(jobId)} onRelink={() => void relinkAsset(selectedMedia.id)} onSave={(patch) => void run(() => window.openmontage.updateMediaMetadata(projectPath, selectedMedia.id, patch), (next) => next, 'Media details saved')} onAnalysis={cacheAudioAnalysis} /> : <div className="inspector-empty"><div className="inspector-empty-icon"><WandSparkles size={20} /></div><strong>No clip selected</strong><span>Select a timeline clip to edit its timing and audio.</span></div>}
        <div className="inspector-footer"><span>PROJECT</span><strong>{project.name}</strong><small>{project.width} × {project.height} · {Number(project.frameRate.num) / Number(project.frameRate.den)} fps</small></div>
      </aside>
    </div>

    {showProjectSettings && <ProjectSettingsModal project={project} onClose={() => setShowProjectSettings(false)} onSave={saveProjectSettings} />}
    {showMcpSetup && <McpSetupModal onClose={() => setShowMcpSetup(false)} />}
    {showMontageGenerator && <AutoMontageModal project={project} onClose={() => setShowMontageGenerator(false)} onGenerate={generateAutomaticMontage} onOpenVariant={openAutomaticMontageVariant} onImportMusic={importMusicForMontage} />}

    <footer className="statusbar"><span className={error ? 'status-error' : ''}>{error ? error : notice}</span><span className="status-right"><i className={ffmpeg ? 'online' : ''} />{ffmpeg ? 'Ready' : 'FFmpeg missing'} <span className="status-separator" />{project ? `${project.media.length} media` : ''}</span></footer>
  </div>;
}

function McpSetupModal({ onClose }: { onClose: () => void }) {
  const [client, setClient] = useState<McpClientTarget>('codex');
  const [roots, setRoots] = useState<string[]>([]);
  const [existingConfiguration, setExistingConfiguration] = useState<McpExistingConfiguration | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [connection, setConnection] = useState<McpConnectionTest | null>(null);
  const [configuration, setConfiguration] = useState<McpSetupConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoadingExisting(true);
    setRoots([]); setExistingConfiguration(null); setConnection(null); setConfiguration(null); setError('');
    void window.openmontage.getMcpClientConfiguration(client).then((snapshot) => {
      if (!active) return;
      setExistingConfiguration(snapshot);
      setRoots(snapshot.allowedRoots);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setLoadingExisting(false); });
    return () => { active = false; };
  }, [client]);

  async function chooseRoot(purpose: 'media' | 'project-export') {
    setError('');
    try {
      const root = await window.openmontage.chooseMcpAllowedRoot(purpose);
      if (!root) return;
      setRoots((current) => current.some((item) => (window.navigator.platform.startsWith('Win') ? item.toLocaleLowerCase('en-US') === root.toLocaleLowerCase('en-US') : item === root)) ? current : [...current, root]);
      setConnection(null); setConfiguration(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function removeRoot(root: string) {
    setRoots((current) => current.filter((item) => item !== root));
    setConnection(null); setConfiguration(null);
  }
  async function testConnection() {
    setBusy(true); setError(''); setConnection(null); setConfiguration(null);
    try { setConnection(await window.openmontage.testMcpConnection(roots)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function createConfiguration() {
    setBusy(true); setError('');
    try {
      const result = await window.openmontage.configureMcpClient(client, roots);
      setConfiguration(result);
      setExistingConfiguration({ serverNames: [result.serverName], allowedRoots: result.allowedRoots, duplicateEntries: 0 });
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
    <section className="project-settings-modal mcp-setup-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-setup-title">
      <div className="montage-modal-heading"><div><span className="eyebrow">LOCAL AGENT CONNECTION</span><h2 id="mcp-setup-title">Connect an AI agent</h2></div><button type="button" className="square-button" disabled={busy} onClick={onClose} title="Close">×</button></div>
      <p>Choose an MCP client and the folders it may use. ClipPulse keeps one managed server entry, updates it when you change these folders, and saves a dated backup first.</p>
      <label className="mcp-client-select"><span>Agent client</span><select value={client} onChange={(event) => { setClient(event.target.value as McpClientTarget); setConnection(null); setConfiguration(null); }}><option value="codex">OpenAI Codex</option><option value="claude-code">Claude Code</option></select></label>
      <div className="mcp-access-note"><strong>Folder permissions</strong><span>The agent can read and write inside every folder below. Add the Medal/source clips, music, and a permanent project/export folder. A new Codex chat’s own <code>outputs</code> folder is not included automatically; use a stable folder you select here.</span></div>
      {existingConfiguration?.serverNames.length ? <div className="mcp-existing-config">Existing ClipPulse setup found: <code>{existingConfiguration.serverNames.join(', ')}</code>{existingConfiguration.duplicateEntries > 0 && ` · ${existingConfiguration.duplicateEntries} duplicate ${existingConfiguration.duplicateEntries === 1 ? 'entry' : 'entries'} will be consolidated`}</div> : null}
      <div className="mcp-roots-heading"><span>Allowed folders {loadingExisting ? '· loading saved access…' : ''}</span><div className="mcp-root-actions"><button type="button" className="text-action" onClick={() => void chooseRoot('media')} disabled={busy || loadingExisting}><Plus size={12} /> Add media/music</button><button type="button" className="text-action" onClick={() => void chooseRoot('project-export')} disabled={busy || loadingExisting}><Plus size={12} /> Add project/export</button></div></div>
      <div className="mcp-roots-list">
        {roots.map((root) => <div className="mcp-root" key={root}><FolderOpen size={14} /><span title={root}>{root}</span><button type="button" onClick={() => removeRoot(root)} aria-label={`Remove ${root}`} title="Remove folder">×</button></div>)}
        {!roots.length && !loadingExisting && <div className="mcp-empty-roots">Add source clips, music, and the permanent folder where projects and exports should be saved.</div>}
      </div>
      {connection && <div className={`mcp-connection-result ${connection.diagnostics.ffmpeg?.compatible === false ? 'attention' : 'success'}`}>
        <strong>{connection.server.name} {connection.server.version} · {connection.toolCount} tools available</strong>
        <span>MCP stdio initialization, tool discovery, and the harmless diagnostics call succeeded on {connection.diagnostics.platform}{connection.diagnostics.node ? ` · ${connection.diagnostics.node}` : ''}.</span>
        {connection.diagnostics.ffmpeg?.compatible === false && <span className="mcp-ffmpeg-warning">MCP is connected, but FFmpeg/FFprobe need attention: {connection.diagnostics.ffmpeg.message ?? 'An available compatible FFmpeg/FFprobe pair was not detected.'}</span>}
      </div>}
      {configuration && <div className="mcp-configuration-result"><strong>Configuration {configuration.action === 'updated' ? 'updated' : 'created'}</strong><span>{client === 'codex' ? 'Codex' : 'Claude Code'} · server <code>{configuration.serverName}</code></span>{configuration.removedDuplicateEntries > 0 && <small>Removed {configuration.removedDuplicateEntries} duplicate ClipPulse server {configuration.removedDuplicateEntries === 1 ? 'entry' : 'entries'}.</small>}<small>Configuration: {configuration.configPath}</small>{configuration.backupPath && <small>Backup: {configuration.backupPath}</small>}<small>Restart the selected client to load ClipPulse tools with these folders.</small></div>}
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" onClick={onClose} disabled={busy}>Close</button>
        <button type="button" onClick={() => void testConnection()} disabled={busy || loadingExisting || roots.length === 0}>{busy && !configuration ? 'Testing…' : 'Test connection'}</button>
        <button type="button" className="primary" onClick={() => void createConfiguration()} disabled={busy || loadingExisting || !connection}>{busy && connection ? 'Saving…' : existingConfiguration?.serverNames.length ? 'Update configuration' : 'Create configuration'}</button>
      </div>
      <div className="mcp-client-note">Claude Desktop uses Anthropic’s Desktop Extensions flow; this setup targets Claude Code. See MCP_SETUP.md for current client instructions and copyable examples.</div>
    </section>
  </div>;
}

type ClipEffectPatch = Partial<Pick<TimelineClip, 'playbackRate' | 'speedKeyframes' | 'transform' | 'color' | 'keyframes' | 'transitionIn' | 'title' | 'normalizeAudio' | 'blendMode' | 'chromaKey' | 'mask'>>;

function ClipEffectsInspector({ clip, project, playhead, onPatch, onGenerateModelMask }: { clip: TimelineClip; project: Project; playhead: number; onPatch: (patch: ClipEffectPatch) => void; onGenerateModelMask: (options: SegmentationOptions) => Promise<void> }) {
  const canComposite = project.media.find((asset) => asset.id === clip.mediaId)?.kind === 'video';
  const transform = clip.transform ?? { scale: 1, x: 0, y: 0, rotationDegrees: 0 };
  const color = clip.color ?? { brightness: 0, contrast: 1, saturation: 1 };
  const local = Math.max(0, Math.min(secondsOf(clip.duration), playhead - secondsOf(clip.start)));
  const localTime = frameTime(toFrame(parseDecimal(local), project.frameRate), project.frameRate);
  const [property, setProperty] = useState<NonNullable<TimelineClip['keyframes']>[number]['property']>('opacity');
  const [value, setValue] = useState('1');
  const [speedValue, setSpeedValue] = useState(String(secondsOf(clip.playbackRate ?? rational(1))));
  const [titleText, setTitleText] = useState(clip.title?.text ?? '');
  const [maskPathDraft, setMaskPathDraft] = useState(clip.mask ? maskPathAt(clip.mask, localTime) : '');
  const [segmentationClass, setSegmentationClass] = useState('person');
  const [segmentationFps, setSegmentationFps] = useState(2);
  const [segmentationBusy, setSegmentationBusy] = useState(false);
  const [segmentationProgress, setSegmentationProgress] = useState<SegmentationProgress | null>(null);
  useEffect(() => { setSpeedValue(String(secondsOf(clip.playbackRate ?? rational(1)))); }, [clip.playbackRate]);
  useEffect(() => { setTitleText(clip.title?.text ?? ''); }, [clip.title?.text]);
  useEffect(() => { setMaskPathDraft(clip.mask ? maskPathAt(clip.mask, localTime) : ''); }, [clip.mask, localTime]);
  useEffect(() => window.openmontage.onSegmentationProgress((event) => {
    if (event.clipId === clip.id) setSegmentationProgress(event);
  }), [clip.id]);

  function updateTransform(patch: Partial<NonNullable<TimelineClip['transform']>>) { onPatch({ transform: { ...transform, ...patch } }); }
  function updateColor(patch: Partial<NonNullable<TimelineClip['color']>>) { onPatch({ color: { ...color, ...patch } }); }
  function updateMask(patch: Partial<NonNullable<TimelineClip['mask']>>) {
    const mask = clip.mask ?? { path: maskPathDraft || 'M 0.2 0.2 L 0.8 0.2 L 0.8 0.8 L 0.2 0.8 Z', featherPx: 0, expansionPx: 0, keyframes: [] };
    const manualEdit = patch.path !== undefined || patch.keyframes !== undefined;
    onPatch({ mask: { ...mask, ...patch, ...(manualEdit ? { provenance: undefined } : {}) } });
  }
  function saveMaskPath() {
    if (!clip.mask || !maskPathDraft.trim()) return;
    if (compare(localTime, rational(0)) === 0) updateMask({ path: maskPathDraft.trim() });
    else addMaskTrackingKeyframe();
  }
  function addMaskTrackingKeyframe() {
    const path = maskPathDraft.trim();
    if (!path) return;
    const keyframes = (clip.mask?.keyframes ?? []).filter((frame) => compare(frame.time, localTime) !== 0);
    updateMask({ keyframes: [...keyframes, { time: localTime, path }].sort((a, b) => compare(a.time, b.time)) });
  }
  function addKeyframe() {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    const frames = (clip.keyframes ?? []).filter((frame) => frame.property !== property || compare(frame.time, localTime) !== 0);
    onPatch({ keyframes: [...frames, { property, time: localTime, value: number, interpolation: 'linear' as const }].sort((a, b) => compare(a.time, b.time)) });
  }
  function addSpeedKeyframe() {
    const rate = parseDecimal(speedValue);
    const frames = (clip.speedKeyframes ?? []).filter((frame) => compare(frame.time, localTime) !== 0);
    onPatch({ speedKeyframes: [...frames, { time: localTime, rate }].sort((a, b) => compare(a.time, b.time)) });
  }
  function updateTitle(patch: Partial<NonNullable<TimelineClip['title']>>) {
    const title = clip.title ?? { text: '', fontSize: 56, color: '#ffffff', x: 0.5, y: 0.12, start: rational(0), duration: clip.duration, box: true };
    onPatch({ title: { ...title, ...patch } });
  }
  function updateTransition(type: string) {
    if (type === 'none') { onPatch({ transitionIn: undefined }); return; }
    const duration = Math.min(0.5, secondsOf(clip.duration));
    onPatch({ transitionIn: { type: type as NonNullable<TimelineClip['transitionIn']>['type'], duration: parseDecimal(duration) } });
  }
  async function generateAiMask() {
    const className = segmentationClass.trim();
    if (!className) return;
    setSegmentationBusy(true);
    setSegmentationProgress({ stage: 'loading-model', current: 0, total: 0 });
    try { await onGenerateModelMask({ className, sampleFps: segmentationFps }); }
    catch { /* The parent reports the actionable error in the app status area. */ }
    finally { setSegmentationBusy(false); setSegmentationProgress(null); }
  }
  const segmentationStatus = segmentationProgress?.stage === 'loading-model' ? 'Loading model; first use downloads it'
    : segmentationProgress?.stage === 'extracting' ? `Preparing frame ${segmentationProgress.current}/${segmentationProgress.total}`
      : segmentationProgress?.stage === 'segmenting' ? `Segmenting frame ${segmentationProgress.current}/${segmentationProgress.total}`
        : segmentationProgress?.stage === 'stabilizing' ? 'Stabilizing mask motion…' : '';
  const keyframeRange: Record<typeof property, [number, number]> = { opacity: [0, 1], brightness: [-1, 1], contrast: [0, 4], saturation: [0, 4], volume: [0, 8] };
  return <>
    <section className="inspector-section"><div className="section-label"><span>VIDEO EFFECTS</span><ChevronDown size={14} /></div>
      <NumberField label="Scale" unit="×" value={transform.scale} min={0.1} max={4} step={0.05} onCommit={(scale) => updateTransform({ scale })} />
      <NumberField label="Position X" unit="px" value={transform.x} min={-project.width * 2} max={project.width * 2} step={1} onCommit={(x) => updateTransform({ x })} />
      <NumberField label="Position Y" unit="px" value={transform.y} min={-project.height * 2} max={project.height * 2} step={1} onCommit={(y) => updateTransform({ y })} />
      <NumberField label="Rotation" unit="°" value={transform.rotationDegrees} min={-360} max={360} step={1} onCommit={(rotationDegrees) => updateTransform({ rotationDegrees })} />
      <NumberField label="Brightness" unit="" value={color.brightness} min={-1} max={1} step={0.05} onCommit={(brightness) => updateColor({ brightness })} />
      <NumberField label="Contrast" unit="×" value={color.contrast} min={0} max={4} step={0.05} onCommit={(contrast) => updateColor({ contrast })} />
      <NumberField label="Saturation" unit="×" value={color.saturation} min={0} max={4} step={0.05} onCommit={(saturation) => updateColor({ saturation })} />
      <TextField label="3D LUT file" value={color.lutPath ?? ''} placeholder="Optional .cube path" onCommit={(lutPath) => updateColor({ lutPath: lutPath.trim() || undefined })} />
    </section>
    {canComposite && <section className="inspector-section"><div className="section-label"><span>COMPOSITING · PHASE F</span><ChevronDown size={14} /></div>
      <label className="text-field"><span>Blend mode</span><select value={clip.blendMode ?? 'normal'} onChange={(event) => onPatch({ blendMode: event.target.value as NonNullable<TimelineClip['blendMode']> })}><option value="normal">Normal alpha</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="add">Add</option><option value="difference">Difference</option></select></label>
      <div className="model-mask-controls">
        <label className="text-field"><span>AI object class</span><input aria-label="AI object class" value={segmentationClass} maxLength={80} placeholder="person, car, dog…" onChange={(event) => setSegmentationClass(event.target.value)} /></label>
        <label className="text-field"><span>Samples per second</span><select aria-label="Mask samples per second" value={segmentationFps} onChange={(event) => setSegmentationFps(Number(event.target.value))}><option value={0.5}>0.5</option><option value={1}>1</option><option value={2}>2</option><option value={4}>4</option><option value={8}>8</option></select></label>
        <button className="small-action" disabled={segmentationBusy || !segmentationClass.trim()} onClick={() => void generateAiMask()}><WandSparkles size={13} />{segmentationBusy ? 'Generating mask…' : clip.mask?.provenance ? 'Regenerate AI mask' : 'Generate AI mask'}</button>
        <small className="compositing-help">Tracks one recognized COCO object in the clip. The ONNX model downloads on first use; frames are processed locally, then mask motion is temporally stabilized.</small>
        {segmentationBusy && <small className="compositing-help">{segmentationStatus}</small>}
      </div>
      {!clip.mask ? <button className="small-action" onClick={() => { const path = 'M 0.2 0.2 L 0.8 0.2 L 0.8 0.8 L 0.2 0.8 Z'; setMaskPathDraft(path); onPatch({ mask: { path, featherPx: 0, expansionPx: 0, keyframes: [] } }); }}>Create polygon mask</button> : <>
        <label className="text-field mask-path-field"><span>Closed polygon / Bézier path · normalized 0–1</span><textarea aria-label="Mask path" value={maskPathDraft} spellCheck={false} onChange={(event) => setMaskPathDraft(event.target.value)} onBlur={saveMaskPath} /></label>
        <div className="compositing-help">SVG path commands M, L, Q, C and Z. Coordinates are relative to the frame. Keep the same number of path points when adding tracking corrections.</div>
        <NumberField label="Feather" unit="px" value={clip.mask.featherPx} max={256} step={1} onCommit={(featherPx) => updateMask({ featherPx })} />
        <NumberField label="Expansion" unit="px" value={clip.mask.expansionPx} min={-256} max={256} step={1} onCommit={(expansionPx) => updateMask({ expansionPx })} />
        {clip.mask.provenance && <small className="compositing-help">AI class: {clip.mask.provenance.className} · {clip.mask.provenance.sampleCount} temporal samples · {clip.mask.provenance.stabilization}</small>}
        <div className="keyframe-add-row"><button onClick={addMaskTrackingKeyframe}>Add tracking correction at {formatTime(local)}</button><small>{clip.mask.keyframes?.length ?? 0} points</small></div>
        {!!clip.mask.keyframes?.length && <div className="keyframe-list">{clip.mask.keyframes.map((frame, index) => <div key={`mask-${index}`}><span>{formatTime(secondsOf(frame.time))} · mask correction</span><button title="Remove tracking correction" onClick={() => updateMask({ keyframes: clip.mask!.keyframes!.filter((_, frameIndex) => frameIndex !== index) })}>×</button></div>)}</div>}
        <button className="text-action" onClick={() => { setMaskPathDraft(''); onPatch({ mask: undefined }); }}>Remove mask</button>
      </>}
      {!clip.chromaKey ? <button className="small-action" onClick={() => onPatch({ chromaKey: { color: '#00ff00', similarity: 0.18, blend: 0.04 } })}>Add chroma key</button> : <>
        <div className="title-style-row"><label>Key color<input aria-label="Chroma key color" type="color" value={clip.chromaKey.color} onChange={(event) => onPatch({ chromaKey: { ...clip.chromaKey!, color: event.target.value } })} /></label><button onClick={() => onPatch({ chromaKey: undefined })}>Remove key</button></div>
        <NumberField label="Similarity" unit="" value={clip.chromaKey.similarity} max={1} step={0.01} onCommit={(similarity) => onPatch({ chromaKey: { ...clip.chromaKey!, similarity } })} />
        <NumberField label="Edge blend" unit="" value={clip.chromaKey.blend} max={1} step={0.01} onCommit={(blend) => onPatch({ chromaKey: { ...clip.chromaKey!, blend } })} />
      </>}
      <small className="compositing-help">Manual and AI masks and chroma keys are applied in both monitor preview and export.</small>
    </section>}
    <section className="inspector-section"><div className="section-label"><span>SPEED & TRANSITION</span><ChevronDown size={14} /></div>
      <NumberField label="Playback rate" unit="×" value={secondsOf(clip.playbackRate ?? rational(1))} min={0.25} max={4} step={0.05} onCommit={(rate) => onPatch({ playbackRate: parseDecimal(rate) })} />
      <label className="text-field"><span>Transition in</span><select value={clip.transitionIn?.type ?? 'none'} onChange={(event) => updateTransition(event.target.value)}><option value="none">None</option><option value="dissolve">Dissolve</option><option value="wipe-left">Wipe left</option><option value="wipe-right">Wipe right</option></select></label>
      {clip.transitionIn && <NumberField label="Transition length" unit="s" value={secondsOf(clip.transitionIn.duration)} min={0.04} max={secondsOf(clip.duration)} step={Number(project.frameRate.den) / Number(project.frameRate.num)} onCommit={(duration) => onPatch({ transitionIn: { ...clip.transitionIn!, duration: parseDecimal(duration) } })} />}
      <div className="keyframe-add-row"><input aria-label="Speed at playhead" type="number" min="0.25" max="4" step="0.05" value={speedValue} onChange={(event) => setSpeedValue(event.target.value)} /><button onClick={addSpeedKeyframe}>Add speed ramp point at {formatTime(local)}</button></div>
      {!!clip.speedKeyframes?.length && <div className="keyframe-list">{clip.speedKeyframes.map((frame, index) => <div key={`speed-${index}`}><span>{formatTime(secondsOf(frame.time))} · {secondsOf(frame.rate).toFixed(2)}×</span><button title="Remove speed point" onClick={() => onPatch({ speedKeyframes: clip.speedKeyframes!.filter((_, frameIndex) => frameIndex !== index) })}>×</button></div>)}</div>}
    </section>
    <section className="inspector-section"><div className="section-label"><span>TITLE</span><ChevronDown size={14} /></div>
      {!clip.title ? <button className="small-action" onClick={() => updateTitle({})}>Add title overlay</button> : <>
        <label className="text-field"><span>Text</span><input value={titleText} maxLength={500} onChange={(event) => setTitleText(event.target.value)} onBlur={() => updateTitle({ text: titleText })} /></label>
        <div className="title-style-row"><label>Color<input type="color" value={clip.title.color} onChange={(event) => updateTitle({ color: event.target.value })} /></label><label>Box<input type="checkbox" checked={clip.title.box ?? false} onChange={(event) => updateTitle({ box: event.target.checked })} /></label><button onClick={() => onPatch({ title: undefined })}>Remove title</button></div>
        <TextField label="Font file" value={clip.title.fontFile ?? ''} placeholder="System font by default" onCommit={(fontFile) => updateTitle({ fontFile: fontFile.trim() || undefined })} />
        <NumberField label="Font size" unit="px" value={clip.title.fontSize} min={8} max={256} step={1} onCommit={(fontSize) => updateTitle({ fontSize })} />
        <NumberField label="Position X" unit="%" value={clip.title.x * 100} min={0} max={100} step={1} onCommit={(x) => updateTitle({ x: x / 100 })} />
        <NumberField label="Position Y" unit="%" value={clip.title.y * 100} min={0} max={100} step={1} onCommit={(y) => updateTitle({ y: y / 100 })} />
        <NumberField label="Start" unit="s" value={secondsOf(clip.title.start)} max={secondsOf(clip.duration)} step={Number(project.frameRate.den) / Number(project.frameRate.num)} onCommit={(start) => updateTitle({ start: parseDecimal(start) })} />
        <NumberField label="Duration" unit="s" value={secondsOf(clip.title.duration)} max={secondsOf(clip.duration) - secondsOf(clip.title.start)} step={Number(project.frameRate.den) / Number(project.frameRate.num)} onCommit={(duration) => updateTitle({ duration: parseDecimal(duration) })} />
      </>}
    </section>
    <section className="inspector-section"><div className="section-label"><span>KEYFRAMES</span><ChevronDown size={14} /></div>
      <label className="text-field"><span>Property</span><select value={property} onChange={(event) => setProperty(event.target.value as typeof property)}><option value="opacity">Opacity</option><option value="brightness">Brightness</option><option value="contrast">Contrast</option><option value="saturation">Saturation</option><option value="volume">Clip volume</option></select></label>
      <div className="keyframe-add-row"><input aria-label="Keyframe value" type="number" min={keyframeRange[property][0]} max={keyframeRange[property][1]} step="0.05" value={value} onChange={(event) => setValue(event.target.value)} /><button onClick={addKeyframe}>Add at {formatTime(local)}</button></div>
      {!!clip.keyframes?.length && <div className="keyframe-list">{clip.keyframes.map((frame, index) => <div key={`key-${index}`}><span>{frame.property} · {formatTime(secondsOf(frame.time))} · {frame.value.toFixed(2)}</span><button title="Remove keyframe" onClick={() => onPatch({ keyframes: clip.keyframes!.filter((_, frameIndex) => frameIndex !== index) })}>×</button></div>)}</div>}
    </section>
  </>;
}

function TrackAudioControls({ track, project, playhead, onUpdate }: { track: TimelineTrack; project: Project; playhead: number; onUpdate: (patch: Parameters<typeof window.openmontage.updateTrack>[2]) => void }) {
  const [volume, setVolume] = useState(track.volume ?? 1);
  useEffect(() => setVolume(track.volume ?? 1), [track.volume]);
  const commitVolume = () => onUpdate({ volume });
  function addVolumeKeyframe() {
    const time = frameTime(toFrame(parseDecimal(playhead), project.frameRate), project.frameRate);
    const keyframes = (track.volumeKeyframes ?? []).filter((frame) => compare(frame.time, time) !== 0);
    onUpdate({ volumeKeyframes: [...keyframes, { time, value: volume, interpolation: 'linear' as const }].sort((a, b) => compare(a.time, b.time)) });
  }
  return <div className="track-audio-controls" onClick={(event) => event.stopPropagation()}>
    <select aria-label={`${track.name} audio role`} value={track.audioRole ?? 'standard'} onChange={(event) => onUpdate({ audioRole: event.target.value as TimelineTrack['audioRole'] })}><option value="standard">Standard</option><option value="dialogue">Dialogue</option><option value="music">Music</option></select>
    <input aria-label={`${track.name} volume`} type="range" min="0" max="8" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} onPointerUp={commitVolume} onBlur={commitVolume} />
    <button title="Add a track gain keyframe at the playhead" onClick={addVolumeKeyframe}>◇</button>
    {track.audioRole === 'music' && <button title={track.duckUnderDialogue ? 'Disable dialogue ducking' : 'Duck under dialogue'} className={track.duckUnderDialogue ? 'active' : ''} onClick={() => onUpdate({ duckUnderDialogue: !track.duckUnderDialogue })}>D</button>}
    <button title={track.normalizeAudio ? 'Disable track loudness normalization' : 'Normalize track loudness'} className={track.normalizeAudio ? 'active' : ''} onClick={() => onUpdate({ normalizeAudio: !track.normalizeAudio })}>N</button>
  </div>;
}

function TextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label className="text-field"><span>{label}</span><input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => onCommit(draft)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>;
}

function MediaInspector({ asset, projectPath, missing, analysisStatus, onAnalysisStatus, mediaJobs, queuePaused, onQueueProxy, onClearProxies, onPauseQueue, onResumeQueue, onRetryJob, onRelink, onSave, onAnalysis }: { asset: MediaAsset; projectPath: string; missing: boolean; analysisStatus?: AudioAnalysisStatus; onAnalysisStatus: (mediaId: string, status: AudioAnalysisStatus) => void; mediaJobs: MediaJob[]; queuePaused: boolean; onQueueProxy: () => void; onClearProxies: () => void; onPauseQueue: () => void; onResumeQueue: () => void; onRetryJob: (jobId: string) => void; onRelink: () => void; onSave: (patch: { tags?: string[]; game?: string | null; rating?: number; analysisEventReviews?: AnalysisEventReview[] }) => void; onAnalysis: (mediaId: string, analysis: AudioAnalysis) => void }) {
  const [tags, setTags] = useState((asset.tags ?? []).join(', '));
  const [game, setGame] = useState(asset.game ?? '');
  const [rating, setRating] = useState(asset.rating ?? 0);
  const [analysisResult, setAnalysisResult] = useState<{ assetId: string; data: AudioAnalysis } | null>(null);
  const analysis = analysisResult?.assetId === asset.id ? analysisResult.data : null;
  const [analyzingAssetId, setAnalyzingAssetId] = useState<string | null>(null);
  const analyzing = analyzingAssetId === asset.id;
  const [analysisFailure, setAnalysisFailure] = useState<{ assetId: string; message: string } | null>(null);
  const analysisError = analysisFailure?.assetId === asset.id ? analysisFailure.message : null;
  const [cueResult, setCueResult] = useState<{ assetId: string; data: HighlightAnalysis } | null>(null);
  const cueAnalysis = cueResult?.assetId === asset.id ? cueResult.data : null;
  const [cueRunningAssetId, setCueRunningAssetId] = useState<string | null>(null);
  const cueRunning = cueRunningAssetId === asset.id;
  const [cueFailure, setCueFailure] = useState<{ assetId: string; message: string } | null>(null);
  const [analysisRuntimes, setAnalysisRuntimes] = useState<AnalysisRuntimeStatus[]>([]);
  const cueError = cueFailure?.assetId === asset.id ? cueFailure.message : null;
  const [cueCorrections, setCueCorrections] = useState<Record<string, { start: number; decisive: number; end: number; eventType: GameplayEventType }>>({});
  const reviewedDetectorPrecision = useMemo(() => {
    const counts = new Map<string, { accepted: number; rejected: number }>();
    for (const review of asset.analysisEventReviews ?? []) for (const id of review.detectorIds) {
      const count = counts.get(id) ?? { accepted: 0, rejected: 0 };
      if (review.status === 'rejected') count.rejected++;
      else count.accepted++;
      counts.set(id, count);
    }
    return [...counts].filter(([, count]) => count.accepted + count.rejected > 0).map(([id, count]) => ({ id, accepted: count.accepted, total: count.accepted + count.rejected, precision: count.accepted / (count.accepted + count.rejected) }));
  }, [asset.analysisEventReviews]);
  const assetJobs = mediaJobs.filter((job) => job.mediaId === asset.id);
  const proxyJob = assetJobs.filter((job) => job.kind === 'proxy' && job.sourceContentHash === asset.contentHash).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const queuedJobCount = mediaJobs.filter((job) => job.state === 'queued').length;
  const runningJobCount = mediaJobs.filter((job) => job.state === 'running').length;
  const failedJobCount = mediaJobs.filter((job) => job.state === 'failed').length;
  const completeProxyCount = mediaJobs.filter((job) => job.kind === 'proxy' && job.state === 'complete').length;
  const activeJobs = mediaJobs.filter((job) => job.state === 'queued' || job.state === 'running' || job.state === 'failed').slice(0, 5);
  const energyBins = analysis?.energyCurve.length ? Array.from({ length: Math.min(120, analysis.energyCurve.length) }, (_unused, index) => {
    const start = Math.floor(index * analysis.energyCurve.length / Math.min(120, analysis.energyCurve.length));
    const end = Math.max(start + 1, Math.floor((index + 1) * analysis.energyCurve.length / Math.min(120, analysis.energyCurve.length)));
    return analysis.energyCurve.slice(start, end).reduce((sum, value) => sum + value, 0) / (end - start);
  }) : [];
  const musicStructure = analysis?.structureEvents ?? [];
  useEffect(() => { setTags((asset.tags ?? []).join(', ')); setGame(asset.game ?? ''); setRating(asset.rating ?? 0); setAnalysisResult(null); setAnalysisFailure(null); setCueResult(null); setCueFailure(null); setCueCorrections({}); }, [asset.id, asset.tags, asset.game, asset.rating]);
  useEffect(() => { let active = true; void window.openmontage.getAnalysisRuntimes().then((runtimes) => { if (active) setAnalysisRuntimes(runtimes); }).catch(() => { if (active) setAnalysisRuntimes([]); }); return () => { active = false; }; }, []);
  async function runAnalysis() {
    setAnalyzingAssetId(asset.id); setAnalysisFailure(null); onAnalysisStatus(asset.id, 'running');
    try { const data = await window.openmontage.analyzeAudio(projectPath, asset.id); setAnalysisResult({ assetId: asset.id, data }); onAnalysis(asset.id, data); }
    catch (error) { setAnalysisFailure({ assetId: asset.id, message: error instanceof Error ? error.message : String(error) }); onAnalysisStatus(asset.id, 'failed'); }
    finally { setAnalyzingAssetId((current) => current === asset.id ? null : current); }
  }
  async function runCueAnalysis() {
    setCueRunningAssetId(asset.id); setCueFailure(null);
    try { setCueResult({ assetId: asset.id, data: await window.openmontage.analyzeHighlightCues(projectPath, asset.id) }); }
    catch (error) { setCueFailure({ assetId: asset.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { setCueRunningAssetId((current) => current === asset.id ? null : current); }
  }
  function saveEventReview(event: HighlightAnalysis['events'][number], status: AnalysisEventReview['status']) {
    const existing = asset.analysisEventReviews?.find((item) => item.eventId === event.id);
    const correction = cueCorrections[event.id] ?? { start: existing?.startSeconds ?? event.startSeconds, decisive: existing?.decisiveSeconds ?? event.decisiveSeconds, end: existing?.endSeconds ?? event.endSeconds, eventType: existing?.correctedEventType ?? event.eventType ?? 'unknown' };
    if (status === 'corrected' && (![correction.start, correction.decisive, correction.end].every(Number.isFinite) || correction.start < 0 || correction.start > correction.decisive || correction.decisive > correction.end || correction.end > secondsOf(asset.duration))) return;
    const review: AnalysisEventReview = {
      eventId: event.id, detectorIds: event.detectors.map((item) => item.detectorId), status,
      startSeconds: status === 'corrected' ? correction.start : existing?.startSeconds ?? event.startSeconds,
      decisiveSeconds: status === 'corrected' ? correction.decisive : existing?.decisiveSeconds ?? event.decisiveSeconds,
      endSeconds: status === 'corrected' ? correction.end : existing?.endSeconds ?? event.endSeconds,
      ...(status === 'corrected' ? { correctedEventType: correction.eventType } : {}),
      updatedAt: new Date().toISOString()
    };
    const previous = asset.analysisEventReviews ?? [];
    onSave({ analysisEventReviews: [...previous.filter((item) => item.eventId !== event.id), review] });
  }
  return <>
    <div className="inspector-asset"><div className="inspector-thumb">{asset.thumbnailPath ? <img src={window.openmontage.toFileUrl(asset.thumbnailPath)} /> : <Music2 size={19} />}</div><div><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} · {formatTime(secondsOf(asset.duration))}</small></div></div>
    {missing && <div className="missing-media-box"><strong>Media file is missing</strong><small title={asset.path}>{asset.path}</small><button onClick={onRelink}><FolderOpen size={13} /> Relink file</button></div>}
    <section className="inspector-section media-jobs-section"><div className="section-label"><span>DERIVED MEDIA QUEUE</span><button><ChevronDown size={14} /></button></div>
      {asset.kind === 'video' && <button className="analyze-audio" disabled={missing || proxyJob?.state === 'queued' || proxyJob?.state === 'running' || proxyJob?.state === 'complete'} onClick={onQueueProxy}><Film size={14} />{proxyJob?.state === 'complete' ? 'Proxy ready for source preview' : proxyJob?.state === 'running' ? 'Creating playback proxy…' : proxyJob?.state === 'queued' ? 'Proxy waiting in queue…' : 'Create playback proxy'}</button>}
      {proxyJob && <div className="media-job-row"><div><strong>Video proxy</strong><span>{proxyJob.state}{proxyJob.state === 'running' || proxyJob.state === 'queued' ? ` · ${Math.round(proxyJob.progress * 100)}%` : ''}</span></div>{(proxyJob.state === 'running' || proxyJob.state === 'queued') && <div className="media-job-progress"><i style={{ width: `${Math.round(proxyJob.progress * 100)}%` }} /></div>}{proxyJob.state === 'failed' && <><small className="media-job-error">{proxyJob.error}</small><button onClick={() => onRetryJob(proxyJob.id)}>Retry</button></>}</div>}
      <div className="media-job-summary">{runningJobCount} running · {queuedJobCount} queued · {failedJobCount} failed</div>
      {activeJobs.map((job) => <div className="media-job-row compact" key={job.id}><div><strong>{job.kind === 'proxy' ? 'Proxy' : `Waveform · ${job.clipId?.slice(0, 8) ?? 'clip'}`}</strong><span>{job.state}{job.state === 'running' || job.state === 'queued' ? ` · ${Math.round(job.progress * 100)}%` : ''}</span></div>{job.state === 'failed' && <button onClick={() => onRetryJob(job.id)}>Retry</button>}</div>)}
      {completeProxyCount > 0 && <button className="queue-toggle" onClick={onClearProxies}>Clear {completeProxyCount} cached {completeProxyCount === 1 ? 'proxy' : 'proxies'}</button>}
      <button className="queue-toggle" onClick={queuePaused ? onResumeQueue : onPauseQueue}>{queuePaused ? <Play size={12} /> : <Pause size={12} />}{queuePaused ? 'Resume queue' : 'Pause after current job'}</button>
      <small className="queue-note">Jobs are saved with the project and resume when it opens again. Limits: one FFmpeg job at a time.</small>
    </section>
    <section className="inspector-section"><div className="section-label"><span>LIBRARY DETAILS</span><button><ChevronDown size={14} /></button></div>
      <div className="rating-field"><span>Highlight rating</span><div role="group" aria-label="Highlight rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={value <= rating ? 'rated' : ''} aria-label={`Rate ${value} out of 5`} aria-pressed={rating === value} onClick={() => setRating(value)}><Star size={14} fill={value <= rating ? 'currentColor' : 'none'} /></button>)}<button type="button" className="rating-clear" onClick={() => setRating(0)} disabled={rating === 0}>Clear</button></div></div>
      <label className="metadata-field"><span>Game</span><input value={game} onChange={(event) => setGame(event.target.value)} placeholder="e.g. Valorant" /></label>
      <label className="metadata-field"><span>Tags</span><textarea value={tags} onChange={(event) => setTags(event.target.value)} placeholder="headshot, clutch, ace" rows={3} /></label>
      <button className="save-metadata" onClick={() => onSave({ game: game.trim() || null, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), rating })}><Check size={13} /> Save details</button>
      <div className="asset-facts"><span>RESOLUTION</span><strong>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Audio only'}</strong><span>FILE SIZE</span><strong>{formatBytes(asset.sizeBytes)}</strong></div>
    </section>
    <section className="inspector-section"><div className="section-label"><span>ANALYSIS</span><button><ChevronDown size={14} /></button></div>
      <button className="analyze-audio" disabled={!asset.hasAudio || analyzing} onClick={() => void runAnalysis()}><AudioLines size={14} />{analyzing ? 'Analyzing audio…' : analysis ? 'Analyze again' : analysisStatus === 'complete' ? 'Load cached analysis' : analysisStatus === 'failed' ? 'Retry audio analysis' : 'Analyze music beats'}{!asset.hasAudio && <small>No audio</small>}</button>
      {analysisError && <div className="analysis-error">{analysisError}</div>}
      {analysis && <div className="analysis-card"><div className="analysis-bpm"><span>ESTIMATED TEMPO</span><strong>{analysis.estimatedBpm ? `${analysis.estimatedBpm} BPM` : 'No stable tempo'}</strong></div>
        {analysis.bpmHypotheses.length > 1 && <div className="analysis-hypotheses"><span>Other tempo matches</span><strong>{analysis.bpmHypotheses.slice(1).map((item) => `${item.bpm} BPM · ${item.score.toFixed(2)}`).join('  /  ')}</strong></div>}
        <div className="analysis-counts"><span>{analysis.beats.length} beats · {analysis.downbeats.length} downbeats</span><span>{analysis.onsets.length} transients</span></div>
        <div className="energy-strip" role="img" aria-label="Relative one-second music energy" title="Relative energy by second">{energyBins.map((energy, index) => <i key={index} style={{ height: `${Math.max(3, Math.round(energy * 22))}px` }} />)}</div>
        <div className="analysis-cues"><span>METER</span><strong>{analysis.meter ? `${analysis.meter.beatsPerBar}/${analysis.meter.denominator} · ${Math.round(analysis.meter.confidence * 100)}%` : 'Unclear'}</strong><span>SECTIONS · DROPS</span><strong>{analysis.energySections.length} · {analysis.drops.length}{analysis.drops.length ? ` · ${formatTime(analysis.drops[0])}` : ''}</strong></div>
        <div className="analysis-cues"><span>ACCENTS · BUILD-UPS</span><strong>{analysis.accents?.length ?? 0} · {musicStructure.filter((event) => event.type === 'build_up').length}</strong><span>QUIET · TEMPO ZONES</span><strong>{musicStructure.filter((event) => event.type === 'quiet').length} · {analysis.tempoSegments?.length ?? 0}</strong></div>
        <small>Beat and onset confidences are relative local heuristics, not calibrated probabilities.</small>
      </div>}
      <button className="analyze-highlights" disabled={cueRunning} onClick={() => void runCueAnalysis()}><Sparkles size={14} />{cueRunning ? 'Finding activity cues…' : cueAnalysis ? 'Refresh ranked activity cues' : 'Find ranked activity cues'}</button>
      {cueError && <div className="analysis-error">{cueError}</div>}
      {cueAnalysis && <div className="cue-analysis-card">
        <div className="cue-analysis-heading"><strong>{cueAnalysis.events.length} ranked cues</strong><span>HEURISTIC</span></div>
        {cueAnalysis.events.length ? <div className="cue-event-list">{cueAnalysis.events.slice(0, 12).map((event) => {
          const review = asset.analysisEventReviews?.find((item) => item.eventId === event.id);
          const correction = cueCorrections[event.id] ?? { start: review?.startSeconds ?? event.startSeconds, decisive: review?.decisiveSeconds ?? event.decisiveSeconds, end: review?.endSeconds ?? event.endSeconds, eventType: review?.correctedEventType ?? event.eventType ?? 'unknown' as GameplayEventType };
          return <div className="cue-event" key={event.id}>
            <span className="cue-rank">{String(event.rank).padStart(2, '0')}</span><div><strong>{analysisEventLabel(event, review?.correctedEventType)}</strong><small>{formatTime(review?.startSeconds ?? event.startSeconds)}–{formatTime(review?.endSeconds ?? event.endSeconds)} · event {formatTime(review?.decisiveSeconds ?? event.decisiveSeconds)}</small><small>{event.detectors.map((detector) => detector.detectorId.replace('openmontage.', '').replaceAll('-', ' ')).join(' + ')} · {event.evidenceLevel ?? 'legacy heuristic'}</small>{event.detectors.find((detector) => typeof detector.evidence.gameProfile === 'string')?.evidence.gameProfile && <small>Game rules: {String(event.detectors.find((detector) => typeof detector.evidence.gameProfile === 'string')?.evidence.gameProfile)}</small>}{event.detectors.find((detector) => typeof detector.evidence.recognizedText === 'string')?.evidence.recognizedText && <small>HUD: {String(event.detectors.find((detector) => typeof detector.evidence.recognizedText === 'string')?.evidence.recognizedText)}</small>}{event.signals?.length ? <small>Signals: {event.signals.join(' · ')}</small> : null}<small>Heuristic confidence {Math.round(event.confidence * 100)}% · cue strength {Math.round(event.interestingness * 100)}% · rank score {event.scoreBreakdown ? `confidence ${event.scoreBreakdown.confidence.toFixed(2)}, activity ${event.scoreBreakdown.cueStrength.toFixed(2)}, corroboration ${event.scoreBreakdown.corroboration.toFixed(2)}, event priority ${event.scoreBreakdown.semanticPriority.toFixed(2)}` : event.rankScore}</small>{event.uncertainties?.map((uncertainty, index) => <small key={index}>Uncertainty: {uncertainty}</small>)}
              <div className="cue-review-actions"><button className={review?.status === 'accepted' ? 'selected' : ''} onClick={() => saveEventReview(event, 'accepted')}>Accept</button><button className={review?.status === 'rejected' ? 'selected' : ''} onClick={() => saveEventReview(event, 'rejected')}>Reject</button><span>{review?.status ?? 'unreviewed'}</span></div>
              <div className="cue-correction-fields"><label>Type<select value={correction.eventType} onChange={(e) => setCueCorrections((current) => ({ ...current, [event.id]: { ...correction, eventType: e.target.value as GameplayEventType } }))}>{GAMEPLAY_EVENT_TYPES.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label><label>Start<input type="number" min="0" max={secondsOf(asset.duration)} step="0.01" value={correction.start} onChange={(e) => setCueCorrections((current) => ({ ...current, [event.id]: { ...correction, start: Number(e.target.value) } }))} /></label><label>Event<input type="number" min="0" max={secondsOf(asset.duration)} step="0.01" value={correction.decisive} onChange={(e) => setCueCorrections((current) => ({ ...current, [event.id]: { ...correction, decisive: Number(e.target.value) } }))} /></label><label>End<input type="number" min="0" max={secondsOf(asset.duration)} step="0.01" value={correction.end} onChange={(e) => setCueCorrections((current) => ({ ...current, [event.id]: { ...correction, end: Number(e.target.value) } }))} /></label><button onClick={() => saveEventReview(event, 'corrected')}>Save correction</button></div>
            </div><b>{event.rankScore}</b>
          </div>;
        })}</div> : <div className="cue-empty">No activity cues found.</div>}
        {reviewedDetectorPrecision.length > 0 && <div className="review-metrics"><strong>Reviewed proposal precision · this asset</strong>{reviewedDetectorPrecision.map((item) => <span key={item.id}>{item.id.replace('openmontage.', '').replaceAll('-', ' ')} · {Math.round(item.precision * 100)}% ({item.accepted}/{item.total})</span>)}</div>}
        {cueAnalysis.warnings.map((warning) => <div className="analysis-error" key={warning}>{warning}</div>)}
        <small>Event types separate explicit HUD text from heuristic activity estimates. Scores and confidence are not calibrated probabilities; OCR text and feed changes can be wrong.</small>
      </div>}
    </section>
    <section className="inspector-section muted-section"><div className="section-label"><span>DETECTOR STATUS</span><button><ChevronDown size={14} /></button></div>{cueAnalysis ? cueAnalysis.detectors.map((detector) => <div className="detector-status-row" key={detector.detectorId}><Activity size={13} /><span>{detector.detectorId.replace('openmontage.', '').replaceAll('-', ' ')}{detector.message && <small className="detector-message">{detector.message}</small>}</span><small className={`detector-state ${detector.status}`}>{detector.status}</small></div>) : <div className="disabled-row"><Activity size={14} /><span>Local detectors</span><small>Run analysis to inspect</small></div>}{analysisRuntimes.map((runtime) => <div className="detector-status-row" key={runtime.id}><Sparkles size={13} /><span>{runtime.label}<small className="detector-message">{runtime.message}</small></span><small className={`detector-state ${runtime.status}`}>{runtime.status}</small></div>)}</section>
  </>;
}

function AutoMontageModal({ project, onClose, onGenerate, onOpenVariant, onImportMusic }: {
  project: Project;
  onClose: () => void;
  onGenerate: (options: AutoMontageOptions) => Promise<GeneratedAutoMontages | null>;
  onOpenVariant: (variant: GeneratedAutoMontageVariant) => Promise<void>;
  onImportMusic: () => Promise<MediaAsset | null>;
}) {
  const videos = project.media.filter((asset) => asset.kind === 'video');
  const musicAssets = project.media.filter((asset) => asset.hasAudio);
  const [musicMediaId, setMusicMediaId] = useState(musicAssets[0]?.id ?? '');
  const [videoMediaIds, setVideoMediaIds] = useState<string[]>(videos.map((asset) => asset.id));
  const [style, setStyle] = useState<AutoMontageStyle>('clean');
  const [duration, setDuration] = useState(() => String(Math.min(30, secondsOf(musicAssets[0]?.duration ?? rational(30)))));
  const [variants, setVariants] = useState('3');
  const [intensity, setIntensity] = useState(50);
  const [format, setFormat] = useState<AutoMontageFormat>('project');
  const [customRules, setCustomRules] = useState<AutoMontageCustomRules>({
    targetShotSeconds: 3.5, minShotSeconds: 1.2, maxShotSeconds: 7, leadSeconds: 1, tailSeconds: 1,
    cutRatio: 0.5, videoAudioVolume: 0.25, musicVolume: 0.95,
    anchorPreference: { drop: 1, accent: 0.9, downbeat: 0.9, beat: 0.68, onset: 0.4 }
  });
  const [busy, setBusy] = useState(false);
  const [importingMusic, setImportingMusic] = useState(false);
  const [error, setError] = useState('');
  const [generated, setGenerated] = useState<GeneratedAutoMontages | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const result = await onGenerate({
        musicMediaId,
        videoMediaIds,
        style,
        durationSeconds: Number(duration),
        variants: Number(variants),
        intensity: intensity / 100,
        format,
        ...(style === 'custom' ? { customRules } : {})
      });
      if (result) setGenerated(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  async function importMusic() {
    setError(''); setImportingMusic(true);
    try {
      const asset = await onImportMusic();
      if (asset) {
        setMusicMediaId(asset.id);
        setDuration(String(Math.min(30, secondsOf(asset.duration))));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportingMusic(false); }
  }

  function toggleVideo(id: string, checked: boolean) {
    setVideoMediaIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  }

  function updateCustomRule<K extends keyof AutoMontageCustomRules>(key: K, value: AutoMontageCustomRules[K]) {
    setCustomRules((current) => ({ ...current, [key]: value }));
  }

  function updateCustomAnchor(key: keyof AutoMontageCustomRules['anchorPreference'], value: number) {
    setCustomRules((current) => ({ ...current, anchorPreference: { ...current.anchorPreference, [key]: value } }));
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose(); }}>
    <form className="project-settings-modal auto-montage-modal" onSubmit={(event) => void submit(event)}>
      <div className="montage-modal-heading"><div><span className="eyebrow">AUTOMATIC EDITING · PHASE D</span><h2>Generate a montage</h2></div><button type="button" className="square-button" disabled={busy} onClick={onClose} title="Close">×</button></div>
      <p className="montage-intro">Analyze local highlights, align their decisive moments to music anchors, and create separate editable project variants. Your current timeline is preserved.</p>
      <div className="modal-field-pair">
        <div className="montage-music-field"><label><span>Music / audio</span><select value={musicMediaId} onChange={(event) => setMusicMediaId(event.target.value)} required><option value="" disabled>Select audio</option>{musicAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name} · {formatTime(secondsOf(asset.duration))}</option>)}</select></label><button type="button" className="music-import-button" disabled={busy || importingMusic} onClick={() => void importMusic()}><Music2 size={13} />{importingMusic ? 'Importing…' : 'Import music'}</button></div>
        <label><span>Editing style</span><select value={style} onChange={(event) => setStyle(event.target.value as AutoMontageStyle)}><option value="clean">Clean Competitive</option><option value="aggressive">Aggressive Gaming</option><option value="cinematic">Cinematic</option><option value="smooth">Smooth</option><option value="velocity">Velocity pacing</option><option value="custom">Custom pacing</option></select></label>
      </div>
      <div className="modal-field-pair">
        <label><span>Desired duration · seconds</span><input type="number" min="1" max="1800" step="0.5" value={duration} onChange={(event) => setDuration(event.target.value)} required /></label>
        <label><span>Output format</span><select value={format} onChange={(event) => setFormat(event.target.value as AutoMontageFormat)}><option value="project">Keep project format · {project.width} × {project.height}</option><option value="landscape-1080p">Landscape · 1920 × 1080</option><option value="portrait-1080p">Portrait · 1080 × 1920</option><option value="square-1080p">Square · 1080 × 1080</option></select></label>
      </div>
      <div className="modal-field-pair">
        <label><span>Variants</span><select value={variants} onChange={(event) => setVariants(event.target.value)}><option value="1">1 variant</option><option value="2">2 variants</option><option value="3">3 variants</option><option value="4">4 variants</option><option value="5">5 variants</option></select></label>
        <label className="intensity-field"><span>Cut intensity · {intensity}%</span><input type="range" min="0" max="100" step="1" value={intensity} onChange={(event) => setIntensity(Number(event.target.value))} /><small>Higher intensity selects tighter shot spacing. It does not add visual effects.</small></label>
      </div>
      {style === 'custom' && <div className="custom-montage-rules">
        <strong>Custom cut and mix rules</strong>
        <div className="custom-rules-grid">
          <label>Target shot · s<input type="number" min="0.5" max="30" step="0.1" value={customRules.targetShotSeconds} onChange={(event) => updateCustomRule('targetShotSeconds', Number(event.target.value))} /></label>
          <label>Minimum shot · s<input type="number" min="0.5" max="30" step="0.1" value={customRules.minShotSeconds} onChange={(event) => updateCustomRule('minShotSeconds', Number(event.target.value))} /></label>
          <label>Maximum shot · s<input type="number" min="0.5" max="30" step="0.1" value={customRules.maxShotSeconds} onChange={(event) => updateCustomRule('maxShotSeconds', Number(event.target.value))} /></label>
          <label>Lead-in · s<input type="number" min="0" max="15" step="0.1" value={customRules.leadSeconds} onChange={(event) => updateCustomRule('leadSeconds', Number(event.target.value))} /></label>
          <label>Tail · s<input type="number" min="0" max="15" step="0.1" value={customRules.tailSeconds} onChange={(event) => updateCustomRule('tailSeconds', Number(event.target.value))} /></label>
          <label>Cut position · 0.25–0.75<input type="number" min="0.25" max="0.75" step="0.05" value={customRules.cutRatio} onChange={(event) => updateCustomRule('cutRatio', Number(event.target.value))} /></label>
          <label>Gameplay audio · ×<input type="number" min="0" max="1" step="0.05" value={customRules.videoAudioVolume} onChange={(event) => updateCustomRule('videoAudioVolume', Number(event.target.value))} /></label>
          <label>Music · ×<input type="number" min="0" max="2" step="0.05" value={customRules.musicVolume} onChange={(event) => updateCustomRule('musicVolume', Number(event.target.value))} /></label>
        </div>
        <div className="custom-anchor-rules">{(['drop', 'accent', 'downbeat', 'beat', 'onset'] as const).map((key) => <label key={key}>{key} weight<input type="number" min="0" max="1" step="0.05" value={customRules.anchorPreference[key] ?? 0.9} onChange={(event) => updateCustomAnchor(key, Number(event.target.value))} /></label>)}</div>
      </div>}
      <div className="montage-source-heading"><span>Video sources</span><button type="button" className="text-action" onClick={() => setVideoMediaIds(videoMediaIds.length === videos.length ? [] : videos.map((asset) => asset.id))}>{videoMediaIds.length === videos.length ? 'Select none' : 'Select all'}</button><small>{videoMediaIds.length} of {videos.length} selected</small></div>
      <div className="montage-video-list">
        {videos.length ? videos.map((asset) => <label className="montage-video-choice" key={asset.id}><input type="checkbox" checked={videoMediaIds.includes(asset.id)} onChange={(event) => toggleVideo(asset.id, event.target.checked)} /><span title={asset.name}>{asset.name}</span><small>{formatTime(secondsOf(asset.duration))}{asset.game ? ` · ${asset.game}` : ''}{asset.rating ? ` · ★${asset.rating}` : ''}</small></label>) : <div className="empty-small">No video assets in this project.</div>}
      </div>
      <div className="montage-hint">Analysis runs locally and uses event reviews, detector cues, manual ratings, game diversity, music drops, downbeats, and beats. Scores are heuristic. Variants are saved as new projects; open one to render a playback preview or export it.</div>
      {busy && <div className="montage-progress"><i /> Analyzing selected clips and music; this can take a while…</div>}
      {error && <div className="modal-error">{error}</div>}
      {generated && <div className="montage-results">
        <div className="montage-result-heading"><strong>{generated.variants.length} editable variant{generated.variants.length === 1 ? '' : 's'} created</strong><small title={generated.outputDirectory}>{generated.outputDirectory}</small></div>
        {generated.variants.map((variant) => <div className="montage-variant-card" key={variant.projectPath}>
          <div className="montage-variant"><div><strong>{variant.plan.style} · {String(variant.plan.variant).padStart(2, '0')}</strong><small>{variant.plan.score}/100 · {variant.plan.segments.length} highlight cuts · {formatTime(variant.plan.durationSeconds)}</small></div><button type="button" className="primary" disabled={busy} onClick={() => void onOpenVariant(variant)}>Open to preview</button></div>
          <details className="montage-plan-details"><summary>Explainable score and edit decisions</summary>
            <div className="montage-score-grid">{Object.entries(variant.plan.scoreBreakdown).map(([key, score]) => <span key={key}>{key.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)} <b>{score}</b></span>)}</div>
            <ol>{variant.plan.segments.map((segment) => <li key={`${segment.mediaId}:${segment.eventId}`}>{formatTime(segment.targetAnchorSeconds)} · {segment.explanation}</li>)}</ol>
            {variant.plan.warnings.map((warning) => <small className="montage-warning" key={warning}>{warning}</small>)}
          </details>
        </div>)}
      </div>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>Close</button><button type="submit" className="primary" disabled={busy || !musicAssets.length || !videos.length || videoMediaIds.length === 0 || !musicMediaId}>{busy ? 'Analyzing…' : 'Generate variants'}</button></div>
    </form>
  </div>;
}

function ProjectSettingsModal({ project, onClose, onSave }: { project: Project; onClose: () => void; onSave: (patch: { name: string; width: number; height: number; frameRate: Project['frameRate'] }) => Promise<void> }) {
  const [name, setName] = useState(project.name);
  const [width, setWidth] = useState(String(project.width));
  const [height, setHeight] = useState(String(project.height));
  const [fps, setFps] = useState(`${project.frameRate.num}/${project.frameRate.den}`);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try {
      const frameRate = parseDecimal(fps);
      if (BigInt(frameRate.num) <= 0n || BigInt(frameRate.den) <= 0n) throw new Error('Frame rate must be greater than zero.');
      setSaving(true);
      await onSave({ name: name.trim(), width: Number(width), height: Number(height), frameRate });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) onClose(); }}>
    <form className="project-settings-modal" onSubmit={(event) => void submit(event)}>
      <span className="eyebrow">PROJECT PROFILE</span><h2>Project settings</h2>
      <label><span>Project name</span><input value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <div className="modal-field-pair"><label><span>Width</span><input type="number" min="2" step="2" value={width} onChange={(event) => setWidth(event.target.value)} required /></label><label><span>Height</span><input type="number" min="2" step="2" value={height} onChange={(event) => setHeight(event.target.value)} required /></label></div>
      <label><span>Frame rate</span><input value={fps} onChange={(event) => setFps(event.target.value)} placeholder="60 or 30000/1001" required /><small>Enter a rate such as 60, 30, or 30000/1001.</small></label>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></div>
    </form>
  </div>;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function NumberField({ label, unit, value, min = 0, max = 99999, step = 0.01, onCommit }: { label: string; unit: string; value: number; min?: number; max?: number; step?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value.toFixed(3));
  useEffect(() => setDraft(value.toFixed(3)), [value]);
  function commit() { const n = Number(draft); if (Number.isFinite(n) && n >= min && n <= max) onCommit(n); else setDraft(value.toFixed(3)); }
  return <label className="number-field"><span>{label}</span><div><input type="number" min={min} max={max} step={step} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { commit(); event.currentTarget.blur(); } }} /><small>{unit}</small></div></label>;
}

function EyeIcon({ muted }: { muted: boolean }) { return <span className={muted ? 'muted-eye' : ''}>◉</span>; }
