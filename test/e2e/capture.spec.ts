import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { launchApp, readWords, ready, selectWordsMode, typeWords, type TypeOptions } from './helpers';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('captures every keystroke of a words 25 test into SQLite, once', async () => {
  test.setTimeout(200_000);
  const { app, monkeytype: page, userData } = await launchApp();
  try {
    await ready(page);
    await selectWordsMode(page, 25);

    // An abandoned attempt: a few keys, then restart with Tab, Enter. It must not be stored.
    const firstWords = await readWords(page);
    await page.keyboard.type(firstWords[0].slice(0, 3) + 'x');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await readWords(page)).join(' '), { timeout: 10_000 }).not.toBe(firstWords.join(' '));
    await page.waitForTimeout(1200);
    await page.click(SEL.wordsWrapper);
    await expect(page.locator(SEL.wordsInput)).toBeFocused();

    const words = await readWords(page);
    expect(words).toHaveLength(25);
    const letters = [...words.join('')];
    const slowLetters = ['e', 'o'].filter((l) => letters.includes(l)).join('') || 'a';

    // Deliberate errors at ordinary letters in three words, one corrected with Backspace.
    const pick = (fromWord: number, fix: boolean): NonNullable<TypeOptions['errors']>[number] => {
      for (let w = fromWord; w < 24; w++) {
        const c = [...words[w]].findIndex((ch, i) => i > 0 && !slowLetters.includes(ch) && ch !== 'q');
        if (c > 0) return { word: w, char: c, typed: 'q', fix };
      }
      throw new Error('no suitable word for a deliberate error');
    };
    const wrongA = pick(3, false);
    const wrongB = pick(wrongA.word + 4, false);
    const fixed = pick(wrongB.word + 4, true);
    const errors = [wrongA, wrongB, fixed];

    let midShot = false;
    const typed = await typeWords(page, words, {
      slowLetters,
      errors,
      onWord: async (w) => {
        if (w === 12 && !midShot) {
          midShot = true;
          await page.screenshot({ path: 'docs/screenshots/03-mid-test.png' });
        }
      },
    });
    await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });

    const dbFile = path.join(userData, 'weakword.db');
    const db = new Database(dbFile, { readonly: true });
    try {
      await expect.poll(() => (db.prepare('SELECT count(*) AS n FROM tests').get() as { n: number }).n).toBe(1);
      const [row] = db.prepare('SELECT * FROM tests').all() as Record<string, unknown>[];
      expect(row).toMatchObject({ source: 'standard', kind: 'normal', eligible: 1, mode: 'words 25', language: 'english', layout: 'qwerty', profile_key: 'words 25|english|||qwerty' });
      expect(JSON.parse(row.record as string)).toEqual({ testType: ['words 25', 'english'], other: [] });
      expect(row.client_id).toEqual(expect.any(String));
      expect(row.corpus_version).toMatch(/^[0-9a-f]{8}$/);
      expect(row.accuracy as number).toBeGreaterThan(50);
      expect(row.accuracy as number).toBeLessThan(100);
      const id = row.id as number;

      const stored = db.prepare('SELECT word FROM words WHERE test_id = ? ORDER BY word_index').all(id) as { word: string }[];
      expect(stored.map((w) => w.word)).toEqual(words);
      const ks = db.prepare('SELECT seq, t, key, expected, correct, word_index, pos, flags FROM keystrokes WHERE test_id = ? ORDER BY seq').all(id) as {
        seq: number; t: number; key: string; expected: string | null; correct: number; word_index: number; pos: number; flags: number;
      }[];
      expect(ks.map((k) => k.key)).toEqual(typed); // the abandoned attempt is not in there
      expect(ks[0].t).toBe(0);
      for (const e of errors) {
        const hit = ks.find((k) => k.word_index === e.word && k.key === e.typed && k.expected === words[e.word][e.char]);
        expect(hit, `error in word ${e.word} char ${e.char}`).toBeDefined();
        expect(hit!.correct).toBe(0);
        expect(hit!.pos).toBe(e.char);
      }
      expect(ks.filter((k) => k.key === 'Backspace')).toHaveLength(1);
      expect(ks.filter((k) => !k.correct && k.key !== 'Backspace')).toHaveLength(errors.length);
      expect(ks.find((k) => k.key === ' ' && k.word_index === 0)).toMatchObject({ expected: ' ', correct: 1, pos: words[0].length });
      expect(ks.every((k) => k.flags === 0)).toBe(true); // no repeats, blur or IME in a scripted run

      // Derived statistics are stored with the test.
      const stats = JSON.parse(row.stats as string) as { items: Record<string, { a: number; e: number }> };
      expect(stats.items['x:space'].a).toBe(24);

      // Slow letters take clearly longer to reach than the rest.
      const gaps = ks.slice(1).map((k, i) => ({ key: k.key, gap: k.t - ks[i].t }));
      const slow = gaps.filter((g) => slowLetters.includes(g.key)).map((g) => g.gap);
      const rest = gaps.filter((g) => !slowLetters.includes(g.key) && g.key !== 'Backspace').map((g) => g.gap);
      expect(mean(slow)).toBeGreaterThan(mean(rest) * 2);

      // Leaving the result and coming back cannot store it again.
      await page.locator(SEL.resultRestartButton).click();
      await expect(page.locator(SEL.result)).toHaveCount(0);
      await page.waitForTimeout(1500);
      expect((db.prepare('SELECT count(*) AS n FROM tests').get() as { n: number }).n).toBe(1);

      // "Repeat test" replays the same words: stored as its own attempt, never compared.
      await page.locator(SEL.wordsWrapper).click();
      const replay = await readWords(page);
      await typeWords(page, replay);
      await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
      await page.locator('[data-ui-element="restartTestButtonWithSameWordset"]').click();
      await expect(page.locator(SEL.result)).toHaveCount(0);
      await page.waitForTimeout(1200);
      await page.locator(SEL.wordsWrapper).click();
      expect(await readWords(page)).toEqual(replay);
      await typeWords(page, replay);
      await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
      await expect.poll(() => (db.prepare('SELECT count(*) AS n FROM tests').get() as { n: number }).n).toBe(3);
      const last = db.prepare('SELECT eligible, ineligible_reason FROM tests ORDER BY id DESC LIMIT 1').get() as { eligible: number; ineligible_reason: string };
      expect(last.eligible).toBe(0);
      console.log(`replayed words stored as: ${last.ineligible_reason}`);
      expect(last.ineligible_reason).toMatch(/repeated|same words/);
      await expect(page.locator('#wwc-row')).toHaveAttribute('data-kind', 'not-counted', { timeout: 10_000 });
    } finally {
      db.close();
    }
  } finally {
    await app.close();
  }
});
