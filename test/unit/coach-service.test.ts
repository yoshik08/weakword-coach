// The whole coach flow against an in-memory database and a fake Monkeytype: calibration, the first drill
// freezing baselines, a full session ending in a normal retest, the result rows, a mismatched profile,
// a follow-up a day later, and that practice rounds never reach the comparisons.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoachService } from '../../src/main/coach';
import { getScored, getTests, openDb } from '../../src/main/db';
import { profileKey } from '../../src/shared/profile';
import { TUNING, withTuning } from '../../src/shared/tuning';
import type { HudView, Profile, ResultRowView } from '../../src/shared/types';
import { captured, COMMON } from '../fixtures/makeTest';

const HOUR = 3_600_000;

function setup() {
  const db = openDb(':memory:');
  let clock = Date.UTC(2026, 10, 24, 9);
  const injected: string[][] = [];
  const loaded: Profile[] = [];
  const huds: (HudView | null)[] = [];
  const badges: { dot: boolean; label: string }[] = [];
  const rows: ResultRowView[] = [];
  const lists: Record<string, string[]> = { english: COMMON, english_1k: [...COMMON, 'paper', 'whale', 'swim', 'wow', 'window', 'widow', 'awkward'] };
  const coach = new CoachService(db, {
    wordlistDir: path.join(mkdtempSync(path.join(tmpdir(), 'wwc-coach-')), 'wordlists'),
    now: () => clock,
    tuning: withTuning({ stepSeconds: { warmup: 10, accuracy: 15, speed: 8, mixed: 20 } }),
    fetchJson: async (url) => {
      const name = url.split('/').pop()!.replace('.json', '');
      if (!lists[name]) throw new Error('HTTP 404');
      return { words: lists[name] };
    },
    driver: {
      injectWords: async (words) => (injected.push(words), { ok: true }),
      loadProfile: async (p) => (loaded.push(p), { ok: true }),
      focusTyping: () => {},
    },
    events: {
      stateChanged: () => {},
      hud: (h) => huds.push(h),
      badge: (b) => badges.push(b),
      practiceStatus: () => {},
      closePanel: () => {},
      openPanel: () => {},
    },
  });
  coach.onRow = (r) => rows.push(r);
  let n = 0;
  /** An ordinary test with fresh words (w typed slowly), as the preload would send it. */
  const normal = (wpm: number, accuracy: number, mode = 'words 10') => {
    n++;
    clock += 60_000;
    const words = [...COMMON.slice((n * 37) % COMMON.length), ...COMMON].slice(0, 120);
    return captured(words, { id: n, mode, wpm, accuracy, endedAt: clock, slow: { w: 380 } });
  };
  /** Types whatever the coach last loaded as a custom text. */
  const drill = (wpm = 70) => {
    clock += 60_000;
    return captured(injected[injected.length - 1], { mode: 'custom custom', wpm, accuracy: 99, endedAt: clock });
  };
  return { db, coach, injected, loaded, huds, badges, rows, normal, drill, advance: (ms: number) => (clock += ms), now: () => clock };
}

