#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).
"""Builds A2B's own place search (the locations table, see src/lib/locations.js) from Overture Maps.

Takes one country's shops and landmarks (Overture places, OpenStreetMap ones included), its named streets (one
entry per street per neighbourhood) and its addresses, and writes them as SQL files that load into D1. Places that
drivers added are kept on a reload. OpenStreetMap data comes under the ODbL: A2B credits it in About, and the
database itself isn't shared.

    pip install duckdb
    python3 scripts/build-locations.py                     # writes data/locations/*.sql
    python3 scripts/build-locations.py --load local        # and loads them into `wrangler dev`'s database
    python3 scripts/build-locations.py --load remote       # the live database (owner only)

Overture publishes a new release monthly: https://docs.overturemaps.org/release-calendar/
"""
import argparse
import glob
import os
import subprocess
import sys
import time

DEFAULT_RELEASE = '2026-10-21.0'
COUNTRY_BOXES = {'MY': (99.5, 0.8, 119.5, 7.5), 'SG': (103.55, 1.15, 104.1, 1.5), 'BN': (114.0, 4.0, 115.4, 5.1)}
ROWS_PER_INSERT = 300  # keeps each statement well under D1's size limit
ROWS_PER_FILE = 30_000
# Overture categories that read as landmarks (and get found from further away).
LANDMARKS = {
    'shopping_center', 'shopping_mall', 'train_station', 'metro_station', 'bus_station', 'airport', 'hospital', 'park',
    'university', 'college_university', 'mosque', 'hindu_temple', 'buddhist_temple', 'church', 'stadium', 'museum',
    'landmark_and_historical_building', 'tourist_attraction', 'convention_center', 'zoo', 'beach', 'theme_park',
}
SKIP_ROADS = "('footway', 'path', 'steps', 'cycleway', 'pedestrian', 'bridleway', 'track', 'unknown')"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--release', default=DEFAULT_RELEASE)
    ap.add_argument('--country', default='MY')
    ap.add_argument('--min-confidence', type=float, default=0.6)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'locations'))
    ap.add_argument('--load', choices=['local', 'remote'], help='load the SQL files into D1 with wrangler')
    args = ap.parse_args()
    try:
        import duckdb
    except ImportError:
        sys.exit('Needs DuckDB: pip install duckdb')
    box = COUNTRY_BOXES.get(args.country)
    if not box:
        sys.exit(f'No bounding box for {args.country}; add one to COUNTRY_BOXES.')
    w, s, e, n = box
    in_box = f'bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}'
    base = f's3://overturemaps-us-west-2/release/{args.release}'

    con = duckdb.connect()
    con.execute('INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;')
    con.execute("CREATE SECRET overture (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2')")

    def step(label, sql, params=()):
        t0 = time.time()
        rows = con.execute(sql, list(params)).fetchall()
        print(f'  {label}: {len(rows):,} in {time.time() - t0:.0f}s', flush=True)
        return rows

    print(f'Overture {args.release}, {args.country}', flush=True)
    # The country's outline: streets, and OpenStreetMap places, carry no country of their own.
    con.execute(f"""
        CREATE TABLE outline AS SELECT geometry FROM read_parquet('{base}/theme=divisions/type=division_area/*', hive_partitioning=1)
        WHERE subtype = 'country' AND country = '{args.country}' AND {in_box}
    """)
    inside = 'EXISTS (SELECT 1 FROM outline o WHERE ST_Contains(o.geometry, ST_Point({lng}, {lat})))'
    places = step('shops and landmarks', f"""
        WITH p AS (
          SELECT names.primary AS name,
                 coalesce(addresses[1].freeform, '') || CASE WHEN addresses[1].locality IS NULL THEN '' ELSE ', ' || addresses[1].locality END AS address,
                 coalesce(basic_category, taxonomy.primary, '') AS category, (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lng,
                 contains(CAST(sources AS VARCHAR), 'OpenStreetMap') AS osm, addresses[1].country AS country
          FROM read_parquet('{base}/theme=places/type=place/*', hive_partitioning=1)
          WHERE {in_box} AND confidence >= ? AND names.primary IS NOT NULL
            AND coalesce(operating_status, 'open') NOT IN ('permanently_closed', 'temporarily_closed', 'closed')
            AND (addresses[1].country = ? OR addresses[1].country IS NULL)
        )
        SELECT name, address, category, lat, lng, CASE WHEN osm THEN 'osm' ELSE 'overture' END FROM p
        WHERE country = ? OR {inside.format(lng='p.lng', lat='p.lat')}
    """, [args.min_confidence, args.country, args.country])

    streets = step('named streets', f"""
        WITH seg AS (
          SELECT names.primary AS name, (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lng
          FROM read_parquet('{base}/theme=transportation/type=segment/*', hive_partitioning=1)
          WHERE {in_box} AND subtype = 'road' AND names.primary IS NOT NULL AND coalesce(class, 'unknown') NOT IN {SKIP_ROADS}
        )
        SELECT any_value(name), '', 'street', avg(lat), avg(lng), 'osm'
        FROM seg WHERE {inside.format(lng='seg.lng', lat='seg.lat')}
        GROUP BY lower(name), round(lat * 20), round(lng * 20)
    """)
    addresses = step('addresses', f"""
        SELECT trim(coalesce(number, '') || CASE WHEN number IS NULL THEN '' ELSE ', ' END || coalesce(street, '')),
               trim(coalesce(postcode, '') || ' ' || coalesce(postal_city, '')), 'address',
               (bbox.ymin + bbox.ymax) / 2, (bbox.xmin + bbox.xmax) / 2, 'overture'
        FROM read_parquet('{base}/theme=addresses/type=address/*', hive_partitioning=1)
        WHERE {in_box} AND country = ? AND street IS NOT NULL
    """, [args.country])

    rows = [(name, addr, cat, 'landmark' if cat in LANDMARKS else 'place', lat, lng, src) for name, addr, cat, lat, lng, src in places]
    rows += [(name, addr, cat, 'street', lat, lng, src) for name, addr, cat, lat, lng, src in streets]
    rows += [(name, addr, cat, 'address', lat, lng, src) for name, addr, cat, lat, lng, src in addresses]
    write(rows, os.path.abspath(args.out))
    if args.load:
        load(os.path.abspath(args.out), args.load)


