import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface PreviewCacheLimits {
  maxFiles: number;
  maxBytes: number;
  maxAgeMs: number;
  matches?: (fileName: string) => boolean;
}

/** Prune only regular files owned by a preview-cache directory; always retain the just-used entry. */
export async function prunePreviewCache(directory: string, keepPath: string, limits: PreviewCacheLimits): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(entries.filter((entry) => entry.isFile() && (!limits.matches || limits.matches(entry.name))).map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    try { const item = await fs.stat(fullPath); return { fullPath, modified: item.mtimeMs, size: item.size }; }
    catch { return { fullPath, modified: 0, size: 0 }; }
  }));
  candidates.sort((a, b) => b.modified - a.modified);
  const keep = new Set<string>([path.resolve(keepPath)]);
  let retainedBytes = candidates.find((item) => path.resolve(item.fullPath) === path.resolve(keepPath))?.size ?? 0;
  for (const item of candidates) {
    if (path.resolve(item.fullPath) === path.resolve(keepPath) || item.modified === 0) continue;
    if (Date.now() - item.modified > limits.maxAgeMs || keep.size >= limits.maxFiles || retainedBytes + item.size > limits.maxBytes) continue;
    keep.add(path.resolve(item.fullPath)); retainedBytes += item.size;
  }
  const removed = candidates.filter((item) => !keep.has(path.resolve(item.fullPath))).map((item) => item.fullPath);
  await Promise.all(removed.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
  return removed;
}
