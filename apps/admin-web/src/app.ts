import { h, render } from 'vue';
import { catalogApi as api } from './catalog-api';
import type { Page, WorkDetail } from './catalog-types';
import { errorMessage } from './dom';
import { useCatalogDialog } from './hooks/useCatalogDialog';
import { useCatalogList } from './hooks/useCatalogList';
import { useCatalogRemoval } from './hooks/useCatalogRemoval';
import { useCatalogStatus } from './hooks/useCatalogStatus';
import { useIssueReview } from './hooks/useIssueReview';
import { useLinkManagement } from './hooks/useLinkManagement';
import type { ShowToast } from './hooks/useToast';
import { useWorkPreviewDialog } from './hooks/useWorkPreviewDialog';
import { useIssueCenter } from './hooks/useIssueCenter';
import { headings } from './router';
import { pinia, router } from './runtime';
import { useCatalogStore } from './stores/catalog';
import { useTransferView } from './hooks/useTransferView';
import { byId } from './utils/catalog-elements';
import { applyCatalogQuery, readCatalogRoute } from './utils/catalog-route';
import type { CatalogRoute, NavigationOptions, QueryChanges, WorkListPage } from './utils/catalog-route';
import { emptyMarkup } from './utils/format';
import UpdateView from './views/UpdateView.vue';

