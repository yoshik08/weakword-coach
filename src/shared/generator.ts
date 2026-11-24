// Builds the words of one practice round. Pure and deterministic: the same spec (including seed)
// and word pools always give the same prompt.
import { TUNING, type Tuning } from './tuning';
import type { StepKind, Target } from './types';
import { mulberry32, separateNeighbours, shuffle } from './util';

export const GENERATOR_VERSION = 2;

export interface WordPools {
  /** The active corpus, most frequent first (e.g. Monkeytype's english list). */
  primary: string[];
  /** Larger lists for variety and as a fallback, smallest first. */
  wider: string[][];
}

export interface RoundSpec {
  kind: Exclude<StepKind, 'retest'>;
  targets: Pick<Target, 'id' | 'kind' | 'label'>[];
  words: number;
  seed: number;
  punctuation?: boolean;
  numbers?: boolean;
  /** Words used earlier in the session: mixed rounds use fresh ones. */
  exclude?: string[];
  /** Review rounds: the words to review. */
  review?: string[];
}

export interface Round {
  words: string[];
  /** Target id -> words in the round that exercise it. */
  targetHits: Record<string, number>;
}

interface Cand {
  word: string;
  rank: number;
}

type T = RoundSpec['targets'][number];

/** Lowercase a-z words, 2-12 letters, primary list first, then the wider lists. */
export function vocabulary(pools: WordPools): Cand[] {
  const seen = new Set<string>();
  const out: Cand[] = [];
  let offset = 0;
  for (const list of [pools.primary, ...pools.wider]) {
    list.forEach((raw, i) => {
      const w = raw.toLowerCase();
      if (!/^[a-z]{2,12}$/.test(w) || seen.has(w)) return;
      seen.add(w);
      out.push({ word: w, rank: offset + i });
    });
    offset += list.length;
  }
  return out;
}

/** The letters a target is about, or null for boundary targets that any word can carry. */
function patternOf(t: T): string | null {
  if (t.kind === 'letter' || t.kind === 'bigram' || t.kind === 'trigram') return t.label;
  return null;
}

function trigrams(w: string): Set<string> {
  const s = new Set<string>();
  for (let i = 2; i < w.length; i++) s.add(w.slice(i - 2, i + 1));
  return s;
}

export function exercises(t: T, word: string): boolean {
  const w = word.toLowerCase();
  const p = patternOf(t);
  if (p) return w.includes(p);
  if (t.kind === 'word') {
    if (w === t.label) return true;
    const own = trigrams(t.label);
    return [...trigrams(w)].some((g) => own.has(g));
  }
  if (t.kind === 'space' || t.kind === 'start') return w.length <= 4;
  if (t.kind === 'shift') return /^[A-Z]/.test(word);
  if (t.kind === 'digit') return /\d/.test(word);
  if (t.kind === 'punct') return word.includes(t.label);
  return false;
}

const count = (w: string, p: string) => w.split(p).length - 1;
const lengthClass = (w: string) => (w.length <= 4 ? 's' : w.length <= 7 ? 'm' : 'l');

/** Where the pattern sits (start/middle/end) and how long the word is: the axes of variety. */
function bucketOf(t: T, w: string): string {
  const p = patternOf(t);
  if (!p) return lengthClass(w);
  const i = w.indexOf(p);
  const where = i === 0 ? 'start' : i + p.length === w.length ? 'end' : 'mid';
  return `${where}-${lengthClass(w)}`;
}

/**
 * Draws n words round-robin across buckets so placement and length vary. Within a bucket the most
 * common unused word goes first; the horizon widens each pass, so repeats only happen in small
 * pools, and the repeat cap is raised only when the vocabulary cannot fill the round.
 */
