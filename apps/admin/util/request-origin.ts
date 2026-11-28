const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Trust only explicitly configured origins; forwarded headers never grant access.
export function isLibraryRequest(requestUrl: string, origin?: string, configured = process.env.LIBRARY_TRUSTED_ORIGINS ?? '') {
    const url = new URL(requestUrl);
    const trusted = configured.split(',').flatMap(value => {
        try {
            const candidate = new URL(value.trim());
            return ['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password &&
                candidate.pathname === '/' && !candidate.search && !candidate.hash ? [candidate] : [];
        } catch { return []; }
    });
    const local = localHosts.has(url.hostname);
    const matches = trusted.filter(candidate => candidate.host === url.host);
    if (!local && matches.length === 0) return false;
    if (!origin) return true;
    return local && origin === url.origin || matches.some(candidate => candidate.origin === origin);
}
