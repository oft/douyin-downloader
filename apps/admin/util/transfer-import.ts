import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalLink, checkedFile, fileStamp, fingerprint, indexLibrary } from './transfer-index.ts';
import { readConfigLinks, saveConfigLinks } from './config-links.ts';
import { digest, ensureWorkDatabase, mergeAuthorProfile, readTransferWorks, TransferStore } from './transfer-store.ts';
import { fetchManifest, remoteSource, validateManifest } from './transfer-protocol.ts';
import type { ImportAction, ImportCounts, ImportOptions, ImportPlan, IndexedFile, LibraryLocation, ProgressReporter, RemoteSource, SharedAuthor, SharedFile, ShareManifest } from './transfer-types.ts';
import type { WorkRow } from './db.ts';

export const transferDirectory = (database: string) => path.join(path.dirname(database), '.library-transfer', digest(database).slice(0, 16));
const slot = (file: { workId: string; role: string; index: number }) => `${file.workId}:${file.role}:${file.index}`;
const ext = (file: SharedFile) => {
    const extension = path.extname(file.name).toLowerCase();
    const permitted = file.role === 'video' ? ['.mp4', '.m4v', '.mov', '.mkv', '.webm'] : file.role === 'music'
        ? ['.mp3', '.m4a', '.flac', '.wav', '.ogg'] : file.role === 'metadata' ? ['.json'] : ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif', '.avif'];
    // Existing naming conventions recognize numbered gallery images and per-work sidecars.
    return permitted.includes(extension) ? extension : file.role === 'video' ? '.mp4' : file.role === 'music' ? '.mp3' : file.role === 'metadata' ? '.json' : '.jpg';
};

function fileTarget(file: SharedFile, row: WorkRow | undefined) {
    let directory = `imported/post/${file.workId}`;
    let stem = file.workId;
    const stored = row?.file_path?.replace(/\\/g, '/');
    if (stored && !path.posix.isAbsolute(stored) && !/^[A-Za-z]:/.test(stored) && !stored.split('/').some(p => p === '..' || p === '.')) {
        directory = path.posix.dirname(stored);
        stem = path.posix.parse(stored).name.replace(/_(?:image_)?\d+$/, row?.aweme_type === 'gallery' ? '' : '$&').replace(/_video$/, '');
    }
    const suffix = file.role === 'video' ? '' : file.role === 'image' ? `_${file.index + 1}` : file.role === 'metadata' ? '_data' : `_${file.role}`;
    return path.posix.join(directory, `${stem}${suffix}${ext(file)}`);
}

