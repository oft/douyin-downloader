import { computed, h, nextTick, reactive, render } from 'vue';
import { catalogApi as api, jsonHeaders } from '../catalog-api';
import type { Author, LinkConfig } from '../catalog-types';
import { errorMessage } from '../dom';
import { byId, findId } from '../utils/catalog-elements';
import { emptyMarkup } from '../utils/format';
import LinksView from '../views/LinksView.vue';
import { useLinkCheck } from './useLinkCheck';
import type { ShowToast } from './useToast';

type LinkAuthors = Record<string, Pick<Author, 'id' | 'name'>>;
export type LinksViewState = {
    config?: LinkConfig;
    authors: LinkAuthors;
    draft: string[];
    query: string;
    filter: string;
    saving: boolean;
    error: string;
};

export function useLinkManagement(showToast: ShowToast, signal: AbortSignal) {
    const results = byId('results');
    const header = byId('header-action');
    const state = reactive<LinksViewState>({
        authors: {}, draft: [], query: '', filter: '', saving: false, error: '',
    });
    const changed = computed(() => Boolean(state.config && (state.draft.length !== state.config.links.length
        || state.draft.some((link, index) => link !== state.config?.links[index]))));
    const check = useLinkCheck(showToast);
    let active = false;
    let mounted = false;
    let request: AbortController | undefined;

    async function focusLink(index: number, validity = '') {
        await nextTick();
        if (!mounted) return;
        const input = results.querySelector<HTMLTextAreaElement>(`[data-link-index="${index}"]`);
        if (input && !input.closest('[hidden]')) {
            input.focus();
            if (validity) { input.setCustomValidity(validity); input.reportValidity(); }
        } else (state.draft.length ? findId('link-search') : findId('add-link'))?.focus();
    }

    function rootView() {
        if (mounted) return;
        results.replaceChildren();
        render(h(LinksView, {
            state, check: check.state,
            onAdd() {
                state.query = '';
                state.filter = '';
                state.draft.push('');
                void focusLink(state.draft.length - 1);
            },
            onRemove(index) {
                state.draft.splice(index, 1);
                void focusLink(Math.min(index, state.draft.length - 1));
            },
            onReload() {
                if (!changed.value || window.confirm('放弃未保存的更改，重新读取配置？')) void load(true);
            },
            onSave: () => void save(),
            onCheck: (links: string[]) => void check.refresh('start', links),
            onStop: () => void check.refresh('stop'),
            onSummary: (text: string) => { if (active) byId('summary').textContent = text; },
        }), results);
        mounted = true;
        results.setAttribute('aria-busy', 'false');
        void check.refresh();
    }

    function unmountView() {
        if (mounted) { render(null, results); mounted = false; }
    }

    async function load(reload = false) {
        if (state.config && !reload && (state.saving || changed.value)) { rootView(); return; }
        request?.abort();
        const pending = new AbortController();
        request = pending;
        check.stopPolling();
        unmountView();
        header.replaceChildren();
        results.setAttribute('aria-busy', 'true');
        results.innerHTML = '<div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取链接配置…</p></div>';
        try {
            const [data, matches] = await Promise.all([
                api<LinkConfig>('links', { signal: pending.signal }),
                api<{ authors: LinkAuthors }>('link-authors', { signal: pending.signal }).catch(() => ({ authors: {} })),
            ]);
            if (!active || pending.signal.aborted) return;
            state.config = data;
            state.authors = matches.authors;
            state.draft = [...data.links];
            rootView();
        } catch (error) {
            if (!active || pending.signal.aborted) return;
            results.innerHTML = emptyMarkup('链接配置读取失败', errorMessage(error),
                '<button type="button" class="secondary" data-reload-links>重试</button>');
        } finally {
            if (active && !pending.signal.aborted) results.setAttribute('aria-busy', 'false');
        }
    }

    async function save() {
        const config = state.config;
        if (state.saving || !config || !changed.value) return;
        const blank = state.draft.findIndex(link => !link.trim());
        if (blank >= 0) {
            state.query = state.filter = '';
            await focusLink(blank, '请输入下载链接，或移除这条空白记录。');
            return;
        }
        state.saving = true;
        state.error = '';
        try {
            const next = await api<LinkConfig>('links', {
                method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ links: state.draft, revision: config.revision }),
            });
            state.config = next;
            state.draft = [...next.links];
            showToast('链接配置已保存');
        } catch (error) {
            if (mounted) state.error = errorMessage(error);
            else showToast(errorMessage(error), true);
        } finally {
            state.saving = false;
        }
    }

    results.addEventListener('click', event => {
        if (active && event.target instanceof Element && event.target.closest('[data-reload-links]')) void load(true);
    }, { signal });

    return {
        open() { active = true; void load(); },
        close() {
            active = false;
            request?.abort();
            check.stopPolling();
            unmountView();
        },
        invalidate() { if (!changed.value) state.config = undefined; },
    };
}
