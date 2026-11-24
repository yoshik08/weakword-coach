import { expect, test } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { SEL } from '../../src/preload/selectors';
import { dismissCookies, launchApp, readWords, selectWordsMode, typeWords, type TypeOptions } from './helpers';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('captures every keystroke of a words 25 test into SQLite', async () => {
  test.setTimeout(150_000);
  const { app, monkeytype: page, userData } = await launchApp();
  try {
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator(SEL.words)).toBeAttached({ timeout: 45_000 });
    await dismissCookies(page);
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

    // Slow letters: 'e' and 'o' if the words have them (they almost always do).
    const letters = [...words.join('')];
    const slowLetters = ['e', 'o'].filter((l) => letters.includes(l)).join('') || 'a';

    // Deliberate errors at ordinary (not slow) letters in three words, one corrected with Backspace.
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
          await page.screenshot({ path: 'docs/screenshots/02-mid-test.png' });
        }
      },
    });

    await expect(page.locator(SEL.result)).toBeAttached({ timeout: 20_000 });
    await page.waitForTimeout(800); // let the result fade in for the screenshot
    await page.screenshot({ path: 'docs/screenshots/02-result.png' });

    // The main process stores the test shortly after the result appears.
    const dbFile = path.join(userData, 'weakword.db');
    const db = new Database(dbFile, { readonly: true });
    try {
      await expect.poll(() => (db.prepare('SELECT count(*) AS n FROM tests').get() as { n: number }).n).toBe(1);

      const tests = db.prepare('SELECT * FROM tests').all() as Record<string, unknown>[];
      expect(tests[0]).toMatchObject({ source: 'standard', mode: 'words 25', language: 'english', practice_id: null });
      expect(tests[0].wpm as number).toBeGreaterThan(0);
      expect(tests[0].accuracy as number).toBeGreaterThan(50);
      expect(tests[0].accuracy as number).toBeLessThan(100);
      const id = tests[0].id as number;

      const stored = db.prepare('SELECT word FROM words WHERE test_id = ? ORDER BY word_index').all(id) as { word: string }[];
      expect(stored.map((w) => w.word)).toEqual(words);

      const ks = db
        .prepare('SELECT seq, t, key, expected, correct, word_index FROM keystrokes WHERE test_id = ? ORDER BY seq')
        .all(id) as { seq: number; t: number; key: string; expected: string | null; correct: number; word_index: number }[];
      // Exactly the keys we typed (the abandoned attempt is not in there), in order.
      expect(ks.map((k) => k.key)).toEqual(typed);
      expect(ks.map((k) => k.seq)).toEqual(ks.map((_, i) => i));
      expect(ks[0].t).toBe(0);

      // Deliberate errors: right word, right expected char, flagged incorrect.
      for (const e of errors) {
        const hit = ks.find((k) => k.word_index === e.word && k.key === e.typed && k.expected === words[e.word][e.char]);
        expect(hit, `error in word ${e.word} char ${e.char}`).toBeDefined();
        expect(hit!.correct).toBe(0);
      }
      expect(ks.filter((k) => k.key === 'Backspace')).toHaveLength(1);
      // Everything else was typed correctly.
      const wrong = ks.filter((k) => !k.correct && k.key !== 'Backspace');
      expect(wrong).toHaveLength(errors.length);
      // Space after a word is expected exactly at the word end.
      const space = ks.find((k) => k.key === ' ' && k.word_index === 0)!;
      expect(space).toMatchObject({ expected: ' ', correct: 1 });

      // Slow letters take clearly longer to reach than the rest.
      const gaps = ks.slice(1).map((k, i) => ({ key: k.key, gap: k.t - ks[i].t }));
      const slow = gaps.filter((g) => slowLetters.includes(g.key)).map((g) => g.gap);
      const rest = gaps.filter((g) => !slowLetters.includes(g.key) && g.key !== 'Backspace').map((g) => g.gap);
      console.log(`slow letters "${slowLetters}": ${mean(slow).toFixed(0)} ms (n=${slow.length}), others: ${mean(rest).toFixed(0)} ms (n=${rest.length}), keys ${ks.length}`);
      expect(slow.length).toBeGreaterThan(5);
      expect(mean(slow)).toBeGreaterThan(mean(rest) * 2);
    } finally {
      db.close();
    }
  } finally {
    await app.close();
  }
});
