import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUpdateProgress } from '../util/update-progress.ts';
import { updateProgressView } from '../../admin-web/src/update-progress.ts';

export function progressEvent(overrides = {}) {
    return { type: 'progress', version: 1, progress: {
        totalUrls: 157, completedUrls: 24, currentIndex: 25, failedUrls: 1,
        url: 'https://www.douyin.com/user/test', author: '测试作者', step: '下载作品', detail: '正在下载',
        itemsTotal: 20, itemsCompleted: 12, success: 110, failed: 2, skipped: 30,
        bytesRead: 1048576, bytesTotal: 2097152, currentItem: '123', message: '',
        ...overrides,
    } };
}

test('accepts only bounded versioned progress snapshots', () => {
    const event = progressEvent();
    assert.equal(parseUpdateProgress(JSON.stringify(event))?.author, '测试作者');
    for (const line of ['ordinary log', '{}', 'null', JSON.stringify({ ...event, version: 2 }),
        JSON.stringify(progressEvent({ totalUrls: -1 })),
        JSON.stringify(progressEvent({ completedUrls: 158 })),
        JSON.stringify(progressEvent({ author: 'x'.repeat(2001) })),
        JSON.stringify(progressEvent({ success: 1.5 }))]) {
        assert.equal(parseUpdateProgress(line), undefined);
    }
});

test('uses link progress independently of work progress and freezes elapsed time on completion', () => {
    const status = { state: 'running', startedAt: '2026-11-25T12:00:00Z',
        progress: { ...progressEvent().progress, updatedAt: '2026-11-25T12:01:00Z' } };
    const now = Date.parse('2026-11-25T12:01:30Z');
    const view = updateProgressView(status, now);
    assert.equal(view.percent, '15%');
    assert.equal(view.linkText, '已处理 24 / 157 个链接');
    assert.equal(view.itemsText, '已获取 20 条 · 新作品待核对 · 本轮累计已下载 110 条');
    assert.equal(view.elapsed, '1 分 30 秒');
    assert.equal(view.freshness, '距上次进度 30 秒');
    assert.match(view.file, /1.0 MB \/ 2.0 MB/);
    const final = updateProgressView({ ...status, state: 'failed', finishedAt: '2026-11-25T12:01:15Z' }, now);
    assert.equal(final.elapsed, '1 分 15 秒');
    assert.equal(final.percent, '15%');
    assert.equal(final.freshness, '已保留最终进度');
    assert.equal(updateProgressView({ state: 'running' }, now).percent, '—');
});

test('reports growing streaming discovery separately from active and queued downloads', () => {
    const line = JSON.stringify(progressEvent({ streaming: true, queuedItems: 5, activeItems: 3,
        listingState: 'collecting' }));
    const progress = parseUpdateProgress(line)!;
    assert.equal(progress.streaming, true);
    const view = updateProgressView({ state: 'running', progress });
    assert.equal(view.itemsIndeterminate, true);
    assert.match(view.itemsText, /已获取 20 条.*新作品待核对.*本轮累计已下载 110 条.*继续抓取中/);
    assert.equal(view.queueText, '进行中 3 条 · 等待 5 条');
    const final = updateProgressView({ state: 'completed', progress: { ...progress, listingState: 'complete' } });
    assert.equal(final.itemsIndeterminate, false);
    assert.match(final.itemsText, /列表抓取结束/);
    assert.match(final.queueText, /进行中 0 条/);
    for (const overrides of [{ queuedItems: -1 }, { activeItems: 21 },
        { queuedItems: 20, activeItems: 2 }, { listingState: 'unknown' }, { streaming: 'yes' }]) {
        assert.equal(parseUpdateProgress(JSON.stringify(progressEvent({ streaming: true,
            queuedItems: 0, activeItems: 0, listingState: 'collecting', ...overrides }))), undefined);
    }
});


test('shows actual per-author fetched, new and downloaded counts independently from global totals', () => {
    const counters = { receivedItems: 29, newItems: 7, existingItems: 20, repairItems: 2,
        downloadedItems: 3, failedItems: 1 };
    const progress = parseUpdateProgress(JSON.stringify(progressEvent({ ...counters, streaming: true,
        itemsTotal: 29, itemsCompleted: 4, queuedItems: 22, activeItems: 3, listingState: 'collecting' })))!;
    assert.ok(progress);
    const view = updateProgressView({ state: 'running', progress });
    assert.match(view.itemsText, /已获取 29 条 · 新作品 7 条 · 已下载 3 条 · 已存在 20 条 · 待补全 2 条 · 下载失败 1 条/);
    assert.ok(!view.itemsText.includes('已下载 110'));
    assert.equal(view.success, 110, 'overall download metric remains cumulative');
    for (const overrides of [{ newItems: -1 }, { newItems: 30 }, { receivedItems: 28 },
        { downloadedItems: 8 }, { failedItems: undefined }]) {
        assert.equal(parseUpdateProgress(JSON.stringify(progressEvent({ ...counters,
            itemsTotal: 29, itemsCompleted: 4, ...overrides }))), undefined);
    }
});
