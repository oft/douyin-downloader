"""Batch-scoped filesystem fallback for legacy or moved media."""

import asyncio
import sqlite3
from pathlib import Path

from utils.legacy_names import LegacyNameIndex


class LocalMediaIndexes:
    def __init__(self):
        self.entries = {}
        self.locks = {}

    async def get(self, root, build, on_build=None):
        identity = await asyncio.get_running_loop().run_in_executor(None, root_identity, root)
        lock = self.locks.setdefault(identity, asyncio.Lock())
        async with lock:
            if identity in self.entries:
                return self.entries[identity], True
            if on_build is not None:
                on_build()
            value = await asyncio.get_running_loop().run_in_executor(None, build)
            # Do not publish an index if the external volume changed during traversal.
            current = await asyncio.get_running_loop().run_in_executor(None, root_identity, root)
            if current != identity:
                raise OSError('媒体根目录在扫描期间发生变化，请重新启动更新')
            self.entries[identity] = value
            return value, False


def root_identity(root):
    root = Path(root).resolve()
    info = root.stat()
    return str(root), info.st_dev, info.st_ino


def nonempty_media(file, root):
    try:
        file = Path(file)
        file.resolve().relative_to(Path(root).resolve())
        return file.is_file() and file.stat().st_size > 0
    except (OSError, ValueError):
        return False


async def registered_media_exists(database, aweme_id, root):
    # Real database implementations own this connection; no new connection per work.
    if (not isinstance(getattr(database, 'db_path', None), str)
            or not callable(getattr(database, '_get_conn', None))):
        return False
    try:
        db = await database._get_conn()
        # Finish this read in one SQLite thread operation. An open cursor on
        # the write connection could pin a snapshot while the queue commits.
        rows = await db.execute_fetchall(
            'SELECT file_path FROM aweme WHERE aweme_id=?', (aweme_id,))
        if not rows or not rows[0][0]:
            return False
        return await asyncio.get_running_loop().run_in_executor(
            None, _registered_media_exists, rows[0][0], aweme_id, root)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        return False


def _registered_media_exists(stored, aweme_id, root):
    root = Path(root).resolve()
    file = Path(stored)
    if not file.is_absolute():
        file = root / file
        if not file.exists() and Path(stored).parts[0] == root.name:
            file = root.parent / stored
    candidates = file.iterdir() if file.is_dir() else [file]
    for candidate in candidates:
        if candidate != file and aweme_id not in candidate.name:
            continue
        if (candidate.suffix.lower() in {'.mp4', '.m4v', '.mov', '.mkv', '.webm', '.jpg', '.jpeg',
                                        '.png', '.webp', '.heic', '.heif', '.avif', '.gif'}
                and not candidate.stem.lower().endswith(('_cover', '_avatar', '_music'))
                and not candidate.name.startswith('._') and nonempty_media(candidate, root)):
            return True
    return False


def cached_media_exists(aweme_id, paths, legacy_paths, publish_date, title, root):
    if any(nonempty_media(file, root) for file in paths.get(aweme_id, [])):
        return True
    legacy = LegacyNameIndex()
    for file in legacy_paths.get(publish_date, []):
        if nonempty_media(file, root):
            legacy.add(file.stem)
    return legacy.matches(publish_date, title, aweme_id)
