import { h, render } from 'vue';
import IssueCenterView from '../views/IssueCenterView.vue';
import { linkCheckNames } from '../link-check';
import { errorMessage, eventElement, escapeHtml as escape, requiredElement } from '../dom';
import type { catalogApi } from '../catalog-api';
import type { LinkConfig, Page, ReviewStatus } from '../catalog-types';
import type { LinkCheckJob } from '../link-check';
import type { UpdateTask } from '../update-progress';

type EmptyAuthor = {
    id: string; name: string; uid?: string; secUid?: string; urls: string[];
    currentWorks: number; historicalWorks: number; incomingWorks: number;
};
type AuthorReport = { candidates: EmptyAuthor[]; token: string; protectedAuthors: number; pendingAuthors: number };
type MaintenanceState = {
    busy?: boolean; changing?: boolean; scanning?: boolean; localFiles?: UpdateTask; report?: AuthorReport; error?: string;
};
type DiagnosticFields = { author?: string; phase?: string; reason?: string; state?: string; status?: string };
type AuthorDiagnostic = DiagnosticFields & {
    pages?: number; elapsedMs?: number; localSaved?: number | null; total?: number | null;
    received?: number | null; newWorks?: number | null; downloaded?: number | null; targetKey?: string;
};
type HistoryAudit = DiagnosticFields & {
    scope: string; registered_count?: number | null; homepage_total?: number | null; remaining_gap?: number | null;
    checked_gap?: number | null; pages?: number; received?: number; oldest_time?: number; repair_works?: number; retry_requested?: number;
};
type Diagnostics = {
    current?: UpdateTask;
    report?: {
        current?: UpdateTask; checkedAt: string;
        summary: { authors: number; onePage: number; medianMs: number; failed: number };
        slowest: (AuthorDiagnostic & { elapsedMs: number })[];
        authors: AuthorDiagnostic[]; audits: HistoryAudit[];
    } | null;
};
type ImportIssuePage = Page<{ name: string; reason: string; target?: string; workId?: string }> & {
    resolvedUnassigned?: number; kind: string; unassignedTotal: number; source?: string;
};
type CenterOptions = {
    root: HTMLElement; api: typeof catalogApi; showToast: (message: string, error?: boolean) => void;
    onMediaVisibility: (visible: boolean) => void; onBatchRemoval: () => void; onBatchReview: (value: ReviewStatus) => void;
    onFindWork: (id: string) => void; onChanged?: () => void; onBusyChange?: (busy: boolean) => void;
};
type CenterElements =
    & Record<'cleanup-diagnostics-query', HTMLInputElement>
    & Record<'cleanup-diagnostics-status' | 'cleanup-import-type' | 'cleanup-log-days', HTMLSelectElement>
    & Record<'cleanup-diagnostics-refresh' | 'cleanup-local-files' | 'cleanup-local-files-stop' | 'cleanup-author-scan'
        | 'cleanup-author-remove' | 'cleanup-links-remove' | 'cleanup-links-check' | 'cleanup-links-stop'
        | 'cleanup-delete-works' | 'cleanup-resolve' | 'cleanup-ignore' | 'cleanup-confirm' | 'cleanup-cancel' | 'cleanup-import-load', HTMLButtonElement>
    & Record<'cleanup-dialog', HTMLDialogElement>;

const count = (value?: number | null) => new Intl.NumberFormat('zh-CN').format(value ?? 0);
const active = (state: string) => ['starting', 'running', 'stopping'].includes(state);

