import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { scanCatalog } from '../util/catalog.ts';
import { deletePermanently, removalPlan } from '../util/library-files.ts';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
    const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dy-removal-')));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'media');
    const stem = '2026-11-01_test_7411111111111111111';
    const directory = path.join(root, 'author', 'post', stem);
    await mkdir(directory, { recursive: true });
    const header = Buffer.alloc(26); header.writeUInt32BE(0x00051607);
    const names = ['_video.mp4', '_cover.jpg', '_avatar.jpg', '_data.json'].map(suffix => stem + suffix);
    for (const name of names) {
        await writeFile(path.join(directory, name), name.endsWith('.json') ? '{}' : 'original data');
        await writeFile(path.join(directory, '._' + name), header);
    }
    const outside = path.join(root, 'unselected.mp4');
    await writeFile(outside, 'keep');
    const databaseFile = path.join(temporary, 'catalog.db');
    const db = new DatabaseSync(databaseFile);
    db.exec(`CREATE TABLE aweme (aweme_id TEXT PRIMARY KEY,aweme_type TEXT,title TEXT,
        author_id TEXT,author_name TEXT,author_sec_uid TEXT,create_time INTEGER,file_path TEXT,metadata TEXT)`);
    db.prepare('INSERT INTO aweme VALUES (?,?,?,?,?,?,?,?,?)').run('7411111111111111111', 'video', 'test', 'uid', 'author', 'sec-author', 1793520000, directory, '{}');
    db.close();
    const catalog = await scanCatalog(root, databaseFile);
    const plan = await removalPlan(catalog, 'authors', [catalog.authors[0]!.id]);
    assert.ok(plan?.view.token);
    return { root, directory, outside, names, plan: plan! };
}

test('AppleDouble files disappearing with their originals do not abort directory removal', async t => {
    const data = await fixture(t);
    let automaticallyRemoved = 0;
    const result = await deletePermanently(data.root, data.plan.units, {
        rmdir,
        async unlink(file) {
            await unlink(file);
            const counterpart = path.join(path.dirname(String(file)), '._' + path.basename(String(file)));
            try { await unlink(counterpart); automaticallyRemoved++; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        },
    });
    assert.equal(automaticallyRemoved, 4);
    assert.equal(result.deletedFiles, 4);
    assert.equal(result.deletedDirectories, 1);
    await assert.rejects(stat(data.directory));
    assert.equal(await readFile(data.outside, 'utf8'), 'keep');
});

test('ordinary missing files still abort with the affected relative path', async t => {
    const data = await fixture(t);
    const entries = data.plan.units[0]!.entries!;
    const reversed = entries.slice().reverse();
    const originals = reversed.filter(entry => !entry.name.startsWith('._'));
    const missing = originals[1]!.name;
    let first = true;
    await assert.rejects(deletePermanently(data.root, data.plan.units, {
        rmdir,
        async unlink(file) {
            await unlink(file);
            if (first) { first = false; await unlink(path.join(data.directory, missing)); }
        },
    }), error => error instanceof Error && error.message.includes('ENOENT') && error.message.includes(missing));
    assert.equal(await readFile(data.outside, 'utf8'), 'keep');
});

test('a dot-underscore filename without the AppleDouble header is not exempt', async t => {
    const data = await fixture(t);
    const fake = path.join(data.directory, '._notes.txt');
    await writeFile(fake, 'ordinary user file');
    const info = await stat(data.directory);
    // Get a fresh real inventory, including the ordinary dot-underscore file.
    const catalogFile = path.join(path.dirname(data.root), 'catalog.db');
    const catalog = await scanCatalog(data.root, catalogFile);
    const plan = (await removalPlan(catalog, 'authors', [catalog.authors[0]!.id]))!;
    assert.ok(info.isDirectory() && plan.view.token);
    let removed = false;
    await assert.rejects(deletePermanently(data.root, plan.units, {
        rmdir,
        async unlink(file) {
            await unlink(file);
            if (!removed && !path.basename(String(file)).startsWith('._')) {
                await unlink(fake); removed = true;
            }
        },
    }), /ENOENT/);
});

test('a replacement symlink is rejected even if its original was AppleDouble', async t => {
    if (process.platform === 'win32') { t.skip('Creating symlinks requires Windows developer privileges'); return; }
    const data = await fixture(t);
    const first = data.plan.units[0]!.entries!.slice().reverse().find(entry => !entry.name.startsWith('._'))!;
    const metadata = path.join(data.directory, '._' + first.name);
    await assert.rejects(deletePermanently(data.root, data.plan.units, {
        rmdir,
        async unlink(file) {
            await unlink(file);
            if (path.basename(String(file)) === first.name) {
                await unlink(metadata);
                await symlink(data.outside, metadata);
            }
        },
    }), /已被替换/);
    assert.equal(await readFile(data.outside, 'utf8'), 'keep');
});

test('AppleDouble disappearance between lstat and unlink is also tolerated', async t => {
    const data = await fixture(t);
    const result = await deletePermanently(data.root, data.plan.units, {
        rmdir,
        async unlink(file) {
            await unlink(file);
            if (path.basename(String(file)).startsWith('._')) {
                throw Object.assign(new Error('Metadata disappeared during unlink'), { code: 'ENOENT' });
            }
        },
    });
    assert.equal(result.deletedFiles, 4);
    assert.equal(result.deletedDirectories, 1);
});

test('replacing the root during deletion is not reported as successful', async t => {
    const data = await fixture(t);
    const previousRoot = data.root + '-previous';
    await assert.rejects(deletePermanently(data.root, data.plan.units, {
        unlink,
        async rmdir(directory) {
            await rmdir(directory);
            if (String(directory) === data.directory) {
                await rename(data.root, previousRoot);
                await mkdir(data.root);
            }
        },
    }), /下载根目录已被替换/);
    assert.equal(await readFile(path.join(previousRoot, 'unselected.mp4'), 'utf8'), 'keep');
});
