# Monkeytype DOM reference (inspected 2026-11-24)

Live site: https://monkeytype.com, fresh guest, headless Chromium (Playwright), plus source from `monkeytypegame/monkeytype` master (HEAD `865f1d72`, 2026-11-23).
**Deployed client version** (footer version button, shift-click alert): `2026.11.23_13.57_37a2d5981` (compat 5). The footer version button text is empty in headless; read the version from the shift-click alert only if you need it.

IMPORTANT: this is the **new SolidJS frontend**. Most old selectors from memory (`#result`'s inner ids like `#result .stats .wpm`, `#resultWordsHistory`, `.word.active` containing `<letter>` with `.correct`, `#customTextModal`, `#cookiesModal`, `.pageTest`, `#liveWpm`...) are gone or renamed. Everything below was verified live unless marked (source) / (untested).


---

## 1. Selectors

Styling classes are Tailwind soup; **do not select on them**. Use ids, `data-ui-*` attributes and the few semantic classes listed.

### Page / test

| Purpose | Selector | Notes |
|---|---|---|
| Test page root | `#pageTest` | |
| Typing area (words + live stats) | `#typingTest` | gets class `hidden` (and inline `opacity:0`) when the test is finished / spinner / result shown |
| Words wrapper | `#wordsWrapper` (`data-ui-element="wordsWrapper"`) | click -> focuses input |
| Words container | `#words` (`data-ui-element="words"`) | gets class `blurred` when the window/input is unfocused; classes `highlight-letter`, `typed-effect-*` etc. are user prefs |
| One word | `#words .word` (= `[data-ui-element="word"]`) | attrs: `data-wordindex="N"` (global index), `data-ui-state="untyped\|typed\|typedIncorrectly"`, `dir="ltr"` |
| Active word | `#words .word.active` (= `[data-ui-active]`) | exactly one |
| Committed word | `.word.typed`; wrongly committed also `.word.error` (`data-ui-state="typedIncorrectly"`) | committed = space pressed (or last word finished) |
| Letter | `letter` (custom tag name, not a div/span) inside the word; `[data-ui-element="letter"]` | attrs: `data-ui-state="untyped\|correct\|incorrect\|extra\|dead\|deadCorrect"`, `data-char="<char>"`, text content = char |
| Letter classes | untyped = `class=""`; correct = `correct`; wrong = `incorrect`; **extra (typed past end)** = `incorrect extra`; stop-on-letter variants `dead`, `dead correct` (source) | |
| Typo hints container | `.word > div.hints` (last child of every word) | empty by default (`indicateTypos` = off). Ignore when iterating letters: use `:scope > letter` |
| Caret | `#caret` (`data-ui-element="caret"`, `data-ui-variant` = style) | absolutely positioned via inline `left/top` (updated every frame); `hidden` class when not shown |
| Pace caret | `#paceCaret` | |
| Hidden input | `textarea#wordsInput` | a **textarea**, not an input; see section 3 |
| Out-of-focus warning | text "Click here or press any key to focus" inside `#wordsWrapper` | |
| Language button | `#typingTest` first `button` row, text e.g. `english` | |
| Hidden mode string | `#premidTestMode` (class `hidden`, read `.textContent`) | `"<mode> <mode2> <language>"`: `time 30 english`, `words 10 english`, `quote 2688 english` (quote id), `zen zen english`, `custom custom english`. Does NOT include punctuation/numbers. Best single "which mode am I in" signal |
| Hidden seconds left | `#premidSecondsLeft` (hidden) | `config.time - elapsed seconds` (meaningful in time mode; counts down live) |
| Live timer (time mode, default "mini" style) | unnamed div under `#typingTest` (parent has `mt-[-1.25em] flex h-0 w-0`) | text `14`; no id. Prefer `#premidSecondsLeft` |
| Restart button (test page, below words) | `[data-ui-element="restartTestButton"]` | the same attribute is also on the result screen's "next test" button |
| Command line | `dialog#CommandlineModal[open]`, search `input[placeholder="Search..."]` | |

### Test config bar

Container `[data-ui-element="testConfig"]`. All buttons are `<button type="button" data-ui-element="button" data-ui-variant="text">` with **no id and no data-value**; select by container + exact text (icon `<i>` has no text):

| Purpose | Selector (Playwright-style) | DOM equivalent |
|---|---|---|
| punctuation / numbers toggles | `[data-ui-element=testConfig] button` with text `punctuation` / `numbers` | match `button.textContent.trim()` |
| mode buttons | text `time`, `words`, `quote`, `zen`, `custom` | |
| time mode2 | `15`, `30`, `60`, `120`, wrench-icon button (opens `#TestDurationModal`) | |
| words mode2 | `10`, `25`, `50`, `100`, wrench icon (opens `#CustomWordAmountModal`) | |
| quote length | `all`, `short`, `medium`, `long`, `thicc`, search icon | |
| custom mode2 | `change` | opens `#CustomTextModal` |

Gotchas:
- Button texts are unique across groups (time = 15/30/60/120, words = 10/25/50/100), but the **inactive mode2 groups stay in the DOM** (`display:none`), so `querySelectorAll` finds them. Check `getBoundingClientRect().width > 0` for visibility if needed.
- **Active state is not a class/attr you can name.** Active text-variant button has the Tailwind class substring `--themable-button-text:var(--themable-button-active)` in `className` (verified: that is the only difference; computed color is main color `rgb(226,183,20)` in the default theme). Easier and more robust: read `localStorage.config` (JSON, written for guests too): `{mode, words, time, punctuation, numbers, quoteLength, language, quickRestart, ...}`, or `#premidTestMode`.
- Config buttons are `disabled` (real attribute, so `el.click()` is a no-op!) while **focus mode** is on (`html[data-focused]`, from first keystroke until mouse move/Esc/finish) and on the result screen. They are also ignored during the restart animation (`isTestRestarting`). A mouse move exits focus mode.
- Changing mode/words/time/punctuation/numbers immediately calls `restartTest()` (new words).

### Result screen (mounted only when shown; removed on restart)

| Purpose | Selector | Sample |
|---|---|---|
| Result root | `#result` (inside `#pageTest`; `#typingTest` gets `.hidden`) | exists = test over |
| Stat cell | `#result [data-ui-element="resultStat"]` -> first child div = label (`wpm`, `acc`, `test type`, `other`, `raw`, `characters`, `consistency`, `time`, ...), `[data-ui-element="resultStatValue"]` = value | **select by label text, not index** (cells appear/disappear: `other` only when invalid; signed-in users get extra cells) |
| wpm | label `wpm` (label follows the speed-unit pref) | text `73`; exact value in `aria-label`: `72.67 wpm` |
| accuracy | label `acc` | text `90%`; `aria-label`: `90.00%\n45 correct\n5 incorrect` (those counts are keystroke-level) |
| test type | label `test type` | innerHTML `words 10<br>english`; `time 15 english`; custom = just `custom`; quote adds quote id |
| other | label `other` | `invalid (wpm,raw)<br>too short`, `invalid (accuracy)` |
| raw | label `raw` | text `96`, aria `96.24 wpm` |
| characters | label `characters` | text `37/3/1/5` = correct / incorrect / extra / missed (aria-label is the label list `correct\nincorrect\nextra\nmissed`) |
| consistency | label `consistency` | `62%`, aria `61.83% (20.88% key)` |
| time | label `time` | `6s`, aria `6.11s (0s afk 0%)`; sub value `00:00:06 session` |
| Next test | `#result [data-ui-element="restartTestButton"]` (aria-label "Next test") | |
| Repeat test | `[data-ui-element="restartTestButtonWithSameWordset"]` | same words again |
| Practice words (MT built-in) | `#practiseWordsButton` | opens `#PractiseWordsModal` (missed/slow words -> MT builds a custom test itself). (untested) |
| Words history toggle | `#showWordHistoryButton` | (untested contents) |
| Replay / screenshot | `#watchReplayButton`, `#saveScreenshotButton` | |
| Guest prompt | text "Sign in to save your result", `<a href="/login">` | |

Result is chart-heavy (`canvas.chartCanvas`); there is no per-word data in the DOM unless the words-history is toggled.

### Modals (all are `<dialog id="XxxModal">` under `#solidmodals`; open = `dialog.open` / `open` attribute, closed dialogs stay in DOM)

| Modal | Selector |
|---|---|
| Cookies | `dialog#CookiesModal[open]` |
| Command line | `dialog#CommandlineModal[open]` |
| Custom text | `dialog#CustomTextModal[open]` |
| Others in DOM | `AlertsModal, VersionHistoryModal, ContactModal, SimpleModalModal, SaveCustomTextModal, SavedTextsModal, WordFilterModal, CustomGeneratorModal, TestDurationModal, CustomWordAmountModal, PractiseWordsModal, QuoteSearchModal, ...` |

Detect "any popup open": `document.querySelector('#solidmodals dialog[open]')`.

---

## 2. First load as guest (cookie modal, banner)

- A **cookie consent dialog** appears bottom-right on first visit: `dialog#CookiesModal[open]` ("We use cookies by the way"). It is not closable with Esc or wrapper click. Buttons (all `<button type="button" data-ui-element="button">`, find by text): `accept all`, **`reject non-essential`** (sets `{security:true,analytics:false,sentry:false}`), `more options`.
  - Click: `[...document.querySelectorAll('#CookiesModal button')].find(b => b.textContent.trim() === 'reject non-essential').click()` - **synthetic click works** (verified in isolated world).
  - **Better: suppress it.** Seed `localStorage.acceptedCookies = '{"security":true,"analytics":false,"sentry":false}'` before the page scripts run (preload does). Verified: the dialog never opens. Schema is `.strict()`; if MT changes the cookie schema it re-asks.
- A yellow **merch banner** is a fixed overlay at the top: `div.fixed.top-0.left-0.z-1000.w-full` containing `img[alt="Banner Image"]`, text "Check out our merch store!", close `button` with `i.fa-times`. It does not block typing. Optional to dismiss; not shown in every load.
- No welcome/announcement modal, no login wall, no tutorial. The window autofocuses `#wordsInput` on load (verified: first typed char lands in the test without clicking).
- Third-party ad/analytics/Cloudflare requests fire on load (we blocked non-monkeytype hosts in tests; the site worked fine, headless Chromium was not challenged).

---

## 3. Hidden input element and event plumbing

Element: `<textarea id="wordsInput" autocomplete="off" autocapitalize="off" spellcheck="false" ...>` inside `#wordsWrapper`, opacity 0, repositioned to follow the active word (inline `top/left/width`). Its `value` is **always prefixed with one space** (leading-space trick so Backspace at word start is observable):

| State | `#wordsInput.value` |
|---|---|
| idle, before typing | `" "` (single space) |
| after typing `if` | `" if"` |
| after wrong char `z` (word `if` is 2 long) | `" ifz"` (extra letter) |
| after Backspace | `" if"` |
| after Space (word committed, next word active) | `" "` |
| Backspace on empty input, previous word was **incorrect** | `" zz"` (previous word's input is restored, `active` word index goes back) |
| Backspace on empty input, previous word was correct | blocked (value stays `" "`, no change) |
| Ctrl+Backspace | removes the whole current word input -> `" "` |
| after the test finishes | stale last value (`" course"`) until the next restart resets to `" "` |

So: current word's typed text = `value.slice(1)`; position in word = `value.length - 1`.

Listeners (checked with CDP `DOMDebugger.getEventListeners` and source `WordsInput.tsx`):
- On `#wordsInput` itself (native, **bubble phase**, via Solid `on:`): `keydown`, `keyup`, `beforeinput`, `input`, `compositionstart/update/end`, `focus`, `blur`, `copy`, `paste`, `select`, `selectstart`, `selectionchange`. Character insertion is driven by `beforeinput`/`input` (`inputType: insertText | deleteContentBackward | deleteWordBackward | insertLineBreak | composition*`), **not** by keydown. `keydown` only handles Tab/Enter/arrows/funbox/layout emulation.
- On `document` (bubble): ~9 `keydown` (tanstack hotkeys + `autofocusWords`), several `keyup`, `visibilitychange`, one `input`.
- On `window`: `keydown`, `resize`, `blur`, `focus`, `visibilitychange`, `beforeunload`.
- **Your window-capture listeners run first** and see everything in the order `keydown` -> `beforeinput` -> `input` -> `keyup` (verified, all `isTrusted: true` for Playwright keyboard). `event.target.id === "wordsInput"`. Hotkeys (Esc, Tab as restart, Mod+Shift+P) are handled on `document` and call `stopPropagation`, so a window-capture listener still sees those keydowns.
- Keys pressed while the textarea is unfocused and no popup open: `document` keydown re-focuses the textarea (`autofocusWords`) and, with the out-of-focus warning enabled, `preventDefault()`s that key (the first key is swallowed).

**isTrusted:** zero occurrences of `isTrusted` in `frontend/src` and `packages/*/src` (grep on the master tarball). No webdriver/automation detection either. Only listener-level checks: `onBeforeInput` requires `event instanceof InputEvent` (synthetic non-InputEvent `input` on the textarea is `preventDefault`ed), and unsupported `inputType`s are blocked. Synthetic KeyboardEvents dispatched at the textarea do **not** type (no `beforeinput`), so typing must be real/trusted input; we only need to read.

### Reading the expected character - timing gotcha

DOM updates are batched per animation frame (`states/words-render.ts`: writers fill a buffer, one shared rAF applies it). Measured with a window-capture `keydown` listener:
- at 100 ms and 30 ms between keys, `.word.active` was always up to date at keydown;
- at ~8 ms between keys, **after a Space the DOM active word was one word stale** (`val=" "` but `.active` still the old word).
So at keydown do not trust `.word.active` alone. Robust approach: keep your own word counter (increment on a Space that commits a word) or derive index from `data-wordindex` of the active word *and* cross-check with `value`, and take the expected char from `word.textContent[value.length-1]` / `letter[data-char]` of that `data-wordindex`. Expected char for the key being pressed = letter at index `value.length - 1` (value read at keydown = state before this key). Past the end of the word, the expected char is Space (word commit).

Word DOM windowing: earlier word elements are **removed** after the line jump (words 50: at word 25 the DOM held `data-wordindex` 12..49 only). Always look words up by `data-wordindex`, never by position; snapshot/record a word's text before it scrolls off. Time mode streams words in as you go. Words/custom (<=100 words) are generated up front.

DOM after a word is committed, examples:
```html
<!-- committed incorrectly: wrong letter, an extra letter at the end -->
<div data-ui-element="word" data-wordindex="1" data-ui-state="typedIncorrectly" class="word typed error ...">
  <letter data-ui-state="correct"   class="correct"   data-char="i">i</letter>
  <letter data-ui-state="incorrect" class="incorrect" data-char="n">n</letter>   <!-- expected n; typed char is NOT shown -->
  ... <letter data-ui-state="extra" class="incorrect extra" data-char="k">k</letter>  <!-- extra: data-char = typed char -->
  <div class="hints ..."></div>
</div>
<!-- Space pressed early: skipped letters stay untyped -->
<div data-wordindex="2" data-ui-state="typedIncorrectly" class="word typed error ...">
  <letter class="correct" data-char="l">l</letter><letter class="" data-ui-state="untyped" data-char="i">i</letter>...
```
Notes: for a wrong letter the DOM shows the **expected** char, not what was typed (unless the user enables `indicateTypos`). So wrong-typed chars can only come from your own keydown/`input` capture (`event.data`). Letters with a stop-on-error/lazy setting may differ; defaults assumed (all prefs default for a fresh guest).

---

## 4. Lifecycle signals

| Moment | DOM signal |
|---|---|
| Idle (new test ready) | `#result` absent, `#typingTest` not `.hidden`, `#words` has words, active word = index 0, `#wordsInput.value === " "`, `html[data-focused]` absent |
| Start (first keystroke) | `html[data-focused]` appears (also on `header`, `footer`: "focus mode" fade); config buttons become `disabled`; `#premidSecondsLeft` starts counting down (time mode); live timer appears. **No dedicated "test started" class.** `data-focused` is also cleared by mouse move / Esc (command line), so it is not a reliable "test active" flag. Use your own signal: first `input` event (insertText) on `#wordsInput` while `#result` is absent |
| End | `#result` is mounted, `#typingTest` gets `hidden` (+ `opacity:0`), `html[data-focused]` removed, `#words` children removed (`resetWordsRender`). Measured ~170 ms after the final correct char in words mode (fade-out 125 ms, spinner `[data-ui-element="resultSpinner"]` may flash, then `#result` fades in, `style="opacity: 0 -> 1"` over ~100 ms). Existence of `#result` (not visibility/opacity) is the signal; the values are readable immediately |
| Words-mode end condition | the **last word's last correct char ends the test with no Space needed** (verified). (Last word typed wrongly then needs Space - source, untested) |
| Time-mode end | `#result` appears when the timer hits 0 (15 s test: result at 15.1 s) |
| Restart | `#result` removed, `#typingTest` loses `hidden`, `#words` repopulated with **new random words** (or same with "repeat test"), `#wordsInput.value` reset to `" "`, active word 0 |
| Window regains focus / becomes visible while idle (words/time modes) | MT **restarts the unstarted test** (`restartIfNotStarted`): words you captured may change. Window blur adds `.blurred` to `#words` |

Restart methods (default `quickRestart: "off"`, shown in footer as "tab > enter - restart test"):
- `Tab` focuses `[data-ui-element="restartTestButton"]`, then `Enter` restarts (works mid-test with no confirm, and on the result screen where Tab focuses "next test"). Verified.
- Plain `Tab` alone does nothing else; no restart on `Tab` unless user sets quickRestart to tab (`localStorage.config.quickRestart`).
- Click on `[data-ui-element="restartTestButton"]` (synthetic `.click()` works, verified on the result screen).

Mode detection: `#premidTestMode` + `localStorage.config` (see Section 1).

---

## 5. Custom text flow (what our practice injection should do)

Source: `components/modals/CustomTextModal.tsx`, `test/custom-text.ts`, `TestConfig.tsx`. All steps below were run live both with **trusted** Playwright input and **synthetically** from a CDP *isolated world* (`Page.createIsolatedWorld`, the closest stand-in for an Electron preload with contextIsolation): `element.click()` and `dispatchEvent(new Event('input', {bubbles:true}))` from the isolated world. Results:

| Step | Selector | Trusted | Synthetic (isolated world) |
|---|---|---|---|
| 0. (optional) click mode `custom` | testConfig button text `custom` | works | works. **Not required**: OK in the modal sets `mode = custom` itself (verified from words mode) |
| 1. open modal | testConfig button text `change` (exists in DOM even when hidden, since it lives in the hidden mode2 group) | works | works (`el.click()` on the hidden button opens the modal) |
| 2. wait for modal | `dialog#CustomTextModal[open]`, textarea autofocused | | |
| 3. set text | `#CustomTextModal textarea#text` (name `text`, placeholder "type or paste your custom text") | `fill()` OK; click + Ctrl+A + `keyboard.insertText()` OK; `keyboard.type()` OK | `t.value = text; t.dispatchEvent(new Event('input',{bubbles:true}))` OK; `InputEvent('input')` OK; `document.execCommand('insertText')` OK. **`t.value = text` WITHOUT dispatching `input` does NOT work** (form state not updated; old default text "The quick brown fox jumps over the lazy dog" is used) |
| 4. apply | `#CustomTextModal button[type="submit"]` (text `ok`) | click OK | `el.click()` OK. Also Ctrl+Enter in the textarea submits (source) |
| 5. result | modal closes, `config.mode = "custom"`, test restarts with the text | | |

Other modal controls (all `button[type=button][data-ui-element=button]`, find by text; none tested beyond markup):
- Mode (sidebar): `simple` (default, active; limit = text length, words in order, test ends after the last word), `repeat`, `shuffle`, `random` (these need a limit: `input[type=number][placeholder="words"]` / `[placeholder="sections"]` / `[placeholder="time"]`; inputs are `disabled` in simple mode; only one limit allowed).
- Word delimiter: `pipe` / `space` (default space). Pipe = sections split on `|`.
- Text cleanup buttons (each labelled `apply`, found by the preceding group title): "Remove zero-width characters", **"Remove fancy typography"**, "Replace control characters", "Replace new lines with spaces" (`space` / `period + space`). Text is also normalised on submit (NFC, NBSP/thin spaces -> space, runs of spaces collapsed, newlines -> `\n ` words).
- Misc: `save`, `saved texts`, `open file` (hidden `input[type=file]`), `words filter`, `custom generator`.
- Empty text: notification "Text cannot be empty", modal stays open.

Results verified: `"alpha bravo charlie delta echo foxtrot"` -> exactly 6 words in that order in `#words`; typing them all ended the test with no trailing Space; `#result` test type = `custom`; the result shows `other: invalid (wpm,raw) too short`. `localStorage.customTextSettings` = `{"mode":"repeat","pipeDelimiter":false,"limit":{"mode":"word","value":6},"text":[...]}`.

### BIG GOTCHA: stale wordset length (site bug) -> long lists repeat the first N words

Applying a custom text **longer than the first custom wordset generated in this page session** (the default 9-word text, created the moment mode `custom` first runs, or a previously applied text) makes the words cycle with the old length. Verified live:
- apply 30 unique words -> 30 words rendered but only the first **9** distinct (`w00..w08` repeated); same with 45 -> 9 unique. `shuffle` mode with limit 30 also only used 9 words.
- re-clicking OK, restarting (Tab+Enter, restart button) does not fix it.
- Shorter-or-equal lists are fine (6 words and 9 words OK; after a 30-word session, 20 words OK, 40 words only 30 unique).
- `localStorage.customTextSettings` always holds the full list; **a page reload fixes it** (30 unique after `location.reload()`), and so does seeding storage before the first load.

Recommended injection strategies:
1. **Seed + load (most robust, verified):** in the preload (runs before page scripts) write
   `localStorage.customTextSettings = JSON.stringify({mode:"repeat",pipeDelimiter:false,limit:{mode:"word",value:N},text:[...words]})` and set `config.mode = "custom"` in `localStorage.config` (parse, set, stringify; do not replace the object), then `location.reload()` (or do it before first load). On load, mode custom shows all N words (verified 30/30 unique). Uses no UI and no clicks, but relies on MT's storage schema (`CustomTextSettingsSchema`).
2. **UI flow + reload:** click `change` -> set textarea + `input` event -> click `ok` -> then `location.reload()` if the list is longer than ~9 words. Reload keeps `mode=custom` and the list. Lists of <= 9 words need no reload.
3. If you keep each practice list to <= 9 words you avoid the bug, but still reload if the previous wordset was shorter than the new list.

After the reload, MT's `window focus` handler may restart an un-started test (new words in non-custom modes only; custom is deterministic in `simple` mode).

### Synthetic clicks that fail
- Config bar buttons while `html[data-focused]` is set (mid-test) or on the result screen: they carry a real `disabled` attribute, so `click()` does nothing (verified: `words 25` ignored, `change` did not open the modal). From the result screen, first click `#result [data-ui-element="restartTestButton"]` (synthetic works), wait for `#result` to disappear and `#typingTest` to lose `hidden` (~1.2 s incl. fades), then proceed. A mouse move also leaves focus mode.
- `click()` during the restart fade (`isTestRestarting`) is silently ignored by `TCButton`; wait ~600-1200 ms after a restart before clicking config buttons.
- Everything else in the flow (custom/change, textarea set, ok, cookie reject, restart buttons) works with untrusted events.

---

## 6. Shortcuts (default prefs, verified unless noted)

| Key | Effect |
|---|---|
| `Esc` | opens command line (`#CommandlineModal[open]`, focus moves to its `input`) even mid-test. The test is **not** reset (input value kept); focus mode clears. `Esc` again closes it and refocuses `#wordsInput` |
| `Ctrl+Shift+P` | same command line (hotkey `Mod+Shift+P` always registered; footer shows "ctrl + shift + p" except on Firefox) |
| `Tab` then `Enter` | restart (see section 4). `Tab` alone only moves focus to the restart button |
| `Ctrl+Enter` | nothing in a test; submits the custom-text modal when typed in its textarea |
| `Shift+Enter` | nothing in a normal short test; ends a zen test; in "long" tests (cannot quick-restart) double-tap bails out (source) |
| `Ctrl+Backspace` | deletes current word's input |
| `Backspace` | see table in section 3 (blocked into a correct previous word) |
| Arrows/Home/End/PgUp/PgDn | prevented during the test |
| Hotkeys are ignored while any `dialog` popup is open | (`isAnyPopupVisible`) |

If the user changes `quickRestart` to `tab|esc|enter`, those keys restart directly and the command line moves (source `states/hotkeys.ts`).

---

## 7. Word lists

- Raw URLs (HTTP 200, `text/plain`, verified):
  - `https://raw.githubusercontent.com/monkeytypegame/monkeytype/master/frontend/static/languages/english.json` (2,540 B, **200 words**)
  - `.../english_1k.json` (12,943 B, **1000 words**)
  - `.../english_5k.json` (73,969 B, **5000 words**)
  - also `english_10k.json` (9,944 words), `english_25k`, `english_450k`, `english_commonly_misspelled`, `english_contractions`, `english_doubleletter`, `english_legal`, `english_medical`, `english_old`, `english_shakespearean` in the same folder.
  - The site also serves them: `https://monkeytype.com/languages/english_1k.json`.
- JSON shape (all unique words, ordered by frequency):
  ```json
  { "name": "english_1k", "noLazyMode": true, "orderedByFrequency": true, "words": ["the", "of", "to", "and", "a", ...] }
  ```
  `english.json` contains capitalised `"I"`; max word length 8 / 11 / 18 for 200 / 1k / 5k.
- License: repository is **GNU GPL v3.0** (`LICENSE` at repo root, GitHub reports `GPL-3.0`). No separate license/README exists in `frontend/static/languages/`. Bundling these lists into a distributed app makes the list data GPL-3.0 content; if that matters, generate our own lists or comply (attribution + license text) - flag to the user.

---

## 8. Guest vs logged-in differences that can affect selectors (source only, not logged in)

- Test config: quote mode gets an extra heart (favorites) `button` (`fa-heart`) when `isAuthenticated()`; no other test-page changes.
- Result screen: guest sees "Sign in to save your result" (`a[href="/login"]`). Signed-in users get extra `resultStat` cells (tags / daily leaderboard / PB crown details), chart lines, "result saving" status and `#retrySavingResultButton` on failure; the result cells shift, so **always select by label text**. Header shows the profile/avatar instead of `a[href="/login"]`.
- Config/custom text: for signed-in users the account config from the server overrides `localStorage.config` after login (and keeps syncing), so `localStorage.config` may lag/reset after sign-in. Saved custom texts are account-backed (`SavedTextsModal`).
- Possible extra modals/banners for signed-in users: alerts/inbox badge on the bell, `LastSignedOutResultModal` (shows the last guest result after login), streak offset modal, PSAs (`confirmedPSAs`), Google signup modal. They would sit in `#solidmodals` like the others.
- Settings like `quickRestart`, theme, caret, `indicateTypos`, `funbox`, `layout` can be user-set and change the DOM (e.g. `indicateTypos` adds `.hints` content; `tape`/`blind` classes on `#words`/`#wordsWrapper`; tape mode hides earlier words). The Weakword Coach app uses a fresh guest profile, so defaults apply.

---

## 9. Other gotchas

- `#words` is virtualised per line jump; use `data-wordindex`.
- The 'words' test never exposes the full text after finishing (DOM cleared). Record words as they appear.
- Result `wpm` text is rounded; exact value is in the `aria-label`.
- Clicking inside `#wordsWrapper` and `focusWordsEvent` re-focuses the textarea; don't steal focus (open a popup) during a test; Esc + command line does not abort the test.
- Playwright `page.locator(...)getByRole('button',{name:'words'})` did **not** match config buttons (accessible name came out empty with the icon); use CSS + text instead.
- Headless Chromium + Cloudflare: not challenged in testing on 2026-11-24; ads/trackers were blocked at the route level.
- `restartIfNotStarted` on `window` focus/visibility means that alt-tabbing to the app before typing regenerates words (words/time modes).
