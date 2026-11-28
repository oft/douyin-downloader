import { catalogApi as api, jsonHeaders } from '../catalog-api';
import type { Author, IssueRow, Page, ReviewStatus } from '../catalog-types';
import type { WorkItem } from '../work-list-types';
import { errorMessage, eventElement, escapeHtml as escape } from '../dom';
import { mountPagination } from '../pagination';
import { mountWorkList } from '../work-list';
import { byId, findId } from '../utils/catalog-elements';
import { authorLink, issueLink } from '../utils/catalog-links';
import { authorCard, issueCard } from '../utils/catalog-markup';
import { emptyMarkup as box, number } from '../utils/format';
import type { CatalogRoute, ListLoadOptions, NavigationOptions, QueryChanges, WorkListPage } from '../utils/catalog-route';
import { useCatalogStore } from '../stores/catalog';
import { pinia } from '../runtime';
import type { ShowToast } from './useToast';
import { useCatalogToolbar } from './useCatalogToolbar';

type ListOptions = {
    signal: AbortSignal; getRoute: () => CatalogRoute;
    setParams: (changes: QueryChanges, options?: NavigationOptions) => Promise<unknown>;
    showToast: ShowToast;
    onOpen: (id: string, page?: WorkListPage) => void;
    onRemove: (kind: 'authors' | 'works', id?: string, showFiles?: boolean, ids?: string[], authorId?: string, clearWorks?: boolean) => void;
    onReview: (row: IssueRow) => void;
    onAuthorLinkRemoval: (id: string) => void;
    onLoaded: (route: CatalogRoute) => void;
    onIssueSelection: (count: number, works: number) => void;
    onReviewSaved: () => void;
};

