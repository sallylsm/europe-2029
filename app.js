// Trips — a shared trip planner (GitHub Pages + Firebase). Many trips, invite people per trip.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where, writeBatch, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./config.js";

const app = initializeApp(CFG.firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const UNSPLASH_KEY = String(CFG.unsplashKey || "").trim();

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const uidGen = () => doc(collection(fs, "_")).id;
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseIso = iso => new Date(iso + "T12:00:00");
const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 864e5);
const validIso = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const fmtD = (iso, o = { month: "short", day: "numeric" }) => validIso(iso) ? parseIso(iso).toLocaleDateString("en-US", o) : "";
const ekey = e => String(e || "").toLowerCase().replace(/\./g, ",");
const safeUrl = u => /^https?:\/\//i.test(String(u || "").trim()) ? String(u).trim() : "";
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
function toast(msg, action) {
  $(".toast")?.remove();
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status");
  t.innerHTML = `<span>${msg}</span>`;
  if (action) { const b = document.createElement("button"); b.type = "button"; b.textContent = action.label; b.onclick = () => { action.run(); t.remove(); }; t.append(b); }
  document.body.append(t); setTimeout(() => t.remove(), action ? 7000 : 3800);
}
function km(a, b) {
  const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const hasPt = p => p && p.lat != null && p.lon != null && isFinite(p.lat) && isFinite(p.lon);
function legText(d) {
  if (d < 0.05) return "Right next door";
  if (d <= 2) return `${(d).toFixed(1)} km · ${Math.max(1, Math.round(d * 1.25 / 4.8 * 60))} min walk`;
  if (d <= 80) return `${d.toFixed(1)} km · ~${Math.round(d * 1.3 / 28 * 60 + 5)} min by car or transit`;
  return `${Math.round(d)} km · a longer trip, check transport`;
}
const fmtMin = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? " " + (m % 60) + "m" : ""}` : `${m}m`;
function parseDur(t) {
  t = String(t || "").trim().toLowerCase(); if (!t) return 0;
  const m = t.match(/^(\d+):(\d{1,2})$/); if (m) return +m[1] * 60 + +m[2];
  let mins = 0, hit = false;
  const h = t.match(/(\d+(?:\.\d+)?)\s*h/); if (h) { mins += parseFloat(h[1]) * 60; hit = true; }
  const mm = t.match(/(\d+)\s*m/); if (mm) { mins += +mm[1]; hit = true; }
  if (!hit && /^\d+(\.\d+)?$/.test(t)) mins = parseFloat(t) * 60;
  return Math.round(mins);
}

// ---------------------------------------------------------------- constants
const TYPES = [["sight", "Sight"], ["museum", "Museum"], ["food", "Food"], ["cafe", "Café & bakery"], ["shop", "Shop"], ["market", "Market"], ["nature", "Nature & views"], ["night", "Nightlife"], ["experience", "Experience"], ["other", "Other"], ["city", "City / town"]];
const TCOL = { shop: "--t0", food: "--t1", cafe: "--t2", sight: "--t3", museum: "--t4", nature: "--t5", market: "--t6", night: "--t7", experience: "--t8", other: "--t9", city: "--t10" };
const TYPE = Object.fromEntries(TYPES.map(([k, l]) => [k, { label: l, col: `var(${TCOL[k]})` }]));
const DAYCOLS = ["--d0", "--d1", "--d2", "--d3", "--d4", "--d5", "--d6", "--d7"];
const dayCol = i => `var(${DAYCOLS[i % DAYCOLS.length]})`;
const AVCOLS = ["#2461B5", "#BE3674", "#3B7A39", "#B7791F", "#7646B3", "#107A74", "#C2610F", "#5E6B78"];
const KINDS = {
  flight: { label: "Flight", group: "transport", col: "var(--d1)", cat: "Transport" },
  train: { label: "Train", group: "transport", col: "var(--d2)", cat: "Transport" },
  bus: { label: "Bus / transfer", group: "transport", col: "var(--d5)", cat: "Transport" },
  ferry: { label: "Ferry", group: "transport", col: "var(--d5)", cat: "Transport" },
  car: { label: "Rental car", group: "car", col: "var(--d4)", cat: "Transport" },
  lodging: { label: "Stay", group: "lodging", col: "var(--d3)", cat: "Lodging" },
  reservation: { label: "Reservation", group: "event", col: "var(--d0)", cat: "Food & drink" },
  activity: { label: "Activity / tickets", group: "event", col: "var(--d6)", cat: "Activities" },
  other: { label: "Other", group: "event", col: "var(--d7)", cat: "Other" },
};
const CATS = ["Transport", "Lodging", "Food & drink", "Activities", "Shopping", "Groceries", "Insurance & docs", "Other"];
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "TWD", "CAD", "AUD", "NZD", "CHF", "DKK", "NOK", "SEK", "CZK", "HUF", "PLN", "ISK", "KRW", "MXN", "THB"];
const ACCENTS = { lehua: ["#D9483B", "#F06A5B"], sunset: ["#C2610F", "#F5A04E"], fern: ["#3B7A39", "#7CC77A"], ocean: ["#2461B5", "#6FA6F2"], lagoon: ["#107A74", "#4FD1C5"], plumeria: ["#7646B3", "#B593F0"], hibiscus: ["#BE3674", "#F07AB0"] };

// ---------------------------------------------------------------- state
let ME = null;             // { uid, email, name }
let TRIPS = {};            // id -> trip doc
let unsubHome = null;
let cur = null;            // { id, tab, unsubs: [] }
const T = { trip: null, places: {}, days: {}, bookings: {}, expenses: {}, checklist: {}, photos: {} };
const latest = {}, timers = {}, chains = {};
let oldEurope = null;      // set when the old Europe 2029 data can be read

function save(path, data, delay = 450) {
  latest[path] = data; clearTimeout(timers[path]);
  timers[path] = setTimeout(() => {
    const d = latest[path]; delete latest[path];
    chains[path] = (chains[path] || Promise.resolve()).then(() => setDoc(doc(fs, path), d)).catch(fail);
  }, delay);
}
function remove(path) {
  clearTimeout(timers[path]); delete latest[path];
  chains[path] = (chains[path] || Promise.resolve()).then(() => deleteDoc(doc(fs, path))).catch(fail);
}
function fail(e) {
  console.error(e);
  toast(e && e.code === "permission-denied" ? "You don't have permission to change that." : "A change didn't save. Check your connection.");
}
const tp = sub => `trips/${cur.id}/${sub}`;

// ---------------------------------------------------------------- theme
let theme = { accent: "lehua", mode: "auto" };
try { theme = { ...theme, ...JSON.parse(localStorage.getItem("e29-theme") || "{}") }; } catch {}
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const r = document.documentElement, dark = theme.mode === "auto" ? darkMQ.matches : theme.mode === "dark";
  r.dataset.accent = theme.accent; r.dataset.theme = dark ? "dark" : "light";
  $$("#swatches button").forEach(b => b.setAttribute("aria-pressed", b.dataset.accent === theme.accent));
  $$("#modeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === theme.mode));
  setTiles(); if (cur) renderMap();
}
$("#swatches").innerHTML = Object.entries(ACCENTS).map(([k, [l, d]]) => `<button type="button" data-accent="${k}" aria-label="${k}" title="${k[0].toUpperCase() + k.slice(1)}" style="background:linear-gradient(135deg,${l} 50%,${d} 50%)"></button>`).join("");
$("#mePop").addEventListener("click", e => {
  e.stopPropagation();
  const a = e.target.closest("[data-accent]"), m = e.target.closest("[data-mode]");
  if (a) theme.accent = a.dataset.accent; if (m) theme.mode = m.dataset.mode;
  if (a || m) { try { localStorage.setItem("e29-theme", JSON.stringify(theme)); } catch {} applyTheme(); }
});
$("#meBtn").addEventListener("click", e => { e.stopPropagation(); const p = $("#mePop"); p.hidden = !p.hidden; $("#meBtn").setAttribute("aria-expanded", String(!p.hidden)); });
document.addEventListener("click", () => { $("#mePop").hidden = true; $("#meBtn").setAttribute("aria-expanded", "false"); });
darkMQ.addEventListener?.("change", applyTheme);
$("#signOut").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------- people
const members = () => (T.trip?.members || []).map(e => e.toLowerCase());
const nameOf = email => { const n = (T.trip?.names || {})[ekey(email)]; return n || String(email || "").split("@")[0]; };
const avColor = email => AVCOLS[Math.max(0, members().indexOf(String(email).toLowerCase())) % AVCOLS.length];
const avatar = email => `<span class="avatar" style="--av:${avColor(email)}" title="${esc(nameOf(email))} (${esc(email)})">${esc(nameOf(email).charAt(0).toUpperCase())}</span>`;
const isOwner = () => T.trip && ME && T.trip.owner === ME.uid;

// ---------------------------------------------------------------- money
function money(n, opts = {}) {
  const c = T.trip?.currency || "USD";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: opts.cents ? 2 : 0 }).format(n || 0); }
  catch { return (n < 0 ? "-" : "") + c + " " + Math.round(Math.abs(n || 0)).toLocaleString("en-US"); }
}

// ---------------------------------------------------------------- dates of the trip
function tripDays() {
  const t = T.trip; if (!t || !validIso(t.start) || !validIso(t.end)) return [];
  const n = Math.min(60, Math.max(1, daysBetween(t.start, t.end) + 1));
  return Array.from({ length: n }, (_, i) => addDays(t.start, i));
}
function dayLabel(iso) { const i = tripDays().indexOf(iso); return i < 0 ? fmtD(iso) : `Day ${i + 1} · ${fmtD(iso, { weekday: "short", month: "short", day: "numeric" })}`; }
function dayOptions(sel) {
  return `<option value="">Not scheduled</option>` + tripDays().map(d => `<option value="${d}" ${d === sel ? "selected" : ""}>${esc(dayLabel(d))}</option>`).join("");
}

// ---------------------------------------------------------------- photo helpers (Wikipedia → Commons → Unsplash)
function shrink(file, maxDim = 900, limit = 260000) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let max = maxDim, out = "";
      for (let pass = 0; pass < 6; pass++) {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
        const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h);
        out = c.toDataURL("image/jpeg", pass < 3 ? 0.8 - pass * 0.1 : 0.6);
        if (out.length < limit) return res(out);
        max = Math.round(max * 0.8);
      }
      res(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That file isn't an image this browser can read.")); };
    img.src = url;
  });
}
const UTM = "utm_source=trips_planner&utm_medium=referral";
const stripHtml = h => { const d = document.createElement("div"); d.innerHTML = String(h || ""); return (d.textContent || "").replace(/\s+/g, " ").trim(); };
function photoSrcOf(p) {
  if (typeof p?.photo === "string" && p.photo.startsWith("data:image/")) return p.photo;
  if (typeof p?.photoUrl === "string" && /^https:\/\/images\.unsplash\.com\//.test(p.photoUrl)) return p.photoUrl;
  return "";
}
function creditHtml(p) {
  const link = safeUrl(p.photoLink);
  if (p.photoSrc === "unsplash") return `<span class="credit">Photo: ${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.photoBy || "Unsplash")}</a>` : esc(p.photoBy || "")} on <a href="https://unsplash.com/?${UTM}" target="_blank" rel="noopener">Unsplash</a></span>`;
  if (!p.photoCredit) return "";
  return `<span class="credit">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(p.photoCredit)}</a>` : esc(p.photoCredit)}</span>`;
}
async function wikiCands(x) {
  for (const t of [x.name, x.city && x.city !== x.name ? `${x.name} (${x.city})` : null].filter(Boolean)) {
    try {
      const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`);
      if (!r.ok) continue;
      const j = await r.json();
      if (j.type === "disambiguation" || !j.thumbnail) continue;
      return [{ kind: "embed", src: (j.thumbnail.source || "").replace(/\/(\d+)px-/, "/900px-"), alt: j.thumbnail.source, credit: "Photo: Wikipedia", link: j.content_urls?.desktop?.page || "", photoSrc: "wikipedia" }];
    } catch { /* next */ }
  }
  return [];
}
const COMMONS = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&prop=imageinfo&iiprop=url|extmetadata|size|mime&iiurlwidth=900";
function commonsFrom(j) {
  return Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0)).flatMap(pg => {
    const ii = (pg.imageinfo || [])[0];
    if (!ii?.thumburl || !/^image\/(jpeg|png|webp)$/.test(ii.mime || "") || (ii.width || 0) < 600 || ii.width / Math.max(1, ii.height) < 0.9) return [];
    const m = ii.extmetadata || {}, by = stripHtml(m.Artist?.value).slice(0, 50), lic = stripHtml(m.LicenseShortName?.value).slice(0, 24);
    return [{ kind: "embed", src: ii.thumburl, credit: `Photo: ${by ? by + ", " : ""}Wikimedia Commons${lic ? " (" + lic + ")" : ""}`, link: ii.descriptionurl || "", photoSrc: "commons" }];
  });
}
async function commonsSearch(x) {
  const r = await fetch(`${COMMONS}&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${x.name} ${x.city && x.city !== x.name ? x.city : ""} filetype:bitmap`.trim())}`);
  return r.ok ? commonsFrom(await r.json()) : [];
}
async function commonsNear(x) {
  if (!hasPt(x)) return [];
  const r = await fetch(`${COMMONS}&generator=geosearch&ggsnamespace=6&ggslimit=8&ggsradius=150&ggscoord=${x.lat}|${x.lon}`);
  return r.ok ? commonsFrom(await r.json()) : [];
}
let unsplashLimited = 0;
const unsplashBusy = () => Date.now() - unsplashLimited < 15 * 60 * 1000;
async function unsplashCands(x) {
  if (!UNSPLASH_KEY || unsplashBusy()) return [];
  const go = async q => {
    const r = await fetch(`https://api.unsplash.com/search/photos?per_page=4&orientation=landscape&content_filter=high&query=${encodeURIComponent(q)}`, { headers: { Authorization: "Client-ID " + UNSPLASH_KEY, "Accept-Version": "v1" } });
    if (r.status === 403 || r.status === 429) { unsplashLimited = Date.now(); return []; }
    if (!r.ok) return [];
    return ((await r.json()).results || []).map(u => ({ kind: "hotlink", url: u.urls?.regular || "", credit: `Photo: ${u.user?.name || ""} on Unsplash`, by: u.user?.name || "", link: u.user?.links?.html ? `${u.user.links.html}?${UTM}` : "", dl: u.links?.download_location || "", photoSrc: "unsplash" })).filter(c => c.url);
  };
  const a = await go([x.name, x.city].filter(Boolean).join(" "));
  return a.length || unsplashBusy() ? a : (x.city ? go(x.city) : []);
}
function addCands(list, more) { const seen = new Set(list.map(c => c.src || c.url)); for (const c of more) { const k = c.src || c.url; if (k && !seen.has(k)) { seen.add(k); list.push(c); } } return list; }
async function photoCandidates(x, mode = "auto") {
  const safe = p => p.catch(() => []);
  const [w, cs, cn] = await Promise.all([safe(wikiCands(x)), safe(commonsSearch(x)), safe(commonsNear(x))]);
  const out = addCands([], [...w, ...cs, ...cn]); out.place = x; out.unsplashDone = false;
  if (mode !== "free" && (mode === "all" || !out.length)) { addCands(out, await safe(unsplashCands(x))); out.unsplashDone = true; }
  return out;
}
async function materialize(c) {
  if (c.kind === "hotlink") return { photo: "", photoUrl: c.url, photoCredit: c.credit, photoLink: c.link, photoBy: c.by || "", photoSrc: c.photoSrc, dl: c.dl };
  let blob = await fetch(c.src).then(r => r.ok ? r.blob() : null).catch(() => null);
  if (!blob && c.alt) blob = await fetch(c.alt).then(r => r.ok ? r.blob() : null).catch(() => null);
  if (!blob) throw new Error("couldn't load");
  return { photo: await shrink(blob), photoUrl: "", photoCredit: c.credit, photoLink: c.link, photoBy: "", photoSrc: c.photoSrc, dl: "" };
}
function trackUnsplash(dl) { if (dl && UNSPLASH_KEY) fetch(dl + (dl.includes("?") ? "&" : "?") + "client_id=" + encodeURIComponent(UNSPLASH_KEY)).catch(() => {}); }
async function firstPhoto(x, mode = "auto") {
  const cands = await photoCandidates(x, mode).catch(() => []);
  for (const c of cands) { try { return await materialize(c); } catch { /* next */ } }
  return null;
}

