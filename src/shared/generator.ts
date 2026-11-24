// Generates a practice word list that targets the user's weakest keys, bigrams and words.
// Pure and deterministic: the same options (including seed) always give the same plan.

import type { Analysis, ItemStat, PracticePlan } from './types';

export interface GenerateOptions {
  /** The STANDARD-test analysis. */
  analysis: Analysis;
  /** Frequency-ordered candidate words. */
  wordList: string[];
  /** Frequency-ordered common words, used for the "normal" share. */
  commonWords: string[];
  length?: number;
  seed?: number;
  normalShare?: number;
}

const MAX_FOCUS_KEYS = 4;
const MAX_FOCUS_BIGRAMS = 4;
const MAX_FOCUS_WORDS = 3;
const MAX_REPEATS = 2;
const BIGRAM_BONUS = 1.5;

/** Small seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  word: string;
  weight: number;
}

export function generatePractice(opts: GenerateOptions): PracticePlan {
  const { analysis, wordList, commonWords } = opts;
  const length = opts.length ?? 30;
  const seed = opts.seed ?? 1;
  const normalShare = opts.normalShare ?? 0.25;
  const rand = mulberry32(seed);

  // 1. Focus selection.
  const weak = (list: ItemStat[]) => list.filter((s) => s.confidence < 1);
  let keyStats = weak(analysis.keys).slice(0, MAX_FOCUS_KEYS);
  if (keyStats.length < 2) keyStats = analysis.keys.slice(0, 2);
  const bigramStats = weak(analysis.bigrams).slice(0, MAX_FOCUS_BIGRAMS);
  if (keyStats.length === 0 && bigramStats.length === 0) {
    throw new Error('Not enough data yet: finish a few Monkeytype tests first.');
  }
  const focusKeys = keyStats.map((s) => s.item);
  const focusBigrams = bigramStats.map((s) => s.item);
  const focusItems = [...focusKeys, ...focusBigrams];
  const hasFocus = (word: string) => focusItems.some((f) => word.includes(f));
  const focusWords = weak(analysis.words)
    .filter((s) => hasFocus(s.item))
    .slice(0, MAX_FOCUS_WORDS)
    .map((s) => s.item);

  // 2. Candidates, weighted by how many weak items they exercise and how common they are.
  const normalise = (list: string[]) => {
    const seen = new Set<string>();
    const out: { word: string; rank: number }[] = [];
    list.forEach((raw, rank) => {
      const word = raw.toLowerCase();
      if (!/^[a-z]+$/.test(word) || word.length < 2 || word.length > 10 || seen.has(word)) return;
      seen.add(word);
      out.push({ word, rank });
    });
    return out;
  };
  const weakness = (stats: ItemStat[]) => new Map(stats.map((s) => [s.item, s.weakness]));
  const keyWeakness = weakness(keyStats);
  const bigramWeakness = weakness(bigramStats);
  const candidates: Candidate[] = [];
  for (const { word, rank } of normalise(wordList)) {
    let score = 0;
    let hit = false;
    for (const [k, w] of keyWeakness) if (word.includes(k)) {
        score += w;
        hit = true;
      }
    for (const [b, w] of bigramWeakness) if (word.includes(b)) {
        score += BIGRAM_BONUS * w;
        hit = true;
      }
    if (hit) candidates.push({ word, weight: score / (1 + rank / 1000) });
  }
  const normalPool = normalise(commonWords)
    .map((c) => c.word)
    .filter(hasFocus);

  // Draws n words from the pool, respecting the repeat cap unless the pool is too small.
  const counts = new Map<string, number>();
  const draw = (pool: Candidate[], n: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < n && pool.length > 0; i++) {
      let eligible = pool.filter((c) => (counts.get(c.word) ?? 0) < MAX_REPEATS);
      if (eligible.length === 0) eligible = pool;
      let r = rand() * eligible.reduce((sum, c) => sum + c.weight, 0);
      const pick = eligible.find((c) => (r -= c.weight) < 0) ?? eligible[eligible.length - 1];
      counts.set(pick.word, (counts.get(pick.word) ?? 0) + 1);
      out.push(pick.word);
    }
    return out;
  };
  for (const w of focusWords) counts.set(w, (counts.get(w) ?? 0) + 1);

  // 3a-c. Focus words, coverage, normal share.
  const covered = [...focusWords];
  const coverage: string[] = [];
  for (const item of focusItems) {
    if (covered.some((w) => w.includes(item))) continue;
    const [word] = draw(candidates.filter((c) => c.word.includes(item)), 1);
    if (word) {
      coverage.push(word);
      covered.push(word);
    }
  }
  const normalCount = Math.round(length * normalShare);
  const normalCandidates = normalPool.length > 0 ? normalPool.map((word) => ({ word, weight: 1 })) : candidates.map((c) => ({ word: c.word, weight: 1 }));
  const normal = draw(normalCandidates, normalCount);

  // 3e. Keep coverage first, then focus words, then normal words; 3d. fill the rest.
  const words = [...coverage, ...focusWords, ...normal].slice(0, length);
  words.push(...draw(candidates, length - words.length));

  // 3f. Seeded Fisher-Yates shuffle, then separate identical neighbours.
  for (let i = words.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [words[i], words[j]] = [words[j], words[i]];
  }
  const clashes = (i: number) => (words[i] !== undefined && words[i] === words[i + 1] ? 1 : 0);
  const localClashes = (...idx: number[]) => idx.reduce((n, i) => n + clashes(i - 1) + clashes(i), 0);
  for (let i = 1; i < words.length; i++) {
    if (words[i] !== words[i - 1]) continue;
    // Prefer a later word (per spec); fall back to an earlier one for the tail of the list.
    const order = [...Array.from({ length: words.length - i - 1 }, (_, k) => i + 1 + k), ...Array.from({ length: i - 1 }, (_, k) => i - 2 - k)];
    for (const j of order) {
      if (words[j] === words[i]) continue;
      [words[i], words[j]] = [words[j], words[i]];
      if (localClashes(i, j) === 0) break;
      [words[i], words[j]] = [words[j], words[i]];
    }
  }

  return { words, focusKeys, focusBigrams, focusWords, seed };
}
