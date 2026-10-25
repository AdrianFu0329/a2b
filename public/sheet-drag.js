// Bottom sheets that follow the finger, like iPhone sheets. The gesture part (pointer tracking, tap vs
// drag, flick speed) is shared; each sheet decides what "moving by dy pixels" means for it.

const TAP_SLOP = 6; // px a finger may wander and still count as a tap
const FLICK = 0.35; // px/ms: faster than this, the flick's direction wins

// Where a sheet should settle when let go. `range` is the distance between its two positions; dy and v are
// how far and how fast the finger moved (down is positive). Returns true for "expanded".
export function settle(expanded, dy, v, range) {
  if (Math.abs(v) > FLICK) return v < 0;
  if (Math.abs(dy) > range / 4) return dy < 0;
  return expanded; // a short nudge springs back
}

// A little stretch past either end instead of a hard stop.
export function rubberBand(value, min, max) {
  if (value < min) return min - Math.sqrt(min - value) * 2;
  if (value > max) return max + Math.sqrt(value - max) * 2;
  return value;
}

// Wires pointer events on `el`. start(e) returns false to ignore a press; move(dy) runs on every move
// once it's a drag; end(dy, v) runs on release. Returns a check for "a drag just ended" so the click
// that follows it isn't taken as a tap.
export function sheetGesture(el, { start = () => true, move, end }) {
  let g = null;
  let draggedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !start(e)) return;
    g = { id: e.pointerId, y0: e.clientY, y: e.clientY, t: e.timeStamp, v: 0, moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y0;
    if (!g.moved) {
      if (Math.abs(dy) < TAP_SLOP) return;
      g.moved = true;
      el.setPointerCapture(e.pointerId); // keep the drag even if the finger leaves the sheet
    }
    move(dy);
    const dt = e.timeStamp - g.t;
    if (dt > 0) g.v = 0.7 * ((e.clientY - g.y) / dt) + 0.3 * g.v; // smoothed
    g.y = e.clientY;
    g.t = e.timeStamp;
  });
  const finish = (e) => {
    if (!g || e.pointerId !== g.id) return;
    const done = g;
    g = null;
    if (!done.moved) return; // a tap: the element's own click handler deals with it
    draggedAt = Date.now();
    end(e.clientY - done.y0, done.v);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // Swallow the click that some browsers fire after a drag, before buttons inside the sheet see it.
  el.addEventListener('click', (e) => {
    if (Date.now() - draggedAt < 350) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  return () => Date.now() - draggedAt < 350;
}
