import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rename, rm, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { indexLibrary } from '../util/transfer-index.ts';
import { serveLibrary } from '../util/transfer-service.ts';
import { executeImport, previewImport } from '../util/transfer-import.ts';
import { digest, ensureWorkDatabase, readTransferWorks, TransferStore } from '../util/transfer-store.ts';
import { validateManifest } from '../util/transfer-protocol.ts';
import { mountTransferRoutes } from '../util/transfer-routes.ts';
import { readConfigLinks, saveConfigLinks } from '../util/config-links.ts';
import { withRegisteredAuthors } from '../util/transfer-authors.ts';
import { readCatalogInWorker } from '../util/catalog-reader.ts';
import { inspectCatalogRows } from '../util/catalog.ts';
import type { LibraryLocation } from '../util/transfer-types.ts';

const workId = '7711783857319096191';
const otherId = '7711410519354044819';
const code = '0123456789abcdef0123456789abcdef';

async function library(base: string, name: string): Promise<LibraryLocation> {
    const directory = path.join(base, name);
    const root = path.join(directory, 'media'); await mkdir(root, { recursive: true });
    const location = { root, database: path.join(directory, 'data.db'), config: path.join(directory, 'config.yml') };
    await writeFile(location.config, 'link: []\npath: ./media\ncookies: fixture-secret-not-for-sharing\n');
    const db = ensureWorkDatabase(location.database); db.close(); return location;
}
async function media(location: LibraryLocation, id = workId, suffix = '.mp4', bytes = Buffer.from('fixture-video-content')) {
    const relative = `author/post/${id}/${id}${suffix}`;
    const file = path.join(location.root, ...relative.split('/')); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    return relative;
}
function row(location: LibraryLocation, id: string, file: string | null, authorName = '历史作者') {
    const db = ensureWorkDatabase(location.database);
    db.prepare('INSERT INTO aweme(aweme_id,aweme_type,title,author_id,author_name,author_sec_uid,create_time,file_path,image_count) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, 'video', `标题-${id}`, '101', authorName, 'sec101', 1000, file, 0);
    db.close();
}
async function fixture(t: { after: (cleanup: () => Promise<unknown>) => void }) {
    const base = await mkdtemp(path.join(os.tmpdir(), 'dy-transfer-'));
    t.after(async () => {
        // Bun defers finalizing SQLite statements until GC; Windows retains their file handles.
        if (process.platform === 'win32' && typeof Bun !== 'undefined') Bun.gc(true);
        await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    });
    return { base, sender: await library(base, 'sender'), receiver: await library(base, 'receiver') };
}
async function waitFor(predicate: () => boolean) {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail('Background transfer did not finish');
}

test('sharing uses explicit authors and file manifests, without leaking configuration or allowing writes', async t => {
    const { base, sender } = await fixture(t);
    const relative = await media(sender); row(sender, workId, relative);
    await media(sender, workId, '_music.mp3', Buffer.from('ID3music'));
    await writeFile(sender.config, 'link:\n  - https://www.douyin.com/user/sec102?from=share\n  - https://v.douyin.com/unknown/\ncookies: fixture-secret-not-for-sharing\n');
    await writeFile(path.join(sender.root, 'cookies.json'), 'fixture-secret-not-for-sharing');
    const outside = path.join(base, 'outside.mp4'); await writeFile(outside, 'outside-secret');
    if (process.platform !== 'win32') await symlink(outside, path.join(sender.root, `outside_${otherId}.mp4`));
    const index = await indexLibrary(sender);
    validateManifest(index.manifest);
    assert.equal(index.manifest.authors.length, 2);
    const author = index.manifest.authors.find(a => a.uid === '101')!;
    assert.equal(index.manifest.links.some(link => link.authorId === author.id), false, 'historical authors need no links');
    assert.ok(index.manifest.links.find(link => link.url.endsWith('/sec102'))?.authorId);
    assert.equal(index.manifest.links.find(link => link.status === 'unresolved')?.authorId, null);
    assert.equal(index.manifest.files.length, 2);
    assert.ok(!JSON.stringify(index.manifest).includes('fixture-secret'));
    assert.ok(!JSON.stringify(index.manifest).includes(sender.root));
    const sharing = await serveLibrary(index, sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const url = `http://127.0.0.1:${sharing.port}`;
    assert.equal((await fetch(url + '/v1/manifest')).status, 401);
    assert.equal((await fetch(url + '/v1/manifest', { method: 'POST', headers: { Authorization: `Bearer ${code}` } })).status, 405);
    const file = index.manifest.files.find(f => f.role === 'video')!;
    const headers = { Authorization: `Bearer ${code}`, 'X-Library-Snapshot': index.manifest.snapshotId, 'If-Match': `"${file.sha256}"`, Range: 'bytes=3-7' };
    const response = await fetch(`${url}/v1/files/${file.id}`, { headers });
    assert.equal(response.status, 206); assert.equal(await response.text(), 'ture-');
    assert.equal((await fetch(`${url}/v1/files/${digest('cookies.json')}`, { headers })).status, 404);
    await writeFile(path.join(sender.root, ...relative.split('/')), 'changed-source');
    assert.equal((await fetch(`${url}/v1/files/${file.id}`, { headers })).status, 409);
});

test('imports new data once and never transfers already present content again', async t => {
    const { sender, receiver } = await fixture(t);
    const relative = await media(sender); row(sender, workId, relative);
    await media(sender, workId, '_cover.jpg', Buffer.from([255,216,255,4,5,6]));
    const configured = readConfigLinks(sender.config); saveConfigLinks(sender.config, ['https://www.douyin.com/user/sec101'], configured.revision);
    const index = await indexLibrary(sender);
    const sharing = await serveLibrary(index, sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    let downloads = 0; sharing.server.on('request', request => { if (request.url?.startsWith('/v1/files/')) downloads++; });
    const plan = await previewImport(receiver, source);
    assert.equal(plan.counts.newWorks, 1); assert.equal(plan.counts.newAuthors, 1); assert.equal(plan.counts.filesToAdd, 2);
    const result = await executeImport(receiver, source, plan.id);
    assert.equal(result.works, 1); assert.equal(result.files, 2); assert.equal(result.links, 1);
    assert.equal(readTransferWorks(receiver.database).length, 1);
    assert.equal(readConfigLinks(receiver.config).links.length, 1);
    const store = new TransferStore(receiver.database); assert.equal(store.authors().length, 1); store.close();
    const transferred = downloads;
    const repeat = await executeImport(receiver, source, plan.id);
    assert.equal(repeat.works, 0); assert.equal(repeat.files, 0); assert.equal(downloads, transferred);
    const again = await previewImport(receiver, source);
    assert.equal(again.counts.newWorks, 0); assert.equal(again.counts.filesToAdd, 0); assert.equal(again.counts.filesToSkip, 2);
    const snapshot = withRegisteredAuthors(await readCatalogInWorker(receiver.root, receiver.database), receiver.database);
    assert.equal(snapshot.authors.length, 1); assert.equal(snapshot.authors[0]!.workCount, 1);
    const text = await readFile(receiver.config, 'utf8'); assert.ok(text.includes('fixture-secret-not-for-sharing'));
});

test('repairs missing media and sidecars without overwriting local records or conflicting files', async t => {
    const { sender, receiver } = await fixture(t);
    const video = await media(sender); row(sender, workId, video, '远端旧昵称');
    await media(sender, workId, '_cover.jpg', Buffer.from('remote-cover'));
    await media(sender, workId, '_music.mp3', Buffer.from('ID3missing-music'));
    row(receiver, workId, `author/post/${workId}/${workId}.mp4`, '本地保留昵称');
    const localCover = await media(receiver, workId, '_cover.jpg', Buffer.from('local-cover'));
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const preview = await previewImport(receiver, source);
    assert.equal(preview.counts.existingWorks, 1); assert.equal(preview.counts.filesToAdd, 2); assert.equal(preview.counts.conflicts, 1);
    const result = await executeImport(receiver, source, preview.id);
    assert.equal(result.works, 0); assert.equal(result.files, 2); assert.equal(result.conflicts, 1);
    assert.equal(readTransferWorks(receiver.database)[0]!.author_name, '本地保留昵称');
    assert.equal(await readFile(path.join(receiver.root, ...localCover.split('/')), 'utf8'), 'local-cover');
    assert.equal(await readFile(path.join(receiver.root, ...video.split('/')), 'utf8'), 'fixture-video-content');
});

test('repeated import recognizes a moved file and repairs the path without creating another copy', async t => {
    const { sender, receiver } = await fixture(t); const original = await media(sender); row(sender, workId, original);
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source); await executeImport(receiver, source, plan.id);
    const stored = readTransferWorks(receiver.database)[0]!.file_path;
    const moved = `renamed/post/${workId}/${workId}.mp4`; await mkdir(path.dirname(path.join(receiver.root, moved)), { recursive: true });
    await rename(path.join(receiver.root, stored), path.join(receiver.root, moved));
    let downloads = 0; sharing.server.on('request', req => { if (req.url?.startsWith('/v1/files/')) downloads++; });
    const result = await executeImport(receiver, source, plan.id);
    assert.equal(downloads, 0); assert.equal(result.files, 0); assert.equal(result.skipped, 1);
    assert.equal(readTransferWorks(receiver.database)[0]!.file_path, moved);
});

test('keeps configured-disabled links disabled on later imports', async t => {
    const { sender, receiver } = await fixture(t);
    const file = await media(sender); row(sender, workId, file);
    const original = readConfigLinks(sender.config); saveConfigLinks(sender.config, ['https://www.douyin.com/user/sec101'], original.revision);
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source); await executeImport(receiver, source, plan.id, { includeLinks: false });
    await executeImport(receiver, source, plan.id, { includeLinks: true });
    assert.deepEqual(readConfigLinks(receiver.config).links, []);
});

test('shares surviving files from pre-cleanup backups of the new database, without reading the old schema', async t => {
    const { sender } = await fixture(t);
    const primary = await media(sender); await media(sender, workId, '_music.mp3', Buffer.from('ID3survivor'));
    const backup = path.join(path.dirname(sender.database), 'cleanup-backups', '20261126', 'dy_downloader.before.db');
    await mkdir(path.dirname(backup), { recursive: true });
    row(sender, workId, primary);
    await import('node:fs/promises').then(fs => fs.copyFile(sender.database, backup));
    const db = ensureWorkDatabase(sender.database); db.prepare('DELETE FROM aweme').run(); db.close();
    await rm(path.join(sender.root, ...primary.split('/')));
    assert.equal((await indexLibrary(sender)).manifest.works.length, 0);
    const index = await indexLibrary(sender, { includeHistory: true });
    assert.equal(index.manifest.works.length, 1); assert.equal(index.manifest.files.length, 1); assert.equal(index.manifest.files[0]!.role, 'music');
});

test('rejects invalid manifests before importing any files', async t => {
    const { sender } = await fixture(t); const file = await media(sender); row(sender, workId, file);
    const good = (await indexLibrary(sender)).manifest;
    const bad = structuredClone(good); bad.files[0]!.name = '../../config.yml';
    assert.throws(() => validateManifest(bad), /清单/);
    const dangling = structuredClone(good); dangling.works[0]!.authorId = 'missing'; assert.throws(() => validateManifest(dangling), /清单/);
    const mismatched = structuredClone(good); mismatched.works[0]!.files = []; assert.throws(() => validateManifest(mismatched), /清单/);
});

test('resumes a truncated transfer using Range and commits the work only after content validation', async t => {
    const { sender, receiver } = await fixture(t);
    const body = Buffer.alloc(1024 * 1024, 42); const relative = await media(sender, workId, '.mp4', body); row(sender, workId, relative);
    const manifest = (await indexLibrary(sender)).manifest; const file = manifest.files[0]!;
    let interrupted = false; const ranges: string[] = [];
    const server = createServer((request, response) => {
        assert.equal(request.headers.authorization, `Bearer ${code}`);
        if (request.url === '/v1/manifest') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(manifest)); return; }
        const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
        ranges.push(request.headers.range ?? '');
        response.writeHead(offset ? 206 : 200, { ETag: `"${file.sha256}"`, 'Content-Length': body.length - offset,
            ...(offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}) });
        if (!interrupted) { interrupted = true; response.write(body.subarray(0, 32 * 1024)); setTimeout(() => response.destroy(), 80); }
        else response.end(body.subarray(offset));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const source = { address: `http://127.0.0.1:${(server.address() as { port: number }).port}`, code };
    const plan = await previewImport(receiver, source);
    await assert.rejects(executeImport(receiver, source, plan.id));
    assert.equal(readTransferWorks(receiver.database).length, 0);
    const partials = await readdir(path.join(receiver.root, '.library-import')); assert.equal(partials.length, 1);
    const offset = (await stat(path.join(receiver.root, '.library-import', partials[0]!))).size; assert.ok(offset > 0 && offset < body.length);
    const result = await executeImport(receiver, source, plan.id); assert.equal(result.works, 1);
    assert.equal(ranges[1], `bytes=${offset}-`);
    const imported = readTransferWorks(receiver.database)[0]!;
    assert.equal(digest(await readFile(path.join(receiver.root, imported.file_path))), file.sha256);
});

