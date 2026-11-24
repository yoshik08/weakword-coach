import { describe, expect, it } from 'vitest';
import { deriveStats, outcomeOn, reconstructPositions, reviewWords } from '../../src/shared/keystats';
import { KS_AFTER_ARTIFACT, KS_AFTER_BLUR, KS_REPEAT, type Keystroke } from '../../src/shared/types';
import { makeTest } from '../fixtures/makeTest';

const stats = (words: string[], o = {}) => deriveStats(makeTest(words, o));

describe('first attempts', () => {
  it('counts only the first try at each position, so a corrected miss stays a miss', () => {
    const s = stats(['abc'], { errors: [{ word: 0, pos: 1 }] });
    // b: wrong first, retyped after Backspace -> 1 attempt, 1 error (not 2 attempts, 1 error)
    expect(s.items['k:b']).toMatchObject({ a: 1, e: 1 });
    expect(s.items['k:a']).toMatchObject({ a: 1, e: 0 });
    expect(s.items['k:c']).toMatchObject({ a: 1, e: 0 });
    expect(s.firstTry).toEqual({ a: 3, e: 1 });
  });

  it('a fast key missed 27% of the time keeps its errors', () => {
    const words = Array.from({ length: 11 }, () => 'p');
    const s = stats(words, { errors: [{ word: 1, pos: 0 }, { word: 4, pos: 0 }, { word: 8, pos: 0 }] });
    expect(s.items['k:p'].a).toBe(11);
    expect(s.items['k:p'].e).toBe(3);
  });

  it('reconstructs caret positions for old data recorded without them', () => {
    const t = makeTest(['abc', 'de'], { errors: [{ word: 0, pos: 1 }] });
    const recorded = t.keystrokes.map((k) => (k.key === 'Backspace' ? null : k.pos));
    expect(reconstructPositions(t.keystrokes)).toEqual(recorded);
    const old = makeTest(['abc', 'de'], { errors: [{ word: 0, pos: 1 }], withPos: false });
    expect(deriveStats(old)).toEqual(deriveStats(t));
  });
});

describe('clean timing', () => {
  it('uses press-to-press gaps between two correct first tries inside a word', () => {
    const s = stats(['abc'], { slow: { c: 300 } });
    expect(s.items['k:a'].s).toEqual([]); // first key of the test
    expect(s.items['k:b'].s).toEqual([100]);
    expect(s.items['k:c'].s).toEqual([300]);
  });

  it('times Space and the next word start as boundaries, not as letters', () => {
    const s = stats(['ab', 'cd'], { pauses: [{ word: 0, pos: 2, ms: 250 }, { word: 1, pos: 0, ms: 400 }] });
    expect(s.items['x:space'].s).toEqual([250]);
    expect(s.items['x:start'].s).toEqual([400]);
    expect(s.items['k:c'].s).toEqual([]);
    expect(s.items['k:d'].s).toEqual([100]);
  });

  it('leaves out keys after a correction, pauses, repeats, focus loss and IME or paste', () => {
    const t = makeTest(['abcdef'], { errors: [{ word: 0, pos: 1 }], pauses: [{ word: 0, pos: 3, ms: 2500 }] });
    const s = deriveStats(t);
    expect(s.items['k:c'].s).toEqual([]); // follows the retyped b: recovery, not speed
    expect(s.items['k:d'].s).toEqual([]); // 2.5 s gap is an interruption
    expect(s.items['k:e'].s).toEqual([100]); // clean again
    const flagged = (flag: number) => {
      const u = makeTest(['abcd']);
      u.keystrokes[2].flags = flag;
      return deriveStats(u).items['k:c'].s;
    };
    expect(flagged(0)).toEqual([100]);
    expect(flagged(KS_REPEAT)).toEqual([]);
    expect(flagged(KS_AFTER_BLUR)).toEqual([]);
    expect(flagged(KS_AFTER_ARTIFACT)).toEqual([]);
  });

  it('gives a capital letter time to Shift and counts it for both', () => {
    const t = makeTest(['aBc'], { slow: { b: 260 } });
    const s = deriveStats(t);
    expect(s.items['k:b']).toMatchObject({ a: 1, e: 0, s: [] });
    expect(s.items['x:shift']).toMatchObject({ a: 1, e: 0, s: [260] });
  });

  it('tracks digits and punctuation as their own boundaries', () => {
    const s = stats(['hi,', '42']);
    expect(s.items['p:,'].a).toBe(1);
    expect(s.items['x:digit'].a).toBe(2);
  });
});

describe('sequences and words', () => {
  it('times bigrams and trigrams inside words only', () => {
    const s = stats(['the', 'the'], { slowPairs: { th: 240 } });
    expect(s.items['b:th']).toMatchObject({ a: 2, e: 0 });
    expect(s.items['b:th'].s).toEqual([240, 240]);
    expect(s.items['t:the']).toMatchObject({ a: 2, e: 0, s: [170, 170] });
    expect(s.items['b:et']).toBeUndefined(); // never across the Space
  });

  it('counts a word error once per occurrence and times clean words per character', () => {
    const s = stats(['once', 'word', 'word'], { errors: [{ word: 1, pos: 2 }] });
    expect(s.items['w:word']).toMatchObject({ a: 2, e: 1 });
    expect(s.items['w:word'].s).toHaveLength(1);
  });

  it('marks a stall inside a word', () => {
    const s = stats(['about', 'because', 'other'], { pauses: [{ word: 1, pos: 3, ms: 900 }] });
    expect(s.stalls['w:because']).toBe(1);
    expect(s.stalls['w:other']).toBeUndefined();
  });

  it('measures fading over a long run', () => {
    const words = Array.from({ length: 30 }, () => 'state');
    const t = makeTest(words);
    t.keystrokes.forEach((k, i) => {
      if (i > 0) k.t = t.keystrokes[i - 1].t + (i > t.keystrokes.length * 0.66 ? 150 : 100);
    });
    expect(deriveStats(t).fade).toBeCloseTo(1.5, 1);
  });
});

describe('helpers', () => {
  it('summarises target outcome in a drill', () => {
    const s = stats(['pop', 'up'], { errors: [{ word: 0, pos: 2 }] });
    expect(outcomeOn(s, ['k:p'])).toMatchObject({ attempts: 3, errors: 1 });
    expect(outcomeOn(s, ['k:p']).accuracy).toBeCloseTo(2 / 3);
  });

  it('picks missed and stalled words for review', () => {
    const t = makeTest(['which', 'about', 'people', 'there'], { errors: [{ word: 2, pos: 1 }], pauses: [{ word: 0, pos: 3, ms: 950 }] });
    expect(reviewWords(t, deriveStats(t))).toEqual(['people', 'which']);
  });

  it('keystroke shape matches what the recorder stores', () => {
    const k: Keystroke = makeTest(['a']).keystrokes[0];
    expect(Object.keys(k).sort()).toEqual(['correct', 'expected', 'flags', 'key', 'pos', 'seq', 't', 'wordIndex']);
  });
});
