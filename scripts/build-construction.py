#!/usr/bin/env python3
"""Builds the list of roads under construction that A2B checks routes against (see src/lib/construction.js).

Overture Maps' road network comes from OpenStreetMap and flags roads that are being built. This keeps those
roads for one country and writes their lines into public/construction/, one small JSON file per tile of
0.05 x 0.05 degrees (about 5.5 x 5.5 km), plus index.json listing the tiles that have any.

    pip install duckdb
    python3 scripts/build-construction.py                       # Malaysia, the release set below
    python3 scripts/build-construction.py --release 2026-11-18.0

Overture publishes a new release monthly: https://docs.overturemaps.org/release-calendar/
The data is OpenStreetMap's, under the ODbL: © OpenStreetMap contributors.
"""

import argparse
import json
import math
import os
import shutil
import sys
import time

DEFAULT_RELEASE = '2026-10-21.0'
TILE = 0.05
BOXES = {'MY': (99.5, 0.8, 119.5, 7.5)}  # west, south, east, north
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'construction')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--country', default='MY', choices=sorted(BOXES))
    ap.add_argument('--release', default=DEFAULT_RELEASE)
    args = ap.parse_args()
    import duckdb

    w, s, e, n = BOXES[args.country]
    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;')
    con.execute("CREATE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")
    src = f"read_parquet('s3://overturemaps-us-west-2/release/{args.release}/theme=transportation/type=segment/*', hive_partitioning=1)"
    print(f'Reading Overture {args.release} roads under construction for {args.country}…', file=sys.stderr)
    t = time.time()
    rows = con.execute(f"""
        SELECT ST_AsGeoJSON(geometry)
        FROM {src}
        WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
          AND subtype = 'road'
          AND list_contains(flatten(list_transform(road_flags, lambda f: f."values")), 'is_under_construction')
    """).fetchall()
    print(f'  {len(rows):,} roads in {time.time() - t:.0f}s', file=sys.stderr)

    tiles = {}
    for (geojson,) in rows:
        line = [[round(x, 6), round(y, 6)] for x, y in json.loads(geojson)['coordinates']]
        # A road crossing tiles goes in each one it touches, so a route sees it from either side.
        for key in {f'{math.floor(x / TILE)}_{math.floor(y / TILE)}' for x, y in line}:
            tiles.setdefault(key, []).append(line)

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    for key, lines in tiles.items():
        with open(os.path.join(OUT, f'{key}.json'), 'w') as f:
            json.dump(lines, f, separators=(',', ':'))
    with open(os.path.join(OUT, 'index.json'), 'w') as f:
        json.dump({'source': 'Overture Maps Foundation transportation (OpenStreetMap, ODbL)', 'release': args.release,
                   'country': args.country, 'built': time.strftime('%Y-%m-%d'), 'tile': TILE, 'roads': len(rows),
                   'tiles': sorted(tiles)}, f, separators=(',', ':'))
    print(f'  {len(tiles):,} tiles; wrote {os.path.abspath(OUT)}', file=sys.stderr)


if __name__ == '__main__':
    main()
