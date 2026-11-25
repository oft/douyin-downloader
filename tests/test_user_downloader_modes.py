import asyncio
from typing import Any, Dict, List
from unittest.mock import AsyncMock

import pytest

import core.user_modes.post_strategy as post_strategy_module
from control.queue_manager import QueueManager
from core.api_client import DouyinAPIClient, FailedPayload, UserUnavailableError
from core.user_downloader import UserDownloader
from storage.file_manager import FileManager
from utils.browser_runtime import BrowserUnavailableError

_UNSET = object()


def _make_aweme(aweme_id: str) -> Dict[str, Any]:
    return {
        "aweme_id": aweme_id,
        "desc": f"desc-{aweme_id}",
        "create_time": 1700000000,
        "author": {"nickname": "tester", "uid": "uid-1"},
        "video": {"play_addr": {"url_list": ["https://example.com/video.mp4"]}},
    }


class _FakeConfig:
    def __init__(self, data: Dict[str, Any]):
        self._data = data

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)


class _FakeCookieManager:
    pass


class _NoopRateLimiter:
    async def acquire(self):
        return


class _FakeAPIClient:
    def __init__(self, self_info: Any = _UNSET):
        self.user_info_calls = []
        self.collect_calls = 0
        self.collect_mix_calls = 0
        self.self_info_calls = 0
        self._self_info = (
            {"uid": "uid-1", "sec_uid": "sec_uid_real", "nickname": "tester"}
            if self_info is _UNSET
            else self_info
        )

    async def get_user_info(self, _sec_uid: str):
        self.user_info_calls.append(_sec_uid)
        return {"uid": "uid-1", "nickname": "tester", "aweme_count": 99}

    async def get_self_info(self):
        self.self_info_calls += 1
        return self._self_info

    async def get_user_post(self, _sec_uid: str, max_cursor: int = 0, count: int = 20):
        if max_cursor > 0:
            return {"items": [], "has_more": False, "max_cursor": max_cursor, "status_code": 0}
        return {
            "items": [_make_aweme("111"), _make_aweme("222")],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }

    async def get_user_like(self, _sec_uid: str, max_cursor: int = 0, count: int = 20):
        if max_cursor > 0:
            return {"items": [], "has_more": False, "max_cursor": max_cursor, "status_code": 0}
        return {
            "items": [_make_aweme("222"), _make_aweme("333")],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }

    async def get_user_mix(self, _sec_uid: str, max_cursor: int = 0, count: int = 20):
        return {
            "items": [_make_aweme("444")],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }

    async def get_user_music(self, _sec_uid: str, max_cursor: int = 0, count: int = 20):
        return {
            "items": [_make_aweme("555")],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }

    async def get_user_collects(self, _sec_uid: str, max_cursor: int = 0, count: int = 20):
        self.collect_calls += 1
        return {
            "items": [{"collects_id_str": "collect-1", "collects_name": "默认收藏夹"}],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }

    async def get_collect_aweme(self, collects_id: str, max_cursor: int = 0, count: int = 20):
        assert collects_id == "collect-1"
        return {
            "items": [_make_aweme("666")],
            "has_more": False,
            "max_cursor": 0,
            "status_code": 0,
        }


def _build_downloader(tmp_path, mode: List[str], api_client=None) -> UserDownloader:
    config_data = {
        "number": {"post": 0, "like": 0, "mix": 0, "music": 0},
        "increase": {"post": False, "like": False, "mix": False, "music": False},
        "mode": mode,
        "thread": 2,
        "browser_fallback": {"enabled": False},
    }
    config = _FakeConfig(config_data)
    file_manager = FileManager(str(tmp_path / "Downloaded"))
    downloader = UserDownloader(
        config=config,
        api_client=api_client or _FakeAPIClient(),
        file_manager=file_manager,
        cookie_manager=_FakeCookieManager(),
        database=None,
        rate_limiter=_NoopRateLimiter(),
        retry_handler=None,
        queue_manager=QueueManager(max_workers=2),
    )
    return downloader


