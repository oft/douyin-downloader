"""主页明确的账号状态应优先于之前的接口安全校验错误。"""

import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from core.api_client import DouyinAPIClient, UserUnavailableError
from utils.browser_runtime import BrowserUnavailableError


@pytest.mark.parametrize("reason", ["用户不存在", "账号已注销", "该账号已被封禁", "私密账号"])
@pytest.mark.asyncio
async def test_browser_unavailable_state_stops_collection_and_closes_browser(monkeypatch, reason):
    page = SimpleNamespace(
        on=Mock(),
        goto=AsyncMock(),
        title=AsyncMock(return_value="抖音"),
        is_closed=Mock(return_value=False),
        evaluate=AsyncMock(return_value=reason),
        wait_for_timeout=AsyncMock(),
        mouse=SimpleNamespace(wheel=AsyncMock()),
    )
    context = SimpleNamespace(
        add_cookies=AsyncMock(),
        new_page=AsyncMock(return_value=page),
        cookies=AsyncMock(return_value=[]),
        close=AsyncMock(),
    )
    browser = SimpleNamespace(new_context=AsyncMock(return_value=context), close=AsyncMock())
    runtime = SimpleNamespace(chromium=SimpleNamespace(launch=AsyncMock(return_value=browser)))
    manager = AsyncMock()
    manager.__aenter__.return_value = runtime
    monkeypatch.setitem(
        sys.modules, "playwright.async_api", SimpleNamespace(async_playwright=lambda: manager)
    )
    client = DouyinAPIClient({})

    with pytest.raises(UserUnavailableError, match=reason):
        await client.collect_user_post_ids_via_browser("missing-user")

    page.mouse.wheel.assert_not_awaited()
    page.wait_for_timeout.assert_not_awaited()
    context.close.assert_awaited_once()
    browser.close.assert_awaited_once()


@pytest.mark.parametrize(
    "state", ["", None, [], "请完成安全验证", "用户未登录", "该账号已被禁止关注"]
)
@pytest.mark.asyncio
async def test_uncertain_page_is_not_classified_as_unavailable(state):
    client = DouyinAPIClient({})
    await client._check_browser_user_available(
        SimpleNamespace(evaluate=AsyncMock(return_value=state))
    )


@pytest.mark.asyncio
async def test_page_read_failure_is_not_classified_as_unavailable():
    client = DouyinAPIClient({})
    await client._check_browser_user_available(
        SimpleNamespace(evaluate=AsyncMock(side_effect=RuntimeError("page closed")))
    )


@pytest.mark.asyncio
async def test_browser_launch_failure_surfaces_as_environment_failure(monkeypatch):
    launch = AsyncMock(side_effect=RuntimeError("launch denied"))
    manager = AsyncMock()
    manager.__aenter__.return_value = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
    monkeypatch.setitem(
        sys.modules, "playwright.async_api", SimpleNamespace(async_playwright=lambda: manager)
    )
    client = DouyinAPIClient({})
    with pytest.raises(BrowserUnavailableError, match="浏览器启动失败"):
        await client.collect_user_post_ids_via_browser("normal-user")
    launch.assert_awaited_once()
