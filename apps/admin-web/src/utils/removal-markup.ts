import { escapeHtml as escape } from '../dom';
import { workSourceNames as sourceNames } from '../work-labels';
import { formatSize, number } from './format';

export type RemovalCopy = { source: string; flat?: boolean; directory: string; error?: string; files: { name: string; kind: string; size?: number }[] };

export function visibleFiles(copy: RemovalCopy) {
    return copy.files.filter(file => !file.name.split('/').some(part => part.startsWith('._')));
}

export function fileList(copy: RemovalCopy, index: number, showAll = false) {
    const source = sourceNames[copy.source] ?? copy.source;
    const type = copy.flat ? '平铺文件' : '作品目录';
    const kinds: Record<string, string> = { directory: '目录', link: '链接', other: '其他' };
    const files = showAll ? copy.files : visibleFiles(copy);
    const rows = files.map(file => {
        const ext = file.name.split('/').at(-1)?.match(/\.([^.]+)$/)?.[1];
        const label = file.kind === 'file' ? ext?.toUpperCase() || '文件' : kinds[file.kind];
        const image = file.kind === 'file' && /\.(?:jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name) && !file.name.split('/').at(-1)?.startsWith('._');
        const relative = [copy.directory, file.name].filter(Boolean).join('/');
        const url = `/assets/${relative.split('/').map(encodeURIComponent).join('/')}`;
        const name = image ? `<button class="plain file-image-select" type="button" data-file-preview="${escape(url)}" data-file-name="${escape(file.name)}" aria-pressed="false">${escape(file.name)}</button>` : escape(file.name);
        return `<tr><td>${name}</td><td>${escape(label)}</td><td>${file.size === undefined ? '—' : formatSize(file.size)}</td></tr>`;
    }).join('');
    const entries = copy.error ? `<p class="player-error">无法读取：${escape(copy.error)}</p>` : rows
        ? `<table class="file-table"><thead><tr><th scope="col">文件名</th><th scope="col">类型</th><th scope="col">大小</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="summary">没有可显示的文件</p>';
    return `<details class="file-copy" ${index === 0 ? 'open' : ''}><summary><strong>${escape(source)}</strong><span>${type} · ${number.format(files.length)} 项</span></summary>
        <div class="file-copy-body"><div class="file-path"><code class="path">${escape(copy.directory || '下载根目录')}</code><button class="plain" type="button" data-copy="${escape(copy.directory)}">复制目录</button></div>${entries}
        <figure class="file-image-preview" hidden><div data-file-image></div><figcaption><strong data-file-caption></strong><span data-file-status role="status"></span><a class="plain" data-file-original target="_blank" rel="noopener">打开原图</a></figcaption></figure></div></details>`;
}

export function previewFile(button: HTMLButtonElement) {
    const copy = button.closest('.file-copy');
    const preview = copy?.querySelector<HTMLElement>('.file-image-preview');
    if (!copy || !preview || !button.dataset.filePreview) return;
    for (const item of copy.querySelectorAll('[data-file-preview]')) item.setAttribute('aria-pressed', String(item === button));
    const name = button.dataset.fileName ?? '';
    preview.hidden = false;
    preview.querySelector('[data-file-caption]')!.textContent = name;
    const status = preview.querySelector('[data-file-status]')!;
    status.textContent = '正在加载图片…';
    preview.querySelector<HTMLAnchorElement>('[data-file-original]')!.href = button.dataset.filePreview;
    const image = new Image();
    image.alt = name;
    image.onload = () => { if (image.isConnected) status.textContent = `${image.naturalWidth} × ${image.naturalHeight}`; };
    image.onerror = () => { if (image.isConnected) { image.hidden = true; status.textContent = '图片无法加载，文件可能已缺失、损坏或浏览器不支持此格式。'; } };
    preview.querySelector('[data-file-image]')!.replaceChildren(image);
    image.src = button.dataset.filePreview;
    preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
