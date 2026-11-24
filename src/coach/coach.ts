// The Coach panel: a drawer over the Monkeytype page. Measured progress first, then the next session,
// the heatmap, the progress chart, weak spots and trained skills.
import type { CoachAction, CoachApi } from '../preload/coach';
import { heatmapRows } from '../shared/layout';
import type { CoachState, Diagnosis, PatternStat, SessionPlan, Target } from '../shared/types';
import { $, el } from './dom';
import { renderTrend } from './trend';

declare global {
  interface Window {
    coach: CoachApi;
  }
}

type Tab = 'letters' | 'sequences' | 'words' | 'boundaries';
const TABS: Tab[] = ['letters', 'sequences', 'words', 'boundaries'];
const HEAD: Record<Tab, string> = { letters: 'Letter', sequences: 'Sequence', words: 'Word', boundaries: 'Boundary' };
const EMPTY: Record<Tab, string> = {
  letters: 'No letter has come up yet.',
  sequences: 'No letter pair has come up yet.',
  words: 'No word of three or more letters has come up yet.',
  boundaries: 'Spaces, capitals, numbers and punctuation show up here once you type them.',
};
const TOP_N = 8;

// Heat: time lost per occurrence relative to one ordinary keystroke. Green on par, red when a key costs
// most of an extra keystroke; hue, saturation and lightness blend between the stops.
const STOPS: [number, [number, number, number]][] = [
  [0.04, [146, 52, 47]],
  [0.15, [84, 52, 48]],
  [0.3, [37, 100, 52]],
  [0.6, [4, 100, 61]],
];
const hsl = ([h, s, l]: number[]) => `hsl(${h.toFixed(0)} ${s.toFixed(0)}% ${l.toFixed(0)}%)`;
function heatColor(r: number): string {
  if (r <= STOPS[0][0]) return hsl(STOPS[0][1]);
  for (let i = 1; i < STOPS.length; i++) {
    const [r0, a] = STOPS[i - 1];
    const [r1, b] = STOPS[i];
    if (r <= r1) return hsl(a.map((v, j) => v + ((b[j] - v) * (r - r0)) / (r1 - r0)));
  }
  return hsl(STOPS[STOPS.length - 1][1]);
}
const heatOf = (s: PatternStat) => s.costMs / Math.max(1, s.baselineMs);
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
const msText = (v: number | null) => (v === null ? '–' : String(Math.round(v)));
const signed = (v: number, digits = 0) => {
  const r = Number(v.toFixed(digits));
  return r === 0 ? '±0' : `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}`;
};
const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

let state: CoachState | undefined;
let tab: Tab = 'letters';
let busy = false;
/** A practice message wins over the state's status line for a few seconds (errors until the next one). */
let message: { text: string; kind: 'info' | 'error'; at: number } | null = null;
const keyEls = new Map<string, HTMLButtonElement>();

const act = async (action: CoachAction) => {
  const r = await window.coach.act(action);
  if (!r.ok && r.error) {
    message = { text: r.error, kind: 'error', at: Date.now() };
    setStatus(r.error, 'error');
  }
};

function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
  const s = $('status');
  s.textContent = text;
  s.dataset.state = kind;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', class: cls }, label) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

// Opening, closing, focus

function open(): void {
  if (!busy) message = null; // what happened before the panel opened is shown in the state itself
  document.body.classList.remove('closing');
  requestAnimationFrame(() => document.body.classList.add('open'));
  $('drawer').focus({ preventScroll: true });
  void refresh();
}

let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  document.body.classList.add('closing');
  document.body.classList.remove('open');
  setTimeout(() => {
    document.body.classList.remove('closing');
    closing = false;
    window.coach.closed();
  }, 230);
}

function trapFocus(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = Array.from($('drawer').querySelectorAll<HTMLElement>('button, select, input, [tabindex="0"]')).filter(
    (n) => !n.hasAttribute('disabled') && n.offsetParent !== null && n.tabIndex >= 0,
  );
  if (items.length === 0) return;
  const [first, last] = [items[0], items[items.length - 1]];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === $('drawer'))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Hero: measured change since coaching

