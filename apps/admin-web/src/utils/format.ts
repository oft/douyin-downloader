import { escapeHtml } from '../dom';

export const number = new Intl.NumberFormat('zh-CN');
export const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function mediaUrl(id: string) {
    return `/media/${encodeURIComponent(id)}`;
}

export function formatSize(bytes: number) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let index = 0;
    while (bytes >= 1024 && index < units.length - 1) {
        bytes /= 1024;
        index++;
    }
    return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: index ? 2 : 0 }).format(bytes)} ${units[index]}`;
}

export function optionMarkup(values: Record<string, string>, current: string) {
    return Object.entries(values).map(([value, label]) =>
        `<option value="${escapeHtml(value)}" ${value === current ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

export function emptyMarkup(title: string, description: string, actionMarkup = '') {
    return `<div class="empty"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${actionMarkup}</div>`;
}

export function localPathLabel(root: string, relative?: string) {
    if (!relative) return root;
    return root + (root.includes('\\') ? `\\${relative.replaceAll('/', '\\')}` : `/${relative}`);
}
