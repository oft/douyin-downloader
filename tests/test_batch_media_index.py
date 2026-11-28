"""The expensive fallback is shared within a batch, with real path checks on hits."""
import asyncio
from unittest.mock import AsyncMock

from core.browser_session import BrowserSession
from storage.database import Database
from tests.test_downloader_base_perf import _build_downloader, _video_aweme


async def test_authors_share_one_scan_and_deleted_files_are_not_cached_as_present(tmp_path, monkeypatch):
    from core.local_media_index import LocalMediaIndexes
    a, api_a = _build_downloader(tmp_path)
    b, api_b = _build_downloader(tmp_path)
    batch = BrowserSession()
    assert isinstance(batch.local_media_indexes, LocalMediaIndexes)
    a._batch_media_indexes = b._batch_media_indexes = batch.local_media_indexes
    key = '7346971177114611826'
    video = tmp_path / (key + '.mp4')
    video.write_bytes(b'video')
    scans = []
    original = type(tmp_path).rglob
    def scan(path, pattern):
        scans.append(path)
        return original(path, pattern)
    monkeypatch.setattr(type(tmp_path), 'rglob', scan)
    results = await asyncio.gather(a._should_download(key), b._should_download(key))
    assert results == [False, False] and len(scans) == 1
    video.unlink()
    assert await b._should_download(key) is True
    assert len(scans) == 1
    other, api_other = _build_downloader(tmp_path)
    other._batch_media_indexes = BrowserSession().local_media_indexes
    assert await other._should_download(key) is True
    assert len(scans) == 2
    await api_a.close()
    await api_b.close()
    await api_other.close()


async def test_registered_file_uses_database_path_without_a_global_scan(tmp_path, monkeypatch):
    downloader, api = _build_downloader(tmp_path)
    db = Database(str(tmp_path / 'data.db'), download_root=str(tmp_path))
    await db.initialize()
    downloader.database = db
    key = '7346971177114611826'
    video = tmp_path / (key + '.mp4')
    video.write_bytes(b'video')
    await db.add_aweme({'aweme_id': key, 'aweme_type': 'video', 'file_path': str(video)})
    def forbidden():
        raise AssertionError('recorded media must not trigger a whole-library scan')
    monkeypatch.setattr(downloader, '_build_local_aweme_index', forbidden)
    assert await downloader._should_download(key) is False
    await db.close()
    await api.close()


async def test_volume_replacement_invalidates_the_batch_cache(tmp_path):
    root = tmp_path / 'media'
    a, api_a = _build_downloader(root)
    batch = BrowserSession().local_media_indexes
    a._batch_media_indexes = batch
    key = '7346971177114611826'
    (root / (key + '.mp4')).write_bytes(b'video')
    assert await a._should_download(key) is False
    root.rename(tmp_path / 'old-media')
    root.mkdir()
    b, api_b = _build_downloader(root)
    b._batch_media_indexes = batch
    assert await b._should_download(key) is True
    assert len(batch.entries) == 2
    await api_a.close()
    await api_b.close()


async def test_downloaded_work_is_visible_to_next_author_without_rescanning(tmp_path, monkeypatch):
    a, api_a = _build_downloader(tmp_path)
    b, api_b = _build_downloader(tmp_path)
    a._batch_media_indexes = b._batch_media_indexes = BrowserSession().local_media_indexes
    a.config.update(video=True, cover=False, avatar=False, music=False, json=False)
    key = '7346971177114611826'
    api_a.get_session = AsyncMock(return_value=object())
    async def download(_candidates, target, _session, **_kwargs):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b'video')
        return True
    monkeypatch.setattr(a, '_download_video_with_fallback', download)
    assert await a._download_aweme_assets(_video_aweme(key), 'author') is True
    def forbidden():
        raise AssertionError('next author must reuse the existing index')
    monkeypatch.setattr(b, '_build_local_aweme_index', forbidden)
    assert await b._should_download(key) is False
    await api_a.close()
    await api_b.close()
