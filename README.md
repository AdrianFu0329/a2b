# A2B

Driving navigation in the browser, powered by the drivers who use it. Search for a place, pick a route, and get spoken
turn-by-turn directions. Report police, crashes, hazards, traffic and closures, and see what other drivers reported on
the road ahead.

The screens and steps match Waze, so Waze users already know their way around. The code, design and data are all A2B's
own: it uses OpenStreetMap data and nothing from Waze.

## What it does

**Map.** Opens on your position, with an arrow that turns with your heading. At the bottom: the **Where to?** bar,
your profile (bottom left) and the orange **Report** button (bottom right). Long-press the map (right-click on a
computer) to drop a pin: *Drive here, Save place, Set as Home, Set as Work*.

**Where to?** Home and Work tiles, Saved places and Recent destinations. Results appear as you type, sorted by distance
from you. You can also paste coordinates (`52.52, 13.40`).

**Route preview.** Up to three routes on the map, each with its drive time. Tap one to pick it. Each route shows a
badge for the fastest, tolls, ferries, the number of reports on the way, and extra time from reported traffic. Under
the routes are **Go now** and **Leave later** ("leave at" or "arrive by", saved to your calendar with a reminder).

**Driving.**
- Banner: the next turn, how far away it is, the street, and the turn after it when that one comes soon.
- **Lane guidance**: approaching a junction, the banner shows every lane with the ones to be in lit up.
- A white **turn arrow** drawn on the map at the next turn (all the way round for roundabouts).
- Spoken directions: an early warning ("In 400 meters, turn right onto…"), then a "now" cue.
- Bottom bar: arrival time, minutes left and distance left.
- Speedometer, plus the posted speed limit. The speedometer turns red when you're over it.
- The map turns with you in 3D. After you pan around, it snaps back after a few seconds or when you tap **Recenter**.
- Off route? It recalculates automatically.
- Tap the bottom bar for **Add a stop, Share drive, Overview, Stop**. The phone's Back button opens this menu instead of
  leaving the app.
- The screen stays on while you drive.

**Reports.** Seven types with sub-types: Traffic, Police, Crash, Hazard, Blocked lane, Closure and Camera, plus an
optional comment.
- Reports show as pins on the map. Approaching one on your route triggers an alert card with a voice warning and
  **Thanks**. Once you've passed it, the app asks **Still there? / Not there**.
- "Still there" keeps a report on the map longer. Enough "Not there" votes remove it.
- Reporting something that's already on the map confirms the existing report instead of adding a second pin.
- Every type expires on its own after a while (traffic after 30 min, closures after 6 h, cameras after 30 days).

**Accounts.** Sign up with email and password. Points come from reporting and from other drivers thanking and
confirming your reports. Your profile shows points, reports and thanks, and there's a **Top drivers** leaderboard.
Settings, Home/Work and saved places follow you to any device. Without an account you can still browse and navigate.
The account is needed to report, vote and share.

**Settings.**
- Voice on/off
- Report alerts
- Speeding warning
- Avoid tolls, highways or ferries
- km or miles
- Map: Auto (night mode from 7 pm to 6:30 am), Day or Night
- Edit Home/Work, change name or password, delete account
- **Demo drive**, which simulates GPS so you can try a drive at a desk

**Shared drive.** One tap sends a link (`/drive/<token>`) that anyone can open in a browser, no app or account needed.
It shows your car moving, your route and your live ETA. It stops updating when you arrive or stop the drive.

**Installable.** Add it to your home screen and it opens full screen like an app (manifest + service worker).

## Better than Waze

Built in:

- **Community-aware routing.** Roads that drivers report as **closed** are avoided automatically, and reported
  **traffic jams add to the ETA** of the routes they're on. The route list shows exactly why one route is slower.
- **Reports fade as they age.** Fresh or confirmed reports are solid; old unconfirmed ones turn see-through, so you can
  tell at a glance how much to trust them.
- **Duplicates merge.** A second report of the same thing within 150 m confirms the first instead of cluttering the map.
- **Shared drives work in any browser**, with no app or sign-up for the person following you.
- **No ads, and no tracking of your drives.** The server keeps only what you save (Home, Work, saved places and recent
  destinations), your reports, and the latest position of a drive while you're sharing it.

Ideas for later:

1. **Hands-free reporting by voice** ("report police") using the browser's speech recognition. Waze needs taps.
2. **"Where I parked"**: drop a pin automatically when a drive ends, and walk back to it later.
3. **Report photos** for closures and hazards (Cloudflare R2), so others can see what's going on.
4. **Trust scores**: weight votes by each driver's accuracy history, so a bad actor can't remove or plant reports.
5. **Commute learning**: "Leave by 8:12 to reach Work on time" notifications from your usual times.
6. **Fuel and EV charging** search along the route, using OpenStreetMap amenity data.

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:8787 (a local database is created automatically)
npm test             # unit and API tests, no network needed
```

Open it on your phone on the same Wi-Fi with `npx wrangler dev --ip 0.0.0.0`. Note that browsers only give GPS to
pages on `https://` or `localhost`, so for real driving tests use the deployed site.

## Put it online (Cloudflare, free tier is enough to start)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Log in from this folder: `npx wrangler login`
3. Create the database: `npx wrangler d1 create a2b`.
   Copy the `database_id` it prints into `wrangler.toml` (replace the zeros).
4. Deploy: `npm run deploy`. You'll get a URL like `https://a2b.<you>.workers.dev`.

That's it. The tables are created on the first request, and you can also create them with `npm run db:migrate:remote`.
To use your own domain, add it under *Workers & Pages → a2b → Settings → Domains & Routes*.