function draw(cands: Cand[], n: number, rand: () => number, counts: Map<string, number>, cap: number, bucket: (w: string) => string): string[] {
  if (cands.length === 0 || n <= 0) return [];
  const groups = new Map<string, Cand[]>();
  for (const c of cands) {
    const k = bucket(c.word);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const queues = shuffle([...groups.keys()].sort(), rand).map((k) => groups.get(k)!);
  const out: string[] = [];
  let allowed = cap;
  for (let pass = 0; out.length < n && pass < n * 4 + 20; pass++) {
    let progressed = false;
    for (const q of queues) {
      if (out.length >= n) break;
      let best: Cand | undefined;
      for (const c of q.slice(0, 6 + pass * 6)) {
        const used = counts.get(c.word) ?? 0;
        if (used >= allowed) continue;
        if (!best || used < (counts.get(best.word) ?? 0)) best = c;
        if (used === 0) break;
      }
      if (!best) continue;
      counts.set(best.word, (counts.get(best.word) ?? 0) + 1);
      out.push(best.word);
      progressed = true;
    }
    if (!progressed && pass > 0) allowed++;
  }
  return out;
}

/** Monkeytype punctuation mode look: sentences of 5-9 words, capitalised, with commas and stops. */
export function sentences(words: string[], rand: () => number): string[] {
  const out: string[] = [];
  let left = 0;
  for (let i = 0; i < words.length; i++) {
    let w = words[i];
    if (left === 0) {
      left = 5 + Math.floor(rand() * 5);
      w = w.charAt(0).toUpperCase() + w.slice(1);
    }
    left--;
    const last = i === words.length - 1;
    if (!/[.,;:!?]$/.test(w)) {
      if (left === 0 || last) {
        const r = rand();
        w += r < 0.8 ? '.' : r < 0.9 ? '?' : '!';
      } else if (rand() < 0.15) w += ',';
    }
    out.push(w);
  }
  return out;
}

export function generateRound(spec: RoundSpec, pools: WordPools, tuning: Tuning = TUNING): Round {
  const rand = mulberry32(spec.seed);
  const vocab = vocabulary(pools);
  if (vocab.length === 0) throw new Error('No words to practice with.');
  const exclude = new Set(spec.exclude ?? []);
  const counts = new Map<string, number>();
  const cap = tuning.maxRepeats;
  const total = Math.max(1, spec.words);

  // Ordinary words: common words that avoid the targets where possible.
  const commonTop = vocab.filter((c) => c.rank < Math.min(200, pools.primary.length || 200));
  const ordinaryOf = (kind: RoundSpec['kind']) => {
    const pool = kind === 'warmup' ? commonTop.slice(0, 100) : commonTop;
    const plain = pool.filter((c) => !spec.targets.some((t) => patternOf(t) && exercises(t, c.word)));
    const fresh = (plain.length >= 20 ? plain : pool).filter((c) => kind !== 'mixed' || !exclude.has(c.word));
    return fresh.length >= 10 ? fresh : pool.length ? pool : vocab;
  };

  if (spec.kind === 'warmup' || (spec.targets.length === 0 && spec.kind !== 'review')) {
    const words = separateNeighbours(shuffle(draw(ordinaryOf('warmup'), total, rand, counts, 1, lengthClass), rand));
    return { words, targetHits: {} };
  }

  const fillerShare = spec.kind === 'quick' ? tuning.fillerShare.quick : tuning.fillerShare[spec.kind as keyof Tuning['fillerShare']] ?? 0.3;
  const targetSlots = Math.max(spec.targets.length, Math.round(total * (1 - fillerShare)));
  const targetWords: string[] = [];
  const boundary: { t: T; slots: number }[] = [];

  if (spec.kind === 'review' && spec.review?.length) {
    const review = spec.review.map((w) => w.toLowerCase()).filter((w) => /^[a-z]+$/.test(w));
    for (const w of review) for (let i = 0; i < Math.min(2, cap); i++) {
      targetWords.push(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const similar = vocab.filter((c) => !review.includes(c.word) && review.some((r) => [...trigrams(c.word)].some((g) => trigrams(r).has(g))));
    targetWords.push(...draw(similar, Math.max(0, targetSlots - targetWords.length), rand, counts, cap, lengthClass));
  } else {
    const per = spec.targets.map((_, i) => Math.floor(targetSlots / spec.targets.length) + (i < targetSlots % spec.targets.length ? 1 : 0));
    spec.targets.forEach((t, i) => {
      if (t.kind === 'shift' || t.kind === 'digit' || t.kind === 'punct') return boundary.push({ t, slots: per[i] });
      const p = patternOf(t);
      let cands = vocab.filter((c) => exercises(t, c.word) && !(spec.kind === 'mixed' && exclude.has(c.word)));
      if (cands.length < 4) cands = vocab.filter((c) => exercises(t, c.word));
      if (spec.kind === 'speed') {
        // Short words dense in the transition.
        const short = cands.filter((c) => c.word.length <= 6);
        cands = (short.length >= 6 ? short : cands).sort((a, b) => (p ? count(b.word, p) - count(a.word, p) : 0) || a.rank - b.rank);
      } else if (spec.kind === 'accuracy') {
        const easy = cands.filter((c) => c.word.length <= 7);
        cands = easy.length >= 8 ? easy : cands;
      }
      if (t.kind === 'word') {
        for (let k = 0; k < Math.min(cap, per[i]); k++) {
          targetWords.push(t.label);
          counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
        }
        cands = cands.filter((c) => c.word !== t.label);
        targetWords.push(...draw(cands, per[i] - Math.min(cap, per[i]), rand, counts, cap, lengthClass));
        return;
      }
      targetWords.push(...draw(cands, per[i], rand, counts, cap, (w) => bucketOf(t, w)));
    });
  }

  // Boundary targets ride on ordinary words: capitals, numbers, punctuation marks.
  for (const { t, slots } of boundary) {
    const carriers = draw(ordinaryOf(spec.kind), slots, rand, counts, cap, lengthClass);
    for (const w of carriers) {
      if (t.kind === 'shift') targetWords.push(w.charAt(0).toUpperCase() + w.slice(1));
      else if (t.kind === 'digit') targetWords.push(String(Math.floor(rand() * (rand() < 0.5 ? 100 : 10000))));
      else targetWords.push(`${w}${t.label}`);
    }
  }

  const fillers = draw(ordinaryOf(spec.kind), Math.max(0, total - targetWords.length), rand, counts, cap, lengthClass);
  let words = separateNeighbours(shuffle([...targetWords, ...fillers].slice(0, total), rand));
  if (spec.punctuation && (spec.kind === 'mixed' || spec.kind === 'review')) words = sentences(words, rand);
  if (spec.numbers && spec.kind === 'mixed' && !spec.targets.some((t) => t.kind === 'digit')) {
    words = words.map((w, i) => (i > 0 && i % 9 === 4 ? String(Math.floor(rand() * 1000)) : w));
  }

  const targetHits: Record<string, number> = {};
  for (const t of spec.targets) targetHits[t.id] = words.filter((w) => exercises(t, w)).length;
  return { words, targetHits };
}