test('background routes start and stop a separate sharing listener and guard local mutation', { timeout: 20_000 }, async t => {
    const { sender } = await fixture(t); row(sender, workId, await media(sender));
    const app = new Hono(); const controller = mountTransferRoutes(app, sender); t.after(() => controller.close());
    const post = (action: string, body: unknown, origin = 'http://localhost') => app.request(`http://localhost/api/catalog/transfer/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    assert.equal((await post('share/start', {}, 'https://example.com')).status, 403);
    assert.equal((await app.request('http://localhost/api/catalog/transfer/status')).headers.get('Cache-Control'), 'no-store');
    assert.equal((await post('share/start', { port: 0 })).status, 202);
    await waitFor(() => controller.shareStatus.state === 'ready' || controller.shareStatus.state === 'failed');
    assert.equal(controller.shareStatus.state, 'ready', controller.shareStatus.error);
    const address = controller.shareStatus.addresses!.find(a => a.includes('127.0.0.1'))!;
    const response = await fetch(address + '/v1/manifest', { headers: { Authorization: `Bearer ${controller.shareStatus.code}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { works: unknown[] }).works.length, 1);
    await post('share/stop', {}); await waitFor(() => !controller.shareActive);
    assert.equal(controller.shareStatus.state, 'stopped');
});

