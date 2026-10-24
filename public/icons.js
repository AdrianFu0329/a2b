// SVG for turn arrows, the car, and map pins.

const ANGLES = {
  straight: 0, depart: 0, slight_right: 45, right: 90, sharp_right: 135, slight_left: -45, left: -90, sharp_left: -135,
  merge: 0, merge_right: 30, merge_left: -30, roundabout_exit: 45,
};

export function turnIcon(type, color = '#fff') {
  const s = `stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  if (type?.startsWith('arrive') || type === 'stop') {
    return `<svg viewBox="0 0 48 48"><path d="M14 42V8m0 0h20l-4 8 4 8H14" ${s}/></svg>`;
  }
  if (type === 'uturn_left' || type === 'uturn_right') {
    const flip = type === 'uturn_right' ? ' transform="matrix(-1 0 0 1 48 0)"' : '';
    return `<svg viewBox="0 0 48 48"><g${flip}><path d="M30 42V20a8 8 0 0 0-16 0v12" ${s}/><path d="m7 26 7 8 7-8" ${s}/></g></svg>`;
  }
  if (type === 'roundabout') {
    return `<svg viewBox="0 0 48 48"><circle cx="24" cy="20" r="9" ${s}/><path d="M24 44V29M30.4 13.6 38 6m0 0h-8m8 0v8" ${s}/></svg>`;
  }
  if (type === 'ferry') {
    return `<svg viewBox="0 0 48 48"><path d="M6 32h36l-5 8H11Zm8 0V20h20v12M24 20v-8" ${s}/></svg>`;
  }
  const a = ((ANGLES[type] ?? 0) * Math.PI) / 180;
  const bx = 24, by = 24;
  const ex = bx + 15 * Math.sin(a), ey = by - 15 * Math.cos(a);
  // arrow head: two short lines back from the tip at ±40°
  const back = (off) => {
    const b = a + Math.PI + off;
    return `${(ex + 9 * Math.sin(b)).toFixed(1)} ${(ey - 9 * Math.cos(b)).toFixed(1)}`;
  };
  const stemTop = Math.abs(a) > 1.8 ? 30 : 24;
  return `<svg viewBox="0 0 48 48"><path d="M${bx} 44V${stemTop}L${ex.toFixed(1)} ${ey.toFixed(1)}" ${s}/><path d="M${back(0.7)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${back(-0.7)}" ${s}/></svg>`;
}

export const CAR = `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="currentColor" fill-opacity=".2"/><path d="M24 7 37 38l-13-7-13 7Z" fill="currentColor" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>`;

export const DEST_PIN = `<svg viewBox="0 0 36 46"><path d="M18 44s15-15.4 15-26A15 15 0 0 0 3 18c0 10.6 15 26 15 26Z" fill="#e5484d" stroke="#fff" stroke-width="2.5"/><circle cx="18" cy="18" r="5.5" fill="#fff"/></svg>`;

export const DROP_PIN = `<svg viewBox="0 0 36 46"><path d="M18 44s15-15.4 15-26A15 15 0 0 0 3 18c0 10.6 15 26 15 26Z" fill="#a8306d" stroke="#fff" stroke-width="2.5"/><circle cx="18" cy="18" r="5.5" fill="#fff"/></svg>`;

export const PLACE_ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 22s7-7.2 7-12.5a7 7 0 0 0-14 0C5 14.8 12 22 12 22Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="9.5" r="2.5" fill="currentColor"/></svg>',
  recent: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.7l-5.4 2.9 1.1-6-4.5-4.2 6.1-.8Z" fill="#f5b300"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
};

export function soundIcon(on) {
  return on
    ? '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4Z" fill="currentColor"/><path d="m16 9 5 6m0-6-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}
