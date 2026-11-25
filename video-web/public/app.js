import { mediaUrl, playableWorks, nextPage, formatTime, readSaved, readMuted, workParams } from './feed.js';

const $ = id => document.getElementById(id);
const paths = {
  search: '<circle cx="10.8" cy="10.8" r="7.3"/><path d="m16.2 16.2 4.3 4.3"/>',
  menu: '<path d="M4 6h16M4 12h12M4 18h16"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  users: '<circle cx="9" cy="8" r="3.3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a4 4 0 0 1 0 8m2 3a5 5 0 0 1 3 5"/>',
  muted: '<path d="m11 4-6 5H2v6h3l6 5ZM16 9l6 6m0-6-6 6"/>',
  volume: '<path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  heart: '<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 22l8.8-9.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  share: '<path d="m14 3 8 7-8 7v-4C8 13 5 15 2 20c0-9 4-13 12-13Z"/>',
  play: '<path d="m8 4 13 8L8 20Z"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? ''}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
for (const [id, name] of Object.entries({ 'browse-button': 'menu', 'search-button': 'search', 'previous-button': 'up', 'next-button': 'down', 'fullscreen-button': 'expand' })) $(id).innerHTML = icon(name);
document.querySelectorAll('[data-close]').forEach(el => { el.innerHTML = icon('close'); el.onclick = () => el.closest('dialog').close(); });

let storage;
try { storage = localStorage; } catch { /* Private browsing can disable storage. */ }
const saved = new Set(readSaved(storage));
let mode = 'recommend', query = '', author = '', authorName = '';
let generation = 0, controller, loading = false, page = 1, pages = 1, total = 0;
const savedMuted = readMuted(storage);
let visited = new Set(), seen = new Set(), cards = [], active, muted = savedMuted ?? true, paused = false;
let needsSoundGesture = savedMuted === null;
let favoriteIds = [], favoriteOffset = 0, removedCount = 0;
let toastTimer, tapTimer, loadFailure = false;
let authorGeneration = 0, authorPage = 0, authorPages = 1;
let motionFrame = 0, touchGesture = null, wheelLast = 0, wheelDelta = 0, wheelConsumed = false;
const authorCache = new Map();
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

async function api(route, signal) {
  const response = await fetch(`/api/catalog/${route}`, { signal, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `资料库响应异常（${response.status}）`);
  return data;
}

function showState(title, message, retry = false) {
  $('feed-state').hidden = false;
  $('state-title').textContent = title;
  $('state-message').textContent = message;
  $('retry-button').hidden = !retry;
}

function syncNav() {
  $('home-button').classList.toggle('active', mode !== 'saved');
  $('saved-button').classList.toggle('active', mode === 'saved');
  $('saved-dot').hidden = !saved.size;
  document.querySelectorAll('[data-mode]').forEach(el => {
    const selected = el.dataset.mode === mode;
    el.classList.toggle('selected', selected);
    if (selected) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $('filter-chip').hidden = !query && !author && mode !== 'saved';
  $('filter-chip').textContent = mode === 'saved' ? `我的收藏 · ${saved.size} 条` : `${author ? `@${authorName}` : `搜索：${query}`}  ×`;
}

function message(card, text = '', error = false) {
  const el = card.querySelector('.playback-message');
  el.replaceChildren(document.createTextNode(text));
  el.hidden = !text;
  el.classList.toggle('error', error);
  if (error) {
    const retry = document.createElement('button');
    retry.textContent = '重新播放';
    retry.onclick = () => { const video = card.querySelector('video'); video.load(); paused = false; play(card); };
    el.append(retry);
  }
}

function syncPlayback(card) {
  if (card !== active) return;
  const video = card.querySelector('video');
  card.querySelector('.play-glyph').hidden = !video.paused || video.error;
  card.querySelector('.play-hit').setAttribute('aria-label', video.paused ? '播放视频' : '暂停视频');
}

function syncSound() {
  $('sound-button').querySelector('.nav-icon').innerHTML = icon(muted ? 'muted' : 'volume');
  $('sound-label').textContent = muted ? '静音' : '声音';
  $('sound-button').setAttribute('aria-label', muted ? '开启声音' : '关闭声音');
  $('sound-button').setAttribute('aria-pressed', String(!muted));
  $('sound-hint').hidden = !active || !muted || !needsSoundGesture;
}

function chooseSound(nextMuted) {
  muted = nextMuted;
  needsSoundGesture = false;
  try { storage?.setItem('video-web:muted', String(muted)); } catch { /* Keep this session's choice. */ }
  cards.forEach(card => { card.querySelector('video').muted = muted; });
  syncSound();
  if (active && !paused) play(active);
}

async function play(card) {
  if (card !== active || document.hidden || document.querySelector('dialog[open]') || paused) return;
  const video = card.querySelector('video');
  video.muted = muted;
  try {
    await video.play();
    if (card !== active || document.hidden || document.querySelector('dialog[open]') || paused) { video.pause(); return; }
    message(card);
  } catch (error) {
    if (card !== active || error.name === 'AbortError') return;
    card.classList.remove('loading');
    if (error.name === 'NotAllowedError' && !muted) {
      // Keep the saved preference. This document needs a fresh gesture to play with sound.
      muted = true;
      needsSoundGesture = true;
      cards.forEach(row => { row.querySelector('video').muted = true; });
      syncSound();
      return play(card);
    }
    if (error.name === 'NotAllowedError') message(card, '轻点画面，开始播放');
    else message(card, '视频暂时无法播放，可重试或上滑看下一条', true);
  }
  syncPlayback(card);
}

function ensureMedia() {
  const current = cards.indexOf(active);
  cards.forEach((card, index) => {
    const video = card.querySelector('video');
    if (Math.abs(index - current) <= 1) {
      if (!video.hasAttribute('src')) { video.src = mediaUrl(card.work.video); video.preload = index === current ? 'auto' : 'metadata'; }
    } else if (video.hasAttribute('src')) {
      video.pause(); video.removeAttribute('src'); video.load();
      card.classList.remove('loading');
    }
    if (card !== active) video.pause();
  });
}

function activate(card) {
  if (active === card || !cards.includes(card)) return;
  clearTimeout(tapTimer);
  active?.querySelector('video').pause();
  active = card;
  paused = false;
  syncSound();
  ensureMedia();
  loadAvatar(card);
  syncCounter();
  play(card);
  const url = new URL(location.href);
  url.searchParams.set('v', card.work.id);
  history.replaceState(null, '', url);
  if (cards.indexOf(card) >= cards.length - 3) loadMore();
  // Keep a bounded DOM and only three attached video sources during long sessions.
  trimCards();
}

function trimCards() {
  if (!motionFrame && !touchGesture && cards.length > 48 && cards.indexOf(active) > 15) {
    const height = $('feed').clientHeight;
    const scroll = $('feed').scrollTop;
    cards.splice(0, 12).forEach(old => { observer.unobserve(old); old.remove(); });
    removedCount += 12;
    $('feed').scrollTop = scroll - 12 * height;
  }
}

async function loadAvatar(card) {
  const id = card.work.authorId;
  if (!id || card.avatarLoaded) return;
  try {
    if (!authorCache.has(id)) {
      if (authorCache.size >= 200) authorCache.delete(authorCache.keys().next().value);
      authorCache.set(id, api(`authors/${encodeURIComponent(id)}`).catch(error => { authorCache.delete(id); throw error; }));
    }
    const data = await authorCache.get(id);
    if (!data.avatar || !card.isConnected) return;
    const avatar = document.createElement('img');
    avatar.alt = '';
    avatar.src = mediaUrl(data.avatar);
    avatar.onerror = () => { card.querySelector('.avatar-button').textContent = (card.work.authorName || '影').slice(0, 1); };
    card.querySelector('.avatar-button').replaceChildren(avatar);
    card.avatarLoaded = true;
  } catch { /* Keep the author's initial when no local avatar is available. */ }
}

function syncCounter() {
  if (active) $('feed-counter').textContent = `${removedCount + cards.indexOf(active) + 1} / ${total}`;
}

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting && entry.intersectionRatio >= .65) activate(entry.target);
}, { root: $('feed'), threshold: [.65] });

function toggleSave(card, force = false) {
  const id = card.work.id;
  const next = force || !saved.has(id);
  if (next && saved.size >= 2000 && !saved.has(id)) { toast('收藏已达 2000 条上限'); return; }
  if (next) saved.add(id); else saved.delete(id);
  try { storage?.setItem('video-web:saved', JSON.stringify([...saved])); }
  catch { toast('浏览器无法保存收藏，本次访问仍然可用'); }
  for (const row of cards) {
    const button = row.querySelector('[data-action="save"]');
    button.classList.toggle('is-saved', saved.has(row.work.id));
    button.setAttribute('aria-pressed', String(saved.has(row.work.id)));
    button.querySelector('span').textContent = saved.has(row.work.id) ? '已收藏' : '收藏';
  }
  syncNav();
}

function createCard(work) {
  const card = document.createElement('article');
  card.className = 'slide';
  card.work = work;
  card.setAttribute('aria-label', `${work.authorName || '未知作者'}的视频`);
  card.innerHTML = `${work.cover ? `<img class="video-backdrop" src="${mediaUrl(work.cover)}" alt="" loading="lazy">` : ''}
    <video playsinline webkit-playsinline muted loop preload="none"${work.cover ? ` poster="${mediaUrl(work.cover)}"` : ''}></video>
    <div class="shade"></div><button class="play-hit" aria-label="暂停视频"></button>
    <div class="play-glyph" hidden>${icon('play')}</div><div class="playback-message" role="status" hidden></div>
    <div class="video-info"><button class="author-name" data-action="author">@${escape(work.authorName || '未知作者')}</button><p class="video-title">${escape(work.title || '记录此刻')}</p>
    <div class="video-date">${icon('clock')}<span>${escape(work.time?.slice(0, 10) || '本地珍藏')} · 本地视频</span></div></div>
    <div class="video-actions"><button class="avatar-button" data-action="author" aria-label="查看作者视频">${escape((work.authorName || '影').slice(0, 1))}</button>
    <button class="action${saved.has(work.id) ? ' is-saved' : ''}" data-action="save" aria-pressed="${saved.has(work.id)}">${icon('heart')}<span>${saved.has(work.id) ? '已收藏' : '收藏'}</span></button>
    <button class="action" data-action="share" aria-label="分享当前视频">${icon('share')}<span>分享</span></button></div>
    <div class="progress-row"><span class="time-label elapsed">0:00</span><input class="progress" type="range" min="0" max="1000" value="0" aria-label="播放进度"><span class="time-label duration">0:00</span></div>`;
  const video = card.querySelector('video');
  video.muted = muted;
  const progress = card.querySelector('.progress');
  let seeking = false, resumeAfterSeek = false;
  video.addEventListener('timeupdate', () => {
    if (seeking) return;
    const value = Number.isFinite(video.duration) && video.duration > 0 ? video.currentTime / video.duration * 1000 : 0;
    progress.value = String(value);
    progress.style.setProperty('--played', `${value / 10}%`);
    card.querySelector('.elapsed').textContent = formatTime(video.currentTime);
  });
  video.addEventListener('loadedmetadata', () => { card.querySelector('.duration').textContent = formatTime(video.duration); });
  for (const event of ['play', 'pause']) video.addEventListener(event, () => syncPlayback(card));
  video.addEventListener('playing', () => { card.classList.remove('loading'); message(card); });
  video.addEventListener('waiting', () => { if (card === active) card.classList.add('loading'); });
  video.addEventListener('error', () => { card.classList.remove('loading'); if (card === active && video.hasAttribute('src')) message(card, '视频文件不可用或浏览器不支持此格式', true); });
  progress.addEventListener('pointerdown', () => { seeking = true; resumeAfterSeek = !video.paused; video.pause(); });
  progress.addEventListener('input', () => {
    if (Number.isFinite(video.duration)) {
      video.currentTime = Number(progress.value) / 1000 * video.duration;
      progress.style.setProperty('--played', `${Number(progress.value) / 10}%`);
      card.querySelector('.elapsed').textContent = formatTime(video.currentTime);
    }
  });
  const endSeek = () => { if (!seeking) return; seeking = false; if (resumeAfterSeek) play(card); };
  progress.addEventListener('pointerup', endSeek);
  progress.addEventListener('pointercancel', endSeek);
  progress.addEventListener('change', endSeek);
  card.querySelector('.play-hit').onclick = () => {
    if (tapTimer) {
      clearTimeout(tapTimer); tapTimer = null;
      toggleSave(card, true);
      const burst = document.createElement('div'); burst.className = 'heart-burst'; burst.innerHTML = icon('heart'); card.append(burst);
      setTimeout(() => burst.remove(), 700);
      return;
    }
    tapTimer = setTimeout(() => { tapTimer = null; togglePlay(); }, 200);
  };
  card.querySelector('.video-title').onclick = event => event.currentTarget.classList.toggle('expanded');
  card.querySelectorAll('[data-action="author"]').forEach(button => {
    button.disabled = !work.authorId;
    button.onclick = () => reset({ mode: 'latest', author: work.authorId, authorName: work.authorName });
  });
  card.querySelector('[data-action="save"]').onclick = () => toggleSave(card);
  card.querySelector('[data-action="share"]').onclick = async () => {
    const url = new URL(location.origin); url.searchParams.set('v', work.id);
    try {
      if (navigator.share) await navigator.share({ title: work.title || '随看 · 本地视频', url: url.href });
      else { await navigator.clipboard.writeText(url.href); toast('视频链接已复制'); }
    } catch (error) { if (error.name !== 'AbortError') toast('暂时无法分享，请复制浏览器地址'); }
  };
  return card;
}

function appendWorks(works) {
  for (const work of playableWorks(works)) {
    if (seen.has(work.id)) continue;
    seen.add(work.id);
    const card = createCard(work); cards.push(card); $('feed').append(card); observer.observe(card);
  }
  if (cards.length) $('feed-state').hidden = true;
  if (!active && cards.length) activate(cards[0]);
}

async function loadMore() {
  if (loading) return;
  const token = generation;
  const signal = controller.signal;
  if (mode === 'saved' ? favoriteOffset >= favoriteIds.length : page === null || visited.has(page)) return;
  loading = true;
  loadFailure = false;
  $('more-retry').hidden = true;
  try {
    if (mode === 'saved') {
      const ids = favoriteIds.slice(favoriteOffset, favoriteOffset + 6);
      const results = await Promise.allSettled(ids.map(id => api(`works/${encodeURIComponent(id)}`, signal)));
      if (token !== generation) return;
      if (results.every(result => result.status === 'rejected') && results.some(result => result.reason.name !== 'AbortError')) throw new Error('暂时无法读取收藏，请稍后重试');
      appendWorks(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
      favoriteOffset += ids.length;
    } else {
      const data = await api(`works?${workParams({ page, query, author })}`, signal);
      if (token !== generation) return;
      visited.add(data.page); total = data.total; pages = data.pages;
      page = nextPage(data.page, pages, mode === 'recommend');
      appendWorks(data.items);
    }
    syncCounter();
    if (!cards.length) showState(mode === 'saved' ? '把喜欢的，留在这里' : '还没有找到视频', mode === 'saved' ? '浏览时轻点爱心，收藏会保存在当前浏览器。' : '试试其他关键词，或在资料库中下载一些视频。');
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    loadFailure = true;
    if (!cards.length) showState('暂时没有连接上', error.message, true);
    else { toast('下一组加载失败，点击重试继续'); $('more-retry').hidden = false; }
  } finally {
    if (token === generation) {
      loading = false;
      // Missing files may occupy a whole API page; continue until a playable item exists.
      const hasMore = mode === 'saved' ? favoriteOffset < favoriteIds.length : page !== null && !visited.has(page);
      if (!loadFailure && hasMore && (!cards.length || cards.indexOf(active) >= cards.length - 3)) queueMicrotask(loadMore);
    }
  }
}

async function reset(options = {}) {
  cancelMotion();
  touchGesture = null;
  wheelConsumed = false;
  wheelLast = 0;
  generation++;
  const token = generation;
  controller?.abort(); controller = new AbortController();
  observer.disconnect();
  cards.forEach(card => { const video = card.querySelector('video'); video.pause(); video.removeAttribute('src'); video.load(); });
  clearTimeout(tapTimer); tapTimer = null;
  mode = options.mode ?? 'recommend'; query = options.query ?? ''; author = options.author ?? ''; authorName = options.authorName ?? '';
  cards = []; active = null; paused = false; loading = false; visited = new Set(); seen = new Set(); removedCount = 0; page = 1;
  syncSound();
  favoriteIds = [...saved].reverse(); favoriteOffset = 0; total = mode === 'saved' ? saved.size : 0;
  $('feed').replaceChildren(); $('feed').scrollTop = 0; $('feed-counter').textContent = '';
  $('more-retry').hidden = true;
  syncNav(); showState('好内容，接着看', '正在加载你的视频…');
  loading = true;
  try {
    if (options.workId) {
      const work = await api(`works/${encodeURIComponent(options.workId)}`, controller.signal);
      if (token !== generation) return;
      appendWorks([work]);
    }
    if (mode === 'recommend') {
      loading = true;
      const first = await api(`works?${workParams({ page: 1, query, author })}`, controller.signal);
      if (token !== generation) return;
      total = first.total; pages = first.pages;
      page = 1 + Math.floor(Math.random() * pages);
      if (page === 1) { visited.add(1); appendWorks(first.items); page = nextPage(1, pages, true); }
    }
    loading = false;
    await loadMore();
    if (token === generation && !cards.length && !loadFailure) showState(mode === 'saved' ? '把喜欢的，留在这里' : '还没有找到视频', mode === 'saved' ? '浏览时轻点爱心，收藏会保存在当前浏览器。' : '试试其他关键词，或在资料库中下载一些视频。');
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    loading = false;
    if (!cards.length) showState('暂时没有连接上', error.message, true);
    else toast('后续视频读取失败，请点击首页重试');
  }
}

function togglePlay() {
  if (!active) return;
  const video = active.querySelector('video');
  paused = !video.paused;
  if (paused) video.pause(); else play(active);
}

function move(direction) {
  if (!active || motionFrame) return;
  const next = cards[cards.indexOf(active) + direction];
  if (next) settleOn(next);
  else { loadMore(); if (!loading) toast(direction > 0 ? '已经看到最后一条了' : '已经是第一条了'); }
}

function cancelMotion() {
  cancelAnimationFrame(motionFrame);
  motionFrame = 0;
  $('feed').classList.remove('is-moving');
}

function settleOn(card) {
  cancelMotion();
  const feed = $('feed');
  const target = cards.indexOf(card) * feed.clientHeight;
  const start = feed.scrollTop;
  if (reduceMotion || Math.abs(target - start) < 1) {
    feed.scrollTop = target;
    activate(card);
    trimCards();
    return;
  }
  const started = performance.now();
  feed.classList.add('is-moving');
  const tick = now => {
    const progress = Math.min(1, (now - started) / 160);
    feed.scrollTop = start + (target - start) * (1 - (1 - progress) ** 3);
    if (progress < 1) motionFrame = requestAnimationFrame(tick);
    else {
      motionFrame = 0;
      feed.scrollTop = target;
      feed.classList.remove('is-moving');
      activate(card);
      trimCards();
    }
  };
  motionFrame = requestAnimationFrame(tick);
}

$('feed').addEventListener('touchstart', event => {
  if (event.touches.length !== 1 || !active || event.target.closest('input,.video-title.expanded')) return;
  cancelMotion();
  const touch = event.touches[0];
  touchGesture = { x: touch.clientX, y: touch.clientY, dy: 0, started: performance.now(),
    index: cards.indexOf(active), top: $('feed').scrollTop, claimed: false };
}, { passive: true });
$('feed').addEventListener('touchmove', event => {
  if (!touchGesture || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dy = touch.clientY - touchGesture.y;
  if (!touchGesture.claimed && (Math.abs(dy) < 3 || Math.abs(dy) <= Math.abs(touch.clientX - touchGesture.x))) return;
  if (event.cancelable) event.preventDefault();
  touchGesture.claimed = true;
  touchGesture.dy = dy;
  $('feed').classList.add('is-moving');
  const height = $('feed').clientHeight;
  const low = Math.max(0, touchGesture.index - 1) * height;
  const high = Math.min(cards.length - 1, touchGesture.index + 1) * height;
  $('feed').scrollTop = Math.max(low, Math.min(high, touchGesture.top - dy));
}, { passive: false });
function endSwipe(event) {
  if (!touchGesture) return;
  const gesture = touchGesture;
  touchGesture = null;
  if (!gesture.claimed) return;
  if (event.cancelable) event.preventDefault();
  clearTimeout(tapTimer);
  tapTimer = null;
  const distance = Math.abs(gesture.dy);
  const velocity = distance / Math.max(1, performance.now() - gesture.started);
  const commit = event.type !== 'touchcancel' && (distance >= 70 || (distance >= 24 && velocity >= .35));
  const index = Math.max(0, Math.min(cards.length - 1, gesture.index + (commit ? -Math.sign(gesture.dy) : 0)));
  settleOn(cards[index]);
  if (commit && index === cards.length - 1) loadMore();
}
$('feed').addEventListener('touchend', endSwipe, { passive: false });
$('feed').addEventListener('touchcancel', endSwipe, { passive: false });
$('feed').addEventListener('wheel', event => {
  if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.target.closest('.video-title.expanded,input')) return;
  event.preventDefault();
  const now = performance.now();
  if (now - wheelLast > 150) { wheelDelta = 0; wheelConsumed = false; }
  wheelLast = now;
  if (wheelConsumed || motionFrame) return;
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $('feed').clientHeight : 1;
  wheelDelta += event.deltaY * scale;
  if (Math.abs(wheelDelta) >= 24) { wheelConsumed = true; move(Math.sign(wheelDelta)); }
}, { passive: false });

function openDialog(id) { active?.querySelector('video').pause(); $(id).showModal(); }
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => { if (active) play(active); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
}
$('search-button').onclick = () => { $('search-input').value = query; openDialog('search-dialog'); };
$('search-form').onsubmit = event => { event.preventDefault(); const value = $('search-input').value.trim(); $('search-dialog').close(); reset({ mode: 'latest', query: value }); };
$('filter-chip').onclick = () => reset();
$('home-button').onclick = () => reset();
$('saved-button').onclick = () => reset({ mode: 'saved' });
document.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => reset({ mode: button.dataset.mode }); });
$('retry-button').onclick = () => reset({ mode, query, author, authorName });
$('more-retry').onclick = loadMore;
$('previous-button').onclick = () => move(-1);
$('next-button').onclick = () => move(1);
$('sound-button').onclick = () => chooseSound(!muted);
$('sound-hint').onclick = () => chooseSound(false);
$('fullscreen-button').onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('app').requestFullscreen) await $('app').requestFullscreen(); else toast('在浏览器菜单中选择添加到主屏幕，体验满屏播放'); }
  catch { toast('当前浏览器暂不支持全屏'); }
};
document.addEventListener('keydown', event => {
  if (event.target.matches('input,textarea,button') || document.querySelector('dialog[open]')) return;
  if (['ArrowDown', 'ArrowUp', ' '].includes(event.key)) event.preventDefault();
  if (event.key === 'ArrowDown') move(1);
  if (event.key === 'ArrowUp') move(-1);
  if (event.key === ' ') togglePlay();
});
document.addEventListener('visibilitychange', () => { if (!active) return; if (document.hidden) active.querySelector('video').pause(); else play(active); });
$('feed').addEventListener('scroll', () => { if (loadFailure && $('feed').scrollTop + $('feed').clientHeight >= $('feed').scrollHeight - 40) loadMore(); }, { passive: true });
new ResizeObserver(() => { if (active) { cancelMotion(); touchGesture = null; $('feed').scrollTop = cards.indexOf(active) * $('feed').clientHeight; } }).observe($('feed'));

