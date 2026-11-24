import Database from 'better-sqlite3';
import { deriveStats, STATS_VERSION } from '../shared/keystats';
import { profileKey, profileOf } from '../shared/profile';
import type { BaselineRecord, PeriodInfo, ScoredTest } from '../shared/progress';
import type {
  CapturedTest, Keystroke, PatternState, ResultRecord, SessionPlan, StoredTest, TestKind, TestSource, TestStats,
} from '../shared/types';
import { hash } from '../shared/util';

export type Db = Database.Database;
export type { PeriodInfo } from '../shared/progress';

export const SCHEMA_VERSION = 2;

// Version 1: the original schema (user_version 0 in databases created by 0.1.x).
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS practice_sessions (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  words TEXT NOT NULL,
  focus TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('standard', 'practice')),
  mode TEXT NOT NULL,
  language TEXT,
  wpm REAL, raw REAL, accuracy REAL, consistency REAL,
  practice_id INTEGER REFERENCES practice_sessions(id)
);
CREATE TABLE IF NOT EXISTS keystrokes (
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  t REAL NOT NULL,
  key TEXT NOT NULL,
  expected TEXT,
  correct INTEGER NOT NULL,
  word_index INTEGER NOT NULL,
  PRIMARY KEY (test_id, seq)
);
CREATE TABLE IF NOT EXISTS words (
  test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  word_index INTEGER NOT NULL,
  word TEXT NOT NULL,
  PRIMARY KEY (test_id, word_index)
);
`;

// Version 2: coach statistics, comparison periods, baselines, sessions, prompts and the practice model.
const SCHEMA_V2 = `
ALTER TABLE tests ADD COLUMN client_id TEXT;
ALTER TABLE tests ADD COLUMN kind TEXT;
ALTER TABLE tests ADD COLUMN eligible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tests ADD COLUMN ineligible_reason TEXT;
ALTER TABLE tests ADD COLUMN profile_key TEXT;
ALTER TABLE tests ADD COLUMN layout TEXT;
ALTER TABLE tests ADD COLUMN corpus_version TEXT;
ALTER TABLE tests ADD COLUMN record TEXT;
ALTER TABLE tests ADD COLUMN settings TEXT;
ALTER TABLE tests ADD COLUMN key_codes TEXT;
ALTER TABLE tests ADD COLUMN prompt_id TEXT;
ALTER TABLE tests ADD COLUMN session_id TEXT;
ALTER TABLE tests ADD COLUMN stats TEXT;
ALTER TABLE tests ADD COLUMN stats_version INTEGER;
ALTER TABLE keystrokes ADD COLUMN pos INTEGER;
ALTER TABLE keystrokes ADD COLUMN flags INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS tests_client_id ON tests(client_id);
CREATE INDEX IF NOT EXISTS tests_profile ON tests(profile_key, ended_at);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  first_drill_at INTEGER,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS baselines (
  period_id INTEGER NOT NULL REFERENCES periods(id),
  profile_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pre-coach', 'fresh')),
  created_at INTEGER NOT NULL,
  frozen_at INTEGER,
  test_ids TEXT NOT NULL DEFAULT '[]',
  wpm REAL, accuracy REAL, corpus_version TEXT,
  PRIMARY KEY (period_id, profile_key)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'done', 'abandoned')),
  plan TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  period_id INTEGER,
  results TEXT NOT NULL DEFAULT '[]',
  completed_at INTEGER,
  retest_test_id INTEGER,
  followup_due_at INTEGER,
  followup_test_id INTEGER
);
CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  step INTEGER,
  kind TEXT NOT NULL,
  words TEXT NOT NULL,
  words_hash TEXT NOT NULL,
  targets TEXT NOT NULL DEFAULT '[]',
  seed INTEGER,
  generator_version INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS prompts_hash ON prompts(words_hash);
