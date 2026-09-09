import { test, expect } from '@playwright/test';
import {
  createWarehouse,
  deleteWarehouse,
  openDashboard,
  register,
  robotPositions,
  sharedAccount,
  signIn,
  signOut,
  spawnRobot,
  uniqueAccount,
  uniqueName,
  waitForLive,
} from './helpers.js';

/**
 * The journey the whole application exists to support, end to end in a real
 * browser against a real backend:
 *
 *   register -> create a warehouse -> create a robot -> generate orders ->
 *   dispatch -> start -> watch robots move -> see an order complete ->
 *   stop -> sign out
 *
 * Run with `npm run test:e2e` against a local dev stack or a staging
 * deployment (E2E_BASE_URL). Never against production - it registers
 * accounts and creates and deletes warehouses.
 */
test.describe('full operator journey', () => {
  // The one spec that must start from nothing: it is testing registration.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('register, build a warehouse, run a simulation, and sign out', async ({ page }) => {
    const account = uniqueAccount();
    const warehouseName = uniqueName('Journey');

    await test.step('register', async () => {
      await register(page, account);
      await expect(page.getByText(account.name)).toBeVisible();
      await waitForLive(page);
    });

    await test.step('a brand new account starts empty, and says so', async () => {
      await expect(page.getByText(/no robots yet/i)).toBeVisible();
      await expect(page.getByText('No orders yet.')).toBeVisible();
      await expect(page.getByText(/no simulation yet/i)).toBeVisible();

      await page.getByRole('button', { name: /browse saved/i }).click();
      await expect(page.getByText(/no saved layouts yet/i)).toBeVisible();
      await page.getByRole('button', { name: /hide browser/i }).click();
    });

    await test.step('create a warehouse', async () => {
      await createWarehouse(page, warehouseName);
      await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation stopped' })).toBeVisible();
      await expect(page.getByText(/no obstacles on the floor/i)).toBeVisible();
    });

    await test.step('create robots', async () => {
      await spawnRobot(page);
      await spawnRobot(page);
      await expect(page.getByRole('heading', { name: /fleet roster \(2\)/i })).toBeVisible();
    });

    await test.step('generate and dispatch orders', async () => {
      await page.getByRole('button', { name: /generate orders/i }).click();
      await expect(page.getByRole('heading', { name: /active orders \([1-9]\d*\)/i })).toBeVisible();

      await page.getByRole('button', { name: /dispatch now/i }).click();
      // Dispatch assigns pending orders to robots; the roster and the order
      // list both change, pushed over the socket rather than polled.
      await expect(page.getByText('Assigned').first()).toBeVisible({ timeout: 20_000 });
    });

    await test.step('start the simulation', async () => {
      await page.getByRole('button', { name: /start simulation/i }).click();
      await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation running' })).toBeVisible();
      await expect(page.locator('.sim-canvas__badge--running')).toBeVisible();
    });

    await test.step('observe robot movement', async () => {
      const before = (await robotPositions(page)).join('|');
      // The tick loop runs server-side and broadcasts; the roster is the
      // text mirror of the canvas, so a change here is a real robot moving.
      await expect
        .poll(async () => (await robotPositions(page)).join('|'), { timeout: 40_000 })
        .not.toBe(before);
    });

    await test.step('watch an order complete', async () => {
      await expect
        .poll(async () => page.getByText('Delivered').count(), { timeout: 90_000 })
        .toBeGreaterThan(0);
    });

    await test.step('stop the simulation', async () => {
      await page.getByRole('button', { name: /stop simulation/i }).click();
      await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation stopped' })).toBeVisible();
      await expect(page.locator('.sim-canvas__badge--running')).toHaveCount(0);

      // Stopped really means stopped: positions stay put.
      const settled = await robotPositions(page);
      await page.waitForTimeout(3000);
      expect(await robotPositions(page)).toEqual(settled);
    });

    await test.step('clean up and sign out', async () => {
      await deleteWarehouse(page, warehouseName);
      await signOut(page);
    });
  });
});

test.describe('session persistence', () => {
  test('survives a page reload', async ({ page }) => {
    const account = sharedAccount();
    const warehouseName = uniqueName('Reload');
    await openDashboard(page);
    await createWarehouse(page, warehouseName);
    await spawnRobot(page);

    await page.reload();

    // The session cookie is httpOnly, so this proves the browser is sending
    // it and the server is honouring it - not that a flag survived in JS.
    await expect(page.getByText(account.name)).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);

    await deleteWarehouse(page, warehouseName);
  });

  test('signing back in finds the saved warehouse again', async ({ page }) => {
    const account = sharedAccount();
    const warehouseName = uniqueName('Persisted');

    await openDashboard(page);
    await createWarehouse(page, warehouseName);
    await signOut(page);

    await signIn(page, account);
    await page.getByRole('button', { name: /browse saved/i }).click();

    await expect(page.getByText(warehouseName)).toBeVisible();
    await deleteWarehouse(page, warehouseName);
  });
});
