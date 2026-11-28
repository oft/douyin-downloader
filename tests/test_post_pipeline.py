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


def build(*, database=None, limit=0, workers=2, capacity=2, library=False):
    config = {"number": {"post": limit}, "thread": workers, "path": "out",
              "library_update_tracking": library}
    downloader = SimpleNamespace(
        config=SimpleNamespace(get=lambda key, default=None: config.get(key, default)),
        database=database, progress_reporter=SimpleNamespace(on_stream_progress=Mock()),
        rate_limiter=SimpleNamespace(acquire=AsyncMock()),
        api_client=SimpleNamespace(get_video_detail=AsyncMock(side_effect=lambda key, **_: item(key))),
        _detect_media_type=lambda _item: "video", _settle_crashed_item=Mock(),
        _progress_update_step=Mock(),
        _should_download=AsyncMock(return_value=True),
        _process_mode_aweme=AsyncMock(return_value={"status": "success"}),
    )
    strategy = SimpleNamespace(downloader=downloader, incomplete_reason=None,
                               filter_stream_items=lambda items: items)
    return PostDownloadPipeline(strategy, "author", {"nickname": "作者", "uid": "uid", "_homepage_work_total": 1}, set(), capacity=capacity)


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


@pytest.mark.parametrize("cancel", [False, True])
async def test_library_collects_more_pages_with_full_download_queue(database, cancel):
    pipe = build(database=database, workers=1, capacity=2, library=True)
    started = asyncio.Event()
    collected = asyncio.Event()
    release = asyncio.Event()
    processed = []

    async def download(work, *_args, **_kwargs):
        started.set()
        await release.wait()
        processed.append(work)
        return {"status": "success"}

    async def collect():
        await pipe.offer_page([item(1)])
        await started.wait()
        await pipe.offer_page([item(2), item(3), item(4)])
        await pipe.offer_page([item(5), item(6)])
        collected.set()

    pipe.downloader._process_mode_aweme.side_effect = download
    task = asyncio.create_task(pipe.run(collect))
    try:
        await asyncio.wait_for(collected.wait(), 3)
        assert pipe.queue.qsize() >= 5 and not processed
        assert sum(isinstance(work, dict) for work in pipe.queue._queue) == 2
        if not cancel:
            release.set()
            result = await asyncio.wait_for(task, 3)
            assert result.success == 6
            assert processed == [item(i) for i in range(1, 7)]
    finally:
        if not task.done():
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    if cancel:
        restarted = build(database=database, library=True)
        result = await restarted.run(AsyncMock())
        assert result.success == 6
        assert restarted.downloader.api_client.get_video_detail.await_count == 6


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


async def save_local(database, tmp_path, key, *, gallery=False, images=2):
    directory = tmp_path / str(key)
    directory.mkdir(exist_ok=True)
    primary = directory / (str(key) + ('_1.jpg' if gallery else '.mp4'))
    primary.write_bytes(b'local-media')
    await database.add_aweme({'aweme_id': str(key), 'aweme_type': 'gallery' if gallery else 'video',
                              'file_path': str(primary), 'image_count': images if gallery else 0,
                              'author_id': 'uid', 'author_sec_uid': 'author'})
    database.download_root = str(tmp_path)
    return primary


async def test_saved_first_page_stops_before_next_page_and_drains_workers(database, tmp_path):
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    pipe.downloader._process_mode_aweme.return_value = {'status': 'skipped'}
    async def collect():
        assert await pipe.offer_page([item(1)]) is False
    result = await pipe.run(collect)
    assert result.skipped == 1 and result.incomplete_reason is None
    pipe.downloader._process_mode_aweme.assert_not_awaited()
    pipe.downloader._progress_update_step.assert_called_once()


async def test_new_page_continues_until_an_existing_page(database, tmp_path):
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    async def collect():
        assert await pipe.offer_page([item(2), item(1)]) is True
        # A page containing only duplicates is not new evidence for a boundary.
        assert await pipe.offer_page([item(1)]) is True
        await save_local(database, tmp_path, 3)
        assert await pipe.offer_page([item(3)]) is False
    await pipe.run(collect)


async def test_pinned_only_pages_and_full_scan_do_not_stop(database, tmp_path):
    await save_local(database, tmp_path, 1)
    for force, full_scan in [(False, False), (True, False), (False, True)]:
        pipe = build(database=database)
        pipe.force = force
        original = pipe.downloader.config.get
        pipe.downloader.config.get = lambda key, default=None: False if key == 'incremental_page_stop' and full_scan else original(key, default)
        async def collect():
            page = [dict(item(1), is_top=True)] if not force and not full_scan else [item(1)]
            assert await pipe.offer_page(page) is True
        await pipe.run(collect)


