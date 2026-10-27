// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Sends the opt-in probe batches: small sips of recent speed fixes, only while the driver both switched
// traffic sharing on in Settings and said yes on the consent screen. The server folds each batch into
// anonymous per-street totals and never stores the raw fixes. Simulated (demo) drives never contribute:
// fake GPS would poison everyone's traffic.

import { state, api, local } from './core.js';

const SEND_EVERY_MS = 10_000; // a batch every 10 seconds is plenty: traffic changes by the minute
const MAX_POINTS = 6; // down-sampled to a few fixes per batch, to stay kind to the free tier
const KEEP_FIXES = 120; // keep ~2 minutes of fixes; older ones are stale by the time they send
const FRESH_MS = 30_000; // only send when the GPS talked recently

let buf = [];
let lastFixAt = 0;
let timer = null;

// Records a live GPS fix. Called from the app's location handler; demo drives never reach it.
export function noteProbeFix(fix) {
  lastFixAt = Date.now();
  if (!sharing()) {
    buf.length = 0;
    return;
  }
  buf.push({
    lat: fix.lngLat[1],
    lng: fix.lngLat[0],
    speed: Math.max(0, fix.speed ?? 0),
    heading: fix.heading,
    accuracy: fix.accuracy,
    at: fix.time,
  });
  if (buf.length > KEEP_FIXES) buf.splice(0, buf.length - KEEP_FIXES);
}

// Both switches must be on: the setting (which follows the account) and this device's consent.
export function sharing() {
  return state.settings.traffic_probe === true && local.get('probeConsent', false) === true;
}

// This device stops sharing: forget the consent and drop whatever was buffered.
export function stopSharing() {
  local.set('probeConsent', null);
  buf.length = 0;
}

export function startProbeSender() {
  if (timer) return;
  timer = setInterval(flush, SEND_EVERY_MS);
}

async function flush() {
  if (!sharing() || !buf.length) return;
  if (Date.now() - lastFixAt > FRESH_MS || document.hidden) return;
  const fixes = buf.splice(0);
  // Evenly down-sample: a sip across the whole 10 seconds, not just the newest fixes.
  const step = Math.max(1, Math.ceil(fixes.length / MAX_POINTS));
  const points = fixes.filter((_, i) => i % step === 0).slice(0, MAX_POINTS);
  try {
    await api('/api/probe', { method: 'POST', body: { consent: true, points } });
  } catch {
    // Traffic sharing is best-effort: a failed batch is just dropped, never retried in full.
  }
}
