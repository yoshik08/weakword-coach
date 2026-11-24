// Preload for the Monkeytype window (sandboxed): captures every keystroke of a test and sends the
// finished test to the main process. It only reads the page, except when the user asks for a
// practice test: then inject.ts loads the words through Monkeytype's own custom text dialog.
import { ipcRenderer } from 'electron';
import type { TestResult } from '../shared/types';
import { injectPractice } from './inject';
import { Recorder } from './recorder';
import { LABEL, SEL } from './selectors';

const recorder = new Recorder(performance.timeOrigin);
let resultShown = false;

function wordText(word: Element): string {
  return Array.from(word.querySelectorAll(SEL.letter))
    .filter((l) => !l.matches(SEL.extraLetter))
    .map((l) => l.getAttribute('data-char') ?? '')
    .join('');
}

function wordIndexOf(word: Element): number {
  return Number(word.getAttribute('data-wordindex'));
}

function onKeydown(e: KeyboardEvent): void {
  if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  const box = e.target;
  if (!(box instanceof HTMLTextAreaElement) || box.id !== 'wordsInput') return;
  if (document.querySelector(SEL.result) || document.querySelector(SEL.openDialog)) return;
  const active = document.querySelector(SEL.activeWord);
  recorder.keydown({
    key: e.key,
    timeStamp: e.timeStamp,
    inputValue: box.value,
    domActiveIndex: active ? wordIndexOf(active) : null,
  });
}

/** Reads a result cell's number by its label; prefers the exact aria-label over the rounded text. */
function readStat(label: string): number | null {
  for (const cell of document.querySelectorAll(SEL.resultStat)) {
    if (cell.firstElementChild?.textContent?.trim().toLowerCase() !== label) continue;
    const value = cell.querySelector(SEL.resultStatValue);
    const n = parseFloat(value?.getAttribute('aria-label') ?? value?.textContent ?? '');
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readResult(): TestResult {
  return {
    wpm: readStat(LABEL.wpm),
    raw: readStat(LABEL.raw),
    accuracy: readStat(LABEL.accuracy),
    consistency: readStat(LABEL.consistency),
  };
}

/** "words 25 english" -> mode "words 25", language "english". */
function readMode(): { mode: string; language: string | null } {
  const parts = (document.querySelector(SEL.testMode)?.textContent ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return { mode: parts.join(' '), language: null };
  return { mode: parts.slice(0, -1).join(' '), language: parts[parts.length - 1] };
}

function sendFinishedTest(): void {
  const test = recorder.finish({ result: readResult(), ...readMode(), endedAt: Date.now() });
  if (test) ipcRenderer.send('wwc:test-finished', test);
}

function onMutations(records: MutationRecord[]): void {
  const added: Element[] = [];
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      added.push(...(node.matches(SEL.word) ? [node] : Array.from(node.querySelectorAll(SEL.word))));
    }
  }
  // Word 0 appearing means a fresh wordset (restart, repeat, new test): drop the old attempt
  // before recording the new words, whatever order they arrived in.
  if (added.some((word) => wordIndexOf(word) === 0)) recorder.reset();
  for (const word of added) recorder.wordSeen(wordIndexOf(word), wordText(word));
  const result = document.querySelector(SEL.result);
  if (result && !resultShown) sendFinishedTest();
  resultShown = result !== null;
}

window.addEventListener('keydown', onKeydown, { capture: true, passive: true });
new MutationObserver(onMutations).observe(document, { childList: true, subtree: true });

ipcRenderer.on('wwc:inject-practice', async (_event, payload: unknown) => {
  const words = (payload as { words?: unknown } | null)?.words;
  const valid = Array.isArray(words) && words.length > 0 && words.every((w) => typeof w === 'string' && w);
  ipcRenderer.send('wwc:inject-done', valid ? await injectPractice(words) : { ok: false, error: 'No practice words' });
});
