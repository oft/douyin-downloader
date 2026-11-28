import { createPinia } from 'pinia';
import { createWebHashHistory } from 'vue-router';
import { createAdminRouter } from './router';

export const pinia = createPinia();
export const router = createAdminRouter(createWebHashHistory());
