import { watch, type FSWatcher } from 'node:fs';
import { AppError } from './errors';

export function watchFolder(rootPath: string, onChange: () => void, recursive = true, debounceMs = 1000): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let watcher: FSWatcher;
  try {
    watcher = watch(rootPath, { recursive }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; if (!closed) onChange(); }, debounceMs);
    });
  } catch (error) {
    throw new AppError('WATCH_START_FAILED', `Could not watch folder ${rootPath}: ${error instanceof Error ? error.message : error}`);
  }
  watcher.on('close', () => { closed = true; if (timer) clearTimeout(timer); });
  return watcher;
}
