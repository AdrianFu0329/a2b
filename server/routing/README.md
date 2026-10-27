# A2B's own routing server

[Valhalla](https://github.com/valhalla/valhalla), the routing engine A2B already uses, run ourselves with
OpenStreetMap's roads for Malaysia, Singapore and Brunei. Routes, turn-by-turn, lanes, speed limits, toll booths,
alternatives and walking all work as they do with the public server, with no outside service, no per-request cost
and no fair-use cap.

```bash
cd server/routing
docker compose up -d              # first start downloads the map (~300 MB) and builds routing tiles (~20-40 min)
docker compose logs -f            # wait for the server to start listening
curl localhost:8002/status
```

Point A2B at it with `ROUTING_URL` in `wrangler.toml` (or `.dev.vars` locally): `http://localhost:8002/route` on this
computer, or `https://<your server>/route` once it runs on a server with HTTPS in front.

To pick up OpenStreetMap's changes, rebuild monthly: `docker compose down`, delete `data/valhalla_tiles*`, and start
again. A small server is enough for these countries: 2 CPUs and 4 GB of memory (8 GB while building).

Map data © OpenStreetMap contributors, ODbL.