function renderHero(s: CoachState): void {
  const body = $('hero-body');
  const select = $('benchmark') as HTMLSelectElement;
  const profiles = [...s.profiles];
  if (s.benchmark && !profiles.some((p) => p.key === s.benchmark!.key)) profiles.unshift(s.benchmark);
  select.replaceChildren(...profiles.map((p) => {
    const o = el('option', { value: p.key }, `${p.label}${p.tests ? ` (${p.tests})` : ''}`) as HTMLOptionElement;
    o.selected = p.key === s.benchmark?.key;
    return o;
  }));
  select.closest('label')!.hidden = profiles.length === 0;
  for (const id of ['normal', 'bench30', 'reset']) ($(id) as HTMLButtonElement).hidden = !s.benchmark;
  $('reset').hidden = !s.progress?.coachingStarted;
  $('hero-title').textContent = s.progress?.coachingStarted ? 'Since coaching' : 'Your baseline';

  const p = s.progress;
  if (!p) {
    body.replaceChildren(el('p', {}, 'Take an ordinary Monkeytype test (time, words or quote). The Coach compares your later tests with how you type today.'));
    return;
  }
  const nodes: Node[] = [];
  const b = p.baseline;
  const need = b?.need ?? 3;
  const pips = (n: number) => {
    const wrap = el('div', { class: 'pips', 'aria-hidden': 'true' });
    for (let i = 0; i < need; i++) wrap.append(el('i', { class: i < n ? 'on' : '' }));
    return wrap;
  };
  if (!p.coachingStarted || (b?.kind === 'fresh' && !b.frozen)) {
    const n = b?.n ?? 0;
    if (n < need) {
      const row = el('div', { class: 'calib', 'data-testid': 'calibration' });
      row.append(el('span', { class: 'num' }, `${n}/${need}`), pips(n));
      nodes.push(row, el('p', {}, `Baseline ${n}/${need} complete. Your baseline for ${p.profileLabel} is the median of ${need} tests${p.coachingStarted ? ' in this mode, starting now' : ' before your first drill'}. ${need - n === 1 ? 'One more test' : `${need - n} more tests`} to go.`));
    } else {
      const row = el('div', { class: 'delta-row' });
      row.append(metric(b!.wpm!.toFixed(1), 'wpm baseline', null), metric(`${b!.acc!.toFixed(1)}%`, 'accuracy', null, true));
      nodes.push(row, el('p', {}, `Median of your last ${need} ${p.profileLabel} tests. It freezes when you start practicing, and later tests are compared with it.`));
    }
  } else if (!b) {
    nodes.push(el('p', {}, p.status));
    nodes.push(button(`Start a baseline for ${p.profileLabel}`, 'ghost', () => void act({ type: 'start-baseline', key: p.profileKey })));
  } else if (!p.latest) {
    nodes.push(el('p', { class: 'lead' }, 'Take a normal test to measure progress.'));
    nodes.push(baselineLine(p.profileLabel, b));
  } else {
    const l = p.latest;
    const row = el('div', { class: 'delta-row', 'data-testid': 'delta' });
    row.dataset.dwpm = l.dWpm.toFixed(1);
    row.append(
      metric(signed(l.dWpm, Math.abs(l.dWpm) < 1 ? 1 : 0), `wpm vs ${b.kind === 'pre-coach' ? 'pre-Coach' : 'baseline'}`, tone(l.dWpm, 0.5)),
      metric(`${signed(l.dAcc, 1)} pp`, 'accuracy', tone(l.dAcc, 0.05), true),
    );
    nodes.push(row);
    const runs = p.postRuns;
    const latest = `${l.wpm.toFixed(1)} wpm, ${l.acc.toFixed(1)}%`;
    const what = l.window > 1
      ? `Median of your last ${l.window} tests (${latest}), ${runs} since coaching began.`
      : `${runs === 1 ? 'One run' : `${runs} runs`} since coaching began; the latest: ${latest}. From 3 runs on, this shows their median.`;
    nodes.push(el('p', {}, what), baselineLine(p.profileLabel, b));
    if (l.dWpm > 0.5 && l.dAcc < -0.05) nodes.push(el('p', {}, 'Faster than your baseline, but less accurate.'));
    else if (l.dWpm < -0.5 && l.dAcc > 0.05) nodes.push(el('p', {}, 'More accurate than your baseline, but slower.'));
  }
  body.replaceChildren(...nodes);
}