/** Entering this view reads status only. Every scan, check and mutation starts from a button. */
export function useIssueCenter({ root, api, showToast, onMediaVisibility, onBatchRemoval, onBatchReview, onFindWork, onChanged, onBusyChange }: CenterOptions) {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: MaintenanceState = {};
    let report: AuthorReport | undefined;
    let links: string[] = [];
    let linkJob: LinkCheckJob = { state: 'idle', total: 0, completed: 0, results: [] };
    let currentTab = 'media', authorPage = 1;
    const authorSelection = new Set<string>(), linkSelection = new Set<string>();
    const events = new AbortController();
    const json = { 'Content-Type': 'application/json' };
    root.hidden = false;
    root.replaceChildren();
    render(h(IssueCenterView), root);
    const el = <K extends string>(id: K) => requiredElement<K extends keyof CenterElements ? CenterElements[K] : HTMLElement>(root, `#${id}`);
    const post = <T = unknown>(endpoint: string, body: object = {}) => api<T>(endpoint, { method: 'POST', headers: json, body: JSON.stringify(body) });
    const remove = <T = unknown>(endpoint: string, body: object) => api<T>(endpoint, { method: 'DELETE', headers: json, body: JSON.stringify({ ...body, mode: 'permanent' }) });
    let diagnostic: Diagnostics | undefined;
    const diagnosticNames: Record<string, string> = { saved_boundary: '已到达已有作品边界', previous_gap_checked: '同一差额已核对，本轮检查新增页', missing_work_gap: '新增待核对差额超过5条', page_not_saved: '当前页有主媒体待补齐', profile_timeout: '作者资料获取超时', first_page_timeout: '首批作品获取超时', history_budget: '历史核对达到时间预算', listing_incomplete: '作品列表未取全，保留待复核', user_unavailable: '作者当前不可访问，保留本地历史作品' };
    const statusNames: Record<string, string> = { running: '运行中', finished: '已完成', failed: '失败', interrupted: '已中断', checked: '本轮已核对', budget: '达到预算，历史待复核', partial: '历史未取全', queued: '已标记下次重试', unavailable: '作者当前不可访问', starting: '启动中', stopping: '停止中', stopped: '已停止', completed: '已完成', idle: '未运行' };
    const optionalCount = (value?: number | null) => value === undefined || value === null ? '—' : count(value);
    function renderDiagnostics() {
        const report = diagnostic?.report;
        const task = diagnostic?.current ?? report?.current;
        const progress = task?.progress ?? {};
        el('cleanup-diagnostics-current').textContent = task ? [`当前更新：${statusNames[task.state] || task.state}`, progress.author, progress.step, progress.detail].filter(Boolean).join(' · ') : '';
        if (!report) { el('cleanup-diagnostics-summary').textContent = '尚无已保存的诊断，点击“刷新运行诊断”汇总。'; return; }
        el('cleanup-diagnostics-summary').textContent = `截至 ${new Date(report.checkedAt).toLocaleString('zh-CN')}：${count(report.summary.authors)} 位作者，${count(report.summary.onePage)} 位一页结束，中位耗时 ${(report.summary.medianMs / 1000).toFixed(1)} 秒，${count(report.summary.failed)} 位失败。旧日志缺少的字段显示为 —。`;
        el('cleanup-diagnostics-slowest').innerHTML = `<details><summary>最近最慢作者（前10次记录）</summary><ol>${(report.slowest || []).map(row => `<li>${escape(row.author || '昵称未获取')} · ${(row.elapsedMs / 1000).toFixed(1)}秒 · ${count(row.pages)}页 · ${escape(diagnosticNames[row.reason ?? ''] || row.reason || row.phase || '—')}</li>`).join('')}</ol></details>`;
        const query = el('cleanup-diagnostics-query').value.trim().toLowerCase();
        const view = el('cleanup-diagnostics-status').value;
        const matches = (row: DiagnosticFields) => (!query || [row.author, row.phase, row.reason, diagnosticNames[row.reason ?? '']].join(' ').toLowerCase().includes(query)) &&
            (view === 'all' || (view === 'failed' ? ['failed', 'interrupted', 'partial', 'budget', 'unavailable', 'queued'].includes(row.state ?? row.status ?? '') : (view === 'finished' ? ['finished', 'checked'].includes(row.state ?? row.status ?? '') : (row.state ?? row.status ?? '') === view)));
        const rows = report.authors.filter(matches).slice(0, 100);
        el('cleanup-diagnostics-list').innerHTML = `<h3>作者耗时与分页原因</h3><p class="summary">最近记录最多显示100条，可按作者筛选；下方保留历史核对进度。</p><div class="cleanup-table-wrap"><table class="cleanup-table"><thead><tr><th>作者</th><th>状态 / 阶段</th><th>耗时 / 页数</th><th>本地登记 / 主页参考</th><th>获取 / 新作品 / 下载</th><th>继续或停止原因</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escape(row.author || '昵称未获取')}</td><td>${escape(statusNames[row.state ?? ''] || row.state)}<small>${escape(row.phase || '')}</small></td><td>${row.elapsedMs == null ? (row.state === 'running' ? '进行中' : '—') : (row.elapsedMs / 1000).toFixed(1) + '秒'} / ${count(row.pages)}页</td><td>${optionalCount(row.localSaved)} / ${optionalCount(row.total)}</td><td>${optionalCount(row.received)} / ${optionalCount(row.newWorks)} / ${optionalCount(row.downloaded)}</td><td>${escape(diagnosticNames[row.reason ?? ''] || row.reason || '—')}${row.targetKey ? `<small><button class="secondary" data-author-retry="${escape(row.targetKey)}" ${row.state === 'queued' ? 'disabled' : ''}>下次更新优先重试</button></small>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
        const audits = report.audits.filter(matches).slice(0, 100);
        el('cleanup-audit-list').innerHTML = `<h3>历史差额与待复核记录</h3><div class="cleanup-table-wrap"><table class="cleanup-table"><thead><tr><th>作者 / 状态</th><th>登记 / 主页参考 / 差额</th><th>已核对</th><th>处理说明</th><th>手动操作</th></tr></thead><tbody>${audits.map(row => `<tr><td>${escape(row.author)}<small>${escape(row.retry_requested ? '已标记下次重核' : statusNames[row.status ?? ''] || row.status)}</small></td><td>${optionalCount(row.registered_count)} / ${optionalCount(row.homepage_total)} / ${optionalCount(row.remaining_gap)}<small>已核对历史差额 ${optionalCount(row.checked_gap)}</small></td><td>${count(row.pages)}页，${count(row.received)}条<small>${row.oldest_time ? '历史最远核对到 ' + new Date(row.oldest_time * 1000).toLocaleDateString('zh-CN') : ''}</small></td><td>${escape(row.reason || '保留已取得的进度')}<small>发现待补主媒体 ${count(row.repair_works)} 条</small></td><td><button class="secondary" data-audit-retry="${escape(row.scope)}" ${row.retry_requested ? 'disabled' : ''}>下次更新重核历史</button></td></tr>`).join('')}</tbody></table></div>`;
    }
    async function loadDiagnostics(refresh = false) {
        el('cleanup-diagnostics-refresh').disabled = true;
        try {
            const result = refresh ? await post<Diagnostics>('maintenance/diagnostics/refresh') : await api<Diagnostics>('maintenance/diagnostics');
            if (!alive) return;
            diagnostic = result; renderDiagnostics();
        } catch (error) { if (alive) el('cleanup-diagnostics-summary').textContent = errorMessage(error); }
        finally { if (alive) el('cleanup-diagnostics-refresh').disabled = false; }
    }
    el('cleanup-diagnostics-query').addEventListener('input', renderDiagnostics, { signal: events.signal });
    el('cleanup-diagnostics-status').addEventListener('change', renderDiagnostics, { signal: events.signal });
    const dialog = el('cleanup-dialog');
    let confirmation: (() => Promise<void>) | undefined;
    function lockControls() {
        const busy = Boolean(state.busy || state.changing);
        const fileJob = state.localFiles ?? { state: 'idle' };
        el('cleanup-local-files').disabled = busy || Boolean(state.scanning);
        el('cleanup-local-files-stop').disabled = !active(fileJob.state);
        el('cleanup-local-files-status').textContent = fileJob.error || (fileJob.state === 'stopped' ? '扫描已停止，原登记结果保留' : '') || fileJob.progress?.message || fileJob.progress?.detail ||
            (active(fileJob.state) ? '正在扫描本地文件…' : fileJob.state === 'stopped' ? '扫描已停止，原登记结果保留' : '尚未手动扫描');
        root.dataset.busy = String(Boolean(busy)); onBusyChange?.(busy);
        el('cleanup-lock').textContent = busy ? '导入、更新或其他操作进行中，清理暂不可用' : '清理仅在确认后执行';
        el('cleanup-author-scan').disabled = Boolean(state.scanning || state.changing);
        el('cleanup-author-remove').disabled = busy || Boolean(state.scanning) || !authorSelection.size;
        el('cleanup-links-remove').disabled = busy || active(linkJob.state) || !linkSelection.size;
        el('cleanup-links-check').disabled = busy || active(linkJob.state);
        el('cleanup-links-stop').disabled = !active(linkJob.state);
        for (const id of ['cleanup-delete-works', 'cleanup-resolve', 'cleanup-ignore'] as const) el(id).disabled = busy || !root.dataset.mediaSelection;
    }
    function renderAuthors() {
        const rows = report?.candidates ?? [], pages = Math.max(1, Math.ceil(rows.length / 50));
        authorPage = Math.min(authorPage, pages);
        el('cleanup-author-summary').textContent = state.scanning ? '正在核对当前、历史和待导入作品…' : report
            ? `${count(rows.length)} 条无作品作者；保留 ${count(report.protectedAuthors)} 位有关联作品的作者，其中 ${count(report.pendingAuthors)} 位有待传作品` : state.error || '尚未扫描';
        if (!report) { el('cleanup-author-list').replaceChildren(); return; }
        const page = rows.slice((authorPage - 1) * 50, authorPage * 50);
        el('cleanup-author-list').innerHTML = rows.length ? `<div class="cleanup-table-wrap"><table class="cleanup-table"><thead><tr><th>选择</th><th>作者 / 固定 ID</th><th>关联链接</th><th>作品核对</th></tr></thead><tbody>${page.map(a => `<tr><td><input type="checkbox" data-cleanup-author="${a.id}" aria-label="选择 ${escape(a.name)}" ${authorSelection.has(a.id) ? 'checked' : ''}></td><td><strong>${escape(a.name)}</strong><code>${escape(a.uid || a.secUid)}</code></td><td>${a.urls.map(u => `<a href="${escape(/^https?:\/\//.test(u) ? u : '#')}" target="_blank" rel="noreferrer">${escape(u)}</a>`).join('<br>') || '无链接'}</td><td>当前 ${a.currentWorks} · 历史 ${a.historicalWorks} · 待传 ${a.incomingWorks}</td></tr>`).join('')}</tbody></table></div><div class="cleanup-actions"><button class="secondary" data-author-page="${authorPage - 1}" ${authorPage === 1 ? 'disabled' : ''}>上一页</button><span>${authorPage} / ${pages} 页</span><button class="secondary" data-author-page="${authorPage + 1}" ${authorPage === pages ? 'disabled' : ''}>下一页</button><button class="secondary" id="cleanup-author-page-select">选择本页</button></div>` : '<p class="cleanup-empty">没有可清理的无作品作者。</p>';
        lockControls();
    }
    async function refresh() {
        clearTimeout(timer);
        try {
            const value = await api<MaintenanceState>('maintenance/status');
            if (!alive) return;
            const changed = value.report?.token !== report?.token;
            state = value;
            if (changed) { report = value.report; authorSelection.clear(); renderAuthors(); }
            else el('cleanup-author-summary').textContent = state.scanning ? '正在核对当前、历史和待导入作品…' : state.error || (report ? `${count(report.candidates.length)} 条无作品作者；保留 ${count(report.protectedAuthors)} 位有关联作品的作者，其中 ${count(report.pendingAuthors)} 位有待传作品` : '尚未扫描');
            lockControls();
        } catch (error) { if (alive) el('cleanup-lock').textContent = errorMessage(error); }
        finally { if (alive) timer = setTimeout(refresh, state.scanning || state.busy || state.changing ? 2000 : 8000); }
    }
    function showConfirmation(title: string, html: string, callback: () => Promise<void>) {
        confirmation = callback;
        el('cleanup-dialog-title').textContent = title;
        el('cleanup-dialog-body').innerHTML = html;
        el('cleanup-dialog-error').hidden = true;
        el('cleanup-confirm').disabled = false; el('cleanup-cancel').disabled = false;
        dialog.showModal();
    }
    el('cleanup-cancel').onclick = () => dialog.close();
    dialog.addEventListener('cancel', event => { if (el('cleanup-cancel').disabled) event.preventDefault(); });
    el('cleanup-confirm').onclick = async () => {
        if (!confirmation) return;
        el('cleanup-confirm').disabled = el('cleanup-cancel').disabled = true;
        try { await confirmation(); if (!alive) return; dialog.close(); showToast('所选项目清理完成'); onChanged?.(); await refresh(); }
        catch (error) { if (alive) { el('cleanup-dialog-error').textContent = `${errorMessage(error)}；请关闭后重新读取或扫描，再确认范围。`; el('cleanup-dialog-error').hidden = false; } }
        finally { if (alive) el('cleanup-cancel').disabled = false; }
    };
    function renderLinks() {
        const found = new Map((linkJob.results ?? []).map(r => [r.link, r]));
        el('cleanup-link-status').textContent = active(linkJob.state) ? `检测中 ${count(linkJob.completed)} / ${count(linkJob.total)}` : linkJob.error || (links.length ? `共 ${count(links.length)} 条；勾选后预览移除范围` : '尚未读取');
        el('cleanup-link-list').innerHTML = links.length ? `<div class="cleanup-table-wrap"><table class="cleanup-table"><thead><tr><th>选择</th><th>链接</th><th>检测结果</th></tr></thead><tbody>${links.map((link, index) => { const r = found.get(link); return `<tr><td><input type="checkbox" data-cleanup-link="${index}" aria-label="选择第 ${index + 1} 条链接" ${linkSelection.has(link) ? 'checked' : ''}></td><td><a href="${escape(/^https?:\/\//.test(link) ? link : '#')}" target="_blank" rel="noreferrer">${escape(link)}</a></td><td>${escape(r ? linkCheckNames[r.status] : '未检测')}<small>${escape(r?.reason || '')}</small></td></tr>`; }).join('')}</tbody></table></div>` : '';
        lockControls();
    }
    async function loadLinks() {
        const [config, job] = await Promise.all([api<LinkConfig>('links'), api<LinkCheckJob>('link-check')]);
        if (!alive) return;
        links = config.links; linkJob = job; linkSelection.clear(); renderLinks();
    }
    async function pollLinks() {
        try { linkJob = await api<LinkCheckJob>('link-check'); if (!alive) return; renderLinks(); if (active(linkJob.state)) setTimeout(() => { if (alive) void pollLinks(); }, 1200); }
        catch (error) { if (alive) showToast(errorMessage(error), true); }
    }
    async function loadImport(page = 1) {
        el('cleanup-import-load').disabled = true;
        try {
            const value = await api<ImportIssuePage>(`maintenance/import-issues?type=${encodeURIComponent(el('cleanup-import-type').value)}&page=${page}`);
            if (!alive) return;
            el('cleanup-import-list').innerHTML = `<p class="summary">共 ${count(value.total)} 条${value.resolvedUnassigned ? `，已归档 ${count(value.resolvedUnassigned)} 个未归属文件` : ''}${value.kind === 'unassigned' && value.unassignedTotal > value.total ? `，来源仅列出前 ${count(value.total)} 条路径（实际 ${count(value.unassignedTotal)} 个文件）` : ''}；来源 ${escape(value.source || '尚无导入记录')}</p>${value.items.length ? `<div class="issue-list">${value.items.map(item => `<article class="issue-card"><div class="issue-info"><strong>${escape(item.name)}</strong><p>${escape(item.reason)}</p>${item.target ? `<code class="path">本地：${escape(item.target)}</code>` : ''}${item.workId ? `<small>作品 ID：${escape(item.workId)}</small>` : ''}</div>${item.workId ? `<button class="secondary" data-cleanup-find-work="${escape(item.workId)}">查看本地作品</button>` : ''}</article>`).join('')}</div>` : '<p class="cleanup-empty">没有此类导入异常。</p>'}${value.pages > 1 ? `<div class="cleanup-actions"><button class="secondary" data-import-page="${value.page - 1}" ${value.page === 1 ? 'disabled' : ''}>上一页</button><span>${value.page} / ${value.pages} 页</span><button class="secondary" data-import-page="${value.page + 1}" ${value.page === value.pages ? 'disabled' : ''}>下一页</button></div>` : ''}`;
        } catch (error) { if (alive) el('cleanup-import-list').textContent = errorMessage(error); }
        finally { if (alive) el('cleanup-import-load').disabled = false; }
    }
    root.addEventListener('click', async event => {
        if (!alive) return;
        const button = eventElement(event)?.closest('button'); if (!button) return;
        try {
            if (button.dataset.cleanupTab) {
                currentTab = button.dataset.cleanupTab;
                for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-cleanup-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.cleanupTab === currentTab));
                for (const tab of ['media', 'authors', 'links', 'import', 'diagnostics', 'logs']) el(`cleanup-${tab}`).hidden = tab !== currentTab;
                onMediaVisibility(currentTab === 'media');
                if (currentTab === 'diagnostics') await loadDiagnostics();
            }
            if (button.id === 'cleanup-log-preview') {
                button.disabled = true;
                try {
                    const preview = await post<{ files: number; bytes: number; retainedFiles: number; examples: string[]; days: number; token: string }>('maintenance/logs/preview', { days: Number(el('cleanup-log-days').value) });
                    if (!alive) return;
                    const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
                    el('cleanup-log-result').textContent = `可清理 ${count(preview.files)} 个文件，${size(preview.bytes)}；保留 ${count(preview.retainedFiles)} 个运行中或未到期文件`;
                    if (preview.files) showConfirmation('确认清理已结束的日志', `<p>将永久删除 ${count(preview.files)} 个日志文件，释放约 ${size(preview.bytes)}。删除后无法恢复。</p><p>保留运行中任务的整组日志，以及服务输出和诊断报告。</p><ul>${preview.examples.map(file => `<li><code>${escape(file)}</code></li>`).join('')}</ul>`, async () => {
                        const result = await remove<{ removedFiles: number; removedBytes: number; skippedFiles: number }>('maintenance/logs', { days: preview.days, token: preview.token });
                        el('cleanup-log-result').textContent = `已清理 ${count(result.removedFiles)} 个文件，释放 ${size(result.removedBytes)}；跳过 ${count(result.skippedFiles)} 个变化或占用的文件`;
                    });
                } finally { if (alive) button.disabled = false; }
            }
            if (button.id === 'cleanup-diagnostics-refresh') await loadDiagnostics(true);
            if (button.dataset.authorRetry) {
                await post('maintenance/diagnostics/retry', { target: button.dataset.authorRetry });
                showToast('已标记，下次更新优先重试；未立即访问抖音');
                await loadDiagnostics(true);
            }
            if (button.dataset.auditRetry) {
                await post('maintenance/diagnostics/retry', { scope: button.dataset.auditRetry });
                showToast('已标记，下次更新会重新核对该作者历史；当前任务继续运行');
                await loadDiagnostics(true);
            }
            if (button.id === 'cleanup-local-files' || button.id === 'cleanup-local-files-stop') {
                state = await post<MaintenanceState>(`maintenance/local-files/${button.id === 'cleanup-local-files' ? 'start' : 'stop'}`);
                if (alive) { lockControls(); await refresh(); }
            }
            if (button.id === 'cleanup-delete-works') onBatchRemoval();
            if (button.id === 'cleanup-resolve') onBatchReview('resolved');
            if (button.id === 'cleanup-ignore') onBatchReview('ignored');
            if (button.id === 'cleanup-author-scan') { state = await post<MaintenanceState>('maintenance/scan'); if (alive) { renderAuthors(); await refresh(); } }
            if (button.id === 'cleanup-author-page-select' && report) { for (const a of report.candidates.slice((authorPage - 1) * 50, authorPage * 50)) authorSelection.add(a.id); renderAuthors(); }
            if (button.dataset.authorPage) { authorPage = Number(button.dataset.authorPage); renderAuthors(); }
            if (button.id === 'cleanup-author-remove' && report) {
                const selected = report.candidates.filter(a => authorSelection.has(a.id));
                const token = report.token;
                if (selected.length > 1000) throw Error('请分批选择，每次最多 1000 位作者');
                showConfirmation('确认清理无作品作者', `<p>所选 ${count(selected.length)} 位作者的当前、历史及待导入作品均为 0。将移除作者记录和 ${count(selected.reduce((n, a) => n + a.urls.length, 0))} 条关联链接。</p><p class="summary">不涉及作品或媒体文件。执行时会重新核对，范围变化则停止。</p><ul>${selected.slice(0, 100).map(a => `<li>${escape(a.name)} · ${escape(a.uid || a.secUid)}</li>`).join('')}</ul>`, async () => { await remove('maintenance/authors', { ids: selected.map(a => a.id), token }); });
            }
            if (button.id === 'cleanup-links-load') await loadLinks();
            if (button.id === 'cleanup-links-check') { await loadLinks(); if (!alive) return; if (!links.length) throw Error('没有待检测链接'); linkJob = await post<LinkCheckJob>('link-check/start', { links }); if (alive) { renderLinks(); void pollLinks(); } }
            if (button.id === 'cleanup-links-stop') { linkJob = await post<LinkCheckJob>('link-check/stop'); if (alive) renderLinks(); }
            if (button.id === 'cleanup-links-remove') {
                const preview = await post<{ links: string[]; removedLinks: number; revision: string }>('maintenance/links/preview', { links: [...linkSelection] });
                if (!alive) return;
                showConfirmation('确认移除所选链接', `<p>将从下载配置移除 ${count(preview.removedLinks)} 条链接，作者和作品保留。</p><ul>${preview.links.map(link => `<li>${escape(link)}</li>`).join('')}</ul>`, async () => { await remove('maintenance/links', preview); await loadLinks(); });
            }
            if (button.id === 'cleanup-import-load') await loadImport();
            if (button.dataset.importPage) await loadImport(Number(button.dataset.importPage));
            if (button.dataset.cleanupFindWork) onFindWork(button.dataset.cleanupFindWork);
        } catch (error) { if (alive) showToast(errorMessage(error), true); }
    }, { signal: events.signal });
    root.addEventListener('change', event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        const author = target.dataset.cleanupAuthor, link = target.dataset.cleanupLink;
        if (author) { target.checked ? authorSelection.add(author) : authorSelection.delete(author); lockControls(); }
        if (link !== undefined) { const value = links[Number(link)]; target.checked ? linkSelection.add(value) : linkSelection.delete(value); lockControls(); }
    }, { signal: events.signal });
    void refresh();
    return {
        updateSelection(size: number, works: number) { if (!alive) return; root.dataset.mediaSelection = size ? String(size) : ''; el('cleanup-media-selection').textContent = size ? `已选择 ${count(size)} 条异常，关联 ${count(works)} 件作品` : '未选择异常'; lockControls(); },
        dispose() { alive = false; events.abort(); clearTimeout(timer); if (dialog.open) dialog.close(); root.hidden = true; delete root.dataset.busy; render(null, root); },
    };
}
