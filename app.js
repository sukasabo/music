import { parseFile, isWantedName } from "./parsers.js";
import { lookupGenres } from "./genres.js";
import { buildProfile, dateSpan, topArtists, compare } from "./compare.js";

const NAMES = { spotify: "Spotify", youtube: "YouTube Music" };
const CHART_ROWS = 15;

// service -> [{ name, label, entries }]
const loaded = { spotify: [], youtube: [] };
let report = null; // what's on screen; plain data so it can travel in a share link
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
    const result = compare(spotify, youtube, genreMap);
    report = buildReport(result, genreMap, { spotify, youtube, range, source });
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

// Everything the results need, rounded and trimmed so it fits in a link.
function buildReport(r, genreMap, { spotify, youtube, range, source }) {
  const round = (x) => Math.round((x || 0) * 10000) / 10000;
  const tagsFor = (key) =>
    Object.entries(genreMap.get(key) || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g);
  const rows = (list, limit) =>
    list.slice(0, limit).map((x) => ({ g: x.genre, f: x.family, s: round(x.spotify), y: round(x.youtube) }));
  const people = (list, limit, pick) => list.slice(0, limit).map((a) => ({ n: a.name, t: tagsFor(a.key), ...pick(a) }));

  const describe = (p, name, cov) =>
    `${name}: ${p.total.toLocaleString()} ${p.usesSaved ? "saved songs" : "plays"}, ` +
    `${p.artists.size.toLocaleString()} artists` +
    (p.first ? `, ${fmtDate(p.first)} to ${fmtDate(p.last)}` : "") +
    `; genres cover ${pct(cov)} of it.`;

  return {
    v: 1,
    at: Date.now(),
    scores: {
      overall: round(r.scores.overall),
      genre: round(r.scores.genreScore),
      family: round(r.scores.familyScore),
      artist: round(r.scores.artistScore),
    },
    sharedCount: r.sharedCount,
    genres: rows(r.genreRows, 60),
    families: rows(r.familyRows, 20),
    shared: people(r.shared, 20, (a) => ({ s: round(a.spotify), y: round(a.youtube) })),
    onlySp: people(r.onlySpotify, 10, (a) => ({ s: round(a.share) })),
    onlyYt: people(r.onlyYoutube, 10, (a) => ({ y: round(a.share) })),
    notes:
      `${describe(spotify, "Spotify", r.coverage.spotify)} ${describe(youtube, "YouTube Music", r.coverage.youtube)}` +
      (range ? " Only the dates both services cover are compared." : "") +
      ` Genre data from ${source === "lastfm" ? "Last.fm" : "MusicBrainz"}.`,
  };
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
  const r = report;
  $("#results").hidden = false;
  $("#s-overall").textContent = score(r.scores.overall);
  $("#s-verdict").textContent = verdict(r.scores.overall);
  $("#s-genre").textContent = score(r.scores.genre);
  $("#s-family").textContent = score(r.scores.family);
  $("#s-artist").textContent = score(r.scores.artist);
  $("#s-artist-note").textContent = `${r.sharedCount.toLocaleString()} on both, weighted by plays`;
  renderChart();
  renderLeans();
  renderArtists();
  $("#coverage").textContent = r.notes;
  $("#share-status").textContent = "";
}

function renderChart() {
  const rows = view === "genres" ? report.genres : report.families;
  const shown = rows.slice(0, CHART_ROWS);
  $("#chart-title").textContent = view === "genres" ? `Top ${shown.length} genres` : "Genre families";
  const max = Math.max(...shown.flatMap((r) => [r.s, r.y]), 0.0001);
  const chart = $("#chart");
  chart.replaceChildren();
  if (!shown.length) chart.innerHTML = '<p class="fine">No genres were found for these artists.</p>';
  for (const row of shown) {
    const el = document.createElement("div");
    el.className = "pair";
    el.tabIndex = 0;
    const name = document.createElement("div");
    name.className = "pair-name";
    name.textContent = row.g;
    const bars = document.createElement("div");
    bars.className = "pair-bars";
    bars.append(barRow("sp", row.s, max), barRow("yt", row.y, max));
    el.append(name, bars);
    el.addEventListener("pointerenter", (e) => showTip(e, row));
    el.addEventListener("pointermove", moveTip);
    el.addEventListener("pointerleave", hideTip);
    el.addEventListener("focus", () => showTip(null, row, el));
    el.addEventListener("blur", hideTip);
    chart.append(el);
  }

  const table = $("#table");
  const withFamily = view === "genres";
  table.innerHTML =
    `<thead><tr><th>${withFamily ? "Genre" : "Family"}</th>` +
    (withFamily ? "<th>Family</th>" : "") +
    '<th class="n">Spotify</th><th class="n">YouTube Music</th></tr></thead>';
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = [row.g, ...(withFamily ? [row.f] : []), pct(row.s), pct(row.y)];
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
  fill.style.width = value ? `calc(${(100 * value) / max}% - 44px)` : "0";
  const val = document.createElement("span");
  val.className = "bar-val";
  val.textContent = pct(value);
  row.append(fill, val);
  return row;
}

