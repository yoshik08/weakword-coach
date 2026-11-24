import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadList, loadPools, parseWordList } from '../../src/main/wordlists';

const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'wwc-wl-')), 'wordlists');

describe('word lists', () => {
  it('validates the list shape', () => {
    expect(parseWordList({ words: ['a', 'b'] })).toEqual(['a', 'b']);
    for (const bad of [null, {}, { words: [] }, { words: [1] }, { words: [''] }]) expect(() => parseWordList(bad)).toThrow();
  });

  it('downloads from the site once, then reads the cache offline', async () => {
    const d = dir();
    const urls: string[] = [];
    const fetchJson = async (url: string) => (urls.push(url), { words: ['one', 'two'] });
    expect(await loadList(d, 'english', fetchJson)).toEqual(['one', 'two']);
    expect(urls).toEqual(['https://monkeytype.com/languages/english.json']);
    expect(await loadList(d, 'english', async () => { throw new Error('offline'); })).toEqual(['one', 'two']);
  });

  it('falls back to GitHub, and explains an offline first run', async () => {
    const urls: string[] = [];
    const flaky = async (url: string) => {
      urls.push(url);
      if (url.includes('monkeytype.com')) throw new Error('HTTP 503');
      return { words: ['x'] };
    };
    expect(await loadList(dir(), 'english', flaky)).toEqual(['x']);
    expect(urls[1]).toMatch(/^https:\/\/raw\.githubusercontent\.com\/monkeytypegame\/monkeytype\/master\/frontend\/static\/languages\/english\.json$/);
    await expect(loadList(dir(), 'english', async () => { throw new Error('offline'); })).rejects.toThrow(/internet/);
    await expect(loadList(dir(), '../etc', async () => ({ words: ['x'] }))).rejects.toThrow(/invalid/);
  });

  it('loads the corpus and wider lists of the same language for variety', async () => {
    const lists: Record<string, string[]> = {
      english: ['the', 'of'], english_1k: ['the', 'of', 'paper'], english_5k: ['the', 'of', 'paper', 'zipper'],
    };
    const fetchJson = async (url: string) => {
      const name = url.split('/').pop()!.replace('.json', '');
      if (!lists[name]) throw new Error('HTTP 404');
      return { words: lists[name] };
    };
    expect(await loadPools(dir(), 'english', fetchJson)).toEqual({ primary: lists.english, wider: [lists.english_1k, lists.english_5k] });
    expect(await loadPools(dir(), 'english_1k', fetchJson)).toEqual({ primary: lists.english_1k, wider: [lists.english_5k] });
    // A language without a list of its own falls back to English.
    expect((await loadPools(dir(), 'klingon', fetchJson)).primary).toEqual(lists.english);
  });
});
