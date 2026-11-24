// Loads practice words into Monkeytype by driving its own UI the way a user would:
// result screen -> next test, config bar -> "change", custom text dialog -> paste -> "ok".
// Nothing here touches Monkeytype's storage, network or code.
import { LABEL, SEL } from './selectors';

/** The config bar ignores clicks while the restart animation plays (~1 s after a restart). */
const RESTART_ANIMATION_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the first truthy `find()` result, re-checking on every DOM change; rejects with `step` on timeout. */
function waitFor<T>(step: string, find: () => T | null | undefined | false, timeoutMs = 6000): Promise<T> {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(step));
    }, timeoutMs);
    function check() {
      const found = find();
      if (!found) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(found);
    }
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    check();
  });
}

function buttonByLabel(selector: string, label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(
    (b) => b.textContent?.trim().toLowerCase() === label,
  );
}

/** Config buttons are disabled on the result screen and mid-test (focus mode). */
const changeButton = () => buttonByLabel(SEL.configButton, LABEL.changeCustomText);

/** From another page (settings, account ...) back to the test page through the nav's keyboard button. */
async function ensureTestPage(): Promise<void> {
  if (document.querySelector(SEL.testConfig)) return;
  document.querySelector<HTMLElement>('header nav [data-nav-item="test"]')?.click();
  await waitFor('the test page did not open', () => document.querySelector(SEL.testConfig), 8000);
  await sleep(RESTART_ANIMATION_MS);
}

/** Gets Monkeytype to an idle test: leaves the result screen or abandons a running test. */
async function reachIdleTest(): Promise<void> {
  await ensureTestPage();
  if (document.querySelector(SEL.result)) {
    document.querySelector<HTMLElement>(SEL.resultRestartButton)?.click();
    await waitFor('the result screen did not close', () => !document.querySelector(SEL.result));
    await waitFor('the typing area did not come back', () => {
      const typing = document.querySelector(SEL.typingTest);
      return typing && !typing.classList.contains('hidden');
    });
  } else if (changeButton()?.disabled) {
    document.querySelector<HTMLElement>(SEL.restartButton)?.click(); // a test is running
  }
  await waitFor('the test settings stayed disabled', () => {
    const button = changeButton();
    return button && !button.disabled && button;
  });
  await sleep(RESTART_ANIMATION_MS);
}

async function openCustomTextDialog(): Promise<void> {
  // A click during the restart animation is silently dropped, so click again if nothing opens.
  for (let attempt = 0; attempt < 4; attempt++) {
    changeButton()?.click();
    try {
      await waitFor('the custom text dialog did not open', () => document.querySelector(SEL.customTextDialog), 1500);
      return;
    } catch {}
  }
  throw new Error('the custom text dialog did not open');
}

/** Applies `words` as a custom text (mode "simple": every word once, in order). */
export async function injectPractice(words: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await reachIdleTest();
    await openCustomTextDialog();

    // Simple mode is the default; selecting it again is harmless if it is already active.
    buttonByLabel(SEL.customTextButton, LABEL.simpleMode)?.click();

    const input = await waitFor('the custom text box was not found', () =>
      document.querySelector<HTMLTextAreaElement>(SEL.customTextInput),
    );
    input.value = words.join(' ');
    // Setting the value alone does not update the form; the input event does.
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const submit = await waitFor('the custom text "ok" button was not found', () =>
      document.querySelector<HTMLButtonElement>(SEL.customTextSubmit),
    );
    submit.click();
    await waitFor('the custom text dialog did not close', () => !document.querySelector(SEL.customTextDialog));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Monkeytype: ${(e as Error).message}` };
  }
}

/** Monkeytype's saved settings, read only (the app never writes them). */
export function readConfig(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(localStorage.getItem('config') ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ProfileRequest {
  mode: string;
  mode2: string;
  punctuation: boolean;
  numbers: boolean;
  language: string;
}

const MODE2: Record<string, string[]> = { time: ['15', '30', '60', '120'], words: ['10', '25', '50', '100'] };
const QUOTE_LENGTHS = ['short', 'medium', 'long', 'thicc'];

/** A config bar button with this exact label that is on screen (inactive groups stay in the DOM, hidden). */
function visibleConfigButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(SEL.configButton)).find(
    (b) => b.textContent?.trim().toLowerCase() === label && b.getBoundingClientRect().width > 0,
  );
}

/** Clicks a config button until `done()` holds; each click restarts the test, which ignores clicks for a moment. */
async function setConfig(label: string, done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 4 && !done(); attempt++) {
    const button = await waitFor(`the "${label}" button was not found`, () => visibleConfigButton(label));
    if (button.disabled) await waitFor(`the "${label}" button stayed disabled`, () => !button.disabled);
    button.click();
    try {
      await waitFor(`"${label}" did not apply`, done, 1500);
    } catch {}
    await sleep(RESTART_ANIMATION_MS);
  }
  if (!done()) throw new Error(`"${label}" did not apply`);
}

/** Switches Monkeytype to an ordinary test profile through its config bar, like a user would. */
export async function loadProfile(p: ProfileRequest): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!['time', 'words', 'quote'].includes(p.mode)) return { ok: false, error: `the ${p.mode} mode cannot be set automatically` };
    if (p.mode !== 'quote' && !MODE2[p.mode].includes(p.mode2)) {
      return { ok: false, error: `${p.mode} ${p.mode2} is a custom length; choose it in Monkeytype yourself` };
    }
    await reachIdleTest();
    const cfg = readConfig;
    if (cfg().language && cfg().language !== p.language) {
      return { ok: false, error: `Monkeytype is set to ${String(cfg().language).replace(/_/g, ' ')}; switch it to ${p.language.replace(/_/g, ' ')} for this test` };
    }
    await setConfig(p.mode, () => cfg().mode === p.mode);
    if (p.mode === 'quote') {
      const group = QUOTE_LENGTHS.indexOf(p.mode2);
      if (group >= 0) await setConfig(p.mode2, () => JSON.stringify(cfg().quoteLength) === JSON.stringify([group]));
    } else {
      await setConfig(p.mode2, () => String(cfg()[p.mode]) === p.mode2);
      await setConfig(LABEL.punctuation, () => Boolean(cfg().punctuation) === p.punctuation);
      await setConfig(LABEL.numbers, () => Boolean(cfg().numbers) === p.numbers);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Monkeytype: ${(e as Error).message}` };
  }
}
