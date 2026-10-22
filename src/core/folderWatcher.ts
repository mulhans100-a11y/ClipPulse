import chokidar, { type FSWatcher } from 'chokidar';
import { realpathSync } from 'node:fs';
import { AppError } from './errors';

export function watchFolder(rootPath: string, onChange: () => void, recursive = true, debounceMs = 1000): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let watcher: FSWatcher;
  try {
    // Canonicalize Windows 8.3 paths before watching. libuv can abort if the
    // watched path uses a short alias but Windows reports events with its long path.
    const canonicalRoot = realpathSync(rootPath);
    watcher = chokidar.watch(canonicalRoot, { ignoreInitial: true, ...(recursive ? {} : { depth: 0 }) });
    watcher.on('all', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; if (!closed) onChange(); }, debounceMs);
    });
  } catch (error) {
    throw new AppError('WATCH_START_FAILED', `Could not watch folder ${rootPath}: ${error instanceof Error ? error.message : error}`);
  }
  const close = watcher.close.bind(watcher);
  watcher.close = async () => {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    await close();
  };
  return watcher;
}
