import { readFile, readdir, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase } from './db.ts';

export async function collectUpdateDiagnostics(project: string, database: string, current: unknown) {
    const directory = path.join(project, 'logs/library-update');
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const files = names.filter(name => /^\d{8}T\d{6}Z-\d+\.jsonl$/.test(name)).sort().slice(-8);
    const latest = new Map<string, any>(), runs: any[] = [];
    let invalidLines = 0;
    for (const file of files) {
        let author: any;
        for (const line of (await readFile(path.join(directory, file), 'utf8')).split('\n')) {
            if (!line.trim()) continue;
            let event; try { event = JSON.parse(line); } catch { invalidLines++; continue; }
            if (event.event === 'author_start') author = { url: event.url, author: '', startedAt: event.time, pages: 0,
                state: 'running', received: 0, newWorks: null, downloaded: 0, skipped: 0, failed: 0, file };
            if (!author) continue;
            if (event.author) author.author = event.author;
            if (event.event === 'phase') author.phase = event.step;
            if (['post_incremental_policy', 'post_audit_policy'].includes(event.event)) {
                author.localSaved = event.localSaved; author.total = event.total; author.allowPageStop = event.allowPageStop;
                author.historyChecked = event.historyChecked ?? false;
                author.historyGap = event.historyGap;
            }
            if (event.event === 'post_page') { author.pages++; author.remainingGap = event.remainingGap; author.reason = event.reason;
                author.historyGap = event.historyGap; author.newGap = event.newGap;
                if (Number.isInteger(event.received)) author.received = event.received;
                if (Number.isInteger(event.newWorks)) author.newWorks = event.newWorks;
            }
            if (event.event === 'author_budget') { author.reason = 'profile_timeout'; author.budgetMs = event.budgetMs; }
            if (['author_finished', 'author_failed'].includes(event.event)) {
                Object.assign(author, { elapsedMs: event.elapsedMs, received: author.received || event.items || 0, downloaded: event.success ?? 0,
                    skipped: event.skipped ?? 0, failed: event.failed ?? 0, finishedAt: event.time,
                    state: event.event === 'author_failed' ? 'failed' : event.status || 'finished' });
                if (event.reason) author.reason = event.reason;
                runs.push({ ...author });
            }
            latest.set(author.url, { ...author });
        }
        const pid = Number(file.match(/-(\d+)\.jsonl$/)?.[1]);
        let active = true;
        try { process.kill(pid, 0); } catch (error) { active = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (!active && author?.state === 'running') { author.state = 'interrupted'; latest.set(author.url, { ...author }); }
    }
    const db = openDatabase(database, true);
    let audits: any[] = [], counts: any[] = [], schedule: any[] = [];
    try {
        const has = (table: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
        if (has('library_post_audit')) {
            const columns = db.prepare('PRAGMA table_info(library_post_audit)').all() as { name: string }[];
            const baseline = columns.some(row => row.name === 'checked_gap') ? 'checked_gap' : 'NULL AS checked_gap';
            audits = db.prepare(`SELECT scope,sec_uid,author,homepage_total,registered_count,remaining_gap,pages,received,new_works,repair_works,oldest_time,status,reason,auto_checked,retry_requested,updated_us,${baseline} FROM library_post_audit ORDER BY updated_us DESC LIMIT 1000`).all();
        }
        if (has('library_author_counts')) counts = db.prepare("SELECT author_key,present_works,complete_works FROM library_author_counts WHERE author_key<>''").all();
        if (has('library_update_state')) schedule = db.prepare("SELECT target_key,status,last_attempt_us FROM library_update_state WHERE status IN ('failed','partial','unavailable','interrupted','queued') ORDER BY last_attempt_us DESC LIMIT 100").all();
    } finally { db.close(); }
    for (const row of latest.values()) {
        const key = typeof row.url === 'string' ? 'user:' + row.url.split('/user/')[1]?.split(/[?#/]/)[0] : '';
        const queued = schedule.find(entry => entry.target_key === key);
        if (queued) { row.targetKey = key; row.state = queued.status; }
    }
    const finished = [...latest.values()].filter(row => row.state !== 'running');
    const durations = finished.map(row => row.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
    return { checkedAt: new Date().toISOString(), current, files: files.length, invalidLines,
        authors: [...latest.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), audits, counts, schedule,
        slowest: runs.filter(row => Number.isFinite(row.elapsedMs)).sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 10),
        summary: { authors: latest.size, failed: finished.filter(row => row.state === 'failed').length,
            onePage: finished.filter(row => row.pages === 1).length,
            medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : 0 } };
}
export async function saveDiagnostics(file: string, report: unknown) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    await writeFile(temp, JSON.stringify(report), { mode: 0o600 });
    await rename(temp, file);
}
export function requestAuditRetry(database: string, scope: string) {
    const db = openDatabase(database);
    try {
        const row = db.prepare('SELECT sec_uid FROM library_post_audit WHERE scope=?').get(scope) as { sec_uid: string } | undefined;
        if (!row) throw new Error('核对记录已变化，请刷新诊断');
        db.prepare("UPDATE library_post_audit SET retry_requested=1,auto_checked=0,status='queued',reason='已请求下次更新重新核对历史' WHERE sec_uid=?").run(row.sec_uid);
        return { queued: true };
    } finally { db.close(); }
}

export function requestAuthorRetry(database: string, target: string) {
    const db = openDatabase(database);
    try {
        const result = db.prepare("UPDATE library_update_state SET last_attempt_us=0,status='queued' WHERE target_key=? AND status IN ('failed','partial','unavailable','interrupted','queued')").run(target);
        if (!Number(result.changes)) throw new Error('该作者状态已变化，请刷新诊断');
        return { queued: true };
    } finally { db.close(); }
}
