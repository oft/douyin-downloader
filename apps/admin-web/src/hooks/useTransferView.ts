import { h, render } from 'vue';
import TransferView from '../views/TransferView.vue';
import { errorMessage, escapeHtml as escape, requiredElement } from '../dom';
import type { Author, Page } from '../catalog-types';
import type { catalogApi } from '../catalog-api';

type UnassignedFile = { path: string; size: number };
type TransferTask = {
    state: string; error?: string;
    progress?: { stage: string; completed: number; total?: number; bytes?: number; bytesTotal?: number; current?: string };
};
type ShareTask = TransferTask & {
    counts?: { authors: number; works: number; files: number; bytes: number; unassignedFiles?: number };
    unassigned?: UnassignedFile[]; addresses?: string[]; snapshotId?: string; code?: string;
};
type ImportTask = TransferTask & {
    preview?: {
        id: string;
        counts: {
            newAuthors: number; existingAuthors: number; newWorks: number; existingWorks: number;
            newLinks: number; existingLinks: number; filesToAdd: number; filesToSkip: number;
            conflicts: number; bytesToTransfer: number; pendingLinks?: number; unassignedFiles?: number;
        };
        unassigned?: UnassignedFile[];
        conflicts: { name: string; reason: string }[];
    };
    result?: { works: number; files: number; skipped: number; conflicts: number };
};
type TransferState = { share: ShareTask; importing: ImportTask };
type TransferOptions = {
    results: HTMLElement; api: typeof catalogApi; showToast: (message: string, error?: boolean) => void; onChanged?: () => void;
};
type TransferElements =
    & Record<'import-address' | 'import-code' | 'import-links' | 'share-history' | 'share-port' | 'share-idle' | 'share-code', HTMLInputElement>
    & Record<'share-address' | 'share-authors' | 'share-scope', HTMLSelectElement>
    & Record<'share-works', HTMLTextAreaElement>
    & Record<'share-start' | 'share-stop' | 'share-copy' | 'import-preview' | 'import-start' | 'import-stop', HTMLButtonElement>
    & Record<'share-form' | 'import-form', HTMLFormElement>
    & Record<'share-status' | 'import-status' | 'share-access' | 'share-authors-field' | 'share-works-field' | 'import-preview-result', HTMLElement>;