def test_user_downloader_processes_modes_and_deduplicates_across_modes(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post", "like"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "sec_uid_x"}))

    # 去重后应仅 3 条（111,222,333）
    assert result.total == 3
    assert result.success == 3
    assert result.failed == 0
    assert result.skipped == 0


def test_user_downloader_keeps_target_author_identity_for_batch_paths(tmp_path, monkeypatch):
    """A profile feed can contain co-authored items whose embedded author is
    not the requested profile.  The directory nickname and sec_uid must still
    come from the same target profile instead of forming a mixed identity.
    """
    downloader = _build_downloader(tmp_path, mode=["post"])
    captured_author_sec_uids = []
    captured_author_dirs = []
    downloader.config._data["author_dir"] = "nickname_uid"

    async def _always_true(*_args, **_kwargs):
        return True

    async def _capture(_item, _author, **kwargs):
        _item["author"]["sec_uid"] = "foreign-sec-uid"
        captured_author_sec_uids.append(kwargs.get("author_sec_uid"))
        context = downloader._build_aweme_file_context(
            _item,
            _author,
            kwargs.get("mode"),
            author_sec_uid=kwargs.get("author_sec_uid"),
        )
        captured_author_dirs.append(context["save_dir"].parts[-3])
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _capture)

    result = asyncio.run(downloader.download({"sec_uid": "target-sec-uid"}))

    assert result.success == 2
    assert captured_author_sec_uids == ["target-sec-uid", "target-sec-uid"]
    assert captured_author_dirs == ["tester_target-sec-uid", "tester_target-sec-uid"]


def test_user_downloader_supports_mix_and_music_modes(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["mix", "music"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "sec_uid_x"}))

    assert result.total == 2
    assert result.success == 2


def test_user_downloader_resolves_self_alias_for_regular_modes(tmp_path, monkeypatch):
    """`https://www.douyin.com/user/self` 是自己主页的地址栏形态,`self`
    不是 sec_uid —— 直接透传给 profile/other 会拿到 status_code=2
    “UserId不合法”。regular 模式下必须先换成登录账号真实 sec_uid。
    """
    downloader = _build_downloader(tmp_path, mode=["post"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "self"}))

    assert result.success == 2
    assert downloader.api_client.self_info_calls == 1
    assert downloader.api_client.user_info_calls == ["sec_uid_real"]


def test_user_downloader_self_alias_failure_reports_account_error(tmp_path):
    """解析不出登录账号时,错误信息要指向"识别账号"而不是甩锅 Cookie。"""
    downloader = _build_downloader(
        tmp_path, mode=["post"], api_client=_FakeAPIClient(self_info=None)
    )

    try:
        asyncio.run(downloader.download({"sec_uid": "self"}))
    except RuntimeError as exc:
        message = str(exc)
    else:
        raise AssertionError("expected RuntimeError for unresolvable /user/self")

    assert "无法识别当前登录账号" in message
    assert downloader.api_client.user_info_calls == []


def test_user_downloader_supports_self_collect_mode(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["collect"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "self"}))

    assert result.total == 1
    assert result.success == 1
    assert downloader.api_client.user_info_calls == []


def test_user_downloader_rejects_non_self_collect_mode(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["collect"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "sec_uid_x"}))

    assert result.total == 0
    assert result.success == 0
    assert downloader.api_client.user_info_calls == []
    assert downloader.api_client.collect_calls == 0


