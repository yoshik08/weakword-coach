// Monkeytype's word lists (c) Miodec and the Monkeytype contributors, github.com/monkeytypegame/monkeytype.
// They are GPL-3.0 data, so they are downloaded on first use into the
// user's profile instead of being bundled with the app, then read from that cache (offline).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WordPools } from '../shared/generator';

/** The site serves the lists its tests use; GitHub is the fallback. */
const SOURCES = [
  'https://monkeytype.com/languages/',
  'https://raw.githubusercontent.com/monkeytypegame/monkeytype/master/frontend/static/languages/',
];
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export type FetchJson = (url: string) => Promise<unknown>;

/** Returns the words of a `{ words: string[] }` document, or throws. */
export function parseWordList(json: unknown): string[] {
  const words = (json as { words?: unknown } | null)?.words;
  if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === 'string' && w.length > 0)) {
    throw new Error('unexpected word list format');
  }
  return words as string[];
}

async function netFetchJson(url: string): Promise<unknown> {
  const { net } = await import('electron');
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const isListName = (name: string) => /^[a-z0-9_]{2,40}$/.test(name);

async function download(name: string, fetchJson: FetchJson): Promise<string[]> {
  let last: Error = new Error('no source');
  for (const base of SOURCES) {
    try {
      return parseWordList(await fetchJson(`${base}${name}.json`));
    } catch (e) {
      last = e as Error;
    }
  }
  throw last;
}

/**
 * One list from the cache, downloading it when missing. A cached copy older than a week is refreshed in
 * the background so a changed list shows up as a new corpus version.
 */
export async function loadList(cacheDir: string, name: string, fetchJson: FetchJson = netFetchJson): Promise<string[]> {
  if (!isListName(name)) throw new Error(`invalid word list name: ${name}`);
  const file = path.join(cacheDir, `${name}.json`);
  try {
    const words = parseWordList(JSON.parse(await readFile(file, 'utf8')));
    const age = Date.now() - (await stat(file)).mtimeMs;
    if (age > REFRESH_MS) {
      void download(name, fetchJson)
        .then((fresh) => writeFile(file, JSON.stringify({ words: fresh })))
        .catch(() => {});
    }
    return words;
  } catch {
    // Missing or corrupt cache: download it.
  }
  let words: string[];
  try {
    words = await download(name, fetchJson);
  } catch (e) {
    throw new Error(`Could not download Monkeytype's word list (${name}: ${(e as Error).message}). Connect to the internet once and try again.`);
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify({ words }));
  return words;
}

/** The active corpus for a language plus larger lists of the same language for variety. */
export async function loadPools(cacheDir: string, language: string, fetchJson: FetchJson = netFetchJson): Promise<WordPools> {
  let primary: string[];
  try {
    primary = await loadList(cacheDir, language, fetchJson);
  } catch (e) {
    if (language === 'english') throw e;
    primary = await loadList(cacheDir, 'english', fetchJson);
  }
  const base = language.replace(/_\d+k$/, '');
  const wider: string[][] = [];
  for (const name of [`${base}_1k`, `${base}_5k`, `${base}_10k`]) {
    if (name === language) continue;
    try {
      const list = await loadList(cacheDir, name, fetchJson);
      if (list.length > primary.length) wider.push(list);
    } catch {
      // Not every language has larger lists.
    }
  }
  return { primary, wider };
}
