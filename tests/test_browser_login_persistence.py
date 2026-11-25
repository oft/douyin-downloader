import asyncio
import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from core.browser_session import BrowserSession
from utils.browser_login import private_json, save_browser_login


def state(value="fresh"):
    return {"cookies": [{"name": "sessionid", "value": value, "domain": ".douyin.com"}],
            "origins": [{"origin": "https://www.douyin.com", "localStorage": [
                {"name": "remember-login", "value": "true"}], "indexedDB": [{"name": "login"}]}]}


async def test_save_updates_cookies_without_exporting_or_changing_native_login_storage(tmp_path):
    profile = tmp_path / "config/browser-profile"
    profile.mkdir(parents=True)
    native_storage = profile / "native-storage-canary"
    native_storage.write_bytes(b"remember-login and IndexedDB are owned by Chrome")
    cookies = tmp_path / "config/cookies.json"
    context = SimpleNamespace(
        storage_state=AsyncMock(side_effect=AssertionError("must not export storage")),
        new_page=AsyncMock(side_effect=AssertionError("must not open a page")),
        cookies=AsyncMock(return_value=state()["cookies"]),
    )
    await save_browser_login(context, profile, cookies, "stable-agent")
    assert json.loads(cookies.read_text()) == {"sessionid": "fresh"}
    assert json.loads((profile / "session-meta.json").read_text()) == {
        "user_agent": "stable-agent"}
    assert native_storage.read_bytes() == b"remember-login and IndexedDB are owned by Chrome"
    assert not (profile.parent / "browser-state.json").exists()
    context.storage_state.assert_not_called()
    context.new_page.assert_not_called()
    context.cookies.assert_awaited_once_with("https://www.douyin.com/")
    if os.name != "nt":
        assert cookies.stat().st_mode & 0o777 == 0o600
        assert (profile / "session-meta.json").stat().st_mode & 0o777 == 0o600


async def test_save_only_exports_douyin_cookies(tmp_path):
    context = SimpleNamespace(cookies=AsyncMock(return_value=[
        {"name": "sessionid", "value": "fresh", "domain": ".douyin.com"},
        {"name": "www-cookie", "value": "fresh-www", "domain": "www.douyin.com"},
        {"name": "other", "value": "excluded", "domain": "notdouyin.com"},
    ]))
    path = tmp_path / "cookies.json"
    await save_browser_login(context, tmp_path / "profile", path, "agent")
    assert json.loads(path.read_text()) == {"sessionid": "fresh", "www-cookie": "fresh-www"}


async def test_capture_failure_does_not_replace_previous_cookies(tmp_path):
    path = tmp_path / "cookies.json"
    private_json(path, {"sessionid": "previous"})
    context = SimpleNamespace(cookies=AsyncMock(side_effect=RuntimeError("closed")))
    with pytest.raises(RuntimeError):
        await save_browser_login(context, tmp_path / "profile", path, "agent")
    assert json.loads(path.read_text())["sessionid"] == "previous"


@pytest.fixture
def persistent_runtime(monkeypatch):
    browser = SimpleNamespace(is_connected=Mock(return_value=True), close=AsyncMock())
    page = SimpleNamespace(is_closed=Mock(return_value=False), evaluate=AsyncMock(return_value="native-agent"),
        goto=AsyncMock(), reload=AsyncMock(), bring_to_front=AsyncMock())
    context = SimpleNamespace(browser=browser, pages=[page], cookies=AsyncMock(return_value=state()["cookies"]),
        storage_state=AsyncMock(side_effect=AssertionError("must not export storage")),
        new_page=AsyncMock(side_effect=AssertionError("must not open a page")),
        add_cookies=AsyncMock(), close=AsyncMock(), clear_cookies=AsyncMock())
    launch = AsyncMock(return_value=context)
    runtime = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
    manager = SimpleNamespace(__aenter__=AsyncMock(return_value=runtime), __aexit__=AsyncMock())
    class Manager:
        async def __aenter__(self): return await manager.__aenter__()
        async def __aexit__(self, *args): return await manager.__aexit__(*args)
    monkeypatch.setitem(sys.modules, "playwright.async_api", SimpleNamespace(async_playwright=Manager))
    monkeypatch.setattr("core.browser_session.chromium_launch_options", AsyncMock(return_value={}))
    return launch, context


async def test_next_session_reuses_same_profile_agent_and_fresh_native_cookie(tmp_path, persistent_runtime):
    launch, context = persistent_runtime
    profile, cookies = tmp_path / "profile", tmp_path / "cookies.json"
    first = BrowserSession(profile_dir=profile, cookie_path=cookies)
    await first.initialize()
    async with first.page(headless=False, user_agent="stable-agent", cookies=[
            {"name": "sessionid", "value": "stale", "url": "https://www.douyin.com/"}]):
        pass
    await first.close()
    context.add_cookies.assert_not_awaited()  # Preserve the fresher native cookie and its expiry.
    second = BrowserSession(profile_dir=profile, cookie_path=cookies)
    await second.initialize()
    async with second.page(headless=False, user_agent="different-agent", cookies=[]):
        pass
    await second.close()
    assert all(call.args[0] == str(profile.resolve()) for call in launch.call_args_list)
    assert all(call.kwargs["user_agent"] == "stable-agent" for call in launch.call_args_list)
    assert json.loads(cookies.read_text())["sessionid"] == "fresh"
    if os.name != "nt":
        assert profile.stat().st_mode & 0o777 == 0o700


async def test_repeated_autosaves_never_open_tabs_or_disturb_login_page(tmp_path, persistent_runtime):
    _launch, context = persistent_runtime
    saved = asyncio.Event()
    refreshed = state("refreshed-after-scan")["cookies"]
    async def read_cookies(_url):
        if context.cookies.await_count >= 3:
            saved.set()
        return refreshed
    session = BrowserSession(profile_dir=tmp_path / "profile", cookie_path=tmp_path / "cookies.json", save_interval=0.01)
    async with session.page(headless=False, user_agent="agent", cookies=[]):
        context.cookies.reset_mock()
        context.cookies.side_effect = read_cookies
        await asyncio.wait_for(saved.wait(), 1)
    await session.close()
    assert json.loads((tmp_path / "cookies.json").read_text()) == {
        "sessionid": "refreshed-after-scan"}
    context.storage_state.assert_not_called()
    context.new_page.assert_not_called()
    page = context.pages[0]
    for action in (page.goto, page.reload, page.bring_to_front, page.evaluate):
        action.assert_not_called()
    assert len(context.pages) == 1
    assert session._save_task is None
