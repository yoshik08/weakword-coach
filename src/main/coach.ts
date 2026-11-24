// The coach: classifies and stores finished tests, keeps baselines and the practice model, plans and
// runs sessions through Monkeytype, and builds what the result row, the session strip and the Coach
// panel show. Everything here runs locally; the only network use is the word-list download.
import { randomInt, randomUUID } from 'node:crypto';
import { buildCorpusFreq, type CorpusFreq } from '../shared/corpus';
import { diagnose, emptyDiagnosis, type DiagnosisInput } from '../shared/diagnose';
import { generateRound, GENERATOR_VERSION } from '../shared/generator';
import { deriveStats, outcomeOn, reviewWords } from '../shared/keystats';
import { fingeringHint } from '../shared/layout';
import { planSession } from '../shared/planner';
import { afterRound, isDue, newPatternState, reviewSchedule } from '../shared/practice-model';
import { eligibility, kindOf, profileFromKey, profileKey, profileLabel, profileOf, scopeKey } from '../shared/profile';
import {
  baselineView, cleanPace, postTests, progressRow, resolveBaseline, transfer, trendPoints, usualProfile,
  type BaselineRecord, type ScoredTest,
} from '../shared/progress';
import type { Tuning } from '../shared/tuning';
import type {
  CapturedTest, CoachState, Diagnosis, FollowupView, HudView, PracticeStatus, Profile, ProfileSummary, ProgressView,
  ResultRowView, RowAction, SessionPlan, TestStats,
} from '../shared/types';
import { hash, median, signed } from '../shared/util';
import * as store from './db';
import { loadList, loadPools, type FetchJson } from './wordlists';

const DAY = 24 * 60 * 60 * 1000;

export interface Driver {
  /** Loads words as a Monkeytype custom text (and reloads the page). */
  injectWords(words: string[]): Promise<{ ok: boolean; error?: string }>;
  /** Switches Monkeytype to an ordinary test profile. */
  loadProfile(p: Profile): Promise<{ ok: boolean; error?: string }>;
  focusTyping(): void;
}

export interface CoachEvents {
  stateChanged(): void;
  hud(view: HudView | null): void;
  badge(b: { dot: boolean; label: string }): void;
  practiceStatus(s: PracticeStatus): void;
  closePanel(): void;
  openPanel(): void;
}

export interface CoachOptions {
  wordlistDir: string;
  now: () => number;
  tuning: Tuning;
  driver: Driver;
  events: CoachEvents;
  fetchJson?: FetchJson;
}

const isScore = (t: ScoredTest) => t.kind === 'normal' && t.eligible && t.wpm !== null && t.acc !== null;

export class CoachService {
  private corpusCache = new Map<string, CorpusFreq | null>();
  /** clientId -> test id and the row shown for it (a re-sent test gets the same row). */
  private rows = new Map<string, { testId: number; row: ResultRowView | null }>();
  private running = false;
  /** The active session's current step is loaded in Monkeytype (false after a restart or a detour). */
  private stepLoaded = false;

  constructor(private db: store.Db, private o: CoachOptions) {}

  private get tuning() {
    return this.o.tuning;
  }

  private now() {
    return this.o.now();
  }

  // Corpus and diagnosis

  private async corpus(language: string): Promise<CorpusFreq | null> {
    if (this.corpusCache.has(language)) return this.corpusCache.get(language)!;
    let freq: CorpusFreq | null = null;
    try {
      freq = buildCorpusFreq(await loadList(this.o.wordlistDir, language, this.o.fetchJson));
    } catch {
      freq = null; // offline on a first run: diagnosis falls back to observed frequencies
    }
    this.corpusCache.set(language, freq);
    return freq;
  }

  private scored(): ScoredTest[] {
    return store.getScored(this.db);
  }

  private benchmarkKey(scored: ScoredTest[]): string | null {
    return store.getMeta(this.db, 'benchmark') ?? usualProfile(scored);
  }

  private scopeOf(scored: ScoredTest[]): { language: string; layout: string } {
    const key = this.benchmarkKey(scored) ?? [...scored].reverse().find((t) => t.profileKey && t.kind === 'normal')?.profileKey;
    if (!key) return { language: 'english', layout: store.getMeta(this.db, 'layout') ?? 'unknown' };
    const p = profileFromKey(key);
    return { language: p.language, layout: p.layout };
  }

