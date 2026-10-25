import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, cumulative } from '../public/geo.js';
import { Glide } from '../public/motion.js';

// 1 km north, then 500 m east, like the nav tests.
const A = [13.4, 52.5], B = [13.4, 52.509], C = [13.4074, 52.509];
const coords = [];
for (let i = 0; i <= 20; i++) coords.push([A[0], A[1] + (B[1] - A[1]) * (i / 20)]);
for (let i = 1; i <= 10; i++) coords.push([B[0] + (C[0] - B[0]) * (i / 10), B[1]]);
const path = { coords, cum: cumulative(coords) };

test('first fix is shown straight away', () => {
  const g = new Glide();
  g.set({ pos: A, heading: 0 }, 0);
  assert.deepEqual(g.at(0).pos, A);
  assert.ok(g.done(1));
});

test('slides between fixes over the time between them, never jumping', () => {
  const g = new Glide();
  const p1 = [13.4, 52.5009]; // about 100 m north
  g.set({ pos: A, heading: 0 }, 0);
  g.set({ pos: p1, heading: 0 }, 1000);
  const mid = g.at(1500).pos;
  assert.ok(Math.abs(distance(A, mid) - 50) < 2);
  assert.ok(!g.done(1500));
  assert.deepEqual(g.at(2000).pos, p1);
  assert.ok(g.done(2000));

  // A new fix halfway through starts from where the car is drawn, not from the last fix.
  g.set({ pos: [13.4, 52.5018], heading: 0 }, 2500);
  g.set({ pos: [13.4, 52.5027], heading: 0 }, 3000);
  const shownAtSet = g.at(3000).pos;
  assert.ok(distance(shownAtSet, [13.4, 52.5018]) < 60);
});

test('turns the short way round', () => {
  const g = new Glide();
  g.set({ pos: A, heading: 350 }, 0);
  g.set({ pos: A, heading: 10 }, 1000);
  assert.ok(Math.abs(g.at(1500).heading) < 1e-9 || Math.abs(g.at(1500).heading - 360) < 1e-9);
});

test('follows the road round a corner instead of cutting it', () => {
  const g = new Glide();
  const before = { pos: coords[19], along: path.cum[19], path, heading: 0 }; // 50 m before the corner
  const after = { pos: coords[21], along: path.cum[21], path, heading: 90 }; // 50 m after it
  g.set(before, 0);
  g.set(after, 1000);
  const mid = g.at(1500).pos;
  assert.ok(distance(mid, B) < 1, 'halfway is the corner itself');
});

test('jumps when the next fix is far away', () => {
  const g = new Glide();
  g.set({ pos: A, heading: 0 }, 0);
  g.set({ pos: C, heading: 0 }, 1000);
  assert.deepEqual(g.at(1000).pos, C);
});
