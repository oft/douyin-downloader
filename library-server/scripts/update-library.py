"""Run the downloader for the library, with cancellation over stdin."""

import asyncio
import contextlib
import logging
import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace


async def update(config, download_root, database):
    try:
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
    reporter = LibraryProgressDisplay(pipe.send)
    schedule = UpdateSchedule(database)
    # stdout is a JSON-lines channel; human logs remain in the server terminal.
    with contextlib.redirect_stdout(sys.stderr):
        task = asyncio.create_task(
            main_async(args, database_path=database, on_download_ready=watch_for_stop,
                       progress_reporter=reporter, browser_preflight=True,
                       url_scheduler=schedule, stream_downloads=True)
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


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    sys.exit(asyncio.run(update(*sys.argv[1:])))