  private inScope(scored: ScoredTest[], scope: { language: string; layout: string }, kinds = ['normal']): ScoredTest[] {
    return scored.filter((t) => {
      if (!t.profileKey || !kinds.includes(t.kind)) return false;
      const p = profileFromKey(t.profileKey);
      return p.language === scope.language && p.layout === scope.layout;
    });
  }

  private inputs(tests: ScoredTest[]): DiagnosisInput[] {
    const stats = store.getStats(this.db, tests.map((t) => t.id));
    return tests.filter((t) => stats.has(t.id)).map((t) => ({ id: t.id, endedAt: t.endedAt, stats: stats.get(t.id)!, wpm: t.wpm }));
  }

  private async diagnosis(scored: ScoredTest[]): Promise<Diagnosis> {
    const scope = this.scopeOf(scored);
    const tests = this.inScope(scored, scope).filter(isScore);
    if (tests.length === 0) return emptyDiagnosis(scope);
    const corpus = await this.corpus(scope.language);
    return diagnose(this.inputs(tests.slice(-this.tuning.recentTests)), { corpus, scope, tuning: this.tuning });
  }

  // Finished tests

  async testFinished(test: CapturedTest): Promise<ResultRowView | null> {
    const now = this.now();
    if (test.clientId && this.rows.has(test.clientId)) return this.rows.get(test.clientId)!.row;
    const prompt = test.mode.startsWith('custom') ? store.findPrompt(this.db, test.words) : null;
    const kind = kindOf(test.mode, prompt !== null);
    const lastLayout = store.getMeta(this.db, 'layout');
    const profile = profileOf(test, lastLayout);
    if (profile.layout !== 'unknown') {
      if (!store.getMeta(this.db, 'legacy-layout')) {
        store.adoptLegacyLayout(this.db, profile.layout);
        store.setMeta(this.db, 'legacy-layout', profile.layout);
      }
      store.setMeta(this.db, 'layout', profile.layout);
      const codes = { ...JSON.parse(store.getMeta(this.db, 'key-codes') ?? '{}'), ...(test.keyCodes ?? {}) };
      store.setMeta(this.db, 'key-codes', JSON.stringify(codes));
    }
    const key = profileKey(profile);
    let corpusVersion: string | null = null;
    if (kind === 'normal' && (profile.mode === 'time' || profile.mode === 'words')) corpusVersion = (await this.corpus(profile.language))?.version ?? null;
    const previous = store.getTests(this.db, { kind: 'normal', limit: 1, withKeystrokes: false })[0];
    const sameWords = kind === 'normal' && previous !== undefined && JSON.stringify(previous.words) === JSON.stringify(test.words);
    const { eligible, reason } = eligibility(kind, test.result, test.record, sameWords);
    const stats = deriveStats(test, this.tuning);
    const active = store.activeSession(this.db);
    const isRetest = kind === 'normal' && eligible && active !== null && active.plan.steps[active.step]?.kind === 'retest' && active.plan.profileKey === key;

    const { id, duplicate } = store.insertTest(this.db, test, {
      kind, eligible, reason, profileKey: key, layout: profile.layout === 'unknown' ? null : profile.layout, corpusVersion,
      promptId: prompt?.id ?? null, sessionId: prompt?.sessionId ?? (isRetest ? active!.id : null), stats,
    });
    if (duplicate) return test.clientId ? (this.rows.get(test.clientId)?.row ?? null) : null;

    let row: ResultRowView | null = null;
    if (kind === 'drill') row = this.afterDrill(id, test, stats, prompt!, profile, now);
    else if (kind === 'normal') row = this.afterNormal(id, test, key, eligible, isRetest, stats, now);
    if (kind !== 'drill' && !isRetest) this.stepLoaded = false;
    if (test.clientId) {
      this.rows.set(test.clientId, { testId: id, row });
      if (this.rows.size > 200) this.rows.delete(this.rows.keys().next().value!);
    }
    this.pushChrome();
    return row;
  }

  /** Coaching begins at the first drill of a period: freeze every profile's pre-Coach baseline then. */
  private beginCoaching(at: number): void {
    const period = store.currentPeriod(this.db);
    if (period.firstDrillAt !== null) return;
    store.markFirstDrill(this.db, period.id, at);
    const started = { ...period, firstDrillAt: at };
    const scored = this.scored();
    for (const key of new Set(scored.filter(isScore).map((t) => t.profileKey!))) {
      const { record, freeze } = resolveBaseline(scored, key, started, store.getBaseline(this.db, period.id, key), this.tuning);
      if (record && freeze) store.saveBaseline(this.db, record);
    }
  }

