import './io-audit-bootstrap.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { indexLibrary } from './transfer-index.ts';
import { serveLibrary } from './transfer-service.ts';
import { executeImport, previewImport } from './transfer-import.ts';
import { validateManifest } from './transfer-protocol.ts';
import type { ImportOptions, LibraryLocation, RemoteSource, TransferSelection, TransferStatus } from './transfer-types.ts';

const input = parentPort ? undefined : createInterface({ input: process.stdin });
let resolveStart: (value: unknown) => void;
const start = new Promise<unknown>(resolve => { resolveStart = resolve; });
input?.on('line', line => {
    try {
        const message = JSON.parse(line);
        if (message.type === 'start') resolveStart(message.data);
        else void receive(message);
    } catch { /* Ignore malformed process protocol messages. */ }
});
const close = () => { parentPort?.close(); input?.close(); if (input) process.stdin.destroy(); };
const request = (parentPort ? workerData : await start) as { kind: 'share' | 'preview' | 'import'; location: LibraryLocation;
    code?: string; port?: number; idleMs?: number; selection?: TransferSelection; source?: RemoteSource; planId?: string; options?: ImportOptions };
const abort = new AbortController();
let sharing: Awaited<ReturnType<typeof serveLibrary>> | undefined;
const send = (status: Partial<TransferStatus>) => {
    if (parentPort) parentPort.postMessage(status); else process.stdout.write(JSON.stringify(status) + '\n');
};
const progress = (value: TransferStatus['progress']) => send({ progress: value });
async function receive(message: { type?: string }) {
    if (message?.type !== 'stop') return;
    abort.abort();
    if (sharing) { await sharing.close(); close(); }
}
parentPort?.on('message', receive);

try {
    send({ state: 'running' });
    if (request.kind === 'share') {
        const index = await indexLibrary(request.location, { ...request.selection, hash: true }, progress, abort.signal);
        validateManifest(index.manifest);
        abort.signal.throwIfAborted();
        sharing = await serveLibrary(index, await import('node:fs/promises').then(fs => fs.realpath(request.location.root)), request.code!, {
            port: request.port, idleMs: request.idleMs,
            onStopped: () => { send({ state: 'stopped', finishedAt: new Date().toISOString() }); close(); },
        });
        send({ state: 'ready', addresses: sharing.addresses, expiresAt: sharing.expiresAt(), snapshotId: index.manifest.snapshotId, unassigned: index.manifest.unassigned,
            counts: { authors: index.manifest.authors.length, links: index.manifest.links.length, works: index.manifest.works.length,
                files: index.manifest.files.length, bytes: index.manifest.files.reduce((sum, f) => sum + f.size, 0), unassignedFiles: index.manifest.unassignedFiles } });
    } else if (request.kind === 'preview') {
        const plan = await previewImport(request.location, request.source!, progress, abort.signal);
        const files = new Map(plan.manifest.files.map(file => [file.id, file]));
        send({ state: 'ready', preview: { id: plan.id, counts: plan.counts, unassigned: plan.manifest.unassigned, conflicts: plan.actions.filter(a => a.action === 'conflict').slice(0, 100)
            .map(action => ({ workId: action.workId, name: files.get(action.fileId)!.name, reason: action.reason ?? '保留本地文件' })) } });
        close();
    } else {
        const result = await executeImport(request.location, request.source!, request.planId!, request.options, progress, abort.signal);
        send({ state: 'completed', result, finishedAt: new Date().toISOString() });
        close();
    }
} catch (error) {
    const secret = request.source?.code ?? request.code;
    let message = error instanceof Error ? error.message : '分享或导入任务失败';
    if (message === 'fetch failed') message = '无法连接分享服务，请确认地址、端口及服务状态；已有断点已保留';
    if (error instanceof Error && error.name === 'TimeoutError') message = '连接或传输超时，已有断点已保留，可稍后继续';
    send({ state: abort.signal.aborted ? 'stopped' : 'failed', finishedAt: new Date().toISOString(),
        ...(!abort.signal.aborted ? { error: (secret ? message.split(secret).join('[分享码]') : message).slice(0, 500) } : {}) });
    await sharing?.close(); close();
}
