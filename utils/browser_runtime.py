"""Select an installed Chromium runtime without relying on stale cache revisions."""

import asyncio
import os
import shlex
import shutil
import sys
from pathlib import Path


class BrowserUnavailableError(RuntimeError):
    """The browser environment cannot run; retrying every profile will not help."""


def _system_browser_channels():
    if sys.platform == "darwin":
        return [
            (channel, root / app / "Contents" / "MacOS" / executable)
            for root in [Path("/Applications")]
            for channel, app, executable in [
                ("chrome", "Google Chrome.app", "Google Chrome"),
                ("msedge", "Microsoft Edge.app", "Microsoft Edge"),
            ]
        ]
    if sys.platform == "win32":
        return [
            (channel, Path(root) / relative)
            for root in [os.environ.get(key) for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
            if root
            for channel, relative in [
                ("chrome", "Google/Chrome/Application/chrome.exe"),
                ("msedge", "Microsoft/Edge/Application/msedge.exe"),
            ]
        ]
    return [(channel, Path(executable))
            for channel, names in [("chrome", ("google-chrome", "google-chrome-stable")),
                                   ("msedge", ("microsoft-edge", "microsoft-edge-stable"))]
            for name in names for executable in [shutil.which(name)] if executable]


def _select_chromium(executable, headless):
    if Path(executable).is_file():
        # Use the full binary in headless mode too, without requiring a separate shell.
        return {"channel": "chromium"} if headless else {}
    for channel, candidate in _system_browser_channels():
        if candidate.is_file():
            return {"channel": channel}
    command = "{} -m playwright install chromium".format(shlex.quote(sys.executable))
    raise BrowserUnavailableError(
        "浏览器未就绪：缺少当前 Playwright 对应的 Chromium，也没有找到系统 Chrome/Edge。"
        "请运行 {}。预期浏览器路径：{}".format(command, executable)
    )


async def chromium_launch_options(chromium, *, headless=False):
    executable = getattr(chromium, "executable_path", "")
    if not isinstance(executable, str) or not executable:
        # Custom browser backends may manage their own executable selection.
        return {}
    return await asyncio.to_thread(_select_chromium, executable, headless)


async def check_browser_runtime(*, headless=False):
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise BrowserUnavailableError(
            "浏览器回补需要 Playwright。请在当前 Python 环境安装 playwright，并运行 python -m playwright install chromium。"
        ) from exc
    try:
        async with async_playwright() as runtime:
            options = await chromium_launch_options(runtime.chromium, headless=headless)
    except BrowserUnavailableError:
        raise
    except Exception as exc:
        raise BrowserUnavailableError(
            "浏览器环境检查失败（{}），请检查 Playwright 安装及运行权限。".format(type(exc).__name__)
        ) from exc
    return {"chrome": "系统 Google Chrome", "msedge": "系统 Microsoft Edge"}.get(
        options.get("channel"), "Playwright Chromium"
    )
