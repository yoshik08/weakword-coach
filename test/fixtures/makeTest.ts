import type { CapturedTest, Keystroke, StoredTest, TestKind } from '../../src/shared/types';

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
  kind?: TestKind;
  endedAt?: number;
  wpm?: number | null;
  accuracy?: number | null;
  /** Default gap before each keystroke. */
  msPerKey?: number;
  /** Gap before a given (lowercase) expected letter, overriding msPerKey. */
  slow?: Record<string, number>;
  /** Gap before the second letter of a pair, e.g. { th: 300 }. */
  slowPairs?: Record<string, number>;
  errors?: KeyError[];
  pauses?: Pause[];
  /** Record caret positions like the current recorder (default) or leave them out like 0.1.x did. */
  withPos?: boolean;
  mode?: string;
  language?: string;
}

/** Builds a test whose keystrokes look exactly like the recorder's: no Space after the last word. */
export function makeTest(words: string[], o: MakeTestOptions = {}): StoredTest {
  const { id = 1, kind = 'normal', endedAt = id * 1000, wpm = 50, accuracy = 97, msPerKey = 100, slow = {}, slowPairs = {}, errors = [], pauses = [], withPos = true } = o;
  const keystrokes: Keystroke[] = [];
  let t = 0;
  const press = (key: string, expected: string | null, wordIndex: number, pos: number, gap: number) => {
    if (keystrokes.length > 0) t += gap;
    keystrokes.push({ seq: keystrokes.length, t, key, expected, correct: key === expected, wordIndex, ...(withPos ? { pos, flags: 0 } : {}) });
  };

  words.forEach((word, w) => {
    const gapAt = (pos: number, fallback: number) => pauses.find((p) => p.word === w && p.pos === pos)?.ms ?? fallback;
    let caret = 0;
    [...word].forEach((ch, pos) => {
      const pair = pos > 0 ? (word[pos - 1] + ch).toLowerCase() : '';
      const gap = gapAt(pos, slowPairs[pair] ?? slow[ch.toLowerCase()] ?? msPerKey);
      const err = errors.find((e) => e.word === w && e.pos === pos);
      if (!err) return press(ch, ch, w, caret++, gap);
      press('#', ch, w, caret++, gap);
      if (err.fix !== false) {
        press('Backspace', null, w, caret--, msPerKey);
        press(ch, ch, w, caret++, msPerKey);
      }
    });
    if (w < words.length - 1) press(' ', ' ', w, caret, gapAt(word.length, msPerKey));
  });

  return {
    id,
    source: kind === 'drill' ? 'practice' : 'standard',
    kind,
    eligible: kind === 'normal',
    ineligibleReason: null,
    profileKey: null,
    layout: null,
    corpusVersion: null,
    promptId: null,
    sessionId: null,
    practiceId: null,
    startedAt: endedAt - 10_000,
    endedAt,
    mode: o.mode ?? 'words 25',
    language: o.language ?? 'english',
    words,
    keystrokes,
    result: { wpm, raw: null, accuracy, consistency: null },
  };
}

/** The captured (not yet stored) form, as the Monkeytype preload sends it. */
export function captured(words: string[], o: MakeTestOptions & { clientId?: string; testType?: string[]; other?: string[]; qwerty?: boolean } = {}): CapturedTest {
  const s = makeTest(words, o);
  const qwerty = 'qwertyuiopasdfghjklzxcvbnm';
  const codes: Record<string, string> = {};
  if (o.qwerty !== false) for (const ch of qwerty) codes[ch] = `Key${ch.toUpperCase()}`;
  const [m, m2] = s.mode.split(' ');
  return {
    clientId: o.clientId ?? `test-client-${o.id ?? 1}-${Math.random().toString(36).slice(2)}`,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    mode: s.mode,
    language: s.language,
    words: s.words,
    keystrokes: s.keystrokes,
    result: s.result,
    record: { testType: o.testType ?? (m === 'custom' ? ['custom'] : [`${m} ${m2}`, s.language ?? 'english']), other: o.other ?? [] },
    settings: { layout: 'default', confidenceMode: 'off' },
    keyCodes: codes,
  };
}

/** Some ordinary English words, enough for realistic letter, pair and word counts. */
export const COMMON = [
  'the', 'be', 'of', 'and', 'a', 'to', 'in', 'he', 'have', 'it', 'that', 'for', 'they', 'with', 'as', 'not', 'on', 'she',
  'at', 'by', 'this', 'we', 'you', 'do', 'but', 'from', 'or', 'which', 'one', 'would', 'all', 'will', 'there', 'say', 'who',
  'make', 'when', 'can', 'more', 'if', 'no', 'man', 'out', 'other', 'so', 'what', 'time', 'up', 'go', 'about', 'than',
  'into', 'could', 'state', 'only', 'new', 'year', 'some', 'take', 'come', 'these', 'know', 'see', 'use', 'get', 'like',
  'then', 'first', 'any', 'work', 'now', 'may', 'such', 'give', 'over', 'think', 'most', 'even', 'find', 'day', 'also',
  'after', 'way', 'many', 'must', 'look', 'before', 'great', 'back', 'through', 'long', 'where', 'much', 'should', 'well',
  'people', 'down', 'own', 'just', 'because', 'good', 'each', 'those', 'feel', 'seem', 'how', 'high', 'too', 'place',
  'little', 'world', 'very', 'still', 'nation', 'hand', 'old', 'life', 'tell', 'write', 'become', 'here', 'show', 'house',
  'both', 'between', 'need', 'mean', 'call', 'develop', 'under', 'last', 'right', 'move', 'thing', 'general', 'school',
  'never', 'same', 'another', 'begin', 'while', 'number', 'part', 'turn', 'real', 'leave', 'might', 'want', 'point', 'form',
  'off', 'child', 'few', 'small', 'since', 'against', 'ask', 'late', 'home', 'interest', 'large', 'person', 'end', 'open',
  'public', 'follow', 'during', 'present', 'without', 'again', 'hold', 'govern', 'around', 'possible', 'head', 'consider',
  'word', 'program', 'problem', 'however', 'lead', 'system', 'set', 'order', 'eye', 'plan', 'run', 'keep', 'face', 'fact',
  'group', 'play', 'stand', 'increase', 'early', 'course', 'change', 'help', 'line',
];
