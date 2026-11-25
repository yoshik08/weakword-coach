# Credits and third-party notices

## Monkeytype

Weakword Coach is built around [Monkeytype](https://monkeytype.com), the typing test created by **Miodec** and developed by its open-source community: [github.com/monkeytypegame/monkeytype](https://github.com/monkeytypegame/monkeytype) ([all contributors](https://github.com/monkeytypegame/monkeytype/graphs/contributors)). Every test, result and account in this app is Monkeytype's own; Weakword Coach only loads the real site in a window and adds a coach beside it. Weakword Coach is an independent project and is not affiliated with, endorsed by or sponsored by Monkeytype.

Monkeytype is licensed under the GNU General Public License v3.0: <https://github.com/monkeytypegame/monkeytype/blob/master/LICENSE>.

- **Code.** No Monkeytype source code is included in or copied into this repository. The app runs on monkeytype.com as served, reads its page like a user would, and does not modify its code. `docs/monkeytype-dom.md` is a set of our own notes on the markup we observed (written while reading the public source), kept so the selectors can be fixed when the site changes.
- **Word lists.** The practice prompts are generated from Monkeytype's language word lists, which are part of the GPL-3.0 Monkeytype project. They are **not bundled** with this app or repository: the app downloads them from monkeytype.com (fallback: the project's GitHub) on first use into the user's own profile folder and reads them from that cache. They remain the work of the Monkeytype contributors under GPL-3.0.
- **Name.** "Monkeytype" is the name of that project and site; it is used here only to say what this app works with.

## Ideas

The adaptive-practice approach draws on [keybr.com](https://www.keybr.com) and Typing.com, Amphetype, Dhakal et al. (CHI 2018) on inter-key timing, Crump & Logan (2010) on word-specific practice gains, and Baddeley & Longman (1978) on distributed practice. No code from these was used.

## Software dependencies

Weakword Coach is built with Electron, better-sqlite3, esbuild, TypeScript, Vitest and Playwright, plus the Archivo and Geist typefaces via Fontsource. Each is under its own open-source license (MIT, Apache-2.0 or SIL OFL 1.1); see the packages in `node_modules` for the exact terms.
