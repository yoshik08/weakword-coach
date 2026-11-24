// Every scoring weight, sample threshold and practice default in one place.
// These are product defaults to tune with real data, not constants of nature.

export const TUNING = {
  // Timing
  /** A press-to-press gap longer than this is an interruption, not typing speed (ms). */
  pauseMs: 2000,
  /** A gap inside a word counts as a stall above max(stallMinMs, stallFactor x the test's median gap). */
  stallMinMs: 600,
  stallFactor: 3,

  // Evidence
  /** Diagnosis uses the newest N eligible ordinary tests of the scope. */
  recentTests: 30,
  /** Recency weighting: a test this many tests older counts half as much. */
  halfLifeTests: 10,
  /** A pattern needs this many first attempts across this many runs before it can be labelled weak. */
  minAttempts: 15,
  minRuns: 2,
  /** Pseudo-attempts that pull a sparse error rate toward the typist's baseline. */
  errorPrior: 12,
  /** Pseudo-samples that pull a sparse timing toward the typist's baseline. */
  msPrior: 6,
  /** reliability = attempts / (attempts + reliabilityK). */
  reliabilityK: 15,

  // Ranking
  /** A first-attempt mistake costs about this many keystrokes of time (notice, Backspace, retype). */
  errorCostKeys: 3.5,
  /**
   * Boundaries are naturally slower than a key inside a word (reading the next word, reaching for Shift);
   * they only count as slow beyond this multiple of the typist's in-word pace.
   */
  boundaryAllowance: { space: 1.1, start: 1.3, shift: 1.6, digit: 1.8, punct: 1.6 },
  /** Minimum impact (ms lost per 100 typed characters) for a "weak" label. */
  weakImpactMin: 12,
  /** ... and the pattern must lag by at least one of these margins. */
  errorMargin: 0.04,
  slowMargin: 0.12,
  /** Up to this many targets per session; a 2nd/3rd target needs this share of the top impact. */
  maxTargets: 3,
  targetImpactRatio: 0.4,
  /** A run is "fading" when its last third is this much slower than its first third (median over recent runs). */
  fadeRatio: 1.1,

  // Practice
  /** First-attempt accuracy floor for a clean round; speed rounds start from it. */
  accuracyFloor: 0.97,
  /** A round this far below the floor counts as rough and lowers the pressure. */
  roughMargin: 0.04,
  raiseAfterCleanRounds: 2,
  paceStep: 0.05,
  paceMin: 0.85,
  paceMax: 1.4,
  /** Accuracy rounds are prompted at this share of the typist's clean pace. */
  accuracyPace: 0.85,
  /** Target durations per step (seconds of typing at the prompted pace); a default session runs 5-7 minutes. */
  stepSeconds: { warmup: 30, accuracy: 50, speed: 25, mixed: 90, quick: 45, review: 45 },
  accuracyRounds: 2,
  speedBursts: 3,
  warmup: true,
  wordsMin: 10,
  wordsMax: 160,
  /** No word appears more than this many times in one round unless the vocabulary is too small. */
  maxRepeats: 2,
  /** Share of ordinary (untargeted) words mixed into each kind of round. */
  fillerShare: { accuracy: 0.3, speed: 0.15, mixed: 0.55, quick: 0.35, review: 0.25 },
  /** Days between reviews of a recovering pattern. */
  reviewIntervalsDays: [1, 3, 7, 14],
  /** A pattern is "recovering" once its cost fell below this share of what it was when first targeted. */
  recoveredShare: 0.5,

  // Comparison
  /** Baseline = median of this many recent eligible tests before the first drill. */
  baselineTests: 3,
  /** With this many post-coaching tests the row shows their rolling median. */
  postWindow: 3,
  /** The follow-up retest is due this long after a session's retest. */
  followupHours: 24,
};

export type Tuning = typeof TUNING;

/** TUNING with a partial override (tests only). Nested objects are merged one level deep. */
export function withTuning(override: unknown): Tuning {
  if (typeof override !== 'object' || override === null) return TUNING;
  const out: Record<string, unknown> = { ...TUNING };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const base = (TUNING as Record<string, unknown>)[k];
    if (base === undefined) continue;
    out[k] = typeof base === 'object' && !Array.isArray(base) && typeof v === 'object' && v !== null ? { ...base, ...v } : v;
  }
  return out as Tuning;
}
