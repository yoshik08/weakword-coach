import { describe, expect, it } from 'vitest';
import { generatePractice, pickFocusKeys, type GenerateOptions } from '../../src/shared/generator';
import type { Analysis, ItemStat } from '../../src/shared/types';

/** A stat whose weakness is given; confidence is its reciprocal (so weakness > 1 means "weak"). */
const stat = (item: string, weakness: number): ItemStat => ({
  item,
  attempts: 50,
  errors: 0,
  errorRate: 0,
  msPerChar: weakness * 200,
  wpm: 12000 / (weakness * 200),
  confidence: 1 / weakness,
  weakness,
});

const analysisOf = (keys: ItemStat[], bigrams: ItemStat[] = [], words: ItemStat[] = []): Analysis => ({
  source: 'standard',
  targetWpm: 60,
  testCount: 10,
  keys,
  bigrams,
  words,
  allKeys: keys,
});

const analysis = analysisOf(
  [stat('z', 3), stat('q', 2.5), stat('j', 2.2), stat('x', 1.8), stat('k', 1.3), stat('e', 0.8)],
  [stat('th', 2.5), stat('ck', 2), stat('ng', 1.8), stat('st', 1.5), stat('ou', 1.2), stat('er', 0.7)],
  [stat('quiz', 2.8), stat('cat', 2), stat('jazz', 1.9), stat('the', 1.6), stat('mix', 1.4), stat('and', 0.6)],
);
const FOCUS_KEYS = ['z', 'q', 'j', 'x'];
const FOCUS_BIGRAMS = ['th', 'ck', 'ng', 'st'];

// Synthetic pool: every pair of syllables, so z/x words are equally frequent and spread evenly over the ranks.
const SYLLABLES = ['za', 'xe', 'qu', 'jo', 'th', 'ck', 'ng', 'st', 'ra', 'mi', 'lo', 'pe'];
const bigList = SYLLABLES.flatMap((a) => SYLLABLES.map((b) => a + b));
const commonWords = ['the', 'this', 'that', 'just', 'quick', 'back', 'long', 'strong', 'fox', 'and', 'of', 'cat', 'a', 'I'];

const opts = (over: Partial<GenerateOptions> = {}): GenerateOptions => ({ analysis, wordList: bigList, commonWords, ...over });
const hasFocus = (w: string) => [...FOCUS_KEYS, ...FOCUS_BIGRAMS].some((f) => w.includes(f));

describe('focus selection', () => {
  it('picks up to 4 weak keys, 4 weak bigrams and 3 weak words that contain a focus item', () => {
    const plan = generatePractice(opts());
    expect(plan.focusKeys).toEqual(FOCUS_KEYS); // k is weak too but is the 5th
    expect(plan.focusBigrams).toEqual(FOCUS_BIGRAMS);
    expect(plan.focusWords).toEqual(['quiz', 'jazz', 'the']); // cat has no focus item, mix is 4th
    expect(plan.seed).toBe(1);
  });

  it('only uses items with confidence < 1', () => {
    const a = analysisOf([stat('z', 2), stat('q', 1.5), stat('j', 1.1), stat('e', 0.8)], [stat('th', 2), stat('er', 0.9)]);
    const plan = generatePractice(opts({ analysis: a }));
    expect(plan.focusKeys).toEqual(['z', 'q', 'j']);
    expect(plan.focusBigrams).toEqual(['th']);
  });

  it('falls back to the 2 weakest keys when fewer than 2 qualify', () => {
    const none = analysisOf([stat('z', 0.95), stat('q', 0.9), stat('j', 0.8)]);
    expect(generatePractice(opts({ analysis: none })).focusKeys).toEqual(['z', 'q']);
    const one = analysisOf([stat('z', 2), stat('q', 0.9), stat('j', 0.8)]);
    expect(generatePractice(opts({ analysis: one })).focusKeys).toEqual(['z', 'q']);
  });

  it('pickFocusKeys applies the same rule', () => {
    expect(pickFocusKeys(analysis)).toEqual(FOCUS_KEYS);
    expect(pickFocusKeys(analysisOf([stat('z', 0.95), stat('q', 0.9), stat('j', 0.8)]))).toEqual(['z', 'q']);
    expect(pickFocusKeys(analysisOf([]))).toEqual([]);
  });

  it('works with bigrams only', () => {
    const plan = generatePractice(opts({ analysis: analysisOf([], [stat('th', 2)]) }));
    expect(plan.focusKeys).toEqual([]);
    expect(plan.focusBigrams).toEqual(['th']);
    expect(plan.words.every((w) => w.includes('th'))).toBe(true);
  });

  it('throws when there is no data', () => {
    expect(() => generatePractice(opts({ analysis: analysisOf([]) }))).toThrow('Not enough data yet');
    expect(() => generatePractice(opts({ analysis: analysisOf([], [stat('th', 0.5)]) }))).toThrow('Not enough data yet');
  });
});

