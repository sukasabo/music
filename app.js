import { parseFile, isWantedName } from "./parsers.js";
import { lookupGenres } from "./genres.js";
import { buildProfile, dateSpan, topArtists, compare } from "./compare.js";

const NAMES = { spotify: "Spotify", youtube: "YouTube Music" };
const CHART_ROWS = 15;

// service -> [{ name, label, entries }]
const loaded = { spotify: [], youtube: [] };
let lastResult = null;
let lastGenres = null;
let view = "genres";
let controller = null;

const $ = (sel) => document.querySelector(sel);
const statusEl = $("#status");

/* ---------- Loading files ---------- */

for (const zone of document.querySelectorAll(".drop")) {
  const input = zone.querySelector("input");
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => { addFiles([...input.files], zone.dataset.service); input.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    addFiles([...e.dataTransfer.files], zone.dataset.service);
  });
}

async function addFiles(files, zoneService) {
  for (const file of files) {
    setStatus(`Reading ${file.name}…`);
    try {
      if (/\.zip$/i.test(file.name)) await addZip(file, zoneService);
      else addParsed(file.name, parseFile(file.name, await file.text(), zoneService), zoneService);
    } catch (err) {
      markBad(zoneService, file.name, "couldn't be read");
      console.error(err);
    }
  }
  setStatus("");
  refreshReady();
}

async function addZip(file, zoneService) {
  if (!window.JSZip) throw new Error("JSZip didn't load");
  const zip = await window.JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && isWantedName(n));
  if (!names.length) {
    markBad(zoneService, file.name, "no listening history inside");
    return;
  }
  let found = 0;
  for (const n of names) {
    setStatus(`Reading ${n.split("/").pop()}…`);
    const parsed = parseFile(n, await zip.files[n].async("string"), zoneService);
    // Big exports hold plenty of unrelated files, so only report on the ones that matched.
    if (parsed && parsed.entries.length) {
      addParsed(n, parsed, zoneService);
      found++;
    }
  }
  if (!found) markBad(zoneService, file.name, "no listening history inside");
}

function addParsed(path, parsed, zoneService) {
  const name = path.split("/").pop();
  if (!parsed || !parsed.entries.length) {
    markBad(zoneService, name, parsed ? "no music plays found" : "not a recognised export");
    return;
  }
  // Files land with the service they belong to, whichever box they were dropped on.
  const list = loaded[parsed.service];
  if (list.some((f) => f.name === name && f.entries.length === parsed.entries.length)) return;
  list.push({ name, label: parsed.label, entries: parsed.entries });
  renderFiles(parsed.service);
}

const badFiles = { spotify: [], youtube: [] };
function markBad(service, name, why) {
  badFiles[service].push({ name, why });
  renderFiles(service);
}

function renderFiles(service) {
  const zone = document.querySelector(`.drop[data-service="${service}"]`);
  const ul = zone.querySelector(".files");
  ul.replaceChildren();
  for (const f of loaded[service]) {
    const n = f.entries.length;
    const unit = f.entries[0].kind === "saved" ? "song" : "play";
    ul.append(li(f.label, `${n.toLocaleString()} ${unit}${n === 1 ? "" : "s"}`, f.name));
  }
  for (const f of badFiles[service]) {
    const item = li(f.name, f.why);
    item.classList.add("bad");
    ul.append(item);
  }
  zone.classList.toggle("loaded", loaded[service].length > 0);
}

function li(text, count, title) {
  const item = document.createElement("li");
  const a = document.createElement("span");
  a.textContent = text;
  if (title) a.title = title;
  const b = document.createElement("span");
  b.className = "count";
  b.textContent = count;
  item.append(a, b);
  return item;
}

function entriesFor(service) {
  return loaded[service].flatMap((f) => f.entries);
}

function sharedRange() {
  const a = dateSpan(entriesFor("spotify"));
  const b = dateSpan(entriesFor("youtube"));
  if (!a || !b) return null;
  const start = Math.max(a[0], b[0]);
  const end = Math.min(a[1], b[1]);
  return start < end ? [start, end] : null;
}

function refreshReady() {
  const ready = loaded.spotify.length > 0 && loaded.youtube.length > 0;
  $("#go").disabled = !ready;
  const range = ready ? sharedRange() : null;
  $("#range-wrap").hidden = !range;
  if (range) $("#range-text").textContent = `(${fmtDate(range[0])} to ${fmtDate(range[1])})`;
  if (!ready) {
    const missing = Object.keys(loaded).filter((s) => !loaded[s].length).map((s) => NAMES[s]);
    setStatus(missing.length < 2 ? `Add your ${missing[0]} export to compare.` : "");
  }
}

/* ---------- Options ---------- */

const sourceEl = $("#source");
const keyEl = $("#apikey");
try {
  keyEl.value = localStorage.getItem("music-compare:lastfm-key") || "";
  if (keyEl.value) sourceEl.value = "lastfm";
} catch { /* storage blocked */ }
const syncSource = () => { $("#key-wrap").hidden = sourceEl.value !== "lastfm"; };
sourceEl.addEventListener("change", syncSource);
syncSource();

