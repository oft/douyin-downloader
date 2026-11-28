import { createHash } from 'node:crypto';
import { open, readdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { profileIdFromLink } from '../../shared/profile-link.ts';
import { readConfigLinks } from './config-links.ts';
import { isoImageType } from './browser-image.ts';
import { digest, hasAuthorName, readTransferWorks, TransferStore } from './transfer-store.ts';
import type { WorkRow } from './db.ts';
import type { FileRole, IndexedFile, IndexedLibrary, LibraryLocation, ProgressReporter, SharedAuthor, SharedLink, SharedWork, TransferSelection } from './transfer-types.ts';

export const fileStamp = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

export function canonicalLink(value: string) {
    const id = profileIdFromLink(value);
    if (id) return `https://www.douyin.com/user/${id}`;
    const candidate = value.match(/https?:\/\/[^\s<>"']+/)?.[0];
    if (!candidate) return undefined;
    try {
        const url = new URL(candidate);
        if (!['www.douyin.com', 'douyin.com', 'v.douyin.com'].includes(url.hostname) || url.username || url.password || url.port) return undefined;
        url.protocol = 'https:'; url.search = ''; url.hash = '';
        return url.toString().replace(/\/$/, '');
    } catch { return undefined; }
}

export function describeTransferFile(relative: string, knownIds?: Set<string>): { workId: string; role: FileRole; index: number } | undefined {
    const name = path.posix.basename(relative);
    const candidates = (value: string) => (value.match(/(?<!\d)\d{1,24}(?!\d)/g) ?? []).filter(id => knownIds?.has(id));
    const names = candidates(name), paths = candidates(relative);
    const known = (names.length ? names : paths).map((id, index) => ({ id, index })).sort((a, b) => b.id.length - a.id.length || b.index - a.index)[0]?.id;
    const local = /(?<![A-Za-z0-9])local-[a-f0-9]{32}(?![a-f0-9])/.exec(relative)?.[0];
    const ids = local ? [local] : known ? [known] : relative.match(/(?<!\d)\d{15,24}(?!\d)/g);
    if (!ids?.length) return undefined;
    let role: FileRole;
    let index = 0;
    if (/_avatar\.[^.]+$/i.test(name)) role = 'avatar';
    else if (/_cover\.[^.]+$/i.test(name)) role = 'cover';
    else if (/_(?:data|result)\.json$/i.test(name)) role = 'metadata';
    else if (/\.(mp4|m4v|mov|mkv|webm)$/i.test(name)) role = 'video';
    else if (/\.(mp3|m4a|flac|wav|ogg)$/i.test(name)) role = 'music';
    else if (/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(name)) {
        role = 'image';
        const numbered = /_(?:image_)?(\d+)\.[^.]+$/i.exec(name);
        index = numbered ? Math.max(0, Number(numbered[1]) - 1) : 0;
    } else return undefined;
    return { workId: ids[ids.length - 1]!, role, index };
}

export async function checkedFile(root: string, relative: string) {
    const parts = relative.split('/');
    if (!relative || parts.some(p => !p || p === '.' || p === '..' || /[\\:\0-\x1f]/.test(p))) throw new Error('媒体路径无效');
    const absolute = path.join(root, ...parts);
    const resolved = await realpath(absolute);
    const inside = path.relative(root, resolved);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside) || resolved !== absolute) throw new Error('媒体路径被重定向');
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('不是常规媒体文件');
    return { absolute, stats };
}

export async function fingerprint(root: string, file: Pick<IndexedFile, 'relativePath' | 'stamp'>, store: TransferStore) {
    const { absolute, stats } = await checkedFile(root, file.relativePath);
    if (fileStamp(stats) !== file.stamp) throw new Error('源文件已变化，请重新生成分享或导入预览');
    const cached = store.fingerprint(file.relativePath, file.stamp);
    if (cached) return cached;
    const handle = await open(absolute, 'r');
    try {
        if (fileStamp(await handle.stat()) !== file.stamp) throw new Error('源文件已变化');
        const header = Buffer.alloc(64);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        const bytes = header.subarray(0, bytesRead);
        const extension = path.extname(file.relativePath).toLowerCase();
        let mime = isoImageType(bytes) ?? ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
            '.gif': 'image/gif', '.heic': 'image/heic', '.heif': 'image/heic', '.avif': 'image/avif',
            '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
            '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.json': 'application/json' } as Record<string, string>)[extension] ?? 'application/octet-stream';
        if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
        const hash = createHash('sha256');
        // A positional header read must not affect the complete content hash.
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
        if (fileStamp(await handle.stat()) !== file.stamp) throw new Error('源文件在校验时变化');
        const sha256 = hash.digest('hex');
        store.saveFingerprint(file.relativePath, file.stamp, sha256, mime);
        return { sha256, mime };
    } finally { await handle.close(); }
}

