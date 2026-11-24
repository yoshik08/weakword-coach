import { describe, expect, it } from 'vitest';
import { Recorder } from '../../src/preload/recorder';
import { KS_AFTER_ARTIFACT, KS_AFTER_BLUR, KS_REPEAT, KS_SHIFT } from '../../src/shared/types';

const result = { wpm: 50, raw: 55, accuracy: 95, consistency: 80 };
const finish = (r: Recorder) => r.finish({ result, mode: 'words 3', language: 'english', endedAt: 1000 });

/** Mimics Monkeytype's input box (leading space) and feeds the recorder like the preload does. */
class Typist {
  value = ' ';
  now = 1000;
  domIndex = 0;
  constructor(readonly rec: Recorder) {}

  /** Press keys `gap` ms apart. `domLag` makes the DOM's active word lag one word behind. */
  press(keys: string[], gap = 100, domLag = false) {
    for (const key of keys) {
      this.now += gap;
      this.rec.keydown({
        key,
        timeStamp: this.now,
        inputValue: this.value,
        domActiveIndex: domLag && this.domIndex > 0 ? this.domIndex - 1 : this.domIndex,
      });
      if (key === ' ') {
        if (this.value.length > 1) {
          this.value = ' ';
          this.domIndex++;
        }
      } else if (key === 'Backspace') {
        if (this.value.length > 1) this.value = this.value.slice(0, -1);
      } else this.value += key;
    }
  }
  /** Backspace into the previous word, which Monkeytype restores when it was committed wrong. */
  restore(text: string) {
    this.value = ` ${text}`;
    this.domIndex--;
  }
}

function setup(words: string[]) {
  const rec = new Recorder();
  words.forEach((w, i) => rec.wordSeen(i, w));
  return new Typist(rec);
}

