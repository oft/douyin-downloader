import type { Author, IssueRow } from '../catalog-types';
import { escapeHtml as escape } from '../dom';
import { mediaUrl as asset, number } from './format';
import { authorLink } from './catalog-links';

export const issueNames: Record<string, string> = {
    missing_video: '视频缺失', missing_cover: '封面缺失', incomplete_album: '图集不完整', empty_file: '空文件',
    unreadable_file: '文件无法读取', unreadable_folder: '目录无法读取', missing_metadata: '元数据缺失',
    invalid_metadata: '元数据无法解析', incomplete_metadata: '元数据不完整', unrecognized_media: '媒体无法识别',
    missing_media: '媒体缺失', invalid_media_path: '媒体路径异常',
};
export const reviewNames = { pending: '待处理', resolved: '已处理', ignored: '已忽略' };

function entryCheckbox(id: string, name: string) {
    return `<label class="entry-check"><input type="checkbox" data-select-entry value="${escape(id)}" aria-label="选择 ${escape(name)}"></label>`;
}

export function authorCard(author: Author, list: boolean) {
    const avatar = author.avatar ? `<img src="${asset(author.avatar)}" alt="" loading="lazy" decoding="async">` : '';
    const initial = Array.from(author.name)[0] ?? '◎';
    const count = `<span class="author-count">${number.format(author.workCount)} 件作品</span>`;
    return `<article class="author-entry">${entryCheckbox(author.id, author.name)}
        <a class="author-card" href="${authorLink(author.id)}"><span class="avatar"><span aria-hidden="true">${escape(initial)}</span>${avatar}</span><span class="author-card-info">
        <strong>${escape(author.name)}</strong>${list ? '' : count}${author.aliases.length ? `<small>曾用名 ${escape(author.aliases.join('、'))}</small>` : ''}</span>
        ${list ? count : ''}<span class="author-arrow" aria-hidden="true">›</span></a></article>`;
}

export function issueCard(row: IssueRow, selected: boolean) {
    const state = row.present ? reviewNames[row.status] : '复扫已消除';
    const workButton = row.targetId && row.present ? `<button type="button" class="plain" data-work="${escape(row.targetId)}">查看作品</button>` : '';
    return `<article class="issue-card">
        <label class="issue-select"><input type="checkbox" data-select-issue="${escape(row.id)}" aria-label="选择异常 ${escape(issueNames[row.code] ?? row.code)}" ${selected ? 'checked' : ''}></label><div class="issue-info"><div class="issue-line"><strong>${escape(issueNames[row.code] ?? row.code)}</strong><span class="status-pill ${escape(row.present ? row.status : 'cleared')}">${escape(state)}</span></div>
        <p>${escape(row.title ? `${row.title} · ${row.detail}` : row.detail)}</p><code class="path" title="${escape(row.path)}">${escape(row.path)}</code>
        ${row.note ? `<p class="review-note">备注　${escape(row.note)}</p>` : ''}</div>
        <div class="issue-actions">${workButton}${row.present && row.targetId ? `<button type="button" class="secondary danger" data-remove-issue-work="${escape(row.targetId)}">查看清理范围</button>` : ''}<button type="button" class="secondary" data-review="${escape(row.id)}">复核</button></div>
    </article>`;
}
