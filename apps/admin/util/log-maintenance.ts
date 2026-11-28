import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

type LogFile = { file: string; name: string; size: number; mtimeMs: number; dev: number; ino: number; root: string; rootDev: number; rootIno: number; pid: number; session: string };
export class LogCleanupError extends Error { status = 409; }
const daysAllowed = new Set([0, 1, 7, 30]);
const auditName = /^(\d{8}T\d{6}\d*Z)-(\d+)-([a-z][a-z0-9-]*)-(\d{4,})\.jsonl$/;
const phaseName = /^(\d{8}T\d{6}Z)-(\d+)\.jsonl$/;
function alive(pid: number) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function ended(file: LogFile) {
    const handle = await open(file.file, 'r');
    try {
        const buffer = Buffer.alloc(Math.min(8192, file.size));
        await handle.read(buffer, 0, buffer.length, Math.max(0, file.size - buffer.length));
        return buffer.toString().trim().split('\n').some(line => {
            try { return JSON.parse(line).event === 'audit_stop'; } catch { return false; }
        });
    } finally { await handle.close(); }
}
export async function inspectLogs(project: string, days: number, auditDirectory = process.env.LIBRARY_IO_AUDIT_DIR ?? path.join(project, 'logs/io-audit')) {
    if (!daysAllowed.has(days)) throw new LogCleanupError('日志保留范围无效');
    const candidates: LogFile[] = [], retained: LogFile[] = [];
    const cutoff = Date.now() - days * 86400_000;
    for (const [directory, expression, isAudit] of [[auditDirectory, auditName, true], [path.join(project, 'logs/library-update'), phaseName, false]] as const) {
        let rootInfo;
        try { rootInfo = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new LogCleanupError('日志目录已变化，请检查日志目录');
        const root = await realpath(directory);
        const groups = new Map<string, LogFile[]>();
        for (const entry of await readdir(root, { withFileTypes: true })) {
            const match = expression.exec(entry.name);
            if (!entry.isFile() || !match) continue;
            const file = path.join(root, entry.name), info = await lstat(file);
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const session = isAudit ? entry.name.replace(/-\d{4,}\.jsonl$/, '') : entry.name;
            const row = { file, name: path.relative(project, file), size: info.size, mtimeMs: info.mtimeMs,
                dev: info.dev, ino: info.ino, root, rootDev: rootInfo.dev, rootIno: rootInfo.ino, pid: Number(match[2]), session };
            const group = groups.get(session) ?? []; group.push(row); groups.set(session, group);
        }
        for (const group of groups.values()) {
            group.sort((a, b) => a.file.localeCompare(b.file));
            const last = group[group.length - 1]!;
            // Keep every volume of a running session, including already-rotated volumes.
            const running = alive(last.pid) && !(isAudit && await ended(last));
            (running || days > 0 && group.some(row => row.mtimeMs > cutoff) ? retained : candidates).push(...group);
        }
    }
    candidates.sort((a, b) => a.file.localeCompare(b.file));
    const token = createHash('sha256').update(JSON.stringify([days, candidates])).digest('hex');
    return { days, token, files: candidates.length, bytes: candidates.reduce((sum, row) => sum + row.size, 0),
        retainedFiles: retained.length, retainedBytes: retained.reduce((sum, row) => sum + row.size, 0),
        examples: candidates.slice(0, 8).map(row => row.name), candidates };
}
export function logPreview(report: Awaited<ReturnType<typeof inspectLogs>>) {
    const { candidates: _private, ...summary } = report;
    return summary;
}
export async function cleanupLogs(project: string, days: number, token: string, auditDirectory?: string) {
    const report = await inspectLogs(project, days, auditDirectory);
    if (!/^[a-f0-9]{64}$/.test(token) || token !== report.token) throw new LogCleanupError('日志范围已变化，请重新查看清理范围');
    let removedFiles = 0, removedBytes = 0, skippedFiles = 0;
    for (const row of report.candidates) {
        try {
            const root = await lstat(row.root), info = await lstat(row.file);
            if (!root.isDirectory() || root.isSymbolicLink() || root.dev !== row.rootDev || root.ino !== row.rootIno ||
                !info.isFile() || info.isSymbolicLink() || info.ino !== row.ino || info.dev !== row.dev || info.size !== row.size || info.mtimeMs !== row.mtimeMs) {
                skippedFiles++; continue;
            }
            await unlink(row.file); removedFiles++; removedBytes += row.size;
        } catch (error) {
            if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            skippedFiles++;
        }
    }
    return { removedFiles, removedBytes, skippedFiles };
}
