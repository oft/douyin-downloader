import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createVideoServer } from '../server.mjs';
import { formatTime, mediaUrl, nextPage, playableWorks, readSaved, readMuted, workParams } from '../public/feed.js';

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves the app and exposes only fixed read-only catalog/media routes', async t => {
  const calls = [];
  const upstream = createServer((req, res) => {
    calls.push({ path: req.url, method: req.method, range: req.headers.range, cookie: req.headers.cookie });
    if (req.url === '/media/clip') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-4/8', 'Accept-Ranges': 'bytes', 'Content-Length': '3' });
      return res.end('cde');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: [{ id: 'work1', kind: 'video', video: 'clip' }], page: 1, pages: 1, total: 1 }));
  });
  const libraryUrl = await listen(upstream, t);
  const base = await listen(createVideoServer({ libraryUrl }), t);
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /上下滑动切换视频/);
  assert.match(home.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  for (const file of ['styles.css', 'app.js', 'feed.js', 'icon.svg', 'manifest.webmanifest']) {
    assert.equal((await fetch(`${base}/${file}`)).status, 200);
  }
  const list = await fetch(`${base}/api/catalog/works?kind=video&page=3`, { headers: { cookie: 'private=value' } });
  assert.equal((await list.json()).items[0].video, 'clip');
  assert.equal(calls[0].path, '/api/catalog/works?kind=video&page=3');
  assert.equal(calls[0].cookie, undefined);
  const range = await fetch(`${base}/media/clip`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), 'bytes 2-4/8');
  assert.equal(await range.text(), 'cde');
  assert.equal(calls[1].range, 'bytes=2-4');
  const head = await fetch(`${base}/media/clip`, { method: 'HEAD' });
  assert.equal(head.status, 206);
  assert.equal(await head.text(), '');
  assert.equal(calls[2].method, 'HEAD');
  for (const route of ['/api/catalog/links', '/api/catalog/update', '/api/catalog/authors/id/links', '/server.mjs', '/%2e%2e/config.yml', '//example.com/media/clip']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(`${base}/api/catalog/works/work1`, { method: 'DELETE' })).status, 405);
  assert.equal(calls.length, 3);
  assert.equal((await fetch(`${base}/api/activity`)).status, 204);
});

test('handles offline upstream and rejects unsafe upstream configuration', async t => {
  for (const libraryUrl of ['file:///etc/passwd', 'http://user:secret@localhost/', 'http://localhost/path', 'http://localhost/?key=value']) {
    assert.throws(() => createVideoServer({ libraryUrl }));
  }
  const offline = createServer();
  offline.listen(0, '127.0.0.1'); await once(offline, 'listening');
  const libraryUrl = `http://127.0.0.1:${offline.address().port}`;
  await new Promise(resolve => offline.close(resolve));
  const base = await listen(createVideoServer({ libraryUrl }), t);
  const response = await fetch(`${base}/api/catalog/works`);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /无法连接资料库/);
});

test('stops when idle, while requests and visible-page heartbeats extend the lifetime', async t => {
  const server = createVideoServer({ idleMs: 160 });
  const base = await listen(server, t);
  for (let i = 0; i < 4; i++) {
    await delay(85);
    assert.equal((await fetch(`${base}/api/activity`)).status, 204);
  }
  assert.equal(server.listening, true);
  const closed = once(server, 'close');
  await closed;
  assert.equal(server.listening, false);
});

test('does not stop a media response during a long stream', async t => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.write('first');
    setTimeout(() => res.end('last'), 230);
  });
  const libraryUrl = await listen(upstream, t);
  const viewer = createVideoServer({ libraryUrl, idleMs: 100 });
  const base = await listen(viewer, t);
  const response = await fetch(`${base}/media/clip`);
  await delay(150);
  assert.equal(viewer.listening, true);
  assert.equal(await response.text(), 'firstlast');
});

test('pagination wraps once for recommendations; corrupt favorites and missing files are safe', () => {
  assert.equal(nextPage(3, 4, true), 4);
  assert.equal(nextPage(4, 4, true), 1);
  assert.equal(nextPage(4, 4, false), null);
  assert.equal(nextPage(1, 1, true), null);
  assert.deepEqual(playableWorks([{ kind: 'video', video: 'a' }, { kind: 'video' }, { kind: 'album' }]), [{ kind: 'video', video: 'a' }]);
  assert.equal(mediaUrl('unsafe/id'), '/media/unsafe%2Fid');
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(Infinity), '0:00');
  assert.deepEqual(readSaved(undefined), []);
  assert.deepEqual(readSaved({ getItem: () => '{broken' }), []);
  assert.deepEqual(readSaved({ getItem: () => '["id1", "id1", 12, "../private"]' }), ['id1']);
  assert.equal(workParams({ page: 2, query: '标题&作者', author: 'id1' }).get('q'), '标题&作者');
});

test('sound choice distinguishes first visit from an explicit mute and handles disabled storage', () => {
  assert.equal(readMuted(undefined), null);
  assert.equal(readMuted({ getItem: () => null }), null);
  assert.equal(readMuted({ getItem: () => 'true' }), true);
  assert.equal(readMuted({ getItem: () => 'false' }), false);
  assert.equal(readMuted({ getItem: () => 'broken' }), null);
  assert.equal(readMuted({ getItem: () => { throw new Error('disabled'); } }), null);
});
