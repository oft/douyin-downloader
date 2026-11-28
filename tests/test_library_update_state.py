import asyncio
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from core.local_media_index import registered_media_exists
from core.post_incremental import saved_author_count
from storage.database import Database
from storage.download_queue import DownloadQueueStore
from storage.library_update_state import (
    TABLES,
    PostAudit,
    ensure_library_state,
    observe_media,
    registered_count,
)
from tests.test_post_pipeline import build, item


@pytest.fixture
async def library(tmp_path):
    database = Database(str(tmp_path / 'works.db'), download_root=str(tmp_path))
    await database.initialize()
    try:
        yield database
    finally:
        await database.close()


async def seed(library, key='1', author='author', path='saved.mp4', kind='video'):
    await library.add_aweme({'aweme_id': key, 'aweme_type': kind, 'author_sec_uid': author,
                             'author_id': 'uid', 'file_path': path})


async def test_manifest_seed_and_cross_language_writes_keep_counts_without_disk_scan(library, monkeypatch):
    await seed(library)
    await asyncio.gather(ensure_library_state(library), ensure_library_state(library))
    assert await registered_count(library, 'author') == 1
    pipe = build(database=library)
    original = pipe.downloader.config.get
    pipe.downloader.config.get = lambda key, default=None: True if key == 'library_update_tracking' else original(key, default)
    def forbidden(*args, **kwargs):
        raise AssertionError('count must use the manifest only')
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'stat', forbidden)
        patch.setattr(Path, 'lstat', forbidden)
        assert await saved_author_count(pipe.downloader, 'author') == 1
    # A separate native writer exercises the same triggers used by Node imports/deletes.
    with sqlite3.connect(library.db_path) as db:
        db.execute("INSERT OR IGNORE INTO aweme(aweme_id,aweme_type,author_sec_uid,file_path) VALUES('2','gallery','author','gallery/2_1.jpg')")
        db.execute("UPDATE aweme SET title='metadata-only' WHERE aweme_id='1'")
    assert await registered_count(library, 'author') == 2
    await observe_media(library, {'1': (False, False), '2': (True, False)})
    assert await registered_count(library, 'author') == 1
    with sqlite3.connect(library.db_path) as db:
        db.execute("UPDATE aweme SET title='keep missing evidence' WHERE aweme_id='1'")
        assert db.execute("SELECT file_path FROM aweme WHERE aweme_id='1'").fetchone()[0] == 'saved.mp4'
        assert db.execute("SELECT present FROM library_media_state WHERE aweme_id='1'").fetchone()[0] == 0
        db.execute("UPDATE aweme SET author_sec_uid='other' WHERE aweme_id='2'")
    assert await registered_count(library, 'author') == 0
    assert await registered_count(library, 'other') == 1
    with sqlite3.connect(library.db_path) as db:
        db.execute("DELETE FROM aweme WHERE aweme_id='2'")
        db.execute("UPDATE aweme SET file_path='repaired.mp4' WHERE aweme_id='1'")
    assert await registered_count(library, 'other') == 0
    assert await registered_count(library, 'author') == 1


async def test_audit_preserves_manual_request_and_deepest_frontier(library):
    await ensure_library_state(library)
    audit = PostAudit(library, 'scope', 'author', '作者')
    fields = dict(total=100, registered=80, pages=20, received=80, new=0, repair=0,
                  oldest=100, status='budget', reason='历史待复核', checked=True)
    await audit.save(**fields)
    await audit.retry(True)
    await audit.save(**dict(fields, registered=60, pages=1, oldest=200, status='running'))
    previous = await audit.previous()
    assert previous['retry'] == 1
    assert previous['gap'] == 20 and previous['registered'] == 60
    with sqlite3.connect(library.db_path) as db:
        assert db.execute('SELECT oldest_time FROM library_post_audit').fetchone()[0] == 100


