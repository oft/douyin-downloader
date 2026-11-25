"""Explicitly invoked link checks; never calls a downloader or writes the config/database."""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path


def emit(kind, **data):
    print(json.dumps({"type": kind, "version": 1, **data}, ensure_ascii=False), flush=True)


async def run(config_path):
    from link_checker import LinkChecker, check_links

    from config import ConfigLoader
    request = json.loads(await asyncio.to_thread(sys.stdin.readline))
    links = request.get("links")
    if (not isinstance(links, list) or not 1 <= len(links) <= 1000
            or not all(isinstance(link, str) and 0 < len(link) <= 4096 for link in links)):
        raise ValueError("检测链接列表无效")
    checker = LinkChecker(ConfigLoader(config_path), show_browser=request.get("showBrowser") is True)
    loop = asyncio.get_running_loop()

    task = asyncio.create_task(check_links(checker, links, emit))

    def stop_listener():
        os.read(sys.stdin.fileno(), 1)
        try:
            loop.call_soon_threadsafe(task.cancel)
        except RuntimeError:
            pass

    threading.Thread(target=stop_listener, daemon=True).start()
    try:
        return await task
    except asyncio.CancelledError:
        return 130
    finally:
        await checker.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    try:
        sys.exit(asyncio.run(run(sys.argv[1])))
    except Exception as error:
        from utils.browser_runtime import BrowserUnavailableError
        emit("link-check-error", message=str(error).replace("更新", "检测") if isinstance(error, BrowserUnavailableError)
             else "无法启动链接检测，请检查 Python 依赖和配置。")
        sys.exit(4)
