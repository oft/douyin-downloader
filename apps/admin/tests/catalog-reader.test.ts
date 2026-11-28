import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { CatalogReader } from '../util/catalog-reader.ts';

test('a locked SQLite catalog cannot block update status or HTTP routing', async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dy-catalog-worker-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const downloads = path.join(root, 'Downloaded');
    const databaseFile = path.join(root, 'test.db');
    await mkdir(downloads);
    const database = new DatabaseSync(databaseFile);
    database.exec(`CREATE TABLE aweme (
        aweme_id TEXT PRIMARY KEY, aweme_type TEXT, title TEXT,
        author_id TEXT, author_name TEXT, author_sec_uid TEXT,
        create_time INTEGER, file_path TEXT, metadata TEXT)`);
    const config = path.join(root, 'config.yml');
    await writeFile(config, `path: ${downloads}\ndatabase_path: ${databaseFile}\n`);
    process.env.CONFIG_PATH = config;
    const { app } = await import('../index.ts');
    database.exec('BEGIN EXCLUSIVE');
    try {
        const reader = new CatalogReader();
        t.after(() => reader.close());
        const slowRead = reader.read(downloads, databaseFile);
        const started = performance.now();
        await setTimeout(150);
        const status = await app.request('http://localhost/api/catalog/update');
        assert.equal(status.status, 200);
        assert.equal((await status.json() as { state: string }).state, 'idle');
        assert.ok(performance.now() - started < 1000, 'a busy database blocked the event loop');
        database.exec('ROLLBACK');
        assert.equal((await slowRead).works.length, 0);
    } finally {
        if (database.isTransaction) database.exec('ROLLBACK');
        database.close();
        delete process.env.CONFIG_PATH;
    }
});

test('queue-only writes reuse a snapshot while visible work changes invalidate it', async t => {
    const { readCatalogVersionInWorker } = await import('../util/catalog-reader.ts');
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dy-catalog-version-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'test.db');
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    db.exec(`CREATE TABLE aweme (
        aweme_id TEXT PRIMARY KEY, aweme_type TEXT, title TEXT, author_id TEXT,
        author_name TEXT, author_sec_uid TEXT, create_time INTEGER, file_path TEXT, metadata TEXT);
        INSERT INTO aweme VALUES ('1','video','before','a','author','sec',1,'post/1.mp4','{}');
        CREATE TABLE download_queue (status TEXT); INSERT INTO download_queue VALUES ('pending');`);
    const first = await readCatalogVersionInWorker(root, file);
    assert.equal(first.snapshot?.works[0]?.title, 'before');
    db.exec("UPDATE download_queue SET status='completed'");
    const queue = await readCatalogVersionInWorker(root, file, first.signature);
    assert.equal(queue.signature, first.signature);
    assert.equal(queue.snapshot, undefined, 'must not clone an unchanged full catalog');
    db.exec("UPDATE aweme SET title='after'");
    const changed = await readCatalogVersionInWorker(root, file, first.signature);
    assert.notEqual(changed.signature, first.signature);
    assert.equal(changed.snapshot?.works[0]?.title, 'after');
    db.exec('DELETE FROM aweme');
    const removed = await readCatalogVersionInWorker(root, file, changed.signature);
    assert.equal(removed.snapshot?.works.length, 0);
});
