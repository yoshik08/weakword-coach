// Data shapes shared by the preloads, the main process, the pure coach logic and the Coach panel.

/** Legacy column: 'practice' for drills, 'standard' for everything else. */
export type TestSource = 'standard' | 'practice';
/** normal = time/words/quote test from Monkeytype's own generator; drill = a Coach practice prompt. */
export type TestKind = 'normal' | 'drill' | 'custom' | 'zen';

/** Keystroke flags: timing next to these keys is not clean. */
export const KS_REPEAT = 1; // auto-repeat from a held key
export const KS_AFTER_BLUR = 2; // first key after the window lost focus
export const KS_AFTER_ARTIFACT = 4; // first key after paste, IME composition, Ctrl+Backspace or similar
export const KS_SHIFT = 8; // Shift was held
export const KS_UNTIMED = KS_REPEAT | KS_AFTER_BLUR | KS_AFTER_ARTIFACT;

/** One keydown captured in the Monkeytype words input during a test. */
export interface Keystroke {
  /** 0-based order within the test. */
  seq: number;
  /** ms since the test's first keystroke (KeyboardEvent.timeStamp: monotonic). */
  t: number;
  /** KeyboardEvent.key: a single character (' ' for space) or 'Backspace'. */
  key: string;
  /** Character Monkeytype expected at the caret: a letter, ' ' at a word end, null for Backspace or past a word's end + 1. */
  expected: string | null;
  /** key === expected. Always false for Backspace. */
  correct: boolean;
  /** Global index (data-wordindex) of the word being typed. */
  wordIndex: number;
  /** Caret position in the word before this key; null/undefined for old data (reconstructed). */
  pos?: number | null;
  /** KS_* bit flags. */
  flags?: number;
}

/** Values read from Monkeytype's result screen; null if the cell was missing or unparsable. */
export interface TestResult {
  wpm: number | null;
  raw: number | null;
  accuracy: number | null;
  consistency: number | null;
}

/** The result screen's own description of the test: the official record. */
export interface ResultRecord {
  /** Lines of the "test type" cell, e.g. ["words 10", "english", "punctuation"]. */
  testType: string[];
  /** Lines of the "other" cell, e.g. ["invalid", "too short"]. Empty when the cell is absent. */
  other: string[];
}

/** Monkeytype settings that change how a test scores, read (never written) from its config. */
export interface TestSettings {
  /** Layout emulation ("default" = the OS layout). */
  layout?: string;
  confidenceMode?: string;
  quoteLength?: number[];
}

/** A finished test as captured from the DOM, sent from the Monkeytype preload to main. */
export interface CapturedTest {
  /** Random id of this attempt: storing the same attempt twice is a no-op. */
  clientId?: string;
  /** Epoch ms of the first keystroke. */
  startedAt: number;
  /** Epoch ms when the result screen appeared. */
  endedAt: number;
  /** Mode and mode2 from #premidTestMode, e.g. "words 25", "time 30", "custom custom". */
  mode: string;
  /** Language id from #premidTestMode, e.g. "english", "english_1k". */
  language: string | null;
  /** Target words by index (0..last word reached), as rendered by Monkeytype. */
  words: string[];
  keystrokes: Keystroke[];
  result: TestResult;
  record?: ResultRecord;
  settings?: TestSettings;
  /** Letter -> KeyboardEvent.code seen in this test (layout fingerprint and fingering hints). */
  keyCodes?: Record<string, string>;
}

/** A test as stored in SQLite. */
export interface StoredTest extends CapturedTest {
  id: number;
  source: TestSource;
  kind: TestKind;
  eligible: boolean;
  ineligibleReason: string | null;
  profileKey: string | null;
  layout: string | null;
  corpusVersion: string | null;
  promptId: string | null;
  sessionId: string | null;
  practiceId: number | null;
}

/** What makes two ordinary tests comparable. */
export interface Profile {
  mode: string;
  mode2: string;
  language: string;
  punctuation: boolean;
  numbers: boolean;
  /** Sorted scoring/assist modifiers: blind, lazy, funbox names, expert, stop on letter, confidence ... */
  modifiers: string[];
  /** Physical layout fingerprint ("qwerty", "dvorak", ...) or "unknown". */
  layout: string;
}

// Derived statistics

/** Running totals for one pattern in one test (first attempts only). */
export interface ItemAcc {
  /** First attempts. */
  a: number;
  /** First attempts that were wrong. */
  e: number;
  /** Clean press-to-press samples, ms (for words: ms per character). */
  s: number[];
}

export interface TestStats {
  v: number;
  /** Keyed by pattern id: k:e (letter), b:th, t:the, w:because, x:space, x:start, x:shift, x:digit, p:, */
  items: Record<string, ItemAcc>;
  /** Word id -> occurrences with a stall. */
  stalls: Record<string, number>;
  /** Median clean in-word gap, ms. */
  medianGap: number | null;
  /** All first attempts in the test. */
  firstTry: { a: number; e: number };
  /** Median gap of the last third over the first third (>1 = slowing down); null for short runs. */
  fade: number | null;
  /** Characters expected (first attempts). */
  chars: number;
}

export type PatternKind = 'letter' | 'bigram' | 'trigram' | 'word' | 'space' | 'start' | 'shift' | 'digit' | 'punct';
export type PatternStatus = 'learning' | 'weak' | 'ok';

