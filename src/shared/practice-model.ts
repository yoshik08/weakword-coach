// The practice model: per-pattern pace level and review schedule, updated from completed drills.
import { TUNING, type Tuning } from './tuning';
import type { PatternState, PatternStat } from './types';
import { clamp } from './util';

const DAY = 24 * 60 * 60 * 1000;

export function newPatternState(id: string, now: number, startCost: number | null): PatternState {
  return {
    id, level: 1, cleanRounds: 0, roughRounds: 0, rounds: 0,
    firstTargetedAt: now, lastPracticedAt: now, startCost,
    status: 'training', intervalIndex: 0, nextDueAt: null,
  };
}

export interface DrillOutcome {
  /** First-attempt accuracy on the pattern in this round, null if it never came up. */
  accuracy: number | null;
  /** The round's prompted pace and what Monkeytype measured for the round. */
  paceWpm: number | null;
  wpm: number | null;
  kind: string;
}

/**
 * One round on a pattern. Clean rounds (accuracy at the floor, and pace met in speed rounds) raise the
 * pace after `raiseAfterCleanRounds`; rough rounds lower it straight away.
 */
export function afterRound(state: PatternState, outcome: DrillOutcome, now: number, tuning: Tuning = TUNING): PatternState {
  const s = { ...state, rounds: state.rounds + 1, lastPracticedAt: now };
  if (outcome.accuracy === null) return s;
  const paceMet = outcome.kind !== 'speed' || outcome.paceWpm === null || outcome.wpm === null || outcome.wpm >= outcome.paceWpm * 0.95;
  if (outcome.accuracy >= tuning.accuracyFloor && paceMet) {
    s.cleanRounds++;
    s.roughRounds = 0;
    if (s.cleanRounds >= tuning.raiseAfterCleanRounds) {
      s.level = clamp(s.level + tuning.paceStep, tuning.paceMin, tuning.paceMax);
      s.cleanRounds = 0;
    }
  } else if (outcome.accuracy < tuning.accuracyFloor - tuning.roughMargin) {
    s.roughRounds++;
    s.cleanRounds = 0;
    s.level = clamp(s.level - tuning.paceStep, tuning.paceMin, tuning.paceMax);
  }
  return s;
}

/**
 * Looks at the pattern in ordinary tests: once its cost has fallen below `recoveredShare` of what it
 * was when first targeted it is "recovering" and comes back for review on later days.
 */
export function reviewSchedule(state: PatternState, stat: PatternStat | undefined, tuning: Tuning = TUNING): PatternState {
  if (!stat || state.startCost === null || state.startCost <= 0) return state;
  const recovered = stat.status !== 'learning' && stat.costMs <= state.startCost * tuning.recoveredShare;
  const days = (i: number) => tuning.reviewIntervalsDays[i] * DAY;
  if (!recovered) return state.status === 'recovering' ? { ...state, status: 'training', intervalIndex: 0, nextDueAt: null } : state;
  if (state.status !== 'recovering') return { ...state, status: 'recovering', intervalIndex: 0, nextDueAt: state.lastPracticedAt + days(0) };
  // Waiting for its review: practicing it on or after the due date moves it to the next interval.
  if (state.nextDueAt !== null && state.lastPracticedAt < state.nextDueAt) return state;
  const index = Math.min(state.intervalIndex + 1, tuning.reviewIntervalsDays.length - 1);
  return { ...state, intervalIndex: index, nextDueAt: state.lastPracticedAt + days(index) };
}

export const isDue = (s: PatternState, now: number) => s.status === 'recovering' && s.nextDueAt !== null && s.nextDueAt <= now;
