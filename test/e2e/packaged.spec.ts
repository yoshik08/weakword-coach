import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { dismissCookies, launchApp, readWords, selectWordsMode, typeWords } from './helpers';
import { SEL } from '../../src/preload/selectors';

// Runs against the packaged build (release/win-unpacked) via `npm run test:packaged`.
test.skip(!process.env.WWC_EXE, 'set WWC_EXE to a packaged Weakword Coach executable');

test('packaged app: both windows, Monkeytype, a recorded words-10 test', async () => {
  expect(existsSync(process.env.WWC_EXE as string)).toBe(true);
  const { app, monkeytype, coach, userData } = await launchApp();
  try {
    await expect(coach).toHaveTitle('Weakword Coach');
    await expect(monkeytype.locator('#words')).toBeAttached({ timeout: 45_000 });
    await dismissCookies(monkeytype);

    await selectWordsMode(monkeytype, 10);
    const words = await readWords(monkeytype);
    expect(words).toHaveLength(10);
    await typeWords(monkeytype, words);
    await expect(monkeytype.locator(SEL.result)).toBeAttached({ timeout: 20_000 });

    // The packaged preload -> asar -> native better-sqlite3 chain wrote the test.
    const dbPath = path.join(userData, 'weakword.db');
    await expect.poll(() => existsSync(dbPath), { timeout: 10_000 }).toBe(true);
    await expect
      .poll(
        () => {
          const db = new Database(dbPath, { readonly: true });
          try {
            return (db.prepare('SELECT COUNT(*) AS n FROM tests').get() as { n: number }).n;
          } finally {
            db.close();
          }
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    const db = new Database(dbPath, { readonly: true });
    try {
      const w = db.prepare('SELECT COUNT(*) AS n FROM words').get() as { n: number };
      expect(w.n).toBe(10);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
  }
});