def test_user_downloader_post_mode_uses_batch_db_insert(tmp_path, monkeypatch):
    """Post-mode should write all aweme records via a single add_aweme_batch
    instead of N individual add_aweme commits."""
    from storage.database import Database

    db_path = tmp_path / "test.db"
    database = Database(str(db_path))
    asyncio.run(database.initialize())

    config_data = {
        "number": {"post": 0, "like": 0, "mix": 0, "music": 0},
        "increase": {"post": False, "like": False, "mix": False, "music": False},
        "mode": ["post"],
        "thread": 2,
        "browser_fallback": {"enabled": False},
    }
    config = _FakeConfig(config_data)
    file_manager = FileManager(str(tmp_path / "Downloaded"))
    downloader = UserDownloader(
        config=config,
        api_client=_FakeAPIClient(),
        file_manager=file_manager,
        cookie_manager=_FakeCookieManager(),
        database=database,
        rate_limiter=_NoopRateLimiter(),
        retry_handler=None,
        queue_manager=QueueManager(max_workers=2),
    )

    add_aweme_calls = {"n": 0}
    add_aweme_batch_calls: List[List[Dict[str, Any]]] = []

    original_add_aweme = database.add_aweme
    original_add_aweme_batch = database.add_aweme_batch

    async def counting_add_aweme(record):
        add_aweme_calls["n"] += 1
        return await original_add_aweme(record)

    async def counting_add_aweme_batch(records):
        add_aweme_batch_calls.append(list(records))
        return await original_add_aweme_batch(records)

    monkeypatch.setattr(database, "add_aweme", counting_add_aweme)
    monkeypatch.setattr(database, "add_aweme_batch", counting_add_aweme_batch)

    async def _always_true(*_args, **_kwargs):
        return True

    async def _fake_download_aweme_assets(
        item, _author, *, mode=None, db_batch=None, author_sec_uid=None
    ):
        if db_batch is not None:
            db_batch.append(
                {
                    "aweme_id": item.get("aweme_id"),
                    "aweme_type": "video",
                    "title": item.get("desc"),
                    "author_id": item["author"]["uid"],
                    "author_name": item["author"]["nickname"],
                    "create_time": item.get("create_time"),
                    "file_path": "/tmp",
                    "metadata": "{}",
                }
            )
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _fake_download_aweme_assets)

    result = asyncio.run(downloader.download({"sec_uid": "sec_uid_x"}))

    assert result.success == 2
    assert add_aweme_calls["n"] == 0, (
        f"post mode should not call add_aweme per item; got {add_aweme_calls['n']} single inserts"
    )
    assert len(add_aweme_batch_calls) == 1
    assert {r["aweme_id"] for r in add_aweme_batch_calls[0]} == {"111", "222"}

    # Verify rows actually landed in the DB.
    assert asyncio.run(database.is_downloaded("111")) is True
    assert asyncio.run(database.is_downloaded("222")) is True

    asyncio.run(database.close())


def test_user_downloader_rejects_mixed_self_collect_and_regular_modes(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["collect", "post"])

    async def _always_true(*_args, **_kwargs):
        return True

    async def _download_ok(*_args, **_kwargs):
        return True

    monkeypatch.setattr(downloader, "_should_download", _always_true)
    monkeypatch.setattr(downloader, "_download_aweme_assets", _download_ok)

    result = asyncio.run(downloader.download({"sec_uid": "self"}))

    assert result.total == 0
    assert result.success == 0
    assert downloader.api_client.user_info_calls == []
    assert downloader.api_client.collect_calls == 0


def test_post_strategy_recovers_when_full_page_stops_with_capped_profile_count(
    tmp_path, monkeypatch
):
    downloader = _build_downloader(tmp_path, mode=["post"])

    async def _full_page(_sec_uid, max_cursor=0, count=20):
        return {
            "items": [_make_aweme(str(index)) for index in range(count)],
            "has_more": False,
            "max_cursor": max_cursor,
            "status_code": 0,
        }

    async def _recover(_sec_uid, _user_info, aweme_list):
        aweme_list.append(_make_aweme("recovered"))

    monkeypatch.setattr(downloader.api_client, "get_user_post", _full_page)
    monkeypatch.setattr(downloader, "_recover_user_post_with_browser", _recover)
    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(strategy.collect_items("sec_uid_x", {"aweme_count": 20}))

    assert len(items) == 21
    assert items[-1]["aweme_id"] == "recovered"


