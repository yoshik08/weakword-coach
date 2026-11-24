import { describe, expect, it } from 'vitest';
import { analyze, deriveTargetWpm, PAUSE_MS } from '../../src/shared/analysis';
import type { Analysis, ItemStat, StoredTest } from '../../src/shared/types';
import { makeTest } from '../fixtures/makeTest';

// 60 wpm => 12000 / 60 = 200 ms per char. An untimed item counts as 2 * 200 = 400 ms.
const TARGET = 60;
const UNTIMED = 400;
const loose = { targetWpm: TARGET, minKeyAttempts: 1, minBigramAttempts: 1, minWordAttempts: 1 };
const find = (list: ItemStat[], item: string) => {
  const stat = list.find((s) => s.item === item);
  if (!stat) throw new Error(`missing ${item} in ${list.map((s) => s.item).join(',')}`);
  return stat;
};
const run = (tests: StoredTest[], opts = {}) => analyze(tests, 'standard', { ...loose, ...opts });

describe('key timing', () => {
  it('uses the median of timed samples (odd and even counts)', () => {
    const e = (ms: number[]) => ms.map((slowE, i) => makeTest(['tea'], { id: i + 1, slow: { e: slowE } }));
    expect(find(run(e([100, 200, 900])).keys, 'e').msPerChar).toBe(200); // the mean would be 400
    expect(find(run(e([100, 200, 900, 300])).keys, 'e').msPerChar).toBe(250);
  });

  it('computes wpm, confidence and weakness from msPerChar', () => {
    const e = find(run([makeTest(['tea'], { slow: { e: 300 } })]).keys, 'e');
    expect(e).toMatchObject({ attempts: 1, errors: 0, errorRate: 0, msPerChar: 300, wpm: 40 });
    expect(e.weakness).toBeCloseTo(1.5);
    expect(e.confidence).toBeCloseTo(1 / 1.5);
  });

  it('does not time the first key of a test', () => {
    const keys = run([makeTest(['ab'])]).keys;
    expect(find(keys, 'a').msPerChar).toBe(UNTIMED);
    expect(find(keys, 'b').msPerChar).toBe(100);
  });

  it('times the first letter after a Space', () => {
    const a = find(run([makeTest(['ab', 'ab'], { slow: { a: 150 } })]).keys, 'a');
    expect(a.attempts).toBe(2);
    expect(a.msPerChar).toBe(150); // only the second a is timed, over the Space gap
  });

  it('does not time the key after a corrected mistake or the Backspace before it', () => {
    const keys = run([makeTest(['abc'], { errors: [{ word: 0, pos: 1 }] })]).keys;
    expect(find(keys, 'a').msPerChar).toBe(UNTIMED); // first key
    const b = find(keys, 'b'); // wrong key + retyped key, neither timed
    expect(b).toMatchObject({ attempts: 2, errors: 1, errorRate: 0.5, msPerChar: UNTIMED });
    expect(b.weakness).toBeCloseTo(2 * (1 + 4 * 0.5));
    expect(find(keys, 'c').msPerChar).toBe(100); // after the correct retype
  });

  it('does not time the key after an uncorrected mistake', () => {
    const keys = run([makeTest(['abc'], { errors: [{ word: 0, pos: 1, fix: false }] })]).keys;
    expect(find(keys, 'b')).toMatchObject({ attempts: 1, errors: 1, errorRate: 1 });
    expect(find(keys, 'c').msPerChar).toBe(UNTIMED);
  });

  it('does not time keys after a pause, but keeps the PAUSE_MS boundary inclusive', () => {
    const b = (ms: number) => find(run([makeTest(['abc'], { pauses: [{ word: 0, pos: 1, ms }] })]).keys, 'b');
    expect(PAUSE_MS).toBe(2000);
    expect(b(3000).msPerChar).toBe(UNTIMED);
    expect(b(2001).msPerChar).toBe(UNTIMED);
    expect(b(2000).msPerChar).toBe(2000);
    expect(find(run([makeTest(['abc'], { pauses: [{ word: 0, pos: 1, ms: 3000 }] })]).keys, 'c').msPerChar).toBe(100);
  });
});

