import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { register, uniqueAccount, SHARED_STATE_PATH, SHARED_ACCOUNT_PATH } from './helpers.js';

/**
 * Registers one account for the whole run and saves its signed-in state.
 *
 * The backend caps registration at five per hour per IP
 * (backend/src/middleware/rateLimit.js) - a deliberate control that stops
 * the endpoint being used to probe which email addresses exist. A suite
 * that registered an account per test hit that ceiling after five tests and
 * failed the rest, which is the rate limiter working correctly, not a bug
 * to configure away: loosening a real security control so the tests are
 * easier to write would mean testing a system nobody runs.
 *
 * So the suite spends its registration budget deliberately. One account is
 * created here and reused through Playwright's storageState (httpOnly
 * session cookies included); the two specs that genuinely need a *new*
 * identity - the registration journey itself, and the check that one
 * account cannot see another's warehouses - opt out and register their own.
 * That is three registrations per run against a budget of five.
 *
 * Each test still creates its own uniquely named warehouse, so sharing an
 * account does not mean sharing state that matters.
 */
export default async function globalSetup(config) {
  const baseURL = config.projects[0]?.use?.baseURL || 'http://localhost:5173';
  const account = uniqueAccount();

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  try {
    await register(page, account);
    mkdirSync(dirname(SHARED_STATE_PATH), { recursive: true });
    await context.storageState({ path: SHARED_STATE_PATH });
    writeFileSync(SHARED_ACCOUNT_PATH, JSON.stringify(account, null, 2));
  } finally {
    await browser.close();
  }
}
