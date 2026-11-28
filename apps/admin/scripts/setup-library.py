"""Initialize or check a local library without downloading or altering existing records."""

import argparse
import asyncio
import os
import sqlite3
import sys
from pathlib import Path

from project_paths import PROJECT_ROOT

try:
    import yaml
except ModuleNotFoundError:
    yaml = None


def dependency_error():
    print('缺少 Python 依赖，请先运行 python -m pip install -e ".[browser]"', file=sys.stderr)


def database_class():
    sys.path.insert(0, str(PROJECT_ROOT))
    from storage.database import Database

    return Database


def library_paths(config_file):
    config = yaml.safe_load(config_file.read_text(encoding="utf-8-sig"))
    if config is None:
        config = {}
    if not isinstance(config, dict):
        raise ValueError("配置文件应为 YAML 映射")
    paths = []
    for key, override, default in (
        ("path", "DOWNLOAD_ROOT", "./Downloaded"),
        ("database_path", "DATABASE_PATH", "./data/dy_downloader.db"),
    ):
        value = os.environ.get(override) or config.get(key, default)
        if not isinstance(value, str) or not value.strip() or "\0" in value:
            raise ValueError("{} 必须为非空路径".format(key))
        candidate = Path(value)
        base = Path.cwd() if os.environ.get(override) else config_file.parent
        paths.append((base / candidate).resolve())
    return paths


def check_database(database):
    # mode=ro must never create a replacement for an unavailable database.
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(aweme)")}
        required = {"aweme_id", "aweme_type", "author_id", "author_sec_uid", "file_path", "create_time"}
        if not required.issubset(columns):
            raise ValueError("数据库不是兼容的作品库，缺少字段：{}".format(", ".join(sorted(required - columns))))
        result = connection.execute("PRAGMA quick_check").fetchone()[0]
        if result != "ok":
            raise ValueError("数据库完整性检查未通过")
        return connection.execute("SELECT COUNT(*) FROM aweme").fetchone()[0]


async def initialize_database(database, root, store_class):
    store = store_class(str(database), download_root=str(root))
    try:
        await store.initialize()
    finally:
        await store.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=PROJECT_ROOT / "config.yml")
    parser.add_argument("--init", action="store_true", help="创建缺少的配置、媒体目录和空数据库；不迁移已有库")
    args = parser.parse_args(argv)
    if yaml is None:
        dependency_error()
        return 1
    config = args.config.resolve()
    try:
        if not config.exists():
            if not args.init:
                raise ValueError("配置不存在，请先使用 --init 初始化")
            config.parent.mkdir(parents=True, exist_ok=True)
            with config.open("x", encoding="utf-8") as target:
                target.write((PROJECT_ROOT / "config.example.yml").read_text(encoding="utf-8"))
        root, database = library_paths(config)
        for location in (root, database):
            if sys.platform == "darwin" and len(location.parts) > 2 and location.parts[1] == "Volumes":
                if not Path(*location.parts[:3]).is_mount():
                    raise ValueError("外置卷未挂载：{}；请修改配置或重新连接磁盘".format(Path(*location.parts[:3])))
        if root == database or root in database.parents:
            raise ValueError("数据库请放在媒体目录之外，例如 ./data/dy_downloader.db")
        if args.init:
            root.mkdir(parents=True, exist_ok=True)
            database.parent.mkdir(parents=True, exist_ok=True)
            if not database.exists():
                store_class = database_class()
                # Reserve the name exclusively; never replace an existing library.
                with database.open("xb"):
                    pass
                asyncio.run(initialize_database(database, root, store_class))
        if not root.is_dir():
            raise ValueError("媒体目录不可用：{}".format(root))
        count = check_database(database)
        print("配置：{}\n媒体：{}\n数据库：{}\n作品记录：{}".format(config, root, database, count))
        if count:
            print("已有作品库未修改；完整性通过不代表媒体文件齐全，切换目录前请核对库与文件的归属。")
        print("资料库就绪；此命令不会下载、迁移或删除媒体。")
        return 0
    except yaml.YAMLError:
        print("初始化/检查失败：配置 YAML 格式无效", file=sys.stderr)
        return 1
    except ModuleNotFoundError:
        dependency_error()
        return 1
    except (OSError, ValueError, sqlite3.Error) as error:
        print("初始化/检查失败：{}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
