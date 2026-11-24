import { _electron as electron, chromium, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { insertTest, openDb, saveBaseline, currentPeriod, markFirstDrill } from '../../src/main/db';
import { LABEL, SEL } from '../../src/preload/selectors';
import { deriveStats } from '../../src/shared/keystats';
import { eligibility, kindOf, profileKey, profileOf } from '../../src/shared/profile';
import type { CapturedTest } from '../../src/shared/types';

export interface Launched {
  app: ElectronApplication;
  monkeytype: Page;
  coach: Page;
  userData: string;
}

/** A throwaway profile folder. Fixtures only ever go here, never into the real %APPDATA% profile. */
export function tempUserData(): string {
  return mkdtempSync(path.join(tmpdir(), 'wwc-e2e-'));
}

export interface LaunchOptions {
  userData?: string;
  executablePath?: string;
  env?: Record<string, string>;
}

/**
 * Launches the app with a throwaway profile and no focus stealing (WWC_TEST=1).
 * With an executablePath (default: env WWC_EXE) it launches that packaged build instead of the repo.
 */
export async function launchApp(opts: LaunchOptions = {}): Promise<Launched> {
  const userData = opts.userData ?? tempUserData();
  const executablePath = opts.executablePath ?? process.env.WWC_EXE;
  // A parent shell may export ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env as Record<string, string>;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    env: { ...env, WWC_TEST: '1', WWC_USER_DATA: userData, ...(opts.env ?? {}) },
  });

  // The Monkeytype page and the Coach view can appear in either order; match them by URL.
  const find = (re: RegExp) => app.windows().find((w) => re.test(w.url()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const monkeytype = find(/monkeytype\.com/);
    const coach = find(/coach[\/]index\.html/);
    if (monkeytype && coach) return { app, monkeytype, coach, userData };
    await new Promise((r) => setTimeout(r, 200));
  }
  await app.close();
  throw new Error('Timed out waiting for the Monkeytype page and the Coach view');
}

/** Waits until Monkeytype is typeable and the app's own additions are in place. */
export async function ready(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator(SEL.words)).toBeAttached({ timeout: 45_000 });
  await dismissCookies(page);
  await expect(page.locator('#wwc-coach')).toBeVisible({ timeout: 15_000 });
}

/** Clicks "reject non-essential" if Monkeytype's cookie dialog shows up (it can take a moment). */
export async function dismissCookies(page: Page): Promise<void> {
  const dialog = page.locator(SEL.cookiesDialog);
  try {
    await dialog.waitFor({ timeout: 5000 });
  } catch {
    return; // no dialog
  }
  await dialog.locator('button', { hasText: new RegExp(`^${LABEL.rejectCookies}$`) }).click();
  await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await expect(page.locator(SEL.cookiesDialog)).toHaveCount(0);
}

/** Opens the Coach panel with the header button, as a user would. */
export async function openCoach(page: Page, coach: Page): Promise<void> {
  await page.locator('#wwc-coach').click();
  await expect(coach.locator('body')).toHaveClass(/open/, { timeout: 10_000 });
  await coach.waitForTimeout(400); // slide-in
}

export async function closeCoach(coach: Page): Promise<void> {
  await coach.keyboard.press('Escape');
  await expect(coach.locator('body')).not.toHaveClass(/open/);
}

/** True when the Coach view is shown over the page (checked in the main process). */
export function panelVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((v) => (v as Electron.WebContentsView).webContents?.getURL().includes('coach'));
    return Boolean(view?.getVisible());
  });
}

/** Picks a mode and a length through the test config bar, then focuses the typing area. */
export async function selectMode(page: Page, mode: 'words' | 'time', n: number): Promise<void> {
  const config = page.locator(SEL.testConfig);
  await config.locator('button').filter({ hasText: new RegExp(`^${mode}$`) }).click();
  await config.locator('button:visible').filter({ hasText: new RegExp(`^${n}$`) }).click();
  await expect(page.locator(SEL.testMode)).toHaveText(new RegExp(`^${mode} ${n} `));
  await page.waitForTimeout(1200); // the restart animation ignores clicks
  await page.click(SEL.wordsWrapper);
  await expect(page.locator(SEL.wordsInput)).toBeFocused();
}

export const selectWordsMode = (page: Page, n: number) => selectMode(page, 'words', n);

/** Target text of every rendered word, in index order. */
export async function readWords(page: Page): Promise<string[]> {
  return page.evaluate(
    ({ word, letter, extra }) =>
      [...document.querySelectorAll(word)]
        .sort((a, b) => Number(a.getAttribute('data-wordindex')) - Number(b.getAttribute('data-wordindex')))
        .map((w) =>
          [...w.querySelectorAll(letter)]
            .filter((l) => !l.matches(extra))
            .map((l) => l.getAttribute('data-char'))
            .join(''),
        ),
    { word: SEL.word, letter: SEL.letter, extra: SEL.extraLetter },
  );
}

