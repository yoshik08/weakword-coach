// Realistic CoachData for iterating on the coach UI without a real Monkeytype run.
import type { Analysis, CoachData, ItemStat, TestSource } from '../../src/shared/types';

const TARGET = 68;

function stat(item: string, attempts: number, errors: number, msPerChar: number): ItemStat {
  const errorRate = errors / attempts;
  const weakness = (msPerChar / (12000 / TARGET)) * (1 + 4 * errorRate);
  return { item, attempts, errors, errorRate, msPerChar, wpm: 12000 / msPerChar, confidence: 1 / weakness, weakness };
}

const byWeakness = (a: ItemStat, b: ItemStat) => b.weakness - a.weakness;

function analysis(source: TestSource, testCount: number, keys: ItemStat[], bigrams: ItemStat[], words: ItemStat[]): Analysis {
  const minKey = 5;
  return {
    source,
    targetWpm: TARGET,
    testCount,
    keys: keys.filter((k) => k.attempts >= minKey).sort(byWeakness),
    bigrams: bigrams.sort(byWeakness),
    words: words.sort(byWeakness),
    allKeys: keys,
  };
}

// item, attempts, errors, ms per char
const keys = [
  ['e', 96, 7, 330], ['o', 71, 5, 295], ['a', 74, 2, 185], ['i', 68, 1, 170], ['n', 60, 1, 160],
  ['t', 66, 3, 190], ['s', 58, 1, 165], ['r', 54, 4, 215], ['h', 40, 0, 150], ['l', 38, 1, 170],
  ['d', 30, 2, 200], ['u', 28, 1, 175], ['c', 26, 1, 185], ['m', 22, 0, 160], ['p', 20, 3, 235],
  ['f', 18, 0, 168], ['g', 17, 1, 190], ['w', 16, 0, 172], ['y', 14, 0, 180], ['b', 12, 2, 210],
  ['v', 9, 0, 195], ['k', 8, 0, 188], ['x', 3, 0, 260], ['j', 2, 0, 200],
].map(([k, n, e, ms]) => stat(k as string, n as number, e as number, ms as number));

const bigrams = [
  ['er', 14, 3, 300], ['he', 13, 1, 260], ['re', 12, 2, 275], ['on', 11, 1, 240], ['ou', 9, 1, 255],
  ['en', 9, 0, 235], ['te', 8, 1, 250], ['ro', 8, 1, 245], ['an', 12, 0, 175], ['in', 12, 0, 170],
].map(([k, n, e, ms]) => stat(k as string, n as number, e as number, ms as number));

const words = [
  ['everyone', 3, 1, 310], ['becomes', 3, 1, 290], ['procedure', 2, 1, 280], ['those', 4, 0, 265],
  ['thought', 3, 0, 255], ['reference', 2, 0, 250], ['person', 4, 0, 238], ['other', 5, 0, 230],
  ['the', 20, 0, 150],
].map(([k, n, e, ms]) => stat(k as string, n as number, e as number, ms as number));

const empty = (source: TestSource): Analysis => ({ source, targetWpm: TARGET, testCount: 0, keys: [], bigrams: [], words: [], allKeys: [] });

export const coachData: CoachData = {
  standard: analysis('standard', 12, keys, bigrams, words),
  practice: empty('practice'),
};

export const coachDataWithPractice: CoachData = {
  ...coachData,
  practice: { ...analysis('practice', 3, keys, bigrams, words) },
};

export const coachDataEmpty: CoachData = { standard: empty('standard'), practice: empty('practice') };