async function loadAuthors(resetList = false) {
  const token = resetList ? ++authorGeneration : authorGeneration;
  if (resetList) { authorPage = 0; $('author-list').replaceChildren(); }
  $('more-authors').hidden = true; $('author-status').textContent = '正在加载作者…';
  try {
    const params = new URLSearchParams({ page: String(authorPage + 1), size: '24', q: $('author-search').value.trim() });
    const data = await api(`authors?${params}`);
    if (token !== authorGeneration) return;
    authorPage = data.page; authorPages = data.pages;
    for (const item of data.items) {
      const row = document.createElement('button'); row.className = 'author-row';
      row.innerHTML = `<span class="author-avatar">${item.avatar ? `<img src="${mediaUrl(item.avatar)}" loading="lazy" alt="">` : escape((item.name || '影').slice(0, 1))}</span><span class="author-copy"><strong>${escape(item.name)}</strong><small>${Number(item.workCount).toLocaleString()} 个本地作品</small></span>${icon('right')}`;
      row.onclick = () => { $('authors-dialog').close(); reset({ mode: 'latest', author: item.id, authorName: item.name }); };
      $('author-list').append(row);
    }
    $('author-status').textContent = data.total ? `共 ${Number(data.total).toLocaleString()} 位作者` : '还没有找到作者';
    $('more-authors').hidden = authorPage >= authorPages;
  } catch (error) {
    if (token !== authorGeneration) return;
    $('author-status').textContent = error.message;
    $('more-authors').hidden = false;
  }
}
function openAuthors() { $('author-search').value = ''; openDialog('authors-dialog'); loadAuthors(true); }
$('browse-button').onclick = openAuthors;
$('authors-button').onclick = openAuthors;
$('author-search-form').onsubmit = event => { event.preventDefault(); loadAuthors(true); };
$('more-authors').onclick = () => loadAuthors();

const shared = new URLSearchParams(location.search).get('v');
reset({ workId: shared && /^[a-zA-Z0-9_-]+$/.test(shared) ? shared : undefined });

// A buffered, looping video makes no media requests. Keep only a visible page awake.
setInterval(() => {
  if (!document.hidden && active) fetch('/api/activity', { cache: 'no-store' }).catch(() => {});
}, 30_000);