describe('composition', () => {
  it('every word contains a focus key or bigram', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const plan = generatePractice(opts({ seed }));
      expect(plan.words.every(hasFocus), `seed ${seed}: ${plan.words.join(' ')}`).toBe(true);
    }
  });

  it('returns exactly `length` words (default 30, custom 10 and 50)', () => {
    expect(generatePractice(opts()).words).toHaveLength(30);
    for (const length of [10, 50]) {
      const plan = generatePractice(opts({ length }));
      expect(plan.words).toHaveLength(length);
      expect(plan.words.every(hasFocus)).toBe(true);
    }
  });

  it('truncates very short lists, keeping coverage first', () => {
    const plan = generatePractice(opts({ length: 3 }));
    expect(plan.words).toHaveLength(3);
    expect(plan.words.every(hasFocus)).toBe(true);
  });

  it('includes the focus words', () => {
    const { words, focusWords } = generatePractice(opts());
    for (const w of focusWords) expect(words).toContain(w);
  });

  it('covers every focus key and bigram', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { words } = generatePractice(opts({ seed }));
      for (const item of [...FOCUS_KEYS, ...FOCUS_BIGRAMS]) {
        expect(
          words.some((w) => w.includes(item)),
          `seed ${seed} misses ${item}`,
        ).toBe(true);
      }
    }
  });

  it('includes round(length * normalShare) words from commonWords', () => {
    // The focus word 'the' is also a common word, so count it separately.
    const inCommon = (o: Partial<GenerateOptions>) => {
      const { words, focusWords } = generatePractice(opts(o));
      return words.filter((w) => commonWords.includes(w)).length - focusWords.filter((w) => commonWords.includes(w)).length;
    };
    expect(inCommon({})).toBe(8); // round(30 * 0.25) = 8 (7.5 rounds up)
    expect(inCommon({ length: 40, normalShare: 0.3 })).toBe(12);
    expect(inCommon({ normalShare: 0 })).toBe(0);
  });

  it('only draws normal words that contain a focus item', () => {
    const plan = generatePractice(opts({ normalShare: 0.5 }));
    expect(plan.words.filter((w) => commonWords.includes(w)).every(hasFocus)).toBe(true);
    expect(plan.words).not.toContain('and');
  });

  it('draws normal words from the candidates when no common word qualifies', () => {
    const plan = generatePractice(opts({ commonWords: ['and', 'of', 'cat'] }));
    expect(plan.words).toHaveLength(30);
    expect(plan.words.every(hasFocus)).toBe(true);
  });

  it('never uses a word outside the word lists (focus words aside)', () => {
    const plan = generatePractice(opts({ seed: 7 }));
    const allowed = new Set([...bigList, ...commonWords, ...plan.focusWords]);
    expect(plan.words.every((w) => allowed.has(w))).toBe(true);
  });

  it('normalises candidates: lowercase, letters only, length 2..10, de-duplicated', () => {
    const wordList = ['ZAP', 'zap', "zap's", 'z', 'zzzzzzzzzzz', 'z1p', 'zip', 'zoo'];
    const plan = generatePractice(opts({ wordList, commonWords: [], normalShare: 0 }));
    expect(new Set(plan.words)).toEqual(new Set(['zap', 'zip', 'zoo', ...plan.focusWords]));
  });
});

describe('weighting', () => {
  it('uses the weakest focus key more often than the 4th', () => {
    const a = analysisOf([stat('z', 3), stat('q', 2.5), stat('j', 2.2), stat('x', 1.8)]);
    let z = 0;
    let x = 0;
    for (let seed = 1; seed <= 200; seed++) {
      for (const w of generatePractice(opts({ analysis: a, seed, normalShare: 0 })).words) {
        if (w.includes('z')) z++;
        if (w.includes('x')) x++;
      }
    }
    expect(z).toBeGreaterThan(x);
  });
});

describe('repeats and ordering', () => {
  it('never repeats a word more than twice when the pool is big', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const { words } = generatePractice(opts({ seed, length: 50 }));
      const counts = new Map<string, number>();
      for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
      expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    }
  });

  it('has no identical adjacent words when the pool is big', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { words } = generatePractice(opts({ seed, length: 50 }));
      words.forEach((w, i) => i > 0 && expect(w, `seed ${seed} index ${i}`).not.toBe(words[i - 1]));
    }
  });

  it('still returns exactly `length` words from a tiny pool', () => {
    const plan = generatePractice(opts({ wordList: ['zip', 'zoo'], commonWords: ['zebra'], length: 30 }));
    expect(plan.words).toHaveLength(30);
    expect(plan.words.every(hasFocus)).toBe(true);
  });
});

describe('determinism', () => {
  it('same options and seed give identical output', () => {
    expect(generatePractice(opts({ seed: 42 }))).toEqual(generatePractice(opts({ seed: 42 })));
  });

  it('different seeds give different words', () => {
    const a = generatePractice(opts({ seed: 1 }));
    const b = generatePractice(opts({ seed: 2 }));
    expect(a.words).not.toEqual(b.words);
    expect(b.seed).toBe(2);
  });
});
