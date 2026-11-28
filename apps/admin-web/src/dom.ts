export function requiredElement<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`找不到界面元素 ${selector}`);
    return element;
}

export function eventElement(event: Event) {
    return event.target instanceof Element ? event.target : undefined;
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value: unknown = '') {
    return String(value ?? '').replace(/[&<>"']/g, character => entities[character]!);
}
