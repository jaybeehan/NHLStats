/* NHL Stats front end. Plain JavaScript, no build step.
   Data comes from data/manifest.json and data/<season>/*.json, which the
   GitHub Action rebuilds hourly (scores) and daily (everything). */

"use strict";

// ------------------------------------------------------------------ teams

// code, full name, nickname, NST name, primary colour, secondary colour
const TEAMS = [
  ["ANA", "Anaheim Ducks", "Ducks", "#F47A38", "#111111"],
  ["BOS", "Boston Bruins", "Bruins", "#FFB81C", "#111111"],
  ["BUF", "Buffalo Sabres", "Sabres", "#FFB81C", "#003087"],
  ["CGY", "Calgary Flames", "Flames", "#C8102E", "#3A0A10"],
  ["CAR", "Carolina Hurricanes", "Hurricanes", "#CE1126", "#111111"],
  ["CHI", "Chicago Blackhawks", "Blackhawks", "#CF0A2C", "#111111"],
  ["COL", "Colorado Avalanche", "Avalanche", "#236192", "#6F263D"],
  ["CBJ", "Columbus Blue Jackets", "Blue Jackets", "#CE1126", "#002654"],
  ["DAL", "Dallas Stars", "Stars", "#2FA36B", "#00382A"],
  ["DET", "Detroit Red Wings", "Red Wings", "#CE1126", "#3B0A10"],
  ["EDM", "Edmonton Oilers", "Oilers", "#FF4C00", "#041E42"],
  ["FLA", "Florida Panthers", "Panthers", "#C8102E", "#041E42"],
  ["LAK", "Los Angeles Kings", "Kings", "#A2AAAD", "#111111"],
  ["MIN", "Minnesota Wild", "Wild", "#C8A15E", "#154734"],
  ["MTL", "Montreal Canadiens", "Canadiens", "#AF1E2D", "#192168"],
  ["NSH", "Nashville Predators", "Predators", "#FFB81C", "#041E42"],
  ["NJD", "New Jersey Devils", "Devils", "#CE1126", "#111111"],
  ["NYI", "New York Islanders", "Islanders", "#F47D30", "#00539B"],
  ["NYR", "New York Rangers", "Rangers", "#CE1126", "#0038A8"],
  ["OTT", "Ottawa Senators", "Senators", "#C52032", "#111111"],
  ["PHI", "Philadelphia Flyers", "Flyers", "#F74902", "#111111"],
  ["PIT", "Pittsburgh Penguins", "Penguins", "#FCB514", "#111111"],
  ["SJS", "San Jose Sharks", "Sharks", "#00A3AD", "#003B40"],
  ["SEA", "Seattle Kraken", "Kraken", "#99D9D9", "#001628"],
  ["STL", "St. Louis Blues", "Blues", "#FCB514", "#002F87"],
  ["TBL", "Tampa Bay Lightning", "Lightning", "#4A90E2", "#002868"],
  ["TOR", "Toronto Maple Leafs", "Maple Leafs", "#5B8FD6", "#00205B"],
  ["UTA", "Utah Mammoth", "Mammoth", "#6CACE4", "#0B1622"],
  ["VAN", "Vancouver Canucks", "Canucks", "#00843D", "#00205B"],
  ["VGK", "Vegas Golden Knights", "Golden Knights", "#B4975A", "#333F42"],
  ["WSH", "Washington Capitals", "Capitals", "#C8102E", "#041E42"],
  ["WPG", "Winnipeg Jets", "Jets", "#7BAFD4", "#041E42"],
].map(([code, name, nick, c1, c2]) => ({ code, name, nick, c1, c2 }));
const TEAM = Object.fromEntries(TEAMS.map(t => [t.code, t]));
const team = c => TEAM[c] || { code: c, name: c, nick: c, c1: "#888", c2: "#333" };

const VIEWS = [
  ["team", "Team"],
  ["standings", "Standings"],
  ["schedule", () => `${team(S.team).nick} schedule`],
  ["recent", "Recent NHL games"],
  ["gamelog", () => `${team(S.team).nick} game log`],
  ["skaters", "Skaters"],
  ["goalies", "NHL goalies"],
  ["goalielog", () => `${team(S.team).nick} goalies`],
  ["leaders", "Scoring"],
  ["advanced", "Team stats"],
  ["magic", "Magic number"],
  ["links", "Links"],
];

// ------------------------------------------------------------------ state

const S = {
  manifest: null,
  team: "EDM",
  season: null,
  view: "team",
  data: {},          // season -> {file -> json}
  ui: {},            // per-view control values
  sort: {},          // table id -> {k, dir}
};

const $ = sel => document.querySelector(sel);

// Per-device preferences: tab order and hidden table columns.
const PREFS = (() => { try { return JSON.parse(localStorage.getItem("nhlstats-prefs") || "{}"); } catch (e) { return {}; } })();
PREFS.tabs ??= null;      // array of view keys, or null for the default order
PREFS.hidden ??= {};      // table key -> [column keys]
function savePrefs() { try { localStorage.setItem("nhlstats-prefs", JSON.stringify(PREFS)); } catch (e) { /* private mode */ } }

const viewLabel = l => typeof l === "function" ? l() : l;