describe('CoachService', () => {
  it('runs calibration, a session, the comparison row and a next-day follow-up', async () => {
    const s = setup();
    const { coach } = s;

    // Sparse history: nothing to plan, an honest message.
    const empty = await coach.state();
    expect(empty.diagnosis.sparse).toBe(true);
    expect(empty.progress).toBeNull();
    expect((await coach.startSession('quick')).error).toMatch(/ordinary Monkeytype test first/);

    // Calibration: Baseline 1/3, 2/3, then ready.
    const r1 = await coach.testFinished(s.normal(80, 97));
    expect(r1).toMatchObject({ kind: 'calibrating', heading: 'Baseline 1/3 complete' });
    expect((await coach.testFinished(s.normal(90, 99)))!.heading).toBe('Baseline 2/3 complete');
    const r3 = await coach.testFinished(s.normal(70, 95));
    expect(r3).toMatchObject({ kind: 'calibrating', heading: 'Baseline ready' });
    expect(r3!.actions[0]).toMatchObject({ id: 'start-session', primary: true });

    const before = await coach.state();
    expect(before.progress).toMatchObject({ coachingStarted: false, status: 'Baseline ready. It freezes when you start practicing.' });
    expect(before.benchmark!.label).toBe('words 10 · english');
    const preview = before.preview as Exclude<typeof before.preview, { error: string } | null>;
    expect(preview.targets.map((t) => t.id)).toContain('k:w');

    // A session: every drill is typed, then the normal retest.
    expect((await coach.startSession('session')).ok).toBe(true);
    expect(s.huds.at(-1)).toMatchObject({ state: 'step', step: 1, title: 'Warm-up' });
    const steps = (await coach.state()).session!.plan.steps;
    let row: ResultRowView | null = null;
    for (let i = 0; i < steps.length - 1; i++) {
      if (i > 0) await coach.continueSession();
      row = await coach.testFinished(s.drill());
      expect(row).toMatchObject({ kind: 'drill' });
      expect(row!.lines).toContain('Practice rounds never count toward your baseline, comparisons or best scores.');
    }
    expect(row!.actions[0]).toMatchObject({ id: 'continue', label: 'Next: Normal retest' });
    expect(s.injected).toHaveLength(steps.length - 1);
    // Fresh words for the mixed round, and every prompt differs.
    expect(new Set(s.injected.map((w) => w.join(' '))).size).toBe(s.injected.length);

    await coach.continueSession();
    expect(s.loaded.at(-1)).toMatchObject({ mode: 'words', mode2: '10', language: 'english', punctuation: false });
    const retest = await coach.testFinished(s.normal(95, 98));
    // Baseline = median of 80, 90, 70 wpm and 97, 99, 95 % from before the first drill.
    expect(retest).toMatchObject({ kind: 'compare', heading: 'Since coaching' });
    expect(retest!.metrics.map((m) => m.delta)).toEqual(['+15', '+1.0 pp']);
    expect(retest!.lines.some((l) => l.startsWith('Session retest.'))).toBe(true);
    expect(s.huds.at(-1)).toBeNull(); // session over

    // Practice rounds never enter the comparison: the baseline holds only the 3 ordinary tests.
    const scored = getScored(s.db);
    const drills = scored.filter((t) => t.kind === 'drill');
    expect(drills).toHaveLength(steps.length - 1);
    expect(drills.every((t) => !t.eligible)).toBe(true);
    const mid = await coach.state();
    expect(mid.progress).toMatchObject({ coachingStarted: true, postRuns: 1, baseline: { n: 3, wpm: 80, acc: 97, frozen: true } });
    expect(mid.followup).toMatchObject({ due: false, retestDelta: 15 });

    // The same result sent twice (a re-mounted result screen) is stored once and gets the same row.
    const again = s.normal(88, 97);
    const first = await coach.testFinished(again);
    const count = getTests(s.db, { withKeystrokes: false }).length;
    expect(await coach.testFinished(again)).toEqual(first);
    expect(getTests(s.db, { withKeystrokes: false })).toHaveLength(count);

    // A mode with no pre-Coach tests needs its own baseline.
    const other = s.normal(60, 96, 'time 60');
    const mismatch = await coach.testFinished(other);
    expect(mismatch).toMatchObject({ kind: 'no-baseline' });
    await coach.rowAction('start-baseline', other.clientId!);
    expect(s.rows.at(-1)).toMatchObject({ kind: 'calibrating', heading: 'Baseline 1/3 complete' });

    // The next day: the follow-up shows on the next ordinary test of the session's mode.
    s.advance(25 * HOUR);
    expect((await coach.state()).followup).toMatchObject({ due: true });
    expect(s.badges.at(-1)).toEqual({ dot: false, label: '' }); // badge refreshes on the next push
    coach.pushChrome();
    expect(s.badges.at(-1)).toEqual({ dot: true, label: 'follow-up test due' });
    const follow = await coach.testFinished(s.normal(84, 96));
    expect(follow!.lines.some((l) => /^Follow-up a day after your session: \+4 wpm vs pre-Coach \(the retest right after was \+15\)\.$/.test(l))).toBe(true);
    expect((await coach.state()).followup).toBeNull();

    // Runs slower and less accurate than the baseline show the regression plainly (median of the last 3).
    await coach.testFinished(s.normal(65, 93));
    await coach.testFinished(s.normal(66, 94));
    const worse = await coach.testFinished(s.normal(64, 92));
    expect(worse!.data.window).toBe('3');
    expect(worse!.metrics.map((m) => [m.delta, m.tone])).toEqual([['−15', 'down'], ['−4.0 pp', 'down']]);

    // Trained skills are compared on ordinary tests before and after coaching began.
    const after = await coach.state();
    expect(after.transfer.map((t) => t.id)).toContain('k:w');
    expect(after.drillTests).toBe(steps.length - 1);
  });

  it('finishes a session started on history recorded before layouts were fingerprinted', async () => {
    const s = setup();
    // Migrated 0.1.x history: no key codes, so the layout is unknown.
    for (const [w, a] of [[90, 97], [95, 98], [92, 98]]) {
      const old = s.normal(w, a);
      await s.coach.testFinished({ ...old, keyCodes: undefined });
    }
    expect((await s.coach.state()).benchmark!.key).toBe('words 10|english|||unknown');
    expect((await s.coach.startSession('session')).ok).toBe(true);
    const steps = (await s.coach.state()).session!.plan.steps;
    // The first drill fingerprints QWERTY: old tests, the session plan and the benchmark adopt it.
    for (let i = 0; i < steps.length - 1; i++) {
      if (i > 0) await s.coach.continueSession();
      await s.coach.testFinished(s.drill());
    }
    const mid = await s.coach.state();
    expect(mid.session!.plan.profileKey).toBe('words 10|english|||qwerty');
    expect(mid.benchmark!.key).toBe('words 10|english|||qwerty');
    await s.coach.continueSession();
    const retest = await s.coach.testFinished(s.normal(99, 98));
    expect(retest).toMatchObject({ kind: 'compare' });
    expect(retest!.lines.some((l) => l.startsWith('Session retest.'))).toBe(true);
    const after = await s.coach.state();
    expect(after.session).toBeNull();
    expect(after.followup).toMatchObject({ due: false });
    expect(after.progress).toMatchObject({ coachingStarted: true, baseline: { n: 3, wpm: 92 } });
  });

  it('keeps the benchmark profile and periods under the user\'s control', async () => {
    const s = setup();
    for (const [w, a] of [[80, 97], [82, 98], [78, 96]]) await s.coach.testFinished(s.normal(w, a));
    const key = profileKey({ mode: 'time', mode2: '30', language: 'english', punctuation: false, numbers: false, modifiers: [], layout: 'qwerty' });
    await s.coach.benchmark30();
    expect(s.loaded.at(-1)).toMatchObject({ mode: 'time', mode2: '30' });
    s.coach.setBenchmark(key);
    expect((await s.coach.state()).benchmark).toMatchObject({ key, tests: 0 });
    await s.coach.startSession('quick');
    await s.coach.testFinished(s.drill());
    expect((await s.coach.state()).progress!.coachingStarted).toBe(true);
    s.coach.resetPeriod();
    expect((await s.coach.state()).progress!.coachingStarted).toBe(false);
  });

  it('uses only tuning from one place', () => {
    expect(withTuning({ accuracyFloor: 0.95 }).accuracyFloor).toBe(0.95);
    expect(withTuning({ bogus: 1 } as never)).not.toHaveProperty('bogus');
    expect(TUNING.accuracyFloor).toBe(0.97);
  });
});
