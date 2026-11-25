import asyncio
import sys
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest

from core.api_client import DouyinAPIClient, UserUnavailableError
from core.browser_session import BrowserSession
from utils.browser_runtime import BrowserUnavailableError


class Page:
    def __init__(self):
        self.url = "about:blank"
        self.handlers = []
        self.previous = None
        self.mouse = SimpleNamespace(wheel=self.wait_for_timeout)
        self.cancel_target = None
        self.entered = asyncio.Event()

    def on(self, event, callback):
        assert event == "response"
        self.handlers.append(callback)

    def remove_listener(self, event, callback):
        self.handlers.remove(callback)

    async def goto(self, url, **_kwargs):
        uid = urlsplit(url).path.rsplit("/", 1)[-1]
        self.url = url
        if uid == self.cancel_target:
            self.entered.set()
            await asyncio.Event().wait()
        for response_uid in [self.previous, uid]:
            if not response_uid:
                continue

            async def data(value=response_uid):
                return {"aweme_list": [{"aweme_id": "work-" + value}]}

            response = SimpleNamespace(
                url="https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=" + response_uid,
                json=data,
            )
            for callback in self.handlers:
                callback(response)
        self.previous = uid

    async def title(self):
        return "抖音"

    def is_closed(self):
        return False

    async def evaluate(self, _script, messages=None):
        if messages is not None:
            return "用户不存在" if self.url.endswith("/missing") else ""
        return []

    async def wait_for_timeout(self, *_args):
        await asyncio.sleep(0)


class Context:
    def __init__(self):
        self.page = Page()
        self.cookie_seeds = []
        self.closed = 0
        self.pages_created = 0

    async def add_cookies(self, cookies):
        self.cookie_seeds.append(cookies)

    async def new_page(self):
        self.pages_created += 1
        return self.page

    async def cookies(self, _url):
        return [{"name": "sessionid", "value": "browser-refreshed"}]

    async def close(self):
        self.closed += 1


@pytest.fixture
def runtime(monkeypatch):
    state = SimpleNamespace(launches=0, contexts=[], closed=0, entered=0, exited=0, connected=True)

    async def new_context(**_kwargs):
        context = Context()
        state.contexts.append(context)
        return context

    async def close():
        state.closed += 1
        state.connected = False

    async def launch(**_kwargs):
        state.launches += 1
        return SimpleNamespace(new_context=new_context, close=close, is_connected=lambda: state.connected)

    class Manager:
        async def __aenter__(self):
            state.entered += 1
            return SimpleNamespace(chromium=SimpleNamespace(launch=launch))

        async def __aexit__(self, *_args):
            state.exited += 1

    monkeypatch.setitem(sys.modules, "playwright.async_api", SimpleNamespace(async_playwright=Manager))
    return state


def client(session, cookie="configured-session"):
    api = DouyinAPIClient({"sessionid": cookie}, browser_session=session)
    api._BROWSER_COOKIE_BLOCKLIST = set()
    return api


async def collect(api, uid):
    return await api.collect_user_post_ids_via_browser(uid, expected_count=1, max_scrolls=1)


@pytest.mark.asyncio
async def test_two_api_clients_share_one_browser_context_page_and_fresh_cookies(runtime):
    session = BrowserSession()
    first = client(session)
    assert await collect(first, "first") == ["work-first"]
    await first.close()
    assert runtime.closed == 0, "closing an API client must not close the batch browser"
    second = client(session)
    assert second.cookies["sessionid"] == "browser-refreshed"
    assert second.headers["User-Agent"] == first.headers["User-Agent"]
    assert await collect(second, "second") == ["work-second"]
    assert (runtime.launches, len(runtime.contexts), runtime.contexts[0].pages_created) == (1, 1, 1)
    assert len(runtime.contexts[0].cookie_seeds) == 1
    assert runtime.contexts[0].page.handlers == []
    await session.close()
    await session.close()
    assert runtime.closed == runtime.exited == runtime.contexts[0].closed == 1


@pytest.mark.asyncio
async def test_missing_user_does_not_destroy_browser_for_next_profile(runtime):
    session = BrowserSession()
    with pytest.raises(UserUnavailableError):
        await collect(client(session), "missing")
    assert runtime.closed == 0
    assert await collect(client(session), "second") == ["work-second"]
    assert runtime.launches == 1
    assert runtime.contexts[0].page.handlers == []
    await session.close()


@pytest.mark.asyncio
async def test_cancellation_removes_listeners_and_allows_batch_cleanup(runtime):
    session = BrowserSession()
    await collect(client(session), "first")
    page = runtime.contexts[0].page
    page.cancel_target = "waiting"
    task = asyncio.create_task(collect(client(session), "waiting"))
    await page.entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await session.close()
    assert page.handlers == []
    assert runtime.closed == runtime.exited == runtime.contexts[0].closed == 1


@pytest.mark.asyncio
async def test_explicit_relogin_replaces_context_but_keeps_browser(runtime):
    session = BrowserSession()
    await collect(client(session), "first")
    await collect(client(session, cookie="new-login"), "second")
    assert runtime.launches == 1
    assert len(runtime.contexts) == 2
    assert runtime.contexts[0].closed == 1
    await session.close()


@pytest.mark.asyncio
async def test_closed_window_stops_instead_of_reopening_for_every_profile(runtime):
    session = BrowserSession()
    await collect(client(session), "first")
    runtime.connected = False
    with pytest.raises(BrowserUnavailableError, match="窗口已关闭"):
        await collect(client(session), "second")
    assert runtime.launches == 1
    await session.close()


@pytest.mark.asyncio
async def test_failed_navigation_never_collects_previous_author_page(runtime, monkeypatch):
    session = BrowserSession()
    await collect(client(session), "first")

    async def failed_navigation(*_args, **_kwargs):
        raise RuntimeError("navigation failed before committing the new page")

    monkeypatch.setattr(runtime.contexts[0].page, "goto", failed_navigation)
    assert await collect(client(session), "second") == []
    assert runtime.contexts[0].page.handlers == []
    assert runtime.launches == 1
    await session.close()


@pytest.mark.asyncio
async def test_concurrent_profiles_serialize_access_to_the_shared_page(runtime):
    session = BrowserSession()
    results = await asyncio.gather(collect(client(session), "first"), collect(client(session), "second"))
    assert results == [["work-first"], ["work-second"]]
    assert runtime.launches == 1
    assert runtime.contexts[0].pages_created == 1
    assert runtime.contexts[0].page.handlers == []
    await session.close()
