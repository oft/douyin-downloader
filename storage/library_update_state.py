"""Library-only manifests and bounded historical reconciliation state."""
import asyncio
import time

KEY = "CASE WHEN COALESCE({p}.author_sec_uid,'')<>'' THEN 'sec:'||{p}.author_sec_uid WHEN COALESCE({p}.author_id,'')<>'' THEN 'uid:'||{p}.author_id ELSE '' END"
PRESENT = "CASE WHEN COALESCE({p}.file_path,'')<>'' AND {p}.aweme_type IN ('video','gallery') THEN 1 ELSE 0 END"
TABLES = [
    """CREATE TABLE IF NOT EXISTS library_media_state (
        aweme_id TEXT PRIMARY KEY, author_key TEXT NOT NULL, file_path TEXT,
        aweme_type TEXT, expected_images INTEGER, present INTEGER NOT NULL,
        complete INTEGER, checked_us INTEGER NOT NULL DEFAULT 0)""",
    "CREATE INDEX IF NOT EXISTS idx_library_media_author ON library_media_state(author_key,present)",
    """CREATE TABLE IF NOT EXISTS library_author_counts (
        author_key TEXT PRIMARY KEY, present_works INTEGER NOT NULL DEFAULT 0,
        complete_works INTEGER NOT NULL DEFAULT 0)""",
    """CREATE TABLE IF NOT EXISTS library_post_audit (
        scope TEXT PRIMARY KEY, sec_uid TEXT, author TEXT, homepage_total INTEGER,
        registered_count INTEGER, remaining_gap INTEGER, pages INTEGER NOT NULL DEFAULT 0,
        received INTEGER NOT NULL DEFAULT 0, new_works INTEGER NOT NULL DEFAULT 0,
        repair_works INTEGER NOT NULL DEFAULT 0, oldest_time INTEGER,
        status TEXT NOT NULL DEFAULT 'running', reason TEXT NOT NULL DEFAULT '',
        auto_checked INTEGER NOT NULL DEFAULT 0, checked_gap INTEGER, retry_requested INTEGER NOT NULL DEFAULT 0,
        updated_us INTEGER NOT NULL)""",
]


def statements():
    result = list(TABLES)
    for suffix, event, prefix, sign in [('insert', 'INSERT', 'NEW', 1), ('delete', 'DELETE', 'OLD', -1)]:
        change = """INSERT INTO library_author_counts VALUES ({p}.author_key,{s}*{p}.present,{s}*CASE WHEN {p}.complete=1 THEN {p}.present ELSE 0 END)
        ON CONFLICT(author_key) DO UPDATE SET present_works=present_works+excluded.present_works,
        complete_works=complete_works+excluded.complete_works;""".format(p=prefix, s=sign)
        result.append('CREATE TRIGGER IF NOT EXISTS library_media_' + suffix + ' AFTER ' + event + ' ON library_media_state BEGIN ' + change + ' END')
    result.append("""CREATE TRIGGER IF NOT EXISTS library_media_update AFTER UPDATE ON library_media_state BEGIN
        INSERT INTO library_author_counts VALUES (OLD.author_key,-OLD.present,-CASE WHEN OLD.complete=1 THEN OLD.present ELSE 0 END)
        ON CONFLICT(author_key) DO UPDATE SET present_works=present_works+excluded.present_works,complete_works=complete_works+excluded.complete_works;
        INSERT INTO library_author_counts VALUES (NEW.author_key,NEW.present,CASE WHEN NEW.complete=1 THEN NEW.present ELSE 0 END)
        ON CONFLICT(author_key) DO UPDATE SET present_works=present_works+excluded.present_works,complete_works=complete_works+excluded.complete_works;
        END""")
    for suffix, event in [('insert', 'INSERT'), ('update', 'UPDATE')]:
        result.append(("""CREATE TRIGGER IF NOT EXISTS library_aweme_{suffix} AFTER {event} ON aweme BEGIN
            INSERT INTO library_media_state(aweme_id,author_key,file_path,aweme_type,expected_images,present)
            VALUES(NEW.aweme_id,{key},NEW.file_path,NEW.aweme_type,COALESCE(NEW.image_count,0),{present})
            ON CONFLICT(aweme_id) DO UPDATE SET author_key=excluded.author_key,
            present=CASE WHEN COALESCE(library_media_state.file_path,'')=COALESCE(excluded.file_path,'') AND library_media_state.aweme_type=excluded.aweme_type THEN library_media_state.present ELSE excluded.present END,
            complete=CASE WHEN COALESCE(library_media_state.file_path,'')=COALESCE(excluded.file_path,'') AND library_media_state.expected_images=excluded.expected_images AND library_media_state.aweme_type=excluded.aweme_type THEN library_media_state.complete ELSE NULL END,
            checked_us=CASE WHEN COALESCE(library_media_state.file_path,'')=COALESCE(excluded.file_path,'') THEN library_media_state.checked_us ELSE 0 END,
            file_path=excluded.file_path,aweme_type=excluded.aweme_type,expected_images=excluded.expected_images;
            END""").format(suffix=suffix, event=event, key=KEY.format(p='NEW'), present=PRESENT.format(p='NEW')))
    result.append('CREATE TRIGGER IF NOT EXISTS library_aweme_delete AFTER DELETE ON aweme BEGIN DELETE FROM library_media_state WHERE aweme_id=OLD.aweme_id; END')
    result.append(("""INSERT OR IGNORE INTO library_media_state(aweme_id,author_key,file_path,aweme_type,expected_images,present)
        SELECT a.aweme_id,{key},a.file_path,a.aweme_type,COALESCE(a.image_count,0),{present} FROM aweme a""").format(key=KEY.format(p='a'), present=PRESENT.format(p='a')))
    return result


