import { REPORT_TYPES, reportLabel, reportIcon } from './report-types.js';
import { distance, bearing, cumulative, formatDistance, formatDuration, formatClock } from './geo.js';
import { Navigator, Simulator, reportsAlong } from './nav.js';
import { turnIcon, CAR, DEST_PIN, DROP_PIN, PLACE_ICONS, soundIcon } from './icons.js';
import {
  $, state, api, local, toast, esc, timeAgo, speak, loadLocalSettings, saveSettings, loadPlaces, addPlace, removePlace,
  isSaved, setHomeWork, armBack,
} from './core.js';
import { initPanels, openMenu, openAuth, renderAvatar, refreshMe } from './panels.js';

const STYLES = {
  day: 'https://tiles.openfreemap.org/styles/liberty',
  night: 'https://tiles.openfreemap.org/styles/dark',
};
// Route line colours per map theme: brand plum, lighter at night so it stands out on the dark map.
const ROUTE = {
  day: { main: '#9b2c6b', casing: '#4a0f31' },
  night: { main: '#d0569a', casing: '#5e1640' },
};
const REPORT_REFRESH_MS = 60_000;
const REROUTE_GAP_MS = 8000;
const SHARE_PUSH_MS = 15_000;

let map;
let carMarker, destMarker, dropMarker, stopMarker;
const routeLabels = [];
const reports = new Map(); // id -> report
const reportMarkers = new Map(); // id -> maplibregl.Marker
let follow = true;
let mode = 'browse'; // browse | preview | drive | watch
let themeNow = null;

// Preview / drive state
let dest = null;
let stops = []; // places to visit on the way, in order, not yet reached
let routes = [];
let selected = 0;
let nav = null;
let live = null;
let sim = null, simTimer = null;
let onRoute = []; // reports along the active route
const alerted = new Map(); // report id -> 'ahead' | 'asked'
let lastReroute = 0;
let rerouting = false;
let driveStarted = 0;
let wakeLock = null;
let share = null; // { token, url, lastPush }
let recenterTimer = null;

// ================= Boot =================
boot();