  private afterDrill(id: number, test: CapturedTest, stats: TestStats, prompt: store.PromptRow, profile: Profile, now: number): ResultRowView {
    this.beginCoaching(test.endedAt);
    const scope = scopeKey(profile);
    const session = prompt.sessionId ? store.getSession(this.db, prompt.sessionId) : null;
    const step = session && prompt.step !== null ? session.plan.steps[prompt.step] : undefined;
    const states = store.getPatternStates(this.db, scope);
    const results: store.StepResult['targets'] = {};
    const notes: string[] = [];
    for (const tid of prompt.targets) {
      const o = outcomeOn(stats, [tid]);
      results[tid] = o;
      const startCost = session?.plan.targets.find((t) => t.id === tid)?.costMs ?? this.costOf(tid);
      const before = states.find((s) => s.id === tid) ?? newPatternState(tid, now, startCost);
      const next = afterRound(before, { accuracy: o.accuracy, paceWpm: step?.paceWpm ?? null, wpm: test.result.wpm, kind: step?.kind ?? prompt.kind }, now, this.tuning);
      store.savePatternState(this.db, scope, next, now);
      if (next.level > before.level) notes.push(`${tid.slice(2)} was clean twice: its speed prompts go up ${Math.round(this.tuning.paceStep * 100)}%.`);
      else if (next.level < before.level) notes.push(`More misses on ${tid.slice(2)}: the next rounds ease off.`);
    }
    const all = outcomeOn(stats, prompt.targets);
    if (session && session.status === 'active' && prompt.step === session.step) {
      const floor = step?.accuracyFloor ?? this.tuning.accuracyFloor;
      session.results.push({
        step: prompt.step, testId: id, wpm: test.result.wpm, accuracy: test.result.accuracy, targets: results,
        paceWpm: step?.paceWpm ?? null, clean: all.accuracy === null || all.accuracy >= floor,
      });
      session.step += 1;
      if (session.step >= session.plan.steps.length) {
        session.status = 'done';
        session.completedAt = now;
      }
      store.updateSession(this.db, session);
      this.stepLoaded = false;
    }
    return this.drillRow(test, prompt, session, step, results, all, notes);
  }

  private costOf(id: string): number | null {
    const cached = this.lastDiagnosis?.items.find((s) => s.id === id);
    return cached ? cached.costMs : null;
  }

  private lastDiagnosis: Diagnosis | null = null;

  private drillRow(
    test: CapturedTest,
    prompt: store.PromptRow,
    session: store.SessionRow | null,
    step: SessionPlan['steps'][number] | undefined,
    results: store.StepResult['targets'],
    all: ReturnType<typeof outcomeOn>,
    notes: string[],
  ): ResultRowView {
    const floor = step?.accuracyFloor ?? this.tuning.accuracyFloor;
    const metrics: ResultRowView['metrics'] = [];
    if (all.accuracy !== null) {
      const labels = prompt.targets.map((t) => t.slice(2)).join(', ');
      metrics.push({
        id: 'acc', value: `${(all.accuracy * 100).toFixed(1)}%`, delta: null,
        tone: all.accuracy >= floor ? 'up' : all.accuracy < floor - this.tuning.roughMargin ? 'down' : 'flat',
        caption: `first tries on ${labels}`,
      });
    }
    const lines: string[] = [];
    const reviewed = session?.plan.reviewWords ?? [];
    if (reviewed.length > 0) lines.push(`Reviewed ${reviewed.map((w) => `"${w}"`).join(', ')} with similar words.`);
    const recap = Object.entries(results)
      .map(([id, o]) => (o.attempts === 0 ? null : `${id.slice(2)}: ${o.errors} of ${o.attempts} missed${o.ms !== null ? `, ${Math.round(o.ms)} ms clean` : ''}`))
      .filter(Boolean)
      .join(' · ');
    if (recap) lines.push(recap);
    if (step?.paceWpm && test.result.wpm !== null) lines.push(`Prompted pace about ${step.paceWpm} wpm; you typed ${Math.round(test.result.wpm)}.`);
    lines.push(...notes);
    lines.push('Practice rounds never count toward your baseline, comparisons or best scores.');
    const multi = session !== null && session.plan.steps.length > 1;
    const actions: RowAction[] = [];
    const next = session && session.status === 'active' ? session.plan.steps[session.step] : undefined;
    if (next) {
      actions.push({ id: 'continue', label: `Next: ${next.title}`, primary: true, kbd: 'ctrl+shift+p' });
      actions.push({ id: 'end-session', label: 'End session' });
    } else {
      lines.push('Take a normal test to measure progress.');
      actions.push({ id: 'retest', label: 'Take a normal test', primary: true });
      actions.push({ id: 'quick', label: 'Another round', kbd: 'ctrl+shift+p' });
    }
    const stepNo = multi && prompt.step !== null ? ` · ${prompt.step + 1} of ${session!.plan.steps.length}` : '';
    return {
      clientId: test.clientId ?? '', kind: 'drill', heading: `Practice round${multi && step ? `: ${step.title}` : ''}${stepNo}`,
      metrics, lines, actions, data: { step: String(prompt.step ?? ''), targets: prompt.targets.join(' ') },
    };
  }

