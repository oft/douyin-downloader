type PageInput = { page?: unknown; pages?: unknown };
type PaginationSurface = Pick<HTMLElement, 'hidden' | 'innerHTML' | 'addEventListener' | 'removeEventListener' | 'setAttribute' | 'replaceChildren'>;

const formatNumber = new Intl.NumberFormat('zh-CN');

function integer(value: unknown, fallback: number) {
    if (value === null || value === '' || typeof value === 'boolean') return fallback;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

export function paginationState(data: PageInput = {}) {
    const pages = integer(data?.pages, 0);
    return { pages, page: Math.max(1, Math.min(integer(data?.page, 1), pages || 1)) };
}

export function paginationItems(page: number, pages: number) {
    const state = paginationState({ page, pages });
    if (!state.pages) return [];
    const selected = new Set([1, state.pages, state.page]);
    const start = state.page <= 3 ? 1 : Math.max(1, Math.min(state.page - 1, state.pages - 2));
    const end = state.page >= state.pages - 2 ? state.pages : Math.min(state.pages, Math.max(3, state.page + 1));
    for (let value = start; value <= end; value++) selected.add(value);
    const items: (number | 'ellipsis')[] = [];
    let previous = 0;
    for (const value of [...selected].sort((a, b) => a - b)) {
        if (value - previous === 2) items.push(previous + 1);
        else if (value - previous > 2) items.push('ellipsis');
        items.push(value);
        previous = value;
    }
    return items;
}

export function paginationMarkup(data: PageInput, busy = false) {
    const { page, pages } = paginationState(data);
    if (pages <= 1) return '';
    const disabled = (condition: boolean) => condition ? ' disabled' : '';
    const numbers = paginationItems(page, pages).map(value => value === 'ellipsis'
        ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
        : `<button class="pagination-number" type="button" data-page="${value}" aria-label="第 ${value} 页"${value === page ? ' aria-current="page"' : ''}${disabled(busy || value === page)}>${formatNumber.format(value)}</button>`).join('');
    return `<div class="pagination-pages">
        <button class="pagination-step" type="button" data-page="${page - 1}" aria-label="上一页"${disabled(busy || page === 1)}><span aria-hidden="true">‹</span></button>
        ${numbers}
        <button class="pagination-step" type="button" data-page="${page + 1}" aria-label="下一页"${disabled(busy || page === pages)}><span aria-hidden="true">›</span></button>
    </div><form class="pagination-jump" data-page-jump>
        <label><span>跳至</span><input name="page" aria-label="跳转页码" inputmode="numeric" type="number" min="1" max="${pages}" value="${page}" step="1" required${disabled(busy)}><span>页</span></label>
        <button class="plain" type="submit"${disabled(busy)}>跳转</button>
    </form>`;
}

/** Multiple bars share one page state and one navigation callback. */
export function mountPagination(elements: PaginationSurface | PaginationSurface[], { onChange }: { onChange: (page: number) => void }) {
    const roots = [...new Set(Array.isArray(elements) ? elements : [elements])].filter(Boolean);
    let state = paginationState(), busy = false, visible = true;
    function render() {
        const markup = paginationMarkup(state, busy);
        for (const root of roots) {
            root.hidden = !visible || state.pages <= 1;
            root.setAttribute('aria-busy', String(busy));
            root.innerHTML = markup;
        }
    }
    function request(value: unknown) {
        const page = integer(value, 0);
        if (busy || !visible || page < 1 || page > state.pages || page === state.page) return;
        busy = true;
        render();
        try { onChange(page); }
        catch (error) { busy = false; render(); throw error; }
    }
    function click(event: Event) {
        const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>('button[data-page]');
        if (!button || button.disabled || !(event.currentTarget as Node | null)?.contains(button)) return;
        request(button.dataset.page);
    }
    function submit(event: Event) {
        const form = (event.target as Element | null)?.closest?.<HTMLFormElement>('form[data-page-jump]');
        if (!form || !(event.currentTarget as Node | null)?.contains(form)) return;
        event.preventDefault();
        const input = form.elements.namedItem('page') as HTMLInputElement | null;
        if (input && form.reportValidity()) request(input.value);
    }
    for (const root of roots) {
        root.addEventListener('click', click);
        root.addEventListener('submit', submit);
    }
    render();
    return {
        update(data: PageInput) { state = paginationState(data); busy = false; render(); },
        setBusy(value: boolean) { busy = Boolean(value); render(); },
        setVisible(value: boolean) { visible = Boolean(value); for (const root of roots) root.hidden = !visible || state.pages <= 1; },
        clear() { state = paginationState(); busy = false; visible = true; render(); },
        dispose() {
            for (const root of roots) {
                root.removeEventListener('click', click);
                root.removeEventListener('submit', submit);
                root.replaceChildren(); root.hidden = true;
            }
        },
    };
}
