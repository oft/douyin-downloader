type CountField = 'totalUrls' | 'completedUrls' | 'itemsTotal' | 'itemsCompleted' | 'receivedItems'
    | 'newItems' | 'existingItems' | 'repairItems' | 'downloadedItems' | 'failedItems' | 'success'
    | 'activeItems' | 'queuedItems' | 'bytesRead' | 'bytesTotal' | 'failed' | 'skipped' | 'failedUrls';

export type UpdateTask = {
    state: string;
    startedAt?: string;
    finishedAt?: string;
    error?: string;
    progress?: Partial<Record<CountField, number>> & {
        updatedAt?: string;
        streaming?: boolean;
        listingState?: string;
        author?: string;
        url?: string;
        step?: string;
        detail?: string;
        message?: string;
        currentItem?: string;
    };
};

const count = (value?: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

function duration(milliseconds: number) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return [hours && `${hours} 小时`, minutes && `${minutes} 分`, `${seconds % 60} 秒`].filter(Boolean).join(' ');
}

function bytes(value: number) {
    return value >= 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB`
        : `${(value / 1024).toFixed(0)} KB`;
}

export function updateProgressView(task: UpdateTask, now = Date.now()) {
    const progress = task.progress ?? {};
    const total = count(progress.totalUrls);
    const completed = Math.min(total, count(progress.completedUrls));
    const itemsTotal = count(progress.itemsTotal);
    const itemsCompleted = Math.min(itemsTotal, count(progress.itemsCompleted));
    const started = Date.parse(task.startedAt ?? '');
    const finished = Date.parse(task.finishedAt ?? '');
    const updated = Date.parse(progress.updatedAt ?? '');
    const active = ['starting', 'running', 'stopping'].includes(task.state);
    const streaming = progress.streaming === true;
    const collecting = streaming && progress.listingState === 'collecting' && active;
    const listing = progress.listingState === 'complete' ? '列表抓取结束'
        : progress.listingState === 'partial' ? '列表未取全' : active ? '继续抓取中' : '列表抓取已停止';
    const counters = ['receivedItems', 'newItems', 'existingItems', 'repairItems', 'downloadedItems', 'failedItems'] as const;
    const detailed = counters.every(key => {
        const value = progress[key];
        return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    });
    const classified = count(progress.newItems) + count(progress.existingItems) + count(progress.repairItems);
    const workText = detailed
        ? `已获取 ${count(progress.receivedItems)} 条 · 新作品 ${count(progress.newItems)} 条 · 已下载 ${count(progress.downloadedItems)} 条`
            + ` · 已存在 ${count(progress.existingItems)} 条`
            + (progress.repairItems ? ` · 待补全 ${count(progress.repairItems)} 条` : '')
            + (itemsTotal > classified ? ` · 待核对 ${itemsTotal - classified} 条` : '')
            + (progress.failedItems ? ` · 下载失败 ${count(progress.failedItems)} 条` : '')
        : itemsTotal ? `已获取 ${itemsTotal} 条 · 新作品待核对 · 本轮累计已下载 ${count(progress.success)} 条` : '等待获取作品列表';
    const elapsed = Number.isFinite(started) ? duration((Number.isFinite(finished) ? finished : now) - started) : '—';
    return {
        total, completed, itemsTotal, itemsCompleted,
        percent: total ? `${Math.floor(completed / total * 100)}%` : '—',
        linkText: total ? `已处理 ${completed} / ${total} 个链接` : active ? '等待下载器上报进度…' : '启动后显示链接总进度',
        itemsText: `${workText}${streaming ? ` · ${listing}` : ''}`,
        itemsIndeterminate: collecting,
        queueText: streaming ? `进行中 ${active ? count(progress.activeItems) : 0} 条 · 等待 ${count(progress.queuedItems)} 条` : '',
        author: progress.author || (progress.url ? '正在识别作者' : '—'),
        url: progress.url || '',
        phase: progress.step || (active ? '正在初始化' : '尚未开始'),
        detail: progress.detail || '',
        message: progress.message || '',
        elapsed,
        freshness: Number.isFinite(updated) ? active ? `距上次进度 ${duration(now - updated)}` : '已保留最终进度' : '尚未收到进度',
        file: progress.currentItem && (progress.bytesRead ?? 0) > 0
            ? `最近文件 ${progress.currentItem}：${bytes(progress.bytesRead ?? 0)}${progress.bytesTotal ? ` / ${bytes(progress.bytesTotal)}` : ''}` : '',
        success: count(progress.success), failed: count(progress.failed),
        skipped: count(progress.skipped), failedUrls: count(progress.failedUrls),
    };
}
