import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { launchApp, pressHotkey, waitForPracticeTest, openCoach, panelVisible, playTest, readWords, ready, resultRow, seedHistory, tempUserData } from './helpers';

/** Reads the app's database without touching it (the app keeps it open). */
function query<T>(userData: string, sql: string): T[] {
  const db = new Database(path.join(userData, 'weakword.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}
const promptCount = (u: string) => query<{ n: number }>(u, "SELECT COUNT(*) AS n FROM prompts WHERE kind != 'legacy'")[0].n;
const newestPrompt = (u: string) => {
  const [r] = query<{ id: string; words: string; targets: string }>(u, 'SELECT id, words, targets FROM prompts ORDER BY created_at DESC LIMIT 1');
  return { id: r.id, words: JSON.parse(r.words) as string[], targets: JSON.parse(r.targets) as string[] };
};

test('practice my weak spots: from the panel, from the result and mid-test; drills never count as scores', async () => {
  test.setTimeout(300_000);
  const userData = tempUserData();
  seedHistory(userData, [
    { mode: 'words 10', wpm: 100, accuracy: 98, endedAt: Date.now() - 3 * 3600_000 },
    { mode: 'words 10', wpm: 104, accuracy: 99, endedAt: Date.now() - 2 * 3600_000 },
    { mode: 'words 10', wpm: 96, accuracy: 97, endedAt: Date.now() - 3600_000 },
  ]);
  const { app, monkeytype: page, coach } = await launchApp({ userData });
  try {
    await ready(page);
    await openCoach(page, coach);
    await expect(coach.locator('#quick')).toBeEnabled({ timeout: 15_000 });
    // The fixtures reach h slowly: the plan targets it (or a sequence built on it).
    const firstTarget = coach.locator('#session-body .target').first();
    await expect(firstTarget).toBeVisible();
    expect(await firstTarget.getAttribute('data-target')).toMatch(/^[kbt]:.*h/);
    await expect(firstTarget.locator('.reason')).toContainText(/slow/);

    // From the panel: it closes, the drill loads into Monkeytype's custom mode, focus is on the words.
    await coach.locator('#quick').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    await waitForPracticeTest(page);
    const prompt = newestPrompt(userData);
    expect(await readWords(page)).toEqual(prompt.words);
    expect(prompt.targets.some((t) => /^[kbt]:.*h/.test(t))).toBe(true);
    await expect(page.locator('#wwc-hud')).toContainText('Practice my weak spots');
    await expect(page.locator(SEL.wordsInput)).toBeFocused();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: 'docs/screenshots/07-drill-loaded.png' });

    await playTest(page);
    const row = await resultRow(page);
    await expect(row).toHaveAttribute('data-kind', 'drill');
    await expect(row).toContainText('Practice rounds never count toward your baseline');
    await expect(row.locator('[data-action="retest"]')).toBeVisible();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/screenshots/08-drill-result.png' });
    const [drill] = query<{ kind: string; eligible: number; prompt_id: string; source: string }>(userData, 'SELECT kind, eligible, prompt_id, source FROM tests ORDER BY id DESC LIMIT 1');
    expect(drill).toEqual({ kind: 'drill', eligible: 0, prompt_id: prompt.id, source: 'practice' });

    // The panel now asks for a normal test to measure progress.
    await openCoach(page, coach);
    await expect(coach.locator('#hero-body')).toContainText('Take a normal test to measure progress.');
    await expect(coach.locator('#summary')).toContainText('1 practice round');

    // Ctrl+Shift+P from the panel: another drill, the panel closes, Monkeytype's command line stays shut.
    await pressHotkey(app, 'coach');
    await expect.poll(() => promptCount(userData), { timeout: 60_000 }).toBe(2);
    await waitForPracticeTest(page);
    expect(await readWords(page)).toEqual(newestPrompt(userData).words);
    expect(await panelVisible(app)).toBe(false);
    await expect(page.locator('dialog#CommandlineModal[open]')).toHaveCount(0);

    // Mid-test: the running test is replaced by the next drill.
    await page.click(SEL.wordsWrapper);
    await page.keyboard.type((await readWords(page))[0].slice(0, 2));
    await pressHotkey(app);
    await expect.poll(() => promptCount(userData), { timeout: 60_000 }).toBe(3);
    await waitForPracticeTest(page);
    expect(await readWords(page)).toEqual(newestPrompt(userData).words);
    await expect(page.locator('dialog#CommandlineModal[open]')).toHaveCount(0);
    // The abandoned drill was never stored.
    expect(query<{ n: number }>(userData, "SELECT COUNT(*) AS n FROM tests WHERE kind = 'drill'")[0].n).toBe(1);
  } finally {
    await app.close();
  }
});
