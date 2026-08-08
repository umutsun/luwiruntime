import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4783,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4782',
        changeOrigin: true,
        ws: true,
      },
      '/health': {
        target: 'http://127.0.0.1:4782',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
