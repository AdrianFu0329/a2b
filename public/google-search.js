// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Google's Place Search (Places UI Kit) for one query, inside Malaysia. The UI Kit is the one part of Google Maps
// Platform its terms let us use next to a map that isn't Google's; it draws the list, names, addresses and its
// attribution itself, and hands our code only the place picked: its ID and position. Those go back to the app
// (postMessage), which names the spot from its own data (see offerGoogle in app.js). Nothing of it is kept on
// A2B's server (Google's terms allow keeping a position 30 days and a place ID).

import { inMalaysia } from './geo.js';

const MALAYSIA = { south: 0.85, west: 99.6, north: 7.4, east: 119.3 };
const params = new URLSearchParams(location.search);
const q = (params.get('q') ?? '').trim().slice(0, 120);
const note = document.getElementById('note');
const say = (text) => (note.textContent = text);
const send = (msg) => parent.postMessage({ source: 'a2b-google', ...msg }, location.origin);

function loadMaps(key) {
  return new Promise((resolve, reject) => {
    window.a2bGoogleReady = resolve;
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=en&region=MY&callback=a2bGoogleReady`;
    s.onerror = () => reject(new Error('Google Maps did not load.'));
    document.head.append(s);
  });
}

async function start() {
  if (!q) return say('Type what you are looking for first.');
  const { key } = await fetch('/api/google').then((r) => r.json());
  if (!key) return say('Search Google is not set up here.');
  await loadMaps(key);
  await google.maps.importLibrary('places');

  const search = document.createElement('gmp-place-search');
  search.setAttribute('selectable', '');
  search.append(document.createElement('gmp-place-all-content'));
  const request = document.createElement('gmp-place-text-search-request');
  request.textQuery = q;
  request.locationRestriction = MALAYSIA; // a box: Singapore and Brunei are in it too, so picks are checked below
  request.maxResultCount = 10;
  search.append(request);
  search.addEventListener('gmp-load', () => say(search.places?.length ? '' : `Google has nothing for "${q}" in Malaysia either.`));
  search.addEventListener('gmp-error', () => say('Google could not search just now. Try again later.'));
  search.addEventListener('gmp-select', ({ place }) => {
    const lat = place.location?.lat(), lng = place.location?.lng();
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return say('That place has no position to drive to.');
    if (!inMalaysia([lng, lat])) return say('A2B only goes to places in Malaysia.'); // the app checks the country too
    send({ type: 'place', place: { id: place.id, lat, lng } });
  });
  document.getElementById('list').append(search);
  say('');
}

start().catch((e) => say(e.message || 'Google could not search just now.'));
