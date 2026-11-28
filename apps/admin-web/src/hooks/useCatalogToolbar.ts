import { eventElement, escapeHtml as escape, requiredElement } from '../dom';
import { viewToggleMarkup, workKindNames as kindNames, workSourceNames as sourceNames } from '../work-labels';
import { byId, findId } from '../utils/catalog-elements';
import { issueNames, reviewNames } from '../utils/catalog-markup';
import type { CatalogRoute, NavigationOptions, QueryChanges } from '../utils/catalog-route';
import { optionMarkup as options } from '../utils/format';

type ToolbarOptions = {
    signal: AbortSignal; getRoute: () => CatalogRoute;
    setParams: (changes: QueryChanges, options?: NavigationOptions) => Promise<unknown>;
    onSelectIssues: (checked: boolean) => void;
};
const issueViews = { ...reviewNames, cleared: '复扫已消除', all: '全部记录' };

export function useCatalogToolbar({ signal, getRoute, setParams, onSelectIssues }: ToolbarOptions) {
    const toolbar = byId('toolbar');
    const listViewToggle = byId('list-view-toggle');
    const headerActions = byId('header-action');
    const headerActionsHome = headerActions.parentElement!;
    let searchTimer: ReturnType<typeof setTimeout> | undefined;
    let filterAuthorId: string | undefined;
    let authorFiltersOpen = false;

    function select(name: string, label: string, values: Record<string, string>, fallback = '') {
        return `<label class="select"><span>${label}</span><select data-filter="${name}" aria-label="${label}">${options(values, getRoute().params.get(name) ?? fallback)}</select></label>`;
    }

    function renderToolbar() {
        toolbar.hidden = false;
        const { view, params, authorId } = getRoute();
        const placeholder = view === 'issues' ? '搜索作品、路径或备注' : view === 'authors' && !authorId ? '搜索作者姓名或曾用名' : '搜索标题、作者或作品 ID';
        let filters = '';
        if (view === 'issues') {
            filters = select('status', '状态', issueViews, 'pending') + select('code', '类型', { '': '全部类型', ...issueNames }) + '<label class="select-page"><input id="select-issue-page" type="checkbox">全选本页</label>';
        } else if (view === 'works' || authorId) {
            filters = select('kind', '类型', { '': '全部类型', ...kindNames }) + select('source', '来源', { '': '全部来源', ...sourceNames });
        }
        let viewToggle = '', pageSelection = '';
        if (view === 'authors' || view === 'works') {
            const list = params.get('layout') === 'list';
            if (view === 'authors' && !authorId) viewToggle = viewToggleMarkup(list ? 'list' : 'cards');
            pageSelection = '<label class="select-page"><input id="select-page" type="checkbox" disabled>全选本页</label>';
        }
        const search = `<label class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" maxlength="200" value="${escape(params.get('q') ?? '')}" placeholder="${placeholder}" aria-label="${placeholder}"></label>`;
        const workPage = view === 'works' || (view === 'authors' && Boolean(authorId));
        toolbar.classList.toggle('author-toolbar', workPage);
        if (workPage) {
            const scope = authorId || 'all-works';
            if (filterAuthorId !== scope) { authorFiltersOpen = false; filterAuthorId = scope; }
            toolbar.innerHTML = `<div class="author-toolbar-row"><div class="author-toolbar-actions"></div>
                <div class="author-toolbar-controls">${pageSelection}<button id="author-filter-toggle" class="plain" type="button" aria-expanded="${authorFiltersOpen}" aria-controls="author-filter-panel">筛选<span class="filter-chevron" aria-hidden="true"></span></button></div></div>
                <div id="author-filter-panel" class="author-filter-panel" role="group" aria-label="作品筛选" ${authorFiltersOpen ? '' : 'hidden'}>${search}${filters}</div>`;
            requiredElement(toolbar, '.author-toolbar-actions').append(headerActions);
        } else {
            toolbar.innerHTML = `${search}<div class="filters">${filters}${pageSelection}</div>`;
        }
        listViewToggle.innerHTML = viewToggle;
        listViewToggle.hidden = !viewToggle;
        const selectIssues = findId('select-issue-page');
        selectIssues?.addEventListener('change', () => onSelectIssues(selectIssues.checked));
        const searchInput = byId('search');
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            const value = searchInput.value;
            searchTimer = setTimeout(() => setParams({ q: value, page: null }, { replace: true }), 220);
        });
        for (const control of toolbar.querySelectorAll<HTMLSelectElement>('[data-filter]')) {
            control.addEventListener('change', () => setParams({ [control.dataset.filter!]: control.value, q: byId('search').value, page: null }));
        }
    }

    toolbar.addEventListener('click', event => {
        const filterToggle = eventElement(event)?.closest('#author-filter-toggle');
        if (filterToggle) {
            authorFiltersOpen = !authorFiltersOpen;
            filterToggle.setAttribute('aria-expanded', String(authorFiltersOpen));
            byId('author-filter-panel').hidden = !authorFiltersOpen;
        }
    }, { signal });
    listViewToggle.addEventListener('click', event => {
        const layout = eventElement(event)?.closest<HTMLElement>('[data-view-layout]');
        if (layout) setParams({ layout: layout.dataset.viewLayout === 'list' ? 'list' : null, q: byId('search').value });
    }, { signal });

    function reset() {
        clearTimeout(searchTimer);
        headerActionsHome.append(headerActions);
        toolbar.classList.remove('author-toolbar');
        listViewToggle.replaceChildren();
        listViewToggle.hidden = true;
    }

    return { render: renderToolbar, reset };
}
