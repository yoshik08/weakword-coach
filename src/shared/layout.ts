// Keyboard layouts: fingerprinting from KeyboardEvent.code/key pairs, heatmap rows and fingering hints.

/** Physical keys of the three letter rows (US ANSI positions), left to right. */
const CODE_ROWS = [
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
];

/** Characters each layout puts on CODE_ROWS (same positions). */
const LAYOUTS: Record<string, string[]> = {
  qwerty: ['qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./'],
  qwertz: ['qwertzuiop', 'asdfghjkl;', 'yxcvbnm,./'],
  azerty: ['azertyuiop', 'qsdfghjklm', 'wxcvbn,;:!'],
  dvorak: ["',.pyfgcrl", 'aoeuidhtns', ';qjkxbmwvz'],
  colemak: ['qwfpgjluy;', 'arstdhneio', 'zxcvbkm,./'],
  'colemak-dh': ['qwfpbjluy;', 'arstgmneio', 'zxcdvkh,./'],
  workman: ['qdrwbjfup;', 'ashtgyneoi', 'zxmcvkl,./'],
};

export const KNOWN_LAYOUTS = Object.keys(LAYOUTS);

/** Letters of each heatmap row for a layout (non-letters dropped). */
export function heatmapRows(layout: string | null | undefined): string[] {
  const rows = LAYOUTS[layout ?? ''] ?? LAYOUTS.qwerty;
  return rows.map((r) => [...r].filter((c) => /[a-z]/.test(c)).join(''));
}

/**
 * Names the layout from letter -> code pairs seen while typing.
 * Needs 8+ distinct letters; returns null with less evidence and "other" when no layout fits 90%.
 */
export function fingerprintLayout(keyCodes: Record<string, string> | undefined): string | null {
  const pairs = Object.entries(keyCodes ?? {}).filter(([k]) => /^[a-z]$/.test(k));
  if (pairs.length < 8) return null;
  let best: { name: string; score: number } = { name: 'other', score: 0 };
  for (const [name, rows] of Object.entries(LAYOUTS)) {
    let hits = 0;
    for (const [letter, code] of pairs) {
      const r = CODE_ROWS.findIndex((row) => row.includes(code));
      if (r >= 0 && rows[r][CODE_ROWS[r].indexOf(code)] === letter) hits++;
    }
    const score = hits / pairs.length;
    if (score > best.score) best = { name, score };
  }
  return best.score >= 0.9 ? best.name : 'other';
}

type Hand = 'left' | 'right';
type Finger = 'pinky' | 'ring' | 'middle' | 'index';

/** Standard touch-typing finger for a physical key. */
function fingerOf(code: string): { hand: Hand; finger: Finger; row: number; col: number } | null {
  for (let r = 0; r < CODE_ROWS.length; r++) {
    const c = CODE_ROWS[r].indexOf(code);
    if (c < 0) continue;
    const fingers: [Hand, Finger][] = [
      ['left', 'pinky'], ['left', 'ring'], ['left', 'middle'], ['left', 'index'], ['left', 'index'],
      ['right', 'index'], ['right', 'index'], ['right', 'middle'], ['right', 'ring'], ['right', 'pinky'],
    ];
    const [hand, finger] = fingers[c];
    return { hand, finger, row: r, col: c };
  }
  return null;
}

/** Physical code of a character in a layout, preferring what was actually observed. */
function codeFor(ch: string, layout: string, observed?: Record<string, string>): string | null {
  if (observed?.[ch]) return observed[ch];
  const rows = LAYOUTS[layout] ?? LAYOUTS.qwerty;
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].indexOf(ch);
    if (c >= 0) return CODE_ROWS[r][c];
  }
  return null;
}

const HOME_COL: Record<Hand, Record<Finger, number>> = {
  left: { pinky: 0, ring: 1, middle: 2, index: 3 },
  right: { index: 6, middle: 7, ring: 8, pinky: 9 },
};

function homeChar(hand: Hand, finger: Finger, layout: string): string {
  const rows = LAYOUTS[layout] ?? LAYOUTS.qwerty;
  return rows[1][HOME_COL[hand][finger]];
}

/** A short, layout-aware fingering hint for a pattern id (k:p, b:th, x:space ...), or null. */
export function fingeringHint(patternId: string, layout: string | null | undefined, observed?: Record<string, string>): string | null {
  const lay = layout && LAYOUTS[layout] ? layout : 'qwerty';
  const [kind, body] = [patternId.slice(0, 2), patternId.slice(2)];
  const describe = (ch: string) => {
    const code = codeFor(ch, lay, observed);
    const f = code ? fingerOf(code) : null;
    if (!f) return null;
    const home = homeChar(f.hand, f.finger, lay);
    const where = f.row === 1
      ? f.col === HOME_COL[f.hand][f.finger] ? 'its home key' : `one step in from ${home}`
      : `${f.row === 0 ? 'up' : 'down'} from ${home}`;
    return { f, text: `${f.hand} ${f.finger}, ${where}` };
  };
  if (kind === 'k:') {
    const d = describe(body);
    return d ? `${body}: ${d.text}.` : null;
  }
  if (kind === 'b:' || kind === 't:') {
    const fs = [...body].map((ch) => describe(ch)?.f ?? null);
    if (fs.some((f) => f === null)) return null;
    for (let i = 1; i < fs.length; i++) {
      const [a, b] = [fs[i - 1]!, fs[i]!];
      if (a.hand === b.hand && a.finger === b.finger && body[i] !== body[i - 1]) {
        return `${body[i - 1]}${body[i]} uses the same finger (${a.hand} ${a.finger}): move from the wrist instead of rushing the jump.`;
      }
    }
    const hands = new Set(fs.map((f) => f!.hand));
    return hands.size === 1
      ? `${body} stays on the ${fs[0]!.hand} hand: start moving the next finger while the previous key goes down.`
      : `${body} alternates hands: let both hands move at once.`;
  }
  if (patternId === 'x:space') return 'Space: use the thumb of the hand that did not type the last letter.';
  if (patternId === 'x:start') return 'Word starts: read the next word while your thumb presses Space.';
  if (patternId === 'x:shift') return 'Capitals: hold Shift with the hand opposite the letter.';
  if (patternId === 'x:digit') return 'Numbers: reach up from the home row with the finger above it, then return.';
  return null;
}
