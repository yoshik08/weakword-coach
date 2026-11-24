// Plans a short training session: optional warm-up, accuracy, speed, mixed context, normal retest.
import { isDue } from './practice-model';
import { profileLabel } from './profile';
import { TUNING, type Tuning } from './tuning';
import type { Diagnosis, PatternState, PatternStat, PlanStep, Profile, SessionPlan, StepKind, Target } from './types';
import { clamp } from './util';

export interface PlanInput {
  kind: SessionPlan['kind'];
  diagnosis: Diagnosis;
  practice: PatternState[];
  profile: Profile;
  profileKey: string;
  /** The typist's own clean pace: median wpm of recent accurate ordinary tests. */
  paceWpm: number | null;
  seed: number;
  now: number;
  warmup?: boolean;
  reviewWords?: string[];
  tuning?: Tuning;
}

const letters = (s: PatternStat) => (s.kind === 'letter' || s.kind === 'bigram' || s.kind === 'trigram' ? s.label : null);

/** A sequence that contains an already chosen letter (or sequence) trains the same thing. */
function overlaps(a: PatternStat, b: PatternStat): boolean {
  const [x, y] = [letters(a), letters(b)];
  return x !== null && y !== null && (x.includes(y) || y.includes(x));
}

/** Why a pattern was chosen, in plain words; fallback and provisional picks say what they are. */
function reasonFor(s: PatternStat): string {
  if (s.status === 'weak') return s.explanation;
  const name = s.kind === 'word' ? `"${s.label}"` : s.kind === 'space' ? 'the space bar' : s.label;
  if (s.status === 'ok') return `Nothing stands out, so this is your biggest remaining cost: about ${Math.round(s.costMs)} ms each time ${name} comes up.`;
  return `${s.explanation} Picked because it looks costliest so far.`;
}

export function toTarget(s: PatternStat): Target {
  return {
    id: s.id, kind: s.kind, label: s.label, problem: s.problem ?? 'speed', reason: reasonFor(s),
    ms: s.ms, errorRate: s.errorRate, attempts: s.attempts, impact: s.impact, costMs: s.costMs,
  };
}

/**
 * One to three high-impact patterns, plus a recovering pattern whose review is due. With `provisional`
 * (a quick drill on sparse history) the costliest patterns seen so far stand in, still marked Learning.
 */
export function chooseTargets(d: Diagnosis, practice: PatternState[], now: number, tuning: Tuning = TUNING, provisional = false): Target[] {
  let pool = d.top;
  if (pool.length === 0) pool = d.items.filter((s) => s.status === 'ok' && s.costMs > 0 && s.impact > 0).slice(0, 2);
  if (pool.length === 0 && provisional) pool = d.items.filter((s) => s.attempts >= 3 && s.costMs > 0 && s.impact > 0).slice(0, 2);
  const picked: PatternStat[] = [];
  for (const s of pool) {
    if (picked.length >= tuning.maxTargets) break;
    if (picked.length > 0 && s.impact < picked[0].impact * tuning.targetImpactRatio) break;
    if (picked.some((p) => overlaps(p, s))) continue;
    picked.push(s);
  }
  const due = practice
    .filter((p) => isDue(p, now))
    .map((p) => d.items.find((s) => s.id === p.id))
    .filter((s): s is PatternStat => s !== undefined && !picked.some((p) => p.id === s.id));
  if (due.length > 0) {
    if (picked.length < tuning.maxTargets) picked.push(due[0]);
    else picked[picked.length - 1] = due[0];
  }
  return picked.map(toTarget);
}

const join = (labels: string[]) =>
  labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;

function label(t: Target): string {
  if (t.kind === 'space') return 'the space bar';
  if (t.kind === 'start') return 'word starts';
  if (t.kind === 'shift') return 'capitals';
  if (t.kind === 'digit') return 'numbers';
  if (t.kind === 'word') return `"${t.label}"`;
  return t.label;
}

function retestSeconds(p: Profile, pace: number): number {
  const n = Number(p.mode2);
  if (p.mode === 'time' && Number.isFinite(n)) return n;
  if (p.mode === 'words' && Number.isFinite(n)) return Math.round((n * 60) / pace);
  return 40;
}

