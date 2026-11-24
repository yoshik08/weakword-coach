# Weakword Coach

A Windows desktop app that wraps the real [monkeytype.com](https://monkeytype.com) and adds keybr-style adaptive training: it watches your finished Monkeytype tests, tracks which keys, bigrams and words you are weakest at, and feeds practice tests into Monkeytype's Custom mode. It only observes the page and drives the UI like a user; it never touches Monkeytype's API, tokens or results.

Unaffiliated with Monkeytype and keybr.

## Setup

```
npm install
```

## Run

```
npm start
```

## Test

```
npm run typecheck
npm test            # unit tests (vitest)
npm run test:e2e    # builds, then launches the app headlessly-ish with Playwright
```

E2E and test launches set `WWC_TEST=1` (windows are shown without taking focus) and `WWC_USER_DATA=<temp dir>` (throwaway profile).

## Build

```
npm run dist        # NSIS installer in release/
```