CREATE TABLE IF NOT EXISTS pattern_state (
  scope TEXT NOT NULL,
  pattern TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, pattern)
);
`;

const wordsHash = (words: string[]) => hash(JSON.stringify(words));

/** Fills the version-2 columns for tests stored by 0.1.x and carries practice lists over as prompts. */
function backfillV2(db: Db): void {
  const rows = db.prepare('SELECT id, started_at, ended_at, source, mode, language, wpm, accuracy, practice_id FROM tests ORDER BY ended_at, id').all() as {
    id: number; started_at: number; ended_at: number; source: TestSource; mode: string; language: string | null;
    wpm: number | null; accuracy: number | null; practice_id: number | null;
  }[];
  const wordsOf = db.prepare('SELECT word FROM words WHERE test_id = ? ORDER BY word_index');
  const update = db.prepare(
    'UPDATE tests SET kind = ?, eligible = ?, ineligible_reason = ?, profile_key = ?, prompt_id = ? WHERE id = ?',
  );
  let previous: string | null = null;
  for (const r of rows) {
    const words = (wordsOf.all(r.id) as { word: string }[]).map((w) => w.word);
    const m = r.mode.split(/\s+/)[0];
    const kind: TestKind = r.source === 'practice' ? 'drill' : m === 'custom' ? 'custom' : m === 'zen' ? 'zen' : 'normal';
    const joined = JSON.stringify(words);
    let reason: string | null = null;
    if (kind === 'drill') reason = 'practice round';
    else if (kind === 'custom') reason = 'custom text';
    else if (kind === 'zen') reason = 'zen mode';
    else if (r.wpm === null || r.accuracy === null) reason = 'no score on the result screen';
    else if (joined === previous) reason = 'same words as the previous test';
    if (kind === 'normal') previous = joined;
    const profile = profileOf({ startedAt: r.started_at, endedAt: r.ended_at, mode: r.mode, language: r.language, words, keystrokes: [], result: { wpm: r.wpm, raw: null, accuracy: r.accuracy, consistency: null } });
    update.run(kind, reason === null ? 1 : 0, reason, profileKey(profile), r.practice_id === null ? null : `legacy-${r.practice_id}`, r.id);
  }
  const sessions = db.prepare('SELECT id, created_at, words, focus FROM practice_sessions').all() as { id: number; created_at: number; words: string; focus: string }[];
  const addPrompt = db.prepare(
    `INSERT OR IGNORE INTO prompts (id, session_id, step, kind, words, words_hash, targets, seed, generator_version, created_at)
     VALUES (?, NULL, NULL, 'legacy', ?, ?, ?, NULL, 1, ?)`,
  );
  for (const s of sessions) {
    const focus = JSON.parse(s.focus) as { keys?: string[]; bigrams?: string[]; words?: string[] };
    const targets = [...(focus.keys ?? []).map((k) => `k:${k}`), ...(focus.bigrams ?? []).map((b) => `b:${b}`), ...(focus.words ?? []).map((w) => `w:${w}`)];
    addPrompt.run(`legacy-${s.id}`, s.words, wordsHash(JSON.parse(s.words)), JSON.stringify(targets), s.created_at);
  }
  const first = db.prepare('SELECT MIN(started_at) AS t FROM tests').get() as { t: number | null };
  const drill = db.prepare("SELECT MIN(ended_at) AS t FROM tests WHERE kind = 'drill'").get() as { t: number | null };
  db.prepare("INSERT INTO periods (started_at, first_drill_at, reason) VALUES (?, ?, 'first')").run(first.t ?? Date.now(), drill.t);
}

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(SCHEMA_V1);
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (version < 2) {
      db.exec(SCHEMA_V2);
      backfillV2(db);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

// Tests

export interface TestMeta {
  kind: TestKind;
  eligible: boolean;
  reason: string | null;
  profileKey: string;
  layout: string | null;
  corpusVersion: string | null;
  promptId: string | null;
  sessionId: string | null;
  practiceId?: number | null;
  stats: TestStats;
}

/** Stores a test with its words and keystrokes atomically. The same clientId twice is a no-op. */
export function insertTest(db: Db, test: CapturedTest, meta: TestMeta): { id: number; duplicate: boolean } {
  return db.transaction(() => {
    if (test.clientId) {
      const existing = db.prepare('SELECT id FROM tests WHERE client_id = ?').get(test.clientId) as { id: number } | undefined;
      if (existing) return { id: existing.id, duplicate: true };
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tests (started_at, ended_at, source, mode, language, wpm, raw, accuracy, consistency, practice_id,
           client_id, kind, eligible, ineligible_reason, profile_key, layout, corpus_version, record, settings, key_codes,
           prompt_id, session_id, stats, stats_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        test.startedAt, test.endedAt, meta.kind === 'drill' ? 'practice' : 'standard', test.mode, test.language,
        test.result.wpm, test.result.raw, test.result.accuracy, test.result.consistency, meta.practiceId ?? null,
        test.clientId ?? null, meta.kind, meta.eligible ? 1 : 0, meta.reason, meta.profileKey, meta.layout, meta.corpusVersion,
        test.record ? JSON.stringify(test.record) : null, test.settings ? JSON.stringify(test.settings) : null,
        test.keyCodes ? JSON.stringify(test.keyCodes) : null, meta.promptId, meta.sessionId,
        JSON.stringify(meta.stats), STATS_VERSION,
      );
    const id = Number(lastInsertRowid);
    const addWord = db.prepare('INSERT INTO words (test_id, word_index, word) VALUES (?, ?, ?)');
    test.words.forEach((word, i) => addWord.run(id, i, word));
    const addKey = db.prepare(
      'INSERT INTO keystrokes (test_id, seq, t, key, expected, correct, word_index, pos, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const k of test.keystrokes) addKey.run(id, k.seq, k.t, k.key, k.expected, k.correct ? 1 : 0, k.wordIndex, k.pos ?? null, k.flags ?? 0);
    return { id, duplicate: false };
  })();
}

interface TestRow {
  id: number; started_at: number; ended_at: number; source: TestSource; mode: string; language: string | null;
  wpm: number | null; raw: number | null; accuracy: number | null; consistency: number | null; practice_id: number | null;
  client_id: string | null; kind: TestKind | null; eligible: number; ineligible_reason: string | null; profile_key: string | null;
  layout: string | null; corpus_version: string | null; record: string | null; settings: string | null; key_codes: string | null;
  prompt_id: string | null; session_id: string | null; stats: string | null; stats_version: number | null;
}

interface KeystrokeRow {
  seq: number; t: number; key: string; expected: string | null; correct: number; word_index: number; pos: number | null; flags: number;
}

const parse = <T>(json: string | null): T | undefined => (json ? (JSON.parse(json) as T) : undefined);

function toStored(db: Db, r: TestRow, withKeys: boolean): StoredTest {
  const words = (db.prepare('SELECT word FROM words WHERE test_id = ? ORDER BY word_index').all(r.id) as { word: string }[]).map((w) => w.word);
  const keystrokes = withKeys
    ? (db.prepare('SELECT seq, t, key, expected, correct, word_index, pos, flags FROM keystrokes WHERE test_id = ? ORDER BY seq').all(r.id) as KeystrokeRow[]).map(
        (k): Keystroke => ({ seq: k.seq, t: k.t, key: k.key, expected: k.expected, correct: k.correct === 1, wordIndex: k.word_index, pos: k.pos, flags: k.flags }),
      )
    : [];
  return {
    id: r.id, source: r.source, practiceId: r.practice_id, startedAt: r.started_at, endedAt: r.ended_at, mode: r.mode, language: r.language,
    result: { wpm: r.wpm, raw: r.raw, accuracy: r.accuracy, consistency: r.consistency },
    words, keystrokes, clientId: r.client_id ?? undefined,
    kind: r.kind ?? 'normal', eligible: r.eligible === 1, ineligibleReason: r.ineligible_reason, profileKey: r.profile_key,
    layout: r.layout, corpusVersion: r.corpus_version, promptId: r.prompt_id, sessionId: r.session_id,
    record: parse<ResultRecord>(r.record), settings: parse(r.settings), keyCodes: parse(r.key_codes),
  };
}

/** Tests oldest first (newest last); with `limit`, the newest `limit` tests. */
export function getTests(db: Db, opts: { source?: TestSource; kind?: TestKind; limit?: number; withKeystrokes?: boolean } = {}): StoredTest[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM tests WHERE (@source IS NULL OR source = @source) AND (@kind IS NULL OR kind = @kind)
         ORDER BY ended_at DESC, id DESC LIMIT @limit
       ) ORDER BY ended_at, id`,
    )
    .all({ source: opts.source ?? null, kind: opts.kind ?? null, limit: opts.limit ?? -1 }) as TestRow[];
  return rows.map((r) => toStored(db, r, opts.withKeystrokes ?? true));
}