describe('bigrams', () => {
  it('only form inside a word, never across the Space', () => {
    const bigrams = run([makeTest(['ab', 'ab'])]).bigrams;
    expect(bigrams.map((b) => b.item)).toEqual(['ab']);
    expect(bigrams[0]).toMatchObject({ attempts: 2, errors: 0, msPerChar: 100 });
  });

  it('count a wrong second key as an error and skip pairs that start on a mistake or Backspace', () => {
    const bigrams = run([makeTest(['abc'], { errors: [{ word: 0, pos: 1 }] })]).bigrams;
    expect(bigrams.map((b) => b.item).sort()).toEqual(['ab', 'bc']);
    const ab = find(bigrams, 'ab');
    expect(ab).toMatchObject({ attempts: 1, errors: 1, errorRate: 1, msPerChar: UNTIMED });
    expect(ab.weakness).toBeCloseTo(10); // (400 / 200) * (1 + 4)
    expect(find(bigrams, 'bc').msPerChar).toBe(100);
  });

  it('skip the pair after an uncorrected mistake', () => {
    const bigrams = run([makeTest(['abcd'], { errors: [{ word: 0, pos: 1, fix: false }] })]).bigrams;
    expect(bigrams.map((b) => b.item).sort()).toEqual(['ab', 'cd']);
  });
});

describe('words', () => {
  const hw = ['hello', 'world'];

  it('time the first word of a test from its first key and later words from the previous Space', () => {
    const words = run([makeTest(hw, { slow: { w: 300 } })]).words;
    expect(find(words, 'hello').msPerChar).toBe(100); // (400 - 0) / 4
    expect(find(words, 'world').msPerChar).toBe(140); // (1200 - 500) / 5
    expect(find(words, 'world').wpm).toBeCloseTo(12000 / 140);
    expect(words.map((w) => w.item)).toEqual(['world', 'hello']); // weakest first
  });

  it('measure errors per letter typed, counting Backspace retries but not Backspace or the Space', () => {
    const world = find(run([makeTest(hw, { errors: [{ word: 1, pos: 2 }] })]).words, 'world');
    expect(world.attempts).toBe(1);
    expect(world.errors).toBe(1);
    expect(world.errorRate).toBeCloseTo(1 / 6); // w o # r l d
    expect(world.msPerChar).toBe(140); // retry time counts against the word
    expect(world.weakness).toBeCloseTo((140 / 200) * (1 + 4 / 6));
  });

  it('skip timing but keep the attempt when a gap inside the word is a pause', () => {
    const mid = find(run([makeTest(hw, { pauses: [{ word: 1, pos: 2, ms: 3000 }] })]).words, 'world');
    expect(mid).toMatchObject({ attempts: 1, errors: 0, msPerChar: UNTIMED });
    const start = find(run([makeTest(hw, { pauses: [{ word: 1, pos: 0, ms: 2500 }] })]).words, 'world');
    expect(start).toMatchObject({ attempts: 1, msPerChar: UNTIMED });
    expect(find(run([makeTest(hw, { pauses: [{ word: 1, pos: 0, ms: 2500 }] })]).words, 'hello').msPerChar).toBe(100);
  });

  it('use the median of per-occurrence timings', () => {
    const t = makeTest(['hello', 'hello', 'hello'], { pauses: [{ word: 1, pos: 0, ms: 600 }] });
    const hello = find(run([t]).words, 'hello');
    expect(hello.attempts).toBe(3);
    expect(hello.msPerChar).toBe(100); // samples 100, 200, 100
  });

  it('ignore words shorter than 3 letters', () => {
    const words = run([makeTest(['it', 'hello'])]).words;
    expect(words.map((w) => w.item)).toEqual(['hello']);
    expect(words[0].msPerChar).toBe(100); // (700 - 200) / 5
  });
});

