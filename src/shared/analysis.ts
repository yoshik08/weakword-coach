// Pure analysis: turns captured keystrokes into per-key, per-bigram and per-word speed/accuracy stats.
import type { Analysis, ItemStat, StoredTest, TestSource, TrendPoint } from './types';

/** A gap longer than this is a pause (distraction), not typing speed. */
export const PAUSE_MS = 2000;

export interface AnalyzeOptions {
  targetWpm: number;
  /** Minimum attempts for a key to appear in `keys` (default 10). */
  minKeyAttempts?: number;
  /** Minimum attempts for a bigram (default 6). */
  minBigramAttempts?: number;
  /** Minimum occurrences for a word (default 2). */
  minWordAttempts?: number;
  /** Use only the newest N tests of the source (default 50). */
  maxTests?: number;
}

/** Running totals for one key, bigram or word. */
interface Acc {
  attempts: number;
  errors: number;
  /** errorRate denominator: attempts for keys and bigrams, letters typed for words. */
  total: number;
  /** ms per character, one per timed sample. */
  samples: number[];
}

const timed = (gap: number) => gap > 0 && gap <= PAUSE_MS;

/** Lowercased a-z letter, or null for anything else. */
function letter(c: string | null): string | null {
  const lower = c?.toLowerCase() ?? '';
  return /^[a-z]$/.test(lower) ? lower : null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function slot(map: Map<string, Acc>, item: string): Acc {
  let acc = map.get(item);
  if (!acc) map.set(item, (acc = { attempts: 0, errors: 0, total: 0, samples: [] }));
  return acc;
}

/** ms since the previous keystroke if keystroke i is a correct, timed follow-on to a correct one; else null. */
function keySample(ks: StoredTest['keystrokes'], i: number): number | null {
  const gap = i > 0 ? ks[i].t - ks[i - 1].t : 0;
  return ks[i].correct && ks[i - 1]?.correct && timed(gap) ? gap : null;
}

function addKeysAndBigrams(test: StoredTest, keys: Map<string, Acc>, bigrams: Map<string, Acc>): void {
  const ks = test.keystrokes;
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    const p = i > 0 ? ks[i - 1] : undefined;
    const key = letter(k.expected);
    if (!key) continue;

    const a = slot(keys, key);
    a.attempts++;
    a.total++;
    const sample = keySample(ks, i);
    if (!k.correct) a.errors++;
    else if (sample !== null) a.samples.push(sample);

    // p.correct implies p is a real key (never Backspace) typed as expected.
    const pl = p?.correct && p.wordIndex === k.wordIndex ? letter(p.expected) : null;
    if (p && pl) {
      const b = slot(bigrams, pl + key);
      b.attempts++;
      b.total++;
      if (!k.correct) b.errors++;
      else if (timed(k.t - p.t)) b.samples.push(k.t - p.t);
    }
  }
}

function addWords(test: StoredTest, words: Map<string, Acc>): void {
  const ks = test.keystrokes;
  const byWord = new Map<number, number[]>(); // wordIndex -> keystroke indices, in order
  ks.forEach((k, i) => byWord.set(k.wordIndex, [...(byWord.get(k.wordIndex) ?? []), i]));

  for (const [wordIndex, indices] of byWord) {
    const word = test.words[wordIndex]?.toLowerCase();
    if (!word || word.length < 3) continue;
    const typed = indices.map((i) => ks[i]);
    const body = typed.filter((k) => !(k.key === ' ' && k.correct)); // drop the committing Space
    if (body.length === 0) continue;

    const a = slot(words, word);
    a.attempts++;
    a.total += typed.filter((k) => k.key !== 'Backspace' && k.expected !== ' ').length;
    a.errors += typed.filter((k) => k.key !== 'Backspace' && !k.correct).length;

    // The clock starts at the key before the word (normally the previous word's Space).
    const before = indices[0] > 0 ? ks[indices[0] - 1] : undefined;
    const start = before ? before.t : body[0].t;
    const chars = before ? word.length : word.length - 1;
    const end = body[body.length - 1].t;
    let last = start;
    let paused = false;
    for (const k of body) {
      if (k.t - last > PAUSE_MS) paused = true;
      last = k.t;
    }
    if (!paused && end > start) a.samples.push((end - start) / chars);
  }
}

function toStat(item: string, a: Acc, targetMs: number): ItemStat {
  const errorRate = a.total > 0 ? a.errors / a.total : 0;
  const msPerChar = a.samples.length > 0 ? median(a.samples) : 2 * targetMs;
  const weakness = (msPerChar / targetMs) * (1 + 4 * errorRate);
  return {
    item,
    attempts: a.attempts,
    errors: a.errors,
    errorRate,
    msPerChar,
    wpm: 12000 / msPerChar,
    confidence: 1 / weakness,
    weakness,
  };
}

function ranked(map: Map<string, Acc>, min: number, targetMs: number): ItemStat[] {
  return [...map]
    .filter(([, a]) => a.attempts >= min)
    .map(([item, a]) => toStat(item, a, targetMs))
    .sort((x, y) => y.weakness - x.weakness || y.attempts - x.attempts || (x.item < y.item ? -1 : x.item > y.item ? 1 : 0));
}

export function analyze(tests: StoredTest[], source: TestSource, opts: AnalyzeOptions): Analysis {
  const { targetWpm, minKeyAttempts = 10, minBigramAttempts = 6, minWordAttempts = 2, maxTests = 50 } = opts;
  const targetMs = 12000 / targetWpm;
  const used = tests
    .filter((t) => t.source === source)
    .sort((a, b) => b.endedAt - a.endedAt || b.id - a.id)
    .slice(0, maxTests);

  const keys = new Map<string, Acc>();
  const bigrams = new Map<string, Acc>();
  const words = new Map<string, Acc>();
  for (const test of used) {
    addKeysAndBigrams(test, keys, bigrams);
    addWords(test, words);
  }

  return {
    source,
    targetWpm,
    testCount: used.length,
    keys: ranked(keys, minKeyAttempts, targetMs),
    bigrams: ranked(bigrams, minBigramAttempts, targetMs),
    words: ranked(words, minWordAttempts, targetMs),
    allKeys: ranked(keys, 1, targetMs),
  };
}

/** Newest 50 tests of both sources, oldest first: Monkeytype's wpm and the speed on the focus keys. */
export function trend(tests: StoredTest[], focusKeys: string[], maxTests = 50): TrendPoint[] {
  return [...tests]
    .sort((a, b) => b.endedAt - a.endedAt || b.id - a.id)
    .slice(0, maxTests)
    .reverse()
    .map((t) => {
      const samples: number[] = [];
      t.keystrokes.forEach((k, i) => {
        const sample = keySample(t.keystrokes, i);
        const key = letter(k.expected);
        if (sample !== null && key && focusKeys.includes(key)) samples.push(sample);
      });
      return {
        testId: t.id,
        endedAt: t.endedAt,
        source: t.source,
        wpm: t.result.wpm,
        weakSpotWpm: samples.length > 0 ? 12000 / median(samples) : null,
      };
    });
}

/** Median wpm of the newest 10 tests that have one; 40 when there are none; clamped to 20..250. */
export function deriveTargetWpm(tests: StoredTest[]): number {
  const wpms = tests
    .filter((t) => t.result.wpm !== null)
    .sort((a, b) => b.endedAt - a.endedAt || b.id - a.id)
    .slice(0, 10)
    .map((t) => t.result.wpm as number);
  if (wpms.length === 0) return 40;
  return Math.min(250, Math.max(20, Math.round(median(wpms))));
}
