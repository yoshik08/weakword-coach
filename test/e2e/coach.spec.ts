import { expect, test } from '@playwright/test';
import { compositeShot, launchApp, openCoach, playSlowLetterTest, ready, resultRow } from './helpers';

test('sparse history: calibration, learning labels, then the heatmap points at the slow letters', async () => {
  test.setTimeout(300_000);
  const { app, monkeytype: page, coach } = await launchApp();
  try {
    await ready(page);
    const { slow, errorLetter } = await playSlowLetterTest(page);

    // One test: the row under wpm/acc says how far the baseline is.
    const row = await resultRow(page);
    await expect(row).toHaveAttribute('data-kind', 'calibrating');
    await expect(row).toContainText('Baseline 1/3 complete');
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/screenshots/04-result-calibrating.png' });

    // The Coach shows calibration and keeps everything "Learning" (one run is not enough evidence).
    await openCoach(page, coach);
    await expect(coach.locator('#summary')).toContainText('1 ordinary test');
    await expect(coach.locator('[data-testid="calibration"]')).toContainText('1/3');
    await expect(coach.locator('#hero-body')).toContainText('Baseline 1/3 complete');
    await expect(coach.locator('.key[data-state="learning"]').first()).toBeVisible();
    expect(await coach.locator('.key[data-state="weak"]').count()).toBe(0);
    await expect(coach.locator('#rows tr').first()).toHaveAttribute('data-status', 'learning');
    await expect(coach.locator('#session-body')).toContainText('Still learning');
    await compositeShot(page, coach, 'docs/screenshots/05-coach-sparse.png');
    await coach.keyboard.press('Escape');

    // A second run of the same habits: the slow letters are now weak, the others mostly on par.
    await page.locator('#result [data-ui-element="restartTestButton"]').click();
    await expect(page.locator('#result')).toHaveCount(0);
    await playSlowLetterTest(page);
    await expect(await resultRow(page)).toContainText('Baseline 2/3 complete');
    await openCoach(page, coach);
    const e = coach.locator('.key[data-key="e"]');
    await expect(e).toHaveAttribute('data-state', 'weak', { timeout: 15_000 });
    await expect(coach.locator('.key[data-key="o"]')).toHaveAttribute('data-state', 'weak');
    const keys = await coach.locator('.key').evaluateAll((els) =>
      els.map((k) => ({ key: k.getAttribute('data-key')!, state: k.getAttribute('data-state')!, heat: Number(k.getAttribute('data-heat') || 0) })),
    );
    const known = keys.filter((k) => k.state === 'weak' || k.state === 'ok').sort((a, b) => b.heat - a.heat);
    expect(known.slice(0, 2).map((k) => k.key).sort()).toEqual(['e', 'o']);
    const others = known.filter((k) => !slow.includes(k.key) && k.key !== errorLetter);
    expect(others.filter((k) => k.state === 'ok').length).toBeGreaterThanOrEqual(Math.ceil(others.length * 0.7));

    // Letters table and explanations, then the sequences tab.
    const first = coach.locator('#rows tr[data-item]').first();
    expect(['e', 'o']).toContain(await first.getAttribute('data-item'));
    await expect(coach.locator('#explain')).toContainText(/(e|o) is slow to reach: \d+ ms vs your usual \d+ ms\./);
    await expect(coach.locator('#session-body .target').first()).toBeVisible();
    await e.hover();
    await expect(coach.locator('#tip')).toBeVisible();
    await coach.waitForTimeout(600);
    await compositeShot(page, coach, 'docs/screenshots/06-coach-heatmap.png');
    await coach.locator('[data-kind="sequences"]').click();
    await expect(coach.locator('#tabs')).toHaveAttribute('data-tab', '1');
    await expect(coach.locator('#item-head')).toHaveText('Sequence');
    // Hints on request.
    await coach.locator('label.switch:has(#hints)').click();
    await expect(coach.locator('#session-body .fingering').first()).toBeVisible({ timeout: 10_000 });
    // The warm-up is optional.
    const firstStep = coach.locator('#session-body .steps li').first();
    await expect(firstStep).toHaveText('Warm-up');
    await coach.locator('label.switch:has(#warmup)').click();
    await expect(firstStep).not.toHaveText('Warm-up', { timeout: 10_000 });
    await coach.locator('label.switch:has(#warmup)').click();
    await expect(firstStep).toHaveText('Warm-up', { timeout: 10_000 });
  } finally {
    await app.close();
  }
});
