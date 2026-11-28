import { reactive } from 'vue';
import { catalogApi as api, jsonHeaders } from '../catalog-api';
import { errorMessage } from '../dom';
import type { LinkCheckJob, LinkCheckResult } from '../link-check';
import type { ShowToast } from './useToast';

export function useLinkCheck(showToast: ShowToast) {
    const state = reactive({
        job: { state: 'idle', total: 0, completed: 0, results: [] } as LinkCheckJob,
        results: new Map<string, LinkCheckResult>(),
        busy: false,
        showBrowser: false,
        error: '',
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let version = 0;

    function stopPolling() {
        clearTimeout(timer);
        ++version;
        state.busy = false;
    }

    async function refresh(action?: 'start' | 'stop', links?: string[]) {
        if (action === 'start' && (!links?.length || links.some(link => !link.trim()))) {
            showToast('请先填写或移除空白链接', true);
            return;
        }
        clearTimeout(timer);
        const request = ++version;
        if (action) state.busy = true;
        try {
            const next = action ? await api<LinkCheckJob>(`link-check/${action}`, {
                method: 'POST', headers: jsonHeaders,
                body: JSON.stringify(action === 'start' ? { links, showBrowser: state.showBrowser } : {}),
            }) : await api<LinkCheckJob>('link-check');
            if (request !== version) return;
            state.job = next;
            state.results.clear();
            for (const result of next.results ?? []) state.results.set(result.link, result);
            state.error = next.error ?? '';
        } catch (error) {
            if (request === version) state.error = errorMessage(error);
        } finally {
            if (request === version) {
                state.busy = false;
                if (['starting', 'running', 'stopping'].includes(state.job.state)) {
                    timer = setTimeout(() => void refresh(), 1500);
                }
            }
        }
    }

    return { state, refresh, stopPolling };
}
