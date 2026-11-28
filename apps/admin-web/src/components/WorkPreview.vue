<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { mediaUrl as asset } from '../utils/format';

const props = defineProps<{ video?: string; cover?: string; images: string[]; isCurrent: () => boolean }>();
const player = ref<HTMLVideoElement | null>(null);
const imageIndex = ref(0);
const failed = ref(false);
const fullscreenEnabled = typeof document !== 'undefined' && document.fullscreenEnabled;

onMounted(() => {
    const video = player.value;
    if (!video) return;
    failed.value = Boolean(video.error);
    void video.play().catch((error: DOMException) => {
        if (error.name !== 'NotAllowedError' || !props.isCurrent() || !video.isConnected) return;
        video.muted = true;
        return video.play().catch(() => {});
    });
});

onBeforeUnmount(() => {
    const video = player.value;
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();
});
</script>

<template>
    <template v-if="video">
        <video ref="player" class="video-player" controls playsinline
            :controlslist="fullscreenEnabled ? 'nofullscreen' : undefined" preload="metadata"
            :src="asset(video)" :poster="cover ? asset(cover) : undefined" @error="failed = true"></video>
        <p id="player-error" class="player-error" role="status" :hidden="!failed">此视频无法播放，请检查文件或浏览器支持的格式。</p>
    </template>
    <template v-else-if="images.length">
        <div class="album-player"><img id="album-image" :src="asset(images[imageIndex]!)" :alt="`图集第 ${imageIndex + 1} 张图片`"></div>
        <div class="album-controls">
            <button type="button" class="secondary" id="album-prev" :disabled="imageIndex === 0" @click="imageIndex--">← 上一张</button>
            <span id="album-count">{{ imageIndex + 1 }} / {{ images.length }}</span>
            <button type="button" class="secondary" id="album-next" :disabled="imageIndex === images.length - 1" @click="imageIndex++">下一张 →</button>
        </div>
    </template>
    <div v-else class="empty"><h2>没有可预览的本地媒体</h2><p>可以在异常记录中查看文件检查结果。</p></div>
</template>
