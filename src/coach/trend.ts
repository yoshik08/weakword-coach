// Progress chart: Monkeytype's wpm and the speed on the current targets, per test, as one hand-written SVG.
// Filled points are ordinary tests; hollow points are practice rounds.
import type { TrendPoint } from '../shared/types';
import { $, el } from './dom';

const NS = 'http://www.w3.org/2000/svg';
const W = 432;
const H = 168;
const PAD = { l: 30, r: 10, t: 18, b: 24 };
/** Above this many tests only practice rounds (and the active test) keep a marker. */
const MARKER_LIMIT = 30;

type Attrs = Record<string, string | number>;
function svg(tag: string, attrs: Attrs = {}, text?: string): SVGElement {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

const SERIES = [
  { id: 'overall', value: (p: TrendPoint) => p.wpm },
  { id: 'weak', value: (p: TrendPoint) => p.targetWpm },
] as const;
const round = (v: number | null) => (v === null ? 'no data' : String(Math.round(v)));

export function renderTrend(points: TrendPoint[], targets: string[], baselineWpm: number | null): void {
  const plot = $('trend-plot');
  const box = plot.parentElement!;
  const tip = $('trend-tip');
  const enough = points.length >= 2;
  $('trend-empty').hidden = enough;
  box.hidden = !enough;
  $('trend-legend').hidden = !enough;
  $('trend-weak').textContent = targets.length > 0 ? `Speed on ${targets.join(' ')}` : 'Speed on targets';
  tip.hidden = true;
  if (!enough) return plot.replaceChildren();

  const values = points.flatMap((p) => [p.wpm, p.targetWpm]).filter((v): v is number => v !== null);
  const top = Math.ceil(Math.max(baselineWpm ?? 0, ...values, 20) / 20) * 20;
  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / top) * (H - PAD.t - PAD.b);

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  for (const v of [0, top / 2, top]) {
    chart.append(svg('line', { class: 'grid', x1: PAD.l, x2: W - PAD.r, y1: y(v), y2: y(v) }));
    chart.append(svg('text', { class: 'tick', x: PAD.l - 8, y: y(v), dy: '0.35em', 'text-anchor': 'end' }, String(v)));
  }
  chart.append(svg('text', { class: 'tick', x: PAD.l, y: H - 6, 'text-anchor': 'start' }, `Test ${points[0].testId}`));
  chart.append(svg('text', { class: 'tick', x: W - PAD.r, y: H - 6, 'text-anchor': 'end' }, `Test ${points[points.length - 1].testId}`));
  if (baselineWpm !== null) {
    chart.append(svg('line', { class: 'target-line', x1: PAD.l, x2: W - PAD.r, y1: y(baselineWpm), y2: y(baselineWpm) }));
    chart.append(svg('text', { class: 'target-label', x: PAD.l + 2, y: y(baselineWpm) - 5, 'text-anchor': 'start' }, `Your median ${Math.round(baselineWpm)}`));
  }
  const cross = svg('line', { class: 'cross', y1: PAD.t - 4, y2: H - PAD.b });
  chart.append(cross);

  for (const s of SERIES) {
    // A test with no value breaks the line instead of bridging the gap.
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = s.value(p);
      d += v === null ? '' : `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = v !== null;
    });
    chart.append(svg('path', { class: `line ${s.id}`, d }));
  }
  const markers = SERIES.map((s) =>
    points.map((p, i) => {
      const v = s.value(p);
      if (v === null) return null;
      const practice = p.kind === 'drill';
      const dim = !practice && points.length > MARKER_LIMIT;
      const m = svg('circle', {
        class: `pt ${s.id}${practice ? ' practice' : ''}${dim ? ' dim' : ''}`,
        cx: x(i), cy: y(v), r: 4,
        'data-series': s.id, 'data-test-id': p.testId, 'data-kind': p.kind, 'data-wpm': v.toFixed(1),
      });
      chart.append(m);
      return m;
    }),
  );
  plot.replaceChildren(chart);

  // Hover and keyboard share one active test; the tooltip lists both series for it.
  let active = -1;
  const show = (i: number) => {
    active = Math.min(Math.max(i, 0), points.length - 1);
    const p = points[active];
    cross.setAttribute('x1', String(x(active)));
    cross.setAttribute('x2', String(x(active)));
    cross.classList.add('on');
    markers.forEach((m) => m.forEach((c, j) => c?.classList.toggle('active', j === active)));
    const row = (id: string, label: string, v: number | null) => {
      const r = el('div', { class: 'row' });
      r.append(el('i', { class: `key-line ${id}` }), el('b', {}, round(v)), ` ${label}`);
      return r;
    };
    tip.replaceChildren(
      el('strong', {}, `Test ${p.testId}, ${p.kind === 'drill' ? 'practice round' : 'ordinary test'}`),
      row('overall', 'wpm', p.wpm),
      row('weak', `wpm on ${targets.length > 0 ? targets.join(' ') : 'targets'}`, p.targetWpm),
    );
    tip.hidden = false;
    const px = (x(active) * box.clientWidth) / W;
    const left = px < box.clientWidth / 2 ? px + 12 : px - 12 - tip.offsetWidth;
    tip.style.left = `${Math.max(left, 0)}px`;
    plot.setAttribute('aria-label', `Test ${p.testId}, ${p.kind === 'drill' ? 'practice round' : 'ordinary test'}: ${round(p.wpm)} wpm, ${round(p.targetWpm)} wpm on targets`);
  };
  const hide = () => {
    active = -1;
    cross.classList.remove('on');
    markers.forEach((m) => m.forEach((c) => c?.classList.remove('active')));
    tip.hidden = true;
  };
  plot.onpointermove = (e) => {
    const r = chart.getBoundingClientRect();
    const sx = ((e.clientX - r.left) * W) / r.width;
    show(Math.round(((sx - PAD.l) / (W - PAD.l - PAD.r)) * (points.length - 1)));
  };
  plot.onpointerleave = () => document.activeElement !== plot && hide();
  plot.onfocus = () => show(points.length - 1);
  plot.onblur = hide;
  plot.onkeydown = (e) => {
    const next = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: points.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    show(next);
  };
  plot.setAttribute('aria-label', 'Progress chart: wpm per test, ordinary tests and practice rounds');
}
