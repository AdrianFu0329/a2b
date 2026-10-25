// Shared drives with few requests: when the driver's phone sends an update, how often a viewer asks for one,
// and how the viewer's map keeps the car moving between updates. Pure logic (no DOM), so it runs in tests.

import { distance, bearing, cumulative } from './geo.js';
import { pointAlong, pointAtDistance } from './nav.js';

// ---------- Driver: send only when it matters ----------
export const SEND = {
  MOVE_M: 150, // moved this far since the last update
  ETA_S: 60, // arrival time changed by this much
  MAX_MS: 30_000, // otherwise at least this often, so viewers know the drive is still on
  MIN_MS: 4_000, // and never more often than this (fast highway driving)
};

// last: { at, pos, eta, count } from the previous send, or null. Returns why it should send now, or null.
export function shouldSend(last, { now, pos, eta }) {
  if (!last) return 'first';
  const gap = now - last.at;
  if (gap < SEND.MIN_MS) return null;
  // A quick second update lets viewers measure the real speed instead of guessing it from the ETA.
  if (last.count === 1) return 'second';
  if (gap >= SEND.MAX_MS) return 'heartbeat';
  if (!last.pos || !pos || distance(last.pos, pos) >= SEND.MOVE_M) return 'moved';
  if (last.eta && eta && Math.abs(eta - last.eta) >= SEND.ETA_S * 1000) return 'eta';
  return null;
}

// ---------- Viewer: ask often while the car moves, back off while it doesn't ----------
export const POLL = { MOVING_MS: 10_000, STILL_MS: [30_000, 60_000] };

// stillPolls: how many polls in a row brought no new position.
export function nextPollDelay(stillPolls) {
  if (stillPolls <= 0) return POLL.MOVING_MS;
  return POLL.STILL_MS[Math.min(stillPolls, POLL.STILL_MS.length) - 1];
}

// ---------- Viewer: keep the car moving between updates ----------
const MAX_GUESS_S = 45; // never guess further ahead than this from the last real position
const MAX_ETA_GUESS_S = 15; // less when the pace is only inferred from the ETA (the car may be standing still)
const STALE_MS = 120_000; // no news for this long: stop guessing, show the car where it was last seen
const MAX_SPEED = 40; // m/s, ~145 km/h: ignore anything faster as noise
const STOPPED = 0.8; // m/s: slower than this counts as standing still
const ON_ROUTE_M = 60;
const BLEND_MS = 2000; // a correction (car shown ahead of or behind the real position) fades out over this

export class Follow {
  constructor(route) {
    this.coords = route;
    this.cum = cumulative(route);
    this.total = this.cum[this.cum.length - 1] || 0;
    this.anchor = null; // { along, at, speed } from the newest real position
    this.offset = 0; // shown minus real at the moment the newest position arrived
    this.offsetAt = 0;
  }

  // A real position from the driver. `at` is when it was recorded, on this device's clock.
  update({ position, eta, at, heading = null }) {
    const hit = this.coords.length > 1 ? pointAlong(this.coords, this.cum, position) : null;
    const onRoute = hit && hit.dist <= ON_ROUTE_M;
    const prev = this.anchor;
    const shown = prev && onRoute ? this.alongAt(at) : null;
    let speed = 0;
    if (onRoute) {
      // Prefer how fast the car really moved between the last two positions; else the pace the ETA implies.
      if (prev?.onRoute && at - prev.at >= 1000) speed = (hit.along - prev.along) / ((at - prev.at) / 1000);
      else if (eta && eta > at) speed = (this.total - hit.along) / ((eta - at) / 1000);
      if (!(speed >= STOPPED)) speed = 0; // includes NaN and moving backwards
      else if (speed > MAX_SPEED) speed = MAX_SPEED;
    }
    const measured = Boolean(onRoute && prev?.onRoute && at - prev.at >= 1000);
    this.anchor = { along: onRoute ? hit.along : 0, at, speed, onRoute, position, heading, measured };
    this.offset = shown == null ? 0 : shown - this.anchor.along;
    this.offsetAt = at;
  }

  alongAt(now) {
    const a = this.anchor;
    if (!a) return 0;
    const age = now - a.at;
    const limit = a.measured ? MAX_GUESS_S : MAX_ETA_GUESS_S;
    const guess = age > STALE_MS ? 0 : a.speed * Math.min(Math.max(age, 0) / 1000, limit);
    const fade = Math.max(0, 1 - (now - this.offsetAt) / BLEND_MS);
    return Math.min(this.total, Math.max(0, a.along + guess + this.offset * fade));
  }

  // Where to draw the car now: { pos, heading, stale }.
  at(now) {
    const a = this.anchor;
    if (!a) return null;
    const stale = now - a.at > STALE_MS;
    if (!a.onRoute) return { pos: a.position, heading: a.heading ?? 0, stale };
    const along = this.alongAt(now);
    const here = pointAtDistance(this.coords, this.cum, along);
    const ahead = pointAtDistance(this.coords, this.cum, Math.min(this.total, along + 10));
    const heading = ahead.point === here.point ? a.heading ?? 0 : bearing(here.point, ahead.point);
    return { pos: here.point, heading, stale };
  }
}

