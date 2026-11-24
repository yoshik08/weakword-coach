// What actually costs the typist speed: aggregates recent ordinary tests of one language + layout,
// smooths sparse evidence toward the typist's own baseline and ranks patterns by
// corpus frequency x lag x reliability.
import type { CorpusFreq } from './corpus';
import { TUNING, type Tuning } from './tuning';
import type { Diagnosis, PatternKind, PatternStat, TestStats } from './types';
import { median, weightedMedian } from './util';

export interface DiagnosisInput {
  id: number;
  endedAt: number;
  stats: TestStats;
  wpm: number | null;
}

export function kindOfId(id: string): PatternKind {
  switch (id.slice(0, 2)) {
    case 'k:': return 'letter';
    case 'b:': return 'bigram';
    case 't:': return 'trigram';
    case 'w:': return 'word';
    case 'p:': return 'punct';
  }
  if (id === 'x:space') return 'space';
  if (id === 'x:start') return 'start';
  if (id === 'x:shift') return 'shift';
  return 'digit';
}

export function labelOf(id: string): string {
  switch (id) {
    case 'x:space': return 'space';
    case 'x:start': return 'word starts';
    case 'x:shift': return 'capitals';
    case 'x:digit': return 'numbers';
  }
  return id.slice(2);
}

interface Agg {
  a: number;
  e: number;
  wa: number;
  we: number;
  samples: { v: number; w: number }[];
  runs: number;
  stalls: number;
}

