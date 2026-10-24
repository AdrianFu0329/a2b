import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distance, bearing, angleDiff, decodePolyline, formatDistance, formatDuration, cumulative } from '../public/geo.js';
import { Navigator, Simulator, pointAlong, pointAtDistance, reportsAlong, spokenDistance } from '../public/nav.js';

// An L-shaped test route: 1 km north, then 500 m east. Roughly 0.009° lat = 1 km.
const A = [13.4, 52.5], B = [13.4, 52.509], C = [13.4074, 52.509];
function lRoute() {
  const coords = [];
  for (let i = 0; i <= 20; i++) coords.push([A[0], A[1] + (B[1] - A[1]) * (i / 20)]);
  for (let i = 1; i <= 10; i++) coords.push([B[0] + (C[0] - B[0]) * (i / 10), B[1]]);
  return {
    coords,
    delay: 0,
    steps: [
      { type: 'depart', instruction: 'Drive north on Main St.', alert: 'Drive north.', pre: 'Drive north on Main St.', street: 'Main St', begin: 0, end: 20, length: 1000, time: 100 },
      { type: 'right', instruction: 'Turn right onto Side St.', alert: 'Turn right onto Side St.', pre: 'Turn right onto Side St.', street: 'Side St', begin: 20, end: 30, length: 500, time: 50 },
      { type: 'arrive', instruction: 'You have arrived.', alert: 'You will arrive.', pre: 'You have arrived at your destination.', street: '', begin: 30, end: 30, length: 0, time: 0 },
    ],
  };
}

test('geo basics', () => {
  assert.ok(Math.abs(distance(A, B) - 1000.8) < 2);
  assert.ok(Math.abs(bearing(A, B)) < 0.5);
  assert.ok(Math.abs(bearing(B, C) - 90) < 0.5);
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(angleDiff(10, 350), -20);
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(234), '230 m');
  assert.equal(formatDistance(100, 'imperial'), '350 ft');
  assert.equal(formatDuration(59 * 60), '59 min');
  assert.equal(formatDuration(3 * 3600 + 5 * 60), '3 h 5 min');
  assert.equal(spokenDistance(400), '400 meters');
  assert.equal(spokenDistance(389), '400 meters');
  assert.equal(spokenDistance(130), '150 meters');
  assert.equal(spokenDistance(1000), '1.0 kilometers');
  assert.equal(spokenDistance(1609.344, 'imperial'), '1.0 miles');
});

test('decodes precision-6 polylines (Valhalla)', () => {
  // From Valhalla's docs/test data: encodes [[-76.3,40.0],[-76.299,40.001]] style coordinates.
  const pts = decodePolyline('_izlhA~rlgdF_{geC~ywl@_kwzCn`{nI', 6);
  assert.deepEqual(pts.map((p) => p.map((v) => Math.round(v * 1e3) / 1e3)), [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
});

test('snapping finds the right spot along the route', () => {
  const r = lRoute();
  const cum = cumulative(r.coords);
  const hit = pointAlong(r.coords, cum, [13.4002, 52.5045]); // ~14 m east of the line, half way up
  assert.ok(hit.dist < 20);
  assert.ok(Math.abs(hit.along - 500) < 10);
  const at = pointAtDistance(r.coords, cum, 1250);
  assert.ok(Math.abs(at.point[1] - 52.509) < 1e-6);
});

test('navigator tracks the next turn, ETA and voice cues', () => {
  const nav = new Navigator(lRoute());
  const s0 = nav.update({ position: A, heading: 0, speed: 14 });
  assert.equal(s0.next.type, 'right');
  assert.ok(Math.abs(s0.distToNext - 1000) < 5);
  assert.ok(Math.abs(s0.remainingTime - 150) < 2);
  assert.equal(s0.prompt, 'Drive north on Main St.');

  const s1 = nav.update({ position: [13.4, 52.5055], heading: 0, speed: 14 });
  assert.match(s1.prompt, /^In 400 meters, turn right onto Side St/);
  assert.ok(Math.abs(s1.remainingTime - 89) < 2);

  const s2 = nav.update({ position: [13.4, 52.5086], heading: 0, speed: 14 });
  assert.equal(s2.prompt, 'Turn right onto Side St.');
  const s3 = nav.update({ position: [13.4, 52.5087], heading: 0, speed: 14 });
  assert.equal(s3.prompt, null, 'each cue is spoken once');

  const s4 = nav.update({ position: [13.403, 52.509], heading: 90, speed: 14 });
  assert.equal(s4.next.type, 'arrive');
  assert.equal(s4.arrived, false);
  const s5 = nav.update({ position: C, heading: 90, speed: 3 });
  assert.equal(s5.arrived, true);
});

test('off-route needs several bad fixes in a row', () => {
  const nav = new Navigator(lRoute());
  nav.update({ position: A });
  const away = [13.403, 52.503]; // ~200 m east of the first leg
  assert.equal(nav.update({ position: away }).offRoute, false);
  assert.equal(nav.update({ position: away }).offRoute, false);
  assert.equal(nav.update({ position: away }).offRoute, true);
  assert.equal(nav.update({ position: [13.4, 52.503] }).offRoute, false);
});

test('reports along the route are found and ordered', () => {
  const r = lRoute();
  const found = reportsAlong(r, [
    { id: 1, lat: 52.509, lng: 13.405 }, // on the second leg
    { id: 2, lat: 52.502, lng: 13.4001 }, // on the first leg
    { id: 3, lat: 52.502, lng: 13.41 }, // far away
  ]);
  assert.deepEqual(found.map((f) => f.id), [2, 1]);
  assert.ok(Math.abs(found[0].at - 222) < 5);
});

test('simulator drives to the end', () => {
  const sim = new Simulator(lRoute(), { speedFactor: 3 });
  let f, n = 0;
  do f = sim.next(); while (!f.done && ++n < 500);
  assert.ok(f.done);
  assert.ok(distance(f.position, C) < 1);
  assert.ok(n < 100);
});
