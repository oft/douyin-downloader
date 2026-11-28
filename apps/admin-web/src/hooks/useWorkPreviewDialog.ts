import { catalogApi as api } from '../catalog-api';
import type { Page, WorkDetail } from '../catalog-types';
import type { WorkItem } from '../work-list-types';
import { errorMessage, eventElement, escapeHtml as escape } from '../dom';
import { neighborOnList } from '../playback-context';
import { router } from '../runtime';
import { workKindNames as kindNames, workSourceNames as sourceNames } from '../work-labels';
import { mountWorkPreview } from '../work-preview';
import { byId } from '../utils/catalog-elements';
import { authorLink } from '../utils/catalog-links';
import type { CatalogRoute, NavigationOptions, QueryChanges, WorkListPage } from '../utils/catalog-route';
import { emptyMarkup as box } from '../utils/format';
import type { useCatalogDialog } from './useCatalogDialog';
import type { ShowToast } from './useToast';

type Preview = { id: string; listPage?: WorkListPage; loadingPage: boolean; loadingWork: boolean };
type PreviewOptions = {
    signal: AbortSignal;
    dialog: ReturnType<typeof useCatalogDialog>; showToast: ShowToast; getRoute: () => CatalogRoute;
    setParams: (changes: QueryChanges, options?: NavigationOptions) => Promise<unknown>;
};

export function useWorkPreviewDialog({ dialog, showToast, getRoute, setParams, signal }: PreviewOptions) {
    const { modal } = dialog;
    let workPreview: Preview | undefined;

    async function showWork(id: string, listPage?: WorkListPage) {
        const previous = workPreview;
        const switching = modal.open && modal.classList.contains('work-modal') && Boolean(modal.querySelector('[data-remove-work]'));
        // Keep the current player and dialog geometry while the next work is fetched.
        const version = switching ? dialog.nextVersion() : dialog.open('正在读取作品…', 'work-modal');
        workPreview = { id, listPage, loadingPage: false, loadingWork: true };
        try {
            const work = await api<WorkDetail>(`works/${encodeURIComponent(id)}`);
            if (version !== dialog.version || !modal.open) return;
            dialog.clear();
            byId('modal-title').textContent = work.title;
            byId('modal-subtitle').textContent = [kindNames[work.kind], work.time, work.platformId].filter(Boolean).join('　·　');
            const copies = work.copies.map(copy => `<li><div><strong>${sourceNames[copy.source] ?? escape(copy.source)}</strong><code class="path">${escape(copy.localPath)}</code></div><button type="button" class="plain" data-copy="${escape(copy.localPath)}">复制路径</button></li>`).join('');
            const author = work.authorId ? `<a class="secondary" href="${authorLink(work.authorId)}" data-modal-link>${escape(work.authorName ?? '查看作者')} →</a>` : '';
            const issues = work.issueCount ? `<a class="secondary" href="#/issues?${new URLSearchParams({ target: work.id, status: 'all' })}" data-modal-link>查看异常（${work.issueCount}）</a>` : '';
            const playerHref = router.resolve({ name: 'work-playback', params: { workId: work.id },
                query: { from: listPage?.route.fullPath } }).href;
            const actions = `<div class="work-actions"><a class="secondary" href="${escape(playerHref)}" data-modal-link>独立播放</a><button class="secondary" type="button" data-files="${escape(work.id)}">文件清单</button><button class="secondary danger" type="button" data-remove-work="${escape(work.id)}" aria-keyshortcuts="Delete">删除作品</button></div>`;
            byId('modal-body').innerHTML = `${actions}<div id="work-media"></div><div class="detail-meta">${author}${issues}</div><section class="details"><h3>本地副本（${work.copies.length}）</h3><ul>${copies}</ul></section>`;
            dialog.setMediaCleanup(mountWorkPreview(byId('work-media'), work, () => dialog.isOpen(version)));
        } catch (error) {
            if (version === dialog.version && modal.open) {
                if (switching) {
                    workPreview = previous;
                    showToast(`无法切换作品：${errorMessage(error)}`, true);
                } else byId('modal-body').innerHTML = box('作品无法打开', errorMessage(error));
            }
        } finally {
            if (version === dialog.version && workPreview) workPreview.loadingWork = false;
        }
    }

    async function stepWorkPreview(step: -1 | 1) {
        const preview = workPreview;
        if (!preview?.listPage || preview.loadingPage || preview.loadingWork) return;
        const { data, params } = preview.listPage;
        const neighbor = neighborOnList(data, preview.id, step);
        if (!neighbor) return;
        if (neighbor.id) {
            void showWork(neighbor.id, preview.listPage);
            return;
        }
        const page = neighbor.page;
        const version = dialog.version;
        const path = router.currentRoute.value.fullPath;
        const nextParams = new URLSearchParams(params);
        nextParams.set('page', String(page));
        preview.loadingPage = true;
        try {
            const next = await api<Page<WorkItem>>(`works?${nextParams}`);
            if (version !== dialog.version || !modal.open || router.currentRoute.value.fullPath !== path || next.page !== page) return;
            const work = next.items.at(step > 0 ? 0 : -1);
            if (!work || work.id === preview.id) return;
            const nextListPage = { ...preview.listPage, data: next, params: nextParams };
            if (getRoute() === nextListPage.route) {
                const failure = await setParams({ page }, { replace: true, workPage: nextListPage });
                if (failure || version !== dialog.version || !modal.open) return;
            }
            void showWork(work.id, nextListPage);
        } catch (error) {
            if (version === dialog.version && modal.open) showToast(`无法切换作品：${errorMessage(error)}`, true);
        } finally {
            preview.loadingPage = false;
        }
    }

    window.addEventListener('keydown', event => {
        if (!modal.open || !modal.classList.contains('work-modal') || dialog.deleting) return;
        if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'Delete') {
            const remove = modal.querySelector<HTMLButtonElement>('button[data-remove-work]');
            if (remove) { event.preventDefault(); if (!event.repeat) remove.click(); }
        } else if (workPreview?.listPage && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            if (!event.repeat) void stepWorkPreview(event.key === 'ArrowUp' ? -1 : 1);
        }
    }, { capture: true, signal });

    modal.addEventListener('click', event => {
        if (dialog.deleting) return;
        const back = eventElement(event)?.closest<HTMLElement>('[data-work-back]');
        if (back?.dataset.workBack) void showWork(back.dataset.workBack, workPreview?.listPage);
    }, { signal });
    modal.addEventListener('close', () => {
        if (!modal.open) workPreview = undefined;
    }, { signal });

    return { show: showWork };
}
