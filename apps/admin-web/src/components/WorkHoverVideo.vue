<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineProps<{ src: string }>();
const emit = defineEmits<{ failed: [] }>();
const player = ref<HTMLVideoElement | null>(null);
const ready = ref(false);
const soundBlocked = ref(false);

async function playWithSound() {
    const video = player.value;
    if (!video) return;
    video.muted = false;
    try {
        await video.play();
        if (video.isConnected) soundBlocked.value = false;
    } catch (error) {
        if (!video.isConnected) return;
        if ((error as DOMException).name !== 'NotAllowedError') { emit('failed'); return; }
        soundBlocked.value = true;
        video.muted = true;
        void video.play().catch(() => { if (video.isConnected) emit('failed'); });
    }
}

onMounted(() => {
    void playWithSound();
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
    <video ref="player" class="work-hover-video" :class="{ ready }" :src="src" loop playsinline
        preload="none" aria-hidden="true" @playing="ready = true" @error="emit('failed')"></video>
    <button v-if="soundBlocked" class="hover-sound" data-hover-sound type="button" title="开启声音"
        aria-label="开启声音" @click.stop="playWithSound">开启声音</button>
</template>
