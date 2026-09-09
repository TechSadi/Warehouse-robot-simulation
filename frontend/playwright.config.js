import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * These specs drive a real browser against a real stack: the Vite dev
 * server, the Express API, and MongoDB. That makes them the only tests here
 * that can catch a cookie that is never actually set, a CORS policy that
 * blocks the socket handshake, or a CSRF header the server rejects - none
 * of which a jsdom test can see, because in jsdom the network is a mock.
 *
 * It also makes them the slowest and most environment-dependent tests in
 * the project, which is why they are a separate `npm run test:e2e` rather
 * than part of the default suite: `npm test` must stay runnable on a laptop
 * with no database.
 *
 * They never touch production. `E2E_BASE_URL` points at a local dev server
 * by default and is expected to point at a staging deployment otherwise;
 * every spec creates its own account and its own warehouse, and cleans up
 * after itself, so the data it leaves behind belongs to nobody else.
 */
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:5173';

/** Only manage a dev server when running against the default local URL -
 * pointed at staging, Playwright must not try to boot anything. */
const isLocal = baseURL.includes('localhost') || baseURL.includes('127.0.0.1');

export default defineConfig({
  testDir: './tests/e2e',
  // A simulation is a live system: "the robot has moved" is not instant, and
  // a too-short timeout would make these flaky rather than strict.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Serial by default: these share one backend, and a shared tick loop makes
  // parallel runs interfere with each other's simulations.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',

  // Registers the one shared account this suite runs as - see the note in
  // tests/e2e/global-setup.js on why registrations are rationed.
  globalSetup: './tests/e2e/global-setup.js',

  use: {
    baseURL,
    // Every spec starts signed in as the shared account. The two that need
    // a fresh identity opt out with test.use({ storageState: ... }).
    storageState: './.playwright/shared-session.json',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: isLocal
    ? {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : undefined,
});
