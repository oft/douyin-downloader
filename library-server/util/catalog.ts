import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readWorks, resolveMediaPath } from './db.ts';
import type { WorkRow } from './db.ts';
import { readRowsInWorker } from './catalog-reader.ts';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const collator = new Intl.Collator('zh-CN', { numeric: true });
const timeFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' });
const timestampPattern = /^(\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2})(?:_(.*))?$/s;
const assetPattern = /_(result\.json|data\.json|video\.mp4|cover\.(?:jpe?g|png|webp)|avatar\.(?:jpe?g|png|webp)|image_(\d+)\.(?:jpe?g|png|webp)|(\d+)\.(?:jpe?g|png|webp|gif)|music(?:_.*)?\.mp3)$/i;
const looseVideoPattern = /\.(?:mp4|webm|mov|m4v|mkv)$/i;
const key = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

export type Source = 'post' | 'like' | 'mix' | 'music' | 'single' | 'loose';
type Kind = 'video' | 'album' | 'unknown';

interface Location {
    source: Source;
    parts: string[];
    owner?: string;
    loose: boolean;
}

interface Candidate extends Location {
    stem: string;
    files: string[];
    displayPath: string;
    flat?: boolean;
}

interface Asset {
    id: string;
    relativePath: string;
    size: number;
}

interface Copy {
    source: Source;
    path: string;
    localPath: string;
    directory: string;
    flatFiles?: string[];
    video?: string;
    cover?: string;
    avatar?: string;
    images: string[];
    issues: Issue[];
}

export interface Issue {
    id: string;
    code: string;
    detail: string;
    path: string;
    targetId?: string;
    authorId?: string;
    title?: string;
}

export interface Work {
    id: string;
    platformId?: string;
    metadataPath?: string;
    title: string;
    time: string;
    downloadTime: number;
    kind: Kind;
    authorId?: string;
    authorName?: string;
    video?: string;
    cover?: string;
    images: string[];
    sources: Source[];
    copies: WorkCopy[];
    issueCount: number;
    search: string;
}

export interface WorkCopy {
    source: Source;
    path: string;
    localPath: string;
    directory: string;
    flatFiles?: string[];
    issueCount: number;
}

export interface Author {
    id: string;
    name: string;
    aliases: string[];
    avatar?: string;
    workCount: number;
    latest: string;
    downloadTime: number;
    issueCount: number;
    search: string;
    sharedKey?: string;
}

export interface Catalog {
    root: string;
    scannedAt: string;
    authors: Author[];
    authorById: Map<string, Author>;
    works: Work[];
    workById: Map<string, Work>;
    issues: Issue[];
    assets: Map<string, Asset>;
    assetsByPath: Map<string, Asset>;
    copyCount: number;
}

export interface DatabaseCatalog extends Catalog {
    rowsById: Map<string, WorkRow>;
    avatarWorks: Map<string, Work>;
}

function issue(code: string, filePath: string, detail: string): Issue {
    return { id: key(`${code}\0${filePath}`), code, path: filePath, detail };
}

export async function parallelMap<T, R>(items: T[], iterate: (item: T) => Promise<R>): Promise<R[]> {
    const output = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(16, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            output[index] = await iterate(items[index]!);
        }
    });
    await Promise.all(workers);
    return output;
}

function describeWork(row: WorkRow, stem: string) {
    const fallback = timestampPattern.exec(stem);
    const numericTime = typeof row.create_time === 'number' ? new Date(row.create_time * 1000) : undefined;
    const time = (numericTime && Number.isFinite(numericTime.getTime())
        ? timeFormatter.format(numericTime)
        : text(row.create_time) || fallback?.[1] || '').replace(/(\d{2})\.(\d{2})\.(\d{2})$/, '$1:$2:$3');
    const downloadTime = typeof row.download_time === 'number' && Number.isFinite(row.download_time)
        ? Math.max(0, row.download_time) : 0;
    const title = text(row.title) || (fallback ? text(fallback[2]) : stem) || '未命名作品';
    return { platformId: text(row.aweme_id), time, downloadTime, title, authorKey: text(row.author_sec_uid || row.author_id),
        authorName: text(row.author_name), metadataPath: row.metadata_path || undefined };
}

type CatalogEntry = ReturnType<typeof describeWork> & { kind: Kind; copy: Copy; owner?: string };

