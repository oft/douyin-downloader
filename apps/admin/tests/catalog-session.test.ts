import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { CatalogSession, applyCatalogPatch } from '../util/catalog-session.ts';
import { readDatabaseCatalog } from '../util/catalog.ts';
import type { DatabaseCatalog } from '../util/catalog.ts';
import type { WorkRow } from '../util/db.ts';
import { CatalogReader } from '../util/catalog-reader.ts';

function row(id: string, author = 'a'): WorkRow {
    return { aweme_id: id, aweme_type: 'video', title: `work ${id}`, author_id: author,
        author_sec_uid: author, author_name: `author ${author}`, create_time: 100, download_time: 200,
        file_path: `post/${id}.mp4`, image_count: 0, metadata_path: null, cover_path: null, avatar_path: null };
}

// Compare every public field and derived map to a fresh rebuild, excluding the clock.
function normalized(snapshot: DatabaseCatalog) { return { ...snapshot, scannedAt: '' }; }

test('incremental author groups remain equivalent to full rebuilds and preserve old snapshots', () => {
    const session = new CatalogSession();
    const root = '/library';
    let rows = [row('1'), row('2'), row('3', 'b'), row('4', '')];
    let snapshot: DatabaseCatalog;
    function check(next: WorkRow[]) {
        const previous = snapshot;
        const previousValue = previous && structuredClone(normalized(previous));
        const update = session.update(root, 'fixture.db', next);
        snapshot = 'snapshot' in update ? update.snapshot : 'patch' in update ? applyCatalogPatch(snapshot, update.patch) : snapshot;
        assert.deepEqual(normalized(snapshot), normalized(readDatabaseCatalog(root, 'fixture.db', next)));
        if (previous) assert.deepEqual(normalized(previous), previousValue, 'a request holding the old snapshot must see stable data');
        rows = next;
        return update;
    }
    check(rows);
    assert.ok('unchanged' in check(rows.map(item => ({ ...item }))));
    const unaffected = snapshot!.workById;
    const beforeB = snapshot!.works.find(work => work.platformId === '3');
    check(rows.map(item => item.aweme_id === '1' ? { ...item, title: 'renamed', author_name: 'new alias', create_time: 1000, avatar_path: 'avatar.jpg' } : item));
    assert.strictEqual(snapshot!.works.find(work => work.platformId === '3'), beforeB);
    assert.notStrictEqual(snapshot!.workById, unaffected);
    check([...rows, { ...row('5'), download_time: 900 }]);
    check(rows.map(item => item.aweme_id === '2' ? { ...item, author_sec_uid: 'b', author_name: 'joined b' } : item));
    check(rows.filter(item => item.aweme_id !== '3'));
    check(rows.map(item => item.aweme_id === '4' ? { ...item, author_sec_uid: 'c', author_name: 'identified' } : item));
    check(rows.map(item => item.aweme_id === '5' ? { ...item, file_path: '../outside.mp4' } : item));
    check(rows.map(item => item.aweme_id === '5' ? { ...item, file_path: 'post/5.mp4' } : item));
    // Reordering equal-time entries can change which author name wins; preserve DB input order.
    check([...rows].reverse());
    check([]);
    check([row('6', ''), { ...row('7', ''), file_path: '../invalid.mp4' }]);
    check([{ ...row('6', ''), aweme_type: 'gallery', image_count: 3 }]);
    const switched = session.update('/other-root', 'fixture.db', rows);
    assert.ok('snapshot' in switched, 'a changed media root must start with a full snapshot');
});

test('persistent reader refreshes inserts/updates/deletes, serializes callers and recovers from failure', async t => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dy-session-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = path.join(root, 'test.db');
    const reader = new CatalogReader();
    t.after(() => reader.close());
    await assert.rejects(reader.read(root, file));
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    db.exec(`CREATE TABLE aweme (
        aweme_id TEXT PRIMARY KEY, aweme_type TEXT, title TEXT, author_id TEXT,
        author_name TEXT, author_sec_uid TEXT, create_time INTEGER, file_path TEXT, metadata TEXT);
        INSERT INTO aweme VALUES ('1','video','before','a','author','sec',1,'post/1.mp4','{}');`);
    const first = await reader.read(root, file);
    assert.equal(first.works[0]!.title, 'before');
    assert.strictEqual(await reader.read(root, file), first);
    db.exec("UPDATE aweme SET title='after'");
    const [a, b] = await Promise.all([reader.read(root, file), reader.read(root, file)]);
    assert.strictEqual(a, b);
    assert.equal(a.works[0]!.title, 'after');
    assert.equal(first.works[0]!.title, 'before');
    reader.close();
    assert.equal((await reader.read(root, file)).works[0]!.title, 'after');
    db.exec('DELETE FROM aweme');
    assert.equal((await reader.read(root, file)).works.length, 0);
    const other = await reader.read(path.join(root, 'other'), file);
    assert.equal(other.root, path.join(root, 'other'));
});