/* ---------- Running the comparison ---------- */

$("#go").addEventListener("click", run);
$("#stop").addEventListener("click", () => controller && controller.abort());

async function run() {
  const source = sourceEl.value;
  const apiKey = keyEl.value.trim();
  if (source === "lastfm" && !apiKey) {
    setStatus("Paste a Last.fm API key, or switch to MusicBrainz.");
    keyEl.focus();
    return;
  }
  if (apiKey) try { localStorage.setItem("music-compare:lastfm-key", apiKey); } catch { /* ignore */ }

  const range = !$("#range-wrap").hidden && $("#same-range").checked ? sharedRange() : null;
  const spotify = buildProfile(entriesFor("spotify"), range);
  const youtube = buildProfile(entriesFor("youtube"), range);
  if (!spotify.total || !youtube.total) {
    setStatus("One of the services has no plays in that date range. Untick the date option and try again.");
    return;
  }

  const n = Number($("#topn").value);
  const wanted = new Map();
  for (const a of [...topArtists(spotify, n), ...topArtists(youtube, n)]) if (!wanted.has(a.key)) wanted.set(a.key, a);

  controller = new AbortController();
  $("#go").disabled = true;
  $("#stop").hidden = false;
  const progress = $(".progress");
  progress.hidden = false;

  try {
    const genreMap = await lookupGenres([...wanted.values()], {
      source,
      apiKey,
      signal: controller.signal,
      onProgress: (done, total) => {
        progress.firstElementChild.style.width = `${(100 * done) / total}%`;
        const left = total - done;
        const eta = source === "musicbrainz" && left > 5 ? ` · about ${Math.ceil((left * 1.1) / 60)} min left` : "";
        setStatus(`Looking up genres: ${done} of ${total} artists${eta}`);
      },
    });
    lastGenres = genreMap;
    lastResult = compare(spotify, youtube, genreMap);
    lastResult.profiles = { spotify, youtube, range };
    render();
    const found = [...genreMap.values()].filter((w) => Object.keys(w).length).length;
    setStatus(
      `${controller.signal.aborted ? "Stopped early. " : ""}Found genres for ${found} of ${wanted.size} artists.`
    );
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setStatus(err.message);
  } finally {
    $("#go").disabled = false;
    $("#stop").hidden = true;
    progress.hidden = true;
  }
}

/* ---------- Rendering results ---------- */

for (const tab of document.querySelectorAll(".seg button")) {
  tab.addEventListener("click", () => {
    view = tab.dataset.view;
    for (const t of document.querySelectorAll(".seg button")) t.setAttribute("aria-selected", String(t === tab));
    renderChart();
  });
}

function render() {
  const r = lastResult;
  $("#results").hidden = false;
  $("#s-overall").textContent = score(r.scores.overall);
  $("#s-verdict").textContent = verdict(r.scores.overall);
  $("#s-genre").textContent = score(r.scores.genreScore);
  $("#s-family").textContent = score(r.scores.familyScore);
  $("#s-artist").textContent = score(r.scores.artistScore);
  $("#s-artist-note").textContent = `${r.sharedCount.toLocaleString()} artists on both, weighted by plays`;

  renderChart();
  renderLeans();
  renderArtists();

  const { spotify, youtube, range } = r.profiles;
  const describe = (p, name) =>
    `${name}: ${p.total.toLocaleString()} ${p.usesSaved ? "saved songs" : "plays"}, ` +
    `${p.artists.size.toLocaleString()} artists` +
    (p.first ? `, ${fmtDate(p.first)} to ${fmtDate(p.last)}` : "") +
    `; genres cover ${pct(r.coverage[name === "Spotify" ? "spotify" : "youtube"])} of it.`;
  $("#coverage").textContent =
    `${describe(spotify, "Spotify")} ${describe(youtube, "YouTube Music")}` +
    (range ? " Only the dates both services cover are compared." : "") +
    " Genre data from " + (sourceEl.value === "lastfm" ? "Last.fm." : "MusicBrainz.");
}

function rowsForView() {
  return view === "genres" ? lastResult.genreRows : lastResult.familyRows;
}

function renderChart() {
  const rows = rowsForView();
  const shown = rows.slice(0, CHART_ROWS);
  $("#chart-title").textContent = view === "genres" ? `Top ${shown.length} genres` : "Genre families";
  const max = Math.max(...shown.flatMap((r) => [r.spotify, r.youtube]), 0.0001);
  const chart = $("#chart");
  chart.replaceChildren();
  if (!shown.length) {
    chart.innerHTML = '<p class="empty">No genres were found for these artists.</p>';
  }
  for (const row of shown) {
    const el = document.createElement("div");
    el.className = "pair";
    el.tabIndex = 0;
    const name = document.createElement("div");
    name.className = "pair-name";
    name.textContent = row.genre;
    const bars = document.createElement("div");
    bars.className = "pair-bars";
    bars.append(barRow("sp", row.spotify, max), barRow("yt", row.youtube, max));
    el.append(name, bars);
    el.addEventListener("pointerenter", (e) => showTip(e, row));
    el.addEventListener("pointermove", moveTip);
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => showTip(null, row, el));
    el.addEventListener("blur", hideTip);
    chart.append(el);
  }

  const table = $("#table");
  table.innerHTML =
    `<thead><tr><th>${view === "genres" ? "Genre" : "Family"}</th>` +
    (view === "genres" ? "<th>Family</th>" : "") +
    '<th class="n">Spotify</th><th class="n">YouTube Music</th></tr></thead>';
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [row.genre, ...(view === "genres" ? [row.family] : []), pct(row.spotify), pct(row.youtube)];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (i >= cells.length - 2) td.className = "n";
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(body);
}

