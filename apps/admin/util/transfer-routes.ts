import { isLibraryRequest } from './request-origin.ts';
import type { Hono } from 'hono';
import { TransferController } from './transfer-controller.ts';
import type { LibraryLocation, TransferSelection } from './transfer-types.ts';

export function mountTransferRoutes(app: Hono, location: LibraryLocation, options: { busy?: () => boolean; onImported?: () => void } = {}) {
    const controller = new TransferController(location, options.onImported);
    app.use('/api/catalog/transfer/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        if (!isLibraryRequest(c.req.url, c.req.header('Origin'))) return c.json({ error: '分享管理与导入仅支持本机或已配置域名的同源请求' }, 403);
        if (c.req.method !== 'GET' && !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
        await controller.ready(); await next();
    });
    app.get('/api/catalog/transfer/status', c => c.json({ share: controller.shareStatus, importing: controller.importStatus }));
    app.post('/api/catalog/transfer/share/start', async c => {
        const body = await c.req.json().catch(() => null);
        const list = (v: unknown) => v === undefined || Array.isArray(v) && v.length > 0 && v.length <= 200_000 && v.every(s => typeof s === 'string' && s.length <= 256);
        if (!body || !list(body.authorIds) || !list(body.workIds) || body.includeHistory !== undefined && typeof body.includeHistory !== 'boolean' ||
            body.port !== undefined && (!Number.isInteger(body.port) || body.port < 0 || body.port > 65535) ||
            body.idleMinutes !== undefined && (!Number.isInteger(body.idleMinutes) || body.idleMinutes < 1 || body.idleMinutes > 1440)) return c.json({ error: '分享范围、端口或空闲时间无效' }, 400);
        if (options.busy?.()) return c.json({ error: '资料库正在更新或删除，请稍后再启动分享' }, 409);
        try { return c.json(await controller.startShare(body as TransferSelection, body.port ?? 0, body.idleMinutes ?? 15), 202); }
        catch (error) { return c.json({ error: (error as Error).message }, 409); }
    });
    app.post('/api/catalog/transfer/share/stop', c => c.json(controller.stopShare(), 202));
    app.post('/api/catalog/transfer/import/preview', async c => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body.address !== 'string' || typeof body.code !== 'string') return c.json({ error: '请填写分享地址和分享码' }, 400);
        if (options.busy?.()) return c.json({ error: '资料库正在更新或删除，请稍后再导入' }, 409);
        try { return c.json(await controller.preview(body), 202); }
        catch (error) { return c.json({ error: (error as Error).message }, 409); }
    });
    app.post('/api/catalog/transfer/import/start', async c => {
        const body = await c.req.json().catch(() => null);
        if (!body || typeof body.address !== 'string' || typeof body.code !== 'string' || typeof body.planId !== 'string' ||
            body.includeLinks !== undefined && typeof body.includeLinks !== 'boolean') return c.json({ error: '请先读取分享清单' }, 400);
        if (options.busy?.()) return c.json({ error: '资料库正在更新或删除，请稍后再导入' }, 409);
        try { return c.json(await controller.import(body, body.planId, { includeLinks: body.includeLinks !== false }), 202); }
        catch (error) { return c.json({ error: (error as Error).message }, 409); }
    });
    app.post('/api/catalog/transfer/import/stop', c => c.json(controller.stopImport(), 202));
    return controller;
}