test('snapshot identity is stable across sharing restarts and author identity gains a UID without duplication', async t => {
    const { sender } = await fixture(t);
    const initial = readConfigLinks(sender.config); saveConfigLinks(sender.config, ['https://www.douyin.com/user/sec101'], initial.revision);
    const empty = await indexLibrary(sender);
    assert.equal(empty.manifest.works.length, 0); assert.equal(empty.manifest.authors.length, 1);
    const authorId = empty.manifest.authors[0]!.id;
    row(sender, workId, await media(sender));
    const first = await indexLibrary(sender), second = await indexLibrary(sender);
    assert.equal(first.manifest.authors.length, 1); assert.equal(first.manifest.authors[0]!.id, authorId);
    assert.equal(first.manifest.authors[0]!.uid, '101'); assert.equal(first.manifest.snapshotId, second.manifest.snapshotId);
    const store = new TransferStore(sender.database); assert.equal(store.authors().length, 1);
    assert.equal(store.authors()[0]!.name, '历史作者', 'a stored placeholder is enriched once a real local profile exists'); store.close();
});

test('new works by an existing author use local author information and leave existing works unchanged', async t => {
    const { sender, receiver } = await fixture(t);
    row(sender, workId, await media(sender), '远端旧昵称');
    row(receiver, otherId, await media(receiver, otherId), '本地权威昵称');
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source); assert.equal(plan.counts.newAuthors, 0);
    await executeImport(receiver, source, plan.id);
    assert.deepEqual(new Set(readTransferWorks(receiver.database).map(r => r.author_name)), new Set(['本地权威昵称']));
});

