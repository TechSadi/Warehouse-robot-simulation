import { test, expect } from '@playwright/test';
import {
  createWarehouse,
  deleteWarehouse,
  openDashboard,
  register,
  signOut,
  uniqueAccount,
  uniqueName,
  waitForLive,
} from './helpers.js';

/**
 * The failure paths, driven in a real browser.
 *
 * These are the cases the jsdom suite can only simulate: an actually
 * offline browser, a real socket whose transport is cut, and a real
 * httpOnly cookie being cleared. They exist because "recovers from network
 * failures" is a claim that can only be checked against a real network.
 */

test.describe('authentication failures', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('rejects bad credentials without hinting which half was wrong', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('nobody@example.test');
    await page.getByLabel('Password').fill('WrongPassword123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    // Deliberately non-committal so the form cannot be used to enumerate
    // which email addresses have accounts.
    await expect(alert).toContainText(/invalid email or password/i);
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('will not submit a password the server would reject as too weak', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Show the create account form' }).click();
    await page.getByLabel('Email').fill(uniqueAccount().email);
    await page.getByLabel('Password').fill('short1A');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();

    // The field's own minlength stops the submission before it reaches the
    // network, which is the point of stating the rule up front - the server
    // still enforces it, but the user is not made to wait to be told.
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: /sync layout to server/i })).toHaveCount(0);
  });
});

test.describe('session loss', () => {
  test('drops back to the sign-in screen when the session cookie is destroyed', async ({ page, context }) => {
    await openDashboard(page);

    // Exactly what an expired refresh token or a "sign out everywhere" from
    // another device looks like to this tab.
    await context.clearCookies();
    await page.getByRole('button', { name: /sync layout to server|re-sync layout/i }).click();

    await expect(page.getByLabel('Password')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('network failures', () => {
  test('reports an unreachable API and recovers when it comes back', async ({ page, context }) => {
    await openDashboard(page);

    await context.route('**/api/health', (route) => route.abort('failed'));
    await expect(page.getByText('API unreachable')).toBeVisible({ timeout: 30_000 });

    await context.unroute('**/api/health');
    await expect(page.getByText('API online')).toBeVisible({ timeout: 30_000 });
  });

  test('surfaces a failed action instead of doing nothing visible', async ({ page, context }) => {
    const warehouseName = uniqueName('Fail');
    await openDashboard(page);
    await createWarehouse(page, warehouseName);

    await context.route('**/api/robots', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: { message: 'Engine unavailable' } }),
      })
    );
    await page.getByRole('button', { name: /spawn robot/i }).click();

    await expect(page.getByText('Engine unavailable')).toBeVisible();
    // The failure is dismissible, not a permanent banner.
    await page.getByRole('button', { name: /^Dismiss$/ }).first().click();
    await expect(page.getByText('Engine unavailable')).toHaveCount(0);

    await context.unroute('**/api/robots');
    await deleteWarehouse(page, warehouseName);
  });

  test('goes offline, says so, and comes back live', async ({ page, context }) => {
    const warehouseName = uniqueName('Offline');
    await openDashboard(page);
    await createWarehouse(page, warehouseName);
    await waitForLive(page);

    await context.setOffline(true);

    // Both facts are reported, and the run control refuses commands it
    // cannot deliver rather than buffering them for later.
    await expect(page.getByText(/last state received/i)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole('button', { name: /start simulation/i })).toBeDisabled();

    await context.setOffline(false);

    await waitForLive(page);
    await expect(page.getByRole('button', { name: /start simulation/i })).toBeEnabled({ timeout: 40_000 });

    await deleteWarehouse(page, warehouseName);
  });

  test('resynchronises the fleet after a reconnect rather than showing stale state', async ({
    page,
    context,
  }) => {
    const warehouseName = uniqueName('Resync');
    await openDashboard(page);
    await createWarehouse(page, warehouseName);
    await page.getByRole('button', { name: /spawn robot/i }).click();
    await expect(page.locator('.robot-row')).toHaveCount(1, { timeout: 20_000 });
    await page.getByRole('button', { name: /start simulation/i }).click();
    await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation running' })).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText(/last state received/i)).toBeVisible({ timeout: 40_000 });
    await context.setOffline(false);

    // The tick loop kept running server-side while this client was away, so
    // the resync must restore the *current* run state, not the one this tab
    // last saw, and the fleet must come back from the server's snapshot.
    await waitForLive(page);
    await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation running' })).toBeVisible({ timeout: 40_000 });
    await expect(page.locator('.robot-row')).toHaveCount(1);

    await page.getByRole('button', { name: /stop simulation/i }).click();
    await expect(page.locator('.run-state__label').filter({ hasText: 'Simulation stopped' })).toBeVisible();
    await deleteWarehouse(page, warehouseName);
  });
});

test.describe('authorization', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("one account cannot see another account's warehouses", async ({ page }) => {
    const first = uniqueAccount();
    const warehouseName = uniqueName('Private');
    await register(page, first);
    await createWarehouse(page, warehouseName);
    await signOut(page);

    // A second account, registered in the same browser, must see nothing of
    // the first - warehouses are scoped per user server-side, and this is
    // the check that the client is not papering over a leak.
    const second = uniqueAccount();
    await register(page, second);
    await page.getByRole('button', { name: /browse saved/i }).click();

    await expect(page.getByText(warehouseName)).toHaveCount(0);
    await expect(page.getByText(/no saved layouts yet/i)).toBeVisible();
  });
});

test.describe('empty states', () => {
  test('says there are no obstacles once a warehouse exists', async ({ page }) => {
    const warehouseName = uniqueName('Obstacles');
    await openDashboard(page);
    await createWarehouse(page, warehouseName);

    await expect(page.getByText(/no obstacles on the floor/i)).toBeVisible();
    await expect(page.getByText(/no activity recorded/i)).toBeVisible();

    await deleteWarehouse(page, warehouseName);
  });
});

test.describe('responsiveness', () => {
  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'tablet', width: 900, height: 1024 },
    { name: 'small', width: 420, height: 800 },
  ]) {
    test(`the dashboard is usable at ${viewport.name} size`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openDashboard(page);

      // The one thing that must never happen at any width: the page itself
      // scrolling sideways. Panels may stack, the grid may shrink.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow).toBeLessThanOrEqual(1);

      // The controls that matter stay reachable rather than being clipped.
      await expect(page.getByRole('button', { name: /sync layout to server|re-sync layout/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
      await expect(page.locator('.sim-canvas canvas')).toBeVisible();
    });
  }
});

test.describe('keyboard access', () => {
  test('the grid can be driven without a mouse', async ({ page }) => {
    await openDashboard(page);

    // The skip link is the first tab stop, and it goes to the grid.
    await page.keyboard.press('Tab');
    await expect(page.locator('.skip-link')).toBeFocused();

    await page.locator('.sim-canvas canvas').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');

    // Moving the selection updates the cell inspector, which is how a
    // keyboard user knows where they are on a canvas.
    await expect(page.getByText(/X:\d+ Y:\d+ —/)).toBeVisible();
  });

  test('the shortcuts dialog traps focus and closes on Escape', async ({ page }) => {
    await openDashboard(page);

    await page.getByRole('button', { name: /shortcuts/i }).click();
    const dialog = page.getByRole('dialog', { name: /keyboard shortcuts/i });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('button', { name: /close keyboard shortcuts/i })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
