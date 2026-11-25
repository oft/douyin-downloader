import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from storage.database import Database
from storage.metadata_handler import MetadataHandler


@pytest.mark.asyncio
async def test_complete_json_is_saved_to_file_and_compact_fields_are_kept(tmp_path):
    database = Database(str(tmp_path / "test.db"))
    await database.initialize()
    video = tmp_path / "2026-11-01_title_7411111111111111111.mp4"
    video.write_bytes(b"video")
    cover = video.with_name(video.stem + "_cover.jpg")
    avatar = video.with_name(video.stem + "_avatar.jpg")
    cover.write_bytes(b"cover")
    avatar.write_bytes(b"avatar")
    raw = {"aweme_id": "7411111111111111111", "desc": "full detail", "images": [],
           "extra": {"original_response": True}}
    await database.add_aweme({
        "aweme_id": raw["aweme_id"], "aweme_type": "video", "file_path": str(video),
        "metadata": json.dumps(raw),
    })
    connection = await database._get_conn()
    cursor = await connection.execute(
        "SELECT metadata,image_count,metadata_path,cover_path,avatar_path FROM aweme"
    )
    blob, count, json_path, cover_path, avatar_path = await cursor.fetchone()
    assert blob is None
    assert count == 0
    assert json.loads(Path(json_path).read_text(encoding="utf-8")) == raw
    assert cover_path == str(cover)
    assert avatar_path == str(avatar)
    await database.close()


@pytest.mark.asyncio
async def test_directory_records_become_primary_file_records_in_batch(tmp_path):
    database = Database(str(tmp_path / "test.db"))
    await database.initialize()
    item_id = "7422222222222222222"
    primary = tmp_path / (item_id + "_1.jpeg")
    primary.write_bytes(b"image")
    await database.add_aweme_batch([{
        "aweme_id": item_id, "aweme_type": "gallery", "file_path": str(tmp_path),
        "metadata": json.dumps({"images": [{}, {}]}),
    }])
    connection = await database._get_conn()
    cursor = await connection.execute("SELECT file_path,image_count,metadata FROM aweme")
    assert await cursor.fetchone() == (str(primary), 2, None)
    await database.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("with_path", [False, True])
async def test_failed_json_write_keeps_original_database_payload(monkeypatch, tmp_path, with_path):
    database = Database(str(tmp_path / "test.db"))
    await database.initialize()
    primary = tmp_path / "7433333333333333333.mp4"
    primary.write_bytes(b"video")
    raw = json.dumps({"original": True})
    monkeypatch.setattr(MetadataHandler, "save_metadata", AsyncMock(return_value=False))
    await database.add_aweme({
        "aweme_id": "7433333333333333333", "aweme_type": "video",
        "file_path": str(primary), "metadata": raw,
        "metadata_path": str(tmp_path / "unwritten_data.json") if with_path else None,
    })
    connection = await database._get_conn()
    cursor = await connection.execute("SELECT metadata,metadata_path FROM aweme")
    assert await cursor.fetchone() == (raw, None)
    await database.close()


@pytest.mark.asyncio
async def test_empty_sync_preserves_paths_and_externalized_details(tmp_path):
    database = Database(str(tmp_path / "test.db"))
    await database.initialize()
    primary = tmp_path / "7444444444444444444.mp4"
    primary.write_bytes(b"video")
    await database.add_aweme({
        "aweme_id": "7444444444444444444", "aweme_type": "video", "title": "old",
        "file_path": str(primary), "metadata": '{"images":[]}',
    })
    await database.add_aweme({
        "aweme_id": "7444444444444444444", "aweme_type": "video", "title": "new",
        "file_path": "", "metadata": "",
    })
    connection = await database._get_conn()
    cursor = await connection.execute("SELECT title,file_path,metadata,metadata_path FROM aweme")
    title, file_path, blob, json_path = await cursor.fetchone()
    assert title == "new"
    assert file_path == str(primary)
    assert blob is None
    assert Path(json_path).is_file()
    await database.close()


@pytest.mark.asyncio
async def test_atomic_metadata_write_preserves_previous_file_on_failure(monkeypatch, tmp_path):
    from storage import metadata_handler

    target = tmp_path / "data.json"
    target.write_text('{"original":true}', encoding="utf-8")

    def fail_replace(*args):
        raise OSError("fixture replacement failure")

    monkeypatch.setattr(metadata_handler.os, "replace", fail_replace)
    assert await MetadataHandler().save_metadata({"new": True}, target) is False
    assert json.loads(target.read_text()) == {"original": True}
    assert list(tmp_path.glob(".metadata-*.tmp")) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("path_style", ["absolute", "root_relative", "project_relative"])
async def test_paths_are_saved_relative_to_download_root(monkeypatch, tmp_path, path_style):
    project = tmp_path / "project"
    root = project / "Downloaded"
    root.mkdir(parents=True)
    monkeypatch.chdir(project)
    primary = root / "7455555555555555555.mp4"
    primary.write_bytes(b"video")
    (root / "7455555555555555555_cover.jpg").write_bytes(b"cover")
    (root / "7455555555555555555_avatar.jpg").write_bytes(b"avatar")
    value = str(primary)
    if path_style == "root_relative":
        value = primary.relative_to(root).as_posix()
    elif path_style == "project_relative":
        value = primary.relative_to(project).as_posix()
    database = Database(str(project / "test.db"), download_root=str(root))
    await database.initialize()
    await database.add_aweme({
        "aweme_id": "7455555555555555555", "aweme_type": "video",
        "file_path": value, "metadata": '{"images":[]}',
    })
    connection = await database._get_conn()
    cursor = await connection.execute(
        "SELECT file_path,metadata_path,cover_path,avatar_path FROM aweme")
    paths = await cursor.fetchone()
    assert paths == (
        "7455555555555555555.mp4", "7455555555555555555_data.json",
        "7455555555555555555_cover.jpg", "7455555555555555555_avatar.jpg",
    )
    assert all((root / value).is_file() for value in paths)
    await database.close()


@pytest.mark.asyncio
async def test_database_references_survive_moving_project(tmp_path):
    project = tmp_path / "original"
    root = project / "Downloaded"
    root.mkdir(parents=True)
    video = root / "7466666666666666666.mp4"
    video.write_bytes(b"video")
    database = Database(str(project / "test.db"), download_root=str(root))
    await database.initialize()
    await database.add_aweme({
        "aweme_id": "7466666666666666666", "aweme_type": "video",
        "file_path": str(video), "metadata": '{"extra":"preserved"}',
    })
    await database.close()
    moved = tmp_path / "moved"
    project.rename(moved)
    database = Database(str(moved / "test.db"), download_root=str(moved / "Downloaded"))
    await database.initialize()
    connection = await database._get_conn()
    cursor = await connection.execute("SELECT file_path,metadata_path FROM aweme")
    primary, details = await cursor.fetchone()
    assert (moved / "Downloaded" / primary).is_file()
    assert json.loads((moved / "Downloaded" / details).read_text())["extra"] == "preserved"
    await database.close()


@pytest.mark.asyncio
async def test_rejects_file_outside_configured_root(tmp_path):
    root = tmp_path / "Downloaded"
    root.mkdir()
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"fixture")
    database = Database(str(tmp_path / "test.db"), download_root=str(root))
    await database.initialize()
    with pytest.raises(ValueError):
        await database.add_aweme({
            "aweme_id": "7477777777777777777", "aweme_type": "video",
            "file_path": str(outside), "metadata": "{}",
        })
    assert not (tmp_path / "outside_data.json").exists()
    await database.close()
