import { app, BrowserWindow, ipcMain, session, shell, WebContentsView, type BrowserWindowConstructorOptions, type WebContents } from 'electron';
import path from 'node:path';
import { profileKey } from '../shared/profile';
import { TUNING, withTuning } from '../shared/tuning';
import type { CapturedTest, PracticeStatus, Profile, ResultRowView } from '../shared/types';
import { installAdBlock, type AdBlockStats } from './adblock';
import { CoachService } from './coach';
import { openDb, type Db } from './db';
import { isCapturedTest } from './validate';

let db: Db | undefined;

const TEST = process.env.WWC_TEST === '1';
const PARTITION = 'persist:monkeytype';
const MONKEYTYPE_URL = 'https://monkeytype.com';
/** Test-only: shifts the clock (and captured test times) forward, e.g. to reach a next-day follow-up. */
const CLOCK_OFFSET = TEST ? Number(process.env.WWC_CLOCK_OFFSET_MS ?? 0) || 0 : 0;
const tuning = TEST && process.env.WWC_TUNING ? withTuning(JSON.parse(process.env.WWC_TUNING)) : TUNING;

// Hosts a guest may need for Monkeytype's Google/GitHub sign-in popups.
const LOGIN_HOSTS = ['accounts.google.com', 'github.com', 'firebaseapp.com', 'monkeytype.com'];
const isLoginHost = (host: string) => LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

if (process.env.WWC_USER_DATA) app.setPath('userData', process.env.WWC_USER_DATA);

/** Test runs render off screen (WWC_TEST_VISIBLE=1 shows them) so they never cover or interrupt the desktop. */
const OFFSCREEN = TEST && process.env.WWC_TEST_VISIBLE !== '1';
// An off-screen or covered window must keep rendering like a visible one.
if (TEST) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// In test mode the window is created hidden and revealed without taking focus.
function createWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({ ...options, show: false, ...(OFFSCREEN ? { x: -20000, y: 0, skipTaskbar: true } : {}) });
  win.once('ready-to-show', () => (TEST ? win.showInactive() : win.show()));
  return win;
}

// Look like plain Chrome so Google/GitHub OAuth doesn't reject the embedded browser.
// Must run before the window exists: a webContents copies the session UA at creation.
function useChromeUserAgent(): void {
  const ses = session.fromPartition(PARTITION);
  // The app token sits right before "Chrome/": "... Gecko) <app>/<version> Chrome/..."
  const version = app.getVersion().replaceAll('.', '[.]');
  const appToken = new RegExp(` [^ /]+/${version}(?= Chrome/)`);
  ses.setUserAgent(ses.getUserAgent().replace(appToken, '').replace(/ Electron[/][^ ]+/, ''));
}

function createMonkeytypeWindow(): BrowserWindow {
  useChromeUserAgent();
  const win = createWindow({
    width: 1280,
    height: 860,
    autoHideMenuBar: true,
    title: 'Weakword Coach',
    backgroundColor: '#000000',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, '../preload/monkeytype.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !TEST,
    },
  });
  // Keep our title: Monkeytype's page title would otherwise replace it.
  win.on('page-title-updated', (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {}
    if (parsed && isLoginHost(parsed.hostname)) {
      // Child windows must stay in the same persistent session so the login sticks.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      };
    }
    if (parsed && /^https?:$/.test(parsed.protocol)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  void win.loadURL(MONKEYTYPE_URL);
  return win;
}

/** The Coach panel: a transparent view over the Monkeytype page, hidden until opened. */
function createCoachView(win: BrowserWindow): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/coach.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !TEST,
    },
  });
  view.setBackgroundColor('#00000000');
  // The panel's only links are credits; they open in the user's browser, never inside the panel.
  const openOutside = (url: string) => {
    try {
      if (/^https:$/.test(new URL(url).protocol)) void shell.openExternal(url);
    } catch {}
  };
  view.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      openOutside(url);
    }
  });
  win.contentView.addChildView(view);
  const fit = () => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  fit();
  win.on('resize', fit);
  view.setVisible(false);
  void view.webContents.loadFile(path.join(__dirname, '../coach/index.html'));
  return view;
}

