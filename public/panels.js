// "My A2B" menu, sign in / sign up, settings, saved places, leaderboard and about.

import { $, state, api, local, toast, esc, initials, saveSettings, setHomeWork, removePlace, renamePlace, armBack, speak } from './core.js';
import { voiceChoice, setVoiceChoice, deviceVoices, isGoodVoice } from './voice.js';
import { VEHICLES, COLORS, DEFAULT_COLOR } from './vehicle3d.js';

let ctx; // callbacks from app.js
let authMode = 'signup';
let authReason = null;
let installPrompt = null;

export function initPanels(callbacks) {
  ctx = callbacks;
  $('menu-backdrop').onclick = closeMenu;
  $('m-settings').onclick = () => (closeMenu(), openSettings());
  $('m-places').onclick = () => (closeMenu(), openSavedPlaces());
  $('m-leaders').onclick = () => (closeMenu(), openLeaders());
  $('m-about').onclick = () => (closeMenu(), openAbout());
  $('m-logout').onclick = logout;
  $('m-install').onclick = install;
  $('auth-switch').onclick = () => setAuthMode(authMode === 'signup' ? 'login' : 'signup');
  $('auth-form').onsubmit = submitAuth;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
  });
}

export async function refreshMe() {
  try {
    const { user, stats, tester } = await api('/api/me');
    state.user = user;
    state.stats = stats ?? null;
    state.tester = Boolean(tester);
    if (user) {
      // The account's settings win over this device's, so they follow the driver between phones.
      Object.assign(state.settings, user.settings);
      local.set('settings', state.settings);
    }
  } catch {
    state.user = null;
    state.tester = false;
  }
  if (!state.tester) state.simulate = false; // testing tools only for tester accounts
}

export function renderAvatar() {
  $('avatar').textContent = state.user ? initials(state.user.name) : '?';
  $('m-logout').classList.toggle('hidden', !state.user);
}

// ================= Menu =================
export function openMenu() {
  renderProfile();
  $('menu').classList.remove('hidden');
  $('menu-backdrop').classList.remove('hidden');
  armBack();
  if (state.user) refreshMe().then(renderProfile);
}

function closeMenu() {
  $('menu').classList.add('hidden');
  $('menu-backdrop').classList.add('hidden');
}

function renderProfile() {
  const box = $('profile');
  const u = state.user;
  if (!u) {
    box.innerHTML = `<div class="who"><span class="avatar">?</span><div><b>Guest driver</b><small>Sign up to report, earn points and keep your places on every device.</small></div></div>
      <div class="sheet-actions" style="margin-top:4px"><button class="btn ghost small" id="p-login">Log in</button><button class="btn primary small" id="p-signup">Sign up</button></div>`;
    $('p-login').onclick = () => (closeMenu(), openAuth(null, 'login'));
    $('p-signup').onclick = () => (closeMenu(), openAuth(null, 'signup'));
    return;
  }
  const s = state.stats ?? { reports: 0, thanks: 0 };
  box.innerHTML = `<div class="who"><span class="avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b><small>${esc(u.email)}</small></div></div>
    <div class="stats"><div class="stat"><b>${u.points}</b><small>points</small></div><div class="stat"><b>${s.reports}</b><small>reports</small></div><div class="stat"><b>${s.thanks}</b><small>thanks</small></div></div>`;
}

// ================= Auth =================
const REASONS = {
  report: 'Sign up to report what you see. Other drivers can thank you, and you earn points.',
  vote: 'Sign up to confirm or dismiss reports from other drivers.',
  share: 'Sign up to share your drive and ETA with friends.',
};

