<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PaginationBar from './PaginationBar.vue';
import WorkHoverVideo from './WorkHoverVideo.vue';
import { workKindNames, workSourceNames } from '../work-labels';
import type { WorkItem, WorkLayout } from '../work-list-types';

const props = defineProps<{
    items: WorkItem[]; page: number; pages: number; layout: WorkLayout; busy: boolean;
    selectable: boolean; overlay: boolean; showAuthor: boolean; allowLayoutSwitch: boolean;
    selectedIds: Set<string>; phase: 'ready' | 'loading' | 'error'; message: string;
    assetUrl: (id: string) => string; authorUrl: (id: string) => string;
}>();
const emit = defineEmits<{
    page: [page: number]; layout: [layout: WorkLayout]; open: [id: string];
    select: [id: string, checked: boolean]; retry: [];
}>();
const nextLayout = computed(() => props.layout === 'list' ? 'cards' : 'list');
const layoutLabel = computed(() => nextLayout.value === 'list' ? '切换为列表' : '切换为卡片');
const isList = computed(() => props.layout === 'list');
const kindNames: Record<string, string> = workKindNames;
const sourceNames: Record<string, string> = workSourceNames;
const hoverId = ref<string>();

function stopHover() { hoverId.value = undefined; }
function onCardClick(event: MouseEvent) {
    if ((event.target as Element).closest('[data-hover-sound]')) return;
    stopHover();
}
function startHover(event: PointerEvent, work: WorkItem) {
    if (event.pointerType !== 'mouse' || props.busy || work.kind !== 'video' || !work.video) return;
    hoverId.value = work.id;
}
function onVisibilityChange() { if (document.hidden) stopHover(); }
watch(() => [props.items, props.layout, props.busy, props.phase], stopHover);
onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange));
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange));

function mediaLabel(work: WorkItem) {
    const label = kindNames[work.kind] ?? '作品';
    return work.kind === 'album' && work.images?.length ? `${label} · ${work.images.length} 张` : label;
}

function hideImage(event: Event) {
    (event.currentTarget as HTMLImageElement).hidden = true;
}

function select(id: string, event: Event) {
    emit('select', id, (event.currentTarget as HTMLInputElement).checked);
}
</script>

<template>
    <section class="work-list-component" aria-label="作品列表">
        <div class="list-navigation">
            <PaginationBar position="top" :page="page" :pages="pages" :busy="busy" @change="emit('page', $event)" />
            <div class="list-view-toggle" data-work-view-toggle :hidden="!allowLayoutSwitch">
                <button class="plain view-layout-toggle" type="button" :data-view-layout="nextLayout"
                    :aria-label="layoutLabel" :title="layoutLabel" :disabled="busy" @click.stop="emit('layout', nextLayout)"></button>
            </div>
        </div>
        <div data-work-items aria-live="polite" :aria-busy="busy">
            <div v-if="phase === 'loading'" class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取…</p></div>
            <div v-else-if="phase === 'error'" class="empty">
                <h2>读取失败</h2><p>{{ message }}</p>
                <button type="button" class="secondary" data-work-list-retry @click.stop="emit('retry')">重试</button>
            </div>
            <div v-else-if="!items.length" class="empty"><h2>没有符合条件的记录</h2><p>试试其他搜索词或筛选条件。</p></div>
            <div v-else :class="isList ? 'work-list' : ['work-grid', { 'work-overlay-grid': overlay }]">
                <article v-for="work in items" :key="work.id" class="work-card"
                    @pointerenter="startHover($event, work)" @pointerleave="stopHover" @click.capture="onCardClick">
                    <label v-if="selectable" class="entry-check">
                        <input type="checkbox" data-select-entry :value="work.id" :aria-label="`选择 ${work.title}`"
                            :checked="selectedIds.has(work.id)" @change.stop="select(work.id, $event)">
                    </label>
                    <div class="work-thumbnail">
                      <button class="thumb" :class="{ 'has-image': work.cover }" :data-work="work.id" type="button"
                        :aria-label="`预览 ${work.title}`" @click.stop="emit('open', work.id)">
                        <span class="thumb-placeholder" aria-hidden="true">{{ work.kind === 'album' ? '▧' : '▷' }}</span>
                        <img v-if="work.cover" :key="work.cover" :src="assetUrl(work.cover)" alt="" loading="lazy" decoding="async" @error="hideImage">
                        <span v-if="!isList" class="media-badge">{{ mediaLabel(work) }}</span>
                      </button>
                      <WorkHoverVideo v-if="hoverId === work.id && work.video" :key="work.video"
                          :src="assetUrl(work.video)" @failed="stopHover" />
                    </div>
                    <div class="work-info">
                        <button type="button" class="work-title" :data-work="work.id" :title="work.title"
                            @click.stop="emit('open', work.id)">{{ work.title }}</button>
                        <div v-if="showAuthor" class="work-author">
                            <a v-if="work.authorId" :href="authorUrl(work.authorId)">{{ work.authorName || '未命名作者' }}</a>
                            <span v-else>作者未知</span>
                        </div>
                        <div class="work-foot">
                            <span v-if="isList">{{ mediaLabel(work) }}</span>
                            <time>{{ work.time ? work.time.slice(0, 10) : '日期未知' }}</time>
                            <span>{{ (work.sources ?? []).map(source => sourceNames[source] ?? source).join(' · ') }}</span>
                        </div>
                    </div>
                </article>
            </div>
        </div>
        <PaginationBar position="bottom" :page="page" :pages="pages" :busy="busy" @change="emit('page', $event)" />
    </section>
</template>