function renderLeans() {
  const rows = report.genres.filter((r) => r.s + r.y >= 0.01);
  const byDiff = [...rows].sort((a, b) => b.s - b.y - (a.s - a.y));
  fillList("#lean-sp", byDiff.filter((r) => r.s > r.y).slice(0, 6), (r) => [r.g, null, `${pct(r.s)} vs ${pct(r.y)}`]);
  fillList("#lean-yt", byDiff.reverse().filter((r) => r.y > r.s).slice(0, 6), (r) => [r.g, null, `${pct(r.y)} vs ${pct(r.s)}`]);
}

function renderArtists() {
  fillList("#shared", report.shared, (a) => [a.n, a.t.join(", "), `${pct(a.s)} · ${pct(a.y)}`]);
  fillList("#only-sp", report.onlySp, (a) => [a.n, a.t.join(", "), pct(a.s)]);
  fillList("#only-yt", report.onlyYt, (a) => [a.n, a.t.join(", "), pct(a.y)]);
  $("#shared-title").textContent = `Artists on both (${report.sharedCount.toLocaleString()})`;
}

function fillList(sel, items, parts) {
  const ol = $(sel);
  ol.replaceChildren();
  if (!items.length) ol.innerHTML = '<li class="empty">None stand out</li>';
  for (const item of items) {
    const [name, sub, meta] = parts(item);
    const row = document.createElement("li");
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = name;
    if (sub) {
      const t = document.createElement("span");
      t.className = "tags";
      t.textContent = sub;
      who.append(t);
    }
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    row.append(who, m);
    ol.append(row);
  }
}

/* ---------- Sharing ---------- */

// The report rides in the link itself (compressed, after the #), so there's no server
// and nothing is stored anywhere. Only the summary on screen is included.
async function packReport(obj) {
  const json = JSON.stringify(obj);
  if (!window.CompressionStream) return "j" + b64url(new TextEncoder().encode(json));
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return "z" + b64url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function unpackReport(text) {
  const bytes = fromB64url(text.slice(1));
  if (text[0] === "j") return JSON.parse(new TextDecoder().decode(bytes));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(stream).text());
}

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const shareStatus = $("#share-status");

$("#copy-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#r=${await packReport(report)}`;
  if (location.protocol === "file:") {
    shareStatus.textContent = "Links only work once the page is on a website, like GitHub Pages.";
    return;
  }
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: "Spotify & YouTube Music", text: shareText(), url });
      return;
    }
    await navigator.clipboard.writeText(url);
    shareStatus.textContent = "Link copied.";
  } catch (err) {
    if (err.name === "AbortError") return; // closed the share sheet
    prompt("Copy this link:", url);
  }
});

$("#save-image").addEventListener("click", async () => {
  shareStatus.textContent = "Drawing…";
  const blob = await drawCard(report);
  const file = new File([blob], "music-compare.png", { type: "image/png" });
  shareStatus.textContent = "";
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ files: [file], title: "Spotify & YouTube Music", text: shareText() });
      return;
    }
  } catch (err) {
    if (err.name === "AbortError") return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  shareStatus.textContent = "Image saved.";
});

function shareText() {
  return `My Spotify and YouTube Music are ${score(report.scores.overall)} alike: ${verdict(report.scores.overall).toLowerCase()}.`;
}

