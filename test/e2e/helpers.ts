import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LABEL, SEL } from '../../src/preload/selectors';

export interface Launched {
  app: ElectronApplication;
  monkeytype: Page;
  coach: Page;
  userData: string;
}

/** Launches the app with a throwaway profile and no focus stealing (WWC_TEST=1). */
export async function launchApp(): Promise<Launched> {
  const userData = mkdtempSync(path.join(tmpdir(), 'wwc-e2e-'));
  // A parent shell may export ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env as Record<string, string>;
  const app = await electron.launch({
    args: ['.'],
    env: { ...env, WWC_TEST: '1', WWC_USER_DATA: userData },
  });

  // Windows can appear in either order; wait until both exist, then match by URL.
  const find = (re: RegExp) => app.windows().find((w) => re.test(w.url()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const monkeytype = find(/monkeytype\.com/);
    const coach = find(/coach[\/]index\.html/);
    if (monkeytype && coach) return { app, monkeytype, coach, userData };
    await new Promise((r) => setTimeout(r, 200));
  }
  await app.close();
  throw new Error('Timed out waiting for the Monkeytype and coach windows');
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

/** Picks the "words" mode with n words through the test config bar, then focuses the typing area. */
export async function selectWordsMode(page: Page, n: number): Promise<void> {
  const config = page.locator(SEL.testConfig);
  await config.locator('button').filter({ hasText: new RegExp(`^${LABEL.wordsMode}$`) }).click();
  await config.locator('button:visible').filter({ hasText: new RegExp(`^${n}$`) }).click();
  await expect(page.locator(SEL.testMode)).toHaveText(new RegExp(`^words ${n} `));
  await page.waitForTimeout(1200); // the restart animation ignores clicks
  // A click does not take OS focus, but it focuses Monkeytype's hidden input.
  await page.click(SEL.wordsWrapper);
  await expect(page.locator(SEL.wordsInput)).toBeFocused();
}

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

/**
 * Plays one 100-word standard test with slow `e` and `o` and three uncorrected errors on the most
 * common other letter, and waits for the result screen. 100 words (not fewer) so a few bigrams
 * reach the minimum attempts.
 */
export async function playSlowLetterTest(page: Page): Promise<{ words: string[]; slow: string[]; errorLetter: string }> {
  await selectWordsMode(page, 100);
  const words = await readWords(page);
  expect(words).toHaveLength(100);

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

  await typeWords(page, words, { baseDelay: 70, slowLetters: slow.join(''), slowDelay: 450, errors });
  await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
  return { words, slow, errorLetter };
}
