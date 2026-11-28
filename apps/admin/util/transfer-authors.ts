import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { openDatabase } from './db.ts';
import { transferStoreFile } from './transfer-store.ts';
import type { Author, DatabaseCatalog, Work } from './catalog.ts';

interface StoredAuthor { id: string; uid: string; sec_uid: string; name: string; aliases: string }
const uiId = (a: StoredAuthor) => createHash('sha256').update(`author\0${a.sec_uid || a.uid || a.id}`).digest('hex').slice(0, 24);

/** Keep authors imported without works visible; do not replace authors already derived from local works. */
export function withRegisteredAuthors(snapshot: DatabaseCatalog, database: string): DatabaseCatalog {
    const file = transferStoreFile(database);
    if (!existsSync(file)) return snapshot;
    const db = openDatabase(file, true);
    try {
        db.exec('PRAGMA busy_timeout=200');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='authors'").get()) return snapshot;
        const registered = db.prepare('SELECT * FROM authors').all() as unknown as StoredAuthor[];
        const known = new Set(snapshot.authors.map(a => a.sharedKey).filter(Boolean));
        const additions: Author[] = [];
        for (const author of registered) {
            const id = uiId(author);
            if (snapshot.authorById.has(id) || author.uid && known.has(author.uid) || author.sec_uid && known.has(author.sec_uid)) continue;
            const aliases = JSON.parse(author.aliases) as string[];
            additions.push({ id, name: author.name, aliases, workCount: 0, latest: '', downloadTime: 0, issueCount: 0,
                search: [author.name, ...aliases, author.uid, author.sec_uid].join(' ').toLowerCase(), sharedKey: author.sec_uid || author.uid || author.id });
            if (author.uid) known.add(author.uid);
            if (author.sec_uid) known.add(author.sec_uid);
        }
        if (!additions.length) return snapshot;
        const memberships = (snapshot as DatabaseCatalog & { worksByAuthor?: Map<string, Work[]> }).worksByAuthor;
        return Object.assign({ ...snapshot }, { authors: [...snapshot.authors, ...additions],
            authorById: new Map([...snapshot.authorById, ...additions.map(a => [a.id, a] as const)]),
            worksByAuthor: new Map([...(memberships ?? []), ...additions.map(a => [a.id, [] as Work[]] as const)]) });
    } finally { db.close(); }
}

export function forgetRegisteredAuthors(database: string, ids: string[]) {
    const file = transferStoreFile(database);
    if (!existsSync(file)) return;
    const db = openDatabase(file);
    try {
        const selected = new Set(ids);
        for (const author of db.prepare('SELECT * FROM authors').all() as unknown as StoredAuthor[]) {
            if (!selected.has(uiId(author))) continue;
            db.prepare('UPDATE links SET configured=0,removed=1 WHERE author_id=?').run(author.id);
            db.prepare('DELETE FROM authors WHERE id=?').run(author.id);
        }
    } finally { db.close(); }
}
