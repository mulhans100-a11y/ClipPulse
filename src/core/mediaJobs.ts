import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCommand } from './ffmpeg';
import type { MediaJob, MediaJobKind, MediaJobQueueSnapshot, MediaJobState } from './types';

export interface MediaJobResourceLimits {
  maxConcurrentJobs: 1;
  ffmpegThreads: 1;
  maxProxyWidth: number;
  maxProxyHeight: number;
  maxProxyBytes: number;
  maxTotalProxyBytes: number;
  maxWaveformWidth: number;
  maxWaveformCacheBytes: number;
  proxyVideoBitrate: string;
  proxyAudioBitrate: string;
}

export const DEFAULT_MEDIA_JOB_RESOURCE_LIMITS: MediaJobResourceLimits = {
  maxConcurrentJobs: 1,
  ffmpegThreads: 1,
  maxProxyWidth: 960,
  maxProxyHeight: 540,
  maxProxyBytes: 1_500_000_000,
  maxTotalProxyBytes: 12_000_000_000,
  maxWaveformWidth: 16_384,
  maxWaveformCacheBytes: 512_000_000,
  proxyVideoBitrate: '2200k',
  proxyAudioBitrate: '96k'
};

export interface MediaJobSource {
  mediaId: string;
  sourcePath: string;
  contentHash: string;
  sourceSizeBytes: number;
  sourceMtimeMs: number;
  durationSeconds: number;
}

interface ProxyJob extends MediaJob {
  kind: 'proxy';
  source: MediaJobSource;
  estimatedBytes: number;
}

interface ClipWaveformJob extends MediaJob {
  kind: 'clip-waveform';
  source: MediaJobSource;
  clipId: string;
  sourceInSeconds: number;
  clipDurationSeconds: number;
  pixelsPerSecond: number;
  width: number;
}

type PersistedJob = ProxyJob | ClipWaveformJob;
interface QueueDocument { schemaVersion: 1; jobs: PersistedJob[]; }

