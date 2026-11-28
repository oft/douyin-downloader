import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { projectRoot } from './project-paths.ts';

const defaultDist = path.join(projectRoot, 'apps', 'admin-web', 'dist');

export function mountAdminWeb(app: Hono, dist = defaultDist) {
    const index = async (c: Context) => {
        try {
            return c.html(await readFile(path.join(dist, 'index.html'), 'utf8'), 200, { 'Cache-Control': 'no-cache' });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return c.text('管理界面尚未构建。请在 apps/ 运行 bun run build。', 503, { 'Cache-Control': 'no-store' });
            }
            throw error;
        }
    };
    app.get('/', index);
    app.get('/index.html', index);

    app.get('/_admin/:file', async c => {
        const file = c.req.param('file');
        if (!/^[A-Za-z0-9_-]+\.(js|css)$/.test(file)) return c.notFound();
        try {
            const contents = await readFile(path.join(dist, '_admin', file), 'utf8');
            return c.body(contents, 200, {
                'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
                'Cache-Control': 'public, max-age=31536000, immutable',
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return c.notFound();
            throw error;
        }
    });
}
