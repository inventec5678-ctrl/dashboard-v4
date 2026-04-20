import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5006',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:5006',
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
  },
});