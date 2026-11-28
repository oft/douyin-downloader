<script setup lang="ts">
import { computed, watch } from 'vue';
import { profileIdFromLink } from '../../../shared/profile-link';
import { linkCheckNames, linkCheckResult } from '../link-check';
import type { LinksViewState } from '../hooks/useLinkManagement';
import type { useLinkCheck } from '../hooks/useLinkCheck';
import { authorLink } from '../utils/catalog-links';
import { date, number } from '../utils/format';

const props = defineProps<{ state: LinksViewState; check: ReturnType<typeof useLinkCheck>['state'] }>();
const emit = defineEmits<{
    add: []; remove: [index: number]; reload: []; save: [];
    check: [links: string[]]; stop: []; summary: [text: string];
}>();

const changed = computed(() => Boolean(props.state.config && (props.state.config.links.length !== props.state.draft.length
    || props.state.draft.some((link, index) => link !== props.state.config?.links[index]))));
const query = computed(() => props.state.query.trim().toLowerCase());
const checking = computed(() => ['starting', 'running', 'stopping'].includes(props.check.job.state));
const rows = computed(() => props.state.draft.map(link => {
    const result = linkCheckResult(link, props.check.job, props.check.results);
    return {
        author: props.state.authors[profileIdFromLink(link) ?? ''],
        result,
        visible: link.toLowerCase().includes(query.value) && (!props.state.filter
            || (props.check.results.get(link)?.status ?? 'unchecked') === props.state.filter),
    };
}));
const visible = computed(() => rows.value.filter(row => row.visible).length);
const jobLabels: Record<string, string> = { starting: '正在启动', running: '检测中', stopping: '正在停止',
    stopped: '已停止', completed: '检测结束', failed: '检测中断' };

watch([visible, () => props.state.draft.length, query, () => props.state.filter], () => {
    const total = number.format(props.state.draft.length);
    emit('summary', query.value || props.state.filter ? `显示 ${number.format(visible.value)} / ${total} 条下载链接` : `共 ${total} 条下载链接`);
}, { immediate: true });

function clearValidity(event: Event) {
    if (event.target instanceof HTMLTextAreaElement) event.target.setCustomValidity('');
}
</script>

<template>
    <Teleport to="#header-action">
        <button id="add-link" class="secondary" type="button" :disabled="state.saving" @click="emit('add')">添加链接</button>
    </Teleport>
    <form id="link-form" class="link-form" novalidate @submit.prevent="emit('save')">
        <div class="link-controls">
            <div class="link-toolbar">
                <label class="search"><span aria-hidden="true">⌕</span><input id="link-search" v-model="state.query" type="search"
                    placeholder="搜索链接" aria-label="搜索链接" @keydown.enter.prevent></label>
                <div class="form-actions">
                    <button id="reload-links" class="secondary" type="button" :disabled="state.saving" @click="emit('reload')">重新读取</button>
                    <button id="save-links" class="primary" type="submit" :disabled="state.saving || !changed">{{ state.saving ? '保存中…' : '保存配置' }}</button>
                </div>
            </div>
            <div id="link-changes" class="summary link-changes" role="status">{{ changed ? '有未保存的更改' : '' }}</div>
            <div class="link-check-toolbar">
                <button id="check-all-links" class="secondary" type="button"
                    :disabled="state.saving || check.busy || checking || !state.draft.length" @click="emit('check', [...state.draft])">检测全部</button>
                <button id="stop-link-check" class="secondary danger" type="button" :hidden="!checking" :disabled="check.busy || check.job.state === 'stopping'"
                    @click="emit('stop')">停止检测</button>
                <label><input id="show-check-browser" v-model="check.showBrowser" type="checkbox" :disabled="check.busy || checking">显示检测浏览器</label>
                <label>检测结果
                    <select id="link-check-filter" v-model="state.filter" aria-label="按检测结果筛选">
                        <option value="">全部状态</option>
                        <option v-for="(label, value) in linkCheckNames" :key="value" :value="value">{{ label }}</option>
                        <option value="unchecked">未检测</option>
                    </select>
                </label>
            </div>
            <p class="summary">检测当前编辑列表，不保存配置、不下载作品。重复链接只检测一次，无法确认的结果不会标为失效。</p>
            <p id="link-check-summary" class="summary" role="status">
                {{ check.job.state === 'idle' ? '尚未开始检测' : `${jobLabels[check.job.state]} · 已检测 ${check.job.completed} / ${check.job.total} 条链接（去重后）` }}
            </p>
            <progress id="link-check-progress" class="link-check-progress" :max="check.job.total || 1" :value="check.job.completed"
                aria-label="链接检测进度" :hidden="!check.job.total"></progress>
            <p id="link-check-error" class="player-error" role="alert" :hidden="!check.error">{{ check.error }}</p>
            <p id="link-save-error" class="player-error" role="alert" :hidden="!state.error">{{ state.error }}</p>
        </div>
        <fieldset id="link-fields" class="link-fields" aria-label="下载链接" :disabled="state.saving">
            <ol v-if="rows.length" class="link-list">
                <li v-for="(row, index) in rows" :key="index" class="link-row" :hidden="!row.visible">
                    <div class="link-main">
                        <label>链接 {{ index + 1 }}<textarea v-model="state.draft[index]" name="link" :data-link-index="index" rows="2"
                            spellcheck="false" required @input="clearValidity"></textarea></label>
                        <p class="link-check-result" :data-link-result="index" :data-status="row.result.status">
                            {{ row.result.checkedAt ? `${row.result.name} · ${row.result.reason} · ${date.format(new Date(row.result.checkedAt))}` : row.result.name }}
                        </p>
                    </div>
                    <div class="link-row-actions">
                        <a v-if="row.author" class="secondary" :data-link-author="index" :href="authorLink(row.author.id)">作者页 · {{ row.author.name }}</a>
                        <button class="secondary" type="button" :data-check-link="index" :disabled="state.saving || check.busy || checking || !state.draft[index]?.trim()"
                            @click="emit('check', [state.draft[index]!])">检测</button>
                        <button class="secondary danger" type="button" :data-remove-link="index" :aria-label="`移除链接 ${index + 1}`"
                            @click="emit('remove', index)">移除</button>
                    </div>
                </li>
            </ol>
            <div v-else class="empty"><h2>暂无下载链接</h2><p>点击「添加链接」填写下载地址。</p></div>
        </fieldset>
        <div id="link-no-matches" class="empty" :hidden="!(query || state.filter) || visible > 0 || !state.draft.length"><p>没有符合搜索条件的链接。</p></div>
    </form>
</template>
