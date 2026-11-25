import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import aiosqlite
import pytest

from core.post_pipeline import PostDownloadPipeline
from storage.database import Database
from storage.download_queue import DownloadQueueStore
from utils.browser_runtime import BrowserUnavailableError


def item(key):
    return {"aweme_id": str(key), "desc": "work", "author": {"uid": "uid", "sec_uid": "author"}}


def build(*, database=None, limit=0, workers=2, capacity=2):
    config = {"number": {"post": limit}, "thread": workers, "path": "out"}
    downloader = SimpleNamespace(
        config=SimpleNamespace(get=lambda key, default=None: config.get(key, default)),
        database=database, progress_reporter=SimpleNamespace(on_stream_progress=Mock()),
        rate_limiter=SimpleNamespace(acquire=AsyncMock()),
        api_client=SimpleNamespace(get_video_detail=AsyncMock(side_effect=lambda key, **_: item(key))),
        _detect_media_type=lambda _item: "video", _settle_crashed_item=Mock(),
        _should_download=AsyncMock(return_value=True),
        _process_mode_aweme=AsyncMock(return_value={"status": "success"}),
    )
    strategy = SimpleNamespace(downloader=downloader, incomplete_reason=None,
                               filter_stream_items=lambda items: items)
    return PostDownloadPipeline(strategy, "author", {"nickname": "作者"}, set(), capacity=capacity)


async def test_download_starts_before_list_producer_finishes():
    pipe = build()
    started = asyncio.Event()
    listing_done = False
    async def download(*_args, **_kwargs):
        assert not listing_done
        started.set()
        return {"status": "success"}
    pipe.downloader._process_mode_aweme.side_effect = download
    async def collect():
        nonlocal listing_done
        await pipe.offer([item(1)])
        await asyncio.wait_for(started.wait(), 1)
        listing_done = True
    result = await asyncio.wait_for(pipe.run(collect), 2)
    assert result.total == result.success == 1


async def test_bounded_queue_applies_backpressure_and_cancels_all_workers():
    pipe = build(workers=1, capacity=2)
    active = asyncio.Event()
    stopped = asyncio.Event()
    async def download(*_args, **_kwargs):
        active.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    pipe.downloader._process_mode_aweme.side_effect = download
    producer_done = asyncio.Event()
    async def collect():
        await pipe.offer([item(i) for i in range(100)])
        producer_done.set()
    task = asyncio.create_task(pipe.run(collect))
    await asyncio.wait_for(active.wait(), 1)
    for _ in range(5):
        await asyncio.sleep(0)
    assert pipe.queue.qsize() == 2 and pipe.active == 1
    assert pipe.result.total <= 4 and not producer_done.is_set()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert stopped.is_set() and pipe.active == 0


async def test_number_limit_and_dedup_are_global_across_pages():
    pipe = build(limit=3)
    async def collect():
        assert await pipe.offer([item(1), item(2)]) is True
        assert await pipe.offer([item(1), item(2), item(3), item(4)]) is False
    result = await pipe.run(collect)
    assert result.total == result.success == 3
    assert {args.args[0]["aweme_id"] for args in pipe.downloader._process_mode_aweme.call_args_list} == {"1", "2", "3"}


async def test_listing_failure_drains_already_discovered_work_as_partial():
    pipe = build()
    async def collect():
        await pipe.offer([item(i) for i in range(8)])
        raise RuntimeError("page two failed")
    result = await pipe.run(collect)
    assert result.total == result.success == 8
    assert "page two failed" in result.incomplete_reason


async def test_fatal_browser_failure_still_propagates_after_draining():
    pipe = build()
    async def collect():
        await pipe.offer([item(1)])
        raise BrowserUnavailableError("browser closed")
    with pytest.raises(BrowserUnavailableError):
        await pipe.run(collect)
    assert pipe.result.success == 1


async def test_item_failure_does_not_stop_other_downloads():
    pipe = build()
    async def download(work, *_args, **_kwargs):
        if work["aweme_id"] == "1":
            raise ValueError("bad work")
        return {"status": "success"}
    pipe.downloader._process_mode_aweme.side_effect = download
    result = await pipe.run(lambda: pipe.offer([item(i) for i in range(4)]))
    assert (result.success, result.failed) == (3, 1)
    pipe.downloader._settle_crashed_item.assert_called_once()


async def test_download_concurrency_is_capped_at_three_and_respects_lower_setting():
    for configured, expected in [(8, 3), (1, 1)]:
        pipe = build(workers=configured)
        peak, active = 0, 0
        release = asyncio.Event()
        async def download(*_args, **_kwargs):
            nonlocal peak, active
            active += 1
            peak = max(peak, active)
            if active == expected:
                release.set()
            await asyncio.wait_for(release.wait(), 1)
            active -= 1
            return {"status": "success"}
        pipe.downloader._process_mode_aweme.side_effect = download
        await pipe.run(lambda: pipe.offer([item(i) for i in range(20)]))
        assert peak == expected