// ---------------------------------------------------------------- place search (Photon / OpenStreetMap)
function typeFrom(k, v) {
  v = v || "";
  if (k === "place" && ["city", "town", "village", "hamlet", "island", "suburb", "neighbourhood", "quarter"].includes(v)) return "city";
  if (k === "shop") return ["bakery", "pastry", "confectionery", "coffee", "tea", "chocolate"].includes(v) ? "cafe" : "shop";
  if (k === "amenity") {
    if (["restaurant", "fast_food", "food_court", "bbq", "biergarten"].includes(v)) return "food";
    if (["cafe", "ice_cream"].includes(v)) return "cafe";
    if (["bar", "pub", "nightclub", "casino"].includes(v)) return "night";
    if (v === "marketplace") return "market";
    if (["theatre", "cinema", "arts_centre", "concert_hall", "planetarium"].includes(v)) return "experience";
    if (["place_of_worship", "monastery", "townhall", "fountain", "clock"].includes(v)) return "sight";
    return "other";
  }
  if (k === "tourism") {
    if (["museum", "gallery"].includes(v)) return "museum";
    if (["viewpoint", "picnic_site"].includes(v)) return "nature";
    if (["zoo", "theme_park", "aquarium"].includes(v)) return "experience";
    if (["hotel", "hostel", "guest_house", "apartment", "motel"].includes(v)) return "other";
    return "sight";
  }
  if (["historic", "building", "man_made", "bridge"].includes(k)) return "sight";
  if (k === "leisure") return ["water_park", "stadium", "sports_centre"].includes(v) ? "experience" : "nature";
  if (["natural", "waterway"].includes(k)) return "nature";
  if (k === "craft") return "shop";
  if (k === "place" || k === "boundary") return "city";
  return "other";
}
const searchCache = new Map();
async function searchPlaces(q, near) {
  const key = q.toLowerCase() + (near ? `@${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : "");
  if (searchCache.has(key)) return searchCache.get(key);
  const bias = near ? `&lat=${near.lat}&lon=${near.lon}&location_bias_scale=0.3` : "";
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=10&lang=en${bias}`);
  if (!r.ok) throw new Error("search failed");
  const j = await r.json(), seen = new Set(), out = [];
  for (const f of j.features || []) {
    const p = f.properties || {}, c = f.geometry?.coordinates || [];
    if (!p.name || c.length < 2) continue;
    const t = typeFrom(p.osm_key, p.osm_value);
    const city = t === "city" ? p.name : (p.city || p.town || p.village || p.district || p.county || p.state || "");
    const addr = [p.housenumber && p.street ? `${p.street} ${p.housenumber}` : p.street, p.postcode].filter(Boolean).join(", ");
    const x = { name: p.name, type: t, city, country: p.country || "", lat: c[1], lon: c[0], addr };
    const sig = (x.name + "|" + x.city).toLowerCase(); if (seen.has(sig)) continue; seen.add(sig); out.push(x);
  }
  searchCache.set(key, out); return out;
}
const gmapsUrl = x => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([x.name, x.city, x.country].filter(Boolean).join(", "))}`;
function closeSuggest(list, input) { list.hidden = true; list.innerHTML = ""; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
// opts: { near(): {lat,lon}|null, local(q): [{saved place}] , onPick(item) }
function attachSuggest(input, list, opts) {
  let timer = 0, items = [], active = -1, seq = 0;
  const show = html => { list.innerHTML = html; list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const paint = () => {
    let h = "", sec = "";
    items.forEach((x, i) => {
      const s = x.saved ? "Saved places" : "Search results";
      if (s !== sec && (items.some(y => y.saved))) { h += `<li class="sec" role="presentation">${s}</li>`; sec = s; }
      const t = TYPE[x.type] || TYPE.other;
      h += `<li role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === active}" class="${x.saved ? "saved" : ""}" style="--tc:${t.col}"><i></i><span><b>${esc(x.name)}</b><small>${esc([x.city !== x.name ? x.city : "", x.country].filter(Boolean).join(", "))}</small></span><em>${x.saved ? (x.day ? "Saved · " + esc(fmtD(x.day)) : "Saved") : esc(t.label)}</em></li>`;
    });
    show(h); if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer); const q = input.value.trim();
    const local = opts.local ? opts.local(q) : [];
    if (q.length < 3) { if (local.length && q.length) { items = local; active = 0; paint(); } else closeSuggest(list, input); return; }
    items = local; active = items.length ? 0 : -1; if (items.length) paint();
    timer = setTimeout(async () => {
      const my = ++seq;
      if (!navigator.onLine) { if (!items.length) show(`<li class="note">Place search needs an internet connection.</li>`); return; }
      try {
        const res = await searchPlaces(q.replace(/^the\s+/i, ""), opts.near ? opts.near() : null); if (my !== seq) return;
        items = [...local, ...res]; active = items.length ? 0 : -1;
        if (!items.length) show(`<li class="note">No matches for “${esc(q)}”. Try another spelling or add the city.</li>`); else paint();
      } catch { if (my === seq && !items.length) show(`<li class="note">Search isn't responding right now. Try again in a moment.</li>`); }
    }, 280);
  });
  input.addEventListener("keydown", e => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); const x = items[active]; closeSuggest(list, input); opts.onPick(x); }
    else if (e.key === "Escape") { e.stopPropagation(); closeSuggest(list, input); }
  });
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => { const li = e.target.closest("li[data-i]"); if (!li) return; const x = items[+li.dataset.i]; closeSuggest(list, input); opts.onPick(x); });
  input.addEventListener("blur", () => setTimeout(() => closeSuggest(list, input), 150));
}

// ---------------------------------------------------------------- modal
function openModal(html, onMount) {
  const root = $("#modalRoot");
  root.innerHTML = `<div class="modal" id="modal"><div class="modal-card" role="dialog" aria-modal="true">${html}</div></div>`;
  const m = $("#modal");
  m.addEventListener("mousedown", e => { if (e.target === m) closeModal(); });
  m.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
  onMount && onMount(m);
  setTimeout(() => $("input:not([type=hidden]), select, textarea", m)?.focus(), 30);
  return m;
}
const closeModal = () => { $("#modalRoot").innerHTML = ""; };

// ================================================================ AUTH
const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: "select_account" });
function renderGate(msg) {
  $("#crumb").textContent = ""; $("#meBtn").hidden = true;
  $("#app").innerHTML = `<div class="gate"><div class="card"><h1>Trips</h1><p class="hint">${esc(msg || "Plan trips together: a map, a day-by-day plan, bookings and a shared budget.")}</p><button class="btn accent" id="signIn" type="button">Sign in with Google</button></div></div>`;
  $("#signIn").onclick = async () => {
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") return signInWithRedirect(auth, provider);
      const why = { "auth/unauthorized-domain": `Add ${location.hostname} under Firebase → Authentication → Settings → Authorized domains.`, "auth/popup-closed-by-user": "The sign-in window was closed. Try again.", "auth/network-request-failed": "You need a connection to sign in." }[e.code];
      renderGate((why || "Sign-in didn't finish.") + ` (${e.code || e.message})`);
    }
  };
}
onAuthStateChanged(auth, async user => {
  if (!user) { ME = null; unsubHome?.(); leaveTrip(); renderGate(); return; }
  ME = { uid: user.uid, email: (user.email || "").toLowerCase(), name: (user.displayName || "").split(" ")[0] || (user.email || "").split("@")[0] };
  $("#meBtn").hidden = false; $("#meAv").textContent = ME.name.charAt(0).toUpperCase(); $("#meName").textContent = user.displayName || ME.name; $("#meEmail").textContent = ME.email;
  subscribeHome(); route();
});

// ================================================================ ROUTING
window.addEventListener("hashchange", route);
function route() {
  if (!ME) return;
  const m = location.hash.match(/^#\/t\/([\w-]+)(?:\/(\w+))?/);
  if (m) openTrip(m[1], m[2] || "plan");
  else { leaveTrip(); renderHome(); }
}

// ================================================================ HOME
function subscribeHome() {
  unsubHome?.();
  unsubHome = onSnapshot(query(collection(fs, "trips"), where("members", "array-contains", ME.email)), snap => {
    TRIPS = {}; snap.docs.forEach(d => { TRIPS[d.id] = { ...d.data() }; });
    if (!cur) renderHome();
  }, e => { console.error(e); if (!cur) renderHome(e); });
  getDoc(doc(fs, "planner/settings")).then(s => { oldEurope = s.exists() ? s.data() : null; if (!cur) renderHome(); }).catch(() => { oldEurope = null; });
}
function tripWhen(t) {
  if (!validIso(t.start)) return "Dates not set";
  const today = isoOf(new Date());
  if (today < t.start) { const n = daysBetween(today, t.start); return n === 1 ? "Tomorrow" : `In ${n.toLocaleString("en-US")} days`; }
  if (validIso(t.end) && today > t.end) return "Past trip";
  return "Happening now";
}
function renderHome(err) {
  $("#crumb").textContent = "";
  const list = Object.entries(TRIPS).sort((a, b) => String(a[1].start || "9").localeCompare(String(b[1].start || "9")));
  const imported = list.some(([, t]) => t.importedFrom === "europe2029");
  $("#app").innerHTML = `<div class="home">
    <div class="row between"><div><h1>Your trips</h1><p class="hint">Plan together: a map, a day-by-day plan, bookings and a shared budget.</p></div><button class="btn accent" id="newTrip" type="button">New trip</button></div>
    ${err ? `<p class="banner">Couldn't load your trips. ${err.code === "permission-denied" ? "The database rules need updating (see the README)." : "Check your connection."}</p>` : ""}
    ${oldEurope && !imported ? `<div class="card row between"><div><b>Bring Europe 2029 in</b><p class="hint">Copies the route, spots, flights and costs, day notes, photos and to-dos from the Europe 2029 site into a trip here. The old site stays as it is.</p></div><button class="btn" id="importEu" type="button">Import Europe 2029</button></div>` : ""}
    <div class="trip-grid">
      ${list.map(([id, t]) => `<a class="trip-card" href="#/t/${id}">
        <div class="trip-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : `<span class="letter">${esc((t.name || "?").charAt(0))}</span>`}<span class="when">${esc(tripWhen(t))}</span></div>
        <div class="trip-body"><h2>${esc(t.name || "Untitled trip")}</h2><span class="hint">${validIso(t.start) ? `${fmtD(t.start)} – ${fmtD(t.end, { month: "short", day: "numeric", year: "numeric" })}` : "No dates yet"}${t.dest?.name ? " · " + esc(t.dest.name) : ""}</span>
        <span class="hint">${(t.members || []).length} ${(t.members || []).length === 1 ? "person" : "people"}</span></div></a>`).join("")}
      <button class="trip-new" id="newTrip2" type="button">+ Plan a new trip</button>
    </div></div>`;
  $("#newTrip").onclick = $("#newTrip2").onclick = newTripModal;
  $("#importEu") && ($("#importEu").onclick = importEurope);
}
function newTripModal() {
  let dest = null;
  openModal(`<div class="row between"><h2>Plan a new trip</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <label class="field" for="ntName">Trip name<input id="ntName" maxlength="60" placeholder="e.g. Japan in spring"></label>
    <div class="field"><label for="ntDest">Where to</label><div class="suggest-wrap"><input id="ntDest" autocomplete="off" placeholder="A city, region or country" role="combobox" aria-expanded="false" aria-controls="ntList"><ul class="suggest" id="ntList" role="listbox" hidden></ul></div></div>
    <div class="grid2"><label class="field" for="ntStart">Start<input id="ntStart" type="date"></label><label class="field" for="ntEnd">End<input id="ntEnd" type="date"></label></div>
    <p class="hint" id="ntMsg">You can change any of this later.</p>
    <div class="row between"><span></span><div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="ntGo">Create trip</button></div></div>`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    attachSuggest($("#ntDest"), $("#ntList"), { onPick: x => { dest = x; $("#ntDest").value = x.name + (x.country && x.country !== x.name ? ", " + x.country : ""); if (!$("#ntName").value) $("#ntName").value = x.name; } });
    $("#ntStart").onchange = () => { if (!$("#ntEnd").value || $("#ntEnd").value < $("#ntStart").value) $("#ntEnd").value = addDays($("#ntStart").value, 6); };
    $("#ntGo").onclick = async () => {
      const name = $("#ntName").value.trim() || dest?.name || "New trip";
      let start = $("#ntStart").value, end = $("#ntEnd").value;
      if (validIso(start) && (!validIso(end) || end < start)) end = start;
      if (!dest && $("#ntDest").value.trim()) { try { dest = (await searchPlaces($("#ntDest").value.trim()))[0] || null; } catch {} }
      const id = uidGen();
      const trip = { name: name.slice(0, 60), dest: dest ? { name: dest.name, country: dest.country, lat: dest.lat, lon: dest.lon } : null, start: start || "", end: end || "",
        members: [ME.email], names: { [ekey(ME.email)]: ME.name }, owner: ME.uid, ownerEmail: ME.email, created: Date.now(), currency: "USD", budget: 0, notes: "", cover: "" };
      try { await setDoc(doc(fs, "trips/" + id), trip); }
      catch (e) { $("#ntMsg").textContent = e.code === "permission-denied" ? "Your account can't create trips yet. Add your email to tripCreators in the Firebase rules (see the README)." : "Couldn't create the trip. Check your connection."; return; }
      closeModal(); location.hash = `#/t/${id}/plan`;
      if (dest) firstPhoto({ name: dest.name, city: dest.name, lat: dest.lat, lon: dest.lon }, "auto").then(ph => { if (ph) { updateDoc(doc(fs, "trips/" + id), { cover: ph.photo || ph.photoUrl, coverCredit: ph.photoCredit || "" }).catch(() => {}); trackUnsplash(ph.dl); } });
    };
  });
}

