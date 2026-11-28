"""CLI-only library application setup: independent libraries and non-destructive checks."""

import importlib.util
import sqlite3
from pathlib import Path

import pytest
import yaml


@pytest.fixture
def setup_library(monkeypatch):
    scripts = Path(__file__).resolve().parents[1] / "apps" / "admin" / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    monkeypatch.delenv("DOWNLOAD_ROOT", raising=False)
    monkeypatch.delenv("DATABASE_PATH", raising=False)
    spec = importlib.util.spec_from_file_location("library_setup", scripts / "setup-library.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_initializes_from_unrelated_directory_and_preserves_existing_records(setup_library, tmp_path, monkeypatch):
    config = tmp_path / "library" / "config.yml"
    monkeypatch.chdir(tmp_path)
    assert setup_library.main(["--config", str(config), "--init"]) == 0
    root, database = setup_library.library_paths(config)
    assert root == config.parent / "Downloaded"
    assert root.is_dir()
    with sqlite3.connect(database) as connection:
        connection.execute("INSERT INTO aweme(aweme_id, aweme_type) VALUES ('kept', 'video')")
    before = config.read_bytes()
    assert setup_library.main(["--config", str(config), "--init"]) == 0
    assert config.read_bytes() == before
    assert setup_library.check_database(database) == 1


def test_check_does_not_create_missing_library(setup_library, tmp_path):
    config = tmp_path / "config.yml"
    assert setup_library.main(["--config", str(config)]) == 1
    assert not config.exists()
    config.write_text("path: ./media\ndatabase_path: ./catalog.db\n", encoding="utf-8")
    assert setup_library.main(["--config", str(config)]) == 1
    assert not (tmp_path / "catalog.db").exists()
    assert not (tmp_path / "media").exists()


def test_rejects_incompatible_database_without_migrating_it(setup_library, tmp_path):
    config = tmp_path / "config.yml"
    config.write_text("path: ./media\ndatabase_path: ./catalog.db\n", encoding="utf-8")
    database = tmp_path / "catalog.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE unrelated (value TEXT)")
    before = database.read_bytes()
    assert setup_library.main(["--config", str(config), "--init"]) == 1
    assert database.read_bytes() == before


@pytest.mark.parametrize("value", [[], {"path": ""}, {"database_path": 123}])
def test_rejects_invalid_paths(setup_library, tmp_path, value):
    config = tmp_path / "config.yml"
    config.write_text(yaml.safe_dump(value), encoding="utf-8")
    assert setup_library.main(["--config", str(config), "--init"]) == 1


def test_environment_overrides_match_admin_paths(setup_library, tmp_path, monkeypatch):
    config = tmp_path / "config.yml"
    config.write_text("path: ./original\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DOWNLOAD_ROOT", "override")
    monkeypatch.setenv("DATABASE_PATH", "override.db")
    assert setup_library.library_paths(config) == [tmp_path / "override", tmp_path / "override.db"]


def test_missing_backend_dependency_does_not_leave_empty_database(setup_library, tmp_path, monkeypatch, capsys):
    config = tmp_path / "config.yml"
    config.write_text("path: ./media\ndatabase_path: ./catalog.db\n", encoding="utf-8")

    def missing():
        raise ModuleNotFoundError("aiosqlite")

    monkeypatch.setattr(setup_library, "database_class", missing)
    assert setup_library.main(["--config", str(config), "--init"]) == 1
    assert not (tmp_path / "catalog.db").exists()
    assert 'pip install' in capsys.readouterr().err


def test_missing_yaml_dependency_has_actionable_message(setup_library, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(setup_library, "yaml", None)
    assert setup_library.main(["--config", str(tmp_path / "config.yml"), "--init"]) == 1
    assert 'pip install' in capsys.readouterr().err
