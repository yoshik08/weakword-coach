// Coach window UI: keyboard heatmap, weak spots table, practice button.
import type { CoachApi } from '../preload/coach';
import type { Analysis, CoachData, ItemStat } from '../shared/types';
import { $, el } from './dom';
import { renderTrend } from './trend';

declare global {
  interface Window {
    coach: CoachApi;
  }
}

type Kind = 'keys' | 'bigrams' | 'words';
const HEAD: Record<Kind, string> = { keys: 'Letter', bigrams: 'Bigram', words: 'Word' };
const EMPTY: Record<Kind, string> = {
  keys: 'No letter has enough attempts yet.',
  bigrams: 'No letter pair has been typed often enough yet.',
  words: 'No word has come up often enough yet.',
};
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const TOP_N = 8;

// Confidence colour: red at <= 0.5, amber at 0.8, green at >= 1; hue, saturation and lightness blend between the stops.
const STOPS: [number, [number, number, number]][] = [
  [0.5, [4, 100, 61]],
  [0.8, [37, 100, 52]],
  [0.9, [84, 52, 48]],
  [1, [146, 52, 47]],
];
const hsl = ([h, s, l]: number[]) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
function confidenceColor(confidence: number): string {
  if (confidence <= STOPS[0][0]) return hsl(STOPS[0][1]);
  for (let i = 1; i < STOPS.length; i++) {
    const [c0, a] = STOPS[i - 1];
    const [c1, b] = STOPS[i];
    if (confidence <= c1) return hsl(a.map((v, j) => v + ((b[j] - v) * (confidence - c0)) / (c1 - c0)));
  }
  return hsl(STOPS[STOPS.length - 1][1]);
}
const stateOf = (confidence: number) => (confidence < 0.8 ? 'weak' : confidence < 1 ? 'ok' : 'strong');
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

let data: Analysis | undefined;
let practicing = false;
let kind: Kind = 'keys';
const keyEls = new Map<string, HTMLButtonElement>();

// Keyboard

function buildKeyboard(): void {
  const keys = $('keys');
  const grid = ROWS.map((letters) => {
    const row = el('div', { class: 'row' });
    const buttons = [...letters].map((letter) => {
      const key = el('button', { class: 'key', type: 'button', 'data-key': letter, 'data-state': 'unknown', 'data-confidence': '', tabindex: '-1' }, letter) as HTMLButtonElement;
      keyEls.set(letter, key);
      row.append(key);
      return key;
    });
    keys.append(row);
    return buttons;
  });
  keyEls.get('q')!.tabIndex = 0;

  // One tab stop for the whole keyboard; arrow keys move between keys.
  keys.addEventListener('keydown', (e) => {
    const from = (e.target as HTMLElement).dataset.key;
    const r = ROWS.findIndex((letters) => from && letters.includes(from));
    if (r < 0) return;
    const c = ROWS[r].indexOf(from!);
    const step: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const move = step[e.key];
    if (!move) return;
    e.preventDefault();
    const nr = Math.min(Math.max(r + move[0], 0), grid.length - 1);
    const nc = Math.min(Math.max(c + move[1], 0), grid[nr].length - 1);
    grid[nr][nc].focus();
  });
  keys.addEventListener('focusin', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLButtonElement>('.key');
    if (!key) return;
    for (const k of keyEls.values()) k.tabIndex = k === key ? 0 : -1;
    showTip(key);
  });
  keys.addEventListener('focusout', hideTip);
  keys.addEventListener('pointerover', (e) => {
    const key = (e.target as HTMLElement).closest<HTMLButtonElement>('.key');
    if (key) showTip(key);
  });
  keys.addEventListener('pointerleave', hideTip);
}

function renderKeyboard(a: Analysis): void {
  const known = new Map(a.keys.map((s) => [s.item, s]));
  for (const [letter, key] of keyEls) {
    const stat = known.get(letter);
    key.dataset.state = stat ? stateOf(stat.confidence) : 'unknown';
    key.dataset.confidence = stat ? stat.confidence.toFixed(2) : '';
    key.style.setProperty('--c', stat ? confidenceColor(stat.confidence) : 'transparent');
    key.setAttribute('aria-label', describeKey(letter, stat, a));
  }
}

function describeKey(letter: string, stat: ItemStat | undefined, a: Analysis): string {
  if (stat) return `${letter}: ${Math.round(stat.wpm)} wpm, ${pct(stat.errorRate)} errors, ${stat.attempts} attempts`;
  const seen = a.allKeys.find((s) => s.item === letter);
  return seen ? `${letter}: only ${seen.attempts} attempts so far` : `${letter}: not typed yet`;
}