test('mixed edits match the full catalog across repeated author renames and moves', () => {
    const session = new CatalogSession();
    let rows: WorkRow[] = Array.from({ length: 40 }, (_, i) => ({ ...row(String(i), `a${i % 5}`), create_time: i % 7 }));
    let snapshot: DatabaseCatalog | undefined;
    for (let step = 0; step < 60; step++) {
        const index = (step * 17) % rows.length;
        if (step % 6 === 0) rows.push(row(`new${step}`, `a${step % 5}`));
        else if (step % 6 === 1) rows = rows.filter((_, i) => i !== index);
        else rows = rows.map((item, i) => i === index ? { ...item,
            author_sec_uid: step % 4 === 0 ? '' : `a${step % 5}`, author_id: step % 4 === 0 ? '' : item.author_id,
            author_name: `alias${step}`, create_time: step % 11, download_time: step,
            file_path: step % 9 === 0 ? '../outside.mp4' : item.file_path,
            avatar_path: step % 3 === 0 ? 'avatar.jpg' : null } : item);
        // Mirror readWorks' deterministic ordering, including equal timestamps.
        rows.sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0) || a.aweme_id.localeCompare(b.aweme_id));
        const update = session.update('/library', 'fixture.db', rows);
        snapshot = 'snapshot' in update ? update.snapshot : 'patch' in update ? applyCatalogPatch(snapshot!, update.patch) : snapshot;
        assert.deepEqual(normalized(snapshot!), normalized(readDatabaseCatalog('/library', 'fixture.db', rows)), `edit ${step}`);
    }
});

test('a title edit in a large author sends one work and preserves unchanged media references', () => {
    const session = new CatalogSession();
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...row(String(i)), create_time: i }));
    const first = session.update('/library', 'fixture.db', rows);
    assert.ok('snapshot' in first);
    const before = first.snapshot;
    const unchanged = before.works.find(work => work.platformId === '1')!;
    const update = session.update('/library', 'fixture.db', rows.map(item => item.aweme_id === '0' ? { ...item, title: 'edited' } : { ...item }));
    assert.ok('patch' in update);
    assert.equal(update.patch.works.length, 1);
    assert.equal(update.patch.rows.length, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(update.patch)) < 4000, 'a single edit must not resend the entire author');
    const after = applyCatalogPatch(before, structuredClone(update.patch));
    assert.strictEqual(after.workById.get(unchanged.id), unchanged);
    const author = after.authors[0]!;
    assert.strictEqual(after.avatarWorks.get(author.id), after.workById.get(after.avatarWorks.get(author.id)!.id));
    assert.deepEqual(normalized(after), normalized(readDatabaseCatalog('/library', 'fixture.db', rows.map(item => item.aweme_id === '0' ? { ...item, title: 'edited' } : item))));
    assert.equal(before.works.find(work => work.platformId === '0')!.title, 'work 0');
});


test('mutating caller rows in place cannot reuse stale memoized work metadata', () => {
    const session = new CatalogSession();
    const rows = [row('1')];
    const first = session.update('/library', 'fixture.db', rows);
    assert.ok('snapshot' in first);
    rows[0]!.title = 'mutated title';
    rows[0]!.file_path = 'post/new.mp4';
    const update = session.update('/library', 'fixture.db', rows);
    assert.ok('patch' in update);
    const after = applyCatalogPatch(first.snapshot, update.patch);
    assert.deepEqual(normalized(after), normalized(readDatabaseCatalog('/library', 'fixture.db', rows)));
    assert.equal(first.snapshot.works[0]!.title, 'work 1');
});
