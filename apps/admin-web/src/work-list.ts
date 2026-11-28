import { h, render } from 'vue';
import { mediaUrl as assetUrl } from './utils/format';
import WorkList from './components/WorkList.vue';
import { paginationState } from './pagination';
import type { WorkItem, WorkLayout } from './work-list-types';

type ListData = {
    items?: WorkItem[];
    page?: number;
    pages?: number;
    layout?: WorkLayout;
    selectable?: boolean;
    overlay?: boolean;
    showAuthor?: boolean;
    selectedIds?: Set<string>;
    allowLayoutSwitch?: boolean;
};

type Callbacks = {
    onPageChange: (page: number) => void;
    onLayoutChange: (layout: WorkLayout) => void;
    onOpen: (id: string) => void;
    onSelectionChange: (ids: Set<string>) => void;
    onRetry: () => void;
    authorUrl: (id: string) => string;
};


/** Adapter for routes that still use the existing DOM controller. */
export function mountWorkList(root: HTMLElement, callbacks: Callbacks) {
    root.replaceChildren();
    let state: ListData = {};
    let ids = new Set<string>();
    let busy = false;
    let phase: 'ready' | 'loading' | 'error' = 'loading';
    let message = '';
    let disposed = false;

    function updateView() {
        if (disposed) return;
        const pagination = phase === 'ready' ? paginationState(state) : { page: 1, pages: 0 };
        render(h(WorkList, {
            ...pagination,
            items: state.items ?? [],
            layout: state.layout ?? 'cards',
            selectable: Boolean(state.selectable),
            overlay: Boolean(state.overlay),
            showAuthor: state.showAuthor ?? !state.overlay,
            allowLayoutSwitch: state.allowLayoutSwitch ?? true,
            busy, phase, message, selectedIds: ids, assetUrl, authorUrl: callbacks.authorUrl,
            onPage(page) {
                if (busy || !Number.isSafeInteger(page) || page < 1 || page > pagination.pages || page === pagination.page) return;
                setBusy(true);
                try { callbacks.onPageChange(page); }
                catch (error) { setBusy(false); throw error; }
            },
            onLayout: callbacks.onLayoutChange,
            onOpen: callbacks.onOpen,
            onRetry: callbacks.onRetry,
            onSelect(id, checked) {
                ids = new Set(ids);
                if (checked) ids.add(id);
                else ids.delete(id);
                callbacks.onSelectionChange(new Set(ids));
                updateView();
            },
        }), root);
    }

    function setBusy(value: boolean) {
        busy = value;
        updateView();
    }

    return {
        update(data: ListData) { state = data; ids = new Set(data.selectedIds); phase = 'ready'; setBusy(false); },
        setBusy,
        setSelection(selected: Set<string>) { ids = new Set(selected); updateView(); },
        showLoading() { phase = 'loading'; setBusy(true); },
        showError(error: string) { phase = 'error'; message = error; setBusy(false); },
        dispose() { if (!disposed) { disposed = true; render(null, root); } },
    };
}
