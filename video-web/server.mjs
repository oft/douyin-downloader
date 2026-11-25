import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const publicRoot = new URL('./public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/feed.js', ['feed.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
]);
const readRoutes = /^\/(?:api\/catalog\/(?:works|authors)(?:\/[a-zA-Z0-9_-]+)?|media\/[a-zA-Z0-9_-]+)$/;
const requestHeaders = ['range', 'if-range', 'if-none-match', 'if-modified-since', 'accept'];
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'cache-control', 'content-disposition'];

function json(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

/** A fixed, read-only upstream keeps media and API on the phone's origin. */
export function createVideoServer({ libraryUrl = 'http://127.0.0.1:3001', idleMs = 0 } = {}) {
  const upstream = new URL(libraryUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('LIBRARY_URL 必须是资料库的 HTTP(S) 服务地址，不包含路径或凭据');
  }

  let lastActivity = Date.now();
  let activeRequests = 0;
  const server = createHttpServer(async (req, res) => {
    lastActivity = Date.now();
    activeRequests++;
    res.once('close', () => { activeRequests--; lastActivity = Date.now(); });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return json(res, 405, '视频浏览服务仅提供只读接口');
    }
    let url;
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return json(res, 404, '页面或接口不存在');
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return json(res, 400, '请求地址无效'); }
    if (url.pathname === '/api/activity') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }

    const asset = assets.get(url.pathname);
    if (asset) {
      try {
        const body = await readFile(new URL(asset[0], publicRoot));
        res.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      } catch { return json(res, 500, '页面文件读取失败'); }
    }
    if (!readRoutes.test(url.pathname)) return json(res, 404, '页面或接口不存在');

    // Never resolve the client URL against the upstream: //host must not change its origin.
    const target = new URL(upstream.origin);
    target.pathname = url.pathname;
    target.search = url.search;
    const headers = {};
    for (const key of requestHeaders) if (req.headers[key]) headers[key] = req.headers[key];
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: req.method, headers,
    }, response => {
      const forwarded = {};
      for (const key of responseHeaders) if (response.headers[key]) forwarded[key] = response.headers[key];
      // The allowed endpoints have no redirects; do not forward an upstream login redirect.
      if (response.statusCode >= 300 && response.statusCode < 400 && response.statusCode !== 304) {
        response.resume();
        return json(res, 502, '资料库返回了意外跳转，请检查 LIBRARY_URL');
      }
      res.writeHead(response.statusCode ?? 502, forwarded);
      pipeline(response, res, () => { /* Closing a video cancels its upstream stream. */ });
    });
    request.setTimeout(url.pathname.startsWith('/media/') ? 120_000 : 30_000, () => request.destroy(new Error('timeout')));
    request.on('error', () => {
      if (!res.headersSent && !res.destroyed) json(res, 502, '无法连接资料库，请确认 library-server 已启动并检查 LIBRARY_URL');
      else res.destroy();
    });
    res.on('close', () => request.destroy());
    request.end();
  });
  if (Number.isFinite(idleMs) && idleMs > 0) {
    const timer = setInterval(() => {
      if (!activeRequests && Date.now() - lastActivity >= idleMs) {
        console.log('视频服务空闲，退出等待下次访问唤醒');
        clearInterval(timer);
        server.close();
        server.closeIdleConnections();
      }
    }, Math.min(idleMs, 30_000));
    timer.unref();
    server.once('close', () => clearInterval(timer));
  }
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3002);
  const host = process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间');
  const server = createVideoServer({ libraryUrl: process.env.LIBRARY_URL, idleMs: Number(process.env.IDLE_MS ?? 0) });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请设置其他 PORT` : `视频服务启动失败：${error.code ?? '未知错误'}`);
    process.exitCode = 1;
  });
  const fd = Number(process.env.VIDEO_LISTEN_FD);
  const ready = () => {
    console.log(`视频浏览 http://127.0.0.1:${port}`);
    if (host === '0.0.0.0') {
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal) console.log(`局域网访问 http://${address.address}:${port}`);
        }
      }
    }
  };
  if (Number.isInteger(fd) && fd >= 3) server.listen({ fd }, ready);
  else server.listen(port, host, ready);
}