function tabOrder() {
  const keys = VIEWS.map(v => v[0]);
  if (!PREFS.tabs) return VIEWS;
  // Keep saved order, drop unknown keys, add any new tabs at the end.
  const order = PREFS.tabs.filter(k => keys.includes(k));
  for (const k of keys) if (!order.includes(k)) order.push(k);
  return order.map(k => VIEWS.find(v => v[0] === k));
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function readHash() {
  const [view, q] = location.hash.replace(/^#\/?/, "").split("?");
  const p = new URLSearchParams(q || "");
  if (VIEWS.some(v => v[0] === view)) S.view = view;
  if (p.get("team") && TEAM[p.get("team")]) S.team = p.get("team");
  if (p.get("season")) S.season = Number(p.get("season"));
}

function writeHash() {
  const h = `#/${S.view}?team=${S.team}&season=${S.season}`;
  if (location.hash !== h) history.replaceState(null, "", h);
  try { localStorage.setItem("nhlstats", JSON.stringify({ team: S.team, season: S.season })); } catch (e) { /* private mode */ }
}

// ------------------------------------------------------------------ data

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function load(season, file) {
  S.data[season] ??= {};
  if (S.data[season][file] !== undefined) return S.data[season][file];
  const entry = S.manifest.seasons.find(s => s.code === season);
  if (!entry || !entry.files.includes(file)) return (S.data[season][file] = null);
  try {
    S.data[season][file] = await getJSON(`data/${season}/${file}.json?v=${encodeURIComponent(S.manifest.generated)}`);
    // Anything derived for this season before this file arrived is stale now.
    for (const k in memo) if (k.includes(String(season))) delete memo[k];
  } catch (e) {
    S.data[season][file] = null;
  }
  return S.data[season][file];
}

const rowsOf = d => d ? (d.rows || d.games || []).map(r => Object.fromEntries(d.cols.map((c, i) => [c, r[i]]))) : [];

function seasonInfo(code = S.season) {
  return S.manifest.seasons.find(s => s.code === code) || { code, games: 82, label: String(code) };
}

// Pre-processed, cached per season.
const memo = {};
function cached(key, fn) { return (memo[key] ??= fn()); }

function standingsMap(st) { return Object.fromEntries((st?.teams || []).map(t => [t.team, t])); }

function games(season) {
  return cached(`games${season}`, () => rowsOf(S.data[season]?.schedule).map(g => ({
    ...g,
    dateObj: new Date(g.start),
    final: g.state === "OFF" || g.state === "FINAL",
    live: g.state === "LIVE" || g.state === "CRIT",
  })));
}

// team-game rows from NST, keyed "date|team|sit"
function teamGames(season) {
  return cached(`tg${season}`, () => {
    const by = {};
    for (const r of rowsOf(S.data[season]?.teamgames)) by[`${r.date}|${r.team}|${r.sit}`] = r;
    return by;
  });
}

function teamTotals(season, sit = "5v5") {
  return cached(`tt${season}${sit}`, () => {
    const t = {};
    for (const r of rowsOf(S.data[season]?.teamgames)) {
      if (r.sit !== sit) continue;
      const a = (t[r.team] ??= { team: r.team, gp: 0 });
      a.gp++;
      for (const k of ["TOI", "CF", "CA", "FF", "FA", "SF", "SA", "GF", "GA", "xGF", "xGA", "SCF", "SCA", "HDCF", "HDCA"]) {
        a[k] = (a[k] || 0) + (r[k] || 0);
      }
    }
    for (const a of Object.values(t)) {
      const sh = (f, x) => (a[f] + a[x]) ? 100 * a[f] / (a[f] + a[x]) : null;
      Object.assign(a, {
        cfp: sh("CF", "CA"), ffp: sh("FF", "FA"), sfp: sh("SF", "SA"), gfp: sh("GF", "GA"),
        xgfp: sh("xGF", "xGA"), scfp: sh("SCF", "SCA"), hdcfp: sh("HDCF", "HDCA"),
        shp: a.SF ? 100 * a.GF / a.SF : null,
        svp: a.SA ? 100 * (1 - a.GA / a.SA) : null,
      });
      a.pdo = a.shp != null && a.svp != null ? (a.shp + a.svp) / 100 : null;
    }
    return t;
  });
}

function rankOf(map, code, key, desc = true) {
  const vals = Object.values(map).map(x => x[key]).filter(v => v != null);
  const v = map[code]?.[key];
  if (v == null) return null;
  return 1 + vals.filter(x => desc ? x > v : x < v).length;
}

// average opponent points % (all / played / remaining)
function sosTable(season) {
  return cached(`sos${season}`, () => {
    const st = standingsMap(S.data[season]?.standings);
    const out = {};
    for (const code of Object.keys(st)) {
      const acc = { all: [], played: [], left: [] };
      for (const g of games(season)) {
        if (g.home !== code && g.away !== code) continue;
        const opp = g.home === code ? g.away : g.home;
        const p = st[opp]?.pct;
        if (p == null) continue;
        acc.all.push(p);
        (g.final ? acc.played : acc.left).push(p);
      }
      const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      out[code] = { team: code, all: avg(acc.all), played: avg(acc.played), left: avg(acc.left), gamesLeft: acc.left.length };
    }
    for (const k of ["all", "played", "left"]) {
      for (const code in out) out[code][k + "Rank"] = rankOf(out, code, k);
    }
    return out;
  });
}

const nstGameUrl = (season, id) =>
  `https://www.naturalstattrick.com/game.php?season=${season}&game=${id % 1000000}&view=limited`;

// ------------------------------------------------------------- formatting

const f1 = v => v == null || isNaN(v) ? "" : Number(v).toFixed(1);
const f2 = v => v == null || isNaN(v) ? "" : Number(v).toFixed(2);
const f3 = v => v == null || isNaN(v) ? "" : Number(v).toFixed(3).replace(/^0\./, ".");
const f0 = v => v == null || isNaN(v) ? "" : Math.round(v).toString();
const sgn = (v, d = 2) => v == null || isNaN(v) ? "" : (v > 0 ? "+" : "") + Number(v).toFixed(d);
const ord = n => n == null ? "" : n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateOnly = s => new Date(s + "T12:00:00");
const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function teamCell(code, withName = false) {
  const t = team(code);
  return `<span class="teamcell"><span class="dot" style="background:${t.c1}"></span>${esc(withName ? t.name : code)}</span>`;
}
const signCls = (v, eps = 0) => v == null ? "" : v > eps ? "pos" : v < -eps ? "neg" : "";
const shareCls = v => v == null ? "" : v >= 52 ? "pos" : v <= 48 ? "neg" : "";

// ------------------------------------------------------------------ table

/* cols: {k, l, v(row)->value, f(value,row)->html, num, cls(value,row), title, nosort, asc}
   opts: {id, rows, sort:{k,dir}, rowCls(row), limit, click} */
function table(opts) {
  const { id } = opts;
  const key = opts.colKey || id;
  const chooser = opts.cols.length > 8;
  const hidden = new Set(chooser ? (PREFS.hidden[key] || []) : []);
  // The first column (team or player) always stays.
  const cols = opts.cols.filter((c, i) => i === 0 || !hidden.has(c.k));
  let button = "";
  if (chooser) {
    colDefs[key] = opts.cols;
    if (!colButtonsShown.has(key)) {
      colButtonsShown.add(key);
      const n = hidden.size;
      button = `<div class="tbl-tools"><button type="button" class="tool-btn" data-cols="${esc(key)}">Columns${n ? ` (${n} hidden)` : ""}</button></div>`;
    }
  }
  const st = S.sort[id] || opts.sort || {};
  let rows = opts.rows.slice();
  const col = cols.find(c => c.k === st.k);
  if (col) {
    const val = r => (col.v ? col.v(r) : r[col.k]);
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || x === "") return 1;
      if (y == null || y === "") return -1;
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return st.dir === "asc" ? c : -c;
    });
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);
  const head = cols.map(c => {
    const aria = col === c ? ` aria-sort="${st.dir === "asc" ? "ascending" : "descending"}"` : "";
    const sort = c.nosort ? "" : ` data-sort="${c.k}" data-table="${id}" tabindex="0"`;
    return `<th class="${c.num === false ? "l" : ""}"${sort}${aria}${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.l)}</th>`;
  }).join("");
  const body = rows.map((r, i) => {
    const cls = [opts.rowCls ? opts.rowCls(r, i) : "", opts.click ? "click" : ""].join(" ").trim();
    const tds = cols.map(c => {
      const v = c.v ? c.v(r) : r[c.k];
      const html = c.f ? c.f(v, r, i) : esc(v ?? "");
      const extra = c.cls ? c.cls(v, r) : "";
      return `<td class="${c.num === false ? "l" : ""} ${extra}">${html}</td>`;
    }).join("");
    return `<tr class="${cls}"${opts.click ? ` data-click="${i}" data-table="${id}"` : ""}>${tds}</tr>`;
  }).join("");
  if (opts.click) tableClicks[id] = { rows, fn: opts.click };
  return `${button}<div class="tbl-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td class="l" colspan="${cols.length}">Nothing to show yet.</td></tr>`}</tbody></table></div>`;
}
const tableClicks = {};
const colDefs = {};               // table key -> full column list
let colButtonsShown = new Set();  // one Columns button per key per render

function openColumns(key) {
  const cols = colDefs[key] || [];
  const hidden = new Set(PREFS.hidden[key] || []);
  $("#prefs-body").innerHTML = `<h3>Columns</h3><p class="tag">Untick a column to hide it. Saved on this device.</p>
    <div class="check-list">${cols.map((c, i) => `<label><input type="checkbox" data-colkey="${esc(key)}" data-col="${esc(c.k)}"${i === 0 ? " disabled" : ""}${hidden.has(c.k) ? "" : " checked"}> ${esc(c.l)}${c.title ? ` <span class="tag">${esc(c.title)}</span>` : ""}</label>`).join("")}</div>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-showall="${esc(key)}">Show all</button></div>`;
  openSheet();
}

function openArrange() {
  const order = tabOrder();
  $("#prefs-body").innerHTML = `<h3>Arrange tabs</h3><p class="tag">Move tabs up or down. Saved on this device.</p>
    <ol class="arrange-list">${order.map(([k, l], i) => `<li><span>${esc(viewLabel(l))}</span>
      <button type="button" class="icon-btn" data-move="${k}" data-dir="-1" aria-label="Move ${esc(viewLabel(l))} up"${i === 0 ? " disabled" : ""}>&#9650;</button>
      <button type="button" class="icon-btn" data-move="${k}" data-dir="1" aria-label="Move ${esc(viewLabel(l))} down"${i === order.length - 1 ? " disabled" : ""}>&#9660;</button></li>`).join("")}</ol>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-resettabs="1">Reset to default</button></div>`;
  openSheet();
}

function openSheet() {
  const d = $("#prefs-sheet");
  if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute("open", ""); }
}

document.addEventListener("click", e => {
  const c = e.target.closest("button[data-cols]");
  if (c) return openColumns(c.dataset.cols);
  if (e.target.closest("button[data-arrange]")) return openArrange();
  const all = e.target.closest("button[data-showall]");
  if (all) { delete PREFS.hidden[all.dataset.showall]; savePrefs(); openColumns(all.dataset.showall); return render(); }
  const mv = e.target.closest("button[data-move]");
  if (mv) {
    const order = tabOrder().map(v => v[0]);
    const i = order.indexOf(mv.dataset.move), j = i + Number(mv.dataset.dir);
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    PREFS.tabs = order; savePrefs(); openArrange(); drawTabs();
    const again = document.querySelector(`button[data-move="${mv.dataset.move}"][data-dir="${mv.dataset.dir}"]`);
    if (again && !again.disabled) again.focus();
    return;
  }
  if (e.target.closest("button[data-resettabs]")) { PREFS.tabs = null; savePrefs(); openArrange(); drawTabs(); }
});
document.addEventListener("change", e => {
  const cb = e.target.closest("input[data-colkey]");
  if (!cb) return;
  const key = cb.dataset.colkey, set = new Set(PREFS.hidden[key] || []);
  if (cb.checked) set.delete(cb.dataset.col); else set.add(cb.dataset.col);
  PREFS.hidden[key] = [...set];
  if (!set.size) delete PREFS.hidden[key];
  savePrefs(); render();
});

document.addEventListener("click", e => {
  const th = e.target.closest("th[data-sort]");
  if (th) return sortBy(th);
  const tr = e.target.closest("tr[data-click]");
  if (tr && tableClicks[tr.dataset.table]) {
    const { rows, fn } = tableClicks[tr.dataset.table];
    fn(rows[Number(tr.dataset.click)]);
  }
});
document.addEventListener("keydown", e => {
  const th = e.target.closest?.("th[data-sort]");
  if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th); }
});
function sortBy(th) {
  const id = th.dataset.table, k = th.dataset.sort;
  const cur = S.sort[id];
  const firstDir = th.textContent.match(/^(Player|Team|Goalie|Opp|Date|Pos|Name)/) ? "asc" : "desc";
  S.sort[id] = cur && cur.k === k ? { k, dir: cur.dir === "asc" ? "desc" : "asc" } : { k, dir: firstDir };
  render();
}

// ------------------------------------------------------------------ chart

/* series: [{name, color, values:[number|null], width, dots}] over shared x */
function lineChart(series, { yMin, yMax, ref, fmt = f1, xLabels = [], height = 220 } = {}) {
  const all = series.flatMap(s => s.values).filter(v => v != null);
  if (!all.length) return `<p class="empty">Not enough games yet for a chart.</p>`;
  const n = Math.max(...series.map(s => s.values.length));
  const W = 720, H = height, L = 40, R = 12, T = 12, B = 26;
  let lo = yMin ?? Math.min(...all), hi = yMax ?? Math.max(...all);
  if (ref != null) { lo = Math.min(lo, ref); hi = Math.max(hi, ref); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const x = i => L + (n <= 1 ? (W - L - R) / 2 : i * (W - L - R) / (n - 1));
  const y = v => T + (hi - v) * (H - T - B) / (hi - lo);
  const ticks = 4;
  let svg = "";
  for (let t = 0; t <= ticks; t++) {
    const v = lo + (hi - lo) * t / ticks;
    svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  if (ref != null) svg += `<line class="refline" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>`;
  const step = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += step) {
    svg += `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(xLabels[i] ?? i + 1)}</text>`;
  }
  for (const s of series) {
    let d = "", pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.5}" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.dots) s.values.forEach((v, i) => { if (v != null) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"><title>${esc(xLabels[i] ?? "")}: ${fmt(v)}</title></circle>`; });
  }
  const legend = series.map(s => `<span style="--c:${s.color}">${esc(s.name)}</span>`).join("")
    + (ref != null ? `<span style="--c:var(--muted)">${fmt(ref)} reference</span>` : "");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(", "))}">${svg}</svg><div class="legend">${legend}</div></div>`;
}

// ------------------------------------------------------------- controls

function seg(name, options, value) {
  return `<span class="seg" role="group">${options.map(([v, l]) =>
    `<button type="button" data-ui="${name}" data-val="${esc(v)}" aria-pressed="${String(v) === String(value)}">${esc(l)}</button>`).join("")}</span>`;
}
function select(name, label, options, value) {
  return `<label>${esc(label)}<select data-ui="${name}">${options.map(([v, l]) =>
    `<option value="${esc(v)}"${String(v) === String(value) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}
function numberInput(name, label, value) {
  return `<label>${esc(label)}<input type="number" min="0" inputmode="numeric" data-ui="${name}" value="${esc(value)}"></label>`;
}
const ui = (k, d) => (S.ui[k] ?? d);

document.addEventListener("click", e => {
  const b = e.target.closest("button[data-ui]");
  if (b) { S.ui[b.dataset.ui] = b.dataset.val; render(); }
});
document.addEventListener("change", e => {
  const el = e.target.closest("[data-ui]");
  if (el) { S.ui[el.dataset.ui] = el.value; render(); }
});
let searchTimer;
document.addEventListener("input", e => {
  const el = e.target.closest("input[data-ui-search]");
  if (!el) return;
  S.ui[el.dataset.uiSearch] = el.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { render(); const again = document.querySelector(`input[data-ui-search="${el.dataset.uiSearch}"]`); if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); } }, 250);
});

// ------------------------------------------------------------- theming

function applyTeamColours() {
  const t = team(S.team);
  const root = document.documentElement.style;
  root.setProperty("--accent", t.c1);
  root.setProperty("--accent-2", t.c2);
  root.setProperty("--accent-ink", luminance(t.c1) > 0.5 ? "#111" : "#fff");
  document.querySelector('meta[name="theme-color"]').setAttribute("content", t.c2);
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => v / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// ----------------------------------------------------------------- theme

const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : { matches: false };
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function drawThemeButton() {
  const b = $("#theme-btn");
  if (!b) return;
  // The button shows the theme you'd switch to.
  b.innerHTML = isDark() ? `${SUN}Light` : `${MOON}Dark`;
  b.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
}

function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("nhlstats-theme", next); } catch (e) { /* private mode */ }
  drawThemeButton();
}

// --------------------------------------------------------------- hero

