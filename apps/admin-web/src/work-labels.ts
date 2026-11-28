export const workKindNames: Readonly<Record<string, string>> = Object.freeze({ video: '视频', album: '图集', unknown: '媒体缺失' });
export const workSourceNames: Readonly<Record<string, string>> = Object.freeze({ post: '发布', like: '喜欢', mix: '合集', music: '原声', single: '单条', loose: '散存' });

export function viewToggleMarkup(layout: 'cards' | 'list' = 'cards', busy = false) {
    const next = layout === 'list' ? '卡片' : '列表';
    return `<button class="plain view-layout-toggle" type="button" data-view-layout="${layout === 'list' ? 'cards' : 'list'}" aria-label="切换为${next}" title="切换为${next}"${busy ? ' disabled' : ''}></button>`;
}
