/** Return the stable profile ID from a Douyin homepage link or share text. */
export function profileIdFromLink(value: unknown) {
    for (const candidate of String(value).match(/https?:\/\/[^\s<>"']+/g) ?? []) {
        try {
            const url = new URL(candidate);
            if (!['www.douyin.com', 'douyin.com'].includes(url.hostname) || url.username || url.password || url.port) continue;
            const match = /^\/user\/([^/]+)\/?$/.exec(url.pathname);
            const id = match && decodeURIComponent(match[1]);
            if (id && /^[A-Za-z0-9_-]+$/.test(id)) return id;
        } catch { /* Ignore malformed and unsupported links. */ }
    }
    return undefined;
}
