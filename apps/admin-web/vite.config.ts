import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const admin = { target: 'http://127.0.0.1:3001', changeOrigin: false };

export default defineConfig({
    plugins: [vue()],
    build: { assetsDir: '_admin' },
    server: {
        host: '127.0.0.1',
        proxy: {
            '/api/': admin,
            '/media/': admin,
            '/assets/': admin,
        },
    },
});