def sql_text(v):
    return "'" + str(v).replace("'", "''")[:120] + "'"


def write(rows, out):
    os.makedirs(out, exist_ok=True)
    for f in glob.glob(os.path.join(out, '*.sql')):
        os.remove(f)
    now = int(time.time() * 1000)
    files = [rows[i:i + ROWS_PER_FILE] for i in range(0, len(rows), ROWS_PER_FILE)]
    with open(os.path.join(out, '000-clear.sql'), 'w') as f:
        f.write("DELETE FROM locations WHERE source != 'driver';\n")  # drivers' places stay
    for k, chunk in enumerate(files, 1):
        with open(os.path.join(out, f'{k:03d}-rows.sql'), 'w', encoding='utf-8') as f:
            for i in range(0, len(chunk), ROWS_PER_INSERT):
                values = ',\n'.join(
                    f"({sql_text(n)},{sql_text(a)},{sql_text(c)},'{kind}',{lat:.6f},{lng:.6f},'{src}',{now})"
                    for n, a, c, kind, lat, lng, src in chunk[i:i + ROWS_PER_INSERT]
                )
                f.write(f'INSERT INTO locations (name, address, category, kind, lat, lng, source, created_at) VALUES\n{values};\n')
    with open(os.path.join(out, f'{len(files) + 1:03d}-index.sql'), 'w') as f:
        f.write("INSERT INTO locations_fts (locations_fts) VALUES ('rebuild');\n")
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(out, '*.sql')))
    print(f'Wrote {len(rows):,} locations in {len(files) + 2} files ({size / 1e6:.0f} MB) to {out}', flush=True)


def load(out, where):
    root = os.path.join(os.path.dirname(__file__), '..')
    for path in sorted(glob.glob(os.path.join(out, '*.sql'))):
        print(f'Loading {os.path.basename(path)} into the {where} database…', flush=True)
        subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'a2b', f'--{where}', '--yes', f'--file={path}'], cwd=root, check=True,
                       stdout=subprocess.DEVNULL)
    print('Loaded.')


if __name__ == '__main__':
    main()
