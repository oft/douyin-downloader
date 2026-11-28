import { isLibraryRequest } from './request-origin.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { projectRoot } from './project-paths.ts';
import { UpdateJob } from './update-job.ts';
import { createAdminPythonBridge } from './python.ts';
import { cleanupLogs, inspectLogs, logPreview } from './log-maintenance.ts';
import { collectUpdateDiagnostics, requestAuditRetry, requestAuthorRetry, saveDiagnostics } from './update-diagnostics.ts';
import { readFile } from 'node:fs/promises';
import type { Hono } from 'hono';
import { previewLinkRemoval } from './maintenance.ts';
import type { AuthorAudit } from './maintenance.ts';
import type { LibraryLocation } from './transfer-types.ts';

function task(location: LibraryLocation, request: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const command = process.versions.bun ? process.env.LIBRARY_NODE_PATH || 'node' : process.execPath;
        const child = spawn(command, [fileURLToPath(new URL('./maintenance-worker.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        let output = '', answered = false;
        const timer = setTimeout(() => { child.kill(); reject(new Error('异常检查超时，请检查数据库及历史库状态')); }, 60_000);
        child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 32 * 1024 * 1024) child.kill(); });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', () => {
            clearTimeout(timer);
            try {
                const result = JSON.parse(output); answered = true;
                if (result.error) reject(Object.assign(new Error(result.error), { status: result.status }));
                else resolve(result.data);
            } catch { if (!answered) reject(new Error('无法完成异常检查，请检查 Node.js 和数据库')); }
        });
        child.stdin.end(JSON.stringify({ ...request, location }));
    });
}

