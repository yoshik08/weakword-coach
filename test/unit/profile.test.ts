import { describe, expect, it } from 'vitest';
import { AD_HOSTS, AD_URL_PATTERNS, isAdHost } from '../../src/main/adblock';
import { fingeringHint, fingerprintLayout, heatmapRows } from '../../src/shared/layout';
import { eligibility, inferNumbers, inferPunctuation, kindOf, profileFromKey, profileKey, profileLabel, profileOf } from '../../src/shared/profile';
import { captured } from '../fixtures/makeTest';

describe('profiles', () => {
  it('reads the result screen record: mode, language, punctuation, numbers and modifiers', () => {
    const t = captured(['Hello,', 'world', '42'], { mode: 'words 10', testType: ['words 10', 'english', 'punctuation', 'numbers', 'blind', 'expert'] });
    const p = profileOf(t);
    expect(p).toEqual({ mode: 'words', mode2: '10', language: 'english', punctuation: true, numbers: true, modifiers: ['blind', 'expert'], layout: 'qwerty' });
    expect(profileKey(p)).toBe('words 10|english|punctuation+numbers|blind,expert|qwerty');
    expect(profileFromKey(profileKey(p))).toEqual(p);
    expect(profileLabel(p)).toBe('words 10 · english · punctuation · numbers · blind · expert');
  });

  it('keys quotes by length group, keeps funbox and emulated layouts apart', () => {
    const quote = profileOf(captured(['a'], { mode: 'quote 2688', testType: ['quote short', 'english'] }));
    expect(quote).toMatchObject({ mode: 'quote', mode2: 'short' });
    const funbox = profileOf({ ...captured(['a'], { testType: ['time 30', 'english', 'mirror'], mode: 'time 30' }), settings: { layout: 'dvorak' } });
    expect(funbox.modifiers).toEqual(['emulating dvorak', 'funbox mirror']);
    const english1k = profileOf(captured(['a'], { mode: 'time 30', language: 'english_1k', testType: ['time 30', 'english 1k'] }));
    expect(english1k).toMatchObject({ language: 'english_1k', punctuation: false, modifiers: [] });
  });

  it('infers punctuation and numbers for tests stored before the record existed', () => {
    expect(inferPunctuation(['the', 'cat'])).toBe(false);
    expect(inferPunctuation(['The', 'cat.'])).toBe(true);
    expect(inferNumbers(['in', '1984'])).toBe(true);
    const old = profileOf({ ...captured(['the', 'end'], { mode: 'time 15' }), record: undefined, keyCodes: undefined });
    expect(old).toMatchObject({ mode: 'time', mode2: '15', punctuation: false, numbers: false, layout: 'unknown' });
    expect(profileOf({ ...captured(['a'], { mode: 'time 15' }), keyCodes: {} }, 'dvorak').layout).toBe('dvorak');
  });

  it('classifies tests and applies Monkeytype\'s own disqualifications', () => {
    expect(kindOf('custom custom', true)).toBe('drill');
    expect(kindOf('custom custom', false)).toBe('custom');
    expect(kindOf('zen zen', false)).toBe('zen');
    expect(kindOf('time 30', false)).toBe('normal');
    const ok = { wpm: 80, raw: 82, accuracy: 97, consistency: 70 };
    const rec = (other: string[]) => ({ testType: ['time 30', 'english'], other });
    expect(eligibility('normal', ok, rec([]), false)).toEqual({ eligible: true, reason: null });
    expect(eligibility('drill', ok, rec([]), false)).toEqual({ eligible: false, reason: 'practice round' });
    expect(eligibility('normal', ok, rec(['invalid (accuracy)']), false).reason).toBe('invalid (accuracy)');
    expect(eligibility('normal', ok, rec(['too short']), false).eligible).toBe(false);
    expect(eligibility('normal', ok, rec(['repeated']), false).eligible).toBe(false);
    expect(eligibility('normal', ok, rec(['invalid', 'repeated']), false).reason).toBe('invalid, repeated');
    expect(eligibility('normal', ok, rec([]), true).reason).toBe('same words as the previous test');
    expect(eligibility('normal', { ...ok, wpm: null }, rec([]), false).eligible).toBe(false);
  });
});

describe('layouts', () => {
  const codes = (letters: string, rows: string[]) => {
    const all = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'];
    const chars = rows.join('');
    const out: Record<string, string> = {};
    for (const l of letters) out[l] = all[chars.indexOf(l)];
    return out;
  };
  it('fingerprints the physical layout from key codes', () => {
    expect(fingerprintLayout(codes('theqickbrownfx', ['qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./']))).toBe('qwerty');
    expect(fingerprintLayout(codes('theqickbrownfx', ["',.pyfgcrl", 'aoeuidhtns', ';qjkxbmwvz']))).toBe('dvorak');
    expect(fingerprintLayout(codes('theqickbrownfx', ['qwfpgjluy;', 'arstdhneio', 'zxcvbkm,./']))).toBe('colemak');
    expect(fingerprintLayout({ a: 'KeyA', b: 'KeyB' })).toBeNull();
    expect(heatmapRows('dvorak')[1]).toBe('aoeuidhtns');
  });

  it('gives layout-aware fingering hints', () => {
    expect(fingeringHint('k:p', 'qwerty')).toBe('p: right pinky, up from ;.');
    expect(fingeringHint('k:j', 'qwerty')).toBe('j: right index, its home key.');
    expect(fingeringHint('b:ed', 'qwerty')).toMatch(/^ed uses the same finger \(left middle\)/);
    expect(fingeringHint('b:th', 'qwerty')).toMatch(/alternates hands/);
    expect(fingeringHint('k:e', 'dvorak')).toBe('e: left middle, its home key.');
  });
});

describe('ad blocking', () => {
  it('blocks the ad hosts Monkeytype loads and their subdomains, nothing of Monkeytype itself', () => {
    for (const h of ['cdn.intergient.com', 'cd836371f1d.cdn.intergient.com', 'config.playwire.com', 'securepubads.g.doubleclick.net', 'pagead2.googlesyndication.com', 'fundingchoicesmessages.google.com', 'c.amazon-adsystem.com']) {
      expect(isAdHost(h), h).toBe(true);
    }
    for (const h of ['monkeytype.com', 'api.monkeytype.com', 'www.google.com', 'www.gstatic.com', 'raw.githubusercontent.com', 'accounts.google.com']) {
      expect(isAdHost(h), h).toBe(false);
    }
    expect(AD_URL_PATTERNS).toHaveLength(AD_HOSTS.length);
  });
});