def test_post_strategy_times_out_stalled_page_and_recovers(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    progress = []

    async def _stalled_page(_sec_uid, max_cursor=0, count=20):
        await asyncio.Event().wait()

    async def _recover(_sec_uid, _user_info, aweme_list):
        aweme_list.append(_make_aweme("recovered"))

    monkeypatch.setattr(downloader.api_client, "get_user_post", _stalled_page)
    monkeypatch.setattr(downloader, "_recover_user_post_with_browser", _recover)
    monkeypatch.setattr(
        downloader,
        "_progress_update_step",
        lambda step, detail="": progress.append((step, detail)),
    )
    monkeypatch.setattr(post_strategy_module, "_POST_PAGE_TIMEOUT_SECONDS", 0.01)
    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(
        asyncio.wait_for(
            strategy.collect_items("sec_uid_x", {"aweme_count": 1}),
            timeout=1.0,
        )
    )

    assert [item["aweme_id"] for item in items] == ["recovered"]
    assert any("超时" in detail for _step, detail in progress)


def test_post_strategy_keeps_collected_items_when_recovery_detail_fails(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["browser_fallback"]["enabled"] = True

    async def _paged(_sec_uid, max_cursor=0, count=20):
        if max_cursor == 0:
            return {
                "items": [_make_aweme("existing")],
                "has_more": True,
                "max_cursor": 1,
                "status_code": 0,
            }
        await asyncio.Event().wait()

    async def _collect_browser_ids(*_args, **_kwargs):
        return ["missing"]

    async def _detail_fails(*_args, **_kwargs):
        raise RuntimeError("login required")

    monkeypatch.setattr(downloader.api_client, "get_user_post", _paged)
    monkeypatch.setattr(
        downloader.api_client,
        "collect_user_post_ids_via_browser",
        _collect_browser_ids,
        raising=False,
    )
    monkeypatch.setattr(
        downloader.api_client,
        "get_video_detail",
        _detail_fails,
        raising=False,
    )
    monkeypatch.setattr(post_strategy_module, "_POST_PAGE_TIMEOUT_SECONDS", 0.01)

    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(strategy.collect_items("sec_uid_x", {"aweme_count": 2}))

    assert [item["aweme_id"] for item in items] == ["existing"]


@pytest.mark.parametrize("error", [UserUnavailableError("用户不存在"), BrowserUnavailableError("浏览器启动失败")])
def test_post_strategy_preserves_unavailable_user_reason_after_argus_rejection(tmp_path, error):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["browser_fallback"]["enabled"] = True

    async def rejected(*_args, **_kwargs):
        return DouyinAPIClient._normalize_paged_response(
            FailedPayload(FailedPayload.REJECTED, status=403), item_keys=["aweme_list"]
        )

    async def unavailable(*_args, **_kwargs):
        raise error

    downloader.api_client.get_user_post = rejected
    downloader.api_client.collect_user_post_ids_via_browser = unavailable
    strategy = downloader._get_mode_strategy("post")

    with pytest.raises(type(error), match=str(error)) as info:
        asyncio.run(strategy.collect_items("sec_uid_x", {"aweme_count": 1}))

    assert "安全校验" not in str(info.value)


@pytest.mark.parametrize("complete", [True, False])
def test_browser_pagination_completion_reaches_post_strategy(tmp_path, monkeypatch, complete):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["browser_fallback"]["enabled"] = True
    downloader.api_client.prefer_browser_posts = True
    monkeypatch.setattr(downloader, "_browser_backend_missing", lambda: False)
    monkeypatch.setattr(downloader.api_client, "collect_user_post_ids_via_browser",
                        AsyncMock(return_value=["first", "second"]), raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_aweme_items",
                        lambda: {key: _make_aweme(key) for key in ["first", "second"]}, raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_stats",
                        lambda: {"complete": complete, "stop_reason": "end_of_list" if complete else "idle"},
                        raising=False)
    steps = []
    monkeypatch.setattr(downloader, "_progress_update_step", lambda step, detail="": steps.append(detail))
    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(strategy.collect_items("sec_uid_x", {"aweme_count": 500}))
    assert len(items) == 2
    if complete:
        assert strategy.incomplete_reason is None  # A profile's count alone is not evidence.
    else:
        assert "未收到分页结束确认" in strategy.incomplete_reason
        assert "未确认取全" in steps[-1]


def test_browser_detail_failures_do_not_report_a_complete_listing(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["browser_fallback"]["enabled"] = True
    downloader.api_client.prefer_browser_posts = True
    monkeypatch.setattr(downloader, "_browser_backend_missing", lambda: False)
    monkeypatch.setattr(downloader.api_client, "collect_user_post_ids_via_browser",
                        AsyncMock(return_value=["first", "missing"]), raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_aweme_items",
                        lambda: {"first": _make_aweme("first")}, raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_stats",
                        lambda: {"complete": True, "stop_reason": "end_of_list"}, raising=False)
    monkeypatch.setattr(downloader.api_client, "get_video_detail", AsyncMock(return_value=None), raising=False)
    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(strategy.collect_items("sec_uid_x", {}))
    assert len(items) == 1
    assert "1条作品详情未能获取" in strategy.incomplete_reason


async def test_post_api_downloads_first_page_while_next_page_is_still_loading(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.stream_downloads = True
    download_started = asyncio.Event()
    listing_finished = False
    async def posts(_uid, max_cursor=0, count=20, **_kwargs):
        nonlocal listing_finished
        if max_cursor == 0:
            return {"items": [_make_aweme("first")], "has_more": True, "max_cursor": 100}
        await asyncio.wait_for(download_started.wait(), 1)
        listing_finished = True
        return {"items": [_make_aweme("second")], "has_more": False, "max_cursor": 0}
    async def download(work, *_args, **_kwargs):
        if work["aweme_id"] == "first":
            assert not listing_finished
            download_started.set()
        return {"status": "success"}
    monkeypatch.setattr(downloader.api_client, "get_user_post", posts)
    monkeypatch.setattr(downloader, "_process_mode_aweme", download)
    result = await asyncio.wait_for(downloader.download({"sec_uid": "sec_uid_x"}), 2)
    assert result.total == result.success == 2


async def test_browser_post_downloads_before_browser_collection_returns(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.stream_downloads = True
    downloader.config._data["browser_fallback"]["enabled"] = True
    downloader.api_client.prefer_browser_posts = True
    monkeypatch.setattr(downloader, "_browser_backend_missing", lambda: False)
    download_started = asyncio.Event()
    async def browser(_uid, *, on_items, **_kwargs):
        await on_items([_make_aweme("first")])
        await asyncio.wait_for(download_started.wait(), 1)
        await on_items([_make_aweme("second")])
        return ["first", "second"]
    async def download(*_args, **_kwargs):
        download_started.set()
        return {"status": "success"}
    monkeypatch.setattr(downloader.api_client, "collect_user_post_ids_via_browser", browser, raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_stats", lambda: {"complete": True}, raising=False)
    monkeypatch.setattr(downloader, "_process_mode_aweme", download)
    result = await asyncio.wait_for(downloader.download({"sec_uid": "sec_uid_x"}), 2)
    assert result.total == result.success == 2


async def test_streamed_number_limit_is_applied_after_filters_across_pages(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.stream_downloads = True
    downloader.config._data["number"]["post"] = 2
    async def posts(_uid, max_cursor=0, count=20, **_kwargs):
        if max_cursor == 0:
            return {"items": [_make_aweme("first")], "has_more": True, "max_cursor": 1}
        return {"items": [_make_aweme("first"), {**_make_aweme("pinned"), "is_top": 1},
                          _make_aweme("second"), _make_aweme("third")],
                "has_more": True, "max_cursor": 2}
    monkeypatch.setattr(downloader.api_client, "get_user_post", posts)
    monkeypatch.setattr(downloader, "_process_mode_aweme", AsyncMock(return_value={"status": "success"}))
    result = await downloader.download({"sec_uid": "sec_uid_x"})
    assert result.total == result.success == 2


@pytest.mark.parametrize("stats,expected", [
    ({"complete": False, "failure_reason": "作者作品分页请求返回 HTTP 429"}, "HTTP 429"),
    ({"complete": False, "failure_reason": "页面导航未完成（net::ERR_ABORTED）"}, "net::ERR_ABORTED"),
    ({"complete": True, "has_more": False, "post_pages": 1}, None),
])
async def test_empty_browser_listing_uses_evidence_instead_of_a_generic_failure(tmp_path, monkeypatch, stats, expected):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["browser_fallback"]["enabled"] = True
    downloader.api_client.prefer_browser_posts = True
    monkeypatch.setattr(downloader, "_browser_backend_missing", lambda: False)
    monkeypatch.setattr(downloader.api_client, "collect_user_post_ids_via_browser", AsyncMock(return_value=[]), raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_stats", lambda: stats, raising=False)
    strategy = downloader._get_mode_strategy("post")
    if expected:
        with pytest.raises(post_strategy_module.PageRequestFailedError, match=expected):
            await strategy.collect_items("sec_uid_x", {})
    else:
        assert await strategy.collect_items("sec_uid_x", {}) == []
        assert strategy.incomplete_reason is None


async def test_foreign_page_items_are_not_retried_as_eight_missing_author_details(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.stream_downloads = True
    downloader.config._data["browser_fallback"]["enabled"] = True
    downloader.api_client.prefer_browser_posts = True
    monkeypatch.setattr(downloader, "_browser_backend_missing", lambda: False)
    async def browser(_uid, *, on_items, **_kwargs):
        works = [_make_aweme("owned")] + [
            {**_make_aweme("foreign-" + str(i)), "author": {"sec_uid": "other-user"}}
            for i in range(8)]
        await on_items(works)
        return [work["aweme_id"] for work in works]
    monkeypatch.setattr(downloader.api_client, "collect_user_post_ids_via_browser", browser, raising=False)
    monkeypatch.setattr(downloader.api_client, "pop_browser_post_stats", lambda: {"complete": True}, raising=False)
    detail = AsyncMock(side_effect=AssertionError("Must not request foreign details"))
    monkeypatch.setattr(downloader.api_client, "get_video_detail", detail, raising=False)
    monkeypatch.setattr(downloader, "_process_mode_aweme", AsyncMock(return_value={"status": "success"}))
    result = await downloader.download({"sec_uid": "sec_uid_x"})
    assert result.total == result.success == 1 and result.incomplete_reason is None
    detail.assert_not_awaited()


def test_post_strategy_browser_recovery_counts_filtered_media(tmp_path, monkeypatch):
    downloader = _build_downloader(tmp_path, mode=["post"])
    downloader.config._data["number"]["post"] = 2
    downloader.config._data["media_types"] = ["gallery"]
    downloader.config._data["browser_fallback"]["enabled"] = True
    browser_expected_counts = []

    async def _full_video_page(_sec_uid, max_cursor=0, count=20):
        return {
            "items": [_make_aweme(f"video-{index}") for index in range(count)],
            "has_more": False,
            "max_cursor": max_cursor,
            "status_code": 0,
        }

    async def _collect_browser_ids(
        _sec_uid,
        *,
        expected_count,
        headless,
        max_scrolls,
        idle_rounds,
        wait_timeout_seconds,
    ):
        browser_expected_counts.append(expected_count)
        return ["gallery-1", "gallery-2"]

    gallery_items = {
        aweme_id: {
            **_make_aweme(aweme_id),
            "image_post_info": {"images": [{"display_image": {"url_list": []}}]},
        }
        for aweme_id in ("gallery-1", "gallery-2")
    }
    monkeypatch.setattr(downloader.api_client, "get_user_post", _full_video_page)
    monkeypatch.setattr(
        downloader.api_client,
        "collect_user_post_ids_via_browser",
        _collect_browser_ids,
        raising=False,
    )
    monkeypatch.setattr(
        downloader.api_client,
        "pop_browser_post_aweme_items",
        lambda: gallery_items,
        raising=False,
    )

    strategy = downloader._get_mode_strategy("post")
    items = asyncio.run(strategy.collect_items("sec_uid_x", {"aweme_count": 20}))
    filtered = strategy.apply_filters(items)

    assert browser_expected_counts == [0]
    assert [item["aweme_id"] for item in filtered] == ["gallery-1", "gallery-2"]