function renderHero() {
  const t = team(S.team);
  const st = standingsMap(S.data[S.season]?.standings)[S.team];
  const gs = games(S.season).filter(g => g.home === S.team || g.away === S.team);
  const next = gs.find(g => !g.final);
  const last = [...gs].reverse().find(g => g.final);
  const info = seasonInfo();
  let record = "", sub = "";
  if (st) {
    const all = Object.values(standingsMap(S.data[S.season]?.standings));
    const divRank = 1 + all.filter(x => x.div === st.div && x.pts > st.pts).length;
    const confRank = 1 + all.filter(x => x.conf === st.conf && x.pts > st.pts).length;
    record = `${st.w}-${st.l}-${st.otl} <b>${st.pts} pts</b> in ${st.gp} games`;
    sub = `${ord(divRank)} in the ${esc(st.div)}, ${ord(confRank)} in the ${esc(st.conf)} Conference. Last 10: ${esc(st.l10)}. ${info.label} season, ${info.games} games.`;
  }
  const card = (k, g) => {
    if (!g) return `<div class="gamecard"><div class="k">${k}</div><div class="v">None</div></div>`;
    const home = g.home === S.team, opp = home ? g.away : g.home;
    const vs = home ? "vs" : "at";
    if (g.final) {
      const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
      const res = us > them ? "W" : (g.ended && g.ended !== "REG" ? "OTL" : "L");
      return `<div class="gamecard"><div class="k">${k}</div><div class="v">${res} ${us}-${them} ${vs} ${esc(opp)}</div><div class="d">${dayFmt.format(dateOnly(g.date))}${g.ended && g.ended !== "REG" ? ` (${esc(g.ended)})` : ""}</div></div>`;
    }
    const live = g.live ? ` <span class="chip live">Live ${g.as ?? ""}-${g.hs ?? ""}</span>` : "";
    return `<div class="gamecard"><div class="k">${k}</div><div class="v">${vs} ${esc(team(opp).nick)}${live}</div><div class="d">${dayFmt.format(g.dateObj)}, ${timeFmt.format(g.dateObj)}</div></div>`;
  };
  $("#hero").innerHTML = `
    <div><h1>${esc(t.nick)}</h1><div class="record">${record || "&nbsp;"}</div><div class="sub">${sub}</div></div>
    <div class="games-strip">${card("Last game", last)}${card("Next game", next)}</div>`;
}

// ---------------------------------------------------------------- views

const V = {};

// Team overview ------------------------------------------------------------
V.team = async () => {
  await Promise.all(["standings", "schedule", "teamgames", "leaders", "goaliegames"].map(f => load(S.season, f)));
  const t = team(S.team);
  const tt = teamTotals(S.season);
  const me = tt[S.team];
  const st = standingsMap(S.data[S.season]?.standings);
  const sos = sosTable(S.season)[S.team];
  const tile = (k, v, r) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="r">${r || "&nbsp;"}</div></div>`;
  const rk = (key, desc = true) => { const r = rankOf(tt, S.team, key, desc); return r ? `${ord(r)} in the NHL` : ""; };
  // League ranks for standings-based numbers.
  const sv = Object.fromEntries(Object.values(st).map(x => [x.team, {
    gfpg: x.gp ? x.gf / x.gp : null, gapg: x.gp ? x.ga / x.gp : null, pct: x.gp ? x.pct : null,
  }]));
  const srk = (key, desc = true) => { const r = rankOf(sv, S.team, key, desc); return r ? `${ord(r)} in the NHL` : ""; };
  const pdoR = rankOf(tt, S.team, "pdo");
  const s = st[S.team];
  let html = `<h2>${esc(t.name)} at a glance</h2>`;
  html += `<div class="tiles">
    ${tile("5v5 expected goals share", me ? f1(me.xgfp) + "%" : "", rk("xgfp"))}
    ${tile("5v5 shot attempts share", me ? f1(me.cfp) + "%" : "", rk("cfp"))}
    ${tile("5v5 high-danger share", me ? f1(me.hdcfp) + "%" : "", rk("hdcfp"))}
    ${tile("5v5 PDO", me ? f3(me.pdo) : "", me ? `${pdoR ? ord(pdoR) + " in the NHL. " : ""}${me.pdo > 1.02 ? "Running hot" : me.pdo < 0.98 ? "Running cold" : "Near average"}` : "")}
    ${tile("Goals for per game", s && s.gp ? f2(s.gf / s.gp) : "", srk("gfpg"))}
    ${tile("Goals against per game", s && s.gp ? f2(s.ga / s.gp) : "", srk("gapg", false))}
    ${tile("Point pace", s && s.gp ? f0(s.pct * 2 * seasonInfo().games) : "", srk("pct"))}
    ${tile("Remaining schedule", sos?.left != null ? f3(sos.left) : "", sos?.leftRank ? `${ord(sos.leftRank)} hardest, ${sos.gamesLeft} games` : "")}
  </div>`;
  if (!S.manifest.nst) html += natNote();

  // rolling xG chart
  const log = teamLog(S.season, S.team);
  if (log.length) {
    html += `<h3>5v5 expected goals share, game by game</h3>`;
    html += lineChart([
      { name: "Each game", color: "color-mix(in srgb, var(--accent) 45%, transparent)", values: log.map(g => g.xg5), width: 1.5, dots: true },
      { name: "Last 5 games", color: t.c1, values: log.map(g => g.roll5), width: 3.5 },
    ], { ref: 50, xLabels: log.map(g => g.opp), fmt: f1 });
  }

  html += `<div class="cols"><div>`;
  // goalies
  const glog = goalieLog(S.season, S.team, "all");
  html += `<h3>Goalies</h3>`;
  html += glog.tally.length ? goalieTallyTable(glog.tally, "team-gt") : `<p class="empty">No goalie games yet.</p>`;
  html += `</div><div>`;
  // top scorers
  const leaders = rowsOf(S.data[S.season]?.leaders).filter(p => lastTeam(p.teams) === S.team).sort((a, b) => b.p - a.p || b.g - a.g).slice(0, 8);
  html += `<h3>Top scorers</h3>`;
  html += table({
    id: "team-lead", rows: leaders, cols: [
      { k: "name", l: "Player", num: false, f: (v, r) => playerBtn(v, r.id) },
      { k: "pos", l: "Pos", num: false }, { k: "gp", l: "GP" }, { k: "g", l: "G" }, { k: "a", l: "A" }, { k: "p", l: "P" },
    ],
  });
  html += `</div></div>`;
  return html;
};

function natNote() {
  return `<p class="note">Natural Stat Trick data (expected goals, shot shares, skater stats) isn't loading yet. The site owner needs to add the NST key as a repository secret named NST_KEY.</p>`;
}

const lastTeam = s => String(s || "").split(/[,/]/).map(x => x.trim()).filter(Boolean).pop() || "";

// Standings ---------------------------------------------------------------
V.standings = async () => {
  await Promise.all(["standings", "schedule"].map(f => load(S.season, f)));
  const st = S.data[S.season]?.standings;
  if (!st) return `<h2>Standings</h2><p class="empty">Standings aren't available for this season yet.</p>`;
  const games = seasonInfo().games;
  const rows = st.teams.map(t => {
    const left = games - t.gp;
    const ppg = t.gp ? t.pts / t.gp : 0;
    return {
      ...t, diff: t.gf - t.ga, left, maxPts: t.pts + 2 * left,
      pace: t.pct * 2 * games, proj: t.pts + ppg * left,
      p321: 3 * t.rw + 2 * (t.w - t.rw) + t.otl,
      gfpg: t.gp ? t.gf / t.gp : null, gapg: t.gp ? t.ga / t.gp : null,
    };
  });
  const mine = rows.find(r => r.team === S.team);
  const group = ui("st-group", "division");
  const cols = [
    { k: "team", l: "Team", num: false, f: v => teamCell(v, true), v: r => r.name },
    { k: "gp", l: "GP" }, { k: "w", l: "W" }, { k: "l", l: "L" }, { k: "otl", l: "OTL" },
    { k: "pts", l: "PTS", f: v => `<b>${v}</b>` },
    { k: "pct", l: "P%", f: f3 },
    { k: "rw", l: "RW" }, { k: "row", l: "ROW" },
    { k: "gf", l: "GF" }, { k: "ga", l: "GA" },
    { k: "diff", l: "DIFF", f: v => sgn(v, 0), cls: v => signCls(v) },
    { k: "gfpg", l: "GF/GP", f: f2 }, { k: "gapg", l: "GA/GP", f: f2 },
    { k: "pace", l: "Pace", f: f0, title: "Points % over a full season" },
    { k: "maxPts", l: "Max", title: "Most points still possible" },
    { k: "p321", l: "3-2-1", title: "Points if regulation wins were worth 3 and OT/shootout wins 2" },
    { k: "home", l: "Home", num: false, nosort: true }, { k: "road", l: "Road", num: false, nosort: true },
    { k: "l10", l: "L10", num: false, nosort: true }, { k: "streak", l: "Strk", num: false, nosort: true },
  ];
  const rowCls = r => r.team === S.team ? "hl" : "";
  const byPts = (a, b) => b.pts - a.pts || a.gp - b.gp || b.rw - a.rw || b.row - a.row || b.diff - a.diff;
  let html = `<h2>Standings</h2><p class="lede">${seasonInfo().label} season, ${games} games. Tap a column to sort; it starts sorted by points. Standings date: ${esc(st.date)}.</p>`;
  html += `<div class="controls">${seg("st-group", [["division", "Division"], ["conference", "Conference"], ["wildcard", "Wild card"], ["league", "League"]], group)}</div>`;
  const block = (title, list, id, cutAfter) => {
    const sorted = list.slice().sort(byPts);
    return `<h3>${esc(title)}</h3>` + table({ id, colKey: "standings", rows: sorted, cols, rowCls: (r, i) => [rowCls(r), cutAfter != null && i === cutAfter ? "sep" : ""].join(" ") });
  };
  const confs = [...new Set(rows.map(r => r.conf))].sort();
  if (group === "league") {
    html += block("League", rows, "st-league");
  } else if (group === "conference") {
    for (const c of confs) html += block(`${c} Conference`, rows.filter(r => r.conf === c), `st-${c}`, 8);
  } else if (group === "wildcard") {
    for (const c of confs) {
      const inConf = rows.filter(r => r.conf === c);
      const divs = [...new Set(inConf.map(r => r.div))].sort();
      const top = divs.flatMap(d => inConf.filter(r => r.div === d).sort(byPts).slice(0, 3));
      for (const d of divs) html += block(`${d} top three`, top.filter(r => r.div === d), `st-wc-${d}`);
      html += block(`${c} wild card`, inConf.filter(r => !top.includes(r)), `st-wc-${c}`, 2);
    }
  } else {
    const divs = [...new Set(rows.map(r => r.div))].sort();
    for (const d of divs) html += block(d, rows.filter(r => r.div === d), `st-${d}`);
  }

  return html;
};

// Magic number ---------------------------------------------------------------
/* Same logic as the spreadsheet's Magic Number tab, against every team in the
   chosen team's conference:
     Magic #   other team's max possible points - our points
     Status    "Ahead" when they've clinched finishing ahead of us, "Behind" when
               we've clinched finishing ahead of them. On an exact tie of max
               points, tiebreakers are regulation wins, then regulation + OT wins. */
