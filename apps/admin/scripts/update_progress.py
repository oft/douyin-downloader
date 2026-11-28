"""Bounded, nonblocking progress snapshots for the library's child-process pipe."""

import asyncio
import json
import queue
import threading
import time

from cli.progress_display import ProgressDisplay
from utils.io_audit import record_stage, set_context
from utils.logger import safe_log_url


class ProgressPipe:
    def __init__(self, stream):
        self.stream = stream
        self.pending = queue.Queue(maxsize=1)
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._write, daemon=True)
        self.thread.start()

    def send(self, snapshot):
        # Callbacks run on the download event loop; never wait for pipe capacity.
        try:
            self.pending.get_nowait()
        except queue.Empty:
            pass
        try:
            self.pending.put_nowait(dict(snapshot))
        except queue.Full:
            pass

    def _write(self):
        while not self.stopping.is_set() or not self.pending.empty():
            try:
                snapshot = self.pending.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                self.stream.write(json.dumps({"type": "progress", "version": 1,
                                              "progress": snapshot}, ensure_ascii=False) + "\n")
                self.stream.flush()
            except (OSError, ValueError):
                return

    async def close(self):
        self.stopping.set()
        # Even a broken/undrained pipe must not prevent cancellation or shutdown.
        await asyncio.to_thread(self.thread.join, 1.0)


