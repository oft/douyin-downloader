import asyncio
import importlib.util
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from utils.browser_runtime import BrowserUnavailableError

SCRIPT = Path(__file__).resolve().parents[1] / "library-server" / "scripts" / "link_checker.py"
spec = importlib.util.spec_from_file_location("library_link_checker", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
URL = "https://www.douyin.com/user/test-user"


@pytest.fixture
def checker(monkeypatch):
    config = SimpleNamespace(get_cookies=lambda: {}, get=lambda _key: None)
    instance = module.LinkChecker(config)
    page = SimpleNamespace(url=URL, main_frame=object(), on=Mock(), remove_listener=Mock(),
                           state={"profile": True}, unavailable="", destination=None)

    async def goto(url, **_kwargs):
        page.url = page.destination or url
        return SimpleNamespace(status=200)

    async def evaluate(_script, messages=None):
        return page.unavailable if messages is not None else page.state

    page.goto = AsyncMock(side_effect=goto)
    page.evaluate = evaluate
    page.wait_for_timeout = AsyncMock()
    context = SimpleNamespace(route=AsyncMock(), cookies=AsyncMock(return_value=[]))

    @asynccontextmanager
    async def browser_page(**_kwargs):
        yield context, page

    monkeypatch.setattr(instance.client, "_browser_page", browser_page)
    monkeypatch.setattr(instance.client, "_ensure_session", AsyncMock(side_effect=AssertionError("no API calls")))
    return instance, page, context


@pytest.mark.parametrize("reason,status", [("", "valid"), ("用户不存在", "unavailable"),
                                          ("账号已注销", "unavailable"), ("私密账号", "restricted")])
@pytest.mark.asyncio
async def test_checks_explicit_profile_state_without_downloading(checker, reason, status):
    instance, page, _context = checker
    page.unavailable = reason
    result = await instance.check(URL)
    assert result["status"] == status
    assert result["checkedAt"] and result["link"] == URL
    page.remove_listener.assert_called_once()
    instance.client._ensure_session.assert_not_awaited()


@pytest.mark.parametrize("value", ["not a link", "https://example.com/user/name",
    "https://www.douyin.com.evil.test/user/name", "http://127.0.0.1/user/name",
    "https://user:secret@www.douyin.com/user/name", "https://www.douyin.com:9000/user/name"])
@pytest.mark.asyncio
async def test_invalid_domain_or_format_never_opens_browser(checker, value):
    instance, page, _context = checker
    assert (await instance.check(value))["status"] == "invalid"
    page.goto.assert_not_awaited()


@pytest.mark.parametrize("state", [{}, {"verification": True}])
@pytest.mark.asyncio
async def test_empty_shell_and_challenge_are_unknown_not_invalid(checker, state):
    instance, page, _context = checker
    page.state = state
    assert (await instance.check(URL))["status"] == "unknown"


@pytest.mark.asyncio
async def test_network_failure_and_mismatched_redirect_are_unknown(checker):
    instance, page, _context = checker
    page.goto.side_effect = RuntimeError("connection interrupted")
    assert (await instance.check(URL))["status"] == "unknown"
    page.goto.side_effect = None
    page.destination = "https://www.douyin.com/user/another-user"
    async def redirect(*_args, **_kwargs):
        page.url = page.destination
    page.goto.side_effect = redirect
    assert (await instance.check(URL))["status"] == "unknown"


@pytest.mark.asyncio
async def test_total_timeout_and_cancellation_cleanup(checker, monkeypatch):
    instance, page, _context = checker
    async def hang(*_args, **_kwargs):
        await asyncio.Event().wait()
    page.goto.side_effect = hang
    monkeypatch.setattr(module, "_CHECK_TIMEOUT_SECONDS", 0.01)
    assert (await instance.check(URL))["status"] == "unknown"
    page.remove_listener.assert_called_once()
    page.remove_listener.reset_mock()
    monkeypatch.setattr(module, "_CHECK_TIMEOUT_SECONDS", 30)
    task = asyncio.create_task(instance.check(URL))
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    page.remove_listener.assert_called_once()


@pytest.mark.asyncio
async def test_media_and_non_douyin_navigation_are_blocked(checker):
    instance, page, context = checker
    await instance.check(URL)
    guard = context.route.call_args.args[1]
    for kind, url in [("media", "https://www.douyin.com/file.mp4"), ("document", "http://localhost/private")]:
        route = SimpleNamespace(request=SimpleNamespace(resource_type=kind, url=url,
            frame=page.main_frame, is_navigation_request=lambda: True), abort=AsyncMock(), continue_=AsyncMock())
        await guard(route)
        route.abort.assert_awaited_once()
        route.continue_.assert_not_awaited()


def test_entity_requires_matching_content_id_and_success_status():
    assert module.entity_matches({"aweme_id": "123"}, {"status_code": 0, "aweme_detail": {"aweme_id": "123"}})
    assert not module.entity_matches({"aweme_id": "123"}, {"aweme_detail": {"aweme_id": "456"}})
    assert not module.entity_matches({"aweme_id": "123"}, {"status_code": 2483, "aweme_detail": {"aweme_id": "123"}})
    assert module.link_url('分享链接 www.douyin.com/user/example') == 'https://www.douyin.com/user/example'


@pytest.mark.asyncio
async def test_browser_environment_failure_is_not_a_bad_link(checker, monkeypatch):
    instance, _page, _context = checker
    @asynccontextmanager
    async def broken(**_kwargs):
        raise BrowserUnavailableError("missing browser")
        yield
    monkeypatch.setattr(instance.client, "_browser_page", broken)
    with pytest.raises(BrowserUnavailableError):
        await instance.check(URL)


@pytest.mark.parametrize("error,expected", [
    (RuntimeError("net::ERR_ABORTED at https://secret/?token=private"), "net::ERR_ABORTED"),
    (asyncio.TimeoutError("https://secret/?cookie=private"), "20秒"),
    (RuntimeError("secret-cookie"), "RuntimeError"),
])
async def test_navigation_failure_keeps_safe_diagnostic(checker, error, expected):
    instance, page, _context = checker
    page.goto.side_effect = error
    result = await instance.check(URL)
    assert result["code"] == "access_error"
    assert expected in result["reason"]
    assert "secret" not in str(result) and "private" not in str(result)


@pytest.mark.parametrize("http_status,expected_code", [(403, "verification"),
    (429, "verification"), (503, "access_error")])
async def test_http_failure_is_never_an_invalid_link(checker, http_status, expected_code):
    instance, page, _context = checker
    page.goto.side_effect = None
    page.goto.return_value = SimpleNamespace(status=http_status)
    result = await instance.check(URL)
    assert result["status"] == "unknown"
    assert result["code"] == expected_code
    assert str(http_status) in result["reason"]


async def run_mock_batch(codes, elapsed=0):
    events = []
    now = [0]
    starts = []
    async def check(link):
        starts.append(now[0])
        now[0] += elapsed
        code = codes[len(starts) - 1]
        return module.checked_result(link, "unknown" if code else "valid", "test", code)
    async def sleep(seconds):
        now[0] += seconds
    checker = SimpleNamespace(check=AsyncMock(side_effect=check))
    exit_code = await module.check_links(checker, [URL + str(i) for i in range(len(codes))],
        lambda kind, **data: events.append((kind, data)), sleep=sleep, clock=lambda: now[0])
    return exit_code, events, starts


async def test_three_access_failures_stop_remaining_links_and_back_off():
    code, events, starts = await run_mock_batch(["access_error"] * 10)
    assert code == 3
    assert starts == [0, 10, 30]
    assert sum(kind == "link-check-result" for kind, _data in events) == 3
    assert "其余链接未检测" in events[-1][1]["message"]


async def test_success_resets_failure_streak_and_normal_pacing():
    code, _events, starts = await run_mock_batch(
        ["access_error", "access_error", None, "access_error", None])
    assert code == 0
    assert starts == [0, 10, 30, 35, 45]


async def test_slow_checks_already_satisfy_minimum_navigation_interval():
    code, _events, starts = await run_mock_batch([None, None], elapsed=8)
    assert code == 0 and starts == [0, 8]


async def test_verification_stops_immediately_without_processing_remaining_links():
    code, events, starts = await run_mock_batch(["verification", None])
    assert code == 3 and starts == [0]
    assert "安全验证或限流" in events[-1][1]["message"]


async def test_batch_cancel_during_backoff_does_not_check_next_link():
    checker = SimpleNamespace(check=AsyncMock(return_value=module.checked_result(
        URL, "unknown", "test", "access_error")))
    sleep = AsyncMock(side_effect=asyncio.CancelledError)
    with pytest.raises(asyncio.CancelledError):
        await module.check_links(checker, [URL, URL], Mock(), sleep=sleep)
    assert checker.check.await_count == 1