function describePath(root: string, absolute: string, row: WorkRow) {
    const { dir: directory, base, name } = path.parse(absolute);
    const stem = row.aweme_type === 'gallery' ? name.replace(/_(?:image_)?\d+$/, '') : name.replace(/_video$/, '');
    const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
    const source = (parts.find(part => ['post', 'like', 'mix', 'music'].includes(part)) ?? 'single') as Source;
    return { directory, base, stem, parts, source, displayPath: path.relative(root, absolute).split(path.sep).join('/') };
}

async function inspect(root: string, candidate: Candidate, assets: Map<string, Asset>, row: WorkRow,
    primaryFile?: { name: string; stats: Stats }) {
    const { parts, stem, displayPath } = candidate;
    const issues: Issue[] = [];
    const files = candidate.files.sort(collator.compare).map(name => {
        const suffix = name.startsWith(`${stem}_`) ? assetPattern.exec(name.slice(stem.length)) : null;
        return { name, suffix: suffix?.[1]?.toLowerCase(), index: suffix?.[2] !== undefined ? Number(suffix[2]) : suffix?.[3] !== undefined ? Number(suffix[3]) - 1 : NaN };
    });
    const metadata = files.find(file => ['result.json', 'data.json'].includes(file.suffix ?? ''));

    const videoFile = files.find(file => file.suffix === 'video.mp4') ?? files.find(file => looseVideoPattern.test(file.name));
    const coverFile = files.find(file => /^cover\./.test(file.suffix ?? ''));
    const avatarFile = files.find(file => /^avatar\./.test(file.suffix ?? ''));
    const imageFiles = files.filter(file => Number.isSafeInteger(file.index)).sort((a, b) => a.index - b.index);
    const kind: Kind = row.aweme_type === 'gallery' || imageFiles.length ? 'album' : 'video';

    async function register(file: typeof files[number] | undefined) {
        if (!file) return undefined;
        const relativePath = [...parts, file.name].join('/');
        try {
            const details = primaryFile?.name === file.name ? primaryFile.stats : await stat(path.join(root, ...parts, file.name));
            if (!details.isFile() || !details.size) {
                issues.push(issue('empty_file', relativePath, '文件为空或不是常规文件'));
                return undefined;
            }
            const id = key(relativePath);
            assets.set(id, { id, relativePath, size: details.size });
            return id;
        } catch {
            issues.push(issue('unreadable_file', relativePath, '扫描时无法访问文件'));
            return undefined;
        }
    }

    const [video, cover, avatar, ...imageIds] = await Promise.all([
        register(videoFile), register(coverFile), register(avatarFile), ...imageFiles.map(register),
    ]);
    const images = imageIds.filter((id): id is string => Boolean(id));
    if (kind === 'video' && !videoFile) issues.push(issue('missing_video', displayPath, '作品为视频，但未找到视频文件'));
    if (kind === 'video' && !candidate.loose && !coverFile) issues.push(issue('missing_cover', displayPath, '未找到视频封面，可在详情中播放已有视频'));
    if (kind === 'album') {
        const expected = Math.max(0, row.image_count);
        const available = new Set(imageFiles.filter((_, index) => imageIds[index]).map(file => file.index));
        const missing = Array.from({ length: expected }, (_, index) => index).filter(index => !available.has(index));
        if (!images.length || missing.length) {
            issues.push(issue('incomplete_album', displayPath, expected
                ? `已有 ${images.length} 张可用图片，元数据记录 ${expected} 张${missing.length ? `，缺少第 ${missing.map(index => index + 1).join('、')} 张` : ''}`
                : '未找到可用的图集图片'));
        }
    }
    const firstFile = videoFile ?? imageFiles[0] ?? metadata ?? coverFile ?? avatarFile;
    const localPath = candidate.flat && firstFile ? [...parts, firstFile.name].join('/') : parts.join('/');
    const copy: Copy = { source: candidate.source, path: displayPath, localPath, directory: parts.join('/'),
        flatFiles: candidate.flat ? candidate.files : undefined, video, cover, avatar, images, issues };
    return { ...describeWork(row, stem), kind, copy, owner: candidate.owner };
}

export async function scanCatalog(downloadRoot: string, databaseFile: string): Promise<Catalog> {
    const [root, rows] = await Promise.all([realpath(downloadRoot), readRowsInWorker(databaseFile)]);
    return inspectCatalogRows(root, rows);
}

