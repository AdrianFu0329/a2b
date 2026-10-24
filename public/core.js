// Shared app state, settings, storage and the API client.

export const $ = (id) => document.getElementById(id);

export const DEFAULT_SETTINGS = {
  voice: true, alerts: true, speed_warning: true, units: 'metric', theme: 'auto', avoid_tolls: false, avoid_highways: false, avoid_ferries: false,
};

export const state = {
  user: null,
  stats: null,
  settings: { ...DEFAULT_SETTINGS },
  simulate: false,
  places: { saved: [], recent: [] },
  home: null,
  work: null,
  pos: null, // { lngLat, heading, speed, accuracy, time }
  locationDenied: false,
};

// ---------- Local storage (per-device conveniences; never required) ----------
export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`a2b.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(`a2b.${key}`);
      else localStorage.setItem(`a2b.${key}`, JSON.stringify(value));
    } catch {}
  },
};

// ---------- API ----------
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
  return data;
}

// ---------- Settings ----------
export function loadLocalSettings() {
  state.settings = { ...DEFAULT_SETTINGS, ...local.get('settings', {}) };
  state.simulate = local.get('simulate', false);
}

export async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  local.set('settings', state.settings);
  if (state.user) {
    try {
      const { user } = await api('/api/me', { method: 'PATCH', body: { settings: patch } });
      state.user = user;
    } catch (e) {
      toast(e.message);
    }
  }
}

// ---------- Places: server for signed-in drivers, this device for guests ----------
export async function loadPlaces() {
  if (state.user) {
    try {
      state.places = await api('/api/places');
    } catch {
      state.places = { saved: [], recent: [] };
    }
    state.home = state.user.home;
    state.work = state.user.work;
  } else {
    state.places = { saved: local.get('saved', []), recent: local.get('recent', []) };
    state.home = local.get('home');
    state.work = local.get('work');
  }
}

function slim(p) {
  return { name: p.name, address: p.address || '', lat: p.lat, lng: p.lng };
}

const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 0.0002 && Math.abs(a.lng - b.lng) < 0.0002;

export async function addPlace(kind, place) {
  const p = slim(place);
  if (state.user) {
    const { place: row } = await api('/api/places', { method: 'POST', body: { ...p, kind } });
    const list = state.places[kind].filter((x) => x.id !== row.id);
    state.places[kind] = [row, ...list];
    return row;
  }
  const list = state.places[kind].filter((x) => !samePlace(x, p));
  const row = { ...p, id: `local-${Date.now()}`, used_at: Date.now() };
  state.places[kind] = [row, ...list].slice(0, kind === 'recent' ? 20 : 100);
  local.set(kind, state.places[kind]);
  return row;
}

export async function removePlace(kind, id) {
  state.places[kind] = state.places[kind].filter((x) => x.id !== id);
  if (state.user && !String(id).startsWith('local-')) await api(`/api/places/${id}`, { method: 'DELETE' });
  else local.set(kind, state.places[kind]);
}

export async function renamePlace(kind, id, name) {
  const p = state.places[kind].find((x) => x.id === id);
  if (!p) return;
  p.name = name;
  if (state.user) await api(`/api/places/${id}`, { method: 'PATCH', body: { name } });
  else local.set(kind, state.places[kind]);
}

export function isSaved(place) {
  return state.places.saved.find((x) => samePlace(x, place)) ?? null;
}

export async function setHomeWork(which, place) {
  const p = place ? slim(place) : null;
  state[which] = p;
  if (state.user) {
    const { user } = await api('/api/me', { method: 'PATCH', body: { [which]: p } });
    state.user = user;
  } else local.set(which, p);
}

// ---------- Back button ----------
// While a screen is open (or a drive is on), keep one extra history entry so the phone's Back button
// closes that screen instead of leaving the app.
export function armBack() {
  try {
    if (!history.state?.a2bBack) history.pushState({ a2bBack: true }, '');
  } catch {}
}

// ---------- Small UI helpers ----------
let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function initials(name) {
  return (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') || '?';
}

export function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// ---------- Voice ----------
export function speak(text, { force = false } = {}) {
  if (!text || (!state.settings.voice && !force) || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language?.startsWith('en') ? navigator.language : 'en-US';
    u.rate = 1.02;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
