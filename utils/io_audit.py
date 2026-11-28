"""Process-local I/O diagnostics. Never records payloads, credentials or SQL values."""
import atexit
import contextvars
import datetime
import functools
import hashlib
import inspect
import io
import itertools
import json
import os
import queue
import re
import sqlite3
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

_current = None
_parent = contextvars.ContextVar('io_audit_parent', default=None)
_FILE_METHODS = frozenset(('read', 'read1', 'readinto', 'readinto1', 'readline', 'readlines',
                           'write', 'writelines', 'flush', 'truncate', 'seek', 'close', '__next__'))


def safe_target(value):
    if isinstance(value, int):
        return 'fd:{}'.format(value)
    try:
        text = os.fsdecode(value)
    except (TypeError, ValueError):
        if type(value).__module__.startswith('yarl'):
            text = str(value)
        else:
            return '<unknown>'
    text = text.split('?', 1)[0].split('#', 1)[0]
    if text.lower().startswith(('data:', 'javascript:')):
        return text.split(':', 1)[0] + ':<redacted>'
    if '://' in text:
        try:
            parsed = urlsplit(text)
            host = parsed.hostname or ''
            if ':' in host:
                host = '[' + host + ']'
            port = ':' + str(parsed.port) if parsed.port is not None else ''
            return urlunsplit((parsed.scheme, host + port, parsed.path, '', ''))[:2048]
        except ValueError:
            return '<invalid-url>'
    return text[:2048]


def sql_fields(sql):
    # Hash the template, never interpolated parameters or expanded trace callbacks.
    text = sql if isinstance(sql, str) else ''
    word = re.match(r'\s*(?:/\*.*?\*/\s*)*([a-z]+)', text, flags=re.I | re.S)
    return {'statement': word.group(1).upper() if word else 'SQL',
            'queryHash': hashlib.sha256(text.encode()).hexdigest()[:16]}


def operation_outcome(category, operation, target, error='', error_code=''):
    """Label expected low-level results without removing their raw error events."""
    if category == 'filesystem' and error in ('FileNotFoundError', 'ENOENT') and operation in ('stat', 'lstat', 'access', 'statSync', 'lstatSync', 'accessSync'):
        return 'path_not_found', True
    if category == 'filesystem' and error in ('FileExistsError', 'EEXIST') and operation in ('mkdir', 'mkdirSync'):
        return 'already_exists', True
    if category == 'browser_network' and target.startswith('chrome-extension://invalid'):
        return 'invalid_extension_probe', True
    if error_code == 'net::ERR_ABORTED':
        return 'request_aborted', True
    if error in ('CancelledError', 'GeneratorExit'):
        return 'cancelled', True
    return 'failed', False


def safe_error_code(error):
    text = str(error)
    match = re.search(r'net::[A-Z0-9_]+', text)
    if match:
        return match.group(0)
    for marker, code in [('Execution context was destroyed', 'execution_context_destroyed'),
                         ('Target page, context or browser has been closed', 'browser_target_closed'),
                         ('Cannot find context', 'execution_context_missing'),
                         ('Timeout', 'timeout')]:
        if marker in text:
            return code
    return None


