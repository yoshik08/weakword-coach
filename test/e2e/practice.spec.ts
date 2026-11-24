import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { dismissCookies, launchApp, playSlowLetterTest, readWords, typeWords } from './helpers';

interface Focus {
  keys: string[];
  bigrams: string[];
  words: string[];
}

/** Reads the app's database without touching it (the app keeps it open). */
function query<T>(userData: string, sql: string): T[] {
  const db = new Database(path.join(userData, 'weakword.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

const newestSession = (userData: string) => {
  const [row] = query<{ id: number; words: string; focus: string }>(
    userData,
    'SELECT id, words, focus FROM practice_sessions ORDER BY id DESC LIMIT 1',
  );
  return { id: row.id, words: JSON.parse(row.words) as string[], focus: JSON.parse(row.focus) as Focus };
};
const sessionCount = (userData: string) =>
  query<{ n: number }>(userData, 'SELECT COUNT(*) AS n FROM practice_sessions')[0].n;

/** After a practice run the page reloads into the custom test; wait for it to be typeable. */
async function waitForPracticeTest(page: Page): Promise<void> {
  await expect(page.locator(SEL.testMode)).toHaveText(/^custom/, { timeout: 30_000 });
  await expect(page.locator(SEL.word).first()).toBeAttached({ timeout: 30_000 });
  await dismissCookies(page);
  await page.waitForTimeout(1200); // the page's restart animation
}

/**
 * Sends Ctrl+Shift+P to the Monkeytype window through the main process. Playwright's own
 * keyboard events are injected over CDP and never reach Electron's before-input-event.
 */
function pressHotkey(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('monkeytype.com'))!;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] });
  });
}

test('practice my weak spots loads a custom test in Monkeytype and tags its result', async () => {
  test.setTimeout(300_000);
  const { app, monkeytype: page, coach, userData } = await launchApp();
  try {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(SEL.words)).toBeAttached({ timeout: 45_000 });
    await dismissCookies(page);

    const { slow } = await playSlowLetterTest(page);
    await expect(coach.locator('#summary')).toContainText('Based on 1 test', { timeout: 15_000 });
    await expect(coach.locator('#practice')).toBeEnabled();

    // Practice from the result screen: Monkeytype is left on its result, the page reloads into the custom test.
    await coach.locator('#practice').click();
    await expect(coach.locator('#practice-status')).toHaveText('Practice loaded in Monkeytype', { timeout: 60_000 });
    await waitForPracticeTest(page);

    const session = newestSession(userData);
    expect(session.words).toHaveLength(30);
    const words = await readWords(page);
    expect(words).toEqual(session.words);
    for (const key of slow) expect(session.focus.keys).toContain(key);
    for (const word of words) {
      const hit = [...session.focus.keys, ...session.focus.bigrams].some((f) => word.includes(f));
      expect(hit, `"${word}" contains a focus key or bigram`).toBe(true);
    }
    console.log(`focus keys ${session.focus.keys} bigrams ${session.focus.bigrams} words ${session.focus.words}`);

    await page.click(SEL.wordsWrapper);
    await expect(page.locator(SEL.wordsInput)).toBeFocused();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: 'docs/screenshots/04-practice-loaded.png' });

    let midShot = false;
    await typeWords(page, words, {
      onWord: async (i) => {
        if (i === 12 && !midShot) {
          midShot = true;
          await page.screenshot({ path: 'docs/screenshots/04-practice-running.png' });
        }
      },
    });
    await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });

    // The test is stored as practice, linked to its session; the standard analysis is untouched.
    await expect.poll(() => query(userData, 'SELECT id FROM tests').length, { timeout: 10_000 }).toBe(2);
    const [practiceTest] = query<{ source: string; practice_id: number; mode: string }>(
      userData,
      'SELECT source, practice_id, mode FROM tests ORDER BY id DESC LIMIT 1',
    );
    expect(practiceTest.source).toBe('practice');
    expect(practiceTest.practice_id).toBe(session.id);
    expect(practiceTest.mode).toMatch(/^custom/);
    await expect(coach.locator('#practice-note')).toHaveText('Practice: 1 session');
    await expect(coach.locator('#summary')).toContainText('Based on 1 test');
    await coach.mouse.move(0, 0);
    await coach.screenshot({ path: 'docs/screenshots/04-coach-after-practice.png' });

    // Hotkey from the result screen: a second session, and Monkeytype's command line stays closed.
    await pressHotkey(app);
    await expect.poll(() => sessionCount(userData), { timeout: 60_000 }).toBe(2);
    await expect(coach.locator('#practice-status')).toHaveText('Practice loaded in Monkeytype', { timeout: 60_000 });
    await waitForPracticeTest(page);
    expect(await readWords(page)).toEqual(newestSession(userData).words);
    await expect(page.locator('dialog#CommandlineModal[open]')).toHaveCount(0);

    // Hotkey in the middle of a test: the running test is restarted and replaced.
    await page.click(SEL.wordsWrapper);
    await page.keyboard.type(words[0].slice(0, 2));
    await pressHotkey(app);
    await expect.poll(() => sessionCount(userData), { timeout: 60_000 }).toBe(3);
    await expect(coach.locator('#practice-status')).toHaveText('Practice loaded in Monkeytype', { timeout: 60_000 });
    await waitForPracticeTest(page);
    expect(await readWords(page)).toEqual(newestSession(userData).words);
    await expect(page.locator('dialog#CommandlineModal[open]')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
