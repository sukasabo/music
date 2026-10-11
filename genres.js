// Looks up genres for artists from a third-party music database.
// MusicBrainz needs no key but allows about one request a second.
// Last.fm is faster and has richer tags, but needs a free API key.

const CACHE_PREFIX = "music-compare:genres:v2:";
// Lookups from the first version: kept when they found genres, retried when they didn't.
const OLD_CACHE_PREFIX = "music-compare:genres:v1:";
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
  "gen z", "millennial", "tiktok", "viral", "spotify singles",
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
    if (raw) return JSON.parse(raw);
    const old = JSON.parse(localStorage.getItem(OLD_CACHE_PREFIX + source + ":" + key) || "null");
    return old && Object.keys(old).length ? old : undefined;
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

// MusicBrainz allows about one request a second, across all calls.
let mbNext = 0;
async function mbFetch(url) {
  const wait = mbNext - Date.now();
  if (wait > 0) await sleep(wait);
  mbNext = Date.now() + 1100;
  return fetchJson(url);
}

async function musicBrainzTags(name) {
  const q = encodeURIComponent(`artist:"${name.replace(/"/g, "")}"`);
  const data = await mbFetch(`https://musicbrainz.org/ws/2/artist/?query=${q}&fmt=json&limit=5`);
  const artists = (data.artists || []).filter((a) => a.score >= 85);
  const exact = artists.filter((a) => a.name.toLowerCase() === name.toLowerCase());
  const pool = exact.length ? exact : artists;
  const tagged = pool.find((a) => a.tags && a.tags.length);
  if (tagged) return tagged.tags;
  // Search results often leave tags out; the full record has curated genres too.
  if (!pool.length) return [];
  const full = await mbFetch(`https://musicbrainz.org/ws/2/artist/${pool[0].id}?inc=genres+tags&fmt=json`);
  return full.genres && full.genres.length ? full.genres : full.tags || [];
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
      await lookupOne(a); // mbFetch keeps to the rate limit
    }
  }
  return result;
}

// New artists for two people: Last.fm's similar artists for the ones they share,
// minus anyone either of them already plays. Needs a Last.fm key.
export async function discoverSimilar(seeds, known, keyOf, apiKey, limit = 10) {
  const base = "https://ws.audioscrobbler.com/2.0/?format=json&autocorrect=1" + `&api_key=${encodeURIComponent(apiKey)}`;
  const pool = new Map();
  for (const seed of seeds) {
    let data;
    try {
      data = await fetchJson(`${base}&method=artist.getsimilar&limit=40&artist=${encodeURIComponent(seed)}`);
    } catch {
      continue;
    }
    for (const s of (data.similarartists && data.similarartists.artist) || []) {
      const key = keyOf(s.name);
      if (!key || known.has(key)) continue;
      const p = pool.get(key) || { name: s.name, score: 0, why: [] };
      p.score += Number(s.match) || 0;
      if (p.why.length < 2) p.why.push(seed);
      pool.set(key, p);
    }
  }
  const top = [...pool.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  await Promise.all(
    top.map(async (p) => {
      try {
        const d = await fetchJson(`${base}&method=artist.gettoptracks&limit=1&artist=${encodeURIComponent(p.name)}`);
        p.song = (d.toptracks && d.toptracks.track && d.toptracks.track[0] && d.toptracks.track[0].name) || "";
      } catch {
        p.song = "";
      }
    }),
  );
  return top;
}