async function boot() {
  loadLocalSettings();
  applyTheme(true);
  const last = local.get('lastPos');
  map = new maplibregl.Map({
    container: 'map',
    style: STYLES[themeNow],
    center: last ?? [10, 25],
    zoom: last ? 15 : 1.6,
    attributionControl: { compact: true },
    maxPitch: 65,
  });
  map.touchPitch.disable();
  map.on('style.load', addMapLayers);
  map.on('dragstart', (e) => e.originalEvent && stopFollowing());
  map.on('zoomstart', (e) => e.originalEvent && mode === 'drive' && stopFollowing());
  map.on('rotate', () => $('btn-compass').classList.toggle('hidden', Math.abs(map.getBearing()) < 3 || mode === 'drive'));
  map.on('moveend', scheduleReportLoad);
  setupLongPress();

  carMarker = new maplibregl.Marker({ element: el('div', 'car', CAR), rotationAlignment: 'map', pitchAlignment: 'map' });

  initPanels({ onUserChanged, applyTheme, openSearchFor, openPreview, refreshSound });
  wireUi();
  refreshSound();
  startLocation();
  setInterval(() => loadReports(true), REPORT_REFRESH_MS);
  setInterval(() => applyTheme(), 5 * 60_000);

  await refreshMe();
  await onUserChanged();

  // Deep links: /drive/<token> watches a shared drive; /?to=lat,lng&name= opens a destination.
  const m = location.pathname.match(/^\/drive\/([a-z0-9]+)$/i);
  if (m) return startWatching(m[1]);
  const to = new URLSearchParams(location.search).get('to');
  if (to) {
    const [lat, lng] = to.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const name = new URLSearchParams(location.search).get('name') || 'Shared place';
      history.replaceState(null, '', '/');
      openPreview({ name, address: '', lat, lng });
    }
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function onUserChanged() {
  renderAvatar();
  await loadPlaces();
  renderSearchHome();
}

function el(tag, cls, html = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

// ================= Theme =================
function nightNow() {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h >= 19 || h < 6.5;
}

function applyTheme(initial = false) {
  const t = state.settings.theme === 'auto' ? (nightNow() ? 'night' : 'day') : state.settings.theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'night' ? '#161b22' : '#751b4f';
  if (themeNow !== t) {
    themeNow = t;
    if (!initial && map) map.setStyle(STYLES[t]);
  }
}

// ================= Map layers =================
function addMapLayers() {
  if (!map.getSource('routes')) {
    map.addSource('routes', { type: 'geojson', data: emptyFc() });
    map.addSource('watch-route', { type: 'geojson', data: emptyFc() });
    // Above every road (some styles put a few labels early), but below the labels drawn on top of roads.
    const layers = map.getStyle().layers;
    const lastShape = layers.findLastIndex((l) => l.type !== 'symbol');
    const before = layers.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
    map.addLayer({ id: 'routes-alt-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], false], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#5f6b76', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 14] } }, before);
    map.addLayer({ id: 'routes-alt', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], false], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a9b5c3', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4.5, 16, 10] } }, before);
    map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 16] } }, before);
    map.addLayer({ id: 'routes-main', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], true], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].main, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11] } }, before);
    map.addLayer({ id: 'watch-route', type: 'line', source: 'watch-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ROUTE[themeNow].main, 'line-width': 6, 'line-opacity': 0.85 } }, before);
    for (const id of ['routes-alt', 'routes-alt-casing']) {
      map.on('click', id, (e) => mode === 'preview' && selectRoute(e.features[0].properties.idx));
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
  }
  drawRoutes();
}

// fitBounds adds to whatever padding the camera already has (e.g. from driving), so clear it first.
function fitTo(bounds, opts) {
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  map.fitBounds(bounds, opts);
}

const emptyFc = () => ({ type: 'FeatureCollection', features: [] });

function drawRoutes() {
  const src = map?.getSource('routes');
  if (!src) return;
  let features = [];
  if (mode === 'preview') {
    features = routes.map((r, i) => ({ type: 'Feature', properties: { idx: i, selected: i === selected }, geometry: { type: 'LineString', coordinates: r.coords } }));
    features.sort((a, b) => a.properties.selected - b.properties.selected);
  } else if (mode === 'drive' && nav) {
    // Only draw what's left, so the line "shrinks" behind the car.
    const along = live?.along ?? 0;
    const rest = remainingCoords(nav, along, live?.snapped);
    features = [{ type: 'Feature', properties: { idx: 0, selected: true }, geometry: { type: 'LineString', coordinates: rest } }];
  }
  src.setData({ type: 'FeatureCollection', features });
}

function remainingCoords(n, along, snapped) {
  const out = snapped ? [snapped] : [];
  for (let i = n.seg; i < n.coords.length; i++) out.push(n.coords[i]);
  return out.length > 1 ? out : n.coords.slice(-2);
}

// ================= Location =================
function startLocation() {
  if (!('geolocation' in navigator)) return locationFailed();
  navigator.geolocation.watchPosition(onFix, locationFailed, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
}

function locationFailed(err) {
  state.locationDenied = true;
  if (mode === 'browse' && !state.pos) $('loc-banner').classList.remove('hidden');
  if (err && err.code !== 1 && !state.pos) setTimeout(startLocation, 15000);
}

function onFix(p) {
  state.locationDenied = false;
  $('loc-banner').classList.add('hidden');
  const lngLat = [p.coords.longitude, p.coords.latitude];
  const prev = state.pos;
  let heading = prev?.heading ?? null;
  const speed = p.coords.speed;
  if (p.coords.heading != null && !Number.isNaN(p.coords.heading) && (speed ?? 0) > 1) heading = p.coords.heading;
  else if (prev && distance(prev.lngLat, lngLat) > 6) heading = bearing(prev.lngLat, lngLat);
  const fix = { lngLat, heading, speed: speed ?? (prev ? estSpeed(prev, lngLat, p.timestamp) : 0), accuracy: p.coords.accuracy, time: p.timestamp };
  if (sim) return; // a simulated drive owns the car right now
  handleFix(fix, !prev);
}

function estSpeed(prev, lngLat, t) {
  const dt = (t - prev.time) / 1000;
  return dt > 0 && dt < 10 ? distance(prev.lngLat, lngLat) / dt : 0;
}

function handleFix(fix, first = false) {
  state.pos = fix;
  local.set('lastPos', fix.lngLat.map((v) => Math.round(v * 1e4) / 1e4));
  if (mode === 'watch') return; // the viewer's own position isn't part of someone else's drive
  if (!carMarker._map) carMarker.setLngLat(fix.lngLat).addTo(map);
  updateSpeedo(fix.speed);
  if (mode === 'drive') return driveTick(fix);
  carMarker.setLngLat(fix.lngLat).setRotation(fix.heading ?? 0);
  if (first && mode === 'browse') map.jumpTo({ center: fix.lngLat, zoom: 15.5 });
  else if (follow && mode === 'browse') map.easeTo({ center: fix.lngLat, duration: 600 });
}

function updateSpeedo(speed) {
  const k = state.settings.units === 'imperial' ? 2.23694 : 3.6;
  const v = Math.max(0, Math.round((speed ?? 0) * k));
  for (const id of ['speedo', 'speedo-browse']) {
    const s = $(id);
    s.querySelector('b').textContent = v;
    s.querySelector('small').textContent = state.settings.units === 'imperial' ? 'mph' : 'km/h';
  }
  $('speedo-browse').classList.toggle('hidden', v < 5);
}

function stopFollowing() {
  follow = false;
  $('btn-recenter').classList.remove('following');
  if (mode === 'drive') {
    $('btn-recenter-drive').classList.remove('hidden');
    clearTimeout(recenterTimer);
    recenterTimer = setTimeout(recenter, 12000); // like a co-driver: snap back after a while
  }
}

function recenter() {
  follow = true;
  clearTimeout(recenterTimer);
  $('btn-recenter').classList.add('following');
  $('btn-recenter-drive').classList.add('hidden');
  if (mode === 'drive' && live) return driveCamera(true);
  if (state.pos) map.easeTo({ center: state.pos.lngLat, zoom: Math.max(map.getZoom(), 15), bearing: 0, pitch: 0, duration: 700 });
  else if (state.locationDenied) toast('Location is off. Allow location for this site in your browser settings.');
}

// ================= Long-press: drop a pin =================
function setupLongPress() {
  let timer = null, start = null;
  const cancel = () => clearTimeout(timer);
  map.on('touchstart', (e) => {
    if (e.points?.length !== 1 || mode === 'drive' || mode === 'watch') return;
    start = e.point;
    timer = setTimeout(() => showContextMenu(e.lngLat, e.point), 550);
  });
  map.on('touchmove', (e) => start && Math.hypot(e.point.x - start.x, e.point.y - start.y) > 10 && cancel());
  map.on('touchend', cancel);
  map.on('touchcancel', cancel);
  map.on('contextmenu', (e) => mode !== 'drive' && mode !== 'watch' && showContextMenu(e.lngLat, e.point));
  map.on('click', hideContextMenu);
}

async function showContextMenu(lngLat, point) {
  const box = $('ctx');
  const p = { name: 'Dropped pin', address: `${lngLat.lat.toFixed(5)}, ${lngLat.lng.toFixed(5)}`, lat: lngLat.lat, lng: lngLat.lng };
  dropMarker?.remove();
  dropMarker = new maplibregl.Marker({ element: el('div', 'drop-pin', DROP_PIN), anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
  box.innerHTML = `
    <button class="menu-row" data-act="go">Drive here</button>
    <button class="menu-row" data-act="save">Save place</button>
    <button class="menu-row" data-act="home">Set as Home</button>
    <button class="menu-row" data-act="work">Set as Work</button>`;
  box.style.left = `${Math.min(point.x, innerWidth - 220)}px`;
  box.style.top = `${Math.min(point.y + 8, innerHeight - 220)}px`;
  box.classList.remove('hidden');
  if (navigator.vibrate) navigator.vibrate(15);
  const named = api(`/api/reverse?lat=${lngLat.lat}&lng=${lngLat.lng}`).then((r) => ({ ...r.place, lat: lngLat.lat, lng: lngLat.lng })).catch(() => p);
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    hideContextMenu();
    const place = await named;
    if (act === 'go') openPreview(place);
    if (act === 'save') saveAsFavourite(place);
    if (act === 'home' || act === 'work') {
      await setHomeWork(act, place);
      renderSearchHome();
      toast(`${act === 'home' ? 'Home' : 'Work'} set to ${place.name}`);
    }
  };
}

function hideContextMenu() {
  $('ctx').classList.add('hidden');
  if (mode !== 'preview') dropMarker?.remove();
}

// ================= UI wiring =================
function wireUi() {
  $('btn-where').onclick = () => openSearchFor(null);
  $('btn-menu').onclick = openMenu;
  $('btn-recenter').onclick = recenter;
  $('btn-recenter-drive').onclick = recenter;
  $('btn-compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
  $('btn-loc-retry').onclick = () => {
    $('loc-banner').classList.add('hidden');
    startLocation();
  };
  $('btn-report').onclick = openReportMenu;
  $('btn-report-drive').onclick = openReportMenu;
  $('btn-sound').onclick = $('btn-sound-browse').onclick = () => {
    saveSettings({ voice: !state.settings.voice });
    refreshSound();
    toast(state.settings.voice ? 'Sound on' : 'Sound off');
  };
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => closeScreen(b.dataset.close)));

  // Search
  let t;
  $('search-input').oninput = () => {
    clearTimeout(t);
    const q = $('search-input').value.trim();
    $('search-clear').classList.toggle('hidden', !q);
    if (q.length < 2) return showSearchHome();
    t = setTimeout(() => runSearch(q), 280);
  };
  $('search-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(t);
      const q = $('search-input').value.trim();
      if (q.length >= 2) runSearch(q, true);
    }
  };
  $('search-clear').onclick = () => {
    $('search-input').value = '';
    $('search-clear').classList.add('hidden');
    showSearchHome();
    $('search-input').focus();
  };
  $('tile-home').onclick = () => (state.home ? pickPlace({ ...state.home, name: 'Home' }) : openSearchFor('home'));
  $('tile-work').onclick = () => (state.work ? pickPlace({ ...state.work, name: 'Work' }) : openSearchFor('work'));

  // Preview
  $('btn-go').onclick = startDrive;
  $('btn-save-place').onclick = () => dest && toggleSaved(dest);
  $('btn-leave-later').onclick = openLater;

  // Drive
  $('btn-eta').onclick = () => {
    const opening = $('eta-menu').classList.toggle('hidden') === false;
    if (opening) $('alert').classList.add('hidden'); // the alert card would sit on top of the menu
  };
  $('btn-stop').onclick = () => endDrive(false);
  $('btn-overview').onclick = overview;
  $('btn-share-drive').onclick = shareDrive;
  $('btn-add-stop').onclick = () => {
    $('eta-menu').classList.add('hidden');
    if (stops.length) return removeStop();
    openSearchFor('stop');
  };
  $('btn-arrived-done').onclick = () => {
    $('arrived').classList.add('hidden');
    backToBrowse();
  };

  // Reports
  $('btn-report-back').onclick = () => renderReportGrid();
  $('btn-report-send').onclick = sendReport;

  window.addEventListener('popstate', onBack);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTop();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mode === 'drive') requestWakeLock();
  });
}

