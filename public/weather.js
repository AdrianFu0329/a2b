// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The weather on a drive: which points of a route to ask about (each at the time the driver will pass it), and
// what the answer means for them, in a line or two for the route sheet: what it's like on arrival, rain or storms
// on the way, MET Malaysia's warnings, and what to bring. The forecasts themselves come from /api/weather.

import { atDistance, cumulative } from './geo.js';

const MAX_POINTS = 8; // the server's limit, destination included
const MIN_STEP_M = 15_000; // a forecast square is ~11 km across; closer points would ask the same one twice

// Points along the route at the time the driver gets there, ending with the destination on arrival.
// route: { coords, cum, distance, duration }; departAt: ms. Returns [{ lng, lat, at, along }].
export function weatherPoints(route, departAt = Date.now()) {
  if (!route.coords?.length) return [];
  const cum = route.cum ?? cumulative(route.coords);
  const total = cum.at(-1);
  if (!total) return [];
  const step = Math.max(MIN_STEP_M, total / (MAX_POINTS - 1));
  const at = (d) => Math.round(departAt + route.duration * 1000 * (d / total));
  const out = [];
  for (let d = step / 2; d < total - step / 2; d += step) {
    const [lng, lat] = atDistance(route.coords, cum, d);
    out.push({ lng, lat, at: at(d), along: d });
  }
  const [lng, lat] = route.coords.at(-1);
  out.push({ lng, lat, at: at(total), along: total });
  return out.slice(-MAX_POINTS);
}

export const weatherQuery = (points) => `pts=${points.map((p) => `${p.lng.toFixed(3)},${p.lat.toFixed(3)},${Math.round(p.at / 1000)}`).join(';')}`;

const WORSE = ['rain', 'heavy-rain', 'storm'];
const wet = (f) => Boolean(f && WORSE.includes(f.sky) && (f.chance ?? 1) >= 0.3);
const severity = (f) => (wet(f) ? WORSE.indexOf(f.sky) + 1 : 0);
const temps = (f) => (f.temp != null ? `${Math.round(f.temp)}°C` : f.low != null && f.high != null ? `${f.low}–${f.high}°C` : '');
// Forecasts are often wrong about exactly where and when it rains, so A2B only ever says what's possible.
const WET_WORDS = { rain: 'rain', 'heavy-rain': 'heavy rain', storm: 'thunderstorms' };
const DRY_WORDS = { clear: 'probably dry', cloudy: 'probably dry and cloudy', haze: 'possibly hazy', windy: 'possibly windy' };
const NOW_MS = 20 * 60_000; // a point this close in time is "now"
// Sticky: warm and damp enough that sweat doesn't dry. Only WeatherKit gives humidity; MET Malaysia doesn't.
const humid = (f) => Boolean(f && (f.humidity ?? 0) >= 0.7 && (f.temp ?? 0) >= 27);
const RAIN_TIP = 'Bring an umbrella or a raincoat, and maybe avoid light-coloured clothes.';

// What to say about a drive. answer: /api/weather's reply; points: what was asked; clock(ms) -> "5:40 PM".
// Returns null when there's nothing to say, else { sky, arrival, ahead, warnings, tips, sources }.
export function describeTrip(answer, points, clock, now = Date.now()) {
  const fs = answer?.points ?? [];
  const destF = fs.at(-1);
  const destP = points.at(-1);
  const arrival = destF
    ? `${wet(destF) ? `Possible ${WET_WORDS[destF.sky]} when you arrive` : `When you arrive: ${DRY_WORDS[destF.sky] ?? 'probably dry'}`}, around ${clock(destP.at)}${temps(destF) ? ` (${temps(destF)})` : ''}`
    : '';

  // The worst weather on the way there (not counting the destination), where it's first met.
  let ahead = null;
  fs.slice(0, -1).forEach((f, i) => {
    if (severity(f) > (ahead ? severity(ahead.f) : 0)) ahead = { f, p: points[i] };
  });
  let aheadText = '';
  if (ahead) {
    const near = ahead.f.place ? ` near ${ahead.f.place}` : '';
    const what = ahead.f.sky === 'storm' ? 'There may be thunderstorms' : `It may ${ahead.f.sky === 'heavy-rain' ? 'rain heavily' : 'rain'}`;
    aheadText = ahead.p.at - now <= NOW_MS
      ? `${ahead.f.sky === 'storm' ? 'There may be thunderstorms' : 'It may be raining'}${near} right now`
      : `${what} on the way${near}, around ${clock(ahead.p.at)}`;
  }

  const tips = [];
  if (wet(destF) || ahead) tips.push(RAIN_TIP);
  const hot = destF && ((destF.feels ?? destF.temp ?? -99) >= 36 || (destF.high ?? -99) >= 35);
  const cool = destF && ((destF.feels ?? destF.temp ?? 99) <= 20 || (destF.high ?? 99) <= 22);
  if (hot) tips.push('It may be hot there: wear something light and bring water.');
  if (cool) tips.push('It may be cool there: bring a jacket.');
  else if (humid(destF)) tips.push("It may be humid there: skip long sleeves and jackets, and wear something that won't show sweat marks.");
  if (ahead && severity(ahead.f) >= 2) tips.push('If it pours, slow down and turn your headlights on.');

  const warnings = (answer?.warnings ?? []).map((w) => `${w.title}: ${w.text}`);
  if (!arrival && !aheadText && !warnings.length) return null;
  const sky = [destF, ...(ahead ? [ahead.f] : [])].reduce((worst, f) => (severity(f) > severity(worst) ? f : worst), destF)?.sky ?? 'clear';
  return { sky: warnings.length && !wet({ sky }) ? 'storm' : sky, arrival, ahead: aheadText, warnings, tips, sources: answer?.sources ?? [] };
}

// While driving: the next wet stretch within `withinM` ahead, for one spoken heads-up. along: metres driven.
export function wetAhead(answer, points, along, withinM = 8000) {
  const fs = answer?.points ?? [];
  for (let i = 0; i < points.length; i++) {
    const ahead = points[i].along - along;
    if (ahead > 0 && ahead <= withinM && wet(fs[i]) && (fs[i].chance ?? 1) >= 0.5) return { i, ahead, sky: fs[i].sky, place: fs[i].place };
  }
  return null;
}

export function spokenWeather({ sky, place }) {
  const near = place ? ` near ${place}` : '';
  return `${sky === 'storm' ? 'There may be thunderstorms' : sky === 'heavy-rain' ? 'It may rain heavily' : 'It may rain'} ahead${near}. Drive carefully.`;
}