export function readDatabaseCatalog(root: string, databaseFile: string): DatabaseCatalog {
    const rowsById = new Map<string, WorkRow>();
    const entries: CatalogEntry[] = [];
    for (const row of readWorks(databaseFile)) {
        let absolute: string;
        try { absolute = resolveMediaPath(root, row.file_path, { checkLegacyPath: false }); }
        catch { continue; }
        const { source, parts, stem, displayPath } = describePath(root, absolute, row);
        rowsById.set(row.aweme_id, row);
        entries.push({ ...describeWork(row, stem), kind: row.aweme_type === 'gallery' ? 'album' : 'video',
            copy: { source, path: displayPath, localPath: displayPath, directory: parts.join('/'), images: [], issues: [] } });
    }
    const catalog = assembleCatalog(root, entries, new Map(), []);
    const avatarWorks = new Map<string, Work>();
    for (const work of catalog.works) {
        if (!work.authorId || !work.platformId) continue;
        const representative = avatarWorks.get(work.authorId);
        const representativeRow = representative?.platformId ? rowsById.get(representative.platformId) : undefined;
        if (!representative || (rowsById.get(work.platformId)?.avatar_path && !representativeRow?.avatar_path)) {
            avatarWorks.set(work.authorId, work);
        }
    }
    return { ...catalog, rowsById, avatarWorks };
}

export async function inspectCatalogRows(root: string, rows: WorkRow[], scannedAt?: string): Promise<Catalog> {
    const issues: Issue[] = [];
    const assets = new Map<string, Asset>();

    const directoryFiles = new Map<string, Promise<string[]>>();
    const copies = (await parallelMap(rows, async row => {
        let absolute: string;
        try {
            absolute = resolveMediaPath(root, row.file_path);
        } catch {
            issues.push({ ...issue('invalid_media_path', row.aweme_id, '数据库媒体路径超出下载目录'),
                targetId: key(`work\0${row.aweme_id}`), title: row.title ?? '' });
            return undefined;
        }
        const recordedStats = await stat(absolute).catch(() => undefined);
        if (recordedStats?.isDirectory()) {
            const entries = await readdir(absolute, { withFileTypes: true });
            const matching = entries.filter(entry => entry.isFile() && entry.name.includes(row.aweme_id));
            const primary = matching.find(entry => row.aweme_type === 'gallery'
                ? /_(?:image_)?\d+\.(?:jpe?g|png|webp)$/i.test(entry.name)
                : looseVideoPattern.test(entry.name) && !/_live_\d+\./i.test(entry.name));
            if (!primary) {
                issues.push({ ...issue('missing_media', row.aweme_id, '数据库目录中未找到此作品的媒体'),
                    targetId: key(`work\0${row.aweme_id}`), title: row.title ?? '' });
                return undefined;
            }
            absolute = path.join(absolute, primary.name);
        }
        const { directory, base, stem, parts, source, displayPath } = describePath(root, absolute, row);
        let files: string[];
        try {
            let pending = directoryFiles.get(directory);
            if (!pending) {
                pending = readdir(directory, { withFileTypes: true }).then(entries =>
                    entries.filter(entry => entry.isFile()).map(entry => entry.name));
                directoryFiles.set(directory, pending);
            }
            files = (await pending).filter(file =>
                path.parse(file).name === stem || file.startsWith(`${stem}_`));
        } catch (error) {
            if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            files = [];
        }
        const candidate: Candidate = { source, parts, stem, files, displayPath,
            loose: true, flat: path.basename(directory) !== stem };
        const primaryFile = recordedStats?.isFile() ? { name: base, stats: recordedStats } : undefined;
        return inspect(root, candidate, assets, row, primaryFile);
    })).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
    return assembleCatalog(root, copies, assets, issues, scannedAt);
}