function refreshSound() {
  $('btn-sound').innerHTML = soundIcon(state.settings.voice);
  $('btn-sound-browse').innerHTML = soundIcon(state.settings.voice);
}

function closeScreen(id) {
  $(id).classList.add('hidden');
  if (id === 'preview') backToBrowse();
  if (id === 'report-sheet') reportDraft = null;
}

const OVERLAYS = ['ctx', 'auth', 'panel', 'search', 'report-card', 'report-sheet', 'later', 'arrived', 'preview'];

// Closes the top-most screen; returns false when nothing was open.
function closeTop() {
  for (const id of OVERLAYS) {
    if ($(id).classList.contains('hidden')) continue;
    if (id === 'ctx') hideContextMenu();
    else if (id === 'arrived') $('btn-arrived-done').click();
    else closeScreen(id);
    return true;
  }
  if (!$('menu').classList.contains('hidden')) {
    $('menu').classList.add('hidden');
    $('menu-backdrop').classList.add('hidden');
    return true;
  }
  if (!$('eta-menu').classList.contains('hidden')) {
    $('eta-menu').classList.add('hidden');
    return true;
  }
  return false;
}

function onBack() {
  const closed = closeTop();
  // Back while driving opens the trip options rather than dropping out of the app.
  if (!closed && mode === 'drive') $('eta-menu').classList.remove('hidden');
  const open = OVERLAYS.some((id) => !$(id).classList.contains('hidden')) || !$('menu').classList.contains('hidden');
  if (open || mode === 'drive') armBack();
}

// ================= Search =================
let searchTarget = null; // null = navigate | 'home' | 'work' | 'save'
let searchSeq = 0;

function openSearchFor(target) {
  armBack();
  searchTarget = target;
  $('search').classList.remove('hidden');
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  const label = { home: 'Set your Home address', work: 'Set your Work address', save: 'Search for a place to save', stop: 'Add a stop on your way' }[target];
  $('search-target').textContent = label ?? '';
  $('search-target').classList.toggle('hidden', !label);
  $('search-input').placeholder = target ? 'Search for an address' : 'Where to?';
  showSearchHome();
  setTimeout(() => $('search-input').focus(), 50);
}

function showSearchHome() {
  $('results').classList.add('hidden');
  $('search-status').classList.add('hidden');
  $('search-home').classList.remove('hidden');
  renderSearchHome();
}

function renderSearchHome() {
  $('home-sub').textContent = state.home ? state.home.address || state.home.name : 'Set location';
  $('work-sub').textContent = state.work ? state.work.address || state.work.name : 'Set location';
  const { saved, recent } = state.places;
  $('saved-head').classList.toggle('hidden', !saved.length);
  $('recent-head').classList.toggle('hidden', !recent.length);
  $('search-empty-hint').classList.toggle('hidden', saved.length + recent.length > 0);
  renderPlaceList($('saved-list'), saved, 'star', 'saved');
  renderPlaceList($('recent-list'), recent, 'recent', 'recent');
}

function renderPlaceList(ul, list, icon, kind) {
  ul.innerHTML = '';
  for (const p of list) {
    const li = el('li');
    const d = state.pos ? formatDistance(distance(state.pos.lngLat, [p.lng, p.lat]), state.settings.units) : '';
    li.innerHTML = `<button class="place-row"><span class="p-ic">${PLACE_ICONS[icon]}</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address || '')}</small></span><span class="p-dist">${d}</span></button>
      <button class="icon-btn" aria-label="Remove">${PLACE_ICONS.more}</button>`;
    li.firstElementChild.onclick = () => pickPlace(p);
    li.lastElementChild.onclick = async () => {
      if (!confirm(`Remove "${p.name}" from ${kind === 'saved' ? 'saved places' : 'recent'}?`)) return;
      await removePlace(kind, p.id).catch((e) => toast(e.message));
      renderSearchHome();
    };
    ul.append(li);
  }
}