function metric(num: string, unit: string, t: 'up' | 'down' | 'flat' | null, small = false): HTMLElement {
  const m = el('div', { class: small ? 'delta small' : 'delta', ...(t ? { 'data-tone': t } : {}) });
  m.append(el('span', { class: 'num' }, num), el('span', { class: 'unit' }, unit));
  return m;
}

const tone = (d: number, eps: number) => (d > eps ? 'up' : d < -eps ? 'down' : 'flat') as 'up' | 'down' | 'flat';

function baselineLine(label: string, b: NonNullable<NonNullable<CoachState['progress']>['baseline']>): HTMLElement {
  const p = el('p');
  const when = b.kind === 'pre-coach' ? `before coaching${b.frozenAt ? ` (frozen ${day(b.frozenAt)})` : ''}` : `from ${day(b.createdAt)}`;
  p.append('Baseline ', el('b', {}, `${b.wpm?.toFixed(1)} wpm, ${b.acc?.toFixed(1)}%`), `: ${label}, median of ${b.n} ${b.n === 1 ? 'test' : 'tests'} ${when}.`);
  return p;
}

function renderFollowup(s: CoachState): void {
  const box = $('followup');
  const f = s.followup;
  if (!f) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const delta = f.retestDelta === null ? '' : ` Your retest right after it was ${signed(f.retestDelta, Math.abs(f.retestDelta) < 1 ? 1 : 0)} wpm.`;
  if (f.due) {
    box.replaceChildren(
      el('strong', {}, 'Follow-up test due'),
      el('p', {}, `A fresh ${f.profileLabel} test shows whether your last session's change held.${delta}`),
      button('Take the follow-up test', 'ghost', () => void act({ type: 'retest' })),
    );
  } else {
    box.replaceChildren(el('strong', {}, `Follow-up test on ${day(f.dueAt)}`), el('p', {}, `A day after your session, take one ${f.profileLabel} test to see if the change held.${delta}`));
  }
}

// Session

function targetRow(t: Target, hint: string | undefined): HTMLElement {
  const row = el('div', { class: 'target', 'data-target': t.id });
  const long = t.label.length > 3;
  row.append(el('div', { class: long ? 'label long' : 'label' }, t.kind === 'space' ? '␣' : t.label));
  row.append(el('div', { class: 'reason' }, t.reason));
  const kind = el('div', { class: 'kind' });
  kind.append(el('b', { 'data-problem': t.problem }, t.problem === 'accuracy' ? 'Accuracy' : 'Speed'), `, from ${t.attempts} tries`);
  row.append(kind);
  if (hint) row.append(el('div', { class: 'fingering' }, hint));
  return row;
}

function stepsList(plan: SessionPlan, current: number | null): HTMLElement {
  const ol = el('ol', { class: 'steps', 'aria-label': 'Steps' });
  plan.steps.forEach((step, i) => {
    const cls = current === null ? '' : i < current ? 'done' : i === current ? 'current' : '';
    const li = el('li', { class: cls }, step.title);
    if (i === current) li.setAttribute('aria-current', 'step');
    ol.append(li);
  });
  return ol;
}

function renderSession(s: CoachState): void {
  const body = $('session-body');
  const meta = $('session-meta');
  const title = $('session-title');
  if (s.session) {
    const plan = s.session.plan;
    title.textContent = plan.kind === 'session' ? 'Session in progress' : 'Practice in progress';
    meta.textContent = `step ${s.session.step + 1} of ${plan.steps.length}`;
    body.replaceChildren(...plan.targets.map((t) => targetRow(t, s.hints[t.id])), stepsList(plan, s.session.step));
    return;
  }
  title.textContent = 'Next session';
  const preview = s.preview;
  if (!preview || 'error' in preview) {
    meta.textContent = '';
    body.replaceChildren(el('p', { class: 'empty' }, preview && 'error' in preview ? preview.error : 'Take an ordinary test first.'));
    return;
  }
  meta.textContent = `about ${preview.estMinutes} min`;
  body.replaceChildren(...preview.targets.map((t) => targetRow(t, s.hints[t.id])), stepsList(preview, null));
}

