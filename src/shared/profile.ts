// Test profiles (what makes two ordinary tests comparable), test kinds and eligibility.
import { fingerprintLayout } from './layout';
import type { CapturedTest, Profile, ResultRecord, TestKind, TestResult } from './types';

const KNOWN_MODIFIERS = /^(blind|lazy|expert|master|stop on .+|delete on .+)$/;

/** Splits "words 25" into mode and mode2. */
function splitMode(mode: string): { mode: string; mode2: string } {
  const [m = 'unknown', m2 = m] = mode.trim().split(/\s+/);
  return { mode: m, mode2: m2 };
}

/** Old tests have no result record: infer punctuation/numbers from the words they showed. */
export function inferPunctuation(words: string[]): boolean {
  return words.some((w) => /[^a-z0-9]/.test(w) && !/^\d+$/.test(w));
}
export function inferNumbers(words: string[]): boolean {
  return words.some((w) => /\d/.test(w));
}

/** The comparison profile of a captured test. `fallbackLayout` is used when this test is too short to fingerprint. */
export function profileOf(test: CapturedTest, fallbackLayout: string | null = null): Profile {
  const { mode, mode2: premidMode2 } = splitMode(test.mode);
  const lines = test.record?.testType ?? [];
  const language = test.language ?? 'unknown';
  let mode2 = premidMode2;
  if (mode === 'quote') mode2 = lines[0]?.split(/\s+/)[1] ?? (test.settings?.quoteLength?.join(',') || 'all');
  if (mode === 'custom' || mode === 'zen') mode2 = mode;

  let punctuation: boolean;
  let numbers: boolean;
  const modifiers: string[] = [];
  if (test.record) {
    const display = language.replace(/_/g, ' ');
    const rest = lines.slice(1).filter((l, i) => !(i === 0 && l === display));
    punctuation = rest.includes('punctuation');
    numbers = rest.includes('numbers');
    for (const line of rest) {
      if (line === 'punctuation' || line === 'numbers') continue;
      if (KNOWN_MODIFIERS.test(line)) modifiers.push(line);
      else modifiers.push(`funbox ${line}`);
    }
  } else {
    punctuation = inferPunctuation(test.words);
    numbers = inferNumbers(test.words);
  }
  const confidence = test.settings?.confidenceMode;
  if (confidence && confidence !== 'off') modifiers.push(`confidence ${confidence}`);
  const emulated = test.settings?.layout;
  if (emulated && emulated !== 'default') modifiers.push(`emulating ${emulated}`);

  const layout = fingerprintLayout(test.keyCodes) ?? fallbackLayout ?? 'unknown';
  return { mode, mode2, language, punctuation, numbers, modifiers: [...new Set(modifiers)].sort(), layout };
}

export function profileKey(p: Profile): string {
  const flags = [p.punctuation && 'punctuation', p.numbers && 'numbers'].filter(Boolean).join('+');
  return [`${p.mode} ${p.mode2}`, p.language, flags, p.modifiers.join(','), p.layout].join('|');
}

export function profileFromKey(key: string): Profile {
  const [mm = '', language = 'unknown', flags = '', mods = '', layout = 'unknown'] = key.split('|');
  const { mode, mode2 } = splitMode(mm);
  return {
    mode, mode2, language,
    punctuation: flags.includes('punctuation'),
    numbers: flags.includes('numbers'),
    modifiers: mods ? mods.split(',') : [],
    layout,
  };
}

export function profileLabel(p: Profile): string {
  const parts = [`${p.mode === p.mode2 ? p.mode : `${p.mode} ${p.mode2}`}`, p.language.replace(/_/g, ' ')];
  if (p.punctuation) parts.push('punctuation');
  if (p.numbers) parts.push('numbers');
  parts.push(...p.modifiers);
  if (p.layout !== 'qwerty' && p.layout !== 'unknown') parts.push(p.layout);
  return parts.join(' · ');
}

/** Language + layout: diagnostics never mix these. */
export const scopeKey = (p: Pick<Profile, 'language' | 'layout'>) => `${p.language}|${p.layout}`;

/** normal = Monkeytype's own untargeted generator (time, words, quote). */
export function kindOf(mode: string, isDrill: boolean): TestKind {
  const m = splitMode(mode).mode;
  if (m === 'custom') return isDrill ? 'drill' : 'custom';
  if (m === 'zen') return 'zen';
  return 'normal';
}

/** Result-screen "other" lines that make Monkeytype itself refuse to save or rank a result. */
const DISQUALIFYING = /^(invalid|too short|repeated|bailed out|failed|afk detected)/;

export function eligibility(
  kind: TestKind,
  result: TestResult,
  record: ResultRecord | undefined,
  sameWordsAsPrevious: boolean,
): { eligible: boolean; reason: string | null } {
  if (kind === 'drill') return { eligible: false, reason: 'practice round' };
  if (kind === 'custom') return { eligible: false, reason: 'custom text' };
  if (kind === 'zen') return { eligible: false, reason: 'zen mode' };
  if (result.wpm === null || result.accuracy === null) return { eligible: false, reason: 'no score on the result screen' };
  const flags = record?.other.filter((l) => DISQUALIFYING.test(l)) ?? [];
  if (flags.length > 0) return { eligible: false, reason: flags.join(', ') };
  if (sameWordsAsPrevious) return { eligible: false, reason: 'same words as the previous test' };
  return { eligible: true, reason: null };
}