test('gallery imports count missing image positions separately and preserve actual HEIF files', async t => {
    const { sender, receiver } = await fixture(t);
    const first = await media(sender, workId, '_1.jpg', Buffer.from([255,216,255,1,2,3]));
    const heic = Buffer.alloc(32); heic.writeUInt32BE(24, 0); heic.write('ftypheic', 4, 'ascii');
    await media(sender, workId, '_2.heic', heic); row(sender, workId, first);
    const db = ensureWorkDatabase(sender.database); db.prepare("UPDATE aweme SET aweme_type='gallery',image_count=2").run(); db.close();
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source); assert.equal(plan.counts.filesToAdd, 2);
    await executeImport(receiver, source, plan.id);
    const snapshot = await inspectCatalogRows(await realpath(receiver.root), readTransferWorks(receiver.database));
    assert.equal(snapshot.works.length, 1); assert.equal(snapshot.works[0]!.kind, 'album'); assert.equal(snapshot.works[0]!.images.length, 2);
    assert.equal((await previewImport(receiver, source)).counts.filesToAdd, 0);
});

test('idle shares close automatically and reject a stale transfer after shutdown', async t => {
    const { sender } = await fixture(t); row(sender, workId, await media(sender));
    let stopped = false;
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1', idleMs: 60, onStopped: () => { stopped = true; } });
    t.after(sharing.close); await waitFor(() => stopped); assert.equal(sharing.server.listening, false);
});