function assembleCatalog(root: string, copies: CatalogEntry[], assets: Map<string, Asset>, issues: Issue[],
    scannedAt = new Date().toISOString()): Catalog {
    const authorDrafts = new Map<string, { sharedKey?: string; name: string; aliases: Set<string>; lastNamed: string; avatar?: string }>();

    function addAuthor(id: string, name: string, sharedKey?: string) {
        let author = authorDrafts.get(id);
        if (!author) {
            author = { name, aliases: new Set(), sharedKey, lastNamed: '' };
            authorDrafts.set(id, author);
        }
        if (name) author.aliases.add(name);
        return author;
    }

    const workGroups = new Map<string, typeof copies>();
    for (const item of copies) {
        const id = key(item.platformId ? `work\0${item.platformId}` : `path\0${item.copy.path}`);
        if (item.authorKey) {
            const authorId = key(`author\0${item.authorKey}`);
            const author = addAuthor(authorId, item.authorName, item.authorKey);
            if (item.authorName && (!author.name || item.time >= author.lastNamed)) {
                author.name = item.authorName;
                author.lastNamed = item.time;
            }
        }
        const list = workGroups.get(id) ?? [];
        list.push(item);
        workGroups.set(id, list);
    }

    const works: Work[] = [];
    for (const [id, list] of workGroups) {
        list.sort((a, b) => Number(Boolean(b.copy.video || b.copy.images.length)) - Number(Boolean(a.copy.video || a.copy.images.length))
            || b.copy.images.length - a.copy.images.length || a.copy.issues.length - b.copy.issues.length
            || Number(b.copy.source === 'post') - Number(a.copy.source === 'post') || collator.compare(a.copy.path, b.copy.path));
        const main = list[0]!;
        const identified = list.find(item => item.authorKey);
        const authorId = identified ? key(`author\0${identified.authorKey}`)
            : list.find(item => item.copy.source === 'post' && item.owner)?.owner;
        const author = authorId ? authorDrafts.get(authorId) : undefined;
        const authorName = author?.name || undefined;
        const cover = list.find(item => item.copy.cover)?.copy.cover;
        const avatar = list.find(item => item.copy.avatar)?.copy.avatar;
        if (author && avatar && !author.avatar) author.avatar = avatar;
        const workIssues = list.flatMap(item => item.copy.issues).map(item => ({ ...item, targetId: id, authorId, title: main.title }));
        issues.push(...workIssues);
        works.push({ id, platformId: main.platformId || undefined, metadataPath: main.metadataPath, title: main.title, time: main.time, kind: main.kind, authorId, authorName,
            downloadTime: list.reduce((latest, item) => Math.max(latest, item.downloadTime), 0),
            video: main.copy.video, cover: cover ?? main.copy.images[0], images: main.copy.images,
            sources: [...new Set(list.map(item => item.copy.source))],
            copies: list.map(({ copy }) => ({ source: copy.source, path: copy.path, localPath: copy.localPath,
                directory: copy.directory, flatFiles: copy.flatFiles, issueCount: copy.issues.length })),
            issueCount: workIssues.length,
            search: [main.title, authorName, ...(author?.aliases ?? []), main.platformId, ...list.map(item => item.copy.path)].join(' ').toLowerCase(),
        });
    }

    works.sort((a, b) => b.time.localeCompare(a.time) || a.id.localeCompare(b.id));
    const authors: Author[] = [...authorDrafts].map(([id, draft]) => {
        const name = draft.name || '未命名作者';
        return { id, name, aliases: [...draft.aliases].filter(alias => alias !== name).sort(collator.compare), avatar: draft.avatar,
            workCount: 0, latest: '', downloadTime: 0, issueCount: 0, search: [name, ...draft.aliases, draft.sharedKey].join(' ').toLowerCase(), sharedKey: draft.sharedKey };
    });
    const authorById = new Map(authors.map(author => [author.id, author]));
    for (const work of works) {
        const author = work.authorId ? authorById.get(work.authorId) : undefined;
        if (author) {
            author.workCount++;
            author.downloadTime = Math.max(author.downloadTime, work.downloadTime);
            if (work.time.localeCompare(author.latest) > 0) author.latest = work.time;
        }
    }
    for (const entry of issues) {
        const author = entry.authorId ? authorById.get(entry.authorId) : undefined;
        if (author) author.issueCount++;
    }
    authors.sort((a, b) => b.downloadTime - a.downloadTime || b.latest.localeCompare(a.latest) ||
        b.workCount - a.workCount || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
    issues.sort((a, b) => collator.compare(a.path, b.path) || a.code.localeCompare(b.code));
    const visibleAuthors = authors.filter(author => author.workCount > 0);
    return { root, scannedAt, authors: visibleAuthors,
        authorById: new Map(visibleAuthors.map(author => [author.id, author])), works,
        workById: new Map(works.map(work => [work.id, work])), issues, assets,
        assetsByPath: new Map([...assets.values()].map(asset => [asset.relativePath, asset])), copyCount: copies.length };
}
