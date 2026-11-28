// Reproducible, offline benchmark. Only writes its own temporary fixture.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const count = Number(process.env.BENCH_WORKS ?? 30000);
const samples = Number(process.env.BENCH_SAMPLES ?? 12);
const mutations = Number(process.env.BENCH_MUTATIONS ?? 3);
if (!Number.isSafeInteger(count) || count < 100 || !Number.isSafeInteger(samples) || samples < 2 || !Number.isSafeInteger(mutations) || mutations < 2) throw new Error('Invalid benchmark size');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'dy-benchmark-'));
const root = path.join(temporary, 'media');
await mkdir(root);
const file = path.join(temporary, 'fixture.db');
const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE aweme (
    aweme_id TEXT PRIMARY KEY, aweme_type TEXT, title TEXT, author_id TEXT, author_name TEXT,
    author_sec_uid TEXT, create_time INTEGER, download_time INTEGER, file_path TEXT,
    image_count INTEGER, metadata_path TEXT, cover_path TEXT, avatar_path TEXT);
    CREATE TABLE download_queue (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO download_queue VALUES (1,'pending')`);
const insert = db.prepare('INSERT INTO aweme VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < count; i++) {
    const id = String(7400000000000000000n + BigInt(i));
    const stored = `author${i % 100}/post/${id}/${id}.mp4`;
    insert.run(id, 'video', `作品 ${i}`, `a${i % 100}`, `作者 ${i % 100}`, `s${i % 100}`,
        1700000000 + i, 1700000000 + i, stored, 0, null, null, null);
}
db.exec('COMMIT');
// Materialize a complete first page while keeping large-catalog setup inexpensive.
for (let i = count - 24; i < count; i++) {
    const id = String(7400000000000000000n + BigInt(i));
    const directory = path.join(root, `author${i % 100}`, 'post', id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.mp4`), Buffer.alloc(65536));
    await writeFile(path.join(directory, `${id}_cover.jpg`), 'fixture-cover');
}
const config = path.join(temporary, 'config.yml');
await writeFile(config, `path: ${root}\ndatabase_path: ${file}\n`);
process.env.CONFIG_PATH = config;
const { app } = await import('../index.ts');
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
const results: Record<string, unknown> = {};
async function request(route: string, headers = {}) {
    const response = await app.request(`http://localhost${route}`, { headers });
    const body = await response.arrayBuffer();
    if (!response.ok) throw new Error(`${route}: ${response.status}`);
    return { bytes: body.byteLength, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(Buffer.from(body).toString()) : null };
}
async function measure(name: string, route: string, before?: (i: number) => void, headers = {}, runs = samples) {
    const times = [];
    let bytes = 0;
    delay.reset();
    for (let i = 0; i < runs; i++) {
        before?.(i);
        const started = performance.now();
        bytes = (await request(route, headers)).bytes;
        times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    results[name] = { p50Ms: +times[Math.floor(times.length * .5)]!.toFixed(2),
        p95Ms: +times[Math.min(times.length - 1, Math.ceil(times.length * .95) - 1)]!.toFixed(2),
        maxLoopDelayMs: +(delay.max / 1e6).toFixed(2), bytes, samples: runs };
}
try {
    await measure('coldCatalog', '/api/catalog/status', undefined, {}, 1);
    const first = (await request('/api/catalog/works?size=12')).data.items[0];
    await measure('status', '/api/catalog/status');
    await measure('works', '/api/catalog/works?size=12');
    await measure('summary', '/api/catalog/works?size=12&summary=1');
    await measure('authors', '/api/catalog/authors?size=24');
    await measure('authorWorks', `/api/catalog/works?author=${first.authorId}&size=12`);
    await measure('search', '/api/catalog/works?q=作品%202999&size=12');
    await measure('detail', `/api/catalog/works/${first.id}`);
    await measure('mediaRange', `/media/${first.video}`, undefined, { Range: 'bytes=0-1023' });
    await measure('queueWrites', '/api/catalog/status', i => db.prepare('UPDATE download_queue SET status=?').run(String(i)));
    await measure('workWrites', '/api/catalog/status', i => db.prepare('UPDATE aweme SET title=? WHERE aweme_id=?').run(`changed ${i}`, first.platformId), {}, mutations);
    const concurrentTimes = [];
    for (let i = 0; i < samples; i++) {
        const started = performance.now();
        await Promise.all(Array.from({ length: 8 }, () => request('/api/catalog/works?size=12')));
        concurrentTimes.push(performance.now() - started);
    }
    concurrentTimes.sort((a, b) => a - b);
    results['concurrent8'] = { p50Ms: +concurrentTimes[Math.floor(samples * .5)]!.toFixed(2),
        p95Ms: +concurrentTimes[Math.min(samples - 1, Math.ceil(samples * .95) - 1)]!.toFixed(2), samples };
    console.log(JSON.stringify({ fixture: { works: count, authors: 100, materializedWorks: 24, offline: true },
        runtime: process.version, platform: `${process.platform}/${process.arch}`, results,
        memoryMiB: Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, +(v / 1048576).toFixed(1)])) }, null, 2));
} finally { delay.disable(); db.close(); await rm(temporary, { recursive: true, force: true }); }
