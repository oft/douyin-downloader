import asyncio
import sqlite3

import pytest

from storage.database import Database
from storage.local_media_registry import ScanCancelled, recorded_media_path, scan_local_media
from tests.test_downloader_base_perf import _build_downloader, _video_aweme

KEY = '7346971177114611826'
OTHER = '7346971177114611827'


async def test_manual_scan_repairs_known_paths_preserves_metadata_and_records_unknowns(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    database = Database(str(tmp_path / 'works.db'), download_root=str(root))
    await database.initialize()
    await database.add_aweme({'aweme_id': KEY, 'aweme_type': 'video', 'title': 'Mac 标题',
                              'author_name': 'Mac 作者', 'file_path': 'old/missing.mp4'})
    file = root / (KEY + '_video.mp4')
    file.write_bytes(b'video')
    (root / (OTHER + '_video.mp4')).write_bytes(b'unknown')
    (root / (KEY + '_cover.jpg')).write_bytes(b'cover')
    (root / (KEY + '_avatar.png')).write_bytes(b'avatar')
    (root / (KEY + '_result.json')).write_text('{"aweme_id":"' + KEY + '"}')
    (root / 'unassigned.mp4').write_bytes(b'local')
    result = scan_local_media(database.db_path, root)
    assert result['repairedWorks'] == 1 and result['unregisteredWorks'] == 1
    assert result['unidentifiedFiles'] == 1
    db = await database._get_conn()
    async with db.execute('SELECT file_path, title, author_name FROM aweme WHERE aweme_id=?', (KEY,)) as cursor:
        row = await cursor.fetchone()
    assert row == (file.name, 'Mac 标题', 'Mac 作者')
    async with db.execute('SELECT metadata_path, cover_path, avatar_path FROM aweme WHERE aweme_id=?', (KEY,)) as cursor:
        assert await cursor.fetchone() == (KEY + '_result.json', KEY + '_cover.jpg', KEY + '_avatar.png')
    assert not await database.is_downloaded(OTHER)
    async with db.execute('SELECT previous_path FROM library_local_media_repairs') as cursor:
        assert (await cursor.fetchone())[0] == 'old/missing.mp4'
    assert await recorded_media_path(database, OTHER, root) == OTHER + '_video.mp4'
    (root / (OTHER + '_video.mp4')).unlink()
    assert await recorded_media_path(database, OTHER, root) is None
    assert file.read_bytes() == b'video'
    await database.close()


async def test_cancelled_scan_keeps_published_snapshot_and_valid_mac_copy(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    database = Database(str(tmp_path / 'works.db'), download_root=str(root))
    await database.initialize()
    valid = root / (KEY + '_original.mp4')
    valid.write_bytes(b'Mac')
    (root / (KEY + '_video.mp4')).write_bytes(b'other copy')
    await database.add_aweme({'aweme_id': KEY, 'aweme_type': 'video', 'file_path': valid.name})
    first = scan_local_media(database.db_path, root)
    assert first['repairedWorks'] == 0
    with pytest.raises(ScanCancelled):
        scan_local_media(database.db_path, root, cancelled=lambda: True)
    with sqlite3.connect(database.db_path) as db:
        assert db.execute('SELECT scanned_at FROM library_local_media_roots').fetchone()[0] == first['scannedAt']
        assert db.execute('SELECT file_path FROM aweme').fetchone()[0] == valid.name
    await database.close()


async def test_updates_never_scan_even_on_misses_direct_download_or_marking(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock
    downloader, api = _build_downloader(tmp_path)
    downloader.config.update(automatic_local_media_scan=False, video=True, cover=False,
                             avatar=False, music=False, json=False)
    def forbidden(*_args, **_kwargs):
        raise AssertionError('normal updates must never enumerate the media root')
    monkeypatch.setattr(downloader, '_build_local_aweme_index', forbidden)
    monkeypatch.setattr(type(tmp_path), 'rglob', forbidden)
    assert await downloader._should_download(KEY) is True
    downloader._mark_local_aweme_downloaded(OTHER)
    assert downloader._is_locally_downloaded(OTHER)
    api.get_session = AsyncMock(return_value=object())
    async def download(_candidates, target, _session, **_kwargs):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'video')
        return True
    monkeypatch.setattr(downloader, '_download_video_with_fallback', download)
    assert await downloader._download_aweme_assets(_video_aweme(KEY), 'author') is True
    assert await downloader._should_download(KEY) is False
    await api.close()


async def test_cancellation_after_publish_started_rolls_back_snapshot_and_path_repairs(tmp_path, monkeypatch):
    import storage.local_media_registry as registry
    root = tmp_path / 'media'
    root.mkdir()
    database = Database(str(tmp_path / 'works.db'), download_root=str(root))
    await database.initialize()
    file = root / (KEY + '_video.mp4')
    file.write_bytes(b'video')
    await database.add_aweme({'aweme_id': KEY, 'aweme_type': 'video', 'file_path': file.name})
    first = scan_local_media(database.db_path, root)
    original_connect = sqlite3.connect
    publishing = [False]
    def connect(*args, **kwargs):
        db = original_connect(*args, **kwargs)
        db.set_trace_callback(lambda sql: publishing.__setitem__(0, True) if sql.startswith('DELETE FROM library_local_media_files') else None)
        return db
    monkeypatch.setattr(registry.sqlite3, 'connect', connect)
    with pytest.raises(ScanCancelled):
        scan_local_media(database.db_path, root, cancelled=lambda: publishing[0])
    with original_connect(database.db_path) as db:
        assert db.execute('SELECT scanned_at FROM library_local_media_roots').fetchone()[0] == first['scannedAt']
        assert db.execute('SELECT COUNT(*) FROM library_local_media_files').fetchone()[0] == 1
    await database.close()


async def test_manual_snapshot_survives_new_process_connections_without_scanning(tmp_path, monkeypatch):
    root = tmp_path / 'media'
    root.mkdir()
    database = Database(str(tmp_path / 'works.db'), download_root=str(root))
    await database.initialize()
    (root / (KEY + '_video.mp4')).write_bytes(b'video')
    scan_local_media(database.db_path, root)
    await database.close()
    reopened = Database(database.db_path, download_root=str(root))
    await reopened.initialize()
    await reopened.add_aweme({'aweme_id': KEY, 'aweme_type': 'video'})
    downloader, api = _build_downloader(root)
    downloader.database = reopened
    downloader.config.update(automatic_local_media_scan=False)
    monkeypatch.setattr(downloader, '_build_local_aweme_index', lambda: pytest.fail('no scans'))
    assert await downloader._should_download(KEY) is False
    assert await reopened.is_downloaded(KEY)
    root.rename(tmp_path / 'old-media')
    root.mkdir()
    assert await downloader._should_download(KEY) is True
    await reopened.close()
    await api.close()


async def test_path_repair_does_not_commit_another_concurrent_transaction(tmp_path, monkeypatch):
    import core.downloader_base as base

    root = tmp_path / 'media'
    root.mkdir()
    database = Database(str(tmp_path / 'works.db'), download_root=str(root))
    await database.initialize()
    file = root / (KEY + '_video.mp4')
    file.write_bytes(b'video')
    scan_local_media(database.db_path, root)
    await database.add_aweme({'aweme_id': KEY, 'aweme_type': 'video', 'title': 'original'})
    downloader, api = _build_downloader(root)
    downloader.database = database
    downloader.config.update(automatic_local_media_scan=False)
    release = asyncio.Event()
    writing = asyncio.Event()
    found = asyncio.Event()
    original_lookup = base.recorded_media_path

    async def lookup(*args):
        result = await original_lookup(*args)
        if result:
            found.set()
        return result

    monkeypatch.setattr(base, 'recorded_media_path', lookup)

    async def writer():
        with pytest.raises(ValueError, match='rollback'):
            async with database._write_transaction() as db:
                await db.execute('UPDATE aweme SET title=? WHERE aweme_id=?', ('uncommitted', KEY))
                writing.set()
                await release.wait()
                raise ValueError('rollback')

    pending_writer = asyncio.create_task(writer())
    pending_repair = None
    try:
        await asyncio.wait_for(writing.wait(), timeout=2)
        pending_repair = asyncio.create_task(downloader._should_download(KEY))
        await asyncio.wait_for(found.wait(), timeout=2)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(asyncio.shield(pending_repair), timeout=.2)
        with sqlite3.connect(database.db_path) as observer:
            assert observer.execute('SELECT title FROM aweme WHERE aweme_id=?', (KEY,)).fetchone()[0] == 'original'
        release.set()
        await pending_writer
        assert await pending_repair is False
        with sqlite3.connect(database.db_path) as observer:
            assert observer.execute('SELECT title,file_path FROM aweme WHERE aweme_id=?', (KEY,)).fetchone() == ('original', file.name)
    finally:
        release.set()
        await asyncio.gather(pending_writer, *([pending_repair] if pending_repair else []), return_exceptions=True)
        await database.close()
        await api.close()
