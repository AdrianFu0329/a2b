// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// Runs before `npm run deploy`: writes public/version.json, a fingerprint of the app's own files, so an open app
// can tell that a newer one is out (public/update.js). Only the app's files count, so a server-only deploy or
// new map data doesn't ask anyone to refresh.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../public/', import.meta.url);
const hash = createHash('sha256');
for (const name of readdirSync(dir).filter((n) => /\.(js|css|html|webmanifest|svg)$/.test(n)).sort()) {
  hash.update(name).update(readFileSync(new URL(name, dir)));
}
const v = hash.digest('hex').slice(0, 12);
writeFileSync(new URL('version.json', dir), `${JSON.stringify({ v })}\n`);
console.log(`App version: ${v}`);
