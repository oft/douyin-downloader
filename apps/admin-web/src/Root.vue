<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterView, useRoute } from 'vue-router';
import CatalogApp from './App.vue';

const route = useRoute();
const inCatalog = computed(() => Boolean(route.meta.section));
const catalogMounted = ref(inCatalog.value);
watch(inCatalog, active => { if (active) catalogMounted.value = true; });
</script>

<template>
    <div v-if="catalogMounted" v-show="inCatalog"><CatalogApp /></div>
    <RouterView v-if="!inCatalog" />
</template>
