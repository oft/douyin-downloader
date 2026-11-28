import { createApp } from 'vue';
import Root from './Root.vue';
import { pinia, router } from './runtime';
import './styles.css';

const app = createApp(Root).use(pinia).use(router);
await router.isReady();
app.mount('#app');
