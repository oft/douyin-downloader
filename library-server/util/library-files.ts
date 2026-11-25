import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { parallelMap } from './catalog.ts';
import type { Catalog, WorkCopy } from './catalog.ts';
import { assertDirectory, authorsFile, trashDirectory } from './removal-state.ts';

export type RemovalKind = 'works' | 'authors';

interface Entry {
    name: string;
    kind: 'file' | 'directory' | 'link' | 'other';
    size?: number;
    stamp: string;
    identity: string;
}

interface Unit {
    relative: string;
    kind: 'file' | 'directory';
    stamp: string;
    identity: string;
    entries?: Entry[];
}

const order = new Intl.Collator('zh-CN', { numeric: true });
const identity = (info: Stats) => `${info.dev}:${info.ino}`;
const stamp = (info: Stats) => `${identity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

function entryKind(details: Stats): Entry['kind'] {
    return details.isSymbolicLink() ? 'link' : details.isDirectory() ? 'directory' : details.isFile() ? 'file' : 'other';
}

function fromRoot(root: string, relative: string) {
    if (!relative) return root;
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)) ||
        [trashDirectory, authorsFile].includes(parts[0]!.toLowerCase())) {
        throw new Error('路径超出索引范围');
    }
    return path.join(root, ...parts);
}

async function inspectPath(absolute: string, kind: Unit['kind']) {
    const details = await lstat(absolute);
    if (!(kind === 'file' ? details.isFile() : details.isDirectory()) || path.relative(absolute, await realpath(absolute)) !== '') {
        throw new Error('文件或目录已被替换或重定向');
    }
    return details;
}

async function filesIn(directory: string) {
    const files: Entry[] = [];
    async function visit(prefix: string) {
        const current = path.join(directory, prefix);
        await assertDirectory(current);
        const names = (await readdir(current)).sort(order.compare);
        for (const name of names) {
            const relative = prefix ? `${prefix}/${name}` : name;
            const details = await lstat(path.join(current, name));
            const kind = entryKind(details);
            files.push({ name: relative, kind, size: kind === 'file' ? details.size : undefined, stamp: stamp(details), identity: identity(details) });
            if (kind === 'directory') await visit(relative);
        }
    }
    await visit('');
    return files;
}

async function copyInventory(root: string, copy: WorkCopy) {
    const base = { source: copy.source, directory: copy.directory, flat: copy.flatFiles !== undefined };
    try {
        const directory = fromRoot(root, copy.directory);
        const files: Entry[] = [];
        const units: Unit[] = [];
        if (copy.flatFiles) {
            await assertDirectory(directory);
            for (const name of copy.flatFiles) {
                const relative = copy.directory ? `${copy.directory}/${name}` : name;
                const details = await inspectPath(fromRoot(root, relative), 'file');
                units.push({ relative, kind: 'file', stamp: stamp(details), identity: identity(details) });
                files.push({ name, kind: 'file', size: details.size, stamp: stamp(details), identity: identity(details) });
            }
        } else {
            if (!copy.directory) throw new Error('无法删除下载根目录');
            const details = await inspectPath(directory, 'directory');
            files.push(...await filesIn(directory));
            units.push({ relative: copy.directory, kind: 'directory', stamp: stamp(details), identity: identity(details), entries: files });
        }
        return { ...base, files, units, error: undefined };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, files: [], units: [], error: undefined };
        const reason = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : '读取失败';
        return { ...base, files: [], units: [], error: reason };
    }
}

export async function removalPlan(catalog: Catalog, kind: RemovalKind, id: string) {
    const work = kind === 'works' ? catalog.workById.get(id) : undefined;
    const author = kind === 'authors' ? catalog.authorById.get(id) : undefined;
    if (!work && !author) return undefined;
    const works = work ? [work] : catalog.works.filter(item => item.authorId === id);
    const copies = await parallelMap(works.flatMap(item => item.copies), copy => copyInventory(catalog.root, copy));
    const units = [...new Map(copies.flatMap(copy => copy.units).map(unit => [unit.relative, unit])).values()];
    const entries = copies.flatMap(copy => copy.files).filter(file => file.kind !== 'directory');
    const errors = copies.filter(copy => copy.error).map(copy => `${copy.directory || '.'}：${copy.error}`);
    if (author && catalog.issues.some(issue => issue.authorId === author.id && issue.code === 'unreadable_folder')) {
        errors.push('此作者存在无法扫描的目录，请先检查目录并重新扫描。');
    }
    const token = errors.length ? undefined : createHash('sha256').update(JSON.stringify({
        scannedAt: catalog.scannedAt, kind, id, units,
    })).digest('hex');
    return {
        units,
        view: {
            title: work?.title ?? author?.name, token, errors, workCount: works.length, copyCount: copies.length,
            fileCount: entries.length, size: entries.reduce((sum, file) => sum + (file.size ?? 0), 0),
            copies: work ? copies.map(({ units, files, ...copy }) => ({ ...copy, files: files.map(({ stamp, identity, ...file }) => file) })) : undefined,
            works: author ? works.slice(0, 50).map(item => ({ id: item.id, title: item.title, copyCount: item.copies.length })) : undefined,
        },
    };
}

async function deleteEntry(absolute: string, expected: Pick<Entry, 'kind' | 'identity' | 'stamp'>) {
    await assertDirectory(path.dirname(absolute));
    const details = await lstat(absolute);
    if (entryKind(details) !== expected.kind || identity(details) !== expected.identity) throw new Error('文件或目录已被替换');
    if (expected.kind === 'directory') {
        await assertDirectory(absolute);
        await rmdir(absolute);
    } else {
        if (stamp(details) !== expected.stamp) throw new Error('文件内容已变更');
        await unlink(absolute);
    }
}

export async function deletePermanently(root: string, kind: RemovalKind, id: string, units: Unit[]) {
    await assertDirectory(root);
    let deletedFiles = 0;
    let deletedDirectories = 0;
    try {
        // Recheck every top-level target before deleting any files.
        const targets = await parallelMap(units, async unit => {
            if (!unit.relative) throw new Error('无法删除下载根目录');
            const absolute = fromRoot(root, unit.relative);
            if (stamp(await inspectPath(absolute, unit.kind)) !== unit.stamp) throw new Error('文件或目录已变更');
            return absolute;
        });
        for (const [index, unit] of units.entries()) {
            for (const entry of (unit.entries ?? []).slice().reverse()) {
                await deleteEntry(fromRoot(root, `${unit.relative}/${entry.name}`), entry);
                if (entry.kind === 'directory') deletedDirectories++;
                else deletedFiles++;
            }
            await deleteEntry(targets[index]!, unit);
            if (unit.kind === 'directory') deletedDirectories++;
            else deletedFiles++;
        }
    } catch (error) {
        const detail = error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.message : '删除失败';
        throw new Error(`删除中止，已永久删除 ${deletedFiles} 个文件和 ${deletedDirectories} 个目录（${detail}）。`);
    }
    return { deletedFiles, deletedDirectories };
}
