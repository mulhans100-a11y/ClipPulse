import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import type { ImportRoot, MediaAsset } from './types';

export interface LibraryAsset extends MediaAsset {
  favorite: boolean;
  rating: number;
  tags: string[];
  game?: string;
}

export function libraryDatabasePath(projectFile: string, projectId: string): string {
  return path.join(path.dirname(path.resolve(projectFile)), `.openmontage-cache-${projectId}`, 'library.sqlite');
}

export class MediaLibrary {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    try { this.db = new DatabaseSync(databasePath); }
    catch (error) { throw new AppError('LIBRARY_OPEN_FAILED', `Could not open media library database: ${error instanceof Error ? error.message : error}`); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('video','audio')),
        duration_num TEXT NOT NULL,
        duration_den TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        fps_num TEXT,
        fps_den TEXT,
        has_audio INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        thumbnail_path TEXT,
        imported_at TEXT NOT NULL,
        favorite INTEGER NOT NULL DEFAULT 0,
        rating INTEGER NOT NULL DEFAULT 0,
        game TEXT
      );
      CREATE INDEX IF NOT EXISTS media_path_idx ON media(path_key);
      CREATE INDEX IF NOT EXISTS media_name_idx ON media(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS media_tags (
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        tag TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY(media_id, tag)
      );
      CREATE INDEX IF NOT EXISTS media_tags_tag_idx ON media_tags(tag COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS import_roots (
        path TEXT PRIMARY KEY,
        path_key TEXT NOT NULL UNIQUE,
        recursive INTEGER NOT NULL DEFAULT 1,
        watching INTEGER NOT NULL DEFAULT 0,
        last_scan TEXT
      );
    `);
    const mediaColumns = this.db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>;
    if (!mediaColumns.some((column) => column.name === 'rating')) this.db.exec('ALTER TABLE media ADD COLUMN rating INTEGER NOT NULL DEFAULT 0');
    this.db.exec('PRAGMA user_version=2;');
  }

  findByPath(filePath: string): LibraryAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media WHERE path_key=?').get(pathKey(filePath));
    return row ? this.toAsset(row as Record<string, unknown>) : undefined;
  }

  findById(mediaId: string): LibraryAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media WHERE id=?').get(mediaId);
    return row ? this.toAsset(row as Record<string, unknown>) : undefined;
  }

  findByHash(hash: string): LibraryAsset | undefined {
    const row = this.db.prepare('SELECT * FROM media WHERE content_hash=?').get(hash);
    return row ? this.toAsset(row as Record<string, unknown>) : undefined;
  }

  upsert(asset: MediaAsset): void {
    this.db.exec('BEGIN');
    try {
      this.writeAsset(asset);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new AppError('LIBRARY_WRITE_FAILED', `Could not update media library: ${error instanceof Error ? error.message : error}`);
    }
  }

  synchronizeAssets(assets: MediaAsset[]): void {
    this.db.exec('BEGIN');
    try {
      const keep = new Set(assets.map((asset) => asset.id));
      const existing = this.db.prepare('SELECT id FROM media').all() as Array<{ id: string }>;
      const remove = this.db.prepare('DELETE FROM media WHERE id=?');
      for (const row of existing) if (!keep.has(row.id)) remove.run(row.id);
      for (const asset of assets) this.writeAsset(asset);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new AppError('LIBRARY_SYNC_FAILED', `Could not synchronize the media library with project history: ${error instanceof Error ? error.message : error}`);
    }
  }

  updatePreferences(mediaId: string, patch: { favorite?: boolean; rating?: number; tags?: string[]; game?: string | null }): void {
    this.db.exec('BEGIN');
    try {
      if (patch.favorite !== undefined || patch.rating !== undefined || patch.game !== undefined) {
        const current = this.db.prepare('SELECT favorite,rating,game FROM media WHERE id=?').get(mediaId) as { favorite: number; rating: number; game: string | null } | undefined;
        if (!current) throw new AppError('MEDIA_NOT_FOUND', `Media asset not found in library: ${mediaId}`);
        this.db.prepare('UPDATE media SET favorite=?,rating=?,game=? WHERE id=?').run(patch.favorite === undefined ? current.favorite : patch.favorite ? 1 : 0, patch.rating ?? current.rating, patch.game === undefined ? current.game : patch.game, mediaId);
      }
      if (patch.tags !== undefined) {
        this.db.prepare('DELETE FROM media_tags WHERE media_id=?').run(mediaId);
        const insertTag = this.db.prepare('INSERT INTO media_tags(media_id,tag) VALUES (?,?)');
        for (const tag of patch.tags) insertTag.run(mediaId, tag);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error instanceof AppError) throw error;
      throw new AppError('LIBRARY_WRITE_FAILED', `Could not update media preferences: ${error instanceof Error ? error.message : error}`);
    }
  }

  search(query = '', favoriteOnly = false): LibraryAsset[] {
    const q = `%${query.trim().toLocaleLowerCase()}%`;
    const rows = this.db.prepare(`SELECT DISTINCT m.* FROM media m
      LEFT JOIN media_tags t ON t.media_id=m.id
      WHERE (?=0 OR m.favorite=1) AND (?='' OR lower(m.name) LIKE ? OR lower(m.path) LIKE ? OR lower(coalesce(m.game,'')) LIKE ? OR lower(t.tag) LIKE ?)
      ORDER BY m.favorite DESC, m.name COLLATE NOCASE`).all(favoriteOnly ? 1 : 0, query.trim(), q, q, q, q);
    return rows.map((row) => this.toAsset(row as Record<string, unknown>));
  }

  setImportRoot(root: ImportRoot): void {
    this.db.prepare(`INSERT INTO import_roots(path,path_key,recursive,watching,last_scan) VALUES (?,?,?,?,?)
      ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,recursive=excluded.recursive,watching=excluded.watching,last_scan=excluded.last_scan`)
      .run(root.path, pathKey(root.path), root.recursive ? 1 : 0, root.watching ? 1 : 0, new Date().toISOString());
  }

  importRoots(): ImportRoot[] {
    return this.db.prepare('SELECT path,recursive,watching,last_scan FROM import_roots ORDER BY path').all().map((row) => {
      const item = row as { path: string; recursive: number; watching: number; last_scan: string | null };
      return { path: item.path, recursive: Boolean(item.recursive), watching: Boolean(item.watching), lastScan: item.last_scan ?? undefined };
    });
  }

  setRootWatching(rootPath: string, watching: boolean): void {
    const result = this.db.prepare('UPDATE import_roots SET watching=?,last_scan=? WHERE path_key=?').run(watching ? 1 : 0, new Date().toISOString(), pathKey(rootPath));
    if (result.changes === 0) throw new AppError('IMPORT_ROOT_NOT_FOUND', `Import folder is not registered: ${rootPath}`);
  }

  private toAsset(row: Record<string, unknown>): LibraryAsset {
    const id = String(row.id);
    const tags = this.db.prepare('SELECT tag FROM media_tags WHERE media_id=? ORDER BY tag COLLATE NOCASE').all(id).map((item) => String((item as { tag: unknown }).tag));
    return {
      id, path: String(row.path), name: String(row.name), kind: row.kind as MediaAsset['kind'],
      duration: { num: String(row.duration_num), den: String(row.duration_den) },
      width: row.width === null ? undefined : Number(row.width), height: row.height === null ? undefined : Number(row.height),
      frameRate: row.fps_num === null || row.fps_den === null ? undefined : { num: String(row.fps_num), den: String(row.fps_den) },
      hasAudio: Boolean(row.has_audio), sizeBytes: Number(row.size_bytes), modifiedAt: String(row.modified_at),
      contentHash: String(row.content_hash), thumbnailPath: row.thumbnail_path === null ? undefined : String(row.thumbnail_path),
      importedAt: String(row.imported_at), favorite: Boolean(row.favorite), rating: Number(row.rating ?? 0), game: row.game === null ? undefined : String(row.game), tags
    };
  }

  close(): void { this.db.close(); }

  private writeAsset(asset: MediaAsset): void {
    const enriched = asset as LibraryAsset;
    this.db.prepare(`INSERT INTO media (id,path,path_key,name,kind,duration_num,duration_den,width,height,fps_num,fps_den,has_audio,size_bytes,modified_at,content_hash,thumbnail_path,imported_at,favorite,rating,game)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path,path_key=excluded.path_key,name=excluded.name,kind=excluded.kind,duration_num=excluded.duration_num,duration_den=excluded.duration_den,width=excluded.width,height=excluded.height,fps_num=excluded.fps_num,fps_den=excluded.fps_den,has_audio=excluded.has_audio,size_bytes=excluded.size_bytes,modified_at=excluded.modified_at,content_hash=excluded.content_hash,thumbnail_path=excluded.thumbnail_path,favorite=excluded.favorite,rating=excluded.rating,game=excluded.game`).run(
      asset.id, asset.path, pathKey(asset.path), asset.name, asset.kind, asset.duration.num, asset.duration.den,
      asset.width ?? null, asset.height ?? null, asset.frameRate?.num ?? null, asset.frameRate?.den ?? null,
      asset.hasAudio ? 1 : 0, asset.sizeBytes, asset.modifiedAt, asset.contentHash, asset.thumbnailPath ?? null,
      asset.importedAt, enriched.favorite ? 1 : 0, enriched.rating ?? 0, enriched.game ?? null
    );
    this.db.prepare('DELETE FROM media_tags WHERE media_id=?').run(asset.id);
    const insertTag = this.db.prepare('INSERT OR IGNORE INTO media_tags(media_id,tag) VALUES (?,?)');
    for (const tag of enriched.tags ?? []) insertTag.run(asset.id, tag);
  }
}

function pathKey(filePath: string): string { return path.resolve(filePath).replace(/\\/g, '/').toLocaleLowerCase(); }
