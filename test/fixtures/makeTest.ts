import type { Keystroke, StoredTest, TestSource } from '../../src/shared/types';

/** A wrong key typed at word[pos]. */
export interface KeyError {
  word: number;
  pos: number;
  /** Press Backspace and retype the right key (default). false leaves the mistake in the word. */
  fix?: boolean;
}

/** The gap before the keystroke at word[pos] becomes `ms` (pos === word.length is the Space). */
export interface Pause {
  word: number;
  pos: number;
  ms: number;
}

export interface MakeTestOptions {
  id?: number;
  source?: TestSource;
  endedAt?: number;
  wpm?: number | null;
  /** Default gap before each keystroke. */
  msPerKey?: number;
  /** Gap before a given (lowercase) expected letter, overriding msPerKey. */
  slow?: Record<string, number>;
  errors?: KeyError[];
  pauses?: Pause[];
}

/** Builds a test whose keystrokes look exactly like the recorder's: no Space after the last word. */
export function makeTest(words: string[], o: MakeTestOptions = {}): StoredTest {
  const { id = 1, source = 'standard', endedAt = id * 1000, wpm = 50, msPerKey = 100, slow = {}, errors = [], pauses = [] } = o;
  const keystrokes: Keystroke[] = [];
  let t = 0;
  const press = (key: string, expected: string | null, wordIndex: number, gap: number) => {
    if (keystrokes.length > 0) t += gap;
    keystrokes.push({ seq: keystrokes.length, t, key, expected, correct: key === expected, wordIndex });
  };

  words.forEach((word, w) => {
    const gapAt = (pos: number, fallback: number) => pauses.find((p) => p.word === w && p.pos === pos)?.ms ?? fallback;
    [...word].forEach((ch, pos) => {
      const gap = gapAt(pos, slow[ch.toLowerCase()] ?? msPerKey);
      const err = errors.find((e) => e.word === w && e.pos === pos);
      if (!err) return press(ch, ch, w, gap);
      press('#', ch, w, gap);
      if (err.fix !== false) {
        press('Backspace', null, w, msPerKey);
        press(ch, ch, w, msPerKey);
      }
    });
    if (w < words.length - 1) press(' ', ' ', w, gapAt(word.length, msPerKey));
  });

  return {
    id,
    source,
    practiceId: null,
    startedAt: 0,
    endedAt,
    mode: 'words 25',
    language: 'english',
    words,
    keystrokes,
    result: { wpm, raw: null, accuracy: null, consistency: null },
  };
}
