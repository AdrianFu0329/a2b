// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Following a trip by train once it's started (see "Start" on a train trip in app.js): the walk to the station, the
// ride, any change of line, and the walk at the end. On a ride the position comes from GPS when it's good, snapped to
// the track; underground (most of the Kelana Jaya Line in the city, the MRT's tunnels) it's estimated from the time
// since the train left, using the timetable's minutes between stations, and put right as soon as GPS comes back.
// "Next stop: X. Get off here." is said once, as the train leaves the stop before yours or about 90 s before it
// gets there, whichever comes first. Everything here is plain logic; app.js draws and speaks it.
//
// This works while A2B is open. With the phone locked in a pocket a web page doesn't keep running: that needs the
// native app's background location and notifications.

import { distance, bearing, cumulative } from './geo.js';

export const ARRIVE_M = 60; // this close to the station (or the destination), the walk is done
export const BOARD_MPS = 6; // faster than walking, along the line: on the train
export const NEAR_TRACK_M = 80; // a fix this close to the track counts as on it
export const GOOD_ACCURACY_M = 60; // fixes vaguer than this don't place you on the track
export const LOST_MS = 2500; // no good fix for this long: estimating
export const ALERT_BEFORE_S = 90;
export const DWELL_S = 25; // a train stands at each station for about this long
const PAST_M = 40; // past a station by this much, it's behind you

// ---------- Geometry along a track ----------
export function trackOf(coords) {
  return { coords, cum: cumulative(coords) };
}

// Where `pos` ([lng, lat]) lies along the track: metres along it and metres off it.
export function snap(track, pos) {
  const { coords, cum } = track;
  const k = Math.cos((pos[1] * Math.PI) / 180) * 111_320;
  let best = { along: 0, off: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const [a, b] = [coords[i], coords[i + 1]];
    const dx = (b[0] - a[0]) * k, dy = (b[1] - a[1]) * 110_540;
    const px = (pos[0] - a[0]) * k, py = (pos[1] - a[1]) * 110_540;
    const len2 = dx * dx + dy * dy;
    const f = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    const off = Math.hypot(px - f * dx, py - f * dy);
    if (off < best.off) best = { along: cum[i] + f * (cum[i + 1] - cum[i]), off };
  }
  return best;
}

// The point `along` metres along the track, and the way the track runs there.
export function pointAt(track, along) {
  const { coords, cum } = track;
  if (coords.length < 2) return { pos: coords[0], heading: 0 };
  let i = 1;
  while (i < cum.length - 1 && cum[i] < along) i++;
  const [a, b] = [coords[i - 1], coords[i]];
  const f = Math.max(0, Math.min(1, (along - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1)));
  return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b) };
}

// Each station's distance along the track, in order (never going backwards).
export function stationAlongs(track, stations) {
  let last = 0;
  return stations.map(([, lat, lng], i) => {
    const s = i === 0 ? 0 : snap(track, [lng, lat]).along;
    last = Math.max(last, s);
    return last;
  });
}

// ---------- Time along a ride, from the timetable ----------
// When the train leaves station k, in seconds after boarding: it stands a little at every station but the first.
const leaves = (times, k) => (k === 0 ? 0 : times[k] + Math.min(DWELL_S, ((times[k + 1] ?? times[k]) - times[k]) / 3));

// Where the train is `t` seconds after leaving the first station.
export function alongAtTime(times, alongs, t) {
  if (t <= 0) return 0;
  for (let k = 0; k < times.length - 1; k++) {
    const go = leaves(times, k), at = times[k + 1];
    if (t < go) return alongs[k];
    if (t < at) return alongs[k] + ((alongs[k + 1] - alongs[k]) * (t - go)) / ((at - go) || 1);
  }
  return alongs.at(-1);
}

