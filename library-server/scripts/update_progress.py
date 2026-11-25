"""Bounded, nonblocking progress snapshots for the library's child-process pipe."""

import asyncio
import json
import queue
import threading
import time

from cli.progress_display import ProgressDisplay
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
    def __init__(self, send):
        super().__init__()
        self.send = send
        self.last_emit = 0.0
        self.settled = {"success": 0, "failed": 0, "skipped": 0}
        self.attempt = dict(self.settled)
        self.snapshot = dict(
            totalUrls=0, completedUrls=0, currentIndex=0, failedUrls=0,
            url="", author="", step="初始化", detail="", itemsTotal=0, itemsCompleted=0,
            success=0, failed=0, skipped=0, bytesRead=0, bytesTotal=0,
            currentItem="", message="",
            streaming=False, queuedItems=0, activeItems=0, listingState="",
        )

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

    def start_url(self, index, total, url):
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot.update(currentIndex=index, totalUrls=total, url=safe_log_url(url),
                             author="", step="初始化", detail="", itemsTotal=0,
                             itemsCompleted=0, bytesRead=0, bytesTotal=0, currentItem="",
                             streaming=False, queuedItems=0, activeItems=0, listingState="")
        self._emit(force=True)

    def _settle(self, result=None):
        for key in self.settled:
            self.settled[key] += getattr(result, key) if result is not None else self.attempt[key]
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot["completedUrls"] += 1

    def complete_url(self, result=None):
        self._settle(result)
        note = getattr(result, "incomplete_reason", None)
        step = "本组未全部完成" if note and "历史待下载作品" in note else "列表未取全" if note else "链接处理完成"
        self.snapshot.update(step=step, detail=str(note or "")[:2000])
        if note:
            self.snapshot["message"] = str(note)[:2000]
        self._emit(force=True)

    def fail_url(self, reason):
        self._settle()
        self.snapshot["failedUrls"] += 1
        self.snapshot.update(step="链接处理失败", detail=str(reason)[:2000])
        self._emit(force=True)

    def advance_step(self, step, detail=""):
        self.update_step(step, detail)

    def update_step(self, step, detail=""):
        self.snapshot.update(step=str(step)[:200], detail=str(detail)[:2000])
        self._emit(force=True)

    def set_item_total(self, total, detail=""):
        self.snapshot.update(streaming=False, queuedItems=0, activeItems=0, listingState="")
        self.snapshot.update(itemsTotal=max(0, int(total)), itemsCompleted=0,
                             detail=str(detail)[:2000], bytesRead=0, bytesTotal=0, currentItem="")
        self._emit(force=True)

    def on_stream_progress(self, *, discovered, queued, active, listing_state):
        if not self.snapshot["streaming"]:
            self.snapshot.update(itemsCompleted=0, bytesRead=0, bytesTotal=0, currentItem="")
        self.snapshot.update(streaming=True, itemsTotal=discovered, queuedItems=queued,
                             activeItems=active, listingState=listing_state)
        self._emit()

    def advance_item(self, status, detail="", reason=""):
        if status in self.attempt:
            self.attempt[status] += 1
        self.snapshot["itemsCompleted"] = min(self.snapshot["itemsTotal"],
                                                self.snapshot["itemsCompleted"] + 1)
        self.snapshot["detail"] = str(reason or detail)[:2000]
        self._emit()

    def rollback_url_item_reasons(self):
        self.attempt = dict.fromkeys(self.settled, 0)
        self.snapshot.update(itemsTotal=0, itemsCompleted=0, bytesRead=0, bytesTotal=0)
        self.snapshot.update(streaming=False, queuedItems=0, activeItems=0, listingState="")
        self._emit(force=True)

    def on_author(self, nickname=None, sec_uid=None):
        if not self.snapshot["author"]:
            self.snapshot["author"] = str(nickname or sec_uid or "")[:200]
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