export interface PatternStat {
  id: string;
  kind: PatternKind;
  label: string;
  attempts: number;
  errors: number;
  /** Distinct runs with at least one attempt. */
  runs: number;
  errorRate: number;
  smoothedErrorRate: number;
  /** Robust (weighted median) clean ms; null without samples. Words: ms per character. */
  ms: number | null;
  smoothedMs: number | null;
  samples: number;
  stallRate: number | null;
  baselineMs: number;
  baselineErrorRate: number;
  /** Expected occurrences per 100 typed characters in the active corpus. */
  frequency: number;
  /** Expected ms lost per occurrence versus the typist's baseline. */
  costMs: number;
  /** frequency x cost x reliability: ms lost per 100 characters. */
  impact: number;
  status: PatternStatus;
  problem: 'accuracy' | 'speed' | null;
  explanation: string;
}

export interface Diagnosis {
  scope: { language: string; layout: string };
  testCount: number;
  keystrokes: number;
  baseline: { msPerKey: number | null; errorRate: number; wpm: number | null };
  /** Every pattern with attempts, highest impact first. */
  items: PatternStat[];
  letters: PatternStat[];
  sequences: PatternStat[];
  words: PatternStat[];
  boundaries: PatternStat[];
  /** Persistent weak patterns, highest impact first. */
  top: PatternStat[];
  fading: boolean;
  /** Nothing has enough evidence yet. */
  sparse: boolean;
}

// Practice

export type StepKind = 'warmup' | 'accuracy' | 'speed' | 'mixed' | 'retest' | 'quick' | 'review';

export interface Target {
  id: string;
  kind: PatternKind;
  label: string;
  problem: 'accuracy' | 'speed';
  reason: string;
  ms: number | null;
  errorRate: number;
  attempts: number;
  impact: number;
  /** Expected ms lost per occurrence when the target was chosen. */
  costMs: number;
}

export interface PlanStep {
  index: number;
  kind: StepKind;
  title: string;
  instruction: string;
  /** Prompt length in words (0 for the retest). */
  words: number;
  paceWpm: number | null;
  accuracyFloor: number | null;
  estSeconds: number;
  targets: string[];
}

export interface SessionPlan {
  kind: 'session' | 'quick' | 'review';
  seed: number;
  createdAt: number;
  targets: Target[];
  steps: PlanStep[];
  profileKey: string;
  profileLabel: string;
  profile: Profile;
  estMinutes: number;
  /** Review sessions: the words being reviewed. */
  reviewWords?: string[];
}

export interface PatternState {
  id: string;
  level: number;
  cleanRounds: number;
  roughRounds: number;
  rounds: number;
  firstTargetedAt: number;
  lastPracticedAt: number;
  /** Cost per occurrence (ms) when first targeted. */
  startCost: number | null;
  status: 'training' | 'recovering';
  intervalIndex: number;
  nextDueAt: number | null;
}

// Result row (rendered by the Monkeytype preload under wpm and acc)

export interface RowMetric {
  id: 'wpm' | 'acc';
  value: string;
  delta: string | null;
  tone: 'up' | 'down' | 'flat' | null;
  caption: string;
}

export interface RowAction {
  id: string;
  label: string;
  primary?: boolean;
  kbd?: string;
}

export interface ResultRowView {
  clientId: string;
  kind: 'compare' | 'calibrating' | 'no-baseline' | 'drill' | 'not-counted';
  heading: string;
  metrics: RowMetric[];
  lines: string[];
  actions: RowAction[];
  data: Record<string, string>;
}

/** The session strip shown above the words while a Coach session is active. */
export interface HudView {
  state: 'step' | 'paused';
  step: number;
  steps: number;
  title: string;
  instruction: string;
  targets: string[];
}

// Coach panel

export interface TrendPoint {
  testId: number;
  endedAt: number;
  kind: TestKind;
  wpm: number | null;
  /** Speed (wpm) on the current targets within that test, null if none typed cleanly. */
  targetWpm: number | null;
}

export interface ProfileSummary {
  key: string;
  label: string;
  tests: number;
  lastAt: number;
}

export interface BaselineView {
  kind: 'pre-coach' | 'fresh';
  wpm: number | null;
  acc: number | null;
  n: number;
  need: number;
  frozen: boolean;
  frozenAt: number | null;
  createdAt: number;
}

export interface ProgressView {
  profileKey: string;
  profileLabel: string;
  baseline: BaselineView | null;
  /** Ordinary tests in the profile since coaching began (excluding baseline tests). */
  postRuns: number;
  /** Comparison over the latest window; null before any post-coaching run. */
  latest: { wpm: number; acc: number; dWpm: number; dAcc: number; window: number } | null;
  coachingStarted: boolean;
  /** Plain status line, e.g. "Baseline 2/3 complete" or "Take a normal test to measure progress." */
  status: string;
}

export interface TransferView {
  id: string;
  label: string;
  metric: 'ms' | 'missed';
  before: number | null;
  after: number | null;
  learning: boolean;
}

export interface FollowupView {
  sessionId: string;
  dueAt: number;
  due: boolean;
  profileLabel: string;
  retestDelta: number | null;
}

export interface SessionView {
  id: string;
  kind: SessionPlan['kind'];
  step: number;
  plan: SessionPlan;
  status: 'active' | 'done' | 'abandoned';
}

export interface CoachState {
  diagnosis: Diagnosis;
  trend: TrendPoint[];
  trendTargets: string[];
  profiles: ProfileSummary[];
  benchmark: ProfileSummary | null;
  progress: ProgressView | null;
  followup: FollowupView | null;
  session: SessionView | null;
  preview: SessionPlan | { error: string } | null;
  transfer: TransferView[];
  settings: { hints: boolean; warmup: boolean };
  /** Letter -> fingering hint text, when hints are on. */
  hints: Record<string, string>;
  normalTests: number;
  drillTests: number;
  status: string | null;
}

export interface PracticeStatus {
  state: 'running' | 'done' | 'error';
  error?: string;
  message?: string;
}
