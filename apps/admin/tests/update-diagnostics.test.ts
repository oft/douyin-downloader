import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Hono } from 'hono';
import { openDatabase } from '../util/db.ts';
import { collectUpdateDiagnostics, requestAuditRetry, requestAuthorRetry } from '../util/update-diagnostics.ts';
import { mountMaintenanceRoutes } from '../util/maintenance-routes.ts';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-diagnostics-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const database = path.join(root, 'works.db');
    const db = openDatabase(database);
    db.exec(`CREATE TABLE library_update_state(target_key TEXT PRIMARY KEY,last_attempt_us INTEGER,status TEXT);
        INSERT INTO library_update_state VALUES('user:first',100,'partial'),('user:active',200,'running');
        CREATE TABLE library_post_audit(scope TEXT PRIMARY KEY,sec_uid TEXT,author TEXT,homepage_total INTEGER,registered_count INTEGER,
        remaining_gap INTEGER,pages INTEGER,received INTEGER,new_works INTEGER,repair_works INTEGER,oldest_time INTEGER,status TEXT,reason TEXT,
        auto_checked INTEGER,retry_requested INTEGER,updated_us INTEGER);
        INSERT INTO library_post_audit VALUES('post:first:${'a'.repeat(64)}','first','作者',100,80,20,4,80,0,0,100,'budget','历史待复核',1,0,1000);`);
    db.close();
    return { root, database };
}

test('diagnostics correlate author phases and distinguish old unknown counts from zero', async t => {
    const { root, database } = await fixture(t);
    const directory = path.join(root, 'logs/library-update'); await mkdir(directory, { recursive: true });
    const events = [
        { event: 'author_start', url: 'https://www.douyin.com/user/first', time: '2026-11-26T10:00:00Z' },
        { event: 'author_identified', author: '作者' },
        { event: 'post_incremental_policy', localSaved: 80, total: 100, allowPageStop: false },
        { event: 'post_page', remainingGap: 20, reason: 'missing_work_gap', received: 20, newWorks: 0 },
        { event: 'author_finished', elapsedMs: 90000, success: 0, skipped: 20, status: 'partial', reason: 'history_budget' },
        { event: 'author_start', url: 'https://www.douyin.com/user/legacy', time: '2026-11-26T11:00:00Z' },
        { event: 'author_finished', elapsedMs: 1500, success: 1, items: 1 },
    ];
    await writeFile(path.join(directory, '20261126T100000Z-999999.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n{partial');
    await writeFile(path.join(directory, 'ignore.jsonl'), 'not a session');
    const report = await collectUpdateDiagnostics(root, database, { state: 'completed' });
    assert.equal(report.files, 1); assert.equal(report.invalidLines, 1);
    assert.equal(report.authors[0].newWorks, null);
    assert.equal(report.authors[1].state, 'partial'); assert.equal(report.authors[1].reason, 'history_budget');
    assert.equal(report.authors[1].targetKey, 'user:first');
    assert.equal(report.authors[1].newWorks, 0); assert.equal(report.authors[1].pages, 1);
    assert.equal(report.audits[0].remaining_gap, 20);
    assert.equal(report.slowest[0].elapsedMs, 90000);
});

test('manual retry marks existing records only and does not interrupt active authors', async t => {
    const { database } = await fixture(t);
    requestAuditRetry(database, 'post:first:' + 'a'.repeat(64));
    requestAuthorRetry(database, 'user:first');
    assert.throws(() => requestAuthorRetry(database, 'user:active'));
    assert.throws(() => requestAuthorRetry(database, 'user:unknown'));
    const db = openDatabase(database, true);
    try {
        assert.equal((db.prepare('SELECT retry_requested FROM library_post_audit').get() as { retry_requested: number }).retry_requested, 1);
        assert.deepEqual({ ...db.prepare("SELECT last_attempt_us,status FROM library_update_state WHERE target_key='user:first'").get()! }, { last_attempt_us: 0, status: 'queued' });
        assert.equal((db.prepare("SELECT status FROM library_update_state WHERE target_key='user:active'").get() as { status: string }).status, 'running');
    } finally { db.close(); }
});

test('opening diagnostics reads saved report only; refresh is a separate explicit action', async t => {
    const { root, database } = await fixture(t);
    const saved = path.join(root, 'library-diagnostics.json');
    await writeFile(saved, JSON.stringify({ checkedAt: 'cached-only', authors: [] }));
    const app = new Hono();
    mountMaintenanceRoutes(app, { root, database, config: path.join(root, 'config.yml') }, {
        busy: () => false, onChanged: () => {}, updateStatus: () => ({ state: 'completed' }),
    });
    const result = await app.request('http://localhost/api/catalog/maintenance/diagnostics');
    assert.equal(result.status, 200);
    assert.equal((await result.json()).report.checkedAt, 'cached-only');
    assert.equal(JSON.parse(await readFile(saved, 'utf8')).checkedAt, 'cached-only');
    const bad = await app.request('http://localhost/api/catalog/maintenance/diagnostics/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'unknown' }),
    });
    assert.equal(bad.status, 400);
    const good = await app.request('http://localhost/api/catalog/maintenance/diagnostics/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'post:first:' + 'a'.repeat(64) }),
    });
    assert.equal(good.status, 200);
});