async def test_history_missing_or_zero_byte_media_never_stops_paging(database, tmp_path):
    primary = await save_local(database, tmp_path, 1)
    for missing in [False, True]:
        if missing:
            primary.unlink()
        else:
            primary.write_bytes(b'')
        pipe = build(database=database)
        await pipe.run(lambda: assert_keeps_paging(pipe, [item(1)]))


async def assert_keeps_paging(pipe, page):
    assert await pipe.offer_page(page) is True


async def test_incomplete_gallery_keeps_paging_but_missing_sidecars_do_not(database, tmp_path):
    primary = await save_local(database, tmp_path, 1, gallery=True)
    page = [dict(item(1), images=[{}, {}])]
    pipe = build(database=database)
    await pipe.run(lambda: assert_keeps_paging(pipe, page))
    (primary.parent / '1_2.jpg').write_bytes(b'image-2')
    pipe = build(database=database)
    async def complete():
        assert await pipe.offer_page(page) is False
    await pipe.run(complete)
    pipe = build(database=database)
    original = pipe.downloader.config.get
    pipe.downloader.config.get = lambda key, default=None: True if key == 'json' else original(key, default)
    await pipe.run(complete)


@pytest.mark.parametrize('option', ['json', 'cover', 'avatar', 'music'])
async def test_missing_sidecars_do_not_reduce_saved_work_count_or_enqueue_repairs(database, tmp_path, option):
    for key in range(1, 7):
        await save_local(database, tmp_path, key)
    pipe = build(database=database)
    pipe.homepage_total = 7
    original = pipe.downloader.config.get
    pipe.downloader.config.get = lambda key, default=None: True if key == option else original(key, default)
    async def collect():
        assert await pipe.offer_page([item(1), item(2)]) is False
    result = await pipe.run(collect)
    assert pipe.local_saved_count == 6
    assert result.skipped == 2 and not pipe.repair_ids
    pipe.downloader._process_mode_aweme.assert_not_awaited()


async def test_unrestored_pending_work_prevents_an_existing_page_boundary(database, tmp_path):
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    await pipe.run(lambda: pipe.offer([item(2)]))
    store = DownloadQueueStore(database.db_path, pipe.store.scope)
    await store.initialize()
    await store.remember(item(3))
    await store.close()
    restarted = build(database=database)
    restarted.downloader.api_client.get_video_detail.side_effect = None
    restarted.downloader.api_client.get_video_detail.return_value = None
    result = await restarted.run(lambda: assert_keeps_paging(restarted, [item(1)]))
    assert result.incomplete_reason and '历史待下载' in result.incomplete_reason


@pytest.mark.parametrize('browser', [False, True])
async def test_real_post_strategy_stops_api_and_browser_page_callbacks(database, tmp_path, browser):
    from core.user_modes.post_strategy import PostUserModeStrategy
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    downloader = pipe.downloader
    downloader.stream_downloads = True
    downloader._filter_by_time = lambda items: items
    downloader.api_client.prefer_browser_posts = browser
    downloader.api_client.get_user_post = AsyncMock()
    downloader._browser_recovery_unavailable_reason = lambda: None
    strategy = PostUserModeStrategy(downloader)
    strategy.filter_stream_items = lambda page: page
    page = [item(1)]
    if browser:
        async def recover(_sec, _user, accumulated, **options):
            assert await options['on_items'](page) is False
            accumulated.extend(page)
        downloader._recover_user_post_with_browser = AsyncMock(side_effect=recover)
    else:
        strategy._request_post_page = AsyncMock(return_value={
            'aweme_list': page, 'has_more': 1, 'max_cursor': 10, 'status_code': 0})
    result = await strategy.download_mode('author', {'nickname': '作者', 'uid': 'uid', '_homepage_work_total': 1})
    assert result.total == 1 and result.incomplete_reason is None
    if browser:
        downloader._recover_user_post_with_browser.assert_awaited_once()
        downloader.api_client.get_user_post.assert_not_awaited()
    else:
        strategy._request_post_page.assert_awaited_once()


@pytest.mark.parametrize('option', ['comments', 'transcript'])
async def test_optional_backfill_keeps_the_original_walk(database, tmp_path, option):
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    original = pipe.downloader.config.get
    pipe.downloader.config.get = lambda key, default=None: {'enabled': True} if key == option else original(key, default)
    await pipe.run(lambda: assert_keeps_paging(pipe, [item(1)]))


