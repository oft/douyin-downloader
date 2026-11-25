"""User-invoked login test window; never enumerates or downloads works."""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path


async def run(config_path):
    from config import ConfigLoader
    from core.browser_session import BrowserSession

    config = ConfigLoader(config_path)
    session = BrowserSession(profile_dir=Path("config/browser-profile"),
                             cookie_path=Path("config/cookies.json"), save_interval=5)
    await session.initialize()
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    async def focus():
        if session._page and not session._page.is_closed():
            await session._page.bring_to_front()

    def listen():
        pending = b""
        while True:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                try:
                    loop.call_soon_threadsafe(task.cancel)
                except RuntimeError:
                    pass
                return
            pending = (pending + chunk)[-32768:]
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                try:
                    request = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(request, dict) and request.get("action") == "focus":
                    asyncio.run_coroutine_threadsafe(focus(), loop)

    threading.Thread(target=listen, daemon=True).start()
    try:
        cookies = [{"name": key, "value": value, "url": "https://www.douyin.com/"}
                   for key, value in config.get_cookies().items()]
        async with session.page(headless=False, user_agent=session.user_agent or "",
                                cookies=cookies, proxy=config.get("proxy")) as (_context, page):
            try:
                await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=30_000)
            except Exception:
                print("页面未完全加载，请在浏览器中手动检查。", file=sys.stderr, flush=True)
            await page.bring_to_front()
            while not page.is_closed():
                await asyncio.sleep(1)
        return 0
    except asyncio.CancelledError:
        return 130
    finally:
        await session.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    os.chdir(Path(__file__).resolve().parents[2])
    sys.exit(asyncio.run(run(sys.argv[1])))
