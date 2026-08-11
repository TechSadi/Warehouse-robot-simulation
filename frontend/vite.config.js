import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /api and /socket.io to the backend during local development so the
// browser only ever talks to one origin (http://localhost:5173).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:5000',
        ws: true,
      },
    },
  },
});