async def test_progress_distinguishes_fetched_new_existing_repairs_and_download_results(database, tmp_path):
    await save_local(database, tmp_path, 1)
    missing = await save_local(database, tmp_path, 2)
    missing.unlink()
    pipe = build(database=database)
    pipe.downloader.progress_reporter.stream_counts_version = 1
    async def download(work, *_args, **_kwargs):
        return {'status': {'1': 'skipped', '2': 'success', '3': 'failed'}[work['aweme_id']]}
    pipe.downloader._process_mode_aweme.side_effect = download
    pipe.strategy.filter_stream_items = lambda page: [entry for entry in page if not entry.get('is_top')]
    async def collect():
        await pipe.offer_page([item(1), item(2), item(3), dict(item(4), is_top=True)])
        await pipe.offer_page([item(1), item(2), item(3)])
    await pipe.run(collect)
    counters = pipe.downloader.progress_reporter.on_stream_progress.call_args.kwargs
    assert counters['received'] == 4
    assert (counters['new'], counters['existing'], counters['repair']) == (1, 1, 1)
    assert (counters['downloaded'], counters['failed'], counters['skipped']) == (1, 1, 1)


async def test_large_remaining_gap_continues_even_on_a_saved_page(database, tmp_path):
    await save_local(database, tmp_path, 1)
    pipe = build(database=database)
    pipe.homepage_total = 7
    async def collect():
        assert await pipe.offer_page([item(1)]) is True
        await save_local(database, tmp_path, 2)
        # Files created outside the accepted batch do not alter the initial count.
        assert await pipe.offer_page([item(2)]) is True
    await pipe.run(collect)
    assert pipe.local_saved_count == 1
    assert pipe.allow_page_stop is False


@pytest.mark.parametrize('total', [1, 2])
async def test_local_count_can_exceed_homepage_total_without_deleting_history(database, tmp_path, total):
    await save_local(database, tmp_path, 1)
    historical = await save_local(database, tmp_path, 2)
    pipe = build(database=database)
    pipe.homepage_total = total
    async def collect():
        assert await pipe.offer_page([item(1)]) is False
    await pipe.run(collect)
    assert pipe.local_saved_count == 2 and pipe.allow_page_stop
    assert historical.exists() and await database.is_downloaded('2')


@pytest.mark.parametrize('hint', [None, 0, 1, '20'])
async def test_missing_or_small_profile_total_does_not_force_repeated_full_walks(database, tmp_path, hint):
    await save_local(database, tmp_path, 1)
    original = build(database=database)
    pipe = PostDownloadPipeline(original.strategy, 'author', {
        'nickname': '作者', 'uid': 'uid', 'aweme_count': hint}, set())
    async def collect():
        assert await pipe.offer_page([item(1)]) is False
    await pipe.run(collect)
    assert pipe.allow_page_stop is True


@pytest.mark.parametrize('gap', [1, 2, 3, 4, 5, 6])
@pytest.mark.parametrize('field', ['_homepage_work_total', 'aweme_count'])
async def test_small_gap_stops_after_missing_work_then_saved_page(database, tmp_path, gap, field):
    await save_local(database, tmp_path, 1)
    original = build(database=database)
    pipe = PostDownloadPipeline(original.strategy, 'author', {
        'nickname': '作者', 'uid': 'uid', field: 1 + gap}, set())
    async def collect():
        # A page with a missing work must continue even inside the tolerance.
        assert await pipe.offer_page([item(2)]) is True
        assert await pipe.offer_page([item(1)]) is False
    await pipe.run(collect)
    assert pipe.allow_page_stop is True


@pytest.mark.parametrize('field', ['_homepage_work_total', 'aweme_count'])
@pytest.mark.parametrize('browser', [False, True])
async def test_first_batch_missing_prefix_and_saved_tail_stop_after_planned_gap_within_five(
        database, tmp_path, field, browser):
    from core.user_modes.post_strategy import PostUserModeStrategy
    # User example: 88/100 saved, 20 fetched, first 9 missing, last 11 saved.
    for key in range(10, 98):
        await save_local(database, tmp_path, key)
    downloader = build(database=database).downloader
    downloader.stream_downloads = True
    downloader._filter_by_time = lambda items: items
    downloader.api_client.get_user_post = AsyncMock()
    downloader.api_client.prefer_browser_posts = browser
    downloader._browser_recovery_unavailable_reason = lambda: None
    strategy = PostUserModeStrategy(downloader)
    strategy.filter_stream_items = lambda page: page
    page = [item(key) for key in range(1, 21)]
    if browser:
        async def recover(_sec, _user, accumulated, **options):
            assert await options['on_items'](page) is False
            accumulated.extend(page)
        downloader._recover_user_post_with_browser = AsyncMock(side_effect=recover)
    else:
        strategy._request_post_page = AsyncMock(return_value={
            'aweme_list': page, 'has_more': 1, 'max_cursor': 10, 'status_code': 0})
    result = await strategy.download_mode('author', {
        'nickname': '作者', 'uid': 'uid', field: 100})
    assert result.total == 20 and result.success == 9 and result.skipped == 11
    assert result.incomplete_reason is None
    assert downloader._process_mode_aweme.await_count == 9
    if not browser:
        strategy._request_post_page.assert_awaited_once()