export interface TypeOptions {
  /** ms before each key (default 70). */
  baseDelay?: number;
  /** Letters that get `slowDelay` before them instead of `baseDelay`. */
  slowLetters?: string;
  slowDelay?: number;
  /** Wrong letters typed in place of the right one. `fix` types the wrong letter, Backspace, then the right one. */
  errors?: { word: number; char: number; typed: string; fix?: boolean }[];
  /** Called after each word (and its Space) is typed. */
  onWord?: (index: number) => Promise<void>;
}

/** Types the words with Playwright's keyboard (one Space between words, none after the last). Returns the keys pressed. */
export async function typeWords(page: Page, words: string[], opts: TypeOptions = {}): Promise<string[]> {
  const { baseDelay = 70, slowLetters = '', slowDelay = 450, errors = [], onWord } = opts;
  const keys: string[] = [];
  const press = async (key: string, delay: number) => {
    await page.waitForTimeout(delay);
    if (key === 'Backspace') await page.keyboard.press(key);
    else await page.keyboard.type(key);
    keys.push(key);
  };
  for (const [w, word] of words.entries()) {
    for (const [c, ch] of [...word].entries()) {
      const delay = slowLetters.includes(ch) ? slowDelay : baseDelay;
      const error = errors.find((e) => e.word === w && e.char === c);
      if (!error) {
        await press(ch, delay);
        continue;
      }
      await press(error.typed, delay);
      if (error.fix) {
        await press('Backspace', baseDelay);
        await press(ch, baseDelay);
      }
    }
    if (w < words.length - 1) await press(' ', baseDelay);
    await onWord?.(w);
  }
  return keys;
}

/** Errors on every `every`-th word at its second letter (left in, so accuracy drops). */
export function errorsEvery(words: string[], every: number, typed = 'q'): NonNullable<TypeOptions['errors']> {
  return words.flatMap((w, i) => (i % every === every - 1 && w.length > 1 && w[1] !== typed ? [{ word: i, char: 1, typed }] : []));
}

/** Types the words on screen and waits for the result screen. */
export async function playTest(page: Page, opts: TypeOptions = {}): Promise<string[]> {
  const words = await readWords(page);
  await page.click(SEL.wordsWrapper);
  await typeWords(page, words, opts);
  await expect(page.locator(SEL.result)).toBeAttached({ timeout: 30_000 });
  return words;
}

/**
 * Plays one standard test (default 100 words, so a few bigrams reach the minimum attempts) with slow
 * `e` and `o` and three uncorrected errors on the most common other letter, and waits for the result screen.
 */