function showTip(key: HTMLButtonElement): void {
  const tip = $('tip');
  const letter = key.dataset.key!;
  const stat = data?.keys.find((s) => s.item === letter);
  const seen = data?.allKeys.find((s) => s.item === letter);
  const fact = (value: string, label: string) => {
    const span = el('span');
    span.append(el('b', {}, value), ` ${label}`);
    return span;
  };
  tip.replaceChildren(el('strong', {}, letter));
  if (stat) tip.append(fact(String(Math.round(stat.wpm)), 'wpm'), fact(pct(stat.errorRate), 'errors'), fact(String(stat.attempts), 'attempts'));
  else tip.append(el('span', {}, seen ? `Only ${seen.attempts} attempts so far` : 'Not typed yet'));
  tip.hidden = false;
  const box = $('keys').parentElement!.getBoundingClientRect();
  const k = key.getBoundingClientRect();
  const half = tip.offsetWidth / 2;
  const x = Math.min(Math.max(k.left + k.width / 2 - box.left, half), box.width - half);
  tip.style.left = `${x}px`;
  // Above the key, except on the top row where it would cover the header: then below.
  const above = k.top - box.top - tip.offsetHeight - 8;
  tip.style.top = `${above >= 0 ? above : k.bottom - box.top + 8}px`;
}
const hideTip = () => ($('tip').hidden = true);

// Weak spots table

function renderTable(a: Analysis): void {
  $('item-head').textContent = HEAD[kind];
  const rows = a[kind].slice(0, TOP_N).map((s) => {
    const tr = el('tr', { 'data-item': s.item });
    const first = el('td', { class: kind === 'words' ? 'item' : 'item display' });
    const dot = el('i', { class: 'dot' });
    dot.style.setProperty('--c', confidenceColor(s.confidence));
    const label = el('span');
    label.append(dot, s.item);
    first.append(label);
    tr.append(first, el('td', { class: 'speed' }, `${Math.round(s.wpm)}`), el('td', {}, pct(s.errorRate)), el('td', {}, String(s.attempts)));
    return tr;
  });
  if (rows.length === 0) {
    const tr = el('tr');
    tr.append(el('td', { colspan: '4' }, EMPTY[kind]));
    rows.push(tr);
  }
  $('rows').replaceChildren(...rows);
}

function selectTab(next: Kind): void {
  kind = next;
  const tabs = $('tabs');
  tabs.dataset.tab = String(Object.keys(HEAD).indexOf(next));
  for (const b of tabs.querySelectorAll('button')) {
    const on = b.dataset.kind === next;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (data) renderTable(data);
}

// Page

function render(all: CoachData): void {
  const a = all.standard;
  data = a;
  const n = a.testCount;
  $('summary').textContent = n === 0 ? 'No tests yet' : `Based on ${n} ${n === 1 ? 'test' : 'tests'}, target ${Math.round(a.targetWpm)} wpm`;
  renderKeyboard(a);
  renderTable(a);
  renderTrend(all.trend, all.focusKeys, a.targetWpm);
  $('empty').hidden = n > 0;
  const sessions = all.practice.testCount;
  // Practising needs something to practise: at least one standard test.
  if (!practicing) ($('practice') as HTMLButtonElement).disabled = n === 0;
  $('practice-note').textContent = sessions > 0 ? `Practice: ${sessions} ${sessions === 1 ? 'session' : 'sessions'}` : '';
}

async function refresh(): Promise<void> {
  render(await window.coach.getData());
}

function init(): void {
  const stops = Array.from({ length: 11 }, (_, i) => `${confidenceColor(0.5 + i * 0.05)} ${i * 10}%`);
  $('keys').parentElement!.style.setProperty('--ramp', stops.join(', '));
  buildKeyboard();

  const tabs = $('tabs');
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) selectTab(b.dataset.kind as Kind);
  });
  tabs.addEventListener('keydown', (e) => {
    const order = Object.keys(HEAD) as Kind[];
    const i = order.indexOf(kind) + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
    if (i === order.indexOf(kind) || i < 0 || i >= order.length) return;
    selectTab(order[i]);
    tabs.querySelector<HTMLElement>(`[data-kind="${order[i]}"]`)!.focus();
  });

  $('practice').addEventListener('click', () => void window.coach.startPractice());
  window.coach.onPracticeStatus(({ state, error }) => {
    practicing = state === 'running';
    ($('practice') as HTMLButtonElement).disabled = practicing || (data?.testCount ?? 0) === 0;
    $('practice-status').textContent =
      state === 'running' ? 'Preparing…' : state === 'done' ? 'Practice loaded in Monkeytype' : (error ?? 'Could not start practice.');
  });

  window.coach.onDataChanged(() => void refresh());
  void refresh();
}

init();
