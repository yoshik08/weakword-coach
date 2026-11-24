// How often each pattern occurs in the active test corpus. Monkeytype's time/words modes draw words
// uniformly from the language list, so a pattern's expected rate is its mean count per drawn word.
import { hash } from './util';

export interface CorpusFreq {
  /** Hash of the word list: changes when Monkeytype changes the list. */
  version: string;
  /** Pattern id -> expected occurrences per 100 typed characters. */
  perHundred: Map<string, number>;
  /** Mean characters per word including the following space. */
  charsPerWord: number;
  size: number;
}

export function corpusVersion(words: string[]): string {
  return hash(words.join('\n'));
}

export function buildCorpusFreq(words: string[]): CorpusFreq {
  const counts = new Map<string, number>();
  const add = (id: string, n = 1) => counts.set(id, (counts.get(id) ?? 0) + n);
  let chars = 0;
  for (const raw of words) {
    const w = raw.trim();
    if (!w) continue;
    chars += w.length + 1;
    add('x:space');
    add('x:start');
    const lower = w.toLowerCase();
    for (const ch of w) {
      if (/[a-z]/.test(ch)) add(`k:${ch}`);
      else if (/[A-Z]/.test(ch)) {
        add(`k:${ch.toLowerCase()}`);
        add('x:shift');
      } else if (/[0-9]/.test(ch)) add('x:digit');
      else add(`p:${ch}`);
    }
    for (let i = 1; i < lower.length; i++) {
      if (/[a-z]{2}/.test(lower.slice(i - 1, i + 1))) add(`b:${lower.slice(i - 1, i + 1)}`);
      if (i >= 2 && /[a-z]{3}/.test(lower.slice(i - 2, i + 1))) add(`t:${lower.slice(i - 2, i + 1)}`);
    }
    const letters = lower.replace(/[^a-z]/g, '');
    if (letters.length >= 3) add(`w:${letters}`);
  }
  const perHundred = new Map<string, number>();
  if (chars > 0) for (const [id, n] of counts) perHundred.set(id, (n / chars) * 100);
  return { version: corpusVersion(words), perHundred, charsPerWord: words.length ? chars / words.length : 6, size: words.length };
}