class IOAudit:
    def __init__(self, directory, role='python', rotate_bytes=64 * 1024 * 1024):
        self.directory = Path(directory).absolute()
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        self.stem = '{}-{}-{}'.format(stamp, os.getpid(), role)
        self.role = role
        self.rotate_bytes = rotate_bytes
        self.pending = queue.SimpleQueue()
        self.counter = itertools.count(1)
        self.closed = False
        self.failed = False
        self.restore = []
        self.local = threading.local()
        self.context = {}
        self.worker = threading.Thread(target=self._write, name='io-audit-writer', daemon=True)
        self.worker.start()

    def emit(self, event, context=None):
        if self.closed or self.failed:
            return
        event.update(time=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     pid=os.getpid(), thread=threading.get_ident(), role=self.role)
        for key, value in (self.context if context is None else context).items():
            event.setdefault(key, value)
        self.pending.put(event)

    def begin(self, category, operation, target='', **fields):
        ident = '{}:{}'.format(os.getpid(), next(self.counter))
        source = ''
        frame = sys._getframe(1)
        while frame:
            name = frame.f_code.co_filename
            if name != __file__ and ('/core/' in name or '/storage/' in name
                                    or '/apps/admin/' in name or '/auth/' in name
                                    or '/config/' in name or '/cli/' in name):
                source = '{}:{}:{}'.format(name, frame.f_lineno, frame.f_code.co_name)
                break
            frame = frame.f_back
        context = dict(self.context)
        metadata = dict(category=category, operation=operation, target=safe_target(target))
        self.emit(dict(event='begin', id=ident, parent=_parent.get(), source=source, **metadata, **fields), context)
        return ident, time.perf_counter(), context, metadata

    def end(self, span, error=None, **fields):
        if error is not None:
            metadata = span[3]
            code = fields.get('errorCode')
            if not code and metadata['category'] in ('network', 'browser', 'browser_network'):
                code = safe_error_code(error)
            if code:
                fields['errorCode'] = code
            outcome, expected = operation_outcome(metadata['category'], metadata['operation'],
                                                   metadata['target'], type(error).__name__, code)
            fields.setdefault('outcome', outcome)
            fields.setdefault('expected', expected)
        self.emit(dict(event='error' if error else 'end', id=span[0],
                       elapsedMs=round((time.perf_counter() - span[1]) * 1000, 3),
                       **({'error': type(error).__name__} if error else {}), **fields), context=span[2])

    def _write(self):
        sys.setprofile(None)  # Never trace the logger's own files or recurse.
        part, size, stream = 0, 0, None
        try:
            while True:
                item = self.pending.get()
                if item is None:
                    break
                batch = [item]
                for _ in range(255):
                    try:
                        next_item = self.pending.get_nowait()
                    except queue.Empty:
                        break
                    if next_item is None:
                        self.pending.put(None)
                        break
                    batch.append(next_item)
                data = ''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in batch).encode()
                if stream is None or size + len(data) > self.rotate_bytes:
                    if stream:
                        stream.close()
                    file = self.directory / ('{}-{:04d}.jsonl'.format(self.stem, part))
                    fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    stream = os.fdopen(fd, 'wb', buffering=0)
                    size = 0
                    part += 1
                offset = 0
                while offset < len(data):
                    offset += stream.write(data[offset:])
                size += len(data)
        except OSError as error:
            self.failed = True
            # Error type only: exception strings can contain URLs or credentials.
            print('I/O 诊断日志写入失败：' + type(error).__name__, file=sys.stderr)
        finally:
            if stream:
                stream.close()

    def patch(self, owner, name, replacement):
        original = getattr(owner, name)
        self.restore.append((owner, name, original))
        setattr(owner, name, replacement)

    def close(self):
        if self.closed:
            return
        self.emit({'event': 'audit_stop'})
        self.closed = True
        for owner, name, original in reversed(self.restore):
            setattr(owner, name, original)
        self.restore.clear()
        if getattr(self, 'profile_installed', False):
            sys.setprofile(None)
            threading.setprofile(None)
        self.pending.put(None)
        self.worker.join(timeout=10)
        if self.worker.is_alive():
            print('I/O 诊断日志尚未写完，进程退出可能截断末尾。', file=sys.stderr)
        global _current
        if _current is self:
            _current = None

    def install_files(self):
        import _io
        import builtins
        import shutil
        for owner, names in [(os, ('stat', 'lstat', 'scandir', 'listdir', 'readlink', 'mkdir',
                                  'rmdir', 'remove', 'unlink', 'rename', 'replace', 'link',
                                  'symlink', 'chmod', 'utime', 'open', 'close', 'read', 'write',
                                  'fsync', 'fdatasync', 'fstat', 'ftruncate', 'pread', 'pwrite',
                                  'sendfile', 'copy_file_range', 'lseek', 'readv', 'writev')),
                             (builtins, ('open',)), (io, ('open',)), (_io, ('open_code',)),
                             (shutil, ('copyfile', 'copy', 'copy2', 'copytree', 'move', 'rmtree'))]:
            for name in names:
                if not hasattr(owner, name):
                    continue
                original = getattr(owner, name)
                def wrap(original, name):
                    @functools.wraps(original)
                    def call(*args, **kwargs):
                        target = args[0] if args else kwargs.get('path', kwargs.get('file', kwargs.get('src', kwargs.get('fd', ''))))
                        # Log files are implementation I/O, excluded to prevent recursion.
                        if getattr(self.local, 'busy', False) or (isinstance(target, (str, bytes, Path))
                                and str(target).startswith(str(self.directory))):
                            return original(*args, **kwargs)
                        self.local.busy = True
                        try:
                            fields = {}
                            if name in ('rename', 'replace', 'link', 'symlink', 'copyfile', 'copy', 'copy2', 'copytree', 'move'):
                                fields['destination'] = safe_target(args[1] if len(args) > 1 else kwargs.get('dst', ''))
                            span = self.begin('filesystem', name, target, **fields)
                        finally:
                            self.local.busy = False
                        try:
                            result = original(*args, **kwargs)
                        except BaseException as error:
                            self.end(span, error)
                            raise
                        fields = {}
                        if name in ('read', 'pread') and isinstance(result, bytes):
                            fields['bytes'] = len(result)
                        elif name in ('write', 'pwrite') and isinstance(result, int):
                            fields['bytes'] = result
                        self.end(span, **fields)
                        if name == 'scandir':
                            return self.trace_directory(result, target)
                        return result
                    return call
                self.patch(owner, name, wrap(original, name))
        try:
            self.install_async_files()
        except ImportError:
            self.emit({'event': 'coverage_warning', 'detail': 'aiofiles-not-installed'})
        # Native file objects stay native (aiofiles relies on their actual types).
        if sys.getprofile() is None and getattr(threading, 'getprofile', lambda: None)() is None:
            self.profile_installed = True
            threading.setprofile(self._file_profile)
            sys.setprofile(self._file_profile)
        else:
            self.emit({'event': 'coverage_warning', 'detail': 'existing-profiler-file-methods-untraced'})

    def trace_directory(self, iterator, target):
        audit = self
        class Directory:
            def __init__(self):
                self.span = audit.begin('filesystem', 'scandir.entries', target)
                self.entries = 0
                self.read_ms = 0
                self.complete = self.closed = False
            def __iter__(self):
                return self
            def __next__(self):
                started = time.perf_counter()
                try:
                    entry = next(iterator)
                except StopIteration:
                    self.complete = True
                    self.close()
                    raise
                except BaseException as error:
                    self.close(error)
                    raise
                finally:
                    self.read_ms += (time.perf_counter() - started) * 1000
                self.entries += 1
                return entry
            def close(self, error=None):
                if self.closed:
                    return
                self.closed = True
                try:
                    iterator.close()
                finally:
                    audit.end(self.span, error, entries=self.entries, readMs=round(self.read_ms, 3),
                              complete=self.complete)
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                self.close()
            def __del__(self):
                self.close()
        return Directory()

    def install_async_files(self):
        import aiofiles.base
        import aiofiles.threadpool.binary
        import aiofiles.threadpool.text
        native_open = aiofiles.threadpool._open
        @functools.wraps(native_open)
        async def open_file(*args, **kwargs):
            span = self.begin('filesystem', 'async.open', args[0] if args else kwargs.get('file', ''))
            try:
                result = await native_open(*args, **kwargs)
            except BaseException as error:
                self.end(span, error)
                raise
            self.end(span)
            return result
        self.patch(aiofiles.threadpool, '_open', open_file)
        # Executor partials call C file methods without c_call profile events.
        classes = {value for module in (aiofiles.threadpool.binary, aiofiles.threadpool.text)
                   for value in vars(module).values() if inspect.isclass(value)
                   and value.__module__.startswith('aiofiles')}
        for cls in classes:
            for name, original in list(vars(cls).items()):
                if name not in _FILE_METHODS or not inspect.iscoroutinefunction(original):
                    continue
                def wrap(original, name):
                    @functools.wraps(original)
                    async def call(file, *args, **kwargs):
                        span = self.begin('filesystem', name, getattr(file._file, 'name', ''))
                        try:
                            result = await original(file, *args, **kwargs)
                        except BaseException as error:
                            self.end(span, error)
                            raise
                        fields = {}
                        if isinstance(result, (str, bytes)):
                            fields['bytes' if isinstance(result, bytes) else 'characters'] = len(result)
                        elif name == 'write' and isinstance(result, int):
                            fields['unitsWritten'] = result
                        self.end(span, **fields)
                        return result
                    return call
                self.patch(cls, name, wrap(original, name))
        original_exit = aiofiles.base.AiofilesContextManager.__aexit__
        @functools.wraps(original_exit)
        async def exit(manager, *args):
            span = self.begin('filesystem', 'context.close', getattr(manager._obj._file, 'name', ''))
            try:
                result = await original_exit(manager, *args)
            except BaseException as error:
                self.end(span, error)
                raise
            self.end(span)
            return result
        self.patch(aiofiles.base.AiofilesContextManager, '__aexit__', exit)

    def _file_profile(self, frame, event, function):
        if event not in ('c_call', 'c_return', 'c_exception') or self.closed:
            return
        obj = getattr(function, '__self__', None)
        method = getattr(function, '__name__', '')
        if event != 'c_call':
            stack = getattr(self.local, 'file_spans', [])
            if stack and stack[-1][0] is obj and stack[-1][1] == method:
                _, _, span = stack.pop()
                self.end(span, OSError() if event == 'c_exception' else None)
            return
        if isinstance(obj, io.IOBase) and method in _FILE_METHODS:
            target = getattr(obj, 'name', None)
            if target is None or str(target) in ('<stdin>', '<stdout>', '<stderr>'):
                return
            if isinstance(target, int) and target < 3:
                return
        elif isinstance(obj, os.DirEntry) and method in ('stat', 'is_file', 'is_dir', 'is_symlink'):
            target = obj.path
        else:
            return
        if str(target).startswith(str(self.directory)):
            return
        stack = getattr(self.local, 'file_spans', None)
        if stack is None:
            stack = self.local.file_spans = []
        stack.append((obj, method, self.begin('filesystem', method, target)))

    def install_sqlite(self):
        audit = self
        class Cursor(sqlite3.Cursor):
            def execute(self, sql, *args, **kwargs):
                self._audit_sql = sql_fields(sql)
                return traced('execute', self, lambda: super(Cursor, self).execute(sql, *args, **kwargs))
            def executemany(self, sql, *args, **kwargs):
                self._audit_sql = sql_fields(sql)
                return traced('executemany', self, lambda: super(Cursor, self).executemany(sql, *args, **kwargs))
            def executescript(self, sql, *args, **kwargs):
                self._audit_sql = sql_fields(sql)
                return traced('executescript', self, lambda: super(Cursor, self).executescript(sql, *args, **kwargs))
        def traced(name, obj, function):
            connection = obj.connection if isinstance(obj, sqlite3.Cursor) else obj
            span = audit.begin('database', name, getattr(connection, '_audit_file', ''),
                               **getattr(obj, '_audit_sql', {}))
            try:
                result = function()
            except StopIteration:
                audit.end(span, rows=0, complete=True)
                raise
            except BaseException as error:
                audit.end(span, error)
                raise
            audit.end(span, **({'rows': len(result)} if isinstance(result, list) else {}))
            return result
        for name in ('fetchone', 'fetchmany', 'fetchall', '__next__', 'close'):
            native = getattr(sqlite3.Cursor, name)
            def method(native, name):
                def call(obj, *args, **kwargs):
                    return traced(name, obj, lambda: native(obj, *args, **kwargs))
                return call
            setattr(Cursor, name, method(native, name))
        class Connection(sqlite3.Connection):
            def cursor(self, *args, **kwargs):
                if not args and 'factory' not in kwargs:
                    kwargs['factory'] = Cursor
                return super().cursor(*args, **kwargs)
            def execute(self, sql, *args, **kwargs):
                return self.cursor().execute(sql, *args, **kwargs)
            def executemany(self, sql, *args, **kwargs):
                return self.cursor().executemany(sql, *args, **kwargs)
            def executescript(self, sql, *args, **kwargs):
                return self.cursor().executescript(sql, *args, **kwargs)
        for name in ('commit', 'rollback', 'close', 'backup', '__exit__'):
            native = getattr(sqlite3.Connection, name)
            def method(native, name):
                def call(obj, *args, **kwargs):
                    return traced(name, obj, lambda: native(obj, *args, **kwargs))
                return call
            setattr(Connection, name, method(native, name))
        original = sqlite3.connect
        @functools.wraps(original)
        def connect(*args, **kwargs):
            target = args[0] if args else kwargs.get('database', '')
            # Preserve callers' explicitly selected factories.
            if len(args) < 6 and 'factory' not in kwargs:
                kwargs['factory'] = Connection
            span = audit.begin('database', 'connect', target)
            try:
                result = original(*args, **kwargs)
                if isinstance(result, Connection):
                    result._audit_file = safe_target(target)
                else:
                    audit.emit({'event': 'coverage_warning', 'detail': 'custom-sqlite-factory'})
            except BaseException as error:
                audit.end(span, error)
                raise
            audit.end(span)
            return result
        self.patch(sqlite3, 'connect', connect)
        try:
            import aiosqlite
        except ImportError:
            return
        original_execute = aiosqlite.Connection._execute
        @functools.wraps(original_execute)
        async def execute(connection, function, *args, **kwargs):
            name = getattr(function, '__name__', 'operation')
            fields = sql_fields(args[0]) if args and name in ('execute', 'executemany', 'executescript') else {}
            native = getattr(connection, '_connection', None)
            span = audit.begin('database', 'async.' + name, getattr(native, '_audit_file', ''), **fields)
            context = contextvars.copy_context()
            context.run(_parent.set, span[0])
            try:
                result = await original_execute(connection, lambda: context.run(function, *args, **kwargs))
            except BaseException as error:
                audit.end(span, error)
                raise
            audit.end(span)
            return result
        self.patch(aiosqlite.Connection, '_execute', execute)

    def install_network(self):
        import aiohttp
        audit = self
        readers = {}
        original = aiohttp.ClientSession.__init__
        @functools.wraps(original)
        def initialize(session, *args, **kwargs):
            trace = aiohttp.TraceConfig()
            async def start(_session, ctx, params):
                ctx.audit_span = audit.begin('network', params.method, params.url)
            async def end(_session, ctx, params):
                if not hasattr(ctx, 'audit_span'):
                    return
                audit.end(ctx.audit_span, status=params.response.status, phase='response_headers')
                readers[id(params.response.content)] = ctx.audit_span[0]
            async def failed(_session, ctx, params):
                if not hasattr(ctx, 'audit_span'):
                    return
                for operation in ('connection_queue', 'dns', 'connect'):
                    span = getattr(ctx, operation, None)
                    if span:
                        audit.end(span, params.exception)
                        setattr(ctx, operation, None)
                audit.end(ctx.audit_span, params.exception)
            async def redirect(_session, ctx, params):
                audit.emit({'event': 'redirect', 'id': ctx.audit_span[0],
                            'target': safe_target(params.response.headers.get('Location', '')),
                            'status': params.response.status}, context=ctx.audit_span[2])
            trace.on_request_start.append(start)
            trace.on_request_end.append(end)
            trace.on_request_exception.append(failed)
            trace.on_request_redirect.append(redirect)
            for signal, operation in [('on_connection_queued_start', 'connection_queue'),
                                      ('on_dns_resolvehost_start', 'dns'),
                                      ('on_connection_create_start', 'connect')]:
                async def stage_start(_session, ctx, params, operation=operation):
                    if not hasattr(ctx, 'audit_span'):
                        return
                    setattr(ctx, operation, audit.begin('network', operation, getattr(params, 'host', ''),
                                                       requestId=ctx.audit_span[0]))
                async def stage_end(_session, ctx, _params, operation=operation):
                    span = getattr(ctx, operation, None)
                    if span:
                        audit.end(span)
                        setattr(ctx, operation, None)
                getattr(trace, signal).append(stage_start)
                getattr(trace, signal.replace('_start', '_end')).append(stage_end)
            kwargs['trace_configs'] = list(kwargs.get('trace_configs') or []) + [trace]
            return original(session, *args, **kwargs)
        self.patch(aiohttp.ClientSession, '__init__', initialize)
        for name in ('release', 'close'):
            original_close = getattr(aiohttp.ClientResponse, name)
            def wrap_close(original_close):
                @functools.wraps(original_close)
                def close(response, *args, **kwargs):
                    readers.pop(id(response.content), None)
                    return original_close(response, *args, **kwargs)
                return close
            self.patch(aiohttp.ClientResponse, name, wrap_close(original_close))
        for name in ('read', 'readany', 'readchunk', 'readexactly', 'readline'):
            original_read = getattr(aiohttp.StreamReader, name)
            def wrap(original_read, name):
                @functools.wraps(original_read)
                async def read(reader, *args, **kwargs):
                    span = audit.begin('network', 'body.' + name,
                                       requestId=readers.get(id(reader)))
                    try:
                        result = await original_read(reader, *args, **kwargs)
                    except BaseException as error:
                        audit.end(span, error)
                        raise
                    data = result[0] if isinstance(result, tuple) else result
                    audit.end(span, bytes=len(data))
                    return result
                return read
            self.patch(aiohttp.StreamReader, name, wrap(original_read, name))

    def install_other_networks(self):
        import http.client
        audit = self
        pending = {}
        original = http.client.HTTPConnection.putrequest
        @functools.wraps(original)
        def putrequest(connection, method, url, *args, **kwargs):
            target = url if '://' in url else '{}://{}:{}{}'.format(
                'https' if isinstance(connection, http.client.HTTPSConnection) else 'http',
                connection.host, connection.port, url)
            span = audit.begin('network', 'urllib.' + method, target)
            pending[id(connection)] = span
            try:
                return original(connection, method, url, *args, **kwargs)
            except BaseException as error:
                pending.pop(id(connection), None)
                audit.end(span, error)
                raise
        self.patch(http.client.HTTPConnection, 'putrequest', putrequest)
        for name in ('endheaders', 'getresponse', 'close'):
            native = getattr(http.client.HTTPConnection, name)
            def wrap(native, name):
                @functools.wraps(native)
                def call(connection, *args, **kwargs):
                    span = pending.get(id(connection))
                    try:
                        response = native(connection, *args, **kwargs)
                    except BaseException as error:
                        if span and pending.pop(id(connection), None):
                            audit.end(span, error)
                        raise
                    if span and name == 'getresponse':
                        pending.pop(id(connection), None)
                        audit.end(span, status=response.status, phase='response_headers')
                        response._io_audit_request = span[0]
                    return response
                return call
            self.patch(http.client.HTTPConnection, name, wrap(native, name))
        for name in ('read', 'read1', 'readinto', 'readline'):
            native = getattr(http.client.HTTPResponse, name)
            def wrap(native, name):
                @functools.wraps(native)
                def call(response, *args, **kwargs):
                    span = audit.begin('network', 'urllib.body.' + name,
                                       requestId=getattr(response, '_io_audit_request', None))
                    try:
                        value = native(response, *args, **kwargs)
                    except BaseException as error:
                        audit.end(span, error)
                        raise
                    audit.end(span, bytes=value if isinstance(value, int) else len(value))
                    return value
                return call
            self.patch(http.client.HTTPResponse, name, wrap(native, name))
        try:
            import httpx
        except ImportError:
            self.emit({'event': 'coverage_warning', 'detail': 'httpx-not-installed'})
            return
        for cls in (httpx.AsyncClient, httpx.Client):
            native = cls._send_single_request
            def wrap_async(native):
                @functools.wraps(native)
                async def send(client, request):
                    span = audit.begin('network', 'httpx.' + request.method, str(request.url))
                    try:
                        response = await native(client, request)
                    except BaseException as error:
                        audit.end(span, error)
                        raise
                    response._io_audit_request = span[0]
                    audit.end(span, status=response.status_code, phase='response_headers')
                    return response
                return send
            def wrap_sync(native):
                @functools.wraps(native)
                def send(client, request):
                    span = audit.begin('network', 'httpx.' + request.method, str(request.url))
                    try:
                        response = native(client, request)
                    except BaseException as error:
                        audit.end(span, error)
                        raise
                    response._io_audit_request = span[0]
                    audit.end(span, status=response.status_code, phase='response_headers')
                    return response
                return send
            self.patch(cls, '_send_single_request', wrap_async(native) if cls is httpx.AsyncClient else wrap_sync(native))
        original_async = httpx.Response.aiter_raw
        @functools.wraps(original_async)
        async def aiter_raw(response, *args, **kwargs):
            request = getattr(response, '_request', None)
            span = audit.begin('network', 'httpx.body', str(request.url) if request is not None else '',
                               requestId=getattr(response, '_io_audit_request', None))
            size, complete, failure = 0, False, None
            try:
                async for chunk in original_async(response, *args, **kwargs):
                    size += len(chunk)
                    yield chunk
                complete = True
            except BaseException as error:
                failure = error
                raise
            finally:
                audit.end(span, failure, bytes=size, complete=complete)
        self.patch(httpx.Response, 'aiter_raw', aiter_raw)
        original_sync = httpx.Response.iter_raw
        @functools.wraps(original_sync)
        def iter_raw(response, *args, **kwargs):
            request = getattr(response, '_request', None)
            span = audit.begin('network', 'httpx.body', str(request.url) if request is not None else '',
                               requestId=getattr(response, '_io_audit_request', None))
            size, complete, failure = 0, False, None
            try:
                for chunk in original_sync(response, *args, **kwargs):
                    size += len(chunk)
                    yield chunk
                complete = True
            except BaseException as error:
                failure = error
                raise
            finally:
                audit.end(span, failure, bytes=size, complete=complete)
        self.patch(httpx.Response, 'iter_raw', iter_raw)

    def install_browser(self):
        try:
            from playwright import async_api
        except ImportError:
            self.emit({'event': 'coverage_warning', 'detail': 'playwright-not-installed'})
            return
        audit = self
        original_init = async_api.BrowserContext.__init__
        def initialize(context, *args, **kwargs):
            original_init(context, *args, **kwargs)
            pending = {}
            def request_started(request):
                key = id(request._impl_obj)
                pending[key] = audit.begin('browser_network', request.method, request.url,
                                           resourceType=request.resource_type)
            def response_received(response):
                span = pending.get(id(response.request._impl_obj))
                if span:
                    audit.emit({'event': 'response_headers', 'id': span[0], 'status': response.status}, context=span[2])
            def request_ended(request, failed=False):
                span = pending.pop(id(request._impl_obj), None)
                if span:
                    code = re.search(r'net::[A-Z0-9_]+', str(request.failure or '')) if failed else None
                    audit.end(span, OSError() if failed else None,
                              **({'errorCode': code.group(0)} if code else {}))
            def closed():
                for span in pending.values():
                    audit.end(span, asyncio.CancelledError())
                pending.clear()
            context.on('request', request_started)
            context.on('response', response_received)
            context.on('requestfinished', request_ended)
            context.on('requestfailed', lambda request: request_ended(request, True))
            context.on('close', lambda *_: closed())
        import asyncio
        self.patch(async_api.BrowserContext, '__init__', initialize)
        original_page_init = async_api.Page.__init__
        def initialize_page(page, *args, **kwargs):
            original_page_init(page, *args, **kwargs)
            sockets = {}
            def websocket(socket):
                span = audit.begin('browser_network', 'WebSocket', socket.url)
                sockets[id(socket)] = span
                def frame(direction, payload):
                    size = len(payload.encode()) if isinstance(payload, str) else len(payload)
                    audit.emit({'event': direction, 'id': span[0], 'bytes': size}, context=span[2])
                def close(*_args):
                    if sockets.pop(id(socket), None):
                        audit.end(span)
                def failed(error):
                    if sockets.pop(id(socket), None):
                        audit.end(span, OSError(), errorCode=safe_error_code(error) or 'websocket_error')
                socket.on('framesent', lambda payload: frame('frame_sent', payload))
                socket.on('framereceived', lambda payload: frame('frame_received', payload))
                socket.on('close', close)
                socket.on('socketerror', failed)
            def navigated(frame):
                if frame._impl_obj is page.main_frame._impl_obj:
                    for span in sockets.values():
                        audit.end(span, outcome='navigation_end', complete=False)
                    sockets.clear()
            def close_page(*_args):
                for span in sockets.values():
                    audit.end(span, asyncio.CancelledError())
                sockets.clear()
            page.on('websocket', websocket)
            page.on('framenavigated', navigated)
            page.on('close', close_page)
        self.patch(async_api.Page, '__init__', initialize_page)
        classes = {value for value in vars(async_api).values() if inspect.isclass(value)
                   and value.__module__.startswith('playwright.async_api')}
        for cls in classes:
            for name, original in list(vars(cls).items()):
                if name.startswith('_') or not inspect.iscoroutinefunction(original):
                    continue
                def wrap(original, operation):
                    @functools.wraps(original)
                    async def call(obj, *args, **kwargs):
                        target = kwargs.get('url', '')
                        if not target and args and operation.endswith(('.goto', '.request', '.get', '.post', '.put', '.delete')):
                            target = args[0]
                        fields = {}
                        if operation.endswith(('.evaluate', '.evaluate_handle', '.wait_for_function')):
                            script = args[0] if args else kwargs.get('expression')
                            if isinstance(script, str):
                                fields['scriptHash'] = hashlib.sha256(script.encode()).hexdigest()[:16]
                        if operation.endswith('.wait_for_timeout') and args and isinstance(args[0], (int, float)):
                            fields['delayMs'] = args[0]
                        if isinstance(kwargs.get('timeout'), (int, float)):
                            fields['timeoutMs'] = kwargs['timeout']
                        span = audit.begin('browser', operation, target, **fields)
                        token = _parent.set(span[0])
                        try:
                            result = await original(obj, *args, **kwargs)
                        except BaseException as error:
                            audit.end(span, error)
                            raise
                        else:
                            audit.end(span)
                            return result
                        finally:
                            _parent.reset(token)
                    return call
                self.patch(cls, name, wrap(original, cls.__name__ + '.' + name))


