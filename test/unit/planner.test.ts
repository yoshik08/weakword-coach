import { describe, expect, it } from 'vitest';
import { buildCorpusFreq } from '../../src/shared/corpus';
import { diagnose } from '../../src/shared/diagnose';
import { deriveStats } from '../../src/shared/keystats';
import { chooseTargets, planSession } from '../../src/shared/planner';
import { afterRound, isDue, newPatternState, reviewSchedule } from '../../src/shared/practice-model';
import { profileFromKey } from '../../src/shared/profile';
import { TUNING } from '../../src/shared/tuning';
import type { Diagnosis, PatternStat, SessionPlan } from '../../src/shared/types';
import { COMMON, makeTest } from '../fixtures/makeTest';

const scope = { language: 'english', layout: 'qwerty' };
const KEY = 'words 25|english|||qwerty';

function diagnosisWith(o: Parameters<typeof makeTest>[1], n = 3): Diagnosis {
  const tests = Array.from({ length: n }, (_, i) => {
    const t = makeTest(COMMON.slice(0, 150), { ...o, id: i + 1, endedAt: (i + 1) * 1000 });
    return { id: t.id, endedAt: t.endedAt, stats: deriveStats(t), wpm: 80 };
  });
  return diagnose(tests, { scope, corpus: buildCorpusFreq(COMMON) });
}

const input = (d: Diagnosis, over = {}) => ({
  kind: 'session' as const, diagnosis: d, practice: [], profile: profileFromKey(KEY), profileKey: KEY, paceWpm: 80, seed: 1, now: 1_000_000, ...over,
});

describe('planSession', () => {
  it('plans warm-up, accuracy, speed, mixed and a normal retest in 5-10 minutes', () => {
    const d = diagnosisWith({ slow: { w: 380 }, slowPairs: { th: 330 } });
    const plan = planSession(input(d)) as SessionPlan;
    expect('error' in plan).toBe(false);
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds[0]).toBe('warmup');
    expect(kinds).toContain('accuracy');
    expect(kinds.filter((k) => k === 'speed')).toHaveLength(TUNING.speedBursts);
    expect(kinds.at(-2)).toBe('mixed');
    expect(kinds.at(-1)).toBe('retest');
    expect(plan.targets.length).toBeGreaterThanOrEqual(1);
    expect(plan.targets.length).toBeLessThanOrEqual(3);
    expect(plan.estMinutes).toBeGreaterThanOrEqual(5);
    expect(plan.estMinutes).toBeLessThanOrEqual(10);
    // A fast typist gets the same length of session, not a shorter one.
    const fast = planSession(input(d, { paceWpm: 140 })) as SessionPlan;
    expect(fast.estMinutes).toBeGreaterThanOrEqual(5);
    expect(fast.estMinutes).toBeLessThanOrEqual(10);
    expect(plan.steps.find((s) => s.kind === 'retest')!.instruction).toContain('words 25 · english');
  });

  it('gives accuracy targets two slow clean rounds at the floor', () => {
    const words = COMMON.slice(0, 150);
    const errors: { word: number; pos: number }[] = [];
    let n = 0;
    words.forEach((w, wi) => [...w].forEach((c, pos) => c === 'o' && n++ % 3 === 0 && errors.push({ word: wi, pos })));
    const plan = planSession(input(diagnosisWith({ errors }))) as SessionPlan;
    expect(plan.targets[0]).toMatchObject({ id: 'k:o', problem: 'accuracy' });
    const acc = plan.steps.filter((s) => s.kind === 'accuracy');
    expect(acc).toHaveLength(TUNING.accuracyRounds);
    expect(acc[0].paceWpm).toBe(Math.round(80 * TUNING.accuracyPace));
    expect(acc[0].accuracyFloor).toBe(0.97);
  });

  it('runs progressively longer mixed runs when pace fades', () => {
    const d = { ...diagnosisWith({ slow: { w: 380 } }), fading: true };
    const mixed = (planSession(input(d)) as SessionPlan).steps.filter((s) => s.kind === 'mixed');
    expect(mixed).toHaveLength(2);
    expect(mixed[1].words).toBeGreaterThan(mixed[0].words);
  });

  it('refuses a session with a plain reason when there is nothing to train yet', () => {
    const sparse = diagnosisWith({}, 1);
    expect(planSession(input(sparse))).toEqual({ error: expect.stringMatching(/^Still learning/) });
  });

  it('still offers a quick drill on sparse history, on the costliest patterns seen so far', () => {
    const sparse = diagnosisWith({ slow: { w: 420 } }, 1);
    expect(sparse.sparse).toBe(true);
    const quick = planSession(input(sparse, { kind: 'quick' })) as SessionPlan;
    expect(quick.targets[0]).toMatchObject({ id: 'k:w' });
    expect(quick.targets[0].reason).toMatch(/^Learning:/);
  });

  it('plans a one-round quick drill and a review of given words', () => {
    const d = diagnosisWith({ slow: { w: 380 } });
    const quick = planSession(input(d, { kind: 'quick' })) as SessionPlan;
    expect(quick.steps.map((s) => s.kind)).toEqual(['quick']);
    const review = planSession(input(d, { kind: 'review', reviewWords: ['because', 'people'] })) as SessionPlan;
    expect(review.steps.map((s) => s.kind)).toEqual(['review']);
    expect(review.reviewWords).toEqual(['because', 'people']);
  });
});