// ================================================================ TRIP VIEW
const TABS = [["plan", "Itinerary"], ["places", "Places"], ["bookings", "Bookings"], ["budget", "Budget"], ["overview", "Overview"]];
function leaveTrip() {
  if (!cur) return;
  cur.unsubs.forEach(u => u()); cur = null;
  for (const k of Object.keys(T)) T[k] = k === "trip" ? null : {};
  destroyMap(); document.body.classList.remove("show-map");
}
function openTrip(id, tab) {
  if (cur && cur.id === id) { if (cur.tab !== tab) { cur.tab = tab; mapFocus = null; fitPending = true; renderTrip(); renderMap(); } return; }
  leaveTrip();
  cur = { id, tab, unsubs: [] };
  $("#app").innerHTML = `<div class="trip"><div class="panel" id="panel"><div class="view"><p class="hint">Loading trip…</p></div></div><div class="mapwrap"><div id="map"></div></div></div><button class="btn accent mapbtn" id="mapToggle" type="button">Map</button>`;
  $("#mapToggle").onclick = () => { document.body.classList.toggle("show-map"); $("#mapToggle").textContent = document.body.classList.contains("show-map") ? "List" : "Map"; map?.invalidateSize(); };
  initMap();
  const rerender = debounce(() => { if (cur?.id === id) { renderTrip(true); renderMap(); } }, 60);
  cur.unsubs.push(onSnapshot(doc(fs, "trips/" + id), s => {
    if (!s.exists()) { $("#panel").innerHTML = `<div class="view"><p class="banner">This trip doesn't exist anymore, or you're no longer a member.</p><a href="#/">Back to your trips</a></div>`; return; }
    T.trip = { ...s.data() };
    if (ME && !(T.trip.names || {})[ekey(ME.email)] && members().includes(ME.email)) updateDoc(doc(fs, "trips/" + id), { ["names." + ekey(ME.email)]: ME.name }).catch(() => {});
    rerender();
  }, e => { $("#panel").innerHTML = `<div class="view"><p class="banner">${e.code === "permission-denied" ? "You're not a member of this trip. Ask the person who planned it to invite your Google email." : "Couldn't load this trip."}</p><a href="#/">Back to your trips</a></div>`; }));
  for (const name of ["places", "days", "bookings", "expenses", "checklist", "photos"]) {
    cur.unsubs.push(onSnapshot(collection(fs, `trips/${id}/${name}`), snap => {
      const o = {}; snap.docs.forEach(d => { o[d.id] = { ...d.data() }; });
      for (const p of Object.keys(latest)) if (p.startsWith(`trips/${id}/${name}/`)) o[p.split("/").pop()] = latest[p];
      T[name] = o; rerender();
    }, () => {}));
  }
}
// fromData: a re-render caused by incoming data; it waits while you're typing so your text and cursor stay put
function renderTrip(fromData = false) {
  if (!T.trip || !cur) return;
  const t = T.trip, panel = $("#panel"), scroll = panel.scrollTop;
  // keep focus and typing intact while data streams in
  const a = document.activeElement, focusId = a && panel.contains(a) && a.id ? a.id : null, sel = focusId && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
  if (fromData && focusId && a.matches("input:not([type=checkbox]):not([type=file]), textarea, select")) { pendingRender = true; return; }
  $("#crumb").textContent = t.name || "";
  const range = validIso(t.start) ? `${fmtD(t.start, { month: "short", day: "numeric" })} – ${fmtD(t.end, { month: "short", day: "numeric", year: "numeric" })}` : "Add dates in Overview";
  panel.innerHTML = `<div class="hero">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ""}
      <div class="hero-btns"><button class="btn small" type="button" id="inviteBtn">Share</button></div>
      <div class="hero-text"><h1>${esc(t.name || "Untitled trip")}</h1><span class="sub">${esc(range)}${t.dest?.name ? " · " + esc(t.dest.name) : ""} · ${esc(tripWhen(t))}</span><span class="avatars">${members().map(avatar).join("")}</span></div></div>
    <nav class="tabs" aria-label="Trip sections">${TABS.map(([k, l]) => `<a href="#/t/${cur.id}/${k}" ${cur.tab === k ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <div class="view" id="view"></div>`;
  $("#inviteBtn").onclick = inviteModal;
  ({ plan: viewPlan, places: viewPlaces, bookings: viewBookings, budget: viewBudget, overview: viewOverview }[cur.tab] || viewPlan)($("#view"));
  panel.scrollTop = scroll;
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} } }
}
let pendingRender = false;
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender && cur) { pendingRender = false; renderTrip(); renderMap(); } }, 0));

// ---------------------------------------------------------------- places data
const placeList = () => Object.entries(T.places).map(([id, p]) => ({ id, ...p, type: TYPE[p.type] ? p.type : "other", hearts: p.hearts || {} }));
const dayPlaces = iso => placeList().filter(p => p.day === iso).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.time || "").localeCompare(b.time || ""));
function newPlaceFrom(x, extra = {}) {
  return { name: (x.name || "").slice(0, 80), type: x.type || "other", city: (x.city || "").slice(0, 60), country: (x.country || "").slice(0, 60), lat: x.lat ?? null, lon: x.lon ?? null,
    addr: x.addr || "", link: x.link || gmapsUrl(x), notes: "", day: "", order: 0, time: "", photo: "", photoUrl: "", photoCredit: "", photoLink: "", photoBy: "", photoSrc: "",
    hearts: { [ekey(ME.email)]: ME.name }, by: ME.email, created: Date.now(), ...extra };
}
function addPlace(x, extra) {
  const id = uidGen(), p = newPlaceFrom(x, extra);
  T.places[id] = p; save(tp("places/" + id), p, 0);
  firstPhoto(x).then(ph => {
    if (!ph || !T.places[id] || photoSrcOf(T.places[id])) return;
    const { dl, ...keep } = ph; T.places[id] = { ...T.places[id], ...keep }; save(tp("places/" + id), T.places[id], 0); trackUnsplash(dl);
  });
  return id;
}
const savePlace = (id, delay = 0) => save(tp("places/" + id), T.places[id], delay);

// ================================================================ ITINERARY
let openAdd = null;   // which day's add box is open
function bookingsOn(iso) {
  const out = [];
  for (const [id, b] of Object.entries(T.bookings)) {
    const k = KINDS[b.kind] || KINDS.other;
    if (k.group === "transport") {
      if (b.depDate === iso) out.push({ id, b, t: b.depTime || "", txt: `<b>${esc(k.label)}</b> ${esc(b.num ? b.num + " · " : "")}${esc(b.from || "?")} ${esc(b.depTime || "")} → ${esc(b.to || "?")} ${esc(b.arrTime || "")}${b.arrDate && b.arrDate !== b.depDate ? " (+" + daysBetween(b.depDate, b.arrDate) + ")" : ""}` });
      else if (b.arrDate === iso) out.push({ id, b, t: b.arrTime || "", txt: `<b>Arrive</b> ${esc(b.title || k.label)} · ${esc(b.to || "")} ${esc(b.arrTime || "")}` });
    } else if (k.group === "lodging") {
      if (b.checkIn === iso) out.push({ id, b, t: b.checkInTime || "15:00", txt: `<b>Check in</b> ${esc(b.title || "Stay")}${b.checkInTime ? " · " + esc(b.checkInTime) : ""}` });
      if (b.checkOut === iso) out.push({ id, b, t: b.checkOutTime || "11:00", txt: `<b>Check out</b> ${esc(b.title || "Stay")}${b.checkOutTime ? " · " + esc(b.checkOutTime) : ""}` });
    } else if (k.group === "car") {
      if (b.depDate === iso) out.push({ id, b, t: b.depTime || "", txt: `<b>Pick up car</b> ${esc(b.from || b.title || "")} ${esc(b.depTime || "")}` });
      if (b.arrDate === iso) out.push({ id, b, t: b.arrTime || "", txt: `<b>Return car</b> ${esc(b.to || b.from || "")} ${esc(b.arrTime || "")}` });
    } else if (b.date === iso) out.push({ id, b, t: b.time || "", txt: `<b>${esc(k.label)}</b> ${esc(b.title || "")}${b.time ? " · " + esc(b.time) : ""}` });
  }
  return out.sort((a, b) => (a.t || "99").localeCompare(b.t || "99"));
}
const stayFor = iso => Object.entries(T.bookings).find(([, b]) => b.kind === "lodging" && validIso(b.checkIn) && validIso(b.checkOut) && iso >= b.checkIn && iso < b.checkOut);
function viewPlan(v) {
  const days = tripDays();
  if (!days.length) { v.innerHTML = `<div class="empty">Add your trip dates in <a href="#/t/${cur.id}/overview">Overview</a> to start a day-by-day plan.</div>`; return; }
  const unscheduled = placeList().filter(p => !p.day || !days.includes(p.day));
  v.innerHTML = `<div class="row between"><h2>Itinerary</h2><span class="hint">${days.length} days · drag places to reorder or move between days</span></div>
    ${unscheduled.length ? `<p class="hint">${unscheduled.length} saved place${unscheduled.length === 1 ? "" : "s"} not scheduled yet. Add them from a day's “Add a place” box, or from <a href="#/t/${cur.id}/places">Places</a>.</p>` : ""}
    ${days.map((iso, i) => dayHtml(iso, i)).join("")}`;
  wirePlan(v);
}
function dayHtml(iso, i) {
  const items = dayPlaces(iso), bk = bookingsOn(iso), stay = stayFor(iso), notes = T.days[iso]?.notes || "", photos = Object.entries(T.photos).filter(([, p]) => p.day === iso);
  const focus = mapFocus === iso;
  let total = 0, legs = [];
  for (let k = 1; k < items.length; k++) { if (hasPt(items[k - 1]) && hasPt(items[k])) { const d = km(items[k - 1], items[k]); total += d; legs[k] = d; } }
  const pts = items.filter(hasPt);
  return `<section class="day ${focus ? "focus" : ""}" id="day-${iso}" data-day="${iso}" style="--dc:${dayCol(i)}">
    <div class="day-head" data-focus="${iso}" role="button" tabindex="0" aria-label="Show ${esc(dayLabel(iso))} on the map">
      <span class="day-dot"></span><div class="grow"><h2>${esc(fmtD(iso, { weekday: "long", month: "long", day: "numeric" }))}</h2>
      <span class="meta">Day ${i + 1}${items.length ? ` · ${items.length} place${items.length === 1 ? "" : "s"}` : ""}${total ? ` · ${total.toFixed(1)} km` : ""}</span></div>
      ${focus ? `<span class="pill accent">On map</span>` : ""}</div>
    <div class="day-body">
      ${bk.map(x => `<div class="bk-mini">${x.txt}</div>`).join("")}
      <textarea class="day-notes" id="dn-${iso}" data-notes="${iso}" data-live placeholder="Notes for the day…" rows="${Math.min(8, Math.max(1, notes.split("\n").length))}">${esc(notes)}</textarea>
      <ol class="stops drop-zone" data-drop="${iso}">
        ${items.map((p, k) => `${k && legs[k] != null ? `<li class="leg" aria-hidden="true">${esc(legText(legs[k]))}</li>` : ""}
          <li class="stop" draggable="true" data-id="${p.id}" style="--tc:${TYPE[p.type].col}">
            <span class="num">${k + 1}</span>
            <span class="thumb">${photoSrcOf(p) ? `<img src="${esc(photoSrcOf(p))}" alt="" loading="lazy" onerror="this.remove()">` : esc(p.name.charAt(0))}</span>
            <span><span class="nm">${esc(p.name)}</span><span class="sub"><span>${esc(TYPE[p.type].label)}${p.city ? " · " + esc(p.city) : ""}</span><input type="time" id="tm-${p.id}" data-time="${p.id}" data-live value="${esc(p.time || "")}" aria-label="Time for ${esc(p.name)}"></span></span>
            <span class="acts"><button class="iconbtn" type="button" data-up="${p.id}" aria-label="Move up">↑</button><button class="iconbtn" type="button" data-down="${p.id}" aria-label="Move down">↓</button><button class="iconbtn" type="button" data-edit="${p.id}" aria-label="Edit ${esc(p.name)}">✎</button><button class="iconbtn del" type="button" data-unsched="${p.id}" aria-label="Remove from this day">×</button></span>
          </li>`).join("")}
      </ol>
      ${photos.length ? `<div class="row" style="gap:6px">${photos.map(([pid, ph]) => `<img src="${esc(ph.data)}" alt="Trip photo" data-zoom style="width:64px;height:48px;object-fit:cover;border-radius:7px;cursor:zoom-in">`).join("")}</div>` : ""}
      ${stay ? `<div class="bk-mini"><b>Staying at</b> ${esc(stay[1].title || "your stay")}</div>` : ""}
      ${openAdd === iso ? `<div class="suggest-wrap"><input id="add-${iso}" autocomplete="off" placeholder="Search saved places or anywhere…" role="combobox" aria-expanded="false" aria-controls="addl-${iso}" data-live><ul class="suggest" id="addl-${iso}" role="listbox" hidden></ul></div>` : ""}
      <div class="day-actions">
        <button class="btn small ${openAdd === iso ? "ghost" : ""}" type="button" data-add="${iso}">${openAdd === iso ? "Done adding" : "+ Add a place"}</button>
        ${pts.length > 2 ? `<button class="btn ghost small" type="button" data-opt="${iso}" title="Reorder stops to shorten the day's route">Optimize route</button>` : ""}
        ${pts.length > 1 ? `<a class="btn ghost small" href="${esc(dirUrl(pts))}" target="_blank" rel="noopener">Directions ↗</a>` : ""}
      </div>
    </div></section>`;
}
function dirUrl(pts) {
  const ll = p => `${p.lat},${p.lon}`, mid = pts.slice(1, -1).slice(0, 9);
  let total = 0; for (let i = 1; i < pts.length; i++) total += km(pts[i - 1], pts[i]);
  return `https://www.google.com/maps/dir/?api=1&origin=${ll(pts[0])}&destination=${ll(pts[pts.length - 1])}${mid.length ? "&waypoints=" + encodeURIComponent(mid.map(ll).join("|")) : ""}&travelmode=${total < 6 ? "walking" : "transit"}`;
}
function reorderDay(iso, ids) {
  ids.forEach((id, k) => { if (T.places[id] && (T.places[id].order !== k || T.places[id].day !== iso)) { T.places[id] = { ...T.places[id], day: iso, order: k }; savePlace(id); } });
}
function optimize(iso) {
  const items = dayPlaces(iso), pts = items.filter(hasPt), rest = items.filter(p => !hasPt(p));
  if (pts.length < 3) return;
  const len = arr => arr.reduce((a, p, i) => i ? a + km(arr[i - 1], p) : 0, 0);
  // nearest neighbour from the first stop, then 2-opt, keeping the first stop fixed
  let route = [pts[0]], left = pts.slice(1);
  while (left.length) { const last = route[route.length - 1]; left.sort((a, b) => km(last, a) - km(last, b)); route.push(left.shift()); }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < route.length - 1; i++) for (let j = i + 1; j < route.length; j++) {
      const cand = [...route.slice(0, i), ...route.slice(i, j + 1).reverse(), ...route.slice(j + 1)];
      if (len(cand) < len(route) - 1e-6) { route = cand; improved = true; }
    }
  }
  const before = len(pts), after = len(route);
  if (before - after < 0.05) { toast("This day's order is already about as short as it gets."); return; }
  const prev = items.map(p => p.id);
  reorderDay(iso, [...route.map(p => p.id), ...rest.map(p => p.id)]);
  renderTrip(); renderMap();
  toast(`New order saves about ${(before - after).toFixed(1)} km.`, { label: "Undo", run: () => { reorderDay(iso, prev); renderTrip(); renderMap(); } });
}
function wirePlan(v) {
  v.addEventListener("click", e => {
    const f = e.target.closest("[data-focus]");
    if (f && !e.target.closest("button")) { mapFocus = mapFocus === f.dataset.focus ? null : f.dataset.focus; fitPending = true; renderTrip(); renderMap(); return; }
    const b = e.target.closest("button, img[data-zoom]"); if (!b) return;
    if (b.dataset.add) { openAdd = openAdd === b.dataset.add ? null : b.dataset.add; renderTrip(); const inp = openAdd && $("#add-" + openAdd); if (inp) { wireAdd(openAdd); inp.focus(); } return; }
    if (b.dataset.opt) return optimize(b.dataset.opt);
    if (b.dataset.edit) return placeModal(b.dataset.edit);
    if (b.dataset.unsched) { const id = b.dataset.unsched; T.places[id] = { ...T.places[id], day: "", time: "" }; savePlace(id); renderTrip(); renderMap(); return; }
    if (b.dataset.up || b.dataset.down) {
      const id = b.dataset.up || b.dataset.down, iso = T.places[id].day, ids = dayPlaces(iso).map(p => p.id), i = ids.indexOf(id), j = i + (b.dataset.up ? -1 : 1);
      if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; reorderDay(iso, ids); renderTrip(); renderMap(); return;
    }
    if (b.dataset.zoom != null) lightbox(b.src);
  });
  v.addEventListener("keydown", e => { const f = e.target.closest("[data-focus]"); if (f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); f.click(); } });
  v.addEventListener("input", e => {
    if (e.target.dataset.notes) { const iso = e.target.dataset.notes; T.days[iso] = { ...(T.days[iso] || {}), notes: e.target.value.slice(0, 2000) }; save(tp("days/" + iso), T.days[iso], 700); }
  });
  v.addEventListener("change", e => {
    if (e.target.dataset.time) { const id = e.target.dataset.time; T.places[id] = { ...T.places[id], time: e.target.value }; savePlace(id, 300); }
  });
  // drag and drop between and within days
  let dragId = null;
  v.addEventListener("dragstart", e => { const li = e.target.closest(".stop"); if (!li) return; dragId = li.dataset.id; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); });
  v.addEventListener("dragend", e => { e.target.closest?.(".stop")?.classList.remove("dragging"); $$(".drop-zone.over").forEach(z => z.classList.remove("over")); });
  v.addEventListener("dragover", e => { const z = e.target.closest("[data-drop]"); if (!z || !dragId) return; e.preventDefault(); $$(".drop-zone.over").forEach(x => x !== z && x.classList.remove("over")); z.classList.add("over"); });
  v.addEventListener("drop", e => {
    const z = e.target.closest("[data-drop]"); if (!z || !dragId) return; e.preventDefault(); z.classList.remove("over");
    const iso = z.dataset.drop, from = T.places[dragId]?.day;
    const ids = dayPlaces(iso).map(p => p.id).filter(id => id !== dragId);
    const after = $$(".stop", z).filter(li => li.dataset.id !== dragId).find(li => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
    const at = after ? ids.indexOf(after.dataset.id) : ids.length;
    ids.splice(at, 0, dragId); reorderDay(iso, ids);
    if (from && from !== iso) reorderDay(from, dayPlaces(from).map(p => p.id).filter(id => id !== dragId));
    dragId = null; renderTrip(); renderMap();
  });
  if (openAdd && $("#add-" + openAdd)) wireAdd(openAdd);
}
function wireAdd(iso) {
  const inp = $("#add-" + iso), list = $("#addl-" + iso); if (!inp || inp.dataset.wired) return; inp.dataset.wired = "1";
  attachSuggest(inp, list, {
    near: () => nearPoint(iso),
    local: q => { q = q.toLowerCase(); return q ? placeList().filter(p => p.day !== iso && (p.name + " " + p.city).toLowerCase().includes(q)).slice(0, 6).map(p => ({ ...p, saved: true })) : []; },
    onPick: x => {
      const n = dayPlaces(iso).length;
      if (x.saved) { T.places[x.id] = { ...T.places[x.id], day: iso, order: n }; savePlace(x.id); toast(`${esc(x.name)} added to ${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}.`); }
      else {
        const dup = placeList().find(p => p.name.toLowerCase() === x.name.toLowerCase() && (p.city || "") === x.city);
        if (dup) { T.places[dup.id] = { ...T.places[dup.id], day: iso, order: n }; savePlace(dup.id); }
        else addPlace(x, { day: iso, order: n });
        toast(`${esc(x.name)} added.`);
      }
      inp.value = ""; renderTrip(); renderMap(); const again = $("#add-" + iso); if (again) { wireAdd(iso); again.focus(); }
    },
  });
}
function nearPoint(iso) {
  const pts = (iso ? dayPlaces(iso) : placeList()).filter(hasPt);
  if (pts.length) return { lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon };
  const all = placeList().filter(hasPt); if (all.length) return { lat: all[0].lat, lon: all[0].lon };
  return T.trip?.dest && hasPt(T.trip.dest) ? { lat: T.trip.dest.lat, lon: T.trip.dest.lon } : null;
}
function lightbox(src) {
  const lb = document.createElement("div"); lb.className = "lightbox"; lb.innerHTML = `<img src="${esc(src)}" alt="Enlarged photo">`;
  lb.onclick = () => lb.remove(); document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { lb.remove(); document.removeEventListener("keydown", k); } });
  document.body.append(lb);
}