test('background import jobs survive page reloads without persisting a sharing code', { timeout: 20_000 }, async t => {
    const { sender, receiver } = await fixture(t); row(sender, workId, await media(sender));
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const app = new Hono(); const controller = mountTransferRoutes(app, receiver); t.after(() => controller.close());
    await controller.preview(source); await waitFor(() => !controller.importActive);
    assert.equal(controller.importStatus.state, 'ready', controller.importStatus.error);
    const id = controller.importStatus.preview!.id;
    await controller.import(source, id); await waitFor(() => !controller.importActive);
    assert.equal(controller.importStatus.state, 'completed', controller.importStatus.error);
    const { transferDirectory } = await import('../util/transfer-import.ts');
    await controller.close();
    const persisted = await readFile(path.join(transferDirectory(receiver.database), 'last-import.json'), 'utf8');
    assert.ok(!persisted.includes(code));
    const other = mountTransferRoutes(new Hono(), receiver); t.after(() => other.close()); await other.ready();
    assert.equal(other.importStatus.preview!.id, id);
    await other.import(source, id); await waitFor(() => !other.importActive);
    assert.equal(other.importStatus.result!.files, 0); assert.equal(other.importStatus.result!.works, 0);
});


test('an existing link-only author fills missing profile data instead of naming imported works after its placeholder', async t => {
    const { sender, receiver } = await fixture(t);
    row(sender, workId, await media(sender), '分享源的真实昵称');
    const config = readConfigLinks(receiver.config);
    saveConfigLinks(receiver.config, ['https://www.douyin.com/user/sec101'], config.revision);
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source);
    assert.equal(plan.counts.newAuthors, 0);
    assert.equal(plan.counts.existingAuthors, 1);
    const initial = new TransferStore(receiver.database);
    assert.equal(initial.authors()[0]!.name, '未命名作者'); initial.close();
    await executeImport(receiver, source, plan.id);
    const imported = readTransferWorks(receiver.database)[0]!;
    assert.equal(imported.author_name, '分享源的真实昵称'); assert.equal(imported.author_id, '101');
    const store = new TransferStore(receiver.database); const authors = store.authors();
    assert.equal(authors.length, 1); assert.equal(authors[0]!.uid, '101'); assert.equal(authors[0]!.name, '分享源的真实昵称');
    store.saveAuthor({ ...authors[0]!, name: '来源后来的昵称' });
    assert.equal(store.authors()[0]!.name, '分享源的真实昵称', 'a real local name is never replaced'); store.close();
    const again = await executeImport(receiver, source, plan.id);
    assert.equal(again.files, 0); assert.equal(again.works, 0);
});