const INJECT_TIMEOUT_MS = 20_000;
const PROFILE_TIMEOUT_MS = 25_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;

type Done = { ok: boolean; error?: string };

app.whenReady().then(() => {
  if (!gotLock) return;
  const database = openDb(path.join(app.getPath('userData'), 'weakword.db'));
  db = database;
  const adblock: AdBlockStats = installAdBlock(session.fromPartition(PARTITION));
  const win = createMonkeytypeWindow();
  const monkeytype = win.webContents;
  const view = createCoachView(win);
  const panel = view.webContents;
  let panelOpen = false;
  let closeTimer: NodeJS.Timeout | undefined;

  const send = (wc: WebContents, channel: string, ...args: unknown[]) => {
    if (!wc.isDestroyed()) wc.send(channel, ...args);
  };

  /** Sends a request to the Monkeytype preload and waits for its reply channel. */
  function ask(channel: string, reply: string, payload: unknown, timeoutMs: number, timeoutError: string): Promise<Done> {
    return new Promise((resolve) => {
      const finish = (result: Done) => {
        clearTimeout(timer);
        ipcMain.removeListener(reply, onDone);
        resolve(result);
      };
      const onDone = (event: Electron.IpcMainEvent, result: Done) => {
        if (event.sender === monkeytype) finish(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: timeoutError }), timeoutMs);
      ipcMain.on(reply, onDone);
      send(monkeytype, channel, payload);
    });
  }

  /** Reloads like F5; Monkeytype keeps a custom text but shows only as many words as its previous wordset had. */
  function reloadMonkeytype(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        monkeytype.removeListener('did-finish-load', done);
        resolve();
      };
      const timer = setTimeout(done, PAGE_LOAD_TIMEOUT_MS);
      monkeytype.on('did-finish-load', done);
      monkeytype.reload();
    });
  }

  const focusTyping = () => {
    // Taking OS focus is skipped in tests so a test run never steals the keyboard.
    if (!TEST) monkeytype.focus();
    send(monkeytype, 'wwc:focus-typing');
  };

  function openPanel(): void {
    clearTimeout(closeTimer);
    if (!panelOpen) {
      panelOpen = true;
      view.setVisible(true);
    }
    if (!TEST) panel.focus();
    send(panel, 'wwc:panel-open');
  }

  function hidePanel(): void {
    clearTimeout(closeTimer);
    if (!panelOpen) return;
    panelOpen = false;
    view.setVisible(false);
    focusTyping();
  }

  /** The panel animates out, then reports back; hide anyway if it does not. */
  function closePanel(): void {
    if (!panelOpen) return;
    send(panel, 'wwc:panel-close');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(hidePanel, 700);
  }

  const coach = new CoachService(database, {
    wordlistDir: path.join(app.getPath('userData'), 'wordlists'),
    now: () => Date.now() + CLOCK_OFFSET,
    tuning,
    driver: {
      async injectWords(words) {
        const result = await ask('wwc:inject-practice', 'wwc:inject-done', { words }, INJECT_TIMEOUT_MS, 'Monkeytype did not respond in time');
        // The reload makes Monkeytype show the whole text (see docs/monkeytype-dom.md, stale wordset).
        if (result.ok) await reloadMonkeytype();
        return result;
      },
      loadProfile(p: Profile) {
        const request = { mode: p.mode, mode2: p.mode2, punctuation: p.punctuation, numbers: p.numbers, language: p.language };
        return ask('wwc:load-profile', 'wwc:profile-done', request, PROFILE_TIMEOUT_MS, 'Monkeytype did not switch tests in time');
      },
      focusTyping,
    },
    events: {
      stateChanged: () => send(panel, 'wwc:state-changed'),
      hud: (v) => send(monkeytype, 'wwc:hud', v),
      badge: (b) => send(monkeytype, 'wwc:coach-badge', b),
      practiceStatus: (s: PracticeStatus) => {
        send(panel, 'wwc:practice-status', s);
        // With the panel closed (Ctrl+Shift+P, a row button) the page shows what went wrong.
        if (s.state === 'error' && !panelOpen) send(monkeytype, 'wwc:toast', s.error ?? 'Could not start practice.');
      },
      closePanel,
      openPanel,
    },
  });
  coach.onRow = (row: ResultRowView) => send(monkeytype, 'wwc:result-row', row);
  if (TEST) (globalThis as Record<string, unknown>).__wwc = { adblock, coach, db: database, profileKey };

  // The page loses our strip, badge and row on every load: send them again.
  monkeytype.on('did-finish-load', () => coach.pushChrome());

  ipcMain.on('wwc:test-finished', (event, payload: unknown) => {
    if (event.sender !== monkeytype || !isCapturedTest(payload)) return;
    const test = payload as CapturedTest;
    if (CLOCK_OFFSET) {
      test.startedAt += CLOCK_OFFSET;
      test.endedAt += CLOCK_OFFSET;
    }
    void coach
      .testFinished(test)
      .then((row) => row && send(monkeytype, 'wwc:result-row', row))
      .catch((e) => console.error('storing a test failed', e));
  });

  ipcMain.on('wwc:coach-open', (event) => {
    if (event.sender === monkeytype) openPanel();
  });
  ipcMain.on('wwc:panel-request-close', (event) => {
    if (event.sender === panel) closePanel();
  });
  ipcMain.on('wwc:panel-closed', (event) => {
    if (event.sender === panel) hidePanel();
  });
  ipcMain.on('wwc:row-action', (event, payload: unknown) => {
    const p = payload as { id?: unknown; clientId?: unknown } | null;
    if (event.sender !== monkeytype || typeof p?.id !== 'string' || typeof p.clientId !== 'string') return;
    void coach.rowAction(p.id, p.clientId);
  });
  ipcMain.on('wwc:hud-action', (event, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id;
    if (event.sender === monkeytype && typeof id === 'string') coach.hudAction(id);
  });

  ipcMain.handle('wwc:get-state', (event) => {
    if (event.sender !== panel) throw new Error('not available');
    return coach.state();
  });

  ipcMain.handle('wwc:act', async (event, action: unknown): Promise<Done> => {
    if (event.sender !== panel) throw new Error('not available');
    const a = action as { type?: unknown; key?: unknown; value?: unknown } | null;
    switch (a?.type) {
      case 'start-session': return coach.startSession('session');
      case 'quick': return coach.startSession('quick');
      case 'continue': return coach.continueSession();
      case 'end-session': coach.endSession(); return { ok: true };
      case 'retest': return coach.loadNormal();
      case 'benchmark': return coach.benchmark30();
      case 'set-benchmark':
        if (typeof a.key !== 'string') break;
        coach.setBenchmark(a.key);
        return { ok: true };
      case 'reset-period': coach.resetPeriod(); return { ok: true };
      case 'start-baseline':
        if (typeof a.key !== 'string') break;
        coach.startBaseline(a.key, Date.now() + CLOCK_OFFSET);
        return { ok: true };
      case 'set-setting':
        if ((a.key !== 'hints' && a.key !== 'warmup') || typeof a.value !== 'boolean') break;
        coach.setSetting(a.key, a.value);
        return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
  });

  // Ctrl+Shift+P from the page or the panel: the next session step, or a quick drill. The app takes
  // the shortcut before Monkeytype sees it, so its command line stays on Esc (the key tip says so).
  for (const wc of [monkeytype, panel]) {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || !input.shift || input.alt || input.meta) return;
      if (input.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      void coach.practiceHotkey();
    });
  }
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => db?.close());
