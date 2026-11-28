import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readLibraryConfig } from '../util/config.ts';
import { readConfigLinks, saveConfigLinks } from '../util/config-links.ts';

test('library resolves paths from the downloader config directory', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-config-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.yml');
    await writeFile(config, "path: './my media'\ndatabase_path: './data/catalog.db'\n");
    const loaded = readLibraryConfig(config, {});
    assert.equal(loaded.downloadRoot, path.join(root, 'my media'));
    assert.equal(loaded.databaseFile, path.join(root, 'data', 'catalog.db'));
});

test('explicit environment paths override configuration', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-config-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.yml');
    await writeFile(config, "path: './original'\ndatabase_path: './data/original.db'\n");
    const media = path.join(root, 'override');
    const database = path.join(root, 'override.db');
    const loaded = readLibraryConfig(config, { DOWNLOAD_ROOT: media, DATABASE_PATH: database });
    assert.equal(loaded.downloadRoot, media);
    assert.equal(loaded.databaseFile, database);
});

test('link management updates only link in the active config and detects stale edits', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-links-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.yml');
    const before = '# before\r\npath: ./media\r\n';
    const after = '\r\n# keep existing settings\r\ncookie: "fixture-only"\r\nthread: 5\r\n';
    await writeFile(config, before + 'link: # download order\r\n  - https://v.douyin.com/original/\r\n' + after);
    const configured = process.env.CONFIG_PATH;
    process.env.CONFIG_PATH = config;
    t.after(() => {
        if (configured === undefined) delete process.env.CONFIG_PATH;
        else process.env.CONFIG_PATH = configured;
    });

    const { app } = await import('../index.ts');
    const endpoint = 'http://localhost/api/catalog/links';
    const listing = await app.request(endpoint);
    assert.equal(listing.status, 200);
    assert.equal(listing.headers.get('Cache-Control'), 'no-store');
    const initial = await listing.json() as { links: string[]; revision: string };
    assert.deepEqual(Object.keys(initial).sort(), ['links', 'revision']);
    assert.deepEqual(initial.links, ['https://v.douyin.com/original/']);
    assert.equal((await app.request(endpoint, { headers: { Origin: 'https://example.com' } })).status, 403);

    const save = (links: string[], revision: string, origin = 'http://localhost') => app.request(endpoint, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ links, revision }),
    });
    const entries = ['https://v.douyin.com/edit/?a=1#fragment', '抖音分享\nhttps://v.douyin.com/added/'];
    assert.equal((await save(entries, initial.revision, 'https://example.com')).status, 403);
    assert.equal((await save([' '], initial.revision)).status, 400);
    const response = await save(entries, initial.revision);
    assert.equal(response.status, 200);
    const saved = await response.json() as { links: string[]; revision: string };
    assert.deepEqual(saved.links, entries);
    const written = await readFile(config, 'utf8');
    assert.ok(written.startsWith(before + 'link: # download order\r\n'));
    assert.ok(written.endsWith(after));
    assert.deepEqual(readConfigLinks(config).links, entries);
    assert.equal((await save([], initial.revision)).status, 409);
    assert.equal(await readFile(config, 'utf8'), written);

    const latest = written.replace('thread: 5', 'thread: 9');
    await writeFile(config, latest);
    assert.equal((await save([], saved.revision)).status, 200);
    assert.deepEqual(readConfigLinks(config).links, []);
    assert.ok((await readFile(config, 'utf8')).endsWith(after.replace('thread: 5', 'thread: 9')));
});

test('accepts a legacy scalar link and adds an absent field to YAML', async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dy-library-links-legacy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = path.join(root, 'config.yml');
    await writeFile(config, 'link: https://v.douyin.com/old/ # keep\npath: ./media\n');
    const scalar = readConfigLinks(config);
    assert.deepEqual(scalar.links, ['https://v.douyin.com/old/']);
    saveConfigLinks(config, [], scalar.revision);
    assert.equal(await readFile(config, 'utf8'), 'link: [] # keep\npath: ./media\n');

    const withoutLink = '# media settings\npath: ./media\n';
    await writeFile(config, withoutLink);
    const absent = readConfigLinks(config);
    assert.deepEqual(absent.links, []);
    const link = 'https://v.douyin.com/new/';
    saveConfigLinks(config, [link], absent.revision);
    assert.ok((await readFile(config, 'utf8')).startsWith(withoutLink));
    assert.deepEqual(readConfigLinks(config).links, [link]);
});