async def test_old_checkpoint_schema_migrates_without_trusting_an_unknown_baseline(library):
    db = await library._get_conn()
    schema = next(sql for sql in TABLES if 'CREATE TABLE IF NOT EXISTS library_post_audit' in sql)
    await db.execute(schema.replace('checked_gap INTEGER, ', ''))
    await db.commit()
    await ensure_library_state(library)
    async with db.execute('PRAGMA table_info(library_post_audit)') as cursor:
        assert 'checked_gap' in {row[1] for row in await cursor.fetchall()}


def tracked_pipe(library):
    return build(database=library, library=True)


async def test_registered_file_read_does_not_block_writes_after_queue_commit(library, monkeypatch):
    await seed(library, path='1.mp4')
    root = Path(library.download_root)
    (root / '1.mp4').write_bytes(b'video')
    await ensure_library_state(library)
    db = await library._get_conn()
    store = DownloadQueueStore(library.db_path, 'scope')
    await store.initialize()

    def interleave(query):
        async def execute(sql, parameters=()):
            result = await query(sql, parameters)
            if sql.startswith('SELECT file_path FROM aweme'):
                try:
                    await store.remember(item(2))
                    await seed(library, key='3')
                except BaseException:
                    if hasattr(result, 'close'):
                        await result.close()
                    raise
            return result
        return execute

    monkeypatch.setattr(db, 'execute', interleave(db.execute))
    monkeypatch.setattr(db, 'execute_fetchall', interleave(db.execute_fetchall))
    try:
        assert await registered_media_exists(library, '1', root)
        assert await library.is_downloaded('3')
    finally:
        await store.close()


async def test_audit_rolls_back_a_failed_snapshot_upgrade_before_next_author(library):
    await seed(library)
    await ensure_library_state(library)
    db = await library._get_conn()
    audit = PostAudit(library, 'scope', 'author', '作者')
    fields = dict(total=1, registered=1, pages=1, received=1, new=0, repair=0,
                  oldest=100, status='running')
    async with db.execute('SELECT file_path FROM aweme WHERE aweme_id=?', ('1',)):
        with sqlite3.connect(library.db_path) as other:
            other.execute('UPDATE aweme SET title=? WHERE aweme_id=?', ('changed', '1'))
        with pytest.raises(sqlite3.OperationalError, match='database is locked'):
            await audit.save(**fields)
        assert not db.in_transaction
    await audit.save(**fields)
    assert (await audit.previous())['status'] == 'running'


async def test_bounded_audit_does_not_repeat_known_gap_and_manual_retry_overrides_boundary(library, monkeypatch):
    for key in range(20):
        await seed(library, str(key))
    pipe = tracked_pipe(library)
    pipe.homepage_total = 40
    async def classified(downloader, items):
        return {str(row['aweme_id']) for row in items}, {str(row['aweme_id']) for row in items}
    monkeypatch.setattr('core.post_pipeline.classify_local_items', classified)
    async def collect():
        assert await pipe.offer_page([item(1), item(2)]) is True
        pipe.strategy.incomplete_reason = '已达到浏览器采集时间上限'
    await pipe.run(collect)
    assert (await pipe.audit.previous())['checked'] == 1
    # One new work has been registered, and the API total has grown too. The old
    # twenty-work discrepancy must not trigger the identical historical walk.
    await seed(library, 'new')
    second = tracked_pipe(library)
    second.homepage_total = 41
    async def next_collect():
        assert second.history_gap == 20
        assert await second.offer_page([item(1), item(2)]) is False
    await second.run(next_collect)
    await second.audit.retry(True)
    third = tracked_pipe(library)
    third.homepage_total = 41
    async def manual_collect():
        assert third.force_history_check
        assert await third.offer_page([item(1), item(2)]) is True
    await third.run(manual_collect)
    assert (await third.audit.previous())['retry'] == 0


async def test_cancelled_manual_history_retry_remains_requested(library):
    pipe = tracked_pipe(library)
    await pipe.run(AsyncMock())
    await pipe.audit.retry(True)
    following = tracked_pipe(library)
    entered = asyncio.Event()
    async def collect():
        entered.set()
        await asyncio.Event().wait()
    task = asyncio.create_task(following.run(collect))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    previous = await following.audit.previous()
    assert previous['retry'] == 1 and previous['status'] == 'interrupted'
