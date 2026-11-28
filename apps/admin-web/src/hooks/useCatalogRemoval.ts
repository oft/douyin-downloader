import { catalogApi as api, jsonHeaders } from '../catalog-api';
import type { Author } from '../catalog-types';
import { errorMessage, eventElement, escapeHtml as escape } from '../dom';
import { pinia, router } from '../runtime';
import { useCatalogStore } from '../stores/catalog';
import type { CatalogStatus } from '../stores/catalog';
import { byId } from '../utils/catalog-elements';
import type { CatalogRoute } from '../utils/catalog-route';
import { emptyMarkup as box, formatSize, number } from '../utils/format';
import { fileList, previewFile, visibleFiles } from '../utils/removal-markup';
import type { RemovalCopy } from '../utils/removal-markup';
import type { useCatalogDialog } from './useCatalogDialog';
import type { ShowToast } from './useToast';

type RemovalPlan = {
    title: string; workCount: number; copyCount: number; fileCount: number; size: number;
    works?: { title: string; copyCount: number }[]; authors?: Pick<Author, 'name' | 'workCount'>[];
    copies?: RemovalCopy[]; resetWorks?: number; removedLinks?: number; errors: string[]; token?: string;
};
export type RemovalResult = CatalogStatus & { deletedFiles: number; deletedDirectories: number; resetWorks?: number; removedLinks?: number };

type RemovalOptions = {
    signal: AbortSignal;
    dialog: ReturnType<typeof useCatalogDialog>; showToast: ShowToast; getRoute: () => CatalogRoute;
    invalidateLinks: () => void; onSelectionChanged: () => void; onRefreshStatus: () => void;
    onRemoved: (result: RemovalResult, navigating: boolean) => void;
};

