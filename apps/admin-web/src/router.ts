import { createRouter } from 'vue-router';
import type { RouterHistory } from 'vue-router';
import App from './App.vue';

export const headings = {
    works: '全部作品',
    authors: '全部作者',
    issues: '数据异常',
    links: '链接管理',
    update: '下载更新',
    transfer: '分享与导入',
} as const;

export function createAdminRouter(history: RouterHistory) {
    return createRouter({
        history,
        routes: [
            { path: '/', redirect: { name: 'works' } },
            ...Object.keys(headings).map(name => ({
                name,
                path: `/${name}`,
                meta: { section: name },
                component: App,
            })),
            { path: '/works/:workId', name: 'work-playback', component: () => import('./views/WorkPlaybackView.vue') },
            { path: '/authors/:authorId', name: 'author-works', meta: { section: 'authors' }, component: App },
            { path: '/:unmatched(.*)*', redirect: to => ({ name: 'works', query: to.query }) },
        ],
    });
}
