// Looks up genres for artists from a third-party music database.
// MusicBrainz needs no key but allows about one request a second.
// Last.fm is faster and has richer tags, but needs a free API key.

const CACHE_PREFIX = "music-compare:genres:v1:";
const MAX_TAGS_PER_ARTIST = 6;

// Tags people use that aren't genres.
const NOT_GENRES = new Set([
  "seen live", "favorites", "favourites", "favorite", "favourite", "awesome", "love", "beautiful",
  "female vocalists", "male vocalists", "female vocalist", "male vocalist", "female", "male",
  "british", "american", "uk", "usa", "english", "canadian", "australian", "german", "french",
  "swedish", "irish", "scottish", "korean", "japanese", "spanish", "italian", "brazilian",
  "mexican", "dutch", "norwegian", "finnish", "danish", "icelandic", "russian", "polish",
  "my music", "check out", "spotify", "under 2000 listeners", "all", "music", "good",
  "singer-songwriter-ish", "chill", "sexy", "cover", "covers", "instrumental", "live",
  "producer", "dj", "composer", "rapper", "singer", "band", "group", "duo", "artist",
]);

const SYNONYMS = {
  "hip-hop": "hip hop", hiphop: "hip hop", "rap & hip hop": "hip hop",
  rnb: "r&b", "r and b": "r&b", "rhythm and blues": "r&b", "r'n'b": "r&b", "rhythm & blues": "r&b",
  "contemporary r&b": "r&b", "alternative rock": "alternative rock", alternative: "alternative",
  electronica: "electronic", "edm": "electronic dance music",
  "k-pop": "k-pop", kpop: "k-pop", "j-pop": "j-pop", jpop: "j-pop",
  "lo-fi": "lo-fi", lofi: "lo-fi", "synth-pop": "synthpop", "synth pop": "synthpop",
  "indie-pop": "indie pop", "indie-rock": "indie rock", "post-punk": "post-punk", "post punk": "post-punk",
  "trap latino": "latin trap", "drum n bass": "drum and bass", "drum & bass": "drum and bass", dnb: "drum and bass",
  "singer/songwriter": "singer-songwriter", "singer songwriter": "singer-songwriter",
};

// Broad families, checked in order; the first match wins.
const FAMILIES = [
  ["Hip hop & rap", /hip hop|rap|trap|drill|grime|boom bap|phonk/],
  ["R&B & soul", /r&b|soul|neo soul|funk|motown|quiet storm|new jack/],
  ["Metal", /metal|metalcore|deathcore|djent|thrash|doom|sludge/],
  ["Punk & hardcore", /punk|hardcore|emo|screamo|pop punk|ska/],
  ["Rock", /rock|grunge|shoegaze|britpop|post-punk|psychedel|garage|stoner|new wave/],
  ["Electronic & dance", /electro|house|techno|trance|dubstep|drum and bass|edm|dance|ambient|idm|synthwave|bass music|garage|breakbeat|downtempo|trip hop|lo-fi|vaporwave|hyperpop|electronic/],
  ["Jazz & blues", /jazz|blues|swing|bebop|bossa/],
  ["Classical & score", /classical|baroque|orchestra|opera|soundtrack|score|film|video game|piano|minimalism|contemporary classical/],
  ["Country & folk", /country|folk|americana|bluegrass|singer-songwriter|acoustic/],
  ["Latin", /latin|reggaeton|salsa|bachata|cumbia|corrido|regional mexican|banda|dembow|mpb|sertanejo|tango|flamenco/],
  ["Reggae & Afro", /reggae|dancehall|dub|afro|amapiano|highlife|soca/],
  ["Pop", /pop|k-pop|j-pop|idol|teen|bubblegum/],
  ["Indie & alternative", /indie|alternative|bedroom|dream/],
  ["Gospel & worship", /gospel|worship|christian|ccm/],
];

export function familyOf(genre) {
  for (const [name, re] of FAMILIES) if (re.test(genre)) return name;
  return "Other";
}

function cleanTag(raw) {
  let t = String(raw || "").toLowerCase().trim().replace(/\s+/g, " ");
  t = SYNONYMS[t] || t;
  if (!t || t.length > 40 || NOT_GENRES.has(t)) return null;
  if (/^\d0s$|^\d{4}s?$|^\d{2}s$/.test(t)) return null; // decades and years
  return t;
}

// [{name, count}] -> {genre: weight}, weights summing to 1.
function toWeights(tags) {
  const merged = new Map();
  for (const tag of tags) {
    const name = cleanTag(tag.name);
    const count = Number(tag.count) || 0;
    if (!name || count <= 0) continue;
    merged.set(name, (merged.get(name) || 0) + count);
  }
  const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return {};
  const top = sorted[0][1];
  // Drop the long tail of one-off tags.
  const kept = sorted.filter(([, c]) => c >= top * 0.1).slice(0, MAX_TAGS_PER_ARTIST);
  const total = kept.reduce((s, [, c]) => s + c, 0);
  return Object.fromEntries(kept.map(([n, c]) => [n, c / total]));
}

function cacheGet(source, key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + source + ":" + key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function cacheSet(source, key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + source + ":" + key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: lookups just won't be remembered */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.ok) return res.json();
    if (res.status === 503 || res.status === 429) {
      await sleep(1500 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error("rate limited");
}

async function musicBrainzTags(name) {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
  const data = await fetchJson(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=3`);
  const artists = (data.artists || []).filter((a) => a.score >= 90);
  // Prefer an exact-name hit that has tags.
  const pick =
    artists.find((a) => a.name.toLowerCase() === name.toLowerCase() && a.tags && a.tags.length) ||
    artists.find((a) => a.tags && a.tags.length);
  return pick ? pick.tags : [];
}

async function lastFmTags(name, apiKey) {
  const url =
    "https://ws.audioscrobbler.com/2.0/?method=artist.gettoptags&autocorrect=1&format=json" +
    `&artist=${encodeURIComponent(name)}&api_key=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  if (data.error) {
    if (data.error === 10 || data.error === 26) throw new Error("Last.fm rejected the API key");
    return [];
  }
  return (data.toptags && data.toptags.tag) || [];
}

// artists: [{key, name}]. Calls onProgress(done, total) as it goes.
// Resolves to Map(key -> {genre: weight}); an empty object means nothing was found.
export async function lookupGenres(artists, { source, apiKey, onProgress, signal }) {
  const result = new Map();
  const todo = [];
  for (const a of artists) {
    const hit = cacheGet(source, a.key);
    if (hit !== undefined) result.set(a.key, hit);
    else todo.push(a);
  }
  let done = artists.length - todo.length;
  onProgress(done, artists.length);

  const lookupOne = async (a) => {
    try {
      const tags = source === "lastfm" ? await lastFmTags(a.name, apiKey) : await musicBrainzTags(a.name);
      const weights = toWeights(tags);
      result.set(a.key, weights);
      cacheSet(source, a.key, weights);
    } catch (err) {
      if (/API key/.test(err.message)) throw err;
      result.set(a.key, {}); // network hiccup: leave it out, don't cache
    }
    onProgress(++done, artists.length);
  };

  if (source === "lastfm") {
    // A few at a time stays well within Last.fm's limits.
    const queue = [...todo];
    const worker = async () => {
      while (queue.length && !signal.aborted) await lookupOne(queue.shift());
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } else {
    for (const a of todo) {
      if (signal.aborted) break;
      const started = Date.now();
      await lookupOne(a);
      const wait = 1100 - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  }
  return result;
}
