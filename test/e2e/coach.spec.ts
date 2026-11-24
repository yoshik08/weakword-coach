import { expect, test } from '@playwright/test';
import { SEL } from '../../src/preload/selectors';
import { dismissCookies, launchApp, playSlowLetterTest } from './helpers';

test('the coach heatmap and table update by themselves and point at the slow letters', async () => {
  test.setTimeout(300_000);
  const { app, monkeytype: page, coach } = await launchApp();
  try {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(SEL.words)).toBeAttached({ timeout: 45_000 });
    await dismissCookies(page);

    // Nothing typed yet: empty state, every key unknown.
    await expect(coach.locator('#empty')).toBeVisible();
    await expect(coach.locator('.key[data-state="unknown"]')).toHaveCount(26);
    await expect(coach.locator('#practice')).toBeDisabled();

    const { slow, errorLetter } = await playSlowLetterTest(page);

    // The coach window refreshes on its own: no reload.
    const eKey = coach.locator('.key[data-key="e"]');
    await expect(eKey).toHaveAttribute('data-state', 'weak', { timeout: 15_000 });
    await expect(coach.locator('.key[data-key="o"]')).toHaveAttribute('data-state', 'weak');
    await expect(coach.locator('#summary')).toContainText('Based on 1 test');
    await expect(coach.locator('#empty')).toBeHidden();

    const keys = await coach.locator('.key').evaluateAll((els) =>
      els.map((e) => ({
        key: e.getAttribute('data-key')!,
        state: e.getAttribute('data-state')!,
        confidence: Number(e.getAttribute('data-confidence')),
        known: e.getAttribute('data-confidence') !== '',
      })),
    );
    const known = keys.filter((k) => k.known).sort((a, b) => a.confidence - b.confidence);
    expect(known.slice(0, 2).map((k) => k.key).sort()).toEqual(['e', 'o']);

    // Letters table: the slow letters lead.
    const items = coach.locator('#rows tr[data-item]');
    await expect(items.first()).toBeVisible();
    expect([await items.nth(0).getAttribute('data-item'), await items.nth(1).getAttribute('data-item')].sort()).toEqual(['e', 'o']);

    // Most other letters with enough data are strong (the error letter is allowed to be weaker).
    const others = known.filter((k) => !slow.includes(k.key) && k.key !== errorLetter);
    expect(others.length).toBeGreaterThanOrEqual(3);
    const strong = others.filter((k) => k.state === 'strong');
    console.log(`slow ${slow}, error letter ${errorLetter}; strong ${strong.length}/${others.length}: ${others.map((k) => `${k.key}=${k.confidence}`).join(' ')}`);
    expect(strong.length).toBeGreaterThanOrEqual(Math.ceil(others.length * 0.7));

    // Screenshots of the coach window: hover a slow key for the tooltip, then the bigrams tab.
    await eKey.hover();
    await expect(coach.locator('#tip')).toBeVisible();
    await coach.waitForTimeout(700); // key colour transitions
    await coach.screenshot({ path: 'docs/screenshots/03-coach-heatmap.png' });

    await coach.locator('[data-kind="bigrams"]').click();
    await expect(coach.locator('#tabs')).toHaveAttribute('data-tab', '1');
    await coach.mouse.move(0, 0);
    await coach.waitForTimeout(600); // tab thumb slide
    await coach.screenshot({ path: 'docs/screenshots/03-coach-bigrams.png' });
  } finally {
    await app.close();
  }
});
