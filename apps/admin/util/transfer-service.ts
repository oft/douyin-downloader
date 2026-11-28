import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { open, realpath } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { checkedFile, fileStamp } from './transfer-index.ts';
import type { IndexedLibrary } from './transfer-types.ts';

function rangeFor(value: string, size: number) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || !match[1] && !match[2]) return undefined;
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[1] ? match[2] ? Math.min(size - 1, Number(match[2])) : size - 1 : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return undefined;
    return { start, end };
}

function json(response: ServerResponse, code: number, body: unknown) {
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(body));
}

export interface SharingServer {
    server: Server;
    port: number;
    addresses: string[];
    expiresAt: () => string;
    close: () => Promise<void>;
}

export async function serveLibrary(index: IndexedLibrary, root: string, code: string,
    options: { port?: number; host?: string; idleMs?: number; onStopped?: () => void } = {}): Promise<SharingServer> {
    root = await realpath(root);
    const expected = Buffer.from(`Bearer ${code}`);
    const files = new Map(index.files.map(file => [file.id, file]));
    const body = Buffer.from(JSON.stringify(index.manifest));
    const idleMs = options.idleMs ?? 15 * 60_000;
    let activeTransfers = 0;
    let lastRequest = Date.now();
    let closing: Promise<void> | undefined;
    const failures = new Map<string, { count: number; since: number }>();
    const server = createServer(async (request, response) => {
        const authorization = Buffer.from(request.headers.authorization ?? '');
        const address = request.socket.remoteAddress ?? '';
        if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
            const previous = failures.get(address);
            const record = previous && Date.now() - previous.since < 60_000 ? previous : { count: 0, since: Date.now() };
            record.count++; failures.set(address, record);
            if (failures.size > 200) failures.delete(failures.keys().next().value!);
            json(response, record.count > 20 ? 429 : 401, { error: '分享码无效或已失效' }); return;
        }
        lastRequest = Date.now();
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { json(response, 405, { error: '分享服务仅支持读取' }); return; }
        let url: URL;
        try { url = new URL(request.url ?? '/', 'http://sharing.invalid'); }
        catch { json(response, 400, { error: '请求地址无效' }); return; }
        if (url.pathname === '/v1/manifest') {
            response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
                'Cache-Control': 'no-store', ETag: `"${index.manifest.snapshotId}"`, 'X-Content-Type-Options': 'nosniff' });
            response.end(request.method === 'HEAD' ? undefined : body); return;
        }
        const match = /^\/v1\/files\/([a-f0-9]{64})$/.exec(url.pathname);
        const file = match && files.get(match[1]!);
        if (!file) { json(response, 404, { error: '分享文件不存在' }); return; }
        if (request.headers['x-library-snapshot'] !== index.manifest.snapshotId ||
            request.headers['if-match'] && request.headers['if-match'] !== `"${file.sha256}"`) {
            json(response, 409, { error: '分享版本已变化，请重新读取清单' }); return;
        }
        let handle;
        try {
            const { absolute, stats } = await checkedFile(root, file.relativePath);
            if (fileStamp(stats) !== file.stamp) { json(response, 409, { error: '源文件已变化，请重新生成分享' }); return; }
            handle = await open(absolute, 'r');
            if (fileStamp(await handle.stat()) !== file.stamp) { await handle.close(); json(response, 409, { error: '源文件已变化' }); return; }
            const range = request.headers.range ? rangeFor(request.headers.range, file.size) : { start: 0, end: file.size - 1 };
            if (!range) { await handle.close(); response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }); response.end(); return; }
            const headers: Record<string, string | number> = { 'Content-Type': file.mime || 'application/octet-stream',
                'Content-Length': range.end - range.start + 1, 'Accept-Ranges': 'bytes', ETag: `"${file.sha256}"`,
                'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
                'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` };
            if (request.headers.range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
            response.writeHead(request.headers.range ? 206 : 200, headers);
            if (request.method === 'HEAD') { await handle.close(); response.end(); return; }
            activeTransfers++;
            const stream = handle.createReadStream({ ...range, autoClose: true });
            let finished = false;
            const done = () => { if (!finished) { finished = true; activeTransfers--; lastRequest = Date.now(); stream.destroy(); } };
            stream.once('error', () => response.destroy());
            response.once('close', done);
            stream.pipe(response);
        } catch {
            await handle?.close().catch(() => {});
            if (response.headersSent) response.destroy();
            else json(response, 409, { error: '无法读取源文件，请重新生成分享' });
        }
    });
    const close = () => closing ??= new Promise<void>(resolve => {
        clearInterval(timer);
        server.close(() => { options.onStopped?.(); resolve(); });
        server.closeAllConnections();
    });
    const timer = setInterval(() => { if (!activeTransfers && Date.now() - lastRequest >= idleMs) void close(); }, Math.min(1000, idleMs));
    timer.unref();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, options.host ?? '0.0.0.0', () => { server.off('error', reject); resolve(); });
    }).catch(error => { clearInterval(timer); throw error; });
    const port = (server.address() as { port: number }).port;
    const addresses = new Set([`http://127.0.0.1:${port}`]);
    for (const interfaces of Object.values(networkInterfaces())) for (const info of interfaces ?? []) {
        if (info.family === 'IPv4' && !info.internal) addresses.add(`http://${info.address}:${port}`);
    }
    return { server, port, addresses: [...addresses], expiresAt: () => new Date(lastRequest + idleMs).toISOString(), close };
}