V.magic = async () => {
  await load(S.season, "standings");
  const st = S.data[S.season]?.standings;
  if (!st) return `<h2>Magic number</h2><p class="empty">Standings aren't available for this season yet.</p>`;
  const games = seasonInfo().games;
  const all = st.teams.map(t => {
    const left = Math.max(0, games - t.gp);
    return { ...t, left, maxPts: t.pts + 2 * left, maxRw: t.rw + left, maxRow: t.row + left, ppg: t.gp ? t.pts / t.gp : 0 };
  });
  const focus = all.find(t => t.team === S.team);
  if (!focus) return `<h2>Magic number</h2><p class="empty">No standings for this team yet.</p>`;
  const conf = all.filter(t => t.conf === focus.conf);
  const pick = conf.some(t => t.team === ui("mg-team")) ? ui("mg-team") : S.team;
  const F = conf.find(t => t.team === pick);
  const nick = team(F.team).nick;

  const rows = conf.map(X => {
    const magic = X.maxPts - F.pts;
    let status = "";
    if (X.team === F.team) status = "self";
    else if (X.pts > F.maxPts) status = "ahead";            // they've clinched finishing ahead
    else if (F.pts > X.maxPts) status = "behind";           // we've clinched finishing ahead
    else if (magic === 0) {                                 // they can only tie us
      if (X.maxRw < F.rw) status = "behind";
      else if (X.maxRw > F.rw) status = "";
      else if (X.maxRow < F.row) status = "behind";
      else if (X.maxRow === F.row) status = "tiebreak3";
    }
    const tragic = F.maxPts - X.pts;                        // points we can still afford to give up to them
    return { ...X, magic, status, tragic };
  });
  // Conference rank by points per game, like the spreadsheet.
  const ranked = conf.slice().sort((a, b) => b.ppg - a.ppg);
  rows.forEach(r => { r.rank = 1 + ranked.filter(x => x.ppg > r.ppg).length; });

  const others = rows.filter(r => r.status !== "self");
  const behind = others.filter(r => r.status === "behind").length;
  const ahead = others.filter(r => r.status === "ahead").length;
  const spots = 8, size = conf.length;
  const clinched = behind >= size - spots;
  const eliminated = ahead >= spots;
  const leftToEliminate = Math.max(0, size - spots - behind);
  // Playoff magic number: points (ours gained plus theirs lost) to be sure of
  // finishing ahead of enough teams for a top-8 spot.
  const mags = others.map(r => r.status === "behind" ? 0 : r.magic + 1).sort((a, b) => a - b);
  const playoffMagic = clinched ? 0 : mags[size - spots - 1];
  const tragics = others.map(r => r.status === "ahead" ? 0 : r.tragic + 1).sort((a, b) => a - b);
  const tragicNumber = eliminated ? 0 : tragics[spots - 1];

  const tile = (k, v, r) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="r">${r || "&nbsp;"}</div></div>`;
  let html = `<h2>${esc(nick)} magic number</h2>
    <p class="lede">The race in the ${esc(F.conf)} Conference, with ${games} games in the ${seasonInfo().label} season. A magic number is the combination of ${esc(nick)} points gained and the other team's points lost that guarantees finishing ahead of them.</p>`;
  html += `<div class="controls">${select("mg-team", "Magic number for", conf.slice().sort((a, b) => a.name.localeCompare(b.name)).map(t => [t.team, t.name]), F.team)}</div>`;
  html += `<div class="tiles">
    ${tile("Clinched a playoff spot?", clinched ? "Yes" : "No", clinched ? "Guaranteed a top-8 finish" : `${leftToEliminate} more team${leftToEliminate === 1 ? "" : "s"} to clinch ahead of`)}
    ${tile("Playoff magic number", clinched ? "Clinched" : (playoffMagic ?? ""), clinched ? "" : "Points gained plus rivals' points lost")}
    ${tile("Eliminated?", eliminated ? "Yes" : "No", `${ahead} team${ahead === 1 ? " has" : "s have"} clinched ahead`)}
    ${tile("Elimination number", eliminated ? "Out" : (tragicNumber ?? ""), eliminated ? "" : "Points lost plus rivals' points gained")}
    ${tile("Points", F.pts, `${F.gp} games played, ${F.left} left`)}
    ${tile("Most possible", F.maxPts, `Regulation wins ${F.rw}, RW + OT wins ${F.row}`)}
  </div>`;
  const statusText = r => ({
    self: "",
    ahead: `Clinched ahead of ${nick}`,
    behind: `${nick} clinched ahead`,
    tiebreak3: "Tied to the 3rd tiebreaker",
  })[r.status] ?? "Still possible";
  html += `<h3>Against each ${esc(F.conf)} team</h3>`;
  html += table({
    id: "magic", rows, sort: { k: "pts", dir: "desc" },
    rowCls: r => r.team === F.team ? "hl" : "",
    cols: [
      { k: "name", l: "Team", num: false, f: (v, r) => teamCell(r.team, true) },
      { k: "gp", l: "GP" }, { k: "left", l: "GR", title: "Games remaining" },
      { k: "pts", l: "PTS", f: v => `<b>${v}</b>` },
      { k: "rw", l: "RW" }, { k: "maxRw", l: "Max RW" },
      { k: "row", l: "ROW" }, { k: "maxRow", l: "Max ROW" },
      { k: "ppg", l: "PPG", f: f3 }, { k: "rank", l: "Conf rank", title: "By points per game" },
      { k: "maxPts", l: "Max PTS" },
      { k: "magic", l: "Magic #", f: (v, r) => r.status === "self" ? "" : r.status === "behind" ? "Clinched" : r.status === "ahead" ? "Out of reach" : String(v) },
      { k: "status", l: `vs ${nick}`, num: false, f: (v, r) => {
          const t = statusText(r);
          return r.status === "behind" ? `<span class="chip good">${esc(t)}</span>` : r.status === "ahead" ? `<span class="chip bad">${esc(t)}</span>` : r.status === "tiebreak3" ? `<span class="chip mid">${esc(t)}</span>` : `<span class="tag">${esc(t)}</span>`;
        } },
    ],
  });
  html += definitions([
    ["Magic #", `Other team's most possible points minus ${nick}'s points. When it reaches zero they can at best tie, and the regulation-wins tiebreaker decides it.`],
    ["Clinched ahead", `${nick} can't be caught by that team, even if they win every remaining game.`],
    ["Playoff magic number", `How many points (${nick} gained plus rivals lost) guarantee finishing ahead of enough teams for a top-8 spot. Like the table, it ignores tiebreakers beyond regulation wins.`],
    ["Elimination number", `How many points (${nick} lost plus rivals gained) before 8 teams are guaranteed to finish ahead.`],
    ["Max RW and Max ROW", "Regulation wins, and regulation plus overtime wins, if the team wins every remaining game in regulation. Used for tiebreakers."],
  ]);
  return html;
};

