import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from './db.ts';
import type { WorkRow } from './db.ts';
import type { SharedAuthor, SharedLink } from './transfer-types.ts';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const transferStoreFile = (database: string) => `${database}.library.sqlite`;

export function readTransferWorks(file: string): WorkRow[] {
    if (!existsSync(file)) return [];
    const db = openDatabase(file, true);
    try {
        db.exec('PRAGMA busy_timeout=3000');
        const columns = new Set((db.prepare('PRAGMA table_info(aweme)').all() as { name: string }[]).map(r => r.name));
        if (!columns.has('aweme_id')) return [];
        const names = ['aweme_id', 'aweme_type', 'title', 'author_id', 'author_name', 'author_sec_uid',
            'create_time', 'download_time', 'file_path', 'image_count', 'metadata_path', 'cover_path', 'avatar_path'];
        return db.prepare(`SELECT ${names.map(name => columns.has(name) ? name : `NULL AS ${name}`).join(',')} FROM aweme`).all() as unknown as WorkRow[];
    } finally { db.close(); }
}

export const hasAuthorName = (name: string) => Boolean(name.trim()) && name.trim() !== '未命名作者';

/** A generated placeholder is missing data, not an authoritative local profile. */
export function mergeAuthorProfile(local: SharedAuthor, incoming: SharedAuthor): SharedAuthor {
    return { ...local, uid: local.uid || incoming.uid, secUid: local.secUid || incoming.secUid,
        name: hasAuthorName(local.name) ? local.name : hasAuthorName(incoming.name) ? incoming.name : '未命名作者',
        aliases: [...new Set([...local.aliases, ...incoming.aliases, local.name, incoming.name].filter(hasAuthorName))] };
}

