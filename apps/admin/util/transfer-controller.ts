import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { transferDirectory } from './transfer-import.ts';
import { remoteSource } from './transfer-protocol.ts';
import type { ImportOptions, LibraryLocation, RemoteSource, TransferSelection, TransferStatus } from './transfer-types.ts';

/** Older Windows Bun has inconsistent file/HTTP worker semantics; run transfers in Node. */
class NodeTransferWorker extends EventEmitter {
    private child;
    constructor(data: Record<string, unknown>) {
        super();
        this.child = spawn(process.env.LIBRARY_NODE_PATH || 'node', [fileURLToPath(new URL('./transfer-worker.ts', import.meta.url))],
            { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        const lines = createInterface({ input: this.child.stdout });
        lines.on('line', line => {
            try { this.emit('message', JSON.parse(line)); }
            catch { /* Only valid protocol messages are accepted. */ }
        });
        this.child.stdin.on('error', () => {});
        this.child.on('error', error => this.emit('error', error));
        this.child.once('close', code => { lines.close(); this.emit('exit', code); });
        this.postMessage({ type: 'start', data });
    }
    postMessage(value: unknown) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
    async terminate() {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return 0;
        const done = new Promise<number>(resolve => this.child.once('close', () => resolve(0)));
        this.child.kill(); return done;
    }
}
type TransferWorker = Worker | NodeTransferWorker;

export class TransferController {
    private shareWorker?: TransferWorker;
    private importWorker?: TransferWorker;
    private sharing: TransferStatus = { state: 'idle' };
    private importing: TransferStatus = { state: 'idle' };
    private importKind?: 'preview' | 'import';
    private persist: Promise<void> = Promise.resolve();
    private persistAt = 0;
    private onImported: () => void;
    private initialized: Promise<void>;
    readonly location: LibraryLocation;
    constructor(location: LibraryLocation, onImported = () => {}) {
        this.location = location;
        this.onImported = onImported;
        this.initialized = this.restore();
    }
    get shareStatus() { return this.sharing; }
    get importStatus() { return this.importing; }
    get importActive() { return Boolean(this.importWorker); }
    get shareActive() { return Boolean(this.shareWorker); }
    async ready() { await this.initialized; }

    private async restore() {
        try {
            const previous = JSON.parse(await readFile(path.join(transferDirectory(this.location.database), 'last-import.json'), 'utf8')) as TransferStatus;
            if (previous.preview?.id && /^[a-f0-9-]{36}$/.test(previous.preview.id)) {
                // No remote code is persisted; resuming requires entering a current sharing code.
                this.importing = { ...previous, state: previous.state === 'completed' ? 'completed' : 'stopped',
                    ...(previous.state !== 'completed' ? { error: '上次任务已中断，填写分享地址和当前分享码后可继续' } : {}) };
            }
        } catch { /* A new library has no saved import job. */ }
    }
    private save() {
        const value = JSON.stringify(this.importing);
        this.persist = this.persist.then(async () => {
            const directory = transferDirectory(this.location.database);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const file = path.join(directory, 'last-import.json');
            const temporary = file + '.tmp';
            await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, file);
        }).catch(() => {});
    }
    private start(kind: 'share' | 'preview' | 'import', extra: Record<string, unknown>) {
        const isShare = kind === 'share';
        const data = { kind, location: this.location, ...extra };
        const child = process.platform === 'win32' && process.versions.bun
            ? new NodeTransferWorker(data) : new Worker(new URL('./transfer-worker.ts', import.meta.url), { workerData: data });
        if (isShare) this.shareWorker = child;
        else { this.importWorker = child; this.importKind = kind; }
        let answered = false;
        let stopTimer: ReturnType<typeof setTimeout> | undefined;
        child.on('message', (patch: Partial<TransferStatus>) => {
            if ((isShare ? this.shareWorker : this.importWorker) !== child) return;
            answered = true;
            if (isShare) this.sharing = { ...this.sharing, ...patch };
            else {
                this.importing = { ...this.importing, ...patch };
                if (Date.now() - this.persistAt > 1000 || patch.state === 'ready' || patch.state === 'completed' || patch.state === 'failed' || patch.state === 'stopped') {
                    this.persistAt = Date.now(); this.save();
                }
                if (kind === 'import' && ['completed', 'failed', 'stopped'].includes(patch.state ?? '')) this.onImported();
            }
        });
        child.on('error', () => {
            const status: TransferStatus = { ...(isShare ? this.sharing : this.importing), state: 'failed', error: child instanceof NodeTransferWorker ? 'Windows 后台传输需要 Node.js 24.12+，请检查 node 命令或 LIBRARY_NODE_PATH；已完成的文件及断点已保留' : '后台分享/导入线程异常退出，已保留完成的文件及断点', finishedAt: new Date().toISOString() };
            if (isShare) this.sharing = status; else { this.importing = status; this.save(); this.onImported(); }
        });
        child.once('exit', () => {
            clearTimeout(stopTimer);
            const state = isShare ? this.sharing : this.importing;
            if (['starting', 'running', 'stopping'].includes(state.state)) {
                const stopped = state.state === 'stopping';
                const result: TransferStatus = { ...state, state: stopped ? 'stopped' : 'failed',
                    error: stopped ? undefined : '后台任务未正常结束，已保留断点', finishedAt: new Date().toISOString() };
                if (isShare) this.sharing = result; else { this.importing = result; this.save(); }
            }
            if (isShare && this.shareWorker === child) this.shareWorker = undefined;
            if (!isShare && this.importWorker === child) { this.importWorker = undefined; if (kind === 'import') this.onImported(); }
            if (!answered && isShare) this.sharing = { state: 'failed', error: '无法启动分享服务' };
        });
        return () => {
            child.postMessage({ type: 'stop' });
            stopTimer = setTimeout(() => void child.terminate(), 10_000); stopTimer.unref();
        };
    }
    private stopSharing?: () => void;
    private stopImporting?: () => void;

    async startShare(selection: TransferSelection = {}, port = 0, idleMinutes = 15) {
        await this.ready();
        if (this.shareWorker) return this.sharing;
        if (this.importWorker) throw new Error('正在导入，请等待任务结束');
        this.sharing = { state: 'starting', startedAt: new Date().toISOString(), code: randomBytes(16).toString('hex') };
        this.stopSharing = this.start('share', { selection, code: this.sharing.code, port, idleMs: idleMinutes * 60_000 });
        return this.sharing;
    }
    stopShare() {
        if (this.shareWorker && this.sharing.state !== 'stopping') { this.sharing = { ...this.sharing, state: 'stopping' }; this.stopSharing?.(); }
        return this.sharing;
    }
    async preview(source: RemoteSource) {
        await this.ready();
        if (this.importWorker) throw new Error('已有导入任务正在运行');
        const remote = remoteSource(source);
        this.importing = { state: 'starting', startedAt: new Date().toISOString() };
        this.stopImporting = this.start('preview', { source: remote });
        return this.importing;
    }
    async import(source: RemoteSource, id: string, options: ImportOptions = {}) {
        await this.ready();
        if (this.importWorker) throw new Error('已有导入任务正在运行');
        if (!this.importing.preview || this.importing.preview.id !== id) throw new Error('请先读取分享清单并查看差异');
        const remote = remoteSource(source);
        this.importing = { state: 'starting', startedAt: new Date().toISOString(), preview: this.importing.preview };
        this.stopImporting = this.start('import', { source: remote, planId: id, options });
        return this.importing;
    }
    stopImport() {
        if (this.importWorker && this.importing.state !== 'stopping') { this.importing = { ...this.importing, state: 'stopping' }; this.stopImporting?.(); }
        return this.importing;
    }
    async close() {
        await Promise.allSettled([this.shareWorker?.terminate(), this.importWorker?.terminate()]);
        this.shareWorker = this.importWorker = undefined;
        await this.persist;
    }
}
