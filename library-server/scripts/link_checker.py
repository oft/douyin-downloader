"""Read-only page checks; HTTP errors and verification are never proof of invalidity."""

import asyncio
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from core.api_client import DouyinAPIClient, UserUnavailableError
from core.browser_session import BrowserSession
from core.url_parser import URLParser

_HOSTS = {"douyin.com", "www.douyin.com", "v.douyin.com", "v.iesdouyin.com",
          "iesdouyin.com", "www.iesdouyin.com", "live.douyin.com"}
_CHECK_TIMEOUT_SECONDS = 30
_STATE_SCRIPT = """() => {
    const visible = e => e && e.getClientRects().length &&
        getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0';
    const title = document.title || '';
    if (/验证码|安全验证|验证后继续/.test(title)) return {verification: true};
    const challenges = ['安全验证', '验证后继续', '请完成验证后继续', '拖动滑块完成拼图'];
    if ([...document.querySelectorAll('main *, [role="main"] *, body div, body p')].some(e =>
        !e.children.length && visible(e) && !e.closest('[data-e2e="user-info"], a, button') &&
        challenges.includes((e.innerText || '').trim()))) return {verification: true};
    const profile = document.querySelector('[data-e2e="user-info"]');
    if (visible(profile) && document.readyState === 'complete') {
        const name = profile.querySelector('[data-e2e="user-title"], h1');
        const text = profile.innerText || '';
        const named = visible(name) && (name.innerText || '').trim() && !/加载中|loading/i.test(name.innerText);
        const counts = ['关注', '粉丝', '获赞'].every(word => text.includes(word)) && /[0-9]/.test(text);
        if (named || counts) return {profile: true};
    }
    return {};
}"""


def checked_result(link, status, reason, code=None):
    result = {"link": link, "status": status, "reason": reason,
              "checkedAt": datetime.now(timezone.utc).isoformat()}
    if code:
        result["code"] = code
    return result


def access_error_result(link, error, *, navigation=False):
    # Playwright errors can contain signed URLs and call logs. Keep only a safe code/type.
    network = re.search(r"\bnet::(ERR_[A-Z0-9_]+)\b", str(error))
    kind = type(error).__name__
    if network:
        reason = "页面访问失败（{}），暂不能确认链接是否有效".format(network.group(0))
    elif "Timeout" in kind:
        reason = "页面加载超时（20秒），暂不能确认链接是否有效" if navigation else "检测超时，暂不能确认链接是否有效"
    else:
        safe_kind = re.sub(r"[^a-zA-Z0-9_]", "", kind)[:60] or "Error"
        reason = "{}（{}），暂不能确认链接是否有效".format(
            "页面访问失败" if navigation else "页面检测异常", safe_kind)
    return checked_result(link, "unknown", reason, "access_error")


async def check_links(checker, links, emit, *, sleep=asyncio.sleep, clock=time.monotonic):
    """Pace navigation starts and stop a broken session before scanning the whole list."""
    failures = 0
    for index, link in enumerate(links):
        started = clock()
        emit("link-check-current", link=link)
        result = await checker.check(link)
        emit("link-check-result", result=result)
        code = result.get("code")
        if code == "verification":
            emit("link-check-error", message="遇到安全验证或限流，已停止本轮检测；其余链接未检测，请处理验证或稍后重试。")
            return 3
        failures = failures + 1 if code == "access_error" else 0
        if failures >= 3:
            emit("link-check-error", message="连续3条链接访问异常，已停止本轮检测；其余链接未检测。请检查网络或显示检测浏览器查看页面，稍后重试。")
            return 3
        if index + 1 < len(links):
            # These intervals are conservative pacing, not a claimed platform limit.
            interval = 10 * (2 ** (failures - 1)) if failures else 5
            await sleep(max(0, interval - (clock() - started)))
    return 0


def allowed_url(value):
    try:
        url = urlsplit(value)
        return (url.scheme in {"http", "https"} and url.hostname in _HOSTS
                and not url.username and not url.password and url.port in {None, 80, 443})
    except ValueError:
        return False


def link_url(value):
    for candidate in re.findall(r'https?://[^\s<>"\']+', value):
        candidate = candidate.rstrip("，。；！？）】")
        if allowed_url(candidate):
            return candidate
    for candidate in re.findall(r'(?<![\w./@])(?:www\.douyin\.com|v\.douyin\.com|v\.iesdouyin\.com)/[^\s<>"\']+', value):
        if allowed_url("https://" + candidate):
            return "https://" + candidate
    return None


def entity_matches(target, data):
    if not target or not isinstance(data, dict) or data.get("status_code", 0) != 0:
        return False
    for key, identifier, target_key in [("aweme_detail", "aweme_id", "aweme_id"),
                                        ("mix_info", "mix_id", "mix_id"),
                                        ("music_info", "id", "music_id")]:
        item = data.get(key)
        expected = target.get(target_key)
        if expected and isinstance(item, dict) and str(item.get(identifier)) == str(expected):
            return True
    return False