const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`;
const ms = (v: number) => `${Math.round(v)} ms`;

function explain(s: Omit<PatternStat, 'explanation'>, tuning: Tuning): string {
  const { label, kind } = s;
  if (s.status === 'learning') {
    const runs = s.runs < tuning.minRuns ? `, ${s.runs} of ${tuning.minRuns} runs` : '';
    return `Learning: ${s.attempts} of ${tuning.minAttempts} tries${runs} so far.`;
  }
  if (s.status === 'ok') return 'In line with the rest of your typing.';
  if (s.problem === 'accuracy') {
    const usual = `(usually ${pct(s.baselineErrorRate)})`;
    switch (kind) {
      case 'letter': return `You miss ${label} often: ${pct(s.errorRate)} of first tries ${usual}.`;
      case 'bigram':
      case 'trigram': return `You often trip on ${label}: ${pct(s.errorRate)} missed ${usual}.`;
      case 'word': return `You often mistype "${label}": ${pct(s.errorRate)} of the times it came up.`;
      case 'space': return `You miss the space bar at ${pct(s.errorRate)} of word ends ${usual}.`;
      case 'start': return `The first letter of a word goes wrong ${pct(s.errorRate)} of the time ${usual}.`;
      case 'shift': return `Capitals go wrong ${pct(s.errorRate)} of the time ${usual}.`;
      case 'digit': return `Numbers go wrong ${pct(s.errorRate)} of the time ${usual}.`;
      default: return `"${label}" goes wrong ${pct(s.errorRate)} of the time ${usual}.`;
    }
  }
  const mine = s.ms ?? s.smoothedMs ?? 0;
  const base = s.baselineMs;
  switch (kind) {
    case 'letter': return `${label} is slow to reach: ${ms(mine)} vs your usual ${ms(base)}.`;
    case 'bigram': return `${label} is slower than your other common pairs: ${ms(mine)} vs ${ms(base)}.`;
    case 'trigram': return `${label} is slower than your other common sequences: ${ms(mine)} vs ${ms(base)} a key.`;
    case 'word': {
      const stall = s.stallRate && s.stallRate >= 0.2 ? `; you stall on it ${pct(s.stallRate)} of the time` : '';
      return `"${label}" slows you down: ${ms(mine)} a letter vs ${ms(base)}${stall}.`;
    }
    case 'space': return `You hesitate before spaces: ${ms(mine)} vs about ${ms(base)} expected from your pace.`;
    case 'start': return `You pause at word starts: ${ms(mine)} vs about ${ms(base)} expected from your pace.`;
    case 'shift': return `Capitals are slow: ${ms(mine)} each vs about ${ms(base)} expected from your pace.`;
    case 'digit': return `Numbers are slow: ${ms(mine)} a key vs about ${ms(base)} expected from your pace.`;
    default: return `"${label}" is slow: ${ms(mine)} vs about ${ms(base)} expected from your pace.`;
  }
}

export function emptyDiagnosis(scope = { language: 'english', layout: 'qwerty' }): Diagnosis {
  return {
    scope, testCount: 0, keystrokes: 0, baseline: { msPerKey: null, errorRate: 0, wpm: null },
    items: [], letters: [], sequences: [], words: [], boundaries: [], top: [], fading: false, sparse: true,
  };
}

export function diagnose(
  tests: DiagnosisInput[],
  opts: { corpus?: CorpusFreq | null; scope: { language: string; layout: string }; tuning?: Tuning },
): Diagnosis {
  const tuning = opts.tuning ?? TUNING;
  const used = [...tests].sort((a, b) => b.endedAt - a.endedAt || b.id - a.id).slice(0, tuning.recentTests);
  if (used.length === 0) return emptyDiagnosis(opts.scope);

  const agg = new Map<string, Agg>();
  let chars = 0;
  let firstA = 0;
  let firstE = 0;
  used.forEach((t, rank) => {
    const w = 0.5 ** (rank / tuning.halfLifeTests);
    chars += t.stats.chars;
    firstA += t.stats.firstTry.a * w;
    firstE += t.stats.firstTry.e * w;
    for (const [id, it] of Object.entries(t.stats.items)) {
      let g = agg.get(id);
      if (!g) agg.set(id, (g = { a: 0, e: 0, wa: 0, we: 0, samples: [], runs: 0, stalls: 0 }));
      g.a += it.a;
      g.e += it.e;
      g.wa += it.a * w;
      g.we += it.e * w;
      for (const v of it.s) g.samples.push({ v, w });
      if (it.a > 0) g.runs++;
      g.stalls += t.stats.stalls[id] ?? 0;
    }
  });

  // The typist's own baselines, per family of patterns.
  const family = (k: PatternKind) => (k === 'bigram' || k === 'trigram' || k === 'word' ? k : 'letter');
  const baseMs = new Map<string, number>();
  const baseErr = new Map<string, number>();
  const wpms = used.map((t) => t.wpm).filter((v): v is number => v !== null);
  const fallbackMs = wpms.length ? 12000 / (median(wpms)! * 1.15) : 200;
  for (const fam of ['letter', 'bigram', 'trigram', 'word']) {
    const members = [...agg].filter(([id]) => kindOfId(id) === fam);
    const samples = members.flatMap(([, g]) => g.samples);
    const wa = members.reduce((n, [, g]) => n + g.wa, 0);
    const we = members.reduce((n, [, g]) => n + g.we, 0);
    baseMs.set(fam, weightedMedian(samples) ?? (fam === 'word' ? fallbackMs * 1.1 : fallbackMs));
    baseErr.set(fam, wa > 0 ? we / wa : 0.03);
  }
  const keyMs = baseMs.get('letter')!;
  const allowance = tuning.boundaryAllowance as Record<string, number>;

  const items: PatternStat[] = [];
  for (const [id, g] of agg) {
    if (g.a === 0) continue;
    const kind = kindOfId(id);
    const fam = family(kind);
    const bMs = baseMs.get(fam)! * (allowance[kind] ?? 1);
    const bErr = baseErr.get(fam)!;
    const errorRate = g.wa > 0 ? g.we / g.wa : 0;
    const smoothedErrorRate = (g.we + tuning.errorPrior * bErr) / (g.wa + tuning.errorPrior);
    const robust = weightedMedian(g.samples);
    const n = g.samples.length;
    const smoothedMs = robust === null ? null : (n * robust + tuning.msPrior * bMs) / (n + tuning.msPrior);
    const len = kind === 'word' ? id.length - 2 : 1;
    const lagPerChar = smoothedMs === null ? 0 : Math.max(0, smoothedMs - bMs);
    const timeCost = lagPerChar * len;
    const errExcess = Math.max(0, smoothedErrorRate - bErr);
    const errCost = errExcess * tuning.errorCostKeys * keyMs;
    const costMs = timeCost + errCost;
    let frequency: number;
    if (!opts.corpus) frequency = chars > 0 ? (g.a / chars) * 100 : 0;
    else if (opts.corpus.perHundred.has(id)) frequency = opts.corpus.perHundred.get(id)!;
    else if (kind === 'punct' || kind === 'shift' || kind === 'digit') frequency = chars > 0 ? (g.a / chars) * 100 : 0;
    else frequency = 0; // Monkeytype's ordinary tests never show it
    const reliability = g.a / (g.a + tuning.reliabilityK);
    const impact = frequency * costMs * reliability;
    const learning = g.a < tuning.minAttempts || g.runs < tuning.minRuns;
    const lags = errExcess >= tuning.errorMargin || lagPerChar >= bMs * tuning.slowMargin;
    const status = learning ? 'learning' : impact >= tuning.weakImpactMin && lags ? 'weak' : 'ok';
    const base: Omit<PatternStat, 'explanation'> = {
      id, kind, label: labelOf(id),
      attempts: g.a, errors: g.e, runs: g.runs,
      errorRate, smoothedErrorRate,
      ms: robust, smoothedMs, samples: n,
      stallRate: kind === 'word' ? g.stalls / g.a : null,
      baselineMs: bMs, baselineErrorRate: bErr,
      frequency, costMs, impact, status,
      problem: costMs <= 0 ? null : errCost >= timeCost ? 'accuracy' : 'speed',
    };
    items.push({ ...base, explanation: explain(base, tuning) });
  }
  items.sort((x, y) => y.impact - x.impact || y.attempts - x.attempts || (x.id < y.id ? -1 : 1));

  const fades = used.map((t) => t.stats.fade).filter((v): v is number => v !== null);
  const of = (...kinds: PatternKind[]) => items.filter((s) => kinds.includes(s.kind));
  const top = items.filter((s) => s.status === 'weak');
  return {
    scope: opts.scope,
    testCount: used.length,
    keystrokes: chars,
    baseline: { msPerKey: keyMs, errorRate: firstA > 0 ? firstE / firstA : 0, wpm: median(wpms) },
    items,
    letters: of('letter'),
    sequences: of('bigram', 'trigram'),
    words: of('word'),
    boundaries: of('space', 'start', 'shift', 'digit', 'punct'),
    top,
    fading: fades.length >= 2 && median(fades)! >= tuning.fadeRatio,
    sparse: !items.some((s) => s.status !== 'learning'),
  };
}
