// Prints the newest Overture Maps release that has both places and road segments published, e.g. 2026-11-18.0.
// Used by the monthly data update (see README, Monthly updates); reads Overture's public S3 bucket listing.

const BUCKET = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/';
const NEEDS = ['theme=places/type=place/', 'theme=transportation/type=segment/'];

async function list(prefix, extra = '') {
  const res = await fetch(`${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${extra}`);
  if (!res.ok) throw new Error(`Overture listing failed (${res.status})`);
  return res.text();
}

const xml = await list('release/', '&delimiter=/');
const releases = [...xml.matchAll(/<Prefix>release\/([^/<]+)\/<\/Prefix>/g)].map((m) => m[1]).sort().reverse();
for (const release of releases) {
  const ready = await Promise.all(NEEDS.map(async (p) => (await list(`release/${release}/${p}`, '&max-keys=1')).includes('<Key>')));
  if (ready.every(Boolean)) {
    console.log(release);
    process.exit(0);
  }
}
console.error('No complete Overture release found.');
process.exit(1);
