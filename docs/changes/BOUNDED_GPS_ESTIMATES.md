# Bounded GPS estimates and confirmed arrival

Review base: upstream `main` at `134045abe40e3fd50f73fb24437c4ef4a2920509`.

## Problem reproduced

Synthetic tests of the upstream `app.js` and `nav.js` functions reproduced two failures:

- After the 90-second estimate budget ended, the next timer tick started another estimate. At 8 m/s, this happened 92 seconds after the last real fix (including the initial gap). The 2.5 km budget failed the same way at 70 m/s, after 47 seconds.
- An estimated position at the destination announced arrival, changed the app to browse mode and sent `ended: "arrived"` to the shared-trip endpoint.

## Changes for review

- `public/dead-reckoning.js`: keep a GPS outage exhausted after either budget is reached. Later timer ticks cannot restart it. Only a new real measurement with valid coordinates, accuracy at most 80 m and age at most 2.5 seconds clears the outage. Duplicate, stale, future, inaccurate and estimated fixes do not clear it. Ending a drive resets its lifecycle.
- `public/app.js`: retain the original GPS measurement timestamp separately from the movement timestamp used for speed calculation. Ignore unusable real fixes during a drive. Keep the `NO GPS` chip visible with `Waiting for GPS` after exhaustion; resume normal positioning on a suitable real fix.
- `public/app.js`: pass estimated provenance into navigation. Estimated progress can update the arrow, distances and turn guidance, but cannot consume a stop, trigger rerouting, publish a position, finish a drive or end trip sharing.
- `public/nav.js`: estimated positions cannot latch arrival or consume arrival/stop voice cues. Off-route recovery fixes also cannot confirm or announce the destination or consume a stop using the previous estimated progress, including before the off-route counter reaches its threshold. Ordinary real arrival still completes the trip.
- `test/dead-reckoning.test.js`, `test/nav.test.js`, `test/gps-lifecycle.test.js`: cover both budgets, continued ticks after exhaustion, invalid/repeated recovery fixes, stationary GPS timestamps, subsequent outages, stop confirmation, arrival voice cues and the actual app path through `arrive()` / `endDrive()` / the shared-trip update.

The controller stays in the existing cached `dead-reckoning.js` module; no new service-worker shell dependency is needed. Transit guidance and the shared text-matching import remain in place.

## Validation

- `npm test`: 189 passed, 0 failed on 2026-10-29, including existing transit and search tests.
- The new app tests execute the actual app functions with synthetic GPS, a controlled clock, a small DOM substitute and stubbed network effects. Three further minutes after each exhaustion produce no movement. Estimated arrival keeps the trip open; a subsequent real destination fix sends exactly one shared-trip completion.
- Baseline reproduction uses the upstream app/navigation functions with the same synthetic fixtures. No public routing/map endpoints or real trip data are used.
- Browser rendering, mobile GPS recovery and physical on-road validation have **not** been performed for this change. The synthetic tests do not establish browser or hardware behavior. Before publishing the PR, check the estimating/waiting/recovered chip states in a browser and record that result; any physical test should be performed by a passenger or with the vehicle safely parked.

No CLA acceptance, push, PR creation, merge or deployment was performed in this implementation subtask.
