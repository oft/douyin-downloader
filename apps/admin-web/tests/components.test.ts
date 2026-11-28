import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';
import { createSSRApp, h } from 'vue';
import type { Component } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, RouterView } from 'vue-router';
import { createPinia } from 'pinia';

test('Vue management shell, work list, pagination and media preview render independently of the API', async t => {
    const server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null } });
    t.after(() => server.close());
    const { createAdminRouter } = await server.ssrLoadModule('/src/router.ts') as typeof import('../src/router');
    const { useCatalogStore } = await server.ssrLoadModule('/src/stores/catalog.ts') as typeof import('../src/stores/catalog');
    const { neighborOnList, playbackListParams, resolvePlaybackList } = await server.ssrLoadModule('/src/playback-context.ts') as typeof import('../src/playback-context');
    const { default: WorkList } = await server.ssrLoadModule('/src/components/WorkList.vue');
    const { default: WorkPreview } = await server.ssrLoadModule('/src/components/WorkPreview.vue');
    const render = (component: Component, props: Record<string, unknown> = {}) => renderToString(createSSRApp({ render: () => h(component, props) }));
    const work = {
        id: 'work-1', title: '作品 <标题>', kind: 'video', cover: 'cover',
        authorId: 'author/1', authorName: '作者', sources: ['post'], time: '2026-11-26 10:00:00',
    };
    const base = {
        items: [work], page: 2, pages: 8, layout: 'cards', busy: false,
        selectable: true, overlay: true, showAuthor: true, allowLayoutSwitch: true,
        selectedIds: new Set(['work-1']), phase: 'ready', message: '',
        assetUrl: (id: string) => '/media/' + encodeURIComponent(id), authorUrl: (id: string) => '#authors/' + encodeURIComponent(id),
    };

    await t.test('the shell uses named routes, author IDs, filters and Pinia counters', async () => {
        const router = createAdminRouter(createMemoryHistory('#'));
        const pinia = createPinia();
        const app = createSSRApp(RouterView).use(pinia).use(router);
        const catalog = useCatalogStore(pinia);
        catalog.status = { works: 123, authors: 45, pending: 6 };
        await router.push({ name: 'author-works', params: { authorId: 'example/author' }, query: { page: '2', q: '中文' } });
        assert.equal(router.currentRoute.value.params.authorId, 'example/author');
        assert.deepEqual(router.currentRoute.value.query, { page: '2', q: '中文' });
        const html = await renderToString(app);
        for (const view of ['works', 'authors', 'issues', 'links', 'update', 'transfer']) assert.ok(html.includes(`href="#/${view}"`));
        assert.match(html, /data-view="authors" aria-current="page"/);
        assert.match(html, /id="nav-works"[^>]*>123</);
        assert.equal(catalog.counters.issues, undefined);
        catalog.status.scannedAt = '2026-11-26T00:00:00.000Z';
        assert.equal(catalog.counters.issues, 6);
        assert.match(html, /id="scan-button"/);
    });
    await t.test('work selection survives navigation in the same scope and clears in another scope', () => {
        const catalog = useCatalogStore(createPinia());
        catalog.enterWorkScope();
        catalog.selectedAuthors.add('author-a');
        catalog.replaceWorkSelection(new Set(['work-1']));
        catalog.enterWorkScope();
        assert.deepEqual([...catalog.selectedWorks], ['work-1']);
        catalog.enterWorkScope('author-a');
        assert.equal(catalog.selectedWorks.size, 0);
        assert.deepEqual([...catalog.selectedAuthors], ['author-a']);
    });
    await t.test('independent playback retains the source filters and finds neighbors across a page boundary', () => {
        const router = createAdminRouter(createMemoryHistory('#'));
        const origin = router.resolve({
            name: 'author-works', params: { authorId: 'author/1' },
            query: { q: '中文', page: '2', kind: 'video', layout: 'list' },
        });
        const player = router.resolve({ name: 'work-playback', params: { workId: 'work-1' }, query: { from: origin.fullPath } });
        assert.match(player.href, /^#\/works\/work-1\?/);
        const list = resolvePlaybackList(router, player.query.from);
        assert.ok(list);
        assert.equal(list.fullPath, origin.fullPath);
        assert.deepEqual(Object.fromEntries(playbackListParams(list, 3)), {
            q: '中文', kind: 'video', page: '3', author: 'author/1',
        });
        assert.equal(resolvePlaybackList(router, '/works/work-1'), undefined);
        assert.equal(resolvePlaybackList(router, '//example.test/works'), undefined);
        const data = { items: [{ id: 'one' }, { id: 'two' }], page: 2, pages: 3 };
        assert.deepEqual(neighborOnList(data, 'one', 1), { id: 'two', page: 2 });
        assert.deepEqual(neighborOnList(data, 'two', 1), { page: 3 });
        assert.deepEqual(neighborOnList(data, 'one', -1), { page: 1 });
        assert.equal(neighborOnList({ ...data, page: 3 }, 'two', 1), undefined);
        assert.equal(neighborOnList(data, 'outside', -1), undefined);
    });
    await t.test('grid includes a selected work, escaped title, author link and two page bars', async () => {
        const html = await render(WorkList, base);
        assert.match(html, /work-grid work-overlay-grid/);
        assert.match(html, /data-select-entry.*checked/);
        assert.match(html, /作品 &lt;标题&gt;/);
        assert.match(html, /\/media\/cover/);
        assert.match(html, /#authors\/author%2F1/);
        assert.equal((html.match(/aria-current="page"/g) ?? []).length, 2);
    });
    await t.test('author list view hides author labels, and a busy request disables layout change', async () => {
        const html = await render(WorkList, { ...base, showAuthor: false, busy: true, layout: 'list' });
        assert.match(html, /class="work-list"/);
        assert.doesNotMatch(html, /class="work-author"|class="media-badge"/);
        assert.match(html, /aria-label="切换为卡片"[^>]*disabled/);
    });
    await t.test('empty and failed states support a retry without opening a work', async () => {
        assert.match(await render(WorkList, { ...base, items: [] }), /没有符合条件的记录/);
        const html = await render(WorkList, { ...base, phase: 'error', message: '<img>' });
        assert.match(html, /&lt;img&gt;/);
        assert.match(html, /data-work-list-retry/);
        assert.doesNotMatch(html, /data-work="work-1"/);
    });
    await t.test('video and gallery reflect the correct media and initial album controls', async () => {
        const video = await render(WorkPreview, { video: 'video/1', cover: 'cover', images: [], isCurrent: () => true });
        assert.match(video, /<video[^>]+src="\/media\/video%2F1"/);
        const gallery = await render(WorkPreview, { images: ['first', 'second'], isCurrent: () => true });
        assert.match(gallery, /id="album-prev" disabled/);
        assert.match(gallery, /<span id="album-count">1 \/ 2<\/span>/);
    });
});
