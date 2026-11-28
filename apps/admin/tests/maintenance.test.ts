import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { inspectEmptyAuthors, removeEmptyAuthors, previewLinkRemoval, removeLinks, importIssueReport } from '../util/maintenance.ts';
import { mountMaintenanceRoutes } from '../util/maintenance-routes.ts';
import { ensureWorkDatabase, TransferStore } from '../util/transfer-store.ts';
import { indexLibrary } from '../util/transfer-index.ts';
import { transferDirectory } from '../util/transfer-import.ts';
import { readConfigLinks, saveConfigLinks } from '../util/config-links.ts';
import { ReviewStore } from '../util/reviews.ts';
import type { LibraryLocation } from '../util/transfer-types.ts';

async function fixture(t: { after: (callback: () => Promise<unknown>) => void }) {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dy-maintenance-')));
    t.after(async () => {
        if (process.platform === 'win32' && typeof Bun !== 'undefined') Bun.gc(true);
        await rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    });
    const location = { root: path.join(base, 'media'), database: path.join(base, 'data.db'), config: path.join(base, 'config.yml') };
    await mkdir(location.root); await writeFile(location.config, 'link: []\ncookies: do-not-copy-this-secret\nthread: 7\n');
    const db = ensureWorkDatabase(location.database); db.close();
    return { base, location };
}
function author(location: LibraryLocation, uid: string, name = '有昵称的作者') {
    const store = new TransferStore(location.database);
    store.saveAuthor({ id: `douyin:uid:${uid}`, uid, secUid: `sec${uid}`, name, aliases: [] }); store.close();
}
function work(database: string, uid: string, id: string) {
    const db = ensureWorkDatabase(database);
    db.prepare('INSERT INTO aweme(aweme_id,aweme_type,author_id,author_sec_uid,author_name,file_path) VALUES (?,?,?,?,?,NULL)')
        .run(id, 'video', uid, `sec${uid}`, '历史昵称'); db.close();
}
async function waitFor(check: () => Promise<boolean>) {
    for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.fail('Background maintenance did not finish');
}

test('manual author scan protects current records, historical metadata and incoming works without mutating the library', async t => {
    const { base, location } = await fixture(t);
    for (const uid of ['1', '2', '3', '4']) author(location, uid);
    const config = readConfigLinks(location.config); saveConfigLinks(location.config, ['https://www.douyin.com/user/sec4'], config.revision);
    work(location.database, '1', '10001');
    const historic = path.join(base, 'cleanup-backups', 'saved', 'dy_downloader.before.db');
    work(historic, '2', '10002');
    const sender = { root: path.join(base, 'source'), database: path.join(base, 'source.db'), config: path.join(base, 'source.yml') };
    await mkdir(sender.root); await writeFile(sender.config, 'link: []\n'); work(sender.database, '3', '10003');
    const index = await indexLibrary(sender);
    const id = randomUUID(), directory = transferDirectory(location.database); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, snapshotId: index.manifest.snapshotId, manifest: index.manifest }));
    await writeFile(path.join(directory, 'last-import.json'), JSON.stringify({ state: 'stopped', preview: { id } }));
    const before = await readFile(location.config, 'utf8');
    const audit = await inspectEmptyAuthors(location);
    assert.equal(audit.protectedAuthors, 3); assert.equal(audit.pendingAuthors, 1);
    assert.deepEqual(audit.candidates.map(a => a.uid), ['4']);
    assert.equal(audit.candidates[0]!.currentWorks, 0); assert.equal(audit.candidates[0]!.historicalWorks, 0);
    const store = new TransferStore(location.database); assert.equal(store.authors().length, 4); store.close();
    assert.equal(await readFile(location.config, 'utf8'), before);
    const receipt = await removeEmptyAuthors(location, [audit.candidates[0]!.id], audit.token);
    assert.equal(receipt.removedAuthors, 1); assert.equal(receipt.removedLinks, 1); assert.equal(receipt.deletedFiles, 0);
    const after = new TransferStore(location.database); assert.equal(after.authors().length, 3); after.close();
    assert.deepEqual(readConfigLinks(location.config).links, []);
    assert.ok((await readFile(location.config, 'utf8')).includes('do-not-copy-this-secret'));
    assert.ok(!(await readFile(path.join(receipt.receipt, 'receipt.json'), 'utf8')).includes('do-not-copy-this-secret'));
});

test('cleanup rejects stale evidence when an empty author gains a work', async t => {
    const { location } = await fixture(t); author(location, '1');
    const audit = await inspectEmptyAuthors(location); assert.equal(audit.candidates.length, 1);
    work(location.database, '1', '10001');
    await assert.rejects(removeEmptyAuthors(location, [audit.candidates[0]!.id], audit.token), /变化|作品/);
    const store = new TransferStore(location.database); assert.equal(store.authors().length, 1); store.close();
});

