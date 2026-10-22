import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AudioLines, Check, ChevronDown, Clapperboard, Clock3, Copy, FilePlus2, Film, FolderOpen, FolderSync, Gauge, HardDrive, Import, Layers2, Magnet, Medal, Music2, Pause, Play, Plus, Redo2, Scissors, Settings2, Sparkles, Star, Trash2, Undo2, Upload, Video, Volume2, WandSparkles } from 'lucide-react';
import type { AudioAnalysis, ImportResult, ImportRoot, MediaAsset, Project, TimelineClip, TimelineTrack, TrackKind } from '../../core/types';
import { add as addTime, compare, decimal, parseDecimal, rational, seconds, toFrame } from '../../core/time';
import { audioClipBeatOffsets, snapTimelineTime } from '../../core/timelineSnapping';
import { mediaVirtualWindow } from './mediaVirtualization';

const MEDIA_CARD_HEIGHT = 64;

function secondsOf(value: { num: string; den: string }): number { return Number(value.num) / Number(value.den); }
function formatTime(value: number): string {
  const ms = Math.max(0, Math.floor(value * 1000));
  const minutes = Math.floor(ms / 60000), seconds = Math.floor(ms / 1000) % 60, centis = Math.floor(ms / 10) % 100;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
function frameLabel(value: { num: string; den: string }, fps: Project['frameRate']): string {
  return String(toFrame(value, fps));
}
function clipEnd(clip: TimelineClip): number { return secondsOf(clip.start) + secondsOf(clip.duration); }
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
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [previewMode, setPreviewMode] = useState<'timeline' | 'source'>('timeline');
  const [timelineFramePath, setTimelineFramePath] = useState<string | null>(null);
  const [timelinePreviewBusy, setTimelinePreviewBusy] = useState(false);
  const [timelinePlayback, setTimelinePlayback] = useState<{ path: string; revision: string } | null>(null);
  const [timelinePlaybackBusy, setTimelinePlaybackBusy] = useState(false);
  const [timelinePlaybackProgress, setTimelinePlaybackProgress] = useState<number | null>(null);
  const [timelinePlaying, setTimelinePlaying] = useState(false);
  const [trimDraft, setTrimDraft] = useState<{ clipId: string; start: number; sourceIn: number; duration: number } | null>(null);
  const [notice, setNotice] = useState('Ready');
  const [error, setError] = useState('');
  const [ffmpeg, setFfmpeg] = useState(false);
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
  const timelinePlaybackStart = useRef(0);
  const autoplayTimelinePlayback = useRef(false);
  const previewRequest = useRef(0);
  const historyRequest = useRef(0);
  const missingRequest = useRef(0);
  const projectPathRef = useRef('');
  const timelineRef = useRef<HTMLDivElement>(null);
  const mediaListRef = useRef<HTMLDivElement>(null);
  const currentClip = getClip(project, selectedClipId);
  const selectedMedia = project?.media.find((asset) => asset.id === selectedMediaId) ?? null;
  const activeMedia = currentClip ? project?.media.find((asset) => asset.id === currentClip.clip.mediaId) ?? null : selectedMedia;
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
    void window.openmontage.version().then((info) => setFfmpeg(info.ffmpeg && info.ffprobe)).catch((cause) => setError(String(cause)));
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
    if (timelinePlayback && timelinePlayback.revision === project.updatedAt) return;
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
    const target = Math.min(playhead, Number.isFinite(video.duration) ? video.duration : playhead);
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

  const load = useCallback((result: { project: Project; path: string }) => {
    setProject(result.project); setProjectPath(result.path); projectPathRef.current = result.path; setSelectedClipId(null);
    setAudioAnalyses({});
    void window.openmontage?.getImportRoots(result.path).then(setImportRoots).catch(() => setImportRoots([]));
    void refreshHistory(result.path);
    void refreshMissingMedia(result.path);
    setSelectedMediaId(result.project.media[0]?.id ?? null); setPlayhead(0);
    setError(''); setNotice(`Opened ${result.project.name}`);
  }, []);

  async function run<T>(operation: () => Promise<T>, update: (value: T) => Project | void, label: string) {
    if (!project || !projectPath) return;
    try {
      setError('');
      const result = await operation();
      const next = update(result);
      if (next) { setProject(next); await refreshHistory(projectPath); }
      setNotice(label);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function cacheAudioAnalysis(mediaId: string, analysis: AudioAnalysis) {
    setAudioAnalyses((current) => ({ ...current, [mediaId]: analysis }));
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
      const previous = await window.openmontage.undoProject(projectPath); setProject(previous);
      await refreshHistory(projectPath); setNotice('Undo complete');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function redo() {
    if (!project || !projectPath || !canRedo) return;
    try {
      const next = await window.openmontage.redoProject(projectPath); setProject(next);
      await refreshHistory(projectPath); setNotice('Redo complete');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function exportVideo() {
    if (!project) return;
    try {
      setExportProgress(0); setError('');
      const result = await window.openmontage.exportVideo(projectPath);
      if (result) { setNotice(`Export complete · ${result.outputPath}`); await window.openmontage.reveal(result.outputPath); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExportProgress(null); }
  }
  async function togglePlayback() {
    if (previewMode === 'source') {
      const video = mediaRef.current;
      if (video) video.paused ? void video.play() : video.pause();
      return;
    }
    const video = timelinePlaybackRef.current;
    if (video && !video.paused) { video.pause(); return; }
    if (currentTimelinePlayback && video) {
      video.currentTime = Math.min(playhead, Number.isFinite(video.duration) ? video.duration : playhead);
      void video.play().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }
    if (!project || !projectPath || timelinePlaybackBusy) return;
    try {
      setError(''); setTimelinePlaybackBusy(true); setTimelinePlaybackProgress(0); setNotice('Rendering timeline playback…');
      const result = await window.openmontage.renderTimelinePlayback(projectPath);
      timelinePlaybackStart.current = playhead;
      autoplayTimelinePlayback.current = true;
      setTimelinePlayback(result);
      setNotice('Timeline preview rendered');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTimelinePlaybackBusy(false); setTimelinePlaybackProgress(null);
    }
  }
  function seekTo(time: number) {
    const video = timelinePlaybackRef.current;
    const target = previewMode === 'timeline' && currentTimelinePlayback && video && Number.isFinite(video.duration)
      ? Math.max(0, Math.min(time, video.duration))
      : time;
    setPlayhead(target);
    if (previewMode === 'timeline' && currentTimelinePlayback && video) {
      video.currentTime = target;
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
        const delta = Math.max(Math.max(-start, -sourceIn), Math.min(duration - frameStep, rawDelta));
        latest = { clipId: clip.id, start: start + delta, sourceIn: sourceIn + delta, duration: duration - delta };
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
      const next = await window.openmontage.relinkMedia(projectPath, mediaId);
      if (!next) return;
      setProject(next); await refreshMissingMedia(projectPath); await refreshHistory(projectPath);
      setNotice(`Relinked ${next.media.find((asset) => asset.id === mediaId)?.name ?? 'media file'}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function saveProjectSettings(patch: { name: string; width: number; height: number; frameRate: Project['frameRate'] }) {
    try {
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
      <h1>OpenMontage <span>AI</span></h1>
      <p>Create, cut, and export music-driven video edits. Your source files stay where they are.</p>
      <div className="welcome-actions"><button className="primary" onClick={() => void createProject()}><Plus size={16} /> New project</button><button onClick={() => void openProject()}><FolderOpen size={16} /> Open project</button></div>
      <div className="runtime"><span className={ffmpeg ? 'dot online' : 'dot'} />{ffmpeg ? 'FFmpeg ready' : 'FFmpeg not detected'} · Editor development build</div>
      {error && <div className="error-box">{error}</div>}
    </div>
  </div>;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark small"><Clapperboard size={17} /></div><strong>OpenMontage <span>AI</span></strong></div>
      <div className="project-title"><span className="project-dot" />{project.name}<span className="path-label">{projectPath}</span></div>
      <div className="toolbar">
        <button className="toolbar-button" title="New project (Ctrl+N)" onClick={() => void createProject()}><FilePlus2 size={14} /> New</button>
        <button className="toolbar-button" title="Open project (Ctrl+O)" onClick={() => void openProject()}><FolderOpen size={14} /> Open</button>
        <button className="icon-button" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => void undo()}><Undo2 size={16} /></button>
        <button className="icon-button" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => void redo()}><Redo2 size={16} /></button>
        <button className="toolbar-button" onClick={() => void save()}><Check size={15} /> Save</button>
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
            <div className="media-thumb">{asset.thumbnailPath ? <img src={window.openmontage.toFileUrl(asset.thumbnailPath)} /> : <div className="audio-art"><Music2 size={20} /></div>}<span className="duration-pill">{formatTime(secondsOf(asset.duration))}</span></div>
            <div className="media-info"><strong title={asset.name}>{asset.name}</strong><span>{asset.kind === 'video' ? `${asset.width ?? '?'} × ${asset.height ?? '?'} · ${asset.frameRate ? `${Number(asset.frameRate.num) / Number(asset.frameRate.den)} fps` : 'Video'}` : 'Audio'}</span>{(asset.tags?.length || asset.game) && <small>{[asset.game, ...(asset.tags ?? [])].filter(Boolean).join(' · ')}</small>}</div>
            {asset.kind === 'video' ? <Film className="type-icon" size={14} /> : <AudioLines className="type-icon" size={14} />}
            {missingMediaIds.includes(asset.id) && <span className="missing-badge">MISSING</span>}
            <span className="favorite-control" onClick={(event) => { event.stopPropagation(); void run(() => window.openmontage.updateMediaMetadata(projectPath, asset.id, { favorite: !asset.favorite }), (next) => next, asset.favorite ? 'Removed from favorites' : 'Added to favorites'); }} title={asset.favorite ? 'Remove favorite' : 'Add to favorites'}><Star size={13} fill={asset.favorite ? 'currentColor' : 'none'} /></span>
          </button>)}
          {mediaWindow.bottomPadding > 0 && <div className="media-virtual-spacer" style={{ height: mediaWindow.bottomPadding }} aria-hidden="true" />}
        </div>
        <div className="panel-footer"><span className={ffmpeg ? 'status-light good' : 'status-light'} />{ffmpeg ? 'FFmpeg connected' : 'FFmpeg unavailable'}<span className="footer-version">v0.1.0</span></div>
      </aside>

      <main className="center-panel">
        <section className="monitor panel">
          <div className="monitor-toolbar"><div className="monitor-tabs"><button className={previewMode === 'timeline' ? 'active-tab' : ''} onClick={() => setPreviewMode('timeline')}><Layers2 size={14} /> Timeline</button><button className={previewMode === 'source' ? 'active-tab' : ''} onClick={() => setPreviewMode('source')}><Video size={14} /> Source</button></div><div className="monitor-meta"><span>{project.width} × {project.height}</span><span>{Number(project.frameRate.num) / Number(project.frameRate.den)} FPS</span><button className="square-button small-square" onClick={() => setShowProjectSettings(true)} title="Project settings"><Settings2 size={14} /></button></div></div>
          <div className="monitor-stage">
            {previewMode === 'timeline' ? <>{currentTimelinePlayback ? <video ref={timelinePlaybackRef} key={currentTimelinePlayback.path} src={window.openmontage.toFileUrl(currentTimelinePlayback.path)} onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                video.currentTime = Math.min(timelinePlaybackStart.current, video.duration || timelinePlaybackStart.current);
                if (autoplayTimelinePlayback.current) {
                  autoplayTimelinePlayback.current = false;
                  void video.play().catch(() => setNotice('Preview rendered — press Play to start'));
                }
              }} onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)} onPlay={() => setTimelinePlaying(true)} onPause={() => setTimelinePlaying(false)} onEnded={(event) => { setTimelinePlaying(false); setPlayhead(event.currentTarget.duration); }} /> : timelineFramePath ? <img className="timeline-preview-image" src={`${window.openmontage.toFileUrl(timelineFramePath)}?v=${project.updatedAt}`} /> : <div className="monitor-placeholder"><div className="placeholder-grid" /><div className="placeholder-icon"><Layers2 size={32} /></div><strong>Timeline preview</strong><span>Scrub the playhead to view the edit</span><div className="playhead-time">{formatTime(playhead)}</div></div>}{(timelinePlaybackBusy || timelinePreviewBusy) && <span className="preview-busy">{timelinePlaybackBusy ? `Rendering playback${timelinePlaybackProgress === null ? '…' : ` ${Math.round(timelinePlaybackProgress * 100)}%`}` : 'Rendering frame…'}</span>}</> : activeMedia?.kind === 'video' ? <video ref={mediaRef} key={activeMedia.id} src={window.openmontage.toFileUrl(activeMedia.path)} controls onTimeUpdate={(event) => {
              const videoTime = event.currentTarget.currentTime;
              if (currentClip) setPlayhead(secondsOf(currentClip.clip.start) + Math.max(0, videoTime - secondsOf(currentClip.clip.sourceIn)));
              else setPlayhead(videoTime);
            }} onLoadedMetadata={(event) => {
              if (currentClip) { event.currentTarget.currentTime = secondsOf(currentClip.clip.sourceIn) + Math.max(0, playhead - secondsOf(currentClip.clip.start)); }
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
                      const clipArtworkStyle: React.CSSProperties | undefined = asset.kind === 'audio' && asset.thumbnailPath ? {
                        width: `${secondsOf(asset.duration) / secondsOf(clip.duration) * 100}%`,
                        left: `${-secondsOf(clip.sourceIn) / secondsOf(clip.duration) * 100}%`,
                        objectFit: 'fill', opacity: 0.72
                      } : undefined;
                      const beatOffsets = asset.kind === 'audio' ? audioClipBeatOffsets(clip, audioAnalyses[asset.id]) : [];
                      return <div key={clip.id} draggable onDragStart={(event) => event.dataTransfer.setData('text/clip-id', clip.id)} onClick={(event) => { event.stopPropagation(); setSelectedClipId(clip.id); setSelectedMediaId(asset.id); setPlayhead(start); }} className={`timeline-clip ${track.kind} ${selectedClipId === clip.id ? 'active' : ''}`} style={{ left: start * timelineScale, width, '--clip-hue': `${(index * 61 + asset.name.length * 13) % 360}` } as React.CSSProperties}>
                        {asset.thumbnailPath && <img className="clip-filmstrip" style={clipArtworkStyle} src={window.openmontage.toFileUrl(asset.thumbnailPath)} />}
                        {beatOffsets.length > 0 && <span className="timeline-beat-markers" aria-hidden="true">{beatOffsets.map((offset, beatIndex) => <i key={beatIndex} style={{ left: `${offset * 100}%` }} />)}</span>}
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
          </section>
          <section className="inspector-section muted-section"><div className="section-label"><span>MORE CONTROLS</span><button><ChevronDown size={14} /></button></div><div className="disabled-row"><Sparkles size={14} /><span>Effects and keyframes</span><small>Planned</small></div><div className="disabled-row"><Activity size={14} /><span>Masking and tracking</span><small>Planned</small></div></section>
        </> : selectedMedia ? <MediaInspector asset={selectedMedia} projectPath={projectPath} missing={missingMediaIds.includes(selectedMedia.id)} onRelink={() => void relinkAsset(selectedMedia.id)} onSave={(patch) => void run(() => window.openmontage.updateMediaMetadata(projectPath, selectedMedia.id, patch), (next) => next, 'Media details saved')} onAnalysis={cacheAudioAnalysis} /> : <div className="inspector-empty"><div className="inspector-empty-icon"><WandSparkles size={20} /></div><strong>No clip selected</strong><span>Select a timeline clip to edit its timing and audio.</span></div>}
        <div className="inspector-footer"><span>PROJECT</span><strong>{project.name}</strong><small>{project.width} × {project.height} · {Number(project.frameRate.num) / Number(project.frameRate.den)} fps</small></div>
      </aside>
    </div>

    {showProjectSettings && <ProjectSettingsModal project={project} onClose={() => setShowProjectSettings(false)} onSave={saveProjectSettings} />}

    <footer className="statusbar"><span className={error ? 'status-error' : ''}>{error ? error : notice}</span><span className="status-right"><i className={ffmpeg ? 'online' : ''} />{ffmpeg ? 'Ready' : 'FFmpeg missing'} <span className="status-separator" />{project ? `${project.media.length} media` : ''}</span></footer>
  </div>;
}

function MediaInspector({ asset, projectPath, missing, onRelink, onSave, onAnalysis }: { asset: MediaAsset; projectPath: string; missing: boolean; onRelink: () => void; onSave: (patch: { tags: string[]; game: string | null; rating: number }) => void; onAnalysis: (mediaId: string, analysis: AudioAnalysis) => void }) {
  const [tags, setTags] = useState((asset.tags ?? []).join(', '));
  const [game, setGame] = useState(asset.game ?? '');
  const [rating, setRating] = useState(asset.rating ?? 0);
  const [analysisResult, setAnalysisResult] = useState<{ assetId: string; data: AudioAnalysis } | null>(null);
  const analysis = analysisResult?.assetId === asset.id ? analysisResult.data : null;
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisFailure, setAnalysisFailure] = useState<{ assetId: string; message: string } | null>(null);
  const analysisError = analysisFailure?.assetId === asset.id ? analysisFailure.message : null;
  useEffect(() => { setTags((asset.tags ?? []).join(', ')); setGame(asset.game ?? ''); setRating(asset.rating ?? 0); setAnalysisResult(null); setAnalysisFailure(null); }, [asset.id, asset.tags, asset.game, asset.rating]);
  async function runAnalysis() {
    setAnalyzing(true); setAnalysisFailure(null);
    try { const data = await window.openmontage.analyzeAudio(projectPath, asset.id); setAnalysisResult({ assetId: asset.id, data }); onAnalysis(asset.id, data); }
    catch (error) { setAnalysisFailure({ assetId: asset.id, message: error instanceof Error ? error.message : String(error) }); }
    finally { setAnalyzing(false); }
  }
  return <>
    <div className="inspector-asset"><div className="inspector-thumb">{asset.thumbnailPath ? <img src={window.openmontage.toFileUrl(asset.thumbnailPath)} /> : <Music2 size={19} />}</div><div><strong>{asset.name}</strong><small>{asset.kind.toUpperCase()} · {formatTime(secondsOf(asset.duration))}</small></div></div>
    {missing && <div className="missing-media-box"><strong>Media file is missing</strong><small title={asset.path}>{asset.path}</small><button onClick={onRelink}><FolderOpen size={13} /> Relink file</button></div>}
    <section className="inspector-section"><div className="section-label"><span>LIBRARY DETAILS</span><button><ChevronDown size={14} /></button></div>
      <div className="rating-field"><span>Highlight rating</span><div role="group" aria-label="Highlight rating">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={value <= rating ? 'rated' : ''} aria-label={`Rate ${value} out of 5`} aria-pressed={rating === value} onClick={() => setRating(value)}><Star size={14} fill={value <= rating ? 'currentColor' : 'none'} /></button>)}<button type="button" className="rating-clear" onClick={() => setRating(0)} disabled={rating === 0}>Clear</button></div></div>
      <label className="metadata-field"><span>Game</span><input value={game} onChange={(event) => setGame(event.target.value)} placeholder="e.g. Valorant" /></label>
      <label className="metadata-field"><span>Tags</span><textarea value={tags} onChange={(event) => setTags(event.target.value)} placeholder="headshot, clutch, ace" rows={3} /></label>
      <button className="save-metadata" onClick={() => onSave({ game: game.trim() || null, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), rating })}><Check size={13} /> Save details</button>
      <div className="asset-facts"><span>RESOLUTION</span><strong>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Audio only'}</strong><span>FILE SIZE</span><strong>{formatBytes(asset.sizeBytes)}</strong></div>
    </section>
    <section className="inspector-section"><div className="section-label"><span>ANALYSIS</span><button><ChevronDown size={14} /></button></div>
      <button className="analyze-audio" disabled={!asset.hasAudio || analyzing} onClick={() => void runAnalysis()}><AudioLines size={14} />{analyzing ? 'Analyzing audio…' : analysis ? 'Analyze again' : 'Analyze music beats'}{!asset.hasAudio && <small>No audio</small>}</button>
      {analysisError && <div className="analysis-error">{analysisError}</div>}
      {analysis && <div className="analysis-card"><div className="analysis-bpm"><span>ESTIMATED TEMPO</span><strong>{analysis.estimatedBpm ? `${analysis.estimatedBpm} BPM` : 'No stable tempo'}</strong></div>
        {analysis.bpmHypotheses.length > 1 && <div className="analysis-hypotheses"><span>Other tempo matches</span><strong>{analysis.bpmHypotheses.slice(1).map((item) => `${item.bpm} BPM · ${item.score.toFixed(2)}`).join('  /  ')}</strong></div>}
        <div className="analysis-counts"><span>{analysis.beats.length} beat positions</span><span>{analysis.onsets.length} transients</span></div>
        <small>Local amplitude analysis · match scores compare rhythmic patterns</small>
      </div>}
      <div className="disabled-row"><Sparkles size={14} /><span>Gameplay highlight detection</span><small>Planned</small></div>
    </section>
    <section className="inspector-section muted-section"><div className="section-label"><span>DETECTORS</span><button><ChevronDown size={14} /></button></div><div className="disabled-row"><Activity size={14} /><span>Scene and game events</span><small>Planned</small></div></section>
  </>;
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
