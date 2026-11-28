<script setup lang="ts">
import { computed } from 'vue';
import { paginationItems, paginationState } from '../pagination';

const props = defineProps<{ page: number; pages: number; busy: boolean; position: 'top' | 'bottom' }>();
const emit = defineEmits<{ change: [page: number] }>();
const state = computed(() => paginationState(props));
const numbers = computed(() => paginationItems(state.value.page, state.value.pages));
const formatNumber = new Intl.NumberFormat('zh-CN');

function jump(event: SubmitEvent) {
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('page') as HTMLInputElement;
    if (form.reportValidity()) emit('change', input.valueAsNumber);
}
</script>

<template>
    <nav class="pagination" :class="{ 'pagination-top': position === 'top' }"
        :data-work-pagination="position" :aria-label="position === 'top' ? '上方翻页' : '下方翻页'"
        :aria-busy="busy" :hidden="state.pages <= 1">
        <template v-if="state.pages > 1">
            <div class="pagination-pages">
                <button class="pagination-step" type="button" :data-page="state.page - 1" aria-label="上一页"
                    :disabled="busy || state.page === 1" @click.stop="emit('change', state.page - 1)"><span aria-hidden="true">‹</span></button>
                <template v-for="(value, index) in numbers" :key="index">
                    <span v-if="value === 'ellipsis'" class="pagination-ellipsis" aria-hidden="true">…</span>
                    <button v-else class="pagination-number" type="button" :data-page="value" :aria-label="`第 ${value} 页`"
                        :aria-current="value === state.page ? 'page' : undefined" :disabled="busy || value === state.page"
                        @click.stop="emit('change', Number(value))">{{ formatNumber.format(Number(value)) }}</button>
                </template>
                <button class="pagination-step" type="button" :data-page="state.page + 1" aria-label="下一页"
                    :disabled="busy || state.page === state.pages" @click.stop="emit('change', state.page + 1)"><span aria-hidden="true">›</span></button>
            </div>
            <form :key="state.page" class="pagination-jump" data-page-jump @submit.prevent.stop="jump">
                <label><span>跳至</span><input name="page" aria-label="跳转页码" inputmode="numeric" type="number" min="1"
                    :max="state.pages" :value="state.page" step="1" required :disabled="busy"><span>页</span></label>
                <button class="plain" type="submit" :disabled="busy">跳转</button>
            </form>
        </template>
    </nav>
</template>
