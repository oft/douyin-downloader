import { profileIdFromLink } from './profile-link.js';
import { updateProgressView } from './update-progress.js';
import { linkCheckNames, linkCheckResult } from './link-check.js';

const byId = id => document.getElementById(id);
const modal = byId('modal');
const modalContent = byId('modal-content');
const fullscreenButton = byId('modal-fullscreen');
const results = byId('results');
const toolbar = byId('toolbar');
const pager = byId('pagination');
const number = new Intl.NumberFormat('zh-CN');
const sourceNames = { post: '发布', like: '喜欢', mix: '合集', music: '原声', single: '单条', loose: '散存' };
const kindNames = { video: '视频', album: '图集', unknown: '媒体缺失' };
const issueNames = {
    missing_video: '视频缺失', missing_cover: '封面缺失', incomplete_album: '图集不完整', empty_file: '空文件',
    unreadable_file: '文件无法读取', unreadable_folder: '目录无法读取', missing_metadata: '元数据缺失',
    invalid_metadata: '元数据无法解析', incomplete_metadata: '元数据不完整', unrecognized_media: '媒体无法识别',
};
const reviewNames = { pending: '待处理', resolved: '已处理', ignored: '已忽略' };
const issueViews = { ...reviewNames, cleared: '复扫已消除', all: '全部记录' };
const headings = { works: '全部作品', authors: '全部作者', issues: '数据异常', links: '链接管理', update: '下载更新' };
const updateStates = {
    idle: '空闲', starting: '正在启动', running: '更新中', stopping: '正在停止',
    stopped: '已停止', completed: '已完成', failed: '更新失败',
};
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const jsonHeaders = { 'Content-Type': 'application/json' };
let status = {};
let route;
let listVersion = 0;
let workListPage;
let modalVersion = 0;
let workPreview;
let searchTimer;
let scanTimer;
let scanStatusVersion = 0;
let toastTimer;
let issueById = new Map();
let deleting = false;
const selectedAuthors = new Set();
const selectedWorks = new Set();
let selectionAuthorId;
let linkConfig;
let linkAuthors = {};
let linkDraft = [];
let linkQuery = '';
let savingLinks = false;
let updateTimer;
let updateVersion = 0;
let linkCheck = { state: 'idle', total: 0, completed: 0, results: [] };
const linkCheckResults = new Map();
let linkCheckFilter = '';
let linkCheckTimer;
let linkCheckVersion = 0;
let linkCheckBusy = false;
let showCheckBrowser = false;
const checkActive = () => ['starting', 'running', 'stopping'].includes(linkCheck.state);

function escape(value = '') {
    const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, character => replacements[character]);
}

function asset(id) { return `/media/${encodeURIComponent(id)}`; }
function authorLink(id) { return `#authors/${encodeURIComponent(id)}`; }
function issueLink(key, value) { return `#issues?${new URLSearchParams({ [key]: value })}`; }

async function api(path, init) {
    const response = await fetch(`/api/catalog/${path}`, init);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
    return body;
}