  private afterNormal(id: number, test: CapturedTest, key: string, eligible: boolean, isRetest: boolean, stats: TestStats, now: number): ResultRowView {
    let followup: { days: number; retestDelta: number | null } | null = null;
    const active = store.activeSession(this.db);
    if (isRetest && active) {
      active.retestTestId = id;
      active.step += 1;
      active.status = 'done';
      active.completedAt = now;
      active.followupDueAt = test.endedAt + this.tuning.followupHours * 60 * 60 * 1000;
      store.updateSession(this.db, active);
      this.stepLoaded = false;
    }
    if (eligible && !isRetest) {
      const period = store.currentPeriod(this.db);
      for (const s of store.pendingFollowups(this.db)) {
        if (s.periodId !== period.id || s.plan.profileKey !== key || (s.followupDueAt ?? Infinity) > test.endedAt) continue;
        s.followupTestId = id;
        store.updateSession(this.db, s);
        const baseline = store.getBaseline(this.db, period.id, key);
        const retest = s.retestTestId ? this.scored().find((t) => t.id === s.retestTestId) : undefined;
        followup = {
          days: Math.max(1, Math.round((test.endedAt - (s.completedAt ?? test.endedAt)) / DAY)),
          retestDelta: retest?.wpm != null && baseline?.wpm != null ? retest.wpm - baseline.wpm : null,
        };
        break;
      }
    }
    const review = reviewWords(test, stats);
    return this.normalRow(id, test.clientId ?? '', { followup, sessionRetest: isRetest, reviewCount: review.length });
  }

  private normalRow(testId: number, clientId: string, extra: { followup?: { days: number; retestDelta: number | null } | null; sessionRetest?: boolean; reviewCount?: number }): ResultRowView {
    const scored = this.scored();
    const test = scored.find((t) => t.id === testId)!;
    const period = store.currentPeriod(this.db);
    const key = test.profileKey ?? '';
    const resolved = this.baselineFor(scored, key, period);
    const versionChanged = period.firstDrillAt !== null && !!resolved && !!resolved.corpusVersion && !!test.corpusVersion && resolved.corpusVersion !== test.corpusVersion && !resolved.testIds.includes(testId);
    const actions: RowAction[] = [];
    if (extra.reviewCount) actions.push({ id: 'review', label: `Review missed words (${extra.reviewCount})` });
    const lines: string[] = [];
    if (period.firstDrillAt === null && isScore(test)) {
      const n = resolved?.testIds.length ?? 0;
      if (n >= this.tuning.baselineTests) actions.unshift({ id: 'start-session', label: 'Start a session', primary: true });
    }
    if (extra.sessionRetest) lines.push(this.sessionRecap());
    return progressRow({
      clientId, test, profileLabel: profileLabel(profileFromKey(key)), period, baseline: resolved, versionChanged, tests: scored,
      followup: extra.followup ?? null, sessionRetest: extra.sessionRetest, extraLines: lines.filter(Boolean), actions, tuning: this.tuning,
    });
  }

  /** Resolves (and persists, when it freezes) a profile's baseline in the current period. */
  private baselineFor(scored: ScoredTest[], key: string, period: store.PeriodInfo = store.currentPeriod(this.db)): BaselineRecord | null {
    if (!key) return null;
    const stored = store.getBaseline(this.db, period.id, key);
    const { record, freeze } = resolveBaseline(scored, key, period, stored, this.tuning);
    if (record && (freeze || (stored?.kind === 'fresh' && JSON.stringify(stored.testIds) !== JSON.stringify(record.testIds)))) store.saveBaseline(this.db, record);
    return record;
  }

