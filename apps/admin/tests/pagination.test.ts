import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mountPagination, paginationItems, paginationMarkup, paginationState } from '../../admin-web/src/pagination.ts';

test('pagination normalizes empty and invalid server state', () => {
    assert.deepEqual(paginationState(), { pages: 0, page: 1 });
    assert.deepEqual(paginationState({ pages: 5, page: 99 }), { pages: 5, page: 5 });
    assert.deepEqual(paginationState({ pages: 5, page: -1 }), { pages: 5, page: 1 });
    for (const pages of [NaN, Infinity, -1, 1.5, true, '<script>']) {
        assert.equal(paginationState({ pages }).pages, 0);
    }
    assert.equal(paginationMarkup({ pages: 1, page: 1 }), '');
});

test('pagination keeps current and boundary pages with useful ellipses', () => {
    assert.deepEqual(paginationItems(1, 0), []);
    assert.deepEqual(paginationItems(1, 3), [1, 2, 3]);
    assert.deepEqual(paginationItems(1, 100), [1, 2, 3, 'ellipsis', 100]);
    assert.deepEqual(paginationItems(50, 100), [1, 'ellipsis', 49, 50, 51, 'ellipsis', 100]);
    assert.deepEqual(paginationItems(100, 100), [1, 'ellipsis', 98, 99, 100]);
    assert.deepEqual(paginationItems(4, 7), [1, 2, 3, 4, 5, 6, 7]);
    for (const page of [1, 2, 3, 50, 98, 99, 100]) {
        const items = paginationItems(page, 100);
        assert.ok(items.includes(page) && items.includes(1) && items.includes(100));
        assert.ok(items.length <= 9);
    }
});

test('pagination emits accessible current page, boundary and loading states without duplicate IDs', () => {
    const first = paginationMarkup({ page: 1, pages: 10 });
    assert.match(first, /aria-label="上一页" disabled/);
    assert.match(first, /aria-current="page" disabled/);
    assert.match(first, /name="page".*max="10"/);
    assert.doesNotMatch(first, /\sid=/);
    assert.match(paginationMarkup({ page: 10, pages: 10 }), /aria-label="下一页" disabled/);
    const busy = paginationMarkup({ page: 5, pages: 10 }, true);
    for (const tag of busy.match(/<(?:button|input)\b[^>]*>/g) || []) assert.match(tag, / disabled/);
    assert.doesNotMatch(paginationMarkup({ page: '<img>', pages: '<script>' }), /script|img/);
});

function surface() {
    const handlers = new Map<string, (event: any) => void>();
    return { hidden: false, innerHTML: '', attributes: new Map<string, string>(), handlers,
        addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler); },
        removeEventListener(name: string) { handlers.delete(name); },
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        contains: () => true, replaceChildren() { this.innerHTML = ''; },
    };
}

test('multiple pagination surfaces synchronize and suppress duplicate navigation while loading', () => {
    const top = surface(), bottom = surface(), changes: number[] = [];
    const component = mountPagination([top, bottom], { onChange: (page: number) => changes.push(page) });
    assert.equal(top.hidden, true);
    component.update({ page: 1, pages: 10 });
    assert.equal(top.innerHTML, bottom.innerHTML);
    const button = { dataset: { page: '2' }, disabled: false };
    const event = { currentTarget: top, target: { closest: () => button } };
    top.handlers.get('click')!(event); bottom.handlers.get('click')!({ ...event, currentTarget: bottom });
    assert.deepEqual(changes, [2]);
    assert.equal(bottom.attributes.get('aria-busy'), 'true');
    component.update({ page: 2, pages: 10 });
    assert.equal(top.innerHTML, bottom.innerHTML);
    component.setVisible(false); assert.equal(top.hidden, true); assert.equal(bottom.hidden, true);
    component.setVisible(true); assert.equal(top.hidden, false);
    component.clear(); assert.equal(top.hidden, true); assert.equal(top.innerHTML, '');
    component.dispose(); assert.equal(top.handlers.size, 0); assert.equal(bottom.handlers.size, 0);
});

test('jump validation rejects fractions and out-of-range pages without navigation', () => {
    const root = surface(), changes: number[] = [];
    const component = mountPagination(root, { onChange: (page: number) => changes.push(page) });
    component.update({ page: 1, pages: 10 });
    let value = '0', valid = true, prevented = 0;
    const form = { reportValidity: () => valid, elements: { namedItem: () => ({ value }) } };
    const event = { currentTarget: root, target: { closest: () => form }, preventDefault() { prevented++; } };
    for (const input of ['0', '11', '2.5', '', 'not-a-page']) {
        value = input; root.handlers.get('submit')!(event);
    }
    assert.deepEqual(changes, []);
    value = '3'; valid = false; root.handlers.get('submit')!(event);
    assert.deepEqual(changes, []);
    valid = true; root.handlers.get('submit')!(event);
    assert.deepEqual(changes, [3]); assert.equal(prevented, 7);
    component.update({ page: 3, pages: 10 });
    component.setBusy(true); value = '4'; root.handlers.get('submit')!(event);
    assert.deepEqual(changes, [3]);
});
