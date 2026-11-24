// Per-test derived statistics: first-attempt accuracy and clean press-to-press timing for every
// pattern the test exercised. Pure; stored per test with STATS_VERSION and recomputed when it changes.
import { TUNING, type Tuning } from './tuning';
import { KS_UNTIMED, type ItemAcc, type Keystroke, type TestStats } from './types';
import { median } from './util';

export const STATS_VERSION = 1;

/** Pattern ids an expected character counts toward (attempts and errors). */
function countIds(expected: string): string[] {
  if (expected === ' ') return ['x:space'];
  if (/^[a-z]$/.test(expected)) return [`k:${expected}`];
  if (/^[A-Z]$/.test(expected)) return [`k:${expected.toLowerCase()}`, 'x:shift'];
  if (/^[0-9]$/.test(expected)) return ['x:digit'];
  return [`p:${expected}`];
}

/** The pattern that owns the timing of an in-word keystroke (a capital's time is Shift's, not the letter's). */
function timingId(expected: string): string {
  if (/^[A-Z]$/.test(expected)) return 'x:shift';
  return countIds(expected)[0];
}

const isLetter = (c: string | null): c is string => c !== null && /^[a-zA-Z]$/.test(c);

/** Caret positions replayed from per-word input buffers, for old data recorded without `pos`. */
export function reconstructPositions(ks: Keystroke[]): (number | null)[] {
  const buf = new Map<number, number>();
  return ks.map((k) => {
    const len = buf.get(k.wordIndex) ?? 0;
    if (k.key === 'Backspace') {
      if (len > 0) buf.set(k.wordIndex, len - 1);
      return null;
    }
    if (k.key === ' ') return len; // Space commits the word; it never enters the buffer
    buf.set(k.wordIndex, len + 1);
    return len;
  });
}

function positionsOf(ks: Keystroke[]): (number | null)[] {
  const recorded = ks.every((k) => k.key === 'Backspace' || typeof k.pos === 'number');
  return recorded ? ks.map((k) => (k.key === 'Backspace' ? null : (k.pos as number))) : reconstructPositions(ks);
}

