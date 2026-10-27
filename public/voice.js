// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Spoken directions, read by the phone's own speech voices (speechSynthesis): offline, no download.
// One voice for now: Daniel (British English, built into iPhones, iPads and Macs), the most natural-sounding of
// the built-in ones. Phones without him, like Android ones, use their best-sounding English voice. In the Android
// app the phone's own text-to-speech reads them instead (see native.js), so they carry on with the screen off.

import { state } from './core.js';
import { spokenCodes } from './nav.js';
import { nativeVoice } from './native.js';

const QUALITY = /premium|enhanced|natural|neural|siri|wavenet|online/i;

// The voice directions are read in, or null when the phone has none.
export function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const better = (a, b) => QUALITY.test(b.name) - QUALITY.test(a.name);
  const daniel = voices.filter((v) => /\bdaniel\b/i.test(v.name)).sort(better)[0];
  if (daniel) return daniel;
  const lang = (navigator.language || 'en-US').toLowerCase();
  const score = (v) => (v.lang.toLowerCase().replace('_', '-') === lang ? 4 : 0) + (QUALITY.test(v.name) ? 6 : 0) + (/google/i.test(v.name) ? 3 : 0) + (v.default ? 1 : 0);
  return voices.sort((a, b) => score(b) - score(a))[0] ?? null;
}

// Voice lists load late on some browsers; ask early so the first direction has them.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
}

export function speak(text, { force = false } = {}) {
  if (!text || (!state.settings.voice && !force)) return;
  if (nativeVoice) {
    // A new direction cuts off the one being read, like cancel() below. Phones without British English use their own.
    const say = (lang) => nativeVoice.speak({ text: spokenCodes(text), lang });
    say('en-GB').catch(() => say(undefined).catch(() => {}));
    return;
  }
  if (!('speechSynthesis' in window)) return;
  try {
    const v = pickVoice();
    const u = new SpeechSynthesisUtterance(spokenCodes(text));
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-GB';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
