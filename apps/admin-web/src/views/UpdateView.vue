<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { updateProgressView } from '../update-progress';
import type { UpdateTask } from '../update-progress';

const props = defineProps<{
    api: (path: string, init?: RequestInit) => Promise<UpdateTask>;
    showToast: (message: string, error: boolean) => void;
    onChanged: () => void;
}>();

type UpdateAction = 'start' | 'stop';

const states: Record<string, string> = {
    idle: '空闲', starting: '正在启动', running: '更新中', stopping: '正在停止',
    stopped: '已停止', completed: '已完成', failed: '更新失败', unavailable: '状态不可用',
};
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const task = ref<UpdateTask>({ state: '' });
const view = ref(updateProgressView(task.value));
const sending = ref(false);
const active = computed(() => ['starting', 'running', 'stopping'].includes(task.value.state));
const details = computed(() => [
    task.value.startedAt && `开始于 ${date.format(new Date(task.value.startedAt))}`,
    task.value.finishedAt && `结束于 ${date.format(new Date(task.value.finishedAt))}`,
].filter(Boolean).join(' · '));
const errors = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let version = 0;
let alive = true;

async function refresh(action?: UpdateAction) {
    clearTimeout(timer);
    const requestVersion = ++version;
    const current = () => alive && requestVersion === version;
    if (action) sending.value = true;
    try {
        const next = action
            ? await props.api(`update/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            : await props.api('update');
        if (!current()) return;
        const previous = task.value.state;
        task.value = next;
        view.value = updateProgressView(next);
        errors.value = next.error ?? '';
        if (next.finishedAt && previous !== next.state) props.onChanged();
    } catch (error) {
        if (!current()) return;
        const message = error instanceof Error ? error.message : String(error);
        if (action) props.showToast(message, true);
        else {
            task.value = { ...task.value, state: 'unavailable' };
            errors.value = message;
        }
    } finally {
        if (current()) {
            sending.value = false;
            timer = setTimeout(() => void refresh(), 1500);
        }
    }
}

onMounted(() => void refresh());
onBeforeUnmount(() => { alive = false; clearTimeout(timer); });
</script>

<template>
    <section class="update-panel" aria-label="下载任务">
        <div class="update-controls">
            <div>
                <div class="summary">当前状态</div>
                <div id="update-state" class="update-state" role="status" :data-state="task.state || undefined">
                    {{ states[task.state] ?? '正在读取状态…' }}
                </div>
            </div>
            <div class="form-actions">
                <button class="primary" type="button" data-update-action="start"
                    :disabled="!task.state || task.state === 'unavailable' || active || sending" @click="refresh('start')">启动更新</button>
                <button class="secondary danger" type="button" data-update-action="stop"
                    :disabled="!active || task.state === 'stopping' || sending" @click="refresh('stop')">停止更新</button>
            </div>
        </div>
        <div class="update-overall">
            <div class="update-progress-label"><strong id="update-link-progress">{{ view.linkText }}</strong><strong id="update-percent">{{ view.percent }}</strong></div>
            <progress id="update-link-bar" :max="view.total || 1" :value="view.completed" aria-label="链接总进度"></progress>
            <p class="summary">总进度按链接计算；下方分别显示当前作者已获取、新作品和已下载数量。</p>
        </div>
        <div class="update-metrics">
            <div><span>本轮已下载</span><strong id="update-success">{{ view.success }}</strong></div>
            <div><span>本轮已跳过</span><strong id="update-skipped">{{ view.skipped }}</strong></div>
            <div><span>作品失败</span><strong id="update-failed">{{ view.failed }}</strong></div>
            <div><span>链接失败</span><strong id="update-failedUrls">{{ view.failedUrls }}</strong></div>
        </div>
        <dl class="update-current">
            <div><dt>当前作者</dt><dd id="update-author">{{ view.author }}</dd></div>
            <div><dt>当前阶段</dt><dd id="update-phase">{{ view.phase }}</dd></div>
            <div><dt>已用时间</dt><dd id="update-elapsed">{{ view.elapsed }}</dd></div>
            <div><dt>进度更新</dt><dd id="update-freshness">{{ view.freshness }}</dd></div>
        </dl>
        <p id="update-url" class="summary update-url" :hidden="!view.url">{{ view.url }}</p>
        <div class="update-items">
            <div class="update-progress-label"><span>当前作者作品</span><span id="update-itemsText">{{ view.itemsText }}</span></div>
            <progress id="update-item-bar" :max="view.itemsTotal || 1" :value.attr="view.itemsIndeterminate ? undefined : view.itemsCompleted"
                aria-label="本组作品进度"></progress>
        </div>
        <p id="update-detail" class="summary" :hidden="!view.detail">{{ view.detail }}</p>
        <p id="update-queueText" class="summary" :hidden="!view.queueText">{{ view.queueText }}</p>
        <p id="update-file" class="summary" :hidden="!view.file">{{ view.file }}</p>
        <p id="update-message" class="update-message" :hidden="!view.message">{{ view.message }}</p>
        <p id="update-details" class="summary" :hidden="!details">{{ details }}</p>
        <p id="update-error" role="alert" :hidden="!errors">{{ errors }}</p>
    </section>
</template>