test('an unreadable pending import plan blocks cleanup instead of silently treating its authors as empty', async t => {
    const { location } = await fixture(t); author(location, '1');
    const directory = transferDirectory(location.database); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'last-import.json'), JSON.stringify({ state: 'running', preview: { id: randomUUID() } }));
    await assert.rejects(inspectEmptyAuthors(location), /待导入清单/);
});

test('manual link removal preserves authors, works and all other configuration, and rejects old previews', async t => {
    const { location } = await fixture(t); author(location, '1'); work(location.database, '1', '10001');
    let config = readConfigLinks(location.config); saveConfigLinks(location.config, ['https://www.douyin.com/user/sec1', 'invalid raw link'], config.revision);
    const stale = previewLinkRemoval(location, ['https://www.douyin.com/user/sec1']);
    config = readConfigLinks(location.config); saveConfigLinks(location.config, [...config.links, 'https://www.douyin.com/user/sec2'], config.revision);
    await assert.rejects(removeLinks(location, stale.links, stale.token), /变化/);
    const preview = previewLinkRemoval(location, ['invalid raw link']);
    const receipt = await removeLinks(location, preview.links, preview.token); assert.equal(receipt.removedLinks, 1);
    assert.deepEqual(readConfigLinks(location.config).links, ['https://www.douyin.com/user/sec1', 'https://www.douyin.com/user/sec2']);
    const store = new TransferStore(location.database); assert.equal(store.authors().length, 1); store.close();
    assert.ok((await readFile(location.config, 'utf8')).includes('thread: 7'));
});

test('maintenance routes do not scan on status reads, enforce origin/confirmation, and block cleanup during import', async t => {
    const { base, location } = await fixture(t); author(location, '1');
    const app = new Hono(); let busy = true, changed = 0;
    mountMaintenanceRoutes(app, location, { busy: () => busy, onChanged: () => { changed++; } });
    const before = (await readdir(base)).filter(name => !/-wal$|-shm$/.test(name));
    const status = await (await app.request('http://localhost/api/catalog/maintenance/status')).json();
    assert.equal(status.scanning, false); assert.equal(status.report, undefined); assert.deepEqual((await readdir(base)).filter(name => !/-wal$|-shm$/.test(name)), before);
    const request = (action: string, method: string, body: unknown, origin = 'http://localhost') => app.request(`http://localhost/api/catalog/maintenance/${action}`, {
        method, headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
    });
    assert.equal((await request('scan', 'POST', {}, 'https://example.com')).status, 403);
    assert.equal((await request('scan', 'POST', {})).status, 202);
    let report: Awaited<ReturnType<typeof inspectEmptyAuthors>>;
    await waitFor(async () => {
        const value = await (await app.request('http://localhost/api/catalog/maintenance/status')).json();
        assert.equal(value.error, undefined); if (value.report) report = value.report;
        return !value.scanning;
    });
    const body = { mode: 'permanent', ids: [report!.candidates[0]!.id], token: report!.token };
    assert.equal((await request('authors', 'DELETE', body)).status, 409);
    busy = false;
    assert.equal((await request('authors', 'DELETE', { ids: body.ids })).status, 400);
    assert.equal((await request('authors', 'DELETE', body)).status, 200); assert.equal(changed, 1);
});

test('batch review preserves existing notes and refuses partial writes for unknown records', async t => {
    const { base } = await fixture(t);
    const file = path.join(base, 'reviews.json'); const reviews = new ReviewStore(file);
    const a = { id: 'a'.repeat(24), code: 'empty_file', path: 'a.mp4', detail: 'empty' };
    const b = { id: 'b'.repeat(24), code: 'missing_cover', path: 'b.mp4', detail: 'missing' };
    reviews.update(a.id, a, 'pending', '保留的核查备注');
    const updated = reviews.updateMany([a.id, b.id], [a, b], 'ignored'); assert.equal(updated?.length, 2);
    assert.equal(reviews.list([a, b])[0]!.note, '保留的核查备注');
    const before = await readFile(file, 'utf8');
    assert.equal(reviews.updateMany([a.id, 'c'.repeat(24)], [a, b], 'resolved'), undefined);
    assert.equal(await readFile(file, 'utf8'), before);
});

