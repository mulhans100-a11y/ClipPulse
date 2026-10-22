import { EventEmitter } from 'node:events';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors';

export class FolderWatcher extends EventEmitter {
  private readonly watchers = new Map<string, FSWatcher>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly rootPath: string,
    private readonly onChange: () => void,
    private readonly recursive: boolean,
    private readonly debounceMs: number
  ) {
    super();
    this.watchDirectory(rootPath, true);
    void this.watchExistingSubdirectories(rootPath)
      .then(() => { if (!this.closed) this.emit('ready'); })
      .catch((error: unknown) => { if (!this.closed) this.emit('error', error); });
  }

  private watchDirectory(directoryPath: string, required = false): void {
    const key = path.resolve(directoryPath);
    if (this.closed || this.watchers.has(key)) return;

    let directoryWatcher: FSWatcher;
    try {
      // Watch directories individually. Recursive fs.watch triggers native
      // assertions on some Windows runners and misses nested changes on macOS.
      directoryWatcher = watch(key, (eventType, filename) => {
        this.scheduleChange();
        if (!this.recursive) return;
        if (filename === null || eventType === 'rename') {
          const changedPath = filename === null ? key : path.join(key, filename.toString());
          void this.reconcileChangedPath(changedPath).catch((error: unknown) => {
            if (!this.closed) this.emit('error', error);
          });
        }
      });
    } catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    this.watchers.set(key, directoryWatcher);
    directoryWatcher.on('error', (error) => { if (!this.closed) this.emit('error', error); });
  }

  private async watchExistingSubdirectories(directoryPath: string): Promise<void> {
    if (this.closed || !this.recursive) return;
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || this.closed) continue;
      const childPath = path.join(directoryPath, entry.name);
      try {
        this.watchDirectory(childPath);
        await this.watchExistingSubdirectories(childPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async reconcileChangedPath(changedPath: string): Promise<void> {
    if (this.closed) return;
    try {
      const details = await lstat(changedPath);
      if (details.isDirectory()) {
        this.watchDirectory(changedPath);
        await this.watchExistingSubdirectories(changedPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await this.closeWatchedSubtree(changedPath);
      else throw error;
    }
  }

  private async closeWatchedSubtree(directoryPath: string): Promise<void> {
    const key = path.resolve(directoryPath);
    const prefix = key.endsWith(path.sep) ? key : `${key}${path.sep}`;
    const closing = [...this.watchers.entries()].filter(([watchedPath]) => watchedPath === key || watchedPath.startsWith(prefix));
    for (const [watchedPath] of closing) this.watchers.delete(watchedPath);
    await Promise.all(closing.map(([, watcher]) => new Promise<void>((resolve) => {
      watcher.once('close', resolve);
      watcher.close();
    })));
  }

  private scheduleChange(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.onChange();
    }, this.debounceMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const closing = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(closing.map((watcher) => new Promise<void>((resolve) => {
      watcher.once('close', resolve);
      watcher.close();
    })));
    this.emit('close');
  }
}

export function watchFolder(rootPath: string, onChange: () => void, recursive = true, debounceMs = 1000): FolderWatcher {
  try {
    return new FolderWatcher(rootPath, onChange, recursive, debounceMs);
  } catch (error) {
    throw new AppError('WATCH_START_FAILED', `Could not watch folder ${rootPath}: ${error instanceof Error ? error.message : error}`);
  }
}
