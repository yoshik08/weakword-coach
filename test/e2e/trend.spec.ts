import { expect, test, type Page } from '@playwright/test';
import { SEL } from '../../src/preload/selectors';
import type { CoachData } from '../../src/shared/types';
import { dismissCookies, launchApp, playSlowLetterTest, readWords, typeWords } from './helpers';

/** After the practice run the page reloads into the custom test; wait until it can be typed. */
async function waitForPracticeTest(page: Page): Promise<void> {
  await expect(page.locator(SEL.testMode)).toHaveText(/^custom/, { timeout: 30_000 });
  await expect(page.locator(SEL.word).first()).toBeAttached({ timeout: 30_000 });
  await dismissCookies(page);
  await page.waitForTimeout(1200); // the page's restart animation
}

test('the progress chart follows three improving tests and a practice test', async () => {
  test.setTimeout(420_000);
  const { app, monkeytype: page, coach } = await launchApp();
  try {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(SEL.words)).toBeAttached({ timeout: 45_000 });
    await dismissCookies(page);

    // No tests yet: the chart explains itself instead of drawing.
    await expect(coach.locator('#trend-empty')).toBeVisible();
    await expect(coach.locator('#trend-plot svg')).toHaveCount(0);

    // Three standard tests; the slow letters (e, o) get quicker each time.
    const delays = [500, 350, 230];
    for (const [i, slowDelay] of delays.entries()) {
      if (i > 0) {
        await page.locator(SEL.resultRestartButton).click();
        await expect(page.locator(SEL.result)).toHaveCount(0);
      }
      await playSlowLetterTest(page, { words: 50, slowDelay });
      await expect(coach.locator('#summary')).toContainText(`Based on ${i + 1} ${i ? 'tests' : 'test'}`, { timeout: 15_000 });
    }
    await expect(coach.locator('#trend-empty')).toBeHidden();
    await expect(coach.locator('.pt[data-series="overall"]')).toHaveCount(3);

    // Practice from the result screen, then play the practice test.
    await coach.locator('#practice').click();
    await expect(coach.locator('#practice-status')).toHaveText('Practice loaded in Monkeytype', { timeout: 60_000 });
    await waitForPracticeTest(page);
    const words = await readWords(page);
    await page.click(SEL.wordsWrapper);
    await expect(page.locator(SEL.wordsInput)).toBeFocused();
    await typeWords(page, words, { slowLetters: 'eo', slowDelay: 150 });
    await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
    await expect(coach.locator('#practice-note')).toHaveText('Practice: 1 session', { timeout: 15_000 });

    // The data behind the chart.
    const { trend, focusKeys } = await coach.evaluate((): Promise<CoachData> => window.coach.getData());
    console.log(`focus ${focusKeys}; ` + trend.map((p) => `#${p.testId} ${p.source} wpm ${p.wpm} weak ${p.weakSpotWpm?.toFixed(1)}`).join(' | '));
    expect(trend).toHaveLength(4);
    expect(trend.map((p) => p.source)).toEqual(['standard', 'standard', 'standard', 'practice']);
    expect(trend.every((p) => p.wpm !== null && p.wpm > 0)).toBe(true);
    for (const key of ['e', 'o']) expect(focusKeys).toContain(key);
    const weak = trend.map((p) => p.weakSpotWpm);
    expect(weak.every((v) => v !== null)).toBe(true);
    expect(weak[0]!).toBeLessThan(weak[1]!);
    expect(weak[1]!).toBeLessThan(weak[2]!);

    // The chart: both series, practice marked hollow, legend names the focus keys.
    await expect(coach.locator('.pt[data-series="overall"]')).toHaveCount(4);
    await expect(coach.locator('.pt[data-series="weak"]')).toHaveCount(4);
    await expect(coach.locator('.pt.practice[data-series="weak"]')).toHaveAttribute('data-test-id', String(trend[3].testId));
    await expect(coach.locator('#trend-weak')).toHaveText(`Weak keys ${focusKeys.join(' ')}`);

    // Hover and keyboard read out the same test.
    const tip = coach.locator('#trend-tip');
    const box = (await coach.locator('#trend-plot').boundingBox())!;
    await coach.mouse.move(box.x + box.width - 14, box.y + 60);
    await expect(tip).toContainText(`Test ${trend[3].testId}, practice`);
    await expect(tip).toContainText(String(Math.round(weak[3]!)));
    await coach.mouse.move(0, 0);
    await expect(tip).toBeHidden();
    await coach.locator('#trend-plot').focus();
    await coach.keyboard.press('ArrowLeft');
    await expect(tip).toContainText(`Test ${trend[2].testId}`);
    await coach.locator('#trend-plot').blur(); // drops the tooltip and the focus ring before the screenshot
    await expect(tip).toBeHidden();

    await coach.mouse.move(0, 0);
    await coach.waitForTimeout(700);
    await coach.screenshot({ path: 'docs/screenshots/05-coach-trend.png' });
    // Monkeytype's promo banner (when it shows) is not part of the picture.
    await page.locator('.content-grid.bg-main button:has(.fa-times)').first().click({ timeout: 1500 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(800); // let the result fade in
    await page.screenshot({ path: 'docs/screenshots/05-monkeytype-result.png' });
  } finally {
    await app.close();
  }
});
