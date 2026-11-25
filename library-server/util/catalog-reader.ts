import { Worker } from 'node:worker_threads';
import type { DatabaseCatalog } from './catalog.ts';
import type { WorkRow } from './db.ts';

// SQLite's synchronous busy wait and full-catalog assembly belong off the HTTP event loop.
function readInWorker<T>(kind: 'catalog' | 'rows', root: string, databaseFile: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./catalog-worker.ts', import.meta.url), {
            workerData: { kind, root, databaseFile },
        });
        let answered = false;
        const timer = setTimeout(() => {
            void worker.terminate();
            reject(Object.assign(new Error('读取作品数据库超时'), { code: 'ETIMEDOUT' }));
        }, 30_000);
        worker.once('message', result => {
            answered = true;
            clearTimeout(timer);
            if (result.error) reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
            else resolve(result.data);
        });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', code => {
            clearTimeout(timer);
            if (!answered) reject(new Error(`作品数据库读取线程退出（${code}）`));
        });
    });
}

export function readCatalogInWorker(root: string, databaseFile: string) {
    return readInWorker<DatabaseCatalog>('catalog', root, databaseFile);
}

export function readRowsInWorker(databaseFile: string) {
    return readInWorker<WorkRow[]>('rows', '', databaseFile);
}
