import { describe, expect, it } from 'vitest';
import { deriveStats } from '../../src/shared/keystats';
import {
  cleanPace, postTests, progressRow, recentBefore, resolveBaseline, transfer, usualProfile, type BaselineRecord, type PeriodInfo, type ScoredTest,
} from '../../src/shared/progress';
import { makeTest } from '../fixtures/makeTest';

const P = 'words 10|english|||qwerty';
const Q = 'time 60|english|||qwerty';
let nextId = 1;
const t = (endedAt: number, wpm: number, acc: number, over: Partial<ScoredTest> = {}): ScoredTest => ({
  id: nextId++, endedAt, kind: 'normal', eligible: true, reason: null, profileKey: P, corpusVersion: 'v1', wpm, acc, ...over,
});
const drill = (endedAt: number, wpm = 200, acc = 100) => t(endedAt, wpm, acc, { kind: 'drill', eligible: false, reason: 'practice round', profileKey: 'custom custom|english|||qwerty' });

const before: PeriodInfo = { id: 1, startedAt: 0, firstDrillAt: null };
const started: PeriodInfo = { id: 1, startedAt: 0, firstDrillAt: 1000 };

function history() {
  nextId = 1;
  return [t(100, 70, 95), t(200, 90, 99), t(300, 80, 97), t(400, 75, 96), drill(1000), drill(1100)];
}

describe('baselines', () => {
  it('rolls before the first drill and freezes the 3 latest pre-Coach tests after it', () => {
    const tests = history();
    const rolling = resolveBaseline(tests, P, before, null);
    expect(rolling.freeze).toBe(false);
    expect(rolling.record).toMatchObject({ kind: 'pre-coach', frozenAt: null, wpm: 80, acc: 97 });
    expect(rolling.record!.testIds).toEqual([2, 3, 4]);
    const frozen = resolveBaseline(tests, P, started, null);
    expect(frozen.freeze).toBe(true);
    expect(frozen.record).toMatchObject({ frozenAt: 1000, testIds: [2, 3, 4], wpm: 80, acc: 97 });
    // Once stored, later tests never change it.
    const later = [...tests, t(1200, 150, 100), t(1300, 160, 100)];
    expect(resolveBaseline(later, P, started, frozen.record).record).toBe(frozen.record);
  });

  it('never counts drills, other profiles or ineligible tests', () => {
    const tests = [...history(), t(500, 300, 100, { profileKey: Q }), t(600, 300, 100, { eligible: false, reason: 'too short' })];
    expect(recentBefore(tests, P, 1000, 3).map((x) => x.wpm)).toEqual([90, 80, 75]);
    const frozen = resolveBaseline(tests, P, started, null).record!;
    const post = postTests([...tests, drill(1500), t(1600, 85, 98)], frozen, started);
    expect(post.map((x) => x.wpm)).toEqual([85]);
  });

  it('collects a fresh baseline for a profile without pre-Coach tests', () => {
    const fresh: BaselineRecord = { periodId: 1, profileKey: Q, kind: 'fresh', createdAt: 2000, frozenAt: null, testIds: [], wpm: null, acc: null, corpusVersion: null };
    const base = history();
    const [a, b, c, d] = [t(2100, 60, 95, { profileKey: Q }), t(2200, 64, 96, { profileKey: Q }), t(2300, 62, 99, { profileKey: Q }), t(2400, 70, 99, { profileKey: Q })];
    const two = resolveBaseline([...base, a, b], Q, started, fresh);
    expect(two).toMatchObject({ freeze: false, record: { testIds: [a.id, b.id] } });
    const three = resolveBaseline([...base, a, b, c, d], Q, started, fresh);
    expect(three.freeze).toBe(true);
    expect(three.record).toMatchObject({ testIds: [a.id, b.id, c.id], wpm: 62, acc: 96, frozenAt: 2300 });
  });
});

