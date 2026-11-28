"""Append bounded, credential-free diagnostic events off the update event loop."""
import asyncio
import datetime
import json
import queue
import threading
from pathlib import Path


class UpdateDiagnostics:
    def __init__(self, file):
        self.file = Path(file)
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.pending = queue.SimpleQueue()
        self.worker = threading.Thread(target=self._write, daemon=True)
        self.worker.start()

    def record(self, event, **fields):
        # Deliberately no arbitrary request bodies, cookies, query strings or exceptions.
        allowed = {'index', 'total', 'author', 'step', 'elapsedMs', 'works', 'entries',
                   'reused', 'success', 'failed', 'skipped', 'items', 'url',
                   'totalSource', 'localSaved', 'allowPageStop', 'remainingGap', 'pages', 'reason',
                   'historyChecked', 'countSource', 'phase', 'budgetMs', 'received', 'newWorks', 'repairWorks', 'historyGap', 'newGap', 'status'}
        from utils.logger import safe_log_url
        data = {key: value for key, value in fields.items() if key in allowed
                and isinstance(value, (str, int, float, bool))}
        if 'url' in data:
            data['url'] = safe_log_url(data['url'])
        data.update(event=str(event)[:100], time=datetime.datetime.now(datetime.timezone.utc).isoformat())
        self.pending.put(data)

    def _write(self):
        try:
            with self.file.open('a', encoding='utf-8') as stream:
                while True:
                    item = self.pending.get()
                    if item is None:
                        return
                    stream.write(json.dumps(item, ensure_ascii=False) + '\n')
                    stream.flush()
        except OSError:
            pass  # Diagnostics must never stop a real download.

    async def close(self):
        self.pending.put(None)
        await asyncio.get_running_loop().run_in_executor(None, self.worker.join, 1.0)
