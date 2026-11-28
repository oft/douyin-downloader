"""One lazily started browser, context and page owned by a download batch."""

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from core.local_media_index import LocalMediaIndexes
from utils.browser_login import prepare_profile, save_browser_login
from utils.browser_runtime import BrowserUnavailableError, chromium_launch_options
from utils.cookie_utils import sanitize_cookies
from utils.logger import setup_logger

logger = setup_logger("BrowserSession")
_AUTH_COOKIES = {"sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss"}


class BrowserSession:
    def __init__(self, *, profile_dir=None, cookie_path=None, save_interval=30):
        self.profile_dir = Path(profile_dir).resolve() if profile_dir else None
        self.cookie_path = Path(cookie_path).resolve() if cookie_path else None
        self.save_interval = save_interval
        self._save_task = None
        self._save_lock = asyncio.Lock()
        self.user_agent = None
        # This is transport evidence for this batch, not a per-author account status.
        self.post_api_requires_browser = False
        self.local_media_indexes = LocalMediaIndexes()
        self._manager = self._runtime = self._browser = self._context = self._page = None
        self._lock = None
        self._closed = False
        self._auth_seed = None
        self._latest_cookies = {}
        self._reset_context = False
        self._options = None

    def cookies_for(self, cookies):
        seed = {key: value for key, value in cookies.items() if key in _AUTH_COOKIES}
        if self._auth_seed is not None and seed != self._auth_seed:
            # Explicit re-login replaces the old account; ordinary profile switches do not.
            self._latest_cookies = {}
            self._reset_context = True
        self._auth_seed = seed
        return {**cookies, **self._latest_cookies}

    def remember_cookies(self, cookies):
        self._latest_cookies.update(sanitize_cookies({
            str(cookie["name"]): str(cookie.get("value") or "")
            for cookie in cookies if cookie.get("name")
        }))

    async def initialize(self):
        if self.profile_dir:
            try:
                raw = await asyncio.to_thread((self.profile_dir / "session-meta.json").read_text)
                agent = json.loads(raw).get("user_agent")
                if isinstance(agent, str) and agent:
                    self.user_agent = agent
            except (OSError, ValueError, AttributeError):
                pass

    async def save_login(self):
        if not self.profile_dir or not self.cookie_path or self._context is None:
            return
        async with self._save_lock:
            try:
                cookies = await save_browser_login(self._context, self.profile_dir,
                                                   self.cookie_path, self.user_agent)
                self._latest_cookies = cookies
            except Exception as error:
                logger.warning("保存浏览器登录状态失败（%s），保留之前的状态", type(error).__name__)

    async def _autosave(self):
        while True:
            await asyncio.sleep(self.save_interval)
            await self.save_login()

    async def release_for_login(self):
        if self._save_task is not None:
            self._save_task.cancel()
            await asyncio.gather(self._save_task, return_exceptions=True)
            self._save_task = None
        await self._dispose()

    async def _dispose_context(self):
        await self.save_login()
        context, self._context, self._page = self._context, None, None
        if context is not None:
            try:
                await context.close()
            except Exception:
                logger.debug("Browser context already closed")

    async def _dispose(self):
        await self._dispose_context()
        browser, self._browser = self._browser, None
        if browser is not None:
            try:
                await browser.close()
            except Exception:
                logger.debug("Browser already closed")
        manager, self._manager, self._runtime = self._manager, None, None
        if manager is not None:
            try:
                await manager.__aexit__(None, None, None)
            except Exception:
                logger.debug("Playwright runtime already closed")

    async def _ensure(self, *, headless, user_agent, cookies, proxy):
        if self._closed:
            raise BrowserUnavailableError("浏览器会话已结束，请重新启动更新。")
        options = (headless, proxy)
        if self._browser is not None:
            connected = getattr(self._browser, "is_connected", None)
            if (callable(connected) and not connected()) or (self._page is not None and self._page.is_closed()):
                raise BrowserUnavailableError("浏览器窗口已关闭，已停止本轮更新；请重新启动更新。")
            if self._options != options:
                await self.release_for_login()
        try:
            if self._browser is None:
                from playwright.async_api import async_playwright

                self._manager = async_playwright()
                self._runtime = await self._manager.__aenter__()
                launch_options = await chromium_launch_options(self._runtime.chromium, headless=headless)
                if proxy:
                    launch_options["proxy"] = {"server": proxy.replace("socks5h://", "socks5://", 1)}
                browser_options = dict(launch_options, headless=headless,
                    args=["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"])
                if self.profile_dir:
                    await asyncio.to_thread(prepare_profile, self.profile_dir)
                    self.user_agent = self.user_agent or user_agent
                    context_options = dict(locale="zh-CN", viewport={"width": 1600, "height": 900})
                    if self.user_agent:
                        context_options["user_agent"] = self.user_agent
                    self._context = await self._runtime.chromium.launch_persistent_context(
                        str(self.profile_dir), **browser_options, **context_options)
                    self._browser = self._context.browser
                    native = await self._context.cookies("https://www.douyin.com")
                    native_values = {item["name"]: item["value"] for item in native}
                    incoming = {item["name"]: item["value"] for item in cookies}
                    same_account = not incoming.get("uid_tt") or not native_values.get("uid_tt") or incoming["uid_tt"] == native_values["uid_tt"]
                    if native_values.get("sessionid") and same_account:
                        self.remember_cookies(native)
                        cookies = [item for item in cookies if item["name"] not in native_values]
                    elif not same_account:
                        await self._context.clear_cookies()
                    if cookies:
                        await self._context.add_cookies(cookies)
                    self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
                    if not self.user_agent:
                        self.user_agent = await self._page.evaluate("navigator.userAgent")
                    self._reset_context = False
                    self._save_task = asyncio.create_task(self._autosave())
                else:
                    self._browser = await self._runtime.chromium.launch(**browser_options)
                self._options = options
            if self._reset_context:
                self._reset_context = False
                if self.profile_dir:
                    await self.release_for_login()
                    return await self._ensure(headless=headless, user_agent=user_agent, cookies=cookies, proxy=proxy)
                await self._dispose_context()
            if self._context is None:
                self.user_agent = self.user_agent or user_agent
                self._context = await self._browser.new_context(
                    user_agent=self.user_agent, locale="zh-CN", viewport={"width": 1600, "height": 900},
                )
                if cookies:
                    await self._context.add_cookies(cookies)
                self._page = await self._context.new_page()
                self._reset_context = False
        except asyncio.CancelledError:
            await self._dispose()
            raise
        except Exception as exc:
            await self._dispose()
            if isinstance(exc, BrowserUnavailableError):
                raise
            raise BrowserUnavailableError(
                "浏览器启动失败（{}），请检查浏览器安装及运行权限；已停止本轮更新。".format(type(exc).__name__)
            ) from exc

    @asynccontextmanager
    async def page(self, *, headless, user_agent, cookies, proxy=""):
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            await self._ensure(headless=headless, user_agent=user_agent, cookies=cookies, proxy=proxy)
            yield self._context, self._page
            await self.save_login()

    async def close(self):
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            self._closed = True
        await self.release_for_login()
