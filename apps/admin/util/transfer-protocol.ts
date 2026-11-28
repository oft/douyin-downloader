import { canonicalLink } from './transfer-index.ts';
import type { RemoteSource, ShareManifest } from './transfer-types.ts';

export function remoteSource(value: RemoteSource): RemoteSource {
    const url = new URL(value.address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('请填写分享服务的完整地址，例如 http://192.168.1.10:12345');
    }
    const code = value.code?.trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(code)) throw new Error('分享码格式无效');
    return { address: url.origin, code };
}

export function validateManifest(input: unknown): ShareManifest {
    const data = input as ShareManifest;
    const fail = () => { throw new Error('分享清单格式不兼容或关联关系不完整'); };
    const string = (s: unknown, max = 256) => typeof s === 'string' && s.length <= max && !/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(s);
    const hash = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
    const identity = (s: unknown) => string(s, 256) && /^[A-Za-z0-9:_-]+$/.test(s as string);
    if (!data || data.version !== 1 || !string(data.instanceId) || !hash(data.snapshotId) || !string(data.createdAt) ||
        !Array.isArray(data.authors) || data.authors.length > 100_000 || !Array.isArray(data.links) || data.links.length > 100_000 ||
        !Array.isArray(data.works) || data.works.length > 200_000 || !Array.isArray(data.files) || data.files.length > 500_000 ||
        !Number.isSafeInteger(data.unassignedFiles) || data.unassignedFiles < 0 || data.unassignedFiles > 1_000_000 ||
        data.unassigned !== undefined && (!Array.isArray(data.unassigned) || data.unassigned.length > 100 || data.unassigned.some(f =>
            !f || !string(f.path, 4096) || f.path.startsWith('/') || /[\\\0]/.test(f.path) || f.path.split('/').some(p => p === '..' || p === '.') || !Number.isSafeInteger(f.size) || f.size < 0))) fail();
    const authors = new Set<string>();
    for (const author of data.authors) {
        if (!author || !identity(author.id) || authors.has(author.id) || !string(author.uid, 200) || !/^[A-Za-z0-9_-]*$/.test(author.uid) || !string(author.secUid, 200) || !/^[A-Za-z0-9_-]*$/.test(author.secUid) ||
            !string(author.name, 1000) || !Array.isArray(author.aliases) || author.aliases.length > 1000 || !author.aliases.every(s => string(s, 1000))) fail();
        authors.add(author.id);
    }
    const works = new Map<string, Set<string>>();
    for (const work of data.works) {
        if (!work || typeof work.id !== 'string' || !/^(?:\d{1,24}|local-[a-f0-9]{32})$/.test(work.id) || works.has(work.id) || !['video', 'gallery'].includes(work.type) ||
            !string(work.title, 100_000) || work.authorId !== null && !authors.has(work.authorId) ||
            work.createTime !== null && (!Number.isSafeInteger(work.createTime) || work.createTime < 0) ||
            !Number.isSafeInteger(work.imageCount) || work.imageCount < 0 || work.imageCount > 10000 ||
            !Array.isArray(work.files) || work.files.length > 20000 || new Set(work.files).size !== work.files.length) fail();
        works.set(work.id, new Set(work.files));
    }
    const files = new Set<string>();
    let total = 0;
    for (const file of data.files) {
        if (!file || !hash(file.id) || files.has(file.id) || !hash(file.sha256) || !works.get(file.workId)?.has(file.id) ||
            !['video', 'image', 'music', 'cover', 'avatar', 'metadata'].includes(file.role) ||
            !Number.isSafeInteger(file.index) || file.index < 0 || file.index > 10000 || !Number.isSafeInteger(file.size) || file.size <= 0 ||
            !string(file.name, 2048) || /[\\/\0-\x1f]/.test(file.name) || !string(file.mime, 100) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime)) fail();
        files.add(file.id); total += file.size;
        if (!Number.isSafeInteger(total)) fail();
    }
    for (const members of works.values()) for (const id of members) if (!files.has(id)) fail();
    const links = new Set<string>();
    for (const link of data.links) {
        if (!link || !string(link.url, 4096) || canonicalLink(link.url) !== link.url || links.has(link.url) || typeof link.enabled !== 'boolean' ||
            !['associated', 'unresolved'].includes(link.status) ||
            link.status === 'associated' && (!link.authorId || !authors.has(link.authorId)) ||
            link.status === 'unresolved' && link.authorId !== null) fail();
        links.add(link.url);
    }
    return data;
}

export async function fetchManifest(source: RemoteSource, signal?: AbortSignal) {
    const remote = remoteSource(source);
    const response = await fetch(`${remote.address}/v1/manifest`, {
        headers: { Authorization: `Bearer ${remote.code}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(response.status === 401 ? '分享码无效或服务已关闭' : `无法读取分享清单（${response.status}）`);
    const limit = 256 * 1024 * 1024;
    if (Number(response.headers.get('Content-Length') ?? 0) > limit) { await response.body?.cancel(); throw new Error('分享清单过大，请缩小分享范围'); }
    const buffers: Uint8Array[] = [];
    let length = 0;
    if (!response.body) throw new Error('分享服务未返回清单');
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        length += chunk.byteLength;
        if (length > limit) throw new Error('分享清单过大，请缩小分享范围');
        buffers.push(chunk);
    }
    return validateManifest(JSON.parse(Buffer.concat(buffers).toString('utf8')));
}