const number = new Intl.NumberFormat('zh-CN');
const bytes = (n = 0) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${number.format(n || 0)} B`;
const names: Record<string, string> = { idle: '尚未启动', starting: '准备中', running: '处理中', ready: '已就绪', stopping: '正在停止', stopped: '已停止', completed: '已完成', failed: '未完成' };
const active = (state: string) => ['starting', 'running', 'stopping'].includes(state);

/** Owns only this view's DOM and polling; leaving the page never stops a background transfer. */
export function useTransferView({ results, api, showToast, onChanged }: TransferOptions) {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let state: TransferState | undefined;
    let previewId: string | undefined;
    let previewSignature: string | undefined;
    results.setAttribute('aria-busy', 'false');
    results.replaceChildren();
    render(h(TransferView), results);
    const el = <K extends keyof TransferElements>(id: K) => requiredElement<TransferElements[K]>(results, `#${id}`);
    const source = () => ({ address: el('import-address').value.trim(), code: el('import-code').value.trim() });
    const request = async (endpoint: string, body: object) => {
        try { await api(`transfer/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); await refresh(); }
        catch (error) { showToast(errorMessage(error), true); }
    };
    const progress = (task: TransferTask) => {
        const p = task.progress;
        return `<div class="update-state" data-state="${escape(task.state)}">${escape(names[task.state] || task.state)}</div>
            ${p ? `<p>${escape(p.stage)}${p.total ? ` · ${number.format(p.completed)} / ${number.format(p.total)}` : ` · ${number.format(p.completed)} 个文件`}</p>
                ${p.total ? `<progress max="${p.total}" value="${p.completed}" aria-label="文件进度"></progress>` : active(task.state) ? '<span class="spinner" aria-hidden="true"></span>' : ''}
                ${p.bytesTotal || p.bytes ? `<p class="summary">${bytes(p.bytes)}${p.bytesTotal ? ` / ${bytes(p.bytesTotal)}` : ''}</p>` : ''}
                ${p.current ? `<p class="transfer-current">${escape(p.current)}</p>` : ''}` : ''}
            ${task.error ? `<p class="transfer-error">${escape(task.error)}</p>` : ''}`;
    };
    const preview = (task: ImportTask) => {
        if (!task.preview) return;
        previewId = task.preview.id;
        const signature = JSON.stringify([task.preview, task.result]);
        if (signature === previewSignature) return;
        previewSignature = signature;
        const c = task.preview.counts;
        const metrics: [string, number][] = [['新增作者', c.newAuthors], ['已有作者', c.existingAuthors], ['新增作品', c.newWorks], ['已有作品', c.existingWorks],
            ['新增链接', c.newLinks], ['已有链接', c.existingLinks], ['待补文件', c.filesToAdd], ['已有文件跳过', c.filesToSkip], ['差异保留', c.conflicts]];
        el('import-preview-result').innerHTML = `<div class="transfer-metrics">${metrics.map(([label, value]) => `<div><span>${label}</span><strong>${number.format(value)}</strong></div>`).join('')}</div>
            <p class="summary">预计导入 ${bytes(c.bytesToTransfer)}。已存在的作品只补缺失文件；不同内容默认保留本地。</p>
            ${c.pendingLinks ? `<p class="transfer-warning">${number.format(c.pendingLinks)} 条链接尚未关联作者，将保留为待确认，不启用下载。</p>` : ''}
            ${c.unassignedFiles ? `<p class="transfer-warning">来源另有 ${number.format(c.unassignedFiles)} 个未归属文件，未包含在清单中，不会计为已导入。</p>${unassigned(task.preview.unassigned)}` : ''}
            ${task.result ? `<p class="transfer-success">本次完成：新增 ${number.format(task.result.works)} 个作品，导入 ${number.format(task.result.files)} 个文件；跳过 ${number.format(task.result.skipped)} 个，保留差异 ${number.format(task.result.conflicts)} 个。</p>` : ''}
            ${task.preview.conflicts.length ? `<details class="transfer-differences"><summary>查看差异（最多显示 100 条）</summary><ul>${task.preview.conflicts.map(item => `<li><strong>${escape(item.name)}</strong><span>${escape(item.reason)}</span></li>`).join('')}</ul></details>` : ''}`;
    };
    const unassigned = (files?: UnassignedFile[]) => files?.length ? `<details class="transfer-differences"><summary>查看未归属文件（最多显示 100 条）</summary><ul>${files.map(file => `<li><strong>${escape(file.path)}</strong><span>${bytes(file.size)}</span></li>`).join('')}</ul></details>` : '';
    async function refresh() {
        clearTimeout(timer);
        try {
            const value = await api<TransferState>('transfer/status');
            if (!alive) return;
            const wasComplete = state?.importing.state === 'completed';
            state = value;
            const sharing = value.share, importing = value.importing;
            el('share-status').innerHTML = progress(sharing);
            if (sharing.counts) el('share-status').insertAdjacentHTML('beforeend', `<p class="summary">${number.format(sharing.counts.authors)} 位作者 · ${number.format(sharing.counts.works)} 个作品 · ${number.format(sharing.counts.files)} 个文件 · ${bytes(sharing.counts.bytes)}</p>${sharing.counts.unassignedFiles ? `<p class="transfer-warning">另有 ${number.format(sharing.counts.unassignedFiles)} 个未归属到作品的文件，未包含在本次分享中，请先整理。</p>` : ''}`);
            if (sharing.unassigned?.length) el('share-status').insertAdjacentHTML('beforeend', unassigned(sharing.unassigned));
            el('share-start').disabled = active(sharing.state) || sharing.state === 'ready' || active(importing.state);
            el('share-stop').disabled = !active(sharing.state) && sharing.state !== 'ready';
            const access = sharing.state === 'ready' && sharing.addresses?.length;
            el('share-access').hidden = !access;
            if (access && sharing.addresses) {
                const addresses = [...sharing.addresses].sort((a, b) => Number(a.includes('127.0.0.1')) - Number(b.includes('127.0.0.1')));
                if (el('share-address').dataset.snapshot !== sharing.snapshotId) {
                    el('share-address').innerHTML = addresses.map(address => `<option>${escape(address)}</option>`).join('');
                    el('share-address').dataset.snapshot = sharing.snapshotId;
                }
                el('share-code').value = sharing.code || '';
            } else el('share-code').value = '';
            el('import-status').innerHTML = progress(importing);
            el('import-preview').disabled = active(importing.state);
            el('import-start').disabled = active(importing.state) || !importing.preview;
            el('import-stop').disabled = !active(importing.state);
            el('import-start').textContent = ['failed', 'stopped'].includes(importing.state) ? '继续导入缺失内容' : '导入缺失内容';
            preview(importing);
            if (!wasComplete && importing.state === 'completed') onChanged?.();
        } catch (error) { if (alive) el('import-status').textContent = errorMessage(error); }
        finally { if (alive) timer = setTimeout(refresh, 1200); }
    }
    el('share-scope').addEventListener('change', () => {
        el('share-authors-field').hidden = el('share-scope').value !== 'authors';
        el('share-works-field').hidden = el('share-scope').value !== 'works';
    });
    el('share-form').addEventListener('submit', event => {
        event.preventDefault();
        const scope = el('share-scope').value;
        const authorIds = [...el('share-authors').selectedOptions].map(option => option.value);
        const workIds = el('share-works').value.split(/[\s,，]+/).filter(Boolean);
        if (scope === 'authors' && !authorIds.length || scope === 'works' && !workIds.length) { showToast('请先选择分享范围', true); return; }
        void request('share/start', { ...(scope === 'authors' ? { authorIds } : {}), ...(scope === 'works' ? { workIds } : {}),
            includeHistory: el('share-history').checked, port: Number(el('share-port').value), idleMinutes: Number(el('share-idle').value) });
    });
    el('share-stop').addEventListener('click', () => void request('share/stop', {}));
    el('share-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(`分享地址：${el('share-address').value}\n分享码：${el('share-code').value}`); showToast('已复制分享地址和分享码'); }
        catch { showToast('请选中上方地址和分享码复制'); }
    });
    el('import-form').addEventListener('submit', event => { event.preventDefault(); void request('import/preview', source()); });
    el('import-start').addEventListener('click', () => {
        if (!el('import-form').reportValidity()) return;
        void request('import/start', { ...source(), planId: previewId, includeLinks: el('import-links').checked });
    });
    el('import-stop').addEventListener('click', () => void request('import/stop', {}));
    void (async () => {
        try {
            const authors: Author[] = [];
            for (let page = 1; page <= 1000; page++) {
                const data = await api<Page<Author>>(`authors?size=100&page=${page}`);
                if (!alive) return;
                authors.push(...data.items);
                if (page >= data.pages) break;
            }
            el('share-authors').innerHTML = authors.map(author => `<option value="${escape(author.id)}">${escape(author.name)}（${number.format(author.workCount)} 个作品）</option>`).join('');
        } catch { if (alive) el('share-authors').innerHTML = '<option disabled>暂无可选作者，可分享全部资料</option>'; }
    })();
    void refresh();
    return () => { alive = false; clearTimeout(timer); render(null, results); };
}
