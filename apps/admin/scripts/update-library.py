"""Run the downloader for the library, with cancellation over stdin."""

import asyncio
import contextlib
import datetime
import logging
import os
import sys
import threading
from types import SimpleNamespace

from project_paths import PROJECT_ROOT


async def update(config, download_root, database):
    try:
        from update_diagnostics import UpdateDiagnostics
        from update_progress import LibraryProgressDisplay, ProgressPipe
        from update_schedule import UpdateSchedule

        from cli.main import main_async
        from utils.logger import set_console_log_level
    except ModuleNotFoundError as error:
        print(error, file=sys.stderr)
        return 4

    set_console_log_level(logging.ERROR)
    args = SimpleNamespace(
        config=config,
        path=download_root,
        url=None,
        thread=None,
        hot_board=None,
        search=None,
        serve=False,
        verbose=False,
        show_warnings=False,
    )
    loop = asyncio.get_running_loop()

    def wait_for_stop():
        # Reading the file descriptor avoids holding Python's buffered stdin lock at exit.
        os.read(sys.stdin.fileno(), 1)
        try:
            loop.call_soon_threadsafe(task.cancel)
        except RuntimeError:
            pass  # The update already completed and closed the event loop.

    def watch_for_stop():
        # Let database initialization finish before cancellation can interrupt it.
        threading.Thread(target=wait_for_stop, daemon=True).start()

    pipe = ProgressPipe(sys.stdout)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    diagnostics = UpdateDiagnostics(PROJECT_ROOT / 'logs' / 'library-update'
                                    / ('{}-{}.jsonl'.format(stamp, os.getpid())))
    reporter = LibraryProgressDisplay(pipe.send, diagnostics=diagnostics)
    schedule = UpdateSchedule(database)
    # stdout is a JSON-lines channel; human logs remain in the server terminal.
    with contextlib.redirect_stdout(sys.stderr):
        task = asyncio.create_task(
            main_async(args, database_path=database, on_download_ready=watch_for_stop,
                       progress_reporter=reporter, browser_preflight=True,
                       url_scheduler=schedule, stream_downloads=True, automatic_local_media_scan=False,
                       library_update_tracking=True)
        )
        try:
            return await task
        except asyncio.CancelledError:
            return 130
        finally:
            try:
                await schedule.close()
            finally:
                await pipe.close()
                await diagnostics.close()


if __name__ == "__main__":
    sys.path.insert(0, str(PROJECT_ROOT))
    from utils.io_audit import install
    audit = install(role='updater')
    try:
        sys.exit(asyncio.run(update(*sys.argv[1:])))
    finally:
        if audit:
            audit.close()