// Keyboard heatmap

function buildKeyboard(layout: string): void {
  const keys = $('keys');
  if (keys.dataset.layout === layout) return;
  keys.dataset.layout = layout;
  keyEls.clear();
  keys.replaceChildren();
  const rows = heatmapRows(layout);
  const grid = rows.map((letters) => {
    const row = el('div', { class: 'krow' });
    const buttons = [...letters].map((letter) => {
      const key = el('button', { class: 'key', type: 'button', 'data-key': letter, 'data-state': 'unknown', tabindex: '-1' }, letter) as HTMLButtonElement;
      keyEls.set(letter, key);
      row.append(key);
      return key;
    });
    keys.append(row);
    return buttons;
  });
  grid[0][0].tabIndex = 0;
  keys.onkeydown = (e) => {
    const from = (e.target as HTMLElement).dataset.key;
    const r = rows.findIndex((letters) => from && letters.includes(from));
    if (r < 0) return;
    const c = rows[r].indexOf(from!);
    const step: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const move = step[e.key];
    if (!move) return;
    e.preventDefault();
    const nr = Math.min(Math.max(r + move[0], 0), grid.length - 1);
    const nc = Math.min(Math.max(c + move[1], 0), grid[nr].length - 1);
    grid[nr][nc].focus();
  };
}

function renderKeyboard(d: Diagnosis): void {
  buildKeyboard(d.scope.layout);
  const stats = new Map(d.letters.map((s) => [s.label, s]));
  for (const [letter, key] of keyEls) {
    const s = stats.get(letter);
    key.dataset.state = !s ? 'unknown' : s.status === 'learning' ? 'learning' : s.status;
    key.dataset.heat = s ? heatOf(s).toFixed(3) : '';
    key.style.setProperty('--c', s && s.status !== 'learning' ? heatColor(heatOf(s)) : 'transparent');
    key.setAttribute('aria-label', describeKey(letter, s));
  }
}

function describeKey(letter: string, s: PatternStat | undefined): string {
  if (!s) return `${letter}: not typed yet`;
  if (s.status === 'learning') return `${letter}: learning, ${s.attempts} tries so far`;
  return `${letter}: ${msText(s.ms)} ms, ${pct(s.errorRate)} missed, ${s.attempts} tries. ${s.explanation}`;
}

function showTip(key: HTMLButtonElement): void {
  const tip = $('tip');
  const letter = key.dataset.key!;
  const s = state?.diagnosis.letters.find((x) => x.label === letter);
  const fact = (value: string, label: string) => {
    const span = el('span');
    span.append(el('b', {}, value), ` ${label}`);
    return span;
  };
  tip.replaceChildren(el('strong', {}, letter));
  if (!s) tip.append(el('span', {}, 'Not typed yet'));
  else {
    tip.append(fact(msText(s.ms), 'ms'), fact(pct(s.errorRate), 'missed'), fact(String(s.attempts), 'tries'));
    if (s.status === 'learning') tip.append(el('span', {}, 'Learning'));
  }
  tip.hidden = false;
  const box = $('keys').parentElement!.getBoundingClientRect();
  const k = key.getBoundingClientRect();
  const half = tip.offsetWidth / 2;
  tip.style.left = `${Math.min(Math.max(k.left + k.width / 2 - box.left, half), box.width - half)}px`;
  const above = k.top - box.top - tip.offsetHeight - 8;
  tip.style.top = `${above >= 0 ? above : k.bottom - box.top + 8}px`;
}
const hideTip = () => ($('tip').hidden = true);

// Weak spots

