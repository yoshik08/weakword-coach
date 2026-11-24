import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { launchApp, openCoach, panelVisible, playTest, ready, resultRow, selectWordsMode } from './helpers';

// Runs against the packaged build (release/win-unpacked) via `npm run test:packaged`.
test.skip(!process.env.WWC_EXE, 'set WWC_EXE to a packaged Weakword Coach executable');

test('packaged app: one window, Coach beside the bell, ads blocked, a recorded test with its Coach row', async () => {
  test.setTimeout(180_000);
  expect(existsSync(process.env.WWC_EXE as string)).toBe(true);
  const { app, monkeytype, coach, userData } = await launchApp();
  try {
    await ready(monkeytype);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__wwc.adblock.blocked), { timeout: 15_000 }).toBeGreaterThan(0);

    await openCoach(monkeytype, coach);
    await expect(coach.locator('#summary')).toHaveText('No ordinary tests yet');
    await coach.keyboard.press('Escape');
    await expect.poll(() => panelVisible(app)).toBe(false);

    await selectWordsMode(monkeytype, 10);
    await playTest(monkeytype);
    const row = await resultRow(monkeytype);
    await expect(row).toContainText('Baseline 1/3 complete');
    expect(await monkeytype.evaluate(() => [...document.querySelectorAll('#result > *')].filter((c) => getComputedStyle(c).display !== 'none').length)).toBe(1);

    // The packaged preload -> asar -> native better-sqlite3 chain wrote the test.
    const dbPath = path.join(userData, 'weakword.db');
    const count = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) AS n FROM tests').get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    await expect.poll(count, { timeout: 10_000 }).toBe(1);
    await expect(monkeytype.locator(SEL.result)).toBeAttached();
  } finally {
    await app.close();
  }
});
