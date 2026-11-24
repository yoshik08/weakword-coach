// What Weakword Coach adds to the Monkeytype page itself: the Coach button beside the bell, the progress
// row under the result's wpm and acc, the session strip above the words, the key tip for Ctrl+Shift+P,
// and the CSS that collapses ad slots. Everything is themed with Monkeytype's own CSS variables so it
// reads as part of the result screen; the Coach panel (a separate view) carries the app's own look.
import type { HudView, ResultRowView } from '../shared/types';
import { LABEL, SEL } from './selectors';

/** Three keycaps climbing from weak to strong: the app's mark, in the nav's current colour. */
const MARK = `<svg class="wwc-mark" viewBox="0 0 20 16" aria-hidden="true" focusable="false">
<rect x="0.5" y="9.5" width="5.5" height="5.5" rx="1.5" opacity="0.45"/>
<rect x="7.25" y="5.25" width="5.5" height="5.5" rx="1.5" opacity="0.72"/>
<rect x="14" y="1" width="5.5" height="5.5" rx="1.5"/></svg>`;

export const STYLE = `
/* Ads: the slots, their placeholder and the space they occupied. */
${SEL.adSlot}, ${SEL.resultAdWrapper}, #ad-result-small-wrapper, [id^="ad-"][id$="-wrapper"],
#result > div:has(> ${SEL.resultAdWrapper}), div:has(> .ad.advertisement):not(:has(> :not(.ad))),
ins.adsbygoogle, iframe[id^="google_ads_iframe"], div[id^="google_ads_iframe"], .fc-ab-root, .fc-dialog-overlay {
  display: none !important;
}

#wwc-coach { position: relative; }
#wwc-coach .wwc-mark { width: 1.25em; height: 1em; fill: currentColor; display: block; }
#wwc-coach .wwc-dot {
  position: absolute; top: 0.3em; right: 0.3em; width: 0.45em; height: 0.45em; border-radius: 50%;
  background: var(--main-color); box-shadow: 0 0 0 0.15em var(--bg-color);
}

/* Progress row: sits in the wpm/acc column of the result. */
#wwc-row {
  grid-column: 1 / -1;
  justify-self: stretch;
  width: 16rem;
  max-width: 100%;
  margin-top: 0.4rem;
  padding-top: 0.75rem;
  border-top: 0.1rem solid var(--sub-alt-color);
  color: var(--sub-color);
  font-size: 0.8rem;
  line-height: 1.35;
  animation: wwc-in 0.25s ease-out both;
}
#wwc-row.wwc-floating {
  position: fixed; right: 1.5rem; bottom: 1.5rem; z-index: 999; width: 18rem; padding: 0.9rem 1rem;
  border: 0; border-radius: 0.5rem; background: var(--sub-alt-color);
}
#wwc-row .wwc-head { display: flex; align-items: center; gap: 0.45em; margin-bottom: 0.35rem; }
#wwc-row .wwc-head .wwc-mark { width: 1.1em; height: 0.9em; fill: var(--sub-color); }
#wwc-row .wwc-metrics { display: flex; flex-wrap: wrap; gap: 0.2rem 1.2rem; margin-bottom: 0.35rem; }
#wwc-row .wwc-metric { display: grid; }
#wwc-row .wwc-big { color: var(--text-color); font-size: 1.6rem; line-height: 1.1; font-variant-numeric: tabular-nums; }
#wwc-row [data-tone="up"] .wwc-big { color: var(--main-color); }
#wwc-row [data-tone="down"] .wwc-big { color: var(--error-color); }
#wwc-row .wwc-cap { font-size: 0.75rem; }
#wwc-row p { margin: 0.25rem 0 0; }
#wwc-row .wwc-actions { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.6rem; }
.wwc-btn {
  appearance: none; border: 0; border-radius: 0.4rem; padding: 0.4em 0.8em; cursor: pointer;
  background: var(--sub-alt-color); color: var(--text-color); font: inherit; font-size: 0.8rem; line-height: 1.25;
  transition: background 0.125s, color 0.125s;
}
.wwc-btn:hover { background: var(--text-color); color: var(--bg-color); }
.wwc-btn[data-primary] { background: var(--main-color); color: var(--bg-color); }
.wwc-btn[data-primary]:hover { background: var(--text-color); }
.wwc-btn:focus-visible { outline: 0; box-shadow: 0 0 0 0.1rem var(--bg-color), 0 0 0 0.2rem var(--text-color); }
.wwc-btn kbd { margin-left: 0.5em; font: inherit; font-size: 0.7rem; opacity: 0.7; }

/* Session strip above the words; it fades out while you type. */
#wwc-hud {
  display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 0.35rem 0.75rem;
  margin: 0 auto 0.75rem; max-width: 46rem; font-size: 0.85rem; line-height: 1.4; color: var(--sub-color); text-align: center;
  transition: opacity 0.15s;
}
#wwc-hud .wwc-mark { width: 1.1em; height: 0.9em; fill: var(--main-color); flex: none; }
#wwc-hud b { color: var(--text-color); font-weight: inherit; }
#wwc-hud .wwc-btn { font-size: 0.75rem; padding: 0.25em 0.7em; }
html[data-focused] #wwc-hud { opacity: 0; pointer-events: none; }
#wwc-keytip { display: flex; align-items: center; gap: 0.5rem; }
#wwc-toast {
  position: fixed; left: 50%; bottom: 2rem; z-index: 1000; transform: translateX(-50%);
  display: flex; align-items: center; gap: 0.6em; max-width: min(36rem, calc(100vw - 2rem)); padding: 0.7em 1.1em;
  border-radius: 0.5rem; background: var(--sub-alt-color); color: var(--text-color); font-size: 0.85rem; line-height: 1.4;
  box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, 0.35); animation: wwc-in 0.2s ease-out both;
}
#wwc-toast .wwc-mark { flex: none; width: 1.1em; height: 0.9em; fill: var(--main-color); }

@keyframes wwc-in { from { opacity: 0; transform: translateY(0.3rem); } }
@media (prefers-reduced-motion: reduce) { #wwc-row { animation: none; } }
`;

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function mark(): Element {
  const t = document.createElement('template');
  t.innerHTML = MARK;
  return t.content.firstElementChild!;
}

