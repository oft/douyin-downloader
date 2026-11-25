"""fetch_cookies builds the right Namespace and delegates to capture_cookies."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

import tools.cookie_fetcher as cf


@pytest.mark.asyncio
async def test_fetch_cookies_delegates(monkeypatch):
    seen = {}

    async def fake_capture(args):
        seen["args"] = args
        return 0

    monkeypatch.setattr(cf, "capture_cookies", fake_capture)

    rc = await cf.fetch_cookies(output=Path("/tmp/x/cookies.json"))

    assert rc == 0
    args = seen["args"]
    assert args.output == Path("/tmp/x/cookies.json")
    assert args.browser == "chromium"
    assert args.headless is False
    assert args.include_all is False
    assert args.url == cf.DEFAULT_URL
    assert args.config is None


async def test_manual_capture_reads_cookie_jar_without_storage_export(tmp_path, monkeypatch):
    page = SimpleNamespace(on=Mock())
    context = SimpleNamespace(
        new_page=AsyncMock(return_value=page), close=AsyncMock(),
        storage_state=AsyncMock(side_effect=AssertionError("must not export storage")),
        cookies=AsyncMock(return_value=[
            {"name": "sessionid", "value": "fresh", "domain": ".douyin.com"},
            {"name": "msToken", "value": "token", "domain": "www.douyin.com"},
            {"name": "other", "value": "excluded", "domain": "notdouyin.com"},
        ]),
    )
    browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
    runtime = SimpleNamespace(firefox=SimpleNamespace(launch=AsyncMock(return_value=browser)))

    class Manager:
        async def __aenter__(self):
            return runtime

        async def __aexit__(self, *args):
            pass

    monkeypatch.setitem(sys.modules, "playwright.async_api", SimpleNamespace(async_playwright=Manager))
    monkeypatch.setattr(cf, "wait_for_login_confirmation", AsyncMock())
    monkeypatch.setattr(cf, "try_extract_ms_token", AsyncMock(return_value="token"))
    output = tmp_path / "cookies.json"
    assert await cf.fetch_cookies(output=output, browser="firefox", include_all=True) == 0
    assert json.loads(output.read_text()) == {"sessionid": "fresh", "msToken": "token"}
    context.cookies.assert_awaited_once_with()
    context.storage_state.assert_not_called()
    context.close.assert_awaited_once()
    browser.close.assert_awaited_once()
