"""Export cookies without disturbing the persistent browser's pages or storage."""

import asyncio
import json
import os
import uuid
from pathlib import Path

from utils.cookie_utils import sanitize_cookies


def prepare_profile(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        path.chmod(0o700)


def private_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(value, ensure_ascii=False, indent=2)
    if path.exists() and path.read_text(encoding="utf-8") == encoded:
        if os.name != "nt":
            path.chmod(0o600)
        return
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(path))
    finally:
        if temporary.exists():
            temporary.unlink()


async def save_browser_login(context, profile_dir, cookie_path, user_agent):
    # storage_state() may visit previously seen origins in a temporary page,
    # stealing focus from the login QR code every time autosave runs. Only read
    # the cookie jar here; the persistent profile owns localStorage/IndexedDB.
    applicable = await context.cookies("https://www.douyin.com/")
    cookies = sanitize_cookies({item["name"]: item.get("value", "")
        for item in applicable
        if item.get("domain", "").lstrip(".") == "douyin.com"
        or item.get("domain", "").endswith(".douyin.com")})
    await asyncio.to_thread(private_json, Path(profile_dir) / "session-meta.json", {"user_agent": user_agent})
    await asyncio.to_thread(private_json, cookie_path, cookies)
    return cookies