export function ensureStyle(): void {
  if (document.getElementById('wwc-style')) return;
  const parent = document.head ?? document.documentElement;
  if (!parent) return;
  const style = el('style', { id: 'wwc-style' });
  style.textContent = STYLE;
  parent.append(style);
}

// Coach button

let badge = { dot: false, label: '' };

/** Puts the Coach button right after the bell (Solid can re-render the nav, so this runs on DOM changes). */
export function ensureCoachButton(onOpen: () => void): void {
  const bell = document.querySelector<HTMLElement>(SEL.navBell);
  if (!bell) return;
  let button = document.getElementById('wwc-coach');
  if (!button) {
    button = el('button', { id: 'wwc-coach', type: 'button', 'data-nav-item': 'weakword-coach', 'aria-haspopup': 'dialog' });
    button.append(mark(), el('span', { class: 'wwc-dot', hidden: '' }));
    button.addEventListener('click', (e) => {
      e.preventDefault();
      onOpen();
    });
    applyBadge(button);
  }
  // Same look as the bell, including its focus-mode fade.
  const cls = bell.className;
  if (button.className !== cls) button.className = cls;
  if (bell.nextElementSibling !== button) bell.after(button);
}

function applyBadge(button: HTMLElement): void {
  const label = badge.label ? `Weakword Coach: ${badge.label}` : 'Weakword Coach';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  (button.querySelector('.wwc-dot') as HTMLElement).hidden = !badge.dot;
}

export function setBadge(next: { dot: boolean; label: string }): void {
  badge = next;
  const button = document.getElementById('wwc-coach');
  if (button) applyBadge(button);
}

// Result row

/** The grid holding the result's wpm and acc cells. */
function mainStatsGrid(): HTMLElement | null {
  const first = document.querySelector(SEL.resultStat);
  return (first?.parentElement as HTMLElement | null) ?? null;
}

export function renderRow(view: ResultRowView, onAction: (id: string) => void): 'inline' | 'floating' {
  document.getElementById('wwc-row')?.remove();
  const row = el('div', { id: 'wwc-row', role: 'group', 'aria-label': 'Weakword Coach progress', 'data-kind': view.kind });
  for (const [k, v] of Object.entries(view.data)) row.dataset[k] = v;
  const head = el('div', { class: 'wwc-head' });
  head.append(mark(), el('span', {}, view.heading));
  row.append(head);
  if (view.metrics.length > 0) {
    const metrics = el('div', { class: 'wwc-metrics' });
    for (const m of view.metrics) {
      const cell = el('div', { class: 'wwc-metric', 'data-id': m.id, ...(m.tone ? { 'data-tone': m.tone } : {}) });
      cell.append(el('span', { class: 'wwc-big' }, m.delta ?? m.value), el('span', { class: 'wwc-cap' }, m.delta ? `${m.caption} · ${m.value}` : m.caption));
      metrics.append(cell);
    }
    row.append(metrics);
  }
  for (const line of view.lines) row.append(el('p', {}, line));
  if (view.actions.length > 0) {
    const actions = el('div', { class: 'wwc-actions' });
    for (const a of view.actions) {
      const b = el('button', { type: 'button', class: 'wwc-btn', 'data-action': a.id, ...(a.primary ? { 'data-primary': '' } : {}) }, a.label);
      if (a.kbd) b.append(el('kbd', {}, a.kbd));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onAction(a.id);
      });
      actions.append(b);
    }
    row.append(actions);
  }
  const grid = mainStatsGrid();
  if (grid && document.querySelector(SEL.result)?.contains(grid)) {
    grid.append(row);
    return 'inline';
  }
  // The result screen changed shape: show the row as an app-owned card beside it instead.
  row.classList.add('wwc-floating');
  document.body.append(row);
  return 'floating';
}

