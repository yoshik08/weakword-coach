// Preload for the Monkeytype window (sandboxed): captures every keystroke of a test and sends the
// finished test, with the result screen's own record of it, to the main process. It also renders what
// the app adds to the page (ui.ts) and, when asked, drives Monkeytype's own UI to load a practice text
// or an ordinary test profile (inject.ts). It never writes Monkeytype's storage or calls its API.
import { ipcRenderer } from 'electron';
import type { HudView, ResultRecord, ResultRowView, TestResult, TestSettings } from '../shared/types';
import { injectPractice, loadProfile, readConfig, type ProfileRequest } from './inject';
import { Recorder } from './recorder';
import { LABEL, SEL } from './selectors';
import { dismissPromoBanner, ensureCoachButton, ensureHud, ensureStyle, focusTyping, patchKeytips, removeFloatingRow, renderRow, setBadge, setHud, showToast } from './ui';

const recorder = new Recorder(performance.timeOrigin);
let resultShown = false;
/** clientId of the test whose result screen is showing (its Coach row may still be on its way). */
let shownClientId: string | null = null;
let pendingRow: ResultRowView | null = null;

function wordText(word: Element): string {
  return Array.from(word.querySelectorAll(SEL.letter))
    .filter((l) => !l.matches(SEL.extraLetter))
    .map((l) => l.getAttribute('data-char') ?? '')
    .join('');
}

function wordIndexOf(word: Element): number {
  return Number(word.getAttribute('data-wordindex'));
}

const isWordsInput = (t: EventTarget | null): t is HTMLTextAreaElement => t instanceof HTMLTextAreaElement && t.matches(SEL.wordsInput);

function onKeydown(e: KeyboardEvent): void {
  const box = e.target;
  if (!isWordsInput(box)) return;
  if (e.isComposing || e.key === 'Process') return recorder.artifact();
  if (e.ctrlKey || e.altKey || e.metaKey) {
    if (e.key === 'Backspace' || e.key.toLowerCase() === 'v') recorder.artifact();
    return;
  }
  if (document.querySelector(SEL.result) || document.querySelector(SEL.openDialog)) return;
  const active = document.querySelector(SEL.activeWord);
  recorder.keydown({
    key: e.key,
    timeStamp: e.timeStamp,
    inputValue: box.value,
    domActiveIndex: active ? wordIndexOf(active) : null,
    repeat: e.repeat,
    shift: e.shiftKey,
    code: e.code,
  });
}

/** Input that the keydown stream does not show keeps the next key out of timing (the input itself is untouched). */
function onInput(e: Event): void {
  if (!isWordsInput(e.target)) return;
  const type = (e as InputEvent).inputType;
  if (type && type !== 'insertText' && type !== 'deleteContentBackward') recorder.artifact();
}

function cellLines(label: string): string[] | null {
  for (const cell of document.querySelectorAll(SEL.resultStat)) {
    if (cell.firstElementChild?.textContent?.trim().toLowerCase() !== label) continue;
    const value = cell.querySelector<HTMLElement>(SEL.resultStatValue);
    return (value?.innerText ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  }
  return null;
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

function readRecord(): ResultRecord {
  return { testType: cellLines(LABEL.testType) ?? [], other: cellLines(LABEL.other) ?? [] };
}

function readSettings(): TestSettings {
  const c = readConfig();
  const out: TestSettings = {};
  if (typeof c.layout === 'string') out.layout = c.layout;
  if (typeof c.confidenceMode === 'string') out.confidenceMode = c.confidenceMode;
  if (Array.isArray(c.quoteLength)) out.quoteLength = c.quoteLength.filter((v): v is number => typeof v === 'number');
  return out;
}

/** "words 25 english" -> mode "words 25", language "english". */
function readMode(): { mode: string; language: string | null } {
  const parts = (document.querySelector(SEL.testMode)?.textContent ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 3) return { mode: parts.join(' '), language: null };
  return { mode: parts.slice(0, -1).join(' '), language: parts[parts.length - 1] };
}

function sendFinishedTest(): void {
  const test = recorder.finish({ result: readResult(), ...readMode(), endedAt: Date.now(), record: readRecord(), settings: readSettings() });
  if (!test) return;
  shownClientId = test.clientId ?? null;
  // The "other" cell (invalid, too short, afk ...) can render a moment after the result.
  setTimeout(() => {
    if (document.querySelector(SEL.result)) {
      const other = cellLines(LABEL.other);
      if (other) test.record = { testType: test.record?.testType ?? [], other };
    }
    ipcRenderer.send('wwc:test-finished', test);
  }, 250);
}

function showRow(view: ResultRowView): void {
  if (view.clientId !== shownClientId || !document.querySelector(SEL.result)) return;
  renderRow(view, (id) => ipcRenderer.send('wwc:row-action', { id, clientId: view.clientId }));
}

let uiQueued = false;
function maintainUi(): void {
  if (uiQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => {
    uiQueued = false;
    ensureStyle();
    ensureCoachButton(() => ipcRenderer.send('wwc:coach-open'));
    dismissPromoBanner();
    patchKeytips();
    ensureHud();
    removeFloatingRow();
    if (pendingRow && document.querySelector(SEL.resultStat)) {
      const row = pendingRow;
      pendingRow = null;
      showRow(row);
    }
  });
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
  if (!result) shownClientId = null;
  resultShown = result !== null;
  maintainUi();
}

window.addEventListener('keydown', onKeydown, { capture: true, passive: true });
window.addEventListener('input', onInput, { capture: true, passive: true });
window.addEventListener('compositionstart', () => recorder.artifact(), { capture: true, passive: true });
window.addEventListener('blur', () => recorder.blurred());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && recorder.blurred());
new MutationObserver(onMutations).observe(document, { childList: true, subtree: true });

ipcRenderer.on('wwc:inject-practice', async (_event, payload: unknown) => {
  const words = (payload as { words?: unknown } | null)?.words;
  const valid = Array.isArray(words) && words.length > 0 && words.every((w) => typeof w === 'string' && w);
  ipcRenderer.send('wwc:inject-done', valid ? await injectPractice(words) : { ok: false, error: 'No practice words' });
});

ipcRenderer.on('wwc:load-profile', async (_event, payload: unknown) => {
  const p = payload as ProfileRequest | null;
  const valid = p && typeof p.mode === 'string' && typeof p.mode2 === 'string' && typeof p.language === 'string';
  ipcRenderer.send('wwc:profile-done', valid ? await loadProfile(p) : { ok: false, error: 'No test profile' });
});

ipcRenderer.on('wwc:result-row', (_event, view: ResultRowView) => {
  if (document.querySelector(SEL.resultStat)) showRow(view);
  else pendingRow = view;
});

ipcRenderer.on('wwc:hud', (_event, view: HudView | null) => {
  setHud(view, (id) => ipcRenderer.send('wwc:hud-action', { id }));
});

ipcRenderer.on('wwc:coach-badge', (_event, b: { dot: boolean; label: string }) => setBadge(b));
ipcRenderer.on('wwc:toast', (_event, text: unknown) => typeof text === 'string' && showToast(text));
ipcRenderer.on('wwc:focus-typing', () => focusTyping());
