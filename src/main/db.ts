import Database from 'better-sqlite3';
import type { CapturedTest, Keystroke, StoredTest, TestSource } from '../shared/types';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS practice_sessions (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  words TEXT NOT NULL,   -- JSON array of the practice words
  focus TEXT NOT NULL    -- JSON: the keys/bigrams/words the session targets
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

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Stores a test with its words and keystrokes atomically; returns the new test id. */
export function insertTest(db: Db, test: CapturedTest, source: TestSource, practiceId: number | null): number {
  const store = db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tests (started_at, ended_at, source, mode, language, wpm, raw, accuracy, consistency, practice_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        test.startedAt, test.endedAt, source, test.mode, test.language,
        test.result.wpm, test.result.raw, test.result.accuracy, test.result.consistency, practiceId,
      );
    const id = Number(lastInsertRowid);
    const addWord = db.prepare('INSERT INTO words (test_id, word_index, word) VALUES (?, ?, ?)');
    test.words.forEach((word, i) => addWord.run(id, i, word));
    const addKey = db.prepare(
      'INSERT INTO keystrokes (test_id, seq, t, key, expected, correct, word_index) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const k of test.keystrokes) addKey.run(id, k.seq, k.t, k.key, k.expected, k.correct ? 1 : 0, k.wordIndex);
    return id;
  });
  return store();
}

interface TestRow {
  id: number; started_at: number; ended_at: number; source: TestSource; mode: string; language: string | null;
  wpm: number | null; raw: number | null; accuracy: number | null; consistency: number | null;
  practice_id: number | null;
}

interface KeystrokeRow {
  seq: number; t: number; key: string; expected: string | null; correct: number; word_index: number;
}

/** Tests oldest first (newest last); with `limit`, the newest `limit` tests. */
export function getTests(db: Db, opts: { source?: TestSource; limit?: number } = {}): StoredTest[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM tests WHERE (@source IS NULL OR source = @source) ORDER BY id DESC LIMIT @limit
       ) ORDER BY id`,
    )
    .all({ source: opts.source ?? null, limit: opts.limit ?? -1 }) as TestRow[];
  const wordsOf = db.prepare('SELECT word FROM words WHERE test_id = ? ORDER BY word_index');
  const keysOf = db.prepare(
    'SELECT seq, t, key, expected, correct, word_index FROM keystrokes WHERE test_id = ? ORDER BY seq',
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    practiceId: r.practice_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    mode: r.mode,
    language: r.language,
    result: { wpm: r.wpm, raw: r.raw, accuracy: r.accuracy, consistency: r.consistency },
    words: (wordsOf.all(r.id) as { word: string }[]).map((w) => w.word),
    keystrokes: (keysOf.all(r.id) as KeystrokeRow[]).map(
      (k): Keystroke => ({
        seq: k.seq, t: k.t, key: k.key, expected: k.expected, correct: k.correct === 1, wordIndex: k.word_index,
      }),
    ),
  }));
}
