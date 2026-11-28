import { createHash } from 'node:crypto';
import { compareCatalogWorks, compareCatalogAuthors, DatabaseCatalogMemo, readDatabaseCatalog } from './catalog.ts';
import type { Author, DatabaseCatalog, Work } from './catalog.ts';
import type { WorkRow } from './db.ts';

// Anonymous works are one conservative group; identified works share author naming/aliases.
function group(row: WorkRow, hashes: Map<string, string>) {
    const value = row.author_sec_uid || row.author_id;
    const author = typeof value === 'string' ? value.trim() : '';
    if (!author) return '';
    let id = hashes.get(author);
    if (!id) { id = createHash('sha256').update(`author\0${author}`).digest('hex').slice(0, 24); hashes.set(author, id); }
    return id;
}

export interface CatalogPatch {
    scannedAt: string;
    groups: string[];
    removeRows: string[];
    removeWorks: string[];
    rows: [string, WorkRow][];
    works: Work[];
    authors: Author[];
    avatars: [string, string][];
    copyCount: number;
}
export type CatalogUpdate = { snapshot: DatabaseCatalog } | { patch: CatalogPatch } | { unchanged: true };

export function applyCatalogPatch(previous: DatabaseCatalog, patch: CatalogPatch): DatabaseCatalog {
    const groups = new Set(patch.groups);
    const removed = new Set(patch.removeWorks);
    const works = previous.works.filter(work => !removed.has(work.id)).concat(patch.works);
    works.sort(compareCatalogWorks);
    const authors = previous.authors.filter(author => !groups.has(author.id)).concat(patch.authors);
    authors.sort(compareCatalogAuthors);
    const rowsById = new Map(previous.rowsById);
    for (const id of patch.removeRows) rowsById.delete(id);
    for (const [id, row] of patch.rows) rowsById.set(id, row);
    const workById = new Map(works.map(work => [work.id, work]));
    const avatarWorks = new Map(previous.avatarWorks);
    for (const id of groups) avatarWorks.delete(id);
    for (const [id, workId] of patch.avatars) avatarWorks.set(id, workById.get(workId)!);
    const worksByAuthor = new Map(previous.worksByAuthor);
    const additions = new Map<string, Work[]>();
    for (const work of patch.works) {
        if (!work.authorId) continue;
        const authored = additions.get(work.authorId) ?? [];
        authored.push(work);
        additions.set(work.authorId, authored);
    }
    for (const id of groups) {
        const authored = (previous.worksByAuthor.get(id) ?? []).filter(work => !removed.has(work.id)).concat(additions.get(id) ?? []);
        if (authored.length) worksByAuthor.set(id, authored.sort(compareCatalogWorks));
        else worksByAuthor.delete(id);
    }
    return { ...previous, scannedAt: patch.scannedAt, works, authors, rowsById, avatarWorks, worksByAuthor,
        workById,
        authorById: new Map(authors.map(author => [author.id, author])), copyCount: patch.copyCount };
}

/** Worker-owned state. A small work update never formats or clones unrelated authors. */
export class CatalogSession {
    private root?: string;
    private databaseFile?: string;
    private rows = new Map<string, { value: string; group: string; row: WorkRow }>();
    private memo = new DatabaseCatalogMemo();
    private worksByGroup = new Map<string, Work[]>();
    private workById = new Map<string, Work>();
    private initialized = false;
    private validRows = new Set<string>();
    private copyCount = 0;
    private order = new Map<string, string>();

    update(root: string, databaseFile: string, rows: WorkRow[]): CatalogUpdate {
        const hashes = new Map<string, string>();
        const groupIds = new Map<string, string[]>();
        const sameLibrary = this.initialized && root === this.root && databaseFile === this.databaseFile;
        const affected = new Set<string>();
        const next = new Map<string, { value: string; group: string; row: WorkRow }>();
        const stableRows: WorkRow[] = [];
        for (const row of rows) {
            const id = group(row, hashes);
            let ids = groupIds.get(id);
            if (!ids) { ids = []; groupIds.set(id, ids); }
            ids.push(row.aweme_id);
            const value = JSON.stringify(row);
            const previous = sameLibrary ? this.rows.get(row.aweme_id) : undefined;
            const unchanged = previous?.value === value;
            const stable = unchanged ? previous!.row : { ...row };
            next.set(row.aweme_id, { value, group: id, row: stable });
            stableRows.push(stable);
            if (!unchanged) {
                affected.add(id);
                if (previous) affected.add(previous.group);
            }
        }
        const order = new Map([...groupIds].map(([id, ids]) => [id, JSON.stringify(ids)]));
        if (!sameLibrary) {
            this.memo = new DatabaseCatalogMemo();
            const snapshot = readDatabaseCatalog(root, databaseFile, stableRows, this.memo);
            this.root = root;
            this.databaseFile = databaseFile;
            this.rows = next;
            this.validRows = new Set(snapshot.rowsById.keys());
            this.workById = new Map(snapshot.workById);
            this.worksByGroup = new Map(snapshot.worksByAuthor);
            this.worksByGroup.set('', snapshot.works.filter(work => !work.authorId));
            this.copyCount = snapshot.copyCount;
            this.order = order;
            this.initialized = true;
            return { snapshot };
        }
        for (const [id, row] of this.rows) if (!next.has(id)) affected.add(row.group);
        // Keep alias insertion order and equal-time author name selection identical to a full read.
        for (const [id, value] of order) if (this.order.get(id) !== value) affected.add(id);
        if (!affected.size) return { unchanged: true };
        const local = readDatabaseCatalog(root, databaseFile, stableRows.filter(row => affected.has(next.get(row.aweme_id)!.group)), this.memo);
        const affectedRows = [...this.validRows].filter(id => affected.has(this.rows.get(id)!.group));
        const removeRows = affectedRows.filter(id => local.rowsById.get(id) !== this.rows.get(id)!.row);
        const removeWorks = [...affected].flatMap(id => this.worksByGroup.get(id) ?? [])
            .filter(work => local.workById.get(work.id) !== work).map(work => work.id);
        const changedWorks = local.works.filter(work => this.workById.get(work.id) !== work);
        const patch: CatalogPatch = { scannedAt: local.scannedAt, groups: [...affected], removeRows, removeWorks,
            rows: [...local.rowsById].filter(([id, row]) => row !== this.rows.get(id)?.row),
            works: changedWorks, authors: local.authors,
            avatars: [...local.avatarWorks].map(([id, work]) => [id, work.id]),
            copyCount: this.copyCount - affectedRows.length + local.copyCount };
        for (const id of removeWorks) this.workById.delete(id);
        for (const work of changedWorks) this.workById.set(work.id, work);
        for (const id of affected) this.worksByGroup.delete(id);
        for (const [id, authored] of local.worksByAuthor) this.worksByGroup.set(id, authored);
        if (affected.has('')) this.worksByGroup.set('', local.works.filter(work => !work.authorId));
        for (const id of removeRows) this.validRows.delete(id);
        for (const id of local.rowsById.keys()) this.validRows.add(id);
        this.copyCount = patch.copyCount;
        this.rows = next;
        this.order = order;
        return { patch };
    }
}
