import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface Launched {
  app: ElectronApplication;
  monkeytype: Page;
  coach: Page;
  userData: string;
}

/** Launches the app with a throwaway profile and no focus stealing (WWC_TEST=1). */
export async function launchApp(): Promise<Launched> {
  const userData = mkdtempSync(path.join(tmpdir(), 'wwc-e2e-'));
  // A parent shell may export ELECTRON_RUN_AS_NODE, which would make Electron run as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env as Record<string, string>;
  const app = await electron.launch({
    args: ['.'],
    env: { ...env, WWC_TEST: '1', WWC_USER_DATA: userData },
  });

  // Windows can appear in either order; wait until both exist, then match by URL.
  const find = (re: RegExp) => app.windows().find((w) => re.test(w.url()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const monkeytype = find(/monkeytype\.com/);
    const coach = find(/coach[\/]index\.html/);
    if (monkeytype && coach) return { app, monkeytype, coach, userData };
    await new Promise((r) => setTimeout(r, 200));
  }
  await app.close();
  throw new Error('Timed out waiting for the Monkeytype and coach windows');
}
