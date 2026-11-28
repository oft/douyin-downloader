<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { onBeforeUnmount, onMounted } from 'vue';
import { useCatalogStore } from './stores/catalog';
import { useToast } from './hooks/useToast';
import { number } from './utils/format';

const { toast, showToast } = useToast();
let dispose: (() => void) | undefined;
let mounted = false;
onMounted(async () => {
    mounted = true;
    const { mountCatalogApp } = await import('./app');
    if (mounted) dispose = mountCatalogApp(showToast);
});
onBeforeUnmount(() => { mounted = false; dispose?.(); });

const route = useRoute();
const catalog = useCatalogStore();
const navigation = [
    { name: 'works', label: '作品', icon: '▤', counter: 'works' },
    { name: 'authors', label: '作者', icon: '◎', counter: 'authors' },
    { name: 'issues', label: '异常', icon: '◇', counter: 'issues' },
    { name: 'links', label: '链接管理', icon: '↗' },
    { name: 'update', label: '更新', icon: '↻' },
    { name: 'transfer', label: '分享 / 导入', icon: '⇄' },
] as const;
const formatCount = (count?: number) => count === undefined ? '' : number.format(count);
</script>

<template>
    <aside class="sidebar">
        <RouterLink class="brand" :to="{ name: 'works' }" aria-label="本地视频资料库首页">
            <span class="brand-mark" aria-hidden="true">▶</span>
            <span>视频资料库<small>本地媒体管理</small></span>
        </RouterLink>
        <nav aria-label="资料库导航">
            <RouterLink v-for="item in navigation" :key="item.name" :to="{ name: item.name }" custom v-slot="{ href, navigate }">
                <a :href="href" :data-view="item.name" :aria-current="route.meta.section === item.name ? 'page' : undefined" @click="navigate">
                    <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>{{ item.label }}
                    <span v-if="'counter' in item" :id="`nav-${item.counter}`" class="nav-count" :class="{ accent: item.counter === 'issues' }">{{ formatCount(catalog.counters[item.counter]) }}</span>
                </a>
            </RouterLink>
        </nav>
        <div class="sidebar-footer">
            <button id="open-douyin" class="scan-button" type="button" title="手动检查登录状态，登录信息会自动保存"><span aria-hidden="true">↗</span> 打开抖音</button>
        </div>
    </aside>
    <main class="workspace">
        <header class="section-header">
            <div>
                <button id="back" class="back-link" type="button" aria-label="返回上一页" hidden><span class="back-chevron" aria-hidden="true"></span></button>
                <h1 id="heading">全部作品</h1>
                <span id="author-work-count" class="summary author-work-count" aria-live="polite" hidden></span>
                <div id="summary" class="summary" aria-live="polite"></div>
            </div>
            <div id="header-action"></div>
        </header>
        <section id="issue-center" aria-label="异常处理中心" hidden></section>
        <section id="media-scan-controls" class="media-scan-controls" aria-label="媒体异常扫描" hidden>
            <button id="scan-button" class="plain" type="button">扫描媒体异常</button>
            <div id="scan-state" class="scan-state" role="status"><span class="status-dot" aria-hidden="true"></span><span id="scan-label">媒体异常未扫描</span></div>
            <div id="scan-time" class="scan-time"></div>
        </section>
        <section id="toolbar" class="toolbar" aria-label="筛选条件" hidden></section>
        <div class="list-navigation">
            <nav id="pagination-top" class="pagination pagination-top" aria-label="上方翻页" hidden></nav>
            <div id="list-view-toggle" class="list-view-toggle" hidden></div>
        </div>
        <section id="results" aria-label="查询结果" aria-busy="true">
            <div class="empty"><span class="spinner" aria-hidden="true"></span><p>正在读取作品…</p></div>
        </section>
        <nav id="pagination" class="pagination" aria-label="下方翻页" hidden></nav>
    </main>
    <dialog id="modal" aria-labelledby="modal-title">
        <div id="modal-content">
            <header class="modal-header">
                <div id="modal-heading"><h2 id="modal-title"></h2><div id="modal-subtitle" class="summary"></div></div>
                <div class="modal-controls">
                    <button type="button" id="modal-fullscreen" class="secondary" hidden>全屏</button>
                    <button type="button" id="modal-close" class="icon-button" aria-label="关闭" autofocus>×</button>
                </div>
            </header>
            <div id="modal-body"></div>
        </div>
    </dialog>
    <div id="toast" role="status" :hidden="!toast" :class="{ error: toast?.error }">{{ toast?.message }}</div>
</template>