test('imports authors with works and skips authors without any works even when named or retained in an old preview', async t => {
    const { sender, receiver } = await fixture(t);
    row(sender, workId, await media(sender), '未命名作者');
    const store = new TransferStore(sender.database);
    store.saveAuthor({ id: 'douyin:sec:sec103', uid: '103', secUid: 'sec103', name: '有昵称但无作品', aliases: [] }); store.close();
    const config = readConfigLinks(sender.config);
    saveConfigLinks(sender.config, ['https://www.douyin.com/user/sec101', 'https://www.douyin.com/user/sec102',
        'https://www.douyin.com/user/sec103', 'https://v.douyin.com/unknown/'], config.revision);
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source);
    assert.equal(plan.manifest.authors.length, 3, 'the original snapshot remains intact');
    assert.equal(plan.counts.newAuthors, 1); assert.equal(plan.counts.newLinks, 1); assert.equal(plan.counts.pendingLinks, 0);
    // Old saved previews can still contain a mapping for a now-excluded author.
    plan.authorMap['douyin:sec:sec102'] = 'douyin:sec:sec102';
    plan.authorMap['douyin:sec:sec103'] = 'douyin:sec:sec103';
    const { transferDirectory } = await import('../util/transfer-import.ts');
    await writeFile(path.join(transferDirectory(receiver.database), `${plan.id}.json`), JSON.stringify(plan));
    await executeImport(receiver, source, plan.id); await executeImport(receiver, source, plan.id);
    const imported = new TransferStore(receiver.database);
    assert.deepEqual(imported.authors().map(a => a.secUid), ['sec101']);
    assert.equal(imported.links().length, 1); imported.close();
    assert.deepEqual(readConfigLinks(receiver.config).links, ['https://www.douyin.com/user/sec101']);
    assert.equal(readTransferWorks(receiver.database).length, 1, 'an unnamed author with works is retained');
});

test('a source with only a link can reuse an author backed by a local historical work without media', async t => {
    const { sender, receiver } = await fixture(t);
    const config = readConfigLinks(sender.config); saveConfigLinks(sender.config, ['https://www.douyin.com/user/sec101'], config.revision);
    row(receiver, otherId, null, 'Mac 整理后的昵称');
    const sharing = await serveLibrary(await indexLibrary(sender), sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source);
    assert.equal(plan.counts.newAuthors, 0); assert.equal(plan.counts.existingAuthors, 1); assert.equal(plan.counts.newLinks, 1);
    await executeImport(receiver, source, plan.id);
    const imported = new TransferStore(receiver.database);
    assert.equal(imported.authors().length, 1); assert.equal(imported.authors()[0]!.name, 'Mac 整理后的昵称'); imported.close();
    assert.equal(readConfigLinks(receiver.config).links.length, 1);
});


