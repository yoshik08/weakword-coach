import { app, BrowserWindow, session, shell, type BrowserWindowConstructorOptions } from 'electron';
import path from 'node:path';

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

app.whenReady().then(() => {
  if (!gotLock) return;
  createCoachWindow(createMonkeytypeWindow());
});

app.on('window-all-closed', () => app.quit());
