// Turns parsed entries into per-service profiles and compares them.

import { artistKey, cleanArtist } from "./parsers.js";
import { familyOf } from "./genres.js";

// entries -> { plays, usesSaved, artists: Map(key -> {key, name, count, tracks}), first, last }
// Play history is preferred; a saved library only counts when there's no history.
export function buildProfile(entries, range) {
  const plays = entries.filter((e) => e.kind === "play");
  const usesSaved = plays.length === 0;
  let used = usesSaved ? entries : plays;
  if (range && !usesSaved) used = used.filter((e) => e.time != null && e.time >= range[0] && e.time <= range[1]);

  const artists = new Map();
  let first = Infinity;
  let last = -Infinity;
  for (const e of used) {
    const key = artistKey(e.artist);
    if (!key) continue;
    const a = artists.get(key) || { key, name: cleanArtist(e.artist), count: 0, tracks: new Map() };
    a.count++;
    const title = String(e.track || "").trim();
    if (title) a.tracks.set(title, (a.tracks.get(title) || 0) + 1);
    artists.set(key, a);
    if (e.time != null) {
      if (e.time < first) first = e.time;
      if (e.time > last) last = e.time;
    }
  }
  const total = [...artists.values()].reduce((s, a) => s + a.count, 0);
  return {
    total,
    usesSaved,
    artists,
    first: Number.isFinite(first) ? first : null,
    last: Number.isFinite(last) ? last : null,
  };
}

export function dateSpan(entries) {
  let first = Infinity;
  let last = -Infinity;
  for (const e of entries) {
    if (e.kind !== "play" || e.time == null) continue;
    if (e.time < first) first = e.time;
    if (e.time > last) last = e.time;
  }
  return Number.isFinite(first) ? [first, last] : null;
}

export function topArtists(profile, n) {
  return [...profile.artists.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

// Share-of-listening per genre, using only artists we found genres for.
// Returns { genres: Map(genre -> share), families: Map, coverage }.
function genreProfile(profile, genreMap) {
  const genres = new Map();
  let covered = 0;
  for (const a of profile.artists.values()) {
    const weights = genreMap.get(a.key);
    if (!weights || !Object.keys(weights).length) continue;
    covered += a.count;
    for (const [g, w] of Object.entries(weights)) genres.set(g, (genres.get(g) || 0) + a.count * w);
  }
  const genreShares = normalise(genres, covered);
  const families = new Map();
  for (const [g, share] of genreShares) {
    const f = familyOf(g);
    families.set(f, (families.get(f) || 0) + share);
  }
  return { genres: genreShares, families, coverage: profile.total ? covered / profile.total : 0 };
}

function normalise(map, total) {
  const out = new Map();
  if (!total) return out;
  for (const [k, v] of map) out.set(k, v / total);
  return out;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    if (b.has(k)) dot += v * b.get(k);
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Sum of the smaller share for each genre/artist: how much of the listening is "in common".
function overlap(a, b) {
  let sum = 0;
  for (const [k, v] of a) if (b.has(k)) sum += Math.min(v, b.get(k));
  return sum;
}

export function compare(spotify, youtube, genreMap) {
  const sg = genreProfile(spotify, genreMap);
  const yg = genreProfile(youtube, genreMap);

  const sArtists = normalise(new Map([...spotify.artists].map(([k, a]) => [k, a.count])), spotify.total);
  const yArtists = normalise(new Map([...youtube.artists].map(([k, a]) => [k, a.count])), youtube.total);

  const genreScore = cosine(sg.genres, yg.genres);
  const familyScore = overlap(sg.families, yg.families);
  const artistScore = overlap(sArtists, yArtists);
  const overall = 0.45 * genreScore + 0.3 * familyScore + 0.25 * artistScore;

  const allGenres = new Set([...sg.genres.keys(), ...yg.genres.keys()]);
  const genreRows = [...allGenres]
    .map((g) => ({ genre: g, family: familyOf(g), spotify: sg.genres.get(g) || 0, youtube: yg.genres.get(g) || 0 }))
    .sort((a, b) => b.spotify + b.youtube - (a.spotify + a.youtube));

  const allFamilies = new Set([...sg.families.keys(), ...yg.families.keys()]);
  const familyRows = [...allFamilies]
    .map((f) => ({ genre: f, spotify: sg.families.get(f) || 0, youtube: yg.families.get(f) || 0 }))
    .sort((a, b) => b.spotify + b.youtube - (a.spotify + a.youtube));

  const shared = [];
  const onlySpotify = [];
  const onlyYoutube = [];
  for (const [k, a] of spotify.artists) {
    const y = youtube.artists.get(k);
    if (y) shared.push({ name: a.name, key: k, spotify: sArtists.get(k), youtube: yArtists.get(k) });
    else onlySpotify.push({ name: a.name, key: k, share: sArtists.get(k) });
  }
  for (const [k, a] of youtube.artists) {
    if (!spotify.artists.has(k)) onlyYoutube.push({ name: a.name, key: k, share: yArtists.get(k) });
  }
  shared.sort((a, b) => b.spotify + b.youtube - (a.spotify + a.youtube));
  onlySpotify.sort((a, b) => b.share - a.share);
  onlyYoutube.sort((a, b) => b.share - a.share);

  return {
    scores: { overall, genreScore, familyScore, artistScore },
    coverage: { spotify: sg.coverage, youtube: yg.coverage },
    genreRows,
    familyRows,
    shared,
    onlySpotify,
    onlyYoutube,
    sharedCount: shared.length,
  };
}

// Artists in `from`'s library that `to` doesn't play but whose genres match `to`'s taste.
// Each comes with `from`'s most-played song by that artist.
export function crossRecommend(to, from, genreMap, limit = 8) {
  const taste = genreProfile(to, genreMap).genres;
  const picks = [];
  for (const a of from.artists.values()) {
    if (to.artists.has(a.key)) continue;
    const weights = genreMap.get(a.key);
    if (!weights || !Object.keys(weights).length) continue;
    const fit = cosine(new Map(Object.entries(weights)), taste);
    if (fit < 0.25) continue;
    // The genres doing the matching, strongest first.
    const why = Object.entries(weights)
      .filter(([g]) => taste.has(g))
      .sort((x, y) => y[1] * taste.get(y[0]) - x[1] * taste.get(x[0]))
      .slice(0, 2)
      .map(([g]) => g);
    picks.push({ name: a.name, key: a.key, song: topTrack(a), why, score: fit * Math.log(1 + a.count) });
  }
  return picks.sort((x, y) => y.score - x.score).slice(0, limit);
}

function topTrack(artist) {
  let best = "";
  let most = 0;
  for (const [title, n] of artist.tracks || []) if (n > most) { best = title; most = n; }
  return best;
}