describe('chooseTargets', () => {
  const stat = (id: string, impact: number, extra: Partial<PatternStat> = {}): PatternStat => ({
    id, kind: id.startsWith('k:') ? 'letter' : 'bigram', label: id.slice(2), attempts: 40, errors: 0, runs: 3, errorRate: 0,
    smoothedErrorRate: 0, ms: 200, smoothedMs: 200, samples: 30, stallRate: null, baselineMs: 150, baselineErrorRate: 0.03,
    frequency: 2, costMs: 50, impact, status: 'weak', problem: 'speed', explanation: '', ...extra,
  });
  const d = (top: PatternStat[]): Diagnosis => ({ ...diagnosisWith({}, 1), top, items: top });

  it('takes one to three high-impact patterns and skips overlapping ones', () => {
    const picked = chooseTargets(d([stat('k:e', 100), stat('b:er', 90), stat('k:p', 80), stat('k:o', 50), stat('k:z', 10)]), [], 0);
    expect(picked.map((t) => t.id)).toEqual(['k:e', 'k:p', 'k:o']);
    const lone = chooseTargets(d([stat('k:e', 100), stat('k:p', 20)]), [], 0);
    expect(lone.map((t) => t.id)).toEqual(['k:e']);
  });

  it('brings back a recovering pattern on its review day', () => {
    const due = { ...newPatternState('k:q', 0, 60), status: 'recovering' as const, nextDueAt: 500 };
    const picked = chooseTargets(d([stat('k:e', 100), stat('k:q', 5, { status: 'ok' })]), [due], 1000);
    expect(picked.map((t) => t.id)).toEqual(['k:e', 'k:q']);
  });
});

describe('practice model', () => {
  const s0 = newPatternState('k:p', 0, 80);
  const round = (accuracy: number, kind = 'accuracy', wpm = 60) => ({ accuracy, paceWpm: 60, wpm, kind });

  it('raises the pace after two clean rounds and lowers it when mistakes rise', () => {
    const one = afterRound(s0, round(0.98), 1);
    expect(one).toMatchObject({ level: 1, cleanRounds: 1 });
    const two = afterRound(one, round(0.99), 2);
    expect(two.level).toBeCloseTo(1.05);
    expect(two.cleanRounds).toBe(0);
    const rough = afterRound(two, round(0.9), 3);
    expect(rough.level).toBeCloseTo(1);
    expect(rough.roughRounds).toBe(1);
    // In between the floor and the rough margin nothing changes.
    expect(afterRound(two, round(0.95), 4).level).toBeCloseTo(1.05);
    // A speed round must also meet its pace to count as clean.
    expect(afterRound(s0, round(0.99, 'speed', 40), 5).cleanRounds).toBe(0);
  });

  it('schedules a recovering pattern for review on later days', () => {
    const DAY = 86_400_000;
    const practiced = { ...s0, lastPracticedAt: 10 * DAY };
    const stat = { costMs: 30, status: 'ok' } as PatternStat;
    const rec = reviewSchedule(practiced, stat);
    expect(rec).toMatchObject({ status: 'recovering', intervalIndex: 0, nextDueAt: 11 * DAY });
    expect(isDue(rec, 10.5 * DAY)).toBe(false);
    expect(isDue(rec, 11 * DAY)).toBe(true);
    // Not practiced yet: the schedule waits.
    expect(reviewSchedule(rec, stat)).toEqual(rec);
    const reviewed = reviewSchedule({ ...rec, lastPracticedAt: 11.2 * DAY }, stat);
    expect(reviewed).toMatchObject({ intervalIndex: 1, nextDueAt: 11.2 * DAY + 3 * DAY });
    // Cost back up: training again.
    expect(reviewSchedule(rec, { costMs: 70, status: 'weak' } as PatternStat).status).toBe('training');
  });
});
