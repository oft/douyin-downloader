import { Worker } from 'node:worker_threads';
import type { DatabaseCatalog } from './catalog.ts';
import type { WorkRow } from './db.ts';
import { applyCatalogPatch } from './catalog-session.ts';
import type { CatalogUpdate } from './catalog-session.ts';

// SQLite's synchronous busy wait and full-catalog assembly belong off the HTTP event loop.
function readInWorker<T>(kind: 'catalog' | 'rows' | 'versioned', root: string, databaseFile: string, signature?: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./catalog-worker.ts', import.meta.url), {
            workerData: { kind, root, databaseFile, signature },
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

export function readCatalogVersionInWorker(root: string, databaseFile: string, signature?: string) {
    return readInWorker<{ signature: string; snapshot?: DatabaseCatalog }>('versioned', root, databaseFile, signature);
}

/** One reader per library; queued reads share a worker, which is unreferenced while idle. */
export class CatalogReader {
    private worker?: Worker;
    private snapshot?: DatabaseCatalog;
    private queue: Promise<unknown> = Promise.resolve();

    read(root: string, databaseFile: string): Promise<DatabaseCatalog> {
        const result = this.queue.then(() => this.request(root, databaseFile));
        this.queue = result.catch(() => {});
        return result;
    }

    close() {
        const worker = this.worker;
        this.worker = undefined;
        this.snapshot = undefined;
        if (worker) void worker.terminate();
    }

    private request(root: string, databaseFile: string): Promise<DatabaseCatalog> {
        let worker = this.worker;
        if (!worker) {
            worker = new Worker(new URL('./catalog-worker.ts', import.meta.url), { workerData: { kind: 'session' } });
            this.worker = worker;
            const reset = () => {
                if (this.worker === worker) { this.worker = undefined; this.snapshot = undefined; }
            };
            // Keep an error listener while idle too; a dead worker is recreated on the next read.
            worker.on('error', reset);
            worker.on('exit', reset);
        }
        const activeWorker = worker;
        activeWorker.ref();
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                activeWorker.off('message', message);
                activeWorker.off('error', failed);
                activeWorker.off('exit', exited);
                activeWorker.unref();
            };
            const failed = (error: Error) => {
                cleanup();
                if (this.worker === activeWorker) this.close();
                reject(error);
            };
            const exited = (code: number) => failed(new Error(`作品数据库读取线程退出（${code}）`));
            const message = (result: { data?: CatalogUpdate; error?: { message: string; code?: string } }) => {
                if (result.error) { failed(Object.assign(new Error(result.error.message), { code: result.error.code })); return; }
                try {
                    const update = result.data!;
                    if ('snapshot' in update) this.snapshot = update.snapshot;
                    else if ('patch' in update) this.snapshot = applyCatalogPatch(this.snapshot!, update.patch);
                    if (!this.snapshot) throw new Error('读取线程未返回作品索引');
                    cleanup();
                    resolve(this.snapshot);
                } catch (error) { failed(error as Error); }
            };
            const timer = setTimeout(() => failed(Object.assign(new Error('读取作品数据库超时'), { code: 'ETIMEDOUT' })), 30_000);
            activeWorker.once('message', message);
            activeWorker.once('error', failed);
            activeWorker.once('exit', exited);
            try { activeWorker.postMessage({ root, databaseFile }); } catch (error) { failed(error as Error); }
        });
    }
}