async function runSearch(q, enter = false) {
  const seq = ++searchSeq;
  $('search-status').textContent = 'Searching…';
  $('search-status').classList.remove('hidden');
  const near = state.pos?.lngLat ?? map.getCenter().toArray();
  try {
    const coord = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    const { places } = coord
      ? { places: [{ name: 'Coordinates', address: q, lat: Number(coord[1]), lng: Number(coord[2]) }] }
      : await api(`/api/search?q=${encodeURIComponent(q)}&lat=${near[1]}&lng=${near[0]}&lang=${(navigator.language || 'en').slice(0, 2)}`);
    if (seq !== searchSeq) return;
    $('search-home').classList.add('hidden');
    const ul = $('results');
    ul.classList.remove('hidden');
    ul.innerHTML = '';
    $('search-status').classList.toggle('hidden', places.length > 0);
    $('search-status').textContent = places.length ? '' : `No results for "${q}".`;
    for (const p of places) {
      const li = el('li');
      const d = formatDistance(distance(near, [p.lng, p.lat]), state.settings.units);
      li.innerHTML = `<button class="place-row"><span class="p-ic">${PLACE_ICONS.pin}</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address)}</small></span><span class="p-dist">${d}</span></button>`;
      li.firstElementChild.onclick = () => pickPlace(p);
      ul.append(li);
    }
    if (enter && places.length === 1) pickPlace(places[0]);
  } catch (e) {
    if (seq !== searchSeq) return;
    $('search-status').textContent = e.message;
  }
}

async function pickPlace(p) {
  $('search-input').blur();
  if (searchTarget === 'home' || searchTarget === 'work') {
    const which = searchTarget;
    try {
      await setHomeWork(which, p);
      toast(`${which === 'home' ? 'Home' : 'Work'} saved`);
    } catch (e) {
      toast(e.message);
    }
    searchTarget = null;
    renderSearchHome();
    closeScreen('search');
    return;
  }
  if (searchTarget === 'save') {
    searchTarget = null;
    closeScreen('search');
    return saveAsFavourite(p);
  }
  if (searchTarget === 'stop') {
    searchTarget = null;
    closeScreen('search');
    return addStop(p);
  }
  closeScreen('search');
  openPreview(p);
}

// ================= Saved places =================
async function saveAsFavourite(p) {
  try {
    await addPlace('saved', p);
    toast(`Saved "${p.name}"`);
    renderSearchHome();
    updateSaveStar();
  } catch (e) {
    toast(e.message);
  }
}

async function toggleSaved(p) {
  const existing = isSaved(p);
  if (existing) {
    await removePlace('saved', existing.id).catch((e) => toast(e.message));
    toast('Removed from saved places');
    renderSearchHome();
    updateSaveStar();
  } else saveAsFavourite(p);
}

function updateSaveStar() {
  $('btn-save-place').classList.toggle('saved', Boolean(dest && isSaved(dest)));
}

// ================= Preview: destination + route options =================
async function openPreview(place) {
  armBack();
  hideContextMenu();
  mode = 'preview';
  dest = place;
  routes = [];
  selected = 0;
  $('browse-ui').classList.add('hidden');
  $('preview').classList.remove('hidden');
  $('dest-name').textContent = place.name;
  $('dest-addr').textContent = place.address || '';
  $('route-list').innerHTML = '';
  $('btn-go').disabled = true;
  updateSaveStar();
  destMarker?.remove();
  dropMarker?.remove();
  destMarker = new maplibregl.Marker({ element: el('div', 'dest-pin', DEST_PIN), anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(map);
  map.easeTo({ center: [place.lng, place.lat], zoom: 15, pitch: 0, bearing: 0, padding: sheetPadding() });

  const from = state.pos?.lngLat;
  if (!from) {
    $('route-status').textContent = state.locationDenied
      ? 'Location is off, so routes start from the middle of the map.'
      : 'Waiting for your location… routes start from the middle of the map for now.';
  } else $('route-status').textContent = 'Finding the best routes…';
  try {
    routes = await requestRoutes(from ?? map.getCenter().toArray(), [place.lng, place.lat]);
    if (mode !== 'preview' || dest !== place) return;
    if (from) $('route-status').textContent = '';
    renderRouteOptions();
    drawRoutes();
    fitRoutes();
    $('btn-go').disabled = false;
  } catch (e) {
    if (mode === 'preview') $('route-status').textContent = e.message;
  }
}

async function requestRoutes(from, to, heading, via = []) {
  const s = state.settings;
  const { routes: rs } = await api('/api/route', {
    method: 'POST',
    body: {
      from, to, heading,
      via: via.map((p) => [p.lng, p.lat]),
      units: s.units,
      lang: navigator.language || 'en-US',
      avoid: { tolls: s.avoid_tolls, highways: s.avoid_highways, ferries: s.avoid_ferries },
    },
  });
  for (const r of rs) r.cum = cumulative(r.coords);
  return rs;
}

function sheetPadding() {
  const wide = innerWidth >= 720;
  return wide ? { top: 60, bottom: 60, left: 460, right: 60 } : { top: 60, bottom: Math.min(innerHeight * 0.5, 380), left: 40, right: 40 };
}

function fitRoutes() {
  const b = new maplibregl.LngLatBounds();
  for (const r of routes) for (const c of r.coords) b.extend(c);
  if (!b.isEmpty()) fitTo(b, { padding: sheetPadding(), duration: 700, maxZoom: 16 });
  drawRouteLabels();
}

function drawRouteLabels() {
  routeLabels.splice(0).forEach((m) => m.remove());
  if (mode !== 'preview') return;
  routes.forEach((r, i) => {
    // Put each label where this route differs from the others, roughly 40-60% of the way.
    const at = r.coords[Math.floor(r.coords.length * (0.4 + i * 0.1))] ?? r.coords[0];
    const label = el('div', `route-label${i === selected ? ' on' : ''}`, esc(formatDuration(r.duration)));
    label.onclick = (e) => {
      e.stopPropagation();
      selectRoute(i);
    };
    routeLabels.push(new maplibregl.Marker({ element: label }).setLngLat(at).addTo(map));
  });
}

function renderRouteOptions() {
  const box = $('route-list');
  box.innerHTML = '';
  const fastest = Math.min(...routes.map((r) => r.duration));
  routes.forEach((r, i) => {
    const b = el('button', `route-opt${i === selected ? ' on' : ''}`);
    const badges = [];
    if (r.duration === fastest && routes.length > 1) badges.push('<span class="badge best">Fastest</span>');
    if (r.toll) badges.push('<span class="badge warn">Toll</span>');
    if (r.ferry) badges.push('<span class="badge warn">Ferry</span>');
    const reps = (r.reports ?? []).length;
    if (reps) badges.push(`<span class="badge">${reps} report${reps > 1 ? 's' : ''}</span>`);
    if (r.delay > 0) badges.push(`<span class="badge warn">+${formatDuration(r.delay)} traffic</span>`);
    b.innerHTML = `<span class="r-time">${formatDuration(r.duration)}</span><span class="r-info"><b>${r.via ? `via ${esc(r.via)}` : 'Route'} </b>${formatDistance(r.distance, state.settings.units)} · arrive ${formatClock(new Date(Date.now() + r.duration * 1000))}<br>${badges.join('')}</span>`;
    b.onclick = () => selectRoute(i);
    box.append(b);
  });
}

function selectRoute(i) {
  selected = Number(i);
  renderRouteOptions();
  drawRoutes();
  drawRouteLabels();
}

function backToBrowse() {
  mode = 'browse';
  routes = [];
  dest = null;
  destMarker?.remove();
  dropMarker?.remove();
  routeLabels.splice(0).forEach((m) => m.remove());
  drawRoutes();
  for (const id of ['preview', 'later', 'drive-ui', 'arrived', 'report-card']) $(id).classList.add('hidden');
  $('browse-ui').classList.remove('hidden');
  document.body.classList.remove('driving');
  follow = true;
  $('btn-recenter').classList.add('following');
  map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, ...(state.pos ? { center: state.pos.lngLat, zoom: 15.5 } : {}), duration: 700 });
  if (state.pos) carMarker.setLngLat(state.pos.lngLat).setRotation(state.pos.heading ?? 0);
}

