// CPU and transfer baseline, no real database or media writes.
import { readDatabaseCatalog } from '../util/catalog.ts';
import { CatalogSession, applyCatalogPatch } from '../util/catalog-session.ts';
import type { WorkRow } from '../util/db.ts';

const count = Number(process.env.BENCH_WORKS ?? 30000);
const runs = Number(process.env.BENCH_SAMPLES ?? 8);
const authors = Number(process.env.BENCH_AUTHORS ?? 100);
if (![count, runs, authors].every(Number.isSafeInteger) || count < 100 || runs < 2 || authors < 1) throw new Error('Invalid benchmark size');
const rows: WorkRow[] = Array.from({ length: count }, (_, i) => ({
    aweme_id: String(7400000000000000000n + BigInt(i)), aweme_type: 'video', title: `作品 ${i}`,
    author_id: `a${i % authors}`, author_sec_uid: `s${i % authors}`, author_name: `作者 ${i % authors}`,
    create_time: 1700000000 + i, download_time: 1700000000 + i,
    file_path: `author${i % authors}/post/${i}/${i}.mp4`, image_count: 0,
    metadata_path: null, cover_path: null, avatar_path: null,
}));
const result: Record<string, unknown> = {};
function measure<T>(name: string, action: (i: number) => T, inspect?: (value: T) => void) {
    const times = [];
    for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const value = action(i);
        times.push(performance.now() - start);
        inspect?.(value);
    }
    times.sort((a, b) => a - b);
    result[name] = { p50Ms: +times[Math.floor(runs / 2)]!.toFixed(2), p95Ms: +times[Math.min(runs - 1, Math.ceil(runs * .95) - 1)]!.toFixed(2), samples: runs };
}
measure('assembly', () => { readDatabaseCatalog('/media', 'unused', rows); });
const session = new CatalogSession();
const initial = session.update('/media', 'unused', rows);
if (!('snapshot' in initial)) throw new Error('Missing initial snapshot');
let snapshot = structuredClone(initial.snapshot);
measure('coldClone', () => { structuredClone(initial.snapshot); });
measure('unchanged', () => { session.update('/media', 'unused', rows.map(row => ({ ...row }))); });
const bytes: number[] = [];
measure('titleEdit', i => {
    rows[0] = { ...rows[0]!, title: `changed ${i}` };
    const update = session.update('/media', 'unused', rows.map(row => ({ ...row })));
    if (!('patch' in update)) throw new Error('Missing patch');
    const patch = structuredClone(update.patch);
    snapshot = applyCatalogPatch(snapshot, patch);
    if (!snapshot.works.some(work => work.title === `changed ${i}`)) throw new Error('Lost update');
    return update.patch;
}, patch => bytes.push(Buffer.byteLength(JSON.stringify(patch))));
console.log(JSON.stringify({ fixture: { works: count, authors, offline: true }, runtime: process.version, results: result,
    titlePatchBytes: { min: Math.min(...bytes), max: Math.max(...bytes) },
    memoryMiB: Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, value]) => [key, +(value / 1048576).toFixed(1)])) }, null, 2));