export function getTest(db: Db, id: number): StoredTest | null {
  const r = db.prepare('SELECT * FROM tests WHERE id = ?').get(id) as TestRow | undefined;
  return r ? toStored(db, r, true) : null;
}

/** Light rows of every test for comparisons (no words or keystrokes). */
export function getScored(db: Db): ScoredTest[] {
  return (db.prepare('SELECT id, ended_at, kind, eligible, ineligible_reason, profile_key, corpus_version, wpm, accuracy FROM tests ORDER BY ended_at, id').all() as {
    id: number; ended_at: number; kind: TestKind | null; eligible: number; ineligible_reason: string | null; profile_key: string | null;
    corpus_version: string | null; wpm: number | null; accuracy: number | null;
  }[]).map((r) => ({
    id: r.id, endedAt: r.ended_at, kind: r.kind ?? 'normal', eligible: r.eligible === 1, reason: r.ineligible_reason,
    profileKey: r.profile_key, corpusVersion: r.corpus_version, wpm: r.wpm, acc: r.accuracy,
  }));
}

/** Derived stats of tests, recomputed from keystrokes (and stored) when missing or from an older version. */
export function getStats(db: Db, ids: number[]): Map<number, TestStats> {
  const out = new Map<number, TestStats>();
  const read = db.prepare('SELECT stats, stats_version FROM tests WHERE id = ?');
  const write = db.prepare('UPDATE tests SET stats = ?, stats_version = ? WHERE id = ?');
  for (const id of ids) {
    const row = read.get(id) as { stats: string | null; stats_version: number | null } | undefined;
    if (!row) continue;
    if (row.stats && row.stats_version === STATS_VERSION) {
      out.set(id, JSON.parse(row.stats) as TestStats);
      continue;
    }
    const test = getTest(db, id)!;
    const stats = deriveStats(test);
    write.run(JSON.stringify(stats), STATS_VERSION, id);
    out.set(id, stats);
  }
  return out;
}