// A portrait card (1080 × 1350) in the page's light paper style.
async function drawCard(r) {
  await document.fonts.ready;
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext("2d");
  const ink = "#1c1a17";
  const ink2 = "#5b564d";
  const muted = "#877f72";
  const gold = "#8f723a";
  const rule = "#ddd5c6";
  const serif = '"Cormorant Garamond", Georgia, serif';
  const sans = '"DM Sans", system-ui, sans-serif';
  const M = 90;

  c.fillStyle = "#f7f3ea";
  c.fillRect(0, 0, W, H);
  c.textAlign = "center";
  c.textBaseline = "alphabetic";

  const spaced = (text, x, y, spacing) => {
    c.letterSpacing = `${spacing}px`;
    c.fillText(text, x, y);
    c.letterSpacing = "0px";
  };
  const line = (y, color = ink, x1 = M, x2 = W - M) => {
    c.fillStyle = color;
    c.fillRect(x1, y, x2 - x1, 1.5);
  };

  c.fillStyle = gold;
  c.font = `600 22px ${sans}`;
  spaced("A LISTENING STUDY", W / 2, 128, 5);
  c.fillStyle = ink;
  c.font = `500 76px ${serif}`;
  const left = "Spotify ";
  const amp = "& ";
  const right = "YouTube Music";
  const wl = c.measureText(left).width;
  c.font = `italic 500 76px ${serif}`;
  const wa = c.measureText(amp).width;
  c.font = `500 76px ${serif}`;
  const wr = c.measureText(right).width;
  let x = (W - wl - wa - wr) / 2;
  c.textAlign = "left";
  c.fillText(left, x, 222);
  c.font = `italic 500 76px ${serif}`;
  c.fillStyle = gold;
  c.fillText(amp, x + wl, 222);
  c.font = `500 76px ${serif}`;
  c.fillStyle = ink;
  c.fillText(right, x + wl + wa, 222);
  c.textAlign = "center";
  line(270);
  line(277);

  c.font = `500 230px ${serif}`;
  c.fillText(score(r.scores.overall), W / 2, 500);
  c.fillStyle = muted;
  c.font = `600 20px ${sans}`;
  spaced("OVERALL SIMILARITY", W / 2, 548, 5);
  c.fillStyle = gold;
  c.font = `italic 500 46px ${serif}`;
  c.fillText(verdict(r.scores.overall), W / 2, 612);

  line(668, rule);
  const subs = [["GENRE MATCH", r.scores.genre], ["GENRE FAMILIES", r.scores.family], ["ARTISTS", r.scores.artist]];
  const colW = (W - 2 * M) / 3;
  subs.forEach(([label, v], i) => {
    const cx = M + colW * i + colW / 2;
    c.fillStyle = ink;
    c.font = `500 64px ${serif}`;
    c.fillText(score(v), cx, 752);
    c.fillStyle = ink2;
    c.font = `600 17px ${sans}`;
    spaced(label, cx, 790, 3.5);
    if (i) c.fillRect(M + colW * i, 700, 1.5, 100);
  });
  line(830, rule);

  // Top genres as paired bars.
  const rows = r.genres.slice(0, 6);
  const max = Math.max(...rows.flatMap((g) => [g.s, g.y]), 0.0001);
  const labelW = 300;
  const barX = M + labelW + 24;
  const barMax = W - M - barX - 70;
  let y = 890;
  c.textAlign = "left";
  c.fillStyle = ink2;
  c.font = `600 18px ${sans}`;
  spaced("TOP GENRES", M, y, 4);
  c.fillStyle = "#2f5d9e";
  c.fillRect(W - M - 340, y - 8, 22, 4);
  c.fillStyle = "#c0562f";
  c.fillRect(W - M - 180, y - 8, 22, 4);
  c.fillStyle = ink2;
  c.font = `400 19px ${sans}`;
  c.fillText("Spotify", W - M - 310, y);
  c.fillText("YouTube Music", W - M - 150, y);
  y += 42;
  for (const g of rows) {
    c.fillStyle = ink;
    c.font = `500 30px ${serif}`;
    c.textAlign = "right";
    let name = g.g;
    while (c.measureText(name).width > labelW && name.length > 3) name = name.slice(0, -2) + "…";
    c.fillText(name, M + labelW, y + 16);
    c.textAlign = "left";
    [[g.s, "#2f5d9e", 0], [g.y, "#c0562f", 18]].forEach(([v, color, dy]) => {
      const w = Math.max(2, (barMax * v) / max);
      c.fillStyle = color;
      c.beginPath();
      c.roundRect(barX, y + dy - 2, w, 11, [0, 5, 5, 0]);
      c.fill();
      c.fillStyle = ink2;
      c.font = `400 16px ${sans}`;
      c.fillText(pct(v), barX + w + 10, y + dy + 8);
    });
    y += 56;
  }

  line(H - 92, rule);
  c.textAlign = "center";
  c.fillStyle = muted;
  c.font = `400 19px ${sans}`;
  const both = r.shared.slice(0, 3).map((a) => a.n).join(", ");
  c.fillText(
    r.sharedCount ? `${r.sharedCount.toLocaleString()} artists on both${both ? `, including ${both}` : ""}` : "No artists in common",
    W / 2,
    H - 50,
  );

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Opening a shared link shows that report instead of the upload steps.
async function openSharedReport() {
  const m = location.hash.match(/^#r=([jz][A-Za-z0-9_-]+)$/);
  if (!m) return;
  try {
    report = await unpackReport(m[1]);
  } catch {
    return;
  }
  $("#setup").hidden = true;
  $("#shared-banner").hidden = false;
  $("#res-num").textContent = "";
  $("#shared-date").textContent = report.at ? `, made ${fmtDate(report.at)}` : "";
  $("#make-own").href = location.pathname;
  render();
}
openSharedReport();
window.addEventListener("hashchange", () => location.reload());

/* ---------- Tooltip ---------- */

const tip = $("#tip");
function showTip(e, row, anchor) {
  tip.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = row.g;
  tip.append(title);
  if (row.f) tip.append(Object.assign(document.createElement("div"), { className: "fam", textContent: row.f }));
  for (const [cls, label, v] of [["sp", "Spotify", row.s], ["yt", "YouTube Music", row.y]]) {
    const r = document.createElement("div");
    r.className = "row";
    r.innerHTML = `<i class="key ${cls}"></i>`;
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
