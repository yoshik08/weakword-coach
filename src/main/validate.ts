import type { CapturedTest } from '../shared/types';

const MAX_KEYSTROKES = 20_000;
const MAX_WORDS = 5_000;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isStrOrNull = (v: unknown) => v === null || typeof v === 'string';

/** Checks an IPC payload from the renderer before it reaches SQLite. */
export function isCapturedTest(x: unknown): x is CapturedTest {
  if (typeof x !== 'object' || x === null) return false;
  const t = x as Record<string, unknown>;
  const r = t.result as Record<string, unknown> | null;
  if (!isNum(t.startedAt) || !isNum(t.endedAt)) return false;
  if (typeof t.mode !== 'string' || t.mode.length > 100 || !isStrOrNull(t.language)) return false;
  if (typeof r !== 'object' || r === null) return false;
  if (![r.wpm, r.raw, r.accuracy, r.consistency].every(isNumOrNull)) return false;
  if (!Array.isArray(t.words) || t.words.length > MAX_WORDS) return false;
  if (!t.words.every((w) => typeof w === 'string' && w.length <= 200)) return false;
  if (!Array.isArray(t.keystrokes) || t.keystrokes.length === 0 || t.keystrokes.length > MAX_KEYSTROKES) return false;
  return t.keystrokes.every((k) => {
    const s = k as Record<string, unknown> | null;
    return (
      typeof s === 'object' && s !== null &&
      isNum(s.seq) && isNum(s.t) && isNum(s.wordIndex) &&
      typeof s.key === 'string' && s.key.length >= 1 && s.key.length <= 9 &&
      (s.expected === null || (typeof s.expected === 'string' && s.expected.length === 1)) &&
      typeof s.correct === 'boolean'
    );
  });
}