/** Gives tests stored without a layout (0.1.x) the first layout the app fingerprints. */
export function adoptLegacyLayout(db: Db, layout: string): number {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, profile_key FROM tests WHERE layout IS NULL AND profile_key LIKE '%|unknown'").all() as { id: number; profile_key: string }[];
    const set = db.prepare('UPDATE tests SET layout = ?, profile_key = ? WHERE id = ?');
    for (const r of rows) set.run(layout, r.profile_key.replace(/\|unknown$/, `|${layout}`), r.id);
    const adopt = (key: string) => key.replace(/\|unknown$/, `|${layout}`);
    const bl = db.prepare("SELECT period_id, profile_key FROM baselines WHERE profile_key LIKE '%|unknown'").all() as { period_id: number; profile_key: string }[];
    for (const b of bl) {
      db.prepare('UPDATE OR IGNORE baselines SET profile_key = ? WHERE period_id = ? AND profile_key = ?').run(adopt(b.profile_key), b.period_id, b.profile_key);
    }
    // Everything else that names a profile or a scope: session plans (their retest and follow-up), the
    // chosen benchmark, and the practice model's scope.
    const sessions = db.prepare('SELECT id, plan FROM sessions').all() as { id: string; plan: string }[];
    for (const s of sessions) {
      const plan = JSON.parse(s.plan) as SessionPlan;
      if (!plan.profileKey?.endsWith('|unknown')) continue;
      plan.profileKey = adopt(plan.profileKey);
      if (plan.profile) plan.profile.layout = layout;
      db.prepare('UPDATE sessions SET plan = ? WHERE id = ?').run(JSON.stringify(plan), s.id);
    }
    const bench = getMeta(db, 'benchmark');
    if (bench?.endsWith('|unknown')) setMeta(db, 'benchmark', adopt(bench));
    db.prepare("UPDATE OR IGNORE pattern_state SET scope = substr(scope, 1, length(scope) - 7) || ? WHERE scope LIKE '%|unknown'").run(layout);
    return rows.length;
  })();
}