export function useCatalogRemoval({ dialog, showToast, getRoute, signal, invalidateLinks, onSelectionChanged, onRefreshStatus, onRemoved }: RemovalOptions) {
    const { modal } = dialog;
    const { selectedAuthors, selectedWorks } = useCatalogStore(pinia);

    async function showAuthorLinkRemoval(id: string) {
        const version = dialog.open('删除链接', 'review-modal');
        const body = byId('modal-body');
        const endpoint = `authors/${encodeURIComponent(id)}/links`;
        body.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取作者链接…</p></div>';
        try {
            const plan = await api<{ name: string; links: string[]; revision: string }>(endpoint);
            if (version !== dialog.version || !modal.open) return;
            byId('modal-subtitle').textContent = plan.name;
            if (!plan.links.length) {
                body.innerHTML = box('没有匹配的作者主页链接', '可以在链接管理中查看配置里的其他链接。',
                    '<a class="secondary" href="#/links" data-modal-link>打开链接管理</a>');
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
                if (dialog.deleting) return;
                dialog.deleting = true;
                const controls = [...modal.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
                controls.forEach(control => { control.disabled = true; });
                confirm.textContent = '正在删除…';
                try {
                    const result = await api<{ removedLinks: number }>(endpoint, { method: 'DELETE', headers: jsonHeaders,
                        body: JSON.stringify({ revision: plan.revision }) });
                    invalidateLinks();
                    if (version === dialog.version && modal.open) modal.close();
                    showToast(`已删除 ${number.format(result.removedLinks)} 条作者主页链接`);
                } catch (error) {
                    if (version === dialog.version && modal.open) {
                        message.textContent = errorMessage(error);
                        message.hidden = false;
                        retry.hidden = false;
                    } else showToast(errorMessage(error), true);
                } finally {
                    dialog.deleting = false;
                    controls.forEach(control => { control.disabled = false; });
                    confirm.textContent = '确认删除链接';
                }
            });
        } catch (error) {
            if (version === dialog.version && modal.open) body.innerHTML = box('无法读取作者链接', errorMessage(error));
        }
    }

    async function showRemoval(kind: 'authors' | 'works', id?: string, showFiles = false, batchIds: string[] = [], batchAuthorId?: string, clearWorks = false) {
        const isAuthor = kind === 'authors';
        const batch = batchIds.length > 0;
        const subject = isAuthor ? '作者' : '作品';
        const title = clearWorks ? '清除作者所有作品' : batch ? `批量删除${subject}` : showFiles ? '作品文件清单' : `删除${subject}`;
        const confirmLabel = clearWorks ? '清除文件并重置为未下载' : '永久删除';
        const endpoint = clearWorks ? `authors/${encodeURIComponent(id ?? '')}/works/clear`
            : batch ? isAuthor ? 'authors/batch-removal' : batchAuthorId ? `authors/${encodeURIComponent(batchAuthorId)}/works/batch-removal` : 'works/batch-removal'
            : `${kind}/${encodeURIComponent(id ?? '')}`;
        const version = dialog.open(title, 'remove-modal');
        const body = byId('modal-body');
        body.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取文件…</p></div>';
        try {
            const plan = batch ? await api<RemovalPlan>(endpoint, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ids: batchIds }) })
                : await api<RemovalPlan>(clearWorks ? endpoint : `${endpoint}/${isAuthor ? 'removal' : 'files'}`);
            if (version !== dialog.version || !modal.open) return;
            byId('modal-subtitle').textContent = batch ? `已选 ${number.format(isAuthor ? (plan.authors?.length ?? 0) : plan.workCount)} ${isAuthor ? '位作者' : '件作品'}` : plan.title;
            const hidden = (plan.copies ?? []).flatMap(copy => {
                const visible = new Set(visibleFiles(copy));
                return copy.files.filter(file => !visible.has(file));
            });
            const hiddenCount = hidden.filter(file => file.kind === 'file').length;
            const summary = (showAll = false) => `${number.format(plan.workCount)} 件作品 · ${number.format(plan.copyCount)} 个副本 · ${number.format(plan.fileCount - (showAll ? 0 : hiddenCount))} 个文件 · ${formatSize(plan.size - (showAll ? 0 : hidden.reduce((size, file) => size + (file.size ?? 0), 0)))}`;
            const authorWorks = plan.works?.map(work => `<li><span>${escape(work.title)}</span><small>${number.format(work.copyCount)} 个副本</small></li>`).join('');
            const authors = batch && isAuthor ? `<details class="file-copy" open><summary><strong>所选作者</strong></summary><ul class="removal-works">${(plan.authors ?? []).map(author => `<li><span>${escape(author.name)}</span><small>${number.format(author.workCount)} 件作品</small></li>`).join('')}</ul></details>` : '';
            const listing = (isAuthor || batch) && authorWorks ? `<details class="file-copy" ${authors ? '' : 'open'}><summary><strong>受影响的作品</strong></summary><ul class="removal-works">${authorWorks}</ul>${plan.workCount > (plan.works?.length ?? 0) ? `<p class="summary more-works">此处显示前 ${(plan.works?.length ?? 0)} 件，全部 ${number.format(plan.workCount)} 件都在删除范围内。</p>` : ''}</details>`
                : `<div data-file-list>${(plan.copies ?? []).map((copy, index) => fileList(copy, index)).join('')}</div>`;
            const scope = clearWorks ? `将清除此作者的全部本地作品，包括其他分页和当前筛选条件之外的作品。保留下载链接和数据库作品记录，将 ${number.format(plan.resetWorks ?? 0)} 条作品记录重置为未下载，下次手动更新时可重新下载。本地文件清除后无法从资料库恢复。`
                : isAuthor ? `${batch ? '所选作者' : '此作者'}的全部本地作品副本和对应数据库记录将永久删除，同时移除配置中匹配的 ${number.format(plan.removedLinks ?? 0)} 条作者主页链接。删除后无法从资料库恢复。`
                : `${batch ? '所选作品' : '此作品'}的本地副本和对应数据库记录将永久删除。平铺文件按清单删除。删除后无法从资料库恢复。`;
            const errors = plan.errors.length ? `<div class="player-error" role="alert">清单无法完整读取，请检查目录后刷新数据库。<ul>${plan.errors.slice(0, 5).map(error => `<li>${escape(error)}</li>`).join('')}</ul></div>` : '';
            const back = isAuthor || batch ? '<button class="secondary" type="button" data-dismiss>取消</button>' : `<button class="secondary" type="button" data-work-back="${escape(id)}">返回作品</button>`;
            body.innerHTML = `<p class="removal-count">${summary()}</p>${plan.copies?.length ? '<label class="file-show-all"><input type="checkbox" data-show-all-files>显示所有文件</label>' : ''}${hidden.length ? '<p class="summary">默认隐藏 ._ 开头的文件；删除作品时会一并清理。</p>' : ''}${authors}${listing}<p class="summary removal-scope">${scope}</p>${errors}
                <p id="removal-error" class="player-error" role="alert" hidden></p><div class="form-actions">${back}<button id="confirm-removal" class="primary danger" type="button" ${plan.token ? '' : 'disabled'}>${confirmLabel}</button></div>`;
            body.querySelector<HTMLInputElement>('[data-show-all-files]')?.addEventListener('change', event => {
                const showAll = (event.currentTarget as HTMLInputElement).checked;
                body.querySelector('.removal-count')!.textContent = summary(showAll);
                const list = body.querySelector('[data-file-list]');
                if (list) list.innerHTML = (plan.copies ?? []).map((copy, index) => fileList(copy, index, showAll)).join('');
            });
            byId('confirm-removal').addEventListener('click', async () => {
                if (dialog.deleting) return;
                dialog.deleting = true;
                const controls = [...modal.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
                controls.forEach(control => { control.disabled = true; });
                byId('confirm-removal').textContent = '正在删除…';
                try {
                    const result = await api<RemovalResult>(endpoint, { method: 'DELETE', headers: jsonHeaders,
                        body: JSON.stringify({ mode: 'permanent', token: plan.token, ids: batch ? batchIds : undefined }) });
                    if (isAuthor && !clearWorks) invalidateLinks();
                    if (clearWorks) selectedWorks.clear();
                    const selection = isAuthor ? selectedAuthors : selectedWorks;
                    for (const selected of batch ? batchIds : id ? [id] : []) selection.delete(selected);
                    onSelectionChanged();
                    const showReceipt = version === dialog.version && modal.open;
                    const navigating = Boolean(id && isAuthor && getRoute().authorId === id);
                    onRemoved(result, navigating);
                    if (navigating) await router.replace({ name: 'authors' });
                    if (showReceipt) {
                        dialog.open(clearWorks ? '已清除作者作品' : batch ? `已删除 ${number.format(batchIds.length)} ${isAuthor ? '位作者' : '件作品'}` : `已删除${subject}`, 'review-modal');
                        const scanWarning = result.databaseError ? '<p class="player-error">无法读取更新后的数据库，请刷新页面。</p>' : '';
                        body.innerHTML = `<p class="summary">已永久删除 ${number.format(result.deletedFiles)} 个文件和 ${number.format(result.deletedDirectories)} 个目录。${clearWorks ? `已将 ${number.format(result.resetWorks ?? 0)} 条作品记录重置为未下载，下载链接已保留。` : isAuthor ? `已移除 ${number.format(result.removedLinks ?? 0)} 条作者主页链接。` : ''}</p>${scanWarning}<div class="form-actions"><button class="secondary" type="button" data-dismiss>完成</button></div>`;
                    } else showToast(clearWorks ? '作品文件已清除，状态已重置为未下载' : '永久删除已完成');
                } catch (error) {
                    if (version === dialog.version && modal.open) {
                        const message = byId('removal-error');
                        message.textContent = errorMessage(error);
                        message.hidden = false;
                        byId('confirm-removal').textContent = confirmLabel;
                        const retry = document.createElement('button');
                        retry.type = 'button';
                        retry.className = 'secondary';
                        retry.textContent = '重新读取清单';
                        retry.addEventListener('click', () => void showRemoval(kind, id, showFiles, batchIds, batchAuthorId, clearWorks));
                        message.after(retry);
                        controls.splice(controls.indexOf(byId('confirm-removal')), 1);
                    } else showToast(errorMessage(error), true);
                    onRefreshStatus();
                } finally {
                    dialog.deleting = false;
                    controls.forEach(control => { control.disabled = false; });
                }
            });
        } catch (error) {
            if (version === dialog.version && modal.open) body.innerHTML = box('无法读取清单', errorMessage(error));
        }
    }

    modal.addEventListener('click', event => {
        const image = eventElement(event)?.closest<HTMLButtonElement>('[data-file-preview]');
        if (image && !dialog.deleting) previewFile(image);
        if (dialog.deleting) return;
        const target = eventElement(event);
        const files = target?.closest<HTMLElement>('[data-files]');
        if (files?.dataset.files) void showRemoval('works', files.dataset.files, true);
        const remove = target?.closest<HTMLElement>('[data-remove-work]');
        if (remove?.dataset.removeWork) void showRemoval('works', remove.dataset.removeWork);
    }, { signal });

    return { showRemoval, showAuthorLinkRemoval };
}
