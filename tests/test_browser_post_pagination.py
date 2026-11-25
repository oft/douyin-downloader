"""Replay asynchronous page responses without launching a browser or making requests."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from core.api_client import DouyinAPIClient


class Page:
    def __init__(self, pages):
        self.pages = list(pages)
        self.handlers = []
        self.url = "about:blank"
        self.waits = 0

    def on(self, _event, callback):
        self.handlers.append(callback)

    def remove_listener(self, _event, callback):
        self.handlers.remove(callback)

    async def emit_page(self):
        if self.pages:
            data = self.pages.pop(0)
            async def response_json():
                return data
            response = SimpleNamespace(
                url="https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=test",
                json=response_json)
            for handler in self.handlers:
                handler(response)
        await asyncio.sleep(0)

    async def goto(self, url, **_kwargs):
        self.url = url
        await self.emit_page()

    async def title(self):
        return "抖音"

    def is_closed(self):
        return False

    async def wait_for_timeout(self, _ms):
        self.waits += 1
        await self.emit_page()


def post_page(index, has_more=1, count=18):
    return {"status_code": 0, "has_more": has_more,
            "aweme_list": [{"aweme_id": str(index * count + i)} for i in range(count)]}


@pytest.fixture
def collector(monkeypatch):
    def build(pages):
        client = DouyinAPIClient({})
        page = Page(pages)
        context = SimpleNamespace(cookies=AsyncMock(return_value=[]))
        @asynccontextmanager
        async def browser_page(**_kwargs):
            yield context, page
        monkeypatch.setattr(client, "_browser_page", browser_page)
        monkeypatch.setattr(client, "_extract_aweme_ids_from_page", AsyncMock(return_value=[]))
        monkeypatch.setattr(client, "_scroll_user_post_page", AsyncMock())
        return client, page
    return build


async def test_response_growth_during_wait_does_not_count_as_idle(collector):
    client, page = collector([post_page(i, has_more=int(i < 11)) for i in range(12)])
    ids = await client.collect_user_post_ids_via_browser("test", idle_rounds=8)
    assert len(ids) == 216 and page.waits == 11
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is True and stats["stop_reason"] == "end_of_list"
    assert stats["post_pages"] == 12 and page.handlers == []


async def test_stall_with_more_pages_is_incomplete_not_success(collector):
    client, page = collector([post_page(0)] * 20)
    ids = await client.collect_user_post_ids_via_browser("test", idle_rounds=3)
    assert len(ids) == 18 and page.waits == 3
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is False and stats["has_more"] is True
    assert stats["stop_reason"] == "idle"


async def test_scroll_cap_with_54_works_is_not_end_of_list(collector):
    client, _page = collector([post_page(i) for i in range(10)])
    ids = await client.collect_user_post_ids_via_browser("test", max_scrolls=2)
    assert len(ids) == 54
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is False and stats["stop_reason"] == "max_scrolls"


async def test_configured_number_limit_is_an_intentional_stop(collector):
    client, _page = collector([post_page(i) for i in range(10)])
    ids = await client.collect_user_post_ids_via_browser("test", expected_count=36)
    assert len(ids) == 36
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is True and stats["stop_reason"] == "number_limit"


async def test_missing_pagination_end_flag_never_confirms_completion(collector):
    data = post_page(0)
    del data["has_more"]
    client, _page = collector([data])
    await client.collect_user_post_ids_via_browser("test", idle_rounds=2)
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is False and stats["has_more"] is None


async def test_interrupted_scrolling_retains_partial_results(collector):
    client, _page = collector([post_page(0)])
    client._scroll_user_post_page.side_effect = RuntimeError("page interrupted")
    ids = await client.collect_user_post_ids_via_browser("test")
    assert len(ids) == 18
    stats = client.pop_browser_post_stats()
    assert stats["complete"] is False and stats["stop_reason"] == "interrupted"


async def test_streaming_delivers_each_page_and_applies_backpressure_before_scroll(collector):
    client, page = collector([post_page(i, has_more=int(i < 3)) for i in range(4)])
    entered, release = asyncio.Event(), asyncio.Event()
    batches = []
    async def deliver(items):
        batches.append(items)
        if len(batches) == 1:
            entered.set()
            await release.wait()
        return True
    task = asyncio.create_task(client.collect_user_post_ids_via_browser("test", on_items=deliver))
    await asyncio.wait_for(entered.wait(), 1)
    assert page.waits == 0
    client._scroll_user_post_page.assert_not_awaited()
    release.set()
    ids = await asyncio.wait_for(task, 1)
    assert len(ids) == 72 and len(batches) == 4
    assert client.pop_browser_post_aweme_items() == {}  # Details are handed off, not retained.
    assert client.pop_browser_post_stats()["complete"] is True


async def test_streaming_cancellation_cancels_blocked_page_delivery(collector):
    client, page = collector([post_page(0)])
    entered, stopped = asyncio.Event(), asyncio.Event()
    async def deliver(_items):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()
    task = asyncio.create_task(client.collect_user_post_ids_via_browser("test", on_items=deliver))
    await asyncio.wait_for(entered.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert stopped.is_set() and page.handlers == []


async def test_streaming_sink_can_stop_after_filtered_number_limit(collector):
    client, page = collector([post_page(i) for i in range(10)])
    delivered = []
    async def deliver(items):
        delivered.extend(items)
        return False
    await client.collect_user_post_ids_via_browser("test", on_items=deliver)
    assert len(delivered) == 18 and page.waits == 0
    assert client.pop_browser_post_stats()["stop_reason"] == "number_limit"


async def test_streaming_storage_errors_propagate_and_remove_response_listener(collector):
    client, page = collector([post_page(0)])
    async def deliver(_items):
        raise OSError("disk full")
    with pytest.raises(OSError):
        await client.collect_user_post_ids_via_browser("test", on_items=deliver)
    assert page.handlers == []
