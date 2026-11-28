import './util/io-audit-bootstrap.ts';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { profileIdFromLink } from '../shared/profile-link.ts';
import type { Context, MiddlewareHandler } from 'hono';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { projectRoot } from './util/project-paths.ts';
import { readLibraryConfig } from './util/config.ts';
import { LinkConfigError, readConfigLinks, saveConfigLinks } from './util/config-links.ts';
import { inspectCatalogRows, scanCatalog } from './util/catalog.ts';
import { CatalogReader } from './util/catalog-reader.ts';
import { authorWorkIds, reconcileDeletedWorks, resetDownloadedWorks, resolveMediaPath } from './util/db.ts';
import type { Catalog, DatabaseCatalog, Source, Work } from './util/catalog.ts';
import { ReviewStore } from './util/reviews.ts';
import type { ReviewStatus } from './util/reviews.ts';
import { deletePermanently, removalPlan } from './util/library-files.ts';
import type { RemovalKind } from './util/library-files.ts';
import { UpdateJob } from './util/update-job.ts';
import { LinkCheckJob } from './util/link-check-job.ts';
import { createAdminPythonBridge } from './util/python.ts';
import { createHeifPreview, isoImageType } from './util/browser-image.ts';
import { mountTransferRoutes } from './util/transfer-routes.ts';
import { withRegisteredAuthors, forgetRegisteredAuthors } from './util/transfer-authors.ts';
import { transferStoreFile } from './util/transfer-store.ts';
import { mountMaintenanceRoutes } from './util/maintenance-routes.ts';
import { isLibraryRequest } from './util/request-origin.ts';
import { mountAdminWeb } from './util/admin-web.ts';

const configFile = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(projectRoot, 'config.yml');
const { downloadRoot, databaseFile } = readLibraryConfig(configFile);
const python = createAdminPythonBridge();
const heifPreview = createHeifPreview(python.findFfmpeg, projectRoot);
const updateJob = new UpdateJob(...python.updateLibrary(configFile, downloadRoot, databaseFile),
    undefined, path.join(path.dirname(databaseFile), 'library-update-status.json'));
const reviewFile = process.env.CATALOG_REVIEW_FILE ? path.resolve(process.env.CATALOG_REVIEW_FILE) : `${databaseFile}.reviews.json`;
const linkCheckJob = new LinkCheckJob(...python.checkLinks(configFile));
const loginBrowser = new UpdateJob(...python.openLogin(configFile));
const reviewStatuses = ['pending', 'resolved', 'ignored'] as const;
const sources: Source[] = ['post', 'like', 'mix', 'music', 'single', 'loose'];
const mediaTypes: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heic', '.avif': 'image/avif' };

let catalog: Catalog | undefined;
let scan: Promise<void> | undefined;
let scanError: string | undefined;
let reviews: ReviewStore | undefined;
let removing = false;
const catalogReader = new CatalogReader();
let databaseView: { stamp: string; snapshot: DatabaseCatalog } | undefined;
let databaseRead: Promise<DatabaseCatalog> | undefined;
const mediaPaths = new Map<string, { root: string; relativePath: string }>();

