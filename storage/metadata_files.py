"""Prepare compact database records with atomically saved JSON details."""

import asyncio
import json
from pathlib import Path

from .metadata_handler import MetadataHandler


async def _externalize_metadata(item):
    record = dict(item)
    raw = record.get("metadata")
    if not raw:
        return record
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return record
    if not isinstance(data, dict):
        return record
    images = data.get("images")
    if not isinstance(images, list):
        image_post = data.get("image_post_info")
        images = image_post.get("images") if isinstance(image_post, dict) else None
    record.setdefault("image_count", len(images) if isinstance(images, list) else 0)
    if not record.get("cover_urls"):
        video = data.get("video")
        video = video if isinstance(video, dict) else {}
        cover = video.get("origin_cover") or video.get("cover") or {}
        urls = cover.get("url_list") if isinstance(cover, dict) else None
        if isinstance(urls, list):
            record["cover_urls"] = json.dumps(urls[:3])
    file_path = Path(record.get("file_path") or "")
    is_file = await asyncio.to_thread(file_path.is_file)
    is_directory = await asyncio.to_thread(file_path.is_dir)
    if not record.get("file_path") or not (is_file or is_directory):
        return record
    directory = file_path.parent if is_file else file_path
    names = await asyncio.to_thread(lambda: list(directory.iterdir()))
    work_id = str(record.get("aweme_id") or "")
    related = [path for path in names if work_id and work_id in path.name
               and not path.name.startswith("._")]
    if is_file:
        stem = file_path.stem
        if record.get("aweme_type") == "gallery":
            stem = stem.rsplit("_", 1)[0]
        if stem.endswith("_video"):
            stem = stem[:-len("_video")]
    else:
        sidecars = [path for path in related if path.name.endswith("_data.json")]
        stem = sidecars[0].name[:-len("_data.json")] if sidecars else work_id
    json_path = Path(record["metadata_path"]) if record.get("metadata_path") else directory / (stem + "_data.json")
    if not await MetadataHandler().save_metadata(data, json_path):
        record.pop("metadata_path", None)
        return record
    record["metadata_path"] = str(json_path.resolve())
    record["metadata"] = None
    for column, suffix in (("cover_path", "_cover"), ("avatar_path", "_avatar")):
        local = next((path for path in related if path.stem.endswith(suffix)), None)
        if local is not None and await asyncio.to_thread(local.is_file):
            record[column] = str(local.resolve())
    if is_directory:
        media = [path for path in related if path.suffix.lower() in {".mp4", ".jpeg", ".jpg", ".png", ".webp", ".mp3"}
                 and not path.stem.endswith(("_cover", "_avatar", "_music"))]
        if media:
            record["file_path"] = str(sorted(media)[0].resolve())
    return record


PATH_FIELDS = ("file_path", "metadata_path", "cover_path", "avatar_path")


async def prepare_aweme_record(item, download_root=None):
    if download_root is None:
        return await _externalize_metadata(item)
    root = Path(download_root).resolve()
    record = dict(item)
    for field in PATH_FIELDS:
        value = record.get(field)
        if not value:
            continue
        candidate = Path(value)
        if not candidate.is_absolute():
            relative = (root / candidate).resolve()
            legacy = candidate.resolve()
            # Older downloaders pass a cwd-relative path including the root directory.
            if legacy.is_relative_to(root) and not await asyncio.to_thread(relative.exists):
                candidate = legacy
            else:
                candidate = relative
        candidate = candidate.resolve()
        candidate.relative_to(root)
        record[field] = str(candidate)
    prepared = await _externalize_metadata(record)
    for field in PATH_FIELDS:
        if prepared.get(field):
            prepared[field] = Path(prepared[field]).resolve().relative_to(root).as_posix()
    return prepared
