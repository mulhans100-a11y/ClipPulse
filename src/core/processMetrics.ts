import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

export interface ProcessTiming { count: number; totalWallMs: number; }
export interface ExternalProcessMetrics {
  ffmpeg: ProcessTiming;
  ffprobe: ProcessTiming;
  tesseract: ProcessTiming;
  other: ProcessTiming;
}

const processMetricContext = new AsyncLocalStorage<ExternalProcessMetrics>();

export function createExternalProcessMetrics(): ExternalProcessMetrics {
  return {
    ffmpeg: { count: 0, totalWallMs: 0 },
    ffprobe: { count: 0, totalWallMs: 0 },
    tesseract: { count: 0, totalWallMs: 0 },
    other: { count: 0, totalWallMs: 0 }
  };
}

export function withExternalProcessMetrics<T>(metrics: ExternalProcessMetrics, work: () => Promise<T>): Promise<T> {
  return processMetricContext.run(metrics, work);
}

export function recordExternalProcessTiming(command: string, durationMs: number): void {
  const metrics = processMetricContext.getStore();
  if (!metrics || !Number.isFinite(durationMs) || durationMs < 0) return;
  const executable = path.basename(command).replace(/\.(?:exe|cmd|bat)$/i, '').toLocaleLowerCase();
  const key = executable === 'ffmpeg' ? 'ffmpeg' : executable === 'ffprobe' ? 'ffprobe' : executable === 'tesseract' ? 'tesseract' : 'other';
  metrics[key].count++;
  metrics[key].totalWallMs += durationMs;
}