function barRow(cls, value, max) {
  const row = document.createElement("div");
  row.className = "bar-row";
  const fill = document.createElement("div");
  fill.className = `bar-fill ${cls}`;
  fill.style.width = `calc(${(100 * value) / max}% - 44px)`;
  if (!value) fill.style.width = "0";
  const val = document.createElement("span");
  val.className = "bar-val";
  val.textContent = pct(value);
  row.append(fill, val);
  return row;
}

function renderLeans() {
  const rows = lastResult.genreRows.filter((r) => r.spotify + r.youtube >= 0.01);
  const byDiff = [...rows].sort((a, b) => b.spotify - b.youtube - (a.spotify - a.youtube));
  fillLean("#lean-sp", byDiff.filter((r) => r.spotify > r.youtube).slice(0, 6), "spotify", "youtube");
  fillLean("#lean-yt", byDiff.reverse().filter((r) => r.youtube > r.spotify).slice(0, 6), "youtube", "spotify");
}

function fillLean(sel, rows, more, less) {
  const ol = $(sel);
  ol.replaceChildren();
  if (!rows.length) ol.innerHTML = '<li class="empty">Nothing stands out</li>';
  for (const r of rows) {
    ol.append(li(r.genre, `${pct(r[more])} vs ${pct(r[less])}`));
    ol.lastChild.lastChild.className = "delta";
  }
}

function renderArtists() {
  const tagsFor = (key) =>
    Object.entries((lastGenres && lastGenres.get(key)) || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g)
      .join(", ");

  const fill = (sel, items, meta) => {
    const ol = $(sel);
    ol.replaceChildren();
    if (!items.length) ol.innerHTML = '<li class="empty">None</li>';
    for (const a of items) {
      const item = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = a.name;
      const tags = tagsFor(a.key);
      if (tags) {
        const t = document.createElement("span");
        t.className = "tags";
        t.textContent = tags;
        who.append(t);
      }
      const m = document.createElement("span");
      m.className = "meta";
      m.textContent = meta(a);
      item.append(who, m);
      ol.append(item);
    }
  };
  fill("#shared", lastResult.shared.slice(0, 20), (a) => `${pct(a.spotify)} · ${pct(a.youtube)}`);
  fill("#only-sp", lastResult.onlySpotify.slice(0, 10), (a) => pct(a.share));
  fill("#only-yt", lastResult.onlyYoutube.slice(0, 10), (a) => pct(a.share));
  $("#shared").previousElementSibling.textContent =
    `Artists on both (${lastResult.sharedCount.toLocaleString()})`;
}

/* ---------- Tooltip ---------- */

const tip = $("#tip");
function showTip(e, row, anchor) {
  tip.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = row.genre;
  tip.append(title);
  if (row.family) tip.append(Object.assign(document.createElement("div"), { textContent: row.family }));
  for (const [cls, label, v] of [["sp", "Spotify", row.spotify], ["yt", "YouTube Music", row.youtube]]) {
    const r = document.createElement("div");
    r.className = "row";
    r.innerHTML = `<i class="swatch ${cls}"></i>`;
    r.append(`${label}: ${pct(v)}`);
    tip.append(r);
  }
  tip.hidden = false;
  if (e) moveTip(e);
  else {
    const box = anchor.getBoundingClientRect();
    placeTip(box.left + box.width / 2, box.bottom);
  }
}
function moveTip(e) { placeTip(e.clientX, e.clientY); }
function placeTip(x, y) {
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 14))}px`;
  tip.style.top = `${y + h + 20 > window.innerHeight ? y - h - 12 : y + 16}px`;
}
function hideTip() { tip.hidden = true; }

/* ---------- Formatting ---------- */

function pct(x) {
  const v = (x || 0) * 100;
  if (v === 0) return "0%";
  if (v < 0.1) return "<0.1%";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}
function score(x) { return `${Math.round(x * 100)}%`; }
function verdict(x) {
  if (x >= 0.8) return "Practically the same taste";
  if (x >= 0.6) return "Very similar";
  if (x >= 0.4) return "Plenty in common";
  if (x >= 0.2) return "Pretty different";
  return "Two different listeners";
}
function fmtDate(t) {
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function setStatus(text) { statusEl.textContent = text; }