function showToast(message, error = false) {
    const toast = byId('toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function readRoute() {
    const [section, query = ''] = location.hash.slice(1).split('?');
    const [view, authorId] = section.split('/');
    return { view: Object.hasOwn(headings, view) ? view : 'works', authorId: view === 'authors' ? authorId : undefined,
        params: new URLSearchParams(query) };
}

function setParams(changes, { replace = false, workPage } = {}) {
    const params = new URLSearchParams(route.params);
    for (const [key, value] of Object.entries(changes)) {
        if (value != null && value !== '' && !(key === 'page' && Number(value) === 1)) params.set(key, value);
        else params.delete(key);
    }
    const next = `#${route.view}${route.authorId ? `/${route.authorId}` : ''}${params.size ? `?${params}` : ''}`;
    if (next === location.hash) return;
    if (replace) {
        history.replaceState(null, '', next);
        route = readRoute();
        void loadList({ workPage });
    } else location.hash = next;
}

function options(values, current) {
    return Object.entries(values).map(([value, label]) =>
        `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(label)}</option>`).join('');
}

function select(name, label, values, fallback = '') {
    return `<label class="select"><span>${label}</span><select data-filter="${name}" aria-label="${label}">${options(values, route.params.get(name) ?? fallback)}</select></label>`;
}

function renderToolbar() {
    toolbar.hidden = false;
    const { view, params, authorId } = route;
    const placeholder = view === 'issues' ? '搜索作品、路径或备注' : view === 'authors' && !authorId ? '搜索作者姓名或曾用名' : '搜索标题、作者或作品 ID';
    let filters = '';
    if (view === 'issues') {
        filters = select('status', '状态', issueViews, 'pending') + select('code', '类型', { '': '全部类型', ...issueNames });
    } else if (view === 'works' || authorId) {
        filters = select('kind', '类型', { '': '全部类型', ...kindNames }) + select('source', '来源', { '': '全部来源', ...sourceNames });
    }
    if (view === 'authors') {
        const list = params.get('layout') === 'list';
        filters += `<div class="view-layout" role="group" aria-label="${authorId ? '作品' : '作者'}展示方式">
            <button class="secondary" type="button" data-view-layout="cards" aria-pressed="${!list}">卡片</button>
            <button class="secondary" type="button" data-view-layout="list" aria-pressed="${list}">列表</button>
        </div><label class="select-page"><input id="select-page" type="checkbox" disabled>全选本页</label>`;
    }
    toolbar.innerHTML = `<label class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" maxlength="200" value="${escape(params.get('q') ?? '')}" placeholder="${placeholder}" aria-label="${placeholder}"></label><div class="filters">${filters}</div>`;
    byId('search').addEventListener('input', event => {
        clearTimeout(searchTimer);
        const value = event.target.value;
        searchTimer = setTimeout(() => setParams({ q: value, page: null }, { replace: true }), 220);
    });
    for (const control of toolbar.querySelectorAll('[data-filter]')) {
        control.addEventListener('change', () => setParams({ [control.dataset.filter]: control.value, q: byId('search').value, page: null }));
    }
}

function currentSelection() {
    return route.authorId ? selectedWorks : selectedAuthors;
}

function selectionActions() {
    return `<button id="clear-selection" class="plain" type="button" hidden>清空选择</button>
        <button id="batch-delete-selection" class="secondary danger" type="button" disabled>${route.authorId ? '批量删除作品' : '批量删除'}</button>`;
}

function updateSelection() {
    const selectPage = byId('select-page');
    const remove = byId('batch-delete-selection');
    if (!selectPage || !remove) return;
    const selected = currentSelection();
    const boxes = [...results.querySelectorAll('input[data-select-entry]')];
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
    const label = route.authorId ? '批量删除作品' : '批量删除';
    remove.textContent = selected.size ? `${label}（${number.format(selected.size)}）` : label;
}

function box(title, description, extra = '') {
    return `<div class="empty"><h2>${escape(title)}</h2><p>${escape(description)}</p>${extra}</div>`;
}

function entryCheckbox(id, name) {
    return `<label class="entry-check"><input type="checkbox" data-select-entry value="${escape(id)}" aria-label="选择 ${escape(name)}"></label>`;
}

function workCard(work, list, selectable) {
    const label = kindNames[work.kind] ?? '作品';
    const media = `${label}${work.kind === 'album' && work.images.length ? ` · ${work.images.length} 张` : ''}`;
    const thumb = work.cover ? `<img src="${asset(work.cover)}" alt="" loading="lazy" decoding="async">` : '';
    const source = work.sources.map(value => sourceNames[value] ?? value).join(' · ');
    const author = work.authorId ? `<a href="${authorLink(work.authorId)}">${escape(work.authorName ?? '未命名作者')}</a>` : '<span>作者未知</span>';
    return `<article class="work-card">${selectable ? entryCheckbox(work.id, work.title) : ''}
        <button class="thumb ${work.cover ? 'has-image' : ''}" data-work="${escape(work.id)}" type="button" aria-label="预览 ${escape(work.title)}">
            <span class="thumb-placeholder" aria-hidden="true">${work.kind === 'album' ? '▧' : '▷'}</span>${thumb}
            ${list ? '' : `<span class="media-badge">${media}</span>`}
        </button>
        <div class="work-info">
            <button type="button" class="work-title" data-work="${escape(work.id)}" title="${escape(work.title)}">${escape(work.title)}</button>
            ${list ? '' : `<div class="work-author">${author}</div>`}
            <div class="work-foot">${list ? `<span>${media}</span>` : ''}<time>${escape(work.time ? work.time.slice(0, 10) : '日期未知')}</time><span>${escape(source)}</span></div>
        </div>
    </article>`;
}

function authorCard(author, list) {
    const avatar = author.avatar ? `<img src="${asset(author.avatar)}" alt="" loading="lazy" decoding="async">` : '';
    const initial = Array.from(author.name)[0] ?? '◎';
    const count = `<span class="author-count">${number.format(author.workCount)} 件作品</span>`;
    return `<article class="author-entry">${entryCheckbox(author.id, author.name)}
        <a class="author-card" href="${authorLink(author.id)}"><span class="avatar"><span aria-hidden="true">${escape(initial)}</span>${avatar}</span><span class="author-card-info">
        <strong>${escape(author.name)}</strong>${list ? '' : count}${author.aliases.length ? `<small>曾用名 ${escape(author.aliases.join('、'))}</small>` : ''}</span>
        ${list ? count : ''}<span class="author-arrow" aria-hidden="true">›</span></a></article>`;
}

function issueCard(row) {
    const state = row.present ? reviewNames[row.status] : '复扫已消除';
    const workButton = row.targetId && row.present ? `<button type="button" class="plain" data-work="${escape(row.targetId)}">查看作品</button>` : '';
    return `<article class="issue-card">
        <div class="issue-info"><div class="issue-line"><strong>${escape(issueNames[row.code] ?? row.code)}</strong><span class="status-pill ${escape(row.present ? row.status : 'cleared')}">${escape(state)}</span></div>
        <p>${escape(row.title ? `${row.title} · ${row.detail}` : row.detail)}</p><code class="path" title="${escape(row.path)}">${escape(row.path)}</code>
        ${row.note ? `<p class="review-note">备注　${escape(row.note)}</p>` : ''}</div>
        <div class="issue-actions">${workButton}<button type="button" class="secondary" data-review="${escape(row.id)}">复核</button></div>
    </article>`;
}

function renderPager(data) {
    pager.hidden = data.pages <= 1;
    if (pager.hidden) return;
    pager.innerHTML = `<button class="secondary" type="button" data-page="${data.page - 1}" ${data.page === 1 ? 'disabled' : ''}>← 上一页</button>
        <form id="page-jump"><label><span>第</span><input name="page" aria-label="页码" type="number" min="1" max="${data.pages}" value="${data.page}" required><span>页 / ${number.format(data.pages)} 页</span></label><button type="submit" class="plain">跳转</button></form>
        <button class="secondary" type="button" data-page="${data.page + 1}" ${data.page === data.pages ? 'disabled' : ''}>下一页 →</button>`;
}

async function loadList({ showLoading = false, workPage } = {}) {
    const version = ++listVersion;
    const current = route;
    const { view, authorId } = current;
    if (view === 'links' || (view === 'issues' && !status.scannedAt)) return;
    const authorPage = view === 'authors' && Boolean(authorId);
    const endpoint = authorPage ? 'works' : view;
    const params = new URLSearchParams(current.params);
    if (authorPage) params.set('author', authorId);
    if (view === 'issues') params.set('size', '15');
    if (showLoading) {
        results.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取…</p></div>';
        pager.hidden = true;
        if (view === 'authors') updateSelection();
    }
    results.setAttribute('aria-busy', 'true');
    try {
        const [data, author] = workPage ? [workPage.data, workPage.author]
            : await Promise.all([api(`${endpoint}?${params}`), authorPage ? api(`authors/${encodeURIComponent(authorId)}`) : null]);
        if (version !== listVersion) return;
        workListPage = endpoint === 'works' ? { data, params, author, route: current } : undefined;
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
        byId('summary').textContent = summary;
        if (view === 'issues') {
            issueById = new Map(data.items.map(item => [item.id, item]));
            const scoped = params.has('target') || params.has('author');
            byId('header-action').innerHTML = scoped ? '<a class="secondary" href="#issues">查看全部异常</a>' : '';
        }
        if (!data.items.length) {
            const description = view === 'issues' && !params.has('q') && !params.has('code') && (!params.has('status') || params.get('status') === 'pending')
                ? '当前范围内没有待处理的异常。' : '试试其他搜索词或筛选条件。';
            results.innerHTML = box('没有符合条件的记录', description);
        } else if (endpoint === 'authors') {
            const list = params.get('layout') === 'list';
            results.innerHTML = `<div class="${list ? 'author-list' : 'author-grid'}">${data.items.map(item => authorCard(item, list)).join('')}</div>`;
        } else if (endpoint === 'works') {
            const list = authorPage && params.get('layout') === 'list';
            results.innerHTML = `<div class="${list ? 'work-list' : 'work-grid'}">${data.items.map(work => workCard(work, list, authorPage)).join('')}</div>`;
        } else {
            results.innerHTML = `<div class="issue-list">${data.items.map(issueCard).join('')}</div>`;
        }
        if (view === 'authors') updateSelection();
        renderPager(data);
    } catch (error) {
        if (version !== listVersion) return;
        results.innerHTML = box('读取失败', error.message, '<button type="button" class="secondary" data-retry>重试</button>');
        pager.hidden = true;
        if (view === 'authors') updateSelection();
    } finally {
        if (version === listVersion) results.setAttribute('aria-busy', 'false');
    }
}

function linksChanged() {
    return linkConfig && (linkDraft.length !== linkConfig.links.length || linkDraft.some((link, index) => link !== linkConfig.links[index]));
}

function updateLinkControls() {
    byId('add-link').disabled = savingLinks;
    byId('reload-links').disabled = savingLinks;
    byId('link-fields').disabled = savingLinks;
    byId('link-changes').textContent = linksChanged() ? '有未保存的更改' : '';
    byId('save-links').disabled = savingLinks || !linksChanged();
    byId('save-links').textContent = savingLinks ? '保存中…' : '保存配置';
    byId('check-all-links').disabled = savingLinks || linkCheckBusy || checkActive() || !linkDraft.length;
    byId('stop-link-check').hidden = !checkActive();
    byId('stop-link-check').disabled = linkCheckBusy || linkCheck.state === 'stopping';
    byId('show-check-browser').disabled = linkCheckBusy || checkActive();
    results.querySelectorAll('[data-check-link]').forEach(button => {
        button.disabled = savingLinks || linkCheckBusy || checkActive() || !linkDraft[Number(button.dataset.checkLink)]?.trim();
    });
}

function filterLinks() {
    const query = linkQuery.trim().toLowerCase();
    let visible = 0;
    results.querySelectorAll('.link-row').forEach((row, index) => {
        const state = linkCheckResults.get(linkDraft[index])?.status ?? 'unchecked';
        row.hidden = !linkDraft[index].toLowerCase().includes(query) || Boolean(linkCheckFilter && state !== linkCheckFilter);
        if (!row.hidden) visible++;
    });
    byId('link-no-matches').hidden = !(query || linkCheckFilter) || visible > 0 || !linkDraft.length;
    byId('summary').textContent = query || linkCheckFilter ? `显示 ${number.format(visible)} / ${number.format(linkDraft.length)} 条下载链接`
        : `共 ${number.format(linkDraft.length)} 条下载链接`;
}

function updateLinkAuthor(index) {
    const link = results.querySelector(`[data-link-author="${index}"]`);
    const author = linkAuthors[profileIdFromLink(linkDraft[index])];
    link.hidden = !author;
    if (author) {
        link.href = authorLink(author.id);
        link.textContent = `作者页 · ${author.name}`;
    } else link.removeAttribute('href');
}

function renderLinks(focusIndex) {
    byId('header-action').innerHTML = '<button id="add-link" class="secondary" type="button">添加链接</button>';
    results.innerHTML = `<form id="link-form" class="link-form" novalidate>
        <div class="link-controls">
            <div class="link-toolbar"><label class="search"><span aria-hidden="true">⌕</span><input id="link-search" type="search" placeholder="搜索链接" aria-label="搜索链接"></label>
                <div class="form-actions"><button class="secondary" id="reload-links" type="button">重新读取</button>
                <button class="primary" id="save-links" type="submit">保存配置</button></div></div>
            <div class="summary link-changes" id="link-changes" role="status"></div>
            <div class="link-check-toolbar">
                <button class="secondary" id="check-all-links" type="button">检测全部</button>
                <button class="secondary danger" id="stop-link-check" type="button" hidden>停止检测</button>
                <label><input id="show-check-browser" type="checkbox">显示检测浏览器</label>
                <label>检测结果 <select id="link-check-filter" aria-label="按检测结果筛选">
                    ${options({ '': '全部状态', ...linkCheckNames, unchecked: '未检测' }, linkCheckFilter)}
                </select></label>
            </div>
            <p class="summary">检测当前编辑列表，不保存配置、不下载作品。重复链接只检测一次，无法确认的结果不会标为失效。</p>
            <p class="summary" id="link-check-summary" role="status"></p>
            <progress class="link-check-progress" id="link-check-progress" max="1" value="0" aria-label="链接检测进度" hidden></progress>
            <p class="player-error" id="link-check-error" role="alert" hidden></p>
            <p class="player-error" id="link-save-error" role="alert" hidden></p>
        </div>
        <fieldset id="link-fields" class="link-fields" aria-label="下载链接">
            ${linkDraft.length ? `<ol class="link-list">${linkDraft.map((_, index) => `<li class="link-row">
                <div class="link-main"><label>链接 ${index + 1}<textarea name="link" data-link-index="${index}" rows="2" spellcheck="false" required></textarea></label>
                    <p class="link-check-result" data-link-result="${index}">未检测</p></div>
                <div class="link-row-actions"><a class="secondary" data-link-author="${index}" hidden>作者页</a>
                <button class="secondary" type="button" data-check-link="${index}">检测</button>
                <button class="secondary danger" type="button" data-remove-link="${index}" aria-label="移除链接 ${index + 1}">移除</button></div>
            </li>`).join('')}</ol>` : box('暂无下载链接', '点击「添加链接」填写下载地址。')}
        </fieldset>
        <div class="empty" id="link-no-matches" hidden><p>没有符合搜索条件的链接。</p></div>
    </form>`;
    const form = byId('link-form');
    byId('show-check-browser').checked = showCheckBrowser;
    byId('show-check-browser').addEventListener('change', event => { showCheckBrowser = event.target.checked; });
    byId('link-check-filter').addEventListener('change', event => { linkCheckFilter = event.target.value; filterLinks(); });
    byId('check-all-links').addEventListener('click', () => void refreshLinkCheck('start', [...linkDraft]));
    byId('stop-link-check').addEventListener('click', () => void refreshLinkCheck('stop'));
    const search = byId('link-search');
    search.value = linkQuery;
    search.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    const inputs = form.querySelectorAll('[data-link-index]');
    inputs.forEach((input, index) => { input.value = linkDraft[index]; updateLinkAuthor(index); });
    form.addEventListener('input', event => {
        const input = event.target;
        if (input.id === 'link-search') {
            linkQuery = input.value;
            filterLinks();
            return;
        }
        if (input.dataset.linkIndex === undefined) return;
        input.setCustomValidity('');
        const index = Number(input.dataset.linkIndex);
        linkDraft[index] = input.value;
        updateLinkAuthor(index);
        renderLinkCheck();
    });
    form.addEventListener('submit', saveLinks);
    byId('add-link').addEventListener('click', () => {
        linkQuery = '';
        linkDraft.push('');
        renderLinks(linkDraft.length - 1);
    });
    byId('reload-links').addEventListener('click', () => {
        if (!linksChanged() || window.confirm('放弃未保存的更改，重新读取配置？')) void loadLinks({ reload: true });
    });
    filterLinks();
    updateLinkControls();
    renderLinkCheck();
    void refreshLinkCheck();
    results.setAttribute('aria-busy', 'false');
    if (focusIndex !== undefined) {
        const focus = inputs[focusIndex];
        (focus && !focus.closest('[hidden]') ? focus : inputs.length ? byId('link-search') : byId('add-link')).focus();
    }
}

function renderLinkCheck() {
    if (!byId('link-form')) return;
    results.querySelectorAll('[data-link-result]').forEach(node => {
        const link = linkDraft[Number(node.dataset.linkResult)];
        const checked = linkCheckResult(link, linkCheck, linkCheckResults);
        if (node.dataset.status !== checked.status) node.dataset.status = checked.status;
        const text = checked.checkedAt
            ? `${checked.name} · ${checked.reason} · ${date.format(new Date(checked.checkedAt))}` : checked.name;
        if (node.textContent !== text) node.textContent = text;
    });
    const labels = { ...updateStates, running: '检测中', failed: '检测中断', completed: '检测结束' };
    byId('link-check-summary').textContent = linkCheck.state === 'idle' ? '尚未开始检测'
        : `${labels[linkCheck.state]} · 已检测 ${linkCheck.completed} / ${linkCheck.total} 条链接（去重后）`;
    const bar = byId('link-check-progress');
    bar.hidden = !linkCheck.total;
    bar.max = linkCheck.total || 1;
    bar.value = linkCheck.completed;
    const error = byId('link-check-error');
    error.textContent = linkCheck.error || '';
    error.hidden = !error.textContent;
    updateLinkControls();
    filterLinks();
}

async function refreshLinkCheck(action, links) {
    if (action === 'start' && (!links?.length || links.some(link => !link.trim()))) {
        showToast('请先填写或移除空白链接', true); return;
    }
    clearTimeout(linkCheckTimer);
    const version = ++linkCheckVersion;
    const current = () => version === linkCheckVersion && route.view === 'links' && byId('link-form');
    if (action) { linkCheckBusy = true; updateLinkControls(); }
    try {
        const next = action ? await api(`link-check/${action}`, { method: 'POST', headers: jsonHeaders,
            body: JSON.stringify(action === 'start' ? { links, showBrowser: showCheckBrowser } : {}) }) : await api('link-check');
        if (!current()) return;
        linkCheck = next;
        linkCheckResults.clear();
        for (const result of next.results ?? []) linkCheckResults.set(result.link, result);
        renderLinkCheck();
    } catch (error) {
        if (current()) {
            const node = byId('link-check-error');
            node.textContent = error.message; node.hidden = false;
        }
    } finally {
        if (action) linkCheckBusy = false;
        if (current()) {
            updateLinkControls();
            if (checkActive()) linkCheckTimer = setTimeout(() => void refreshLinkCheck(), 1500);
        }
    }
}

async function loadLinks({ reload = false } = {}) {
    const version = ++listVersion;
    if (linkConfig && !reload && (savingLinks || linksChanged())) {
        renderLinks();
        return;
    }
    byId('header-action').replaceChildren();
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取链接配置…</p></div>';
    try {
        const [data, matches] = await Promise.all([api('links'), api('link-authors').catch(() => ({ authors: {} }))]);
        if (version !== listVersion) return;
        linkConfig = data;
        linkAuthors = matches.authors;
        linkDraft = [...data.links];
        renderLinks();
    } catch (error) {
        if (version !== listVersion) return;
        results.innerHTML = box('链接配置读取失败', error.message, '<button type="button" class="secondary" data-reload-links>重试</button>');
    } finally {
        if (version === listVersion) results.setAttribute('aria-busy', 'false');
    }
}

async function saveLinks(event) {
    event.preventDefault();
    if (savingLinks || !linksChanged()) return;
    const blankIndex = linkDraft.findIndex(link => !link.trim());
    if (blankIndex !== -1) {
        linkQuery = '';
        renderLinks(blankIndex);
        const blank = results.querySelector(`[data-link-index="${blankIndex}"]`);
        blank.setCustomValidity('请输入下载链接，或移除这条空白记录。');
        blank.reportValidity();
        return;
    }
    savingLinks = true;
    byId('link-save-error').hidden = true;
    updateLinkControls();
    try {
        linkConfig = await api('links', { method: 'PUT', headers: jsonHeaders,
            body: JSON.stringify({ links: linkDraft, revision: linkConfig.revision }) });
        linkDraft = [...linkConfig.links];
        if (byId('link-form')) filterLinks();
        showToast('链接配置已保存');
    } catch (error) {
        const message = byId('link-save-error');
        if (message) {
            message.textContent = error.message;
            message.hidden = false;
        } else showToast(error.message, true);
    } finally {
        savingLinks = false;
        if (byId('link-form')) updateLinkControls();
    }
}

function showUpdate() {
    results.setAttribute('aria-busy', 'false');
    byId('summary').textContent = '按已保存的链接运行一轮下载，优先处理从未更新或最久未更新的作者。';
    results.innerHTML = `<section class="update-panel" aria-label="下载任务">
        <div class="update-controls">
            <div>
                <div class="summary">当前状态</div>
                <div id="update-state" class="update-state" role="status">正在读取状态…</div>
            </div>
            <div class="form-actions">
                <button class="primary" type="button" data-update-action="start" disabled>启动更新</button>
                <button class="secondary danger" type="button" data-update-action="stop" disabled>停止更新</button>
            </div>
        </div>
        <div class="update-overall">
            <div class="update-progress-label"><strong id="update-link-progress"></strong><strong id="update-percent">—</strong></div>
            <progress id="update-link-bar" max="1" value="0" aria-label="链接总进度"></progress>
            <p class="summary">总进度按链接计算，作品数量在抓取列表后确定。</p>
        </div>
        <div class="update-metrics">
            <div><span>已下载作品</span><strong id="update-success">0</strong></div>
            <div><span>已跳过作品</span><strong id="update-skipped">0</strong></div>
            <div><span>作品失败</span><strong id="update-failed">0</strong></div>
            <div><span>链接失败</span><strong id="update-failedUrls">0</strong></div>
        </div>
        <dl class="update-current">
            <div><dt>当前作者</dt><dd id="update-author">—</dd></div>
            <div><dt>当前阶段</dt><dd id="update-phase">尚未开始</dd></div>
            <div><dt>已用时间</dt><dd id="update-elapsed">—</dd></div>
            <div><dt>进度更新</dt><dd id="update-freshness">尚未收到进度</dd></div>
        </dl>
        <p id="update-url" class="summary update-url" hidden></p>
        <div class="update-items">
            <div class="update-progress-label"><span>本组作品</span><span id="update-itemsText"></span></div>
            <progress id="update-item-bar" max="1" value="0" aria-label="本组作品进度"></progress>
        </div>
        <p id="update-detail" class="summary" hidden></p>
        <p id="update-queueText" class="summary" hidden></p>
        <p id="update-file" class="summary" hidden></p>
        <p id="update-message" class="update-message" hidden></p>
        <p id="update-details" class="summary" hidden></p>
        <p id="update-error" role="alert" hidden></p>
    </section>`;
    void refreshUpdate();
}

function renderUpdateProgress(task) {
    const view = updateProgressView(task);
    for (const field of ['author', 'phase', 'elapsed', 'freshness', 'url', 'detail', 'file', 'message',
        'success', 'skipped', 'failed', 'failedUrls', 'percent', 'itemsText', 'queueText']) {
        const node = byId(`update-${field}`);
        const value = String(view[field]);
        if (node.textContent !== value) node.textContent = value;
        if (['url', 'detail', 'file', 'message', 'queueText'].includes(field)) node.hidden = !value;
    }
    byId('update-link-progress').textContent = view.linkText;
    byId('update-link-bar').max = view.total || 1;
    byId('update-link-bar').value = view.completed;
    byId('update-item-bar').max = view.itemsTotal || 1;
    if (view.itemsIndeterminate) byId('update-item-bar').removeAttribute('value');
    else byId('update-item-bar').value = view.itemsCompleted;
}

async function refreshUpdate(action) {
    clearTimeout(updateTimer);
    const version = ++updateVersion;
    const current = () => version === updateVersion && route.view === 'update';
    const state = byId('update-state');
    const details = byId('update-details');
    const message = byId('update-error');
    const start = results.querySelector('[data-update-action="start"]');
    const stop = results.querySelector('[data-update-action="stop"]');
    if (action) start.disabled = stop.disabled = true;

    try {
        const next = action
            ? await api(`update/${action}`, { method: 'POST', headers: jsonHeaders, body: '{}' })
            : await api('update');
        if (!current()) return;
        const previous = state.dataset.state;
        const active = ['starting', 'running', 'stopping'].includes(next.state);
        if (previous !== next.state) state.textContent = updateStates[next.state];
        state.dataset.state = next.state;
        start.disabled = active;
        stop.disabled = !active || next.state === 'stopping';
        details.textContent = [
            next.startedAt && `开始于 ${date.format(new Date(next.startedAt))}`,
            next.finishedAt && `结束于 ${date.format(new Date(next.finishedAt))}`,
        ].filter(Boolean).join(' · ');
        details.hidden = !details.textContent;
        renderUpdateProgress(next);
        const error = next.error ?? '';
        if (message.textContent !== error) message.textContent = error;
        message.hidden = !error;
        if (next.finishedAt && previous !== next.state) void refreshStatus();
    } catch (error) {
        if (!current()) return;
        if (action) showToast(error.message, true);
        else {
            if (state.dataset.state !== 'unavailable') state.textContent = '状态不可用';
            state.dataset.state = 'unavailable';
            start.disabled = stop.disabled = true;
            if (message.textContent !== error.message) message.textContent = error.message;
            message.hidden = false;
        }
    } finally {
        if (current()) updateTimer = setTimeout(() => void refreshUpdate(), 1500);
    }
}

function navigate() {
    clearTimeout(searchTimer);
    clearTimeout(updateTimer);
    clearTimeout(linkCheckTimer);
    ++linkCheckVersion;
    if (modal.open) modal.close();
    ++listVersion;
    workListPage = undefined;
    route = readRoute();
    const { view, authorId } = route;
    if (authorId && selectionAuthorId !== authorId) {
        selectedWorks.clear();
        selectionAuthorId = authorId;
    }
    for (const link of document.querySelectorAll('[data-view]')) {
        if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
    byId('heading').textContent = authorId ? '作者作品' : headings[view];
    byId('back').hidden = !authorId;
    byId('summary').textContent = '';
    byId('header-action').replaceChildren();
    pager.hidden = true;
    if (view === 'update') {
        toolbar.hidden = true;
        showUpdate();
        void refreshStatus();
    } else if (view === 'links') {
        toolbar.hidden = true;
        void loadLinks();
    } else {
        renderToolbar();
        if (view === 'authors' && !authorId) {
            byId('header-action').innerHTML = selectionActions();
        }
        if (view === 'issues' && !status.scannedAt) {
            results.setAttribute('aria-busy', 'true');
            results.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在扫描本地媒体…</p></div>';
            void refreshStatus({ scanIfNeeded: true });
        } else {
            void loadList({ showLoading: true });
            void refreshStatus();
        }
    }
    window.scrollTo(0, 0);
}

function renderStatus() {
    const active = status.scanning;
    const error = status.error ?? status.databaseError;
    byId('scan-button').disabled = active;
    byId('scan-state').dataset.state = active ? 'scanning' : error ? 'error' : 'ready';
    byId('scan-label').textContent = active ? '正在扫描媒体异常' : status.error ? '媒体扫描失败'
        : status.databaseError ? '数据库读取失败' : status.scannedAt ? '异常扫描已完成' : '媒体异常未扫描';
    byId('scan-time').textContent = status.scannedAt ? date.format(new Date(status.scannedAt)) : '';
    byId('scan-state').title = [status.root, error].filter(Boolean).join('\n');
    byId('nav-works').textContent = status.works === undefined ? '' : number.format(status.works);
    byId('nav-authors').textContent = status.authors === undefined ? '' : number.format(status.authors);
    byId('nav-issues').textContent = status.scannedAt ? number.format(status.pending) : '';
    if (route.view === 'issues' && status.error && !status.scannedAt) {
        results.setAttribute('aria-busy', 'false');
        results.innerHTML = box('媒体扫描失败', status.error, '<button type="button" class="secondary" data-rescan>重新扫描</button>');
    }
}

async function refreshStatus({ rescan = false, scanIfNeeded = false } = {}) {
    const version = ++scanStatusVersion;
    clearTimeout(scanTimer);
    const previous = status;
    try {
        let next = rescan ? null : await api('status');
        if (version !== scanStatusVersion) return;
        if (!next || (scanIfNeeded && !next.scannedAt && !next.scanning && !next.error)) {
            next = await api('scan', { method: 'POST', headers: jsonHeaders, body: '{}' });
        }
        if (version !== scanStatusVersion) return;
        status = next;
        renderStatus();
        if ((route.view === 'issues' || (['works', 'authors'].includes(route.view) && (rescan || previous.scanning))) &&
            status.scannedAt && status.scannedAt !== previous.scannedAt) void loadList({ showLoading: !previous.scannedAt });
        if (status.scanning) scanTimer = setTimeout(() => void refreshStatus(), 800);
        if (previous.scanning && !status.scanning && status.error && status.scannedAt) showToast(status.error, true);
    } catch (error) {
        if (version !== scanStatusVersion) return;
        byId('scan-button').disabled = false;
        byId('scan-label').textContent = '扫描状态不可用';
        byId('scan-state').dataset.state = 'error';
        if (route.view === 'issues' && !status.scannedAt) {
            results.setAttribute('aria-busy', 'false');
            results.innerHTML = box('无法扫描媒体', error.message, '<button type="button" class="secondary" data-rescan>重试</button>');
        } else showToast(error.message, true);
    }
}

function clearModalBody() {
    const video = modal.querySelector('video');
    if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
    }
    byId('modal-body').replaceChildren();
}

function updateFullscreenButton() {
    const workOpen = modal.open && modal.classList.contains('work-modal');
    const fullscreen = document.fullscreenElement === modalContent;
    fullscreenButton.hidden = !document.fullscreenEnabled || !workOpen;
    fullscreenButton.textContent = fullscreen ? '退出全屏' : '全屏';
    if (!workOpen) exitWorkFullscreen();
}

function exitWorkFullscreen() {
    if (document.fullscreenElement === modalContent) void document.exitFullscreen().catch(() => {});
}

function openModal(title, variant) {
    byId('modal-title').textContent = title;
    byId('modal-subtitle').textContent = '';
    clearModalBody();
    modal.className = variant;
    modal.scrollTop = 0;
    if (!modal.open) modal.showModal();
    updateFullscreenButton();
    return ++modalVersion;
}

function renderPreview(work) {
    if (work.video) return `<video class="video-player" controls playsinline${document.fullscreenEnabled ? ' controlslist="nofullscreen"' : ''} preload="metadata" src="${asset(work.video)}"${work.cover ? ` poster="${asset(work.cover)}"` : ''}></video><p id="player-error" class="player-error" role="status" hidden>此视频无法播放，请检查文件或浏览器支持的格式。</p>`;
    if (work.images.length) {
        return `<div class="album-player"><img id="album-image" src="${asset(work.images[0])}" alt="图集第 1 张图片"></div>
            <div class="album-controls"><button type="button" class="secondary" id="album-prev" disabled>← 上一张</button><span id="album-count">1 / ${work.images.length}</span>
            <button type="button" class="secondary" id="album-next" ${work.images.length < 2 ? 'disabled' : ''}>下一张 →</button></div>`;
    }
    return box('没有可预览的本地媒体', '可以在异常记录中查看文件检查结果。');
}

async function showWork(id, listPage) {
    const previous = workPreview;
    const switching = modal.open && modal.classList.contains('work-modal') && Boolean(modal.querySelector('[data-remove-work]'));
    // Keep the current player and dialog geometry while the next work is fetched.
    const version = switching ? ++modalVersion : openModal('正在读取作品…', 'work-modal');
    workPreview = { id, listPage, loadingPage: false, loadingWork: true };
    try {
        const work = await api(`works/${encodeURIComponent(id)}`);
        if (version !== modalVersion || !modal.open) return;
        clearModalBody();
        byId('modal-title').textContent = work.title;
        byId('modal-subtitle').textContent = [kindNames[work.kind], work.time, work.platformId].filter(Boolean).join('　·　');
        const copies = work.copies.map(copy => `<li><div><strong>${sourceNames[copy.source] ?? escape(copy.source)}</strong><code class="path">${escape(copy.localPath)}</code></div><button type="button" class="plain" data-copy="${escape(copy.localPath)}">复制路径</button></li>`).join('');
        const author = work.authorId ? `<a class="secondary" href="${authorLink(work.authorId)}" data-modal-link>${escape(work.authorName ?? '查看作者')} →</a>` : '';
        const issues = work.issueCount ? `<a class="secondary" href="#issues?${new URLSearchParams({ target: work.id, status: 'all' })}" data-modal-link>查看异常（${work.issueCount}）</a>` : '';
        const actions = `<div class="work-actions"><button class="secondary" type="button" data-files="${escape(work.id)}">文件清单</button><button class="secondary danger" type="button" data-remove-work="${escape(work.id)}" aria-keyshortcuts="Delete">删除作品</button></div>`;
        byId('modal-body').innerHTML = `${actions}${renderPreview(work)}<div class="detail-meta">${author}${issues}</div><section class="details"><h3>本地副本（${work.copies.length}）</h3><ul>${copies}</ul></section>`;
        const video = modal.querySelector('video');
        if (video) {
            const message = byId('player-error');
            const failed = () => { message.hidden = false; };
            video.addEventListener('error', failed);
            if (video.error) failed();
            void video.play().catch(error => {
                if (error.name !== 'NotAllowedError' || version !== modalVersion || !modal.open) return;
                video.muted = true;
                return video.play().catch(() => {});
            });
        }
        if (byId('album-image')) {
            let index = 0;
            const change = step => {
                index = Math.max(0, Math.min(work.images.length - 1, index + step));
                byId('album-image').src = asset(work.images[index]);
                byId('album-image').alt = `图集第 ${index + 1} 张图片`;
                byId('album-count').textContent = `${index + 1} / ${work.images.length}`;
                byId('album-prev').disabled = index === 0;
                byId('album-next').disabled = index === work.images.length - 1;
            };
            byId('album-prev').addEventListener('click', () => change(-1));
            byId('album-next').addEventListener('click', () => change(1));
        }
    } catch (error) {
        if (version === modalVersion && modal.open) {
            if (switching) {
                workPreview = previous;
                showToast(`无法切换作品：${error.message}`, true);
            } else byId('modal-body').innerHTML = box('作品无法打开', error.message);
        }
    } finally {
        if (version === modalVersion && workPreview) workPreview.loadingWork = false;
    }
}

async function stepWorkPreview(step) {
    const preview = workPreview;
    if (!preview?.listPage || preview.loadingPage || preview.loadingWork) return;
    const { data, params } = preview.listPage;
    const index = data.items.findIndex(work => work.id === preview.id);
    if (index < 0) return;
    const adjacent = data.items[index + step];
    if (adjacent) {
        void showWork(adjacent.id, preview.listPage);
        return;
    }

    const page = data.page + step;
    if (page < 1 || page > data.pages) return;
    const version = modalVersion;
    const hash = location.hash;
    const nextParams = new URLSearchParams(params);
    nextParams.set('page', page);
    preview.loadingPage = true;
    try {
        const next = await api(`works?${nextParams}`);
        if (version !== modalVersion || !modal.open || location.hash !== hash || next.page !== page) return;
        const work = next.items.at(step > 0 ? 0 : -1);
        if (!work || work.id === preview.id) return;
        const nextListPage = { ...preview.listPage, data: next, params: nextParams };
        if (route === nextListPage.route) {
            setParams({ page }, { replace: true, workPage: nextListPage });
            nextListPage.route = route;
        }
        void showWork(work.id, nextListPage);
    } catch (error) {
        if (version === modalVersion && modal.open) showToast(`无法切换作品：${error.message}`, true);
    } finally {
        preview.loadingPage = false;
    }
}

function formatSize(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let index = 0;
    while (bytes >= 1024 && index < units.length - 1) {
        bytes /= 1024;
        index++;
    }
    return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: index ? 2 : 0 }).format(bytes)} ${units[index]}`;
}

function fileList(copy, index) {
    const source = sourceNames[copy.source] ?? copy.source;
    const type = copy.flat ? '平铺文件' : '作品目录';
    const kinds = { directory: '目录', link: '链接', other: '其他' };
    const rows = copy.files.map(file => {
        const ext = file.name.split('/').at(-1).match(/\.([^.]+)$/)?.[1];
        const label = file.kind === 'file' ? ext?.toUpperCase() || '文件' : kinds[file.kind];
        return `<tr><td>${escape(file.name)}</td><td>${escape(label)}</td><td>${file.size === undefined ? '—' : formatSize(file.size)}</td></tr>`;
    }).join('');
    const entries = copy.error ? `<p class="player-error">无法读取：${escape(copy.error)}</p>` : rows
        ? `<table class="file-table"><thead><tr><th scope="col">文件名</th><th scope="col">类型</th><th scope="col">大小</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="summary">目录为空</p>';
    return `<details class="file-copy" ${index === 0 ? 'open' : ''}><summary><strong>${escape(source)}</strong><span>${type} · ${number.format(copy.files.length)} 项</span></summary>
        <div class="file-copy-body"><div class="file-path"><code class="path">${escape(copy.directory || '下载根目录')}</code><button class="plain" type="button" data-copy="${escape(copy.directory)}">复制目录</button></div>${entries}</div></details>`;
}

