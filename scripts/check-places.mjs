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
