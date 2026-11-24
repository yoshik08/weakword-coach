// Measured progress on ordinary tests: frozen baselines, fair comparisons, the result-screen row,
// skill transfer and the progress chart. Only eligible ordinary tests ever feed these numbers.
import { kindOfId, labelOf, type DiagnosisInput } from './diagnose';
import { TUNING, type Tuning } from './tuning';
import type { BaselineView, ResultRowView, RowAction, RowMetric, TestKind, TransferView, TrendPoint } from './types';
import { median, signed } from './util';

export interface ScoredTest {
  id: number;
  endedAt: number;
  kind: TestKind;
  eligible: boolean;
  reason: string | null;
  profileKey: string | null;
  corpusVersion: string | null;
  wpm: number | null;
  acc: number | null;
}

export interface PeriodInfo {
  id: number;
  startedAt: number;
  firstDrillAt: number | null;
}

export interface BaselineRecord {
  periodId: number;
  profileKey: string;
  kind: 'pre-coach' | 'fresh';
  createdAt: number;
  frozenAt: number | null;
  testIds: number[];
  wpm: number | null;
  acc: number | null;
  corpusVersion: string | null;
}

const isScore = (t: ScoredTest) => t.kind === 'normal' && t.eligible && t.wpm !== null && t.acc !== null;
const byTime = (a: ScoredTest, b: ScoredTest) => a.endedAt - b.endedAt || a.id - b.id;
const versionsMatch = (a: string | null, b: string | null) => !a || !b || a === b;

function summarise(members: ScoredTest[]): Pick<BaselineRecord, 'testIds' | 'wpm' | 'acc' | 'corpusVersion'> {
  return {
    testIds: members.map((t) => t.id),
    wpm: median(members.map((t) => t.wpm as number)),
    acc: median(members.map((t) => t.acc as number)),
    corpusVersion: members.length ? members[members.length - 1].corpusVersion : null,
  };
}

/** The newest `n` eligible tests of a profile that ended before `cutoff` (oldest first). */
export function recentBefore(tests: ScoredTest[], profileKey: string, cutoff: number, n: number): ScoredTest[] {
  return tests.filter((t) => isScore(t) && t.profileKey === profileKey && t.endedAt < cutoff).sort(byTime).slice(-n);
}

/**
 * The baseline of a profile in a period. Before the first drill it is rolling (not frozen). After the
 * first drill a stored record wins; otherwise the pre-Coach tests are frozen now (`freeze` is set so the
 * caller stores them). A fresh baseline collects the first `n` eligible tests from its creation.
 */
export function resolveBaseline(
  tests: ScoredTest[],
  profileKey: string,
  period: PeriodInfo,
  stored: BaselineRecord | null,
  tuning: Tuning = TUNING,
): { record: BaselineRecord | null; freeze: boolean } {
  const n = tuning.baselineTests;
  if (period.firstDrillAt === null) {
    const members = recentBefore(tests, profileKey, Infinity, n);
    if (members.length === 0) return { record: null, freeze: false };
    return { record: { periodId: period.id, profileKey, kind: 'pre-coach', createdAt: period.startedAt, frozenAt: null, ...summarise(members) }, freeze: false };
  }
  if (stored?.frozenAt) return { record: stored, freeze: false };
  if (stored?.kind === 'fresh') {
    const members = tests.filter((t) => isScore(t) && t.profileKey === profileKey && t.endedAt >= stored.createdAt).sort(byTime).slice(0, n);
    const record: BaselineRecord = { ...stored, ...summarise(members) };
    if (members.length >= n) return { record: { ...record, frozenAt: members[members.length - 1].endedAt }, freeze: true };
    return { record, freeze: false };
  }
  const members = recentBefore(tests, profileKey, period.firstDrillAt, n);
  if (members.length === 0) return { record: null, freeze: false };
  return {
    record: { periodId: period.id, profileKey, kind: 'pre-coach', createdAt: period.startedAt, frozenAt: period.firstDrillAt, ...summarise(members) },
    freeze: true,
  };
}

/** Eligible tests of the profile after coaching began that are not baseline members (oldest first). */
export function postTests(tests: ScoredTest[], baseline: BaselineRecord, period: PeriodInfo): ScoredTest[] {
  if (period.firstDrillAt === null) return [];
  const members = new Set(baseline.testIds);
  const from = baseline.kind === 'fresh' ? baseline.createdAt : period.firstDrillAt;
  return tests
    .filter((t) => isScore(t) && t.profileKey === baseline.profileKey && t.endedAt >= from && !members.has(t.id) && versionsMatch(t.corpusVersion, baseline.corpusVersion))
    .sort(byTime);
}

export function baselineView(b: BaselineRecord, tuning: Tuning = TUNING): BaselineView {
  return {
    kind: b.kind, wpm: b.wpm, acc: b.acc, n: b.testIds.length, need: tuning.baselineTests,
    frozen: b.frozenAt !== null, frozenAt: b.frozenAt, createdAt: b.createdAt,
  };
}