export class TransferStore {
    readonly db: ReturnType<typeof openDatabase>;
    private readonly file: string;
    private hashes?: ReturnType<typeof openDatabase>;
    constructor(database: string) {
        const file = transferStoreFile(database);
        this.file = file;
        mkdirSync(path.dirname(file), { recursive: true });
        this.db = openDatabase(file);
        this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, uid TEXT NOT NULL, sec_uid TEXT NOT NULL, name TEXT NOT NULL, aliases TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS links (url TEXT PRIMARY KEY, author_id TEXT, status TEXT NOT NULL, configured INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS assets (work_id TEXT NOT NULL, role TEXT NOT NULL, position INTEGER NOT NULL, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, PRIMARY KEY(work_id,role,position));`);
    }
    close() { this.hashes?.close(); this.db.close(); }
    private hashDatabase() {
        if (!this.hashes) {
            this.hashes = openDatabase(`${this.file}.fingerprints.sqlite`);
            this.hashes.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS fingerprints (relative_path TEXT PRIMARY KEY, stamp TEXT NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL);`);
        }
        return this.hashes;
    }
    instanceId() {
        let value = (this.db.prepare("SELECT value FROM meta WHERE key='instance'").get() as { value: string } | undefined)?.value;
        if (!value) {
            this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('instance',?)").run(randomUUID());
            value = (this.db.prepare("SELECT value FROM meta WHERE key='instance'").get() as { value: string }).value;
        }
        return value;
    }
    authors(): SharedAuthor[] {
        return (this.db.prepare('SELECT * FROM authors').all() as { id: string; uid: string; sec_uid: string; name: string; aliases: string }[])
            .map(r => ({ id: r.id, uid: r.uid, secUid: r.sec_uid, name: r.name, aliases: JSON.parse(r.aliases) }));
    }
    saveAuthor(author: SharedAuthor) {
        const row = this.db.prepare("SELECT * FROM authors WHERE id=? OR (uid<>'' AND uid=?) OR (sec_uid<>'' AND sec_uid=?) LIMIT 1")
            .get(author.id, author.uid, author.secUid) as { id: string; uid: string; sec_uid: string; name: string; aliases: string } | undefined;
        const known: SharedAuthor | undefined = row ? { id: row.id, uid: row.uid, secUid: row.sec_uid, name: row.name, aliases: JSON.parse(row.aliases) } : undefined;
        if (known) {
            const merged = mergeAuthorProfile(known, author);
            const aliases = JSON.stringify(merged.aliases);
            if (merged.uid !== known.uid || merged.secUid !== known.secUid || merged.name !== known.name || aliases !== JSON.stringify(known.aliases)) {
                this.db.prepare('UPDATE authors SET uid=?,sec_uid=?,name=?,aliases=? WHERE id=?')
                    .run(merged.uid, merged.secUid, merged.name, aliases, known.id);
            }
            return;
        }
        this.db.prepare('INSERT OR IGNORE INTO authors VALUES (?,?,?,?,?)').run(author.id, author.uid, author.secUid, author.name, JSON.stringify(author.aliases));
    }
    links(): (SharedLink & { removed: boolean })[] {
        return (this.db.prepare('SELECT * FROM links').all() as { url: string; author_id: string | null; status: SharedLink['status']; configured: number; removed: number }[])
            .map(r => ({ url: r.url, authorId: r.author_id, status: r.status, enabled: Boolean(r.configured), removed: Boolean(r.removed) }));
    }
    saveLink(link: SharedLink) {
        this.db.prepare('INSERT OR IGNORE INTO links(url,author_id,status,configured) VALUES (?,?,?,?)').run(link.url, link.authorId, link.status, Number(link.enabled));
    }
    syncConfigured(links: string[]) {
        const configured = new Set(links);
        for (const link of this.links()) {
            if (link.enabled && !configured.has(link.url)) this.db.prepare('UPDATE links SET configured=0,removed=1 WHERE url=?').run(link.url);
            if (configured.has(link.url) && (!link.enabled || link.removed)) this.db.prepare('UPDATE links SET configured=1,removed=0 WHERE url=?').run(link.url);
        }
    }
    fingerprint(relative: string, stamp: string) {
        return this.hashDatabase().prepare('SELECT sha256,mime FROM fingerprints WHERE relative_path=? AND stamp=?').get(relative, stamp) as { sha256: string; mime: string } | undefined;
    }
    saveFingerprint(relative: string, stamp: string, sha: string, mime: string) {
        this.hashDatabase().prepare('INSERT OR REPLACE INTO fingerprints VALUES (?,?,?,?)').run(relative, stamp, sha, mime);
    }
    assets() {
        return this.db.prepare('SELECT work_id,role,position,relative_path,sha256 FROM assets').all() as {
            work_id: string; role: string; position: number; relative_path: string; sha256: string;
        }[];
    }
    saveAsset(work: string, role: string, index: number, relative: string, sha: string) {
        this.db.prepare('INSERT OR IGNORE INTO assets VALUES (?,?,?,?,?)').run(work, role, index, relative, sha);
    }
}

export function ensureWorkDatabase(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    const db = openDatabase(file);
    db.exec(`PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS aweme (
            id INTEGER PRIMARY KEY AUTOINCREMENT, aweme_id TEXT UNIQUE NOT NULL, aweme_type TEXT NOT NULL,
            title TEXT, author_id TEXT, author_name TEXT, create_time INTEGER, download_time INTEGER,
            file_path TEXT, metadata TEXT, author_sec_uid TEXT, cover_urls TEXT NOT NULL DEFAULT '',
            job_id TEXT NOT NULL DEFAULT '', image_count INTEGER, metadata_path TEXT, cover_path TEXT, avatar_path TEXT);`);
    const columns = new Set((db.prepare('PRAGMA table_info(aweme)').all() as { name: string }[]).map(r => r.name));
    for (const [name, type] of Object.entries({ author_sec_uid: 'TEXT', image_count: 'INTEGER', metadata_path: 'TEXT', cover_path: 'TEXT', avatar_path: 'TEXT', download_time: 'INTEGER' })) {
        if (!columns.has(name)) db.exec(`ALTER TABLE aweme ADD COLUMN ${name} ${type}`);
    }
    return db;
}