  /** What the session's drills measured on its targets (practice only, described, not credited). */
  private sessionRecap(): string {
    const s = store.lastSessions(this.db, 1)[0];
    if (!s || s.results.length === 0) return '';
    const parts: string[] = [];
    for (const t of s.plan.targets) {
      const rounds = s.results.filter((r) => r.targets[t.id]?.attempts);
      if (rounds.length < 2) continue;
      const [first, last] = [rounds[0].targets[t.id], rounds[rounds.length - 1].targets[t.id]];
      if (t.problem === 'accuracy' && first.accuracy !== null && last.accuracy !== null) {
        parts.push(`${t.label} missed ${Math.round((1 - first.accuracy) * 100)}% → ${Math.round((1 - last.accuracy) * 100)}%`);
      } else if (first.ms !== null && last.ms !== null) parts.push(`${t.label} ${Math.round(first.ms)} → ${Math.round(last.ms)} ms`);
    }
    return parts.length ? `In this session's practice rounds: ${parts.join(' · ')}.` : '';
  }

  // Sessions

  private async planFor(kind: SessionPlan['kind'], reviewOf?: number): Promise<SessionPlan | { error: string }> {
    const scored = this.scored();
    const key = this.benchmarkKey(scored);
    if (!key) return { error: 'Take an ordinary Monkeytype test first, so the Coach knows your usual mode.' };
    const profile = profileFromKey(key);
    const diagnosis = await this.diagnosis(scored);
    this.lastDiagnosis = diagnosis;
    const scope = scopeKey(profile);
    const states = store.getPatternStates(this.db, scope).map((s) => reviewSchedule(s, diagnosis.items.find((i) => i.id === s.id), this.tuning));
    const inProfile = scored.filter((t) => t.profileKey === key);
    let words: string[] | undefined;
    if (kind === 'review') {
      const test = reviewOf !== undefined ? store.getTest(this.db, reviewOf) : null;
      if (!test) return { error: 'That test is no longer stored.' };
      words = reviewWords(test, store.getStats(this.db, [test.id]).get(test.id)!);
    }
    return planSession({
      kind, diagnosis, practice: states, profile, profileKey: key,
      paceWpm: cleanPace(inProfile.filter(isScore).length >= 2 ? inProfile : scored),
      seed: kind === 'session' && !reviewOf ? this.previewSeed() : randomInt(2 ** 31), now: this.now(),
      warmup: store.getMeta(this.db, 'warmup') !== '0', reviewWords: words, tuning: this.tuning,
    });
  }

  /** The preview and the session it starts share a seed, so what the panel shows is what you get. */
  private previewSeed(): number {
    return parseInt(hash(`${new Date(this.now()).toDateString()}|${store.getScored(this.db).length}`), 16) >>> 1;
  }

