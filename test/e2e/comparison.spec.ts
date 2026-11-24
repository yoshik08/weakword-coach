// Demonstrates the Coach row on real results against fixture baselines (in a throwaway profile):
// a positive delta, a speed gain with lower accuracy, a negative delta, and a mode with no baseline.
import { expect, test, type Page } from '@playwright/test';
import { SEL } from '../../src/preload/selectors';
import { compositeShot, launchApp, openCoach, playTest, ready, resultRow, seedHistory, selectWordsMode, tempUserData } from './helpers';

async function next(page: Page): Promise<void> {
  await page.locator(SEL.resultRestartButton).click();
  await expect(page.locator(SEL.result)).toHaveCount(0);
  await page.waitForTimeout(1200);
}

const shot = async (page: Page, file: string) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `docs/screenshots/${file}` });
};

test('the Coach row compares each ordinary result with its own frozen baseline', async () => {
  test.setTimeout(360_000);
  const userData = tempUserData();
  const t0 = Date.now() - 6 * 3600_000;
  seedHistory(userData, [
    { mode: 'words 10', wpm: 80, accuracy: 99, endedAt: t0 },
    { mode: 'words 10', wpm: 82, accuracy: 99.5, endedAt: t0 + 60_000 },
    { mode: 'words 10', wpm: 78, accuracy: 98.5, endedAt: t0 + 120_000 },
    { mode: 'words 25', wpm: 220, accuracy: 99, endedAt: t0 + 180_000 },
    { mode: 'words 25', wpm: 225, accuracy: 99, endedAt: t0 + 240_000 },
    { mode: 'words 25', wpm: 215, accuracy: 99, endedAt: t0 + 300_000 },
    { mode: 'words 10', wpm: 150, accuracy: 100, endedAt: t0 + 3600_000, drill: true }, // coaching began
  ]);
  const { app, monkeytype: page, coach } = await launchApp({ userData });
  try {
    await ready(page);

    // 1. Faster than the words 10 baseline (80 wpm, 99%): a positive delta, labelled as a single run.
    await selectWordsMode(page, 10);
    await playTest(page);
    let row = await resultRow(page);
    await expect(row).toHaveAttribute('data-kind', 'compare');
    expect(Number(await row.getAttribute('data-dwpm'))).toBeGreaterThan(0);
    await expect(row.locator('[data-id="wpm"]')).toHaveAttribute('data-tone', 'up');
    await expect(row).toContainText('wpm vs pre-Coach');
    await expect(row).toContainText('One run since coaching began');
    await expect(row).toContainText('Pre-Coach baseline: 80 wpm, 99.0%, median of 3 tests.');
    await shot(page, '14-row-positive.png');

    // 2. Faster again but with corrected mistakes: speed up, accuracy down, both shown.
    await next(page);
    const words = await page.evaluate(({ w, l }) => [...document.querySelectorAll(w)].map((e) => [...e.querySelectorAll(l)].map((x) => x.getAttribute('data-char')).join('')), { w: SEL.word, l: SEL.letter });
    const errors = words.slice(0, 9).flatMap((word, i) => (i % 2 === 0 && word.length > 1 ? [{ word: i, char: 1, typed: word[1] === 'z' ? 'x' : 'z', fix: true }] : []));
    await playTest(page, { errors });
    row = await resultRow(page);
    await expect(row.locator('[data-id="wpm"]')).toHaveAttribute('data-tone', 'up');
    await expect(row.locator('[data-id="acc"]')).toHaveAttribute('data-tone', 'down');
    await expect(row).toContainText('Faster than your baseline, but less accurate.');
    await expect(row).toContainText('2 runs since coaching began');
    await shot(page, '15-row-tradeoff.png');

    // 3. words 25 against a 220 wpm baseline: a negative delta, shown just as plainly.
    await next(page);
    await selectWordsMode(page, 25);
    await playTest(page);
    row = await resultRow(page);
    expect(Number(await row.getAttribute('data-dwpm'))).toBeLessThan(0);
    await expect(row.locator('[data-id="wpm"]')).toHaveAttribute('data-tone', 'down');
    await expect(row.locator('[data-id="wpm"] .wwc-big')).toHaveText(/^−\d+$/);
    await expect(row).toContainText('Pre-Coach baseline: 220 wpm');
    await shot(page, '16-row-negative.png');

    // 4. words 50 was never typed before coaching: it needs its own baseline.
    await next(page);
    await selectWordsMode(page, 50);
    await playTest(page);
    row = await resultRow(page);
    await expect(row).toHaveAttribute('data-kind', 'no-baseline');
    await expect(row).toContainText('No tests in words 50 · english from before coaching began');
    await shot(page, '17-row-mismatch.png');
    await row.locator('[data-action="start-baseline"]').click();
    await expect(page.locator('#wwc-row')).toHaveAttribute('data-kind', 'calibrating');
    await expect(page.locator('#wwc-row')).toContainText('Baseline 1/3 complete');

    // The panel follows the chosen benchmark: words 25 shows the regression with its sample count.
    await openCoach(page, coach);
    const options = await coach.locator('#benchmark option').allTextContents();
    expect(options).toEqual(expect.arrayContaining([expect.stringMatching(/^words 10 · english \(5\)$/), expect.stringMatching(/^words 25 · english \(4\)$/)]));
    await coach.locator('#benchmark').selectOption({ label: options.find((o) => o.startsWith('words 25'))! });
    await expect(coach.locator('[data-testid="delta"] .delta[data-tone="down"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(coach.locator('#hero-body')).toContainText('One run since coaching began');
    await expect(coach.locator('#hero-body')).toContainText('Baseline 220.0 wpm, 99.0%');
    await compositeShot(page, coach, 'docs/screenshots/18-coach-benchmark.png');
  } finally {
    await app.close();
  }
});