// ================================================================ PLACES
const PF = { q: "", type: "", sched: "", city: "" };
function viewPlaces(v) {
  const all = placeList(), days = tripDays();
  const L = all.filter(p => (!PF.type || p.type === PF.type) && (!PF.city || p.city === PF.city) &&
    (!PF.sched || (PF.sched === "yes" ? days.includes(p.day) : !days.includes(p.day))) &&
    (!PF.q || [p.name, p.notes, p.city, p.country, TYPE[p.type].label].join(" ").toLowerCase().includes(PF.q.toLowerCase())))
    .sort((a, b) => Object.keys(b.hearts).length - Object.keys(a.hearts).length || (b.created || 0) - (a.created || 0));
  const count = f => { const m = {}; all.forEach(p => { const k = f(p); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])); };
  const chips = (key, items) => `<div class="chips" data-f="${key}"><button type="button" class="chip ${!PF[key] ? "on" : ""}" data-v="">All</button>${items.map(([v, l, n]) => `<button type="button" class="chip ${PF[key] === v ? "on" : ""}" data-v="${esc(v)}">${esc(l)}<span class="n">${n}</span></button>`).join("")}</div>`;
  v.innerHTML = `<div class="row between"><h2>Places</h2><button class="btn ghost small" type="button" id="fillPh" ${all.some(p => !photoSrcOf(p)) ? "" : "hidden"}>Find missing photos</button></div>
    <div class="card" style="display:grid;gap:8px"><h3 style="color:var(--accent)">Add a place</h3>
      <div class="suggest-wrap"><input id="pq" autocomplete="off" placeholder="Search anywhere, e.g. Sagrada Família, a café, a beach…" role="combobox" aria-expanded="false" aria-controls="pql" data-live><ul class="suggest" id="pql" role="listbox" hidden></ul></div>
      <p class="hint">Picked places get their type, location, a Google Maps link and a photo when one is free to use. <button class="linkbtn" type="button" id="manual">Add one by hand</button></p></div>
    ${all.length ? `<div class="card filters">
      <input class="input" id="pfq" type="search" placeholder="Filter by name, note or city" value="${esc(PF.q)}" data-live>
      ${chips("type", TYPES.map(([k, l]) => [k, l, all.filter(p => p.type === k).length]).filter(x => x[2]))}
      ${count(p => p.city).length > 1 ? chips("city", count(p => p.city).map(([c, n]) => [c, c, n])) : ""}
      ${chips("sched", [["yes", "Scheduled", all.filter(p => days.includes(p.day)).length], ["no", "Not scheduled", all.filter(p => !days.includes(p.day)).length]])}
    </div>` : ""}
    <div class="place-grid">${L.map(placeCard).join("") || `<div class="empty" style="grid-column:1/-1">${all.length ? "No places match these filters." : "Nothing saved yet. Search above to add sights, food, shops and more."}</div>`}</div>`;
  attachSuggest($("#pq"), $("#pql"), {
    near: () => nearPoint(null),
    onPick: x => {
      const dup = placeList().find(p => p.name.toLowerCase() === x.name.toLowerCase() && (p.city || "") === x.city);
      if (dup) { toast(`${esc(x.name)} is already saved.`); flashPlace(dup.id); return; }
      const id = addPlace(x); $("#pq").value = ""; renderTrip(); renderMap(); flashPlace(id);
      toast(`Saved ${esc(x.name)}.`, { label: "Add a note", run: () => placeModal(id) });
    },
  });
  $("#manual").onclick = () => placeModal(null);
  $("#fillPh").onclick = fillPhotos;
  v.addEventListener("input", e => { if (e.target.id === "pfq") { PF.q = e.target.value; renderPlacesGridOnly(); } });
  v.addEventListener("click", e => {
    const chip = e.target.closest(".chips[data-f] .chip");
    if (chip) { const k = chip.parentElement.dataset.f; PF[k] = PF[k] === chip.dataset.v ? "" : chip.dataset.v; renderTrip(); renderMap(); return; }
    const card = e.target.closest(".place"); if (!card) return; const id = card.dataset.id;
    if (e.target.closest("[data-heart]")) {
      const k = ekey(ME.email), on = !(T.places[id].hearts || {})[k], hearts = { ...(T.places[id].hearts || {}) };
      if (on) hearts[k] = ME.name; else delete hearts[k];
      T.places[id] = { ...T.places[id], hearts };
      updateDoc(doc(fs, tp("places/" + id)), { ["hearts." + k]: on ? ME.name : deleteField() }).catch(fail);
      renderTrip(); return;
    }
    if (e.target.closest("[data-edit]")) return placeModal(id);
    if (e.target.closest("[data-zoom]")) return lightbox(e.target.src);
    if (e.target.closest("[data-locate]")) { mapFocusPlace(id); }
  });
  v.addEventListener("change", e => {
    if (e.target.dataset.pday != null) { const id = e.target.closest(".place").dataset.id, iso = e.target.value; T.places[id] = { ...T.places[id], day: iso, order: iso ? dayPlaces(iso).length : 0 }; savePlace(id); renderTrip(); renderMap(); }
  });
}
function renderPlacesGridOnly() {
  // light re-render while typing in the filter box
  const keep = PF.q; renderTrip(); const f = $("#pfq"); if (f) { f.focus(); f.setSelectionRange(keep.length, keep.length); }
  renderMap();
}
function placeCard(p) {
  const t = TYPE[p.type], ph = photoSrcOf(p), who = Object.values(p.hearts), mine = !!p.hearts[ekey(ME.email)], link = safeUrl(p.link);
  return `<article class="place" id="pl-${p.id}" data-id="${p.id}" style="--tc:${t.col}">
    <div class="place-img"><div class="ph">${esc((p.name || "?").charAt(0).toUpperCase())}</div>${ph ? `<img src="${esc(ph)}" alt="${esc(p.name)}" data-zoom loading="lazy" onerror="this.remove()">${creditHtml(p)}` : ""}<span class="type-chip">${esc(t.label)}</span></div>
    <div class="place-body"><span class="nm">${esc(p.name)}</span><span class="where">${esc([p.city !== p.name ? p.city : "", p.country].filter(Boolean).join(", "))}</span>
      ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ""}
      <div class="place-foot"><button class="heart ${mine ? "on" : ""}" type="button" data-heart aria-pressed="${mine}" title="${esc(who.join(", "))}">♥ ${who.length || ""}</button>
        <select data-pday aria-label="Schedule ${esc(p.name)}">${dayOptions(tripDays().includes(p.day) ? p.day : "")}</select><span class="grow"></span>
        ${hasPt(p) ? `<button class="ext" type="button" data-locate style="border:0;background:none;cursor:pointer">Map</button>` : ""}
        ${link ? `<a class="ext" href="${esc(link)}" target="_blank" rel="noopener">${/google\.[a-z.]+\/maps/.test(link) ? "Maps ↗" : "Link ↗"}</a>` : ""}
        <button class="ext" type="button" data-edit style="border:0;background:none;cursor:pointer">Edit</button></div></div></article>`;
}
function flashPlace(id) { requestAnimationFrame(() => { const c = document.getElementById("pl-" + id); if (c) { c.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1400); } }); }
async function fillPhotos() {
  const btn = $("#fillPh"); if (!btn) return;
  const todo = placeList().filter(p => !photoSrcOf(p)); let found = 0;
  btn.disabled = true;
  for (let i = 0; i < todo.length; i++) {
    btn.textContent = `Finding photos… ${i + 1} of ${todo.length}`;
    const p = todo[i], ph = await firstPhoto(p, "free");
    if (ph && T.places[p.id] && !photoSrcOf(T.places[p.id])) { const { dl, ...keep } = ph; T.places[p.id] = { ...T.places[p.id], ...keep }; savePlace(p.id); found++; }
    await new Promise(r => setTimeout(r, 250));
  }
  const left = placeList().filter(p => !photoSrcOf(p));
  for (const p of left) {
    if (!UNSPLASH_KEY || unsplashBusy()) break;
    const u = await unsplashCands(p).catch(() => []);
    for (const c of u) { try { const ph = await materialize(c); if (T.places[p.id] && !photoSrcOf(T.places[p.id])) { const { dl, ...keep } = ph; T.places[p.id] = { ...T.places[p.id], ...keep }; savePlace(p.id); trackUnsplash(dl); found++; } break; } catch {} }
  }
  const still = placeList().filter(p => !photoSrcOf(p)).length;
  toast(`Added ${found} photo${found === 1 ? "" : "s"}.${still ? ` ${still} still need one${unsplashBusy() && UNSPLASH_KEY ? " (Unsplash's hourly limit was reached)" : ""}.` : ""}`);
  renderTrip();
}
function placeModal(id) {
  const p = id ? T.places[id] : null;
  let ph = p && photoSrcOf(p) ? { photo: p.photo, photoUrl: p.photoUrl, photoCredit: p.photoCredit, photoLink: p.photoLink, photoBy: p.photoBy, photoSrc: p.photoSrc, dl: "" } : null;
  let cands = null, idx = -1, picked = null, armed = false;
  openModal(`<div class="row between"><h2>${p ? "Edit place" : "Add a place"}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <div class="field"><label for="pmName">Name</label><div class="suggest-wrap"><input id="pmName" maxlength="80" autocomplete="off" value="${esc(p?.name || "")}" role="combobox" aria-expanded="false" aria-controls="pmList"><ul class="suggest" id="pmList" role="listbox" hidden></ul></div></div>
    <div class="grid2"><label class="field" for="pmType">Type<select id="pmType">${TYPES.map(([k, l]) => `<option value="${k}" ${p?.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field" for="pmCity">City<input id="pmCity" maxlength="60" value="${esc(p?.city || "")}"></label></div>
    <label class="field" for="pmLink">Link<input id="pmLink" type="url" maxlength="500" value="${esc(p?.link || "")}" placeholder="https://…"></label>
    <label class="field" for="pmNotes">Notes<textarea id="pmNotes" rows="3" maxlength="600" placeholder="What to get, best time to go, who recommended it…">${esc(p?.notes || "")}</textarea></label>
    <div class="grid2"><label class="field" for="pmDay">Day<select id="pmDay">${dayOptions(p?.day || "")}</select></label><label class="field" for="pmTime">Time<input id="pmTime" type="time" value="${esc(p?.time || "")}"></label></div>
    <div class="field"><span>Photo</span><div class="photo-box" id="pmDrop"><div class="photo-prev" id="pmPrev">No photo</div>
      <div style="display:grid;gap:6px"><div class="row" style="gap:6px"><button class="btn ghost small" type="button" id="pmFind">Find a photo</button><label class="btn ghost small file-btn">Upload<input type="file" id="pmFile" accept="image/*"></label><button class="linkbtn" type="button" id="pmRm">Remove</button></div>
      <span class="hint" id="pmCredit"></span><span class="hint">Or paste (Ctrl/⌘ + V) or drop an image here.</span></div></div></div>
    <p class="hint" id="pmMsg"></p>
    <div class="row between">${p ? `<button class="btn danger" type="button" id="pmDel">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="pmSave">Save</button></div></div>`, m => {
    const show = () => {
      const src = ph ? ph.photo || ph.photoUrl : "";
      $("#pmPrev").innerHTML = src ? `<img src="${esc(src)}" alt="">` : "No photo"; $("#pmRm").hidden = !src;
      $("#pmCredit").innerHTML = src && ph ? creditHtml(ph).replace(' class="credit"', "") : "";
      $("#pmFind").textContent = cands && (cands.length > 1 || (!cands.unsplashDone && UNSPLASH_KEY)) ? "Try another photo" : "Find a photo";
    };
    show();
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    attachSuggest($("#pmName"), $("#pmList"), { near: () => nearPoint(null), onPick: x => { picked = x; $("#pmName").value = x.name; $("#pmType").value = x.type; $("#pmCity").value = x.city; if (!$("#pmLink").value) $("#pmLink").value = gmapsUrl(x); if (!ph) next(true); } });
    const place = () => ({ name: $("#pmName").value.trim(), city: $("#pmCity").value.trim(), lat: picked?.lat ?? p?.lat ?? null, lon: picked?.lon ?? p?.lon ?? null });
    const next = async fresh => {
      const x = place(); if (!x.name) { $("#pmMsg").textContent = "Type a name first."; return; }
      if (fresh || !cands || cands.key !== x.name + "|" + x.city) { $("#pmMsg").textContent = "Looking for photos…"; cands = await photoCandidates(x).catch(() => []); cands.key = x.name + "|" + x.city; idx = -1; }
      if (idx >= cands.length - 1 && !cands.unsplashDone && UNSPLASH_KEY) { cands.unsplashDone = true; addCands(cands, await unsplashCands(x).catch(() => [])); }
      if (!cands.length) { $("#pmMsg").textContent = "No free photos found. Upload or paste your own."; return; }
      for (let t = 0; t < cands.length; t++) { idx = (idx + 1) % cands.length; try { ph = await materialize(cands[idx]); $("#pmMsg").textContent = `Photo ${idx + 1} of ${cands.length}${!cands.unsplashDone && UNSPLASH_KEY ? "+" : ""}.`; show(); return; } catch {} }
      $("#pmMsg").textContent = "Couldn't load the photos found.";
    };
    $("#pmFind").onclick = () => next(false);
    $("#pmRm").onclick = () => { ph = null; show(); };
    const own = async f => { if (!f || !f.type.startsWith("image/")) return; try { ph = { photo: await shrink(f), photoUrl: "", photoCredit: "", photoLink: "", photoBy: "", photoSrc: "own", dl: "" }; show(); } catch (e) { $("#pmMsg").textContent = e.message; } };
    $("#pmFile").onchange = e => { own(e.target.files[0]); e.target.value = ""; };
    m.addEventListener("paste", e => { const it = [...(e.clipboardData?.items || [])].find(i => i.kind === "file" && i.type.startsWith("image/")); if (it) { e.preventDefault(); own(it.getAsFile()); } });
    const box = $("#pmDrop");
    m.addEventListener("dragover", e => { e.preventDefault(); box.classList.add("over"); });
    m.addEventListener("dragleave", e => { if (!m.contains(e.relatedTarget)) box.classList.remove("over"); });
    m.addEventListener("drop", e => { e.preventDefault(); box.classList.remove("over"); const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith("image/")); if (f) own(f); else $("#pmMsg").textContent = "Copy the image and paste it here instead."; });
    if (p) $("#pmDel").onclick = () => { if (!armed) { armed = true; $("#pmDel").textContent = "Tap again to delete"; return; } delete T.places[id]; remove(tp("places/" + id)); closeModal(); renderTrip(); renderMap(); };
    $("#pmSave").onclick = async () => {
      const name = $("#pmName").value.trim(); if (!name) { $("#pmMsg").textContent = "Give it a name."; return; }
      const city = $("#pmCity").value.trim(), day = $("#pmDay").value;
      let lat = picked?.lat ?? p?.lat ?? null, lon = picked?.lon ?? p?.lon ?? null, country = picked?.country ?? p?.country ?? "";
      if (lat == null && city) { try { const hit = (await searchPlaces(city, nearPoint(null)))[0]; if (hit) { lat = hit.lat; lon = hit.lon; country = country || hit.country; } } catch {} }
      const base = p || newPlaceFrom({ name });
      const pid = id || uidGen();
      T.places[pid] = { ...base, name, type: $("#pmType").value, city, country, lat, lon, link: $("#pmLink").value.trim().slice(0, 500), notes: $("#pmNotes").value.trim().slice(0, 600),
        day, time: $("#pmTime").value, order: day && day !== base.day ? dayPlaces(day).length : base.order ?? 0,
        photo: ph?.photo || "", photoUrl: ph?.photoUrl || "", photoCredit: ph?.photoCredit || "", photoLink: ph?.photoLink || "", photoBy: ph?.photoBy || "", photoSrc: ph?.photoSrc || "" };
      if (ph?.dl) trackUnsplash(ph.dl);
      savePlace(pid); closeModal(); renderTrip(); renderMap();
    };
  });
}

// ================================================================ BOOKINGS
const BF = { kind: "" };
function bkStart(b) {
  const k = KINDS[b.kind] || KINDS.other;
  if (k.group === "lodging") return (b.checkIn || "9999") + (b.checkInTime || "15:00");
  if (k.group === "transport" || k.group === "car") return (b.depDate || "9999") + (b.depTime || "");
  return (b.date || "9999") + (b.time || "");
}
function viewBookings(v) {
  const all = Object.entries(T.bookings).sort((a, b) => bkStart(a[1]).localeCompare(bkStart(b[1])));
  const L = all.filter(([, b]) => !BF.kind || (KINDS[b.kind] || KINDS.other).group === BF.kind);
  const groups = [["transport", "Flights, trains & transfers"], ["lodging", "Stays"], ["car", "Rental cars"], ["event", "Reservations & tickets"]];
  v.innerHTML = `<div class="row between"><h2>Bookings</h2><div class="row" style="gap:6px">
      <button class="btn small" type="button" data-new="flight">+ Flight</button><button class="btn ghost small" type="button" data-new="train">+ Train</button><button class="btn ghost small" type="button" data-new="lodging">+ Stay</button><button class="btn ghost small" type="button" data-new="reservation">+ Reservation</button><button class="btn ghost small" type="button" data-new="other">+ Other</button></div></div>
    ${all.length ? `<div class="chips"><button type="button" class="chip ${!BF.kind ? "on" : ""}" data-bf="">All</button>${groups.map(([g, l]) => { const n = all.filter(([, b]) => (KINDS[b.kind] || KINDS.other).group === g).length; return n ? `<button type="button" class="chip ${BF.kind === g ? "on" : ""}" data-bf="${g}">${l}<span class="n">${n}</span></button>` : ""; }).join("")}</div>` : ""}
    ${L.map(([id, b]) => bookingCard(id, b)).join("") || `<div class="empty">Keep flights, trains, stays and reservations here, with times and confirmation numbers. They show up on the right days in the itinerary.</div>`}`;
  v.addEventListener("click", e => {
    const n = e.target.closest("[data-new]"); if (n) return bookingModal(null, n.dataset.new);
    const f = e.target.closest("[data-bf]"); if (f) { BF.kind = f.dataset.bf; renderTrip(); return; }
    const ed = e.target.closest("[data-bedit]"); if (ed) return bookingModal(ed.dataset.bedit);
    const c = e.target.closest("[data-copy]"); if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast("Copied " + esc(c.dataset.copy)), () => {}); }
  });
}
function bookingCard(id, b) {
  const k = KINDS[b.kind] || KINDS.other, cost = num(b.cost);
  const conf = b.conf ? `<span>Confirmation <b class="copy mono" data-copy="${esc(b.conf)}" title="Copy">${esc(b.conf)}</b></span>` : "";
  const money_ = cost ? `<span>Cost <b>${money(cost)}</b>${b.paidBy ? " · paid by " + esc(nameOf(b.paidBy)) : ""}${b.planned ? " · estimate" : ""}</span>` : "";
  let body = "";
  if (k.group === "transport" || k.group === "car") {
    const plus = b.arrDate && b.depDate && b.arrDate !== b.depDate ? ` (+${daysBetween(b.depDate, b.arrDate)})` : "";
    const via = (b.stops || []).filter(s => (s.at || "").trim());
    const wait = via.reduce((a, s) => a + parseDur(s.dur), 0);
    body = `<div class="bk-route"><div class="end"><b>${esc(b.from || "—")}</b><span>${esc(fmtD(b.depDate, { weekday: "short", month: "short", day: "numeric" }))} ${esc(b.depTime || "")}</span></div>
      <div class="mid">${via.length ? `via ${via.map(s => esc(s.at) + (parseDur(s.dur) ? " " + fmtMin(parseDur(s.dur)) : "")).join(", ")}` : (k.group === "car" ? "rental" : "nonstop")}</div>
      <div class="end r"><b>${esc(b.to || "—")}</b><span>${esc(fmtD(b.arrDate, { weekday: "short", month: "short", day: "numeric" }))} ${esc(b.arrTime || "")}${plus}</span></div></div>
      <div class="bk-facts">${b.num ? `<span>${k.group === "car" ? "Company" : "Number"} <b>${esc(b.num)}</b></span>` : ""}${b.seats ? `<span>Seats <b>${esc(b.seats)}</b></span>` : ""}${wait ? `<span>Layovers <b>${fmtMin(wait)}</b></span>` : ""}${conf}${money_}</div>`;
  } else if (k.group === "lodging") {
    const nights = validIso(b.checkIn) && validIso(b.checkOut) ? daysBetween(b.checkIn, b.checkOut) : 0;
    body = `<div class="bk-route"><div class="end"><b style="font-size:15px">${esc(fmtD(b.checkIn, { weekday: "short", month: "short", day: "numeric" }) || "—")}</b><span>Check in ${esc(b.checkInTime || "")}</span></div><div class="mid">${nights ? nights + " night" + (nights === 1 ? "" : "s") : ""}</div><div class="end r"><b style="font-size:15px">${esc(fmtD(b.checkOut, { weekday: "short", month: "short", day: "numeric" }) || "—")}</b><span>Check out ${esc(b.checkOutTime || "")}</span></div></div>
      <div class="bk-facts">${b.addr ? `<span>${esc(b.addr)}</span>` : ""}${conf}${money_}</div>`;
  } else {
    body = `<div class="bk-facts"><span><b>${esc(fmtD(b.date, { weekday: "short", month: "short", day: "numeric" }) || "No date")}</b>${b.time ? " · " + esc(b.time) : ""}</span>${b.addr ? `<span>${esc(b.addr)}</span>` : ""}${conf}${money_}</div>`;
  }
  return `<article class="bk" style="--bc:${k.col}"><div class="bk-top"><div><div class="bk-kind">${esc(k.label)}</div><div class="bk-title">${esc(b.title || k.label)}</div></div><button class="btn ghost small" type="button" data-bedit="${id}">Edit</button></div>${body}${b.notes ? `<p class="hint">${esc(b.notes)}</p>` : ""}</article>`;
}
function bookingModal(id, kind) {
  const b = id ? T.bookings[id] : { kind, split: members() };
  let k = b.kind || "flight", stops = (b.stops || []).map(s => ({ ...s })), loc = b.lat != null ? { lat: b.lat, lon: b.lon } : null, armed = false;
  const fld = (key, label, type = "text", ph = "", extra = "") => `<label class="field" for="bm-${key}">${label}<input id="bm-${key}" data-k="${key}" type="${type}" value="${esc(b[key] ?? "")}" placeholder="${esc(ph)}" ${extra}></label>`;
  openModal(`<div class="row between"><h2>${id ? "Edit booking" : "Add a booking"}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <label class="field" for="bm-kind">Kind<select id="bm-kind">${Object.entries(KINDS).map(([key, x]) => `<option value="${key}" ${key === k ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
    ${fld("title", "Title", "text", "e.g. Honolulu → London, Hotel Arts, Dinner at Dishoom", 'maxlength="80"')}
    <div data-g="transport car" class="grid2">${fld("from", "From", "text", "HNL or a station", 'maxlength="50"')}${fld("to", "To", "text", "LHR", 'maxlength="50"')}</div>
    <div data-g="transport car" class="grid2">${fld("depDate", "Departs", "date")}${fld("depTime", "Time", "time")}</div>
    <div data-g="transport car" class="grid2">${fld("arrDate", "Arrives", "date")}${fld("arrTime", "Time", "time")}</div>
    <div data-g="transport car" class="grid2">${fld("num", "Flight / train number or company", "text", "AS 841", 'maxlength="30"')}${fld("seats", "Seats", "text", "32A, 32B", 'maxlength="30"')}</div>
    <div data-g="transport" class="field"><span>Layovers</span><div class="stops-ed" id="bmStops"></div><button class="linkbtn" type="button" id="bmAddStop" style="justify-self:start">+ Add a layover</button></div>
    <div data-g="lodging" class="grid2">${fld("checkIn", "Check in", "date")}${fld("checkInTime", "Time", "time")}</div>
    <div data-g="lodging" class="grid2">${fld("checkOut", "Check out", "date")}${fld("checkOutTime", "Time", "time")}</div>
    <div data-g="event" class="grid2">${fld("date", "Date", "date")}${fld("time", "Time", "time")}</div>
    <div data-g="lodging event" class="field"><label for="bm-addr">Address or place</label><div class="suggest-wrap"><input id="bm-addr" data-k="addr" value="${esc(b.addr || "")}" autocomplete="off" placeholder="Search to pin it on the map" role="combobox" aria-expanded="false" aria-controls="bmAddrL"><ul class="suggest" id="bmAddrL" role="listbox" hidden></ul></div></div>
    ${fld("conf", "Confirmation number", "text", "ABC123", 'maxlength="40"')}
    <div class="grid3">${fld("cost", "Total cost (" + esc(T.trip.currency || "USD") + ")", "number", "0", 'min="0" step="0.01"')}
      <label class="field" for="bm-paidBy">Paid by<select id="bm-paidBy" data-k="paidBy"><option value="">—</option>${members().map(e => `<option value="${esc(e)}" ${b.paidBy === e ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select></label>
      <label class="field" style="align-self:end;flex-direction:row;display:flex;gap:6px;color:var(--ink)"><input type="checkbox" id="bm-planned" ${b.planned ? "checked" : ""}> Just an estimate</label></div>
    <div class="field"><span>Split between</span><div class="splitbox">${members().map(e => `<label><input type="checkbox" data-split value="${esc(e)}" ${(b.split || members()).includes(e) ? "checked" : ""}> ${esc(nameOf(e))}</label>`).join("")}</div></div>
    <label class="field" for="bm-notes">Notes<textarea id="bm-notes" data-k="notes" rows="2" maxlength="600">${esc(b.notes || "")}</textarea></label>
    <div class="row between">${id ? `<button class="btn danger" type="button" id="bmDel">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="bmSave">Save</button></div></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    const groupShow = () => { const g = (KINDS[k] || KINDS.other).group; $$("[data-g]", m).forEach(el => el.hidden = !el.dataset.g.split(" ").includes(g)); };
    const paintStops = () => { $("#bmStops").innerHTML = stops.map((s, i) => `<div class="stop-ed"><input class="input" data-si="${i}" data-sf="at" value="${esc(s.at || "")}" placeholder="Airport / station" aria-label="Layover place"><input class="input" data-si="${i}" data-sf="dur" value="${esc(s.dur || "")}" placeholder="2h 30m" aria-label="Layover length"><button class="iconbtn del" type="button" data-rs="${i}" aria-label="Remove layover">×</button></div>`).join(""); };
    groupShow(); paintStops();
    $("#bm-kind").onchange = e => { k = e.target.value; groupShow(); };
    $("#bmAddStop").onclick = () => { stops.push({ at: "", dur: "" }); paintStops(); $(`[data-si="${stops.length - 1}"]`, m)?.focus(); };
    $("#bmStops").addEventListener("input", e => { const i = e.target.dataset.si; if (i != null) stops[+i][e.target.dataset.sf] = e.target.value.slice(0, 50); });
    $("#bmStops").addEventListener("click", e => { const r = e.target.closest("[data-rs]"); if (r) { stops.splice(+r.dataset.rs, 1); paintStops(); } });
    $("#bm-depDate").addEventListener("change", e => { if (!$("#bm-arrDate").value) $("#bm-arrDate").value = e.target.value; });
    attachSuggest($("#bm-addr"), $("#bmAddrL"), { near: () => nearPoint(null), onPick: x => { loc = { lat: x.lat, lon: x.lon }; $("#bm-addr").value = [x.name, x.addr, x.city].filter(Boolean).join(", "); if (!$("#bm-title").value) $("#bm-title").value = x.name; } });
    $("#bm-addr").addEventListener("input", () => { loc = null; });
    if (id) $("#bmDel").onclick = () => { if (!armed) { armed = true; $("#bmDel").textContent = "Tap again to delete"; return; } delete T.bookings[id]; remove(tp("bookings/" + id)); closeModal(); renderTrip(); renderMap(); };
    $("#bmSave").onclick = () => {
      const out = { kind: k };
      $$("[data-k]", m).forEach(el => { if (!el.closest("[data-g]") || !el.closest("[data-g]").hidden) out[el.dataset.k] = el.value.trim(); });
      out.cost = num(out.cost); out.planned = $("#bm-planned").checked; out.split = $$("[data-split]", m).filter(x => x.checked).map(x => x.value);
      out.stops = (KINDS[k] || KINDS.other).group === "transport" ? stops.filter(s => (s.at || "").trim()) : [];
      out.lat = loc?.lat ?? null; out.lon = loc?.lon ?? null;
      if (!out.title) out.title = out.from && out.to ? `${out.from} → ${out.to}` : (KINDS[k] || KINDS.other).label;
      out.created = b.created || Date.now();
      const bid = id || uidGen(); T.bookings[bid] = out; save(tp("bookings/" + bid), out, 0);
      closeModal(); renderTrip(); renderMap();
    };
  });
}

// ================================================================ BUDGET
function spendItems() {
  const out = [];
  for (const [id, e] of Object.entries(T.expenses)) out.push({ id, src: "expense", ...e, amount: num(e.amount) });
  for (const [id, b] of Object.entries(T.bookings)) if (num(b.cost)) {
    const k = KINDS[b.kind] || KINDS.other;
    out.push({ id, src: "booking", desc: b.title || k.label, amount: num(b.cost), category: k.cat, date: b.depDate || b.checkIn || b.date || "", paidBy: b.paidBy || "", split: b.split || [], planned: !!b.planned, kind: "expense" });
  }
  return out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || (b.created || 0) - (a.created || 0));
}
function balances() {
  const bal = Object.fromEntries(members().map(e => [e, 0]));
  for (const x of spendItems()) {
    if (x.planned) continue;
    if (x.kind === "payment") { if (x.paidBy in bal) bal[x.paidBy] += x.amount; if (x.to in bal) bal[x.to] -= x.amount; continue; }
    if (!x.paidBy || !(x.paidBy in bal)) continue;
    const who = (x.split && x.split.length ? x.split : members()).filter(e => e in bal); if (!who.length) continue;
    bal[x.paidBy] += x.amount; for (const e of who) bal[e] -= x.amount / who.length;
  }
  // who pays whom, fewest transfers
  const debt = Object.entries(bal).map(([e, v]) => [e, Math.round(v * 100) / 100]);
  const cred = debt.filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]), owe = debt.filter(([, v]) => v < -0.005).map(([e, v]) => [e, -v]).sort((a, b) => b[1] - a[1]);
  const transfers = []; let i = 0, j = 0;
  while (i < owe.length && j < cred.length) {
    const amt = Math.min(owe[i][1], cred[j][1]); transfers.push({ from: owe[i][0], to: cred[j][0], amt: Math.round(amt * 100) / 100 });
    owe[i][1] -= amt; cred[j][1] -= amt; if (owe[i][1] < 0.01) i++; if (cred[j][1] < 0.01) j++;
  }
  return { bal, transfers };
}
function viewBudget(v) {
  const items = spendItems(), real = items.filter(x => !x.planned && x.kind !== "payment"), plan = items.filter(x => x.planned);
  const spent = real.reduce((a, x) => a + x.amount, 0), planned = plan.reduce((a, x) => a + x.amount, 0), budget = num(T.trip.budget);
  const byCat = {}; for (const x of [...real, ...plan]) { const c = x.category || "Other"; byCat[c] = byCat[c] || { s: 0, p: 0 }; byCat[c][x.planned ? "p" : "s"] += x.amount; }
  const maxC = Math.max(1, ...Object.values(byCat).map(c => c.s + c.p));
  const { bal, transfers } = balances(), n = members().length;
  v.innerHTML = `<div class="row between"><h2>Budget</h2><button class="btn accent small" type="button" id="addExp">+ Add expense</button></div>
    <div class="stats">
      <div class="stat"><span class="k">Budget</span><span class="v">${budget ? money(budget) : "—"}</span><span class="s"><button class="linkbtn" type="button" id="setBudget">${budget ? "Change" : "Set a budget"}</button></span></div>
      <div class="stat"><span class="k">Spent</span><span class="v">${money(spent)}</span><span class="s">${n > 1 ? money(spent / n) + " each on average" : ""}</span></div>
      <div class="stat"><span class="k">Still planned</span><span class="v">${money(planned)}</span><span class="s">estimates</span></div>
      <div class="stat"><span class="k">Left</span><span class="v" style="color:${budget && budget - spent - planned < 0 ? "var(--warn)" : "inherit"}">${budget ? money(budget - spent - planned) : "—"}</span><span class="s">${budget ? Math.round((spent + planned) / budget * 100) + "% used or planned" : ""}</span></div>
    </div>
    ${budget ? `<div class="meter ${spent + planned > budget ? "over" : ""}"><i style="width:${Math.min(100, (spent + planned) / budget * 100)}%"></i></div>` : ""}
    ${n > 1 ? `<div class="card" style="display:grid;gap:10px"><h3>Who owes whom</h3>
      ${transfers.length ? `<div class="owes">${transfers.map(t => `<div class="owe">${avatar(t.from)}<span><b>${esc(nameOf(t.from))}</b> owes <b>${esc(nameOf(t.to))}</b></span><span class="amt">${money(t.amt, { cents: true })}</span><button class="btn ghost small" type="button" data-settle="${esc(t.from)}|${esc(t.to)}|${t.amt}">Settle up</button></div>`).join("")}</div>` : `<p class="hint">Everyone's even.</p>`}
      <div style="display:grid;gap:4px">${members().map(e => `<div class="bal">${avatar(e)}<span>${esc(nameOf(e))}</span><b style="color:${bal[e] > 0.005 ? "var(--leaf)" : bal[e] < -0.005 ? "var(--accent)" : "var(--muted)"}">${bal[e] > 0.005 ? "gets back " : bal[e] < -0.005 ? "owes " : ""}${money(Math.abs(bal[e]), { cents: true })}</b></div>`).join("")}</div></div>` : `<p class="hint">Invite people with <b>Share</b> to split costs between you.</p>`}
    ${Object.keys(byCat).length ? `<div class="card" style="display:grid;gap:10px"><h3>By category</h3><div class="bars">${CATS.filter(c => byCat[c]).map(c => `<div class="bar"><span>${c}</span><span class="track"><i style="width:${byCat[c].s / maxC * 100}%;background:var(--accent)"></i><i style="width:${byCat[c].p / maxC * 100}%;background:var(--accent-soft)"></i></span><b>${money(byCat[c].s + byCat[c].p)}</b></div>`).join("")}</div><p class="hint"><span style="color:var(--accent)">■</span> spent · <span style="color:var(--accent-soft)">■</span> planned</p></div>` : ""}
    <div class="card"><h3 style="margin-bottom:6px">All costs</h3>${items.length ? `<table class="tbl"><thead><tr><th>Date</th><th>What</th><th>Paid by</th><th class="num">Amount</th></tr></thead><tbody>
      ${items.map(x => `<tr class="${x.planned ? "planned" : ""}" data-src="${x.src}" data-id="${x.id}" style="cursor:pointer"><td>${esc(fmtD(x.date) || "—")}</td><td>${x.kind === "payment" ? `<b>${esc(nameOf(x.paidBy))}</b> paid <b>${esc(nameOf(x.to))}</b>` : esc(x.desc || "")}<br><span class="hint" style="font-size:11.5px">${x.kind === "payment" ? "Settle up" : esc(x.category || "")}${x.src === "booking" ? " · booking" : ""}${x.planned ? " · estimate" : ""}</span></td><td>${x.paidBy ? esc(nameOf(x.paidBy)) : "—"}</td><td class="num"><b>${money(x.amount, { cents: x.amount % 1 !== 0 })}</b></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No costs yet. Add expenses as you go, or add costs to your bookings.</div>`}</div>`;
  $("#addExp").onclick = () => expenseModal(null);
  $("#setBudget").onclick = () => { location.hash = `#/t/${cur.id}/overview`; setTimeout(() => $("#ovBudget")?.focus(), 80); };
  v.addEventListener("click", e => {
    const s = e.target.closest("[data-settle]");
    if (s) { const [from, to, amt] = s.dataset.settle.split("|"); const id = uidGen(); T.expenses[id] = { kind: "payment", paidBy: from, to, amount: +amt, desc: "Settle up", category: "Other", date: isoOf(new Date()), created: Date.now(), split: [] }; save(tp("expenses/" + id), T.expenses[id], 0); renderTrip(); toast(`Recorded: ${esc(nameOf(from))} paid ${esc(nameOf(to))} ${money(+amt, { cents: true })}.`); return; }
    const r = e.target.closest("tr[data-src]"); if (!r) return;
    if (r.dataset.src === "booking") bookingModal(r.dataset.id); else expenseModal(r.dataset.id);
  });
}
function expenseModal(id) {
  const x = id ? T.expenses[id] : { paidBy: ME.email, split: members(), date: isoOf(new Date()), category: "Food & drink" };
  let armed = false;
  if (x.kind === "payment") {
    openModal(`<div class="row between"><h2>Settle-up payment</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div><p>${esc(nameOf(x.paidBy))} paid ${esc(nameOf(x.to))} <b>${money(num(x.amount), { cents: true })}</b> on ${esc(fmtD(x.date))}.</p><div class="row between"><button class="btn danger" type="button" id="exDel">Delete</button><button class="btn ghost" type="button" data-close>Close</button></div>`, m => {
      $$("[data-close]", m).forEach(b => b.onclick = closeModal);
      $("#exDel").onclick = () => { if (!armed) { armed = true; $("#exDel").textContent = "Tap again to delete"; return; } delete T.expenses[id]; remove(tp("expenses/" + id)); closeModal(); renderTrip(); };
    });
    return;
  }
  openModal(`<div class="row between"><h2>${id ? "Edit expense" : "Add an expense"}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <div class="grid2"><label class="field" for="exAmt">Amount (${esc(T.trip.currency || "USD")})<input id="exAmt" type="number" min="0" step="0.01" value="${esc(x.amount ?? "")}" placeholder="0.00"></label>
      <label class="field" for="exDate">Date<input id="exDate" type="date" value="${esc(x.date || "")}"></label></div>
    <label class="field" for="exDesc">What for<input id="exDesc" maxlength="80" value="${esc(x.desc || "")}" placeholder="Dinner, museum tickets, groceries…"></label>
    <div class="grid2"><label class="field" for="exCat">Category<select id="exCat">${CATS.map(c => `<option ${c === x.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field" for="exPaid">Paid by<select id="exPaid">${members().map(e => `<option value="${esc(e)}" ${e === x.paidBy ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select></label></div>
    <div class="field"><span>Split between</span><div class="splitbox">${members().map(e => `<label><input type="checkbox" data-split value="${esc(e)}" ${(x.split && x.split.length ? x.split : members()).includes(e) ? "checked" : ""}> ${esc(nameOf(e))}</label>`).join("")}</div></div>
    <label class="row" style="gap:8px;font-weight:600"><input type="checkbox" id="exPlanned" ${x.planned ? "checked" : ""}> Just an estimate (not spent yet)</label>
    <p class="hint" id="exMsg"></p>
    <div class="row between">${id ? `<button class="btn danger" type="button" id="exDel">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="exSave">Save</button></div></div>`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    if (id) $("#exDel").onclick = () => { if (!armed) { armed = true; $("#exDel").textContent = "Tap again to delete"; return; } delete T.expenses[id]; remove(tp("expenses/" + id)); closeModal(); renderTrip(); };
    $("#exSave").onclick = () => {
      const amount = num($("#exAmt").value); if (!amount) { $("#exMsg").textContent = "Enter an amount."; $("#exAmt").focus(); return; }
      const split = $$("[data-split]", m).filter(c => c.checked).map(c => c.value); if (!split.length) { $("#exMsg").textContent = "Pick at least one person to split with."; return; }
      const eid = id || uidGen();
      T.expenses[eid] = { kind: "expense", amount, date: $("#exDate").value, desc: $("#exDesc").value.trim() || $("#exCat").value, category: $("#exCat").value, paidBy: $("#exPaid").value, split, planned: $("#exPlanned").checked, created: x.created || Date.now() };
      save(tp("expenses/" + eid), T.expenses[eid], 0); closeModal(); renderTrip();
    };
  });
}

// ================================================================ OVERVIEW
function viewOverview(v) {
  const t = T.trip, days = tripDays(), all = placeList(), sched = all.filter(p => days.includes(p.day)).length;
  const items = Object.entries(T.checklist).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const spent = spendItems().filter(x => !x.planned && x.kind !== "payment").reduce((a, x) => a + x.amount, 0);
  v.innerHTML = `<div class="stats">
      <div class="stat"><span class="k">${validIso(t.start) && isoOf(new Date()) < t.start ? "Days to go" : "Status"}</span><span class="v">${validIso(t.start) && isoOf(new Date()) < t.start ? daysBetween(isoOf(new Date()), t.start).toLocaleString("en-US") : esc(tripWhen(t))}</span><span class="s">${days.length ? days.length + " days" : "no dates"}</span></div>
      <div class="stat"><span class="k">Places</span><span class="v">${all.length}</span><span class="s">${sched} scheduled</span></div>
      <div class="stat"><span class="k">Bookings</span><span class="v">${Object.keys(T.bookings).length}</span><span class="s">flights, stays & more</span></div>
      <div class="stat"><span class="k">Spent</span><span class="v">${money(spent)}</span><span class="s">${num(t.budget) ? "of " + money(num(t.budget)) : "no budget set"}</span></div></div>
    <div class="card" style="display:grid;gap:12px"><h3>Trip details</h3>
      <label class="field" for="ovName">Name<input id="ovName" maxlength="60" value="${esc(t.name || "")}" data-live></label>
      <div class="field"><label for="ovDest">Destination</label><div class="suggest-wrap"><input id="ovDest" autocomplete="off" value="${esc(t.dest?.name || "")}" placeholder="Search a city, region or country" role="combobox" aria-expanded="false" aria-controls="ovDestL" data-live><ul class="suggest" id="ovDestL" role="listbox" hidden></ul></div></div>
      <div class="grid2"><label class="field" for="ovStart">Start<input id="ovStart" type="date" value="${esc(t.start || "")}"></label><label class="field" for="ovEnd">End<input id="ovEnd" type="date" value="${esc(t.end || "")}"></label></div>
      <div class="grid2"><label class="field" for="ovBudget">Total budget<input id="ovBudget" type="number" min="0" step="50" value="${num(t.budget) || ""}" placeholder="0" data-live></label>
        <label class="field" for="ovCur">Currency<select id="ovCur">${CURRENCIES.map(c => `<option ${c === (t.currency || "USD") ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
      <div class="row"><button class="btn ghost small" type="button" id="ovCover">New cover photo</button><label class="btn ghost small file-btn">Upload cover<input type="file" id="ovCoverFile" accept="image/*"></label>${t.coverCredit ? `<span class="hint">${esc(t.coverCredit)}</span>` : ""}</div></div>
    <div class="card" style="display:grid;gap:10px"><div class="row between"><h3>People</h3><button class="btn ghost small" type="button" id="ovInvite">Share & invite</button></div>
      ${members().map(e => `<div class="bal">${avatar(e)}<span><b>${esc(nameOf(e))}</b> <span class="hint" style="display:inline">${esc(e)}</span></span><span class="hint">${t.ownerEmail === e ? "Planner" : ""}</span></div>`).join("")}</div>
    <div class="card" style="display:grid;gap:8px"><h3>Notes</h3><textarea class="input" id="ovNotes" rows="4" maxlength="5000" placeholder="Ideas, links, packing thoughts, anything…" data-live>${esc(t.notes || "")}</textarea></div>
    <div class="card" style="display:grid;gap:8px"><div class="row between"><h3>To-do before we go</h3><span class="hint">${items.filter(([, c]) => c.done).length} of ${items.length} done</span></div>
      <ul class="check">${items.map(([id, c]) => `<li class="${c.done ? "done" : ""}" data-id="${id}"><input type="checkbox" ${c.done ? "checked" : ""} aria-label="Done"><input type="text" id="ck-${id}" value="${esc(c.text || "")}" maxlength="140" data-live aria-label="To-do"><button class="iconbtn del" type="button" data-rm aria-label="Delete">×</button></li>`).join("")}</ul>
      <form id="ckAdd" class="row" style="gap:6px"><input class="input grow" id="ckNew" placeholder="Add a to-do, e.g. Renew passport" maxlength="140" data-live><button class="btn small" type="submit">Add</button></form></div>
    <div class="card row between"><span class="hint">${isOwner() ? "Deleting removes this trip for everyone." : "Leaving removes you from this trip. You can be invited back."}</span><button class="btn danger" type="button" id="ovDanger">${isOwner() ? "Delete trip" : "Leave trip"}</button></div>`;
  const tripRef = doc(fs, "trips/" + cur.id);
  const upd = debounce(patch => updateDoc(tripRef, patch).catch(fail), 600);
  $("#ovName").oninput = e => { T.trip.name = e.target.value; upd({ name: e.target.value.slice(0, 60) }); $("#crumb").textContent = e.target.value; };
  $("#ovBudget").oninput = e => { T.trip.budget = num(e.target.value); upd({ budget: num(e.target.value) }); };
  $("#ovNotes").oninput = e => { T.trip.notes = e.target.value; upd({ notes: e.target.value.slice(0, 5000) }); };
  $("#ovCur").onchange = e => { updateDoc(tripRef, { currency: e.target.value }).catch(fail); };
  const dates = () => { let s = $("#ovStart").value, en = $("#ovEnd").value; if (validIso(s) && (!validIso(en) || en < s)) { en = s; $("#ovEnd").value = s; } if (validIso(s) && daysBetween(s, en) > 59) { toast("Trips can be up to 60 days."); return; } updateDoc(tripRef, { start: s, end: en }).catch(fail); };
  $("#ovStart").onchange = dates; $("#ovEnd").onchange = dates;
  attachSuggest($("#ovDest"), $("#ovDestL"), { onPick: x => { $("#ovDest").value = x.name; updateDoc(tripRef, { dest: { name: x.name, country: x.country, lat: x.lat, lon: x.lon } }).catch(fail); } });
  $("#ovCover").onclick = async () => {
    const d = t.dest || { name: t.name }; $("#ovCover").disabled = true; $("#ovCover").textContent = "Looking…";
    const cands = await photoCandidates({ name: d.name, city: d.name, lat: d.lat, lon: d.lon }, "all").catch(() => []);
    const curIdx = cands.findIndex(c => c.src === t.coverSrc || c.url === t.cover), pick = cands[(curIdx + 1) % Math.max(1, cands.length)];
    if (!pick) { toast("No free photos found. Upload one instead."); $("#ovCover").disabled = false; $("#ovCover").textContent = "New cover photo"; return; }
    try { const ph = await materialize(pick); await updateDoc(tripRef, { cover: ph.photo || ph.photoUrl, coverCredit: ph.photoCredit || "", coverSrc: pick.src || pick.url || "" }); trackUnsplash(ph.dl); } catch { toast("Couldn't load that photo."); }
  };
  $("#ovCoverFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const d = await shrink(f, 1400, 450000); await updateDoc(tripRef, { cover: d, coverCredit: "", coverSrc: "" }); } catch (err) { toast(esc(err.message)); } };
  $("#ovInvite").onclick = inviteModal;
  const list = $(".check");
  list.addEventListener("change", e => { const li = e.target.closest("li"); if (e.target.type === "checkbox") { const id = li.dataset.id; T.checklist[id] = { ...T.checklist[id], done: e.target.checked }; save(tp("checklist/" + id), T.checklist[id], 0); li.classList.toggle("done", e.target.checked); } });
  list.addEventListener("input", e => { const li = e.target.closest("li"); if (e.target.type === "text") { const id = li.dataset.id; T.checklist[id] = { ...T.checklist[id], text: e.target.value }; save(tp("checklist/" + id), T.checklist[id], 600); } });
  list.addEventListener("click", e => { if (e.target.closest("[data-rm]")) { const id = e.target.closest("li").dataset.id; delete T.checklist[id]; remove(tp("checklist/" + id)); renderTrip(); } });
  $("#ckAdd").onsubmit = e => { e.preventDefault(); const text = $("#ckNew").value.trim(); if (!text) return; const id = uidGen(); T.checklist[id] = { text, done: false, order: Date.now() }; save(tp("checklist/" + id), T.checklist[id], 0); $("#ckNew").value = ""; renderTrip(); $("#ckNew")?.focus(); };
  let armed = false;
  $("#ovDanger").onclick = async () => {
    if (!armed) { armed = true; $("#ovDanger").textContent = isOwner() ? "Tap again to delete for everyone" : "Tap again to leave"; return; }
    const tid = cur.id;
    if (isOwner()) {
      for (const sub of ["places", "days", "bookings", "expenses", "checklist", "photos"]) { const s = await getDocs(collection(fs, `trips/${tid}/${sub}`)).catch(() => null); s?.docs.forEach(d => deleteDoc(d.ref).catch(() => {})); }
      await deleteDoc(doc(fs, "trips/" + tid)).catch(fail);
    } else await updateDoc(doc(fs, "trips/" + tid), { members: members().filter(e => e !== ME.email) }).catch(fail);
    location.hash = "#/";
  };
}

// ================================================================ SHARE / INVITE
function inviteModal() {
  const link = location.href.split("#")[0] + "#/t/" + cur.id;
  openModal(`<div class="row between"><h2>Share this trip</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">People you add can see and edit everything in this trip. They sign in with the Google account for that email.</p>
    <div style="display:grid;gap:6px" id="invList">${members().map(e => `<div class="bal">${avatar(e)}<span><b>${esc(nameOf(e))}</b> <span class="hint" style="display:inline">${esc(e)}</span></span>${isOwner() && e !== T.trip.ownerEmail ? `<button class="iconbtn del" type="button" data-rmm="${esc(e)}" aria-label="Remove ${esc(e)}">×</button>` : `<span class="hint">${e === T.trip.ownerEmail ? "Planner" : ""}</span>`}</div>`).join("")}</div>
    ${isOwner() ? `<form id="invForm" class="row" style="gap:6px"><input class="input grow" id="invEmail" type="email" placeholder="friend@gmail.com" required><button class="btn accent" type="submit">Invite</button></form>` : `<p class="hint">Only the planner (${esc(T.trip.ownerEmail || "")}) can add or remove people.</p>`}
    <p class="hint" id="invMsg"></p>
    <div class="field"><span>Link to send them</span><div class="row" style="gap:6px"><input class="input grow" readonly value="${esc(link)}" id="invLink" aria-label="Trip link"><button class="btn ghost" type="button" id="invCopy">Copy</button></div></div>`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    $("#invCopy").onclick = () => navigator.clipboard?.writeText(link).then(() => { $("#invMsg").textContent = "Link copied. Send it to them along with the invite."; }, () => { $("#invLink").select(); });
    const ref = doc(fs, "trips/" + cur.id);
    if ($("#invForm")) $("#invForm").onsubmit = async e => {
      e.preventDefault(); const em = $("#invEmail").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { $("#invMsg").textContent = "That doesn't look like an email address."; return; }
      if (members().includes(em)) { $("#invMsg").textContent = "They're already on this trip."; return; }
      try { await updateDoc(ref, { members: [...members(), em] }); closeModal(); toast(`Invited ${esc(em)}. Send them the link so they can sign in.`, { label: "Copy link", run: () => navigator.clipboard?.writeText(link) }); }
      catch (err) { $("#invMsg").textContent = err.code === "permission-denied" ? "Only the planner can invite people." : "Couldn't save. Check your connection."; }
    };
    $("#invList").addEventListener("click", async e => { const r = e.target.closest("[data-rmm]"); if (!r) return; await updateDoc(ref, { members: members().filter(x => x !== r.dataset.rmm) }).catch(fail); closeModal(); });
  });
}

// ================================================================ MAP (Leaflet + OpenStreetMap/CARTO tiles)
let map = null, tiles = null, layer = null, mapFocus = null, fitPending = true, lastFitKey = "";
function initMap() {
  if (!window.L) { $("#map").innerHTML = `<div class="empty" style="margin:20px">The map couldn't load. Check your connection.</div>`; return; }
  map = L.map("map", { zoomControl: true, worldCopyJump: true, attributionControl: true }).setView([30, 0], 2);
  layer = L.layerGroup().addTo(map);
  setTiles(); fitPending = true;
}
function setTiles() {
  if (!map) return;
  const dark = document.documentElement.dataset.theme === "dark";
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "rastertiles/voyager"}/{z}/{x}/{y}{r}.png`, { subdomains: "abcd", maxZoom: 20, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' }).addTo(map);
}
function destroyMap() { if (map) { map.remove(); map = null; tiles = null; layer = null; } lastFitKey = ""; }
const icon = (html, cls = "", col = "var(--accent)", size = 26) => L.divIcon({ className: "", html: `<div class="mk ${cls}" style="--mc:${col}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
function popupFor(p) {
  const d = tripDays().includes(p.day) ? dayLabel(p.day) : "Not scheduled";
  return `<b>${esc(p.name)}</b><br><span style="color:var(--muted)">${esc(TYPE[p.type]?.label || "")}${p.city ? " · " + esc(p.city) : ""}</span><br>${esc(d)}${p.time ? " · " + esc(p.time) : ""}`;
}
function renderMap() {
  if (!map || !cur || !T.trip) return;
  layer.clearLayers();
  const pts = [], days = tripDays(), tab = cur.tab;
  const add = (lat, lon, ic, pop, id) => { const m = L.marker([lat, lon], { icon: ic, keyboard: true, title: "" }).addTo(layer); if (pop) m.bindPopup(pop); if (id) m.on("click", () => { if (tab === "places") flashPlace(id); else if (tab === "plan") document.querySelector(`.stop[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }); }); pts.push([lat, lon]); return m; };
  if (tab === "plan" || tab === "overview") {
    days.forEach((iso, i) => {
      if (mapFocus && mapFocus !== iso) return;
      const items = dayPlaces(iso).filter(hasPt); if (!items.length) return;
      const col = dayCol(i);
      L.polyline(items.map(p => [p.lat, p.lon]), { color: getComputedStyle(document.documentElement).getPropertyValue(DAYCOLS[i % DAYCOLS.length]).trim() || "#D9483B", weight: 3, opacity: .8, dashArray: "6 6" }).addTo(layer);
      items.forEach((p, k) => add(p.lat, p.lon, icon(k + 1, "", col), popupFor(p), p.id));
    });
    if (!mapFocus) placeList().filter(p => hasPt(p) && !days.includes(p.day)).forEach(p => add(p.lat, p.lon, icon("", "dot", "var(--muted)", 16), popupFor(p), p.id));
    Object.values(T.bookings).forEach(b => { if (b.kind === "lodging" && b.lat != null && (!mapFocus || (b.checkIn <= mapFocus && mapFocus < b.checkOut))) add(b.lat, b.lon, icon("⌂", "home", "var(--ink)"), `<b>${esc(b.title || "Stay")}</b><br>${esc(fmtD(b.checkIn))} – ${esc(fmtD(b.checkOut))}`); });
  } else if (tab === "places") {
    placeList().filter(hasPt).filter(p => (!PF.type || p.type === PF.type) && (!PF.city || p.city === PF.city)).forEach(p => add(p.lat, p.lon, icon("", "dot", TYPE[p.type].col, 16), popupFor(p), p.id));
  } else if (tab === "bookings") {
    Object.values(T.bookings).forEach(b => { if (b.lat != null) add(b.lat, b.lon, icon(b.kind === "lodging" ? "⌂" : "★", "home", (KINDS[b.kind] || KINDS.other).col), `<b>${esc(b.title || "")}</b>`); });
    placeList().filter(hasPt).forEach(p => add(p.lat, p.lon, icon("", "dot", "var(--muted)", 12), popupFor(p), p.id));
  } else {
    placeList().filter(hasPt).forEach(p => add(p.lat, p.lon, icon("", "dot", TYPE[p.type].col, 14), popupFor(p), p.id));
  }
  const key = tab + "|" + (mapFocus || "") + "|" + pts.length;
  if (fitPending || key !== lastFitKey) {
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15, animate: !reduceMotion() });
    else if (T.trip.dest && hasPt(T.trip.dest)) map.setView([T.trip.dest.lat, T.trip.dest.lon], 6);
    fitPending = false; lastFitKey = key;
  }
  setTimeout(() => map && map.invalidateSize(), 50);
}
function mapFocusPlace(id) {
  const p = T.places[id]; if (!map || !hasPt(p)) return;
  if (innerWidth <= 960) { document.body.classList.add("show-map"); $("#mapToggle").textContent = "List"; map.invalidateSize(); }
  map.setView([p.lat, p.lon], 16, { animate: !reduceMotion() });
  layer.eachLayer(l => { if (l.getLatLng && Math.abs(l.getLatLng().lat - p.lat) < 1e-9 && Math.abs(l.getLatLng().lng - p.lon) < 1e-9) l.openPopup?.(); });
}

// ================================================================ IMPORT EUROPE 2029
const EU_CITIES = { london: ["London", "United Kingdom", 51.5, -0.13], edinburgh: ["Edinburgh", "United Kingdom", 55.95, -3.19], dublin: ["Dublin", "Ireland", 53.35, -6.26], paris: ["Paris", "France", 48.86, 2.35], amsterdam: ["Amsterdam", "Netherlands", 52.37, 4.9], bruges: ["Bruges", "Belgium", 51.21, 3.22], copenhagen: ["Copenhagen", "Denmark", 55.68, 12.57], oslo: ["Oslo", "Norway", 59.91, 10.75], stockholm: ["Stockholm", "Sweden", 59.33, 18.07], berlin: ["Berlin", "Germany", 52.52, 13.4], prague: ["Prague", "Czechia", 50.08, 14.44], munich: ["Munich", "Germany", 48.14, 11.58], vienna: ["Vienna", "Austria", 48.21, 16.37], budapest: ["Budapest", "Hungary", 47.5, 19.04], interlaken: ["Interlaken", "Switzerland", 46.69, 7.86], nice: ["Nice", "France", 43.7, 7.27], venice: ["Venice", "Italy", 45.44, 12.33], florence: ["Florence", "Italy", 43.77, 11.25], rome: ["Rome", "Italy", 41.9, 12.5], amalfi: ["Amalfi Coast", "Italy", 40.63, 14.6], dubrovnik: ["Dubrovnik", "Croatia", 42.65, 18.09], athens: ["Athens", "Greece", 37.98, 23.73], santorini: ["Santorini", "Greece", 36.39, 25.46], barcelona: ["Barcelona", "Spain", 41.39, 2.17], madrid: ["Madrid", "Spain", 40.42, -3.7], seville: ["Seville", "Spain", 37.39, -5.98], lisbon: ["Lisbon", "Portugal", 38.72, -9.14], porto: ["Porto", "Portugal", 41.15, -8.61], helsinki: ["Helsinki", "Finland", 60.17, 24.94], monaco: ["Monaco", "Monaco", 43.74, 7.42], krakow: ["Kraków", "Poland", 50.06, 19.94], salzburg: ["Salzburg", "Austria", 47.8, 13.04] };
async function importEurope() {
  const btn = $("#importEu"); btn.disabled = true; btn.textContent = "Importing…";
  try {
    const get = async c => { const s = await getDocs(collection(fs, c)); const o = {}; s.docs.forEach(d => { o[d.id] = d.data(); }); return o; };
    const [settingsSnap, cities, custom, spots, costs, days, tasks, photos] = await Promise.all([getDoc(doc(fs, "planner/settings")), get("cities"), get("places"), get("spots"), get("expenses"), get("days"), get("tasks"), get("photos")]);
    const st = settingsSnap.exists() ? settingsSnap.data() : {};
    const start = validIso(st.start) ? st.start : "2029-06-01", len = Math.max(1, num(st.len) || 14), end = addDays(start, len - 1);
    const travelers = Math.max(1, String(st.names || "").split(",").map(s => s.trim()).filter(Boolean).length || 2);
    const dayIso = k => { const n = parseInt(String(k).slice(1)); return n >= 1 ? addDays(start, n - 1) : ""; };
    const tid = uidGen(), base = `trips/${tid}`;
    await setDoc(doc(fs, base), { name: "Europe 2029", dest: { name: "Europe", country: "", lat: 48.5, lon: 9 }, start, end, members: [ME.email], names: { [ekey(ME.email)]: ME.name }, owner: ME.uid, ownerEmail: ME.email,
      created: Date.now(), currency: "USD", budget: num(st.budget) * travelers, notes: "Imported from the Europe 2029 site.", cover: "", importedFrom: "europe2029" });
    const ops = [];
    const put = (path, data) => ops.push([path, data]);
    // route cities and custom pins → places (type City / town)
    const custOf = id => custom[id] && { name: custom[id].name, country: custom[id].country || "", lat: custom[id].lat, lon: custom[id].lon };
    Object.entries(cities).filter(([, c]) => c.picked).sort((a, b) => (a[1].order || 0) - (b[1].order || 0)).forEach(([id, c], i) => {
      const e = EU_CITIES[id] ? { name: EU_CITIES[id][0], country: EU_CITIES[id][1], lat: EU_CITIES[id][2], lon: EU_CITIES[id][3] } : custOf(id); if (!e) return;
      put(`${base}/places/city-${id}`, newPlaceFrom({ ...e, city: e.name, type: "city", link: gmapsUrl({ name: e.name, country: e.country }) }, { notes: `Route stop ${i + 1}${c.nights ? ` · ${c.nights} night${c.nights === 1 ? "" : "s"}` : ""}`, created: i }));
    });
    for (const [id, s] of Object.entries(spots)) {
      put(`${base}/places/${id}`, { ...newPlaceFrom({ name: s.name, type: TYPE[s.type] ? s.type : "other", city: s.city, country: s.country, lat: s.lat ?? null, lon: s.lon ?? null, link: s.link || "" }),
        notes: s.notes || "", day: s.day ? dayIso(s.day) : "", photo: s.photo || "", photoUrl: s.photoUrl || "", photoCredit: s.photoCredit || "", photoLink: s.photoLink || "", photoBy: s.photoBy || "", photoSrc: s.photoSrc || "", hearts: { [ekey(ME.email)]: ME.name }, created: s.created || Date.now() });
    }
    // costs → bookings (transport, stays) and expenses (the rest)
    for (const [id, x] of Object.entries(costs)) {
      const people = x.people === "" || x.people == null ? travelers : num(x.people), est = num(x.est) * people, paid = num(x.paid), cost = paid || est, planned = !paid;
      if (["Flights", "Trains", "Local transport"].includes(x.cat)) {
        put(`${base}/bookings/${id}`, { kind: x.cat === "Flights" ? "flight" : x.cat === "Trains" ? "train" : "bus", title: x.what || "", from: x.from || "", to: x.to || "", depDate: x.date || "", depTime: x.depTime || "", arrDate: x.arrDate || "", arrTime: x.arrTime || "",
          num: x.num || "", seats: x.seats || "", conf: x.conf || "", stops: (x.stops || []).filter(s => (s.at || "").trim()), cost, planned, paidBy: "", split: [], notes: x.notes || "", lat: null, lon: null, created: x.created || Date.now() });
      } else if (x.cat === "Lodging") {
        put(`${base}/bookings/${id}`, { kind: "lodging", title: x.what || "Stay", checkIn: x.date || "", checkOut: "", conf: x.conf || "", cost, planned, paidBy: "", split: [], notes: x.notes || "", addr: "", lat: null, lon: null, created: x.created || Date.now() });
      } else if (cost) {
        put(`${base}/expenses/${id}`, { kind: "expense", amount: cost, date: x.date || "", desc: x.what || x.cat || "Cost", category: CATS.includes(x.cat) ? x.cat : x.cat === "Food & drink" ? "Food & drink" : "Other", paidBy: ME.email, split: [ME.email], planned, created: x.created || Date.now() });
      }
    }
    // day notes
    for (const [k, d] of Object.entries(days)) {
      const iso = dayIso(k); if (!iso) continue;
      const cityName = d.city ? (EU_CITIES[d.city]?.[0] || custom[d.city]?.name || "") : "";
      const notes = [cityName && `In ${cityName}`, d.stay && `Staying: ${d.stay}`, d.plan].filter(Boolean).join("\n");
      if (notes) put(`${base}/days/${iso}`, { notes });
    }
    Object.entries(tasks).forEach(([id, t]) => { if (t.text) put(`${base}/checklist/${id}`, { text: t.text + (t.when ? ` (${t.when})` : ""), done: !!t.done, order: t.order || 0 }); });
    // write in batches (photos one at a time because they're big)
    for (let i = 0; i < ops.length; i += 200) { const b = writeBatch(fs); ops.slice(i, i + 200).forEach(([p, d]) => b.set(doc(fs, p), d)); await b.commit(); }
    for (const [id, ph] of Object.entries(photos)) { const iso = dayIso(ph.day); if (iso && ph.data) await setDoc(doc(fs, `${base}/photos/${id}`), { day: iso, data: ph.data, created: ph.created || Date.now() }).catch(() => {}); }
    const cover = Object.values(spots).find(s => s.photo)?.photo || "";
    if (cover) await updateDoc(doc(fs, base), { cover }).catch(() => {});
    else firstPhoto({ name: "Europe", city: "" }, "free").then(ph => ph && updateDoc(doc(fs, base), { cover: ph.photo, coverCredit: ph.photoCredit }).catch(() => {}));
    toast("Europe 2029 imported. Invite your friend from Share.");
    location.hash = `#/t/${tid}/plan`;
  } catch (e) { console.error(e); btn.disabled = false; btn.textContent = "Import Europe 2029"; toast(e.code === "permission-denied" ? "Couldn't read the Europe 2029 data with this account." : "The import didn't finish. Try again."); }
}

// ---------------------------------------------------------------- start
applyTheme();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
