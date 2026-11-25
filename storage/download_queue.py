"""Durable per-scope work records, separate from downloaded-file history."""

import asyncio
import json
import time

import aiosqlite


class DownloadQueueStore:
    def __init__(self, database_path, scope):
        self.database_path = str(database_path)
        self.scope = scope
        self.connection = None
        self.lock = asyncio.Lock()

    async def initialize(self):
        self.connection = await aiosqlite.connect(self.database_path)
        await self.connection.execute("""
            CREATE TABLE IF NOT EXISTS download_queue (
                scope TEXT NOT NULL, aweme_id TEXT NOT NULL, payload TEXT NOT NULL,
                status TEXT NOT NULL, created_us INTEGER NOT NULL, updated_us INTEGER NOT NULL,
                PRIMARY KEY (scope, aweme_id)
            )
        """)
        await self.connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_download_queue_pending
            ON download_queue (scope, status, created_us, aweme_id)
        """)
        await self.connection.execute(
            "UPDATE download_queue SET status='pending' WHERE scope=? AND status='downloading'",
            (self.scope,))
        await self.connection.commit()

    async def close(self):
        if self.connection is not None:
            await self.connection.close()
            self.connection = None

    async def remember(self, item):
        now = time.time_ns() // 1000
        async with self.lock:
            await self.connection.execute("""
                INSERT INTO download_queue VALUES (?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(scope, aweme_id) DO UPDATE SET
                    payload=excluded.payload, status='pending', updated_us=excluded.updated_us
            """, (self.scope, str(item["aweme_id"]), json.dumps(item, ensure_ascii=False), now, now))
            await self.connection.commit()

    async def mark(self, aweme_id, status):
        async with self.lock:
            await self.connection.execute(
                "UPDATE download_queue SET status=?, updated_us=?, "
                "payload=CASE WHEN ?='completed' THEN '{}' ELSE payload END "
                "WHERE scope=? AND aweme_id=?",
                (status, time.time_ns() // 1000, status, self.scope, str(aweme_id)))
            await self.connection.commit()

    async def pending(self):
        # Keyset pages avoid materializing an author's entire saved metadata in memory.
        last_time, last_id = -1, ""
        while True:
            async with self.lock:
                async with self.connection.execute("""
                    SELECT created_us, aweme_id, payload FROM download_queue
                    WHERE scope=? AND status IN ('pending', 'failed')
                      AND (created_us > ? OR (created_us=? AND aweme_id > ?))
                    ORDER BY created_us, aweme_id LIMIT 32
                """, (self.scope, last_time, last_time, last_id)) as cursor:
                    rows = await cursor.fetchall()
            if not rows:
                return
            for timestamp, aweme_id, payload in rows:
                last_time, last_id = timestamp, aweme_id
                yield json.loads(payload)

    async def unfinished_count(self):
        async with self.lock:
            async with self.connection.execute(
                "SELECT COUNT(*) FROM download_queue WHERE scope=? AND status!='completed'",
                (self.scope,)) as cursor:
                return (await cursor.fetchone())[0]