const fmtWpm = (v: number) => (Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(Math.abs(v) < 10 ? 1 : 0));
const fmtAcc = (v: number) => `${v.toFixed(1)}%`;
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const wpmDelta = (d: number) => signed(d, Math.abs(d) < 1 && d !== 0 ? 1 : 0);
const tone = (d: number, eps: number): RowMetric['tone'] => (d > eps ? 'up' : d < -eps ? 'down' : 'flat');

export interface RowContext {
  clientId: string;
  test: ScoredTest;
  profileLabel: string;
  period: PeriodInfo;
  baseline: BaselineRecord | null;
  /** True when a stored baseline exists but its word list differs from this test's. */
  versionChanged?: boolean;
  /** All scored tests (for post-coaching windows). */
  tests: ScoredTest[];
  followup?: { days: number; retestDelta: number | null } | null;
  sessionRetest?: boolean;
  extraLines?: string[];
  actions?: RowAction[];
  tuning?: Tuning;
}

/** The Coach row shown under Monkeytype's wpm and acc for an ordinary test. */
export function progressRow(ctx: RowContext): ResultRowView {
  const tuning = ctx.tuning ?? TUNING;
  const { test, baseline, period } = ctx;
  const actions = ctx.actions ?? [];
  const extra = ctx.extraLines ?? [];
  const base = { clientId: ctx.clientId, actions, data: {} as Record<string, string> };

  if (!isScore(test)) {
    return { ...base, kind: 'not-counted', heading: 'Not counted', metrics: [], lines: [`This test is not compared with your baseline: ${test.reason ?? 'not an ordinary test'}.`, ...extra], data: { reason: test.reason ?? '' } };
  }

  const need = tuning.baselineTests;
  if (period.firstDrillAt === null) {
    const n = baseline?.testIds.length ?? 0;
    if (n < need) {
      return {
        ...base, kind: 'calibrating', heading: `Baseline ${n}/${need} complete`, metrics: [],
        lines: [`${ctx.profileLabel}: your baseline is the median of your last ${need} tests before your first drill.`, ...extra],
        data: { done: String(n), need: String(need) },
      };
    }
    return {
      ...base, kind: 'calibrating', heading: 'Baseline ready',
      metrics: [
        { id: 'wpm', value: fmtWpm(baseline!.wpm!), delta: null, tone: null, caption: 'wpm' },
        { id: 'acc', value: fmtAcc(baseline!.acc!), delta: null, tone: null, caption: 'accuracy' },
      ],
      lines: [`Median of your last ${need} ${ctx.profileLabel} tests. It freezes when you start practicing.`, ...extra],
      data: { done: String(n), need: String(need) },
    };
  }

  if (!baseline || ctx.versionChanged) {
    const why = ctx.versionChanged
      ? `Monkeytype's word list for ${ctx.profileLabel} changed since your baseline, so these runs need their own.`
      : `No tests in ${ctx.profileLabel} from before coaching began, so there is nothing fair to compare with.`;
    return {
      ...base, kind: 'no-baseline', heading: 'No baseline for this mode', metrics: [], lines: [why, ...extra],
      actions: [{ id: 'start-baseline', label: 'Start a baseline for this mode' }, ...actions],
      data: { reason: ctx.versionChanged ? 'version' : 'new-mode' },
    };
  }

  if (baseline.testIds.includes(test.id) || baseline.testIds.length < (baseline.kind === 'fresh' && !baseline.frozenAt ? need : 1)) {
    const n = baseline.testIds.length;
    return {
      ...base, kind: 'calibrating', heading: `Baseline ${Math.min(n, need)}/${need} complete`, metrics: [],
      lines: [`A new baseline for ${ctx.profileLabel}, from ${day(baseline.createdAt)}. Comparisons start after ${need} tests.`, ...extra],
      data: { done: String(n), need: String(need), fresh: '1' },
    };
  }

  const post = postTests(ctx.tests, baseline, period);
  const upTo = post.filter((t) => byTime(t, test) <= 0);
  const n = upTo.length;
  const windowed = n >= tuning.postWindow;
  const win = windowed ? upTo.slice(-tuning.postWindow) : [test];
  const wpm = windowed ? median(win.map((t) => t.wpm!))! : test.wpm!;
  const acc = windowed ? median(win.map((t) => t.acc!))! : test.acc!;
  const dWpm = wpm - baseline.wpm!;
  const dAcc = acc - baseline.acc!;
  const versus = baseline.kind === 'pre-coach' ? 'vs pre-Coach' : `vs baseline (${day(baseline.createdAt)})`;
  const metrics: RowMetric[] = [
    { id: 'wpm', value: fmtWpm(wpm), delta: wpmDelta(dWpm), tone: tone(dWpm, 0.5), caption: `wpm ${versus}` },
    { id: 'acc', value: fmtAcc(acc), delta: `${signed(dAcc, 1)} pp`, tone: tone(dAcc, 0.05), caption: 'accuracy' },
  ];
  const lines: string[] = [];
  if (windowed) lines.push(`Median of your last ${tuning.postWindow} ${ctx.profileLabel} tests · ${n} since coaching began. This run: ${fmtWpm(test.wpm!)} wpm, ${fmtAcc(test.acc!)}.`);
  else lines.push(`${n === 1 ? 'One run' : `${n} runs`} since coaching began. From ${tuning.postWindow} runs on, this shows their median.`);
  const bn = baseline.testIds.length;
  lines.push(`${baseline.kind === 'pre-coach' ? 'Pre-Coach baseline' : 'Baseline'}: ${fmtWpm(baseline.wpm!)} wpm, ${fmtAcc(baseline.acc!)}, median of ${bn} ${bn === 1 ? 'test' : 'tests'}${bn < need ? ` (only ${bn} before coaching)` : ''}.`);
  if (dWpm > 0.5 && dAcc < -0.05) lines.push('Faster than your baseline, but less accurate.');
  else if (dWpm < -0.5 && dAcc > 0.05) lines.push('More accurate than your baseline, but slower.');
  if (ctx.followup) {
    const was = ctx.followup.retestDelta === null ? '' : ` (the retest right after was ${wpmDelta(ctx.followup.retestDelta)})`;
    lines.push(`Follow-up ${ctx.followup.days === 1 ? 'a day' : `${ctx.followup.days} days`} after your session: ${wpmDelta(test.wpm! - baseline.wpm!)} wpm ${versus}${was}.`);
  }
  if (ctx.sessionRetest) lines.push('Session retest. A follow-up test tomorrow shows whether the change holds.');
  lines.push(...extra);
  return {
    ...base, kind: 'compare', heading: windowed ? `Since coaching, last ${tuning.postWindow} tests` : 'Since coaching', metrics, lines,
    data: {
      dwpm: dWpm.toFixed(1), dacc: dAcc.toFixed(2), n: String(n), window: windowed ? String(tuning.postWindow) : '1',
      baselineWpm: String(baseline.wpm), baselineAcc: String(baseline.acc), baselineN: String(bn), versus,
    },
  };
}

