import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from './db.ts';
import { readConfigLinks, saveConfigLinks } from './config-links.ts';
import { canonicalLink, checkedFile, readHistoricalWorks } from './transfer-index.ts';
import { readImportPlan, transferDirectory } from './transfer-import.ts';
import { profileIdFromLink } from '../../shared/profile-link.ts';
import { readTransferWorks, transferStoreFile, TransferStore } from './transfer-store.ts';
import type { SharedAuthor, LibraryLocation } from './transfer-types.ts';
import type { WorkRow } from './db.ts';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class MaintenanceError extends Error {
    readonly status: number;
    constructor(message: string, status = 409) { super(message); this.status = status; }
}
export interface EmptyAuthor extends SharedAuthor {
    storeId?: string;
    currentWorks: number;
    historicalWorks: number;
    incomingWorks: number;
    urls: string[];
}
export interface AuthorAudit {
    scannedAt: string;
    token: string;
    candidates: EmptyAuthor[];
    protectedAuthors: number;
    pendingAuthors: number;
    configRevision: string;
}
const identityKeys = (uid: string, sec: string) => [uid && `uid:${uid}`, sec && `sec:${sec}`].filter(Boolean) as string[];

function registered(database: string): SharedAuthor[] {
    const file = transferStoreFile(database);
    if (!existsSync(file)) return [];
    const db = openDatabase(file, true);
    try {
        db.exec('PRAGMA busy_timeout=3000');
        return (db.prepare('SELECT * FROM authors').all() as { id: string; uid: string; sec_uid: string; name: string; aliases: string }[])
            .map(a => ({ id: a.id, uid: a.uid, secUid: a.sec_uid, name: a.name, aliases: JSON.parse(a.aliases) }));
    } finally { db.close(); }
}

