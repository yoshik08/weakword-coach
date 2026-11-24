import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  adoptLegacyLayout, createSession, currentPeriod, findPrompt, getBaseline, getScored, getStats, getTests, insertPrompt, insertTest,
  migrate, openDb, saveBaseline, SCHEMA_VERSION, type TestMeta,
} from '../../src/main/db';
import { isCapturedTest } from '../../src/main/validate';
import { deriveStats, STATS_VERSION } from '../../src/shared/keystats';
import type { CapturedTest, SessionPlan } from '../../src/shared/types';

function sample(startedAt: number, overrides: Partial<CapturedTest> = {}): CapturedTest {
  return {
    clientId: `client-${startedAt}-${Math.random().toString(36).slice(2)}`,
    startedAt,
    endedAt: startedAt + 5000,
    mode: 'words 2',
    language: 'english',
    words: ['if', 'on'],
    keystrokes: [
      { seq: 0, t: 0, key: 'i', expected: 'i', correct: true, wordIndex: 0, pos: 0, flags: 0 },
      { seq: 1, t: 90.5, key: 'x', expected: 'f', correct: false, wordIndex: 0, pos: 1, flags: 0 },
      { seq: 2, t: 200, key: ' ', expected: ' ', correct: false, wordIndex: 0, pos: 2, flags: 0 },
      { seq: 3, t: 300, key: 'Backspace', expected: null, correct: false, wordIndex: 1, pos: 0, flags: 2 },
    ],
    result: { wpm: 60.5, raw: 64, accuracy: 93.33, consistency: null },
    record: { testType: ['words 2', 'english'], other: [] },
    ...overrides,
  };
}

const meta = (test: CapturedTest, over: Partial<TestMeta> = {}): TestMeta => ({
  kind: 'normal', eligible: true, reason: null, profileKey: 'words 2|english|||qwerty', layout: 'qwerty', corpusVersion: 'abc',
  promptId: null, sessionId: null, stats: deriveStats(test), ...over,
});

