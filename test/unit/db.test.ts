import { describe, expect, it } from 'vitest';
import { getTests, insertTest, openDb } from '../../src/main/db';
import { isCapturedTest } from '../../src/main/validate';
import type { CapturedTest } from '../../src/shared/types';

function sample(startedAt: number, overrides: Partial<CapturedTest> = {}): CapturedTest {
  return {
    startedAt,
    endedAt: startedAt + 5000,
    mode: 'words 2',
    language: 'english',
    words: ['if', 'on'],
    keystrokes: [
      { seq: 0, t: 0, key: 'i', expected: 'i', correct: true, wordIndex: 0 },
      { seq: 1, t: 90.5, key: 'x', expected: 'f', correct: false, wordIndex: 0 },
      { seq: 2, t: 200, key: ' ', expected: ' ', correct: false, wordIndex: 0 },
      { seq: 3, t: 300, key: 'Backspace', expected: null, correct: false, wordIndex: 1 },
    ],
    result: { wpm: 60.5, raw: 64, accuracy: 93.33, consistency: null },
    ...overrides,
  };
}

describe('db', () => {
  it('round-trips a test with words and keystrokes', () => {
    const db = openDb(':memory:');
    const test = sample(1000);
    const id = insertTest(db, test, 'standard', null);
    expect(getTests(db)).toEqual([{ ...test, id, source: 'standard', practiceId: null }]);
  });

  it('filters by source, orders newest last and limits to the newest tests', () => {
    const db = openDb(':memory:');
    const session = db
      .prepare("INSERT INTO practice_sessions (created_at, words, focus) VALUES (1, '[]', '{}')")
      .run().lastInsertRowid as number;
    const a = insertTest(db, sample(1000), 'standard', null);
    const b = insertTest(db, sample(2000), 'practice', session);
    const c = insertTest(db, sample(3000), 'standard', null);
    expect(getTests(db).map((t) => t.id)).toEqual([a, b, c]);
    expect(getTests(db, { source: 'practice' }).map((t) => [t.id, t.practiceId])).toEqual([[b, session]]);
    expect(getTests(db, { source: 'standard' }).map((t) => t.id)).toEqual([a, c]);
    expect(getTests(db, { limit: 2 }).map((t) => t.id)).toEqual([b, c]);
  });

  it('rolls back the whole test when a row fails', () => {
    const db = openDb(':memory:');
    const dupSeq = sample(1000).keystrokes[0];
    const bad = sample(1000, { keystrokes: [dupSeq, dupSeq] });
    expect(() => insertTest(db, bad, 'standard', null)).toThrow();
    for (const table of ['tests', 'keystrokes', 'words']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });

  it('enforces the source check and the practice foreign key', () => {
    const db = openDb(':memory:');
    expect(() => insertTest(db, sample(1), 'bogus' as never, null)).toThrow();
    expect(() => insertTest(db, sample(1), 'practice', 999)).toThrow();
  });

  it('cascades deletes to words and keystrokes', () => {
    const db = openDb(':memory:');
    const id = insertTest(db, sample(1000), 'standard', null);
    db.prepare('DELETE FROM tests WHERE id = ?').run(id);
    expect(db.prepare('SELECT count(*) AS n FROM keystrokes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM words').get()).toEqual({ n: 0 });
  });
});

describe('isCapturedTest', () => {
  it('accepts a good payload and rejects malformed or oversized ones', () => {
    expect(isCapturedTest(sample(1))).toBe(true);
    expect(isCapturedTest(null)).toBe(false);
    expect(isCapturedTest({ ...sample(1), keystrokes: [] })).toBe(false);
    expect(isCapturedTest({ ...sample(1), mode: 5 })).toBe(false);
    expect(isCapturedTest({ ...sample(1), result: { wpm: 'fast' } })).toBe(false);
    expect(isCapturedTest({ ...sample(1), keystrokes: [{ seq: 0 }] })).toBe(false);
    const many = Array.from({ length: 20_001 }, (_, i) => ({ ...sample(1).keystrokes[0], seq: i }));
    expect(isCapturedTest({ ...sample(1), keystrokes: many })).toBe(false);
  });
});