def install(directory=None, role='python'):
    global _current
    if _current is not None:
        return _current
    if os.environ.get('LIBRARY_IO_AUDIT', '1') == '0':
        return None
    directory = directory or os.environ.get('LIBRARY_IO_AUDIT_DIR') or Path(__file__).resolve().parents[1] / 'logs/io-audit'
    audit = IOAudit(directory, role)
    _current = audit
    audit.install_files()
    audit.install_sqlite()
    try:
        audit.install_network()
    except ImportError:
        audit.emit({'event': 'coverage_warning', 'detail': 'aiohttp-not-installed'})
    audit.install_other_networks()
    audit.install_browser()
    audit.emit({'event': 'audit_start', 'coverage': 'python-files,sqlite,aiohttp,httpx,urllib,playwright',
                'payloads': False})
    atexit.register(audit.close)
    return audit


def set_context(*, author='', author_url='', index=0):
    if _current is not None:
        _current.context = {'author': str(author)[:200], 'authorUrl': safe_target(author_url), 'index': index}


def record_stage(stage, **fields):
    if _current is not None:
        allowed = {'index', 'total', 'step', 'elapsedMs', 'works', 'entries', 'reused', 'success',
                   'failed', 'skipped', 'items', 'totalSource', 'localSaved', 'allowPageStop', 'remainingGap',
                   'pages', 'reason', 'historyChecked', 'countSource', 'phase', 'budgetMs',
                   'received', 'newWorks', 'repairWorks', 'historyGap', 'newGap', 'status'}
        _current.emit({'event': 'stage', 'stage': str(stage)[:100], **{
            key: value for key, value in fields.items() if key in allowed
            and isinstance(value, (str, int, float, bool))}})