export function mountCatalogApp(showToast: ShowToast) {
    const effects = new AbortController();
    const { signal } = effects;
    const catalog = useCatalogStore(pinia);
    const results = byId('results');
    const toolbar = byId('toolbar');
    const scanControls = byId('media-scan-controls');
    const scanControlsHome = scanControls.parentElement!;
    const header = byId('header-action');
    const sectionHeader = header.parentElement!;

    let route = readCatalogRoute(router.currentRoute.value);
    let listOnlyNavigation: { from: string; to: string; workPage?: WorkListPage } | undefined;
    let playbackReturn: { path: string; scroll: number } | undefined;
    let issueCenter: ReturnType<typeof useIssueCenter> | undefined;
    let disposePanel: (() => void) | undefined;
    const getRoute = () => route;

    const dialog = useCatalogDialog({ showToast, signal, getRoot: () => catalog.status.root });
    const links = useLinkManagement(showToast, signal);
    const preview = useWorkPreviewDialog({ dialog, showToast, getRoute, setParams, signal });
    const editReview = useIssueReview(dialog, showToast, () => { void list.load(); void status.refresh(); });
    const removal = useCatalogRemoval({
        dialog, showToast, getRoute, signal, invalidateLinks: links.invalidate,
        onSelectionChanged: () => list.updateSelection(),
        onRefreshStatus: () => void status.refresh(),
        onRemoved(snapshot, navigating) {
            status.replace(snapshot);
            if (navigating) return;
            if (route.view === 'issues' && !snapshot.scannedAt) {
                list.clearIssues();
                results.innerHTML = emptyMarkup('清理已完成，请手动复扫核对结果', '点击上方“扫描媒体异常”重新检查。');
                void status.refresh();
            } else void list.load();
        },
    });
    const list = useCatalogList({
        signal, getRoute, setParams, showToast,
        onOpen: (id, page) => void preview.show(id, page),
        onRemove: (...args) => void removal.showRemoval(...args),
        onReview: editReview,
        onAuthorLinkRemoval: id => void removal.showAuthorLinkRemoval(id),
        onIssueSelection: (count, works) => issueCenter?.updateSelection(count, works),
        onReviewSaved: () => void status.refresh(),
        onLoaded(current) {
            if (playbackReturn?.path !== current.fullPath) return;
            const { scroll } = playbackReturn;
            playbackReturn = undefined;
            requestAnimationFrame(() => {
                if (route === current && router.currentRoute.value.fullPath === current.fullPath) window.scrollTo(0, scroll);
            });
        },
    });
    const status = useCatalogStatus({
        signal, showToast, getRoute,
        onScanChanged: options => void list.load(options),
        onScanRequested: list.clearIssues,
    });

    async function setParams(changes: QueryChanges, { replace = false, workPage }: NavigationOptions = {}) {
        const current = router.currentRoute.value;
        const params = applyCatalogQuery(route.params, changes);
        const next = `${current.path}${params.size ? `?${params}` : ''}`;
        if (!replace) return router.push(next);
        const navigation = { from: current.fullPath, to: router.resolve(next).fullPath, workPage };
        listOnlyNavigation = navigation;
        try { return await router.replace(next); }
        finally { if (listOnlyNavigation === navigation) listOnlyNavigation = undefined; }
    }

    function disposeView() {
        scanControlsHome.append(scanControls);
        scanControls.hidden = true;
        issueCenter?.dispose();
        issueCenter = undefined;
        links.close();
        disposePanel?.();
        disposePanel = undefined;
        list.pause();
        dialog.close();
    }

    function navigate(next: CatalogRoute) {
        disposeView();
        route = next;
        const { view, authorId } = next;
        const workScope = view === 'works' || Boolean(authorId);
        if (workScope) catalog.enterWorkScope(authorId);
        sectionHeader.classList.toggle('work-page', workScope);
        const heading = byId('heading');
        heading.textContent = authorId ? '作者作品' : headings[view];
        heading.removeAttribute('title');
        const count = byId('author-work-count');
        count.hidden = true;
        count.textContent = '';
        byId('back').hidden = !authorId;
        byId('summary').textContent = '';
        header.replaceChildren();

        if (view === 'issues') openIssues();
        if (view === 'transfer') {
            toolbar.hidden = true;
            disposePanel = useTransferView({ results, api, showToast, onChanged: () => void status.refresh() });
        } else if (view === 'update') {
            toolbar.hidden = true;
            byId('summary').textContent = '按已保存的链接运行一轮下载，优先处理从未更新或最久未更新的作者。';
            results.setAttribute('aria-busy', 'false');
            results.replaceChildren();
            render(h(UpdateView, { api, showToast, onChanged: () => void status.refresh() }), results);
            disposePanel = () => render(null, results);
            void status.refresh();
        } else if (view === 'links') {
            toolbar.hidden = true;
            links.open();
        } else {
            list.renderToolbar();
            if ((view === 'authors' && !authorId) || view === 'works') header.innerHTML = list.selectionActions();
            if (view === 'issues' && !catalog.status.scannedAt) {
                results.innerHTML = emptyMarkup('尚未扫描媒体异常', '点击上方“扫描媒体异常”开始检查。打开页面不会自动扫描。');
                results.setAttribute('aria-busy', 'false');
            } else void list.load({ showLoading: true });
            void status.refresh();
        }
        window.scrollTo(0, 0);
    }

    function openIssues() {
        issueCenter = useIssueCenter({
            root: byId('issue-center'), api, showToast,
            onBusyChange: busy => { byId('scan-button').disabled = busy || Boolean(catalog.status.scanning); },
            onMediaVisibility: list.setIssueVisibility,
            onBatchRemoval() {
                const ids = list.selectedIssueWorks();
                if (ids.length) void removal.showRemoval('works', undefined, false, ids);
                else showToast('所选异常未关联可清理作品，请逐条核对路径', true);
            },
            onBatchReview: value => void list.reviewSelectedIssues(value),
            async onFindWork(id) {
                try {
                    const data = await api<Page<WorkDetail>>(`works?q=${encodeURIComponent(id)}&size=100`);
                    const work = data.items.find(item => item.platformId === id);
                    if (work) void preview.show(work.id);
                    else showToast('本地尚未找到此作品记录');
                } catch (error) { showToast(errorMessage(error), true); }
            },
            onChanged: () => { links.invalidate(); void status.refresh(); },
        });
        byId('cleanup-media-scan-slot').append(scanControls);
        scanControls.hidden = false;
        list.updateIssueSelection();
    }

    byId('back').addEventListener('click', () => router.back(), { signal });

    const removeRouteListener = router.afterEach((to, from, failure) => {
        if (failure) return;
        if (to.name === 'work-playback') {
            if (from.meta.section) {
                playbackReturn = { path: from.fullPath, scroll: window.scrollY };
                disposeView();
                status.stopPolling();
            }
            return;
        }
        if (from.name !== 'work-playback' || playbackReturn?.path !== to.fullPath) playbackReturn = undefined;
        const next = readCatalogRoute(to);
        const navigation = listOnlyNavigation;
        if (navigation?.from === from.fullPath && navigation.to === to.fullPath) {
            route = next;
            if (navigation.workPage) navigation.workPage.route = next;
            void list.load({ workPage: navigation.workPage });
        } else navigate(next);
    });

    if (router.currentRoute.value.meta.section) navigate(route);
    return () => {
        removeRouteListener();
        disposeView();
        status.stopPolling();
        dialog.clear();
        list.dispose();
        effects.abort();
    };
}
