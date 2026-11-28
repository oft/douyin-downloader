import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const trashDirectory = '.catalog-trash';
export const authorsFile = '.catalog-removed-authors.json';

export async function assertDirectory(directory: string) {
    const details = await lstat(directory);
    if (!details.isDirectory() || path.relative(directory, await realpath(directory)) !== '') {
        throw new Error('目录已被重定向，操作已停止');
    }
}

async function readAuthorIds(file: string) {
    try {
        await assertDirectory(path.dirname(file));
        if (!(await lstat(file)).isFile()) throw new Error('已删除作者记录不是常规文件');
        const value: unknown = JSON.parse(await readFile(file, 'utf8'));
        if (!Array.isArray(value) || !value.every(id => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id))) {
            throw new Error('已删除作者记录无法读取');
        }
        return value as string[];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

export async function readRemovedAuthors(root: string) {
    const records = await Promise.all([
        readAuthorIds(path.join(root, authorsFile)),
        readAuthorIds(path.join(root, trashDirectory, 'removed-authors.json')),
    ]);
    return new Set(records.flat());
}

export async function recordRemovedAuthor(root: string, id: string) {
    const ids = await readRemovedAuthors(root);
    if (ids.has(id)) return;
    const temporary = path.join(root, `${authorsFile}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify([...ids, id], null, 2), { flag: 'wx' });
    try {
        await rename(temporary, path.join(root, authorsFile));
    } finally {
        await unlink(temporary).catch(() => {});
    }
}
