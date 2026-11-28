export type UpdateProgress = {
    totalUrls: number; completedUrls: number; currentIndex: number; failedUrls: number;
    url: string; author: string; step: string; detail: string;
    itemsTotal: number; itemsCompleted: number;
    success: number; failed: number; skipped: number;
    bytesRead: number; bytesTotal: number; currentItem: string; message: string;
    updatedAt: string;
    streaming?: boolean; queuedItems?: number; activeItems?: number;
    listingState?: 'collecting' | 'complete' | 'partial';
    receivedItems?: number; newItems?: number; existingItems?: number; repairItems?: number;
    downloadedItems?: number; failedItems?: number;
};

const counts = ['totalUrls', 'completedUrls', 'currentIndex', 'failedUrls', 'itemsTotal',
    'itemsCompleted', 'success', 'failed', 'skipped', 'bytesRead', 'bytesTotal'] as const;
const workCounts = ['receivedItems', 'newItems', 'existingItems', 'repairItems', 'downloadedItems', 'failedItems'] as const;
const labels = ['url', 'author', 'step', 'detail', 'currentItem', 'message'] as const;

export function parseUpdateProgress(line: string): UpdateProgress | undefined {
    if (line.length > 32_768) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type !== 'progress' || event.version !== 1 || !event.progress) return;
    const data = event.progress;
    if (data.streaming !== undefined && typeof data.streaming !== 'boolean') return;
    if (data.streaming && (!['collecting', 'complete', 'partial'].includes(data.listingState)
        || !Number.isSafeInteger(data.queuedItems) || data.queuedItems < 0
        || !Number.isSafeInteger(data.activeItems) || data.activeItems < 0
        || data.queuedItems + data.activeItems > data.itemsTotal)) return;
    const hasWorkCounts = workCounts.some(key => data[key] !== undefined);
    if (hasWorkCounts && (workCounts.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)
        || data.newItems + data.existingItems + data.repairItems > data.itemsTotal
        || data.itemsTotal > data.receivedItems
        || data.downloadedItems + data.failedItems > data.itemsCompleted)) return;
    if (counts.some(key => !Number.isSafeInteger(data[key]) || data[key] < 0)
        || labels.some(key => typeof data[key] !== 'string' || data[key].length > 2000)
        || data.completedUrls > data.totalUrls || data.currentIndex > data.totalUrls
        || data.failedUrls > data.completedUrls || data.itemsCompleted > data.itemsTotal) return;
    return Object.fromEntries([
        ...counts.map(key => [key, data[key]]), ...labels.map(key => [key, data[key]]),
        ['updatedAt', new Date().toISOString()],
        ...(hasWorkCounts ? workCounts.map(key => [key, data[key]]) : []),
        ...(data.streaming ? [['streaming', true], ['queuedItems', data.queuedItems],
            ['activeItems', data.activeItems], ['listingState', data.listingState]] : []),
    ]) as UpdateProgress;
}
