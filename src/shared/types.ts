// Data shapes shared by the preload, main process, analysis and coach UI.

export type TestSource = 'standard' | 'practice';

/** One keydown captured in the Monkeytype words input during a test. */
export interface Keystroke {
  /** 0-based order within the test. */
  seq: number;
  /** ms since the test's first keystroke (from KeyboardEvent.timeStamp). */
  t: number;
  /** KeyboardEvent.key: a single character (' ' for space) or 'Backspace'. */
  key: string;
  /** Character Monkeytype expected at the caret: a letter, ' ' at a word end, null for Backspace or past a word's end + 1. */
  expected: string | null;
  /** key === expected. Always false for Backspace. */
  correct: boolean;
  /** Global index (data-wordindex) of the word being typed. */
  wordIndex: number;
}

/** Values read from Monkeytype's result screen; null if the cell was missing or unparsable. */
export interface TestResult {
  wpm: number | null;
  raw: number | null;
  accuracy: number | null;
  consistency: number | null;
}

/** A finished test as captured from the DOM, sent from the Monkeytype preload to main. */
export interface CapturedTest {
  /** Epoch ms of the first keystroke. */
  startedAt: number;
  /** Epoch ms when the result screen appeared. */
  endedAt: number;
  /** Mode and mode2 from #premidTestMode, e.g. "words 25", "time 30", "custom custom". */
  mode: string;
  language: string | null;
  /** Target words by index (0..last word reached), as rendered by Monkeytype. */
  words: string[];
  keystrokes: Keystroke[];
  result: TestResult;
}

/** A test as stored in SQLite. */
export interface StoredTest extends CapturedTest {
  id: number;
  source: TestSource;
  practiceId: number | null;
}

/** Speed/accuracy stats for one key, bigram or word. */
export interface ItemStat {
  /** 'e', 'th', or a whole word. */
  item: string;
  /** Keystrokes where this key/bigram was expected, or occurrences of the word. */
  attempts: number;
  /** Attempts typed incorrectly (for words: wrong keystrokes inside the word). */
  errors: number;
  /** errors / attempts, 0..1 (for words: errors / letters typed). */
  errorRate: number;
  /** Median ms per character over timed samples. */
  msPerChar: number;
  /** 12000 / msPerChar (5 chars per word). */
  wpm: number;
  /** 1 / weakness. >= 1 means at or above target speed with good accuracy. */
  confidence: number;
  /** (msPerChar / targetMs) * (1 + 4 * errorRate); higher = weaker. */
  weakness: number;
}

export interface Analysis {
  source: TestSource;
  targetWpm: number;
  testCount: number;
  /** Items with attempts >= the minimum, weakest first. */
  keys: ItemStat[];
  bigrams: ItemStat[];
  words: ItemStat[];
  /** Every letter seen, including those below the minimum attempts (for the heatmap). */
  allKeys: ItemStat[];
}

export interface TrendPoint {
  testId: number;
  endedAt: number;
  source: TestSource;
  /** Monkeytype's reported wpm for the test. */
  wpm: number | null;
  /** Speed on the current weakest keys within that test (null if none typed). */
  weakSpotWpm: number | null;
}

export interface PracticePlan {
  words: string[];
  focusKeys: string[];
  focusBigrams: string[];
  focusWords: string[];
  seed: number;
}

/** What the coach window renders: standard tests and practice sessions are analysed separately. */
export interface CoachData {
  standard: Analysis;
  practice: Analysis;
}