// Skill transfer: trained patterns in ordinary tests before vs after coaching began.

function pool(tests: DiagnosisInput[], id: string) {
  let a = 0;
  let e = 0;
  let runs = 0;
  const s: number[] = [];
  for (const t of tests) {
    const it = t.stats.items[id];
    if (!it || it.a === 0) continue;
    a += it.a;
    e += it.e;
    runs++;
    s.push(...it.s);
  }
  return { a, e, runs, ms: median(s) };
}

export function transfer(trained: { id: string; problem: 'accuracy' | 'speed' }[], before: DiagnosisInput[], after: DiagnosisInput[], tuning: Tuning = TUNING): TransferView[] {
  return trained.map(({ id, problem }) => {
    const [b, a] = [pool(before, id), pool(after, id)];
    const enough = (p: ReturnType<typeof pool>) => p.a >= tuning.minAttempts && p.runs >= tuning.minRuns;
    const metric = problem === 'accuracy' || kindOfId(id) === 'word' ? 'missed' : 'ms';
    const value = (p: ReturnType<typeof pool>) => (metric === 'missed' ? (p.a ? p.e / p.a : null) : p.ms);
    return { id, label: labelOf(id), metric, before: value(b), after: value(a), learning: !(enough(b) && enough(a)) };
  });
}

// Progress chart.

export function trendPoints(
  tests: { id: number; endedAt: number; kind: TestKind; wpm: number | null; eligible: boolean; stats: DiagnosisInput['stats'] | null }[],
  targetIds: string[],
  max = 50,
): TrendPoint[] {
  return tests
    .filter((t) => (t.kind === 'normal' && t.eligible) || t.kind === 'drill')
    .sort((a, b) => a.endedAt - b.endedAt || a.id - b.id)
    .slice(-max)
    .map((t) => {
      const s = t.stats ? targetIds.flatMap((id) => t.stats!.items[id]?.s ?? []) : [];
      const m = median(s);
      return { testId: t.id, endedAt: t.endedAt, kind: t.kind, wpm: t.wpm, targetWpm: m ? 12000 / m : null };
    });
}

/** Most frequent profile among the last 20 eligible ordinary tests (ties: the most recent). */
export function usualProfile(tests: ScoredTest[]): string | null {
  const recent = tests.filter(isScore).sort(byTime).slice(-20);
  const counts = new Map<string, { n: number; last: number }>();
  for (const t of recent) {
    const c = counts.get(t.profileKey!) ?? { n: 0, last: 0 };
    counts.set(t.profileKey!, { n: c.n + 1, last: Math.max(c.last, t.endedAt) });
  }
  let best: string | null = null;
  for (const [k, c] of counts) {
    const b = best ? counts.get(best)! : null;
    if (!b || c.n > b.n || (c.n === b.n && c.last > b.last)) best = k;
  }
  return best;
}

/** The typist's own clean pace: median wpm of recent accurate ordinary tests. */
export function cleanPace(tests: ScoredTest[]): number | null {
  const recent = tests.filter(isScore).sort(byTime).slice(-10);
  const clean = recent.filter((t) => (t.acc ?? 0) >= 95);
  return median((clean.length >= 2 ? clean : recent).map((t) => t.wpm as number));
}
