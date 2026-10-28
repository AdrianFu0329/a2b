// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherAlong, readMetText, metPeriod, warningsFor, nearestTown, skyFromCondition, cellOf } from '../src/lib/weather.js';
import { weatherPoints, weatherQuery, describeTrip, wetAhead, spokenWeather } from '../public/weather.js';
import { cumulative } from '../public/geo.js';

const KL = [101.6953, 3.1478];
const SEREMBAN = [101.94, 2.7258];
const MYT = (s) => Date.parse(`${s}+08:00`);
const NOW = MYT('2026-10-28T14:00:00');

// A stand-in for Cloudflare's edge cache.
function fakeCache() {
  const m = new Map();
  return {
    match: async (req) => m.get(req.url)?.clone(),
    put: async (req, res) => void m.set(req.url, res),
  };
}

function withFetch(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const klTown = nearestTown(KL);
const metRows = (forecast) => [
  { location: { location_id: klTown.id, location_name: klTown.name }, date: '2026-10-28', morning_forecast: 'Tiada Hujan', afternoon_forecast: forecast, night_forecast: 'Tiada hujan', summary_forecast: forecast, summary_when: 'Petang', min_temp: 24, max_temp: 33 },
];
const WARNING = {
  warning_issue: { issued: '2026-10-28T12:00:00', title_en: 'Thunderstorms Warning' },
  valid_from: '2026-10-28T12:00:00',
  valid_to: '2026-10-28T17:00:00',
  text_en: '1) Thunderstorms, heavy rain and strong winds are expected over the states of Sarawak: Miri until 3:00 PM. 2) Thunderstorms, heavy rain and strong winds are expected over the state of Selangor (Gombak and Petaling) and W.P. Kuala Lumpur until 5:00 PM.',
};
const SEA = { ...WARNING, warning_issue: { title_en: 'Strong Winds and Rough Seas Warning' }, text_en: 'Rough seas over the waters of Selangor.' };

test('MET Malaysia wording is read into rain, storms and dry spells', () => {
  assert.deepEqual(readMetText('Tiada Hujan'), { sky: 'clear', chance: 0.1, text: 'No rain' });
  assert.equal(readMetText('Ribut petir di beberapa tempat').text, 'Thunderstorms in places');
  assert.equal(readMetText('Ribut petir di beberapa tempat').sky, 'storm');
  assert.equal(readMetText('Hujan di kebanyakan tempat di kawasan pedalaman').text, 'Rain in most places inland');
  assert.equal(readMetText('Hujan menyeluruh').chance, 0.8);
  assert.equal(readMetText('Berangin').sky, 'windy');
  assert.equal(readMetText('???'), null);
});

test("MET Malaysia's morning, afternoon and night are in Malaysia time; small hours belong to the night before", () => {
  assert.deepEqual(metPeriod(MYT('2026-10-28T08:00:00')), { date: '2026-10-28', part: 'morning' });
  assert.deepEqual(metPeriod(MYT('2026-10-28T15:30:00')), { date: '2026-10-28', part: 'afternoon' });
  assert.deepEqual(metPeriod(MYT('2026-10-28T22:00:00')), { date: '2026-10-28', part: 'night' });
  assert.deepEqual(metPeriod(MYT('2026-10-29T02:00:00')), { date: '2026-10-28', part: 'night' });
});

test('WeatherKit conditions map to what a driver cares about', () => {
  assert.equal(skyFromCondition('ScatteredThunderstorms'), 'storm');
  assert.equal(skyFromCondition('HeavyRain'), 'heavy-rain');
  assert.equal(skyFromCondition('Drizzle'), 'rain');
  assert.equal(skyFromCondition('MostlyCloudy', 10), 'heavy-rain', 'heavy rain by the amount');
  assert.equal(skyFromCondition('MostlyClear'), 'clear');
  assert.deepEqual(cellOf([101.6953, 3.1478]), [3.1, 101.7]);
});

test('every MET Malaysia place has a position in Malaysia, and the nearest one is found', () => {
  assert.ok(klTown, 'a MET town near Kuala Lumpur');
  assert.match(klTown.state, /kuala lumpur|selangor/i);
  assert.equal(nearestTown([110, 20]), null, 'nothing out at sea');
});

test('warnings are cut down to the states on the route, and sea warnings are left out', () => {
  const ws = warningsFor([WARNING, SEA], ['Federal Territory of Kuala Lumpur'], NOW, NOW + 3600_000);
  assert.equal(ws.length, 1);
  assert.match(ws[0].text, /Selangor/);
  assert.doesNotMatch(ws[0].text, /Miri/);
  assert.equal(warningsFor([WARNING], ['Johor'], NOW, NOW + 3600_000).length, 0, 'not on the route');
  assert.equal(warningsFor([WARNING], ['Selangor'], NOW + 4 * 3600_000, NOW + 5 * 3600_000).length, 0, 'over by then');
});

test('without a WeatherKit key, the forecast comes from MET Malaysia, fetched once and cached', async () => {
  const f = withFetch((url) => {
    if (url.includes('/weather/forecast')) return Response.json(metRows('Ribut petir di beberapa tempat'));
    if (url.includes('/weather/warning')) return Response.json([WARNING, SEA]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const cache = fakeCache();
    const pts = [{ lng: KL[0], lat: KL[1], at: NOW + 1800_000 }, { lng: KL[0], lat: KL[1], at: NOW + 3600_000 }];
    const a = await weatherAlong({}, pts, { now: NOW, cache });
    assert.equal(a.points[0].sky, 'storm');
    assert.equal(a.points[1].source, 'met');
    assert.equal(a.points[1].high, 33);
    assert.equal(a.warnings.length, 1);
    assert.deepEqual(a.sources.map((s) => s.name), ['MET Malaysia']);
    await weatherAlong({}, pts, { now: NOW, cache });
    assert.equal(f.calls.length, 2, 'forecast and warnings once each, then from the cache');
    const far = await weatherAlong({}, [{ lng: 110, lat: 20, at: NOW }], { now: NOW, cache });
    assert.deepEqual(far.points, [null], 'no forecast far from any MET place');
  } finally {
    f.restore();
  }
});

test('with a WeatherKit key, each square is fetched once with a signed token; MET Malaysia fills in when it fails', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const env = { WEATHERKIT_TEAM_ID: 'TEAM123', WEATHERKIT_SERVICE_ID: 'my.a2b.weather', WEATHERKIT_KEY_ID: 'KEY456', WEATHERKIT_KEY: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----` };
  let kitDown = false;
  const f = withFetch((url) => {
    if (url.includes('weatherkit.apple.com')) {
      if (kitDown) return new Response('nope', { status: 500 });
      const start = Date.parse('2026-10-28T06:00:00Z');
      return Response.json({ forecastHourly: { hours: [0, 1, 2].map((h) => ({ forecastStart: new Date(start + h * 3600_000).toISOString(), conditionCode: h === 1 ? 'HeavyRain' : 'Cloudy', temperature: 30, temperatureApparent: 36, precipitationChance: h === 1 ? 0.8 : 0.1, precipitationIntensity: h === 1 ? 9 : 0 })) } });
    }
    if (url.includes('/weather/forecast')) return Response.json(metRows('Hujan di beberapa tempat'));
    if (url.includes('/weather/warning')) return Response.json([]);
    throw new Error(`unexpected ${url}`);
  });
  try {
    const pts = [{ lng: KL[0], lat: KL[1], at: NOW }, { lng: KL[0] - 0.01, lat: KL[1] - 0.01, at: NOW + 3600_000 }];
    const a = await weatherAlong(env, pts, { now: NOW, cache: fakeCache() });
    const kit = f.calls.filter((c) => c.url.includes('weatherkit'));
    assert.equal(kit.length, 1, 'both points are in one square');
    assert.match(kit[0].url, /\/en\/3\.1\/101\.7\?dataSets=forecastHourly/);
    assert.deepEqual([a.points[0].sky, a.points[1].sky], ['cloudy', 'heavy-rain']);
    assert.equal(a.points[1].feels, 36);
    assert.deepEqual(a.sources.map((s) => s.name), [' Weather']);

    const [head, body, sig] = kit[0].init.headers.authorization.replace('Bearer ', '').split('.');
    const read = (s) => JSON.parse(Buffer.from(s, 'base64url'));
    assert.deepEqual(read(head), { alg: 'ES256', kid: 'KEY456', id: 'TEAM123.my.a2b.weather' });
    assert.equal(read(body).iss, 'TEAM123');
    assert.equal(read(body).sub, 'my.a2b.weather');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(sig, 'base64url'), new TextEncoder().encode(`${head}.${body}`));
    assert.ok(ok, 'the token is signed with the key');

    kitDown = true;
    const b = await weatherAlong(env, [{ lng: SEREMBAN[0], lat: SEREMBAN[1], at: NOW }], { now: NOW, cache: fakeCache() });
    assert.equal(b.points[0]?.source ?? 'met', 'met', 'MET Malaysia, not an error');
  } finally {
    f.restore();
  }
});

// ---------- The app's side ----------
const line = Array.from({ length: 101 }, (_, i) => [101.69 + i * 0.006, 3.15 - i * 0.0042]); // ~80 km to the south-east
const route = { coords: line, cum: cumulative(line), duration: 3600 };
const clock = (at) => new Date(at + 8 * 3600_000).toISOString().slice(11, 16);

test('a route is asked about every ~15 km at the time the driver passes, ending at the destination on arrival', () => {
  const pts = weatherPoints(route, NOW);
  assert.ok(pts.length >= 5 && pts.length <= 8, `${pts.length} points`);
  assert.deepEqual([pts.at(-1).lng, pts.at(-1).lat], line.at(-1));
  assert.equal(pts.at(-1).at, NOW + 3600_000);
  assert.ok(pts.every((p, i) => !i || (p.at > pts[i - 1].at && p.along > pts[i - 1].along)));
  assert.match(weatherQuery(pts.slice(0, 1)), /^pts=101\.\d{3},3\.\d{3},\d{10}$/);
  assert.deepEqual(weatherPoints({ coords: [line[0], line[0]], duration: 0 }), [], 'nowhere to go');
});

test('the route sheet says what it is like on arrival, the worst on the way, and what to bring', () => {
  const pts = weatherPoints(route, NOW);
  const dry = { sky: 'clear', chance: 0.1, text: 'No rain', low: 24, high: 33, source: 'met' };
  const points = pts.map(() => dry);
  points[1] = { sky: 'storm', chance: 0.4, text: 'Thunderstorms in places', place: 'Kajang', source: 'met' };
  points[points.length - 1] = { sky: 'rain', chance: 0.7, text: 'Rain in most places', low: 24, high: 32, place: 'Seremban', source: 'met' };
  const trip = describeTrip({ points, warnings: [], sources: [{ name: 'MET Malaysia' }] }, pts, clock);
  assert.equal(trip.arrival, `On arrival at ${clock(pts.at(-1).at)}: Rain in most places, 24–32°C`);
  assert.equal(trip.ahead, `Thunderstorms on the way near Kajang, around ${clock(pts[1].at)}`);
  assert.deepEqual(trip.tips, ['Bring an umbrella.', 'Slow down and turn your headlights on in heavy rain.']);
  assert.equal(trip.sky, 'storm');

  const sunny = describeTrip({ points: pts.map(() => ({ sky: 'clear', chance: 0.05, text: 'Clear', temp: 34, feels: 39, source: 'weatherkit' })), warnings: [] }, pts, clock);
  assert.equal(sunny.ahead, '');
  assert.deepEqual(sunny.tips, ['Hot there: wear something light and bring water.']);
  const highlands = describeTrip({ points: [{ sky: 'cloudy', text: 'Cloudy', low: 14, high: 21, source: 'met' }], warnings: [] }, pts.slice(-1), clock);
  assert.deepEqual(highlands.tips, ['Cool there: bring a jacket.']);
  assert.equal(describeTrip({ points: [null], warnings: [] }, pts.slice(-1), clock), null, 'nothing known, nothing shown');
});

test('while driving, a likely wet stretch a few km ahead is announced', () => {
  const pts = weatherPoints(route, NOW);
  const points = pts.map(() => null);
  points[2] = { sky: 'heavy-rain', chance: 0.8, place: 'Kajang' };
  const answer = { points };
  assert.equal(wetAhead(answer, pts, 0), null, 'still far off');
  const near = wetAhead(answer, pts, pts[2].along - 5000);
  assert.equal(near.i, 2);
  assert.equal(spokenWeather(near), 'Heavy rain expected ahead near Kajang. Drive carefully.');
  assert.equal(wetAhead(answer, pts, pts[2].along + 100), null, 'already passed');
  points[2] = { sky: 'storm', chance: 0.4 };
  assert.equal(wetAhead(answer, pts, pts[2].along - 5000), null, 'too unsure to say out loud');
});