// ================= Leave later =================
let laterMode = 'leave';

function openLater() {
  const r = routes[selected];
  if (!r) return toast('Wait for the route first.');
  $('later').classList.remove('hidden');
  armBack();
  const input = $('later-time');
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  input.value = toLocalInput(d);
  document.querySelectorAll('[data-later]').forEach((b) => {
    b.onclick = () => {
      laterMode = b.dataset.later;
      document.querySelectorAll('[data-later]').forEach((x) => x.classList.toggle('on', x === b));
      updateLater();
    };
  });
  input.oninput = updateLater;
  $('btn-later-remind').onclick = downloadCalendar;
  updateLater();
}

function laterTimes() {
  const r = routes[selected];
  const t = new Date($('later-time').value);
  const ms = r.duration * 1000;
  return laterMode === 'leave' ? { leave: t, arrive: new Date(+t + ms) } : { leave: new Date(+t - ms), arrive: t };
}

function updateLater() {
  if (!routes[selected] || Number.isNaN(+new Date($('later-time').value))) return;
  const { leave, arrive } = laterTimes();
  $('later-result').innerHTML = `Leave <b>${formatClock(leave)}</b>, arrive around <b>${formatClock(arrive)}</b>.<br><small class="hint">Based on today's typical drive time of ${formatDuration(routes[selected].duration)}.</small>`;
}

function downloadCalendar() {
  const { leave, arrive } = laterTimes();
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const link = `${location.origin}/?to=${dest.lat},${dest.lng}&name=${encodeURIComponent(dest.name)}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//A2B//Leave later//EN', 'BEGIN:VEVENT',
    `UID:${Date.now()}@a2b`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(leave)}`, `DTEND:${stamp(arrive)}`,
    `SUMMARY:Drive to ${dest.name.replace(/[,;\n]/g, ' ')}`, `DESCRIPTION:Open in A2B: ${link}`, `URL:${link}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'DESCRIPTION:Time to leave soon', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = 'a2b-drive.ics';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Added: open the file to put it in your calendar.');
  $('later').classList.add('hidden');
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ================= Driving =================
function startDrive() {
  const route = routes[selected];
  if (!route) return;
  mode = 'drive';
  nav = new Navigator(route, { units: state.settings.units });
  nav.spoken.add('depart');
  live = null;
  stops = [];
  renderStopMenu();
  alerted.clear();
  driveStarted = Date.now();
  routeLabels.splice(0).forEach((m) => m.remove());
  $('preview').classList.add('hidden');
  $('later').classList.add('hidden');
  $('drive-ui').classList.remove('hidden');
  $('eta-menu').classList.add('hidden');
  $('alert').classList.add('hidden');
  document.body.classList.add('driving');
  armBack();
  follow = true;
  $('btn-recenter-drive').classList.add('hidden');
  // Speak inside the tap so mobile browsers allow audio for the rest of the drive.
  speak(route.steps[0]?.pre);
  addPlace('recent', dest).then(renderSearchHome).catch(() => {});
  computeOnRoute();
  loadReports(true);
  requestWakeLock();

  const useSim = state.simulate || !state.pos;
  if (useSim) {
    if (!state.simulate) toast('No GPS signal, so this is a demo drive.', 3500);
    startSimulation(route);
  } else driveTick(state.pos);
}

function startSimulation(route) {
  stopSimulation();
  sim = new Simulator(route, { speedFactor: local.get('simSpeed', 1) });
  const step = () => {
    const f = sim.next();
    handleFix({ lngLat: f.position, heading: f.heading, speed: f.speed, accuracy: f.accuracy, time: Date.now() });
    if (f.done) stopSimulation();
  };
  step();
  simTimer = setInterval(step, 1000);
}

function stopSimulation() {
  clearInterval(simTimer);
  simTimer = null;
  sim = null;
}

function driveTick(fix) {
  if (!nav) return;
  live = nav.update({ position: fix.lngLat, heading: fix.heading, speed: fix.speed, accuracy: fix.accuracy });
  const heading = (fix.speed ?? 0) > 1.5 && fix.heading != null ? fix.heading : live.routeBearing;
  carMarker.setLngLat(live.snapped).setRotation(heading);
  renderBanner();
  renderEta();
  renderLimit(live.limit, fix.speed);
  drawRoutes();
  if (follow) driveCamera(false, heading);
  if (live.prompt) speak(live.prompt);
  checkAlerts();
  if (share) pushShare();

  const stopStep = nav.steps.findIndex((st) => st.type === 'stop');
  if (stops.length && stopStep >= 0 && live.stepIndex >= stopStep) {
    toast(`Reached ${stops.shift().name}`);
    renderStopMenu();
  }

  $('offroute').classList.toggle('hidden', !live.offRoute);
  if (live.offRoute) reroute(fix);
  if (live.arrived) arrive();
}

function driveCamera(snap, heading = live?.routeBearing ?? 0) {
  if (!live) return;
  const speed = state.pos?.speed ?? 0;
  const zoom = speed > 25 ? 15.3 : speed > 15 ? 16 : 16.8;
  const pad = { top: Math.round(innerHeight * 0.42), bottom: 110, left: 0, right: 0 };
  const opts = { center: live.snapped, bearing: heading, pitch: 55, zoom, padding: pad };
  if (snap) map.easeTo({ ...opts, duration: 600 });
  else map.easeTo({ ...opts, duration: sim ? 1000 : 900, easing: (t) => t });
}

function renderBanner() {
  const { next, distToNext, then } = live;
  $('turn-icon').innerHTML = turnIcon(next.type);
  $('turn-dist').textContent = formatDistance(distToNext, state.settings.units);
  let street = next.street || next.instruction.replace(/\.$/, '');
  if (next.type === 'roundabout' && next.exit) street = `${ordinal(next.exit)} exit${next.street ? ` · ${next.street}` : ''}`;
  if (next.type.startsWith('arrive')) street = dest?.name || 'Destination';
  if (next.type === 'stop') street = stops[0]?.name || 'Your stop';
  $('turn-street').textContent = street;
  $('then').classList.toggle('hidden', !then);
  if (then) $('then-icon').innerHTML = turnIcon(then.type);
}

// Posted limit sign next to the speedometer; the speedometer goes red when clearly over it.
function renderLimit(kmh, speed) {
  const sign = $('limit');
  const imperial = state.settings.units === 'imperial';
  sign.classList.toggle('hidden', !kmh);
  $('speedo').classList.remove('fast');
  if (!kmh) return;
  const shown = imperial ? Math.round(kmh / 1.609344 / 5) * 5 : kmh;
  sign.querySelector('b').textContent = shown;
  sign.classList.toggle('us', imperial);
  const over = (speed ?? 0) * 3.6 > kmh * 1.05 + 3;
  $('speedo').classList.toggle('fast', over && state.settings.speed_warning !== false);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function renderEta() {
  const { remaining, remainingTime } = live;
  $('eta-clock').textContent = formatClock(new Date(Date.now() + remainingTime * 1000));
  const mins = Math.max(1, Math.round(remainingTime / 60));
  if (mins >= 60) {
    $('eta-min').textContent = `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    $('eta-min-unit').textContent = 'hr';
  } else {
    $('eta-min').textContent = mins;
    $('eta-min-unit').textContent = 'min';
  }
  const [n, u] = formatDistance(remaining, state.settings.units).split(' ');
  $('eta-dist').textContent = n;
  $('eta-dist-unit').textContent = u;
}

