// Toll plazas along a route. Valhalla says where the route passes a toll booth; what the booth is called,
// what a car pays and how you can pay come from the booth's OpenStreetMap tags. Those are looked up once per
// plaza and kept in D1, so routes don't wait on OpenStreetMap and its API isn't asked twice for the same booth.
// OpenStreetMap doesn't record which lanes take which payment, so that isn't available.

import { distance } from '../../public/geo.js';

const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';
const UA = 'a2b-navigation/0.1 (+https://github.com/thaqif0709/a2b)';
const BOX = 0.0015; // degrees around the booth to search, about 170 m
const KEEP_MS = 30 * 86400_000;
const KEEP_EMPTY_MS = 7 * 86400_000; // nothing mapped yet: look again sooner
const LOOKUP_MS = 3000;
const SAME_PLAZA_M = 300; // booth points closer than this along a route are one plaza

// Ways to pay, from OpenStreetMap payment:* tags (Malaysian systems first).
const PAYMENTS = [
  [/^payment:(touchngo|touch_n_go)$/, "Touch 'n Go"],
  [/^payment:(touchngo_rfid|rfid)$/, 'RFID'],
  [/^payment:(touchngo_smarttag|smarttag)$/, 'SmartTAG'],
  [/^payment:(cash|coins|notes)$/, 'Cash'],
  [/^payment:(credit_cards|debit_cards|contactless|visa|mastercard)$/, 'Card'],
];

// Shape indexes of the booths a route passes, from trace_attributes edges; neighbouring booths are one plaza.
export function tollIndexes(edges, coords, offset = 0) {
  const out = [];
  for (const e of edges) {
    if (e.end_node?.type !== 'toll_booth' || !Number.isInteger(e.end_shape_index)) continue;
    const i = e.end_shape_index + offset;
    if (out.length && coords && coords[i] && distance(coords[out.at(-1)], coords[i]) < SAME_PLAZA_M) continue;
    out.push(i);
  }
  return out;
}

const keyOf = ([lng, lat]) => `${lat.toFixed(3)},${lng.toFixed(3)}`;

// { name, price: { amount, currency } | null, pay: [...] } for each point (null when nothing is known).
export async function plazaDetails(db, points) {
  const keys = [...new Set(points.map(keyOf))];
  const known = new Map();
  if (keys.length) {
    const rows = await db.prepare(`SELECT key, info, fetched_at FROM toll_plazas WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
    for (const r of rows.results ?? []) {
      const info = JSON.parse(r.info);
      if (Date.now() - r.fetched_at < (info.name || info.price ? KEEP_MS : KEEP_EMPTY_MS)) known.set(r.key, info);
    }
  }
  const missing = points.filter((p) => !known.has(keyOf(p))).filter((p, i, a) => a.findIndex((q) => keyOf(q) === keyOf(p)) === i);
  await Promise.all(
    missing.slice(0, 8).map(async (p) => {
      const info = await lookUp(p).catch(() => null);
      if (!info) return; // OpenStreetMap slow or down: try again next time
      known.set(keyOf(p), info);
      await db.prepare('INSERT OR REPLACE INTO toll_plazas (key, info, fetched_at) VALUES (?, ?, ?)').bind(keyOf(p), JSON.stringify(info), Date.now()).run();
    }),
  );
  return points.map((p) => {
    const info = known.get(keyOf(p));
    return info && (info.name || info.price || info.pay?.length) ? info : null;
  });
}

async function lookUp([lng, lat]) {
  const res = await fetch(`${OSM_API}?bbox=${lng - BOX},${lat - BOX},${lng + BOX},${lat + BOX}`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(LOOKUP_MS),
  });
  if (!res.ok) return null;
  return describeBooth(nearestBooth(await res.text(), [lng, lat]));
}

// The toll booth node closest to `at` in an OpenStreetMap XML response, as its tags.
export function nearestBooth(xml, at) {
  let best = null, bestD = Infinity;
  for (const m of xml.matchAll(/<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g)) {
    if (!/k="barrier" v="toll_booth"/.test(m[2] || '')) continue;
    const lat = Number(/\blat="([-\d.]+)"/.exec(m[1])?.[1]), lng = Number(/\blon="([-\d.]+)"/.exec(m[1])?.[1]);
    const d = distance(at, [lng, lat]);
    if (d < bestD) [best, bestD] = [m[2], d];
  }
  if (best == null) return null;
  return Object.fromEntries([...best.matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((t) => [t[1], unescapeXml(t[2])]));
}

export function describeBooth(tags) {
  if (!tags) return {};
  const name = (tags['name:en'] || tags.name || '').trim().slice(0, 80) || null;
  // "2.10 MYR/motorcar;1.10 MYR/taxi;..." -> the car price; a single unlabelled charge counts too.
  const charge = tags.charge || '';
  const car = /([\d.]+)\s*([A-Z]{3})\s*\/\s*motorcar/.exec(charge) || (/^\s*([\d.]+)\s*([A-Z]{3})\s*$/.exec(charge) ?? null);
  const price = car ? { amount: Number(car[1]), currency: car[2] } : null;
  const pay = [];
  for (const [k, v] of Object.entries(tags)) {
    if (v !== 'yes') continue;
    const label = PAYMENTS.find(([re]) => re.test(k))?.[1];
    if (label && !pay.includes(label)) pay.push(label);
  }
  pay.sort((a, b) => PAYMENTS.findIndex((p) => p[1] === a) - PAYMENTS.findIndex((p) => p[1] === b));
  return { name, price, pay };
}

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