export async function inspectEmptyAuthors(location: LibraryLocation): Promise<AuthorAudit> {
    if (!existsSync(location.database)) throw new MaintenanceError('作品数据库不存在，请先检查配置');
    const current = readTransferWorks(location.database);
    const historical = await readHistoricalWorks(location);
    const currentIds = new Set(current.map(row => row.aweme_id));
    const historicalIds = new Set(historical.map(row => row.aweme_id));
    const counts = [new Map<string, Set<string>>(), new Map<string, Set<string>>(), new Map<string, Set<string>>()];
    const add = (map: Map<string, Set<string>>, uid: string, sec: string, workId: string) => {
        for (const key of identityKeys(uid, sec)) { const set = map.get(key) ?? new Set(); set.add(workId); map.set(key, set); }
    };
    for (const row of current) add(counts[0]!, row.author_id ?? '', row.author_sec_uid ?? '', row.aweme_id);
    for (const row of historical) if (!currentIds.has(row.aweme_id)) add(counts[1]!, row.author_id ?? '', row.author_sec_uid ?? '', row.aweme_id);
    const lastFile = path.join(transferDirectory(location.database), 'last-import.json');
    let last;
    try { last = JSON.parse(await readFile(lastFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new MaintenanceError('待导入任务状态无法读取，请先检查任务记录'); }
    try {
        if (last && last.state !== 'completed' && last.preview?.id) {
            const plan = await readImportPlan(location, last.preview.id);
            const authors = new Map(plan.manifest.authors.map(a => [a.id, a]));
            for (const work of plan.manifest.works) {
                const author = work.authorId && authors.get(work.authorId);
                if (author && !currentIds.has(work.id) && !historicalIds.has(work.id)) add(counts[2]!, author.uid, author.secUid, work.id);
            }
        }
    } catch (error) {
        throw new MaintenanceError('待导入清单无法核对，请先恢复清单后再扫描空作者');
    }
    const config = readConfigLinks(location.config);
    const profiles = registered(location.database);
    const entries: EmptyAuthor[] = profiles.map(a => ({ ...a, storeId: a.id,
        id: hash(`author\0${a.secUid || a.uid || a.id}`).slice(0, 24), currentWorks: 0, historicalWorks: 0, incomingWorks: 0, urls: [] }));
    const byKey = new Map<string, EmptyAuthor>();
    for (const author of entries) for (const key of identityKeys(author.uid, author.secUid)) byKey.set(key, author);
    for (const link of config.links) {
        const secUid = profileIdFromLink(link);
        if (!secUid) continue;
        let author = byKey.get(`sec:${secUid}`) ?? byKey.get(`uid:${secUid}`);
        if (!author) {
            author = { id: hash(`author\0${secUid}`).slice(0, 24), uid: '', secUid, name: '昵称未采集', aliases: [], currentWorks: 0, historicalWorks: 0, incomingWorks: 0, urls: [] };
            entries.push(author); byKey.set(`sec:${secUid}`, author);
        }
        author.urls.push(link);
    }
    const candidates: EmptyAuthor[] = [];
    let protectedAuthors = 0, pendingAuthors = 0;
    for (const author of entries) {
        const totals = counts.map(map => new Set(identityKeys(author.uid, author.secUid).flatMap(key => [...(map.get(key) ?? [])])).size);
        [author.currentWorks, author.historicalWorks, author.incomingWorks] = totals as [number, number, number];
        if (totals.some(Boolean)) { protectedAuthors++; if (author.incomingWorks) pendingAuthors++; }
        else candidates.push(author);
    }
    candidates.sort((a, b) => a.id.localeCompare(b.id));
    return { scannedAt: new Date().toISOString(), token: hash([config.revision, candidates]), candidates, protectedAuthors, pendingAuthors, configRevision: config.revision };
}

async function backup(location: LibraryLocation, data: unknown) {
    const directory = path.join(path.dirname(location.database), 'import-backups', `manual-cleanup-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(data, null, 2), { mode: 0o600 });
    return directory;
}

export async function removeEmptyAuthors(location: LibraryLocation, ids: string[], token: string) {
    if (!existsSync(location.database)) throw new MaintenanceError('作品数据库不存在，请先检查配置');
    const lock = openDatabase(location.database);
    const store = new TransferStore(location.database);
    let locked = false, storeLocked = false;
    try {
        lock.exec('PRAGMA busy_timeout=3000; BEGIN IMMEDIATE'); locked = true;
        store.db.exec('BEGIN IMMEDIATE'); storeLocked = true;
        const audit = await inspectEmptyAuthors(location);
        if (token !== audit.token) throw new MaintenanceError('作者、作品或链接已变化，请重新扫描并确认');
        const selected = audit.candidates.filter(a => ids.includes(a.id));
        if (selected.length !== new Set(ids).size) throw new MaintenanceError('所选作者已有当前、历史或待导入作品，不能作为空作者清理');
        const config = readConfigLinks(location.config);
        const removed = new Set(selected.flatMap(a => a.urls));
        const retained = config.links.filter(link => !removed.has(link));
        const receipt = await backup(location, { kind: 'empty-authors', authors: selected, linksBefore: config.links, revision: config.revision });
        for (const author of selected) {
            if (author.storeId) {
                store.db.prepare("UPDATE links SET configured=0,removed=1,author_id=NULL,status='unresolved' WHERE author_id=?").run(author.storeId);
                store.db.prepare('DELETE FROM authors WHERE id=?').run(author.storeId);
            }
            for (const link of author.urls) {
                const url = canonicalLink(link);
                if (!url) continue;
                store.saveLink({ url, authorId: null, status: 'unresolved', enabled: false });
                store.db.prepare("UPDATE links SET configured=0,removed=1,author_id=NULL,status='unresolved' WHERE url=?").run(url);
            }
        }
        saveConfigLinks(location.config, retained, config.revision);
        store.db.exec('COMMIT'); storeLocked = false; lock.exec('COMMIT'); locked = false;
        return { removedAuthors: selected.length, removedLinks: config.links.length - retained.length, deletedFiles: 0, receipt };
    } catch (error) { if (storeLocked) store.db.exec('ROLLBACK'); if (locked) lock.exec('ROLLBACK'); throw error; }
    finally { store.close(); lock.close(); }
}

export function previewLinkRemoval(location: LibraryLocation, links: string[]) {
    const config = readConfigLinks(location.config);
    const selected = [...new Set(links)].sort();
    if (!selected.length || selected.some(link => !config.links.includes(link))) throw new MaintenanceError('部分链接已变化，请重新读取链接列表');
    return { links: selected, removedLinks: config.links.filter(link => selected.includes(link)).length,
        token: hash([config.revision, selected]), revision: config.revision };
}
export async function removeLinks(location: LibraryLocation, links: string[], token: string) {
    const preview = previewLinkRemoval(location, links);
    if (preview.token !== token) throw new MaintenanceError('链接已变化，请重新查看清理范围');
    const config = readConfigLinks(location.config);
    const retained = config.links.filter(link => !preview.links.includes(link));
    const receipt = await backup(location, { kind: 'links', linksBefore: config.links, selected: preview.links });
    saveConfigLinks(location.config, retained, preview.revision);
    const store = new TransferStore(location.database);
    try {
        const canonical = new Set(retained.map(canonicalLink).filter(Boolean));
        for (const link of preview.links) {
            const url = canonicalLink(link);
            if (!url || canonical.has(url)) continue;
            store.saveLink({ url, authorId: null, status: 'unresolved', enabled: false });
            store.db.prepare('UPDATE links SET configured=0,removed=1 WHERE url=?').run(url);
        }
        store.syncConfigured([...canonical] as string[]);
    } finally { store.close(); }
    return { removedLinks: preview.removedLinks, removedAuthors: 0, deletedFiles: 0, receipt };
}


export async function importIssueReport(location: LibraryLocation, kind: string, page: number, size = 50) {
    const lastFile = path.join(transferDirectory(location.database), 'last-import.json');
    const last = JSON.parse(await readFile(lastFile, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'; throw error;
    }));
    if (!last.preview?.id) return { items: [], total: 0, page: 1, pages: 1, kind };
    const plan = await readImportPlan(location, last.preview.id);
    const files = new Map(plan.manifest.files.map(file => [file.id, file]));
    const resolved = new Set<string>();
    if (kind === 'unassigned' && Array.isArray(plan.unassignedResolutions) && existsSync(transferStoreFile(location.database))) {
        const db = openDatabase(transferStoreFile(location.database), true);
        try {
            const works = new Map(readTransferWorks(location.database).map(row => [row.aweme_id, row]));
            for (const entry of plan.unassignedResolutions) {
                const source = plan.manifest.unassigned?.find(file => file.path === entry.path && file.size === entry.size);
                const work = works.get(entry.workId);
                if (!source || !work?.file_path || !/^[a-f0-9]{64}$/.test(entry.sha256)) continue;
                const asset = db.prepare("SELECT relative_path FROM assets WHERE work_id=? AND role IN ('video','image') AND sha256=? AND relative_path=?")
                    .get(entry.workId, entry.sha256, work.file_path) as { relative_path: string } | undefined;
                if (!asset) continue;
                const current = await checkedFile(location.root, asset.relative_path).catch(() => undefined);
                if (current?.stats.size === source.size) resolved.add(source.path);
            }
        } finally { db.close(); }
    }
    const rows = kind === 'unassigned' ? (plan.manifest.unassigned ?? []).filter(file => !resolved.has(file.path)).map(file => ({ ...file, name: file.path, reason: '来源文件尚未关联到作品', workId: null, target: null }))
        : plan.actions.filter(action => action.action === 'conflict').map(action => ({ ...files.get(action.fileId)!, target: action.target,
            reason: action.reason ?? '保留本地内容，来源版本待人工核对' }));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const current = Math.min(page, pages);
    return { items: rows.slice((current - 1) * size, current * size), total: rows.length, page: current, pages, kind,
        source: plan.address, unassignedTotal: Math.max(0, plan.manifest.unassignedFiles - resolved.size), resolvedUnassigned: resolved.size, snapshotId: plan.snapshotId };
}
