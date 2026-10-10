// Reads Spotify and Google Takeout (YouTube Music) exports into a common shape:
//   { artist, track, time (ms since epoch or null), kind: "play" | "saved" }

const MIN_SPOTIFY_MS = 30000; // Spotify counts a stream after 30 seconds

// A loose key so "The Weeknd", "TheWeekndVEVO" and "The Weeknd - Topic" all match.
export function artistKey(name) {
  return cleanArtist(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/vevo$/, "")
    .replace(/^the(?=...)/, "");
}

export function cleanArtist(name) {
  return String(name || "").replace(/\s+-\s+Topic$/i, "").trim();
}

// Files worth opening inside a big export zip. Everything else is skipped.
const WANTED = [
  /watch-history\.(json|html)$/i,
  /StreamingHistory[^/]*\.json$/i,
  /Streaming_History_Audio[^/]*\.json$/i,
  /endsong[^/]*\.json$/i,
  /YourLibrary\.json$/i,
  /\.csv$/i, // checked by its columns; ones without an artist column are skipped quietly
];

export function isWantedName(name) {
  return WANTED.some((re) => re.test(name));
}

// Returns { service, label, entries } or null if the file isn't recognised.
export function parseFile(name, text, fallbackService) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return parseJson(text);
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return parseWatchHistoryHtml(text);
  if (lower.endsWith(".csv")) return parseAnyCsv(text, fallbackService);
  return null;
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }

  if (Array.isArray(data) && data.length) {
    const first = data.find((d) => d && typeof d === "object") || {};

    if ("msPlayed" in first && "artistName" in first) {
      const entries = data
        .filter((d) => d.artistName && d.msPlayed >= MIN_SPOTIFY_MS)
        .map((d) => ({ artist: d.artistName, track: d.trackName, time: toTime(d.endTime), kind: "play" }));
      return { service: "spotify", label: "Spotify streaming history", entries };
    }

    if ("ms_played" in first && ("master_metadata_album_artist_name" in first || "ts" in first)) {
      const entries = data
        .filter((d) => d.master_metadata_album_artist_name && d.ms_played >= MIN_SPOTIFY_MS)
        .map((d) => ({
          artist: d.master_metadata_album_artist_name,
          track: d.master_metadata_track_name,
          time: toTime(d.ts),
          kind: "play",
        }));
      return { service: "spotify", label: "Spotify extended streaming history", entries };
    }

    if ("header" in first || "titleUrl" in first || "subtitles" in first) {
      const entries = [];
      for (const d of data) {
        const isMusic = d.header === "YouTube Music" || /music\.youtube\.com/.test(d.titleUrl || "");
        const channel = d.subtitles && d.subtitles[0] && d.subtitles[0].name;
        if (!isMusic || !channel) continue;
        entries.push({
          artist: cleanArtist(channel),
          track: String(d.title || "").replace(/^Watched\s+/, ""),
          time: toTime(d.time),
          kind: "play",
        });
      }
      return { service: "youtube", label: "YouTube Music watch history", entries };
    }
  }

  if (data && Array.isArray(data.tracks)) {
    const entries = data.tracks
      .filter((t) => t.artist)
      .map((t) => ({ artist: t.artist, track: t.track, time: null, kind: "saved" }));
    return { service: "spotify", label: "Spotify saved library", entries };
  }

  return null;
}

// Takeout can give watch history as HTML instead of JSON.
function parseWatchHistoryHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const cells = doc.querySelectorAll(".outer-cell");
  if (!cells.length) return null;
  const entries = [];
  for (const cell of cells) {
    const header = cell.querySelector(".header-cell");
    const content = cell.querySelector(".content-cell");
    if (!content) continue;
    const links = content.querySelectorAll("a");
    const isMusic =
      (header && /YouTube Music/.test(header.textContent)) ||
      (links[0] && /music\.youtube\.com/.test(links[0].getAttribute("href") || ""));
    if (!isMusic || links.length < 2) continue;
    // The date is the last bare text line after the links.
    const dateText = [...content.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
      .map((n) => n.textContent.trim().replace(/\u202f/g, " "))
      .pop();
    entries.push({
      artist: cleanArtist(links[1].textContent),
      track: links[0].textContent.trim(),
      time: toTime(dateText),
      kind: "play",
    });
  }
  return { service: "youtube", label: "YouTube Music watch history", entries };
}

// CSVs come from several places, so columns are matched by name:
//  - Takeout "music library songs.csv" (YouTube Music saved songs)
//  - Exportify and similar Spotify playlist/liked-songs exports
//  - Spotify streaming history converted to CSV, or listening-history tools
// fallbackService is the box the file was dropped on, used when the columns don't say.
function parseAnyCsv(text, fallbackService) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) return null;
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_]+/g, " "));
  const col = (...names) => head.findIndex((h) => names.includes(h));

  const artistCol = col(
    "artist name 1", "artist name(s)", "artist names", "artist name", "artistname", "artist",
    "artists", "master metadata album artist name", "album artist name"
  );
  if (artistCol < 0) return null;
  const trackCol = col("track name", "trackname", "song title", "title", "track", "song", "master metadata track name");
  const msCol = col("ms played", "msplayed");
  const timeCol = col("ts", "endtime", "end time", "played at", "timestamp", "date", "time");

  let service = fallbackService;
  if (head.includes("artist name 1") || head.includes("video id")) service = "youtube";
  else if (head.some((h) => /spotify|track uri|artist uri|master metadata|msplayed|ms played/.test(h))) service = "spotify";

  // A play-time or play-date column means it's history; otherwise it's a list of saved songs.
  const isHistory = msCol >= 0 || timeCol >= 0;
  const entries = [];
  for (const r of rows.slice(1)) {
    const rawArtist = r[artistCol];
    if (!rawArtist) continue;
    if (msCol >= 0 && Number(r[msCol]) < MIN_SPOTIFY_MS) continue;
    entries.push({
      // Multi-artist cells ("A, B" or "A;B"): credit the first artist.
      artist: cleanArtist(rawArtist.split(/;|, (?=\S)/)[0]),
      track: trackCol >= 0 ? r[trackCol] : "",
      time: isHistory && timeCol >= 0 ? toTime(r[timeCol]) : null,
      kind: isHistory ? "play" : "saved",
    });
  }
  const name = NAMES[service];
  return { service, label: `${name} ${isHistory ? "listening history" : "saved songs"} (CSV)`, entries };
}

const NAMES = { spotify: "Spotify", youtube: "YouTube Music" };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toTime(value) {
  if (!value) return null;
  // Spotify's basic history uses "2023-05-01 14:03" in UTC.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? value.replace(" ", "T") + "Z" : value;
  let t = Date.parse(iso);
  // Takeout HTML dates end in a zone name ("EDT") that some browsers can't read.
  if (Number.isNaN(t)) t = Date.parse(String(iso).replace(/\s+[A-Z]{2,5}$/, ""));
  return Number.isNaN(t) ? null : t;
}
