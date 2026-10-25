// Smooth car movement between GPS fixes. Fixes arrive about once a second; drawing the car only at
// each fix makes it jump. A Glide moves the shown position from where the car is drawn now to the
// newest fix over roughly the time until the next one, along the road when the car is on a route.
// Pure logic (no DOM), so it runs in tests.

import { distance, angleDiff, interpolate } from './geo.js';
import { pointAtDistance } from './nav.js';

const MIN_MS = 200;
const MAX_MS = 1200;
const SNAP_M = 250; // further than this between fixes: jump instead of sliding across the map
const ON_PATH_M = 8;

export class Glide {
  constructor() {
    this.from = null;
    this.to = null;
    this.start = 0;
    this.duration = 1;
    this.lastSet = 0;
  }

  // pose: { pos: [lng, lat], heading, along?, path? } where path is { coords, cum } and along is metres along it.
  set(pose, now) {
    const gap = this.lastSet ? now - this.lastSet : 0;
    this.lastSet = now;
    const shown = this.to ? this.at(now) : null;
    if (!shown || distance(shown.pos, pose.pos) > SNAP_M) {
      this.from = this.to = { ...pose, heading: pose.heading ?? 0 };
      this.duration = 1;
      this.start = now;
      return;
    }
    this.from = shown;
    this.to = { ...pose, heading: pose.heading ?? shown.heading };
    this.start = now;
    this.duration = Math.min(MAX_MS, Math.max(MIN_MS, gap || 1000));
  }

  done(now) {
    return !this.to || now - this.start >= this.duration;
  }

  at(now) {
    if (!this.to) return null;
    const { from, to } = this;
    const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    const heading = from.heading + angleDiff(from.heading, to.heading) * t;
    if (t >= 1) return { ...to, heading: norm(to.heading) };
    if (alongPath(from, to)) {
      const along = from.along + (to.along - from.along) * t;
      return { pos: pointAtDistance(to.path.coords, to.path.cum, along).point, heading: norm(heading), along, path: to.path };
    }
    return { pos: interpolate(from.pos, to.pos, t), heading: norm(heading) };
  }
}

// Follow the road (not a straight chord) when both ends sit on the same route, going forwards.
function alongPath(from, to) {
  if (!to.path || from.path !== to.path || from.along == null || to.along == null) return false;
  if (to.along < from.along) return false;
  const { coords, cum } = to.path;
  return distance(pointAtDistance(coords, cum, from.along).point, from.pos) < ON_PATH_M
    && distance(pointAtDistance(coords, cum, to.along).point, to.pos) < ON_PATH_M;
}

const norm = (h) => ((h % 360) + 360) % 360;
