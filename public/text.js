// Loose text matching shared by the app, the Worker and scripts/build-places.py: case, accents and
// apostrophes don't matter ("nandos" finds "Nando's", "cafe" finds "Café").

export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function words(s) {
  const t = normalizeText(s);
  return t ? t.split(' ') : [];
}

// Every word of the query appears somewhere in the text.
export function matches(text, query) {
  const hay = normalizeText(text);
  return words(query).every((w) => hay.includes(w));
}

// Every word of the query starts a word of the text ("nando" matches "Nando's Eco Grandeur").
export function matchesWordStarts(text, query) {
  const hay = words(text);
  return words(query).every((w) => hay.some((h) => h.startsWith(w)));
}
