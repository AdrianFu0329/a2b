// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// First visit: a short welcome (what A2B is, that it's a beta, and how to put it on the home screen), shown
// once per device. Its "Let's go" is what asks for location, so the browser's prompt doesn't land on top of it.
// Also hides the launch splash once the map is ready.

import { $, local } from './core.js';
import { inApp } from './native.js';

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M8 10H6v10h12V10h-2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export const installed = () => inApp || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// done(): called once the driver is through (straight away for people who've seen it before).
export function welcome(done) {
  if (local.get('welcomed', false)) return done();
  if (inApp) $('welcome-ask').lastChild.textContent = 'Next, your phone asks to share your location so A2B can show where you are, and to show a notification while it gives directions';
  $('welcome-install').innerHTML = installed()
    ? ''
    : isIos()
      ? `<b>Use it like an app:</b> in Safari, tap Share <span class="w-ic">${SHARE_ICON}</span>, then <b>Add to Home Screen</b>, keep <b>Open as Web App</b> on, and open A2B from its new icon.`
      : '<b>Use it like an app:</b> in Chrome, tap ⋮, then <b>Add to home screen</b> (or <b>Install app</b>), and open A2B from its new icon.';
  $('welcome').classList.remove('hidden');
  $('welcome-go').onclick = () => {
    local.set('welcomed', true);
    $('welcome').classList.add('hidden');
    done();
  };
}

export function hideSplash() {
  const s = $('splash');
  if (!s || s.classList.contains('out')) return;
  s.classList.add('out');
  setTimeout(() => s.remove(), 400);
}
