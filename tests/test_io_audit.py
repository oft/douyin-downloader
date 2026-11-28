"""Use isolated processes: tracing must not monkeypatch the pytest host."""
import json
import os
import subprocess
import sys
from pathlib import Path


def test_real_async_files_sqlite_network_errors_and_redaction(tmp_path):
    script = r'''
import asyncio, json, sqlite3, sys
from pathlib import Path
from utils.io_audit import install
root = Path(sys.argv[1])
audit = install(root / 'logs', role='test')
secret = 'secret-payload-cookie-token'
async def main():
    import aiofiles
    import aiosqlite
    import httpx
    import urllib.request
    from aiohttp import ClientSession, ClientTimeout, web
    async with aiofiles.open(root / 'sample', 'w') as file:
        await file.write(secret)
    async with aiofiles.open(root / 'sample') as file:
        assert await file.read() == secret
    async with aiosqlite.connect(str(root / 'sample.db')) as db:
        await db.execute('CREATE TABLE data (value TEXT)')
        await db.execute('INSERT INTO data VALUES (?)', (secret,))
        await db.commit()
        await db.execute('INSERT INTO data VALUES (?)', ('rollback',))
        await db.rollback()
        async with db.execute('SELECT value FROM data') as cursor:
            assert await cursor.fetchall() == [(secret,)]
    try:
        (root / 'missing').stat()
    except FileNotFoundError:
        pass
    app = web.Application()
    async def echo(request):
        assert request.headers['Authorization'] == 'Bearer ' + secret
        return web.Response(text=await request.text())
    async def redirect(request):
        raise web.HTTPFound('/echo?secret=' + secret)
    async def slow(request):
        await asyncio.sleep(.1)
        return web.Response(text='late')
    app.router.add_post('/echo', echo)
    app.router.add_get('/redirect', redirect)
    app.router.add_get('/echo', lambda request: web.Response(text='redirected'))
    app.router.add_get('/slow', slow)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    url = 'http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1])
    try:
        async with ClientSession() as session:
            async with session.post(url + '/echo?token=' + secret,
                                    data=secret, headers={'Authorization': 'Bearer ' + secret}) as response:
                assert await response.text() == secret
            async with session.get(url + '/redirect') as response:
                assert await response.text() == 'redirected'
            try:
                await session.get(url + '/slow', timeout=ClientTimeout(total=.01))
            except asyncio.TimeoutError:
                pass
            else:
                raise AssertionError('Timeout disappeared')
        async with httpx.AsyncClient() as session:
            response = await session.get(url + '/redirect', follow_redirects=True)
            assert response.text == 'redirected'
        def synchronous_requests():
            with urllib.request.urlopen(url + '/echo?cookie=' + secret) as response:
                assert response.read() == b'redirected'
            with httpx.Client() as client:
                assert client.get(url + '/echo?token=' + secret).text == 'redirected'
        await asyncio.to_thread(synchronous_requests)
    finally:
        await runner.cleanup()
try:
    asyncio.run(main())
finally:
    audit.close()
'''
    env = dict(os.environ, LIBRARY_IO_AUDIT='1')
    completed = subprocess.run([sys.executable, '-c', script, str(tmp_path)],
                               cwd=Path(__file__).resolve().parents[1], env=env,
                               capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    files = list((tmp_path / 'logs').glob('*.jsonl'))
    text = ''.join(file.read_text() for file in files)
    assert 'secret-payload-cookie-token' not in text and 'Bearer ' not in text
    events = [json.loads(line) for line in text.splitlines()]
    begins = {event['id']: event for event in events if event['event'] == 'begin'}
    ends = {event['id']: event for event in events if event['event'] in ('end', 'error')}
    assert set(begins) == set(ends)
    assert {'filesystem', 'database', 'network'} <= {event['category'] for event in begins.values()}
    assert any(event['operation'] == 'write' and event['target'].endswith('/sample') for event in begins.values())
    assert any(event['operation'] == 'read' and event['target'].endswith('/sample') for event in begins.values())
    assert any(event['operation'] == 'rollback' for event in begins.values())
    assert any(event['operation'] == 'urllib.GET' for event in begins.values())
    assert any(event['operation'] == 'httpx.GET' for event in begins.values())
    assert any(event.get('error') == 'FileNotFoundError' for event in ends.values())
    assert any('Timeout' in event.get('error', '') for event in ends.values())
    assert any(event['event'] == 'redirect' for event in events)
    assert all((file.stat().st_mode & 0o777) == 0o600 for file in files)


def test_disabled_trace_does_not_create_directory(tmp_path, monkeypatch):
    from utils.io_audit import install
    monkeypatch.setenv('LIBRARY_IO_AUDIT', '0')
    assert install(tmp_path / 'unused') is None
    assert not (tmp_path / 'unused').exists()


def test_rotation_keeps_every_paired_operation(tmp_path):
    from utils.io_audit import IOAudit
    audit = IOAudit(tmp_path, rotate_bytes=700)
    for _ in range(1000):
        span = audit.begin('test', 'operation', '/test')
        audit.end(span)
    audit.close()
    files = list(tmp_path.glob('*.jsonl'))
    assert len(files) > 1
    events = [json.loads(line) for file in files for line in file.read_text().splitlines()]
    assert len([event for event in events if event['event'] == 'begin']) == 1000
    assert len([event for event in events if event['event'] == 'end']) == 1000


def test_analyzer_pairs_rotation_files_and_reports_errors_truncated_and_pending(tmp_path, monkeypatch):
    import importlib.util
    file = Path(__file__).resolve().parents[1] / 'apps/admin/scripts/analyze-io.py'
    monkeypatch.syspath_prepend(str(file.parent))
    spec = importlib.util.spec_from_file_location('analyze_io', file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    begin = {'event': 'begin', 'id': '1', 'category': 'filesystem', 'operation': 'read', 'time': '2026-11-26'}
    (tmp_path / 'session-0000.jsonl').write_text(json.dumps(begin) + '\n')
    rows = [{'event': 'error', 'id': '1', 'elapsedMs': 123, 'error': 'OSError'},
            {**begin, 'id': '2'}]
    (tmp_path / 'session-0001.jsonl').write_text('\n'.join(json.dumps(row) for row in rows) + '\n{"event":')
    result = module.analyze(list(tmp_path.glob('*.jsonl')))
    assert result['unpairedCount'] == 1 and result['unpaired'][0]['id'] == '2'
    assert result['operations'][0]['errors'] == 1
    assert result['slowest'][0]['elapsedMs'] == 123
    assert result['malformedLines'] == 1


def test_span_keeps_start_author_and_labels_expected_errors_without_losing_events(tmp_path):
    from utils.io_audit import IOAudit
    audit = IOAudit(tmp_path)
    audit.context = {'author': '作者A', 'index': 1}
    span = audit.begin('filesystem', 'stat', '/missing')
    audit.context = {'author': '作者B', 'index': 2}
    audit.end(span, FileNotFoundError())
    other = audit.begin('browser_network', 'GET', 'chrome-extension://invalid/')
    audit.end(other, OSError(), errorCode='net::ERR_FAILED')
    audit.close()
    events = [json.loads(line) for file in tmp_path.glob('*.jsonl') for line in file.read_text().splitlines()]
    ending = next(row for row in events if row.get('id') == span[0] and row['event'] == 'error')
    assert ending['author'] == '作者A' and ending['index'] == 1
    assert ending['expected'] and ending['outcome'] == 'path_not_found'
    assert next(row for row in events if row.get('id') == other[0] and row['event'] == 'error')['outcome'] == 'invalid_extension_probe'


def test_analyzer_uses_begin_author_and_separates_legacy_expected_errors(tmp_path, monkeypatch):
    import importlib.util
    source = Path(__file__).resolve().parents[1] / 'apps/admin/scripts/analyze-io.py'
    monkeypatch.syspath_prepend(str(source.parent))
    spec = importlib.util.spec_from_file_location('analyze_io_expected', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = [{'event': 'begin', 'id': '1', 'category': 'filesystem', 'operation': 'stat',
             'target': '/absent', 'author': '作者A'},
            {'event': 'error', 'id': '1', 'error': 'FileNotFoundError', 'elapsedMs': 1, 'author': '作者B'}]
    file = tmp_path / 'session-0000.jsonl'
    file.write_text('\n'.join(json.dumps(row) for row in rows))
    report = module.analyze([file])
    assert report['operations'][0]['errors'] == 0
    assert report['operations'][0]['expectedErrors'] == 1
    assert report['recentExpectedResults'][0]['author'] == '作者A'
    assert report['recentExpectedResults'][0]['endedDuringAuthor'] == '作者B'
