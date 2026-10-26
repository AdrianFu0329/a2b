// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// New versions of the app. A phone keeps a home-screen app frozen in the background and wakes it where it left
// off, so people can run an old version for days. Each time the app comes back on screen it asks for the
// latest version's fingerprint (version.json, a few bytes; no timers). When a newer one is out:
// - waking up on the map with nothing open, it refreshes quietly, before anyone starts doing anything;
// - otherwise (picking a route, say), a small pill says so once and fades away; over a full screen (search,
//   settings) it waits for that to close, so it never covers what someone is typing;
// - while driving, nothing until the trip ends.
// After the pill, a dot on the menu button and an "Update A2B" row in the menu stay until the refresh.

import { $ } from './core.js';

const PILL_MS = 8000;
const SCREENS = ['search', 'panel', 'auth']; // full screens with their own bar where the pill sits

let mine = null; // the version this page was loaded with
let newer = false;
let announced = false;
let idle = () => false;
let driving = () => false;

async function latest() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()).v ?? null;
  } catch {
    return null;
  }
}

export async function watchUpdates(opts) {
  ({ idle, driving } = opts);
  $('m-update').onclick = refresh;
  $('upd-go').onclick = refresh;
  mine = await latest();
  if (!mine) return; // no version file (local dev): nothing to compare
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    if (!newer) {
      const v = await latest();
      if (!v || v === mine) return;
      newer = true;
    }
    if (idle()) refresh();
    else updateCheckpoint();
  });
}

// A good moment to mention a newer version, if there is one: the app came back on screen, or a trip ended.
export function updateCheckpoint() {
  if (!newer) return;
  $('btn-menu').classList.add('has-update');
  $('m-update').classList.remove('hidden');
  if (!announced && !driving()) announce();
}

let waitingFor = null;

function announce() {
  const open = SCREENS.map((id) => $(id)).filter((el) => !el.classList.contains('hidden'));
  if (open.length) {
    // Try again once it closes. Only class changes on these few elements are watched, and only until then.
    waitingFor ??= new MutationObserver(() => {
      if (SCREENS.some((id) => !$(id).classList.contains('hidden'))) return;
      waitingFor.disconnect();
      waitingFor = null;
      if (!announced && !driving()) announce();
    });
    for (const el of open) waitingFor.observe(el, { attributes: true, attributeFilter: ['class'] });
    return;
  }
  announced = true;
  const pill = $('upd-pill');
  pill.classList.remove('hidden');
  const hide = () => {
    pill.classList.add('hidden');
    $('map').removeEventListener('pointerdown', hide);
  };
  $('map').addEventListener('pointerdown', hide);
  setTimeout(hide, PILL_MS);
}

function refresh() {
  location.reload();
}
