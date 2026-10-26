// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Runs before `npm run deploy`: warns when the Overture place files (public/places/, not kept in git)
// haven't been built, because search then only has OpenStreetMap's places.
import { existsSync, readFileSync } from 'node:fs';

const index = new URL('../public/places/index.json', import.meta.url);
if (!existsSync(index)) {
  console.warn('\n⚠  No place data in public/places/. Search will only use OpenStreetMap.');
  console.warn('   Build it first: pip install duckdb && npm run places\n');
} else {
  const { release, count, built } = JSON.parse(readFileSync(index, 'utf8'));
  console.log(`Place data: Overture ${release}, ${count.toLocaleString()} places, built ${built}.`);
}

const roads = new URL('../public/construction/index.json', import.meta.url);
if (existsSync(roads)) {
  const { release, roads: n } = JSON.parse(readFileSync(roads, 'utf8'));
  console.log(`Roads under construction: Overture ${release}, ${n.toLocaleString()} roads.`);
} else {
  console.warn('\n⚠  No construction road data in public/construction/. Routes won\'t be checked for roadworks.');
  console.warn('   Build it first: pip install duckdb && npm run construction\n');
}