class LibraryProgressDisplay(ProgressDisplay):
    stream_counts_version = 1

    def __init__(self, send, diagnostics=None):
        super().__init__()
        self.send = send
        self.diagnostics = diagnostics
        self.author_started = None
        self.last_phase = None
        self.last_emit = 0.0
        self.settled = {"success": 0, "failed": 0, "skipped": 0}
        self.attempt = dict(self.settled)
        self.stream_base_attempt = None
        self.snapshot = dict(
            totalUrls=0, completedUrls=0, currentIndex=0, failedUrls=0,
            url="", author="", step="初始化", detail="", itemsTotal=0, itemsCompleted=0,
            success=0, failed=0, skipped=0, bytesRead=0, bytesTotal=0,
            currentItem="", message="",
            streaming=False, queuedItems=0, activeItems=0, listingState="",
        )

    def on_diagnostic(self, event, **fields):
        record_stage(event, **fields)
        if self.diagnostics is not None:
            self.diagnostics.record(event, author=self.snapshot.get('author', ''), **fields)

    def _emit(self, force=False):
        now = time.monotonic()
        if not force and now - self.last_emit < 0.25:
            return
        self.last_emit = now
        for key in self.settled:
            self.snapshot[key] = self.settled[key] + self.attempt[key]
        self.send(dict(self.snapshot))

    def start_download_session(self, total_urls):
        self.snapshot["totalUrls"] = total_urls
        self._emit(force=True)

    def stop_download_session(self):
        self._emit(force=True)

    def _clear_work_counts(self):
        self.stream_base_attempt = None
        for key in ("receivedItems", "newItems", "existingItems", "repairItems", "downloadedItems", "failedItems"):
            self.snapshot.pop(key, None)

    def start_url(self, index, total, url):
        set_context(author_url=url, index=index)
        self._clear_work_counts()
        self.author_started = time.monotonic()
        self.last_phase = None
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot.update(currentIndex=index, totalUrls=total, url=safe_log_url(url),
                             author="", step="初始化", detail="", itemsTotal=0,
                             itemsCompleted=0, bytesRead=0, bytesTotal=0, currentItem="",
                             streaming=False, queuedItems=0, activeItems=0, listingState="", message="")
        self.on_diagnostic('author_start', index=index, total=total, url=url)
        self._emit(force=True)

    def _settle(self, result=None):
        for key in self.settled:
            self.settled[key] += getattr(result, key) if result is not None else self.attempt[key]
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot["completedUrls"] += 1

    def complete_url(self, result=None):
        note = getattr(result, 'incomplete_reason', None)
        unavailable = getattr(result, 'unavailable_reason', None)
        outcome = 'unavailable' if unavailable else 'partial' if note or getattr(result, 'failed', 0) else 'finished'
        reason = ('user_unavailable' if unavailable else 'first_page_timeout' if note and '首批' in note else
                  'history_budget' if note and ('时间上限' in note or '超时' in note) else 'listing_incomplete' if note else '')
        self.on_diagnostic('author_finished', elapsedMs=round((time.monotonic()-self.author_started)*1000)
                           if self.author_started is not None else 0,
                           items=getattr(result, 'total', self.snapshot['itemsTotal']),
                           success=getattr(result, 'success', self.attempt['success']),
                           failed=getattr(result, 'failed', self.attempt['failed']),
                           skipped=getattr(result, 'skipped', self.attempt['skipped']), status=outcome, reason=reason)
        self._settle(result)
        note = getattr(result, "incomplete_reason", None)
        step = "本组未全部完成" if note and "历史待下载作品" in note else "列表未取全" if note else "链接处理完成"
        self.snapshot.update(step=step, detail=str(note or "")[:2000])
        if note:
            self.snapshot["message"] = str(note)[:2000]
        self._emit(force=True)

    def fail_url(self, reason):
        self.on_diagnostic('author_failed', elapsedMs=round((time.monotonic()-self.author_started)*1000)
                           if self.author_started is not None else 0)
        self._settle()
        self.snapshot["failedUrls"] += 1
        self.snapshot.update(step="链接处理失败", detail=str(reason)[:2000])
        self._emit(force=True)

    def advance_step(self, step, detail=""):
        self.update_step(step, detail)

    def update_step(self, step, detail=""):
        if step != self.last_phase:
            self.on_diagnostic('phase', step=str(step)[:200])
            self.last_phase = step
        self.snapshot.update(step=str(step)[:200], detail=str(detail)[:2000])
        self._emit(force=True)

    def set_item_total(self, total, detail=""):
        self._clear_work_counts()
        self.snapshot.update(streaming=False, queuedItems=0, activeItems=0, listingState="")
        self.snapshot.update(itemsTotal=max(0, int(total)), itemsCompleted=0,
                             detail=str(detail)[:2000], bytesRead=0, bytesTotal=0, currentItem="")
        self._emit(force=True)

    def on_stream_progress(self, *, discovered, queued, active, listing_state,
                           received=None, new=None, existing=None, repair=None,
                           downloaded=None, failed=None, skipped=None):
        if not self.snapshot["streaming"]:
            self.snapshot.update(itemsCompleted=0, bytesRead=0, bytesTotal=0, currentItem="")
        self.snapshot.update(streaming=True, itemsTotal=discovered, queuedItems=queued,
                             activeItems=active, listingState=listing_state)
        if received is not None:
            if self.stream_base_attempt is None:
                self.stream_base_attempt = dict(self.attempt)
            for key, value in (("success", downloaded), ("failed", failed), ("skipped", skipped)):
                self.attempt[key] = self.stream_base_attempt[key] + value
            self.snapshot.update(receivedItems=received, newItems=new, existingItems=existing,
                                 repairItems=repair, downloadedItems=downloaded, failedItems=failed,
                                 itemsCompleted=min(discovered, downloaded + failed + skipped))
        self._emit()

    def advance_item(self, status, detail="", reason=""):
        if status in self.attempt:
            self.attempt[status] += 1
        self.snapshot["itemsCompleted"] = min(self.snapshot["itemsTotal"],
                                                self.snapshot["itemsCompleted"] + 1)
        self.snapshot["detail"] = str(reason or detail)[:2000]
        self._emit()

    def rollback_url_item_reasons(self):
        self._clear_work_counts()
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot.update(itemsTotal=0, itemsCompleted=0, bytesRead=0, bytesTotal=0)
        self.snapshot.update(streaming=False, queuedItems=0, activeItems=0, listingState="")
        self._emit(force=True)

    def on_author(self, nickname=None, sec_uid=None):
        if not self.snapshot["author"]:
            self.snapshot["author"] = str(nickname or sec_uid or "")[:200]
            set_context(author=self.snapshot["author"], author_url=self.snapshot.get('url', ''),
                        index=self.snapshot.get('currentIndex', 0))
            self.on_diagnostic('author_identified')
            self._emit(force=True)

    def on_item_progress(self, *, aweme_id, bytes_read, bytes_total):
        self.snapshot.update(currentItem=str(aweme_id)[:200], bytesRead=max(0, int(bytes_read)),
                             bytesTotal=max(0, int(bytes_total)))
        self._emit()

    def print_warning(self, message):
        self.snapshot["message"] = str(message)[:2000]
        self._emit(force=True)
        super().print_warning(message)

    def print_error(self, message):
        self.snapshot["message"] = str(message)[:2000]
        self._emit(force=True)
        super().print_error(message)
