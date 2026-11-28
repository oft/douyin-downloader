import { catalogApi as api, jsonHeaders } from '../catalog-api';
import { errorMessage, eventElement } from '../dom';
import { pinia } from '../runtime';
import { useCatalogStore } from '../stores/catalog';
import type { CatalogStatus } from '../stores/catalog';
import type { UpdateTask } from '../update-progress';
import { byId } from '../utils/catalog-elements';
import type { CatalogRoute, ListLoadOptions } from '../utils/catalog-route';
import { date, emptyMarkup as box } from '../utils/format';
import type { ShowToast } from './useToast';

type StatusOptions = {
    signal: AbortSignal; showToast: ShowToast; getRoute: () => CatalogRoute;
    onScanChanged: (options: ListLoadOptions) => void; onScanRequested: () => void;
};

export function useCatalogStatus({ signal, showToast, getRoute, onScanChanged, onScanRequested }: StatusOptions) {
    const results = byId('results');
    const catalog = useCatalogStore(pinia);
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let scanStatusVersion = 0;

    function renderStatus() {
        const active = catalog.status.scanning;
        const error = catalog.status.error ?? catalog.status.databaseError;
        byId('scan-button').disabled = active || getRoute().view === 'issues' && byId('issue-center').dataset.busy === 'true';
        byId('scan-state').dataset.state = active ? 'scanning' : error ? 'error' : 'ready';
        byId('scan-label').textContent = active ? '正在扫描媒体异常' : catalog.status.error ? '媒体扫描失败'
            : catalog.status.databaseError ? '数据库读取失败' : catalog.status.scannedAt ? '异常扫描已完成' : '媒体异常未扫描';
        byId('scan-time').textContent = catalog.status.scannedAt ? date.format(new Date(catalog.status.scannedAt)) : '';
        byId('scan-state').title = [catalog.status.root, error].filter(Boolean).join('\n');
        if (getRoute().view === 'issues' && catalog.status.error && !catalog.status.scannedAt) {
            results.setAttribute('aria-busy', 'false');
            results.innerHTML = box('媒体扫描失败', catalog.status.error, '<button type="button" class="secondary" data-rescan>重新扫描</button>');
        }
    }

    async function refreshStatus({ rescan = false } = {}) {
        const version = ++scanStatusVersion;
        clearTimeout(scanTimer);
        const previous = catalog.status;
        try {
            let next = rescan ? null : await api<CatalogStatus>('status');
            if (version !== scanStatusVersion) return;
            if (!next) {
                next = await api<CatalogStatus>('scan', { method: 'POST', headers: jsonHeaders, body: '{}' });
            }
            if (version !== scanStatusVersion) return;
            catalog.status = next;
            renderStatus();
            if ((getRoute().view === 'issues' || (['works', 'authors'].includes(getRoute().view) && (rescan || previous.scanning))) &&
                catalog.status.scannedAt && catalog.status.scannedAt !== previous.scannedAt) onScanChanged({ showLoading: !previous.scannedAt });
            if (catalog.status.scanning) scanTimer = setTimeout(() => void refreshStatus(), 800);
            if (previous.scanning && !catalog.status.scanning && catalog.status.error && catalog.status.scannedAt) showToast(catalog.status.error, true);
        } catch (error) {
            if (version !== scanStatusVersion) return;
            byId('scan-button').disabled = false;
            byId('scan-label').textContent = '扫描状态不可用';
            byId('scan-state').dataset.state = 'error';
            if (getRoute().view === 'issues' && !catalog.status.scannedAt) {
                results.setAttribute('aria-busy', 'false');
                results.innerHTML = box('无法扫描媒体', errorMessage(error), '<button type="button" class="secondary" data-rescan>重试</button>');
            } else showToast(errorMessage(error), true);
        }
    }

    byId('open-douyin').addEventListener('click', async () => {
        const button = byId('open-douyin');
        button.disabled = true;
        try {
            const result = await api<UpdateTask>('browser/open', { method: 'POST', headers: jsonHeaders, body: '{}' });
            if (result.state === 'failed') throw new Error(result.error || '无法打开抖音');
            showToast('已请求打开抖音，完成登录和保存选择后可关闭窗口，登录状态会自动保存。');
            await new Promise(resolve => setTimeout(resolve, 1500));
            const current = await api<UpdateTask>('browser');
            if (current.state === 'failed') throw new Error(current.error || '无法打开抖音');
        } catch (error) { showToast(errorMessage(error), true); }
        finally { button.disabled = false; }
    }, { signal });

    function stopPolling() {
        ++scanStatusVersion;
        clearTimeout(scanTimer);
    }

    function scan() {
        onScanRequested();
        void refreshStatus({ rescan: true });
    }

    byId('scan-button').addEventListener('click', scan, { signal });
    results.addEventListener('click', event => {
        if (eventElement(event)?.closest('[data-rescan]')) scan();
    }, { signal });

    return {
        refresh: refreshStatus, stopPolling,
        replace(snapshot: CatalogStatus) { stopPolling(); catalog.status = snapshot; renderStatus(); },
    };
}
