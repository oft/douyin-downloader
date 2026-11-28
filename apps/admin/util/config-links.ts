import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

export class LinkConfigError extends Error {
    readonly status: 409 | 422;

    constructor(message: string, status: 409 | 422 = 422) {
        super(message);
        this.status = status;
    }
}

function readSource(file: string) {
    try { return readFileSync(file, 'utf8'); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}

function readDocument(source: string) {
    const document = parseDocument(source, { merge: true });
    if (document.errors.length) throw new LinkConfigError('配置文件的 YAML 格式无效');
    let config: unknown;
    try { config = document.toJS(); }
    catch { throw new LinkConfigError('配置文件中有无法解析的 YAML 引用'); }
    if (!isMap(document.contents) && config !== null) throw new LinkConfigError('配置文件应为 YAML 映射');
    const { link, ...settings } = (config ?? {}) as Record<string, unknown>;
    const links = link == null ? [] : typeof link === 'string' ? [link] : link;
    if (!Array.isArray(links) || !links.every(item => typeof item === 'string')) {
        throw new LinkConfigError('配置中的 link 应为文本或文本列表');
    }
    return { document, links: links as string[], settings };
}

function linkRevision(links: string[]) {
    return createHash('sha256').update(JSON.stringify(links)).digest('hex');
}

function replaceLinks(source: string, document: ReturnType<typeof parseDocument>, links: string[]) {
    // Splice source ranges to preserve the formatting of the surrounding settings.
    const root = document.contents;
    const eol = source.match(/\r?\n/)?.[0] ?? '\n';
    const quoted = links.map(link => JSON.stringify(link).replace(/[\u007f-\u009f\u2028\u2029]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
    const flow = `[${quoted.join(', ')}]`;
    const block = (indent: string) => quoted.map(link => `- ${link}`).join(eol + indent);
    const field = isMap(root) ? root.items.find(pair => isScalar(pair.key) && pair.key.value === 'link') : undefined;
    const value = field?.value;
    if ((isAlias(value) || isScalar(value) || isSeq(value)) && value.range) {
        const [start, end] = value.range;
        const newline = source.slice(start, end).match(/\r?\n$/)?.[0] ?? '';
        if (isSeq(value) && !value.flow) {
            const indent = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
            const content = links.length ? block(indent) : `${indent ? '' : '  '}[]`;
            return source.slice(0, start) + content + newline + source.slice(end);
        }
        const spaceBefore = start === end && source[start - 1] === ':' ? ' ' : '';
        const spaceAfter = start === end && source[start] === '#' ? ' ' : '';
        return source.slice(0, start) + spaceBefore + flow + spaceAfter + newline + source.slice(end);
    }
    if (field) throw new LinkConfigError('此 link 使用了 YAML 引用，请直接编辑配置文件');

    if (isMap(root) && root.range) {
        const [start, end] = root.range;
        if (root.flow) {
            const insert = start + 1;
            const separator = root.items.length ? ', ' : source[insert] === '#' ? ' ' : '';
            return source.slice(0, insert) + `link: ${flow}${separator}` + source.slice(insert);
        }
        const linePrefix = source.slice(source.lastIndexOf('\n', start - 1) + 1, start);
        const indent = linePrefix.match(/^\uFEFF?( *)/)?.[1] ?? '';
        const entry = links.length ? `link:${eol}${indent}  ${block(indent + '  ')}` : 'link: []';
        const separator = source[end - 1] === '\n' ? '' : eol;
        return source.slice(0, end) + separator + indent + entry + eol + source.slice(end);
    }

    const start = root?.range?.[0] ?? source.length;
    const end = root?.range?.[1] ?? start;
    const prefix = source.slice(0, start);
    const separator = prefix && prefix !== '\uFEFF' && !prefix.endsWith('\n') ? eol : '';
    return prefix + separator + `link: ${flow}` + eol + source.slice(end);
}

export function readConfigLinks(file: string) {
    const { links } = readDocument(readSource(file));
    return { links, revision: linkRevision(links) };
}

export function saveConfigLinks(file: string, links: string[], revision: string) {
    const target = lstatSync(file, { throwIfNoEntry: false }) ? realpathSync(file) : file;
    const source = readSource(target);
    const current = readDocument(source);
    const conflict = () => new LinkConfigError('配置已被修改，请重新读取后再保存', 409);
    if (linkRevision(current.links) !== revision) throw conflict();
    if (isDeepStrictEqual(current.links, links)) return { links, revision };

    const updated = replaceLinks(source, current.document, links);
    const saved = readDocument(updated);
    if (!isDeepStrictEqual(saved.links, links) || !isDeepStrictEqual(saved.settings, current.settings)) {
        throw new LinkConfigError('无法单独更新 link，请直接编辑配置文件');
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    const mode = statSync(target, { throwIfNoEntry: false })?.mode;
    try {
        writeFileSync(temporary, updated, { flag: 'wx', mode: mode === undefined ? 0o600 : mode & 0o777 });
        if (readSource(target) !== source) throw conflict();
        renameSync(temporary, target);
    } finally {
        rmSync(temporary, { force: true });
    }
    return { links, revision: linkRevision(links) };
}