// The other way: how long after leaving the first station the train is `along` metres along (for putting the
// estimate right when GPS comes back).
export function timeAtAlong(times, alongs, along) {
  for (let k = 0; k < times.length - 1; k++) {
    if (along > alongs[k + 1]) continue;
    const go = leaves(times, k), at = times[k + 1];
    const f = (along - alongs[k]) / ((alongs[k + 1] - alongs[k]) || 1);
    return go + Math.max(0, f) * (at - go);
  }
  return times.at(-1);
}

// The next station ahead (index into the ride's stations; at least 1, the first after boarding).
export function nextStop(alongs, along) {
  for (let k = 1; k < alongs.length; k++) if (alongs[k] > along + PAST_M) return k;
  return alongs.length - 1;
}

// Time to say "get off at the next stop": the train has left the stop before yours, or it's about 90 s away.
export function shouldAlert({ alongs, times, along, sinceBoard }) {
  const n = alongs.length;
  if (n < 2) return false;
  return along > alongs[n - 2] + PAST_M || (sinceBoard != null && sinceBoard >= times[n - 1] - ALERT_BEFORE_S);
}

// At your stop: close to it along the track, or (estimating) its time plus the stand has passed.
export function alighted({ alongs, times, along, sinceBoard }) {
  return along >= alongs.at(-1) - PAST_M || (sinceBoard != null && sinceBoard >= times.at(-1) + DWELL_S);
}

// On the train: moving faster than walking near the line, or the train's time has come and gone while you were at
// the station (underground, GPS rarely says).
export function boarded({ speed, off, now, departAt, atStation }) {
  return ((speed ?? 0) >= BOARD_MPS && off <= NEAR_TRACK_M) || (atStation && now >= departAt + 30_000);
}

// ---------- What to say ----------
const stationName = (s) => (s.name === 'Destination' ? 'your destination' : `${s.name} station`);
export const boardText = (leg) => `Take the ${leg.line.name} towards ${leg.towards}.`;
export const ridingText = (leg, stopsToGo) => `${stopsToGo} stop${stopsToGo > 1 ? 's' : ''} to ${leg.to.name}.`;
export const alertText = (leg) => `Next stop: ${leg.to.name}. Get off here.`;
export const changeText = (leg) => `Change to the ${leg.line.name}, towards ${leg.towards}.`;
export const walkText = (leg) => `Walk to ${stationName(leg.to)}.`;

// Which marker shows where you are: a 3D train on a ride, the chevron on foot (it shows which way you're facing),
// otherwise the vehicle from Settings
// (the chevron unless the car was picked).
export function markerFor({ mode, legMode, vehicle }) {
  if (mode === 'ride') return legMode === 'train' ? 'train' : 'chevron';
  return vehicle === 'car' ? 'car' : 'chevron';
}

// ---------- Following a whole trip ----------
// update({ now, fix }) once a second (fix: { lngLat, speed, accuracy } or null when there's none); returns what to
// show and anything to announce: { view, events: [{ type, text }] }.
export class TrainGuide {
  constructor(trip, { now = Date.now() } = {}) {
    this.trip = trip;
    this.i = 0;
    this.started = now;
    this.done = false;
    this.enterLeg(now);
  }

  get leg() {
    return this.trip.legs[this.i];
  }

  enterLeg(now) {
    const leg = this.leg;
    this.phase = leg.mode === 'walk' ? 'walk' : 'wait';
    this.along = 0;
    this.boardedAt = null;
    this.lastGood = now;
    this.alerted = false;
    if (leg.mode === 'train') {
      this.track = trackOf(leg.coords);
      this.times = leg.stations.map((s) => s[3]);
      this.alongs = stationAlongs(this.track, leg.stations);
    }
  }

  // The next leg, with what to say on reaching it.
  advance(now, events) {
    const was = this.leg;
    if (this.i >= this.trip.legs.length - 1) {
      this.done = true;
      events.push({ type: 'arrived', text: 'You have arrived.' });
      return;
    }
    this.i++;
    this.enterLeg(now);
    const leg = this.leg;
    const after = this.trip.legs[this.i + 1];
    if (leg.mode === 'train') events.push({ type: was.mode === 'train' ? 'change' : 'at-station', text: was.mode === 'train' ? changeText(leg) : boardText(leg) });
    else if (was.mode === 'train' && after?.mode === 'train') events.push({ type: 'change', text: `Get off. ${changeText(after)}` });
    else if (was.mode === 'train') events.push({ type: 'alight', text: `Get off here. ${walkText(leg)}` });
  }

