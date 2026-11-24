// Small pure helpers shared by the coach logic.

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median of values with weights (ties resolved at the half-weight point). */
export function weightedMedian(pairs: { v: number; w: number }[]): number | null {
  const s = pairs.filter((p) => p.w > 0).sort((a, b) => a.v - b.v);
  if (s.length === 0) return null;
  const total = s.reduce((sum, p) => sum + p.w, 0);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    acc += s[i].w;
    if (acc > total / 2) return s[i].v;
    if (acc === total / 2) return i + 1 < s.length ? (s[i].v + s[i + 1].v) / 2 : s[i].v;
  }
  return s[s.length - 1].v;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Small seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash as 8 hex chars. Stable across runs and platforms. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Seeded Fisher-Yates shuffle (in place). */
export function shuffle<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Moves identical neighbours apart where possible (keeps the multiset). */
export function separateNeighbours<T>(items: T[]): T[] {
  const out = [...items];
  const clashes = (i: number) => (out[i] !== undefined && out[i] === out[i + 1] ? 1 : 0);
  const local = (...idx: number[]) => idx.reduce((n, i) => n + clashes(i - 1) + clashes(i), 0);
  for (let i = 1; i < out.length; i++) {
    if (out[i] !== out[i - 1]) continue;
    const order = [
      ...Array.from({ length: out.length - i - 1 }, (_, k) => i + 1 + k),
      ...Array.from({ length: i - 1 }, (_, k) => i - 2 - k),
    ];
    for (const j of order) {
      if (out[j] === out[i]) continue;
      [out[i], out[j]] = [out[j], out[i]];
      if (local(i, j) === 0) break;
      [out[i], out[j]] = [out[j], out[i]];
    }
  }
  return out;
}

export const round1 = (v: number) => Math.round(v * 10) / 10;

export const signed = (v: number, digits = 0) => {
  const r = Number(v.toFixed(digits));
  if (r === 0) return digits > 0 ? `±${(0).toFixed(digits)}` : '±0';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}`;
};
