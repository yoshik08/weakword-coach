import { expect, test } from '@playwright/test';
import { SEL } from '../../src/preload/selectors';
import { compositeShot, launchApp, openCoach, panelVisible, playTest, ready, selectWordsMode } from './helpers';

test('one window: Monkeytype with the Coach beside the bell, no ads, keyboard-friendly panel', async () => {
  test.setTimeout(180_000);
  const { app, monkeytype: page, coach } = await launchApp();
  try {
    await ready(page);
    await expect(page).toHaveTitle(/Monkeytype/i);
    expect(app.windows().length).toBe(2); // the page and the Coach view, in one BrowserWindow
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // The Coach button sits right after the notification bell and looks like it.
    const bell = page.locator(SEL.navBell);
    const button = page.locator('#wwc-coach');
    expect(await bell.evaluate((b) => b.nextElementSibling?.id)).toBe('wwc-coach');
    expect(await button.getAttribute('class')).toBe(await bell.getAttribute('class'));
    await expect(button).toHaveAttribute('aria-label', 'Weakword Coach');

    // Ctrl+Shift+P belongs to the Coach: the key tips say Esc opens the command line.
    await expect(page.locator('#wwc-keytip')).toHaveText(/ctrl \+ shift \+ p\s*- practice weak spots/);
    const tip = page.locator('footer div', { hasText: /- command line$/ }).last();
    await expect(tip).not.toContainText('or');

    // Ads: the loader is blocked, the merch promo is dismissed, no ad slot is visible.
    await expect.poll(() => app.evaluate(() => (globalThis as any).__wwc.adblock.blocked), { timeout: 15_000 }).toBeGreaterThan(0);
    const hosts: string[] = await app.evaluate(() => [...(globalThis as any).__wwc.adblock.hosts]);
    expect(hosts).toContain('cdn.intergient.com');
    await expect(page.locator('a[href*="mktp.co/merch"]')).toHaveCount(0, { timeout: 10_000 });

    // The UA has no Electron or app token (sign-in providers would reject it).
    expect(await page.evaluate(() => navigator.userAgent)).not.toMatch(/Electron|weakword/i);
    await page.waitForTimeout(800);
    await page.screenshot({ path: 'docs/screenshots/01-launch.png' });

    // The panel: opens from the button, holds focus, closes with Esc and gives the keyboard back.
    await openCoach(page, coach);
    expect(await panelVisible(app)).toBe(true);
    await expect(coach.locator('#drawer')).toBeFocused();
    await expect(coach.locator('#summary')).toHaveText('No ordinary tests yet');
    for (let i = 0; i < 25; i++) await coach.keyboard.press('Tab');
    expect(await coach.evaluate(() => document.getElementById('drawer')!.contains(document.activeElement))).toBe(true);
    await compositeShot(page, coach, 'docs/screenshots/02-coach-empty.png');
    await coach.keyboard.press('Escape');
    await expect.poll(() => panelVisible(app)).toBe(false);
    await expect(page.locator(SEL.wordsInput)).toBeFocused();

    // The scrim closes it too.
    await openCoach(page, coach);
    await coach.mouse.click(100, 400);
    await expect.poll(() => panelVisible(app)).toBe(false);

    // A result screen with no ad slot and no gap where it was.
    await selectWordsMode(page, 10);
    await playTest(page);
    await expect(page.locator('#wwc-row')).toBeVisible({ timeout: 15_000 });
    const layout = await page.evaluate(() => {
      const result = document.querySelector('#result')!;
      const shown = [...result.children].filter((c) => getComputedStyle(c).display !== 'none');
      const ads = [...document.querySelectorAll('.advertisement, #ad-result-wrapper')].filter((e) => (e as HTMLElement).offsetParent !== null);
      return { shown: shown.map((c) => c.id), resultH: Math.round(result.getBoundingClientRect().height), targetH: Math.round(document.querySelector('#resultScreenshotTarget')!.getBoundingClientRect().height), ads: ads.length };
    });
    expect(layout.ads).toBe(0);
    expect(layout.shown).toEqual(['resultScreenshotTarget']);
    expect(layout.resultH).toBe(layout.targetH);
  } finally {
    await app.close();
  }
});
