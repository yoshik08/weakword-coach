// DOM-free recorder: turns observations of a Monkeytype test into a CapturedTest.
import { KS_AFTER_ARTIFACT, KS_AFTER_BLUR, KS_REPEAT, KS_SHIFT, type CapturedTest, type Keystroke, type ResultRecord, type TestResult, type TestSettings } from '../shared/types';

export interface KeyObservation {
  /** KeyboardEvent.key. */
  key: string;
  /** KeyboardEvent.timeStamp (ms, monotonic). */
  timeStamp: number;
  /** #wordsInput.value read at keydown, i.e. the state BEFORE this key; always has a leading space. */
  inputValue: string;
  /** data-wordindex of the DOM's active word, or null if unknown. It can lag one word at fast typing. */
  domActiveIndex: number | null;
  /** KeyboardEvent.repeat (a held key). */
  repeat?: boolean;
  /** KeyboardEvent.shiftKey. */
  shift?: boolean;
  /** KeyboardEvent.code (physical key). */
  code?: string;
}

/** A DOM that has been quiet this long (ms) has certainly rendered the previous key. */
const DOM_SETTLE_MS = 50;

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class Recorder {
  private words = new Map<number, string>();
  private keystrokes: Keystroke[] = [];
  private firstTimeStamp = 0;
  private lastTimeStamp = 0;
  /** Our own idea of the active word; the DOM is rAF-batched and can be stale. */
  private wordIndex = 0;
  /** Words committed with Space while wrong: Backspace can step back into these. */
  private committedWrong = new Set<number>();
  private maxWordIndex = 0;
  /** Flags for the next recorded key (focus loss, paste, IME ... happened since the last one). */
  private pending = 0;
  private keyCodes: Record<string, string> = {};
  private clientId = newId();

  /** @param timeOrigin epoch ms of timeStamp 0 (performance.timeOrigin in a page). */
  constructor(private timeOrigin = 0) {}

  get started(): boolean {
    return this.keystrokes.length > 0;
  }

  /** Remember a word's target text; words scroll out of the DOM, so call when they appear. */
  wordSeen(index: number, text: string): void {
    this.words.set(index, text);
  }

  /** The window lost focus: the next key's timing spans the interruption. */
  blurred(): void {
    if (this.started) this.pending |= KS_AFTER_BLUR;
  }

  /** Input the keydown stream does not show (paste, IME, Ctrl+Backspace): the next key is not clean. */
  artifact(): void {
    if (this.started) this.pending |= KS_AFTER_ARTIFACT;
  }

  /** Records one key. Returns the keystroke, or null when the key is not recorded. */
  keydown(obs: KeyObservation): Keystroke | null {
    const { key, timeStamp, inputValue, domActiveIndex } = obs;
    const isBackspace = key === 'Backspace';
    if (!isBackspace && key.length !== 1) return null;
    const charIndex = Math.max(0, inputValue.length - 1);
    // The test starts on the first character key; Space on an empty word is ignored by Monkeytype.
    if (!this.started && isBackspace) return null;
    if (key === ' ' && charIndex === 0) return null;

    if (!this.started) {
      this.firstTimeStamp = timeStamp;
      this.wordIndex = domActiveIndex ?? 0;
      this.pending = 0;
    } else if (domActiveIndex !== null && timeStamp - this.lastTimeStamp > DOM_SETTLE_MS) {
      this.wordIndex = domActiveIndex;
    }
    this.lastTimeStamp = timeStamp;

    const word = this.words.get(this.wordIndex);
    let expected: string | null = null;
    if (!isBackspace && word !== undefined) {
      if (charIndex < word.length) expected = word[charIndex];
      else if (charIndex === word.length) expected = ' ';
    }

    let flags = this.pending;
    if (obs.repeat) flags |= KS_REPEAT;
    if (obs.shift) flags |= KS_SHIFT;
    this.pending = 0;
    const keystroke: Keystroke = {
      seq: this.keystrokes.length,
      t: timeStamp - this.firstTimeStamp,
      key,
      expected,
      correct: !isBackspace && key === expected,
      wordIndex: this.wordIndex,
      pos: charIndex,
      flags,
    };
    this.keystrokes.push(keystroke);
    this.maxWordIndex = Math.max(this.maxWordIndex, this.wordIndex);
    if (obs.code && /^[a-zA-Z]$/.test(key) && !obs.repeat) this.keyCodes[key.toLowerCase()] = obs.code;

    if (key === ' ') {
      // charIndex > 0 here: the word is committed, right or wrong.
      if (inputValue.slice(1) !== word) this.committedWrong.add(this.wordIndex);
      this.wordIndex++;
    } else if (isBackspace && charIndex === 0 && this.committedWrong.delete(this.wordIndex - 1)) {
      // Monkeytype restores the previous word's input only if it was committed wrong.
      this.wordIndex--;
    }
    return keystroke;
  }

  /** Ends the test and returns it (null if nothing was typed). Always resets the recorder. */
  finish(info: {
    result: TestResult;
    mode: string;
    language: string | null;
    endedAt: number;
    record?: ResultRecord;
    settings?: TestSettings;
  }): CapturedTest | null {
    if (!this.started) {
      this.reset();
      return null;
    }
    const words = Array.from({ length: this.maxWordIndex + 1 }, (_, i) => this.words.get(i) ?? '');
    const test: CapturedTest = {
      clientId: this.clientId,
      startedAt: Math.round(this.timeOrigin + this.firstTimeStamp),
      endedAt: info.endedAt,
      mode: info.mode,
      language: info.language,
      words,
      keystrokes: this.keystrokes,
      result: info.result,
      record: info.record,
      settings: info.settings,
      keyCodes: this.keyCodes,
    };
    this.reset();
    return test;
  }

  /** Discards everything, including known words (a restart brings new ones). */
  reset(): void {
    this.words = new Map();
    this.keystrokes = [];
    this.committedWrong = new Set();
    this.firstTimeStamp = 0;
    this.lastTimeStamp = 0;
    this.wordIndex = 0;
    this.maxWordIndex = 0;
    this.pending = 0;
    this.keyCodes = {};
    this.clientId = newId();
  }
}
