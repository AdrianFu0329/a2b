# Bounded GPS estimates and confirmed arrival

Review base: upstream `main` at `134045abe40e3fd50f73fb24437c4ef4a2920509`.

## Problem reproduced

Synthetic tests of the upstream `app.js` and `nav.js` functions reproduced two failures:

- After the 90-second estimate budget ended, the next timer tick started another estimate. At 8 m/s, this happened 92 seconds after the last real fix (including the initial gap). The 2.5 km budget failed the same way at 70 m/s, after 47 seconds.
- An estimated position at the destination announced arrival, changed the app to browse mode and sent `ended: "arrived"` to the shared-trip endpoint.
- Follow-up review found that replacing a route during GPS loss reused its old distance origin. The actual reroute/tunnel fixture at `8895c07` reproduced a jump from more than 5 km along the old route to the endpoint of a new 222 m route. The periodic sharing timer could also publish an estimated `live.snapped` position despite the guard in `driveTick()`.

## Changes for review

- `public/dead-reckoning.js`: keep a GPS outage exhausted after either budget is reached. Later timer ticks cannot restart it. Only a new real measurement with valid coordinates, accuracy at most 80 m and age at most 2.5 seconds clears the outage. Duplicate, stale, future, inaccurate and estimated fixes do not clear it. Ending a drive resets its lifecycle.
- `public/app.js`: retain the original GPS measurement timestamp separately from the movement timestamp used for speed calculation. Ignore unusable real fixes during a drive. Keep the `NO GPS` chip visible with `Waiting for GPS` after exhaustion; resume normal positioning on a suitable real fix.
- `public/app.js`: pass estimated provenance into navigation. Estimated progress can update the arrow, distances and turn guidance, but cannot consume a stop, trigger rerouting, publish a position, finish a drive or end trip sharing.
- Route replacement during active, exhausted or stale GPS suspends the existing episode and clears the old route progress without renewing its budget. The new line can be drawn while the marker waits for a newer accurate fix. A delayed response uses the latest fresh accepted position, never the position captured when the request started.
- The trip-sharing heartbeat also checks freshness and outage state. A replacement route held during GPS loss is sent with the next real recovery fix and retried until the server acknowledges it. Only a newly replaced route bypasses the normal send cadence; retries for the same unacknowledged route follow the existing movement/ETA/heartbeat rules, with no added polling timer. Late acknowledgements cannot mark another sharing session or route as updated.
- `public/nav.js`: estimated positions cannot latch arrival or consume arrival/stop voice cues. Off-route recovery fixes also cannot confirm or announce the destination or consume a stop using the previous estimated progress, including before the off-route counter reaches its threshold. Ordinary real arrival still completes the trip.
- `test/dead-reckoning.test.js`, `test/nav.test.js`, `test/gps-lifecycle.test.js`: cover both budgets, continued ticks after exhaustion, invalid/repeated recovery fixes, stationary GPS timestamps, subsequent outages, stop confirmation, arrival voice cues and the actual app path through `arrive()` / `endDrive()` / the shared-trip update. Deferred reroute fixtures cover active/exhausted route replacement, long requests, a newer position arriving while a request is pending, and sharing after recovery. The fixture includes the separate route-lifecycle change's `resetTripRequests` hook for combined validation.

The controller stays in the existing cached `dead-reckoning.js` module; no new service-worker shell dependency is needed. Transit guidance and the shared text-matching import remain in place.

## Validation

- `npm test`: 199 passed, 0 failed on 2026-10-29 after the route-replacement follow-up, including existing transit and search tests. Slow/failed PATCH fixtures with per-second stationary GPS send at 0, 4, 34 and 64 seconds, then send a new route immediately at 65 seconds; failures do not falsely acknowledge the route.
- The new app tests execute the actual app functions with synthetic GPS, a controlled clock, a small DOM substitute and stubbed network effects. Three further minutes after each exhaustion produce no movement. Estimated arrival keeps the trip open; a subsequent real destination fix sends exactly one shared-trip completion.
- Baseline reproduction uses the upstream app/navigation functions with the same synthetic fixtures. No public routing/map endpoints or real trip data are used.
- Chrome 156 component smoke used the actual HTML/CSS, episode controller and `renderTunnelStatus()` function with synthetic GPS states. Estimating, suspended/exhausted waiting and recovered-hidden states passed at 320, 375 and 812 px widths in day/night themes, with no page errors. Reproducible local harness: `work/m1-gps-reroute-browser.mjs`; log: `work/m1-gps-reroute-browser.log`.
- The browser smoke bypasses map/app boot and uses synthetic episode inputs. It does not establish real permission, hardware GPS, background navigation or on-road behavior; those remain untested.

Actual component captures from the same fixture:

![Estimating after GPS loss](../screenshots/gps-estimating-chip.png)

![Waiting for GPS after suspension or exhaustion](../screenshots/gps-waiting-chip.png)

Remaining sharing boundary: the late-acknowledgement guard protects client bookkeeping, not ordering of
overlapping PATCH writes at the server. Ordered/versioned outbound sharing is a separate follow-up;
these tests do not claim to solve that existing race.

Submitted for owner review. No CLA acceptance, merge or deployment was performed.