function itemsOf(d: Diagnosis, t: Tab): PatternStat[] {
  return t === 'letters' ? d.letters : t === 'sequences' ? d.sequences : t === 'words' ? d.words : d.boundaries;
}

function renderTable(d: Diagnosis): void {
  $('item-head').textContent = HEAD[tab];
  const items = itemsOf(d, tab);
  const shown = [...items.filter((s) => s.status !== 'learning'), ...items.filter((s) => s.status === 'learning')].slice(0, TOP_N);
  const rows = shown.map((s) => {
    const tr = el('tr', { 'data-item': s.label, 'data-status': s.status, title: s.explanation });
    const first = el('td', { class: s.kind === 'word' ? 'item' : 'item display' });
    const label = el('span');
    const dot = el('i', { class: 'dot' });
    dot.style.setProperty('--c', s.status === 'learning' ? 'var(--outline)' : heatColor(heatOf(s)));
    label.append(dot, s.kind === 'space' ? 'space' : s.label);
    if (s.status !== 'ok') label.append(el('span', { class: `chip ${s.status}` }, s.status === 'learning' ? 'Learning' : 'Weak'));
    first.append(label);
    tr.append(first, el('td', { class: 'speed' }, msText(s.ms)), el('td', {}, pct(s.errorRate)), el('td', {}, String(s.attempts)));
    return tr;
  });
  if (rows.length === 0) {
    const tr = el('tr');
    tr.append(el('td', { colspan: '4' }, EMPTY[tab]));
    rows.push(tr);
  }
  $('rows').replaceChildren(...rows);
  const weak = items.filter((s) => s.status === 'weak').slice(0, 2);
  const explain = $('explain');
  if (weak.length > 0) explain.replaceChildren(...weak.map((s) => el('p', {}, s.explanation)));
  else if (items.length > 0 && items.every((s) => s.status === 'learning')) explain.replaceChildren(el('p', {}, `Learning: patterns need ${15} tries across 2 tests before the Coach calls them weak.`));
  else explain.replaceChildren(el('p', {}, items.length ? 'Nothing here stands out from the rest of your typing.' : ''));
}

