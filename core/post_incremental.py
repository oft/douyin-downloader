"""Conservative local-file evidence for stopping an incremental post walk."""

import asyncio
import re
import stat
from pathlib import Path

import aiosqlite

from storage.library_update_state import observe_media, registered_count


class FileEvidence:
    """One verification snapshot; share directory resolution/stat work within it only."""
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.directories = {self.root: self.root}
        self.files = {}
        self.listings = {}

    def directory(self, directory):
        directory = Path(directory)
        if '..' in directory.parts:
            raise ValueError('Outside media root')
        directory.relative_to(self.root)
        if directory in self.directories:
            return self.directories[directory]
        parent = self.directory(directory.parent)
        candidate = parent / directory.name
        info = candidate.lstat()
        if stat.S_ISLNK(info.st_mode):
            candidate = candidate.resolve()
            candidate.relative_to(self.root)
            if not candidate.is_dir():
                raise OSError('Not a directory')
        elif not stat.S_ISDIR(info.st_mode):
            raise OSError('Not a directory')
        self.directories[directory] = candidate
        return candidate

    def nonempty(self, file):
        file = Path(file)
        if file not in self.files:
            try:
                canonical = self.directory(file.parent) / file.name
                info = canonical.lstat()
                if stat.S_ISLNK(info.st_mode):
                    canonical = canonical.resolve()
                    canonical.relative_to(self.root)
                    info = canonical.stat()
                self.files[file] = stat.S_ISREG(info.st_mode) and info.st_size > 0
            except (OSError, ValueError):
                self.files[file] = False
        return self.files[file]

    def children(self, directory):
        if directory not in self.listings:
            self.listings[directory] = list(self.directory(directory).iterdir())
        return self.listings[directory]


def _saved_files_complete(rows, items, root, config, *, primary_only=False, evidence=None):
    evidence = evidence or FileEvidence(root)
    root = evidence.root
    nonempty = evidence.nonempty
    image_suffixes = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.avif', '.gif'}

    for item in items:
        row = rows.get(str(item['aweme_id']))
        if not row or not row.get('file_path'):
            return False
        primary = Path(row['file_path'])
        if not primary.is_absolute():
            primary = root / primary
            if Path(row['file_path']).parts[0] == root.name and not nonempty(primary):
                primary = root.parent / row['file_path']
        if not nonempty(primary):
            return False
        stem = re.sub(r'_video$', '', primary.stem)
        if row.get('aweme_type') == 'gallery':
            stem = re.sub(r'_(?:image_)?\d+$', '', primary.stem)
            images = item.get('images')
            expected = len(images) if isinstance(images, list) else int(row.get('image_count') or 0)
            if expected <= 0:
                return False
            positions = set()
            for file in evidence.children(primary.parent):
                match = re.fullmatch(re.escape(stem) + r'_(?:image_)?(\d+)', file.stem)
                if match and file.suffix.lower() in image_suffixes and nonempty(file):
                    positions.add(int(match.group(1)))
            if not set(range(1, expected + 1)).issubset(positions):
                return False
        elif primary.suffix.lower() not in {'.mp4', '.m4v', '.mov', '.mkv', '.webm'}:
            return False
        if primary_only:
            continue
        for option, column, suffixes in (
            ('json', 'metadata_path', ['_data.json', '_result.json']),
            ('cover', 'cover_path', ['_cover' + ext for ext in image_suffixes]),
            ('avatar', 'avatar_path', ['_avatar' + ext for ext in image_suffixes]),
            ('music', None, ['_music.mp3', '_music.m4a']),
        ):
            if not config.get(option):
                continue
            stored = row.get(column) if column else None
            if stored:
                candidate = Path(stored)
                candidates = [candidate if candidate.is_absolute() else root / candidate]
            else:
                candidates = [primary.parent / (stem + suffix) for suffix in suffixes]
            if not any(nonempty(file) for file in candidates):
                return False
    return True


