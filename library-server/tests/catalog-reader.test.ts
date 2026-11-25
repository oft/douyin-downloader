import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { readCatalogInWorker } from '../util/catalog-reader.ts';

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
        const slowRead = readCatalogInWorker(downloads, databaseFile);
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
