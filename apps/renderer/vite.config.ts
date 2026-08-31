import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // Electron loads the production renderer from file://. Relative asset URLs
  // are required; Vite's default /assets/... paths produce a blank window.
  base: './',
  plugins: [vue()],
  server: { proxy: { '/api': 'http://127.0.0.1:4318' } },
});
