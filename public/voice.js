// Spoken directions, read by the phone's own speech voices (speechSynthesis): offline, any language.
// Phones ship several voices and the default is often the most robotic, so the best-sounding one is picked
// automatically and Settings lets you choose another. Voices differ between devices, so the choice is kept
// on this device: a voice name, or 'auto'.

import { state, local } from './core.js';

const QUALITY = /premium|enhanced|natural|neural|siri|wavenet|online/i;

export function voiceChoice() {
  return local.get('voiceName') ?? 'auto';
}

export function setVoiceChoice(name) {
  local.set('voiceName', name);
}

// The phone's voices for the prompt language, best-sounding first.
export function deviceVoices() {
  if (!('speechSynthesis' in window)) return [];
  const lang = (navigator.language || 'en-US').toLowerCase();
  const base = lang.slice(0, 2);
  const score = (v) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    let s = 0;
    if (l === lang) s += 4;
    if (QUALITY.test(v.name)) s += 6;
    if (/google/i.test(v.name)) s += 3; // Chrome's network voices sound far better than the built-in ones
    if (!v.localService) s += 1;
    if (v.default) s += 1;
    return s;
  };
  return speechSynthesis
    .getVoices()
    .filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(base))
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

export const isGoodVoice = (v) => QUALITY.test(v.name) || /google/i.test(v.name);

// Voice lists load late on some browsers; ask early so the first direction has them.
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  speechSynthesis.getVoices();
  speechSynthesis.addEventListener?.('voiceschanged', () => speechSynthesis.getVoices());
}

export function speak(text, { force = false, choice = voiceChoice() } = {}) {
  if (!text || (!state.settings.voice && !force) || !('speechSynthesis' in window)) return;
  try {
    const voices = deviceVoices();
    const u = new SpeechSynthesisUtterance(text);
    const v = (choice !== 'auto' && voices.find((x) => x.name === choice)) || voices[0];
    if (v) u.voice = v;
    u.lang = v?.lang || navigator.language || 'en-US';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
