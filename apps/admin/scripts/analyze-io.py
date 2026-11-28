"""Read-only, streaming summary of I/O trace files (the analyzer does not trace itself)."""
import argparse
import collections
import heapq
import json
import sys
from pathlib import Path

from project_paths import PROJECT_ROOT

sys.path.insert(0, str(PROJECT_ROOT))
from utils.io_audit import operation_outcome


def analyze(files, limit=20):
    pending = {}
    totals = collections.defaultdict(lambda: {'calls': 0, 'errors': 0, 'expectedErrors': 0, 'elapsedMs': 0, 'maxMs': 0})
    slowest, failures, expected_results, warnings = [], [], [], []
    malformed = events = sequence = 0
    for file in sorted(files):
        # Pair only within one process session; OS PIDs can be reused across days.
        namespace = file.stem.rsplit('-', 1)[0]
        with file.open(encoding='utf-8', errors='replace') as stream:
            for number, line in enumerate(stream, 1):
                try:
                    event = json.loads(line)
                except (ValueError, TypeError):
                    malformed += 1
                    continue
                if not isinstance(event, dict):
                    malformed += 1
                    continue
                events += 1
                kind = event.get('event')
                key = (namespace, event.get('id'))
                if kind == 'begin':
                    pending[key] = event
                elif kind in ('end', 'error'):
                    start = pending.pop(key, None)
                    if start is None:
                        continue
                    elapsed = event.get('elapsedMs', 0)
                    if not isinstance(elapsed, (int, float)):
                        elapsed = 0
                    group = totals[(start.get('category', ''), start.get('operation', ''))]
                    group['calls'] += 1
                    outcome, expected = operation_outcome(start.get('category'), start.get('operation'),
                                                         start.get('target', ''), event.get('error', ''), event.get('errorCode', ''))
                    expected = event.get('expected', expected)
                    group['errors'] += kind == 'error' and not expected
                    group['expectedErrors'] += kind == 'error' and expected
                    group['elapsedMs'] += elapsed
                    group['maxMs'] = max(group['maxMs'], elapsed)
                    row = {**start, **event, 'startedAt': start.get('time'), 'log': str(file), 'line': number}
                    for field in ('author', 'authorUrl', 'index', 'parent'):
                        if field in start:
                            row[field] = start[field]
                    if start.get('author') != event.get('author'):
                        row['endedDuringAuthor'] = event.get('author')
                    if kind == 'error':
                        row.update(expected=expected, outcome=event.get('outcome', outcome))
                    sequence += 1
                    if len(slowest) < limit:
                        heapq.heappush(slowest, (elapsed, sequence, row))
                    elif elapsed > slowest[0][0]:
                        heapq.heapreplace(slowest, (elapsed, sequence, row))
                    if kind == 'error':
                        target = expected_results if expected else failures
                        target.append(row)
                        del target[:-limit]
                elif kind == 'coverage_warning':
                    warnings.append(event)
    groups = [{'category': key[0], 'operation': key[1], **value} for key, value in totals.items()]
    return {'files': len(files), 'events': events, 'malformedLines': malformed,
            'operations': sorted(groups, key=lambda row: row['elapsedMs'], reverse=True),
            'slowest': [row for _, _, row in sorted(slowest, reverse=True)],
            'recentErrors': failures, 'unpairedCount': len(pending),
            'recentExpectedResults': expected_results,
            'pendingByType': dict(collections.Counter(
                'control_wait' if row.get('target') == 'fd:0' and row.get('operation') == 'read' else
                'websocket' if row.get('operation') == 'WebSocket' else 'operation'
                for row in pending.values())),
            'unpaired': sorted(pending.values(), key=lambda row: row.get('time', ''))[:limit],
            'coverageWarnings': warnings[-limit:]}


def main():
    parser = argparse.ArgumentParser(description='只读汇总 I/O 日志：耗时、失败、未结束操作')
    parser.add_argument('directory', nargs='?', default=str(PROJECT_ROOT / 'logs/io-audit'))
    parser.add_argument('--pattern', default='*.jsonl', help='只分析匹配文件，例如 *-updater-*.jsonl')
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    report = analyze(list(Path(args.directory).glob(args.pattern)), max(1, min(args.limit, 1000)))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return
    print('文件 {} 个，事件 {} 条，未配对操作 {} 个，无法解析的日志行 {} 条'.format(
        report['files'], report['events'], report['unpairedCount'], report['malformedLines']))
    print('耗时为操作累计时间；并发和嵌套操作会重叠，不能直接相加作为运行时间。')
    for row in report['operations']:
        print('{category:18} {operation:32} 次数 {calls:8} 异常 {errors:5} 预期结果 {expectedErrors:6} 累计 {elapsedMs:12.1f}ms 最长 {maxMs:10.1f}ms'.format(**row))
    print('未结束分类：' + json.dumps(report['pendingByType'], ensure_ascii=False))
    for label, rows in [('最慢操作', report['slowest']), ('最近异常', report['recentErrors']),
                        ('最近预期探测/中止（原始错误仍保留）', report['recentExpectedResults']),
                        ('未配对操作（仍在执行、缺少分卷或进程中断）', report['unpaired'])]:
        print('\n' + label)
        for row in rows:
            print('{} {} {} {}ms {} {}'.format(row.get('time', ''), row.get('category', ''),
                  row.get('operation', ''), row.get('elapsedMs', '?'), row.get('target', ''),
                  row.get('source', '')))
    if report['coverageWarnings']:
        print('\n覆盖范围提示：' + json.dumps(report['coverageWarnings'], ensure_ascii=False))


if __name__ == '__main__':
    main()