export function openAuth(reason = null, mode = 'signup') {
  authReason = reason;
  setAuthMode(mode);
  $('auth-why').textContent = REASONS[reason] ?? 'Join other drivers. Report what you see on the road and get thanked for it.';
  $('auth-error').classList.add('hidden');
  $('auth').classList.remove('hidden');
  armBack();
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('auth-title').textContent = signup ? 'Sign up' : 'Log in';
  $('auth-submit').textContent = signup ? 'Create account' : 'Log in';
  $('auth-switch').textContent = signup ? 'Already have an account? Log in' : 'New here? Create an account';
  document.querySelector('#auth-form .name-row').classList.toggle('hidden', !signup);
  document.querySelector('#auth-form [name=password]').autocomplete = signup ? 'new-password' : 'current-password';
  $('auth-error').classList.add('hidden');
}

async function submitAuth(e) {
  e.preventDefault();
  const f = new FormData($('auth-form'));
  const body = { email: f.get('email'), password: f.get('password') };
  if (authMode === 'signup') Object.assign(body, { name: f.get('name'), settings: state.settings });
  const btn = $('auth-submit');
  const label = btn.textContent;
  const fields = $('auth-form').querySelectorAll('input, button');
  // Show progress in the button (and lock the form) so a slow network doesn't look like a frozen screen.
  const busy = (text) => (btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(text)}`);
  fields.forEach((x) => (x.disabled = true));
  btn.classList.add('busy');
  busy(authMode === 'signup' ? 'Creating account…' : 'Logging in…');
  $('auth-error').classList.add('hidden');
  try {
    await api(`/api/auth/${authMode}`, { method: 'POST', body });
    await refreshMe();
    if (authMode === 'signup') {
      busy('Copying your places…');
      await bringGuestPlaces();
    }
    $('auth').classList.add('hidden');
    $('auth-form').reset();
    await ctx.onUserChanged();
    ctx.applyTheme();
    ctx.refreshSound();
    toast(authMode === 'signup' ? `Welcome, ${state.user.name}!` : `Welcome back, ${state.user.name}!`);
    if (authReason === 'report') $('btn-report').click();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').classList.remove('hidden');
  } finally {
    fields.forEach((x) => (x.disabled = false));
    btn.classList.remove('busy');
    btn.textContent = label;
  }
}

// A brand-new account takes over everything the guest kept on this device: Home, Work, saved places and recent
// destinations. Once they're in the account they're cleared here, so logging out later doesn't bring back an old
// guest copy. If the copy fails, the guest's lists stay on the device untouched.
async function bringGuestPlaces() {
  const home = local.get('home'), work = local.get('work');
  const saved = local.get('saved', []), recent = local.get('recent', []);
  try {
    if (home) await setHomeWork('home', home);
    if (work) await setHomeWork('work', work);
    if (saved.length || recent.length) await api('/api/places/import', { method: 'POST', body: { saved, recent } });
    for (const k of ['home', 'work', 'saved', 'recent']) local.set(k, null);
  } catch {
    toast("Couldn't copy all your places into the account. They're still on this phone.");
  }
}

async function logout() {
  closeMenu();
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  state.user = null;
  state.stats = null;
  await ctx.onUserChanged();
  toast('Logged out');
}

// ================= Panels =================
function openPanel(title, html) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel').classList.remove('hidden');
  armBack();
  return $('panel-body');
}

// This phone's voices, best first. Tapping one picks it and plays a sample. Voices differ per device, so the
// choice is kept on this device only.
function renderVoiceList() {
  const box = $('voice-list');
  const now = voiceChoice();
  const row = (choice, name, note) =>
    `<button class="set-row voice-row${choice === now ? ' on' : ''}" data-voice="${esc(choice)}"><span>${esc(name)}<small>${esc(note)}</small></span></button>`;
  const phone = deviceVoices().slice(0, 8);
  const iphone = /iphone|ipad/i.test(navigator.userAgent);
  box.innerHTML = `
    ${row('auto', 'Automatic', 'The best voice this phone has')}
    ${phone.map((v) => row(v.name, v.name, `${v.lang}${isGoodVoice(v) ? ' · high quality' : ''}`)).join('')}
    ${iphone ? '<p class="hint" style="padding:6px 18px 2px">For a better offline voice, download an Enhanced or Premium one in iPhone Settings › Accessibility › Spoken Content › Voices, then pick it here.</p>' : ''}`;
  box.onclick = (e) => {
    const b = e.target.closest('[data-voice]');
    if (!b) return;
    setVoiceChoice(b.dataset.voice);
    box.querySelectorAll('[data-voice]').forEach((x) => x.classList.toggle('on', x === b));
    const sample = state.settings.units === 'imperial' ? 'In a quarter mile, turn right. Then keep left.' : 'In 300 metres, turn right. Then keep left.';
    speak(sample, { force: true, choice: b.dataset.voice });
  };
}

function toggleRow(key, label, sub = '') {
  return `<label class="set-row"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="switch" data-set="${key}" ${state.settings[key] ? 'checked' : ''}></label>`;
}

function choiceRow(key, label, options) {
  return `<div class="set-row"><span>${label}</span><div class="choice" data-choice="${key}">${options
    .map(([v, l]) => `<button data-v="${v}" class="${state.settings[key] === v ? 'on' : ''}">${l}</button>`)
    .join('')}</div></div>`;
}

export function openSettings() {
  const u = state.user;
  const body = openPanel('Settings', `
    <div class="set-group"><h3>Sound and alerts</h3>
      ${toggleRow('voice', 'Voice directions')}
      ${toggleRow('alerts', 'Report alerts while driving', 'Police, crashes, hazards and closures ahead')}
      ${toggleRow('speed_warning', 'Speeding warning', 'Speedometer turns red above the posted limit')}
    </div>
    <div class="set-group"><h3>Voice</h3><div id="voice-list"></div></div>
    <div class="set-group"><h3>Navigation</h3>
      ${toggleRow('avoid_tolls', 'Avoid toll roads')}
      ${toggleRow('avoid_highways', 'Avoid highways')}
      ${toggleRow('avoid_ferries', 'Avoid ferries')}
      <p class="hint" style="padding:4px 18px">Roads that other drivers report as closed are avoided automatically.</p>
    </div>
    <div class="set-group"><h3>Display</h3>
      ${choiceRow('units', 'Units', [['metric', 'km'], ['imperial', 'miles']])}
      ${choiceRow('theme', 'Map', [['auto', 'Auto'], ['day', 'Day'], ['night', 'Night']])}
      <div class="set-row"><span>Vehicle<small>How you appear on the map</small></span><div class="choice" id="s-vehicle">${VEHICLES
        .map(([v, l]) => `<button data-v="${v}" class="${local.get('vehicle', 'chevron') === v ? 'on' : ''}">${l}</button>`)
        .join('')}</div></div>
      <div class="set-row swatch-row"><span>Colour</span><div class="swatches" id="s-vehicle-color">${COLORS
        .map(([c, l]) => `<button data-c="${c}" aria-label="${l}" title="${l}" class="${local.get('vehicleColor', DEFAULT_COLOR) === c ? 'on' : ''}" style="--c:${c}"></button>`)
        .join('')}</div></div>
    </div>
    <div class="set-group"><h3>Places</h3>
      <button class="set-row" id="s-home"><span>Home<small>${esc(state.home?.address || state.home?.name || 'Not set')}</small></span></button>
      <button class="set-row" id="s-work"><span>Work<small>${esc(state.work?.address || state.work?.name || 'Not set')}</small></span></button>
    </div>
    ${u ? `<div class="set-group"><h3>Account</h3>
      <button class="set-row" id="s-name"><span>Display name<small>${esc(u.name)}</small></span></button>
      <button class="set-row" id="s-pass"><span>Change password</span></button>
      <button class="set-row" id="s-delete" style="color:var(--danger)"><span>Delete account</span></button>
    </div>` : ''}
    ${state.tester ? `<div class="set-group"><h3>Testing</h3>
      <label class="set-row"><span>Demo drive<small>Simulate GPS along the route. Handy for trying A2B at a desk.</small></span><input type="checkbox" class="switch" id="s-sim" ${state.simulate ? 'checked' : ''}></label>
      <div class="set-row${state.simulate ? '' : ' hidden'}" id="s-sim-speed-row"><span>Demo speed<small>How fast the demo car drives</small></span><div class="choice" id="s-sim-speed">${[1, 2, 4, 8]
        .map((v) => `<button data-v="${v}" class="${local.get('simSpeed', 1) === v ? 'on' : ''}">${v}×</button>`)
        .join('')}</div></div>
    </div>` : ''}`);

  body.querySelectorAll('[data-set]').forEach((c) => {
    c.onchange = async () => {
      await saveSettings({ [c.dataset.set]: c.checked });
      if (c.dataset.set === 'voice') ctx.refreshSound();
    };
  });
  body.querySelectorAll('[data-choice]').forEach((group) => {
    group.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      await saveSettings({ [group.dataset.choice]: b.dataset.v });
      if (group.dataset.choice === 'theme') ctx.applyTheme();
    };
  });
  renderVoiceList();
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => $('voice-list') && renderVoiceList();
  // Kept on this device: it's about how this screen looks.
  $('s-vehicle').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('s-vehicle').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    local.set('vehicle', b.dataset.v);
    ctx.setupVehicle();
  };
  $('s-vehicle-color').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $('s-vehicle-color').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    local.set('vehicleColor', b.dataset.c);
    ctx.setupVehicle();
  };
  if (state.tester) {
    $('s-sim').onchange = (e) => {
      state.simulate = e.target.checked;
      local.set('simulate', state.simulate);
      $('s-sim-speed-row').classList.toggle('hidden', !state.simulate);
    };
    // Testing aid: applies straight away, also to a demo drive already under way.
    $('s-sim-speed').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $('s-sim-speed').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      local.set('simSpeed', Number(b.dataset.v));
      ctx.setSimSpeed(Number(b.dataset.v));
    };
  }
  $('s-home').onclick = () => homeWorkAction('home');
  $('s-work').onclick = () => homeWorkAction('work');
  if (u) {
    $('s-name').onclick = async () => {
      const name = prompt('Display name (other drivers see this on your reports)', u.name);
      if (!name?.trim()) return;
      try {
        state.user = (await api('/api/me', { method: 'PATCH', body: { name } })).user;
        renderAvatar();
        openSettings();
      } catch (e) {
        toast(e.message);
      }
    };
    $('s-pass').onclick = async () => {
      const current = prompt('Current password');
      if (!current) return;
      const next = prompt('New password (at least 8 characters)');
      if (!next) return;
      try {
        await api('/api/me', { method: 'PATCH', body: { current_password: current, password: next } });
        toast('Password changed');
      } catch (e) {
        toast(e.message);
      }
    };
    $('s-delete').onclick = async () => {
      if (!confirm('Delete your account? Your saved places and reports will be removed. This cannot be undone.')) return;
      try {
        await api('/api/me', { method: 'DELETE' });
        state.user = null;
        $('panel').classList.add('hidden');
        await ctx.onUserChanged();
        toast('Account deleted');
      } catch (e) {
        toast(e.message);
      }
    };
  }
}

function homeWorkAction(which) {
  const label = which === 'home' ? 'Home' : 'Work';
  const has = state[which];
  if (!has) {
    $('panel').classList.add('hidden');
    return ctx.openSearchFor(which);
  }
  openPanel(label, `<div class="about"><p><b style="color:var(--text)">${esc(has.name)}</b><br>${esc(has.address || '')}</p>
    <button class="btn primary wide" id="hw-change">Change ${label.toLowerCase()} address</button>
    <button class="btn ghost wide" id="hw-clear">Clear</button></div>`);
  $('hw-change').onclick = () => {
    $('panel').classList.add('hidden');
    ctx.openSearchFor(which);
  };
  $('hw-clear').onclick = async () => {
    await setHomeWork(which, null).catch((e) => toast(e.message));
    await ctx.onUserChanged();
    openSettings();
  };
}

function openSavedPlaces() {
  const list = state.places.saved;
  const body = openPanel('Saved places', `
    <div style="padding:8px 16px"><button class="btn primary wide" id="sp-add">Add a place</button></div>
    ${list.length ? '' : '<p class="hint" style="padding:8px 18px">Tap the star on any destination, or long-press the map, to save it here.</p>'}
    <ul class="place-list">${list
      .map((p) => `<li data-id="${esc(p.id)}"><button class="place-row" data-go><span class="p-ic">⭐</span><span class="p-text"><b>${esc(p.name)}</b><small>${esc(p.address || '')}</small></span></button>
        <button class="icon-btn" data-rename aria-label="Rename">✎</button><button class="icon-btn" data-del aria-label="Delete">✕</button></li>`)
      .join('')}</ul>`);
  $('sp-add').onclick = () => {
    $('panel').classList.add('hidden');
    ctx.openSearchFor('save');
  };
  body.querySelectorAll('li').forEach((li) => {
    const p = list.find((x) => String(x.id) === li.dataset.id);
    li.querySelector('[data-go]').onclick = () => {
      $('panel').classList.add('hidden');
      ctx.openPreview(p);
    };
    li.querySelector('[data-rename]').onclick = async () => {
      const name = prompt('Name', p.name);
      if (!name?.trim()) return;
      await renamePlace('saved', p.id, name.trim()).catch((e) => toast(e.message));
      openSavedPlaces();
    };
    li.querySelector('[data-del]').onclick = async () => {
      if (!confirm(`Delete "${p.name}"?`)) return;
      await removePlace('saved', p.id).catch((e) => toast(e.message));
      openSavedPlaces();
    };
  });
}

async function openLeaders() {
  const body = openPanel('Top drivers', '<p class="hint" style="padding:12px 18px">Loading…</p>');
  try {
    const { leaders } = await api('/api/leaderboard');
    body.innerHTML = leaders.length
      ? `<p class="hint" style="padding:8px 18px">Points come from reports and from other drivers thanking and confirming them.</p>${leaders
          .map((l, i) => `<div class="leader${l.me ? ' me' : ''}"><span class="rank">${i + 1}</span><span class="avatar">${esc(initials(l.name))}</span><span>${esc(l.name)}</span><b>${l.points}</b></div>`)
          .join('')}`
      : '<p class="hint" style="padding:12px 18px">No drivers yet. Be the first to report something!</p>';
  } catch (e) {
    body.innerHTML = `<p class="hint" style="padding:12px 18px">${esc(e.message)}</p>`;
  }
}

function openAbout() {
  openPanel('About A2B', `<div class="about">
    <img src="/icon.svg" alt="" width="64" height="64">
    <p><b style="color:var(--text)">A2B</b> gets you from A to B with live directions and reports from drivers around you.</p>
    <p>Keep your eyes on the road. Only use the app when it is safe and legal to do so. Reports from other drivers can be wrong.</p>
    <p>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>.
       Map tiles by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>.
       Routing by <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noopener">Valhalla</a>, search by <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>.</p>
  </div>`);
}

async function install() {
  closeMenu();
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt = null;
    return;
  }
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  openPanel('Add to home screen', `<div class="about"><p>${
    ios
      ? 'In Safari, tap the <b>Share</b> button, then <b>Add to Home Screen</b>.'
      : 'Open your browser menu (⋮) and choose <b>Install app</b> or <b>Add to Home screen</b>.'
  }</p><p>A2B then opens full screen, like an app.</p></div>`);
}

