// Every Monkeytype selector and UI label the app or its tests rely on, in one place.
// Verified against the live site: see docs/monkeytype-dom.md. Do not select on Tailwind classes.

export const SEL = {
  /** Clicking it focuses the hidden input. */
  wordsWrapper: '#wordsWrapper',
  /** Container of the rendered words (windowed: old lines are removed). */
  words: '#words',
  /** One word; `data-wordindex` is its global index. */
  word: '#words .word[data-wordindex]',
  /** The word currently being typed. */
  activeWord: '#words .word.active[data-wordindex]',
  /** Direct letter children of a word (excludes the `.hints` div). Extra letters also carry class `extra`. */
  letter: ':scope > letter',
  extraLetter: '.extra',
  /** Hidden textarea that receives typing; its value always has one leading space. */
  wordsInput: 'textarea#wordsInput',
  /** Mounted only while the result screen is shown. */
  result: '#result',
  resultStat: '#result [data-ui-element="resultStat"]',
  /** Inside a resultStat; the exact number is in its aria-label. */
  resultStatValue: '[data-ui-element="resultStatValue"]',
  /** Hidden element whose text is "<mode> <mode2> <language>", e.g. "words 25 english". */
  testMode: '#premidTestMode',
  /** Container of the mode / words / time buttons (no ids; find buttons by text). */
  testConfig: '[data-ui-element="testConfig"]',
  /** Restart button below the words (the result screen's "next test" shares the attribute). */
  restartButton: '[data-ui-element="restartTestButton"]',
  /** The typing area (words + live stats); hidden while the result screen shows. */
  typingTest: '#typingTest',
  /** The result screen's "next test" button. */
  resultRestartButton: '#result [data-ui-element="restartTestButton"]',
  /** Buttons inside the test config bar. */
  configButton: '[data-ui-element="testConfig"] button',
  /** Custom text dialog: open state, its text box, its mode buttons and its "ok" button. */
  customTextDialog: 'dialog#CustomTextModal[open]',
  customTextInput: 'dialog#CustomTextModal textarea#text',
  customTextButton: 'dialog#CustomTextModal button[type="button"]',
  customTextSubmit: 'dialog#CustomTextModal button[type="submit"]',
  /** Cookie consent dialog. */
  cookiesDialog: 'dialog#CookiesModal[open]',
  /** Any open modal dialog (command line, custom text, cookies ...). */
  openDialog: '#solidmodals dialog[open]',
} as const;

/** Visible text of buttons and result cells, matched exactly after trim/lowercase. */
export const LABEL = {
  rejectCookies: 'reject non-essential',
  /** Result cell labels. */
  wpm: 'wpm',
  raw: 'raw',
  accuracy: 'acc',
  consistency: 'consistency',
  /** testConfig mode button. */
  wordsMode: 'words',
  /** testConfig button (in custom mode) that opens the custom text dialog. */
  changeCustomText: 'change',
  /** Custom text dialog mode: words once each, in order. */
  simpleMode: 'simple',
} as const;
