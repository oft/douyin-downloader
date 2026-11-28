import './io-audit-bootstrap.ts';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { readDatabaseCatalog } from './catalog.ts';
import { readWorks } from './db.ts';
import { CatalogSession } from './catalog-session.ts';

if (workerData.kind === 'session') {
    const session = new CatalogSession();
    parentPort!.on('message', ({ root, databaseFile }) => {
        try { parentPort!.postMessage({ data: session.update(root, databaseFile, readWorks(databaseFile)) }); }
        catch (error) {
            const failure = error as NodeJS.ErrnoException;
            parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
        }
    });
} else try {
    const rows = readWorks(workerData.databaseFile);
    if (workerData.kind === 'versioned') {
        // Queue/retry bookkeeping changes the WAL too. Only visible work columns invalidate browsing.
        const signature = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        parentPort!.postMessage({ data: { signature,
            ...(signature === workerData.signature ? {} : { snapshot: readDatabaseCatalog(workerData.root, workerData.databaseFile, rows) }) } });
    } else {
        parentPort!.postMessage({ data: workerData.kind === 'rows' ? rows
            : readDatabaseCatalog(workerData.root, workerData.databaseFile, rows) });
    }
} catch (error) {
    const failure = error as NodeJS.ErrnoException;
    parentPort!.postMessage({ error: { message: failure.message, code: failure.code } });
}
