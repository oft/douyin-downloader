"""One list producer, a bounded queue and fixed download workers for one author."""

import asyncio
import hashlib
import json

from core.api_client import LoginRequiredError, UserUnavailableError
from core.downloader_base import DownloadResult
from storage.download_queue import DownloadQueueStore
from utils.browser_runtime import BrowserUnavailableError


class PostDownloadPipeline:
    def __init__(self, strategy, sec_uid, user_info, seen_aweme_ids, *, capacity=64):
        self.strategy = strategy
        self.downloader = strategy.downloader
        self.sec_uid = user_info.get("sec_uid") or sec_uid
        self.author_name = user_info.get("nickname", "unknown")
        self.seen = seen_aweme_ids if seen_aweme_ids is not None else set()
        self.queue = asyncio.Queue(maxsize=capacity)
        self.offer_lock = asyncio.Lock()
        self.result = DownloadResult()
        self.active = 0
        self.collecting = True
        self.store = None
        config = self.downloader.config
        self.limit = int((config.get("number", {}) or {}).get("post", 0) or 0)
        self.workers = max(1, min(3, int(config.get("thread", 3) or 3)))
        self.force = not bool((config.get("increase", {}) or {}).get("post", True))

    def notify(self):
        reporter = self.downloader.progress_reporter
        callback = getattr(reporter, "on_stream_progress", None)
        if callable(callback):
            completed = self.result.success + self.result.failed + self.result.skipped
            callback(discovered=self.result.total, active=self.active,
                     queued=max(0, self.result.total - completed - self.active),
                     listing_state="collecting" if self.collecting else
                     "partial" if self.result.incomplete_reason else "complete")

    async def offer(self, items):
        async with self.offer_lock:
            for item in self.strategy.filter_stream_items(items):
                key = str(item.get("aweme_id") or "")
                if not key or key in self.seen:
                    continue
                if self.limit and self.result.total >= self.limit:
                    return False
                self.seen.add(key)
                if self.store:
                    await self.store.remember(item)
                if self.downloader.database:
                    author = item.get("author") or {}
                    await self.downloader.database.add_aweme({
                        "aweme_id": key, "aweme_type": self.downloader._detect_media_type(item),
                        "title": item.get("desc"), "author_id": author.get("uid"),
                        "author_name": author.get("nickname") or self.author_name,
                        "author_sec_uid": self.sec_uid, "create_time": item.get("create_time"),
                    })
                self.result.total += 1
                self.notify()
                await self.queue.put(item)
            return not self.limit or self.result.total < self.limit

    async def worker(self):
        while True:
            item = await self.queue.get()
            if item is None:
                return
            key = str(item["aweme_id"])
            self.active += 1
            self.notify()
            try:
                if self.store:
                    await self.store.mark(key, "downloading")
                try:
                    entry = await self.downloader._process_mode_aweme(
                        item, "post", self.author_name, author_sec_uid=self.sec_uid,
                        force_download=self.force)
                    status = entry["status"]
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
            if collection_error and (not self.result.total or isinstance(
                    collection_error, (BrowserUnavailableError, LoginRequiredError, UserUnavailableError))):
                raise collection_error
            if self.store:
                remaining = await self.store.unfinished_count()
                if remaining > self.result.failed:
                    note = "仍有{}条历史待下载作品未能恢复，本组未全部完成".format(remaining)
                    self.result.incomplete_reason = "；".join(filter(None, [
                        self.result.incomplete_reason, note]))
            return self.result
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if self.store:
                await self.store.close()