  async startSession(kind: SessionPlan['kind'], reviewOf?: number): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: 'A practice round is already loading.' };
    const plan = await this.planFor(kind, reviewOf);
    if ('error' in plan) {
      this.o.events.practiceStatus({ state: 'error', error: plan.error });
      return { ok: false, error: plan.error };
    }
    const period = store.currentPeriod(this.db);
    const session = store.createSession(this.db, randomUUID(), plan, period.id, this.now());
    return this.runStep(session);
  }

  async continueSession(): Promise<{ ok: boolean; error?: string }> {
    const active = store.activeSession(this.db);
    if (!active) return this.startSession('quick');
    return this.runStep(active);
  }

  /** Ctrl+Shift+P: the next step of the running session, or a quick drill. */
  practiceHotkey(): Promise<{ ok: boolean; error?: string }> {
    return this.continueSession();
  }

  private async runStep(session: store.SessionRow): Promise<{ ok: boolean; error?: string }> {
    const step = session.plan.steps[session.step];
    if (!step) return { ok: false, error: 'This session is complete.' };
    this.running = true;
    this.o.events.closePanel();
    this.o.events.practiceStatus({ state: 'running', message: `Loading ${step.title.toLowerCase()}…` });
    let result: { ok: boolean; error?: string };
    try {
      if (step.kind === 'retest') {
        result = await this.o.driver.loadProfile(session.plan.profile);
      } else {
        const pools = await loadPools(this.o.wordlistDir, session.plan.profile.language, this.o.fetchJson);
        const targets = session.plan.targets.filter((t) => step.targets.includes(t.id));
        const seed = (session.plan.seed + step.index * 7919) >>> 0;
        const round = generateRound(
          {
            kind: step.kind, targets, words: step.words, seed,
            punctuation: session.plan.profile.punctuation, numbers: session.plan.profile.numbers,
            exclude: step.kind === 'mixed' ? store.sessionWords(this.db, session.id) : [],
            review: session.plan.reviewWords,
          },
          pools,
          this.tuning,
        );
        if (round.words.length < Math.min(this.tuning.wordsMin, step.words)) throw new Error('Could not build a practice text from the word lists.');
        result = await this.o.driver.injectWords(round.words);
        if (result.ok) {
          store.insertPrompt(this.db, {
            sessionId: session.id, step: step.index, kind: step.kind, words: round.words, targets: step.targets, seed,
            createdAt: this.now(), generatorVersion: GENERATOR_VERSION,
          });
        }
      }
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    } finally {
      this.running = false;
    }
    this.stepLoaded = result.ok;
    this.o.events.practiceStatus(result.ok ? { state: 'done', message: `${step.title} loaded in Monkeytype` } : { state: 'error', error: result.error });
    this.pushChrome();
    this.o.driver.focusTyping();
    return result;
  }

  endSession(): void {
    const active = store.activeSession(this.db);
    if (!active) return;
    active.status = 'abandoned';
    store.updateSession(this.db, active);
    this.stepLoaded = false;
    this.pushChrome();
  }

  /** An ordinary test in a profile (the benchmark by default): calibration, measuring, follow-ups. */
  async loadNormal(key?: string): Promise<{ ok: boolean; error?: string }> {
    const scored = this.scored();
    const k = key ?? this.benchmarkKey(scored);
    if (!k) return { ok: false, error: 'Take an ordinary Monkeytype test first.' };
    this.o.events.closePanel();
    const result = await this.o.driver.loadProfile(profileFromKey(k));
    this.o.events.practiceStatus(result.ok ? { state: 'done', message: 'Normal test ready' } : { state: 'error', error: result.error });
    this.o.driver.focusTyping();
    return result;
  }

  /** A 30-second untargeted test in the benchmark's language and settings. */
  benchmark30(): Promise<{ ok: boolean; error?: string }> {
    const key = this.benchmarkKey(this.scored());
    const base = key ? profileFromKey(key) : { mode: 'time', mode2: '30', language: 'english', punctuation: false, numbers: false, modifiers: [], layout: store.getMeta(this.db, 'layout') ?? 'unknown' };
    return this.loadNormal(profileKey({ ...base, mode: 'time', mode2: '30' }));
  }

  setBenchmark(key: string): void {
    store.setMeta(this.db, 'benchmark', key);
    this.pushChrome();
  }

  /** A new comparison period: baselines are taken again before its first drill. */
  resetPeriod(): void {
    this.endSession();
    store.newPeriod(this.db, this.now(), 'reset');
    this.pushChrome();
  }

  /** A new baseline for a profile that has none: its next eligible tests (from `from`) form it. */
  startBaseline(key: string, from: number): void {
    const period = store.currentPeriod(this.db);
    store.saveBaseline(this.db, { periodId: period.id, profileKey: key, kind: 'fresh', createdAt: from, frozenAt: null, testIds: [], wpm: null, acc: null, corpusVersion: null });
    this.baselineFor(this.scored(), key, period);
    this.pushChrome();
  }

  setSetting(key: 'hints' | 'warmup', value: boolean): void {
    store.setMeta(this.db, key, value ? '1' : '0');
    this.o.events.stateChanged();
  }

  /** A button in the result row. */
  async rowAction(id: string, clientId: string): Promise<void> {
    const entry = this.rows.get(clientId);
    switch (id) {
      case 'continue': await this.continueSession(); break;
      case 'end-session': this.endSession(); break;
      case 'quick': await this.startSession('quick'); break;
      case 'start-session': await this.startSession('session'); break;
      case 'retest': await this.loadNormal(); break;
      case 'review': if (entry) await this.startSession('review', entry.testId); break;
      case 'open-coach': this.o.events.openPanel(); break;
      case 'start-baseline': {
        if (!entry) break;
        const t = this.scored().find((s) => s.id === entry.testId);
        if (t?.profileKey) {
          this.startBaseline(t.profileKey, t.endedAt);
          const row = this.normalRow(t.id, clientId, {});
          this.rows.set(clientId, { testId: t.id, row });
          this.onRow?.(row);
        }
        break;
      }
    }
  }

  /** Set by main: re-renders a result row (after an action changed it). */
  onRow: ((row: ResultRowView) => void) | null = null;

  hudAction(id: string): void {
    if (id === 'resume') void this.continueSession();
    else if (id === 'end') this.endSession();
  }

  // Chrome: the session strip and the Coach button's dot

  hudView(): HudView | null {
    const s = store.activeSession(this.db);
    if (!s) return null;
    const step = s.plan.steps[s.step];
    if (!step) return null;
    const targets = s.plan.targets.filter((t) => step.targets.includes(t.id)).map((t) => t.label);
    if (!this.stepLoaded) {
      return { state: 'paused', step: s.step + 1, steps: s.plan.steps.length, title: `Next: ${step.title}`, instruction: 'Session paused.', targets };
    }
    return { state: 'step', step: s.step + 1, steps: s.plan.steps.length, title: step.title, instruction: step.instruction, targets };
  }

  private followupView(): FollowupView | null {
    const period = store.currentPeriod(this.db);
    const pending = store.pendingFollowups(this.db).find((s) => s.periodId === period.id);
    if (!pending || pending.followupDueAt === null) return null;
    const scored = this.scored();
    const baseline = store.getBaseline(this.db, period.id, pending.plan.profileKey);
    const retest = scored.find((t) => t.id === pending.retestTestId);
    return {
      sessionId: pending.id, dueAt: pending.followupDueAt, due: pending.followupDueAt <= this.now(),
      profileLabel: pending.plan.profileLabel,
      retestDelta: retest?.wpm != null && baseline?.wpm != null ? retest.wpm - baseline.wpm : null,
    };
  }

  pushChrome(): void {
    this.o.events.hud(this.hudView());
    const f = this.followupView();
    const active = store.activeSession(this.db);
    this.o.events.badge(
      f?.due ? { dot: true, label: 'follow-up test due' } : active ? { dot: true, label: 'session in progress' } : { dot: false, label: '' },
    );
    this.o.events.stateChanged();
  }

  // Coach panel

  async state(): Promise<CoachState> {
    const scored = this.scored();
    const period = store.currentPeriod(this.db);
    const diagnosis = await this.diagnosis(scored);
    this.lastDiagnosis = diagnosis;
    const key = this.benchmarkKey(scored);
    const profiles = this.profiles(scored);
    const benchmark = key ? (profiles.find((p) => p.key === key) ?? { key, label: profileLabel(profileFromKey(key)), tests: 0, lastAt: 0 }) : null;
    const progress = key ? this.progressView(scored, key, period) : null;
    const active = store.activeSession(this.db);
    const scope = diagnosis.scope;
    const stored = store.getPatternStates(this.db, scopeKey(scope));
    const states = stored.map((s) => reviewSchedule(s, diagnosis.items.find((i) => i.id === s.id), this.tuning));
    states.forEach((s, i) => {
      if (JSON.stringify(s) !== JSON.stringify(stored[i])) store.savePatternState(this.db, scopeKey(scope), s, this.now());
    });
    const preview = active ? null : key ? await this.planFor('session') : null;
    const planTargets = active?.plan.targets ?? (preview && !('error' in preview) ? preview.targets : []);
    const trendTargets = planTargets.length ? planTargets.map((t) => t.id) : diagnosis.top.slice(0, 3).map((s) => s.id);

    // Skill transfer: trained patterns in ordinary tests before vs since coaching began.
    let transferViews: CoachState['transfer'] = [];
    if (period.firstDrillAt !== null) {
      const scopeTests = this.inScope(scored, scope).filter(isScore);
      const trained = states.filter((s) => s.rounds > 0).map((s) => ({
        id: s.id, problem: diagnosis.items.find((i) => i.id === s.id)?.problem ?? (s.id.startsWith('w:') ? 'accuracy' : 'speed'),
      })) as { id: string; problem: 'accuracy' | 'speed' }[];
      transferViews = transfer(
        trained,
        this.inputs(scopeTests.filter((t) => t.endedAt < period.firstDrillAt!).slice(-this.tuning.recentTests)),
        this.inputs(scopeTests.filter((t) => t.endedAt >= period.firstDrillAt!).slice(-this.tuning.recentTests)),
        this.tuning,
      );
    }

    const trendTests = scored.filter((t) => (t.kind === 'normal' && t.eligible) || t.kind === 'drill').slice(-50);
    const trendStats = store.getStats(this.db, trendTests.map((t) => t.id));
    const trend = trendPoints(trendTests.map((t) => ({ ...t, stats: trendStats.get(t.id) ?? null })), trendTargets);

    const hintsOn = store.getMeta(this.db, 'hints') === '1';
    const hints: Record<string, string> = {};
    if (hintsOn) {
      const codes = JSON.parse(store.getMeta(this.db, 'key-codes') ?? '{}') as Record<string, string>;
      for (const id of [...new Set([...planTargets.map((t) => t.id), ...diagnosis.items.slice(0, 40).map((s) => s.id)])]) {
        const h = fingeringHint(id, scope.layout, codes);
        if (h) hints[id] = h;
      }
    }

    const lastTest = scored[scored.length - 1];
    let status: string | null = null;
    if (lastTest?.kind === 'drill') status = 'Take a normal test to measure progress.';
    else if (progress) status = progress.status;

    return {
      diagnosis, trend, trendTargets, profiles, benchmark, progress, followup: this.followupView(),
      session: active ? { id: active.id, kind: active.kind, step: active.step, plan: active.plan, status: active.status } : null,
      preview, transfer: transferViews,
      settings: { hints: hintsOn, warmup: store.getMeta(this.db, 'warmup') !== '0' }, hints,
      normalTests: scored.filter(isScore).length, drillTests: scored.filter((t) => t.kind === 'drill').length, status,
    };
  }

  private profiles(scored: ScoredTest[]): ProfileSummary[] {
    const map = new Map<string, ProfileSummary>();
    for (const t of scored.filter(isScore)) {
      const p = map.get(t.profileKey!) ?? { key: t.profileKey!, label: profileLabel(profileFromKey(t.profileKey!)), tests: 0, lastAt: 0 };
      p.tests++;
      p.lastAt = Math.max(p.lastAt, t.endedAt);
      map.set(t.profileKey!, p);
    }
    return [...map.values()].sort((a, b) => b.tests - a.tests || b.lastAt - a.lastAt);
  }

  private progressView(scored: ScoredTest[], key: string, period: store.PeriodInfo): ProgressView {
    const label = profileLabel(profileFromKey(key));
    const started = period.firstDrillAt !== null;
    const record = this.baselineFor(scored, key, period);
    const need = this.tuning.baselineTests;
    const view: ProgressView = { profileKey: key, profileLabel: label, baseline: record ? baselineView(record, this.tuning) : null, postRuns: 0, latest: null, coachingStarted: started, status: '' };
    if (!started) {
      const n = record?.testIds.length ?? 0;
      view.status = n < need ? `Baseline ${n}/${need} complete` : 'Baseline ready. It freezes when you start practicing.';
      return view;
    }
    if (!record) {
      view.status = 'No tests in this mode from before coaching began. Start a baseline for it below.';
      return view;
    }
    if (record.kind === 'fresh' && !record.frozenAt) {
      view.status = `Baseline ${record.testIds.length}/${need} complete`;
      return view;
    }
    const post = postTests(scored, record, period);
    view.postRuns = post.length;
    if (post.length === 0) {
      view.status = 'Take a normal test to measure progress.';
      return view;
    }
    const win = post.slice(-Math.min(this.tuning.postWindow, post.length));
    const windowed = post.length >= this.tuning.postWindow;
    const wpm = windowed ? median(win.map((t) => t.wpm!))! : post[post.length - 1].wpm!;
    const acc = windowed ? median(win.map((t) => t.acc!))! : post[post.length - 1].acc!;
    view.latest = { wpm, acc, dWpm: wpm - record.wpm!, dAcc: acc - record.acc!, window: windowed ? this.tuning.postWindow : 1 };
    view.status = `${signed(view.latest.dWpm, Math.abs(view.latest.dWpm) < 1 ? 1 : 0)} wpm since coaching began (${windowed ? `median of the last ${this.tuning.postWindow}` : 'one run'}).`;
    return view;
  }

  /** Recovering patterns whose review is due (for tests and the panel). */
  dueReviews(): string[] {
    const scope = this.lastDiagnosis?.scope;
    if (!scope) return [];
    return store.getPatternStates(this.db, scopeKey(scope)).filter((s) => isDue(s, this.now())).map((s) => s.id);
  }
}
