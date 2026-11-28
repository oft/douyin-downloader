/** Application I/O trace. Payloads, headers, SQL values and URL queries never enter the log. */
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { projectRoot } from './project-paths.ts';
import { threadId } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
import { errorMonitor } from 'node:events';

const raw = { mkdir: fs.mkdirSync, open: fs.openSync, write: fs.writeSync, close: fs.closeSync, chmod: fs.chmodSync };
const ancestry = new AsyncLocalStorage<string>();
let active: IOAudit | undefined;
let sequence = 0;
export function safeTarget(value: unknown): string {
    if (typeof value === 'number') return `fd:${value}`;
    if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
    let text = value instanceof URL ? value.href : typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString() : '';
    text = text.split(/[?#]/, 1)[0]!;
    if (/^(data|javascript):/i.test(text)) return text.split(':', 1)[0] + ':<redacted>';
    if (text.includes('://')) {
        try { const url = new URL(text); url.username = ''; url.password = ''; text = url.href; }
        catch { text = '<invalid-url>'; }
    }
    return text.slice(0, 2048);
}
function source() {
    return new Error().stack?.split('\n').slice(2).find(line => line.includes('douyin-downloader/')
        && !line.includes('/io-audit.ts') && !line.includes('/io-audit-bootstrap.ts'))?.trim() ?? '';
}
function preserveSymbols(replacement: Function, original: Function) {
    Object.assign(replacement, original);
    for (const key of Object.getOwnPropertySymbols(original)) {
        Object.defineProperty(replacement, key, Object.getOwnPropertyDescriptor(original, key)!);
    }
}
type Span = { id: string; start: number };
export class IOAudit {
    directory: string;
    private fd?: number;
    private part = 0;
    private size = 0;
    private buffer: string[] = [];
    private buffered = 0;
    private stem: string;
    private timer: ReturnType<typeof setInterval>;
    private failed = false;
    private stopped = false;
    private restore: (() => void)[] = [];
    private rotateBytes: number;
    constructor(directory: string, rotateBytes = 64 * 1024 * 1024) {
        this.rotateBytes = rotateBytes;
        this.directory = path.resolve(directory);
        raw.mkdir(this.directory, { recursive: true, mode: 0o700 });
        this.stem = `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-node-${threadId}`;
        this.timer = setInterval(() => this.flush(), 200); this.timer.unref();
    }
    emit(event: Record<string, unknown>) {
        if (this.stopped || this.failed) return;
        const line = JSON.stringify({ ...event, time: new Date().toISOString(), pid: process.pid, thread: threadId }) + '\n';
        this.buffer.push(line); this.buffered += Buffer.byteLength(line);
        // Bound memory during synchronous filesystem walks. Never silently sample/drop operations.
        if (this.buffered >= Math.min(512 * 1024, this.rotateBytes)) this.flush();
    }
    begin(category: string, operation: string, target: unknown = '', fields: Record<string, unknown> = {}): Span {
        const span = { id: `${process.pid}:${threadId}:${++sequence}`, start: performance.now() };
        this.emit({ event: 'begin', id: span.id, parent: ancestry.getStore(), category, operation,
            target: safeTarget(target), source: source(), ...fields });
        return span;
    }
    end(span: Span, error?: unknown, fields: Record<string, unknown> = {}) {
        this.emit({ event: error ? 'error' : 'end', id: span.id, elapsedMs: Math.round((performance.now() - span.start) * 1000) / 1000,
            ...(error ? { error: (error as NodeJS.ErrnoException).code ?? (error as Error).name ?? 'Error' } : {}), ...fields });
    }
    flush() {
        if (!this.buffer.length || this.failed) return;
        const data = Buffer.from(this.buffer.join('')); this.buffer = []; this.buffered = 0;
        try {
            if (this.fd === undefined || this.size + data.length > this.rotateBytes) {
                if (this.fd !== undefined) raw.close(this.fd);
                this.fd = raw.open(path.join(this.directory, `${this.stem}-${String(this.part++).padStart(4, '0')}.jsonl`), 'wx', 0o600);
                this.size = 0;
            }
            let offset = 0;
            while (offset < data.length) offset += raw.write(this.fd, data, offset, data.length - offset);
            this.size += data.length;
        } catch (error) {
            this.failed = true;
            console.error('I/O 诊断日志写入失败：', (error as NodeJS.ErrnoException).code ?? 'Error');
        }
    }
    close() {
        if (this.stopped) return;
        this.emit({ event: 'audit_stop' }); this.flush(); this.stopped = true;
        clearInterval(this.timer);
        for (const restore of this.restore.reverse()) restore();
        if (this.fd !== undefined) { raw.close(this.fd); this.fd = undefined; }
        if (active === this) active = undefined;
    }
    private patch(owner: any, name: string, replacement: any) {
        const original = owner[name]; owner[name] = replacement;
        this.restore.push(() => { owner[name] = original; });
    }
    private excluded(target: unknown) { return safeTarget(target).startsWith(this.directory + path.sep); }
    installFiles() {
        const names = ['access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lstat', 'stat', 'statfs', 'mkdir', 'mkdtemp',
            'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'truncate', 'unlink', 'utimes',
            'writeFile', 'link', 'symlink', 'open', 'close', 'read', 'readv', 'write', 'writev', 'fstat', 'fsync', 'fdatasync', 'ftruncate', 'exists'];
        const details = (name: string, args: unknown[]) => ['copyFile', 'cp', 'rename', 'link', 'symlink'].includes(name)
            ? { destination: safeTarget(args[1]) } : {};
        for (const name of names) {
            const owner = fs as any, promises = fsPromises as any;
            if (typeof owner[name + 'Sync'] === 'function') {
                const original = owner[name + 'Sync'];
                const replacement = (...args: any[]) => {
                    if (this.excluded(args[0])) return original(...args);
                    const span = this.begin('filesystem', name + 'Sync', args[0], details(name, args));
                    try { const result = original(...args); this.end(span); return result; }
                    catch (error) { this.end(span, error); throw error; }
                };
                preserveSymbols(replacement, original); this.patch(owner, name + 'Sync', replacement);
            }
            if (typeof owner[name] === 'function') {
                const original = owner[name];
                const replacement = (...args: any[]) => {
                    const callback = args[args.length - 1];
                    if (this.excluded(args[0]) || typeof callback !== 'function') return original(...args);
                    const span = this.begin('filesystem', name, args[0], details(name, args));
                    args[args.length - 1] = (...result: any[]) => { this.end(span, name === 'exists' ? undefined : result[0]); callback(...result); };
                    try { return original(...args); } catch (error) { this.end(span, error); throw error; }
                };
                preserveSymbols(replacement, original); this.patch(owner, name, replacement);
            }
            if (typeof promises[name] === 'function') {
                const original = promises[name];
                this.patch(promises, name, async (...args: any[]) => {
                    if (this.excluded(args[0])) return original(...args);
                    const span = this.begin('filesystem', name, args[0], details(name, args));
                    try {
                        const result = await original(...args);
                        if (name === 'open') this.traceHandle(result, args[0]);
                        if (name === 'opendir') this.traceDirectory(result, args[0]);
                        this.end(span); return result;
                    } catch (error) { this.end(span, error); throw error; }
                });
            }
        }
        for (const name of ['createReadStream', 'createWriteStream']) {
            const original = (fs as any)[name];
            this.patch(fs, name, (...args: any[]) => this.traceStream(() => original(...args), name, args[0]));
        }
        syncBuiltinESMExports(); this.restore.unshift(() => syncBuiltinESMExports());
    }
    private traceHandle(handle: any, target: unknown) {
        for (const name of ['read', 'readv', 'readFile', 'readLines', 'write', 'writev', 'writeFile', 'appendFile',
            'stat', 'sync', 'datasync', 'truncate', 'chmod', 'chown', 'utimes', 'close']) {
            if (typeof handle[name] !== 'function') continue;
            const original = handle[name].bind(handle);
            handle[name] = (...args: any[]) => {
                const span = this.begin('filesystem', 'handle.' + name, target);
                try {
                    const result = original(...args);
                    if (result?.then) return result.then((value: any) => { this.end(span, undefined,
                        { ...(typeof value?.bytesRead === 'number' ? { bytes: value.bytesRead } : {}),
                            ...(typeof value?.bytesWritten === 'number' ? { bytes: value.bytesWritten } : {}) }); return value; },
                    (error: unknown) => { this.end(span, error); throw error; });
                    this.end(span); return result;
                } catch (error) { this.end(span, error); throw error; }
            };
        }
        for (const name of ['createReadStream', 'createWriteStream']) {
            const original = handle[name].bind(handle);
            handle[name] = (...args: any[]) => this.traceStream(() => original(...args), 'handle.' + name, target);
        }
    }
    private traceDirectory(directory: any, target: unknown) {
        for (const name of ['read', 'close', 'readSync', 'closeSync']) {
            const original = directory[name].bind(directory);
            directory[name] = (...args: any[]) => {
                const span = this.begin('filesystem', 'directory.' + name, target);
                const callback = args[args.length - 1];
                if (typeof callback === 'function') args[args.length - 1] = (...values: any[]) => { this.end(span, values[0]); callback(...values); };
                try {
                    const result = original(...args);
                    if (result?.then) return result.then((value: any) => { this.end(span); return value; },
                        (error: unknown) => { this.end(span, error); throw error; });
                    if (typeof callback !== 'function') this.end(span);
                    return result;
                } catch (error) { this.end(span, error); throw error; }
            };
        }
    }
    private traceStream(create: () => any, name: string, target: unknown) {
        if (this.excluded(target)) return create();
        const span = this.begin('filesystem', name, target);
        let stream: any;
        try { stream = create(); } catch (error) { this.end(span, error); throw error; }
        let finished = false;
        const end = (error?: unknown) => { if (!finished) { finished = true; this.end(span, error,
            { bytes: stream.bytesRead ?? stream.bytesWritten }); } };
        // No 'data' listener: logging must never put a paused stream into flowing mode.
        stream.once('end', () => end()); stream.once('finish', () => end());
        stream.once(errorMonitor, end); stream.once('close', () => end());
        return stream;
    }
    installNetwork() {
        const requests = new WeakMap<object, Span>();
        const subscribe = (name: string, listener: (event: any) => void) => {
            const topic = channel(name); topic.subscribe(listener); this.restore.push(() => topic.unsubscribe(listener));
        };
        subscribe('undici:request:create', ({ request }) => {
            requests.set(request, this.begin('network', request.method, String(request.origin) + request.path));
        });
        subscribe('undici:request:headers', ({ request, response }) => {
            const span = requests.get(request);
            if (span) this.emit({ event: 'response_headers', id: span.id, status: response.statusCode });
        });
        subscribe('undici:request:trailers', ({ request }) => { const span = requests.get(request); if (span) { this.end(span); requests.delete(request); } });
        subscribe('undici:request:error', ({ request, error }) => { const span = requests.get(request); if (span) { this.end(span, error); requests.delete(request); } });
        const incoming = new WeakMap<object, Span>();
        subscribe('http.server.request.start', ({ request, response }) => {
            const span = this.begin('http_server', request.method, request.url); incoming.set(response, span);
            ancestry.enterWith(span.id);
            response.once('close', () => { const pending = incoming.get(response); if (pending) { this.end(pending, undefined,
                { status: response.statusCode, aborted: !response.writableFinished }); incoming.delete(response); } });
        });
        subscribe('http.server.response.finish', ({ response }) => { const span = incoming.get(response); if (span) {
            this.end(span, undefined, { status: response.statusCode }); incoming.delete(response); } });
        // Also cover node:http(s) clients (fetch uses Undici above).
        const outgoing = new WeakMap<object, Span>();
        subscribe('http.client.request.start', ({ request }) => {
            const span = this.begin('network', request.method, request.protocol + '//' + request.host + request.path);
            outgoing.set(request, span);
            request.once('response', (response: any) => {
                this.emit({ event: 'response_headers', id: span.id, status: response.statusCode });
                let done = false;
                const finish = (error?: unknown) => { if (!done) { done = true; this.end(span, error,
                    { status: response.statusCode, complete: response.complete }); outgoing.delete(request); } };
                response.once('end', () => finish()); response.once(errorMonitor, finish); response.once('close', () => finish());
            });
            request.once(errorMonitor, (error: unknown) => { if (outgoing.has(request)) { this.end(span, error); outgoing.delete(request); } });
        });
    }
}
export function installIOAudit(directory = process.env.LIBRARY_IO_AUDIT_DIR ?? path.join(projectRoot, 'logs', 'io-audit')) {
    if (process.env.LIBRARY_IO_AUDIT === '0') return undefined;
    if (active) return active;
    const audit = active = new IOAudit(directory);
    audit.installFiles(); audit.installNetwork();
    audit.emit({ event: 'audit_start', coverage: 'node-files,sqlite,http-server,http-client,fetch', payloads: false });
    const exit = () => audit.close(); process.once('exit', exit);
    return audit;
}
function sqlFields(sql: unknown) {
    const text = typeof sql === 'string' ? sql : '';
    return { statement: text.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*([a-z]+)/i)?.[1]?.toUpperCase() ?? 'SQL',
        queryHash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}
export function auditDatabase<T extends object>(database: T, target: string): T {
    if (!active) return database;
    const audit = active;
    const wrap = (object: any, statement?: Record<string, unknown>): any => new Proxy(object, {
        get: (obj, key) => {
            const original = Reflect.get(obj, key, obj);
            if (typeof original !== 'function') return original;
            return (...args: any[]) => {
                const fields = statement ?? (['prepare', 'query', 'exec', 'run'].includes(String(key)) ? sqlFields(args[0]) : {});
                const span = audit.begin('database', String(key), target, fields);
                try {
                    let result = original.apply(obj, args);
                    if (['prepare', 'query'].includes(String(key))) result = wrap(result, fields);
                    if (String(key) === 'iterate') result = traceIterator(result, audit, target, fields);
                    audit.end(span, undefined, { ...(Array.isArray(result) ? { rows: result.length } : {}),
                        ...(typeof result?.changes === 'number' ? { changes: result.changes } : {}) });
                    return result;
                } catch (error) { audit.end(span, error); throw error; }
            };
        },
    });
    return wrap(database);
}
function* traceIterator(iterator: Iterable<unknown>, audit: IOAudit, target: string, fields: Record<string, unknown>) {
    const span = audit.begin('database', 'iterate.rows', target, fields); let rows = 0, complete = false, failure;
    try { for (const row of iterator) { rows++; yield row; } complete = true; }
    catch (error) { failure = error; throw error; }
    finally { audit.end(span, failure, { rows, complete }); }
}
export function auditDatabaseOpen<T>(target: string, action: () => T): T {
    if (!active) return action();
    const span = active.begin('database', 'open', target);
    try { const value = action(); active.end(span); return value; }
    catch (error) { active.end(span, error); throw error; }
}