async def classify_local_items(downloader, items):
    """Missing files, unknown schemas or filesystem failures always keep paging."""
    database = downloader.database
    if not database or not isinstance(getattr(database, 'db_path', None), str):
        return None
    ids = [str(item.get('aweme_id') or '') for item in items]
    if not ids or not all(ids):
        return None
    try:
        # A separate read-only connection avoids coupling to either database schema variant.
        uri = Path(database.db_path).absolute().as_uri() + '?mode=ro'
        async with aiosqlite.connect(uri, uri=True) as db:
            db.row_factory = aiosqlite.Row
            rows = {}
            async with db.execute('PRAGMA table_info(aweme)') as cursor:
                columns = {row['name'] for row in await cursor.fetchall()}
            selected = [name for name in ('aweme_id', 'file_path', 'aweme_type', 'image_count',
                                          'metadata_path', 'cover_path', 'avatar_path')
                        if name in columns]
            for start in range(0, len(ids), 200):
                batch = ids[start:start + 200]
                sql = ('SELECT ' + ','.join(selected) + ' FROM aweme WHERE aweme_id IN ('
                       + ','.join('?' for _ in batch) + ')')
                async with db.execute(sql, batch) as cursor:
                    rows.update((str(row['aweme_id']), dict(row)) for row in await cursor.fetchall())
        root = getattr(database, 'download_root', None) or downloader.config.get('path', './Downloaded')
        observations = {}
        result = await asyncio.get_running_loop().run_in_executor(
            None, _classify_files, rows, items, root, downloader.config, observations)
        if downloader.config.get('library_update_tracking', False):
            await observe_media(database, observations)
        return result
    except (OSError, ValueError, TypeError, aiosqlite.Error):
        return None


def _classify_files(rows, items, root, config, observations=None):
    evidence = FileEvidence(root)
    saved = {str(item['aweme_id']) for item in items
             if _saved_files_complete(rows, [item], root, config, primary_only=True, evidence=evidence)}
    known = {key for key, row in rows.items() if row.get('file_path')}
    if observations is not None:
        for key, row in rows.items():
            stored = row.get('file_path')
            file = Path(stored) if stored else None
            if file is not None and not file.is_absolute():
                file = evidence.root / file
                if Path(stored).parts[0] == evidence.root.name and not evidence.nonempty(file):
                    file = evidence.root.parent / stored
            observations[key] = (bool(file is not None and evidence.nonempty(file)), key in saved)
    return saved, known


async def page_is_saved(downloader, items):
    # These outputs have their own backfill policy; retain the normal walk for them.
    for option in ('comments', 'transcript'):
        settings = downloader.config.get(option) or {}
        if not isinstance(settings, dict) or settings.get('enabled'):
            return False
    classified = await classify_local_items(downloader, items)
    return bool(items) and classified is not None and all(
        str(item.get('aweme_id') or '') in classified[0] for item in items)


async def saved_author_count(downloader, sec_uid, uid=''):
    """Count distinct saved works for this author, never metadata rows or file copies."""
    database = downloader.database
    if not database or not isinstance(getattr(database, 'db_path', None), str):
        return None
    try:
        if downloader.config.get('library_update_tracking', False):
            return await registered_count(database, str(sec_uid), str(uid) if uid else '')
        uri = Path(database.db_path).absolute().as_uri() + '?mode=ro'
        async with aiosqlite.connect(uri, uri=True) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute('PRAGMA table_info(aweme)') as cursor:
                columns = {row['name'] for row in await cursor.fetchall()}
            selected = [name for name in ('aweme_id', 'file_path', 'aweme_type', 'image_count',
                                          'metadata_path', 'cover_path', 'avatar_path') if name in columns]
            predicates, values = [], []
            for column, value in (('author_sec_uid', sec_uid), ('author_id', uid)):
                if column in columns and value:
                    predicates.append(column + '=?')
                    values.append(str(value))
            if not predicates:
                return None
            sql = ('SELECT ' + ','.join(selected) + ' FROM aweme WHERE ('
                   + ' OR '.join(predicates) + ") AND COALESCE(file_path, '')<>''")
            async with db.execute(sql, values) as cursor:
                rows = {str(row['aweme_id']): dict(row) for row in await cursor.fetchall()}
        root = getattr(database, 'download_root', None) or downloader.config.get('path', './Downloaded')
        return await asyncio.get_running_loop().run_in_executor(
            None, _count_saved_author_files, rows, root, downloader.config)
    except (OSError, ValueError, TypeError, aiosqlite.Error):
        return None


def _count_saved_author_files(rows, root, config):
    evidence = FileEvidence(root)
    return sum(_saved_files_complete(rows, [{'aweme_id': key}], root, config,
                                     primary_only=True, evidence=evidence) for key in rows)
