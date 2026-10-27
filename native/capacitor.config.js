// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The app is a shell around the live web app: it loads A2B_URL (the live app by default) rather than a copy bundled
// inside, so sign-in cookies and /api stay same-origin and a web deploy updates the app too. To try a local copy on
// a phone or emulator: `npm run dev` in the repo, `adb reverse tcp:8787 tcp:8787`, then
// `A2B_URL=http://localhost:8787 npm run sync` here (localhost counts as secure, so GPS still works).
const url = process.env.A2B_URL || 'https://a2b-beta.pages.dev';

module.exports = {
  appId: 'my.a2b.app',
  appName: 'A2B',
  webDir: 'www', // only a fallback; the app loads `url`
  server: { url, cleartext: url.startsWith('http:') },
  // Results reach the page with evaluateJavascript rather than postMessage: with the screen off, Android's WebView
  // stops delivering postMessage about a minute in, and directions stop with it.
  android: { allowMixedContent: false, useLegacyBridge: true },
};