describe('Recorder', () => {
  it('records a correct run with expected chars and relative times', () => {
    const t = setup(['if', 'on']);
    t.press([...'if', ' ', ...'on'], 100);
    const test = finish(t.rec)!;
    expect(test.words).toEqual(['if', 'on']);
    expect(test.keystrokes.map((k) => [k.key, k.expected, k.correct, k.wordIndex])).toEqual([
      ['i', 'i', true, 0],
      ['f', 'f', true, 0],
      [' ', ' ', true, 0],
      ['o', 'o', true, 1],
      ['n', 'n', true, 1],
    ]);
    expect(test.keystrokes.map((k) => k.t)).toEqual([0, 100, 200, 300, 400]);
    expect(test.keystrokes.map((k) => k.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(test.startedAt).toBe(1100);
    expect(test).toMatchObject({ mode: 'words 3', language: 'english', endedAt: 1000, result });
  });

  it('adds timeOrigin to startedAt', () => {
    const rec = new Recorder(5000);
    rec.wordSeen(0, 'a');
    rec.keydown({ key: 'a', timeStamp: 12.4, inputValue: ' ', domActiveIndex: 0 });
    expect(finish(rec)!.startedAt).toBe(5012);
  });

  it('marks a wrong letter incorrect with the expected char', () => {
    const t = setup(['cat']);
    t.press([...'cxt']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks[1]).toMatchObject({ key: 'x', expected: 'a', correct: false });
    expect(ks[2]).toMatchObject({ key: 't', expected: 't', correct: true });
  });

  it('treats letters past the word end as wrong, with Space expected right at the end', () => {
    const t = setup(['go', 'to']);
    t.press([...'gox', 'y', ' ', ...'to']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks[2]).toMatchObject({ key: 'x', expected: ' ', correct: false, wordIndex: 0 });
    expect(ks[3]).toMatchObject({ key: 'y', expected: null, correct: false, wordIndex: 0 });
    expect(ks[4]).toMatchObject({ key: ' ', expected: null, correct: false, wordIndex: 0 });
    expect(ks[5]).toMatchObject({ key: 't', expected: 't', wordIndex: 1 });
  });

  it('commits an early Space as an incorrect key and moves to the next word', () => {
    const t = setup(['hello', 'world']);
    t.press([...'he', ' ', ...'wor']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks[2]).toMatchObject({ key: ' ', expected: 'l', correct: false, wordIndex: 0 });
    expect(ks[3]).toMatchObject({ key: 'w', expected: 'w', correct: true, wordIndex: 1 });
  });

  it('ignores Space on an empty word and Backspace before the first character', () => {
    const t = setup(['ab']);
    t.press(['Backspace', ' ', 'a', ' ', 'b']);
    // Only a, then " " at index 1 (early commit), then b in the next (unknown) word.
    const ks = finish(t.rec)!.keystrokes;
    expect(ks.map((k) => k.key)).toEqual(['a', ' ', 'b']);
    expect(ks[0].t).toBe(0);
  });

  it('records a Backspace correction within a word', () => {
    const t = setup(['cat']);
    t.press(['c', 'x', 'Backspace', 'a', 't']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks.map((k) => [k.key, k.expected, k.correct])).toEqual([
      ['c', 'c', true],
      ['x', 'a', false],
      ['Backspace', null, false],
      ['a', 'a', true],
      ['t', 't', true],
    ]);
  });

  it('steps back a word when Backspace hits the start of a wrongly committed word', () => {
    const t = setup(['cat', 'dog']);
    t.press([...'cxt', ' ']); // committed wrong, now on word 1
    t.press(['Backspace']); // at the start of word 1: MT restores "cxt"
    t.restore('cxt');
    t.press(['Backspace', 'Backspace', ...'at']); // fix the word, then Space
    t.press([' ', ...'do']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks[4]).toMatchObject({ key: 'Backspace', wordIndex: 1 });
    expect(ks[5]).toMatchObject({ key: 'Backspace', wordIndex: 0 });
    expect(ks[7]).toMatchObject({ key: 'a', expected: 'a', wordIndex: 0 });
    expect(ks[9]).toMatchObject({ key: ' ', expected: ' ', correct: true, wordIndex: 0 });
    expect(ks[10]).toMatchObject({ key: 'd', expected: 'd', wordIndex: 1 });
  });

  it('does not step back into a correctly committed word', () => {
    const t = setup(['cat', 'dog']);
    t.press([...'cat', ' ', 'Backspace', 'd']);
    const ks = finish(t.rec)!.keystrokes;
    expect(ks[5]).toMatchObject({ key: 'd', expected: 'd', correct: true, wordIndex: 1 });
  });

  it('trusts its own word counter over a stale DOM index at fast typing', () => {
    const t = setup(['ab', 'cd']);
    t.press([...'ab', ' ', ...'cd'], 8, true); // 8 ms apart: the DOM lags one word after Space
    const ks = finish(t.rec)!.keystrokes;
    expect(ks.slice(3).map((k) => [k.key, k.expected, k.correct, k.wordIndex])).toEqual([
      ['c', 'c', true, 1],
      ['d', 'd', true, 1],
    ]);
  });

  it('resyncs the word counter from the DOM after a pause', () => {
    const rec = new Recorder();
    ['ab', 'cd', 'ef'].forEach((w, i) => rec.wordSeen(i, w));
    rec.keydown({ key: 'a', timeStamp: 100, inputValue: ' ', domActiveIndex: 0 });
    // The recorder missed everything in between (e.g. keys outside the filter); the DOM says word 2.
    const quiet = rec.keydown({ key: 'e', timeStamp: 300, inputValue: ' ', domActiveIndex: 2 });
    expect(quiet).toMatchObject({ wordIndex: 2, expected: 'e', correct: true });
    // Within 50 ms the DOM is not trusted.
    const fast = rec.keydown({ key: 'f', timeStamp: 320, inputValue: ' e', domActiveIndex: 0 });
    expect(fast).toMatchObject({ wordIndex: 2, expected: 'f', correct: true });
  });

  it('ignores non-character keys', () => {
    const t = setup(['a']);
    t.press(['Shift', 'Tab', 'Enter', 'ArrowLeft', 'a']);
    expect(finish(t.rec)!.keystrokes).toHaveLength(1);
  });

  it('returns null when nothing was typed and starts clean after finish or reset', () => {
    const t = setup(['ab', 'cd']);
    expect(finish(t.rec)).toBeNull();
    t.press(['a']);
    t.rec.reset(); // abandoned test
    expect(t.rec.started).toBe(false);
    t.rec.wordSeen(0, 'xy');
    t.now = 50_000;
    t.value = ' ';
    t.domIndex = 0;
    t.press(['x', 'y']);
    const test = finish(t.rec)!;
    expect(test.words).toEqual(['xy']);
    expect(test.keystrokes.map((k) => [k.key, k.t, k.correct])).toEqual([
      ['x', 0, true],
      ['y', 100, true],
    ]);
    expect(finish(t.rec)).toBeNull();
  });

  it('records the caret position, Shift, repeats and the physical keys of letters', () => {
    const rec = new Recorder();
    rec.wordSeen(0, 'Aa');
    rec.keydown({ key: 'A', timeStamp: 10, inputValue: ' ', domActiveIndex: 0, shift: true, code: 'KeyA' });
    rec.keydown({ key: 'a', timeStamp: 20, inputValue: ' A', domActiveIndex: 0, repeat: true, code: 'KeyA' });
    const test = finish(rec)!;
    expect(test.keystrokes.map((k) => [k.pos, k.flags])).toEqual([[0, KS_SHIFT], [1, KS_REPEAT]]);
    expect(test.keyCodes).toEqual({ a: 'KeyA' });
  });

  it('flags the first key after focus loss or input it cannot see (paste, IME, Ctrl+Backspace)', () => {
    const t = setup(['abcd']);
    t.press(['a']);
    t.rec.blurred();
    t.press(['b']);
    t.rec.artifact();
    t.press(['c', 'd']);
    expect(finish(t.rec)!.keystrokes.map((k) => k.flags)).toEqual([0, KS_AFTER_BLUR, KS_AFTER_ARTIFACT, 0]);
  });

  it('gives every attempt its own id and a fresh one after a restart', () => {
    const t = setup(['a']);
    t.press(['a']);
    const first = finish(t.rec)!.clientId;
    t.rec.wordSeen(0, 'a');
    t.value = ' ';
    t.press(['a']);
    const second = finish(t.rec)!.clientId;
    expect(first).toMatch(/.{8,}/);
    expect(second).not.toBe(first);
  });

  it('includes words up to the furthest one reached', () => {
    const t = setup(['a', 'b', 'c', 'd']);
    t.press(['a', ' ', 'b', ' ', 'c']);
    expect(finish(t.rec)!.words).toEqual(['a', 'b', 'c']);
  });
});