// Meta

export function getMeta(db: Db, key: string): string | null {
  return (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setMeta(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  else db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Periods and baselines

export function currentPeriod(db: Db): PeriodInfo {
  const row = db.prepare('SELECT id, started_at, first_drill_at FROM periods ORDER BY id DESC LIMIT 1').get() as
    | { id: number; started_at: number; first_drill_at: number | null }
    | undefined;
  if (row) return { id: row.id, startedAt: row.started_at, firstDrillAt: row.first_drill_at };
  const id = Number(db.prepare("INSERT INTO periods (started_at, reason) VALUES (?, 'first')").run(Date.now()).lastInsertRowid);
  return { id, startedAt: Date.now(), firstDrillAt: null };
}

export function markFirstDrill(db: Db, periodId: number, at: number): void {
  db.prepare('UPDATE periods SET first_drill_at = ? WHERE id = ? AND first_drill_at IS NULL').run(at, periodId);
}

export function newPeriod(db: Db, at: number, reason: string): PeriodInfo {
  const id = Number(db.prepare('INSERT INTO periods (started_at, reason) VALUES (?, ?)').run(at, reason).lastInsertRowid);
  return { id, startedAt: at, firstDrillAt: null };
}

export function getBaseline(db: Db, periodId: number, profileKey: string): BaselineRecord | null {
  const r = db.prepare('SELECT * FROM baselines WHERE period_id = ? AND profile_key = ?').get(periodId, profileKey) as
    | { period_id: number; profile_key: string; kind: 'pre-coach' | 'fresh'; created_at: number; frozen_at: number | null; test_ids: string; wpm: number | null; accuracy: number | null; corpus_version: string | null }
    | undefined;
  if (!r) return null;
  return {
    periodId: r.period_id, profileKey: r.profile_key, kind: r.kind, createdAt: r.created_at, frozenAt: r.frozen_at,
    testIds: JSON.parse(r.test_ids) as number[], wpm: r.wpm, acc: r.accuracy, corpusVersion: r.corpus_version,
  };
}

export function saveBaseline(db: Db, b: BaselineRecord): void {
  db.prepare(
    `INSERT INTO baselines (period_id, profile_key, kind, created_at, frozen_at, test_ids, wpm, accuracy, corpus_version)
     VALUES (@periodId, @profileKey, @kind, @createdAt, @frozenAt, @testIds, @wpm, @acc, @corpusVersion)
     ON CONFLICT(period_id, profile_key) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at,
       frozen_at = excluded.frozen_at, test_ids = excluded.test_ids, wpm = excluded.wpm, accuracy = excluded.accuracy,
       corpus_version = excluded.corpus_version`,
  ).run({ ...b, testIds: JSON.stringify(b.testIds) });
}

// Sessions

export interface SessionRow {
  id: string;
  kind: SessionPlan['kind'];
  createdAt: number;
  status: 'active' | 'done' | 'abandoned';
  plan: SessionPlan;
  step: number;
  periodId: number | null;
  results: StepResult[];
  completedAt: number | null;
  retestTestId: number | null;
  followupDueAt: number | null;
  followupTestId: number | null;
}

export interface StepResult {
  step: number;
  testId: number;
  wpm: number | null;
  accuracy: number | null;
  /** First-attempt accuracy and clean ms on each target in this round. */
  targets: Record<string, { attempts: number; errors: number; accuracy: number | null; ms: number | null }>;
  paceWpm: number | null;
  clean: boolean;
}

function toSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string, kind: r.kind as SessionRow['kind'], createdAt: r.created_at as number, status: r.status as SessionRow['status'],
    plan: JSON.parse(r.plan as string) as SessionPlan, step: r.step as number, periodId: r.period_id as number | null,
    results: JSON.parse(r.results as string) as StepResult[], completedAt: r.completed_at as number | null,
    retestTestId: r.retest_test_id as number | null, followupDueAt: r.followup_due_at as number | null, followupTestId: r.followup_test_id as number | null,
  };
}

export function createSession(db: Db, id: string, plan: SessionPlan, periodId: number, now: number): SessionRow {
  db.prepare("UPDATE sessions SET status = 'abandoned' WHERE status = 'active'").run();
  db.prepare("INSERT INTO sessions (id, kind, created_at, status, plan, step, period_id) VALUES (?, ?, ?, 'active', ?, 0, ?)").run(id, plan.kind, now, JSON.stringify(plan), periodId);
  return getSession(db, id)!;
}

export function getSession(db: Db, id: string): SessionRow | null {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? toSession(r) : null;
}

export function activeSession(db: Db): SessionRow | null {
  const r = db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  return r ? toSession(r) : null;
}

export function updateSession(db: Db, s: SessionRow): void {
  db.prepare(
    `UPDATE sessions SET status = ?, step = ?, results = ?, completed_at = ?, retest_test_id = ?, followup_due_at = ?, followup_test_id = ? WHERE id = ?`,
  ).run(s.status, s.step, JSON.stringify(s.results), s.completedAt, s.retestTestId, s.followupDueAt, s.followupTestId, s.id);
}

/** Done sessions with a follow-up that has not been taken yet, newest first. */
export function pendingFollowups(db: Db): SessionRow[] {
  return (db.prepare('SELECT * FROM sessions WHERE followup_due_at IS NOT NULL AND followup_test_id IS NULL ORDER BY completed_at DESC').all() as Record<string, unknown>[]).map(toSession);
}

export function lastSessions(db: Db, limit: number): SessionRow[] {
  return (db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toSession);
}

// Prompts

export interface PromptRow {
  id: string;
  sessionId: string | null;
  step: number | null;
  kind: string;
  words: string[];
  targets: string[];
  seed: number | null;
  createdAt: number;
}

export function insertPrompt(db: Db, p: Omit<PromptRow, 'id'> & { generatorVersion: number }): string {
  const id = `p-${hash(`${p.sessionId}|${p.step}|${p.seed}|${JSON.stringify(p.words)}`)}-${p.createdAt.toString(36)}`;
  db.prepare(
    `INSERT OR REPLACE INTO prompts (id, session_id, step, kind, words, words_hash, targets, seed, generator_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, p.sessionId, p.step, p.kind, JSON.stringify(p.words), wordsHash(p.words), JSON.stringify(p.targets), p.seed, p.generatorVersion, p.createdAt);
  return id;
}

/** The newest prompt whose words are exactly `words` (a Coach drill), or null. */
export function findPrompt(db: Db, words: string[]): PromptRow | null {
  const rows = db.prepare('SELECT * FROM prompts WHERE words_hash = ? ORDER BY created_at DESC').all(wordsHash(words)) as Record<string, unknown>[];
  const json = JSON.stringify(words);
  const r = rows.find((row) => row.words === json);
  if (!r) return null;
  return {
    id: r.id as string, sessionId: r.session_id as string | null, step: r.step as number | null, kind: r.kind as string,
    words: JSON.parse(r.words as string) as string[], targets: JSON.parse(r.targets as string) as string[],
    seed: r.seed as number | null, createdAt: r.created_at as number,
  };
}

/** Words of the drills of a session so far (mixed rounds avoid them). */
export function sessionWords(db: Db, sessionId: string): string[] {
  return (db.prepare('SELECT words FROM prompts WHERE session_id = ?').all(sessionId) as { words: string }[]).flatMap((r) => JSON.parse(r.words) as string[]);
}

// Practice model

export function getPatternStates(db: Db, scope: string): PatternState[] {
  return (db.prepare('SELECT state FROM pattern_state WHERE scope = ?').all(scope) as { state: string }[]).map((r) => JSON.parse(r.state) as PatternState);
}

export function savePatternState(db: Db, scope: string, s: PatternState, now: number): void {
  db.prepare(
    `INSERT INTO pattern_state (scope, pattern, state, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(scope, pattern) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(scope, s.id, JSON.stringify(s), now);
}
