<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { catalogApi } from '../catalog-api';
import { neighborOnList, playbackListParams, resolvePlaybackList } from '../playback-context';
import type { ListPage } from '../playback-context';
import { workKindNames } from '../work-labels';
import WorkPreview from '../components/WorkPreview.vue';

type Work = {
    id: string;
    kind: string;
    title: string;
    authorId?: string;
    authorName?: string;
    time?: string;
    video?: string;
    cover?: string;
    images: string[];
};

const router = useRouter();
const route = useRoute();
const id = computed(() => String(route.params.workId ?? ''));
const source = computed(() => resolvePlaybackList(router, route.query.from));
const work = shallowRef<Work>();
const stage = ref<HTMLElement | null>(null);
const fullscreen = ref(false);
const fullscreenAvailable = typeof document !== 'undefined' && document.fullscreenEnabled;
const loading = ref(true);
const error = ref('');
const neighborError = ref('');
const listPage = shallowRef<{ key: string; data: ListPage }>();
const listKey = computed(() => source.value?.fullPath);
const matchingPage = computed(() => listPage.value?.key === listKey.value ? listPage.value?.data : undefined);
const stepping = ref(false);
const kinds: Record<string, string> = workKindNames;
let stepRequest: AbortController | undefined;

const previous = computed(() => matchingPage.value && neighborOnList(matchingPage.value, id.value, -1));
const next = computed(() => matchingPage.value && neighborOnList(matchingPage.value, id.value, 1));
const returnTo = computed(() => source.value?.fullPath ?? { name: 'works' });
const mediaDetail = computed(() => work.value ? [kinds[work.value.kind], work.value.time].filter(Boolean).join(' · ') : '');

const retries = ref(0);
watch([id, retries], async ([workId], _before, onCleanup) => {
    if (!workId) return;
    const request = new AbortController();
    onCleanup(() => request.abort());
    loading.value = true;
    error.value = '';
    neighborError.value = '';
    try {
        const response = await catalogApi<Work>(`works/${encodeURIComponent(workId)}`, { signal: request.signal });
        if (!request.signal.aborted) work.value = response;
    } catch (failure) {
        if (!request.signal.aborted) error.value = message(failure);
    } finally {
        if (!request.signal.aborted) loading.value = false;
    }
}, { immediate: true });

watch(listKey, async (key, _old, onCleanup) => {
    const origin = source.value;
    if (!key || !origin || listPage.value?.key === key) return;
    const request = new AbortController();
    onCleanup(() => request.abort());
    try {
        const data = await catalogApi<ListPage>(`works?${playbackListParams(origin)}`, { signal: request.signal });
        if (!request.signal.aborted) listPage.value = { key, data };
    } catch {
        if (!request.signal.aborted) listPage.value = undefined;
    }
}, { immediate: true });

function message(failure: unknown) {
    return failure instanceof Error ? failure.message : '请求失败，请重试。';
}

async function step(direction: -1 | 1) {
    const origin = source.value;
    const candidate = direction < 0 ? previous.value : next.value;
    if (!origin || !candidate || loading.value || stepping.value || error.value) return;
    stepping.value = true;
    neighborError.value = '';
    const request = new AbortController();
    stepRequest = request;
    const startingPath = route.fullPath;
    const startingId = id.value;
    try {
        let nextId = candidate.id;
        let listPath = origin.fullPath;
        if (!nextId) {
            const data = await catalogApi<ListPage>(`works?${playbackListParams(origin, candidate.page)}`, { signal: request.signal });
            if (request.signal.aborted || route.fullPath !== startingPath) return;
            if (data.page !== candidate.page) return;
            nextId = data.items.at(direction > 0 ? 0 : -1)?.id;
            const resolved = router.resolve({ path: origin.path, query: {
                ...origin.query, page: candidate.page === 1 ? undefined : String(candidate.page),
            } });
            listPath = resolved.fullPath;
            if (nextId && nextId !== startingId) listPage.value = { key: listPath, data };
        }
        if (nextId && nextId !== startingId && route.fullPath === startingPath) {
            await router.replace({ name: 'work-playback', params: { workId: nextId }, query: { from: listPath } });
        }
    } catch (failure) {
        if (!request.signal.aborted && route.fullPath === startingPath) neighborError.value = message(failure);
    } finally {
        if (stepRequest === request) {
            stepRequest = undefined;
            stepping.value = false;
        }
    }
}

function onKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : undefined;
    if (!direction || !(direction < 0 ? previous.value : next.value) || loading.value || error.value) return;
    event.preventDefault();
    void step(direction);
}

function onFullscreen() {
    fullscreen.value = Boolean(stage.value && document.fullscreenElement === stage.value);
}

async function toggleFullscreen() {
    if (!stage.value) return;
    try {
        if (fullscreen.value) await document.exitFullscreen();
        else await stage.value.requestFullscreen();
    } catch {
        neighborError.value = '浏览器无法进入全屏。';
    }
}

onMounted(() => {
    window.scrollTo(0, 0);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreen);
});
onBeforeUnmount(() => {
    stepRequest?.abort();
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFullscreen);
});
</script>

<template>
    <main class="playback-page">
        <div class="playback-top">
            <RouterLink class="plain" :to="returnTo">‹ {{ source ? '返回列表' : '全部作品' }}</RouterLink>
            <RouterLink v-if="work?.authorId && !error" class="plain"
                :to="{ name: 'author-works', params: { authorId: work.authorId } }">查看作者作品</RouterLink>
        </div>
        <header v-if="work && !error" class="playback-header">
            <h1>{{ work.title }}</h1>
            <p class="summary">{{ [work.authorName, mediaDetail].filter(Boolean).join(' · ') }}</p>
        </header>
        <div v-if="error" class="empty" role="alert"><h2>作品无法打开</h2><p>{{ error }}</p>
            <button type="button" class="secondary" @click="retries++">重试</button>
        </div>
        <div v-else-if="!work" class="empty" role="status"><span class="spinner" aria-hidden="true"></span><p>正在读取作品…</p></div>
        <section v-else ref="stage" class="playback-stage" aria-label="作品播放" :aria-busy="loading || stepping">
            <WorkPreview :key="work.id" :video="work.video" :cover="work.cover" :images="work.images"
                :is-current="() => !loading && work?.id === id" />
            <div v-if="source || (fullscreenAvailable && (work.video || work.images.length))" class="playback-controls">
                <button v-if="source" type="button" :disabled="!previous || loading || stepping" aria-keyshortcuts="ArrowUp"
                    @click="step(-1)">↑ 上一个作品</button>
                <button v-if="fullscreenAvailable && (work.video || work.images.length)" type="button" class="playback-fullscreen"
                    @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '全屏' }}</button>
                <button v-if="source" type="button" :disabled="!next || loading || stepping" aria-keyshortcuts="ArrowDown"
                    @click="step(1)">下一个作品 ↓</button>
            </div>
            <p v-if="neighborError" class="player-error" role="status">{{ neighborError }}</p>
        </section>
    </main>
</template>