export function mountMaintenanceRoutes(app: Hono, location: LibraryLocation, options: { busy: () => boolean; onChanged: () => void; updateStatus?: () => unknown }) {
    let report: AuthorAudit | undefined, scanning = false, changing = false, cleaningLogs = false, error: string | undefined;
    const project = projectRoot;
    const diagnosticFile = path.join(path.dirname(location.database), 'library-diagnostics.json');
    let diagnosing = false;
    const python = createAdminPythonBridge();
    const files = new UpdateJob(...python.scanLocalFiles(location.database, location.root), line => {
        try { const data = JSON.parse(line); if (data.progress?.completedUrls === 1) options.onChanged(); } catch { /* Non-progress output. */ }
    }, path.join(path.dirname(location.database), 'local-file-scan-status.json'),
    '本地文件扫描失败，原登记结果保留。请检查媒体目录、数据库权限和诊断日志。');
    const state = () => ({ scanning, changing: changing || files.active, busy: options.busy(), error, report, localFiles: files.status });
    app.use('/api/catalog/maintenance/*', async (c, next) => {
        c.header('Cache-Control', 'no-store');
        if (!isLibraryRequest(c.req.url, c.req.header('Origin'))) return c.json({ error: '异常清理仅支持本机或已配置域名的同源请求' }, 403);
        if (c.req.method !== 'GET' && !/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: '需要 JSON 请求' }, 415);
        await next();
    });
    app.get('/api/catalog/maintenance/status', c => c.json(state()));
    app.get('/api/catalog/maintenance/diagnostics', async c => {
        const saved = await readFile(diagnosticFile, 'utf8').then(text => JSON.parse(text)).catch(() => null);
        return c.json({ report: saved, refreshing: diagnosing, current: options.updateStatus?.() });
    });
    app.post('/api/catalog/maintenance/diagnostics/refresh', async c => {
        if (diagnosing) return c.json({ error: '正在汇总诊断，请稍后刷新' }, 409);
        diagnosing = true;
        try {
            const report = await collectUpdateDiagnostics(project, location.database, options.updateStatus?.());
            await saveDiagnostics(diagnosticFile, report);
            return c.json({ report, refreshing: false, current: options.updateStatus?.() });
        } catch { return c.json({ error: '无法读取运行诊断，请检查日志和数据库状态' }, 409); }
        finally { diagnosing = false; }
    });
    app.post('/api/catalog/maintenance/diagnostics/retry', async c => {
        const body = await c.req.json().catch(() => null);
        if (typeof body?.target === 'string' && /^user:[\w.-]{1,400}$/.test(body.target)) {
            try { return c.json(requestAuthorRetry(location.database, body.target)); }
            catch { return c.json({ error: '作者状态已变化，请刷新诊断后重试' }, 409); }
        }
        if (typeof body?.scope !== 'string' || body.scope.length > 512 || !/^post:[\w-]+:[a-f0-9]{64}$/.test(body.scope)) return c.json({ error: '请选择已有的历史核对记录' }, 400);
        try { return c.json(requestAuditRetry(location.database, body.scope)); }
        catch { return c.json({ error: '无法标记重新核对，请先刷新诊断' }, 409); }
    });
    app.post('/api/catalog/maintenance/logs/preview', async c => {
        if (cleaningLogs) return c.json({ error: '正在清理日志，请稍后查看范围' }, 409);
        const body = await c.req.json().catch(() => null);
        if (![0, 1, 7, 30].includes(body?.days)) return c.json({ error: '请选择日志保留范围' }, 400);
        try { return c.json(logPreview(await inspectLogs(project, body.days))); }
        catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
    });
    app.delete('/api/catalog/maintenance/logs', async c => {
        if (cleaningLogs) return c.json({ error: '正在清理日志，请稍后再试' }, 409);
        const body = await c.req.json().catch(() => null);
        if (body?.mode !== 'permanent' || ![0, 1, 7, 30].includes(body?.days) || !/^[a-f0-9]{64}$/.test(body?.token ?? '')) return c.json({ error: '请先查看清理范围，再确认删除日志' }, 400);
        cleaningLogs = true;
        try { return c.json(await cleanupLogs(project, body.days, body.token)); }
        catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
        finally { cleaningLogs = false; }
    });
    app.post('/api/catalog/maintenance/local-files/start', c => {
        if (files.active) return c.json(state(), 202);
        if (options.busy() || changing || scanning) return c.json({ error: '导入、下载或其他扫描正在运行，请结束后再扫描本地文件' }, 409);
        files.start();
        return c.json(state(), 202);
    });
    app.post('/api/catalog/maintenance/local-files/stop', c => { files.stop(); return c.json(state(), 202); });
    app.get('/api/catalog/maintenance/import-issues', async c => {
        const type = c.req.query('type') ?? 'conflicts';
        const page = Number(c.req.query('page') ?? 1);
        if (!['conflicts', 'unassigned'].includes(type) || !Number.isSafeInteger(page) || page < 1) return c.json({ error: '差异类型或页码无效' }, 400);
        try { return c.json(await task(location, { kind: 'import-report', type, page }) as Record<string, unknown>); }
        catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
    });
    app.post('/api/catalog/maintenance/scan', c => {
        if (changing || files.active) return c.json({ error: '正在执行清理或本地文件扫描，请稍后再扫描' }, 409);
        if (!scanning) {
            scanning = true; error = undefined;
            void task(location, { kind: 'scan' }).then(data => { report = data as AuthorAudit; })
                .catch(failure => { error = failure.message; }).finally(() => { scanning = false; });
        }
        return c.json(state(), 202);
    });
    app.post('/api/catalog/maintenance/links/preview', async c => {
        const body = await c.req.json().catch(() => null);
        if (!Array.isArray(body?.links) || !body.links.length || body.links.length > 1000 || !body.links.every((link: unknown) => typeof link === 'string' && link.length <= 4096)) return c.json({ error: '请选择要移除的链接' }, 400);
        try { return c.json(previewLinkRemoval(location, body.links)); }
        catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
    });
    for (const kind of ['authors', 'links'] as const) app.delete(`/api/catalog/maintenance/${kind}`, async c => {
        if (options.busy() || changing || scanning || files.active) return c.json({ error: '导入、下载、扫描或其他清理正在运行，请结束后再执行清理' }, 409);
        const body = await c.req.json().catch(() => null);
        const selected = body?.[kind === 'authors' ? 'ids' : 'links'];
        if (body?.mode !== 'permanent' || !/^[a-f0-9]{64}$/.test(body?.token ?? '') || !Array.isArray(selected) || !selected.length || selected.length > 1000 ||
            !selected.every((item: unknown) => typeof item === 'string' && (kind === 'authors' ? /^[a-f0-9]{24}$/.test(item) : item.length <= 4096))) return c.json({ error: '请先选择项目并查看清理范围，再确认执行' }, 400);
        changing = true;
        try {
            const result = await task(location, { kind, ids: body.ids, links: body.links, token: body.token });
            report = undefined; options.onChanged(); return c.json(result as Record<string, unknown>);
        } catch (failure) { return c.json({ error: (failure as Error).message }, 409); }
        finally { changing = false; }
    });
    return { get changing() { return changing || files.active; }, get scanning() { return scanning; } };
}