async function fileStamp(file: string, optional = false) {
    try {
        const info = await stat(file, { bigint: true });
        // A read-only SQLite connection can create an empty WAL without changing any records.
        if (optional && info.size === 0n) return '';
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs ?? info.mtimeMs}:${info.ctimeNs ?? info.ctimeMs}`;
    } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}

async function loadDatabaseCatalog() {
    const [databaseStamp, walStamp, root, authorStamp, authorWalStamp] = await Promise.all([
        fileStamp(databaseFile), fileStamp(`${databaseFile}-wal`, true), realpath(downloadRoot).catch(() => downloadRoot),
        fileStamp(transferStoreFile(databaseFile), true), fileStamp(`${transferStoreFile(databaseFile)}-wal`, true),
    ]);
    const stamp = `${databaseStamp}|${walStamp}|${root}|${authorStamp}|${authorWalStamp}`;
    if (databaseView?.stamp === stamp) return databaseView.snapshot;
    if (!databaseRead) {
        databaseRead = catalogReader.read(root, databaseFile).then(original => {
            const snapshot = withRegisteredAuthors(original, databaseFile);
            if (databaseView && databaseView.snapshot.root !== root) mediaPaths.clear();
            databaseView = { stamp, snapshot };
            return snapshot;
        }).finally(() => { databaseRead = undefined; });
    }
    return databaseRead;
}

function databaseError(error: unknown) {
    return `无法读取作品数据库（${(error as NodeJS.ErrnoException).code ?? '读取失败'}）`;
}

async function inspectWorks(snapshot: DatabaseCatalog, works: Work[]) {
    const rows = works.flatMap(work => {
        const row = work.platformId && snapshot.rowsById.get(work.platformId);
        return row ? [row] : [];
    });
    const inspected = await inspectCatalogRows(snapshot.root, rows, snapshot.scannedAt);
    if (databaseView?.snapshot === snapshot) {
        for (const { id, relativePath } of inspected.assets.values()) mediaPaths.set(id, { root: inspected.root, relativePath });
    }
    return inspected;
}

function startScan() {
    if (scan || removing) return;
    scanError = undefined;
    scan = scanCatalog(downloadRoot, databaseFile).then(result => { catalog = result; }).catch(error => {
        scanError = `无法建立资料库索引（${(error as NodeJS.ErrnoException).code ?? '扫描失败'}）`;
        console.error(scanError, error);
    }).finally(() => { scan = undefined; });
}

function reviewStore() {
    return reviews ??= new ReviewStore(reviewFile);
}

function status(database?: DatabaseCatalog, readError?: string) {
    const rows = catalog ? reviewStore().list(catalog.issues) : [];
    return {
        root: downloadRoot, database: databaseFile, scannedAt: catalog?.scannedAt, scanning: Boolean(scan), error: scanError,
        authors: database?.authors.length, works: database?.works.length, copies: database?.copyCount, databaseError: readError,
        pending: rows.filter(issue => issue.present && issue.status === 'pending').length,
    };
}

async function currentStatus() {
    let database;
    try { database = await loadDatabaseCatalog(); }
    catch (error) { return status(undefined, databaseError(error)); }
    return status(database);
}

async function browseDatabase(c: Context, select: (snapshot: DatabaseCatalog) => Response | Promise<Response>) {
    let database;
    try { database = await loadDatabaseCatalog(); }
    catch (error) { return c.json({ error: databaseError(error) }, 503); }
    return select(database);
}

function browseIssues(c: Context, select: (snapshot: Catalog) => Response | Promise<Response>) {
    if (catalog) return select(catalog);
    return c.json({ error: scanError ?? '尚未扫描，请点击“扫描媒体异常”开始检查' }, 503);
}

async function paginate<T, U>(c: Context, rows: T[], transform: (page: T[]) => U[] | Promise<U[]>, extra = {}) {
    const rawPage = c.req.query('page') ?? '1';
    const rawSize = c.req.query('size') ?? '24';
    const page = Number(rawPage);
    const size = Number(rawSize);
    if (!/^\d+$/.test(rawPage) || !/^\d+$/.test(rawSize) || !Number.isSafeInteger(page) || page < 1 || size < 1 || size > 100) {
        return c.json({ error: '分页参数无效' }, 400);
    }
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const current = Math.min(page, pages);
    return c.json({ items: await transform(rows.slice((current - 1) * size, current * size)), page: current, pages, total: rows.length, ...extra });
}

function getQuery(c: Context) {
    return (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 200);
}

function publicAuthor({ search, sharedKey, downloadTime, ...author }: Catalog['authors'][number]) { return author; }
function publicWork({ search, copies, metadataPath, downloadTime, ...work }: Catalog['works'][number]) { return work; }

async function streamAsset(c: Context, root: string, relativePath: string) {
    const requested = path.join(root, ...relativePath.split('/'));
    let contentType = mediaTypes[path.extname(relativePath).toLowerCase()] ?? 'application/octet-stream';
    let preview: Buffer | undefined;
    let handle;
    let size;
    let etag = '';
    let modified = '';
    try {
        const resolved = await realpath(requested);
        const inside = path.relative(root, resolved);
        if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return c.notFound();
        handle = await open(resolved, 'r');
        const details = await handle.stat();
        if (!details.isFile() || !details.size) {
            await handle.close();
            return c.notFound();
        }
        size = details.size;
        etag = `W/"${details.size}-${details.mtimeMs}-${details.ctimeMs}-preview1"`;
        modified = details.mtime.toUTCString();
        // Validate before reading image headers or generating a HEIF preview.
        const condition = c.req.header('If-None-Match');
        if (condition && (condition.trim() === '*' || condition.split(',').some(value => value.trim().replace(/^W\//, '') === etag.replace(/^W\//, '')))) {
            await handle.close();
            return new Response(null, { status: 304, headers: { ETag: etag, 'Last-Modified': modified, 'Cache-Control': 'private, no-cache' } });
        }
        if (contentType.startsWith('image/')) {
            const header = Buffer.alloc(64);
            const { bytesRead } = await handle.read(header, 0, header.length, 0);
            contentType = isoImageType(header.subarray(0, bytesRead)) ?? contentType;
            if (contentType === 'image/heic') {
                preview = await heifPreview(resolved);
                if (preview) {
                    contentType = 'image/jpeg';
                    size = preview.length;
                }
            }
        }
    } catch {
        await handle?.close();
        return c.notFound();
    }

    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Content-Type': contentType,
        'Cache-Control': 'private, no-cache', ETag: etag, 'Last-Modified': modified, 'X-Content-Type-Options': 'nosniff' });
    let start = 0;
    let end = size - 1;
    const ifRange = c.req.header('If-Range');
    // A weak ETag cannot satisfy If-Range. A mismatched validator requires the full body.
    const range = !ifRange || ifRange === modified ? c.req.header('Range') : undefined;
    if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match?.[1]) {
            start = Number(match[1]);
            if (match[2]) end = Math.min(end, Number(match[2]));
        } else if (match?.[2]) {
            start = Math.max(0, size - Number(match[2]));
        }
        if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end) {
            await handle.close();
            headers.set('Content-Range', `bytes */${size}`);
            return new Response(null, { status: 416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    if (c.req.method === 'HEAD') {
        await handle.close();
        return new Response(null, { status: range ? 206 : 200, headers });
    }
    if (preview) {
        await handle.close();
        return new Response(Uint8Array.from(preview.subarray(start, end + 1)), { status: range ? 206 : 200, headers });
    }
    const stream = Readable.toWeb(handle.createReadStream({ start, end }));
    return new Response(stream as unknown as BodyInit, { status: range ? 206 : 200, headers });
}

const app = new Hono({ strict: false });
let maintenance: ReturnType<typeof mountMaintenanceRoutes>;
const transfer = mountTransferRoutes(app, { root: downloadRoot, database: databaseFile, config: configFile }, {
    busy: () => updateJob.active || removing || Boolean(scan) || Boolean(maintenance?.changing),
    onImported: () => { databaseView = undefined; catalog = undefined; scanError = undefined; },
});
maintenance = mountMaintenanceRoutes(app, { root: downloadRoot, database: databaseFile, config: configFile }, {
    busy: () => transfer.importActive || updateJob.active || linkCheckJob.active || removing || Boolean(scan),
    onChanged: () => { databaseView = undefined; },
    updateStatus: () => updateJob.status,
});
app.use('/api/catalog/*', async (c, next) => {
    if (maintenance.changing && c.req.method !== 'GET' && !c.req.path.startsWith('/api/catalog/maintenance/')) return c.json({ error: '正在清理异常，请稍后再修改资料库' }, 409);
    if (transfer.importActive && c.req.method !== 'GET' && !c.req.path.startsWith('/api/catalog/transfer/')) {
        return c.json({ error: '正在导入资料，其他修改操作请稍后再试；浏览不受影响' }, 409);
    }
    await next();
});
app.use('/api/catalog/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
});

function isLocalRequest(c: Context) {
    return isLibraryRequest(c.req.url, c.req.header('Origin'));
}

function linkConfigFailure(c: Context, error: unknown, message: string) {
    return error instanceof LinkConfigError ? c.json({ error: error.message }, error.status) : c.json({ error: message }, 500);
}

const requireLocalLinks: MiddlewareHandler = async (c, next) => {
    if (!isLocalRequest(c)) return c.json({ error: '链接管理仅支持本机或已配置域名的同源请求' }, 403);
    await next();
};

app.use('/api/catalog/links', requireLocalLinks);
app.use('/api/catalog/authors/:id/links', requireLocalLinks);
app.use('/api/catalog/link-check', requireLocalLinks);
app.use('/api/catalog/link-check/*', requireLocalLinks);

app.get('/api/catalog/link-check', c => c.json(linkCheckJob.status));
app.post('/api/catalog/link-check/start', async c => {
    if (loginBrowser.active) return c.json({ error: '请先关闭手动登录测试窗口，再开始链接检测；登录状态会自动保存。' }, 409);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.links) || !body.links.length || body.links.length > 1000
        || !body.links.every((link: unknown) => typeof link === 'string' && Boolean(link.trim()) && link.length <= 4096)
        || (body.showBrowser !== undefined && typeof body.showBrowser !== 'boolean')) {
        return c.json({ error: '请提交 1–1000 条非空链接，每条不超过 4096 字符' }, 400);
    }
    if (updateJob.active) return c.json({ error: '下载更新正在运行，请先停止更新或等待结束后再检测' }, 409);
    return c.json(linkCheckJob.start(body.links, body.showBrowser === true), 202);
});
app.post('/api/catalog/link-check/stop', c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    return c.json(linkCheckJob.stop(), 202);
});

app.get('/api/catalog/link-authors', c => {
    if (!isLocalRequest(c)) return c.json({ error: '链接管理仅支持本机或已配置域名的同源请求' }, 403);
    return browseDatabase(c, snapshot => c.json({ authors: Object.fromEntries(snapshot.authors
        .filter(author => author.sharedKey).map(author => [author.sharedKey!, { id: author.id, name: author.name }])) }));
});

app.get('/api/catalog/links', c => {
    try { return c.json(readConfigLinks(configFile)); }
    catch (error) { return linkConfigFailure(c, error, '无法读取下载器配置'); }
});

app.put('/api/catalog/links', async c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision) ||
        !Array.isArray(body.links) || !body.links.every((link: unknown) => typeof link === 'string' && Boolean(link.trim()))) {
        return c.json({ error: '每条链接都应填写非空文本' }, 400);
    }
    if (removing) return c.json({ error: '正在删除文件，请稍后再保存链接' }, 409);
    try { return c.json(saveConfigLinks(configFile, body.links, body.revision)); }
    catch (error) { return linkConfigFailure(c, error, '无法保存下载器配置，请检查文件权限'); }
});

app.get('/api/catalog/status', async c => c.json(await currentStatus()));

app.use('/api/catalog/update/*', async (c, next) => {
    if (!isLocalRequest(c)) return c.json({ error: '下载更新仅支持本机或已配置域名的同源请求' }, 403);
    if (c.req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) {
        return c.json({ error: '需要 JSON 请求' }, 415);
    }
    await next();
});

app.get('/api/catalog/update', c => c.json(updateJob.status));
app.post('/api/catalog/update/start', c => {
    if (loginBrowser.active) return c.json({ error: '请先关闭手动登录测试窗口，再启动更新；登录状态会自动保存。' }, 409);
    if (updateJob.active) return c.json(updateJob.status, 202);
    if (linkCheckJob.active) return c.json({ error: '正在检测链接，请先停止检测或等待结束后再启动更新' }, 409);
    if (removing) return c.json({ error: '正在删除文件，请稍后再启动更新' }, 409);
    try {
        if (!readConfigLinks(configFile).links.some(link => link.trim())) {
            return c.json({ error: '请先在链接管理中添加链接并保存配置' }, 422);
        }
    } catch (error) { return linkConfigFailure(c, error, '无法读取下载器配置'); }
    return c.json(updateJob.start(), 202);
});

app.get('/api/catalog/browser', c => {
    if (!isLocalRequest(c)) return c.json({ error: '浏览器功能仅支持本机或已配置域名的同源请求' }, 403);
    return c.json(loginBrowser.status);
});
app.post('/api/catalog/browser/open', c => {
    if (!isLocalRequest(c)) return c.json({ error: '浏览器功能仅支持本机或已配置域名的同源请求' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    if (updateJob.active || linkCheckJob.active) return c.json({ error: '更新或检测正在使用浏览器，请使用当前窗口，或停止任务后再打开测试窗口。' }, 409);
    if (loginBrowser.active) loginBrowser.send({ action: 'focus' });
    else loginBrowser.start();
    return c.json(loginBrowser.status, 202);
});
app.post('/api/catalog/update/stop', c => c.json(updateJob.stop(), 202));

app.post('/api/catalog/scan', async c => {
    if (!isLocalRequest(c)) return c.json({ error: '媒体扫描仅支持本机或已配置域名的同源请求' }, 403);
    if (updateJob.active) return c.json({ error: '正在下载更新，请结束后再扫描媒体' }, 409);
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: '需要 JSON 请求' }, 415);
    if (removing) return c.json({ error: '正在删除文件，请稍后再扫描' }, 409);
    startScan();
    return c.json(await currentStatus(), 202);
});

async function authorsWithMedia(snapshot: DatabaseCatalog, authors: Catalog['authors']) {
    const auditCatalog = catalog?.root === snapshot.root ? catalog : undefined;
    const missingAvatars = authors.flatMap(author => {
        const work = snapshot.avatarWorks.get(author.id);
        return work && !auditCatalog?.authorById.get(author.id)?.avatar ? [work] : [];
    });
    const local = await inspectWorks(snapshot, missingAvatars);
    return authors.map(author => {
        const audit = auditCatalog?.authorById.get(author.id);
        const asset = audit?.avatar && auditCatalog?.assets.get(audit.avatar);
        if (asset) {
            mediaPaths.set(asset.id, { root: snapshot.root, relativePath: asset.relativePath });
        }
        return { ...publicAuthor(author), avatar: audit?.avatar ?? local.authorById.get(author.id)?.avatar,
            issueCount: audit?.issueCount ?? 0 };
    });
}

function withWorkMedia(work: Work, local: Catalog) {
    const inspected = local.workById.get(work.id);
    return inspected ? { ...inspected, authorName: work.authorName }
        : { ...work, issueCount: local.issues.filter(issue => issue.targetId === work.id).length };
}

app.get('/api/catalog/authors', c => browseDatabase(c, snapshot => {
    const q = getQuery(c);
    const authors = snapshot.authors.filter(author => !q || author.search.includes(q));
    return paginate(c, authors, page => authorsWithMedia(snapshot, page));
}));

app.get('/api/catalog/authors/:id', c => browseDatabase(c, async snapshot => {
    const author = snapshot.authorById.get(c.req.param('id'));
    return author ? c.json((await authorsWithMedia(snapshot, [author]))[0]) : c.json({ error: '数据库中没有此作者' }, 404);
}));

function planAuthorLinks(authorKeys: (string | undefined)[]) {
    const config = readConfigLinks(configFile);
    const keys = new Set(authorKeys.filter(Boolean));
    const matches: string[] = [];
    const remaining: string[] = [];
    for (const link of config.links) {
        const list = keys.has(profileIdFromLink(link)) ? matches : remaining;
        list.push(link);
    }
    return { config, matches, remaining };
}

app.get('/api/catalog/authors/:id/links', c => browseDatabase(c, snapshot => {
    const author = snapshot.authorById.get(c.req.param('id'));
    if (!author) return c.json({ error: '数据库中没有此作者' }, 404);
    try {
        const { config, matches } = planAuthorLinks([author.sharedKey]);
        return c.json({ name: author.name, links: matches, revision: config.revision });
    } catch (error) { return linkConfigFailure(c, error, '无法读取下载器配置'); }
}));

app.delete('/api/catalog/authors/:id/links', async c => {
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)) {
        return c.json({ error: '请重新读取并确认要删除的链接' }, 400);
    }
    return browseDatabase(c, snapshot => {
        if (removing) return c.json({ error: '正在删除文件，请稍后再保存链接' }, 409);
        const author = snapshot.authorById.get(c.req.param('id'));
        if (!author) return c.json({ error: '数据库中没有此作者' }, 404);
        try {
            const { matches, remaining } = planAuthorLinks([author.sharedKey]);
            saveConfigLinks(configFile, remaining, body.revision);
            return c.json({ removedLinks: matches.length });
        } catch (error) { return linkConfigFailure(c, error, '无法保存下载器配置，请检查文件权限'); }
    });
});

app.get('/api/catalog/works', c => browseDatabase(c, snapshot => {
    const q = getQuery(c);
    const { author, kind, source } = c.req.query();
    if ((kind && !['video', 'album', 'unknown'].includes(kind)) || (source && !sources.includes(source as Source))) {
        return c.json({ error: '作品筛选参数无效' }, 400);
    }
    const candidates = author ? snapshot.worksByAuthor.get(author) ?? [] : snapshot.works;
    const works = candidates.filter(work => (!kind || work.kind === kind) &&
        (!source || work.sources.includes(source as Source)) && (!q || work.search.includes(q)));
    // Recommendation startup needs pagination totals, without touching discarded media files.
    if (c.req.query('summary') === '1') return paginate(c, works, () => []);
    return paginate(c, works, async page => {
        const local = await inspectWorks(snapshot, page);
        return page.map(work => publicWork(withWorkMedia(work, local)));
    });
}));

async function readWorkMetadata(snapshot: Catalog, work: Work) {
    if (!work.metadataPath) return {};
    try {
        const file = await realpath(resolveMediaPath(snapshot.root, work.metadataPath));
        resolveMediaPath(snapshot.root, file);
        return { metadata: JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as unknown };
    } catch {
        return { metadataError: '作品 JSON 文件缺失或无法解析' };
    }
}

app.get('/api/catalog/works/:id', c => browseDatabase(c, async snapshot => {
    const summary = snapshot.workById.get(c.req.param('id'));
    if (!summary) return c.json({ error: '数据库中没有此作品' }, 404);
    const work = withWorkMedia(summary, await inspectWorks(snapshot, [summary]));
    return c.json({ ...publicWork(work), ...await readWorkMetadata(snapshot, work),
        copies: work.copies.map(({ flatFiles, ...copy }) => copy) });
}));

async function planRemoval(snapshot: DatabaseCatalog, kind: RemovalKind, ids: string[], authorId?: string, clearWorks = false) {
    if (kind === 'authors' && ids.some(id => !snapshot.authorById.has(id))) return undefined;
    const selected = new Set(ids);
    const isSelected = (work: Work) => selected.has((kind === 'authors' ? work.authorId : work.id) ?? '');
    const works = snapshot.works.filter(isSelected);
    if (authorId && works.some(work => work.authorId !== authorId)) return undefined;
    const local = await inspectWorks(snapshot, works);
    if (kind === 'authors') for (const id of ids) local.authorById.set(id, snapshot.authorById.get(id)!);
    // Missing local media still belongs to the confirmed database deletion scope.
    for (const item of works) {
        if (!local.workById.has(item.id)) {
            const missing = { ...item, copies: [] };
            local.works.push(missing);
            local.workById.set(item.id, missing);
        }
    }
    const rootName = path.basename(snapshot.root).toLowerCase();
    const protectedPaths = snapshot.works.filter(item => !isSelected(item)).flatMap(item => item.copies.flatMap(copy => {
        const parts = copy.path.split('/');
        const legacy = parts.length > 1 && parts[0]?.toLowerCase() === rootName;
        return legacy ? [copy.path, parts.slice(1).join('/')] : [copy.path];
    }));
    const plan = await removalPlan(local, kind, ids, protectedPaths);
    if (!plan) return undefined;
    const clearIds = clearWorks ? authorWorkIds(databaseFile, snapshot.authorById.get(ids[0]!)?.sharedKey,
        local.works.flatMap(work => work.platformId ? [work.platformId] : [])) : undefined;
    const linkPlan = kind === 'authors' && !clearWorks ? planAuthorLinks(ids.map(id => snapshot.authorById.get(id)?.sharedKey)) : undefined;
    if (plan.view.token && linkPlan) {
        plan.view.token = createHash('sha256').update(JSON.stringify([plan.view.token, linkPlan.config.revision])).digest('hex');
    }
    if (plan.view.token && clearWorks) {
        plan.view.token = createHash('sha256').update(JSON.stringify(['clear-author-works', plan.view.token, clearIds])).digest('hex');
    }
    return { local, plan, linkPlan, clearIds };
}

function previewRemoval(c: Context, kind: RemovalKind, ids: string[], authorId?: string, clearWorks = false) {
    return browseDatabase(c, async snapshot => {
        if (removing) return c.json({ error: '正在删除文件，请稍后再查看' }, 409);
        try {
            const result = await planRemoval(snapshot, kind, ids, authorId, clearWorks);
            return result ? c.json({ ...result.plan.view, removedLinks: result.linkPlan?.matches.length ?? 0,
                ...(clearWorks ? { resetWorks: result.clearIds?.length ?? 0 } : {}) })
                : c.json({ error: '部分选择已不存在，请刷新列表后重新选择' }, 404);
        } catch (error) { return linkConfigFailure(c, error, '无法读取删除范围或下载器配置'); }
    });
}

async function commitRemoval(c: Context, kind: RemovalKind, ids: string[], token: string, authorId?: string, clearWorks = false) {
    if (updateJob.active) return c.json({ error: '正在下载更新，请在更新结束后再删除' }, 409);
    if (scan || removing) return c.json({ error: '索引正在更新，请稍后再试' }, 409);
    removing = true;
    let attempted = false;
    let affectedWorks: string[] = [];
    let affectedAssets: string[] = [];
    let mediaRoot = downloadRoot;
    let deleted;
    let failure;
    let removedLinks = 0;
    let clearIds: string[] = [];
    let linkChange: { before: ReturnType<typeof readConfigLinks>; saved: ReturnType<typeof saveConfigLinks> } | undefined;
    try {
        const snapshot = await loadDatabaseCatalog();
        const result = await planRemoval(snapshot, kind, ids, authorId, clearWorks);
        if (!result) return c.json({ error: '部分选择已不存在，请刷新列表后重新选择' }, 404);
        const { local, plan, linkPlan } = result;
        if (plan.view.token !== token || await loadDatabaseCatalog() !== snapshot) {
            return c.json({ error: '文件或作品记录已变更，请重新查看删除范围' }, 409);
        }
        affectedWorks = local.works.flatMap(work => work.platformId ? [work.platformId] : []);
        clearIds = result.clearIds ?? [];
        affectedAssets = [...local.assets.keys()];
        mediaRoot = local.root;
        // Save first so an unwritable configuration cannot leave media already deleted.
        if (linkPlan?.matches.length) {
            const { config, remaining, matches } = linkPlan;
            const saved = saveConfigLinks(configFile, remaining, config.revision);
            linkChange = { before: config, saved };
            removedLinks = matches.length;
        }
        attempted = true;
        deleted = await deletePermanently(local.root, plan.units);
    } catch (error) {
        failure = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : '操作失败';
    } finally {
        if (linkChange && !deleted) {
            try { saveConfigLinks(configFile, linkChange.before.links, linkChange.saved.revision); }
            catch { failure = `${failure ?? '删除未完成'}；配置链接恢复失败，请重新读取链接配置`; }
        }
        if (attempted) {
            try {
                if (clearWorks) {
                    if (deleted) resetDownloadedWorks(databaseFile, clearIds);
                } else {
                    await reconcileDeletedWorks(databaseFile, mediaRoot, affectedWorks);
                    if (deleted && kind === 'authors') forgetRegisteredAuthors(databaseFile, ids);
                }
            }
            catch (error) { failure ??= error instanceof Error ? error.message : '数据库更新失败'; }
            databaseView = undefined;
            catalog = undefined;
            scanError = undefined;
            for (const asset of affectedAssets) mediaPaths.delete(asset);
        }
        removing = false;
    }
    return failure ? c.json({ error: failure }, 409) : c.json({ ...deleted, removedLinks,
        ...(clearWorks ? { resetWorks: clearIds.length } : {}), ...await currentStatus() });
}

function isRemovalToken(body: unknown): body is { mode: 'permanent'; token: string } {
    const request = body as { mode?: unknown; token?: unknown } | null;
    return request?.mode === 'permanent' && typeof request.token === 'string' && /^[a-f0-9]{64}$/.test(request.token);
}

function removalSelection(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || !value.length || !value.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))) return undefined;
    return [...new Set<string>(value)].sort();
}

function batchRemoval(kind: RemovalKind, pathname: string) {
    app.on(['POST', 'DELETE'], pathname, async c => {
        if (!isLocalRequest(c)) return c.json({ error: '删除功能仅支持本机或已配置域名的同源请求' }, 403);
        if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
        const body = await c.req.json().catch(() => null);
        const ids = removalSelection(body?.ids);
        if (!ids) return c.json({ error: `请选择要删除的${kind === 'authors' ? '作者' : '作品'}` }, 400);
        const authorId = c.req.param('authorId');
        if (c.req.method === 'POST') return previewRemoval(c, kind, ids, authorId);
        if (!isRemovalToken(body)) return c.json({ error: '请查看删除清单并确认永久删除' }, 400);
        return commitRemoval(c, kind, ids, body.token, authorId);
    });
}

batchRemoval('authors', '/api/catalog/authors/batch-removal');
batchRemoval('works', '/api/catalog/works/batch-removal');
batchRemoval('works', '/api/catalog/authors/:authorId/works/batch-removal');

app.get('/api/catalog/authors/:id/works/clear', c => previewRemoval(c, 'authors', [c.req.param('id')], undefined, true));
app.delete('/api/catalog/authors/:id/works/clear', async c => {
    if (!isLocalRequest(c)) return c.json({ error: '清除功能仅支持本机或已配置域名的同源请求' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    if (!isRemovalToken(body)) return c.json({ error: '请查看文件清单并确认清除所有作品' }, 400);
    return commitRemoval(c, 'authors', [c.req.param('id')], body.token, undefined, true);
});

for (const kind of ['works', 'authors'] as const) {
    app.get(`/api/catalog/${kind}/:id/${kind === 'works' ? 'files' : 'removal'}`, c => previewRemoval(c, kind, [c.req.param('id')]));
    app.delete(`/api/catalog/${kind}/:id`, async c => {
        if (!isLocalRequest(c)) return c.json({ error: '删除功能仅支持本机或已配置域名的同源请求' }, 403);
        if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
        const body = await c.req.json().catch(() => null);
        if (!isRemovalToken(body)) return c.json({ error: '请刷新页面，查看文件清单并确认永久删除' }, 400);
        return commitRemoval(c, kind, [c.req.param('id')], body.token);
    });
}

app.get('/api/catalog/issues', c => browseIssues(c, snapshot => {
    const q = getQuery(c);
    const view = c.req.query('status') ?? 'pending';
    const code = c.req.query('code');
    const target = c.req.query('target');
    const author = c.req.query('author');
    if (!['pending', 'ignored', 'resolved', 'cleared', 'all'].includes(view)) return c.json({ error: '异常状态无效' }, 400);
    const rows = reviewStore().list(snapshot.issues).filter(issue => (!target || issue.targetId === target) && (!author || issue.authorId === author));
    const types = [...new Set(rows.map(issue => issue.code))].sort();
    const filtered = rows.filter(issue => (view === 'all' || (view === 'cleared' ? !issue.present : issue.present && issue.status === view)) &&
        (!code || issue.code === code) && (!q || [issue.title, issue.path, issue.detail, issue.note].join(' ').toLowerCase().includes(q)));
    return paginate(c, filtered, page => page, { types });
}));

app.post('/api/catalog/issues/batch-review', async c => {
    if (!isLocalRequest(c)) return c.json({ error: '异常复核仅支持本机或已配置域名的同源请求' }, 403);
    if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    const ids = removalSelection(body?.ids);
    if (!ids || ids.length > 1000 || !reviewStatuses.includes(body.status) || body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2000)) return c.json({ error: '请选择异常及有效的复核状态' }, 400);
    return browseIssues(c, snapshot => {
        const result = reviewStore().updateMany(ids, snapshot.issues, body.status, body.note);
        return result ? c.json({ updated: result.length }) : c.json({ error: '部分异常已变化，请重新读取列表' }, 409);
    });
});

app.patch('/api/catalog/issues/:id', async c => {
    if (!c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: '需要 JSON 请求' }, 415);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || !reviewStatuses.includes(body.status) || typeof body.note !== 'string' || body.note.length > 2000) {
        return c.json({ error: '状态或备注无效，备注最多 2000 字' }, 400);
    }
    return browseIssues(c, snapshot => {
        const id = c.req.param('id');
        if (!/^[a-f0-9]{24}$/.test(id)) return c.json({ error: '异常记录不存在' }, 404);
        const result = reviewStore().update(id, snapshot.issues.find(issue => issue.id === id), body.status as ReviewStatus, body.note.trim());
        return result ? c.json(result) : c.json({ error: '异常记录不存在，请刷新列表' }, 404);
    });
});

app.on(['GET', 'HEAD'], '/media/:id', c => {
    const id = c.req.param('id');
    const asset = mediaPaths.get(id);
    if (asset) return streamAsset(c, asset.root, asset.relativePath);
    const audited = catalog?.assets.get(id);
    return catalog && audited ? streamAsset(c, catalog.root, audited.relativePath) : c.notFound();
});

// Retain the older API for callers of the original gallery.
function loadLegacy(snapshot: DatabaseCatalog) {
    const users = snapshot.authors.map(author => ({
        name: author.name, sharedKey: author.sharedKey ?? '',
        works: snapshot.works.filter(work => work.authorId === author.id).map(work => ({
            description: work.title, time: work.time.replace(/:/g, '.'),
        })),
    }));
    const videos = users.flatMap((user, userIndex) => user.works.map((work, workIndex) => ({
        user: user.name, work: work.description, workTime: work.time,
        index: String(workIndex).padStart(10, '0') + String(userIndex).padStart(10, '0'),
    }))).sort((a, b) => a.index.localeCompare(b.index));
    return { users, videos };
}

for (const name of ['users', 'videos'] as const) {
    app.get(`/api/${name}`, c => c.redirect(`/api/${name}/0`, 302));
    app.get(`/api/${name}/:page`, c => browseDatabase(c, snapshot => {
        const page = c.req.param('page');
        const number = Number(page);
        if (!/^\d+$/.test(page) || !Number.isSafeInteger(number)) return c.text('Invalid Page', 400);
        const data = loadLegacy(snapshot);
        return c.json(data[name].slice(number * 24, (number + 1) * 24));
    }));
}
app.get('/api/:user/:work/:time', c => browseDatabase(c, async snapshot => {
    const { user, work, time } = c.req.param();
    const author = snapshot.authors.find(entry => entry.name === user);
    if (!author) return c.text('用户不存在', 400);
    const type = c.req.query('type') || 'video';
    if (!['video', 'cover', 'avatar'].includes(type)) return c.text('Invalid Page', 400);
    const item = snapshot.works.find(item => item.authorName === user && item.title === work
        && item.time.replace(/:/g, '.') === time);
    if (!item) return c.notFound();
    const local = withWorkMedia(item, await inspectWorks(snapshot, [item]));
    const asset = type === 'video' ? local.video : type === 'cover' ? local.cover : (await authorsWithMedia(snapshot, [author]))[0]?.avatar;
    return asset ? c.redirect(`/media/${asset}`, 302) : c.notFound();
}));
app.on(['GET', 'HEAD'], '/assets/*', c => browseDatabase(c, async snapshot => {
    let requested;
    try { requested = decodeURIComponent(new URL(c.req.raw.url).pathname.slice('/assets/'.length)); }
    catch { return c.notFound(); }
    const audited = catalog?.assetsByPath.get(requested);
    if (catalog && audited) return streamAsset(c, catalog.root, audited.relativePath);
    const directory = path.posix.dirname(requested);
    const legacy = path.posix.join(path.basename(snapshot.root), directory);
    const candidates = snapshot.works.filter(work => work.copies.some(copy =>
        (copy.directory || '.') === directory || copy.path === directory || copy.directory === legacy || copy.path === legacy));
    const local = await inspectWorks(snapshot, candidates);
    return local.assetsByPath.has(requested) ? streamAsset(c, local.root, requested) : c.notFound();
}));

mountAdminWeb(app);

const serverOptions = { fetch: app.fetch, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3001) };
export async function startServer() {
    const { serve } = await import('@hono/node-server');
    const server = serve({ ...serverOptions, overrideGlobalObjects: false }, info => console.log(`本地视频资料库 http://127.0.0.1:${info.port}`));
    server.on('error', error => {
        const message = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? `端口 ${serverOptions.port} 已被占用。可设置 PORT 后重试。` : error.message;
        console.error(message);
        process.exitCode = 1;
    });
    return server;
}

if (import.meta.main && typeof Bun === 'undefined') await startServer();

export { app, transfer };
export default serverOptions;
