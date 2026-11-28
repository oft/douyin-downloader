export function mediaUrl(id) {
  return id ? `/media/${encodeURIComponent(id)}` : '';
}

export function playableWorks(items) {
  return items.filter(item => item.kind === 'video' && item.video);
}

export function nextPage(page, pages, random) {
  if (page < pages) return page + 1;
  return random && pages > 1 ? 1 : null;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function readSaved(storage) {
  try {
    const saved = JSON.parse(storage.getItem('video-web:saved') ?? '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id)))].slice(0, 2000) : [];
  } catch { return []; }
}

export function readMuted(storage) {
  try {
    const value = storage?.getItem('video-web:muted');
    return value === 'true' ? true : value === 'false' ? false : null;
  } catch { return null; }
}

export function workParams({ page, query = '', author = '' }) {
  const params = new URLSearchParams({ kind: 'video', page: String(page), size: '12' });
  if (query) params.set('q', query);
  if (author) params.set('author', author);
  return params;
}
