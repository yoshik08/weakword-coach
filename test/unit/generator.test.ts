import { describe, expect, it } from 'vitest';
import { exercises, generateRound, sentences, vocabulary, type RoundSpec, type WordPools } from '../../src/shared/generator';
import { mulberry32 } from '../../src/shared/util';
import { COMMON } from '../fixtures/makeTest';

const WIDER = [
  'paper', 'happen', 'speak', 'open', 'upon', 'example', 'simple', 'support', 'perhaps', 'spend', 'stop', 'type', 'deep',
  'top', 'shop', 'step', 'map', 'pick', 'pull', 'push', 'pay', 'pain', 'pair', 'price', 'print', 'proud', 'prove', 'apple',
  'happy', 'puppy', 'pepper', 'zipper', 'copy', 'hope', 'jump', 'lamp', 'ramp', 'camp', 'damp', 'sharp', 'grip', 'trip',
  'with', 'think', 'three', 'though', 'thick', 'thin', 'theme', 'thumb', 'earth', 'math', 'path', 'bath', 'south', 'truth',
  'mother', 'father', 'rather', 'either', 'whether', 'further', 'nothing', 'anything', 'something', 'method', 'author',
];
const pools: WordPools = { primary: COMMON, wider: [WIDER] };
const targets: RoundSpec['targets'] = [
  { id: 'k:p', kind: 'letter', label: 'p' },
  { id: 'b:th', kind: 'bigram', label: 'th' },
];
const spec = (over: Partial<RoundSpec> = {}): RoundSpec => ({ kind: 'accuracy', targets, words: 40, seed: 7, ...over });

describe('generateRound', () => {
  it('is reproducible for a seed and changes with it', () => {
    expect(generateRound(spec(), pools)).toEqual(generateRound(spec(), pools));
    expect(generateRound(spec({ seed: 8 }), pools).words).not.toEqual(generateRound(spec(), pools).words);
  });

  it('fills the round with target words plus a share of ordinary words', () => {
    const { words, targetHits } = generateRound(spec(), pools);
    expect(words).toHaveLength(40);
    const targeted = words.filter((w) => targets.some((t) => exercises(t, w)));
    expect(targeted.length).toBeGreaterThanOrEqual(26); // 70% target share
    expect(targeted.length).toBeLessThan(40); // ordinary words mixed in
    expect(targetHits['k:p']).toBeGreaterThanOrEqual(12);
    expect(targetHits['b:th']).toBeGreaterThanOrEqual(12);
  });

  it('starts from common real words, then varies placement and length', () => {
    const { words } = generateRound(spec({ targets: [targets[0]], words: 30 }), pools);
    const withP = [...new Set(words.filter((w) => w.includes('p')))];
    const where = new Set(withP.map((w) => (w.startsWith('p') ? 'start' : w.endsWith('p') ? 'end' : 'mid')));
    expect(where.size).toBe(3);
    expect(new Set(withP.map((w) => (w.length <= 4 ? 's' : w.length <= 7 ? 'm' : 'l'))).size).toBeGreaterThanOrEqual(2);
    expect(withP).toContain('people'); // a common word comes first in its bucket
  });

  it('caps repeats and falls back to wider vocabulary when the pool is small', () => {
    const { words } = generateRound(spec({ targets: [targets[0]], words: 40 }), pools);
    const counts = new Map<string, number>();
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(words.some((w) => WIDER.includes(w) && !COMMON.includes(w))).toBe(true);
    // A tiny vocabulary still fills the round by relaxing the cap.
    const tiny = generateRound(spec({ targets: [targets[0]], words: 20 }), { primary: ['up', 'pa', 'the', 'and'], wider: [] });
    expect(tiny.words).toHaveLength(20);
  });

  it('separates identical neighbours', () => {
    const { words } = generateRound(spec({ words: 60 }), pools);
    for (let i = 1; i < words.length; i++) expect(words[i]).not.toBe(words[i - 1]);
  });

  it('uses fresh words in mixed rounds and sentences in punctuation mode', () => {
    const first = generateRound(spec({ words: 30 }), pools).words;
    const mixed = generateRound(spec({ kind: 'mixed', words: 30, exclude: first }), pools).words;
    const targetedReuse = mixed.filter((w) => first.includes(w) && targets.some((t) => exercises(t, w)));
    expect(targetedReuse.length).toBeLessThanOrEqual(2);
    const punct = generateRound(spec({ kind: 'mixed', words: 30, punctuation: true }), pools).words;
    expect(punct[0][0]).toMatch(/[A-Z]/);
    expect(punct[punct.length - 1]).toMatch(/[.?!]$/);
  });

  it('warm-up is ordinary common words; review repeats the missed words', () => {
    const warm = generateRound(spec({ kind: 'warmup', targets: [], words: 25 }), pools).words;
    expect(warm.every((w) => COMMON.slice(0, 100).includes(w))).toBe(true);
    const review = generateRound(spec({ kind: 'review', targets: [], words: 24, review: ['because', 'people'] }), pools).words;
    expect(review.filter((w) => w === 'because')).toHaveLength(2);
    expect(review.filter((w) => w === 'people')).toHaveLength(2);
    expect(review).toHaveLength(24);
  });

  it('puts boundary targets on ordinary words', () => {
    const caps = generateRound(spec({ targets: [{ id: 'x:shift', kind: 'shift', label: 'capitals' }], words: 20 }), pools).words;
    expect(caps.filter((w) => /^[A-Z]/.test(w)).length).toBeGreaterThanOrEqual(12);
    const nums = generateRound(spec({ targets: [{ id: 'x:digit', kind: 'digit', label: 'numbers' }], words: 20 }), pools).words;
    expect(nums.filter((w) => /^\d+$/.test(w)).length).toBeGreaterThanOrEqual(12);
  });

  it('only keeps plain lowercase words from the lists', () => {
    expect(vocabulary({ primary: ['I', 'Hello', "don't", 'ok', 'a'], wider: [] }).map((c) => c.word)).toEqual(['hello', 'ok']);
  });

  it('builds sentences like punctuation mode', () => {
    const s = sentences(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'], mulberry32(3));
    expect(s[0]).toMatch(/^One[,]?$/);
    expect(s.join(' ')).toMatch(/[.?!]$/);
  });
});
