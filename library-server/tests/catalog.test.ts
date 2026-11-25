import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { scanCatalog } from '../util/catalog.ts';
import { reconcileDeletedWorks } from '../util/db.ts';

test('database catalog, media routes, refresh, and confirmed deletion', async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'dy-library-db-'));
    const root = path.join(temporary, 'Downloaded');
    const databaseFile = path.join(temporary, 'data', 'dy_downloader.db');
    await mkdir(path.dirname(databaseFile), { recursive: true });
    const videoStem = '2026-11-01_数据库视频_7411111111111111111';
    const albumStem = '2026-11-02_数据库图集_7422222222222222222';
    const videoDir = path.join(root, '测试作者', 'post', videoStem);
    const albumDir = path.join(root, '测试作者', 'post', albumStem);
    await mkdir(videoDir, { recursive: true });
    await mkdir(albumDir, { recursive: true });
    const video = path.join(videoDir, videoStem + '.mp4');
    const album = path.join(albumDir, albumStem + '_1.jpeg');
    await writeFile(video, '0123456789');
    await writeFile(path.join(videoDir, videoStem + '_cover.jpg'), 'cover');
    // Invalid legacy sidecars must not override database metadata.
    await writeFile(path.join(videoDir, videoStem + '_data.json'), '{invalid');
    await writeFile(album, 'first');
    await writeFile(path.join(albumDir, albumStem + '_2.jpeg'), 'second');
    await writeFile(path.join(root, 'unregistered.mp4'), 'not in database');
    const db = new DatabaseSync(databaseFile);
    db.exec(`CREATE TABLE aweme (
        aweme_id TEXT PRIMARY KEY, aweme_type TEXT, title TEXT,
        author_id TEXT, author_name TEXT, author_sec_uid TEXT,
        create_time INTEGER, file_path TEXT, metadata TEXT)`);
    const insert = db.prepare('INSERT INTO aweme VALUES (?,?,?,?,?,?,?,?,?)');
    insert.run('7411111111111111111', 'video', '数据库视频', 'uid', '数据库作者', 'sec-author',
        1793520000, video, '{}');
    insert.run('7422222222222222222', 'gallery', '数据库图集', 'uid', '数据库作者', 'sec-author',
        1793606400, album, JSON.stringify({ images: [{}, {}] }));
    db.close();
    t.after(async () => { await rm(temporary, { recursive: true, force: true }); });

    await t.test('uses database records and recognizes modern gallery names', async () => {
        const catalog = await scanCatalog(root, databaseFile);
        assert.equal(catalog.works.length, 2);
        assert.equal(catalog.authors.length, 1);
        assert.equal(catalog.authors[0]!.name, '数据库作者');
        assert.equal(catalog.authors[0]!.workCount, 2);
        const gallery = catalog.works.find(work => work.kind === 'album')!;
        assert.equal(gallery.images.length, 2);
        assert.equal(gallery.issueCount, 0);
        assert.equal(catalog.issues.some(issue => issue.code.includes('metadata')), false);
        assert.equal(catalog.works.some(work => work.title.includes('unregistered')), false);
    });

    await t.test('reports missing gallery images', async () => {
        const second = path.join(albumDir, albumStem + '_2.jpeg');
        await rm(second);
        const catalog = await scanCatalog(root, databaseFile);
        assert.equal(catalog.issues.some(issue => issue.code === 'incomplete_album'), true);
        await writeFile(second, 'second');
    });

    await t.test('requires an existing database', async () => {
        await assert.rejects(scanCatalog(root, path.join(temporary, 'absent.db')));
    });

    await t.test('rejects media paths outside the configured root', async () => {
        const database = new DatabaseSync(databaseFile);
        database.prepare('UPDATE aweme SET file_path=? WHERE aweme_type=?').run(
            path.join(temporary, 'outside.mp4'), 'video');
        database.close();
        try {
            const catalog = await scanCatalog(root, databaseFile);
            assert.equal(catalog.works.length, 1);
            assert.equal(catalog.issues.some(issue => issue.code === 'invalid_media_path'), true);
            await assert.rejects(reconcileDeletedWorks(databaseFile, root, ['7411111111111111111']));
        } finally {
            const restore = new DatabaseSync(databaseFile);
            restore.prepare('UPDATE aweme SET file_path=? WHERE aweme_type=?').run(video, 'video');
            restore.close();
        }
    });

    await t.test('compact columns work without a database JSON blob', async () => {
        const database = new DatabaseSync(databaseFile);
        database.exec(`ALTER TABLE aweme ADD COLUMN image_count INTEGER;
            ALTER TABLE aweme ADD COLUMN metadata_path TEXT;
            ALTER TABLE aweme ADD COLUMN cover_path TEXT;
            ALTER TABLE aweme ADD COLUMN avatar_path TEXT;`);
        database.prepare("UPDATE aweme SET image_count=CASE WHEN aweme_type='gallery' THEN 2 ELSE 0 END,metadata=NULL").run();
        database.prepare("UPDATE aweme SET metadata_path=? WHERE aweme_type='video'").run(
            path.join(videoDir, videoStem + '_data.json'));
        database.close();
        const catalog = await scanCatalog(root, databaseFile);
        assert.equal(catalog.works.length, 2);
        assert.equal(catalog.works.find(work => work.kind === 'album')!.images.length, 2);
    });

    await t.test('reads old JSON only for unfilled legacy image counts', async () => {
        const database = new DatabaseSync(databaseFile);
        database.prepare("UPDATE aweme SET image_count=NULL,metadata=? WHERE aweme_type='gallery'")
            .run(JSON.stringify({ images: [{}, {}] }));
        database.close();
        try {
            const catalog = await scanCatalog(root, databaseFile);
            assert.equal(catalog.works.find(work => work.kind === 'album')!.images.length, 2);
            assert.equal(catalog.issues.some(issue => issue.code === 'incomplete_album'), false);
        } finally {
            const restore = new DatabaseSync(databaseFile);
            restore.prepare("UPDATE aweme SET image_count=2,metadata=NULL WHERE aweme_type='gallery'").run();
            restore.close();
        }
    });

    await t.test('supports directory paths written by earlier downloaders', async () => {
        const database = new DatabaseSync(databaseFile);
        database.prepare("UPDATE aweme SET file_path=? WHERE aweme_type='video'").run(videoDir);
        database.close();
        try {
            const catalog = await scanCatalog(root, databaseFile);
            assert.equal(catalog.works.length, 2);
            assert.ok(catalog.works.find(work => work.kind === 'video')!.video);
        } finally {
            const restore = new DatabaseSync(databaseFile);
            restore.prepare("UPDATE aweme SET file_path=? WHERE aweme_type='video'").run(video);
            restore.close();
        }
    });

    await t.test('uses download-root-relative paths for media and JSON', async () => {
        const database = new DatabaseSync(databaseFile);
        const rows = database.prepare('SELECT aweme_id,file_path,metadata_path FROM aweme').all() as {
            aweme_id: string; file_path: string; metadata_path: string | null;
        }[];
        for (const row of rows) {
            database.prepare('UPDATE aweme SET file_path=?,metadata_path=? WHERE aweme_id=?').run(
                path.relative(root, row.file_path).split(path.sep).join('/'),
                row.metadata_path ? path.relative(root, row.metadata_path).split(path.sep).join('/') : null,
                row.aweme_id);
        }
        database.close();
        const catalog = await scanCatalog(root, databaseFile);
        assert.equal(catalog.works.length, 2);
        assert.ok(catalog.works.find(work => work.kind === 'video')!.video);
        assert.equal(catalog.works.find(work => work.kind === 'album')!.images.length, 2);
    });

    const configFile = path.join(temporary, 'config.yml');
    await writeFile(configFile, 'link: []\n');
    process.env.CONFIG_PATH = configFile;
    process.env.DOWNLOAD_ROOT = root;
    process.env.DATABASE_PATH = databaseFile;
    process.env.CATALOG_REVIEW_FILE = path.join(temporary, 'reviews.json');
    const { app } = await import('../index.ts');
    async function ready(requireScan = false) {
        for (let attempt = 0; attempt < 100; attempt++) {
            const response = await app.request('http://localhost/api/catalog/status');
            const status = await response.json() as { scanning: boolean; scannedAt?: string; works?: number; error?: string };
            assert.equal(status.error, undefined);
            if (!status.scanning && status.works !== undefined && (!requireScan || status.scannedAt)) return status;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('Catalog did not load');
    }

    await t.test('startup and normal browse leave the full media scan idle', async () => {
        assert.equal((await ready()).scannedAt, undefined);
        const response = await app.request('http://localhost/api/catalog/works?size=1');
        assert.equal(response.status, 200);
        const page = await response.json() as { total: number; items: { id: string; cover?: string }[] };
        assert.equal(page.total, 2);
        assert.equal(page.items.length, 1);
        assert.equal((await app.request('http://localhost/media/' + page.items[0]!.cover)).status, 200);
        assert.equal((await app.request('http://localhost/api/catalog/authors')).status, 200);
        const videoRelative = path.relative(root, video).split(path.sep).map(encodeURIComponent).join('/');
        assert.equal(await (await app.request('http://localhost/assets/' + videoRelative)).text(), '0123456789');
        assert.equal((await ready()).scannedAt, undefined);
    });

    await t.test('links resolve directly to the same internal author page', async () => {
        const matches = await app.request('http://localhost/api/catalog/link-authors');
        assert.equal(matches.status, 200);
        const data = await matches.json() as { authors: Record<string, { id: string; name: string }> };
        assert.equal(data.authors['sec-author']!.name, '数据库作者');
        const detail = await app.request('http://localhost/api/catalog/authors/' + data.authors['sec-author']!.id);
        assert.equal(detail.status, 200);
        assert.equal((await detail.json() as { workCount: number }).workCount, 2);
        assert.equal((await ready()).scannedAt, undefined);
        assert.equal((await app.request('http://localhost/api/catalog/link-authors', {
            headers: { Origin: 'https://example.com' },
        })).status, 403);
    });

    await t.test('author link removal changes only matching config entries', async () => {
        const matches = ['https://www.douyin.com/user/sec-author/?from=share',
            '作者分享 https://douyin.com/user/sec%2Dauthor 复制打开'];
        const otherLinks = ['https://www.douyin.com/user/sec-author-other', 'https://v.douyin.com/unknown/',
            'https://www.douyin.com/video/7411111111111111111'];
        const config = { link: [matches[0], ...otherLinks, matches[1]], path: './Downloaded', cookies: { sessionid: 'fixture-only' } };
        await writeFile(configFile, JSON.stringify(config));
        const authors = await (await app.request('http://localhost/api/catalog/authors')).json() as { items: { id: string }[] };
        const authorUrl = 'http://localhost/api/catalog/authors/' + authors.items[0]!.id;
        const endpoint = authorUrl + '/links';
        assert.equal((await app.request(endpoint, { headers: { Origin: 'https://example.com' } })).status, 403);

        const remove = (revision: string, origin = 'http://localhost') => app.request(endpoint, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ revision }),
        });
        const preview = await (await app.request(endpoint)).json() as { links: string[]; revision: string };
        assert.deepEqual(preview.links, matches);
        assert.equal((await remove(preview.revision, 'https://example.com')).status, 403);
        assert.equal((await remove('invalid')).status, 400);

        const concurrentLink = 'https://www.douyin.com/user/unrelated';
        const modified = JSON.stringify({ ...config, link: [...config.link, concurrentLink] });
        await writeFile(configFile, modified);
        assert.equal((await remove(preview.revision)).status, 409);
        assert.equal(await readFile(configFile, 'utf8'), modified);

        const fresh = await (await app.request(endpoint)).json() as { revision: string };
        const response = await remove(fresh.revision);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { removedLinks: 2 });
        assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { ...config, link: [...otherLinks, concurrentLink] });
        assert.deepEqual((await (await app.request(endpoint)).json() as { links: string[] }).links, []);
        assert.equal((await app.request(authorUrl)).status, 200);
        assert.equal((await ready()).works, 2);
        assert.equal(await readFile(video, 'utf8'), '0123456789');
        assert.equal(await readFile(album, 'utf8'), 'first');
    });

    await t.test('serves database works and ranged media through normal routes', async () => {
        const response = await app.request('http://localhost/api/catalog/works');
        assert.equal(response.status, 200);
        const page = await response.json() as { total: number; items: { id: string; video?: string; title: string }[] };
        assert.equal(page.total, 2);
        const work = page.items.find(item => item.video)!;
        const media = await app.request('http://localhost/media/' + work.video, { headers: { Range: 'bytes=2-5' } });
        assert.equal(media.status, 206);
        assert.equal(media.headers.get('content-range'), 'bytes 2-5/10');
        assert.equal(await media.text(), '2345');
        const legacy = await app.request('http://localhost/api/videos/0');
        assert.equal(legacy.status, 200);
        assert.equal((await legacy.json() as unknown[]).length, 2);
        const users = await app.request('http://localhost/api/users/0');
        assert.equal((await users.json() as { name: string }[])[0]!.name, '数据库作者');
    });

    await t.test('details read JSON on demand and tolerate unavailable JSON', async () => {
        const page = await (await app.request('http://localhost/api/catalog/works')).json() as {
            items: { id: string; kind: string; metadata?: unknown }[];
        };
        const work = page.items.find(item => item.kind === 'video')!;
        assert.equal(work.metadata, undefined);
        const endpoint = 'http://localhost/api/catalog/works/' + work.id;
        const broken = await (await app.request(endpoint)).json() as { metadataError?: string; title: string };
        assert.ok(broken.metadataError);
        const file = path.join(videoDir, videoStem + '_data.json');
        await writeFile(file, JSON.stringify({ full_response: true, extra: { preserved: true } }));
        const detail = await (await app.request(endpoint)).json() as { metadata: { full_response: boolean } };
        assert.equal(detail.metadata.full_response, true);
        await rm(file);
        const missing = await (await app.request(endpoint)).json() as { metadataError?: string; video?: string };
        assert.ok(missing.metadataError);
        assert.ok(missing.video);
    });

    await t.test('database updates are visible before an explicit media scan', async () => {
        const earlier = await (await app.request('http://localhost/api/catalog/works')).json() as { items: { video?: string }[] };
        const media = earlier.items.find(item => item.video)!.video;
        const database = new DatabaseSync(databaseFile);
        try {
            database.exec('PRAGMA journal_mode=WAL');
            database.prepare('UPDATE aweme SET title=? WHERE aweme_type=?').run('已更新标题', 'video');
            const works = await (await app.request('http://localhost/api/catalog/works?q=' +
                encodeURIComponent('已更新标题'))).json() as { total: number };
            assert.equal(works.total, 1);
        } finally { database.close(); }
        assert.equal(await (await app.request('http://localhost/media/' + media)).text(), '0123456789');
        assert.equal((await ready()).scannedAt, undefined);

        const second = path.join(albumDir, albumStem + '_2.jpeg');
        await rm(second);
        const response = await app.request('http://localhost/api/catalog/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        assert.equal(response.status, 202);
        assert.ok((await ready(true)).scannedAt);
        const issues = await (await app.request('http://localhost/api/catalog/issues')).json() as { items: { code: string }[] };
        assert.equal(issues.items.some(item => item.code === 'incomplete_album'), true);
        await writeFile(second, 'second');
    });

    await t.test('confirmed deletion updates its database record', async () => {
        const page = await (await app.request('http://localhost/api/catalog/works')).json() as {
            items: { id: string; kind: string }[];
        };
        const work = page.items.find(item => item.kind === 'video')!;
        const plan = await (await app.request('http://localhost/api/catalog/works/' + work.id + '/files')).json() as { token: string };
        const response = await app.request('http://localhost/api/catalog/works/' + work.id, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'permanent', token: plan.token }),
        });
        assert.equal(response.status, 200);
        const database = new DatabaseSync(databaseFile);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM aweme').get()!.count, 1);
        database.close();
        await assert.rejects(async () => { await import('node:fs/promises').then(fs => fs.stat(video)); });
        const status = await ready();
        assert.equal(status.works, 1);
        assert.equal(status.scannedAt, undefined);
    });

    await t.test('author deletion removes all works and matching links while preserving other authors and settings', async () => {
        await mkdir(videoDir, { recursive: true });
        await writeFile(video, 'downloaded-again');
        const otherDir = path.join(root, '其他作者', 'post', 'other-work');
        const otherFile = path.join(otherDir, 'other-work.mp4');
        await mkdir(otherDir, { recursive: true });
        await writeFile(otherFile, 'keep-other-author');
        const missingFile = path.join(root, '测试作者', 'post', 'already-missing', 'missing.mp4');
        const database = new DatabaseSync(databaseFile);
        const insert = database.prepare(`INSERT INTO aweme
            (aweme_id,aweme_type,title,author_id,author_name,author_sec_uid,create_time,file_path)
            VALUES (?,?,?,?,?,?,?,?)`);
        insert.run('7411111111111111111', 'video', '重建的视频', 'uid', '数据库作者', 'sec-author', 1793520000, video);
        insert.run('7433333333333333333', 'video', '本地已缺失', 'uid', '数据库作者', 'sec-author', 1793520000, missingFile);
        insert.run('7444444444444444444', 'video', '其他作者作品', 'other', '其他作者', 'sec-other', 1793520000, otherFile);
        database.close();
        const config = {
            link: ['https://www.douyin.com/user/sec-author', 'https://www.douyin.com/user/sec-author/?from=test',
                'https://www.douyin.com/user/sec-other', 'https://www.douyin.com/user/sec-author-other',
                'https://www.douyin.com/video/7411111111111111111', 'https://v.douyin.com/unknown/'],
            path: './Downloaded', cookies: { sessionid: 'fixture-only' }, avatar: true,
        };
        await writeFile(configFile, JSON.stringify(config));
        const page = await (await app.request('http://localhost/api/catalog/authors')).json() as {
            items: { id: string; name: string }[];
        };
        const author = page.items.find(item => item.name === '数据库作者')!;
        const endpoint = 'http://localhost/api/catalog/authors/' + author.id;
        const plan = await (await app.request(endpoint + '/removal')).json() as {
            token: string; workCount: number; removedLinks: number; errors: string[];
        };
        assert.equal(plan.workCount, 3);
        assert.equal(plan.removedLinks, 2);
        assert.deepEqual(plan.errors, []);
        assert.ok(plan.token);
        const remove = (token: string, headers = {}) => app.request(endpoint, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ mode: 'permanent', token }),
        });
        assert.equal((await remove(plan.token, { Origin: 'https://example.com' })).status, 403);
        // A changed config invalidates the reviewed deletion scope before touching files.
        await writeFile(configFile, JSON.stringify({ ...config, link: [...config.link, 'https://example.com/keep'] }));
        assert.equal((await remove(plan.token)).status, 409);
        assert.equal(await readFile(video, 'utf8'), 'downloaded-again');
        // An unreadable config must not allow irreversible file deletion.
        await writeFile(configFile, 'link: [invalid');
        assert.equal((await remove(plan.token)).status, 409);
        assert.ok(await stat(album));
        await writeFile(configFile, JSON.stringify(config));
        const fresh = await (await app.request(endpoint + '/removal')).json() as { token: string };
        const response = await remove(fresh.token);
        assert.equal(response.status, 200, await response.clone().text());
        const result = await response.json() as { removedLinks: number; works: number; authors: number };
        assert.equal(result.removedLinks, 2);
        assert.equal(result.works, 1);
        assert.equal(result.authors, 1);
        await assert.rejects(stat(video));
        await assert.rejects(stat(album));
        assert.equal(await readFile(otherFile, 'utf8'), 'keep-other-author');
        const saved = JSON.parse(await readFile(configFile, 'utf8'));
        assert.deepEqual(saved, { ...config, link: config.link.slice(2) });
        const check = new DatabaseSync(databaseFile);
        assert.deepEqual(check.prepare('SELECT aweme_id FROM aweme').all().map(row => row.aweme_id), ['7444444444444444444']);
        check.close();
        assert.equal((await app.request(endpoint)).status, 404);
        await assert.rejects(stat(path.join(root, '.catalog-removed-authors.json')));
    });

    await t.test('batch removal checks the complete selected scope before removing authors', async () => {
        const firstDir = path.join(root, '批量甲', 'post', 'first');
        const secondDir = path.join(root, '批量乙', 'post', 'second');
        const firstFile = path.join(firstDir, 'first.mp4');
        const secondFile = path.join(secondDir, 'second.mp4');
        const otherFile = path.join(root, '其他作者', 'post', 'other-work', 'other-work.mp4');
        await mkdir(firstDir, { recursive: true });
        await mkdir(secondDir, { recursive: true });
        await writeFile(firstFile, 'first');
        await writeFile(secondFile, 'second');
        const database = new DatabaseSync(databaseFile);
        try {
            const insert = database.prepare(`INSERT INTO aweme
                (aweme_id,aweme_type,title,author_id,author_name,author_sec_uid,create_time,file_path)
                VALUES (?,?,?,?,?,?,?,?)`);
            insert.run('7455555555555555555', 'video', '甲作品', 'first', '批量甲', 'sec-first', 1793520000, firstFile);
            insert.run('7466666666666666666', 'video', '乙作品', 'second', '批量乙', 'sec-second', 1793520000, secondFile);
        } finally { database.close(); }
        const firstLink = 'https://www.douyin.com/user/sec-first';
        const secondLink = 'https://www.douyin.com/user/sec-second/?from=batch';
        const otherLink = 'https://www.douyin.com/user/sec-other';
        const config = { link: [otherLink, firstLink, secondLink], path: './Downloaded', avatar: true };
        await writeFile(configFile, JSON.stringify(config));

        const authors = await (await app.request('http://localhost/api/catalog/authors')).json() as {
            items: { id: string; name: string }[];
        };
        const ids = authors.items.filter(author => author.name.startsWith('批量')).map(author => author.id);
        const endpoint = 'http://localhost/api/catalog/authors/batch-removal';
        const request = (method: string, selected: string[], token?: string, origin = 'http://localhost') => app.request(endpoint, {
            method, headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({ ids: selected, mode: 'permanent', token }),
        });
        assert.equal(ids.length, 2);
        assert.equal((await request('POST', [], undefined)).status, 400);
        assert.equal((await request('POST', [...ids, 'a'.repeat(24)])).status, 404);
        assert.equal((await request('POST', ids, undefined, 'https://example.com')).status, 403);

        const preview = async () => {
            const response = await request('POST', ids);
            assert.equal(response.status, 200);
            return await response.json() as { token?: string; authors: { id: string }[]; workCount: number; fileCount: number; removedLinks: number; errors: string[] };
        };
        const plan = await preview();
        assert.deepEqual(plan.authors.map(author => author.id).sort(), [...ids].sort());
        assert.equal(plan.workCount, 2);
        assert.equal(plan.removedLinks, 2);
        assert.ok(plan.token);
        assert.equal((await request('DELETE', ids.slice(0, 1), plan.token)).status, 409);

        const sharedFile = path.join(firstDir, 'unselected.mp4');
        await writeFile(sharedFile, 'shared');
        const updatePath = (author: string, file: string) => {
            const connection = new DatabaseSync(databaseFile);
            try { connection.prepare('UPDATE aweme SET file_path=? WHERE author_sec_uid=?').run(file, author); }
            finally { connection.close(); }
        };
        updatePath('sec-other', sharedFile);
        const blocked = await preview();
        assert.equal(blocked.token, undefined);
        assert.ok(blocked.errors.some(error => error.includes('未选作品使用此路径')));
        assert.equal((await request('DELETE', ids, plan.token)).status, 409);
        assert.equal(await readFile(sharedFile, 'utf8'), 'shared');
        updatePath('sec-other', otherFile);
        await rm(sharedFile);

        const nestedDir = path.join(firstDir, 'second');
        const nestedFile = path.join(nestedDir, 'second.mp4');
        await rename(secondDir, nestedDir);
        updatePath('sec-second', nestedFile);
        const fresh = await preview();
        assert.ok(fresh.token);
        assert.equal(fresh.fileCount, 2);
        const result = await request('DELETE', [...ids].reverse(), fresh.token);
        assert.equal(result.status, 200, await result.clone().text());
        assert.equal((await result.json() as { removedLinks: number }).removedLinks, 2);
        await assert.rejects(stat(firstFile));
        await assert.rejects(stat(nestedFile));
        assert.equal(await readFile(otherFile, 'utf8'), 'keep-other-author');
        assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), { ...config, link: [otherLink] });
        assert.equal((await ready()).works, 1);
    });
});