test('read-only issues requests leave media scans idle until the scan API is called', async t => {
    const { base, location } = await fixture(t);
    process.env.CONFIG_PATH = location.config; process.env.DOWNLOAD_ROOT = location.root; process.env.DATABASE_PATH = location.database;
    process.env.CATALOG_REVIEW_FILE = path.join(base, 'reviews.json');
    const { app } = await import('../index.ts');
    assert.equal((await app.request('http://localhost/api/catalog/issues')).status, 503);
    let status = await (await app.request('http://localhost/api/catalog/status')).json();
    assert.equal(status.scanning, false); assert.equal(status.scannedAt, undefined);
    assert.equal((await app.request('http://localhost/api/catalog/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 202);
    await waitFor(async () => { status = await (await app.request('http://localhost/api/catalog/status')).json(); return Boolean(status.scannedAt); });
    assert.equal((await app.request('http://localhost/api/catalog/issues')).status, 200);
});


test('an archived unassigned file resolves only while its registered local work and media still exist', async t => {
    const { location } = await fixture(t);
    await writeFile(path.join(location.root, 'orphan.mp4'), 'local-video');
    const index = await indexLibrary(location);
    assert.equal(index.manifest.unassignedFiles, 1);
    const directory = transferDirectory(location.database); await mkdir(directory, { recursive: true });
    const id = randomUUID(), workId = 'local-' + 'b'.repeat(32), sha = 'a'.repeat(64);
    const plan = { id, snapshotId: index.manifest.snapshotId, address: 'http://source.example', actions: [], manifest: index.manifest,
        unassignedResolutions: [{ path: 'orphan.mp4', size: 11, workId, sha256: sha }] };
    const planFile = path.join(directory, `${id}.json`);
    await writeFile(planFile, JSON.stringify(plan));
    await writeFile(path.join(directory, 'last-import.json'), JSON.stringify({ state: 'completed', preview: { id } }));
    assert.equal((await importIssueReport(location, 'unassigned', 1)).total, 1);
    await writeFile(path.join(location.root, 'archived.mp4'), 'local-video');
    const db = ensureWorkDatabase(location.database);
    db.prepare('INSERT INTO aweme(aweme_id,aweme_type,author_id,author_name,file_path) VALUES (?,?,?,?,?)').run(workId, 'video', 'local_uploads', '本地上传', 'archived.mp4'); db.close();
    const store = new TransferStore(location.database); store.saveAsset(workId, 'video', 0, 'archived.mp4', sha); store.close();
    const report = await importIssueReport(location, 'unassigned', 1);
    assert.equal(report.total, 0); assert.equal(report.unassignedTotal, 0); assert.equal(report.resolvedUnassigned, 1);
    assert.equal((await importIssueReport(location, 'conflicts', 1)).total, 0);
    assert.deepEqual(JSON.parse(await readFile(planFile, 'utf8')), plan, 'original source snapshot stays intact');
    await rm(path.join(location.root, 'archived.mp4'));
    assert.equal((await importIssueReport(location, 'unassigned', 1)).total, 1);
});

test('local files scan is button-triggered, locks changes and persists paths without changing works', async t => {
    const { location } = await fixture(t);
    const id = '7346971177114611826';
    work(location.database, '1', id);
    await writeFile(path.join(location.root, id + '_video.mp4'), 'video');
    let busy = true, changed = 0;
    const app = new Hono();
    const maintenance = mountMaintenanceRoutes(app, location, { busy: () => busy, onChanged: () => changed++ });
    const post = (endpoint: string) => app.request('http://localhost/api/catalog/maintenance/' + endpoint,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const status = await (await app.request('http://localhost/api/catalog/maintenance/status')).json();
    assert.equal(status.localFiles.state, 'idle');
    let db = ensureWorkDatabase(location.database);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='library_local_media_roots'").get() as { n: number }).n, 0);
    db.close();
    assert.equal((await post('local-files/start')).status, 409);
    busy = false;
    assert.equal((await post('local-files/start')).status, 202);
    assert.equal(maintenance.changing, true);
    assert.equal((await post('scan')).status, 409);
    await waitFor(async () => !maintenance.changing);
    const result = await (await app.request('http://localhost/api/catalog/maintenance/status')).json();
    assert.equal(result.localFiles.state, 'completed', JSON.stringify(result.localFiles));
    assert.ok(result.localFiles.progress.message.includes('修复 1 条'));
    assert.equal(changed, 1);
    db = ensureWorkDatabase(location.database);
    const row = db.prepare('SELECT file_path, author_name FROM aweme WHERE aweme_id=?').get(id) as { file_path: string; author_name: string };
    assert.equal(row.file_path, id + '_video.mp4'); assert.equal(row.author_name, '历史昵称');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM library_local_media_roots').get() as { n: number }).n, 1);
    db.close();
    assert.equal((await readFile(path.join(location.root, id + '_video.mp4'), 'utf8')), 'video');
    const restarted = new Hono();
    mountMaintenanceRoutes(restarted, location, { busy: () => false, onChanged: () => {} });
    const saved = await (await restarted.request('http://localhost/api/catalog/maintenance/status')).json();
    assert.equal(saved.localFiles.state, 'completed');
});

test('log cleanup endpoints enforce same-origin JSON and explicit deletion scope', async t => {
    const { location } = await fixture(t);
    const app = new Hono();
    mountMaintenanceRoutes(app, location, { busy: () => false, onChanged: () => {} });
    const response = await app.request('http://localhost/api/catalog/maintenance/logs', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 0 }),
    });
    assert.equal(response.status, 400);
    const cross = await app.request('http://localhost/api/catalog/maintenance/logs/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{"days":0}',
    });
    assert.equal(cross.status, 403);
});
