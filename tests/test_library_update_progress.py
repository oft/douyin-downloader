import asyncio
import importlib.util
import io
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "library-server" / "scripts" / "update_progress.py"
spec = importlib.util.spec_from_file_location("library_update_progress", SCRIPT)
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)


def result(success=0, failed=0, skipped=0):
    return SimpleNamespace(success=success, failed=failed, skipped=skipped)


def test_batch_counts_do_not_double_count_live_events_and_results():
    events = []
    reporter = progress.LibraryProgressDisplay(events.append)
    reporter.start_download_session(2)
    reporter.start_url(1, 2, "https://www.douyin.com/user/first?secret=hidden")
    reporter.on_author(nickname="第一位作者")
    reporter.set_item_total(3)
    for status in ["success", "failed", "skipped"]:
        reporter.advance_item(status)
    reporter.complete_url(result(success=1, failed=1, skipped=1))
    reporter.start_url(2, 2, "https://www.douyin.com/user/second")
    reporter.on_author(nickname="第二位作者")
    reporter.set_item_total(2)
    reporter.advance_item("success")
    reporter.advance_item("success")
    reporter.complete_url(result(success=2))
    reporter.stop_download_session()

    assert events[-1]["completedUrls"] == events[-1]["totalUrls"] == 2
    assert (events[-1]["success"], events[-1]["failed"], events[-1]["skipped"]) == (3, 1, 1)
    assert events[-1]["author"] == "第二位作者"
    assert "hidden" not in json.dumps(events)


def test_retry_rolls_back_only_current_attempt_and_cancellation_keeps_partial_progress():
    events = []
    reporter = progress.LibraryProgressDisplay(events.append)
    reporter.start_download_session(3)
    reporter.start_url(1, 3, "first")
    reporter.complete_url(result(success=2))
    reporter.start_url(2, 3, "second")
    reporter.set_item_total(4)
    reporter.advance_item("failed")
    reporter.rollback_url_item_reasons()
    reporter.set_item_total(4)
    reporter.advance_item("success")
    reporter.stop_download_session()

    assert events[-1]["completedUrls"] == 1
    assert events[-1]["success"] == 3
    assert events[-1]["failed"] == 0
    assert events[-1]["itemsCompleted"] == 1


def test_partial_listing_remains_visible_after_download_completion():
    events = []
    reporter = progress.LibraryProgressDisplay(events.append)
    reporter.start_download_session(1)
    reporter.start_url(1, 1, "https://www.douyin.com/user/test")
    outcome = result(success=54)
    outcome.incomplete_reason = "作品列表可能未取全：页面未确认分页结束"
    reporter.complete_url(outcome)
    reporter.stop_download_session()
    assert events[-1]["step"] == "列表未取全"
    assert events[-1]["message"] == outcome.incomplete_reason
    assert events[-1]["detail"] == outcome.incomplete_reason
    assert events[-1]["success"] == 54


def test_streaming_totals_grow_without_resetting_completed_downloads():
    events = []
    reporter = progress.LibraryProgressDisplay(events.append)
    reporter.start_url(1, 1, "https://www.douyin.com/user/test")
    reporter.on_stream_progress(discovered=2, queued=1, active=1, listing_state="collecting")
    reporter.advance_item("success")
    reporter.on_stream_progress(discovered=5, queued=3, active=1, listing_state="collecting")
    reporter.stop_download_session()
    assert events[-1]["itemsCompleted"] == 1
    assert events[-1]["itemsTotal"] == 5
    assert events[-1]["streaming"] is True
    assert events[-1]["queuedItems"] == 3
    reporter.set_item_total(7)
    assert events[-1]["streaming"] is False
    assert events[-1]["itemsCompleted"] == 0


@pytest.mark.asyncio
async def test_progress_pipe_delivers_final_json_snapshot():
    stream = io.StringIO()
    pipe = progress.ProgressPipe(stream)
    for value in range(100):
        pipe.send({"completedUrls": value})
    await pipe.close()
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert events[-1] == {"type": "progress", "version": 1, "progress": {"completedUrls": 99}}
    assert not pipe.thread.is_alive()


@pytest.mark.asyncio
async def test_slow_progress_reader_cannot_block_download_callbacks():
    writing = threading.Event()
    release = threading.Event()

    class SlowStream:
        def write(self, _value):
            writing.set()
            release.wait(3)

        def flush(self):
            pass

    pipe = progress.ProgressPipe(SlowStream())
    pipe.send({"value": 0})
    try:
        assert await asyncio.to_thread(writing.wait, 1)
        started = time.monotonic()
        for value in range(10000):
            pipe.send({"value": value})
        await asyncio.sleep(0)
        assert time.monotonic() - started < 0.5
        assert pipe.pending.qsize() <= 1
    finally:
        release.set()
        await pipe.close()