export function useCatalogList({ signal, getRoute, setParams, showToast, onOpen, onRemove, onReview,
    onAuthorLinkRemoval, onLoaded, onIssueSelection, onReviewSaved }: ListOptions) {
    const catalog = useCatalogStore(pinia);
    const { selectedAuthors, selectedWorks } = catalog;
    const results = byId('results');
    const toolbar = byId('toolbar');
    const pagination = mountPagination([byId('pagination-top'), byId('pagination')], { onChange: goToPage });
    let listVersion = 0;
    let listController: AbortController | undefined;
    let workListPage: WorkListPage | undefined;
    let workListComponent: ReturnType<typeof mountWorkList> | undefined;
    let issueById = new Map<string, IssueRow>();
    const selectedIssues = new Map<string, IssueRow>();
    let issueMediaVisible = true;
    const toolbarControls = useCatalogToolbar({ signal, getRoute, setParams, onSelectIssues(checked) {
        for (const row of issueById.values()) checked ? selectedIssues.set(row.id, row) : selectedIssues.delete(row.id);
        for (const input of results.querySelectorAll<HTMLInputElement>('[data-select-issue]')) input.checked = checked;
        updateIssueSelection();
    } });

    function goToPage(page: number) { void setParams({ page, q: byId('search').value }); }

    function selectingWorks() { return getRoute().view === 'works' || Boolean(getRoute().authorId); }

    function currentSelection() {
        return selectingWorks() ? selectedWorks : selectedAuthors;
    }

    function selectionActions() {
        return `<button id="clear-selection" class="plain" type="button" hidden>清空选择</button>
            <button id="batch-delete-selection" class="secondary danger" type="button" disabled>${selectingWorks() ? '批量删除作品' : '批量删除'}</button>`;
    }

    function updateSelection() {
        const selectPage = findId('select-page');
        const remove = findId('batch-delete-selection');
        if (!selectPage || !remove) return;
        const selected = currentSelection();
        workListComponent?.setSelection(selected);
        const boxes = [...results.querySelectorAll<HTMLInputElement>('input[data-select-entry]')];
        let checked = 0;
        for (const box of boxes) {
            box.checked = selected.has(box.value);
            if (box.checked) checked++;
        }
        selectPage.disabled = !boxes.length;
        selectPage.checked = boxes.length > 0 && checked === boxes.length;
        selectPage.indeterminate = checked > 0 && checked < boxes.length;
        byId('clear-selection').hidden = !selected.size;
        remove.disabled = !selected.size;
        const label = selectingWorks() ? '批量删除作品' : '批量删除';
        remove.textContent = selected.size ? `${label}（${number.format(selected.size)}）` : label;
    }

    function updateIssueSelection() {
        const works = new Set([...selectedIssues.values()].flatMap(row => row.present && row.targetId ? [row.targetId] : []));
        onIssueSelection(selectedIssues.size, works.size);
    }

    async function reviewSelectedIssues(value: ReviewStatus) {
        if (!selectedIssues.size) return;
        try {
            await api('issues/batch-review', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ids: [...selectedIssues.keys()], status: value }) });
            selectedIssues.clear(); updateIssueSelection(); void loadList(); onReviewSaved(); showToast('所选异常复核已保存');
        } catch (error) { showToast(errorMessage(error), true); }
    }

    function renderPager(data: Pick<Page<unknown>, 'page' | 'pages'>) {
        pagination.update(data);
        pagination.setVisible(getRoute().view !== 'issues' || issueMediaVisible);
    }

    async function loadList({ showLoading = false, workPage }: ListLoadOptions = {}) {
        const version = ++listVersion;
        listController?.abort();
        listController = new AbortController();
        const signal = listController.signal;
        const current = getRoute();
        const { view, authorId } = current;
        if (!['works', 'authors', 'issues'].includes(view) || (view === 'issues' && !catalog.status.scannedAt)) return;
        const authorPage = view === 'authors' && Boolean(authorId);
        const endpoint = authorPage ? 'works' : view;
        const params = new URLSearchParams(current.params);
        if (authorPage && authorId) params.set('author', authorId);
        if (view === 'issues') params.set('size', '15');
        if (endpoint === 'works') {
            pagination.clear();
            if (!workListComponent) workListComponent = mountWorkList(results, {
                onPageChange: goToPage,
                onLayoutChange: layout => setParams({ layout: layout === 'list' ? 'list' : null, q: byId('search').value }),
                onOpen: id => onOpen(id, workListPage),
                authorUrl: authorLink,
                onSelectionChange: ids => { catalog.replaceWorkSelection(ids); updateSelection(); },
                onRetry: () => void loadList({ showLoading: true }),
            });
            workListComponent.setBusy(true);
            if (showLoading) { workListComponent.showLoading(); if (view === 'authors' || view === 'works') updateSelection(); }
        } else {
            pagination.setBusy(true);
            if (showLoading) {
                results.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取…</p></div>';
                pagination.clear();
                if (view === 'authors' || view === 'works') updateSelection();
            }
        }
        results.setAttribute('aria-busy', 'true');
        try {
            const [data, author] = workPage ? [workPage.data, workPage.author]
                : await Promise.all([api<Page<Author | WorkItem | IssueRow>>(`${endpoint}?${params}`, { signal }), authorPage && authorId ? api<Author>(`authors/${encodeURIComponent(authorId)}`, { signal }) : null]);
            if (version !== listVersion) return;
            workListPage = endpoint === 'works' ? { data: data as Page<WorkItem>, params, author, route: current } : undefined;
            if (author) {
                byId('heading').textContent = author.name;
                const issueAction = author.issueCount ? `<a class="secondary" href="${issueLink('author', author.id)}">查看作者异常</a>` : '';
                byId('header-action').innerHTML = `${issueAction}<button class="secondary" type="button" data-remove-author-links="${escape(author.id)}">删除链接</button>
                    <button class="secondary danger" type="button" data-clear-author-works="${escape(author.id)}">清除所有作品</button>
                    <button class="secondary danger" type="button" data-remove-author="${escape(author.id)}">删除作者</button>${selectionActions()}`;
            }
            let summary = `共 ${number.format(data.total)} ${endpoint === 'authors' ? '位作者' : endpoint === 'issues' ? '条异常记录' : '件作品'}`;
            if (author?.aliases.length) summary += `　·　曾用名 ${author.aliases.join('、')}`;
            if (author && author.workCount !== data.total) summary += `　·　作者共 ${number.format(author.workCount)} 件作品`;
            if (endpoint === 'works') {
                const count = byId('author-work-count');
                count.textContent = !author || data.total === author.workCount ? `共 ${number.format(data.total)} 件作品`
                    : `${number.format(data.total)} / ${number.format(author.workCount)} 件作品`;
                count.hidden = false;
                if (author) byId('heading').title = author.name;
                summary = author?.aliases.length ? `曾用名 ${author.aliases.join('、')}` : '';
            }
            byId('summary').textContent = summary;
            if (view === 'issues') {
                issueById = new Map((data.items as IssueRow[]).map(item => [item.id, item]));
                const scoped = params.has('target') || params.has('author');
                byId('header-action').innerHTML = scoped ? '<a class="secondary" href="#/issues">查看全部异常</a>' : '';
            }
            if (endpoint === 'works') {
                workListComponent?.update({ ...data as Page<WorkItem>, layout: params.get('layout') === 'list' ? 'list' : 'cards',
                    selectable: true, overlay: true, showAuthor: !authorPage, selectedIds: selectedWorks });
            } else if (!data.items.length) {
                const description = view === 'issues' && !params.has('q') && !params.has('code') && (!params.has('status') || params.get('status') === 'pending')
                    ? '当前范围内没有待处理的异常。' : '试试其他搜索词或筛选条件。';
                results.innerHTML = box('没有符合条件的记录', description);
            } else if (endpoint === 'authors') {
                const list = params.get('layout') === 'list';
                results.innerHTML = `<div class="${list ? 'author-list' : 'author-grid'}">${(data.items as Author[]).map(item => authorCard(item, list)).join('')}</div>`;
            } else {
                results.innerHTML = `<div class="issue-list">${(data.items as IssueRow[]).map(row => issueCard(row, selectedIssues.has(row.id))).join('')}</div>`;
            }
            if (view === 'authors' || view === 'works') updateSelection();
            if (endpoint !== 'works') renderPager(data);
            onLoaded(current);
            if (view === 'issues') updateIssueSelection();
        } catch (error) {
            if (version !== listVersion) return;
            if (endpoint === 'works') workListComponent?.showError(errorMessage(error));
            else results.innerHTML = box('读取失败', errorMessage(error), '<button type="button" class="secondary" data-retry>重试</button>');
            pagination.clear();
            if (view === 'authors' || view === 'works') updateSelection();
        } finally {
            if (version === listVersion) results.setAttribute('aria-busy', 'false');
        }
    }

    toolbar.addEventListener('change', event => {
        if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'select-page') return;
        const selected = currentSelection();
        for (const box of results.querySelectorAll<HTMLInputElement>('input[data-select-entry]')) {
            if (event.target.checked) selected.add(box.value);
            else selected.delete(box.value);
        }
        updateSelection();
    }, { signal });
    results.addEventListener('change', event => {
        const issue = eventElement(event)?.closest<HTMLInputElement>('input[data-select-issue]');
        if (issue) { const row = issueById.get(issue.dataset.selectIssue ?? ''); if (row) issue.checked ? selectedIssues.set(row.id, row) : selectedIssues.delete(row.id); updateIssueSelection(); return; }
        const box = eventElement(event)?.closest<HTMLInputElement>('input[data-select-entry]');
        if (!box) return;
        const selected = currentSelection();
        if (box.checked) selected.add(box.value);
        else selected.delete(box.value);
        updateSelection();
    }, { signal });
    results.addEventListener('click', event => {
        const item = eventElement(event)?.closest('button');
        if (!item) return;
        if (item.dataset.work) onOpen(item.dataset.work, workListPage);
        if (item.dataset.review) {
            const issue = issueById.get(item.dataset.review);
            if (issue) onReview(issue);
        }
        if (item.dataset.removeIssueWork) onRemove('works', item.dataset.removeIssueWork);
        if (item.hasAttribute('data-retry')) void loadList({ showLoading: true });
    }, { signal });
    results.addEventListener('error', event => {
        if (event.target instanceof HTMLImageElement) event.target.hidden = true;
    }, { capture: true, signal });
    byId('header-action').addEventListener('click', event => {
        const clear = eventElement(event)?.closest<HTMLButtonElement>('button[data-clear-author-works]');
        if (clear) onRemove('authors', clear.dataset.clearAuthorWorks, false, [], undefined, true);
        const author = eventElement(event)?.closest<HTMLButtonElement>('button[data-remove-author]');
        if (author) onRemove('authors', author.dataset.removeAuthor);
        const link = eventElement(event)?.closest<HTMLButtonElement>('button[data-remove-author-links]');
        if (link?.dataset.removeAuthorLinks) onAuthorLinkRemoval(link.dataset.removeAuthorLinks);
        if (eventElement(event)?.closest('#clear-selection')) {
            currentSelection().clear();
            updateSelection();
        }
        if (eventElement(event)?.closest('#batch-delete-selection') && currentSelection().size) {
            onRemove(selectingWorks() ? 'works' : 'authors', undefined, false, [...currentSelection()], getRoute().authorId);
        }
    }, { signal });

    function pause() {
        toolbarControls.reset();
        listController?.abort();
        ++listVersion;
        workListPage = undefined;
        workListComponent?.dispose();
        workListComponent = undefined;
        results.hidden = false;
        issueMediaVisible = true;
        pagination.clear();
    }

    return {
        load: loadList,
        pause,
        dispose() { pause(); pagination.dispose(); },
        renderToolbar: toolbarControls.render, selectionActions, updateSelection, updateIssueSelection, reviewSelectedIssues,
        get page() { return workListPage; },
        clearIssues() { selectedIssues.clear(); updateIssueSelection(); },
        selectedIssueWorks() {
            return [...new Set([...selectedIssues.values()].flatMap(row => row.present && row.targetId ? [row.targetId] : []))];
        },
        setIssueVisibility(visible: boolean) {
            issueMediaVisible = visible;
            results.hidden = toolbar.hidden = !visible;
            pagination.setVisible(visible);
        },
    };
}