export function deriveStats(test: { words: string[]; keystrokes: Keystroke[] }, tuning: Tuning = TUNING): TestStats {
  const ks = test.keystrokes;
  const pos = positionsOf(ks);
  const items: Record<string, ItemAcc> = {};
  const slot = (id: string) => (items[id] ??= { a: 0, e: 0, s: [] });
  const attempted = new Map<number, Set<number>>();
  const first: boolean[] = new Array(ks.length).fill(false);
  const afterSpace: boolean[] = new Array(ks.length).fill(false);
  const firstTry = { a: 0, e: 0 };

  // 1. First attempts: only the first keystroke at each caret position of each word counts.
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    const p = pos[i];
    if (k.key === 'Backspace' || k.expected === null || p === null) continue;
    let seen = attempted.get(k.wordIndex);
    if (!seen) attempted.set(k.wordIndex, (seen = new Set()));
    if (seen.has(p)) continue;
    seen.add(p);
    first[i] = true;
    firstTry.a++;
    if (!k.correct) firstTry.e++;
    for (const id of countIds(k.expected)) {
      const s = slot(id);
      s.a++;
      if (!k.correct) s.e++;
    }
    const prev = ks[i - 1];
    if (p === 0 && prev && prev.key === ' ' && prev.correct && prev.wordIndex === k.wordIndex - 1) {
      afterSpace[i] = true;
      const s = slot('x:start');
      s.a++;
      if (!k.correct) s.e++;
    }
  }

  // 2. Clean transitions: both keys correct first attempts, nothing in between, no repeat/blur/IME flag, no pause.
  const gap: (number | null)[] = ks.map((k, i) => {
    const prev = ks[i - 1];
    if (!prev || !first[i] || !first[i - 1] || !k.correct || !prev.correct) return null;
    if ((k.flags ?? 0) & KS_UNTIMED) return null;
    const g = k.t - prev.t;
    return g > 0 && g <= tuning.pauseMs ? Math.round(g) : null;
  });

  const inWordGaps: number[] = [];
  for (let i = 0; i < ks.length; i++) {
    const g = gap[i];
    const expected = ks[i].expected;
    if (g === null || expected === null) continue;
    if (afterSpace[i]) slot('x:start').s.push(g);
    else if (expected === ' ') slot('x:space').s.push(g);
    else {
      slot(timingId(expected)).s.push(g);
      if (isLetter(expected) && isLetter(ks[i - 1].expected)) inWordGaps.push(g);
    }
  }

  // 3. Letter sequences inside a word (case-insensitive): bigrams and trigrams.
  for (let i = 1; i < ks.length; i++) {
    const k = ks[i];
    const prev = ks[i - 1];
    if (!first[i] || !isLetter(k.expected) || pos[i] === null) continue;
    if (!first[i - 1] || !prev.correct || !isLetter(prev.expected) || prev.wordIndex !== k.wordIndex || pos[i - 1] !== pos[i]! - 1) continue;
    const bi = slot(`b:${prev.expected.toLowerCase()}${k.expected.toLowerCase()}`);
    bi.a++;
    if (!k.correct) bi.e++;
    else if (gap[i] !== null) bi.s.push(gap[i]!);

    const pp = ks[i - 2];
    if (!pp || !first[i - 2] || !pp.correct || !isLetter(pp.expected) || pp.wordIndex !== k.wordIndex || pos[i - 2] !== pos[i]! - 2) continue;
    const tri = slot(`t:${pp.expected.toLowerCase()}${prev.expected.toLowerCase()}${k.expected.toLowerCase()}`);
    tri.a++;
    if (!k.correct) tri.e++;
    else if (gap[i] !== null && gap[i - 1] !== null) tri.s.push(Math.round((gap[i]! + gap[i - 1]!) / 2));
  }

  // 4. Words: error rate per occurrence, ms per character of clean occurrences, stalls.
  const medianGap = median(inWordGaps);
  const stallAt = Math.max(tuning.stallMinMs, tuning.stallFactor * (medianGap ?? 150));
  const stalls: Record<string, number> = {};
  const byWord = new Map<number, number[]>();
  ks.forEach((k, i) => {
    const list = byWord.get(k.wordIndex);
    if (list) list.push(i);
    else byWord.set(k.wordIndex, [i]);
  });
  for (const [w, idx] of byWord) {
    const target = test.words[w];
    const word = target?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
    if (word.length < 3) continue;
    const body = idx.filter((i) => !(ks[i].key === ' ' && ks[i].correct));
    if (body.length === 0) continue;
    const id = `w:${word}`;
    const s = slot(id);
    s.a++;
    const hadError = idx.some((i) => ks[i].key !== 'Backspace' && ks[i].expected !== ' ' && (ks[i].expected === null || (first[i] && !ks[i].correct)));
    if (hadError) s.e++;
    const before = idx[0] > 0 ? ks[idx[0] - 1] : undefined;
    const start = before ? before.t : ks[body[0]].t;
    const chars = before ? target.length : target.length - 1;
    let last = start;
    let maxGap = 0;
    let interrupted = false;
    for (const i of body) {
      const g = ks[i].t - last;
      maxGap = Math.max(maxGap, g);
      if (g > tuning.pauseMs || (ks[i].flags ?? 0) & KS_UNTIMED) interrupted = true;
      last = ks[i].t;
    }
    if (!interrupted && !hadError && last > start && chars > 0) s.s.push(Math.round((last - start) / chars));
    if (maxGap > stallAt && maxGap <= tuning.pauseMs * 2.5) stalls[id] = (stalls[id] ?? 0) + 1;
  }

  // 5. Fading: is the end of the run slower than its start?
  let fade: number | null = null;
  if (inWordGaps.length >= 30) {
    const third = Math.floor(inWordGaps.length / 3);
    const head = median(inWordGaps.slice(0, third));
    const tail = median(inWordGaps.slice(-third));
    if (head && tail) fade = Math.round((tail / head) * 1000) / 1000;
  }

  return { v: STATS_VERSION, items, stalls, medianGap, firstTry, fade, chars: firstTry.a };
}

/** First-attempt accuracy and clean speed on some patterns within one test (drill evaluation). */
export function outcomeOn(stats: TestStats, ids: string[]): { attempts: number; errors: number; accuracy: number | null; ms: number | null } {
  let attempts = 0;
  let errors = 0;
  const samples: number[] = [];
  for (const id of ids) {
    const it = stats.items[id];
    if (!it) continue;
    attempts += it.a;
    errors += it.e;
    samples.push(...it.s);
  }
  return { attempts, errors, accuracy: attempts > 0 ? 1 - errors / attempts : null, ms: median(samples) };
}

/** Words of one test worth reviewing: missed on the first try, stalled on, or clearly slow. */
export function reviewWords(test: { words: string[] }, stats: TestStats, limit = 8): string[] {
  const wordMs = Object.entries(stats.items)
    .filter(([id, it]) => id.startsWith('w:') && it.s.length > 0)
    .map(([, it]) => median(it.s)!);
  const typical = median(wordMs);
  const scored: { word: string; score: number }[] = [];
  for (const [id, it] of Object.entries(stats.items)) {
    if (!id.startsWith('w:')) continue;
    const word = id.slice(2);
    const ms = median(it.s);
    const slow = typical !== null && ms !== null && ms > typical * 1.35;
    const score = it.e * 3 + (stats.stalls[id] ?? 0) * 2 + (slow ? 1 : 0);
    if (score > 0) scored.push({ word, score });
  }
  return scored.sort((a, b) => b.score - a.score || (a.word < b.word ? -1 : 1)).slice(0, limit).map((s) => s.word);
}