async def ensure_library_state(database):
    if getattr(database, '_library_state_ready', False):
        return
    if not hasattr(database, '_library_state_lock'):
        database._library_state_lock = asyncio.Lock()
    async with database._library_state_lock:
        if getattr(database, '_library_state_ready', False):
            return
        async with database._write_transaction() as db:
            await db.execute('BEGIN IMMEDIATE')
            for sql in statements():
                await db.execute(sql)
            columns = {row[1] for row in await db.execute_fetchall(
                'PRAGMA table_info(library_post_audit)')}
            if 'checked_gap' not in columns:
                await db.execute('ALTER TABLE library_post_audit ADD COLUMN checked_gap INTEGER')
        database._library_state_ready = True


def ensure_library_state_sync(db):
    try:
        db.execute('BEGIN IMMEDIATE')
        for sql in statements():
            db.execute(sql)
        columns = {row[1] for row in db.execute('PRAGMA table_info(library_post_audit)')}
        if 'checked_gap' not in columns:
            db.execute('ALTER TABLE library_post_audit ADD COLUMN checked_gap INTEGER')
        db.commit()
    except BaseException:
        db.rollback()
        raise


async def registered_count(database, sec_uid, uid=''):
    await ensure_library_state(database)
    db = await database._get_conn()
    rows = await db.execute_fetchall(
        'SELECT COALESCE(SUM(present_works),0) FROM library_author_counts WHERE author_key IN (?,?)',
        ('sec:' + sec_uid, 'uid:' + uid if uid else ''))
    return rows[0][0]


async def observe_media(database, observations):
    """Record page-local checks; never erase metadata/history for missing files."""
    if not observations:
        return
    await ensure_library_state(database)
    now = time.time_ns() // 1000
    async with database._write_transaction() as db:
        await db.executemany(
            'UPDATE library_media_state SET present=?,complete=?,checked_us=? WHERE aweme_id=?',
            [(int(present), int(complete), now, key)
             for key, (present, complete) in observations.items()])


class PostAudit:
    def __init__(self, database, scope, sec_uid, author):
        self.database, self.scope, self.sec_uid, self.author = database, scope, sec_uid, author

    async def previous(self):
        await ensure_library_state(self.database)
        db = await self.database._get_conn()
        rows = await db.execute_fetchall(
            'SELECT homepage_total,registered_count,auto_checked,retry_requested,status,checked_gap '
            'FROM library_post_audit WHERE scope=?', (self.scope,))
        return dict(zip(('total', 'registered', 'checked', 'retry', 'status', 'gap'), rows[0])) if rows else None

    async def save(self, *, total, registered, pages, received, new, repair, oldest, status, reason='', checked=False):
        gap = max(0, total - registered) if total is not None and registered is not None else None
        baseline = gap if checked and status not in ('running', 'interrupted') else None
        sql = """INSERT INTO library_post_audit(scope,sec_uid,author,homepage_total,registered_count,remaining_gap,pages,received,new_works,repair_works,oldest_time,status,reason,auto_checked,checked_gap,retry_requested,updated_us)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(scope) DO UPDATE SET
            homepage_total=excluded.homepage_total,registered_count=excluded.registered_count,remaining_gap=excluded.remaining_gap,
            author=excluded.author,pages=excluded.pages,received=excluded.received,new_works=excluded.new_works,repair_works=excluded.repair_works,
            oldest_time=CASE WHEN oldest_time IS NULL THEN excluded.oldest_time WHEN excluded.oldest_time IS NULL THEN oldest_time ELSE MIN(oldest_time,excluded.oldest_time) END,
            status=excluded.status,reason=excluded.reason,auto_checked=excluded.auto_checked,
            checked_gap=CASE WHEN excluded.auto_checked=1 AND excluded.status NOT IN ('running','interrupted') THEN excluded.checked_gap ELSE library_post_audit.checked_gap END,
            updated_us=excluded.updated_us"""
        async with self.database._write_transaction() as db:
            await db.execute(
                sql, (self.scope, self.sec_uid, self.author, total, registered, gap, pages, received,
                      new, repair, oldest, status, reason[:1000], int(checked), baseline,
                      time.time_ns() // 1000))

    async def retry(self, requested):
        async with self.database._write_transaction() as db:
            await db.execute('UPDATE library_post_audit SET retry_requested=? WHERE scope=?',
                             (int(requested), self.scope))
