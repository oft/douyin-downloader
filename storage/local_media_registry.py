"""Explicit filesystem reconciliation; normal downloads only read recorded paths."""
import asyncio
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from utils.legacy_names import LegacyNameIndex, legacy_name_keys

MEDIA_SUFFIXES = {'.mp4', '.m4v', '.mov', '.mkv', '.webm', '.jpg', '.jpeg', '.png',
                  '.webp', '.heic', '.heif', '.avif', '.gif'}
ID_PATTERN = re.compile(r'(?<!\d)(?:\d{15,20}|local-[a-f0-9]{32})(?!\d)')


class ScanCancelled(Exception):
    pass


def identity(root):
    root = Path(root).resolve(strict=True)
    info = root.stat()
    return str(root), str(info.st_dev), str(info.st_ino)


def valid_file(root, stored):
    try:
        file = Path(stored)
        if not file.is_absolute():
            file = Path(root) / file
        file.resolve().relative_to(Path(root))
        return file.is_file() and file.stat().st_size > 0
    except (OSError, ValueError):
        return False


async def recorded_media_path(database, aweme_id, root, publish_date='', title=''):
    """Read the last manual snapshot. Never enumerate folders or create its schema."""
    if not isinstance(getattr(database, 'db_path', None), str) or not callable(getattr(database, '_get_conn', None)):
        return None
    try:
        scope = await asyncio.get_running_loop().run_in_executor(None, identity, root)
        db = await database._get_conn()
        cached = getattr(database, '_manual_file_registry_scope', None)
        if cached is None or cached[0] != scope:
            async with db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_local_media_roots'") as cursor:
                exists = await cursor.fetchone()
            matched = False
            if exists:
                async with db.execute('SELECT device, inode FROM library_local_media_roots WHERE root=?', (scope[0],)) as cursor:
                    row = await cursor.fetchone()
                matched = bool(row and tuple(row) == scope[1:])
            database._manual_file_registry_scope = scope, matched
        if not database._manual_file_registry_scope[1]:
            return None
        async with db.execute('SELECT relative_path FROM library_local_media_files WHERE root=? AND aweme_id=?',
                              (scope[0], aweme_id)) as cursor:
            direct = await cursor.fetchall()
        legacy = []
        if not direct and publish_date and title:
            async with db.execute("SELECT relative_path FROM library_local_media_files WHERE root=? AND aweme_id='' AND legacy_date=?",
                                  (scope[0], publish_date)) as cursor:
                legacy = await cursor.fetchall()
        def find():
            for row in direct:
                if valid_file(scope[0], row[0]):
                    return row[0]
            for row in legacy:
                index = LegacyNameIndex()
                index.add(Path(row[0]).stem)
                if index.matches(publish_date, title, aweme_id) and valid_file(scope[0], row[0]):
                    return row[0]
            return None
        return await asyncio.get_running_loop().run_in_executor(None, find)
    except (OSError, ValueError, sqlite3.Error):
        return None