export class PersistentMediaJobQueue {
  private jobs: PersistedJob[] = [];
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private paused = false;
  private running = false;
  private enqueueChain: Promise<void> = Promise.resolve();
  private saveChain: Promise<void> = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly cacheDirectory: string,
    private readonly queueFilePath: string,
    private readonly onChange?: (snapshot: MediaJobQueueSnapshot) => void,
    private readonly limits: MediaJobResourceLimits = DEFAULT_MEDIA_JOB_RESOURCE_LIMITS
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    const initializing = this.loadQueue();
    this.initializing = initializing;
    try { await initializing; }
    finally { if (this.initializing === initializing) this.initializing = null; }
  }

  private async loadQueue(): Promise<void> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.queueFilePath, 'utf8')) as QueueDocument;
      if (saved.schemaVersion === 1 && Array.isArray(saved.jobs)) this.jobs = saved.jobs.filter((job) => isPersistedJob(job, this.cacheDirectory));
    } catch { this.jobs = []; }
    let recovered = false;
    for (const job of this.jobs) if (job.state === 'running') {
      job.state = 'queued'; job.progress = 0; job.updatedAt = new Date().toISOString(); recovered = true;
    }
    for (const job of this.jobs) if (job.state === 'complete' && !(await exists(job.outputPath))) {
      job.state = 'queued'; job.progress = 0; job.updatedAt = new Date().toISOString(); recovered = true;
    }
    const cacheEntries = await fs.readdir(this.cacheDirectory, { withFileTypes: true }).catch(() => []);
    await Promise.all(cacheEntries.filter((entry) => entry.isFile() && entry.name.startsWith('media-jobs.json.') && entry.name.endsWith('.tmp')).map((entry) => fs.rm(path.join(this.cacheDirectory, entry.name), { force: true }).catch(() => undefined)));
    for (const directory of ['proxies', 'waveforms']) {
      const fullPath = path.join(this.cacheDirectory, directory);
      const entries = await fs.readdir(fullPath, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.includes('.tmp.')).map((entry) => fs.rm(path.join(fullPath, entry.name), { force: true }).catch(() => undefined)));
    }
    if (recovered) await this.persist();
    this.initialized = true;
    await this.pruneWaveformCache();
    this.publish();
    queueMicrotask(() => { void this.drain(); });
  }

  async list(): Promise<MediaJob[]> {
    await this.initialize();
    return this.snapshot();
  }

  async status(): Promise<MediaJobQueueSnapshot> {
    await this.initialize();
    return { jobs: this.snapshot(), paused: this.paused };
  }

  enqueueProxy(source: MediaJobSource): Promise<MediaJob> {
    return this.serializeEnqueue(() => this.enqueueProxyInternal(source));
  }

  private async enqueueProxyInternal(source: MediaJobSource): Promise<MediaJob> {
    await this.initialize();
    const key = jobKey('proxy-v1', source);
    const outputPath = path.join(this.cacheDirectory, 'proxies', `${safe(source.mediaId)}-${source.contentHash}-proxy-v1.mp4`);
    const existing = this.jobs.find((job) => job.key === key);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) return this.publicJob(existing);
    if (existing?.state === 'complete' && await exists(existing.outputPath)) {
      try { await validateProxy(existing.outputPath, source.durationSeconds); return this.publicJob(existing); }
      catch { await fs.rm(existing.outputPath, { force: true }); }
    }
    const estimatedBytes = estimateProxyBytes(source.durationSeconds, this.limits);
    if (estimatedBytes > this.limits.maxProxyBytes) throw new Error(`Estimated proxy size (${formatBytes(estimatedBytes)}) exceeds the per-file resource limit (${formatBytes(this.limits.maxProxyBytes)}).`);
    await this.assertProxyBudget(estimatedBytes, outputPath);
    const job = this.upsertQueued({
      id: existing?.id ?? randomUUID(), key, kind: 'proxy', mediaId: source.mediaId,
      source: { ...source }, outputPath, estimatedBytes, state: 'queued', progress: 0,
      attempts: existing?.attempts ?? 0, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    await this.persist(); this.publish();
    void this.drain();
    return this.publicJob(job);
  }

  enqueueClipWaveform(source: MediaJobSource, clip: { clipId: string; sourceInSeconds: number; durationSeconds: number }, pixelsPerSecond: number): Promise<MediaJob> {
    return this.serializeEnqueue(() => this.enqueueClipWaveformInternal(source, clip, pixelsPerSecond));
  }

  private async enqueueClipWaveformInternal(source: MediaJobSource, clip: { clipId: string; sourceInSeconds: number; durationSeconds: number }, pixelsPerSecond: number): Promise<MediaJob> {
    await this.initialize();
    if (![clip.sourceInSeconds, clip.durationSeconds, pixelsPerSecond].every(Number.isFinite) || clip.sourceInSeconds < 0 || clip.durationSeconds <= 0 || pixelsPerSecond <= 0) throw new Error('Clip waveform requires valid nonnegative source timing and zoom.');
    const width = Math.min(this.limits.maxWaveformWidth, Math.max(128, Math.ceil(clip.durationSeconds * pixelsPerSecond * 2)));
    const key = jobKey(`clip-waveform-v1:${clip.clipId}:${clip.sourceInSeconds}:${clip.durationSeconds}:${pixelsPerSecond}:${width}`, source);
    const outputPath = path.join(this.cacheDirectory, 'waveforms', `${safe(source.mediaId)}-${safe(clip.clipId)}-${key.slice(0, 20)}.png`);
    let cancelledStale = false;
    for (const stale of this.jobs) {
      if (stale.kind === 'clip-waveform' && stale.clipId === clip.clipId && stale.mediaId === source.mediaId && stale.key !== key && ['queued', 'running'].includes(stale.state)) {
        if (stale.state === 'running') this.controllers.get(stale.id)?.abort();
        stale.state = 'cancelled'; stale.updatedAt = new Date().toISOString();
        cancelledStale = true;
      }
    }
    const existing = this.jobs.find((job) => job.key === key);
    if (existing && (existing.state === 'queued' || existing.state === 'running')) {
      if (cancelledStale) { await this.persist(); this.publish(); }
      return this.publicJob(existing);
    }
    if (existing?.state === 'complete' && await exists(existing.outputPath)) {
      if (cancelledStale) { await this.persist(); this.publish(); }
      return this.publicJob(existing);
    }
    const job = this.upsertQueued({
      id: existing?.id ?? randomUUID(), key, kind: 'clip-waveform', mediaId: source.mediaId, source: { ...source },
      clipId: clip.clipId, sourceInSeconds: clip.sourceInSeconds, clipDurationSeconds: clip.durationSeconds,
      pixelsPerSecond, width, outputPath, state: 'queued', progress: 0, attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    await this.persist(); this.publish();
    void this.drain();
    return this.publicJob(job);
  }

  async pause(): Promise<void> { await this.initialize(); this.paused = true; this.publish(); }
  async resume(): Promise<void> { await this.initialize(); this.paused = false; this.publish(); void this.drain(); }

  async clearCompletedProxies(): Promise<number> {
    await this.initialize();
    const completed = this.jobs.filter((job): job is ProxyJob => job.kind === 'proxy' && job.state === 'complete');
    await Promise.all(completed.map((job) => fs.rm(job.outputPath, { force: true })));
    const now = new Date().toISOString();
    for (const job of completed) { job.state = 'cancelled'; job.error = 'Cached proxy was cleared.'; job.updatedAt = now; }
    await this.persist(); this.publish();
    return completed.length;
  }

  retry(jobId: string): Promise<MediaJob> {
    return this.serializeEnqueue(() => this.retryInternal(jobId));
  }

  private async retryInternal(jobId: string): Promise<MediaJob> {
    await this.initialize();
    const job = this.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error(`Media job not found: ${jobId}`);
    if (job.state !== 'failed' && job.state !== 'cancelled') return this.publicJob(job);
    if (job.kind === 'proxy') await this.assertProxyBudget(job.estimatedBytes, job.outputPath);
    job.state = 'queued'; job.progress = 0; delete job.error; job.updatedAt = new Date().toISOString();
    await this.persist(); this.publish(); void this.drain();
    return this.publicJob(job);
  }

  async invalidateMedia(mediaId: string, currentContentHash?: string): Promise<void> {
    await this.initialize();
    const now = new Date().toISOString();
    const invalidated: PersistedJob[] = [];
    for (const job of this.jobs) if (job.mediaId === mediaId && ['queued', 'running', 'complete'].includes(job.state) && (!currentContentHash || job.source.contentHash !== currentContentHash)) {
      if (job.state === 'running') this.controllers.get(job.id)?.abort();
      const wasComplete = job.state === 'complete';
      job.state = 'cancelled'; job.error = 'Source media changed.'; job.updatedAt = now;
      if (wasComplete) invalidated.push(job);
    }
    await Promise.all(invalidated.map((job) => fs.rm(job.outputPath, { force: true }).catch(() => undefined)));
    await this.persist(); this.publish();
  }

  private upsertQueued<T extends PersistedJob>(job: T): T {
    const index = this.jobs.findIndex((item) => item.key === job.key);
    if (index >= 0) this.jobs[index] = job;
    else this.jobs.push(job);
    return job;
  }

  private serializeEnqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.enqueueChain.then(operation);
    this.enqueueChain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async drain(): Promise<void> {
    if (this.running || this.paused) return;
    this.running = true;
    try {
      while (!this.paused) {
        const job = this.jobs.find((item) => item.state === 'queued');
        if (!job) break;
        try { await this.process(job); }
        catch (error) { console.error(`Media job ${job.id} could not run:`, error); }
      }
    } finally { this.running = false; }
  }

  private async process(job: PersistedJob): Promise<void> {
    job.state = 'running'; job.progress = 0; job.attempts++; job.updatedAt = new Date().toISOString();
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const temporaryPath = `${job.outputPath}.${randomUUID()}.tmp${path.extname(job.outputPath)}`;
    let lastProgressUpdate = 0;
    let progressBuffer = '';
    try {
      await this.persist(); this.publish();
      await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
      const sourceStat = await fs.stat(job.source.sourcePath);
      if (!sourceStat.isFile() || sourceStat.size !== job.source.sourceSizeBytes || sourceStat.mtime.toISOString() !== new Date(job.source.sourceMtimeMs).toISOString()) throw new Error('Source changed after this job was queued; re-import or relink the media first.');
      await this.assertSourceStillQueued(job);
      const args = job.kind === 'proxy' ? this.proxyArgs(job, temporaryPath) : this.waveformArgs(job, temporaryPath);
      await runCommand('ffmpeg', args, (chunk) => {
        progressBuffer += chunk;
        const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop() ?? '';
        const elapsed = parseProgressLines(lines);
        if (job.state === 'running' && elapsed !== null && Date.now() - lastProgressUpdate >= 350) {
          lastProgressUpdate = Date.now();
          const jobDuration = job.kind === 'clip-waveform' ? job.clipDurationSeconds : job.source.durationSeconds;
          job.progress = Math.min(0.99, elapsed / jobDuration);
          job.updatedAt = new Date().toISOString(); this.publish(); void this.persist().catch((error) => console.error('Could not persist media job progress:', error));
        }
      }, controller.signal);
      await this.assertSourceStillQueued(job);
      const outputStat = await fs.stat(temporaryPath);
      if (!outputStat.size) throw new Error('FFmpeg created an empty media job output.');
      if (job.kind === 'proxy') {
        if (outputStat.size >= this.limits.maxProxyBytes) throw new Error(`Proxy reached the per-file size limit of ${formatBytes(this.limits.maxProxyBytes)}.`);
        await validateProxy(temporaryPath, job.source.durationSeconds);
      }
      await fs.rm(job.outputPath, { force: true });
      await fs.rename(temporaryPath, job.outputPath);
      job.state = 'complete'; job.progress = 1; delete job.error;
      job.updatedAt = new Date().toISOString();
      if (job.kind === 'proxy') job.outputBytes = outputStat.size;
      await this.persist(); this.publish();
      if (job.kind === 'clip-waveform') await this.pruneWaveformCache(job.outputPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      if ((job.state as MediaJobState) !== 'cancelled') {
        job.state = 'failed'; job.progress = 0; job.error = error instanceof Error ? error.message : String(error); job.updatedAt = new Date().toISOString();
      }
      this.publish();
      await this.persist().catch((persistError) => console.error('Could not persist failed media job:', persistError));
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private proxyArgs(job: ProxyJob, output: string): string[] {
    const duration = job.source.durationSeconds;
    return [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', String(this.limits.ffmpegThreads), '-filter_threads', String(this.limits.ffmpegThreads),
      '-i', job.source.sourcePath, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=${this.limits.maxProxyWidth}:${this.limits.maxProxyHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', this.limits.proxyVideoBitrate,
      '-c:a', 'aac', '-b:a', this.limits.proxyAudioBitrate,
      '-threads', String(this.limits.ffmpegThreads), '-t', String(duration), '-movflags', '+faststart',
      '-fs', String(this.limits.maxProxyBytes), '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output
    ];
  }

  private waveformArgs(job: ClipWaveformJob, output: string): string[] {
    const start = job.sourceInSeconds, duration = job.clipDurationSeconds;
    return [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', String(this.limits.ffmpegThreads), '-filter_threads', String(this.limits.ffmpegThreads),
      '-ss', String(start), '-i', job.source.sourcePath, '-t', String(duration),
      '-filter_complex', `[0:a:0]atrim=duration=${duration},asetpts=PTS-STARTPTS,aformat=channel_layouts=mono,showwavespic=s=${job.width}x144:colors=0xa6e85f:scale=lin[wave]`,
      '-map', '[wave]', '-frames:v', '1', '-update', '1', '-progress', 'pipe:1', '-nostats', output
    ];
  }

  private async assertProxyBudget(estimatedBytes: number, targetPath: string): Promise<void> {
    const directory = path.join(this.cacheDirectory, 'proxies');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    let cachedBytes = 0;
    for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4') && !entry.name.includes('.tmp.')) {
      const fullPath = path.join(directory, entry.name);
      if (path.resolve(fullPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) continue;
      cachedBytes += (await fs.stat(fullPath).catch(() => null))?.size ?? 0;
    }
    const reservedBytes = this.jobs.filter((job): job is ProxyJob => job.kind === 'proxy' && ['queued', 'running'].includes(job.state) && path.resolve(job.outputPath).toLowerCase() !== path.resolve(targetPath).toLowerCase()).reduce((sum, job) => sum + job.estimatedBytes, 0);
    if (cachedBytes + reservedBytes + estimatedBytes > this.limits.maxTotalProxyBytes) throw new Error(`Proxy jobs would exceed the project proxy cache limit of ${formatBytes(this.limits.maxTotalProxyBytes)}. Remove cached proxies or choose shorter media.`);
  }

  private async assertSourceStillQueued(job: PersistedJob): Promise<void> {
    const latest = this.jobs.find((item) => item.id === job.id);
    if (!latest || latest.state !== 'running') throw new Error('Media job was cancelled before it started.');
    const stat = await fs.stat(job.source.sourcePath);
    if (!stat.isFile() || stat.size !== job.source.sourceSizeBytes || stat.mtime.toISOString() !== new Date(job.source.sourceMtimeMs).toISOString()) throw new Error('Source changed while the media job was running.');
  }

  private async pruneWaveformCache(keepPath?: string): Promise<void> {
    const directory = path.join(this.cacheDirectory, 'waveforms');
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png')).map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      return stat ? { filePath, size: stat.size, modified: stat.mtimeMs } : null;
    }));
    const ordered = files.filter((file): file is NonNullable<typeof file> => file !== null).sort((a, b) => {
      if (a.filePath === keepPath) return 1;
      if (b.filePath === keepPath) return -1;
      return a.modified - b.modified;
    });
    let total = ordered.reduce((sum, file) => sum + file.size, 0);
    for (const file of ordered) {
      if (total <= this.limits.maxWaveformCacheBytes) break;
      await fs.rm(file.filePath, { force: true }); total -= file.size;
      const job = this.jobs.find((item) => item.kind === 'clip-waveform' && item.outputPath === file.filePath);
      if (job?.state === 'complete') { job.state = 'cancelled'; job.error = 'Waveform cache was evicted to respect the cache size limit.'; job.updatedAt = new Date().toISOString(); }
    }
    await this.persist(); this.publish();
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.queueFilePath), { recursive: true });
    const document: QueueDocument = { schemaVersion: 1, jobs: this.jobs };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const temporaryPath = `${this.queueFilePath}.${randomUUID()}.tmp`;
    const save = this.saveChain.then(async () => {
      await fs.writeFile(temporaryPath, serialized, 'utf8');
      await fs.rename(temporaryPath, this.queueFilePath);
    }).catch(async (error) => {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    });
    this.saveChain = save.catch(() => undefined);
    await save;
  }

  private snapshot(): MediaJob[] { return this.jobs.map((job) => this.publicJob(job)); }
  private publicJob(job: PersistedJob): MediaJob {
    const common: MediaJob = {
      id: job.id, key: job.key, kind: job.kind, mediaId: job.mediaId, sourceContentHash: job.source.contentHash, state: job.state, progress: job.progress,
      attempts: job.attempts, createdAt: job.createdAt, updatedAt: job.updatedAt, outputPath: job.outputPath,
      ...(job.outputBytes === undefined ? {} : { outputBytes: job.outputBytes }),
      ...(job.error === undefined ? {} : { error: job.error })
    };
    if (job.kind === 'clip-waveform') Object.assign(common, {
      clipId: job.clipId, sourceInSeconds: job.sourceInSeconds, clipDurationSeconds: job.clipDurationSeconds,
      zoomPixelsPerSecond: job.pixelsPerSecond, waveformWidth: job.width
    });
    return common;
  }
  private publish(): void { this.onChange?.({ jobs: this.snapshot(), paused: this.paused }); }
}

export function mediaJobQueuePath(cacheDirectory: string): string { return path.join(cacheDirectory, 'media-jobs.json'); }

function jobKey(version: string, source: MediaJobSource): string {
  return createHash('sha256').update(JSON.stringify([version, source.mediaId, source.contentHash, source.sourcePath, source.sourceSizeBytes, source.sourceMtimeMs])).digest('hex');
}
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }
function estimateProxyBytes(durationSeconds: number, limits: MediaJobResourceLimits): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return limits.maxProxyBytes + 1;
  const bitsPerSecond = parseBitrate(limits.proxyVideoBitrate) + parseBitrate(limits.proxyAudioBitrate);
  return Math.ceil(durationSeconds * bitsPerSecond / 8 * 1.12 + 1_000_000);
}
function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(value);
  if (!match) return 0;
  const scale = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1;
  return Number(match[1]) * scale;
}
function formatBytes(value: number): string { return `${(value / (1024 ** 3)).toFixed(2)} GiB`; }
function parseProgressLines(lines: string[]): number | null {
  let time: number | null = null;
  for (const line of lines) {
    const match = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(line.trim());
    if (match) time = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }
  return time;
}
async function exists(filePath: string): Promise<boolean> { try { return (await fs.stat(filePath)).isFile(); } catch { return false; } }
async function validateProxy(filePath: string, expectedDuration: number): Promise<void> {
  const { stdout } = await runCommand('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
  const info = JSON.parse(stdout) as { streams?: Array<{ codec_type?: string }>; format?: { duration?: string } };
  if (!info.streams?.some((stream) => stream.codec_type === 'video')) throw new Error('Generated proxy has no video stream.');
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > Math.max(1, expectedDuration * 0.02)) throw new Error('Generated proxy duration does not match the source.');
}
function isPersistedJob(value: unknown, cacheDirectory?: string): value is PersistedJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<PersistedJob>;
  const source = job.source;
  if (typeof job.id !== 'string' || typeof job.key !== 'string' || (job.kind !== 'proxy' && job.kind !== 'clip-waveform') ||
    typeof job.mediaId !== 'string' || typeof job.outputPath !== 'string' ||
    !['queued', 'running', 'complete', 'failed', 'cancelled'].includes(String(job.state)) || !Number.isFinite(job.progress) ||
    !Number.isSafeInteger(job.attempts) || typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string' ||
    !source || typeof source.sourcePath !== 'string' || typeof source.mediaId !== 'string' || source.mediaId !== job.mediaId ||
    typeof source.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(source.contentHash) || !Number.isSafeInteger(source.sourceSizeBytes) || source.sourceSizeBytes < 0 ||
    !Number.isFinite(source.sourceMtimeMs) || !Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) return false;
  if (cacheDirectory) {
    const expectedDirectory = path.resolve(cacheDirectory, job.kind === 'proxy' ? 'proxies' : 'waveforms');
    if (path.dirname(path.resolve(job.outputPath)).toLocaleLowerCase() !== expectedDirectory.toLocaleLowerCase()) return false;
  }
  if (job.kind === 'proxy') {
    const proxy = job as Partial<ProxyJob>;
    return typeof proxy.estimatedBytes === 'number' && Number.isFinite(proxy.estimatedBytes) && proxy.estimatedBytes > 0;
  }
  const waveform = job as Partial<ClipWaveformJob>;
  return typeof waveform.clipId === 'string' && waveform.clipId.length > 0 && Number.isFinite(waveform.sourceInSeconds) && waveform.sourceInSeconds! >= 0 &&
    Number.isFinite(waveform.clipDurationSeconds) && waveform.clipDurationSeconds! > 0 && Number.isFinite(waveform.pixelsPerSecond) && waveform.pixelsPerSecond! > 0 &&
    Number.isSafeInteger(waveform.width) && waveform.width! > 0 && waveform.width! <= DEFAULT_MEDIA_JOB_RESOURCE_LIMITS.maxWaveformWidth;
}
