import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance } from '../public/geo.js';
import { Follow, shouldSend, nextPollDelay, SEND } from '../public/follow.js';

// A straight 1 km road heading north; 0.00045° of latitude is ~50 m.
const ROUTE = Array.from({ length: 21 }, (_, i) => [13.4, 52.5 + 0.00045 * i]);
const at = (m) => [13.4, 52.5 + (0.009 * m) / 1000];

test('the driver sends only when something changed', () => {
  const t0 = 1_000_000;
  assert.equal(shouldSend(null, { now: t0, pos: at(0), eta: t0 + 600_000 }), 'first');
  const first = { at: t0, pos: at(0), eta: t0 + 600_000, count: 1 };
  assert.equal(shouldSend(first, { now: t0 + 2000, pos: at(0), eta: first.eta }), null);
  assert.equal(shouldSend(first, { now: t0 + 5000, pos: at(0), eta: first.eta }), 'second', 'a quick second update to measure speed');
  const last = { ...first, count: 2 };
  assert.equal(shouldSend(last, { now: t0 + 2000, pos: at(500), eta: last.eta }), null, 'never faster than every 4 s');
  assert.equal(shouldSend(last, { now: t0 + 10_000, pos: at(100), eta: last.eta }), null, 'small move, same ETA');
  assert.equal(shouldSend(last, { now: t0 + 10_000, pos: at(160), eta: last.eta }), 'moved');
  assert.equal(shouldSend(last, { now: t0 + 10_000, pos: at(10), eta: last.eta + 90_000 }), 'eta');
  assert.equal(shouldSend(last, { now: t0 + SEND.MAX_MS, pos: at(0), eta: last.eta }), 'heartbeat', 'stopped at lights: still a heartbeat');
});

test('viewers back off while the car is still', () => {
  assert.equal(nextPollDelay(0), 10_000);
  assert.equal(nextPollDelay(1), 30_000);
  assert.equal(nextPollDelay(2), 60_000);
  assert.equal(nextPollDelay(9), 60_000);
});

test('the car keeps moving between updates at the observed speed', () => {
  const f = new Follow(ROUTE);
  f.update({ position: at(100), at: 0 });
  f.update({ position: at(250), at: 15_000 }); // 150 m in 15 s = 10 m/s
  const p = f.at(15_000 + 5_000 + 2_000); // 7 s on, after the correction has faded
  assert.ok(Math.abs(distance(p.pos, at(250 + 70))) < 3, `expected ~320 m, got ${distance(at(0), p.pos)}`);
  assert.ok(Math.abs(p.heading) < 1, 'pointing along the road');
  assert.equal(p.stale, false);
});

test('without two positions yet, the pace comes from the ETA', () => {
  const f = new Follow(ROUTE);
  f.update({ position: at(400), at: 0, eta: 60_000 }); // 600 m left in 60 s = 10 m/s
  assert.ok(Math.abs(distance(f.at(10_000).pos, at(500))) < 3);
  assert.ok(Math.abs(distance(f.at(40_000).pos, at(550))) < 3, 'only 15 s of guessing from the ETA alone');
});

test('guessing stops at a limit, at the destination, and when the car stands still', () => {
  const f = new Follow(ROUTE);
  f.update({ position: at(100), at: 0 });
  f.update({ position: at(250), at: 15_000 });
  const far = f.at(15_000 + 300_000);
  assert.equal(far.stale, true);
  assert.ok(distance(far.pos, at(250)) < 3, 'stale: shown where last seen');
  assert.ok(distance(f.at(15_000 + 40_000).pos, at(650)) < 3);
  assert.ok(distance(f.at(15_000 + 90_000).pos, at(700)) < 3, 'no more than 45 s of guessing');

  const g = new Follow(ROUTE);
  g.update({ position: at(900), at: 0 });
  g.update({ position: at(990), at: 5_000 });
  assert.ok(distance(g.at(60_000).pos, at(1000)) < 3, 'never past the destination');

  const s = new Follow(ROUTE);
  s.update({ position: at(300), at: 0 });
  s.update({ position: at(302), at: 15_000 });
  assert.ok(distance(s.at(40_000).pos, at(302)) < 3, 'stopped at lights: no drifting');
});

test('a late correction slides instead of jumping', () => {
  const f = new Follow(ROUTE);
  f.update({ position: at(100), at: 0 });
  f.update({ position: at(250), at: 15_000 }); // 10 m/s
  // Shown at ~400 m by 30 s, but the car had slowed: the real position is 330 m.
  f.update({ position: at(330), at: 30_000 });
  const right = distance(at(0), f.at(30_000).pos);
  assert.ok(Math.abs(right - 400) < 5, 'starts from where it was shown');
  assert.ok(Math.abs(distance(at(0), f.at(32_500).pos) - (330 + 5.3 * 2.5)) < 5, 'then follows the real position');
});

test('off the route, the car is shown where it really is', () => {
  const f = new Follow(ROUTE);
  const away = [13.41, 52.503];
  f.update({ position: away, heading: 90, at: 0 });
  assert.deepEqual(f.at(5_000).pos, away);
});