class LinkChecker:
    def __init__(self, config, *, show_browser=False):
        persistent = bool(getattr(config, "config_path", None))
        self.session = BrowserSession(
            profile_dir=Path("config/browser-profile") if persistent else None,
            cookie_path=Path("config/cookies.json") if persistent else None)
        self._initialized = False
        self.client = DouyinAPIClient(config.get_cookies(), proxy=config.get("proxy"),
                                     browser_session=self.session)
        self.client._BROWSER_COOKIE_BLOCKLIST = set()
        self.headless = not show_browser
        self._guarded_context = None

    async def close(self):
        await self.session.close()
        await self.client.close()

    async def check(self, link):
        url = link_url(link)
        if not url:
            return checked_result(link, "invalid", "未找到支持的抖音链接，请检查格式或域名")
        if urlsplit(url).hostname not in {"v.douyin.com", "v.iesdouyin.com"} and not URLParser.parse(url):
            return checked_result(link, "unknown", "此链接类型暂不能可靠检测，未判定为失效")
        try:
            if not self._initialized:
                await self.session.initialize()
                self._initialized = True
            return await asyncio.wait_for(self._check_page(link, url), timeout=_CHECK_TIMEOUT_SECONDS)
        except UserUnavailableError as error:
            status = "restricted" if error.reason.startswith("私密账号") else "unavailable"
            return checked_result(link, status, error.reason)
        except asyncio.TimeoutError:
            return checked_result(link, "unknown", "检测超时（30秒），暂不能确认链接是否有效", "access_error")
        except Exception as error:
            from utils.browser_runtime import BrowserUnavailableError
            if isinstance(error, BrowserUnavailableError):
                raise
            return access_error_result(link, error)

    async def _check_page(self, link, url):
        async with self.client._browser_page(headless=self.headless) as (context, page):
            if context is not self._guarded_context:
                async def guard(route):
                    request = route.request
                    if request.resource_type == "media":
                        await route.abort()
                    elif request.is_navigation_request() and request.frame == page.main_frame and not allowed_url(request.url):
                        await route.abort()
                    else:
                        await route.continue_()
                await context.route("**/*", guard)
                self._guarded_context = context
            responses = []
            pending = set()

            async def capture(response):
                if not allowed_url(response.url) or response.status != 200:
                    return
                if not any(endpoint in urlsplit(response.url).path for endpoint in [
                    "/aweme/detail/", "/mix/detail/", "/music/detail/",
                ]):
                    return
                try:
                    responses.append(await response.json())
                except Exception:
                    pass

            def on_response(response):
                task = asyncio.create_task(capture(response))
                pending.add(task)
                task.add_done_callback(pending.discard)

            page.on("response", on_response)
            try:
                try:
                    response = await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                except Exception as error:
                    return access_error_result(link, error, navigation=True)
                if not allowed_url(page.url):
                    return checked_result(link, "unknown", "页面跳转到非抖音地址，未继续检测", "access_error")
                if response and response.status in {403, 429}:
                    return checked_result(link, "unknown", "访问被安全验证或限流阻止，需人工确认（HTTP {}）".format(response.status), "verification")
                if response and response.status >= 400:
                    return checked_result(link, "unknown", "页面访问失败（HTTP {}），未判定为失效".format(response.status), "access_error")
                target = URLParser.parse(page.url)
                original = URLParser.parse(url)
                if (original and target and original.get("type") == "user"
                        and original.get("sec_uid") != "self" and original.get("sec_uid") != target.get("sec_uid")):
                    return checked_result(link, "unknown", "主页跳转与原链接不一致，暂不能确认")
                confirmed = 0
                for _ in range(15):
                    await self.client._check_browser_user_available(page)
                    state = await page.evaluate(_STATE_SCRIPT)
                    if state.get("verification"):
                        return checked_result(link, "unknown", "遇到安全验证，需人工确认", "verification")
                    profile_ready = target and target.get("type") == "user" and state.get("profile")
                    content_ready = any(entity_matches(target, data) for data in responses)
                    confirmed = confirmed + 1 if profile_ready or content_ready else 0
                    if confirmed >= 2:
                        return checked_result(link, "valid", "用户主页可访问；此结果不代表所有作品都可下载"
                                              if profile_ready else "已确认页面返回目标内容信息")
                    await page.wait_for_timeout(400)
                detail = "，HTTP {}".format(response.status) if response and response.status != 200 else ""
                return checked_result(link, "unknown", "页面未提供足够证据，暂不能确认" + detail)
            finally:
                page.remove_listener("response", on_response)
                for task in list(pending):
                    task.cancel()
                if pending:
                    await asyncio.gather(*list(pending), return_exceptions=True)
                try:
                    self.session.remember_cookies(await context.cookies(self.client.BASE_URL))
                except Exception:
                    pass