describe('minimum attempts', () => {
  it('keeps rare items in allKeys but out of keys, bigrams and words', () => {
    const a = analyze([makeTest(['tea', 'tea'])], 'standard', { targetWpm: TARGET });
    expect(a.keys).toEqual([]); // 2 attempts < 10
    expect(a.bigrams).toEqual([]); // 2 attempts < 6
    expect(a.allKeys.map((k) => k.item).sort()).toEqual(['a', 'e', 't']);
    expect(a.words.map((w) => w.item)).toEqual(['tea']); // 2 occurrences >= 2
    expect(analyze([makeTest(['tea'])], 'standard', { targetWpm: TARGET }).words).toEqual([]);
  });

  it('honours custom minimums', () => {
    const tests = [makeTest(['tea', 'tea'])];
    expect(analyze(tests, 'standard', { targetWpm: TARGET, minKeyAttempts: 2 }).keys).toHaveLength(3);
    expect(analyze(tests, 'standard', { targetWpm: TARGET, minBigramAttempts: 2 }).bigrams).toHaveLength(2);
    expect(analyze(tests, 'standard', { targetWpm: TARGET, minWordAttempts: 3 }).words).toEqual([]);
  });
});

describe('ranking', () => {
  // e: slow (400 ms) but always right.  a: faster (150 ms) but wrong every other press.
  const slowAccurate = makeTest(Array(6).fill('ee'), { id: 1, slow: { e: 400 } });
  const fastSloppy = makeTest(Array(6).fill('aa'), {
    id: 2,
    slow: { a: 150 },
    errors: Array.from({ length: 6 }, (_, word) => ({ word, pos: 1, fix: false })),
  });

  it('mixes slowness and errors, with hand-computed weakness', () => {
    const { keys } = run([slowAccurate, fastSloppy], { minKeyAttempts: 10 });
    const e = find(keys, 'e');
    const a = find(keys, 'a');
    expect(e).toMatchObject({ attempts: 12, errors: 0, msPerChar: 400 });
    expect(e.weakness).toBeCloseTo(2); // 400/200 * (1 + 0)
    expect(a).toMatchObject({ attempts: 12, errors: 6, errorRate: 0.5, msPerChar: 150, wpm: 80 });
    expect(a.weakness).toBeCloseTo(2.25); // 150/200 * (1 + 4 * 0.5)
    expect(a.confidence).toBeCloseTo(1 / 2.25);
    expect(a.msPerChar).toBeLessThan(e.msPerChar);
    expect(keys.map((k) => k.item)).toEqual(['a', 'e']); // the faster key is weaker
  });

  it('breaks weakness ties by attempts (desc), then item (asc)', () => {
    expect(run([makeTest(['aa', 'bbb'])]).keys.map((k) => k.item)).toEqual(['b', 'a']);
    expect(run([makeTest(['bb', 'aa'])]).keys.map((k) => k.item)).toEqual(['a', 'b']);
  });
});

describe('test selection', () => {
  const t1 = makeTest(['tea'], { id: 1, endedAt: 1000, slow: { e: 100 } });
  const t2 = makeTest(['tea'], { id: 2, endedAt: 2000, slow: { e: 200 } });
  const t3 = makeTest(['tea'], { id: 3, endedAt: 3000, slow: { e: 300 } });
  const practice = makeTest(['tea'], { id: 4, endedAt: 4000, source: 'practice', slow: { e: 999 } });
  const shuffled = [t2, practice, t1, t3];

  it('filters by source', () => {
    const std = analyze(shuffled, 'standard', loose);
    expect(std).toMatchObject({ source: 'standard', targetWpm: TARGET, testCount: 3 });
    expect(find(std.keys, 'e').msPerChar).toBe(200);
    const pr = analyze(shuffled, 'practice', loose);
    expect(pr.source).toBe('practice');
    expect(pr.testCount).toBe(1);
    expect(find(pr.keys, 'e').msPerChar).toBe(999);
  });

  it('uses only the newest maxTests by endedAt, whatever the input order', () => {
    const a = analyze(shuffled, 'standard', { ...loose, maxTests: 2 });
    expect(a.testCount).toBe(2);
    expect(find(a.keys, 'e').msPerChar).toBe(250); // t2 and t3
  });
});

