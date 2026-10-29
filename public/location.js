// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// One geolocation watch owns its callbacks and retry. A timed-out watch may still call back, so clear it before
// retrying and ignore anything delivered after it has been replaced or stopped.
export function createLocationWatch({ geolocation, onFix, onState, setTimer = setTimeout, clearTimer = clearTimeout,
  retryMs = 15_000, accuracyLimit = 80 }) {
  let watchId = null, retryTimer = null, generation = 0, active = false, status = 'idle';
  const report = (next) => {
    if (status === next) return;
    status = next;
    onState(next);
  };
  const cancelRetry = () => {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  };
  const stop = () => {
    generation++;
    active = false;
    cancelRetry();
    if (watchId !== null) geolocation.clearWatch(watchId);
    watchId = null;
  };
  const start = () => {
    if (active) return;
    cancelRetry();
    if (!geolocation?.watchPosition) return report('unsupported');
    const token = ++generation;
    active = true;
    report('acquiring');
    const current = () => active && token === generation;
    const fail = (error) => {
      if (!current()) return;
      stop();
      const next = error?.code === 1 ? 'denied' : error?.code === 3 ? 'timeout' : 'unavailable';
      report(next);
      if (next === 'denied') return; // only a deliberate retry can ask again after permission was refused
      const retryToken = generation;
      retryTimer = setTimer(() => {
        if (retryToken !== generation) return;
        retryTimer = null;
        start();
      }, retryMs);
    };
    try {
      const id = geolocation.watchPosition((position) => {
        if (!current()) return;
        const { longitude, latitude, accuracy } = position.coords ?? {};
        if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
            !Number.isFinite(accuracy) || accuracy < 0) return fail({ code: 2 });
        cancelRetry();
        report(accuracy > accuracyLimit ? 'inaccurate' : 'ready');
        onFix(position);
      }, fail, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
      // Also handles an implementation that calls back synchronously before returning its watch ID.
      if (current()) watchId = id;
      else geolocation.clearWatch(id);
    } catch {
      fail({ code: 2 });
    }
  };
  return { start, stop, get status() { return status; } };
}

export function locationMessage(status) {
  return {
    acquiring: 'Finding your location…',
    denied: 'Location permission is off. Allow location for this site in your browser settings, then try again.',
    timeout: 'Finding your location took too long. Retrying shortly.',
    unavailable: 'Your location is temporarily unavailable. Retrying shortly.',
    inaccurate: 'Location signal is weak. Waiting for a more accurate fix.',
    unsupported: 'This browser cannot provide location. You can still plan from the map.',
  }[status] ?? '';
}
