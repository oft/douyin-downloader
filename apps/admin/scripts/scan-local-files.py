"""Explicit local filesystem reconciliation, with cancellation over stdin."""
import json
import os
import sys
import threading
import time

from project_paths import PROJECT_ROOT


def main(database, root):
    from storage.local_media_registry import ScanCancelled, scan_local_media
    stop = threading.Event()
    def listen():
        os.read(sys.stdin.fileno(), 1)
        stop.set()
    threading.Thread(target=listen, daemon=True).start()
    last = 0
    def progress(entries, files, complete=False, message=''):
        nonlocal last
        if not complete and time.monotonic() - last < .5:
            return
        last = time.monotonic()
        snapshot = dict(totalUrls=1, completedUrls=int(complete), currentIndex=1, failedUrls=0,
                        url='', author='', step='本地文件扫描已完成' if complete else '扫描更新本地文件',
                        detail='已检查 {} 个目录项，发现 {} 个可用媒体文件'.format(entries, files),
                        itemsTotal=entries, itemsCompleted=entries, success=files, failed=0, skipped=0,
                        bytesRead=0, bytesTotal=0, currentItem='', message=message)
        print(json.dumps(dict(type='progress', version=1, progress=snapshot), ensure_ascii=False), flush=True)
    progress(0, 0)
    try:
        report = scan_local_media(database, root, progress, stop.is_set)
    except ScanCancelled:
        return 130
    message = '已登记 {} 个作品 ID；修复 {} 条已知作品路径；{} 个 ID 尚无作品资料；{} 个文件无法确定 ID'.format(
        report['works'], report['repairedWorks'], report['unregisteredWorks'], report['unidentifiedFiles'])
    progress(report['entries'], report['files'], True, message)
    return 0


if __name__ == '__main__':
    sys.path.insert(0, str(PROJECT_ROOT))
    from utils.io_audit import install
    audit = install(role='manual-file-scan')
    try:
        sys.exit(main(*sys.argv[1:]))
    finally:
        if audit:
            audit.close()
