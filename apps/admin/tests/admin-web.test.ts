import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { mountAdminWeb } from '../util/admin-web.ts';

test('serves the built admin SPA without intercepting API or media requests', async t => {
    const dist = await mkdtemp(path.join(os.tmpdir(), 'dy-admin-web-'));
    t.after(() => rm(dist, { recursive: true, force: true }));
    const app = new Hono();
    app.get('/api/status', c => c.json({ ok: true }));
    app.get('/media/demo', c => c.text('media'));
    app.get('/assets/demo', c => c.text('legacy media'));
    mountAdminWeb(app, dist);
    assert.equal((await app.request('/')).status, 503);
    await writeFile(path.join(dist, 'index.html'), '<script type="module" src="/_admin/index-test.js"></script>');
    await mkdir(path.join(dist, '_admin'));
    await writeFile(path.join(dist, '_admin', 'index-test.js'), 'export {};');
    for (const url of ['/', '/index.html']) {
        const index = await app.request(url);
        assert.equal(index.status, 200);
        assert.equal(index.headers.get('Cache-Control'), 'no-cache');
        assert.match(await index.text(), /\/_admin\/index-test.js/);
    }
    const script = await app.request('/_admin/index-test.js');
    assert.equal(script.status, 200);
    assert.match(script.headers.get('Content-Type') ?? '', /^text\/javascript/);
    assert.match(script.headers.get('Cache-Control') ?? '', /immutable/);
    assert.equal((await app.request('/_admin/missing.js')).status, 404);
    assert.equal((await app.request('/_admin/..%2findex.html')).status, 404);
    assert.deepEqual(await (await app.request('/api/status')).json(), { ok: true });
    assert.equal(await (await app.request('/media/demo')).text(), 'media');
    assert.equal(await (await app.request('/assets/demo')).text(), 'legacy media');
});