describe('db', () => {
  it('round-trips a test with words, keystrokes and its record', () => {
    const db = openDb(':memory:');
    const test = sample(1000);
    const { id } = insertTest(db, test, meta(test));
    const [stored] = getTests(db);
    expect(stored).toMatchObject({ ...test, id, kind: 'normal', eligible: true, profileKey: 'words 2|english|||qwerty', layout: 'qwerty', corpusVersion: 'abc', source: 'standard' });
    expect(stored.keystrokes).toEqual(test.keystrokes);
  });

  it('stores the same attempt only once (restarts and re-sends cannot duplicate a result)', () => {
    const db = openDb(':memory:');
    const test = sample(1000);
    const first = insertTest(db, test, meta(test));
    const again = insertTest(db, test, meta(test));
    expect(again).toEqual({ id: first.id, duplicate: true });
    expect(db.prepare('SELECT count(*) AS n FROM tests').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM keystrokes').get()).toEqual({ n: 4 });
  });

  it('rolls back the whole test when a row fails', () => {
    const db = openDb(':memory:');
    const dup = sample(1000).keystrokes[0];
    const bad = sample(1000, { keystrokes: [dup, dup] });
    expect(() => insertTest(db, bad, meta(bad))).toThrow();
    for (const table of ['tests', 'keystrokes', 'words']) expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it('recomputes stored statistics when their version is old', () => {
    const db = openDb(':memory:');
    const test = sample(1000);
    const { id } = insertTest(db, test, meta(test));
    db.prepare("UPDATE tests SET stats = '{}', stats_version = 0 WHERE id = ?").run(id);
    expect(getStats(db, [id]).get(id)).toEqual(deriveStats(test));
    expect(db.prepare('SELECT stats_version FROM tests WHERE id = ?').get(id)).toEqual({ stats_version: STATS_VERSION });
  });

  it('keeps baselines, sessions and prompts', () => {
    const db = openDb(':memory:');
    const period = currentPeriod(db);
    saveBaseline(db, { periodId: period.id, profileKey: 'k', kind: 'pre-coach', createdAt: 1, frozenAt: 2, testIds: [1, 2, 3], wpm: 80, acc: 97, corpusVersion: 'v' });
    expect(getBaseline(db, period.id, 'k')).toMatchObject({ testIds: [1, 2, 3], wpm: 80, frozenAt: 2 });
    const plan = { kind: 'quick', steps: [], targets: [] } as unknown as SessionPlan;
    createSession(db, 's1', plan, period.id, 10);
    const s2 = createSession(db, 's2', plan, period.id, 20); // a new session abandons the old one
    expect(s2.status).toBe('active');
    expect(db.prepare("SELECT status FROM sessions WHERE id = 's1'").get()).toEqual({ status: 'abandoned' });
    const id = insertPrompt(db, { sessionId: 's2', step: 0, kind: 'quick', words: ['pop', 'up'], targets: ['k:p'], seed: 1, createdAt: 30, generatorVersion: 2 });
    expect(findPrompt(db, ['pop', 'up'])).toMatchObject({ id, sessionId: 's2', targets: ['k:p'] });
    expect(findPrompt(db, ['pop'])).toBeNull();
  });
});

describe('migration from 0.1.x', () => {
  it('upgrades an old database in place and backfills kinds, profiles, prompts and the first period', () => {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE practice_sessions (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, words TEXT NOT NULL, focus TEXT NOT NULL);
      CREATE TABLE tests (id INTEGER PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('standard', 'practice')), mode TEXT NOT NULL, language TEXT,
        wpm REAL, raw REAL, accuracy REAL, consistency REAL, practice_id INTEGER REFERENCES practice_sessions(id));
      CREATE TABLE keystrokes (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE, seq INTEGER NOT NULL, t REAL NOT NULL,
        key TEXT NOT NULL, expected TEXT, correct INTEGER NOT NULL, word_index INTEGER NOT NULL, PRIMARY KEY (test_id, seq));
      CREATE TABLE words (test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE, word_index INTEGER NOT NULL, word TEXT NOT NULL,
        PRIMARY KEY (test_id, word_index));
      INSERT INTO practice_sessions VALUES (1, 500, '["pop","up"]', '{"keys":["p"],"bigrams":["op"],"words":[]}');
      INSERT INTO tests VALUES (1, 100, 200, 'standard', 'time 15', 'english', 99.1, 100, 94.9, 70, NULL);
      INSERT INTO tests VALUES (2, 300, 400, 'standard', 'time 15', 'english', 99.1, 100, 94.9, 70, NULL);
      INSERT INTO tests VALUES (3, 600, 700, 'practice', 'custom custom', 'english', 80, 80, 99, 70, 1);
      INSERT INTO tests VALUES (4, 800, 900, 'standard', 'custom custom', 'english', 80, 80, 99, 70, NULL);
      INSERT INTO words VALUES (1, 0, 'the'), (1, 1, 'end'), (2, 0, 'the'), (2, 1, 'end'), (3, 0, 'pop'), (3, 1, 'up'), (4, 0, 'my'), (4, 1, 'text');
      INSERT INTO keystrokes VALUES (1, 0, 0, 't', 't', 1, 0), (1, 1, 120, 'h', 'h', 1, 0), (1, 2, 230, 'e', 'e', 1, 0);
    `);
    migrate(raw);
    migrate(raw); // idempotent
    expect(raw.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const rows = raw.prepare('SELECT id, kind, eligible, ineligible_reason AS reason, profile_key AS key, prompt_id AS prompt FROM tests ORDER BY id').all();
    expect(rows).toEqual([
      { id: 1, kind: 'normal', eligible: 1, reason: null, key: 'time 15|english|||unknown', prompt: null },
      { id: 2, kind: 'normal', eligible: 0, reason: 'same words as the previous test', key: 'time 15|english|||unknown', prompt: null },
      { id: 3, kind: 'drill', eligible: 0, reason: 'practice round', key: 'custom custom|english|||unknown', prompt: 'legacy-1' },
      { id: 4, kind: 'custom', eligible: 0, reason: 'custom text', key: 'custom custom|english|||unknown', prompt: null },
    ]);
    expect(findPrompt(raw, ['pop', 'up'])).toMatchObject({ id: 'legacy-1', targets: ['k:p', 'b:op'] });
    expect(currentPeriod(raw)).toEqual({ id: 1, startedAt: 100, firstDrillAt: 700 });
    // Stats are derived lazily from the old keystrokes (no caret positions stored).
    expect(getStats(raw, [1]).get(1)!.items['k:h'].s).toEqual([120]);
    // The first fingerprinted test gives old tests its layout.
    expect(adoptLegacyLayout(raw, 'qwerty')).toBe(4);
    expect(getScored(raw).map((t) => t.profileKey)).toEqual([
      'time 15|english|||qwerty', 'time 15|english|||qwerty', 'custom custom|english|||qwerty', 'custom custom|english|||qwerty',
    ]);
  });
});

describe('isCapturedTest', () => {
  it('accepts a good payload and rejects malformed or oversized ones', () => {
    expect(isCapturedTest(sample(1))).toBe(true);
    const { clientId: _c, record: _r, ...old } = sample(1);
    expect(isCapturedTest(old)).toBe(true);
    expect(isCapturedTest(null)).toBe(false);
    expect(isCapturedTest({ ...sample(1), keystrokes: [] })).toBe(false);
    expect(isCapturedTest({ ...sample(1), mode: 5 })).toBe(false);
    expect(isCapturedTest({ ...sample(1), result: { wpm: 'fast' } })).toBe(false);
    expect(isCapturedTest({ ...sample(1), keystrokes: [{ seq: 0 }] })).toBe(false);
    expect(isCapturedTest({ ...sample(1), record: { testType: 'words' } })).toBe(false);
    expect(isCapturedTest({ ...sample(1), keyCodes: { abc: 'KeyA' } })).toBe(false);
    expect(isCapturedTest({ ...sample(1), keystrokes: [{ ...sample(1).keystrokes[0], flags: 1.5 }] })).toBe(false);
    const many = Array.from({ length: 20_001 }, (_, i) => ({ ...sample(1).keystrokes[0], seq: i }));
    expect(isCapturedTest({ ...sample(1), keystrokes: many })).toBe(false);
  });
});
