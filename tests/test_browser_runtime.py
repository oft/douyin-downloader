import sys
from types import SimpleNamespace

import pytest

from utils import browser_runtime
from utils.browser_runtime import BrowserUnavailableError, chromium_launch_options


@pytest.mark.asyncio
async def test_installed_playwright_binary_takes_precedence(tmp_path, monkeypatch):
    executable = tmp_path / "chromium"
    executable.touch()
    monkeypatch.setattr(browser_runtime, "_system_browser_channels", lambda: pytest.fail("not needed"))
    chromium = SimpleNamespace(executable_path=str(executable))
    assert await chromium_launch_options(chromium) == {}
    assert await chromium_launch_options(chromium, headless=True) == {"channel": "chromium"}


@pytest.mark.asyncio
async def test_missing_playwright_revision_uses_installed_system_channel(tmp_path, monkeypatch):
    executable = tmp_path / "system-chrome"
    executable.touch()
    monkeypatch.setattr(browser_runtime, "_system_browser_channels", lambda: [("chrome", executable)])
    chromium = SimpleNamespace(executable_path=str(tmp_path / "missing-chromium"))
    assert await chromium_launch_options(chromium) == {"channel": "chrome"}


@pytest.mark.asyncio
async def test_missing_browser_has_actionable_environment_error(tmp_path, monkeypatch):
    monkeypatch.setattr(browser_runtime, "_system_browser_channels", lambda: [])
    chromium = SimpleNamespace(executable_path=str(tmp_path / "missing-chromium"))
    with pytest.raises(BrowserUnavailableError, match="playwright install chromium"):
        await chromium_launch_options(chromium)


@pytest.mark.asyncio
async def test_missing_playwright_is_reported_before_download(monkeypatch):
    monkeypatch.setitem(sys.modules, "playwright.async_api", None)
    with pytest.raises(BrowserUnavailableError, match="需要 Playwright"):
        await browser_runtime.check_browser_runtime()
