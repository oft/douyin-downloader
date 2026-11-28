import type { LocationQueryValue, RouteLocationResolved, Router } from 'vue-router';

export type ListPage = { items: { id: string }[]; page: number; pages: number };

export function resolvePlaybackList(router: Router, from: LocationQueryValue | LocationQueryValue[] | undefined) {
    if (typeof from !== 'string' || !/^\/(?:works(?:\?|$)|authors\/)/.test(from)) return;
    const route = router.resolve(from);
    if (route.name === 'works' || route.name === 'author-works') return route;
}

export function playbackListParams(from: RouteLocationResolved, page?: number) {
    const params = new URLSearchParams();
    for (const key of ['q', 'kind', 'source', 'author', 'size', 'page']) {
        const value = from.query[key];
        if (typeof value === 'string' && value) params.set(key, value);
    }
    if (from.name === 'author-works' && typeof from.params.authorId === 'string') {
        params.set('author', from.params.authorId);
    }
    if (page !== undefined) params.set('page', String(page));
    return params;
}

export function neighborOnList(page: ListPage, id: string, step: -1 | 1) {
    const index = page.items.findIndex(item => item.id === id);
    if (index < 0) return;
    const item = page.items[index + step];
    if (item) return { page: page.page, id: item.id };
    const next = page.page + step;
    if (next >= 1 && next <= page.pages) return { page: next };
}
