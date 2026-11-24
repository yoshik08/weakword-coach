import { expect, test } from '@playwright/test';
import { launchApp } from './helpers';

test('launches both windows and loads Monkeytype as a guest', async () => {
  const { app, monkeytype, coach } = await launchApp();
  try {
    await monkeytype.waitForLoadState('domcontentloaded');
    await expect(monkeytype).toHaveTitle(/Monkeytype/i);
    await expect(monkeytype.locator('#words')).toBeAttached({ timeout: 45_000 });

    // Act like a guest: decline optional cookies if a consent dialog appears.
    const consent = monkeytype.getByRole('button', { name: /reject|necessary/i }).first();
    if (await consent.isVisible().catch(() => false)) await consent.click();

    await expect(coach).toHaveTitle('Weakword Coach');
    await expect(coach.getByText('Finish a Monkeytype test to see your weak spots.')).toBeVisible();

    // The app token and Electron token must be gone from the UA.
    const ua = await monkeytype.evaluate(() => navigator.userAgent);
    expect(ua).not.toMatch(/Electron|weakword/i);

    await monkeytype.waitForTimeout(1000);
    await monkeytype.screenshot({ path: 'docs/screenshots/01-launch-monkeytype.png' });
    await coach.screenshot({ path: 'docs/screenshots/01-launch-coach.png' });
  } finally {
    await app.close();
  }
});