export async function walkMedia(root: string, visit: (relative: string, stats: Stats) => Promise<void>, signal?: AbortSignal) {
    async function walk(directory: string) {
        signal?.throwIfAborted();
        for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
            const relative = directory ? `${directory}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(relative);
            else if (entry.isFile()) {
                const stats = await lstat(path.join(root, ...relative.split('/')));
                if (stats.isFile() && !stats.isSymbolicLink() && stats.size > 0) await visit(relative, stats);
            }
        }
    }
    await walk('');
}

export async function readHistoricalWorks(location: LibraryLocation) {
    const output: WorkRow[] = [];
    const directory = await realpath(path.join(path.dirname(location.database), 'cleanup-backups')).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return '';
    });
    if (!directory) return output;
    for (const child of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        const file = path.join(directory, child.name, 'dy_downloader.before.db');
        try {
            // These are backups of the current schema, never the unrelated Release/data.db.
            const actual = await realpath(file);
            if (actual !== file) continue;
            output.push(...readTransferWorks(file));
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return output;
}

export async function indexLibrary(location: LibraryLocation, options: TransferSelection & { hash?: boolean } = {},
    progress: ProgressReporter = () => {}, signal?: AbortSignal): Promise<IndexedLibrary> {
    const root = await realpath(location.root);
    const store = new TransferStore(location.database);
    try {
        const instanceId = store.instanceId();
        const current = readTransferWorks(location.database);
        const rows = new Map<string, WorkRow>();
        for (const row of current) rows.set(row.aweme_id, row);
        if (options.includeHistory) for (const row of await readHistoricalWorks(location)) if (!rows.has(row.aweme_id)) rows.set(row.aweme_id, row);
        const authors: SharedAuthor[] = [];
        const identities = new Map<string, SharedAuthor>();
        const authorFor = (uid: string, secUid: string, name: string, fallback?: string) => {
            const keys = [uid && `uid:${uid}`, secUid && `sec:${secUid}`].filter(Boolean) as string[];
            if (!keys.length && !fallback) return undefined;
            let author = keys.map(k => identities.get(k)).find(Boolean) ?? identities.get(`stored:${fallback}`);
            if (!author) {
                author = { id: fallback ?? `douyin:${keys[0]}`, uid, secUid, name: hasAuthorName(name) ? name : '未命名作者', aliases: [] };
                authors.push(author);
            }
            if (!author.uid && uid) author.uid = uid;
            if (!author.secUid && secUid) author.secUid = secUid;
            if (hasAuthorName(name) && !author.aliases.includes(name)) author.aliases.push(name);
            for (const key of keys) identities.set(key, author);
            if (fallback) identities.set(`stored:${fallback}`, author);
            return author;
        };
        const workAuthors = new Map<string, SharedAuthor>();
        for (const author of store.authors()) {
            const found = authorFor(author.uid, author.secUid, author.name, author.id);
            if (found) for (const alias of author.aliases) if (hasAuthorName(alias) && !found.aliases.includes(alias)) found.aliases.push(alias);
        }
        const namedFromRows = new Set<string>();
        for (const row of [...rows.values()].sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0))) {
            const author = authorFor(row.author_id ?? '', row.author_sec_uid ?? '', row.author_name ?? '');
            if (author) {
                if (hasAuthorName(row.author_name ?? '') && !namedFromRows.has(author.id)) { author.name = row.author_name!; namedFromRows.add(author.id); }
                workAuthors.set(row.aweme_id, author);
            }
        }
        const configured = readConfigLinks(location.config).links.map(canonicalLink).filter((x): x is string => Boolean(x));
        store.syncConfigured(configured);
        const links = new Map<string, SharedLink>();
        for (const link of store.links()) {
            if (link.removed) continue;
            const normalized = canonicalLink(link.url);
            if (!normalized) continue;
            const secUid = profileIdFromLink(normalized);
            const author = authors.find(a => a.id === link.authorId) ?? (secUid ? authorFor('', secUid, '') : undefined);
            links.set(normalized, { url: normalized, authorId: author?.id ?? null, status: author ? 'associated' : 'unresolved', enabled: configured.includes(normalized) });
        }
        for (const url of configured) {
            const secUid = profileIdFromLink(url);
            const author = authors.find(a => a.id === links.get(url)?.authorId) ?? (secUid ? authorFor('', secUid, '') : undefined);
            const link: SharedLink = { url, authorId: author?.id ?? null, status: author ? 'associated' : 'unresolved', enabled: true };
            links.set(url, link); store.saveLink(link);
        }
        for (const author of authors) store.saveAuthor(author);
        const selectedAuthors = options.authorIds?.length ? new Set(options.authorIds) : undefined;
        const selectedWorks = options.workIds?.length ? new Set(options.workIds) : undefined;
        const chosenAuthor = (author: SharedAuthor) => !selectedAuthors || selectedAuthors.has(author.id)
            || selectedAuthors.has(digest(`author\0${author.secUid || author.uid || author.id}`).slice(0, 24));
        const files: IndexedFile[] = [];
        let unassignedFiles = 0, inspected = 0, bytes = 0;
        const unassigned: { path: string; size: number }[] = [];
        const registered = new Map(store.assets().map(a => [a.relative_path, a]));
        const knownWorkIds = new Set(rows.keys());
        progress({ stage: '索引作者和作品', completed: 0, total: 0, bytes: 0, bytesTotal: 0 });
        await walkMedia(root, async (relative, stats) => {
            signal?.throwIfAborted();
            const known = registered.get(relative);
            const description = known ? { workId: known.work_id, role: known.role as FileRole, index: known.position } : describeTransferFile(relative, knownWorkIds);
            if (description && !rows.has(description.workId) && options.hash === false) {
                rows.set(description.workId, { aweme_id: description.workId, aweme_type: description.role === 'image' ? 'gallery' : 'video',
                    title: '', author_id: null, author_name: null, author_sec_uid: null, create_time: null, download_time: null,
                    file_path: '', image_count: 0, metadata_path: null, cover_path: null, avatar_path: null });
                knownWorkIds.add(description.workId);
            }
            if (!description || !rows.has(description.workId)) {
                if (/\.(mp4|mkv|webm|mov|m4v|mp3|jpe?g|png|webp|heic|heif|avif)$/i.test(relative)) {
                    unassignedFiles++;
                    if (unassigned.length < 100) unassigned.push({ path: relative, size: stats.size });
                }
                return;
            }
            const author = workAuthors.get(description.workId);
            if (selectedWorks && !selectedWorks.has(description.workId) || selectedAuthors && (!author || !chosenAuthor(author))) return;
            const file: IndexedFile = { id: digest(relative), ...description, relativePath: relative,
                name: path.posix.basename(relative), size: stats.size, stamp: fileStamp(stats), sha256: '', mime: '' };
            if (options.hash !== false) Object.assign(file, await fingerprint(root, file, store));
            files.push(file); bytes += stats.size; inspected++;
            if (inspected % 100 === 0) progress({ stage: options.hash === false ? '检查本地文件' : '校验分享文件', completed: inspected, total: 0, bytes, bytesTotal: 0 });
        }, signal);
        // Prefer the copy referenced by the active database, preserving all other copies in the manifest.
        files.sort((a, b) => Number(b.relativePath === rows.get(b.workId)?.file_path?.replace(/\\/g, '/')) - Number(a.relativePath === rows.get(a.workId)?.file_path?.replace(/\\/g, '/')) || a.relativePath.localeCompare(b.relativePath));
        const byWork = new Map<string, IndexedFile[]>();
        for (const file of files) { const list = byWork.get(file.workId) ?? []; list.push(file); byWork.set(file.workId, list); }
        const works: SharedWork[] = [];
        // A historical work remains a work when its media is no longer present.
        for (const [id, row] of rows) {
            const author = workAuthors.get(id);
            if (selectedWorks && !selectedWorks.has(id) || selectedAuthors && (!author || !chosenAuthor(author))) continue;
            const assets = byWork.get(id) ?? [];
            works.push({ id, authorId: workAuthors.get(id)?.id ?? null, type: row.aweme_type === 'gallery' ? 'gallery' : 'video',
                title: row.title ?? '', createTime: row.create_time, imageCount: row.image_count ?? 0, files: assets.map(f => f.id) });
        }
        const authorIds = new Set(works.map(w => w.authorId));
        const publishedAuthors = authors.filter(a => !selectedAuthors && !selectedWorks || authorIds.has(a.id) || selectedAuthors && chosenAuthor(a));
        const allowed = new Set(publishedAuthors.map(a => a.id));
        const publishedLinks = [...links.values()].filter(l => !selectedAuthors && !selectedWorks || l.authorId && allowed.has(l.authorId));
        const publicFiles = files.map(({ relativePath, stamp, ...file }) => file);
        const contents = { authors: publishedAuthors, links: publishedLinks, works, files: publicFiles };
        unassigned.sort((a, b) => a.path.localeCompare(b.path));
        const snapshotId = digest(JSON.stringify({ ...contents, unassignedFiles, unassigned }));
        const manifest = { version: 1 as const, instanceId, snapshotId, createdAt: new Date().toISOString(), ...contents, unassignedFiles, unassigned };
        progress({ stage: '索引完成', completed: files.length, total: files.length, bytes, bytesTotal: bytes });
        return { manifest, files };
    } finally { store.close(); }
}