@pytest.fixture
async def database(tmp_path):
    db = Database(str(tmp_path / "library.db"))
    await db.initialize()
    try:
        yield db
    finally:
        await db.close()


async def test_discovery_is_not_mistaken_for_a_downloaded_work(database):
    pipe = build(database=database)
    async def download(work, *_args, **_kwargs):
        assert not await database.is_downloaded(work["aweme_id"])
        return {"status": "success"}
    pipe.downloader._process_mode_aweme.side_effect = download
    await pipe.run(lambda: pipe.offer([item(1)]))
    assert not await database.is_downloaded("1")
    async with aiosqlite.connect(database.db_path) as db:
        async with db.execute("SELECT status, payload FROM download_queue") as cursor:
            assert await cursor.fetchone() == ("completed", "{}")


async def test_cancelled_work_survives_restart_and_refreshes_media_details(database):
    pipe = build(database=database, workers=1)
    started = asyncio.Event()
    async def download(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()
    pipe.downloader._process_mode_aweme.side_effect = download
    task = asyncio.create_task(pipe.run(lambda: pipe.offer([item(1), item(2)])))
    await asyncio.wait_for(started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)
    restarted = build(database=database)
    await restarted.run(lambda: restarted.offer([item(1), item(2)]))
    assert restarted.result.total == restarted.result.success == 2
    assert restarted.downloader.api_client.get_video_detail.await_count == 2


async def test_stale_pending_details_can_be_replaced_by_fresh_browser_metadata(database):
    pipe = build(database=database)
    await pipe.run(lambda: pipe.offer([item(1)]))
    store = DownloadQueueStore(database.db_path, pipe.store.scope)
    await store.initialize()
    await store.remember(item(2))
    await store.close()
    restarted = build(database=database)
    restarted.downloader.api_client.get_video_detail.return_value = None
    restarted.downloader.api_client.get_video_detail.side_effect = None
    result = await restarted.run(lambda: restarted.offer([item(2)]))
    assert result.success == 1 and result.incomplete_reason is None


async def test_already_saved_pending_file_does_not_require_refreshing_expired_details(database):
    pipe = build(database=database)
    await pipe.run(lambda: pipe.offer([item(1)]))
    store = DownloadQueueStore(database.db_path, pipe.store.scope)
    await store.initialize()
    await store.remember(item(2))
    await store.close()
    restarted = build(database=database)
    restarted.downloader._should_download.return_value = False
    restarted.downloader._process_mode_aweme.return_value = {"status": "skipped"}
    result = await restarted.run(AsyncMock())
    assert result.skipped == 1 and result.incomplete_reason is None
    restarted.downloader.api_client.get_video_detail.assert_not_awaited()


async def test_unrestored_pending_work_is_not_silently_reported_complete(database):
    pipe = build(database=database)
    await pipe.run(lambda: pipe.offer([item(1)]))
    store = DownloadQueueStore(database.db_path, pipe.store.scope)
    await store.initialize()
    for i in range(2, 10):
        await store.remember(item(i))
    await store.close()
    restarted = build(database=database)
    restarted.downloader.api_client.get_video_detail.side_effect = None
    restarted.downloader.api_client.get_video_detail.return_value = None
    result = await restarted.run(AsyncMock())
    assert restarted.downloader.api_client.get_video_detail.await_count == 3
    assert "8条历史待下载作品" in result.incomplete_reason


async def test_store_failure_cannot_leave_the_producer_waiting_forever(database, monkeypatch):
    pipe = build(database=database, workers=1, capacity=1)
    monkeypatch.setattr(DownloadQueueStore, "mark", AsyncMock(side_effect=OSError("disk failure")))
    with pytest.raises(OSError):
        await asyncio.wait_for(pipe.run(lambda: pipe.offer([item(i) for i in range(20)])), 2)


async def test_crashed_queue_records_recover_and_scopes_stay_separate(database):
    store = DownloadQueueStore(database.db_path, "author-a")
    await store.initialize()
    await store.remember(item(1))
    await store.remember(item(2))
    await store.mark("1", "downloading")
    await store.mark("2", "failed")
    await store.close()
    restarted = DownloadQueueStore(database.db_path, "author-a")
    await restarted.initialize()
    try:
        assert {entry["aweme_id"] async for entry in restarted.pending()} == {"1", "2"}
        await restarted.mark("1", "completed")
        assert await restarted.unfinished_count() == 1
    finally:
        await restarted.close()
    other = DownloadQueueStore(database.db_path, "author-b")
    await other.initialize()
    try:
        assert [entry async for entry in other.pending()] == []
    finally:
        await other.close()