### The map, routing and search services

All three are free and need no key. They're set in `wrangler.toml`:

| What | Default | Notes |
| --- | --- | --- |
| Map tiles | [OpenFreeMap](https://openfreemap.org) | Free, no key, no usage limits. Map looks are in `public/map-themes.js` (default: Bright plum by day, Plum night at night). |
| Routing and speed limits | [Valhalla public server](https://valhalla1.openstreetmap.de) (`ROUTING_URL`) | Community-run "fair use" server. Fine for you and friends. |
| Search | [Photon](https://photon.komoot.io) (`GEOCODER_URL`) | Community-run "fair use" server. Same. |

Before you open it to the public, point `ROUTING_URL` and `GEOCODER_URL` at your own servers or a paid provider. You
can self-host [Valhalla](https://github.com/valhalla/valhalla) and [Photon](https://github.com/komoot/photon) with
Docker on any small VPS, or use a hosted provider such as [Stadia Maps](https://stadiamaps.com), which offers Valhalla
routing and geocoding. Nothing else in the app needs to change.

### Shops and places (Overture Maps, free)

OpenStreetMap misses many shops, especially in newer Malaysian areas, so A2B also searches
[Overture Maps](https://overturemaps.org) places (Meta, Microsoft, Foursquare, AllThePlaces and others).
They're built into small files that the website serves, and the phone downloads only the files for what's
being searched, in its own area. There's no database and no extra cost.

The files aren't kept in git. Build them before deploying, and again each month when Overture publishes a
new release ([calendar](https://docs.overturemaps.org/release-calendar/)):

```bash
pip install duckdb
npm run places          # Malaysia by default; see scripts/build-places.py --help
npm run deploy
```

### Roads under construction

OpenStreetMap sometimes marks one half of a new dual carriageway as under construction and leaves the other
half open, so the router drives down it. `npm run construction` builds the list of roads under construction
from Overture (kept in git, in `public/construction/`), and routes that run right alongside one are asked
for again around it (`src/lib/construction.js`).

### Monthly updates

A scheduled Claude Code session checks once a month for a new Overture release
(`node scripts/overture-release.mjs`). When there is one, it rebuilds both data sets with that release, runs
the tests, deploys, and commits the new construction data.

## How it's built

```
public/               the web app (no build step, plain ES modules)
  index.html          every screen
  styles.css          day and night themes, phone and desktop layouts
  app.js              map, search, route preview, driving, reports, shared drives
  panels.js           profile menu, sign in/up, settings, saved places, leaderboard
  core.js             state, API client, settings, saved places, voice
  nav.js              turn-by-turn engine: GPS snapping, next turn, ETA, voice cues, off-route, demo drive
  geo.js              distances, bearings, polylines, formatting
  report-types.js     report types, lifetimes, points, icons (shared with the server)
  icons.js            turn arrows, car and pins
  sw.js, manifest     installable app, offline shell
src/
  worker.js           the API (Cloudflare Worker)
  lib/auth.js         PBKDF2 password hashes, HttpOnly session cookies
  lib/reports.js      reports, duplicate merging, votes, expiry
  lib/providers.js    Photon search and Valhalla routing, speed limits, reports along a route
  lib/schema.js       database tables (kept in sync with migrations/)
test/                 node --test: navigation engine and the full API on an in-memory database
```

**API:**
- Accounts: `POST /api/auth/signup|login|logout`, `GET|PATCH|DELETE /api/me`
- Places: `GET|POST /api/places`, `PATCH|DELETE /api/places/:id`
- Search and routing: `GET /api/search`, `GET /api/reverse`, `POST /api/route`
- Reports: `GET|POST /api/reports`, `POST /api/reports/:id/vote`
- Shared drives: `POST /api/trips`, `PATCH|GET /api/trips/:token`
- `GET /api/leaderboard`

**Security:**
- Passwords are hashed with PBKDF2-SHA256 (100k iterations).
- Sessions are random tokens in HttpOnly, SameSite=Lax cookies, and only their hash is stored.
- Repeated wrong passwords are throttled.
- Writes must be JSON, which blocks cross-site form posts.
- A strict Content-Security-Policy is set in `public/_headers`.
- A daily cron job removes expired sessions and old shared drives.

## Known limits

- **No live traffic feed.** Drive times come from Valhalla's typical road speeds plus the traffic that A2B drivers
  report. Waze also uses its users' live speeds, and the same could be added later (see ideas above).
- **Phones pause web pages in the background.** Keep A2B on screen while driving (it keeps the screen awake). A native
  wrapper (e.g. Capacitor) would allow background navigation and CarPlay/Android Auto later.
- **Voices** are your phone's built-in text-to-speech voices.
- **Lane guidance** appears where OpenStreetMap has lane data for the junction. That's common on main roads and highways, patchier on small streets.
- **Offline maps** aren't built yet.

Always keep your eyes on the road, and only use the app when it is safe and legal.

## Contributing

Ideas, bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run A2B on
your computer, test a change and send it in. Code contributions need the [Contributor License Agreement](CLA.md): you keep your
copyright and A2B stays open source.

## Licence

A2B is free software under the [GNU Affero General Public License v3.0 or later](LICENSE). You can use, study, change
and share it. If you run a changed version for other people, over the internet included, you must offer them its
source code under the same licence. The app links to its source from **About**.

The map and place data have their own licences: map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
(ODbL); places and roads under construction from the [Overture Maps Foundation](https://overturemaps.org) (see
`public/places/NOTICE.txt` once built).
