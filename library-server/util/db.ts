import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function openDatabase(databaseFile: string, readOnly = false) {
    if (process.versions.bun) {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        return readOnly ? new Database(databaseFile, { readonly: true }) : new Database(databaseFile);
    }
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    return new DatabaseSync(databaseFile, { readOnly });
}

export interface WorkRow {
    aweme_id: string;
    aweme_type: string;
    title: string | null;
    author_id: string | null;
    author_name: string | null;
    author_sec_uid: string | null;
    create_time: number | null;
    download_time: number | null;
    file_path: string;
    image_count: number;
    metadata_path: string | null;
    cover_path: string | null;
    avatar_path: string | null;
}

export function resolveMediaPath(root: string, storedPath: string, { checkLegacyPath = true } = {}) {
    const normalized = storedPath.replace(/\\/g, '/');
    let absolute = path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(root, normalized);
    // Accept older project-relative rows until they have been converted.
    if (checkLegacyPath && !path.isAbsolute(normalized) && normalized.split('/')[0]?.toLowerCase() === path.basename(root).toLowerCase()
        && !existsSync(absolute)) {
        const legacy = path.resolve(path.dirname(root), normalized);
        if (existsSync(legacy)) absolute = legacy;
    }
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('数据库中的媒体路径超出下载目录');
    }
    return absolute;
}

export function readWorks(databaseFile: string): WorkRow[] {
    const database = openDatabase(databaseFile, true);
    try {
        database.exec('PRAGMA busy_timeout=5000');
        const columns = new Set((database.prepare('PRAGMA table_info(aweme)').all() as { name: string }[])
            .map(column => column.name));
        const legacyImageCount = columns.has('metadata') ? `CASE WHEN json_valid(metadata) THEN COALESCE(
            json_array_length(metadata, '$.images'),
            json_array_length(metadata, '$.image_post_info.images'), 0
        ) ELSE 0 END` : '0';
        const imageCount = columns.has('image_count')
            ? `COALESCE(image_count, ${legacyImageCount})` : legacyImageCount;
        const downloadTime = columns.has('download_time') ? 'download_time' : 'NULL AS download_time';
        const paths = ['metadata_path', 'cover_path', 'avatar_path'].map(column =>
            columns.has(column) ? column : `NULL AS ${column}`);
        return database.prepare(`
            SELECT aweme_id, aweme_type, title, author_id, author_name, author_sec_uid,
                   create_time, ${downloadTime}, file_path, ${imageCount} AS image_count, ${paths.join(', ')}
            FROM aweme WHERE COALESCE(file_path, '') != ''
            ORDER BY create_time DESC, aweme_id
        `).all() as unknown as WorkRow[];
    } finally {
        database.close();
    }
}

export function authorWorkIds(databaseFile: string, sharedKey: string | undefined, knownIds: string[]) {
    const ids = new Set(knownIds);
    if (!sharedKey) return [...ids].sort();
    const database = openDatabase(databaseFile, true);
    try {
        database.exec('PRAGMA busy_timeout=5000');
        const columns = new Set((database.prepare('PRAGMA table_info(aweme)').all() as { name: string }[]).map(row => row.name));
        const author = columns.has('author_sec_uid') ? "COALESCE(NULLIF(author_sec_uid, ''), author_id)" : 'author_id';
        for (const row of database.prepare(`SELECT aweme_id FROM aweme WHERE ${author}=?`).all(sharedKey) as { aweme_id: string }[]) ids.add(row.aweme_id);
        const queue = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_queue'").get();
        if (queue) {
            const prefix = `post:${sharedKey}:`;
            for (const row of database.prepare('SELECT aweme_id FROM download_queue WHERE scope>=? AND scope<?')
                .all(prefix, prefix + '\uffff') as { aweme_id: string }[]) ids.add(row.aweme_id);
        }
        return [...ids].sort();
    } finally { database.close(); }
}

export function resetDownloadedWorks(databaseFile: string, workIds: string[]) {
    const database = openDatabase(databaseFile);
    try {
        database.exec('PRAGMA busy_timeout=5000');
        const columns = new Set((database.prepare('PRAGMA table_info(aweme)').all() as { name: string }[]).map(row => row.name));
        const reset = ['file_path', 'download_time', 'metadata_path', 'cover_path', 'avatar_path']
            .filter(column => columns.has(column)).map(column => `${column}=NULL`).join(', ');
        const update = database.prepare(`UPDATE aweme SET ${reset} WHERE aweme_id=?`);
        const queue = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_queue'").get();
        const resetQueue = queue ? database.prepare("UPDATE download_queue SET status='pending', payload=?, updated_us=? WHERE aweme_id=?") : undefined;
        database.exec('BEGIN IMMEDIATE');
        try {
            for (const id of workIds) {
                update.run(id);
                resetQueue?.run(JSON.stringify({ aweme_id: id }), Date.now() * 1000, id);
            }
            database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
    } finally { database.close(); }
}

// Reconcile only records affected by an explicitly confirmed file deletion.
export async function reconcileDeletedWorks(databaseFile: string, root: string, workIds: string[]) {
    const database = openDatabase(databaseFile);
    try {
        database.exec('PRAGMA busy_timeout=5000');
        const find = database.prepare('SELECT file_path FROM aweme WHERE aweme_id=?');
        const remove = database.prepare('DELETE FROM aweme WHERE aweme_id=? AND file_path=?');
        for (const id of workIds) {
            const row = find.get(id) as { file_path: string } | undefined;
            if (!row?.file_path) continue;
            const file = resolveMediaPath(root, row.file_path);
            let missing = false;
            try {
                const details = await stat(file);
                missing = details.isFile() && details.size === 0;
            } catch (error) {
                if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
                missing = true;
            }
            if (missing) remove.run(id, row.file_path);
        }
    } finally {
        database.close();
    }
}