def scan_local_media(database_path, root, progress=lambda *_args: None, cancelled=lambda: False):
    """Manual maintenance subprocess only. Publish atomically; never delete user data."""
    scope = identity(root)
    root = Path(scope[0])
    uri = Path(database_path).absolute().as_uri() + '?mode=rw'
    db = sqlite3.connect(uri, uri=True)
    entries = files = unidentified = 0
    by_id, observed, sidecars = {}, set(), {}
    try:
        db.execute('PRAGMA busy_timeout=3000')
        from storage.library_update_state import ensure_library_state_sync
        ensure_library_state_sync(db)
        db.execute('CREATE TEMP TABLE scan_files (aweme_id TEXT, relative_path TEXT, legacy_date TEXT)')
        batch = []
        def check_cancelled():
            if cancelled():
                raise ScanCancelled()
        def fail(error):
            raise error
        for directory, directories, names in os.walk(root, followlinks=False, onerror=fail):
            check_cancelled()
            entries += len(directories)
            progress(entries, files)
            for name in names:
                check_cancelled()
                entries += 1
                if entries % 5000 == 0:
                    progress(entries, files)
                file = Path(directory) / name
                sidecar = ('metadata_path' if file.suffix.lower() == '.json' and file.stem.lower().endswith(('_result', '_data'))
                           else 'cover_path' if file.stem.lower().endswith('_cover') and file.suffix.lower() in MEDIA_SUFFIXES
                           else 'avatar_path' if file.stem.lower().endswith('_avatar') and file.suffix.lower() in MEDIA_SUFFIXES else None)
                primary = file.suffix.lower() in MEDIA_SUFFIXES and not file.stem.lower().endswith(('_cover', '_avatar', '_music'))
                if name.startswith('._') or not (sidecar or primary):
                    continue
                if file.is_symlink() or not file.is_file() or file.stat().st_size <= 0:
                    continue
                relative = file.relative_to(root).as_posix()
                identifiers = set(ID_PATTERN.findall(name))
                if len(identifiers) > 1:
                    identifiers = set()  # Ambiguous names must not reassign another work's path.
                if sidecar:
                    for key in identifiers:
                        sidecars.setdefault(key, {}).setdefault(sidecar, []).append(relative)
                    continue
                files += 1
                observed.add(relative)
                for key in identifiers:
                    batch.append((key, relative, ''))
                    by_id.setdefault(key, []).append(relative)
                if not identifiers:
                    dates = {date for date, _title in legacy_name_keys(file.stem)}
                    batch.extend(('', relative, date) for date in dates)
                    if not dates:
                        unidentified += 1
                if len(batch) >= 1000:
                    db.executemany('INSERT INTO scan_files VALUES (?, ?, ?)', batch)
                    batch.clear()
        check_cancelled()
        if identity(root) != scope:
            raise OSError('扫描期间媒体磁盘已变更，保留原扫描结果')
        if batch:
            db.executemany('INSERT INTO scan_files VALUES (?, ?, ?)', batch)
        db.execute('CREATE TABLE IF NOT EXISTS library_local_media_roots (root TEXT PRIMARY KEY, device TEXT, inode TEXT, scanned_at TEXT, entries INTEGER, files INTEGER)')
        db.execute('CREATE TABLE IF NOT EXISTS library_local_media_files (root TEXT, aweme_id TEXT, relative_path TEXT, legacy_date TEXT, PRIMARY KEY(root, aweme_id, relative_path, legacy_date))')
        db.execute('CREATE INDEX IF NOT EXISTS idx_local_media_date ON library_local_media_files(root, legacy_date, aweme_id)')
        db.execute('CREATE TABLE IF NOT EXISTS library_local_media_repairs (scanned_at TEXT, aweme_id TEXT, path_column TEXT, previous_path TEXT, new_path TEXT)')
        db.execute('DELETE FROM library_local_media_files WHERE root=?', (scope[0],))
        db.execute('INSERT INTO library_local_media_files SELECT ?, aweme_id, relative_path, legacy_date FROM scan_files', (scope[0],))
        repaired, repaired_paths, known = 0, 0, set()
        scanned_at = datetime.now(timezone.utc).isoformat()
        columns = {row[1] for row in db.execute('PRAGMA table_info(aweme)')}
        path_columns = [column for column in ('file_path', 'metadata_path', 'cover_path', 'avatar_path') if column in columns]
        rows = db.execute('SELECT aweme_id,' + ','.join(path_columns) + ' FROM aweme').fetchall()
        for row in rows:
            check_cancelled()
            key, stored_paths = str(row[0]), dict(zip(path_columns, row[1:]))
            known.add(key)
            candidates = by_id.get(key)
            if not candidates:
                continue
            changed = False
            preferred_directory = None
            for column in path_columns:
                stored = stored_paths[column]
                choices = candidates if column == 'file_path' else sidecars.get(key, {}).get(column, [])
                if not choices:
                    continue
                try:
                    current = Path(stored) if stored else None
                    if current is not None and not current.is_absolute():
                        current = root / current
                    relative = current.relative_to(root).as_posix() if current is not None else None
                    present = relative in observed or bool(stored and valid_file(root, stored))
                    if present or (column == 'file_path' and relative and any(p.startswith(relative.rstrip('/') + '/') for p in candidates)):
                        if column == 'file_path':
                            preferred_directory = str(Path(relative).parent) if relative in observed else relative
                        continue
                except ValueError:
                    pass
                replacement = sorted(choices, key=lambda p: (preferred_directory is not None and str(Path(p).parent) != preferred_directory,
                                     Path(p).suffix.lower() not in {'.mp4', '.mov', '.mkv', '.webm', '.m4v'}, p))[0]
                result = db.execute("UPDATE aweme SET " + column + "=? WHERE aweme_id=? AND COALESCE(" + column + ",'')=?", (replacement, key, stored or ''))
                if result.rowcount:
                    changed = True
                    repaired_paths += result.rowcount
                    db.execute('INSERT INTO library_local_media_repairs VALUES (?, ?, ?, ?, ?)', (scanned_at, key, column, stored, replacement))
                if column == 'file_path':
                    preferred_directory = str(Path(replacement).parent)
            repaired += changed
        check_cancelled()
        for key, stored, kind, expected in db.execute('SELECT aweme_id,file_path,aweme_type,COALESCE(image_count,0) FROM aweme').fetchall():
            check_cancelled()
            present = bool(kind in ('video', 'gallery') and stored and valid_file(root, stored))
            if kind in ('video', 'gallery') and stored and not present:
                try:
                    relative = Path(stored).relative_to(root).as_posix() if Path(stored).is_absolute() else stored
                    present = any(p.startswith(relative.rstrip('/') + '/') for p in by_id.get(str(key), []))
                except ValueError:
                    pass
            complete = None
            if not present:
                complete = 0
            elif kind != 'gallery':
                complete = 1
            elif expected > 0:
                stem = re.sub(r'_(?:image_)?\d+$', '', Path(stored).stem)
                positions = set()
                for candidate in by_id.get(str(key), []):
                    match = re.fullmatch(re.escape(stem) + r'_(?:image_)?(\d+)', Path(candidate).stem)
                    if match and Path(candidate).suffix.lower() in MEDIA_SUFFIXES - {'.mp4', '.mov', '.mkv', '.webm', '.m4v'}:
                        positions.add(int(match.group(1)))
                complete = int(set(range(1, expected + 1)).issubset(positions))
            db.execute('UPDATE library_media_state SET present=?,complete=?,checked_us=? WHERE aweme_id=?',
                       (int(present), complete, int(datetime.now(timezone.utc).timestamp() * 1000000), key))
        db.execute('INSERT OR REPLACE INTO library_local_media_roots VALUES (?, ?, ?, ?, ?, ?)', (*scope, scanned_at, entries, files))
        db.commit()
        progress(entries, files)
        return dict(scannedAt=scanned_at, entries=entries, files=files, works=len(by_id),
                    repairedWorks=repaired, repairedPaths=repaired_paths, unregisteredWorks=len(set(by_id) - known), unidentifiedFiles=unidentified)
    finally:
        db.close()  # An interruption rolls back the unpublished snapshot and repairs.