test('shares and imports historical work metadata even after the current database and media no longer contain the work', async t => {
    const { sender, receiver } = await fixture(t);
    row(sender, workId, null, '历史保存的作者昵称');
    const backup = path.join(path.dirname(sender.database), 'cleanup-backups', 'history', 'dy_downloader.before.db');
    await mkdir(path.dirname(backup), { recursive: true });
    await import('node:fs/promises').then(fs => fs.copyFile(sender.database, backup));
    const db = ensureWorkDatabase(sender.database); db.prepare('DELETE FROM aweme').run(); db.close();
    assert.equal((await indexLibrary(sender)).manifest.works.length, 0);
    const index = await indexLibrary(sender, { includeHistory: true });
    assert.equal(index.manifest.works.length, 1); assert.deepEqual(index.manifest.works[0]!.files, []);
    assert.equal(index.manifest.authors[0]!.name, '历史保存的作者昵称');
    const sharing = await serveLibrary(index, sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source);
    assert.equal(plan.counts.newAuthors, 1); assert.equal(plan.counts.newWorks, 1); assert.equal(plan.counts.filesToAdd, 0);
    await executeImport(receiver, source, plan.id);
    const imported = readTransferWorks(receiver.database); assert.equal(imported.length, 1);
    assert.equal(imported[0]!.author_name, '历史保存的作者昵称'); assert.equal(imported[0]!.file_path, null);
    assert.equal((await executeImport(receiver, source, plan.id)).works, 0);
});


test('local uploads keep their own identity, metadata and avatar through sharing and repeat imports', async t => {
    const { sender, receiver } = await fixture(t);
    const id = 'local-ba3bc894e0401a11ee703d2bd0342cc9';
    const video = await media(sender, id);
    const metadata = await media(sender, id, '_data.json', Buffer.from(JSON.stringify({ aweme_id: id, desc: '本地视频', source: 'local_upload', author: { uid: 'local_uploads', nickname: '本地上传' } })));
    await media(sender, id, '_avatar.png', Buffer.from('placeholder-avatar'));
    await media(sender, id, '_cover.jpg', Buffer.from('local-video-cover'));
    row(sender, id, video, '本地上传');
    const db = ensureWorkDatabase(sender.database);
    db.prepare("UPDATE aweme SET author_id='local_uploads',author_sec_uid=NULL,metadata_path=? WHERE aweme_id=?").run(metadata, id); db.close();
    const index = await indexLibrary(sender);
    validateManifest(index.manifest);
    assert.equal(index.manifest.unassignedFiles, 0);
    assert.equal(index.manifest.files.length, 4);
    assert.equal(index.manifest.links.length, 0);
    assert.equal(index.manifest.authors[0]!.uid, 'local_uploads');
    const sharing = await serveLibrary(index, sender.root, code, { host: '127.0.0.1' }); t.after(sharing.close);
    const source = { address: `http://127.0.0.1:${sharing.port}`, code };
    const plan = await previewImport(receiver, source);
    assert.equal(plan.counts.newWorks, 1); assert.equal(plan.counts.filesToAdd, 4);
    await executeImport(receiver, source, plan.id);
    const imported = readTransferWorks(receiver.database)[0]!;
    assert.equal(imported.aweme_id, id); assert.equal(imported.author_name, '本地上传');
    assert.equal(imported.author_sec_uid, null);
    assert.ok(imported.metadata_path && imported.cover_path && imported.avatar_path);
    const catalog = await inspectCatalogRows(await realpath(receiver.root), [imported]);
    assert.ok(catalog.authors[0]!.avatar); assert.ok(catalog.works[0]!.cover);
    const repeated = await previewImport(receiver, source);
    assert.equal(repeated.counts.newWorks, 0); assert.equal(repeated.counts.newAuthors, 0);
    assert.equal(repeated.counts.filesToAdd, 0); assert.equal(repeated.counts.conflicts, 0);
    for (const invalid of ['local-../escape', 'local-abc', 'local-' + 'a'.repeat(33)]) {
        const broken = JSON.parse(JSON.stringify(index.manifest)); broken.works[0].id = invalid;
        assert.throws(() => validateManifest(broken));
    }
});