async function reroute(fix, { force = false, note } = {}) {
  if (rerouting || (!force && Date.now() - lastReroute < REROUTE_GAP_MS) || !dest) return;
  rerouting = true;
  lastReroute = Date.now();
  try {
    const rs = await requestRoutes(fix.lngLat, [dest.lng, dest.lat], fix.heading ?? undefined, stops);
    if (mode !== 'drive') return;
    nav = new Navigator(rs[0], { units: state.settings.units });
    nav.spoken.add('depart');
    computeOnRoute();
    loadReports(true);
    if (sim) startSimulation(rs[0]);
    speak(note ?? 'Route recalculated.');
    if (share) pushShare(true);
  } catch (e) {
    toast(e.message);
  } finally {
    rerouting = false;
  }
}

async function addStop(place) {
  if (mode !== 'drive' || !state.pos) return;
  stops = [place];
  renderStopMenu();
  toast(`Adding a stop at ${place.name}…`);
  await reroute(state.pos, { force: true, note: `Stop added. Going via ${place.name}.` });
  if (stopMarker) stopMarker.remove();
  stopMarker = new maplibregl.Marker({ element: el('div', 'drop-pin', DROP_PIN), anchor: 'bottom' }).setLngLat([place.lng, place.lat]).addTo(map);
}

async function removeStop() {
  stops = [];
  stopMarker?.remove();
  stopMarker = null;
  renderStopMenu();
  if (state.pos) await reroute(state.pos, { force: true, note: 'Stop removed.' });
}

function renderStopMenu() {
  $('add-stop-label').textContent = stops.length ? `Remove stop (${stops[0].name})` : 'Add a stop';
  if (!stops.length && stopMarker) {
    stopMarker.remove();
    stopMarker = null;
  }
}

function overview() {
  $('eta-menu').classList.add('hidden');
  if (!nav) return;
  stopFollowing();
  const b = new maplibregl.LngLatBounds();
  for (const c of nav.coords) b.extend(c);
  fitTo(b, { padding: { top: 160, bottom: 140, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 800 });
}

async function arrive() {
  const name = dest?.name ?? '';
  const took = Date.now() - driveStarted;
  const dist = nav?.total ?? 0;
  speak(nav?.steps.at(-1)?.pre || 'You have arrived.');
  await endDrive(true);
  $('arrived-name').textContent = name;
  $('arrived-stats').textContent = `${formatDistance(dist, state.settings.units)} in ${formatDuration(took / 1000)}`;
  $('arrived').classList.remove('hidden');
  $('browse-ui').classList.add('hidden');
}

async function endDrive(arrived) {
  stopSimulation();
  if (share) {
    api(`/api/trips/${share.token}`, { method: 'PATCH', body: { ended: true } }).catch(() => {});
    share = null;
  }
  nav = null;
  live = null;
  onRoute = [];
  stops = [];
  renderStopMenu();
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  $('alert').classList.add('hidden');
  $('offroute').classList.add('hidden');
  $('limit').classList.add('hidden');
  $('speedo').classList.remove('fast');
  if (!arrived) backToBrowse();
  else {
    mode = 'browse';
    $('drive-ui').classList.add('hidden');
    document.body.classList.remove('driving');
    drawRoutes();
    destMarker?.remove();
    map.easeTo({ pitch: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
  }
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}

// ================= Shared drive =================
async function shareDrive() {
  $('eta-menu').classList.add('hidden');
  if (!state.user) return openAuth('share');
  try {
    if (!share) {
      const res = await api('/api/trips', {
        method: 'POST',
        body: { destination: dest, eta: Date.now() + (live?.remainingTime ?? 0) * 1000, route: nav?.coords ?? [] },
      });
      share = { ...res, lastPush: 0 };
      pushShare(true);
    }
    const text = `I'm driving to ${dest.name}. Follow my drive and ETA:`;
    if (navigator.share) await navigator.share({ title: 'My drive', text, url: share.url }).catch(() => {});
    else {
      await navigator.clipboard?.writeText(share.url);
      toast('Link copied. Anyone with it can follow this drive until you arrive.');
    }
  } catch (e) {
    toast(e.message);
  }
}

function pushShare(withRoute = false) {
  if (!share || !live || !state.pos) return;
  if (!withRoute && Date.now() - share.lastPush < SHARE_PUSH_MS) return;
  share.lastPush = Date.now();
  api(`/api/trips/${share.token}`, {
    method: 'PATCH',
    body: {
      position: live.snapped,
      heading: state.pos.heading ?? live.routeBearing,
      eta: Date.now() + live.remainingTime * 1000,
      ...(withRoute ? { route: nav.coords } : {}),
    },
  }).catch(() => {});
}

// Someone opened a /drive/<token> link: show where that driver is.
async function startWatching(token) {
  mode = 'watch';
  carMarker.remove();
  $('browse-ui').classList.add('hidden');
  const sheet = $('watch');
  sheet.classList.remove('hidden');
  sheet.innerHTML = '<div class="grabber"></div><p class="hint">Loading drive…</p>';
  let fitted = false;
  let driverMarker = null;
  const tick = async () => {
    try {
      const t = await api(`/api/trips/${token}`);
      if (!map.getSource('watch-route')) return setTimeout(tick, 500);
      map.getSource('watch-route').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: t.route } });
      if (!destMarker) destMarker = new maplibregl.Marker({ element: el('div', 'dest-pin', DEST_PIN), anchor: 'bottom' }).setLngLat([t.destination.lng, t.destination.lat]).addTo(map);
      if (t.position) {
        driverMarker ??= new maplibregl.Marker({ element: el('div', 'car', CAR), rotationAlignment: 'map' }).setLngLat([t.position.lng, t.position.lat]).addTo(map);
        driverMarker.setLngLat([t.position.lng, t.position.lat]).setRotation(t.position.heading ?? 0);
        driverMarker.getElement().classList.toggle('stale', Date.now() - t.updated_at > 120_000);
      }
      if (!fitted) {
        const b = new maplibregl.LngLatBounds();
        for (const c of t.route) b.extend(c);
        if (t.position) b.extend([t.position.lng, t.position.lat]);
        b.extend([t.destination.lng, t.destination.lat]);
        fitTo(b, { padding: sheetPadding(), duration: 0, maxZoom: 15 });
        fitted = true;
      }
      const left = t.eta ? Math.max(0, (t.eta - Date.now()) / 1000) : null;
      sheet.innerHTML = `<div class="grabber"></div>
        <div class="watch-head"><span class="avatar">${esc((t.driver || '?')[0])}</span><div><b>${esc(t.driver)} ${t.ended ? 'has arrived' : 'is driving'}</b><small class="hint">to ${esc(t.destination.name)}</small></div></div>
        ${t.ended ? '' : `<div class="watch-eta"><div><b>${t.eta ? formatClock(new Date(t.eta)) : '--'}</b><small>arrival</small></div><div><b>${left == null ? '--' : left < 30 ? 'Any minute' : formatDuration(left)}</b><small>left</small></div></div>`}
        <p class="hint">Updated ${timeAgo(t.updated_at)}</p>
        <a class="btn ghost wide" style="display:grid;place-items:center;text-decoration:none" href="/">Open A2B</a>`;
      if (!t.ended) setTimeout(tick, 10_000);
    } catch (e) {
      sheet.innerHTML = `<div class="grabber"></div><p class="hint">${esc(e.message)}</p><a class="btn ghost wide" style="display:grid;place-items:center;text-decoration:none" href="/">Open A2B</a>`;
    }
  };
  tick();
}

