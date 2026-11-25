import { parentPort, workerData } from 'node:worker_threads';
import { readDatabaseCatalog } from './catalog.ts';
import { readWorks } from './db.ts';

try {
    parentPort!.postMessage({ data: workerData.kind === 'rows' ? readWorks(workerData.databaseFile)
        : readDatabaseCatalog(workerData.root, workerData.databaseFile) });
} catch (error) {
    const failure = error as NodeJS.ErrnoException;
    parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
}
