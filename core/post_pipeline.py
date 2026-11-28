"""One list producer and fixed download workers for one author."""

import asyncio
import hashlib
import json
import time

from core.api_client import BrowserPageAccessError, LoginRequiredError, UserUnavailableError
from core.downloader_base import DownloadResult
from core.post_incremental import classify_local_items, saved_author_count
from storage.download_queue import DownloadQueueStore
from storage.library_update_state import PostAudit, registered_count
from utils.browser_runtime import BrowserUnavailableError


class PostDownloadPipeline:
    def __init__(self, strategy, sec_uid, user_info, seen_aweme_ids, *, capacity=64):
        self.strategy = strategy
        self.downloader = strategy.downloader
        self.sec_uid = user_info.get("sec_uid") or sec_uid
        self.author_name = user_info.get("nickname", "unknown")
        self.author_uid = user_info.get("uid") or ""
        # Prefer a verified homepage total when available. The profile API count is
        # a pagination hint, not proof of completeness (e.g. coauthored/hidden posts).
        self.homepage_total = None
        self.total_source = "unknown"
        for field in ("_homepage_work_total", "aweme_count"):
            total = user_info.get(field)
            if type(total) is int and total >= 0:
                self.homepage_total = total
                self.total_source = field
                break
        self.local_saved_count = None
        self.allow_page_stop = False
        self.seen = seen_aweme_ids if seen_aweme_ids is not None else set()
        config = self.downloader.config
        self.persisted_backlog = bool(
            self.downloader.database and config.get("library_update_tracking", False))
        self.memory_capacity = capacity
        self.queue = asyncio.Queue(maxsize=0 if self.persisted_backlog else capacity)
        self.offer_lock = asyncio.Lock()
        self.result = DownloadResult()
        self.active = 0
        self.collecting = True
        self.store = None
        self.limit = int((config.get("number", {}) or {}).get("post", 0) or 0)
        self.workers = max(1, min(3, int(config.get("thread", 3) or 3)))
        self.received_ids = set()
        self.new_ids = set()
        self.existing_ids = set()
        self.repair_ids = set()
        self.unrestored_pending = set()
        self.force = not bool((config.get("increase", {}) or {}).get("post", True))
        self.audit = None
        self.history_checked = False
        self.force_history_check = False
        self.history_gap = 0
        self.pages = 0
        self.oldest_time = None

    def notify(self):
        reporter = self.downloader.progress_reporter
        callback = getattr(reporter, "on_stream_progress", None)
        if callable(callback):
            completed = self.result.success + self.result.failed + self.result.skipped
            counts = {}
            if getattr(reporter, 'stream_counts_version', None) == 1:
                counts = dict(received=len(self.received_ids), new=len(self.new_ids),
                              existing=len(self.existing_ids), repair=len(self.repair_ids),
                              downloaded=self.result.success, failed=self.result.failed,
                              skipped=self.result.skipped)
            callback(discovered=self.result.total, active=self.active,
                     queued=max(0, self.result.total - completed - self.active),
                     listing_state="collecting" if self.collecting else
                     "partial" if self.result.incomplete_reason else "complete", **counts)

    async def offer_page(self, items):
        # Recovery uses offer() directly: a saved retry item is not a whole list page.
        started = time.monotonic()
        self.received_ids.update(str(item['aweme_id']) for item in items if item.get('aweme_id'))
        self.notify()
        classification = await classify_local_items(self.downloader, items)
        settings = [self.downloader.config.get(option) or {} for option in ('comments', 'transcript')]
        backfill = any(not isinstance(option, dict) or option.get('enabled') for option in settings)
        pinned = getattr(self.downloader, "_is_pinned_aweme", None)
        ordinary = [item for item in items if not (
            pinned(item) if callable(pinned) else str(item.get("is_top", "")).lower() in
            {"1", "true", "yes", "on"})]
        self.pages += 1
        times = [item.get('create_time') for item in ordinary if type(item.get('create_time')) is int and item['create_time'] > 0]
        if times:
            self.oldest_time = min([self.oldest_time] + times) if self.oldest_time else min(times)
        has_unseen = any(str(item.get("aweme_id") or "") not in self.seen for item in ordinary)
        saved_ids = classification[0] if classification is not None and not self.force and not backfill else set()
        keep_going = await self.offer(items, saved_ids=saved_ids, classification=classification)
        # Count the missing works accepted for download in this run as well. Stop at
        # the saved tail of this page; workers still drain before the next author.
        planned = len(self.new_ids | self.repair_ids)
        remaining_gap = (self.homepage_total - self.local_saved_count - planned
                         if self.homepage_total is not None and self.local_saved_count is not None
                         else None)
        self.allow_page_stop = (self.local_saved_count is not None
                                and self.local_saved_count > 0
                                and (remaining_gap is None or remaining_gap <= self.history_gap + 5))
        can_stop = (self.allow_page_stop and not self.force and not self.force_history_check and not self.unrestored_pending and not backfill
                    and self.downloader.config.get("incremental_page_stop", True)
                    and has_unseen and bool(ordinary)
                    and classification is not None
                    and str(ordinary[-1].get('aweme_id') or '') in classification[0])
        diagnostic = getattr(self.downloader.progress_reporter, 'on_diagnostic', None)
        if callable(diagnostic):
            diagnostic('post_page', items=len(items), elapsedMs=round((time.monotonic()-started)*1000),
                       allowPageStop=bool(can_stop), remainingGap=remaining_gap, pages=self.pages,
                       received=len(self.received_ids), newWorks=len(self.new_ids), repairWorks=len(self.repair_ids),
                       historyGap=self.history_gap, newGap=max(0, remaining_gap - self.history_gap) if remaining_gap is not None else None,
                       reason='previous_gap_checked' if can_stop and self.history_checked else
                       'saved_boundary' if can_stop else 'missing_work_gap' if remaining_gap and remaining_gap > self.history_gap + 5 else 'page_not_saved')
        if self.audit:
            await self._save_audit('running', checked=self.history_checked)
        if can_stop:
            self.downloader._progress_update_step(
                "增量更新", "本页已到达已保存作品，新发现的缺失作品下载完成后结束当前作者")
            return False
        return keep_going

    async def offer(self, items, *, saved_ids=None, classification=None):
        async with self.offer_lock:
            if classification is None:
                classification = await classify_local_items(self.downloader, items)
            for item in self.strategy.filter_stream_items(items):
                key = str(item.get("aweme_id") or "")
                if not key or key in self.seen:
                    continue
                if self.limit and self.result.total >= self.limit:
                    return False
                self.seen.add(key)
                self.received_ids.add(key)
                if classification is not None:
                    saved, known = classification
                    target = self.existing_ids if key in saved else self.repair_ids if key in known else self.new_ids
                    target.add(key)
                self.unrestored_pending.discard(key)
                if saved_ids and key in saved_ids:
                    # Already verified from the recorded paths: avoid building a whole-library
                    # filename index and rewriting history just to skip this existing page.
                    self.result.total += 1
                    self.result.skipped += 1
                    self.notify()
                    continue
                if self.store:
                    await self.store.remember(item)
                if self.downloader.database:
                    author = item.get("author") or {}
                    await self.downloader.database.add_aweme({
                        "aweme_id": key, "aweme_type": self.downloader._detect_media_type(item),
                        "title": item.get("desc"), "author_id": author.get("uid"),
                        "author_name": self.author_name,
                        "author_sec_uid": self.sec_uid, "create_time": item.get("create_time"),
                    })
                self.result.total += 1
                self.notify()
                # The queue store already holds the payload. Keep only IDs beyond
                # the in-memory capacity so a slow download can't block paging.
                queued = key if self.persisted_backlog and self.queue.qsize() >= self.memory_capacity else item
                await self.queue.put(queued)
            return not self.limit or self.result.total < self.limit

    async def worker(self):
        while True:
            item = await self.queue.get()
            if item is None:
                return
            key = item if isinstance(item, str) else str(item["aweme_id"])
            self.active += 1
            self.notify()
            try:
                if isinstance(item, str):
                    item = await self.store.load_pending(key)
                if self.store:
                    await self.store.mark(key, "downloading")
                try:
                    entry = await self.downloader._process_mode_aweme(
                        item, "post", self.author_name, author_sec_uid=self.sec_uid,
                        force_download=self.force)
                    status = entry["status"]
                    if self.audit and status in ('success', 'skipped'):
                        await classify_local_items(self.downloader, [item])
                except Exception as error:
                    status = "failed"
                    self.downloader._settle_crashed_item(item, error)
                setattr(self.result, status, getattr(self.result, status) + 1)
                if self.store:
                    await self.store.mark(key, "failed" if status == "failed" else "completed")
            except asyncio.CancelledError:
                if self.store:
                    await self.store.mark(key, "pending")
                raise
            finally:
                self.active -= 1
                self.notify()

    async def run(self, collect):
        config = self.downloader.config
        # Subsequent pages reduce the gap by the missing works accepted for download.
        # An unavailable total must not force repeated full walks.
        self.allow_page_stop = False
        if not self.force and config.get("incremental_page_stop", True):
            self.local_saved_count = await saved_author_count(
                self.downloader, self.sec_uid, self.author_uid)
            self.allow_page_stop = (self.local_saved_count is not None
                                    and self.local_saved_count > 0
                                    and (self.homepage_total is None
                                         or self.homepage_total - self.local_saved_count <= 5))
        diagnostic = getattr(self.downloader.progress_reporter, 'on_diagnostic', None)
        if callable(diagnostic):
            diagnostic('post_incremental_policy', total=self.homepage_total,
                       totalSource=self.total_source, localSaved=self.local_saved_count,
                       allowPageStop=self.allow_page_stop)
        if not self.allow_page_stop and config.get("incremental_page_stop", True):
            detail = ("本地登记 {} 条，主页参考 {} 条，继续查找缺失作品".format(
                self.local_saved_count, self.homepage_total)
                if self.local_saved_count is not None and self.homepage_total is not None
                else "尚无可核实的本地已保存作品，本轮完整抓取")
            self.downloader._progress_update_step("核对缺失作品", detail)
        if self.downloader.database:
            # No cookies/credentials are persisted in the scope. The hash separates filters/outputs.
            options = {key: config.get(key) for key in (
                "path", "number", "media_types", "download_pinned", "time", "start_date",
                "end_date", "date", "video_quality", "video", "music", "cover", "avatar", "json",
                "increase", "comments", "naming", "folder_mode")}
            for key in ("start_time", "end_time", "min_create_time", "max_create_time",
                        "author_dir", "redownload_missing_files"):
                options[key] = config.get(key)
            digest = hashlib.sha256(json.dumps(options, sort_keys=True, default=str).encode()).hexdigest()
            self.store = DownloadQueueStore(self.downloader.database.db_path,
                                           "post:" + self.sec_uid + ":" + digest)
            if config.get('library_update_tracking', False):
                self.audit = PostAudit(self.downloader.database, self.store.scope, self.sec_uid, self.author_name)
                previous = await self.audit.previous()
                self.force_history_check = bool(previous and previous['retry'])
                if self.force_history_check:
                    await self.audit.retry(False)
                self.history_checked = bool(previous and previous['checked'] and not previous['retry']
                                            and previous['gap'] is not None and not self.force)
                if self.history_checked:
                    self.history_gap = previous['gap']
                    self.allow_page_stop = (self.local_saved_count is not None and self.local_saved_count > 0
                                            and (self.homepage_total is None or self.homepage_total - self.local_saved_count <= self.history_gap + 5))
                    self.downloader._progress_update_step('增量核对', '同一作品差额已核对，本轮先检查新增页；剩余历史差额保留在诊断中')
                await self._save_audit('running', checked=self.history_checked)
                diagnostic = getattr(self.downloader.progress_reporter, 'on_diagnostic', None)
                if callable(diagnostic):
                    diagnostic('post_audit_policy', historyChecked=self.history_checked,
                               localSaved=self.local_saved_count, total=self.homepage_total,
                               allowPageStop=self.allow_page_stop, countSource='database_manifest', historyGap=self.history_gap)

        collection_error = None

        async def produce():
            nonlocal collection_error
            if self.store:
                failures = 0
                async for saved in self.store.pending():
                    if self.limit and self.result.total >= self.limit:
                        break
                    if not await self.downloader._should_download(
                            str(saved["aweme_id"]), force=self.force, aweme=saved):
                        # A crash can occur after the file was saved but before queue settlement.
                        await self.offer([saved])
                        continue
                    # Signed media URLs may have expired since the previous process stopped.
                    try:
                        await self.downloader.rate_limiter.acquire()
                        fresh = await self.downloader.api_client.get_video_detail(
                            saved["aweme_id"], suppress_error=True)
                    except Exception:
                        fresh = None
                    if not isinstance(fresh, dict) or str(fresh.get("aweme_id")) != str(saved["aweme_id"]):
                        failures += 1
                        if failures >= 3:
                            break  # Let the browser provide fresh page metadata instead.
                        continue
                    failures = 0
                    await self.offer([fresh])
            if self.store:
                self.unrestored_pending = {
                    str(saved["aweme_id"]) async for saved in self.store.pending()
                    if str(saved["aweme_id"]) not in self.seen}
            try:
                if not self.limit or self.result.total < self.limit:
                    await collect()
            except Exception as error:
                collection_error = error
            self.result.incomplete_reason = self.strategy.incomplete_reason
            if collection_error:
                self.result.incomplete_reason = "作品列表抓取中断：" + str(collection_error)
            self.collecting = False
            self.notify()
            for _ in range(self.workers):
                await self.queue.put(None)

        tasks = []
        try:
            if self.store:
                await self.store.initialize()
            self.notify()
            tasks = [asyncio.create_task(self.worker()) for _ in range(self.workers)]
            tasks.append(asyncio.create_task(produce()))
            await asyncio.gather(*tasks)
            if self.audit:
                incomplete = self.result.incomplete_reason
                await self._save_audit('budget' if incomplete and ('上限' in incomplete or '超时' in incomplete) else
                                       'partial' if incomplete or self.result.failed else 'checked',
                                       reason='历史核对未完成，保留差额供手动复核' if incomplete else
                                       '本轮核对完成，主媒体补齐结果见下载记录' if self.repair_ids else '本轮核对完成',
                                       checked=bool(self.pages and not self.result.failed and not collection_error
                                                    and (not incomplete or '上限' in incomplete or '超时' in incomplete)
                                                    and not self.unrestored_pending))
            if collection_error and (not self.result.total or isinstance(
                    collection_error, (BrowserUnavailableError, BrowserPageAccessError, LoginRequiredError, UserUnavailableError))):
                raise collection_error
            if self.store:
                remaining = await self.store.unfinished_count()
                if remaining > self.result.failed:
                    note = "仍有{}条历史待下载作品未能恢复，本组未全部完成".format(remaining)
                    self.result.incomplete_reason = "；".join(filter(None, [
                        self.result.incomplete_reason, note]))
            return self.result
        except asyncio.CancelledError:
            if self.audit:
                await self._save_audit('interrupted', reason='更新已停止，已取得的进度与队列保留', checked=self.history_checked)
                if self.force_history_check:
                    await self.audit.retry(True)
            raise
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if self.store:
                await self.store.close()

    async def _save_audit(self, status, reason='', checked=False):
        count = await registered_count(self.downloader.database, self.sec_uid, str(self.author_uid))
        await self.audit.save(total=self.homepage_total, registered=count, pages=self.pages,
                              received=len(self.received_ids), new=len(self.new_ids), repair=len(self.repair_ids),
                              oldest=self.oldest_time, status=status, reason=reason, checked=checked)