// ================= Reports on the map =================
let reportLoadTimer;
let lastLoad = { at: 0, box: null };

// The camera moves every second while driving or following, so only refetch when the view leaves
// the area we already have, or the data is getting old.
function scheduleReportLoad() {
  if (mode === 'drive') return; // driving refreshes on its own timer, along the whole route
  clearTimeout(reportLoadTimer);
  reportLoadTimer = setTimeout(() => loadReports(), 350);
}

async function loadReports(force = false) {
  if (!map || map.getZoom() < 9 || mode === 'watch') {
    if (map && map.getZoom() < 9) for (const id of [...reportMarkers.keys()]) dropReport(id);
    return;
  }
  const b = map.getBounds();
  const view = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const had = lastLoad.box;
  const covered = had && view[0] >= had[0] && view[1] >= had[1] && view[2] <= had[2] && view[3] <= had[3];
  if (!force && covered && Date.now() - lastLoad.at < REPORT_REFRESH_MS - 1000) return;
  // Fetch a margin around the view so small pans don't need another request.
  const mx = (view[2] - view[0]) * 0.25, my = (view[3] - view[1]) * 0.25;
  const box = [view[0] - mx, view[1] - my, view[2] + mx, view[3] + my];
  if (mode === 'drive' && state.pos) {
    // While driving, also fetch ~30 km around the car so alerts work well beyond the screen.
    const [x, y] = state.pos.lngLat;
    box[0] = Math.min(box[0], x - 0.3); box[1] = Math.min(box[1], y - 0.25);
    box[2] = Math.max(box[2], x + 0.3); box[3] = Math.max(box[3], y + 0.25);
  }
  try {
    const { reports: list } = await api(`/api/reports?bbox=${box.map((v) => v.toFixed(5)).join(',')}`);
    lastLoad = { at: Date.now(), box };
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      upsertReport(r);
    }
    for (const id of [...reports.keys()]) {
      const r = reports.get(id);
      const inside = r.lng >= box[0] && r.lng <= box[2] && r.lat >= box[1] && r.lat <= box[3];
      if (inside && !seen.has(id)) dropReport(id);
    }
    computeOnRoute();
  } catch {}
}

function upsertReport(r) {
  reports.set(r.id, r);
  let m = reportMarkers.get(r.id);
  if (!m) {
    const e = el('div', 'report-pin', `<div class="pin-ic" style="background:${REPORT_TYPES[r.type]?.color}">${reportIcon(r.type)}</div>`);
    e.onclick = (ev) => {
      ev.stopPropagation();
      showReportCard(reports.get(r.id));
    };
    m = new maplibregl.Marker({ element: e }).setLngLat([r.lng, r.lat]).addTo(map);
    reportMarkers.set(r.id, m);
  }
  const e = m.getElement();
  e.classList.toggle('mine', r.mine);
  e.style.opacity = String(reportOpacity(r));
  e.title = reportLabel(r.type, r.subtype);
}

// Fresh and confirmed reports are solid; old, unconfirmed ones fade so drivers can tell at a glance.
function reportOpacity(r) {
  const life = r.expires_at - r.created_at || 1;
  const age = (Date.now() - r.created_at) / life;
  return Math.max(0.45, Math.min(1, 1 - age * 0.6 + r.still * 0.15));
}

function dropReport(id) {
  reportMarkers.get(id)?.remove();
  reportMarkers.delete(id);
  reports.delete(id);
}

function computeOnRoute() {
  onRoute = nav ? reportsAlong(nav, [...reports.values()]) : [];
}

