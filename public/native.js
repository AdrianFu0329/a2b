// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Inside the A2B Android app (a Capacitor shell around this web app, see native/), the phone's own GPS, voice and
// screen lock take over from the browser's. In a browser inApp is false, the plugins are null and nothing changes.
// The app's WebView has no speech voices and stops GPS once the app is in the background; the native ones keep
// directions going with the screen off or another app on top.

const cap = typeof window === 'undefined' ? null : window.Capacitor;
export const inApp = Boolean(cap?.isNativePlatform?.());
const plugin = (name) => (inApp && cap.isPluginAvailable(name) ? cap.Plugins[name] : null);

export const keepAwake = plugin('KeepAwake');
export const nativeVoice = plugin('TextToSpeech');
const geo = plugin('BackgroundGeolocation');
export const nativeLocation = Boolean(geo);
const notifications = plugin('NotificationPermission');

// Android 13+ hides the "giving directions" notification without permission to show notifications. Ask once the
// location question is out of the way (at the first fix or error), not at the start of a drive, when a dialog
// could pop up in a moving car. Android itself stops asking after the second no.
let askedNotifications = false;
function askNotifications() {
  if (askedNotifications || !notifications) return;
  askedNotifications = true;
  notifications.request().catch(() => {});
}

let watcher = null; // { id, background } of the current location watcher

// Watchers belong to the app, not the page, so one from before a reload would keep the GPS (and the driving
// notification) going with no one listening. The page remembers its watcher across reloads to remove it.
const LAST_WATCHER = 'a2b.watcher';
const forget = (id) => geo.removeWatcher({ id }).catch(() => {});
if (geo) {
  try {
    const stale = sessionStorage.getItem(LAST_WATCHER);
    if (stale) forget(stale);
  } catch {}
}

// Like navigator.geolocation.watchPosition, with fixes in the same shape. `background` keeps fixes coming while
// the app is out of sight, behind a notification Android requires (only while driving).
export async function watchLocation(onFix, onError, { background = false } = {}) {
  if (watcher?.background === background) return;
  const old = watcher;
  const mine = { id: null, background };
  watcher = mine;
  const options = { requestPermissions: true, stale: false, distanceFilter: 0 };
  if (background) Object.assign(options, { backgroundTitle: 'A2B is giving directions', backgroundMessage: 'Tap to go back to your drive.' });
  const id = await geo.addWatcher(options, (loc, err) => {
    askNotifications();
    if (err) {
      // The watcher is dead after an error (no permission, location off, service not up yet), so the next
      // watchLocation adds a fresh one.
      if (watcher === mine) watcher = null;
      return onError({ code: err.code === 'NOT_AUTHORIZED' ? 1 : 2, message: err.message });
    }
    onFix({
      coords: { longitude: loc.longitude, latitude: loc.latitude, accuracy: loc.accuracy, speed: loc.speed, heading: loc.bearing },
      timestamp: loc.time ?? Date.now(),
    });
  });
  // Swap only once the new watcher is in, so no fixes are lost between the two. A watcher still being added when
  // it was replaced removes itself here.
  if (watcher === mine) {
    mine.id = id;
    try {
      sessionStorage.setItem(LAST_WATCHER, id);
    } catch {}
  } else forget(id);
  if (old?.id) forget(old.id);
}