async def test_missing_prefix_does_not_stop_when_remaining_gap_is_six(database, tmp_path):
    for key in range(10, 98):
        await save_local(database, tmp_path, key)
    pipe = build(database=database)
    pipe.homepage_total = 103
    await pipe.run(lambda: assert_keeps_paging(pipe, [item(key) for key in range(1, 21)]))
    assert pipe.local_saved_count == 88 and not pipe.allow_page_stop


async def test_filtered_missing_items_do_not_reduce_the_remaining_gap(database, tmp_path):
    for key in range(10, 98):
        await save_local(database, tmp_path, key)
    pipe = build(database=database)
    pipe.homepage_total = 100
    pipe.strategy.filter_stream_items = lambda page: [work for work in page if int(work['aweme_id']) > 3]
    await pipe.run(lambda: assert_keeps_paging(pipe, [item(key) for key in range(1, 21)]))
    assert len(pipe.new_ids) == 6 and not pipe.allow_page_stop


@pytest.mark.parametrize('hint', [None, 0, 5])
async def test_no_local_files_still_requires_full_walk(database, hint):
    original = build(database=database)
    pipe = PostDownloadPipeline(original.strategy, 'author', {
        'nickname': '作者', 'uid': 'uid', 'aweme_count': hint}, set())
    await pipe.run(lambda: assert_keeps_paging(pipe, [item(1)]))
    assert pipe.local_saved_count == 0 and not pipe.allow_page_stop


async def test_author_count_excludes_other_authors_missing_media_and_metadata_only_rows(database, tmp_path):
    from core.post_incremental import saved_author_count
    await save_local(database, tmp_path, 1)
    missing = await save_local(database, tmp_path, 2)
    missing.unlink()
    await database.add_aweme({'aweme_id': '3', 'aweme_type': 'video',
                              'author_id': 'uid', 'author_sec_uid': 'author'})
    other = tmp_path / 'other.mp4'
    other.write_bytes(b'other')
    await database.add_aweme({'aweme_id': '4', 'aweme_type': 'video', 'file_path': str(other),
                              'author_id': 'other-uid', 'author_sec_uid': 'other-author'})
    pipe = build(database=database)
    assert await saved_author_count(pipe.downloader, 'author', 'uid') == 1


@pytest.mark.parametrize('browser', [False, True])
async def test_existing_first_page_does_not_hide_a_later_missing_post(database, tmp_path, browser):
    from core.user_modes.post_strategy import PostUserModeStrategy
    await save_local(database, tmp_path, 1)
    downloader = build(database=database).downloader
    downloader.stream_downloads = True
    downloader._filter_by_time = lambda items: items
    downloader.api_client.prefer_browser_posts = browser
    downloader.api_client.get_user_post = AsyncMock()
    downloader._browser_recovery_unavailable_reason = lambda: None
    strategy = PostUserModeStrategy(downloader)
    strategy.filter_stream_items = lambda page: page
    if browser:
        async def recover(_sec, _user, accumulated, **options):
            assert await options['on_items']([item(1)]) is True
            assert await options['on_items']([item(2)]) is True
            accumulated.extend([item(1), item(2)])
        downloader._recover_user_post_with_browser = AsyncMock(side_effect=recover)
    else:
        strategy._request_post_page = AsyncMock(side_effect=[
            {'aweme_list': [item(1)], 'has_more': 1, 'max_cursor': 10, 'status_code': 0},
            {'aweme_list': [item(2)], 'has_more': 0, 'max_cursor': 20, 'status_code': 0}])
    result = await strategy.download_mode('author', {
        'nickname': '作者', 'uid': 'uid', '_homepage_work_total': 7})
    assert result.total == 2 and result.skipped == 1 and result.success == 1
    assert result.incomplete_reason is None
    if not browser:
        assert strategy._request_post_page.await_count == 2
