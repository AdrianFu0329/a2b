// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Navigator } from '../public/nav.js';
import { distance, bearing } from '../public/geo.js';
import { DeadReckoningEpisode, shouldEstimate, nearTunnel, pointAt } from '../public/dead-reckoning.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
// Run the real browser functions with a synthetic clock, GPS and DOM. No map servers or GPS hardware are used.
// Functions end at an unindented brace; fail loudly if a refactor moves them instead of testing a copied body.
function appFunction(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `app function ${name} exists`);
  return match[0];
}

function route(count = 301, stop = false) {
  const coords = Array.from({ length: count }, (_, i) => [101.6 + i * 0.001, 3.1]);
  const last = count - 1;
  const steps = [
    { type: 'depart', begin: 0, end: last, length: last * 111, time: last * 8, pre: 'Drive east.', alert: 'Drive east.' },
    { type: 'arrive', begin: last, end: last, length: 0, time: 0, pre: 'You have arrived.', alert: 'You will arrive.' },
  ];
  if (stop) steps.splice(1, 0, { type: 'stop', begin: 10, end: last, length: 1110, time: 80, pre: 'You have reached your stop.' });
  return { coords, steps };
}

function drive({ speed = 8, count, stop = false } = {}) {
  const clock = { now: 1_000_000 };
  const calls = { moves: [], shares: 0, probes: 0, patches: [], spoken: [], reroutes: 0, reached: [] };
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set(['hidden']);
      const span = { textContent: '' };
      nodes.set(id, { textContent: '', querySelector: () => span, classList: {
        add: (...items) => items.forEach((s) => classes.add(s)),
        remove: (...items) => items.forEach((s) => classes.delete(s)),
        contains: (s) => classes.has(s),
        toggle: (s, on) => on ? classes.add(s) : classes.delete(s),
      } });
    }
    return nodes.get(id);
  };
  const r = route(count, stop);
  const context = vm.createContext({
    Date: { now: () => clock.now }, setInterval: () => 1, clearInterval() {},
    DeadReckoningEpisode, shouldEstimate, nearTunnel, pointAt, distance, bearing,
    tunnelEpisode: new DeadReckoningEpisode(), tunnelTimer: null, tunnelFixAt: 0, lastFixAccuracy: null, lastGoodSpeed: 0,
    mode: 'drive', sim: null, gpsBlocked: false, nav: new Navigator(r), live: null, travel: 'drive',
    state: { pos: null, settings: { units: 'metric' } }, local: { set() {} },
    share: { token: 'synthetic-trip' }, stops: stop ? [{ name: 'Test stop' }] : [], offTrail: [],
    carMarker: { _map: true }, map: { easeTo() {} }, document: { body: node('body') },
    dest: { name: 'Test destination' }, destMarker: null, driveStarted: clock.now, lastFixAt: 0,
    wakeLock: null, parkingFor: null, trail: [], onRoute: [], STILL_SPEED: 1,
    $: node, moveCar: (pose) => calls.moves.push(pose), updateSpeedo() {},
    noteProbeFix: () => calls.probes++, pushShare: () => calls.shares++,
    speak: (text) => calls.spoken.push(text), toast: (text) => calls.reached.push(text),
    reroute: () => calls.reroutes++, api: async (url, options) => calls.patches.push({ url, ...options }),
    formatDistance: (n) => `${n} m`, formatDuration: (n) => `${n} s`,
  });
  for (const name of ['renderBanner', 'renderEta', 'renderLimit', 'drawDriveLine', 'drawManeuverArrow',
    'checkTolls', 'checkCameras', 'checkAlerts', 'renderStopMenu', 'setOffrouteNote', 'stopSimulation',
    'discardProbeBuffer', 'clearParkingPins', 'renderShareMenu', 'forgetTrip', 'drawTrail',
    'backToBrowse', 'resetTravel', 'drawRoutes', 'updateCheckpoint']) context[name] = () => {};
  vm.runInContext(['onFix', 'estSpeed', 'handleFix', 'driveTick', 'tunnelAhead', 'startTunnelWatch',
    'stopTunnelWatch', 'stopReckoning', 'tunnelTick', 'arrive', 'endDrive'].map(appFunction).join('\n'), context);
  const fix = (point = r.coords[0], extra = {}) => context.onFix({
    timestamp: clock.now,
    coords: { longitude: point[0], latitude: point[1], speed, heading: 90, accuracy: 10, ...extra },
  });
  context.startTunnelWatch();
  fix();
  return { context, clock, calls, node, route: r, fix, tick(seconds = 1) {
    for (let i = 0; i < seconds; i++) { clock.now += 1000; context.tunnelTick(); }
  } };
}