async function showAuthorLinkRemoval(id) {
    const version = openModal('删除链接', 'review-modal');
    const body = byId('modal-body');
    const endpoint = `authors/${encodeURIComponent(id)}/links`;
    body.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取作者链接…</p></div>';
    try {
        const plan = await api(endpoint);
        if (version !== modalVersion || !modal.open) return;
        byId('modal-subtitle').textContent = plan.name;
        if (!plan.links.length) {
            body.innerHTML = box('没有匹配的作者主页链接', '可以在链接管理中查看配置里的其他链接。',
                '<a class="secondary" href="#links" data-modal-link>打开链接管理</a>');
            return;
        }
        const listing = plan.links.map(link => `<li><code class="path">${escape(link)}</code></li>`).join('');
        body.innerHTML = `<p class="removal-count">将从下载器配置移除以下 ${number.format(plan.links.length)} 条作者主页链接</p>
            <ul class="removal-works author-link-preview">${listing}</ul>
            <p id="author-link-error" class="player-error" role="alert" hidden></p>
            <div class="form-actions"><button id="reload-author-links" class="secondary" type="button" hidden>重新读取链接</button>
                <button class="secondary" type="button" data-dismiss>取消</button>
                <button id="confirm-author-links" class="primary danger" type="button">确认删除链接</button></div>`;
        const confirm = byId('confirm-author-links');
        const retry = byId('reload-author-links');
        const message = byId('author-link-error');
        retry.addEventListener('click', () => void showAuthorLinkRemoval(id));
        confirm.addEventListener('click', async () => {
            if (deleting) return;
            deleting = true;
            const controls = [...modal.querySelectorAll('button:not(:disabled)')];
            controls.forEach(control => { control.disabled = true; });
            confirm.textContent = '正在删除…';
            try {
                const result = await api(endpoint, { method: 'DELETE', headers: jsonHeaders,
                    body: JSON.stringify({ revision: plan.revision }) });
                if (!linksChanged()) linkConfig = undefined;
                if (version === modalVersion && modal.open) modal.close();
                showToast(`已删除 ${number.format(result.removedLinks)} 条作者主页链接`);
            } catch (error) {
                if (version === modalVersion && modal.open) {
                    message.textContent = error.message;
                    message.hidden = false;
                    retry.hidden = false;
                } else showToast(error.message, true);
            } finally {
                deleting = false;
                controls.forEach(control => { control.disabled = false; });
                confirm.textContent = '确认删除链接';
            }
        });
    } catch (error) {
        if (version === modalVersion && modal.open) body.innerHTML = box('无法读取作者链接', error.message);
    }
}