function selectTab(next: Tab): void {
  tab = next;
  const tabs = $('tabs');
  tabs.dataset.tab = String(TABS.indexOf(next));
  for (const b of tabs.querySelectorAll('button')) {
    const on = b.dataset.kind === next;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (state) renderTable(state.diagnosis);
}

// Trained skills

function renderTransfer(s: CoachState): void {
  const section = $('transfer').closest('section')!;
  section.hidden = s.transfer.length === 0;
  $('transfer').replaceChildren(
    ...s.transfer.map((t) => {
      const li = el('li', { 'data-transfer': t.id });
      li.append(el('span', { class: 'what' }, t.label));
      const value = el('span', { class: 'value' });
      if (t.learning || t.before === null || t.after === null) value.textContent = 'Learning: needs more ordinary tests on both sides';
      else {
        const fmt = (v: number) => (t.metric === 'ms' ? `${Math.round(v)} ms` : `${(v * 100).toFixed(0)}% missed`);
        const better = t.after < t.before;
        value.append(`${fmt(t.before)} → `, el('b', { 'data-tone': better ? 'up' : t.after > t.before ? 'down' : 'flat' }, fmt(t.after)));
      }
      li.append(value);
      return li;
    }),
  );
}

// Page

function render(s: CoachState): void {
  state = s;
  const d = s.diagnosis;
  const layout = d.scope.layout === 'unknown' ? '' : `, ${d.scope.layout}`;
  $('summary').textContent = s.normalTests === 0
    ? 'No ordinary tests yet'
    : `${d.scope.language.replace(/_/g, ' ')}${layout}: ${s.normalTests} ordinary ${s.normalTests === 1 ? 'test' : 'tests'}${s.drillTests ? `, ${s.drillTests} practice ${s.drillTests === 1 ? 'round' : 'rounds'}` : ''}`;
  renderHero(s);
  renderFollowup(s);
  renderSession(s);
  ($('hints') as HTMLInputElement).checked = s.settings.hints;
  ($('warmup') as HTMLInputElement).checked = s.settings.warmup;
  ($('warmup') as HTMLInputElement).disabled = Boolean(s.session);
  renderKeyboard(d);
  renderTrend(s.trend, s.trendTargets.map((id) => id.slice(2)), d.baseline.wpm);
  renderTable(d);
  $('empty').hidden = d.testCount > 0;
  renderTransfer(s);

  const primary = $('primary') as HTMLButtonElement;
  const quick = $('quick') as HTMLButtonElement;
  if (s.session) {
    const step = s.session.plan.steps[s.session.step];
    primary.textContent = step ? `Resume: ${step.title}` : 'Resume';
    primary.dataset.action = 'continue';
    primary.disabled = busy || !step;
    quick.textContent = 'End session';
    quick.dataset.action = 'end-session';
    quick.disabled = busy;
  } else {
    const ok = s.preview && !('error' in s.preview);
    primary.textContent = ok ? `Start session · about ${(s.preview as SessionPlan).estMinutes} min` : 'Start session';
    primary.dataset.action = 'start-session';
    primary.disabled = busy || !ok;
    quick.textContent = 'Practice my weak spots';
    quick.dataset.action = 'quick';
    quick.disabled = busy || d.testCount === 0 || !d.items.some((i) => i.costMs > 0);
  }
  const fresh = message && (busy || message.kind === 'error' || Date.now() - message.at < 4000);
  if (fresh) setStatus(message!.text, message!.kind);
  else setStatus(s.status ?? '');
}

async function refresh(): Promise<void> {
  render(await window.coach.getState());
}

function init(): void {
  const stops = Array.from({ length: 11 }, (_, i) => `${heatColor(i * 0.06)} ${i * 10}%`);
  $('keys').parentElement!.style.setProperty('--ramp', stops.join(', '));
  const keys = $('keys');
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

  const tabs = $('tabs');
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b) selectTab(b.dataset.kind as Tab);
  });
  tabs.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
    if (i === TABS.indexOf(tab) || i < 0 || i >= TABS.length) return;
    selectTab(TABS[i]);
    tabs.querySelector<HTMLElement>(`[data-kind="${TABS[i]}"]`)!.focus();
  });

  for (const id of ['primary', 'quick']) {
    $(id).addEventListener('click', () => void act({ type: $(id).dataset.action as 'start-session' | 'quick' | 'continue' | 'end-session' }));
  }
  $('normal').addEventListener('click', () => void act({ type: 'retest' }));
  $('bench30').addEventListener('click', () => void act({ type: 'benchmark' }));
  $('benchmark').addEventListener('change', (e) => void act({ type: 'set-benchmark', key: (e.target as HTMLSelectElement).value }));
  $('reset').addEventListener('click', () => {
    $('reset-confirm').hidden = false;
    $('reset-yes').focus();
  });
  $('reset-no').addEventListener('click', () => ($('reset-confirm').hidden = true));
  $('reset-yes').addEventListener('click', () => {
    $('reset-confirm').hidden = true;
    void act({ type: 'reset-period' });
  });
  $('hints').addEventListener('change', (e) => void act({ type: 'set-setting', key: 'hints', value: (e.target as HTMLInputElement).checked }));
  $('warmup').addEventListener('change', (e) => void act({ type: 'set-setting', key: 'warmup', value: (e.target as HTMLInputElement).checked }));
  $('close').addEventListener('click', close);
  $('scrim').addEventListener('click', close);
  document.addEventListener('keydown', trapFocus);

  window.coach.onOpen(open);
  window.coach.onClose(close);
  window.coach.onStateChanged(() => {
    if (document.body.classList.contains('open')) void refresh();
  });
  window.coach.onPracticeStatus(({ state: st, error, message: text }) => {
    busy = st === 'running';
    message = { text: st === 'error' ? (error ?? 'Could not start practice.') : (text ?? ''), kind: st === 'error' ? 'error' : 'info', at: Date.now() };
    if (state) render(state);
    else setStatus(message.text, message.kind);
  });
  void refresh();
}

init();