export function removeFloatingRow(): void {
  const row = document.getElementById('wwc-row');
  if (row?.classList.contains('wwc-floating') && !document.querySelector(SEL.result)) row.remove();
}

// Session strip

let hud: HudView | null = null;
let hudAction: (id: string) => void = () => {};

export function setHud(view: HudView | null, onAction: (id: string) => void): void {
  hud = view;
  hudAction = onAction;
  document.getElementById('wwc-hud')?.remove();
  ensureHud();
}

export function ensureHud(): void {
  if (!hud || document.getElementById('wwc-hud')) return;
  const typing = document.querySelector(SEL.typingTest);
  if (!typing) return;
  const strip = el('div', { id: 'wwc-hud', role: 'status', 'aria-live': 'polite', 'data-state': hud.state });
  strip.append(mark());
  strip.append(el('span', {}, hud.steps > 1 ? `Coach ${hud.step}/${hud.steps}` : 'Coach'));
  const title = el('b', {}, hud.title);
  strip.append(title, el('span', {}, hud.instruction));
  const end = hud.steps > 1 ? 'End session' : 'Stop practice';
  const buttons: [string, string][] = hud.state === 'paused' ? [['resume', 'Resume'], ['end', end]] : [['end', end]];
  for (const [id, label] of buttons) {
    const b = el('button', { type: 'button', class: 'wwc-btn', 'data-hud': id, tabindex: '-1' }, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      hudAction(id);
    });
    strip.append(b);
  }
  typing.prepend(strip);
}

// Promotions

let promoClosed = false;
/**
 * Monkeytype's merch-store banner pushes the page down by its height, so hiding it would leave a gap.
 * Its own close button dismisses it for good (Monkeytype remembers that), so press it once, like a user.
 * Only this promotional banner: notices and errors stay.
 */
export function dismissPromoBanner(): void {
  if (promoClosed) return;
  const link = document.querySelector('a[href*="mktp.co/merch"], a[href*="monkeytype.store"]');
  const close = link?.closest('div.content-grid')?.querySelector<HTMLButtonElement>('button:has(.fa-times)');
  if (!close) return;
  promoClosed = true;
  close.click();
}

// Key tips

/** Ctrl+Shift+P belongs to the Coach in this app: the command-line tip keeps Esc and gains a practice tip. */
export function patchKeytips(): void {
  const footer = document.querySelector(SEL.footer);
  if (!footer || footer.querySelector('#wwc-keytip')) return;
  const tip = Array.from(footer.querySelectorAll('div')).find(
    (d) => d.lastElementChild?.textContent?.trim() === LABEL.commandLineTip && d.querySelectorAll(':scope > kbd').length >= 1,
  );
  if (!tip) return;
  const kbds = tip.querySelectorAll<HTMLElement>(':scope > kbd');
  if (kbds.length >= 2) {
    const second = kbds[1];
    const or = second.previousSibling;
    if (or && or.nodeType === Node.TEXT_NODE) (or as Text).data = '';
    second.style.display = 'none';
  }
  const ours = el('div', { id: 'wwc-keytip', class: tip.className });
  ours.append(el('kbd', {}, 'ctrl + shift + p'), el('span', {}, '- practice weak spots'));
  tip.after(ours);
}

// Messages

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message from the Coach when its panel is closed (e.g. a drill that could not load). */
export function showToast(text: string): void {
  document.getElementById('wwc-toast')?.remove();
  clearTimeout(toastTimer);
  const toast = el('div', { id: 'wwc-toast', role: 'status', 'aria-live': 'polite' });
  toast.append(mark(), el('span', {}, text));
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 7000);
}

// Focus

/** Back to the typing surface: the result's focus anchor (Tab then reaches "next test") or the words input. */
export function focusTyping(): void {
  if (document.querySelector(SEL.openDialog)) return;
  if (document.querySelector(SEL.result)) {
    document.querySelector<HTMLElement>(SEL.resultPrefocus)?.focus({ preventScroll: true });
    return;
  }
  document.querySelector<HTMLTextAreaElement>(SEL.wordsInput)?.focus({ preventScroll: true });
}