async function showRemoval(kind, id, showFiles = false, batchIds = [], batchAuthorId, clearWorks = false) {
    const isAuthor = kind === 'authors';
    const batch = batchIds.length > 0;
    const subject = isAuthor ? '作者' : '作品';
    const title = clearWorks ? '清除作者所有作品' : batch ? `批量删除${subject}` : showFiles ? '作品文件清单' : `删除${subject}`;
    const confirmLabel = clearWorks ? '清除文件并重置为未下载' : '永久删除';
    const endpoint = clearWorks ? `authors/${encodeURIComponent(id)}/works/clear`
        : batch ? isAuthor ? 'authors/batch-removal' : `authors/${encodeURIComponent(batchAuthorId)}/works/batch-removal`
        : `${kind}/${encodeURIComponent(id)}`;
    const version = openModal(title, 'remove-modal');
    const body = byId('modal-body');
    body.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取文件…</p></div>';
    try {
        const plan = batch ? await api(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ids: batchIds }) })
            : await api(clearWorks ? endpoint : `${endpoint}/${isAuthor ? 'removal' : 'files'}`);
        if (version !== modalVersion || !modal.open) return;
        byId('modal-subtitle').textContent = batch ? `已选 ${number.format(isAuthor ? plan.authors.length : plan.workCount)} ${isAuthor ? '位作者' : '件作品'}` : plan.title;
        const summary = `${number.format(plan.workCount)} 件作品 · ${number.format(plan.copyCount)} 个副本 · ${number.format(plan.fileCount)} 个文件 · ${formatSize(plan.size)}`;
        const authorWorks = plan.works?.map(work => `<li><span>${escape(work.title)}</span><small>${number.format(work.copyCount)} 个副本</small></li>`).join('');
        const authors = batch && isAuthor ? `<details class="file-copy" open><summary><strong>所选作者</strong></summary><ul class="removal-works">${plan.authors.map(author => `<li><span>${escape(author.name)}</span><small>${number.format(author.workCount)} 件作品</small></li>`).join('')}</ul></details>` : '';
        const listing = (isAuthor || batch) && authorWorks ? `<details class="file-copy" ${authors ? '' : 'open'}><summary><strong>受影响的作品</strong></summary><ul class="removal-works">${authorWorks}</ul>${plan.workCount > plan.works.length ? `<p class="summary more-works">此处显示前 ${plan.works.length} 件，全部 ${number.format(plan.workCount)} 件都在删除范围内。</p>` : ''}</details>`
            : (plan.copies ?? []).map(fileList).join('');
        const scope = clearWorks ? `将清除此作者的全部本地作品，包括其他分页和当前筛选条件之外的作品。保留下载链接和数据库作品记录，将 ${number.format(plan.resetWorks ?? 0)} 条作品记录重置为未下载，下次手动更新时可重新下载。本地文件清除后无法从资料库恢复。`
            : isAuthor ? `${batch ? '所选作者' : '此作者'}的全部本地作品副本和对应数据库记录将永久删除，同时移除配置中匹配的 ${number.format(plan.removedLinks ?? 0)} 条作者主页链接。删除后无法从资料库恢复。`
            : `${batch ? '所选作品' : '此作品'}的本地副本和对应数据库记录将永久删除。平铺文件按清单删除。删除后无法从资料库恢复。`;
        const errors = plan.errors.length ? `<div class="player-error" role="alert">清单无法完整读取，请检查目录后刷新数据库。<ul>${plan.errors.slice(0, 5).map(error => `<li>${escape(error)}</li>`).join('')}</ul></div>` : '';
        const back = isAuthor || batch ? '<button class="secondary" type="button" data-dismiss>取消</button>' : `<button class="secondary" type="button" data-work-back="${escape(id)}">返回作品</button>`;
        body.innerHTML = `<p class="removal-count">${summary}</p>${authors}${listing}<p class="summary removal-scope">${scope}</p>${errors}
            <p id="removal-error" class="player-error" role="alert" hidden></p><div class="form-actions">${back}<button id="confirm-removal" class="primary danger" type="button" ${plan.token ? '' : 'disabled'}>${confirmLabel}</button></div>`;
        byId('confirm-removal').addEventListener('click', async () => {
            if (deleting) return;
            deleting = true;
            const controls = [...modal.querySelectorAll('button:not(:disabled)')];
            controls.forEach(control => { control.disabled = true; });
            byId('confirm-removal').textContent = '正在删除…';
            try {
                const result = await api(endpoint, { method: 'DELETE', headers: jsonHeaders,
                    body: JSON.stringify({ mode: 'permanent', token: plan.token, ids: batch ? batchIds : undefined }) });
                if (isAuthor && !clearWorks && !linksChanged()) linkConfig = undefined;
                if (clearWorks) selectedWorks.clear();
                const selection = isAuthor ? selectedAuthors : selectedWorks;
                for (const selected of batch ? batchIds : [id]) selection.delete(selected);
                updateSelection();
                const showReceipt = version === modalVersion && modal.open;
                ++scanStatusVersion;
                clearTimeout(scanTimer);
                status = result;
                renderStatus();
                if (isAuthor && route.authorId === id) {
                    history.replaceState(null, '', '#authors');
                    navigate();
                } else if (route.view === 'issues' && !status.scannedAt) void refreshStatus({ rescan: true });
                else void loadList();
                if (showReceipt) {
                    openModal(clearWorks ? '已清除作者作品' : batch ? `已删除 ${number.format(batchIds.length)} ${isAuthor ? '位作者' : '件作品'}` : `已删除${subject}`, 'review-modal');
                    const scanWarning = result.databaseError ? '<p class="player-error">无法读取更新后的数据库，请刷新页面。</p>' : '';
                    body.innerHTML = `<p class="summary">已永久删除 ${number.format(result.deletedFiles)} 个文件和 ${number.format(result.deletedDirectories)} 个目录。${clearWorks ? `已将 ${number.format(result.resetWorks ?? 0)} 条作品记录重置为未下载，下载链接已保留。` : isAuthor ? `已移除 ${number.format(result.removedLinks ?? 0)} 条作者主页链接。` : ''}</p>${scanWarning}<div class="form-actions"><button class="secondary" type="button" data-dismiss>完成</button></div>`;
                } else showToast(clearWorks ? '作品文件已清除，状态已重置为未下载' : '永久删除已完成');
            } catch (error) {
                if (version === modalVersion && modal.open) {
                    const message = byId('removal-error');
                    message.textContent = error.message;
                    message.hidden = false;
                    byId('confirm-removal').textContent = confirmLabel;
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.className = 'secondary';
                    retry.textContent = '重新读取清单';
                    retry.addEventListener('click', () => void showRemoval(kind, id, showFiles, batchIds, batchAuthorId, clearWorks));
                    message.after(retry);
                    controls.splice(controls.indexOf(byId('confirm-removal')), 1);
                } else showToast(error.message, true);
                void refreshStatus();
            } finally {
                deleting = false;
                controls.forEach(control => { control.disabled = false; });
            }
        });
    } catch (error) {
        if (version === modalVersion && modal.open) body.innerHTML = box('无法读取清单', error.message);
    }
}