export function planSession(input: PlanInput): SessionPlan | { error: string } {
  const tuning = input.tuning ?? TUNING;
  const { diagnosis: d, profile } = input;
  const pace = Math.round(input.paceWpm ?? d.baseline.wpm ?? 40);
  const floor = tuning.accuracyFloor;
  const floorPct = Math.round(floor * 100);
  const wordsFor = (seconds: number, wpm: number) => clamp(Math.round((seconds * wpm) / 60), tuning.wordsMin, tuning.wordsMax);
  const steps: Omit<PlanStep, 'index' | 'estSeconds'>[] = [];
  let targets: Target[] = [];

  if (input.kind === 'review') {
    const words = input.reviewWords ?? [];
    if (words.length === 0) return { error: 'That test had no missed or slow words to review.' };
    steps.push({
      kind: 'review', title: 'Review missed and slow words',
      instruction: `Type ${join(words.slice(0, 4).map((w) => `"${w}"`))}${words.length > 4 ? ' and the rest' : ''} cleanly, mixed with similar words.`,
      words: wordsFor(tuning.stepSeconds.review, pace), paceWpm: Math.round(pace * tuning.accuracyPace), accuracyFloor: floor, targets: [],
    });
  } else {
    targets = chooseTargets(d, input.practice, input.now, tuning, input.kind === 'quick');
    if (targets.length === 0) {
      return {
        error: d.sparse
          ? 'Still learning: finish a few more ordinary tests so the Coach can see what slows you down.'
          : 'Nothing stands out right now: your letters, pairs and words are all close to your own baseline.',
      };
    }
    const level = (id: string) => input.practice.find((p) => p.id === id)?.level ?? 1;
    const ids = (ts: Target[]) => ts.map((t) => t.id);
    const names = (ts: Target[]) => join(ts.map(label));
    const accuracyTargets = targets.filter((t) => t.problem === 'accuracy');
    const speedTargets = targets.filter((t) => t.problem === 'speed');

    if (input.kind === 'quick') {
      steps.push({
        kind: 'quick', title: 'Practice my weak spots',
        instruction: `${names(targets)} in common words. Aim for ${floorPct}% clean, then speed.`,
        words: wordsFor(tuning.stepSeconds.quick, pace), paceWpm: pace, accuracyFloor: floor, targets: ids(targets),
      });
    } else {
      if (input.warmup ?? tuning.warmup) {
        steps.push({
          kind: 'warmup', title: 'Warm-up',
          instruction: 'Common words at an easy pace to loosen up. Not part of your scores.',
          words: wordsFor(tuning.stepSeconds.warmup, pace), paceWpm: null, accuracyFloor: null, targets: [],
        });
      }
      const accTargets = accuracyTargets.length > 0 ? accuracyTargets : targets;
      const accPace = Math.round(pace * tuning.accuracyPace);
      const accRounds = accuracyTargets.length > 0 ? tuning.accuracyRounds : 1;
      for (let r = 0; r < accRounds; r++) {
        steps.push({
          kind: 'accuracy', title: accRounds > 1 ? `Accuracy ${r + 1}` : 'Accuracy',
          instruction: `Slow, clean repetitions: get ${names(accTargets)} right the first time. Aim for ${floorPct}% at about ${accPace} wpm.`,
          words: wordsFor(tuning.stepSeconds.accuracy, accPace),
          paceWpm: accPace, accuracyFloor: floor, targets: ids(accTargets),
        });
      }
      const spd = speedTargets.length > 0 ? speedTargets : targets;
      const bursts = speedTargets.length > 0 ? tuning.speedBursts : 1;
      const lvl = spd.reduce((sum, t) => sum + level(t.id), 0) / spd.length;
      for (let b = 0; b < bursts; b++) {
        const p = Math.round(pace * lvl * (1 + 0.05 * b));
        steps.push({
          kind: 'speed', title: bursts > 1 ? `Speed burst ${b + 1}` : 'Speed burst',
          instruction: `Short and quick: push ${names(spd)} to about ${p} wpm while staying above ${floorPct}%.`,
          words: wordsFor(tuning.stepSeconds.speed, p), paceWpm: p, accuracyFloor: floor, targets: ids(spd),
        });
      }
      const runs = d.fading ? [0.6, 1.2] : [1];
      runs.forEach((f, i) => {
        steps.push({
          kind: 'mixed', title: runs.length > 1 ? `Mixed run ${i + 1}` : 'Mixed',
          instruction: `Fresh words with ${names(targets)} among ordinary ones${profile.punctuation ? ', in sentences' : ''}. Keep the rhythm steady to the end.`,
          words: wordsFor(tuning.stepSeconds.mixed * f, pace), paceWpm: pace, accuracyFloor: 0.95, targets: ids(targets),
        });
      });
      steps.push({
        kind: 'retest', title: 'Normal retest',
        instruction: `An ordinary ${profileLabel(profile)} test with Monkeytype's own words. It counts toward your progress.`,
        words: 0, paceWpm: null, accuracyFloor: null, targets: [],
      });
    }
  }

  const planned: PlanStep[] = steps.map((s, index) => ({
    ...s,
    index,
    estSeconds: s.kind === 'retest' ? retestSeconds(profile, pace) + 8 : Math.round((s.words * 60) / (s.paceWpm ?? pace)) + 8,
  }));
  return {
    kind: input.kind,
    seed: input.seed,
    createdAt: input.now,
    targets,
    steps: planned,
    profileKey: input.profileKey,
    profileLabel: profileLabel(profile),
    profile,
    estMinutes: Math.max(1, Math.round(planned.reduce((n, s) => n + s.estSeconds, 0) / 60)),
    reviewWords: input.reviewWords,
  };
}

export const isDrillStep = (k: StepKind) => k !== 'retest';
