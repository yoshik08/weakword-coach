// Monkeytype's English word lists. They are GPL-3.0 data, so we download them on first use
// into the user's profile instead of bundling them with the app.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/monkeytypegame/monkeytype/master/frontend/static/languages/';
const FILES = { common: 'english.json', list: 'english_5k.json' } as const;

export interface WordLists {
  /** The 200 most common words. */
  common: string[];
  /** The 5000-word list practice words are picked from. */
  list: string[];
}

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

async function loadOne(cacheDir: string, file: string, fetchJson: (url: string) => Promise<unknown>): Promise<string[]> {
  const cached = path.join(cacheDir, file);
  try {
    return parseWordList(JSON.parse(await readFile(cached, 'utf8')));
  } catch {
    // Missing or corrupt cache: download it again.
  }
  let words: string[];
  try {
    words = parseWordList(await fetchJson(BASE + file));
  } catch (e) {
    throw new Error(
      `Could not download Monkeytype's word list (${file}: ${(e as Error).message}). Connect to the internet once and try again.`,
    );
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, JSON.stringify({ words }));
  return words;
}

/** Reads the lists from `cacheDir`, downloading whatever is missing. */
export async function loadWordLists(
  cacheDir: string,
  fetchJson: (url: string) => Promise<unknown> = netFetchJson,
): Promise<WordLists> {
  const [common, list] = await Promise.all([
    loadOne(cacheDir, FILES.common, fetchJson),
    loadOne(cacheDir, FILES.list, fetchJson),
  ]);
  return { common, list };
}