describe('deriveTargetWpm', () => {
  const withWpm = (wpms: (number | null)[]) => wpms.map((wpm, i) => makeTest(['a'], { id: i + 1, endedAt: i + 1, wpm }));

  it('takes the median of the newest 10 and rounds it', () => {
    expect(deriveTargetWpm(withWpm([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]))).toBe(75); // drops 10 and 20
    expect(deriveTargetWpm(withWpm([62, 63]))).toBe(63); // 62.5 rounds up
    expect(deriveTargetWpm(withWpm([50]))).toBe(50);
  });

  it('skips tests without a wpm', () => {
    const tests = withWpm([1, ...Array(10).fill(100), null, null]);
    expect(deriveTargetWpm(tests)).toBe(100);
  });

  it('falls back to 40 and clamps to 20..250', () => {
    expect(deriveTargetWpm([])).toBe(40);
    expect(deriveTargetWpm(withWpm([null, null]))).toBe(40);
    expect(deriveTargetWpm(withWpm([5]))).toBe(20);
    expect(deriveTargetWpm(withWpm([400]))).toBe(250);
  });
});

describe('edge cases', () => {
  it('groups case-insensitively and only forms keys for letters', () => {
    const a = run([makeTest(['Tea', 'tea'])]);
    expect(a.allKeys.map((k) => k.item).sort()).toEqual(['a', 'e', 't']);
    expect(find(a.allKeys, 't').attempts).toBe(2);
    expect(a.bigrams.map((b) => b.item).sort()).toEqual(['ea', 'te']);
    expect(a.words.map((w) => w.item)).toEqual(['tea']);
    expect(a.words[0].attempts).toBe(2);
  });

  it('ignores digits, punctuation and spaces as keys and bigrams', () => {
    const a = run([makeTest(['a1b', 'c-d.'])]);
    expect(a.allKeys.map((k) => k.item).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(a.bigrams).toEqual([]);
  });

  it('is deterministic and independent of input order', () => {
    const tests = [
      makeTest(['hello', 'world', 'tea'], { id: 1, endedAt: 1, errors: [{ word: 1, pos: 2 }] }),
      makeTest(['tea', 'hello'], { id: 2, endedAt: 2, slow: { e: 250 } }),
      makeTest(['world'], { id: 3, endedAt: 3, source: 'practice' }),
    ];
    const first = run(tests);
    expect(run(tests)).toEqual(first);
    expect(run([...tests].reverse())).toEqual(first);
  });

  it('returns empty lists for no input, with no NaN anywhere', () => {
    const a = analyze([], 'standard', { targetWpm: TARGET });
    expect(a).toEqual({ source: 'standard', targetWpm: TARGET, testCount: 0, keys: [], bigrams: [], words: [], allKeys: [] });
    expect(analyze([makeTest(['a'], { source: 'practice' })], 'standard', { targetWpm: TARGET }).testCount).toBe(0);
  });

  it('produces only finite numbers, even for untimed items', () => {
    const a = run([makeTest(['abc', 'hello'], { errors: [{ word: 0, pos: 1, fix: false }], pauses: [{ word: 1, pos: 1, ms: 5000 }] })]);
    const nums: number[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'number') nums.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(a as Analysis);
    expect(nums.length).toBeGreaterThan(0);
    expect(nums.every(Number.isFinite)).toBe(true);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});