async function existing(root: string, relative: string) {
    try { return await checkedFile(root, relative); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Retain authors backed by current or historical work records, even when media is missing. */
function importableAuthorIds(manifest: ShareManifest, rows: WorkRow[]) {
    const known = new Set<string>();
    for (const row of rows) {
        if (row.author_id) known.add(`uid:${row.author_id}`);
        if (row.author_sec_uid) known.add(`sec:${row.author_sec_uid}`);
    }
    const withWorks = new Set(manifest.works.map(work => work.authorId));
    return new Set(manifest.authors.filter(author => withWorks.has(author.id)
        || author.uid && known.has(`uid:${author.uid}`)
        || author.secUid && known.has(`sec:${author.secUid}`)).map(author => author.id));
}

export async function previewImport(location: LibraryLocation, source: RemoteSource,
    progress: ProgressReporter = () => {}, signal?: AbortSignal): Promise<ImportPlan> {
    const remote = remoteSource(source);
    progress({ stage: '连接分享服务', completed: 0, total: 0, bytes: 0, bytesTotal: 0 });
    const manifest = await fetchManifest(remote, signal);
    await mkdir(location.root, { recursive: true });
    const local = await indexLibrary(location, { hash: false }, progress, signal);
    if (manifest.instanceId === local.manifest.instanceId) throw new Error('这是本机的分享服务，无需导入');
    const root = await realpath(location.root);
    const currentRows = readTransferWorks(location.database);
    const acceptedAuthors = importableAuthorIds(manifest, currentRows);
    const store = new TransferStore(location.database);
    try {
        const identity = new Map<string, SharedAuthor>();
        for (const author of local.manifest.authors) {
            if (author.uid) identity.set(`uid:${author.uid}`, author);
            if (author.secUid) identity.set(`sec:${author.secUid}`, author);
            identity.set(`id:${author.id}`, author);
        }
        const authorMap: Record<string, string> = Object.create(null);
        const counts: ImportCounts = { newAuthors: 0, existingAuthors: 0, newLinks: 0, existingLinks: 0, pendingLinks: 0,
            newWorks: 0, existingWorks: 0, filesToAdd: 0, filesToSkip: 0, conflicts: 0, bytesToTransfer: 0, unassignedFiles: manifest.unassignedFiles };
        for (const author of manifest.authors) {
            if (!acceptedAuthors.has(author.id)) continue;
            const found = author.uid && identity.get(`uid:${author.uid}`) || author.secUid && identity.get(`sec:${author.secUid}`) || identity.get(`id:${author.id}`);
            authorMap[author.id] = found ? found.id : author.uid ? `douyin:uid:${author.uid}` : author.secUid ? `douyin:sec:${author.secUid}` : `imported:${digest(`${manifest.instanceId}:${author.id}`)}`;
            if (found) counts.existingAuthors++; else counts.newAuthors++;
        }
        const config = readConfigLinks(location.config);
        const knownLinks = new Set([...config.links.map(canonicalLink).filter(Boolean), ...store.links().map(l => l.url)]);
        for (const link of manifest.links) {
            if (!link.authorId || !acceptedAuthors.has(link.authorId)) continue;
            if (knownLinks.has(link.url)) counts.existingLinks++; else counts.newLinks++;
            if (link.status === 'unresolved') counts.pendingLinks++;
        }
        const rows = new Map(currentRows.map(row => [row.aweme_id, row]));
        for (const work of manifest.works) { if (rows.has(work.id)) counts.existingWorks++; else counts.newWorks++; }
        const slots = new Map<string, IndexedFile[]>();
        for (const file of local.files) { const list = slots.get(slot(file)) ?? []; list.push(file); slots.set(slot(file), list); }
        const reserved = new Map<string, { file: SharedFile; target: string }>();
        const actions: ImportAction[] = [];
        for (const file of manifest.files) {
            signal?.throwIfAborted();
            const copies = slots.get(slot(file)) ?? [];
            let action: ImportAction | undefined;
            for (const candidate of copies) {
                if (candidate.size !== file.size) continue;
                const hashed = await fingerprint(root, candidate, store);
                if (hashed.sha256 === file.sha256) { action = { fileId: file.id, workId: file.workId, target: candidate.relativePath, action: 'skip' }; break; }
            }
            if (!action && copies.length) action = { fileId: file.id, workId: file.workId, target: copies[0]!.relativePath, action: 'conflict', reason: '本地同一位置已有不同内容，保留本地文件' };
            const prior = reserved.get(slot(file));
            if (!action && prior) action = { fileId: file.id, workId: file.workId, target: prior.target,
                action: prior.file.sha256 === file.sha256 ? 'skip' : 'conflict', reason: '分享中存在多个副本，默认只补一份' };
            if (!action) {
                const target = fileTarget(file, rows.get(file.workId));
                // Never silently replace even a zero-byte or unindexed local file.
                const occupant = await lstat(path.join(root, ...target.split('/'))).catch(error => {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error;
                });
                action = { fileId: file.id, workId: file.workId, target, action: occupant ? 'conflict' : 'add',
                    ...(occupant ? { reason: '目标位置已存在文件或目录，未覆盖' } : {}) };
                if (!occupant) reserved.set(slot(file), { file, target });
            }
            actions.push(action);
            if (action.action === 'add') { counts.filesToAdd++; counts.bytesToTransfer += file.size; }
            else if (action.action === 'skip') counts.filesToSkip++;
            else counts.conflicts++;
            if (actions.length % 100 === 0) progress({ stage: '比较本地已有内容', completed: actions.length, total: manifest.files.length, bytes: 0, bytesTotal: counts.bytesToTransfer });
        }
        const plan: ImportPlan = { id: randomUUID(), address: remote.address, snapshotId: manifest.snapshotId,
            createdAt: new Date().toISOString(), counts, actions, authorMap, linkRevision: config.revision, manifest };
        const directory = transferDirectory(location.database);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, `${plan.id}.json`), JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
        return plan;
    } finally { store.close(); }
}

export async function readImportPlan(location: LibraryLocation, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('导入预览不存在');
    const file = path.join(transferDirectory(location.database), `${id}.json`);
    const plan = JSON.parse(await readFile(file, 'utf8')) as ImportPlan;
    validateManifest(plan.manifest);
    if (plan.id !== id || plan.snapshotId !== plan.manifest.snapshotId) throw new Error('导入预览已损坏');
    return plan;
}

async function assertRoot(root: string, identity: string) {
    const current = await lstat(root);
    if (!current.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== identity || await realpath(root) !== root) throw new Error('下载目录已断开或被替换，导入已停止');
}

async function destination(root: string, relative: string, identity: string) {
    await assertRoot(root, identity);
    const parts = relative.split('/');
    if (parts.some(p => !p || p === '..' || p === '.' || /[\\:\0-\x1f]/.test(p))) throw new Error('导入目标路径无效');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        await mkdir(parent).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        const current = await lstat(parent);
        if (!current.isDirectory() || current.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('目标目录被重定向，未写入文件');
    }
    return path.join(root, ...parts);
}

async function hashFile(file: string) {
    const handle = await open(file, 'r');
    try { const hash = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest('hex'); }
    finally { await handle.close(); }
}

async function download(source: RemoteSource, plan: ImportPlan, file: SharedFile, partial: string,
    progress: (bytes: number) => void, signal?: AbortSignal) {
    let offset = (await lstat(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }))?.size ?? 0;
    const info = await lstat(partial).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('临时文件被替换');
    if (info && offset === 0) await unlink(partial);
    if (offset === file.size && await hashFile(partial) === file.sha256) return;
    if (offset >= file.size) { await unlink(partial); offset = 0; }
    const headers: Record<string, string> = { Authorization: `Bearer ${source.code}`, 'X-Library-Snapshot': plan.snapshotId, 'If-Match': `"${file.sha256}"` };
    if (offset) headers.Range = `bytes=${offset}-`;
    const response = await fetch(`${source.address}/v1/files/${file.id}`, { headers, redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(30 * 60_000), ...(signal ? [signal] : [])]) });
    if (response.status === 409) throw new Error('分享的源文件已变化，请重新读取分享清单');
    if (!response.ok || !response.body) throw new Error(`无法下载分享文件（${response.status}），可稍后继续`);
    if (response.headers.get('ETag') !== `"${file.sha256}"`) { await response.body.cancel(); throw new Error('分享文件校验标识不一致'); }
    if (offset && response.status === 200) { await unlink(partial); offset = 0; }
    if (offset && (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${offset}-${file.size - 1}/${file.size}`)) {
        await response.body.cancel(); throw new Error('分享服务不支持可靠续传，请重新生成分享');
    }
    const output = await open(partial, offset ? 'r+' : 'wx', 0o600);
    let bytes = offset;
    try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal?.throwIfAborted();
            if (bytes + chunk.byteLength > file.size) throw new Error('分享文件长度超过清单，未导入');
            let written = 0;
            while (written < chunk.byteLength) {
                // Explicit positions also work around append-offset differences in older Windows runtimes.
                const result = await output.write(chunk, written, chunk.byteLength - written, bytes + written);
                if (!result.bytesWritten) throw new Error('无法继续写入临时文件，已保留断点');
                written += result.bytesWritten;
            }
            bytes += chunk.byteLength; progress(bytes);
        }
        await output.sync();
    } finally { await output.close(); }
    if (bytes !== file.size) throw new Error('文件尚未传输完整，可继续导入');
    if (await hashFile(partial) !== file.sha256) { await unlink(partial); throw new Error('文件哈希校验失败，未导入'); }
}

/** Publish without replacing a concurrent writer, including on exFAT without hard links. */
async function publish(partial: string, target: string) {
    try { await link(partial, target); await unlink(partial); return; }
    catch (error) {
        if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    // COPYFILE_EXCL is a no-clobber reservation on filesystems without hard links.
    await copyFile(partial, target, constants.COPYFILE_EXCL);
    const output = await open(target, 'r+');
    try { await output.sync(); } finally { await output.close(); }
    await unlink(partial);
}

export async function executeImport(location: LibraryLocation, source: RemoteSource, id: string, options: ImportOptions = {},
    progress: ProgressReporter = () => {}, signal?: AbortSignal) {
    const remote = remoteSource(source);
    const plan = await readImportPlan(location, id);
    if (remote.address !== plan.address) throw new Error('分享地址与预览不一致，请重新读取清单');
    const latest = await fetchManifest(remote, signal);
    if (latest.snapshotId !== plan.snapshotId || latest.instanceId !== plan.manifest.instanceId) throw new Error('分享已更新，请重新读取清单');
    const root = await realpath(location.root);
    const rootStats = await lstat(root);
    const rootIdentity = `${rootStats.dev}:${rootStats.ino}`;
    // Repeated imports must also recognize moved files and files published before a crash.
    const inventory = await indexLibrary(location, { hash: false }, progress, signal);
    const localAuthors = new Map(inventory.manifest.authors.map(author => [author.id, author]));
    const localSlots = new Map<string, IndexedFile[]>();
    for (const file of inventory.files) { const list = localSlots.get(slot(file)) ?? []; list.push(file); localSlots.set(slot(file), list); }
    const partialDirectory = '.library-import';
    await destination(root, `${partialDirectory}/reservation`, rootIdentity);
    const store = new TransferStore(location.database);
    const db = ensureWorkDatabase(location.database);
    const result = { authors: 0, links: 0, works: 0, files: 0, skipped: 0, conflicts: 0, bytes: 0 };
    const files = new Map(plan.manifest.files.map(file => [file.id, file]));
    const actions = new Map(plan.actions.map(action => [action.fileId, action]));
    const authors = new Map(plan.manifest.authors.map(a => [a.id, a]));
    const knownAuthors = new Set(store.authors().map(a => a.id));
    let processed = 0;
    try {
        // Recheck local identities at execution time; previews are never permission to overwrite local data.
        const currentRows = readTransferWorks(location.database);
        const acceptedAuthors = importableAuthorIds(plan.manifest, currentRows);
        const acceptedLinks = plan.manifest.links.filter(link => link.authorId && acceptedAuthors.has(link.authorId));
        const identities = new Map<string, string>();
        for (const author of store.authors()) {
            if (author.uid) identities.set(`uid:${author.uid}`, author.id);
            if (author.secUid) identities.set(`sec:${author.secUid}`, author.id);
        }
        for (const row of currentRows) {
            const key = row.author_id && identities.get(`uid:${row.author_id}`) || row.author_sec_uid && identities.get(`sec:${row.author_sec_uid}`)
                || (row.author_id ? `douyin:uid:${row.author_id}` : row.author_sec_uid ? `douyin:sec:${row.author_sec_uid}` : '');
            if (row.author_id) identities.set(`uid:${row.author_id}`, key);
            if (row.author_sec_uid) identities.set(`sec:${row.author_sec_uid}`, key);
        }
        for (const author of plan.manifest.authors) {
            if (!acceptedAuthors.has(author.id)) continue;
            const found = author.uid && identities.get(`uid:${author.uid}`) || author.secUid && identities.get(`sec:${author.secUid}`);
            if (found) plan.authorMap[author.id] = found;
            const localId = plan.authorMap[author.id]!;
            const local = localAuthors.get(localId);
            const incoming = { ...author, id: localId };
            const merged = local ? mergeAuthorProfile(local, incoming) : incoming;
            store.saveAuthor(merged);
            localAuthors.set(localId, merged);
            if (merged.uid) identities.set(`uid:${merged.uid}`, localId);
            if (merged.secUid) identities.set(`sec:${merged.secUid}`, localId);
            if (!found && !knownAuthors.has(localId)) { knownAuthors.add(localId); result.authors++; }
        }
        for (const work of plan.manifest.works) {
            signal?.throwIfAborted();
            await assertRoot(root, rootIdentity);
            const present = new Map<string, { file: SharedFile; relative: string }>();
            for (const fileId of work.files) {
                signal?.throwIfAborted();
                const file = files.get(fileId)!;
                const action = actions.get(fileId)!;
                const update = (bytes = 0) => progress({ stage: '导入缺失文件', completed: processed, total: plan.manifest.files.length,
                    bytes: result.bytes + bytes, bytesTotal: plan.counts.bytesToTransfer, current: file.name, skipped: result.skipped, conflicts: result.conflicts });
                const localCopies = localSlots.get(slot(file)) ?? [];
                let matching: IndexedFile | undefined;
                let occupied = false;
                for (const copy of localCopies) {
                    const current = await existing(root, copy.relativePath);
                    if (!current) continue;
                    occupied = true;
                    if (current.stats.size === file.size && (await fingerprint(root, copy, store)).sha256 === file.sha256) { matching = copy; break; }
                }
                if (matching) {
                    present.set(slot(file), { file, relative: matching.relativePath }); result.skipped++; processed++; update(); continue;
                }
                if (occupied || action.action === 'conflict') { result.conflicts++; processed++; update(); continue; }
                const target = await destination(root, action.target, rootIdentity);
                const occupant = await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return undefined; });
                if (occupant) {
                    const safe = await checkedFile(root, action.target).catch(() => undefined);
                    if (safe && safe.stats.size === file.size && await hashFile(safe.absolute) === file.sha256) {
                        present.set(slot(file), { file, relative: action.target }); result.skipped++;
                    } else result.conflicts++;
                    processed++; update(); continue;
                }
                // A previously skipped file may have disappeared since preview; re-importing repairs only that hole.
                const partial = path.join(root, partialDirectory, `${digest(`${file.sha256}:${action.target}`)}.part`);
                await download(remote, plan, file, partial, update, signal);
                await assertRoot(root, rootIdentity);
                let created = true;
                try { await publish(partial, target); }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    const current = await existing(root, action.target);
                    if (!current || current.stats.size !== file.size || await hashFile(current.absolute) !== file.sha256) { result.conflicts++; processed++; update(); continue; }
                    result.skipped++; created = false;
                }
                present.set(slot(file), { file, relative: action.target });
                store.saveAsset(work.id, file.role, file.index, action.target, file.sha256);
                const current = await checkedFile(root, action.target);
                const item: IndexedFile = { ...file, relativePath: action.target, stamp: fileStamp(current.stats) };
                localSlots.set(slot(file), [item]);
                if (created) { result.files++; result.bytes += file.size; }
                processed++; update();
            }
            await assertRoot(root, rootIdentity);
            const current = db.prepare('SELECT * FROM aweme WHERE aweme_id=?').get(work.id) as WorkRow | undefined;
            const author = work.authorId ? localAuthors.get(plan.authorMap[work.authorId]!) ?? authors.get(work.authorId) : undefined;
            const primary = [...present.values()].find(p => p.file.role === (work.type === 'gallery' ? 'image' : 'video'));
            const metadata = [...present.values()].find(p => p.file.role === 'metadata');
            const cover = [...present.values()].find(p => p.file.role === 'cover');
            const avatar = [...present.values()].find(p => p.file.role === 'avatar');
            if (!current) {
                const inserted = db.prepare(`INSERT OR IGNORE INTO aweme(aweme_id,aweme_type,title,author_id,author_name,author_sec_uid,create_time,download_time,file_path,image_count,metadata_path,cover_path,avatar_path)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(work.id, work.type, work.title, author?.uid || null, author?.name || null,
                    author?.secUid || null, work.createTime, primary ? Math.floor(Date.now() / 1000) : null,
                    primary?.relative ?? null, work.imageCount, metadata?.relative ?? null, cover?.relative ?? null, avatar?.relative ?? null);
                if (Number(inserted.changes)) result.works++;
            } else {
                for (const [column, found] of Object.entries({ file_path: primary, metadata_path: metadata, cover_path: cover, avatar_path: avatar })) {
                    if (!found) continue;
                    const stored = current[column as keyof WorkRow];
                    let readable = false;
                    if (typeof stored === 'string' && stored) {
                        try { readable = (await existing(root, stored.replace(/\\/g, '/')))?.stats.size! > 0; } catch { readable = true; }
                    }
                    if (!readable) {
                        db.prepare(`UPDATE aweme SET ${column}=? WHERE aweme_id=? AND (${column} IS NULL OR ${column}='' OR ${column}=?)`).run(found.relative, work.id, stored ?? '');
                    }
                }
            }
        }
        const config = readConfigLinks(location.config);
        const canonical = new Set(config.links.map(canonicalLink).filter(Boolean));
        store.syncConfigured([...canonical] as string[]);
        const savedLinks = new Map(store.links().map(l => [l.url, l]));
        const additions: string[] = [];
        for (const link of acceptedLinks) {
            const known = savedLinks.get(link.url);
            if (options.includeLinks !== false && link.enabled && link.status === 'associated' && !canonical.has(link.url) && !known) {
                additions.push(link.url); canonical.add(link.url);
            }
        }
        if (additions.length) {
            // If the user edited links after preview, keep that edit and ask for a fresh preview.
            if (config.revision !== plan.linkRevision) throw new Error('文件已导入，但本地链接已变化；请重新预览后合并链接');
            saveConfigLinks(location.config, [...config.links, ...additions], config.revision);
            result.links = additions.length;
        }
        for (const link of acceptedLinks) store.saveLink({ ...link,
            authorId: link.authorId ? plan.authorMap[link.authorId]! : null, enabled: canonical.has(link.url) });
        store.syncConfigured([...canonical] as string[]);
        await assertRoot(root, rootIdentity);
        progress({ stage: '导入完成', completed: processed, total: plan.manifest.files.length, bytes: result.bytes,
            bytesTotal: result.bytes, skipped: result.skipped, conflicts: result.conflicts });
        return result;
    } finally { store.close(); db.close(); }
}
