import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where global-setup leaves the shared signed-in session and the account
 * that owns it, for specs that need to sign back in as the same person. */
export const SHARED_STATE_PATH = resolve(HERE, '../../.playwright/shared-session.json');
export const SHARED_ACCOUNT_PATH = resolve(HERE, '../../.playwright/shared-account.json');

export function sharedAccount() {
  return JSON.parse(readFileSync(SHARED_ACCOUNT_PATH, 'utf8'));
}

/**
 * Shared steps for the end-to-end specs.
 *
 * Registration is rationed - see the note in global-setup.js - so most
 * specs start already signed in as the shared account and give their
 * warehouse a unique name instead. `uniqueName` is what keeps two specs
 * (or two runs against the same staging environment) from colliding.
 */

export function uniqueAccount() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    email: `e2e-${stamp}@example.test`,
    // Satisfies the server's rules: 12+ chars, upper, lower, and a digit.
    password: `E2ePassword${stamp.slice(-4)}1`,
    name: 'E2E Runner',
  };
}

export function uniqueName(prefix) {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The dashboard is up and the session is real. */
export async function openDashboard(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /sync layout to server|re-sync layout/i })).toBeVisible();
}

export async function register(page, account) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Show the create account form' }).click();
  await page.getByLabel('Name').fill(account.name);
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('button', { name: /sync layout to server/i })).toBeVisible();
}

export async function signIn(page, account) {
  await page.goto('/');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: /sync layout|re-sync layout/i })).toBeVisible();
}

export async function signOut(page) {
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
}

/** Generates a floor plan and pushes it to the server, which is what makes
 * robots, orders and the live feed possible at all. */
export async function createWarehouse(page, name) {
  await page.getByLabel('Layout Name').fill(name);
  await page.getByRole('button', { name: /generate layout/i }).click();
  await page.getByRole('button', { name: /sync layout to server/i }).click();
  await expect(page.getByRole('button', { name: /re-sync layout/i })).toBeVisible();
}

export async function waitForLive(page) {
  await expect(page.locator('.status-pill').filter({ hasText: /Live|Reconnected/ }).first()).toBeVisible({
    timeout: 30_000,
  });
}

const robotRows = (page) => page.locator('.robot-row');

export async function spawnRobot(page) {
  const before = await robotRows(page).count();
  await page.getByRole('button', { name: /spawn robot/i }).click();
  await expect(robotRows(page)).toHaveCount(before + 1, { timeout: 20_000 });
}

/** Reads robot positions out of the roster - the accessible text mirror of
 * what the canvas draws, and the only way to assert on movement without
 * inspecting pixels. */
export function robotPositions(page) {
  return page.locator('.robot-row__meta').allTextContents();
}

/** Removes a warehouse this spec created, so a shared account does not
 * accumulate a layout per run. */
export async function deleteWarehouse(page, name) {
  const browse = page.getByRole('button', { name: /browse saved/i });
  if (await browse.isVisible()) await browse.click();
  const row = page.locator('.layout-row').filter({ hasText: name }).first();
  if ((await row.count()) === 0) return;
  // The delete button is labelled with the layout it deletes, so that two
  // rows are distinguishable to anyone navigating by control name.
  await row.getByRole('button', { name: new RegExp('^Delete layout ') }).click();
  await row.getByRole('button', { name: /yes, delete/i }).click();
  await expect(page.locator('.layout-row').filter({ hasText: name })).toHaveCount(0);
}
