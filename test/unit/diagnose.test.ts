import { describe, expect, it } from 'vitest';
import { buildCorpusFreq } from '../../src/shared/corpus';
import { diagnose, type DiagnosisInput } from '../../src/shared/diagnose';
import { deriveStats } from '../../src/shared/keystats';
import { TUNING } from '../../src/shared/tuning';
import { COMMON, makeTest, type MakeTestOptions } from '../fixtures/makeTest';

const scope = { language: 'english', layout: 'qwerty' };

/** n tests of the same words with the same habits, newest last. */
function runs(words: string[], n: number, o: MakeTestOptions = {}): DiagnosisInput[] {
  return Array.from({ length: n }, (_, i) => {
    const t = makeTest(words, { ...o, id: i + 1, endedAt: (i + 1) * 1000 });
    return { id: t.id, endedAt: t.endedAt, stats: deriveStats(t), wpm: 80 };
  });
}

/** Every occurrence of `letter` in the words missed with a fixed share (deterministic). */
function missEvery(words: string[], letter: string, everyNth: number) {
  const errors: { word: number; pos: number }[] = [];
  let seen = 0;
  words.forEach((w, wi) => [...w].forEach((ch, pos) => {
    if (ch === letter && seen++ % everyNth === 0) errors.push({ word: wi, pos });
  }));
  return errors;
}

describe('ranking', () => {
  it('an error-prone common key outranks a rare slow key', () => {
    // p comes up often and is fast but missed ~27%; z is rare and slow but never missed.
    const words = [...COMMON.slice(0, 60), 'paper', 'people', 'place', 'point', 'public', 'help', 'keep', 'up', 'plan', 'part', 'lazy', 'size'];
    const errors = missEvery(words, 'p', 4);
    const d = diagnose(runs(words, 3, { errors, slow: { z: 600 } }), { scope, corpus: buildCorpusFreq(COMMON.concat(['lazy', 'size'])) });
    const p = d.items.find((s) => s.id === 'k:p')!;
    const z = d.items.find((s) => s.id === 'k:z')!;
    expect(p.errorRate).toBeGreaterThan(0.2);
    expect(p.ms!).toBeLessThan(z.ms!);
    expect(p.problem).toBe('accuracy');
    expect(p.impact).toBeGreaterThan(z.impact);
    expect(d.top[0].id).toBe('k:p');
    expect(p.explanation).toMatch(/^You miss p often: \d+(\.\d)?% of first tries/);
  });

  it('labels a slow pair against the other common pairs', () => {
    const words = [...COMMON.slice(0, 120)];
    const d = diagnose(runs(words, 4, { slowPairs: { th: 320 } }), { scope, corpus: buildCorpusFreq(COMMON) });
    const th = d.sequences.find((s) => s.id === 'b:th')!;
    expect(th.status).toBe('weak');
    expect(th.problem).toBe('speed');
    expect(th.explanation).toMatch(/^th is slower than your other common pairs: 3\d\d ms vs 1\d\d ms\.$/);
  });

  it('allows boundaries their natural extra time before calling them slow', () => {
    const words = [...COMMON.slice(0, 120)];
    const starts = (ms: number) => {
      const pauses = words.slice(1).map((_, i) => ({ word: i + 1, pos: 0, ms }));
      return diagnose(runs(words, 3, { pauses }), { scope, corpus: buildCorpusFreq(COMMON) }).boundaries.find((s) => s.id === 'x:start')!;
    };
    expect(starts(125).status).toBe('ok'); // 1.25x the in-word pace: reading the next word, not a weakness
    const slow = starts(190);
    expect(slow.status).toBe('weak');
    expect(slow.explanation).toBe('You pause at word starts: 190 ms vs about 130 ms expected from your pace.');
  });

  it('ignores patterns the ordinary-test corpus never shows', () => {
    const words = [...COMMON.slice(0, 80), 'zygote', 'zygote'];
    const d = diagnose(runs(words, 3, { slow: { y: 500 } }), { scope, corpus: buildCorpusFreq(COMMON) });
    expect(d.items.find((s) => s.id === 'w:zygote')!.impact).toBe(0);
  });
});

describe('evidence', () => {
  it('keeps a pattern "learning" until it has 15 tries across 2 runs', () => {
    const one = diagnose(runs([...COMMON.slice(0, 150)], 1, { slow: { w: 400 } }), { scope });
    const w1 = one.letters.find((s) => s.id === 'k:w')!;
    expect(w1.attempts).toBeGreaterThanOrEqual(TUNING.minAttempts);
    expect(w1.status).toBe('learning'); // only one run
    expect(w1.explanation).toMatch(/^Learning: \d+ of 15 tries, 1 of 2 runs so far\.$/);
    expect(one.sparse).toBe(true);
    const two = diagnose(runs([...COMMON.slice(0, 150)], 2, { slow: { w: 400 } }), { scope });
    expect(two.letters.find((s) => s.id === 'k:w')!.status).toBe('weak');
    expect(two.sparse).toBe(false);
  });

  it('smooths a sparse error rate toward the typist baseline', () => {
    const words = [...COMMON.slice(0, 40), 'jump'];
    const d = diagnose(runs(words, 2, { errors: [{ word: 40, pos: 0 }] }), { scope });
    const j = d.letters.find((s) => s.id === 'k:j')!;
    expect(j.errorRate).toBe(1); // missed both times
    expect(j.smoothedErrorRate).toBeLessThan(0.2); // 2 tries say little
    expect(j.status).toBe('learning');
  });

  it('weights recent runs more', () => {
    const fixedLate = [...runs(COMMON.slice(0, 100), 6, { slow: { e: 300 } }), ...runs(COMMON.slice(0, 100), 6).map((r, i) => ({ ...r, id: 100 + i, endedAt: 100_000 + i }))];
    const e = diagnose(fixedLate, { scope }).letters.find((s) => s.id === 'k:e')!;
    expect(e.ms!).toBeLessThan(200);
  });

  it('flags fading when the end of runs is slower', () => {
    const words = Array.from({ length: 40 }, (_, i) => COMMON[i]);
    const make = (id: number) => {
      const t = makeTest(words, { id, endedAt: id * 1000 });
      t.keystrokes.forEach((k, i) => i > 0 && (k.t = t.keystrokes[i - 1].t + (i > t.keystrokes.length * 0.6 ? 140 : 100)));
      return { id, endedAt: t.endedAt, stats: deriveStats(t), wpm: 70 };
    };
    expect(diagnose([make(1), make(2)], { scope }).fading).toBe(true);
    expect(diagnose(runs(words, 2), { scope }).fading).toBe(false);
  });
});

describe('tuning', () => {
  it('keeps the weights and thresholds in one place', () => {
    expect(TUNING).toMatchObject({ minAttempts: 15, minRuns: 2, accuracyFloor: 0.97, baselineTests: 3 });
  });
});
