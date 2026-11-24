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

/** Gets Monkeytype to an idle test: leaves the result screen or abandons a running test. */
async function reachIdleTest(): Promise<void> {
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