describe('the result row', () => {
  const row = (tests: ScoredTest[], test: ScoredTest, period = started, baseline?: BaselineRecord | null, extra = {}) =>
    progressRow({
      clientId: 'c', test, profileLabel: 'words 10 · english', period, tests,
      baseline: baseline === undefined ? resolveBaseline(tests, test.profileKey!, period, null).record : baseline, ...extra,
    });

  it('shows a positive delta for a single run, labelled as one run, with the baseline exposed', () => {
    const tests = history();
    const now = t(1200, 85, 98.4);
    const r = row([...tests, now], now);
    expect(r.kind).toBe('compare');
    expect(r.metrics.map((m) => [m.id, m.delta, m.tone])).toEqual([['wpm', '+5', 'up'], ['acc', '+1.4 pp', 'up']]);
    expect(r.metrics[0].caption).toBe('wpm vs pre-Coach');
    expect(r.lines[0]).toMatch(/^One run since coaching began/);
    expect(r.lines[1]).toBe('Pre-Coach baseline: 80 wpm, 97.0%, median of 3 tests.');
    expect(r.data).toMatchObject({ dwpm: '5.0', window: '1', n: '1', baselineN: '3' });
  });

  it('shows a negative delta and the median of the last 3 once there are 3 runs', () => {
    const tests = [...history(), t(1200, 78, 97), t(1300, 74, 98)];
    const now = t(1400, 76, 97.5);
    const r = row([...tests, now], now);
    expect(r.metrics[0]).toMatchObject({ delta: '−4', tone: 'down', value: '76' });
    expect(r.heading).toBe('Since coaching, last 3 tests');
    expect(r.lines[0]).toMatch(/^Median of your last 3 words 10 · english tests · 3 since coaching began\. This run: 76 wpm, 97\.5%\.$/);
  });

  it('makes a speed gain with lower accuracy obvious', () => {
    const tests = history();
    const now = t(1200, 92, 94.5);
    const r = row([...tests, now], now);
    expect(r.metrics.map((m) => m.tone)).toEqual(['up', 'down']);
    expect(r.metrics[1].delta).toBe('−2.5 pp');
    expect(r.lines).toContain('Faster than your baseline, but less accurate.');
  });

  it('asks for its own baseline when the profile has no pre-Coach tests', () => {
    const tests = history();
    const now = t(1200, 60, 95, { profileKey: Q });
    const r = row([...tests, now], now);
    expect(r.kind).toBe('no-baseline');
    expect(r.actions[0]).toEqual({ id: 'start-baseline', label: 'Start a baseline for this mode' });
    const changed = row([...tests, now], now, started, resolveBaseline(tests, P, started, null).record, { versionChanged: true });
    expect(changed.lines[0]).toMatch(/word list .* changed/);
  });

  it('shows calibration before coaching and a follow-up line after it', () => {
    const early = [t(100, 70, 95), t(200, 90, 99)];
    const r = row(early, early[1], before);
    expect(r).toMatchObject({ kind: 'calibrating', heading: 'Baseline 2/3 complete' });
    const tests = history();
    const now = t(90_000_000, 84, 98);
    const f = row([...tests, now], now, started, undefined, { followup: { days: 1, retestDelta: 5 } });
    expect(f.lines).toContain('Follow-up a day after your session: +4 wpm vs pre-Coach (the retest right after was +5).');
  });

  it('does not compare tests Monkeytype itself would not count', () => {
    const tests = history();
    const now = t(1200, 300, 100, { eligible: false, reason: 'too short' });
    expect(row([...tests, now], now)).toMatchObject({ kind: 'not-counted', metrics: [] });
  });
});

describe('profile choice and pace', () => {
  it('picks the usual mode and a clean pace', () => {
    const tests = [...history(), t(1200, 60, 90, { profileKey: Q })];
    expect(usualProfile(tests)).toBe(P);
    expect(cleanPace(tests)).toBe(77.5); // the 90%-accuracy run is left out
  });
});

describe('skill transfer', () => {
  it('compares trained patterns in ordinary tests before and after, and says when evidence is thin', () => {
    const mk = (id: number, thMs: number) => {
      const s = makeTest(Array.from({ length: 12 }, () => 'the'), { id, slowPairs: { th: thMs } });
      return { id, endedAt: id, stats: deriveStats(s), wpm: 80 };
    };
    const views = transfer([{ id: 'b:th', problem: 'speed' }, { id: 'k:q', problem: 'accuracy' }], [mk(1, 142), mk(2, 142)], [mk(3, 118), mk(4, 118)]);
    expect(views[0]).toEqual({ id: 'b:th', label: 'th', metric: 'ms', before: 142, after: 118, learning: false });
    expect(views[1]).toMatchObject({ id: 'k:q', learning: true });
  });
});