function showReportCard(r) {
  if (!r) return;
  const card = $('report-card');
  const t = REPORT_TYPES[r.type];
  const d = state.pos ? ` · ${formatDistance(distance(state.pos.lngLat, [r.lng, r.lat]), state.settings.units)} away` : '';
  card.innerHTML = `<div class="grabber"></div>
    <div class="rc-head"><span class="pin-ic" style="background:${t.color}">${reportIcon(r.type, 28)}</span>
      <div style="flex:1;min-width:0"><b>${esc(reportLabel(r.type, r.subtype))}</b><small>${r.mine ? 'Your report' : `Reported by ${esc(r.by || 'a driver')}`} · ${timeAgo(r.created_at)}${d}</small></div>
      <button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button></div>
    ${r.comment ? `<p class="rc-comment">${esc(r.comment)}</p>` : ''}
    <div class="rc-stats"><span>👍 ${r.thanks} thanks</span><span>✔ ${r.still} still there</span><span>✖ ${r.gone} not there</span></div>
    <div class="sheet-actions">
      ${r.mine ? '<button class="btn danger" data-vote="gone">Remove my report</button>' : '<button class="btn ghost" data-vote="gone">Not there</button><button class="btn primary" data-vote="thanks">👍 Thanks</button>'}
    </div>`;
  card.classList.remove('hidden');
  armBack();
  card.querySelector('[data-x]').onclick = () => card.classList.add('hidden');
  card.querySelectorAll('[data-vote]').forEach((b) => {
    b.onclick = () => vote(r, b.dataset.vote).then(() => card.classList.add('hidden'), () => {});
  });
}

async function vote(r, v) {
  if (!state.user) {
    openAuth('vote');
    throw new Error('sign in');
  }
  try {
    const res = await api(`/api/reports/${r.id}/vote`, { method: 'POST', body: { vote: v } });
    if (res.removed || v === 'gone') {
      if (res.removed) dropReport(r.id);
      toast(res.removed ? 'Thanks, it has been removed from the map.' : 'Thanks for letting us know.');
    } else {
      upsertReport(res.report);
      toast(v === 'thanks' ? `You thanked ${r.by || 'the reporter'}` : 'Thanks for confirming!');
    }
    if (res.points) bumpPoints(res.points);
  } catch (e) {
    toast(e.message);
  }
}

function bumpPoints(n) {
  if (!state.user) return;
  state.user.points += n;
  renderAvatar();
}

// Alert the driver about reports ahead on the route, then ask if they're still there once passed.
function checkAlerts() {
  if (!state.settings.alerts || !live) return;
  const card = $('alert');
  for (const r of onRoute) {
    const ahead = r.at - live.along;
    const status = alerted.get(r.id);
    if (!status && ahead > 0 && ahead < alertRange(r.type)) {
      alerted.set(r.id, 'ahead');
      showAlert(r, ahead);
      speak(`${REPORT_TYPES[r.type].label} reported ahead.`);
      return;
    }
    if (status === 'ahead' && ahead < -25 && ahead > -400 && !r.mine) {
      alerted.set(r.id, 'asked');
      showAlert(r, null);
      return;
    }
  }
  if (!card.classList.contains('hidden') && card.dataset.until && Date.now() > Number(card.dataset.until)) card.classList.add('hidden');
}

function alertRange(type) {
  return type === 'police' || type === 'camera' ? 800 : type === 'closure' ? 1500 : 600;
}

function showAlert(r, ahead) {
  const card = $('alert');
  if (!$('eta-menu').classList.contains('hidden')) return; // trip menu is open; the voice alert is enough
  const t = REPORT_TYPES[r.type];
  const ms = ahead == null ? 10_000 : 12_000;
  card.dataset.until = String(Date.now() + ms);
  const title = ahead == null ? `${t.label} still there?` : `${reportLabel(r.type, r.subtype)} ahead`;
  const sub = ahead == null ? `Reported by ${esc(r.by || 'a driver')}` : `${formatDistance(ahead, state.settings.units)} · ${timeAgo(r.created_at)}${r.by ? ` by ${esc(r.by)}` : ''}`;
  const buttons = ahead == null
    ? '<button class="btn ghost" data-a="gone">Not there</button><button class="btn primary" data-a="still">Still there</button>'
    : `<button class="btn ghost" data-a="dismiss">OK</button>${r.mine ? '' : '<button class="btn primary" data-a="thanks">👍 Thanks</button>'}`;
  card.innerHTML = `<div class="alert-top"><span class="pin-ic" style="background:${t.color}">${reportIcon(r.type, 26)}</span><div><b>${esc(title)}</b><small>${sub}</small></div></div>
    <div class="alert-actions">${buttons}</div><div class="alert-timer"><i style="animation-duration:${ms}ms"></i></div>`;
  card.classList.remove('hidden');
  card.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => {
      card.classList.add('hidden');
      if (b.dataset.a !== 'dismiss') vote(r, b.dataset.a).catch(() => {});
    };
  });
}

// ================= Reporting =================
let reportDraft = null;

function openReportMenu() {
  hideContextMenu();
  if (!state.user) return openAuth('report');
  reportDraft = { at: state.pos?.lngLat ?? map.getCenter().toArray(), heading: state.pos?.heading ?? null };
  $('report-where').textContent = state.pos ? 'At your current location' : 'At the middle of the map (location is off)';
  renderReportGrid();
  $('report-sheet').classList.remove('hidden');
  armBack();
}

function renderReportGrid() {
  $('report-title').textContent = 'Report';
  $('report-sub').classList.add('hidden');
  const grid = $('report-grid');
  grid.classList.remove('hidden');
  grid.innerHTML = '';
  for (const [key, t] of Object.entries(REPORT_TYPES)) {
    const b = el('button', 'report-tile', `<span class="pin-ic" style="background:${t.color}">${reportIcon(key, 36)}</span>${esc(t.label)}`);
    b.onclick = () => pickReportType(key);
    grid.append(b);
  }
}

function pickReportType(key) {
  const t = REPORT_TYPES[key];
  reportDraft.type = key;
  reportDraft.subtype = null;
  $('report-title').textContent = t.label;
  $('report-grid').classList.add('hidden');
  $('report-sub').classList.remove('hidden');
  $('report-comment').value = '';
  const sub = $('report-sub-grid');
  sub.innerHTML = '';
  for (const [k, label] of Object.entries(t.subtypes)) {
    const b = el('button', '', esc(label));
    b.onclick = () => {
      reportDraft.subtype = reportDraft.subtype === k ? null : k;
      sub.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b && reportDraft.subtype === k));
    };
    sub.append(b);
  }
}

async function sendReport() {
  if (!reportDraft?.type) return;
  const btn = $('btn-report-send');
  btn.disabled = true;
  try {
    const [lng, lat] = reportDraft.at;
    const res = await api('/api/reports', {
      method: 'POST',
      body: { type: reportDraft.type, subtype: reportDraft.subtype, lat, lng, heading: reportDraft.heading, comment: $('report-comment').value },
    });
    $('report-sheet').classList.add('hidden');
    upsertReport(res.report);
    computeOnRoute();
    if (res.report) alerted.set(res.report.id, 'asked');
    bumpPoints(res.points || 0);
    toast(res.merged ? 'Thanks! You confirmed an existing report.' : `Report sent. Thanks! +${res.points} points`);
    reportDraft = null;
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