// Schedule -----------------------------------------------------------------
V.schedule = async () => {
  await Promise.all(["standings", "schedule", "teamgames"].map(f => load(S.season, f)));
  const st = standingsMap(S.data[S.season]?.standings);
  const tg = teamGames(S.season), tt = teamTotals(S.season);
  const sos = sosTable(S.season);
  const mine = games(S.season).filter(g => g.home === S.team || g.away === S.team);
  if (!mine.length) return `<h2>Schedule</h2><p class="empty">No schedule for this season yet.</p>`;
  const nextIdx = mine.findIndex(g => !g.final);
  const rows = mine.map((g, i) => {
    const home = g.home === S.team, opp = home ? g.away : g.home;
    let res = "";
    if (g.final) {
      const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
      res = (us > them ? "W" : g.ended && g.ended !== "REG" ? "OTL" : "L") + ` ${us}-${them}` + (g.ended && g.ended !== "REG" ? ` (${g.ended})` : "");
    } else if (g.live) res = `Live ${home ? g.hs : g.as}-${home ? g.as : g.hs}`;
    const mineRow = tg[`${g.date}|${S.team}|5v5`];
    const share = (f, a) => mineRow && (mineRow[f] + mineRow[a]) ? 100 * mineRow[f] / (mineRow[f] + mineRow[a]) : null;
    const gx = share("xGF", "xGA");
    const played = g.final && gx != null;
    return {
      n: i + 1, g, opp, ha: home ? "H" : "A", res,
      xg: g.final && gx != null ? gx : tt[S.team]?.xgfp,
      oxg: g.final && gx != null ? 100 - gx : tt[opp]?.xgfp,
      fromGame: g.final && gx != null,
      opct: st[opp]?.pct, osos: sos[opp]?.all, oleft: sos[opp]?.left,
      cf: played ? share("CF", "CA") : tt[S.team]?.cfp,
      ocf: played ? 100 - share("CF", "CA") : tt[opp]?.cfp,
      scf: played ? share("SCF", "SCA") : tt[S.team]?.scfp,
      hd: played ? share("HDCF", "HDCA") : tt[S.team]?.hdcfp,
      ohd: played ? 100 - share("HDCF", "HDCA") : tt[opp]?.hdcfp,
      xgfor: played ? mineRow.xGF : null, xgagainst: played ? mineRow.xGA : null,
    };
  });
  const s = sos[S.team] || {};
  let html = `<h2>${esc(team(S.team).nick)} schedule</h2>`;
  html += `<div class="tiles">
    <div class="tile"><div class="k">Strength of schedule, full season</div><div class="v">${f3(s.all)}</div><div class="r">${s.allRank ? ord(s.allRank) + " hardest" : ""}</div></div>
    <div class="tile"><div class="k">Played so far</div><div class="v">${f3(s.played)}</div><div class="r">${s.playedRank ? ord(s.playedRank) + " hardest" : ""}</div></div>
    <div class="tile"><div class="k">Remaining</div><div class="v">${f3(s.left)}</div><div class="r">${s.leftRank ? ord(s.leftRank) + ` hardest, ${s.gamesLeft} games` : ""}</div></div>
  </div>`;
  html += `<p class="lede">Strength of schedule is the average points % of the opponents, using current standings. The Natural Stat Trick numbers are at 5v5: played games show that game, upcoming games show each team's season so far (in grey). Use Columns to pick what you see.</p>`;
  html += table({
    id: "sched", rows,
    rowCls: (r, i) => r.n - 1 === nextIdx ? "next" : r.g.live ? "live" : "",
    cols: [
      { k: "n", l: "#" },
      { k: "date", l: "Date", num: false, v: r => r.g.start, f: (v, r) => dayFmt.format(r.g.dateObj) },
      { k: "time", l: "Time", num: false, nosort: true, f: (v, r) => r.g.final ? "" : timeFmt.format(r.g.dateObj) },
      { k: "opp", l: "Opp", num: false, f: v => teamCell(v) },
      { k: "ha", l: "H/A", num: false },
      { k: "res", l: "Result", num: false, f: (v, r) => r.g.final ? `<a href="${nstGameUrl(S.season, r.g.id)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v), cls: v => /^W/.test(v) ? "pos" : /^(L|OTL)/.test(v) ? "neg" : "" },
      { k: "xg", l: `${team(S.team).nick} xGF%`, f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>`, cls: (v, r) => r.fromGame ? shareCls(v) : "" },
      { k: "oxg", l: "Opp xGF%", f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>` },
      { k: "xgfor", l: "xGF", f: f2, title: "Expected goals for, 5v5" },
      { k: "xgagainst", l: "xGA", f: f2, title: "Expected goals against, 5v5" },
      { k: "cf", l: `${team(S.team).nick} CF%`, f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>`, cls: (v, r) => r.fromGame ? shareCls(v) : "", title: "Shot attempts share, 5v5" },
      { k: "ocf", l: "Opp CF%", f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>` },
      { k: "scf", l: `${team(S.team).nick} SCF%`, f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>`, cls: (v, r) => r.fromGame ? shareCls(v) : "", title: "Scoring chances share, 5v5" },
      { k: "hd", l: `${team(S.team).nick} HDCF%`, f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>`, cls: (v, r) => r.fromGame ? shareCls(v) : "", title: "High-danger chances share, 5v5" },
      { k: "ohd", l: "Opp HDCF%", f: (v, r) => v == null ? "" : `<span${r.fromGame ? "" : ' class="tag"'}>${f1(v)}</span>` },
      { k: "opct", l: "Opp P%", f: f3 },
      { k: "osos", l: "Opp SOS", f: f3, title: "Opponent's own full-season strength of schedule" },
      { k: "oleft", l: "Opp SOS left", f: f3, title: "Opponent's remaining strength of schedule" },
    ],
  });
  // league SOS
  html += `<h3>Strength of schedule, every team</h3>`;
  const all = Object.values(sos).map(x => ({ ...x, pct: st[x.team]?.pct, xg: tt[x.team]?.xgfp, name: team(x.team).name }));
  html += table({
    id: "sos", rows: all, sort: { k: "left", dir: "desc" }, rowCls: r => r.team === S.team ? "hl" : "",
    cols: [
      { k: "name", l: "Team", num: false, f: (v, r) => teamCell(r.team, true) },
      { k: "pct", l: "P%", f: f3 }, { k: "xg", l: "5v5 xGF%", f: f1, cls: shareCls },
      { k: "all", l: "SOS season", f: f3 }, { k: "played", l: "SOS played", f: f3 },
      { k: "left", l: "SOS left", f: f3 }, { k: "gamesLeft", l: "Games left" },
      { k: "leftRank", l: "Rank left", title: "1 = hardest remaining schedule", sort: "asc" },
    ],
  });
  return html;
};

// Recent games (always the current season) ---------------------------------
V.recent = async () => {
  const cur = S.manifest.current;
  await Promise.all(["standings", "schedule", "teamgames"].map(f => load(cur, f)));
  const gs = games(cur);
  if (!gs.length) return `<h2>Recent NHL games</h2><p class="empty">No games loaded yet.</p>`;
  const today = localISO(new Date());
  const addDays = (iso, n) => localISO(new Date(dateOnly(iso).getTime() + n * 864e5));
  const started = gs.some(g => g.date === today && (g.final || g.live));
  const upcoming = gs.filter(g => g.date >= (started ? addDays(today, 1) : today)).map(g => g.date).sort();
  const hi = upcoming[0] || today;
  const lo = addDays(today, -3);
  const win = gs.filter(g => g.date >= lo && g.date <= hi).sort((a, b) => b.date.localeCompare(a.date) || a.dateObj - b.dateObj);
  const tg = teamGames(cur), tt = teamTotals(cur);
  const share = (a, b) => a + b ? 100 * a / (a + b) : null;
  const rows = win.map(g => {
    const a = tg[`${g.date}|${g.away}|5v5`];
    const has = g.final && a && (a.CF + a.CA) > 0;
    const status = g.final ? `Final: ${g.away} ${g.as} - ${g.home} ${g.hs}${g.ended && g.ended !== "REG" ? ` (${g.ended})` : ""}`
      : g.live ? `Live: ${g.away} ${g.as ?? 0} - ${g.home} ${g.hs ?? 0}` : "Upcoming";
    const pick = (k, side) => has ? (side === "a" ? share(a[k + "F"], a[k + "A"]) : 100 - share(a[k + "F"], a[k + "A"])) : tt[side === "a" ? g.away : g.home]?.[k.toLowerCase() + "fp"];
    return {
      g, status, has,
      axg: pick("xG", "a"), hxg: pick("xG", "h"),
      acf: pick("C", "a"), hcf: pick("C", "h"),
      ahd: pick("HDC", "a"), hhd: pick("HDC", "h"),
      xg: has ? `${f2(a.xGF)} - ${f2(a.xGA)}` : "",
    };
  });
  // NB: teamTotals keys are cfp/xgfp/hdcfp; map the pick() names onto them
  for (const r of rows) {
    if (!r.has) {
      const A = tt[r.g.away] || {}, H = tt[r.g.home] || {};
      Object.assign(r, { axg: A.xgfp, hxg: H.xgfp, acf: A.cfp, hcf: H.cfp, ahd: A.hdcfp, hhd: H.hdcfp });
    }
  }
  let html = `<h2>Recent NHL games</h2><p class="lede">The last three nights and the next night of games across the league. Once tonight's games start, tomorrow's appear too. Played games show that game's 5v5 numbers from Natural Stat Trick (tap the score to open the game); upcoming and live games show each team's season so far. Times are in your time zone.</p>`;
  if (!S.manifest.nst) html += natNote();
  let lastDate = null;
  html += table({
    id: "recent", rows,
    rowCls: r => {
      const c = [];
      if (r.g.home === S.team || r.g.away === S.team) c.push("hl");
      if (r.g.live) c.push("live");
      if (lastDate && lastDate !== r.g.date) c.push("sep");
      lastDate = r.g.date;
      return c.join(" ");
    },
    cols: [
      { k: "date", l: "Date", num: false, nosort: true, f: (v, r) => dayFmt.format(dateOnly(r.g.date)) },
      { k: "time", l: "Time", num: false, nosort: true, f: (v, r) => timeFmt.format(r.g.dateObj) },
      { k: "away", l: "Away", num: false, nosort: true, f: (v, r) => teamCell(r.g.away) },
      { k: "home", l: "Home", num: false, nosort: true, f: (v, r) => teamCell(r.g.home) },
      { k: "status", l: "Score", num: false, nosort: true, f: (v, r) => r.g.final ? `<a href="${nstGameUrl(cur, r.g.id)}" target="_blank" rel="noopener">${esc(v)}</a>` : r.g.live ? `<span class="chip live">${esc(v)}</span>` : `<span class="tag">${esc(v)}</span>` },
      { k: "src", l: "Stats", num: false, nosort: true, f: (v, r) => r.has ? "This game" : `<span class="tag">Season</span>` },
      { k: "axg", l: "Away xGF%", nosort: true, f: f1, cls: (v, r) => r.has ? shareCls(v) : "" },
      { k: "hxg", l: "Home xGF%", nosort: true, f: f1, cls: (v, r) => r.has ? shareCls(v) : "" },
      { k: "acf", l: "Away CF%", nosort: true, f: f1 }, { k: "hcf", l: "Home CF%", nosort: true, f: f1 },
      { k: "ahd", l: "Away HDCF%", nosort: true, f: f1 }, { k: "hhd", l: "Home HDCF%", nosort: true, f: f1 },
      { k: "xg", l: "xG (away - home)", num: false, nosort: true },
    ],
  });
  return html;
};

// Game log -----------------------------------------------------------------
function teamLog(season, code) {
  return cached(`log${season}${code}`, () => {
    const tg = teamGames(season);
    const sched = games(season).filter(g => (g.home === code || g.away === code) && g.final);
    const out = [];
    for (const g of sched) {
      const all = tg[`${g.date}|${code}|all`], five = tg[`${g.date}|${code}|5v5`];
      if (!all && !five) continue;
      const home = g.home === code;
      const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
      const share = (r, a, b) => r && (r[a] + r[b]) ? 100 * r[a] / (r[a] + r[b]) : null;
      out.push({
        g, date: g.date, opp: home ? g.away : g.home, ha: home ? "H" : "A",
        res: (us > them ? "W" : g.ended && g.ended !== "REG" ? "OTL" : "L") + ` ${us}-${them}` + (g.ended && g.ended !== "REG" ? ` (${g.ended})` : ""),
        gf: all?.GF, ga: all?.GA, xgf: all?.xGF, xga: all?.xGA, xg: share(all, "xGF", "xGA"),
        xgf5: five?.xGF, xga5: five?.xGA, xg5: share(five, "xGF", "xGA"),
        cf5: share(five, "CF", "CA"),
        hdcf: all?.HDCF, hdca: all?.HDCA, hd: share(all, "HDCF", "HDCA"),
      });
    }
    out.forEach((r, i) => {
      const win = out.slice(Math.max(0, i - 4), i + 1);
      const f = win.reduce((a, x) => a + (x.xgf5 || 0), 0), a = win.reduce((s, x) => s + (x.xga5 || 0), 0);
      r.roll5 = f + a ? 100 * f / (f + a) : null;
    });
    return out;
  });
}

V.gamelog = async () => {
  await Promise.all(["schedule", "teamgames"].map(f => load(S.season, f)));
  const log = teamLog(S.season, S.team);
  const t = team(S.team);
  let html = `<h2>${esc(t.nick)} game log</h2><p class="lede">Every regular-season game from Natural Stat Trick. GF to xG% are all situations; the 5v5 columns are even strength without empty nets. The rolling column covers the last 5 games at 5v5. Tap a result to open NST's game page.</p>`;
  if (!S.manifest.nst) html += natNote();
  if (!log.length) return html + `<p class="empty">No games yet.</p>`;
  html += lineChart([
    { name: "5v5 xG% each game", color: "color-mix(in srgb, var(--accent) 45%, transparent)", values: log.map(g => g.xg5), width: 1.5, dots: true },
    { name: "Last 5 games", color: t.c1, values: log.map(g => g.roll5), width: 3.5 },
  ], { ref: 50, xLabels: log.map(g => g.opp) });
  const sum = k => log.reduce((a, r) => a + (r[k] || 0), 0);
  const share = (a, b) => a + b ? 100 * a / (a + b) : null;
  const total = {
    total: true, date: "", opp: "", ha: "", res: `${log.length} games`,
    gf: sum("gf"), ga: sum("ga"), xgf: sum("xgf"), xga: sum("xga"), xg: share(sum("xgf"), sum("xga")),
    xgf5: sum("xgf5"), xga5: sum("xga5"), xg5: share(sum("xgf5"), sum("xga5")),
    hdcf: sum("hdcf"), hdca: sum("hdca"), hd: share(sum("hdcf"), sum("hdca")),
  };
  const rows = [...log].reverse();
  html += `<h3>Games, newest first</h3>`;
  html += table({
    id: "gamelog", rows: [...rows, total], rowCls: r => r.total ? "total" : "",
    cols: [
      { k: "date", l: "Date", num: false, nosort: true, f: (v, r) => r.total ? "Season" : dayFmt.format(dateOnly(v)) },
      { k: "opp", l: "Opp", num: false, nosort: true, f: (v, r) => r.total ? "" : `${r.ha === "A" ? "at " : ""}${teamCell(v)}` },
      { k: "res", l: "Result", num: false, nosort: true, f: (v, r) => r.total ? esc(v) : `<a href="${nstGameUrl(S.season, r.g.id)}" target="_blank" rel="noopener">${esc(v)}</a>`, cls: v => /^W/.test(v) ? "pos" : /^(L|OTL)/.test(v) ? "neg" : "" },
      { k: "gf", l: "GF", nosort: true, f: f0 }, { k: "ga", l: "GA", nosort: true, f: f0 },
      { k: "xgf", l: "xGF", nosort: true, f: f2 }, { k: "xga", l: "xGA", nosort: true, f: f2 },
      { k: "xg", l: "xG%", nosort: true, f: f1, cls: shareCls },
      { k: "xgf5", l: "5v5 xGF", nosort: true, f: f2 }, { k: "xga5", l: "5v5 xGA", nosort: true, f: f2 },
      { k: "xg5", l: "5v5 xG%", nosort: true, f: f1, cls: shareCls },
      { k: "roll5", l: "Rolling 5v5 xG%", nosort: true, f: f1, cls: shareCls },
      { k: "hdcf", l: "HDCF", nosort: true, f: f0 }, { k: "hdca", l: "HDCA", nosort: true, f: f0 },
      { k: "hd", l: "HDCF%", nosort: true, f: f1, cls: shareCls },
    ],
  });
  return html;
};

// Skaters ------------------------------------------------------------------
const normName = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

function playerIndex(season) {
  return cached(`pidx${season}`, () => {
    const m = {};
    for (const p of rowsOf(S.data[season]?.leaders)) m[normName(p.name)] = p;
    return m;
  });
}

function playerBtn(name, id) {
  return `<button type="button" class="namebtn" data-player="${esc(name)}" data-pid="${esc(id ?? "")}">${esc(name)}</button>`;
}

document.addEventListener("click", e => {
  const b = e.target.closest("button[data-player]");
  if (b) openPlayer(b.dataset.player, b.dataset.pid, b.dataset.goalie === "1");
});

function openPlayer(name, pid, goalie) {
  const p = playerIndex(S.season)[normName(name)];
  const id = pid || p?.id || "";
  const slug = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const q = encodeURIComponent(name);
  const links = [
    id && ["NHL.com", "Bio, game log, career", `https://www.nhl.com/player/${id}`],
    ["HockeyDB", "Career stats, every league", `https://www.hockeydb.com/ihdb/stats/find_player.php?full_name=${q}`],
    ["PuckPedia", "Contract and cap hit", `https://puckpedia.com/player/${slug}`],
    id && ["MoneyPuck", "Expected goals, cards", `https://moneypuck.com/player.htm?p=${id}`],
    id && ["Natural Stat Trick", "Player report", `https://www.naturalstattrick.com/playerreport.php?fromseason=${S.season}&thruseason=${S.season}&playerid=${id}&sit=5v5&stype=2`],
    ["Elite Prospects", "Development path, junior and Europe", `https://www.eliteprospects.com/search/player?q=${q}`],
  ].filter(Boolean);
  let stat = "";
  if (p && !goalie) {
    stat = `<div class="statline">
      <div><b>${p.gp}</b><span>GP</span></div><div><b>${p.g}</b><span>Goals</span></div>
      <div><b>${p.a}</b><span>Assists</span></div><div><b>${p.p}</b><span>Points</span></div></div>`;
  }
  $("#player-sheet-body").innerHTML = `<h3>${esc(name)}</h3>
    <div class="tag">${esc(p ? `${p.pos} for ${lastTeam(p.teams)}` : "")} ${seasonInfo().label}</div>
    ${stat}
    <div class="links-grid">${links.map(([l, d, u]) => `<a href="${u}" target="_blank" rel="noopener">${l}<small>${d}</small></a>`).join("")}</div>
    ${id ? "" : `<p class="tag">No NHL player ID found, so the NHL.com, MoneyPuck and NST links are missing; the others use a name search.</p>`}`;
  const d = $("#player-sheet");
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
}

V.skaters = async () => {
  await Promise.all(["skaters", "leaders", "standings"].map(f => load(S.season, f)));
  const sit = ui("sk-sit", "5v5"), scope = ui("sk-scope", "team"), pos = ui("sk-pos", "all"), q = normName(ui("sk-q", ""));
  const minToi = scope === "all" ? Number(ui("sk-toi", 0)) || 0 : 0;
  const t = team(S.team);
  let html = `<h2>${scope === "team" ? esc(t.nick) + " skaters" : "All skaters"}</h2><p class="lede">Natural Stat Trick individual and on-ice stats. Tap a column to sort, or a name for that player's pages on NHL.com, HockeyDB, PuckPedia, MoneyPuck and more. Definitions are at the bottom.</p>`;
  html += `<div class="controls">
    ${seg("sk-scope", [["team", t.nick], ["all", "All teams"]], scope)}
    ${select("sk-sit", "Situation", [["5v5", "5 on 5"], ["all", "All situations"], ["ev", "Even strength"], ["pp", "Power play"], ["pk", "Penalty kill"]], sit)}
    ${select("sk-pos", "Position", [["all", "All"], ["F", "Forwards"], ["D", "Defence"]], pos)}
    ${scope === "all" ? numberInput("sk-toi", "Min TOI (minutes)", minToi) : ""}
    <label>Find a player<input type="search" data-ui-search="sk-q" value="${esc(ui("sk-q", ""))}" placeholder="Name"></label>
  </div>`;
  if (!S.manifest.nst) return html + natNote();
  const all = rowsOf(S.data[S.season]?.skaters).filter(r => r.sit === sit);
  if (!all.length) return html + `<p class="empty">No skater data for this season yet.</p>`;
  const pidx = playerIndex(S.season);
  let rows = all.filter(r => (scope === "all" || r.team.split(",").map(s => s.trim()).includes(S.team))
    && (pos === "all" || (pos === "D" ? r.pos === "D" : r.pos !== "D"))
    && (!q || normName(r.name).includes(q))
    && (r.toi ?? 0) >= minToi);
  rows = rows.map(r => ({ ...r, fin: r.g != null && r.ixg != null ? r.g - r.ixg : null, pid: pidx[normName(r.name)]?.id }));
  const cols = [
    { k: "name", l: "Player", num: false, f: (v, r) => playerBtn(v, r.pid) },
    ...(scope === "all" ? [{ k: "team", l: "Team", num: false }] : []),
    { k: "pos", l: "Pos", num: false }, { k: "gp", l: "GP" }, { k: "toi", l: "TOI", f: f1 },
    { k: "g", l: "G", f: f0 }, { k: "a", l: "A", f: f0 }, { k: "p", l: "P", f: f0 },
    { k: "ixg", l: "ixG", f: f2 }, { k: "fin", l: "G − ixG", f: v => sgn(v), cls: v => signCls(v, 0.5) },
    { k: "ihdcf", l: "iHDCF", f: f0 },
    { k: "cf", l: "CF%", f: f1, cls: shareCls }, { k: "xgf", l: "xGF%", f: f1, cls: shareCls },
    { k: "hdcf", l: "HDCF%", f: f1, cls: shareCls }, { k: "gfp", l: "GF%", f: f1, cls: shareCls },
    { k: "oish", l: "On-ice SH%", f: f1 }, { k: "oisv", l: "On-ice SV%", f: f1 },
    { k: "pdo", l: "PDO", f: f3 }, { k: "ozs", l: "OZS%", f: f1 },
  ];
  html += table({ id: `sk-${scope}`, colKey: "skaters", rows, cols, sort: { k: "toi", dir: "desc" }, limit: scope === "all" ? 400 : null });
  html += definitions([
    ["TOI", "Minutes on the ice in the chosen situation."],
    ["ixG", "Individual expected goals: how many goals an average shooter would score from this player's own shots."],
    ["G − ixG", "Goals minus ixG. Positive means finishing above expected; big gaps usually shrink."],
    ["iHDCF", "The player's own high-danger chances (slot and crease)."],
    ["CF%", "Share of all shot attempts while he's on the ice."],
    ["xGF%", "Share of expected goals while he's on the ice; the best single measure of on-ice play."],
    ["HDCF%", "Share of high-danger chances while he's on the ice."],
    ["GF%", "Share of actual goals while he's on the ice; noisier than xGF%."],
    ["On-ice SH% and SV%", "His team's shooting and save percentages while he's on the ice."],
    ["PDO", "On-ice SH% plus SV%, where 1.000 is average. Far from 1.000 tends to come back."],
    ["OZS%", "Share of his offensive and defensive zone faceoff starts in the offensive zone."],
  ]);
  return html;
};

function definitions(list) {
  return `<h3>Definitions</h3><dl class="cols">${list.map(([k, v]) => `<div><dt><b>${esc(k)}</b></dt><dd style="margin:0 0 10px">${esc(v)}</dd></div>`).join("")}</dl>`;
}

// Goalies (league) ---------------------------------------------------------
V.goalies = async () => {
  await load(S.season, "goalies");
  const sit = ui("g-sit", "all"), minGp = Number(ui("g-gp", 1)) || 0, minMin = Number(ui("g-min", 0)) || 0;
  let html = `<h2>NHL goalies</h2><p class="lede">Every goalie from MoneyPuck. GSAx is goals saved above expected: expected goals against minus goals against, so positive means better than an average goalie on the same shots. Tap a column heading to sort; the rank follows the sort. When sorting by GSAx/60, set a minimum of a few hundred minutes so short stints don't top the list.</p>`;
  html += `<div class="controls">
    ${select("g-sit", "Situation", [["all", "All"], ["5on5", "5 on 5"], ["4on5", "Penalty kill"], ["5on4", "Power play"], ["other", "Other"]], sit)}
    ${numberInput("g-gp", "Min games", minGp)}
    ${numberInput("g-min", "Min minutes", minMin)}
  </div>`;
  const data = rowsOf(S.data[S.season]?.goalies);
  if (!data.length) return html + `<p class="empty">No goalie data for this season yet.</p>`;
  let rows = data.filter(r => r.sit === sit && r.gp >= minGp && r.toi >= minMin).map(r => ({
    ...r, gsax: r.xga - r.ga, gsax60: r.toi ? (r.xga - r.ga) / r.toi * 60 : null,
    sv: r.sa ? 1 - r.ga / r.sa : null, xsv: r.sa ? 1 - r.xga / r.sa : null, hdgsax: (r.hdxga ?? 0) - (r.hdga ?? 0),
  }));
  html += table({
    id: "goalies", rows, sort: { k: "gsax", dir: "desc" }, rowCls: r => r.team === S.team ? "hl" : "",
    cols: [
      { k: "rank", l: "Rank", nosort: true, f: (v, r, i) => i + 1, title: "Position in the current sort" },
      { k: "name", l: "Goalie", num: false, f: (v, r) => `<button type="button" class="namebtn" data-player="${esc(v)}" data-pid="${r.id}" data-goalie="1">${esc(v)}</button>` },
      { k: "team", l: "Team", num: false, f: v => teamCell(v) },
      { k: "gp", l: "GP" }, { k: "toi", l: "Minutes", f: f0 }, { k: "sa", l: "Shots", f: f0 },
      { k: "ga", l: "GA", f: f0 }, { k: "xga", l: "xGA", f: f2 },
      { k: "gsax", l: "GSAx", f: v => sgn(v), cls: v => signCls(v) },
      { k: "gsax60", l: "GSAx/60", f: v => sgn(v), cls: v => signCls(v) },
      { k: "sv", l: "SV%", f: f3 }, { k: "xsv", l: "xSV%", f: f3 },
      { k: "hdgsax", l: "HD GSAx", f: v => sgn(v), cls: v => signCls(v) },
    ],
  });
  return html;
};

// Goalie log ---------------------------------------------------------------
function grade(g) { return g > 0.5 ? "Good" : g < -0.5 ? "Bad" : "Mid"; }

function goalieLog(season, code, sit) {
  const rows = rowsOf(S.data[season]?.goaliegames).filter(r => r.team === code && r.sit === sit)
    .map(r => ({ ...r, gsax: r.xga - r.ga })).sort((a, b) => a.date.localeCompare(b.date));
  const by = {};
  for (const r of rows) {
    const list = (by[r.name] ??= []);
    list.push(r);
    const last5 = list.slice(-5);
    r.roll = last5.reduce((a, x) => a + x.gsax, 0) / last5.length;
    r.run = list.reduce((a, x) => a + x.gsax, 0);
    r.grade = grade(r.gsax);
    r.n = list.length;
  }
  const tally = Object.entries(by).map(([name, list]) => {
    const c = k => list.filter(r => r.grade === k).length;
    const last5 = list.slice(-5);
    return {
      name, id: list[0].id, gp: list.length, good: c("Good"), mid: c("Mid"), bad: c("Bad"),
      goodPct: c("Good") / list.length, gsax: list.reduce((a, r) => a + r.gsax, 0),
      roll: last5.reduce((a, r) => a + r.gsax, 0) / last5.length,
    };
  }).sort((a, b) => b.gp - a.gp);
  if (tally.length > 1) {
    const all = rows;
    const c = k => all.filter(r => r.grade === k).length;
    tally.push({ name: "Team total", total: true, gp: all.length, good: c("Good"), mid: c("Mid"), bad: c("Bad"), goodPct: c("Good") / all.length, gsax: all.reduce((a, r) => a + r.gsax, 0) });
  }
  return { rows, by, tally };
}

function goalieTallyTable(tally, id) {
  return table({
    id, rows: tally, rowCls: r => r.total ? "total" : "",
    cols: [
      { k: "name", l: "Goalie", num: false, nosort: true, f: (v, r) => r.total ? esc(v) : `<button type="button" class="namebtn" data-player="${esc(v)}" data-pid="${r.id}" data-goalie="1">${esc(v)}</button>` },
      { k: "gp", l: "GP", nosort: true },
      { k: "good", l: "Good", nosort: true, f: v => `<span class="chip good">${v}</span>` },
      { k: "mid", l: "Mid", nosort: true, f: v => `<span class="chip mid">${v}</span>` },
      { k: "bad", l: "Bad", nosort: true, f: v => `<span class="chip bad">${v}</span>` },
      { k: "goodPct", l: "Good %", nosort: true, f: v => v == null ? "" : Math.round(v * 100) + "%" },
      { k: "gsax", l: "Season GSAx", nosort: true, f: v => sgn(v), cls: v => signCls(v) },
      { k: "roll", l: "Last-5 avg", nosort: true, f: v => sgn(v), cls: v => signCls(v) },
    ],
  });
}

V.goalielog = async () => {
  await load(S.season, "goaliegames");
  const sit = ui("gl-sit", "all");
  const t = team(S.team);
  const log = goalieLog(S.season, S.team, sit);
  const who = ui("gl-who", "All");
  let html = `<h2>${esc(t.nick)} goalies</h2><p class="lede">Every game from MoneyPuck. A start is Good when GSAx is above +0.5, Bad when below −0.5, and Mid in between. The rolling column averages GSAx over that goalie's last 5 games.</p>`;
  html += `<div class="controls">
    ${select("gl-sit", "Situation", [["all", "All"], ["5on5", "5 on 5"], ["4on5", "Penalty kill"], ["5on4", "Power play"]], sit)}
    ${select("gl-who", "Goalie", [["All", "All"], ...Object.keys(log.by).map(n => [n, n])], who)}
  </div>`;
  if (!log.rows.length) return html + `<p class="empty">No goalie games for this team and season yet.</p>`;
  html += `<h3>Start quality</h3>` + goalieTallyTable(log.tally, "gl-tally");

  const names = Object.keys(log.by);
  const palette = [t.c1, "#2E6FD8", "#1F8A55", "#9B59B6", "#E0A100"];
  const maxN = Math.max(...names.map(n => log.by[n].length));
  html += `<h3>Rolling 5-game GSAx by appearance</h3>`;
  html += lineChart(names.map((n, i) => ({
    name: n, color: palette[i % palette.length], width: 3, dots: true,
    values: Array.from({ length: maxN }, (_, k) => log.by[n][k]?.roll ?? null),
  })), { ref: 0, fmt: v => sgn(v, 1), xLabels: Array.from({ length: maxN }, (_, k) => k + 1) });

  const rows = log.rows.filter(r => who === "All" || r.name === who).slice().reverse();
  html += `<h3>Games, newest first</h3>`;
  html += table({
    id: "glog", rows,
    cols: [
      { k: "date", l: "Date", num: false, f: v => dayFmt.format(dateOnly(v)) },
      { k: "name", l: "Goalie", num: false },
      { k: "opp", l: "Opp", num: false, f: (v, r) => `${r.ha === "A" ? "at " : ""}${teamCell(v)}` },
      { k: "toi", l: "Min", f: f0 }, { k: "sa", l: "Shots", f: f0 }, { k: "ga", l: "GA", f: f0 },
      { k: "xga", l: "xGA", f: f2 },
      { k: "gsax", l: "GSAx", f: v => sgn(v), cls: v => signCls(v) },
      { k: "grade", l: "Start", num: false, f: v => `<span class="chip ${v.toLowerCase()}">${v}</span>` },
      { k: "roll", l: "Rolling 5", f: v => sgn(v), cls: v => signCls(v) },
      { k: "run", l: "Season GSAx", f: v => sgn(v), cls: v => signCls(v) },
      { k: "sv", l: "SV%", v: r => r.sa ? 1 - r.ga / r.sa : null, f: f3 },
      { k: "xsv", l: "xSV%", v: r => r.sa ? 1 - r.xga / r.sa : null, f: f3 },
      { k: "hdsa", l: "HD shots", f: f0 },
      { k: "hdg", l: "HD GSAx", v: r => (r.hdxga ?? 0) - (r.hdga ?? 0), f: v => sgn(v), cls: v => signCls(v) },
    ],
  });
  return html;
};

// Scoring leaders ------------------------------------------------------------
V.leaders = async () => {
  await Promise.all(["leaders", "standings"].map(f => load(S.season, f)));
  const scope = ui("ld-scope", "all"), pos = ui("ld-pos", "all");
  const st = standingsMap(S.data[S.season]?.standings);
  const games = seasonInfo().games;
  let html = `<h2>Scoring</h2><p class="lede">NHL scoring totals. Projections add each player's per-game rate over the games his team has left, so time missed through injury isn't projected back in.</p>`;
  html += `<div class="controls">
    ${seg("ld-scope", [["all", "League"], ["team", team(S.team).nick]], scope)}
    ${select("ld-pos", "Position", [["all", "All"], ["F", "Forwards"], ["D", "Defence"]], pos)}
  </div>`;
  let rows = rowsOf(S.data[S.season]?.leaders);
  if (!rows.length) return html + `<p class="empty">No scoring data yet.</p>`;
  rows = rows.filter(p => (scope === "all" || lastTeam(p.teams) === S.team) && (pos === "all" || (pos === "D" ? p.pos === "D" : p.pos !== "D")))
    .map(p => {
      const tm = st[lastTeam(p.teams)];
      const left = tm ? Math.max(0, games - tm.gp) : 0;
      const rate = k => p.gp ? p[k] / p.gp : 0;
      return { ...p, team: lastTeam(p.teams), left, ppg: p.gp ? p.p / p.gp : null, pg: p.g + rate("g") * left, pa: p.a + rate("a") * left, pp: p.p + rate("p") * left };
    });
  html += table({
    id: `ld-${scope}`, colKey: "leaders", rows, sort: { k: "p", dir: "desc" }, limit: scope === "all" ? 150 : null,
    rowCls: r => r.team === S.team ? "hl" : "",
    cols: [
      { k: "name", l: "Player", num: false, f: (v, r) => playerBtn(v, r.id) },
      { k: "team", l: "Team", num: false, f: v => teamCell(v) }, { k: "pos", l: "Pos", num: false },
      { k: "gp", l: "GP" }, { k: "g", l: "G" }, { k: "a", l: "A" }, { k: "p", l: "P", f: v => `<b>${v}</b>` },
      { k: "ppg", l: "P/GP", f: f2 }, { k: "pm", l: "+/-", f: v => sgn(v, 0), cls: v => signCls(v) },
      { k: "ppp", l: "PPP" }, { k: "shots", l: "Shots" }, { k: "toi", l: "TOI/GP", f: f1 },
      { k: "left", l: "Team games left" },
      { k: "pg", l: "Proj G", f: f0 }, { k: "pa", l: "Proj A", f: f0 }, { k: "pp", l: "Proj P", f: v => `<b>${f0(v)}</b>` },
    ],
  });
  return html;
};

// Team stats ----------------------------------------------------------------
V.advanced = async () => {
  await Promise.all(["teamgames", "standings", "teamsummary"].map(f => load(S.season, f)));
  const nick = team(S.team).nick;
  let html = `<h2>Team stats</h2><p class="lede">Every team's season: goals and special teams from the NHL, shot and chance shares added up from Natural Stat Trick game data. Tap a column to sort; use Columns to choose what you see.</p>`;

  // ---- goals and special teams
  const st = standingsMap(S.data[S.season]?.standings);
  const sum = Object.fromEntries(rowsOf(S.data[S.season]?.teamsummary).map(r => [r.team, r]));
  const pp = teamTotals(S.season, "pp"), pk = teamTotals(S.season, "pk");
  const per60 = (v, toi) => v != null && toi ? 60 * v / toi : null;
  const pctv = v => v == null ? null : v <= 1 ? 100 * v : v;   // NHL API gives 0.25 for 25%
  const goals = Object.values(st).map(t => {
    const sm = sum[t.team] || {}, p = pp[t.team] || {}, k = pk[t.team] || {};
    return {
      team: t.team, name: team(t.team).name, gp: t.gp, gf: t.gf, ga: t.ga, diff: t.gf - t.ga,
      gfpg: t.gp ? t.gf / t.gp : null, gapg: t.gp ? t.ga / t.gp : null,
      pp: pctv(sm.pp), pk: pctv(sm.pk), ppnet: pctv(sm.ppnet), pknet: pctv(sm.pknet),
      st: sm.pp != null && sm.pk != null ? pctv(sm.pp) + pctv(sm.pk) : null,
      sfpg: sm.sfpg, sapg: sm.sapg, fo: pctv(sm.fo),
      ppgf60: per60(p.GF, p.TOI), ppxgf60: per60(p.xGF, p.TOI), pptoi: t.gp && p.TOI ? p.TOI / t.gp : null,
      pkga60: per60(k.GA, k.TOI), pkxga60: per60(k.xGA, k.TOI), pktoi: t.gp && k.TOI ? k.TOI / t.gp : null,
    };
  });
  const gmap = Object.fromEntries(goals.map(g => [g.team, g]));
  const me = gmap[S.team];
  if (me) {
    const tile = (k, key, fmt, desc = true, suffix = "") => {
      const r = rankOf(gmap, S.team, key, desc);
      return `<div class="tile"><div class="k">${k}</div><div class="v">${me[key] == null ? "" : fmt(me[key]) + suffix}</div><div class="r">${r ? ord(r) + " in the NHL" : "&nbsp;"}</div></div>`;
    };
    html += `<h3>${esc(nick)} goals and special teams</h3><div class="tiles">
      ${tile("Goals for per game", "gfpg", f2)}${tile("Goals against per game", "gapg", f2, false)}
      ${tile("Goal differential", "diff", v => sgn(v, 0))}
      ${tile("Power play", "pp", f1, true, "%")}${tile("Penalty kill", "pk", f1, true, "%")}
      ${tile("Special teams index", "st", f1, true, "")}
      ${tile("Power play xGF per 60", "ppxgf60", f2)}${tile("Penalty kill xGA per 60", "pkxga60", f2, false)}
    </div>`;
  }
  html += `<h3>Goals and special teams, every team</h3>`;
  html += table({
    id: "goals", colKey: "teamgoals", rows: goals, sort: { k: "diff", dir: "desc" }, rowCls: r => r.team === S.team ? "hl" : "",
    cols: [
      { k: "name", l: "Team", num: false, f: (v, r) => teamCell(r.team, true) },
      { k: "gp", l: "GP" }, { k: "gf", l: "GF" }, { k: "ga", l: "GA" },
      { k: "diff", l: "DIFF", f: v => sgn(v, 0), cls: v => signCls(v) },
      { k: "gfpg", l: "GF/GP", f: f2 }, { k: "gapg", l: "GA/GP", f: f2, asc: true },
      { k: "pp", l: "PP%", f: f1 }, { k: "pk", l: "PK%", f: f1 },
      { k: "st", l: "PP% + PK%", f: f1, cls: v => v == null ? "" : v > 100 ? "pos" : v < 100 ? "neg" : "", title: "Special teams index: above 100 is better than average" },
      { k: "ppnet", l: "PP net%", f: f1, title: "Power play % after subtracting shorthanded goals allowed" },
      { k: "pknet", l: "PK net%", f: f1, title: "Penalty kill % after adding shorthanded goals scored" },
      { k: "pptoi", l: "PP min/GP", f: f2, title: "Power play minutes per game" },
      { k: "ppgf60", l: "PP GF/60", f: f2 }, { k: "ppxgf60", l: "PP xGF/60", f: f2 },
      { k: "pktoi", l: "PK min/GP", f: f2, title: "Penalty kill minutes per game" },
      { k: "pkga60", l: "PK GA/60", f: f2 }, { k: "pkxga60", l: "PK xGA/60", f: f2 },
      { k: "sfpg", l: "Shots/GP", f: f1 }, { k: "sapg", l: "Shots against/GP", f: f1 },
      { k: "fo", l: "Faceoff %", f: f1 },
    ],
  });

  // ---- shot and chance shares by situation
  const sit = ui("adv-sit", "5v5");
  const tt = teamTotals(S.season, sit);
  html += `<h3>Shot and chance shares</h3>`;
  html += `<div class="controls">${seg("adv-sit", [["5v5", "5 on 5"], ["all", "All situations"], ["pp", "Power play"], ["pk", "Penalty kill"]], sit)}</div>`;
  if (!S.manifest.nst) return html + natNote();
  const rows = Object.values(tt).map(r => ({
    ...r, name: team(r.team).name,
    cf60: per60(r.CF, r.TOI), ca60: per60(r.CA, r.TOI), xgf60: per60(r.xGF, r.TOI), xga60: per60(r.xGA, r.TOI),
    gf60: per60(r.GF, r.TOI), ga60: per60(r.GA, r.TOI),
  }));
  if (!rows.length) return html + `<p class="empty">No team data yet.</p>`;
  const special = sit === "pp" || sit === "pk";
  html += `<p class="lede">${special ? "On the power play and penalty kill, shares are lopsided by nature; the per-60 rates are the better comparison." : "Shares above 50% mean a team out-chances its opponents."}</p>`;
  html += table({
    id: `adv-${sit}`, colKey: "advanced", rows, sort: { k: special ? (sit === "pp" ? "xgf60" : "xga60") : "xgfp", dir: sit === "pk" ? "asc" : "desc" },
    rowCls: r => r.team === S.team ? "hl" : "",
    cols: [
      { k: "name", l: "Team", num: false, f: (v, r) => teamCell(r.team, true) },
      { k: "gp", l: "GP" }, { k: "TOI", l: "Minutes", f: f0 },
      { k: "cfp", l: "CF%", f: f1, cls: special ? null : shareCls }, { k: "ffp", l: "FF%", f: f1, cls: special ? null : shareCls },
      { k: "sfp", l: "SF%", f: f1, cls: special ? null : shareCls }, { k: "gfp", l: "GF%", f: f1, cls: special ? null : shareCls },
      { k: "xgfp", l: "xGF%", f: f1, cls: special ? null : shareCls }, { k: "scfp", l: "SCF%", f: f1, cls: special ? null : shareCls },
      { k: "hdcfp", l: "HDCF%", f: f1, cls: special ? null : shareCls },
      { k: "xGF", l: "xGF", f: f1 }, { k: "xGA", l: "xGA", f: f1 },
      { k: "cf60", l: "CF/60", f: f1 }, { k: "ca60", l: "CA/60", f: f1 },
      { k: "xgf60", l: "xGF/60", f: f2 }, { k: "xga60", l: "xGA/60", f: f2 },
      { k: "gf60", l: "GF/60", f: f2 }, { k: "ga60", l: "GA/60", f: f2 },
      { k: "shp", l: "SH%", f: f1 }, { k: "svp", l: "SV%", f: f1 }, { k: "pdo", l: "PDO", f: f3 },
    ],
  });
  html += definitions([
    ["PP% and PK%", "Power play goals per opportunity, and penalties killed per time shorthanded."],
    ["PP% + PK%", "A quick special teams index; 100 is roughly average."],
    ["Per 60", "Per 60 minutes in that situation, so teams with more or fewer power plays compare fairly."],
    ["CF% (Corsi)", "Share of all shot attempts: on goal, missed and blocked."],
    ["FF% (Fenwick)", "Share of unblocked shot attempts."],
    ["SF%", "Share of shots on goal."],
    ["xGF%", "Share of expected goals, weighting each shot by its chance of scoring."],
    ["SCF% and HDCF%", "Share of scoring chances, and of high-danger chances from the slot and crease."],
    ["PDO", "Shooting % plus save %, where 1.000 is average. Far from 1.000 usually comes back."],
  ]);
  return html;
};

// Links ---------------------------------------------------------------------
V.links = async () => {
  const t = team(S.team);
  const L = [
    ["NHL.com", "Official scores, standings, schedules and player pages.", "https://www.nhl.com/"],
    ["NHL Edge", "Puck and player tracking: skating speed, shot speed, zone time.", "https://edge.nhl.com/"],
    ["Natural Stat Trick", "The source of this site's shot shares, expected goals and skater stats.", "https://www.naturalstattrick.com/"],
    ["MoneyPuck", "Expected goals model, goalie GSAx, playoff and Cup odds.", "https://moneypuck.com/"],
    ["PuckPedia", "Contracts, cap space and trade tools.", "https://puckpedia.com/"],
    ["HockeyDB", "Career stats for every player in every league.", "https://www.hockeydb.com/"],
    ["Hockey Reference", "Historical stats, records and season pages.", "https://www.hockey-reference.com/"],
    ["Evolving-Hockey", "GAR and WAR player value models (some features need a subscription).", "https://evolving-hockey.com/"],
    ["Daily Faceoff", "Line combinations and starting goalies, updated daily.", "https://www.dailyfaceoff.com/"],
    ["Elite Prospects", "Prospects, juniors and leagues worldwide.", "https://www.eliteprospects.com/"],
    ["JFresh Hockey", "Player cards and visual summaries.", "https://jfresh.substack.com/"],
    ["ESPN NHL", "Standings and scoring, as used in the Google Sheet.", "https://www.espn.com/nhl/"],
    [`${t.name} on NHL.com`, "Team news, roster and schedule.", `https://www.nhl.com/${t.nick.toLowerCase().replace(/[^a-z]/g, "")}/`],
  ];
  return `<h2>Hockey links</h2><p class="lede">Good places for more detail, all free unless noted.</p>
    <div class="link-list">${L.map(([n, d, u]) => `<a href="${u}" target="_blank" rel="noopener"><b>${esc(n)}</b><span>${esc(d)}</span></a>`).join("")}</div>`;
};

// ------------------------------------------------------------------ render

let renderToken = 0;
async function render() {
  const token = ++renderToken;
  writeHash();
  applyTeamColours();
  drawTabs();
  colButtonsShown = new Set();
  await Promise.all(["standings", "schedule"].map(f => load(S.season, f)));
  if (token !== renderToken) return;
  renderHero();
  let html;
  try {
    html = await V[S.view]();
  } catch (e) {
    console.error(e);
    html = `<p class="note">Something went wrong drawing this section: ${esc(e.message)}</p>`;
  }
  if (token !== renderToken) return;
  $("#view").innerHTML = html;
  const cur = document.querySelector(".tabs a[aria-current]");
  if (cur) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function drawTabs() {
  $("#tabs").innerHTML = tabOrder().map(([k, l]) => `<a href="#/${k}?team=${S.team}&season=${S.season}" data-view="${k}"${k === S.view ? ' aria-current="page"' : ""}>${esc(viewLabel(l))}</a>`).join("")
    + `<button type="button" class="tab-tool" data-arrange="1" aria-label="Arrange tabs">Arrange</button>`;
}

function fillPickers() {
  $("#team-pick").innerHTML = [...TEAMS].sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${t.code}"${t.code === S.team ? " selected" : ""}>${esc(t.name)}</option>`).join("");
  $("#season-pick").innerHTML = S.manifest.seasons
    .map(s => `<option value="${s.code}"${s.code === S.season ? " selected" : ""}>${s.label}</option>`).join("");
}

async function init() {
  try {
    const saved = JSON.parse(localStorage.getItem("nhlstats") || "{}");
    if (saved.team && TEAM[saved.team]) S.team = saved.team;
    if (saved.season) S.season = saved.season;
  } catch (e) { /* ignore */ }
  readHash();
  drawThemeButton();
  $("#theme-btn").addEventListener("click", toggleTheme);
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", drawThemeButton);
  try {
    S.manifest = await getJSON(`data/manifest.json?t=${Date.now()}`);
  } catch (e) {
    $("#view").innerHTML = `<p class="note">The data hasn't been built yet. The first build takes a few minutes; refresh this page shortly.</p>`;
    return;
  }
  if (!S.manifest.seasons.some(s => s.code === S.season)) S.season = S.manifest.current;
  fillPickers();
  $("#team-pick").addEventListener("change", e => { S.team = e.target.value; render(); });
  $("#season-pick").addEventListener("change", e => { S.season = Number(e.target.value); render(); });
  window.addEventListener("hashchange", () => { readHash(); fillPickers(); render(); });
  const gen = new Date(S.manifest.generated);
  $("#foot").innerHTML = `Data from the NHL, Natural Stat Trick and MoneyPuck, last updated ${dayFmt.format(gen)} at ${timeFmt.format(gen)}. Scores refresh hourly; everything else daily. Built for personal use.`;
  render();
}

init();