export async function playSlowLetterTest(
  page: Page,
  { words: count = 100, slowDelay = 450 }: { words?: number; slowDelay?: number } = {},
): Promise<{ words: string[]; slow: string[]; errorLetter: string }> {
  await selectWordsMode(page, count);
  const words = await readWords(page);
  expect(words).toHaveLength(count);

  const counts = new Map<string, number>();
  for (const ch of words.join('')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const slow = ['e', 'o'];
  for (const l of slow) expect(counts.get(l) ?? 0, `letter ${l} in the words`).toBeGreaterThan(8);
  const errorLetter = [...counts].filter(([l]) => !slow.includes(l) && l !== 'q').sort((a, b) => b[1] - a[1])[0][0];
  const errors: NonNullable<TypeOptions['errors']> = [];
  for (const [w, word] of words.entries()) {
    const c = [...word].findIndex((ch, i) => i > 0 && ch === errorLetter);
    if (c > 0 && errors.length < 3 && (errors.length === 0 || w - errors[errors.length - 1].word >= 5)) {
      errors.push({ word: w, char: c, typed: 'q' });
    }
  }
  expect(errors).toHaveLength(3);

  await typeWords(page, words, { baseDelay: 70, slowLetters: slow.join(''), slowDelay, errors });
  await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
  return { words, slow, errorLetter };
}

/** The Coach row under the result's wpm and acc, once it has rendered. */
export async function resultRow(page: Page) {
  const row = page.locator('#wwc-row');
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** After a drill loads, the page has reloaded into the custom test; wait until it can be typed. */
export async function waitForPracticeTest(page: Page): Promise<void> {
  await expect(page.locator(SEL.testMode)).toHaveText(/^custom/, { timeout: 30_000 });
  await expect(page.locator(SEL.word).first()).toBeAttached({ timeout: 30_000 });
  await dismissCookies(page);
  await page.waitForTimeout(1200); // the page's restart animation
}

/** Ctrl+Shift+P through Electron's input pipeline (Playwright's CDP keys never reach before-input-event). */
export function pressHotkey(app: ElectronApplication, target: 'monkeytype' | 'coach' = 'monkeytype'): Promise<void> {
  return app.evaluate(({ webContents }, t) => {
    const wc = webContents.getAllWebContents().find((w) => (t === 'coach' ? w.getURL().includes('coach') : w.getURL().includes('monkeytype.com')))!;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control', 'shift'] });
  }, target);
}

// Fixtures

/** The letter fixture history types slowly. */
export const FIXTURE_SLOW = 'h';

export interface FixtureTest {
  mode: string;
  wpm: number;
  accuracy: number;
  endedAt: number;
  drill?: boolean;
  punctuation?: boolean;
}

/**
 * Seeds a throwaway profile with fixture history: ordinary tests (and optionally drills, which start
 * coaching). Refuses to touch anything outside the temp folder.
 */
export function seedHistory(userData: string, tests: FixtureTest[]): void {
  if (!path.resolve(userData).startsWith(path.resolve(tmpdir()))) throw new Error('fixtures only go into temp profiles');
  const db = openDb(path.join(userData, 'weakword.db'));
  const qwerty = 'qwertyuiopasdfghjklzxcvbnm';
  const keyCodes = Object.fromEntries([...qwerty].map((c) => [c, `Key${c.toUpperCase()}`]));
  const pool = ['the', 'of', 'and', 'that', 'have', 'with', 'this', 'from', 'they', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'time', 'just', 'know', 'take', 'people', 'into', 'year', 'your', 'good', 'some', 'could', 'them', 'other', 'than', 'then', 'look', 'only', 'come', 'over', 'think', 'also', 'back', 'after', 'work', 'first', 'well', 'even', 'want', 'because', 'these', 'give', 'most'];
  let seq = 0;
  for (const f of tests) {
    seq++;
    const words = Array.from({ length: 40 }, (_, i) => pool[(i * 7 + seq * 3) % pool.length]);
    const keystrokes: CapturedTest['keystrokes'] = [];
    let t = 0;
    // A habit to find: h (inside the, that, which ...) is reached slowly; everything else is even.
    words.forEach((w, wi) => {
      [...w, ...(wi < words.length - 1 ? [' '] : [])].forEach((ch, pos) => {
        if (keystrokes.length > 0) t += ch === FIXTURE_SLOW ? 260 : 95 + ((pos * 13) % 30);
        keystrokes.push({ seq: keystrokes.length, t, key: ch, expected: ch, correct: true, wordIndex: wi, pos, flags: 0 });
      });
    });
    const [mode, mode2] = f.mode.split(' ');
    const test: CapturedTest = {
      clientId: `fixture-${seq}-${f.endedAt}`,
      startedAt: f.endedAt - t, endedAt: f.endedAt, mode: f.drill ? 'custom custom' : f.mode, language: 'english', words, keystrokes,
      result: { wpm: f.wpm, raw: f.wpm + 2, accuracy: f.accuracy, consistency: 70 },
      record: { testType: f.drill ? ['custom'] : [`${mode} ${mode2}`, 'english', ...(f.punctuation ? ['punctuation'] : [])], other: [] },
      settings: { layout: 'default', confidenceMode: 'off' }, keyCodes,
    };
    const kind = kindOf(test.mode, Boolean(f.drill));
    const p = profileOf(test);
    const { eligible, reason } = eligibility(kind, test.result, test.record, false);
    insertTest(db, test, { kind, eligible, reason, profileKey: profileKey(p), layout: p.layout, corpusVersion: null, promptId: null, sessionId: null, stats: deriveStats(test) });
    if (f.drill) {
      const period = currentPeriod(db);
      if (period.firstDrillAt === null) markFirstDrill(db, period.id, f.endedAt);
    }
  }
  void saveBaseline; // baselines freeze inside the app, exactly as for real history
  db.close();
}

/** Layers the Coach view over the Monkeytype page into one picture (they are two web contents). */
export async function compositeShot(monkeytype: Page, coach: Page, file: string): Promise<void> {
  const [under, over] = await Promise.all([monkeytype.screenshot(), coach.screenshot({ omitBackground: true })]);
  const browser = await chromium.launch();
  try {
    const size = await monkeytype.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const page = await browser.newPage({ viewport: size });
    const vp = page.viewportSize()!;
    const html = `<body style="margin:0"><img src="data:image/png;base64,${under.toString('base64')}" style="position:absolute;inset:0;width:${vp.width}px">` +
      `<img src="data:image/png;base64,${over.toString('base64')}" style="position:absolute;inset:0;width:${vp.width}px"></body>`;
    await page.setContent(html);
    await page.waitForTimeout(100);
    writeFileSync(file, await page.screenshot());
  } finally {
    await browser.close();
  }
}
