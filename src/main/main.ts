import { app, BrowserWindow, ipcMain, session, shell, type BrowserWindowConstructorOptions } from 'electron';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { analyze, deriveTargetWpm } from '../shared/analysis';
import { generatePractice } from '../shared/generator';
import type { CapturedTest, CoachData, TestSource } from '../shared/types';
import { findPracticeSession, getTests, insertPracticeSession, insertTest, openDb, type Db } from './db';
import { isCapturedTest } from './validate';
import { loadWordLists } from './wordlists';

let db: Db | undefined;

const TEST = process.env.WWC_TEST === '1';
const PARTITION = 'persist:monkeytype';
const MONKEYTYPE_URL = 'https://monkeytype.com';

// Hosts a guest may need for Monkeytype's Google/GitHub sign-in popups.
const LOGIN_HOSTS = ['accounts.google.com', 'github.com', 'firebaseapp.com', 'monkeytype.com'];
const isLoginHost = (host: string) => LOGIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

if (process.env.WWC_USER_DATA) app.setPath('userData', process.env.WWC_USER_DATA);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// In test mode windows are created hidden and revealed without taking focus.
function createWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({ ...options, show: false });
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
    width: 1200,
    height: 820,
    autoHideMenuBar: true,
    title: 'Weakword Coach - Monkeytype',
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, '../preload/monkeytype.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

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

function createCoachWindow(anchor: BrowserWindow): BrowserWindow {
  const b = anchor.getBounds();
  const win = createWindow({
    x: b.x + b.width,
    y: b.y,
    width: 420,
    height: 820,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: 'Weakword Coach',
    webPreferences: {
      preload: path.join(__dirname, '../preload/coach.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void win.loadFile(path.join(__dirname, '../coach/index.html'));
  return win;
}

const INJECT_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_MS = 20_000;
const MIN_PRACTICE_WORDS = 10;

type PracticeResult = { ok: boolean; error?: string };

/** A custom test whose words are exactly a stored practice session is that practice session. */
function classifyTest(test: CapturedTest, database: Db): { source: TestSource; practiceId: number | null } {
  const practiceId = test.mode.startsWith('custom') ? findPracticeSession(database, test.words) : null;
  return practiceId === null ? { source: 'standard', practiceId: null } : { source: 'practice', practiceId };
}

app.whenReady().then(() => {
  if (!gotLock) return;
  const database = openDb(path.join(app.getPath('userData'), 'weakword.db'));
  db = database;
  const monkeytype = createMonkeytypeWindow();
  const coach = createCoachWindow(monkeytype);
  const toCoach = (channel: string, ...args: unknown[]) => {
    if (!coach.isDestroyed()) coach.webContents.send(channel, ...args);
  };

  /** Asks the Monkeytype preload to load the words through the page's own UI. */
  function injectWords(words: string[]): Promise<PracticeResult> {
    return new Promise((resolve) => {
      const finish = (result: PracticeResult) => {
        clearTimeout(timer);
        ipcMain.removeListener('wwc:inject-done', onDone);
        resolve(result);
      };
      const onDone = (event: Electron.IpcMainEvent, result: PracticeResult) => {
        if (event.sender === monkeytype.webContents) finish(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'Monkeytype did not respond in time' }), INJECT_TIMEOUT_MS);
      ipcMain.on('wwc:inject-done', onDone);
      monkeytype.webContents.send('wwc:inject-practice', { words });
    });
  }

  /** Reloads like F5; Monkeytype keeps a custom text but shows only as many words as its previous wordset had. */
  function reloadMonkeytype(): Promise<void> {
    return new Promise((resolve) => {
      const wc = monkeytype.webContents;
      const done = () => {
        clearTimeout(timer);
        wc.removeListener('did-finish-load', done);
        resolve();
      };
      const timer = setTimeout(done, PAGE_LOAD_TIMEOUT_MS);
      wc.on('did-finish-load', done);
      wc.reload();
    });
  }

  let practicing = false;
  async function startPractice(): Promise<PracticeResult> {
    if (practicing) return { ok: true };
    practicing = true;
    toCoach('wwc:practice-status', { state: 'running' });
    let result: PracticeResult;
    try {
      const standard = getTests(database, { source: 'standard', limit: 50 });
      const analysis = analyze(standard, 'standard', { targetWpm: deriveTargetWpm(standard) });
      const lists = await loadWordLists(path.join(app.getPath('userData'), 'wordlists'));
      const plan = generatePractice({ analysis, wordList: lists.list, commonWords: lists.common, seed: randomInt(2 ** 31) });
      if (plan.words.length < MIN_PRACTICE_WORDS) throw new Error('Could not build a practice list from the word lists.');
      result = await injectWords(plan.words);
      if (result.ok) {
        insertPracticeSession(database, plan); // only a loaded session can be recognised later
        await reloadMonkeytype();
        if (!TEST) monkeytype.focus();
        toCoach('wwc:data-changed');
      }
    } catch (e) {
      result = { ok: false, error: (e as Error).message };
    } finally {
      practicing = false;
    }
    toCoach('wwc:practice-status', result.ok ? { state: 'done' } : { state: 'error', error: result.error });
    return result;
  }

  ipcMain.handle('wwc:start-practice', (event): Promise<PracticeResult> => {
    if (event.sender !== coach.webContents) throw new Error('not available');
    return startPractice();
  });

  // Ctrl+Shift+P from either window. This shadows Monkeytype's own Ctrl+Shift+P (command line)
  // inside the app; Esc still opens it.
  for (const wc of [monkeytype.webContents, coach.webContents]) {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || !input.shift || input.alt || input.meta) return;
      if (input.key.toLowerCase() !== 'p') return;
      event.preventDefault();
      void startPractice();
    });
  }

  ipcMain.handle('wwc:get-coach-data', (event): CoachData => {
    if (event.sender !== coach.webContents) throw new Error('not available');
    const standard = getTests(database, { source: 'standard', limit: 50 });
    const targetWpm = deriveTargetWpm(standard);
    return {
      standard: analyze(standard, 'standard', { targetWpm }),
      practice: analyze(getTests(database, { source: 'practice', limit: 50 }), 'practice', { targetWpm }),
    };
  });

  ipcMain.on('wwc:test-finished', (event, payload: unknown) => {
    if (event.sender !== monkeytype.webContents || !isCapturedTest(payload)) return;
    const { source, practiceId } = classifyTest(payload, database);
    insertTest(database, payload, source, practiceId);
    toCoach('wwc:data-changed');
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => db?.close());
