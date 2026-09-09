// `defineConfig` comes from vitest/config rather than vite: it is the same
// function widened with the `test` block below, so the config stays a single
// file instead of a vite.config plus a near-duplicate vitest.config.
import { defineConfig } from 'vitest/config';
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
  build: {
    rollupOptions: {
      output: {
        // Measured, not guessed: before this split the production bundle was
        // 632 kB, of which recharts alone was 501 kB - 80% of everything the
        // browser had to parse before the dashboard could paint, for one
        // panel at the bottom of a scrolling rail that shows an empty state
        // until a simulation runs. ChartPanel is loaded with React.lazy
        // (AppShell.jsx), so keeping recharts in its own chunk is what makes
        // that deferral actually save anything.
        manualChunks: {
          charts: ['recharts'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.{js,jsx}'],
    // Playwright specs are driven by `npm run test:e2e`, not by Vitest -
    // they need a real browser and a running stack.
    exclude: ['tests/e2e/**', 'node_modules/**'],
    restoreMocks: true,
    // Has to clear the 5s `asyncUtilTimeout` set in tests/setup.js, or a slow
    // `findBy*` would be cut short by the test timeout before its own
    // deadline - reporting a timed-out test instead of the missing element,
    // and leaving the abandoned `userEvent` typing that setup file describes.
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.{js,jsx}'],
      // Canvas drawing and the app entry point cannot be meaningfully
      // asserted in jsdom - there is no 2D context to inspect - so counting
      // them would only inflate or deflate the number without saying
      // anything about whether the code works.
      exclude: ['src/main.jsx', 'src/theme.js', 'src/**/*.css'],
    },
  },
});
