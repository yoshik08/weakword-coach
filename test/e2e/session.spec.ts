import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { compositeShot, launchApp, openCoach, panelVisible, playTest, ready, resultRow, seedHistory, tempUserData, waitForPracticeTest } from './helpers';

// Short rounds so the whole session types in about a minute (the real defaults run 5-7 minutes).
const TUNING = JSON.stringify({ stepSeconds: { warmup: 4, accuracy: 5, speed: 4, mixed: 6 }, accuracyRounds: 1, speedBursts: 1, wordsMin: 8 });
const DAY = 24 * 3600_000;

function query<T>(userData: string, sql: string): T[] {
  const db = new Database(path.join(userData, 'weakword.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

async function nextTestIsReady(page: Page) {
  await expect(page.locator(SEL.result)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(SEL.word).first()).toBeAttached({ timeout: 30_000 });
  await page.waitForTimeout(1200);
}

test('a full session ends in a normal retest compared with the frozen baseline; it resumes and follows up a day later', async () => {
  test.setTimeout(480_000);
  const userData = tempUserData();
  const t0 = Date.now() - 4 * 3600_000;
  seedHistory(userData, [
    { mode: 'words 10', wpm: 100, accuracy: 98, endedAt: t0 },
    { mode: 'words 10', wpm: 110, accuracy: 99, endedAt: t0 + 600_000 },
    { mode: 'words 10', wpm: 90, accuracy: 97, endedAt: t0 + 1_200_000 },
  ]);

  // 1. The session.
  let { app, monkeytype: page, coach } = await launchApp({ userData, env: { WWC_TUNING: TUNING } });
  try {
    await ready(page);
    await openCoach(page, coach);
    await expect(coach.locator('#hero-title')).toHaveText('Your baseline');
    await expect(coach.locator('#hero-body')).toContainText('Median of your last 3 words 10 · english tests');
    await expect(coach.locator('#primary')).toHaveText(/^Start session · about \d+ min$/, { timeout: 15_000 });
    const steps = await coach.locator('#session-body .steps li').allTextContents();
    expect(steps[0]).toBe('Warm-up');
    expect(steps.at(-1)).toBe('Normal retest');
    await compositeShot(page, coach, 'docs/screenshots/09-coach-before-session.png');

    await coach.locator('#primary').click();
    await expect.poll(() => panelVisible(app)).toBe(false);
    for (let i = 0; i < steps.length - 1; i++) {
      if (i > 0) await page.locator('#wwc-row [data-action="continue"]').click();
      await waitForPracticeTest(page);
      await expect(page.locator('#wwc-hud')).toContainText(`Coach ${i + 1}/${steps.length}`);
      await expect(page.locator('#wwc-hud')).toContainText(steps[i]);
      if (i === 1) {
        await page.mouse.move(0, 0);
        await page.screenshot({ path: 'docs/screenshots/10-session-step.png' });
      }
      await playTest(page);
      const row = await resultRow(page);
      await expect(row).toHaveAttribute('data-kind', 'drill');
      await expect(row).toHaveAttribute('data-step', String(i));
    }
    await expect(page.locator('#wwc-row [data-action="continue"]')).toHaveText(/Next: Normal retest/);

    // The retest: an ordinary words 10 test from Monkeytype's own generator.
    await page.locator('#wwc-row [data-action="continue"]').click();
    await expect(page.locator(SEL.testMode)).toHaveText(/^words 10 /, { timeout: 30_000 });
    await nextTestIsReady(page);
    await expect(page.locator('#wwc-hud')).toContainText('Normal retest');
    await playTest(page);
    const row = await resultRow(page);
    await expect(row).toHaveAttribute('data-kind', 'compare');
    await expect(row).toHaveAttribute('data-window', '1');
    await expect(row).toHaveAttribute('data-baseline-wpm', '100');
    await expect(row).toContainText('One run since coaching began');
    await expect(row).toContainText('Session retest.');
    await expect(page.locator('#wwc-hud')).toHaveCount(0); // session over
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/screenshots/11-result-compare.png' });

    // The database: practice rounds never reach the baseline or the comparison.
    const [baseline] = query<{ test_ids: string; wpm: number; accuracy: number }>(userData, 'SELECT test_ids, wpm, accuracy FROM baselines');
    expect(JSON.parse(baseline.test_ids)).toEqual([1, 2, 3]);
    expect(baseline).toMatchObject({ wpm: 100, accuracy: 98 });
    const drills = query<{ eligible: number }>(userData, "SELECT eligible FROM tests WHERE kind = 'drill'");
    expect(drills).toHaveLength(steps.length - 1);
    expect(drills.every((d) => d.eligible === 0)).toBe(true);
    const [session] = query<{ status: string; followup_due_at: number; retest_test_id: number }>(userData, 'SELECT status, followup_due_at, retest_test_id FROM sessions');
    expect(session.status).toBe('done');
    expect(session.followup_due_at).toBeGreaterThan(Date.now() + 23 * 3600_000);

    // The panel: measured change, follow-up date, ordinary vs practice on the chart.
    await openCoach(page, coach);
    await expect(coach.locator('#hero-title')).toHaveText('Since coaching');
    await expect(coach.locator('[data-testid="delta"]')).toBeVisible();
    await expect(coach.locator('#hero-body')).toContainText('One run since coaching began');
    await expect(coach.locator('#followup')).toContainText('Follow-up test on');
    await expect(coach.locator('.pt.practice[data-series="overall"]')).toHaveCount(steps.length - 1);
    await expect(coach.locator('.pt[data-series="overall"]:not(.practice)')).toHaveCount(4);
    await compositeShot(page, coach, 'docs/screenshots/12-coach-after-session.png');

    // Start another session and quit in the middle of it.
    await coach.locator('#primary').click();
    await waitForPracticeTest(page);
  } finally {
    await app.close();
  }

  // 2. History persists and the session resumes after a restart.
  ({ app, monkeytype: page, coach } = await launchApp({ userData, env: { WWC_TUNING: TUNING } }));
  try {
    await ready(page);
    await expect(page.locator('#wwc-hud')).toHaveAttribute('data-state', 'paused', { timeout: 15_000 });
    await expect(page.locator('#wwc-coach .wwc-dot')).toBeVisible();
    await openCoach(page, coach);
    await expect(coach.locator('#session-title')).toHaveText('Session in progress');
    await expect(coach.locator('#primary')).toHaveText('Resume: Warm-up');
    await expect(coach.locator('#hero-body')).toContainText('One run since coaching began');
    await coach.keyboard.press('Escape');
    await page.locator('#wwc-hud [data-hud="resume"]').click();
    await waitForPracticeTest(page);
    await expect(page.locator('#wwc-hud')).toHaveAttribute('data-state', 'step');
    await page.locator('#wwc-hud [data-hud="end"]').click();
    await expect(page.locator('#wwc-hud')).toHaveCount(0);
  } finally {
    await app.close();
  }

  // 3. A day later: the follow-up is due and shows on the next ordinary test.
  ({ app, monkeytype: page, coach } = await launchApp({ userData, env: { WWC_TUNING: TUNING, WWC_CLOCK_OFFSET_MS: String(DAY + 3600_000) } }));
  try {
    await ready(page);
    await expect(page.locator('#wwc-coach')).toHaveAttribute('aria-label', 'Weakword Coach: follow-up test due', { timeout: 15_000 });
    await openCoach(page, coach);
    await expect(coach.locator('#followup')).toContainText('Follow-up test due');
    await coach.locator('#followup button').click();
    await expect(page.locator(SEL.testMode)).toHaveText(/^words 10 /, { timeout: 30_000 });
    await nextTestIsReady(page);
    await playTest(page);
    const row = await resultRow(page);
    await expect(row).toContainText(/Follow-up a day after your session: [+−±]\d+(\.\d)? wpm vs pre-Coach \(the retest right after was [+−±]\d+(\.\d)?\)\./);
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'docs/screenshots/13-result-followup.png' });
  } finally {
    await app.close();
  }
});