  update({ now = Date.now(), fix = null } = {}) {
    const events = [];
    if (this.done) return { view: { kind: 'done' }, events };
    const leg = this.leg;
    const good = fix && (fix.accuracy ?? 0) <= GOOD_ACCURACY_M ? fix : null;

    if (leg.mode === 'walk') {
      const target = [leg.to.lng, leg.to.lat];
      const pos = good?.lngLat ?? null;
      const left = pos ? distance(pos, target) : null;
      if ((left != null && left <= ARRIVE_M) || leg.distance < ARRIVE_M / 2) {
        this.advance(now, events);
        return { view: this.done ? { kind: 'done' } : this.update({ now, fix }).view, events };
      }
      return { view: { kind: 'walk', leg, left: left ?? leg.distance, pos, heading: pos ? bearing(pos, target) : null }, events };
    }

    const n = this.alongs.length;
    if (this.phase === 'wait') {
      const s = good ? snap(this.track, good.lngLat) : null;
      const atStation = !good || distance(good.lngLat, [leg.from.lng, leg.from.lat]) <= 150;
      if (boarded({ speed: good?.speed, off: s?.off ?? Infinity, now, departAt: leg.depart, atStation })) {
        this.phase = 'ride';
        // Boarded seen from GPS part-way along: start the clock from there; otherwise from the train's time.
        this.boardedAt = s && s.along > PAST_M ? now - timeAtAlong(this.times, this.alongs, s.along) * 1000 : Math.min(now, leg.depart + 30_000);
        this.along = s ? Math.max(0, s.along) : 0;
        events.push({ type: 'boarded', text: `On the ${leg.line.name}. ${ridingText(leg, n - 1)}` });
      } else {
        return { view: { kind: 'wait', leg, pos: [leg.from.lng, leg.from.lat], heading: pointAt(this.track, 0).heading, departAt: leg.depart }, events };
      }
    }

    // Riding: from GPS when it's good and on the line, else from the timetable.
    const s = good ? snap(this.track, good.lngLat) : null;
    let estimating = false;
    if (s && s.off <= NEAR_TRACK_M * 1.5) {
      this.along = Math.max(this.along - 20, s.along); // GPS wobble can't send the train backwards far
      this.boardedAt = now - timeAtAlong(this.times, this.alongs, this.along) * 1000; // put the estimate right
      this.lastGood = now;
    } else {
      const sinceBoard = (now - this.boardedAt) / 1000;
      this.along = Math.max(this.along, alongAtTime(this.times, this.alongs, sinceBoard));
      estimating = now - this.lastGood > LOST_MS;
    }
    const sinceBoard = (now - this.boardedAt) / 1000;
    if (!this.alerted && shouldAlert({ alongs: this.alongs, times: this.times, along: this.along, sinceBoard })) {
      this.alerted = true;
      events.push({ type: 'alert', text: alertText(leg) });
    }
    if (alighted({ alongs: this.alongs, times: this.times, along: this.along, sinceBoard })) {
      this.advance(now, events);
      return { view: this.done ? { kind: 'done' } : this.update({ now, fix }).view, events };
    }
    const next = nextStop(this.alongs, this.along);
    const { pos, heading } = pointAt(this.track, this.along);
    return {
      view: {
        kind: 'ride', leg, pos, heading, estimating, alerted: this.alerted,
        next: leg.stations[next][0], stopsToGo: n - next,
        stations: leg.stations.map(([name], k) => ({ name, state: k < next ? 'past' : k === n - 1 ? 'alight' : k === next ? 'next' : 'later' })),
      },
      events,
    };
  }
}
