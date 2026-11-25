"""Persistent oldest-attempt-first scheduling, enabled only by the library runner."""

import asyncio
import hashlib
import time

import aiosqlite

from core.url_parser import URLParser


def target_key(url):
    # Query strings/trailing slashes must not turn one author into several targets.
    if "/user/" in url:
        parsed = URLParser.parse(url)
        if parsed and parsed.get("type") == "user" and parsed.get("sec_uid"):
            return "user:" + parsed["sec_uid"]
    # Short URLs stay separate until explicitly resolved by the downloader.
    return "url:" + hashlib.sha256(url.encode("utf-8")).hexdigest()


class UpdateSchedule:
    def __init__(self, database_path):
        self.database_path = str(database_path)
        self.connection = None

    async def _connect(self):
        if self.connection is None:
            self.connection = await aiosqlite.connect(self.database_path)
            await self.connection.execute("""
                CREATE TABLE IF NOT EXISTS library_update_state (
                    target_key TEXT PRIMARY KEY,
                    last_attempt_us INTEGER NOT NULL,
                    last_finished_us INTEGER,
                    status TEXT NOT NULL
                )
            """)
            await self.connection.commit()
        return self.connection

    async def close(self):
        if self.connection is not None:
            await self.connection.close()
            self.connection = None

    async def order(self, urls):
        db = await self._connect()
        async with db.execute(
            "SELECT target_key, last_attempt_us FROM library_update_state"
        ) as cursor:
            attempts = dict(await cursor.fetchall())

        # Existing users get a useful initial order from historical downloads.
        history = {}
        async with db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_history'"
        ) as cursor:
            has_history = await cursor.fetchone()
        if has_history:
            async with db.execute(
                "SELECT url, MAX(download_time) FROM download_history GROUP BY url"
            ) as cursor:
                for url, timestamp in await cursor.fetchall():
                    if isinstance(url, str) and isinstance(timestamp, (int, float)):
                        key = target_key(url)
                        history[key] = max(history.get(key, 0), int(timestamp * 1_000_000))

        # Stable sorting preserves configuration order for equally old/new targets.
        return sorted(urls, key=lambda url: attempts.get(
            target_key(url), history.get(target_key(url), 0)))

    async def run(self, url, operation):
        db = await self._connect()
        key = target_key(url)
        await db.execute("""
            INSERT INTO library_update_state (target_key, last_attempt_us, status)
            VALUES (?, ?, 'running')
            ON CONFLICT(target_key) DO UPDATE SET
                last_attempt_us=excluded.last_attempt_us,
                last_finished_us=NULL, status='running'
        """, (key, time.time_ns() // 1000))
        # Persist before network access so even a forced process exit rotates the target.
        await db.commit()
        status = "interrupted"
        try:
            result = await operation()
            if result is None:
                status = "failed"
            elif getattr(result, "failed", 0) or getattr(result, "incomplete_reason", None):
                status = "partial"
            else:
                status = "finished"
            return result
        except asyncio.CancelledError:
            raise
        except Exception:
            status = "failed"
            raise
        finally:
            await db.execute("""
                UPDATE library_update_state SET last_finished_us=?, status=?
                WHERE target_key=?
            """, (time.time_ns() // 1000, status, key))
            await db.commit()