for (const speed of [8, 70]) test(`app timer cannot restart exhausted ${speed} m/s GPS estimates`, () => {
  const d = drive({ speed });
  let seconds = 0;
  while (!d.context.tunnelEpisode.exhausted && seconds < 100) { d.tick(); seconds++; }
  assert.equal(d.context.tunnelEpisode.exhausted, true);
  assert.ok(speed === 8 ? seconds === 92 : seconds < 90, `budget reached at ${seconds}s`);
  const along = d.context.live.along, updates = d.calls.moves.length;
  d.tick(180);
  assert.equal(d.calls.moves.length, updates, 'three more minutes produce no movement');
  assert.equal(d.context.live.along, along);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), false);
  assert.equal(d.node('dr-chip').querySelector('span').textContent, 'Waiting for GPS');
  assert.equal(d.calls.shares, 1, 'only the initial real fix was shared');
  assert.equal(d.calls.probes, 1, 'estimates never enter traffic probes');
  assert.equal(d.calls.patches.length, 0, 'outage does not end the shared trip');

  d.fix(d.route.coords[1], { accuracy: 150 });
  d.context.handleFix({ lngLat: d.route.coords[1], accuracy: 10, speed, time: d.clock.now - 3000 });
  d.tick(5);
  assert.equal(d.calls.moves.length, updates, 'poor and stale fixes cannot restart the episode');
  assert.equal(d.context.tunnelEpisode.exhausted, true);
  d.fix(d.route.coords[1]);
  assert.equal(d.context.tunnelEpisode.exhausted, false);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), true);
  const recovered = d.context.live.along;
  d.tick(2);
  assert.equal(d.context.live.along, recovered, 'wait for a new GPS gap');
  d.tick();
  assert.ok(d.context.live.along > recovered);
  assert.equal(d.node('dr-chip').querySelector('span').textContent, 'Estimating your position');
  d.context.stopTunnelWatch();
  assert.equal(d.context.tunnelEpisode.active, false);
  assert.equal(d.node('dr-chip').classList.contains('hidden'), true);
});

test('app estimated destination cannot announce arrival, finish the drive or end sharing; real GPS can', async () => {
  const d = drive({ speed: 20, count: 3 });
  d.tick(35);
  assert.equal(d.context.live.remaining, 0, 'estimate reaches the route endpoint');
  assert.equal(d.context.nav.arrived, false);
  assert.equal(d.context.mode, 'drive');
  assert.ok(d.context.share);
  assert.equal(d.calls.patches.length, 0);
  assert.equal(d.calls.shares, 1);
  assert.equal(d.calls.spoken.some((s) => /arrived/.test(s)), false);
  d.tick(100);
  assert.equal(d.context.mode, 'drive', 'waiting beyond exhaustion also keeps the trip open');
  d.fix(d.route.coords[0]);
  assert.equal(d.context.nav.arrived, false, 'a real fix before destination does not inherit estimated arrival');
  d.clock.now += 1000;
  d.fix(d.route.coords.at(-1), { speed: 0 });
  await Promise.resolve();
  assert.equal(d.context.mode, 'browse');
  assert.equal(d.context.share, null);
  assert.equal(d.calls.patches.length, 1);
  assert.equal(d.calls.patches[0].body.ended, 'arrived');
  assert.equal(d.node('arrived').classList.contains('hidden'), false);
  assert.ok(d.calls.spoken.some((s) => /arrived/.test(s)));
});

test('app estimated progress cannot consume a stop or reroute', () => {
  const d = drive({ speed: 70, count: 30, stop: true });
  d.tick(30);
  assert.ok(d.context.live.stepIndex >= 1);
  assert.equal(d.context.stops.length, 1);
  assert.equal(d.calls.reached.length, 0);
  assert.equal(d.calls.reroutes, 0);
  d.fix([101.612, 3.11]);
  assert.ok(d.context.live.offBy > 1000);
  assert.equal(d.context.live.offRoute, false, 'the first off-route fix has not yet triggered a reroute');
  assert.equal(d.context.stops.length, 1, 'its stale estimated step cannot confirm the stop');
  assert.equal(d.calls.reached.length, 0);
  d.clock.now += 1000;
  d.fix(d.route.coords[12]);
  assert.equal(d.context.stops.length, 0);
  assert.deepEqual(d.calls.reached, ['Reached Test stop']);
});

test('fresh stationary onFix measurements recover GPS even when movement time is old', () => {
  const d = drive();
  d.tick(95);
  const oldTime = d.context.state.pos.time;
  d.fix(d.route.coords[0], { speed: 0 });
  assert.equal(d.context.state.pos.time, oldTime);
  assert.equal(d.context.state.pos.gpsTime, d.clock.now);
  assert.equal(d.context.tunnelEpisode.exhausted, false);
  d.tick(100);
  assert.equal(d.context.tunnelEpisode.active, false, 'stationary car stays still');
});