function editReview(id) {
    const row = issueById.get(id);
    if (!row) return;
    openModal('复核异常', 'review-modal');
    byId('modal-subtitle').textContent = `${issueNames[row.code] ?? row.code} · ${row.detail}`;
    byId('modal-body').innerHTML = `<form id="review-form"><code class="path">${escape(row.path)}</code>
        <label>处理状态<select name="status">${options(reviewNames, row.status)}</select></label>
        <label>备注<textarea name="note" rows="4" maxlength="2000" placeholder="记录核查结果或处理方式">${escape(row.note)}</textarea></label>
        <p id="save-error" role="alert" hidden></p><div class="form-actions"><button type="button" class="secondary" data-dismiss>取消</button><button type="submit" class="primary">保存复核</button></div></form>`;
    byId('review-form').addEventListener('submit', async event => {
        event.preventDefault();
        const version = modalVersion;
        const submit = event.submitter;
        submit.disabled = true;
        const form = new FormData(event.currentTarget);
        try {
            await api(`issues/${encodeURIComponent(id)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(Object.fromEntries(form)) });
            if (version === modalVersion && modal.open) modal.close();
            void loadList();
            void refreshStatus();
            showToast('复核已保存');
        } catch (error) {
            if (version === modalVersion && modal.open) {
                byId('save-error').textContent = error.message;
                byId('save-error').hidden = false;
            }
        } finally { submit.disabled = false; }
    });
}

function goToPage(page) { setParams({ page, q: byId('search').value }); }

window.addEventListener('keydown', event => {
    if (!modal.open || !modal.classList.contains('work-modal') || deleting) return;
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Delete') {
        const remove = modal.querySelector('button[data-remove-work]');
        if (!remove) return;
        event.preventDefault();
        if (!event.repeat) remove.click();
    } else if (workPreview?.listPage && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        if (!event.repeat) void stepWorkPreview(event.key === 'ArrowUp' ? -1 : 1);
    }
}, { capture: true });

toolbar.addEventListener('click', event => {
    const layout = event.target.closest('[data-view-layout]');
    if (layout) setParams({ layout: layout.dataset.viewLayout === 'list' ? 'list' : null, q: byId('search').value });
});
toolbar.addEventListener('change', event => {
    if (event.target.id !== 'select-page') return;
    const selected = currentSelection();
    for (const box of results.querySelectorAll('input[data-select-entry]')) {
        if (event.target.checked) selected.add(box.value);
        else selected.delete(box.value);
    }
    updateSelection();
});
results.addEventListener('change', event => {
    const box = event.target.closest('input[data-select-entry]');
    if (!box) return;
    const selected = currentSelection();
    if (box.checked) selected.add(box.value);
    else selected.delete(box.value);
    updateSelection();
});
results.addEventListener('click', event => {
    const item = event.target.closest('button');
    if (!item) return;
    if (item.dataset.work) void showWork(item.dataset.work, workListPage);
    if (item.dataset.review) editReview(item.dataset.review);
    if (item.hasAttribute('data-retry')) void loadList({ showLoading: true });
    if (item.hasAttribute('data-rescan')) void refreshStatus({ rescan: true });
    if (item.hasAttribute('data-reload-links')) void loadLinks({ reload: true });
    if (item.hasAttribute('data-check-link')) void refreshLinkCheck('start', [linkDraft[Number(item.dataset.checkLink)]]);
    if (item.dataset.updateAction) void refreshUpdate(item.dataset.updateAction);
    if (item.hasAttribute('data-remove-link')) {
        const index = Number(item.dataset.removeLink);
        linkDraft.splice(index, 1);
        renderLinks(Math.min(index, linkDraft.length - 1));
    }
});
results.addEventListener('error', event => { if (event.target instanceof HTMLImageElement) event.target.hidden = true; }, true);
pager.addEventListener('click', event => {
    const item = event.target.closest('button[data-page]');
    if (item) goToPage(item.dataset.page);
});
pager.addEventListener('submit', event => {
    event.preventDefault();
    goToPage(new FormData(event.target).get('page'));
});
byId('scan-button').addEventListener('click', () => void refreshStatus({ rescan: true }));
byId('open-douyin').addEventListener('click', async () => {
    const button = byId('open-douyin');
    button.disabled = true;
    try {
        const result = await api('browser/open', { method: 'POST', headers: jsonHeaders, body: '{}' });
        if (result.state === 'failed') throw new Error(result.error || '无法打开抖音');
        showToast('已请求打开抖音，完成登录和保存选择后可关闭窗口，登录状态会自动保存。');
        await new Promise(resolve => setTimeout(resolve, 1500));
        const current = await api('browser');
        if (current.state === 'failed') throw new Error(current.error || '无法打开抖音');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
});
byId('header-action').addEventListener('click', event => {
    const clear = event.target.closest('button[data-clear-author-works]');
    if (clear) void showRemoval('authors', clear.dataset.clearAuthorWorks, false, [], undefined, true);
    const author = event.target.closest('button[data-remove-author]');
    if (author) void showRemoval('authors', author.dataset.removeAuthor);
    const link = event.target.closest('button[data-remove-author-links]');
    if (link) void showAuthorLinkRemoval(link.dataset.removeAuthorLinks);
    if (event.target.closest('#clear-selection')) {
        currentSelection().clear();
        updateSelection();
    }
    if (event.target.closest('#batch-delete-selection') && currentSelection().size) {
        void showRemoval(route.authorId ? 'works' : 'authors', undefined, false, [...currentSelection()], route.authorId);
    }
});
fullscreenButton.addEventListener('click', () => {
    const change = document.fullscreenElement === modalContent ? document.exitFullscreen() : modalContent.requestFullscreen();
    void change.catch(error => showToast(`无法切换全屏：${error.message}`, true));
});
document.addEventListener('fullscreenchange', updateFullscreenButton);
byId('modal-close').addEventListener('click', () => modal.close());
modal.addEventListener('cancel', event => {
    if (deleting || document.fullscreenElement === modalContent) event.preventDefault();
    if (!deleting) exitWorkFullscreen();
});
modal.addEventListener('click', async event => {
    if (deleting) return;
    if (event.target === modal || event.target.closest('[data-modal-link], [data-dismiss]')) modal.close();
    const files = event.target.closest('[data-files]');
    if (files) void showRemoval('works', files.dataset.files, true);
    const removal = event.target.closest('[data-remove-work]');
    if (removal) void showRemoval('works', removal.dataset.removeWork);
    const back = event.target.closest('[data-work-back]');
    if (back) void showWork(back.dataset.workBack, workPreview?.listPage);
    const copy = event.target.closest('[data-copy]');
    if (copy) {
        try {
            const suffix = copy.dataset.copy;
            const filePath = status.root + (suffix ? (status.root.includes('\\') ? `\\${suffix.replaceAll('/', '\\')}` : `/${suffix}`) : '');
            await navigator.clipboard.writeText(filePath);
            showToast('已复制本地路径');
        } catch { showToast('无法访问剪贴板，可以手动选择路径文本', true); }
    }
});
modal.addEventListener('close', () => {
    if (modal.open) return;
    updateFullscreenButton();
    modalVersion++;
    workPreview = undefined;
    clearModalBody();
});
byId('back').addEventListener('click', () => window.history.back());
window.addEventListener('hashchange', navigate);
navigate();
