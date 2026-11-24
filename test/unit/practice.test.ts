import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPracticeSession, insertPracticeSession, openDb } from '../../src/main/db';
import { loadWordLists, parseWordList } from '../../src/main/wordlists';
import type { PracticePlan } from '../../src/shared/types';

const plan = (words: string[]): PracticePlan => ({ words, focusKeys: ['e'], focusBigrams: ['re'], focusWords: ['here'], seed: 1 });

describe('practice sessions', () => {
  it('finds a session only by its exact words', () => {
    const db = openDb(':memory:');
    const a = insertPracticeSession(db, plan(['here', 'there']));
    const b = insertPracticeSession(db, plan(['here', 'where']));
    expect(findPracticeSession(db, ['here', 'there'])).toBe(a);
    expect(findPracticeSession(db, ['here', 'where'])).toBe(b);
    expect(findPracticeSession(db, ['here'])).toBeNull();
    const row = db.prepare('SELECT focus FROM practice_sessions WHERE id = ?').get(a) as { focus: string };
    expect(JSON.parse(row.focus)).toEqual({ keys: ['e'], bigrams: ['re'], words: ['here'] });
  });
});

describe('word lists', () => {
  it('validates the list shape', () => {
    expect(parseWordList({ words: ['a', 'b'] })).toEqual(['a', 'b']);
    for (const bad of [null, {}, { words: [] }, { words: [1] }, { words: [''] }]) expect(() => parseWordList(bad)).toThrow();
  });

  it('downloads once, then reads the cache', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'wwc-wl-')), 'wordlists');
    let calls = 0;
    const fetchJson = async () => (calls++, { words: ['one', 'two'] });
    expect(await loadWordLists(dir, fetchJson)).toEqual({ common: ['one', 'two'], list: ['one', 'two'] });
    expect(calls).toBe(2);
    await loadWordLists(dir, async () => { throw new Error('offline'); });
  });

  it('explains an offline first run', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'wwc-wl-')), 'wordlists');
    await expect(loadWordLists(dir, async () => { throw new Error('offline'); })).rejects.toThrow(/internet/);
  });
});
