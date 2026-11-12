// Wayfinder — a shared trip planner (GitHub Pages + Firebase). Many trips, invite people per trip.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut, reauthenticateWithPopup } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, setDoc, updateDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where, writeBatch, deleteField } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import * as CFG from "./config.js";

const app = initializeApp(CFG.firebaseConfig);
const auth = getAuth(app);
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const UNSPLASH_KEY = String(CFG.unsplashKey || "").trim();
const FLIGHT_KEY = String(CFG.flightStatusKey || "").trim();
const GKEY = String(CFG.googleMapsKey || "").trim();   // optional Google Maps Platform key: Google map, search and nearby places   // optional AeroDataBox key (RapidAPI) for live flight status

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
// Ways of getting around a day; times are estimates from straight-line distance
const MODES = {
  walk: { label: "Walking", verb: "walk", g: "walking", mins: d => d * 1.25 / 4.8 * 60 },
  transit: { label: "Bus & train", verb: "by transit", g: "transit", mins: d => d * 1.3 / 18 * 60 + 8 },
  drive: { label: "Driving", verb: "drive", g: "driving", mins: d => d * 1.35 / 32 * 60 + 4 },
  bike: { label: "Biking", verb: "bike", g: "bicycling", mins: d => d * 1.2 / 14 * 60 },
};
const MODE_IC = { walk: "🚶", transit: "🚆", drive: "🚗", bike: "🚲" };
// a day can be "auto": walk the short hops, transit for the rest
const AUTO_KM = 1.2;
const DAY_MODES = [...Object.entries(MODES).map(([k, m]) => [k, m.label]), ["auto", "Walk when close, transit otherwise"]];
// how you get to this stop: its own choice, else the day's
function legModeOf(iso, p, d) {
  if (p?.leg && MODES[p.leg]) return p.leg;
  const m = dayMode(iso); return m === "auto" ? (d <= AUTO_KM ? "walk" : "transit") : (MODES[m] ? m : "walk");
}
const routeMode = iso => { const m = dayMode(iso); return m === "auto" ? "transit" : (MODES[m] ? m : "walk"); };
function legMins(d, mode) { return Math.max(1, Math.round((MODES[mode] || MODES.walk).mins(d))); }
function legText(d, mode = "walk") {
  if (d < 0.05) return "Right next door";
  if (d > 150) return `${Math.round(d)} km · a long way, check trains or flights`;
  // a long walk is better done another way: suggest it
  const m = MODES[mode] || MODES.walk, t = legMins(d, mode);
  const hint = mode === "walk" && d > 3 ? ` · or ~${fmtMin(legMins(d, "transit"))} by transit` : "";
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} km · ${t >= 60 ? "~" : ""}${fmtMin(t)} ${m.verb}${hint}`;
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
// colors you can pick for a day (stored on the day as a hex value)
const DAYPAL = [["#D9483B", "Red"], ["#EF7A5A", "Coral"], ["#E08A1E", "Orange"], ["#C9A227", "Gold"], ["#8DB03A", "Lime"], ["#3B7A39", "Green"], ["#2E9E78", "Jade"], ["#107A74", "Teal"],
  ["#1F9BBF", "Aqua"], ["#4A90E2", "Sky"], ["#2461B5", "Blue"], ["#4F55C9", "Indigo"], ["#7646B3", "Violet"], ["#9B3FA0", "Plum"], ["#D24D8C", "Pink"], ["#BE3674", "Rose"], ["#8A5A3C", "Brown"], ["#5E6B78", "Slate"]];
const dayColor = (iso, i) => (/^#[0-9a-f]{6}$/i.test(T.days[iso]?.color || "") ? T.days[iso].color : dayCol(i));
const colVal = c => c.startsWith("var(") ? (getComputedStyle(document.documentElement).getPropertyValue(c.slice(4, -1)).trim() || "#D9483B") : c;
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
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "TWD", "CAD", "AUD", "NZD", "CHF", "DKK", "NOK", "SEK", "CZK", "HUF", "PLN", "ISK", "HRK", "RON", "BGN", "TRY", "KRW", "CNY", "HKD", "SGD", "THB", "VND", "IDR", "PHP", "MYR", "INR", "MXN", "BRL", "ZAR", "AED", "MAD", "EGP"];
const ACCENTS = { lehua: ["#D9483B", "#F06A5B"], sunset: ["#C2610F", "#F5A04E"], fern: ["#3B7A39", "#7CC77A"], ocean: ["#2461B5", "#6FA6F2"], lagoon: ["#107A74", "#4FD1C5"], plumeria: ["#7646B3", "#B593F0"], hibiscus: ["#BE3674", "#F07AB0"] };

// ---------------------------------------------------------------- state
let ME = null;             // { uid, email, name }
let TRIPS = {};            // id -> trip doc
let unsubHome = null;
let cur = null;            // { id, tab, unsubs: [] }
const T = { trip: null, places: {}, days: {}, bookings: {}, expenses: {}, checklist: {}, photos: {}, notes: {}, polls: {}, packing: null };
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
// font pairs; each loads from Google Fonts only when used
const FONTS = {
  clean: { label: "Clean", d: '"Plus Jakarta Sans"', b: '"Plus Jakarta Sans"', q: "Plus+Jakarta+Sans:wght@400;500;600;700;800" },
  rounded: { label: "Rounded", d: '"Nunito"', b: '"Nunito"', q: "Nunito:wght@400;500;600;700;800" },
  modern: { label: "Modern", d: '"Outfit"', b: '"DM Sans"', q: "Outfit:wght@500;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700" },
  editorial: { label: "Editorial", d: '"Playfair Display"', b: '"Source Sans 3"', q: "Playfair+Display:wght@600;700&family=Source+Sans+3:wght@400;500;600;700" },
  classic: { label: "Classic", d: '"Fraunces"', b: '"Manrope"', q: "Fraunces:opsz,wght@9..144,500;9..144,650&family=Manrope:wght@400;500;600;700;800" },
  system: { label: "System", d: "", b: "", q: "" },
};
function loadFont(k) {
  const f = FONTS[k]; if (!f || !f.q || document.querySelector(`link[data-font="${k}"]`)) return;
  const l = document.createElement("link"); l.rel = "stylesheet"; l.dataset.font = k; l.href = `https://fonts.googleapis.com/css2?family=${f.q}&display=swap`; document.head.append(l);
}
let theme = { accent: "lehua", mode: "auto", font: "clean" };
const useF = () => theme.temp ? theme.temp === "F" : /-(US|LR|MM)$/i.test(navigator.language || "en-US") || !/-/.test(navigator.language || "");   // temperatures in °F for US-style locales
try { theme = { ...theme, ...JSON.parse(localStorage.getItem("e29-theme") || "{}") }; } catch {}
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const r = document.documentElement, dark = theme.mode === "auto" ? darkMQ.matches : theme.mode === "dark";
  r.dataset.accent = theme.accent; r.dataset.theme = dark ? "dark" : "light";
  const f = FONTS[theme.font] || FONTS.clean, sys = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  loadFont(theme.font);
  r.style.setProperty("--f-display", f.d ? `${f.d}, ${sys}` : sys); r.style.setProperty("--f-body", f.b ? `${f.b}, ${sys}` : sys);
  $$("#fontPick button").forEach(b => b.setAttribute("aria-pressed", b.dataset.font === theme.font));
  $$("[data-labels]").forEach(b => b.setAttribute("aria-pressed", b.dataset.labels === (theme.labels || "en")));
  $$("[data-temp]").forEach(b => b.setAttribute("aria-pressed", b.dataset.temp === (theme.temp || (useF() ? "F" : "C"))));
  try { if (cur && (cur.tab === "plan" || cur.tab === "today") && T.trip) renderTrip(); } catch {}
  $$("#swatches button").forEach(b => b.setAttribute("aria-pressed", b.dataset.accent === theme.accent));
  $$("#modeSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === theme.mode));
  setTiles(); if (cur) renderMap();
}
$("#swatches").innerHTML = Object.entries(ACCENTS).map(([k, [l, d]]) => `<button type="button" data-accent="${k}" aria-label="${k}" title="${k[0].toUpperCase() + k.slice(1)}" style="background:linear-gradient(135deg,${l} 50%,${d} 50%)"></button>`).join("");
$("#mePop").addEventListener("click", e => {
  e.stopPropagation();
  const a = e.target.closest("[data-accent]"), m = e.target.closest("[data-mode]"), fo = e.target.closest("[data-font]"), lb = e.target.closest("[data-labels]"), te = e.target.closest("[data-temp]");
  if (a) theme.accent = a.dataset.accent; if (m) theme.mode = m.dataset.mode; if (fo) theme.font = fo.dataset.font; if (lb) theme.labels = lb.dataset.labels; if (te) theme.temp = te.dataset.temp;
  if (a || m || fo || lb || te) { try { localStorage.setItem("e29-theme", JSON.stringify(theme)); } catch {} applyTheme(); }
});
$("#fontPick").innerHTML = Object.entries(FONTS).map(([k, f]) => `<button type="button" data-font="${k}" style="font-family:${f.b ? f.b + "," : ""}system-ui,sans-serif"><b style="font-family:${f.d ? f.d + "," : ""}system-ui,sans-serif">Aa</b>${f.label}</button>`).join("");
$("#loyBtn").addEventListener("click", () => { $("#mePop").hidden = true; loyaltyModal(); });
$("#profBtn").addEventListener("click", () => { $("#mePop").hidden = true; profileModal(); });
$("#accessBtn").addEventListener("click", () => { $("#mePop").hidden = true; accessModal(); });
$("#meBtn").addEventListener("click", e => { e.stopPropagation(); Object.keys(FONTS).forEach(loadFont); const p = $("#mePop"); p.hidden = !p.hidden; $("#meBtn").setAttribute("aria-expanded", String(!p.hidden)); });
document.addEventListener("click", () => { $("#mePop").hidden = true; $("#meBtn").setAttribute("aria-expanded", "false"); });
darkMQ.addEventListener?.("change", applyTheme);
$("#signOut").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------- people
const members = () => (T.trip?.members || []).map(e => e.toLowerCase());
const nameOf = email => { if (ME && email === ME.email && ME.name) return ME.name; const n = (T.trip?.names || {})[ekey(email)]; return n || String(email || "").split("@")[0]; };
const avColor = email => AVCOLS[Math.max(0, members().indexOf(String(email).toLowerCase())) % AVCOLS.length];
const avatarSrc = email => (email === ME?.email && ME.photo) || (T.trip?.avatars || {})[ekey(email)] || "";
const avatar = email => { const src = avatarSrc(email); return `<span class="avatar ${src ? "has-img" : ""}" style="--av:${avColor(email)}" title="${esc(nameOf(email))} (${esc(email)})">${src ? `<img src="${esc(src)}" alt="">` : esc(nameOf(email).charAt(0).toUpperCase())}</span>`; };
const isOwner = () => T.trip && ME && T.trip.owner === ME.uid;

// ---------------------------------------------------------------- money
const homeCur = () => T.trip?.currency || "USD";
// a trip can go to several places (countries, regions or cities); older trips have one "dest"
const tripDests = t => (t?.dests?.length ? t.dests : t?.dest ? [t.dest] : []).filter(Boolean);
const destLabel = t => tripDests(t).map(d => d.name).join(" · ");
const destOf = x => ({ name: x.name, country: x.country || "", lat: x.lat ?? null, lon: x.lon ?? null });
// chips editor for destinations: search adds one, × removes it
function destEditor(input, list, box, getList, setList) {
  const paint = () => { box.innerHTML = getList().map((d, i) => `<span class="dchip">${esc(d.name)}${d.country && d.country !== d.name ? `<span class="hint">${esc(d.country)}</span>` : ""}<button type="button" data-rd="${i}" aria-label="Remove ${esc(d.name)}">×</button></span>`).join("") || `<span class="hint">None yet</span>`; };
  paint();
  attachSuggest(input, list, { onPick: x => { const l = getList(); if (!l.some(d => d.name === x.name && d.country === x.country)) setList([...l, destOf(x)]); input.value = ""; paint(); input.focus(); } });
  box.addEventListener("click", e => { const r = e.target.closest("[data-rd]"); if (!r) return; const l = getList().slice(); l.splice(+r.dataset.rd, 1); setList(l); paint(); });
  return paint;
}
function fmtCur(n, c, cents) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 }).format(n || 0); }
  catch { return c + " " + (+n || 0).toFixed(cents ? 2 : 0); }
}
// exchange rates: Frankfurter (central-bank rates, no key), with a free fallback for other currencies; cached on this device
let FX = {}; try { FX = JSON.parse(localStorage.getItem("trips-fx") || "{}"); } catch {}
async function getRate(from, to, date) {
  if (!from || !to || from === to) return { rate: 1, date: date || "", src: "" };
  const today = isoOf(new Date()), d = validIso(date) && date <= today ? date : "latest", key = `${from}>${to}@${d === "latest" ? today : d}`;
  if (FX[key]) return FX[key];
  let out = null;
  try {
    const r = await fetch(`https://api.frankfurter.dev/v1/${d}?base=${from}&symbols=${to}`);
    if (r.ok) { const j = await r.json(); if (j.rates && j.rates[to]) out = { rate: j.rates[to], date: j.date || d, src: "European Central Bank via Frankfurter" }; }
  } catch {}
  if (!out) try {
    const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/${from.toLowerCase()}.json`);
    if (r.ok) { const j = await r.json(), v = j[from.toLowerCase()]?.[to.toLowerCase()]; if (v) out = { rate: v, date: j.date || d, src: "currency-api" }; }
  } catch {}
  if (out) { FX[key] = out; FX[`${from}>${to}@last`] = out; try { localStorage.setItem("trips-fx", JSON.stringify(FX)); } catch {} }
  return out || FX[`${from}>${to}@last`] || null;
}
// an item's value in the trip's home currency
function inHome(amount, cur, rate, home) {
  const h = homeCur(); cur = cur || home || h;
  if (cur === h) return { v: amount, ok: true };
  if (home === h && rate) return { v: amount * rate, ok: true };
  const last = FX[`${cur}>${h}@last`];
  return last ? { v: amount * last.rate, ok: true, approx: true } : { v: 0, ok: false };
}
function money(n, opts = {}) {
  const c = T.trip?.currency || "USD";
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c, maximumFractionDigits: opts.cents ? 2 : 0 }).format(n || 0); }
  catch { return (n < 0 ? "-" : "") + c + " " + Math.round(Math.abs(n || 0)).toLocaleString("en-US"); }
}

// ---------------------------------------------------------------- dates of the trip
function tripDaysOf(t) { const out = []; if (!validIso(t.start) || !validIso(t.end)) return out; for (let d = t.start; d <= t.end && out.length < 120; d = addDays(d, 1)) out.push(d); return out; }
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
async function photon(q, near, limit = 15) {
  const bias = near ? `&lat=${near.lat}&lon=${near.lon}&location_bias_scale=0.3` : "";
  const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en${bias}`);
  if (!r.ok) throw new Error("search failed");
  return (await r.json()).features || [];
}
function fromPhoton(f) {
  const p = f.properties || {}, c = f.geometry?.coordinates || [];
  if (!p.name || c.length < 2) return null;
  const t = typeFrom(p.osm_key, p.osm_value);
  const city = t === "city" ? p.name : (p.city || p.town || p.village || p.district || p.county || p.state || "");
  const addr = [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street, p.postcode].filter(Boolean).join(", ");
  const area = [p.locality, p.district].filter(x => x && x !== city).join(", ");
  return { name: p.name, type: t, city, country: p.country || "", lat: c[1], lon: c[0], addr, area, _all: [p.name, p.street, p.locality, p.district, p.city, p.county, p.postcode].filter(Boolean).join(" ").toLowerCase() };
}
// "35.6702, 139.7027" or a Google Maps link → the spot, plus named places right next to it
const COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;
function parsePasted(q) {
  const m = q.match(COORD); if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) return { lat: +m[1], lon: +m[2], name: "" };
  if (!/google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i.test(q)) return null;
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(q)) return { short: true };
  let lat, lon; const d = q.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/), at = q.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/), qq = q.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i);
  if (d) [lat, lon] = [+d[1], +d[2]]; else if (qq) [lat, lon] = [+qq[1], +qq[2]]; else if (at) [lat, lon] = [+at[1], +at[2]];
  const nm = q.match(/\/maps\/place\/([^/@?]+)/); let name = "";
  if (nm) { try { name = decodeURIComponent(nm[1].replace(/\+/g, " ")); } catch { name = nm[1].replace(/\+/g, " "); } }
  return lat != null ? { lat, lon, name } : name ? { name } : { bad: true };
}
async function resolvePasted(x, near) {
  if (x.lat == null) return (await searchPlaces(x.name, near)).map(r => ({ ...r }));
  const [rev, addr] = await Promise.all([
    fetch(`https://photon.komoot.io/reverse?lat=${x.lat}&lon=${x.lon}&limit=10&radius=0.12&lang=en`).then(r => r.json()).then(j => (j.features || []).map(fromPhoton).filter(y => y && y.type !== "city")).catch(() => []),
    streetAddress(x.lat, x.lon),
  ]);
  const spot = { name: x.name || "Pinned spot", type: "other", city: addr?.city || "", country: addr?.country || "", lat: x.lat, lon: x.lon, addr: [addr?.street, addr?.postcode].filter(Boolean).join(", "), area: "", pinned: true };
  if (x.name) { const same = rev.find(r => r.name.toLowerCase() === x.name.toLowerCase() || r.name.toLowerCase().includes(x.name.toLowerCase().split(" ")[0])); if (same) spot.type = same.type; }
  rev.forEach(r => r.d = km(x, r)); rev.sort((a, b) => a.d - b.d);
  return [spot, ...rev.filter(r => r.d < 0.12 && r.name !== spot.name).slice(0, 6)];
}
const searchCache = new Map();
async function searchPlaces(q, near) {
  const key = q.toLowerCase() + (near ? `@${near.lat.toFixed(1)},${near.lon.toFixed(1)}` : "");
  if (searchCache.has(key)) return searchCache.get(key);
  const words = q.toLowerCase().split(/[\s,]+/).filter(w => w.length > 1 && !/^(the|st|store|shop|branch|restaurant)$/.test(w));
  let feats = await photon(q, near);
  // a long query like "Ippudo Harajuku Takeshita St" may match nothing; search the name, then rank by the other words
  if (feats.length < 4 && words.length > 1) for (let n = Math.min(2, words.length - 1); n >= 1 && feats.length < 8; n--) feats = [...feats, ...await photon(words.slice(0, n).join(" "), near).catch(() => [])];
  const seen = new Set(), out = [];
  for (const f of feats) {
    const x = fromPhoton(f); if (!x) continue;
    const sig = (x.name + "|" + x.lat.toFixed(4) + "|" + x.lon.toFixed(4)).toLowerCase(); if (seen.has(sig)) continue; seen.add(sig);
    x._score = words.filter(w => x._all.includes(w)).length; out.push(x);
  }
  out.sort((a, b) => b._score - a._score);   // stable: keeps Photon's order among equals
  out.forEach(x => { delete x._all; delete x._score; });
  searchCache.set(key, out); return out;
}
// street address for a spot on the map (OpenStreetMap's Nominatim, in English); used when search had no street
const addrCache = {};
async function streetAddress(lat, lon) {
  const k = lat.toFixed(5) + "," + lon.toFixed(5); if (k in addrCache) return addrCache[k];
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1&accept-language=en`);
    const a = (await r.json()).address || {};
    const street = [a.house_number, a.road || a.pedestrian || a.footway].filter(Boolean).join(" ") || a.neighbourhood || a.quarter || "";
    const city = a.city || a.town || a.village || a.city_district || a.suburb || "";
    return addrCache[k] = { street, postcode: a.postcode || "", city, country: a.country || "", line: [street, [a.postcode, city].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ") };
  } catch { return addrCache[k] = null; }
}
// fills x.addr (and city/country if missing) when the search result came without them
async function withAddress(x) {
  if (x.full) return x;
  if (x.addr && /\d|street|road|st\b|rd\b/i.test(x.addr) || x.type === "city" || x.lat == null) return x;
  const a = await streetAddress(x.lat, x.lon); if (!a) return x;
  return { ...x, addr: [a.street, a.postcode].filter(Boolean).join(", ") || x.addr, city: x.city || a.city, country: x.country || a.country };
}
const gmapsUrl = x => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([x.name, x.city, x.country].filter(Boolean).join(", "))}`;
function closeSuggest(list, input) { list.hidden = true; list.innerHTML = ""; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
// opts: { near(): {lat,lon}|null, local(q): [{saved place}] , onPick(item) }
function attachSuggest(input, list, opts) {
  let timer = 0, items = [], active = -1, seq = 0, token = null;
  // picking a Google suggestion fetches its details (address, location) first
  const pick = async x => {
    closeSuggest(list, input);
    if (x.pred) {
      try { x = await googleDetails(x.pred); } catch { toast("Couldn't get that place from Google. Try again."); return; }
      token = null;
    }
    opts.onPick(x);
  };
  const show = html => { list.innerHTML = html; list.hidden = false; input.setAttribute("aria-expanded", "true"); };
  const paint = () => {
    let h = "", sec = "";
    items.forEach((x, i) => {
      const s = x.saved ? "Saved places" : "Search results";
      if (s !== sec && (items.some(y => y.saved))) { h += `<li class="sec" role="presentation">${s}</li>`; sec = s; }
      const t = TYPE[x.type] || TYPE.other;
      h += `<li role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === active}" class="${x.saved ? "saved" : ""}" style="--tc:${t.col}"><i></i><span><b>${esc(x.name)}${x.pinned ? " 📍" : ""}</b><small>${esc([x.addr, x.area, x.city !== x.name ? x.city : "", x.country].filter(Boolean).join(", "))}</small></span><em>${x.saved ? (x.day ? "Saved · " + esc(fmtD(x.day)) : "Saved") : esc(t.label)}</em></li>`;
    });
    if (items.some(x => x.g)) h += `<li class="note g-attr" role="presentation">Powered by Google</li>`;
    show(h); if (active >= 0) input.setAttribute("aria-activedescendant", `${list.id}-${active}`);
  };
  input.addEventListener("input", () => {
    clearTimeout(timer); const q = input.value.trim();
    const local = opts.local ? opts.local(q) : [];
    const pasted = parsePasted(q);
    if (pasted) {
      if (pasted.short) { show(`<li class="note">That's a short share link, which Wayfinder can't open. In Google Maps, press and hold the spot and copy the coordinates (like 35.6702, 139.7027), or open the link in a browser and copy the full address from the address bar.</li>`); return; }
      if (pasted.bad) { show(`<li class="note">Couldn't find a location in that link. Try copying the coordinates from Google Maps instead.</li>`); return; }
      const my = ++seq; show(`<li class="note">Finding that spot…</li>`);
      resolvePasted(pasted, opts.near ? opts.near() : null).then(res => { if (my !== seq) return; items = res; active = items.length ? 0 : -1; items.length ? paint() : show(`<li class="note">Nothing found there.</li>`); }).catch(() => { if (my === seq) show(`<li class="note">Search isn't responding right now.</li>`); });
      return;
    }
    if (q.length < 3) { if (local.length && q.length) { items = local; active = 0; paint(); } else closeSuggest(list, input); return; }
    items = local; active = items.length ? 0 : -1; if (items.length) paint();
    timer = setTimeout(async () => {
      const my = ++seq;
      if (!navigator.onLine) { if (!items.length) show(`<li class="note">Place search needs an internet connection.</li>`); return; }
      try {
        let res;
        if (useGoogle()) {
          try { const { AutocompleteSessionToken } = await gPlaces(); token ||= new AutocompleteSessionToken(); res = await googleSuggest(q, opts.near ? opts.near() : null, token); }
          catch { res = null; }
        }
        res ||= await searchPlaces(q.replace(/^the\s+/i, ""), opts.near ? opts.near() : null); if (my !== seq) return;
        items = [...local, ...res]; active = items.length ? 0 : -1;
        if (!items.length) show(`<li class="note">No matches for “${esc(q)}”. Try another spelling or add the city.</li>`); else paint();
      } catch { if (my === seq && !items.length) show(`<li class="note">Search isn't responding right now. Try again in a moment.</li>`); }
    }, 280);
  });
  input.addEventListener("keydown", e => {
    if (list.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
    else if (e.key === "Escape") { e.stopPropagation(); closeSuggest(list, input); }
  });
  list.addEventListener("mousedown", e => e.preventDefault());
  list.addEventListener("click", e => { const li = e.target.closest("li[data-i]"); if (!li) return; pick(items[+li.dataset.i]); });
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
// links opened from Instagram, Messenger, LINE, etc. open in that app's own browser, where Google blocks sign-in
const inAppBrowser = () => /FBAN|FBAV|Instagram|Line\/|Messenger|MicroMessenger|Snapchat|TikTok|BytedanceWebview|KAKAOTALK|; wv\)|\bGSA\//i.test(navigator.userAgent || "");
function renderGate(msg) {
  $("#crumb").textContent = ""; $("#meBtn").hidden = true; $("#backBtn").hidden = true; $("#layoutSeg").hidden = true;
  $("#app").innerHTML = `<div class="gate"><div class="card"><h1><span class="brand-logo big" role="img" aria-label="Wayfinder"></span></h1><p class="hint">${esc(msg || "Plan trips together: a map, a day-by-day plan, bookings and a shared budget.")}</p><button class="btn accent" id="signIn" type="button">Sign in with Google</button></div></div>`;
  if (inAppBrowser()) {
    $(".gate .card").insertAdjacentHTML("beforeend", `<div class="banner warn-banner"><b>Open this page in Safari or Chrome.</b> Google doesn't allow signing in from inside other apps (like Messenger, Instagram or LINE). Tap ⋯ or the share icon and choose <b>Open in browser</b>, or copy the link:<div class="row" style="gap:6px;margin-top:8px"><input class="input grow" readonly value="${esc(location.href)}" aria-label="Page link"><button class="btn small" type="button" id="gateCopy">Copy</button></div></div>`);
    $("#gateCopy").onclick = () => navigator.clipboard?.writeText(location.href).then(() => { $("#gateCopy").textContent = "Copied"; });
  }
  $("#signIn").onclick = async () => {
    try { await signInWithPopup(auth, provider); }
    catch (e) {
      if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") return signInWithRedirect(auth, provider);
      if (e.code === "auth/web-storage-unsupported" || /disallowed_useragent/i.test(e.message || "")) return renderGate("Google sign-in doesn't work in this app's built-in browser. Open the link in Safari or Chrome instead.");
      const why = { "auth/unauthorized-domain": `Add ${location.hostname} under Firebase → Authentication → Settings → Authorized domains.`, "auth/popup-closed-by-user": "The sign-in window was closed. Try again.", "auth/network-request-failed": "You need a connection to sign in." }[e.code];
      renderGate((why || "Sign-in didn't finish.") + ` (${e.code || e.message})`);
    }
  };
}
const shareToken = () => (location.hash.match(/^#\/s\/([\w-]{16,})/) || [])[1];
onAuthStateChanged(auth, async user => {
  if (!user) { ME = null; unsubHome?.(); leaveTrip(); if (shareToken()) renderShare(shareToken()); else renderGate(); return; }
  ME = { uid: user.uid, email: (user.email || "").toLowerCase(), name: (user.displayName || "").split(" ")[0] || (user.email || "").split("@")[0], gphoto: user.photoURL || "", gname: user.displayName || "" };
  $("#meBtn").hidden = false; $("#meAv").textContent = ME.name.charAt(0).toUpperCase(); $("#meName").textContent = user.displayName || ME.name; $("#meEmail").textContent = ME.email;
  subscribeHome(); subscribeLoyalty(); subscribeAccess(); subscribeProfile(); route();
});

// ================================================================ ROUTING
window.addEventListener("hashchange", route);
function route() {
  if (shareToken()) { leaveTrip(); renderShare(shareToken()); return; }
  if (!ME) { if (auth.currentUser === null) renderGate(); return; }
  const m = location.hash.match(/^#\/t\/([\w-]+)(?:\/(\w+))?/);
  if (location.hash.startsWith("#/help")) { leaveTrip(); renderHelp(); return; }
  if (m) openTrip(m[1], m[2] || (TRIPS[m[1]] && tripDaysOf(TRIPS[m[1]]).includes(isoOf(new Date())) ? "today" : "plan"));
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
  $("#crumb").textContent = ""; $("#backBtn").hidden = true; $("#layoutSeg").hidden = true;
  const list = Object.entries(TRIPS).sort((a, b) => String(a[1].start || "9").localeCompare(String(b[1].start || "9")));
  const imported = list.some(([, t]) => t.importedFrom === "europe2029");
  $("#app").innerHTML = `<div class="home">
    <div class="row between"><div><h1>Your trips</h1><p class="hint">Plan together: a map, a day-by-day plan, bookings and a shared budget.</p></div><button class="btn accent" id="newTrip" type="button">New trip</button></div>
    ${(() => { try { return !localStorage.getItem("trips-seen-help"); } catch { return false; } })() ? `<div class="card row between help-cta"><div><b>New here?</b><p class="hint">Take a two-minute tour of what the planner can do.</p></div><a class="btn accent small" href="#/help">Open the guide</a></div>` : ""}
    ${err ? `<p class="banner">Couldn't load your trips. ${err.code === "permission-denied" ? "The database rules need updating (see the README)." : "Check your connection."}</p>` : ""}
    ${oldEurope && !imported ? `<div class="card row between"><div><b>Bring Europe 2029 in</b><p class="hint">Copies the route, spots, flights and costs, day notes, photos and to-dos from the Europe 2029 site into a trip here. The old site stays as it is.</p></div><button class="btn" id="importEu" type="button">Import Europe 2029</button></div>` : ""}
    <div class="trip-grid">
      ${list.map(([id, t]) => `<a class="trip-card" href="#/t/${id}">
        <div class="trip-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : `<span class="letter">${esc((t.name || "?").charAt(0))}</span>`}<span class="when">${esc(tripWhen(t))}</span></div>
        <div class="trip-body"><h2>${esc(t.name || "Untitled trip")}</h2><span class="hint">${validIso(t.start) ? `${fmtD(t.start)} – ${fmtD(t.end, { month: "short", day: "numeric", year: "numeric" })}` : "No dates yet"}${destLabel(t) ? " · " + esc(destLabel(t)) : ""}</span>
        <span class="hint">${(t.members || []).length} ${(t.members || []).length === 1 ? "person" : "people"}</span></div></a>`).join("")}
      <button class="trip-new" id="newTrip2" type="button">+ Plan a new trip</button>
    </div></div>`;
  $("#newTrip").onclick = $("#newTrip2").onclick = newTripModal;
  $("#importEu") && ($("#importEu").onclick = importEurope);
}
function newTripModal() {
  let dests = [];
  openModal(`<div class="row between"><h2>Plan a new trip</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <label class="field" for="ntName">Trip name<input id="ntName" maxlength="60" placeholder="e.g. Japan in spring"></label>
    <div class="field"><label for="ntDest">Where to <span class="hint" style="display:inline;font-weight:500">(add as many countries or cities as you like)</span></label><div class="dchips" id="ntChips"></div><div class="suggest-wrap"><input id="ntDest" autocomplete="off" placeholder="e.g. Japan, then Hong Kong" role="combobox" aria-expanded="false" aria-controls="ntList"><ul class="suggest" id="ntList" role="listbox" hidden></ul></div></div>
    <div class="grid2"><label class="field" for="ntStart">Start<input id="ntStart" type="date"></label><label class="field" for="ntEnd">End<input id="ntEnd" type="date"></label></div>
    <p class="hint" id="ntMsg">You can change any of this later.</p>
    <div class="row between"><span></span><div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="ntGo">Create trip</button></div></div>`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    destEditor($("#ntDest"), $("#ntList"), $("#ntChips"), () => dests, l => { dests = l; if (!$("#ntName").dataset.typed) $("#ntName").value = l.map(d => d.name).join(" & ").slice(0, 60); });
    $("#ntName").oninput = e => { e.target.dataset.typed = e.target.value ? "1" : ""; };
    $("#ntStart").onchange = () => { if (!$("#ntEnd").value || $("#ntEnd").value < $("#ntStart").value) $("#ntEnd").value = addDays($("#ntStart").value, 6); };
    $("#ntGo").onclick = async () => {
      if ($("#ntDest").value.trim()) { try { const h = (await searchPlaces($("#ntDest").value.trim()))[0]; if (h) dests.push(destOf(h)); } catch {} }
      const dest = dests[0] || null;
      const name = $("#ntName").value.trim() || dests.map(d => d.name).join(" & ") || "New trip";
      let start = $("#ntStart").value, end = $("#ntEnd").value;
      if (validIso(start) && (!validIso(end) || end < start)) end = start;
      const id = uidGen();
      const trip = { name: name.slice(0, 60), dest: dest ? destOf(dest) : null, dests, start: start || "", end: end || "",
        members: [ME.email], names: { [ekey(ME.email)]: ME.name }, owner: ME.uid, ownerEmail: ME.email, created: Date.now(), currency: PROFILE.homeCur || "USD", budget: 0, notes: "", cover: "" };
      try { await setDoc(doc(fs, "trips/" + id), trip); }
      catch (e) { $("#ntMsg").textContent = e.code === "permission-denied" ? "Your account can't start trips yet. Ask whoever set up Wayfinder to add you under People & access. You can still join trips you're invited to." : "Couldn't create the trip. Check your connection."; return; }
      closeModal(); location.hash = `#/t/${id}/plan`;
      if (dest) firstPhoto({ name: dest.name, city: dest.name, lat: dest.lat, lon: dest.lon }, "auto").then(ph => { if (ph) { updateDoc(doc(fs, "trips/" + id), { cover: ph.photo || ph.photoUrl, coverCredit: ph.photoCredit || "" }).catch(() => {}); trackUnsplash(ph.dl); } });
    };
  });
}

// ================================================================ TRIP VIEW
const TABS = [["today", "Today"], ["overview", "Overview"], ["explore", "Explore"], ["notes", "Notes"], ["places", "Places"], ["plan", "Itinerary"], ["bookings", "Bookings"], ["food", "Restaurants"], ["budget", "Budget"], ["todo", "To-do"], ["packing", "Packing"], ["album", "Photos"], ["guide", "Country guide"], ["parks", "Theme parks"]];
function leaveTrip() {
  if (!cur) return;
  cur.unsubs.forEach(u => u()); cur = null;
  for (const k of Object.keys(T)) T[k] = k === "trip" || k === "packing" ? null : {};
  destroyMap(); document.body.classList.remove("show-map");
}
function openTrip(id, tab) {
  if (cur && cur.id === id) { if (cur.tab !== tab) { cur.tab = tab; mapFocus = null; fitPending = true; renderTrip(); renderMap(); } return; }
  leaveTrip();
  cur = { id, tab, unsubs: [] };
  $("#app").innerHTML = `<div class="trip layout-${layout}"><aside class="side" id="side" aria-label="Trip sections"></aside><div class="panel" id="panel"><div class="view"><p class="hint">Loading trip…</p></div></div><div class="mapwrap"><div id="map"></div><div class="map-days" id="mapDays" hidden></div></div></div><button class="btn accent mapbtn" id="mapToggle" type="button">Map</button>`;
  $("#mapToggle").onclick = () => { document.body.classList.toggle("show-map"); $("#mapToggle").textContent = document.body.classList.contains("show-map") ? "List" : "Map"; map?.invalidateSize(); };
  initMap();
  const rerender = debounce(() => { if (cur?.id === id) { renderTrip(true); renderMap("data"); pushShare(); } }, 60);
  cur.unsubs.push(onSnapshot(doc(fs, "trips/" + id), s => {
    if (!s.exists()) { $("#panel").innerHTML = `<div class="view"><p class="banner">This trip doesn't exist anymore, or you're no longer a member.</p><a href="#/">Back to your trips</a></div>`; return; }
    T.trip = { ...s.data() };
    if (ME && members().includes(ME.email) && PROFILE.updated !== undefined) syncProfileTo(id, T.trip);
    else if (ME && !(T.trip.names || {})[ekey(ME.email)] && members().includes(ME.email)) updateDoc(doc(fs, "trips/" + id), { ["names." + ekey(ME.email)]: ME.name }).catch(() => {});
    rerender();
  }, e => { $("#panel").innerHTML = `<div class="view"><p class="banner">${e.code === "permission-denied" ? `This trip hasn't been shared with <b>${esc(ME?.email || "")}</b>. Ask the person who planned it to add this exact email under <b>Share</b>, or sign in with the Google account they invited.` : "Couldn't load this trip. Check your connection and try again."}</p>${e.code === "permission-denied" ? `<button class="btn small" type="button" id="switchAcct">Sign in with a different Google account</button> ` : ""}<a href="#/">Back to your trips</a></div>`; $("#switchAcct") && ($("#switchAcct").onclick = () => signOut(auth)); }));
  cur.unsubs.push(onSnapshot(doc(fs, `users/${ME.uid}/packing/${id}`), s => { if (!latest[`users/${ME.uid}/packing/${id}`]) { T.packing = s.exists() ? { ...s.data() } : { empty: true }; rerender(); } }, () => { T.packing = { empty: true }; }));
  for (const name of ["places", "days", "bookings", "expenses", "checklist", "photos", "notes", "polls"]) {
    cur.unsubs.push(onSnapshot(collection(fs, `trips/${id}/${name}`), snap => {
      const o = {}; snap.docs.forEach(d => { o[d.id] = { ...d.data() }; });
      for (const p of Object.keys(latest)) if (p.startsWith(`trips/${id}/${name}/`)) o[p.split("/").pop()] = latest[p];
      T[name] = o; rerender(); if (name === "bookings") setTimeout(checkReminders, 1500);
    }, () => {}));
  }
}
// fromData: a re-render caused by incoming data; it waits while you're typing so your text and cursor stay put
function renderTrip(fromData = false) {
  if (!T.trip || !cur) return;
  const t = T.trip, panel = $("#panel"), scroll = panel.scrollTop;
  // keep focus and typing intact while data streams in
  const a = document.activeElement, focusId = a && panel.contains(a) && a.id ? a.id : null, sel = focusId && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null;
  if (fromData && ((focusId && a.matches("input:not([type=checkbox]):not([type=file]), textarea, select")) || dragging)) { pendingRender = true; return; }
  $("#crumb").textContent = t.name || ""; $("#backBtn").hidden = false; $("#layoutSeg").hidden = cur.tab === "print";
  $(".trip")?.classList.toggle("printing", cur.tab === "print");
  if (cur.tab === "print") { panel.innerHTML = `<div class="view print-view" id="view"></div>`; viewPrint($("#view")); renderSide(); return; }
  const range = validIso(t.start) ? `${fmtD(t.start, { month: "short", day: "numeric" })} – ${fmtD(t.end, { month: "short", day: "numeric", year: "numeric" })}` : "Add dates in Overview";
  panel.innerHTML = `<div class="hero">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ""}
      <div class="hero-btns"><button class="btn small" type="button" id="calBtn">Add to calendar</button><a class="btn small" href="#/t/${cur.id}/print">Export PDF</a><button class="btn small" type="button" id="inviteBtn">Share</button></div>
      <div class="hero-text"><h1>${esc(t.name || "Untitled trip")}</h1><span class="sub">${esc(range)}${destLabel(t) ? " · " + esc(destLabel(t)) : ""} · ${esc(tripWhen(t))}</span><span class="avatars">${members().map(avatar).join("")}</span></div></div>
    <nav class="tabs" aria-label="Trip sections">${TABS.map(([k, l]) => `<a href="#/t/${cur.id}/${k}" ${cur.tab === k ? 'aria-current="page"' : ""}>${l}</a>`).join("")}</nav>
    <div class="view" id="view"></div>`;
  $("#inviteBtn").onclick = inviteModal; $("#calBtn").onclick = calendarModal;
  ({ plan: viewPlan, places: viewPlaces, bookings: viewBookings, budget: viewBudget, notes: viewNotes, overview: viewOverview, explore: viewExplore, todo: viewTodo, packing: viewPacking, food: viewFood, today: viewToday, guide: viewGuide, parks: viewParks, album: viewAlbum }[cur.tab] || viewPlan)($("#view"));
  if (cur.tab === "plan") { loadWeather(); loadHours(); }
  renderSide();
  if (scrollToDay && cur.tab === "plan") { const el = document.getElementById("day-" + scrollToDay); scrollToDay = null; if (el) { el.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" }); return; } }
  panel.scrollTop = scroll;
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch {} } }
}
let pendingRender = false, dragging = false, scrollToDay = null;
// ---- sidebar (wide screens) ----
const sideOpen = { plan: true, bookings: true };
function renderSide() {
  const side = $("#side"); if (!side || !T.trip) return;
  const days = tripDays(), tab = cur.tab, all = placeList();
  const bk = g => Object.values(T.bookings).filter(b => (KINDS[b.kind] || KINDS.other).group === g).length;
  const todoOpen = Object.values(T.checklist).filter(c => !c.done).length;
  const pk = packStats();
  const item = (k, label, extra = "", count = "") => `<a href="#/t/${cur.id}/${k}" class="side-item ${tab === k ? "on" : ""}" ${tab === k ? 'aria-current="page"' : ""}><span>${label}</span>${count !== "" ? `<span class="side-n">${count}</span>` : ""}${extra}</a>`;
  const caret = k => `<button class="side-caret" type="button" data-caret="${k}" aria-expanded="${!!sideOpen[k]}" aria-label="${sideOpen[k] ? "Collapse" : "Expand"}">${sideOpen[k] ? "▾" : "▸"}</button>`;
  side.innerHTML = `<nav>
    ${item("today", "Today", "", tripDays().includes(isoOf(new Date())) ? "●" : "")}
    ${item("overview", "Overview")}
    ${item("explore", "Explore")}
    ${item("notes", "Notes & votes", "", Object.values(T.polls || {}).filter(p => !p.closed && !(p.votes || {})[ekey(ME.email)]).length ? "🗳" : Object.keys(T.notes).length || "")}
    ${item("places", "Places to visit", "", all.length || "")}
    <div class="side-group">${item("plan", "Itinerary", caret("plan"))}
      ${sideOpen.plan ? `<div class="side-sub">${days.map((iso, i) => { const n = dayPlaces(iso).length; return `<button type="button" class="side-day ${mapFocus === iso ? "on" : ""}" data-sday="${iso}" style="--dc:${dayColor(iso, i)}"><i></i><span>${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}</span>${n ? `<span class="side-n">${n}</span>` : ""}</button>`; }).join("")}</div>` : ""}</div>
    <div class="side-group">${item("bookings", "Bookings", caret("bookings"), Object.keys(T.bookings).length || "")}
      ${sideOpen.bookings ? `<div class="side-sub">${[["transport", "Flights & trains"], ["lodging", "Hotels & lodging"], ["car", "Rental cars"], ["event", "Reservations & tickets"]].map(([g, l]) => `<button type="button" class="side-day ${tab === "bookings" && BF.kind === g ? "on" : ""}" data-sbk="${g}"><span>${l}</span>${bk(g) ? `<span class="side-n">${bk(g)}</span>` : ""}</button>`).join("")}</div>` : ""}</div>
    ${parkDays().length ? item("parks", "Theme parks", "", parkDays().reduce((a, d) => a + T.days[d].parks.length, 0)) : ""}
    ${item("food", "Restaurants", "", placeList().filter(p => FOODT.includes(p.type)).length || "")}
    ${item("budget", "Budget")}
    ${item("todo", "To-do", "", todoOpen || "")}
    ${item("packing", "Packing", "", pk.total ? `${pk.done}/${pk.total}` : "")}
    ${item("album", "Photos", "", Object.keys(T.photos).length || "")}
    ${item("guide", "Country guide")}
    <a href="#/t/${cur.id}/print" class="side-item side-export ${tab === "print" ? "on" : ""}"><span>Export PDF</span></a>
  </nav>`;
  side.onclick = e => {
    const c = e.target.closest("[data-caret]"); if (c) { e.preventDefault(); sideOpen[c.dataset.caret] = !sideOpen[c.dataset.caret]; renderSide(); return; }
    const d = e.target.closest("[data-sday]");
    if (d) { mapFocus = d.dataset.sday; fitPending = true; scrollToDay = d.dataset.sday; if (cur.tab !== "plan") location.hash = `#/t/${cur.id}/plan`; else { renderTrip(); renderMap(); } return; }
    const b = e.target.closest("[data-sbk]");
    if (b) { BF.kind = BF.kind === b.dataset.sbk && cur.tab === "bookings" ? "" : b.dataset.sbk; if (cur.tab !== "bookings") location.hash = `#/t/${cur.id}/bookings`; else renderTrip(); }
  };
}
// List / Split / Map layout, remembered on this device
let layout = (() => { try { return localStorage.getItem("trips-layout") || "split"; } catch { return "split"; } })();
setTimeout(() => $$("[data-layout]").forEach(b => b.setAttribute("aria-pressed", b.dataset.layout === layout)), 0);
$("#layoutSeg").innerHTML = [["list", "List"], ["split", "Split"], ["map", "Map"]].map(([k, l]) => `<button type="button" data-layout="${k}" title="${k === "list" ? "Hide the map" : k === "map" ? "Bigger map" : "List and map side by side"}">${l}</button>`).join("");
$("#layoutSeg").addEventListener("click", e => { const b = e.target.closest("[data-layout]"); if (b) setLayout(b.dataset.layout); });
function setLayout(l) {
  layout = l; try { localStorage.setItem("trips-layout", l); } catch {}
  const t = $(".trip"); if (t) { t.classList.remove("layout-list", "layout-split", "layout-map"); t.classList.add("layout-" + l); }
  $$("[data-layout]").forEach(b => b.setAttribute("aria-pressed", b.dataset.layout === l));
  if (map) setTimeout(() => { map.invalidateSize(); fitPending = true; renderMap(); }, 60);
}
// catch up once you leave a field, but not while you're moving between fields of the same form
document.addEventListener("focusout", () => setTimeout(() => { const a = document.activeElement, typing = a && $("#panel")?.contains(a) && a.matches("input:not([type=checkbox]), textarea, select");
  if (pendingRender && cur && !typing) { pendingRender = false; renderTrip(); renderMap(); } }, 0));

// ---------------------------------------------------------------- places data
const placeList = () => Object.entries(T.places).map(([id, p]) => ({ id, ...p, type: TYPE[p.type] ? p.type : "other", hearts: p.hearts || {} }));
// note bubbles on a day, kept on the day itself; they share the "order" numbers with the day's places
const dayCards = iso => (T.days[iso]?.cards || []).filter(c => c && c.id);
const dayItems = iso => [...dayPlaces(iso).map(p => ({ ...p, k: "p" })), ...dayCards(iso).map(c => ({ ...c, k: "n" }))].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.k === b.k ? 0 : a.k === "n" ? 1 : -1));
const saveDay = (iso, delay = 0) => save(tp("days/" + iso), T.days[iso], delay);
const dayPlaces = iso => placeList().filter(p => p.day === iso).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.time || "").localeCompare(b.time || ""));
function newPlaceFrom(x, extra = {}) {
  return { name: (x.name || "").slice(0, 80), type: x.type || "other", city: (x.city || "").slice(0, 60), country: (x.country || "").slice(0, 60), lat: x.lat ?? null, lon: x.lon ?? null,
    addr: x.addr || "", link: x.link || gmapsUrl(x), gid: x.gid || "", notes: "", day: "", order: 0, time: "", photo: "", photoUrl: "", photoCredit: "", photoLink: "", photoBy: "", photoSrc: "",
    hearts: { [ekey(ME.email)]: ME.name }, by: ME.email, created: Date.now(), ...extra };
}
function addPlace(x, extra) {
  const id = uidGen(), p = newPlaceFrom(x, extra);
  T.places[id] = p; save(tp("places/" + id), p, 0);
  withAddress(x).then(y => { if (T.places[id] && (y.addr !== p.addr || y.country !== p.country)) { T.places[id] = { ...T.places[id], addr: y.addr || "", country: T.places[id].country || y.country || "", city: T.places[id].city || y.city || "" }; savePlace(id); } });
  firstPhoto(x).then(ph => {
    if (!ph || !T.places[id] || photoSrcOf(T.places[id])) return;
    const { dl, ...keep } = ph; T.places[id] = { ...T.places[id], ...keep }; save(tp("places/" + id), T.places[id], 0); trackUnsplash(dl);
  });
  return id;
}
const savePlace = (id, delay = 0) => save(tp("places/" + id), T.places[id], delay);

// ================================================================ ITINERARY
let openAdd = null;   // which day's add box is open
let openColor = null; // which day's color picker is open
function bookingsOn(iso) {
  const out = [];
  for (const [id, b] of Object.entries(T.bookings)) {
    const k = KINDS[b.kind] || KINDS.other;
    if (b.kind === "flight" && b.legs?.length > 1) {
      const segs = b.legs;
      segs.forEach((l, i) => {
        if (l.depDate === iso) out.push({ id, b, t: l.depTime || "", txt: `<b>Flight</b> ${esc(l.num ? l.num + " · " : "")}${esc(l.from || "?")} ${esc(l.depTime || "")} → ${esc(l.to || "?")} ${esc(l.arrTime || "")}${l.arrDate && l.arrDate !== l.depDate ? " (+" + daysBetween(l.depDate, l.arrDate) + ")" : ""}` });
        else if (l.arrDate === iso && (i === segs.length - 1 || segs[i + 1].depDate !== iso)) out.push({ id, b, t: l.arrTime || "", txt: `<b>Arrive</b> ${esc(l.to || "")} ${esc(l.arrTime || "")}${i < segs.length - 1 ? " · connecting" : ""}` });
      });
    } else if (k.group === "transport") {
      if (b.depDate === iso) {
        const route = b.from || b.to ? `${esc(b.from || "?")} ${esc(b.depTime || "")} → ${esc(b.to || "?")} ${esc(b.arrTime || "")}${b.arrDate && b.arrDate !== b.depDate ? " (+" + daysBetween(b.depDate, b.arrDate) + ")" : ""}` : `${esc(b.title || "")}${b.depTime ? " · " + esc(b.depTime) : ""}`;
        out.push({ id, b, t: b.depTime || "", txt: `<b>${esc(k.label)}</b> ${esc(b.num ? b.num + " · " : "")}${route}` });
      }
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
  const head = `<div class="row between"><h2>Itinerary</h2><div class="row" style="gap:8px"><span class="hint">${days.length} days</span><button class="btn ghost small pp-toggle" type="button" id="ppToggle" aria-pressed="${ppOn}">${ppOn ? "Hide saved places" : `Saved places${unscheduled.length ? ` (${unscheduled.length})` : ""}`}</button></div></div>`;
  const dayList = days.map((iso, i) => dayHtml(iso, i)).join("");
  v.innerHTML = ppOn ? `${head}<div class="plan-split"><aside class="pp" aria-label="Saved places">${ppHtml()}</aside><div class="plan-days">${dayList}</div></div>`
    : `${head}${unscheduled.length ? `<p class="hint">${unscheduled.length} saved place${unscheduled.length === 1 ? "" : "s"} not scheduled yet. Open <b>Saved places</b> to drag them into a day.</p>` : ""}${dayList}`;
  $(".trip")?.classList.toggle("pp-on", ppOn);
  $("#ppToggle").onclick = () => { ppOn = !ppOn; try { localStorage.setItem("trips-pp", ppOn ? "1" : ""); } catch {} renderTrip(); setTimeout(() => map?.invalidateSize(), 80); };
  wirePlan(v);
  if (ppOn) wirePP(v);
}
const dayMode = iso => T.days[iso]?.mode || T.trip?.mode || "walk";
let ppOn = (() => { try { return !!localStorage.getItem("trips-pp"); } catch { return false; } })(), ppFilter = { q: "", all: false };
function ppHtml() {
  const days = tripDays();
  const L = placeList().filter(p => ppFilter.all || !days.includes(p.day)).sort((a, b) => (a.city || "").localeCompare(b.city || "") || a.name.localeCompare(b.name));
  return `<div class="pp-head"><h3>Saved places</h3><span class="hint">Drag into a day</span></div>
    <input class="input" id="ppQ" type="search" placeholder="Filter…" value="${esc(ppFilter.q)}" aria-label="Filter saved places">
    <div class="seg pp-seg"><button type="button" data-ppall="" aria-pressed="${!ppFilter.all}">Not scheduled</button><button type="button" data-ppall="1" aria-pressed="${ppFilter.all}">All</button></div>
    <ol class="pp-list" id="ppList">${L.map(p => `<li class="stop-wrap pp-item" data-id="${p.id}" data-q="${esc((p.name + " " + (p.city || "") + " " + TYPE[p.type].label).toLowerCase())}" style="--tc:${TYPE[p.type].col}">
      <span class="thumb">${photoSrcOf(p) ? `<img src="${esc(photoSrcOf(p))}" alt="" loading="lazy" draggable="false" onerror="this.remove()">` : esc(p.name.charAt(0))}</span>
      <span class="info"><b>${esc(p.name)}</b><small>${esc(TYPE[p.type].label)}${p.city && p.city !== p.name ? " · " + esc(p.city) : ""}${days.includes(p.day) ? " · " + esc(fmtD(p.day)) : ""}</small></span></li>`).join("")}</ol>
    ${L.length ? "" : `<p class="hint">${placeList().length ? "Everything's scheduled." : "Nothing saved yet. Add places in Places or Explore."}</p>`}
    <p class="hint" style="font-size:11.5px">Drag a stop back here to unschedule it.</p>`;
}
function wirePP(v) {
  const q = $("#ppQ"), list = $("#ppList");
  const apply = () => { const t = ppFilter.q.toLowerCase(); $$(".pp-item", list).forEach(li => li.hidden = !!t && !li.dataset.q.includes(t)); };
  apply();
  q.oninput = () => { ppFilter.q = q.value; apply(); };
  $$("[data-ppall]", v).forEach(b => b.onclick = () => { ppFilter.all = !!b.dataset.ppall; renderTrip(); });
  if (!window.Sortable) return;
  Sortable.create(list, {
    group: { name: "days", pull: "clone", put: true }, sort: false, animation: 200, draggable: ".pp-item", forceFallback: true, fallbackOnBody: true,
    delay: 140, delayOnTouchOnly: true, ghostClass: "sort-ghost", chosenClass: "sort-chosen", dragClass: "sort-drag",
    onStart: () => { dragging = true; v.classList.add("is-dragging"); },
    onEnd: evt => {
      v.classList.remove("is-dragging"); dragging = false;
      if (evt.to !== evt.from && evt.to.dataset.drop) {
        const iso = evt.to.dataset.drop, id = evt.item.dataset.id, was = T.places[id]?.day;
        reorderDay(iso, $$(".stop-wrap", evt.to).map(li => li.dataset.id).filter((x, i, a) => a.indexOf(x) === i));
        if (was && was !== iso) reorderDay(was, dayPlaces(was).map(p => p.id).filter(x => x !== id));
        toast(`${esc(T.places[id]?.name || "Place")} added to ${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}.`);
      }
      pendingRender = false; requestAnimationFrame(() => { renderTrip(); renderMap(); });
    },
    onAdd: evt => {   // a stop dragged back from a day: unschedule it
      const id = evt.item.dataset.id, was = T.places[id]?.day;
      if (id && T.places[id]) { T.places[id] = { ...T.places[id], day: "", time: "" }; savePlace(id); if (was) reorderDay(was, dayPlaces(was).map(p => p.id)); }
      dragging = false; pendingRender = false; requestAnimationFrame(() => { renderTrip(); renderMap(); });
    },
  });
}
function dayHtml(iso, i) {
  const items = dayPlaces(iso), bk = bookingsOn(iso), stay = stayFor(iso), notes = T.days[iso]?.notes || "", photos = Object.entries(T.photos).filter(([, p]) => p.day === iso);
  const focus = mapFocus === iso, mode = dayMode(iso);
  let total = 0, mins = 0; const legs = [], lm = [];
  for (let k = 1; k < items.length; k++) if (hasPt(items[k - 1]) && hasPt(items[k])) { const d = km(items[k - 1], items[k]), md = legModeOf(iso, items[k], d); total += d; mins += d > 0.05 ? legMins(d, md) : 0; legs[k] = d; lm[k] = md; }
  const used = [...new Set(lm.filter(Boolean))], how = used.length === 1 ? " " + MODES[used[0]].verb : used.length > 1 ? " (" + used.map(u => MODES[u].label.toLowerCase()).join(" + ") + ")" : "";
  const pts = items.filter(hasPt);
  const travelDay = !items.length && bk.some(x => (KINDS[x.b.kind] || KINDS.other).group === "transport");
  return `<section class="day ${focus ? "focus" : ""}" id="day-${iso}" data-day="${iso}" style="--dc:${dayColor(iso, i)}">
    <div class="day-head" data-focus="${iso}" role="button" tabindex="0" aria-pressed="${focus}" aria-label="Show only ${esc(dayLabel(iso))} on the map">
      <button class="day-dot" type="button" data-dcolor="${iso}" aria-expanded="${openColor === iso}" aria-label="Change the color of ${esc(dayLabel(iso))}" title="Change this day's color"></button><div class="grow"><h2>${esc(fmtD(iso, { weekday: "long", month: "long", day: "numeric" }))}</h2>
      <span class="meta">${wxChip(iso)}Day ${i + 1}${travelDay ? " · Travel day" : ""}${items.length ? ` · ${items.length} place${items.length === 1 ? "" : "s"}` : ""}${total ? ` · ${total.toFixed(1)} km · about ${fmtMin(mins)}${how}` : ""}</span></div>
      ${focus ? `<span class="pill accent">Only this day on map</span>` : ""}</div>
    <div class="day-body">
      ${(T.days[iso]?.parks || []).map(p => `<button type="button" class="park-chip" data-openpark="${iso}|${esc(p.pid)}">🎢 <b>${esc(p.name)}</b><span>${(p.items || []).length ? `${(p.items || []).filter(i => i.must).length} must-dos · ${(p.items || []).length} planned` : "Plan this park"}</span></button>`).join("")}
      ${openColor === iso ? `<div class="day-colors" role="group" aria-label="Day color">${DAYPAL.map(([hx, nm]) => `<button type="button" data-setcol="${iso}" data-c="${hx}" style="--sw:${hx}" aria-pressed="${T.days[iso]?.color === hx}" title="${nm}" aria-label="${nm}"></button>`).join("")}<button type="button" class="linkbtn" data-setcol="${iso}" data-c="">Default</button></div>` : ""}
      ${bk.map(x => `<div class="bk-mini">${x.txt}</div>`).join("")}
      <textarea class="day-notes" id="dn-${iso}" data-notes="${iso}" placeholder="Notes for the day…" rows="${Math.min(8, Math.max(1, notes.split("\n").length))}">${esc(notes)}</textarea>
      ${items.length > 1 ? `<label class="mode-pick">Getting around <select id="md-${iso}" data-mode="${iso}" aria-label="How you'll get around on ${esc(dayLabel(iso))}">${DAY_MODES.map(([k, l]) => `<option value="${k}" ${k === mode ? "selected" : ""}>${l}</option>`).join("")}</select><span class="hint">Change any stretch below</span></label>` : ""}
      <ol class="stops" data-drop="${iso}">${dayItems(iso).map(x => x.k === "n" ? noteHtml(iso, x) : (() => { const p = x, k = items.findIndex(y => y.id === p.id); return `<li class="stop-wrap" data-id="${p.id}">
          ${k && legs[k] != null ? `<div class="leg"><label class="leg-pick ${p.leg ? "set" : ""}" title="How you'll get to ${esc(p.name)}"><span aria-hidden="true">${MODE_IC[lm[k]]}</span><select data-leg="${p.id}" aria-label="How to get to ${esc(p.name)}"><option value="">${p.leg ? "Same as the day" : "Same as the day (" + esc(MODES[lm[k]].label.toLowerCase()) + ")"}</option>${Object.entries(MODES).map(([mk, m]) => `<option value="${mk}" ${p.leg === mk ? "selected" : ""}>${m.label}</option>`).join("")}</select></label><span>${esc(legText(legs[k], lm[k]))}</span></div>` : ""}
          <div class="stop" style="--tc:${TYPE[p.type].col}">
            <span class="grip" aria-hidden="true">⋮⋮</span><span class="num">${k + 1}</span>
            <span class="thumb">${photoSrcOf(p) ? `<img src="${esc(photoSrcOf(p))}" alt="" loading="lazy" draggable="false" onerror="this.remove()">` : esc(p.name.charAt(0))}</span>
            <span class="info"><span class="nm">${esc(p.name)}</span><span class="sub"><span>${esc(TYPE[p.type].label)}${p.city && p.city !== p.name ? " · " + esc(p.city) : ""}</span><input type="time" id="tm-${p.id}" data-time="${p.id}" value="${esc(p.time || "")}" aria-label="Time for ${esc(p.name)}">${hoursBadge(p, iso)}</span></span>
            <span class="acts">${commentsOf(p).length ? cmtBtn(p) : ""}<button class="iconbtn" type="button" data-up="${p.id}" aria-label="Move ${esc(p.name)} up">↑</button><button class="iconbtn" type="button" data-down="${p.id}" aria-label="Move ${esc(p.name)} down">↓</button><button class="iconbtn" type="button" data-edit="${p.id}" aria-label="Edit ${esc(p.name)}">✎</button><button class="iconbtn del" type="button" data-unsched="${p.id}" aria-label="Remove ${esc(p.name)} from this day">×</button></span>
          </div></li>`; })()).join("")}</ol>
      ${photos.length ? `<div class="row" style="gap:6px">${photos.map(([, ph]) => `<img src="${esc(ph.data)}" alt="Trip photo" data-zoom style="width:64px;height:48px;object-fit:cover;border-radius:7px;cursor:zoom-in">`).join("")}</div>` : ""}
      ${stay ? `<div class="bk-mini"><b>Staying at</b> ${esc(stay[1].title || "your stay")}</div>` : pts.length ? `<button class="linkbtn find-stay" type="button" data-findstay="c:${esc((pts[0].city || "Day " + (i + 1)).trim())}">No stay booked for this night · Find one nearby</button>` : ""}
      ${openAdd === iso ? `<div class="suggest-wrap add-box"><input id="add-${iso}" autocomplete="off" placeholder="Search saved places or anywhere…" role="combobox" aria-expanded="false" aria-controls="addl-${iso}"><ul class="suggest" id="addl-${iso}" role="listbox" hidden></ul></div>` : ""}
      ${openIdeas === iso ? ideasHtml(iso) : ""}
      <div class="day-actions">
        <button class="btn small ${openAdd === iso ? "ghost" : ""}" type="button" data-add="${iso}">${openAdd === iso ? "Done adding" : "+ Add a place"}</button>
        <button class="btn ghost small" type="button" data-addnote="${iso}">+ Note</button>
        <button class="btn ghost small" type="button" data-parkday="${iso}">🎢 Theme park</button>
        <button class="btn ghost small" type="button" data-ideas="${iso}" aria-expanded="${openIdeas === iso}">${openIdeas === iso ? "Hide ideas" : "Ideas nearby"}</button>
        ${pts.length > 1 ? `<button class="btn ghost small" type="button" data-opt="${iso}" title="Let the planner put the stops in the shortest order">Optimize route</button>` : ""}
        ${pts.length > 1 ? `<button class="btn ghost small" type="button" data-dir="${iso}">Directions</button>` : ""}
      </div>
    </div></section>`;
}
function noteHtml(iso, c) {
  return `<li class="stop-wrap note-wrap" data-id="n:${c.id}"><div class="dnote">
    <span class="grip" aria-hidden="true">⋮⋮</span><span class="dn-ic" aria-hidden="true">✎</span>
    <textarea id="cn-${c.id}" data-card="${iso}|${c.id}" rows="1" maxlength="1000" placeholder="Write a note… (e.g. bag drop at the hotel, gate info)" aria-label="Note">${esc(c.text || "")}</textarea>
    <input type="time" id="ct-${c.id}" data-ctime="${iso}|${c.id}" value="${esc(c.time || "")}" aria-label="Time for this note">
    <button class="iconbtn del" type="button" data-cdel="${iso}|${c.id}" aria-label="Delete note">×</button></div></li>`;
}
function dirUrl(pts, mode = "walk") {
  const ll = p => `${p.lat},${p.lon}`, mid = pts.slice(1, -1).slice(0, 9);
  return `https://www.google.com/maps/dir/?api=1&origin=${ll(pts[0])}&destination=${ll(pts[pts.length - 1])}${mid.length ? "&waypoints=" + encodeURIComponent(mid.map(ll).join("|")) : ""}&travelmode=${(MODES[mode] || MODES.walk).g}`;
}
const APPLE_MODE = { walk: "walking", transit: "transit", drive: "driving", bike: "cycling" };
function appleDirUrl(pts, mode = "walk") {
  const ll = p => `${p.lat},${p.lon}`;
  return `https://maps.apple.com/directions?source=${ll(pts[0])}&destination=${ll(pts[pts.length - 1])}${pts.slice(1, -1).map(p => "&waypoint=" + ll(p)).join("")}&mode=${APPLE_MODE[mode] || "walking"}`;
}
function directionsModal(iso) {
  const pts = dayPlaces(iso).filter(hasPt);
  const stretches = pts.slice(1).map((p, k) => { const d = km(pts[k], p); return { a: pts[k], b: p, d, m: legModeOf(iso, p, d) }; });
  const mixed = new Set(stretches.map(x => x.m)).size > 1, mode = !mixed && stretches.length ? stretches[0].m : routeMode(iso);
  let pref = ""; try { pref = localStorage.getItem("trips-maps") || ""; } catch {}
  const many = pts.length > 11;
  openModal(`<div class="row between"><h2>Directions</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">${esc(dayLabel(iso))} · ${pts.length} stops${mixed ? "" : " · " + esc(MODES[mode].label.toLowerCase())}. Which maps app?</p>${mixed ? `<p class="hint">The whole-day route uses ${esc(MODES[mode].label.toLowerCase())}, since a maps app can only take one way of getting around per route.</p>` : ""}
    <div class="maps-pick">
      <a class="maps-btn" href="${esc(appleDirUrl(pts, mode))}" target="_blank" rel="noopener" data-app="apple"><b>Apple Maps</b><span>Best on iPhone, iPad and Mac</span></a>
      <a class="maps-btn" href="${esc(dirUrl(pts, mode))}" target="_blank" rel="noopener" data-app="google"><b>Google Maps</b><span>Works everywhere${many ? " · first 10 stops" : ""}</span></a>
    </div>
    ${mixed ? `<div class="field"><span>Or one stretch at a time, each in its own way of getting around</span><ol class="dir-legs">${stretches.map(x => `<li><span>${MODE_IC[x.m]} <b>${esc(x.a.name)}</b> → <b>${esc(x.b.name)}</b> <span class="hint" style="display:inline">${esc(legText(x.d, x.m))}</span></span><span class="dir-links"><a class="ext" href="${esc(appleDirUrl([x.a, x.b], x.m))}" target="_blank" rel="noopener">Apple ↗</a><a class="ext" href="${esc(dirUrl([x.a, x.b], x.m))}" target="_blank" rel="noopener">Google ↗</a></span></li>`).join("")}</ol></div>` : ""}
    <label class="row" style="gap:8px"><input type="checkbox" id="dmRemember" ${pref ? "checked" : ""}> Remember my choice on this device</label>
    <p class="hint">Apple Maps needs iOS 18.4 or macOS 15.4 or later for routes with several stops.</p>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    m.addEventListener("click", e => { const a = e.target.closest("[data-app]"); if (!a) return; try { localStorage.setItem("trips-maps", $("#dmRemember").checked ? a.dataset.app : ""); } catch {} setTimeout(closeModal, 50); });
  });
  if (pref) { const a = $(`[data-app="${pref}"]`); if (a) { a.classList.add("pref"); a.focus(); } }
}
function reorderDay(iso, ids) {
  let full = ids;
  if (dayCards(iso).length && !ids.some(x => String(x).startsWith("n:"))) {
    // only places were reordered: each note stays in the slot it was in
    const q = ids.slice(); full = dayItems(iso).map(x => x.k === "n" ? "n:" + x.id : q.shift()).filter(x => x !== undefined); full.push(...q);
  }
  const touched = new Set();
  full.forEach((id, k) => {
    if (String(id).startsWith("n:")) {
      const nid = id.slice(2);
      let card = dayCards(iso).find(c => c.id === nid);
      if (!card) {   // dragged here from another day
        for (const [d, v] of Object.entries(T.days)) { const c = (v?.cards || []).find(c => c.id === nid); if (c && d !== iso) { T.days[d] = { ...v, cards: v.cards.filter(x => x.id !== nid) }; touched.add(d); card = c; } }
        if (!card) return;
        T.days[iso] = { ...(T.days[iso] || {}), cards: [...dayCards(iso), card] };
      }
      if (card.order !== k) { T.days[iso] = { ...T.days[iso], cards: dayCards(iso).map(c => c.id === nid ? { ...c, order: k } : c) }; }
      touched.add(iso); return;
    }
    if (T.places[id] && (T.places[id].order !== k || T.places[id].day !== iso)) { T.places[id] = { ...T.places[id], day: iso, order: k }; savePlace(id); }
  });
  touched.forEach(d => saveDay(d));
}
function optimizeAsk(iso) {
  const st = stayFor(iso) || stayFor(addDays(iso, -1)), sb = st && st[1].lat != null ? st[1] : null;
  const keep = (() => { try { return JSON.parse(localStorage.getItem("trips-opt") || "{}"); } catch { return {}; } })();
  openModal(`<div class="row between"><h2>Optimize route</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Puts ${esc(dayLabel(iso))}'s stops in the order with the least travel, measured as straight-line distance between them. You can undo it.</p>
    <label class="field" for="opStart">Start from<select id="opStart"><option value="first">Keep my first stop first</option><option value="any">Any stop</option>${sb ? `<option value="stay" ${keep.start === "stay" ? "selected" : ""}>My stay: ${esc(sb.title || "hotel")}</option>` : ""}</select></label>
    <label class="field" for="opEnd">End at<select id="opEnd"><option value="any">Wherever is shortest</option><option value="last">Keep my last stop last</option>${sb ? `<option value="stay" ${keep.end === "stay" ? "selected" : ""}>Back at my stay</option>` : ""}</select></label>
    ${sb ? "" : `<p class="hint">Add your hotel's address in Bookings to start or end the day there.</p>`}
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="opGo">Optimize</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    $("#opGo").onclick = () => { const o = { start: $("#opStart").value, end: $("#opEnd").value }; try { localStorage.setItem("trips-opt", JSON.stringify(o)); } catch {} closeModal(); optimize(iso, o, sb); };
  });
}
function optimize(iso, o = { start: "first", end: "any" }, stay = null) {
  const items = dayPlaces(iso), pts = items.filter(hasPt), rest = items.filter(p => !hasPt(p));
  if (pts.length < 2) return;
  const S = stay ? { lat: stay.lat, lon: stay.lon, home: true } : null;
  const head = o.start === "stay" && S ? S : o.start === "first" ? pts[0] : null;
  const tail = o.end === "stay" && S ? S : o.end === "last" ? pts[pts.length - 1] : null;
  const free = pts.filter(p => p !== head && p !== tail);
  const len = arr => arr.reduce((a, p, i) => i ? a + km(arr[i - 1], p) : 0, 0);
  const wrap = mid => [...(head ? [head] : []), ...mid, ...(tail ? [tail] : [])];
  // nearest neighbour from the start, then 2-opt to untangle crossings
  let mid = [], left = free.slice();
  let last = head || (tail ? null : null);
  if (!last) { left.sort((a, b) => (tail ? km(tail, b) - km(tail, a) : 0)); mid.push(left.shift()); last = mid[0]; }
  while (left.length) { left.sort((a, b) => km(last, a) - km(last, b)); last = left.shift(); mid.push(last); }
  let improved = true, guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < mid.length - 1; i++) for (let j = i + 1; j < mid.length; j++) {
      const cand = [...mid.slice(0, i), ...mid.slice(i, j + 1).reverse(), ...mid.slice(j + 1)];
      if (len(wrap(cand)) < len(wrap(mid)) - 1e-6) { mid = cand; improved = true; }
    }
  }
  const route = wrap(mid).filter(p => !p.home);
  const before = len(wrap(pts.filter(p => p !== head && p !== tail))), after = len(wrap(mid));
  if (before - after < 0.05) { toast("This day's order is already about as short as it gets."); return; }
  const prev = items.map(p => p.id);
  reorderDay(iso, [...route.map(p => p.id), ...rest.map(p => p.id)]);
  renderTrip(); renderMap();
  toast(`New order saves about ${(before - after).toFixed(1)} km.`, { label: "Undo", run: () => { reorderDay(iso, prev); renderTrip(); renderMap(); } });
}
function wirePlan(v) {
  v.addEventListener("click", e => {
    const f = e.target.closest("[data-focus]");
    if (f && !e.target.closest("button, select, input")) { focusDay(mapFocus === f.dataset.focus ? null : f.dataset.focus); return; }
    const b = e.target.closest("button, img[data-zoom]"); if (!b) return;
    if (b.dataset.add) { openAdd = openAdd === b.dataset.add ? null : b.dataset.add; renderTrip(); const inp = openAdd && $("#add-" + openAdd); if (inp) { wireAdd(openAdd); inp.focus(); } return; }
    if (b.dataset.ideas) { openIdeas = openIdeas === b.dataset.ideas ? null : b.dataset.ideas; renderTrip(); if (openIdeas) loadIdeas(openIdeas); return; }
    if (b.dataset.idea) return useIdea(b.dataset.idea, b.dataset.how, b.closest("[data-ideas-for]").dataset.ideasFor);
    if (b.dataset.ideasWhere) { ideasWherePrompt(b.dataset.ideasWhere); return; }
    if (b.dataset.opt) return optimizeAsk(b.dataset.opt);
    if (b.dataset.dir) return directionsModal(b.dataset.dir);
    if (b.dataset.findstay) return staysModal(b.dataset.findstay);
    if (b.dataset.parkday) return parkPickModal(b.dataset.parkday);
    if (b.dataset.openpark) { const [a, c] = b.dataset.openpark.split("|"); parkSel = { iso: a, pid: c }; location.hash = `#/t/${cur.id}/parks`; return; }
    if (b.dataset.addnote) {
      const iso = b.dataset.addnote, id = uidGen(), all = dayItems(iso), order = all.length ? Math.max(...all.map(x => x.order ?? 0)) + 1 : 0;
      T.days[iso] = { ...(T.days[iso] || {}), cards: [...dayCards(iso), { id, text: "", time: "", order }] }; saveDay(iso);
      renderTrip(); document.getElementById("cn-" + id)?.focus(); return;
    }
    if (b.dataset.cdel) {
      const [iso, id] = b.dataset.cdel.split("|"), was = dayCards(iso);
      T.days[iso] = { ...T.days[iso], cards: was.filter(c => c.id !== id) }; saveDay(iso); renderTrip();
      if (was.find(c => c.id === id)?.text) toast("Note deleted.", { label: "Undo", run: () => { T.days[iso] = { ...T.days[iso], cards: was }; saveDay(iso); renderTrip(); } });
      return;
    }
    if (b.dataset.dcolor) { openColor = openColor === b.dataset.dcolor ? null : b.dataset.dcolor; renderTrip(); return; }
    if (b.dataset.setcol) { const iso = b.dataset.setcol; T.days[iso] = { ...(T.days[iso] || {}), color: b.dataset.c }; save(tp("days/" + iso), T.days[iso], 0); openColor = null; renderTrip(); renderMap(); return; }
    if (b.dataset.edit) return placeModal(b.dataset.edit);
    if (b.dataset.unsched) { const id = b.dataset.unsched; T.places[id] = { ...T.places[id], day: "", time: "" }; savePlace(id); renderTrip(); renderMap(); return; }
    if (b.dataset.up || b.dataset.down) {
      const id = b.dataset.up || b.dataset.down, iso = T.places[id].day, ids = dayPlaces(iso).map(p => p.id), i = ids.indexOf(id), j = i + (b.dataset.up ? -1 : 1);
      if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; reorderDay(iso, ids); renderTrip(); renderMap();
      document.querySelector(`[data-${b.dataset.up ? "up" : "down"}="${id}"]`)?.focus(); return;
    }
    if (b.dataset.zoom != null) lightbox(b.src);
  });
  v.addEventListener("keydown", e => { const f = e.target.closest("[data-focus]"); if (f && e.target === f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); f.click(); } });
  v.addEventListener("input", e => {
    if (e.target.dataset.card) { const [iso, id] = e.target.dataset.card.split("|"); growNote(e.target); T.days[iso] = { ...T.days[iso], cards: dayCards(iso).map(c => c.id === id ? { ...c, text: e.target.value.slice(0, 1000) } : c) }; saveDay(iso, 700); return; }
    if (e.target.dataset.notes) { const iso = e.target.dataset.notes; T.days[iso] = { ...(T.days[iso] || {}), notes: e.target.value.slice(0, 2000) }; save(tp("days/" + iso), T.days[iso], 700); }
  });
  v.addEventListener("change", e => {
    if (e.target.dataset.ctime) { const [iso, id] = e.target.dataset.ctime.split("|"); T.days[iso] = { ...T.days[iso], cards: dayCards(iso).map(c => c.id === id ? { ...c, time: e.target.value } : c) }; saveDay(iso, 300); }
    if (e.target.dataset.leg) { const id = e.target.dataset.leg; T.places[id] = { ...T.places[id], leg: e.target.value }; savePlace(id); e.target.blur(); renderTrip(); return; }
    if (e.target.dataset.time) { const id = e.target.dataset.time; T.places[id] = { ...T.places[id], time: e.target.value }; savePlace(id, 300); }
    if (e.target.dataset.mode) { const iso = e.target.dataset.mode; T.days[iso] = { ...(T.days[iso] || {}), mode: e.target.value }; save(tp("days/" + iso), T.days[iso], 0); e.target.blur(); renderTrip(); }
  });
  // smooth drag and drop (SortableJS): reorder within a day or move to another day
  if (window.Sortable) $$(".stops[data-drop]", v).forEach(list => Sortable.create(list, {
    group: "days", animation: 220, easing: "cubic-bezier(.2,.8,.2,1)", draggable: ".stop-wrap",
    filter: "input, button, select, textarea", preventOnFilter: false, delay: 140, delayOnTouchOnly: true, fallbackTolerance: 4,
    ghostClass: "sort-ghost", chosenClass: "sort-chosen", dragClass: "sort-drag", forceFallback: true, fallbackOnBody: true, scroll: true, scrollSensitivity: 90, bubbleScroll: true,
    onStart: () => { dragging = true; v.classList.add("is-dragging"); },
    onEnd: evt => {
      v.classList.remove("is-dragging");
      // skip the hidden copy Sortable leaves behind while dragging, and any repeats
      const ids = el => [...new Set($$(":scope > .stop-wrap", el).filter(li => li.style.display !== "none" && li.dataset.id).map(li => li.dataset.id))];
      const to = evt.to.dataset.drop, from = evt.from.dataset.drop;
      if (to) reorderDay(to, ids(evt.to));   // dropped onto the saved-places list instead: that list unschedules it
      if (from && from !== to) reorderDay(from, ids(evt.from));
      dragging = false; pendingRender = false;
      requestAnimationFrame(() => { renderTrip(); renderMap(); });
    },
  }));
  if (openAdd && $("#add-" + openAdd)) wireAdd(openAdd);
  $$(".dnote textarea", v).forEach(growNote);
}
const growNote = el => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
function focusDay(iso) { mapFocus = iso; fitPending = true; renderTrip(); renderMap(); }

// ---------------------------------------------------------------- ideas nearby (Wikipedia: popular articles with coordinates near the day)
let openIdeas = null;
const ideasCache = {}, ideasWhere = {};
function ideasCenter(iso) {
  if (ideasWhere[iso]) return ideasWhere[iso];
  const pts = dayPlaces(iso).filter(hasPt);
  const nameOfCenter = list => { const m = {}; list.forEach(p => { const c = p.type === "city" ? p.name : p.city; if (c) m[c] = (m[c] || 0) + 1; }); return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || ""; };
  if (pts.length) return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length, name: nameOfCenter(pts) };
  const stay = stayFor(iso); if (stay && stay[1].lat != null) return { lat: stay[1].lat, lon: stay[1].lon, name: (stay[1].addr || "").split(",").slice(-1)[0].trim() || stay[1].title };
  const days = tripDays(), i = days.indexOf(iso);
  for (let d = 1; d < days.length; d++) for (const j of [i - d, i + d]) { const ps = days[j] ? dayPlaces(days[j]).filter(hasPt) : []; if (ps.length) return { lat: ps[0].lat, lon: ps[0].lon, name: nameOfCenter(ps) }; }
  return T.trip?.dest && hasPt(T.trip.dest) ? { lat: T.trip.dest.lat, lon: T.trip.dest.lon, name: T.trip.dest.name } : null;
}
const SKIP = /\b(station|railway|tube|underground|metro|bus|street|road|avenue|lane|district|ward|constituency|electoral|parish|borough of|area of|neighbourhood|neighborhood|suburb|school|college|university|hospital|company|headquarters|office building|embassy|hotel|apartment|residential|housing|cemetery|bridge over)\b/i;
function ideaType(desc) {
  const d = String(desc || "").toLowerCase();
  if (/museum|gallery/.test(d)) return "museum";
  if (/market/.test(d)) return "market";
  if (/park|garden|beach|lake|river|hill|mountain|viewpoint|nature|forest|island/.test(d)) return "nature";
  if (/theatre|theater|stadium|zoo|aquarium|concert|opera|arena|cinema/.test(d)) return "experience";
  if (/bookshop|bookstore|department store|shop|store|boutique|mall/.test(d)) return "shop";
  if (/restaurant/.test(d)) return "food";
  if (/caf[eé]|bakery|tea room/.test(d)) return "cafe";
  if (/\bpub\b|\bbar\b|nightclub/.test(d)) return "night";
  return "sight";
}
async function loadIdeas(iso) {
  const c = ideasCenter(iso), key = c ? `${c.lat.toFixed(3)},${c.lon.toFixed(3)}` : "";
  if (!c) { ideasCache[iso] = { err: "Add a place to this day (or a destination in Overview) and ideas will show up around it." }; renderTrip(); return; }
  if (ideasCache[key]) { ideasCache[iso] = { key }; renderTrip(); return; }
  ideasCache[iso] = { loading: true, key }; renderTrip();
  try {
    const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${c.lat}|${c.lon}&ggsradius=10000&ggslimit=80&prop=pageimages|description|coordinates|pageviews&piprop=thumbnail&pithumbsize=320&pvipdays=30&pvipmetric=pageviews`;
    const j = await (await fetch(u)).json();
    const have = new Set(placeList().map(p => p.name.toLowerCase()));
    const list = Object.values(j?.query?.pages || {}).map(pg => ({
      title: pg.title, desc: pg.description || "", thumb: pg.thumbnail?.source || "", lat: pg.coordinates?.[0]?.lat, lon: pg.coordinates?.[0]?.lon,
      views: Object.values(pg.pageviews || {}).reduce((a, v) => a + (v || 0), 0),
    })).filter(x => x.lat != null && !SKIP.test(x.desc) && !SKIP.test(x.title) && !/^List of|^\d/.test(x.title) && x.desc && !have.has(x.title.toLowerCase()))
      .sort((a, b) => b.views - a.views).slice(0, 12);
    ideasCache[key] = { list, name: c.name }; ideasCache[iso] = { key };
  } catch { ideasCache[iso] = { err: navigator.onLine ? "Couldn't load ideas right now. Try again in a moment." : "Ideas need an internet connection." }; }
  if (openIdeas === iso) renderTrip();
}
function ideasHtml(iso) {
  const st = ideasCache[iso] || {}, data = st.key ? ideasCache[st.key] : null, c = ideasCenter(iso);
  const where = data?.name || c?.name || "here";
  let body;
  if (st.err) body = `<p class="hint">${esc(st.err)}</p>`;
  else if (st.loading || !data) body = `<p class="hint">Finding popular places near ${esc(where)}…</p>`;
  else if (!data.list.length) body = `<p class="hint">No ideas found near ${esc(where)}. Try another area.</p>`;
  else body = `<div class="ideas">${data.list.map((x, n) => `<div class="idea">
      <span class="thumb">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : esc(x.title.charAt(0))}</span>
      <span class="info"><b>${esc(x.title)}</b><small>${esc(x.desc)}</small></span>
      <span class="idea-btns"><button class="btn small" type="button" data-idea="${n}" data-how="day" aria-label="Add ${esc(x.title)} to this day">+ Add</button><button class="btn ghost small" type="button" data-idea="${n}" data-how="save" aria-label="Save ${esc(x.title)} for later">Save</button></span></div>`).join("")}</div>`;
  return `<div class="ideas-box" data-ideas-for="${iso}"><div class="row between"><h3>Popular near ${esc(where)}</h3><button class="linkbtn" type="button" data-ideas-where="${iso}">Somewhere else?</button></div>${body}<p class="hint" style="font-size:11.5px">Ranked by how often people read about them on Wikipedia.</p></div>`;
}
function useIdea(n, how, iso) {
  const data = ideasCache[ideasCache[iso]?.key]; const x = data?.list?.[+n]; if (!x) return;
  const id = addPlace({ name: x.title, type: ideaType(x.desc), city: data.name || "", country: "", lat: x.lat, lon: x.lon }, how === "day" ? { day: iso, order: dayPlaces(iso).length, notes: x.desc } : { notes: x.desc });
  data.list.splice(+n, 1);
  toast(how === "day" ? `Added ${esc(x.title)} to ${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}.` : `Saved ${esc(x.title)} to Places.`);
  renderTrip(); renderMap();
}
function ideasWherePrompt(iso) {
  const box = $(`[data-ideas-for="${iso}"]`); if (!box) return;
  box.insertAdjacentHTML("afterbegin", `<div class="suggest-wrap" style="margin-bottom:8px"><input id="iw-${iso}" autocomplete="off" placeholder="Show ideas near… (a city or neighborhood)" role="combobox" aria-expanded="false" aria-controls="iwl-${iso}"><ul class="suggest" id="iwl-${iso}" role="listbox" hidden></ul></div>`);
  const inp = $("#iw-" + iso); inp.focus();
  attachSuggest(inp, $("#iwl-" + iso), { onPick: x => { ideasWhere[iso] = { lat: x.lat, lon: x.lon, name: x.name }; loadIdeas(iso); } });
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
const PF = { q: "", type: "", sched: "", city: "", country: "" };
function viewPlaces(v) {
  const all = placeList(), days = tripDays();
  backfillCountries();
  const L = all.filter(p => (!PF.type || p.type === PF.type) && (!PF.city || p.city === PF.city) && (!PF.country || p.country === PF.country) &&
    (!PF.sched || (PF.sched === "yes" ? days.includes(p.day) : !days.includes(p.day))) &&
    (!PF.q || [p.name, p.notes, p.city, p.country, TYPE[p.type].label].join(" ").toLowerCase().includes(PF.q.toLowerCase())))
    .sort((a, b) => Object.keys(b.hearts).length - Object.keys(a.hearts).length || (b.created || 0) - (a.created || 0));
  const count = f => { const m = {}; all.forEach(p => { const k = f(p); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])); };
  const chips = (key, items) => `<div class="chips" data-f="${key}"><button type="button" class="chip ${!PF[key] ? "on" : ""}" data-v="">All</button>${items.map(([v, l, n]) => `<button type="button" class="chip ${PF[key] === v ? "on" : ""}" data-v="${esc(v)}">${esc(l)}<span class="n">${n}</span></button>`).join("")}</div>`;
  v.innerHTML = `<div class="row between"><h2>Places</h2><button class="btn ghost small" type="button" id="fillPh" ${all.some(p => !photoSrcOf(p)) ? "" : "hidden"}>Find missing photos</button></div>
    <div class="card" style="display:grid;gap:8px"><h3 style="color:var(--accent)">Add a place</h3>
      <div class="suggest-wrap"><input id="pq" autocomplete="off" placeholder="Search anywhere, e.g. Sagrada Família, a café, a beach…" role="combobox" aria-expanded="false" aria-controls="pql" data-live><ul class="suggest" id="pql" role="listbox" hidden></ul></div>
      <p class="hint">Picked places get their type, location, a Google Maps link and a photo when one is free to use. Can't find the right branch? Add the neighborhood or street, or paste a Google Maps link or coordinates (in Google Maps, press and hold the spot to copy them). <button class="linkbtn" type="button" id="manual">Add one by hand</button></p></div>
    ${all.length ? `<div class="card filters">
      <input class="input" id="pfq" type="search" placeholder="Filter by name, note or city" value="${esc(PF.q)}" data-live>
      ${chips("type", TYPES.map(([k, l]) => [k, l, all.filter(p => p.type === k).length]).filter(x => x[2]))}
      ${count(p => p.country).length > 1 ? chips("country", count(p => p.country).map(([c, n]) => [c, c, n])) : ""}
      ${count(p => (!PF.country || p.country === PF.country) && p.city).length > 1 ? chips("city", count(p => (!PF.country || p.country === PF.country) ? p.city : "").map(([c, n]) => [c, c, n])) : ""}
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
    if (chip) { const k = chip.parentElement.dataset.f; PF[k] = PF[k] === chip.dataset.v ? "" : chip.dataset.v; if (k === "country") PF.city = ""; renderTrip(); renderMap(); return; }
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
      ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ""}${reminderFacts(p.id)}
      <div class="place-foot"><button class="heart ${mine ? "on" : ""}" type="button" data-heart aria-pressed="${mine}" title="${esc(who.join(", "))}">♥ ${who.length || ""}</button>
        <select data-pday aria-label="Schedule ${esc(p.name)}">${dayOptions(tripDays().includes(p.day) ? p.day : "")}</select><span class="grow"></span>
        ${hasPt(p) ? `<button class="ext" type="button" data-locate style="border:0;background:none;cursor:pointer">Map</button>` : ""}
        ${link ? `<a class="ext" href="${esc(link)}" target="_blank" rel="noopener">${/google\.[a-z.]+\/maps/.test(link) ? "Maps ↗" : "Link ↗"}</a>` : ""}
        ${cmtBtn(p)}<button class="ext" type="button" data-edit style="border:0;background:none;cursor:pointer">Edit</button></div></div></article>`;
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
    <div class="grid2"><label class="field" for="pmBookBy">Book by<input id="pmBookBy" type="date" value="${esc(p?.bookBy || "")}"></label><label class="field" for="pmBookNote">What to book<input id="pmBookNote" maxlength="80" value="${esc(p?.bookNote || "")}" placeholder="Tickets go on sale, reserve a table…"></label></div>
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
      if ((lat == null || !country) && city) { try { const hits = await searchPlaces(city, nearPoint(null)), hit = hits.find(h => h.type === "city") || hits[0]; if (hit) { if (lat == null) { lat = hit.lat; lon = hit.lon; } country = country || hit.country; } } catch {} }
      if (!country && lat != null) country = (await reverseGeo(lat, lon))?.country || "";
      const base = p || newPlaceFrom({ name });
      const pid = id || uidGen();
      T.places[pid] = { ...base, name, type: $("#pmType").value, city, country, lat, lon, link: $("#pmLink").value.trim().slice(0, 500), notes: $("#pmNotes").value.trim().slice(0, 600),
        day, time: $("#pmTime").value, bookBy: validIso($("#pmBookBy").value) ? $("#pmBookBy").value : "", bookNote: $("#pmBookNote").value.trim().slice(0, 80), order: day && day !== base.day ? dayPlaces(day).length : base.order ?? 0,
        photo: ph?.photo || "", photoUrl: ph?.photoUrl || "", photoCredit: ph?.photoCredit || "", photoLink: ph?.photoLink || "", photoBy: ph?.photoBy || "", photoSrc: ph?.photoSrc || "" };
      if (ph?.dl) trackUnsplash(ph.dl);
      savePlace(pid); closeModal(); renderTrip(); renderMap();
    };
  });
}

// ================================================================ BOOKINGS
const BF = { kind: "" };
let bkFocus = null;   // flight shown alone on the map
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
      <button class="btn small" type="button" data-new="flight">+ Flight</button><button class="btn ghost small" type="button" data-new="train">+ Train</button><button class="btn ghost small" type="button" data-new="lodging">+ Stay</button><button class="btn ghost small" type="button" id="findStays">Find stays nearby</button><button class="btn ghost small" type="button" id="gmailBtn">Import from Gmail</button><button class="btn ghost small" type="button" data-new="reservation">+ Reservation</button><button class="btn ghost small" type="button" data-new="other">+ Other</button></div></div>
    ${all.length ? `<div class="chips"><button type="button" class="chip ${!BF.kind ? "on" : ""}" data-bf="">All</button>${groups.map(([g, l]) => { const n = all.filter(([, b]) => (KINDS[b.kind] || KINDS.other).group === g).length; return n ? `<button type="button" class="chip ${BF.kind === g ? "on" : ""}" data-bf="${g}">${l}<span class="n">${n}</span></button>` : ""; }).join("")}</div>` : ""}
    ${L.map(([id, b]) => bookingCard(id, b)).join("") || `<div class="empty">Keep flights, trains, stays and reservations here, with times and confirmation numbers. They show up on the right days in the itinerary.</div>`}`;
  $("#findStays").onclick = () => staysModal();
  $("#gmailBtn").onclick = gmailModal;
  v.addEventListener("click", e => {
    const n = e.target.closest("[data-new]"); if (n) return bookingModal(null, n.dataset.new);
    const f = e.target.closest("[data-bf]"); if (f) { BF.kind = f.dataset.bf; renderTrip(); return; }
    const ed = e.target.closest("[data-bedit]"); if (ed) return bookingModal(ed.dataset.bedit);
    const st = e.target.closest("[data-stat]"); if (st) { st.disabled = true; st.textContent = "Checking…"; refreshStatus(st.dataset.stat); return; }
    const w = e.target.closest("[data-watch]"); if (w) return toggleWatch(w.dataset.watch);
    const fr = e.target.closest("[data-froute]"); if (fr) { bkFocus = bkFocus === fr.dataset.froute ? null : fr.dataset.froute; fitPending = true; renderTrip(); renderMap(); if (bkFocus && innerWidth <= 960) { document.body.classList.add("show-map"); $("#mapToggle").textContent = "List"; map?.invalidateSize(); } return; }
    const c = e.target.closest("[data-copy]"); if (c) { navigator.clipboard?.writeText(c.dataset.copy).then(() => toast("Copied " + esc(c.dataset.copy)), () => {}); }
  });
}
function bookingCard(id, b) {
  const k = KINDS[b.kind] || KINDS.other, cost = num(b.cost);
  const conf = b.conf ? `<span>Confirmation <b class="copy mono" data-copy="${esc(b.conf)}" title="Copy">${esc(b.conf)}</b></span>` : "";
  const cc = b.costCur || homeCur(), costTxt = cc === homeCur() ? money(cost) : `${fmtCur(cost, cc)}${b.costRate && b.home === homeCur() ? " (≈ " + money(cost * b.costRate) + ")" : ""}`;
  const money_ = cost ? `<span>Cost <b>${costTxt}</b>${b.paidBy ? " · paid by " + esc(nameOf(b.paidBy)) : ""}${b.planned ? " · estimate" : ""}</span>` : "";
  let body = "";
  if (k.group === "transport" || k.group === "car") {
    const plus = b.arrDate && b.depDate && b.arrDate !== b.depDate ? ` (+${daysBetween(b.depDate, b.arrDate)})` : "";
    const via = (b.stops || []).filter(s => (s.at || "").trim());
    const wait = via.reduce((a, s) => a + parseDur(s.dur), 0);
    body = `<div class="bk-route"><div class="end"><b>${esc(b.from || "—")}</b><span>${esc(fmtD(b.depDate, { weekday: "short", month: "short", day: "numeric" }))} ${esc(b.depTime || "")}</span></div>
      <div class="mid">${via.length ? `via ${via.map(s => esc(s.at) + (parseDur(s.dur) ? " " + fmtMin(parseDur(s.dur)) : "")).join(", ")}` : (k.group === "car" ? "rental" : "nonstop")}</div>
      <div class="end r"><b>${esc(b.to || "—")}</b><span>${esc(fmtD(b.arrDate, { weekday: "short", month: "short", day: "numeric" }))} ${esc(b.arrTime || "")}${plus}</span></div></div>
      <div class="bk-facts">${b.legs?.length > 1 ? `<span>Flights <b>${esc(b.legs.map(l => l.num).filter(Boolean).join(", ") || "—")}</b></span>` : b.num ? `<span>${k.group === "car" ? "Company" : "Number"} <b>${esc(b.num)}</b></span>` : ""}${b.seats ? `<span>Seats <b>${esc(b.seats)}</b></span>` : ""}${wait ? `<span>Layovers <b>${fmtMin(wait)}</b></span>` : ""}${conf}${money_}</div>`;
  } else if (k.group === "lodging") {
    const nights = validIso(b.checkIn) && validIso(b.checkOut) ? daysBetween(b.checkIn, b.checkOut) : 0;
    body = `<div class="bk-route"><div class="end"><b style="font-size:15px">${esc(fmtD(b.checkIn, { weekday: "short", month: "short", day: "numeric" }) || "—")}</b><span>Check in ${esc(b.checkInTime || "")}</span></div><div class="mid">${nights ? nights + " night" + (nights === 1 ? "" : "s") : ""}</div><div class="end r"><b style="font-size:15px">${esc(fmtD(b.checkOut, { weekday: "short", month: "short", day: "numeric" }) || "—")}</b><span>Check out ${esc(b.checkOutTime || "")}</span></div></div>
      <div class="bk-facts">${b.addr ? `<span>${esc(b.addr)}</span>` : ""}${conf}${money_}</div>`;
  } else {
    body = `<div class="bk-facts"><span><b>${esc(fmtD(b.date, { weekday: "short", month: "short", day: "numeric" }) || "No date")}</b>${b.time ? " · " + esc(b.time) : ""}</span>${b.addr ? `<span>${esc(b.addr)}</span>` : ""}${conf}${money_}</div>`;
  }
  if (k.group === "transport") body += statusHtml(id, b);
  const extra = reminderFacts(id) + loyaltyHtml(b); if (extra) body += `<div class="bk-extra">${extra}</div>`;
  return `<article class="bk ${bkFocus === id ? "focus" : ""}" id="bk-${id}" style="--bc:${k.col}"><div class="bk-top"><div><div class="bk-kind">${esc(k.label)}</div><div class="bk-title">${esc(b.title || k.label)}</div></div><button class="btn ghost small" type="button" data-bedit="${id}">Edit</button></div>${body}${b.notes ? `<p class="hint">${esc(b.notes)}</p>` : ""}</article>`;
}
function bookingModal(id, kind, prefill = {}) {
  const b = id ? T.bookings[id] : { kind, split: members(), ...prefill };
  // flights are edited as legs; an older flight with layovers is split into legs (times in between left blank)
  let legs = b.legs?.length ? b.legs.map(l => ({ ...l })) : (() => {
    const names = [b.from || (!id && PROFILE.homeAirport) || "", ...(b.stops || []).map(x => x.at), b.to || ""];
    return names.slice(0, -1).map((f, i, arr) => ({ from: f, to: names[i + 1], num: i ? "" : b.num || "", seat: i ? "" : b.seats || "",
      depDate: i ? "" : b.depDate || "", depTime: i ? "" : b.depTime || "", arrDate: i === arr.length - 1 ? b.arrDate || "" : "", arrTime: i === arr.length - 1 ? b.arrTime || "" : "" }));
  })();
  let k = b.kind || "flight", stops = (b.stops || []).map(s => ({ ...s })), loc = b.lat != null ? { lat: b.lat, lon: b.lon } : null, armed = false;
  const fld = (key, label, type = "text", ph = "", extra = "") => `<label class="field" for="bm-${key}">${label}<input id="bm-${key}" data-k="${key}" type="${type}" value="${esc(b[key] ?? "")}" placeholder="${esc(ph)}" ${extra}></label>`;
  openModal(`<div class="row between"><h2>${id ? "Edit booking" : "Add a booking"}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <label class="field" for="bm-kind">Kind<select id="bm-kind">${Object.entries(KINDS).map(([key, x]) => `<option value="${key}" ${key === k ? "selected" : ""}>${x.label}</option>`).join("")}</select></label>
    ${fld("title", "Title", "text", "e.g. Honolulu → London, Hotel Arts, Dinner at Dishoom", 'maxlength="80"')}
    <div data-nf data-g="transport car" class="grid2">${fld("from", "From", "text", "HNL or a station", 'maxlength="50"')}${fld("to", "To", "text", "LHR", 'maxlength="50"')}</div>
    <div data-nf data-g="transport car" class="grid2">${fld("depDate", "Departs", "date")}${fld("depTime", "Time", "time")}</div>
    <div data-nf data-g="transport car" class="grid2">${fld("arrDate", "Arrives", "date")}${fld("arrTime", "Time", "time")}</div>
    <div data-nf data-g="transport car" class="grid2">${fld("num", "Flight / train number or company", "text", "AS 841", 'maxlength="30"')}${fld("seats", "Seats", "text", "32A, 32B", 'maxlength="30"')}</div>
    <div data-nf data-g="transport" class="field"><span>Layovers</span><div class="stops-ed" id="bmStops"></div><button class="linkbtn" type="button" id="bmAddStop" style="justify-self:start">+ Add a layover</button></div>
    <div data-g="flight" class="field"><span>Flights</span><div class="legs-ed" id="bmLegs"></div><button class="linkbtn" type="button" id="bmAddLeg" style="justify-self:start">+ Add a connecting flight</button></div>
    <div data-g="lodging" class="grid2">${fld("checkIn", "Check in", "date")}${fld("checkInTime", "Time", "time")}</div>
    <div data-g="lodging" class="grid2">${fld("checkOut", "Check out", "date")}${fld("checkOutTime", "Time", "time")}</div>
    <div data-g="event" class="grid2">${fld("date", "Date", "date")}${fld("time", "Time", "time")}</div>
    <div data-g="lodging event" class="field"><label for="bm-addr">Address or place</label><div class="suggest-wrap"><input id="bm-addr" data-k="addr" value="${esc(b.addr || "")}" autocomplete="off" placeholder="Search to pin it on the map" role="combobox" aria-expanded="false" aria-controls="bmAddrL"><ul class="suggest" id="bmAddrL" role="listbox" hidden></ul></div></div>
    ${fld("conf", "Confirmation number", "text", "ABC123", 'maxlength="40"')}
    <div class="grid2">${fld("cancelBy", "Free cancellation until", "date")}
      <label class="field" data-g="flight" for="bm-checkinH">Online check-in opens<select id="bm-checkinH" data-k="checkinH">${[["24", "24 hours before"], ["48", "48 hours before"], ["72", "72 hours before"], ["30", "30 hours before"], ["0", "Don't remind me"]].map(([v, l]) => `<option value="${v}" ${String(b.checkinH || "24") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="grid3">${fld("cost", "Total cost", "number", "0", 'min="0" step="0.01"')}
      <label class="field" for="bm-costCur">Currency<select id="bm-costCur">${CURRENCIES.map(c => `<option ${c === (b.costCur || homeCur()) ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field" for="bm-paidBy">Paid by<select id="bm-paidBy" data-k="paidBy"><option value="">—</option>${members().map(e => `<option value="${esc(e)}" ${b.paidBy === e ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select></label>
    </div>
    <div class="fx-row" id="bmFx"><span id="bmLab">1 EUR =</span><input id="bm-rate" type="number" min="0" step="any" value="${esc(b.home === homeCur() && b.costRate ? b.costRate : "")}" aria-label="Exchange rate"><span id="bmHome">USD</span><b id="bmOut"></b><span class="hint" id="bmSrc"></span></div>
    <label class="row" style="gap:8px;font-weight:600"><input type="checkbox" id="bm-planned" ${b.planned ? "checked" : ""}> Just an estimate (not paid yet)</label>
    <div class="field"><span>Split between</span><div class="splitbox">${members().map(e => `<label><input type="checkbox" data-split value="${esc(e)}" ${(b.split || members()).includes(e) ? "checked" : ""}> ${esc(nameOf(e))}</label>`).join("")}</div></div>
    <label class="field" for="bm-notes">Notes<textarea id="bm-notes" data-k="notes" rows="2" maxlength="600">${esc(b.notes || "")}</textarea></label>
    <div class="row between">${id ? `<button class="btn danger" type="button" id="bmDel">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="bmSave">Save</button></div></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    const groupShow = () => { const g = (KINDS[k] || KINDS.other).group; $$("[data-g]", m).forEach(el => { const gs = el.dataset.g.split(" "); el.hidden = !(gs.includes(g) || gs.includes(k)) || (k === "flight" && el.hasAttribute("data-nf")); }); };
    const lf = (i, f, label, type = "text", ph = "", extra = "") => `<label class="field">${label}<input class="input" data-li="${i}" data-lf="${f}" type="${type}" value="${esc(legs[i][f] || "")}" placeholder="${ph}" ${extra}></label>`;
    const paintLegs = () => {
      $("#bmLegs").innerHTML = legs.map((l, i) => {
        const g = i ? gapMins(legs[i - 1], l) : null;
        return `${i ? `<div class="leg-lay">Layover in <b>${esc(l.from || "?")}</b>${g != null ? (g > 0 ? " · " + fmtMin(g) : " · the next flight leaves before this one lands") : ""}</div>` : ""}
        <div class="leg-ed"><div class="row between"><b>Flight ${i + 1}</b>${legs.length > 1 ? `<button class="iconbtn del" type="button" data-rl="${i}" aria-label="Remove flight ${i + 1}">×</button>` : ""}</div>
          <div class="grid3">${lf(i, "from", "From", "text", "ITO", 'maxlength="50"')}${lf(i, "to", "To", "text", "HNL", 'maxlength="50"')}${lf(i, "num", "Flight number", "text", "HA 123", 'maxlength="12"')}</div>
          <div class="grid4">${lf(i, "depDate", "Departs", "date")}${lf(i, "depTime", "Time", "time")}${lf(i, "arrDate", "Arrives", "date")}${lf(i, "arrTime", "Time", "time")}</div>
          ${lf(i, "seat", "Seats", "text", "32A, 32B", 'maxlength="30"')}</div>`;
      }).join("");
    };
    paintLegs();
    $("#bmAddLeg").onclick = () => { const p = legs[legs.length - 1]; legs.push({ from: p.to || "", to: "", num: "", seat: "", depDate: p.arrDate || p.depDate || "", depTime: "", arrDate: "", arrTime: "" }); paintLegs(); $(`[data-li="${legs.length - 1}"][data-lf="to"]`, m)?.focus(); };
    $("#bmLegs").addEventListener("input", e => { const i = e.target.dataset.li; if (i == null) return; legs[+i][e.target.dataset.lf] = e.target.value.trim(); });
    $("#bmLegs").addEventListener("change", e => {
      const i = e.target.dataset.li; if (i == null) return; const l = legs[+i], f = e.target.dataset.lf;
      if (f === "depDate" && !l.arrDate) l.arrDate = l.depDate;
      if (f === "to" && legs[+i + 1] && !legs[+i + 1].from) legs[+i + 1].from = l.to;
      if (f === "arrDate" && legs[+i + 1] && !legs[+i + 1].depDate) legs[+i + 1].depDate = l.arrDate;
      const keep = document.activeElement?.dataset; paintLegs();
      if (keep?.li != null) $(`[data-li="${keep.li}"][data-lf="${keep.lf}"]`, m)?.focus();
    });
    $("#bmLegs").addEventListener("click", e => { const r = e.target.closest("[data-rl]"); if (r) { legs.splice(+r.dataset.rl, 1); paintLegs(); } });
    const paintStops = () => { $("#bmStops").innerHTML = stops.map((s, i) => `<div class="stop-ed"><input class="input" data-si="${i}" data-sf="at" value="${esc(s.at || "")}" placeholder="Airport / station" aria-label="Layover place"><input class="input" data-si="${i}" data-sf="dur" value="${esc(s.dur || "")}" placeholder="2h 30m" aria-label="Layover length"><button class="iconbtn del" type="button" data-rs="${i}" aria-label="Remove layover">×</button></div>`).join(""); };
    groupShow(); paintStops();
    const fx = rateWidget(m, { amt: "#bm-cost", cur: "#bm-costCur", rate: "#bm-rate", row: "#bmFx", out: "#bmOut", lab: "#bmLab", home: "#bmHome", src: "#bmSrc" }, () => (k === "flight" ? legs[0]?.depDate : "") || $("#bm-depDate").value || $("#bm-checkIn").value || $("#bm-date").value);
    if ($("#bm-costCur").value !== homeCur() && !$("#bm-rate").value) fx.fetchRate();
    $("#bm-kind").onchange = e => { k = e.target.value; groupShow(); };
    $("#bmAddStop").onclick = () => { stops.push({ at: "", dur: "" }); paintStops(); $(`[data-si="${stops.length - 1}"]`, m)?.focus(); };
    $("#bmStops").addEventListener("input", e => { const i = e.target.dataset.si; if (i != null) stops[+i][e.target.dataset.sf] = e.target.value.slice(0, 50); });
    $("#bmStops").addEventListener("click", e => { const r = e.target.closest("[data-rs]"); if (r) { stops.splice(+r.dataset.rs, 1); paintStops(); } });
    $("#bm-depDate").addEventListener("change", e => { if (!$("#bm-arrDate").value) $("#bm-arrDate").value = e.target.value; });
    attachSuggest($("#bm-addr"), $("#bmAddrL"), { near: () => nearPoint(null), onPick: async x => { loc = { lat: x.lat, lon: x.lon }; $("#bm-addr").value = (x.full ? [x.name, x.addr] : [x.name, x.addr, x.city, x.country]).filter(Boolean).join(", "); if (!$("#bm-title").value) $("#bm-title").value = x.name;
      const y = await withAddress(x); if (loc?.lat === x.lat && y.addr !== x.addr) $("#bm-addr").value = [y.name, y.addr, y.city, y.country].filter(Boolean).join(", "); } });
    $("#bm-addr").addEventListener("input", () => { loc = null; });
    if (id) $("#bmDel").onclick = () => { if (!armed) { armed = true; $("#bmDel").textContent = "Tap again to delete"; return; } delete T.bookings[id]; remove(tp("bookings/" + id)); closeModal(); renderTrip(); renderMap(); };
    $("#bmSave").onclick = () => {
      const out = { kind: k };
      $$("[data-k]", m).forEach(el => { if (!el.closest("[data-g]") || !el.closest("[data-g]").hidden) out[el.dataset.k] = el.value.trim(); });
      out.cost = num(out.cost); out.costCur = $("#bm-costCur").value; out.costRate = out.costCur === homeCur() ? 1 : num($("#bm-rate").value); out.home = homeCur();
      if (out.cost && !out.costRate) { $("#bm-rate").focus(); $("#bmSrc").textContent = `Add the exchange rate from ${out.costCur} to ${homeCur()} to save.`; return; }
      out.planned = $("#bm-planned").checked; out.split = $$("[data-split]", m).filter(x => x.checked).map(x => x.value);
      out.stops = (KINDS[k] || KINDS.other).group === "transport" ? stops.filter(s => (s.at || "").trim()) : [];
      if (k === "flight") {
        const L2 = legs.filter(l => l.from || l.to || l.num || l.depDate);
        if (!L2.length) L2.push({ from: "", to: "", num: "", seat: "", depDate: "", depTime: "", arrDate: "", arrTime: "" });
        const f0 = L2[0], fl = L2[L2.length - 1];
        Object.assign(out, { legs: L2, from: f0.from, to: fl.to, depDate: f0.depDate, depTime: f0.depTime, arrDate: fl.arrDate, arrTime: fl.arrTime, num: f0.num, seats: [...new Set(L2.map(l => l.seat).filter(Boolean))].join(" / "),
          stops: L2.slice(1).map((l, i) => { const g = gapMins(L2[i], l); return { at: l.from || L2[i].to, dur: g > 0 ? fmtMin(g) : "" }; }) });
      }
      out.lat = loc?.lat ?? null; out.lon = loc?.lon ?? null;
      if (!out.title) out.title = out.from && out.to ? `${out.from} → ${out.to}` : (KINDS[k] || KINDS.other).label;
      out.created = b.created || Date.now();
      const bid = id || uidGen(); T.bookings[bid] = out; save(tp("bookings/" + bid), out, 0);
      closeModal(); renderTrip(); renderMap();
    };
  });
}

// ================================================================ FLIGHTS: airports, route map, tracking, live status
let AP = null, apLoading = null;
function loadAirports() {
  if (AP) return Promise.resolve(AP);
  return apLoading ||= fetch("airports.json").then(r => r.json()).then(j => { AP = j; if (cur) renderMap(); return AP; }).catch(() => { apLoading = null; return null; });
}
// "HNL", "Honolulu (HNL)", "hnl" or a city name → an airport
function airportOf(txt) {
  if (!AP) return null;
  const t = String(txt || "").trim(); if (!t) return null;
  const m = t.match(/\b([A-Z]{3})\b/) || (/^[a-z]{3}$/i.test(t) ? [0, t.toUpperCase()] : null);
  if (m && AP[m[1]]) { const [name, city, cc, lat, lon] = AP[m[1]]; return { code: m[1], name, city, cc, lat, lon }; }
  const q = t.toLowerCase().replace(/\s*airport.*$/, "");
  let best = null;
  for (const [code, [name, city, cc, lat, lon]] of Object.entries(AP)) {
    const c = (city || "").toLowerCase(), n = name.toLowerCase();
    if (c === q || c.startsWith(q + ",") || n === q || n.startsWith(q + " ")) { const score = /international/i.test(name) ? 2 : 1; if (!best || score > best.score) best = { score, code, name, city, cc, lat, lon }; }
  }
  return best;
}
const flightLegsOf = b => [b.from, ...(b.stops || []).map(s => s.at), b.to].map(airportOf);
// great-circle arc, with longitudes unwrapped so it doesn't jump across the map at the date line
function arc(a, b, n = 48) {
  const r = Math.PI / 180, [p1, l1, p2, l2] = [a.lat * r, a.lon * r, b.lat * r, b.lon * r];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  if (!d) return [[a.lat, a.lon]];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2), y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2), z = A * Math.sin(p1) + B * Math.sin(p2);
    out.push([Math.atan2(z, Math.hypot(x, y)) / r, Math.atan2(y, x) / r]);
  }
  for (let i = 1; i < out.length; i++) { while (out[i][1] - out[i - 1][1] > 180) out[i][1] -= 360; while (out[i][1] - out[i - 1][1] < -180) out[i][1] += 360; }
  return out;
}
// layover labels sit above their airport so close airports (like Hilo and Honolulu) don't hide each other
const apIcon = (code, kind) => L.divIcon({ className: "", html: `<div class="ap-mk ${kind}">${esc(code)}</div>`, iconSize: [40, 20], iconAnchor: kind === "via" ? [20, 28] : [20, 10], popupAnchor: [0, -10] });
// draws one flight (with its layovers) on the map; returns the points for fitting the view
function drawFlight(b, color) {
  const segs = flightSegs(b), names = b.legs?.length ? [segs[0].from, ...segs.map(l => l.to)] : [b.from, ...(b.stops || []).map(x => x.at), b.to];
  const legs = names.map(airportOf), pts = [];
  let prev = null, prevLon = 0;   // previous airport, and the longitude it was drawn at
  legs.forEach((ap, i) => {
    if (!ap) return;
    let lon = ap.lon;
    if (prev) {
      const line = arc(prev, ap), off = prevLon - line[0][1];
      line.forEach(q => { q[1] += off; pts.push(q); });
      L.polyline(line, { color, weight: 2.5, opacity: .9, dashArray: "7 7" }).addTo(layer);
      lon = line[line.length - 1][1];
    }
    const kind = i === 0 ? "dep" : i === legs.length - 1 ? "arr" : "via";
    const inn = b.legs?.length ? segs[i - 1] : null, out = b.legs?.length ? segs[i] : null, st = (b.stops || [])[i - 1];
    const when = (l, w) => l ? `${w} ${esc(fmtD(w === "Depart" ? l.depDate : l.arrDate))} ${esc((w === "Depart" ? l.depTime : l.arrTime) || "")}${l.num && w === "Depart" ? " · " + esc(l.num) : ""}` : "";
    let line2;
    if (kind === "dep") line2 = out ? when(out, "Depart") : `Depart ${esc(fmtD(b.depDate))} ${esc(b.depTime || "")}`;
    else if (kind === "arr") line2 = inn ? when(inn, "Arrive") : `Arrive ${esc(fmtD(b.arrDate))} ${esc(b.arrTime || "")}`;
    else if (inn && out) { const g = gapMins(inn, out); line2 = `${when(inn, "Arrive")}<br>${when(out, "Depart")}${g != null && g > 0 ? `<br><b>Layover ${fmtMin(g)}</b>` : ""}`; }
    else line2 = `Layover${st && parseDur(st.dur) ? " " + fmtMin(parseDur(st.dur)) : ""}`;
    L.marker([ap.lat, lon], { icon: apIcon(ap.code, kind), keyboard: true }).addTo(layer).bindPopup(`<b>${esc(ap.code)}</b> · ${esc(ap.name)}<br><span style="color:var(--muted)">${esc(ap.city || "")}</span><br>${line2}`);
    pts.push([ap.lat, lon]); prev = ap; prevLon = lon;
  });
  return pts;
}
// a flight booking's legs: new bookings store them; older ones are one leg from start to end
const flightSegs = b => b.legs?.length ? b.legs : [{ from: b.from, to: b.to, num: b.num, depDate: b.depDate, depTime: b.depTime, arrDate: b.arrDate, arrTime: b.arrTime, seat: b.seats }];
const segDates = b => new Set(flightSegs(b).flatMap(l => [l.depDate, l.arrDate]).filter(validIso));
// minutes between landing and the next departure (same airport, so the same time zone)
const gapMins = (a, b) => validIso(a.arrDate) && a.arrTime && validIso(b.depDate) && b.depTime ? Math.round((new Date(`${b.depDate}T${b.depTime}`) - new Date(`${a.arrDate}T${a.arrTime}`)) / 6e4) : null;
const flightCode = b => { const c = String(b.num || "").toUpperCase().replace(/[\s-]/g, ""); return /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(c) ? c : ""; };
const trackLinks = code => `<a class="ext" href="https://www.flightaware.com/live/flight/${code}" target="_blank" rel="noopener">FlightAware ↗</a><a class="ext" href="https://www.flightradar24.com/data/flights/${code.toLowerCase()}" target="_blank" rel="noopener">Flightradar24 ↗</a>`;
// ---- live status (only when a flight-status key is set in config.js)
const STATUS = {};
let WATCH = (() => { try { return JSON.parse(localStorage.getItem("trips-watch") || "{}"); } catch { return {}; } })();
const saveWatch = () => { try { localStorage.setItem("trips-watch", JSON.stringify(WATCH)); } catch {} };
const hoursTo = (date, time) => (new Date(`${date}T${time || "12:00"}`) - Date.now()) / 36e5;
const statusWindow = b => validIso(b.depDate) && hoursTo(b.depDate, b.depTime) < 24 * 7 && hoursTo(b.arrDate || b.depDate, b.arrTime) > -12;
async function fetchStatus(code, date, from) {
  const r = await fetch(`https://aerodatabox.p.rapidapi.com/flights/number/${encodeURIComponent(code)}/${date}?withAircraftImage=false&withLocation=false`, { headers: { "X-RapidAPI-Key": FLIGHT_KEY, "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com" } });
  if (r.status === 204 || r.status === 404) return { none: true };
  if (!r.ok) throw new Error(r.status === 429 ? "The flight-status service's limit was reached. Try again later." : "Couldn't get flight status.");
  const list = await r.json(), fc = (airportOf(from) || {}).code;
  const f = (Array.isArray(list) ? list : [list]).find(x => !fc || x.departure?.airport?.iata === fc) || (Array.isArray(list) ? list[0] : list);
  if (!f) return { none: true };
  const t = x => (x?.revisedTime?.local || x?.predictedTime?.local || x?.scheduledTime?.local || "").slice(11, 16), sch = x => (x?.scheduledTime?.local || "").slice(11, 16);
  return { status: f.status || "", depSched: sch(f.departure), dep: t(f.departure), depTerm: f.departure?.terminal || "", depGate: f.departure?.gate || "", arrSched: sch(f.arrival), arr: t(f.arrival), arrTerm: f.arrival?.terminal || "", belt: f.arrival?.baggageBelt || "", at: Date.now() };
}
const statusSig = s => [s.status, s.dep, s.depGate, s.depTerm, s.arr, s.belt].join("|");
const segOf = key => { const [id, i] = String(key).split(":"); const b = T.bookings[id]; return b ? flightSegs(b)[+i || 0] : WATCH[key]?.b; };
function legLive(key, l) {
  const code = flightCode(l); if (!code) return "";
  const watching = !!WATCH[key], s = STATUS[key];
  let live = "";
  if (!FLIGHT_KEY) live = "";
  else if (!statusWindow(l)) live = `<span class="hint">Live status shows up in the week of the flight.</span>`;
  else if (s?.err) live = `<span class="hint">${esc(s.err)}</span>`;
  else if (s?.none) live = `<span class="hint">No live data for ${esc(code)} on this date yet.</span>`;
  else if (s) {
    const late = s.dep && s.depSched && s.dep !== s.depSched, cls = /cancel/i.test(s.status) ? "bad" : late || /delay/i.test(s.status) ? "warn" : "ok";
    live = `<span class="st ${cls}">${esc(s.status || "Scheduled")}</span><span>Departs <b>${esc(s.dep || "—")}</b>${late ? ` <s>${esc(s.depSched)}</s>` : ""}${s.depTerm ? " · Terminal " + esc(s.depTerm) : ""}${s.depGate ? " · Gate " + esc(s.depGate) : ""}</span><span>Arrives <b>${esc(s.arr || "—")}</b>${s.belt ? " · Bags belt " + esc(s.belt) : ""}</span><span class="hint">Updated ${new Date(s.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`;
  } else live = `<button class="btn ghost small" type="button" data-stat="${key}">Check status</button>`;
  return `${live}<span class="grow"></span>${trackLinks(code)}<button class="btn ghost small" type="button" data-watch="${key}" aria-pressed="${watching}">${watching ? "Watching ✓" : "Watch for changes"}</button>`;
}
function statusHtml(id, b) {
  if (b.kind !== "flight") return "";
  const segs = flightSegs(b), multi = segs.length > 1;
  const rows = segs.map((l, i) => {
    const g = i ? gapMins(segs[i - 1], l) : null;
    const lay = i ? `<div class="leg-lay">Layover in <b>${esc(l.from || segs[i - 1].to || "?")}</b>${g != null && g > 0 ? " · " + fmtMin(g) : ""}${g != null && g <= 0 ? " · check the times" : ""}</div>` : "";
    const head = multi ? `<div class="leg-line"><b>${esc(l.from || "?")} → ${esc(l.to || "?")}</b><span>${esc(fmtD(l.depDate, { weekday: "short", month: "short", day: "numeric" }))} ${esc(l.depTime || "")} → ${l.arrDate && l.arrDate !== l.depDate ? esc(fmtD(l.arrDate, { weekday: "short", month: "short", day: "numeric" })) + " " : ""}${esc(l.arrTime || "")}</span>${l.num ? `<span class="mono">${esc(l.num)}</span>` : ""}${l.seat ? `<span>Seat ${esc(l.seat)}</span>` : ""}</div>` : "";
    const live = legLive(`${id}:${i}`, l);
    // several legs: tracking sits on each leg's own row
    if (multi) return lay + head.replace(/<\/div>$/, live ? `<span class="grow"></span><span class="leg-acts">${live.replace('<span class="grow"></span>', "")}</span></div>` : "</div>");
    return lay + (live ? `<div class="bk-live">${live}</div>` : "");
  }).join("");
  const anyCode = segs.some(l => flightCode(l));
  return `<div class="bk-legs">${rows}<div class="bk-live">${!FLIGHT_KEY && anyCode ? `<span class="hint">Live status: use the tracking links, or add a flight-status key (Help → Live flight status).</span>` : ""}<span class="grow"></span><button class="btn ghost small" type="button" data-froute="${id}">Route map</button></div></div>`;
}
async function refreshStatus(key, quiet) {
  const l = segOf(key); if (!l || !FLIGHT_KEY) return;
  try { const s = await fetchStatus(flightCode(l), l.depDate, l.from); STATUS[key] = s; checkChange(key, l, s); }
  catch (e) { STATUS[key] = { err: e.message }; if (!quiet) toast(esc(e.message)); }
  if (cur?.tab === "bookings") renderTrip();
}
function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") { toast(`<b>${esc(title)}</b> ${esc(body)}`); return; }
  navigator.serviceWorker?.getRegistration().then(r => r ? r.showNotification(title, { body, icon: "icon-192.png", tag: title }) : new Notification(title, { body })).catch(() => new Notification(title, { body }));
}
function checkChange(id, b, s) {
  const w = WATCH[id]; if (!w || s.none || s.err) return;
  const sig = statusSig(s);
  if (w.sig && w.sig !== sig) {
    const bits = [s.status, s.dep && `departs ${s.dep}`, s.depGate && `gate ${s.depGate}`, s.arr && `arrives ${s.arr}`].filter(Boolean).join(" · ");
    notify(`${flightCode(b)} update`, bits);
  }
  w.sig = sig; saveWatch();
}
async function toggleWatch(id) {
  const b = segOf(id); if (!b) return;
  if (WATCH[id]) { delete WATCH[id]; saveWatch(); renderTrip(); return; }
  if ("Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch {} }
  WATCH[id] = { b: { num: b.num, depDate: b.depDate, depTime: b.depTime, arrDate: b.arrDate, arrTime: b.arrTime, from: b.from }, sig: STATUS[id] && !STATUS[id].none ? statusSig(STATUS[id]) : "" };
  saveWatch(); renderTrip();
  toast(FLIGHT_KEY ? "Watching this flight. While Wayfinder is open, it checks every 10 minutes in the week of the flight and alerts you to changes." : "Saved. Add a flight-status key to get alerts (see Help).");
}
// background check while the app is open
setInterval(() => { if (!FLIGHT_KEY || document.hidden) return; for (const [id, w] of Object.entries(WATCH)) if (statusWindow(w.b)) refreshStatus(id, true); }, 10 * 60 * 1000);

// ---- countries: fill in the country for places saved without one
const geoCache = {};
async function reverseGeo(lat, lon) {
  const k = lat.toFixed(3) + "," + lon.toFixed(3); if (geoCache[k]) return geoCache[k];
  try { const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en&limit=1`); const p = (await r.json()).features?.[0]?.properties || {};
    return geoCache[k] = { country: p.country || "", city: p.city || p.town || p.village || p.county || "" }; } catch { return null; }
}
let backfilling = false;
async function backfillCountries() {
  if (backfilling || !cur) return; backfilling = true;
  const tid = cur.id; let n = 0;
  try {
    for (const p of placeList().filter(p => !p.country && (hasPt(p) || p.city))) {
      if (cur?.id !== tid) break;
      let g = null;
      if (hasPt(p)) g = await reverseGeo(p.lat, p.lon);
      else { const h = (await searchPlaces(p.city).catch(() => [])).find(h => h.type === "city"); if (h) g = { country: h.country, city: "" }; }
      if (g?.country && T.places[p.id] && !T.places[p.id].country) { T.places[p.id] = { ...T.places[p.id], country: g.country, city: T.places[p.id].city || g.city }; savePlace(p.id); n++; }
      await new Promise(r => setTimeout(r, 350));
    }
  } finally { backfilling = false; }
  if (n && (cur?.tab === "places" || cur?.tab === "food")) renderTrip();
}

// ---- OpenStreetMap lookups (Overpass) for stays and places to eat
async function overpass(lat, lon, radius, filters, limit = 80) {
  const q = `[out:json][timeout:25];(${filters.map(f => `nwr(around:${radius},${lat},${lon})${f}[name];`).join("")});out center tags ${limit};`;
  let lastErr;
  for (const host of ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]) {
    try { const r = await fetch(host, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      if (!r.ok) throw new Error("busy"); const j = await r.json();
      return (j.elements || []).map(e => ({ id: e.type + e.id, tags: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon })).filter(e => e.lat != null);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("busy");
}
// the areas you'll be in: cities from scheduled places, plus where flights land
function tripAreas() {
  const days = tripDays(), groups = {};
  placeList().filter(p => hasPt(p) && days.includes(p.day)).forEach(p => {
    const k = (p.city || "Day " + (days.indexOf(p.day) + 1)).trim(), g = groups[k] ||= { label: k, country: p.country || "", pts: [], days: new Set() };
    g.pts.push(p); g.days.add(p.day); if (!g.country && p.country) g.country = p.country;
  });
  const out = Object.values(groups).map(g => {
    const ds = [...g.days].sort(), lat = g.pts.reduce((a, p) => a + p.lat, 0) / g.pts.length, lon = g.pts.reduce((a, p) => a + p.lon, 0) / g.pts.length;
    return { key: "c:" + g.label, label: g.label, country: g.country, lat, lon, from: ds[0], to: addDays(ds[ds.length - 1], 1), n: g.pts.length, sub: `${fmtD(ds[0])}${ds.length > 1 ? " – " + fmtD(ds[ds.length - 1]) : ""} · ${g.pts.length} place${g.pts.length === 1 ? "" : "s"}` };
  }).sort((a, b) => a.from.localeCompare(b.from));
  Object.values(T.bookings).filter(b => b.kind === "flight").forEach(b => {
    const ap = airportOf(b.to); if (!ap) return;
    out.push({ key: "f:" + ap.code + b.arrDate, label: ap.city || ap.code, country: "", lat: ap.lat, lon: ap.lon, from: b.arrDate, to: validIso(b.arrDate) ? addDays(b.arrDate, 1) : "", n: 0, sub: `Where ${b.num || "your flight"} lands (${ap.code})${b.arrDate ? " · " + fmtD(b.arrDate) : ""}`, airport: true });
  });
  if (!out.length) tripDests(T.trip).filter(hasPt).forEach((d, i) => out.push({ key: "d" + i, label: d.name, country: d.country || "", lat: d.lat, lon: d.lon, from: T.trip.start, to: T.trip.end, n: 0, sub: "Trip destination" }));
  return out;
}
const distTxt = d => d < 1 ? `${Math.round(d * 1000 / 10) * 10} m` : `${d.toFixed(1)} km`;
const STAYT = { hotel: "Hotel", hostel: "Hostel", guest_house: "Guesthouse / B&B", apartment: "Apartment", motel: "Motel" };
async function staysModal(preKey) {
  await loadAirports();
  const areas = tripAreas();
  if (!areas.length) { toast("Add some places to your days (or a flight) first, so there's somewhere to search around."); return; }
  let area = areas.find(a => a.key === preKey) || areas[0], kind = "", list = null;
  openModal(`<div class="row between"><h2>Stays nearby</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Hotels and other stays close to the places on your days, from OpenStreetMap. Check prices and book on the hotel's site or a booking site.</p>
    <div class="grid2"><label class="field" for="syArea">Near<select id="syArea">${areas.map(a => `<option value="${esc(a.key)}">${esc(a.label)} · ${esc(a.sub)}</option>`).join("")}</select></label>
      <label class="field" for="syKind">Kind<select id="syKind"><option value="">Any</option>${Object.entries(STAYT).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label></div>
    <div id="syList" class="near-list"><p class="hint">Searching…</p></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    $("#syArea").value = area.key;
    const paint = () => {
      const el = $("#syList"); if (!el) return;
      if (!list) { el.innerHTML = `<p class="hint">Searching…</p>`; return; }
      if (list.err) { el.innerHTML = `<p class="hint">${esc(list.err)}</p>`; return; }
      const L2 = list.filter(x => !kind || x.tags.tourism === kind).slice(0, 30);
      const ci = validIso(area.from) ? area.from : "", co = validIso(area.to) ? area.to : "";
      el.innerHTML = L2.map(x => {
        const t = x.tags, stars = parseInt(t.stars) || 0, addr = t._addr || [t["addr:street"] && (t["addr:street"] + (t["addr:housenumber"] ? " " + t["addr:housenumber"] : "")), t["addr:city"] || area.label].filter(Boolean).join(", ");
        const bq = encodeURIComponent(`${t.name} ${t["addr:city"] || area.label}`), web = safeUrl(t.website || t["contact:website"]);
        return `<div class="near"><div class="grow"><b>${esc(t.name)}</b>${stars ? ` <span class="stars" aria-label="${stars} stars">${"★".repeat(Math.min(stars, 5))}</span>` : ""}
          <span class="hint">${t._rating ? `<b class="g-rate">${esc(ratingTxt(t))}</b> · ` : ""}${esc(STAYT[t.tourism] || "Stay")} · ${distTxt(x.d)} from ${area.airport ? "the airport" : `your ${esc(area.label)} places`}${addr ? " · " + esc(addr) : ""}</span>
          <span class="near-links">${web ? `<a class="ext" href="${esc(web)}" target="_blank" rel="noopener">Website ↗</a>` : ""}<a class="ext" href="${esc(safeUrl(t._maps) || "https://www.google.com/maps/search/?api=1&query=" + bq)}" target="_blank" rel="noopener">Maps ↗</a><a class="ext" href="https://www.booking.com/searchresults.html?ss=${bq}${ci ? "&checkin=" + ci : ""}${co ? "&checkout=" + co : ""}" target="_blank" rel="noopener">Booking.com ↗</a></span></div>
          <button class="btn small" type="button" data-pick="${esc(x.id)}">Add as stay</button></div>`;
      }).join("") + (L2.some(x => x.g) ? G_ATTR : "") || `<p class="hint">Nothing found within a few km. Try another area.</p>`;
    };
    const load = async () => {
      list = null; paint();
      try {
        let r = null;
        if (useGoogle()) { try { r = await googleNearby(area.lat, area.lon, 2500, ["lodging"]); if (r.length < 6) r = await googleNearby(area.lat, area.lon, 6000, ["lodging"]); } catch { r = null; } }
        if (!r) { r = await overpass(area.lat, area.lon, 1500, ['[tourism~"^(hotel|hostel|guest_house|apartment|motel)$"]']);
          if (r.length < 6) r = await overpass(area.lat, area.lon, 4000, ['[tourism~"^(hotel|hostel|guest_house|apartment|motel)$"]']); }
        r.forEach(x => x.d = km(area, x)); r.sort((a, b) => a.d - b.d); list = r;
      } catch { list = { err: "The map service is busy right now. Try again in a minute." }; }
      paint();
    };
    $("#syArea").onchange = e => { area = areas.find(a => a.key === e.target.value); load(); };
    $("#syKind").onchange = e => { kind = e.target.value; paint(); };
    $("#syList").addEventListener("click", async e => {
      const b = e.target.closest("[data-pick]"); if (!b) return;
      const x = list.find(y => y.id === b.dataset.pick), t = x.tags;
      b.disabled = true; b.textContent = "Getting address…";
      if (t._addr) { closeModal(); bookingModal(null, "lodging", { title: t.name.slice(0, 80), addr: [t.name, t._addr].join(", "), lat: x.lat, lon: x.lon, checkIn: validIso(area.from) ? area.from : "", checkOut: validIso(area.to) ? area.to : "", checkInTime: "15:00", checkOutTime: "11:00", planned: true }); return; }
      let street = t["addr:street"] ? [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") : "", city = t["addr:city"] || "", pc = t["addr:postcode"] || "", country = "";
      if (!street || !city) { const a = await streetAddress(x.lat, x.lon); if (a) { street ||= a.street; city ||= a.city; pc ||= a.postcode; country = a.country; } }
      closeModal();
      bookingModal(null, "lodging", { title: t.name.slice(0, 80), addr: [t.name, street, [pc, city || area.label].filter(Boolean).join(" "), country].filter(Boolean).join(", "), lat: x.lat, lon: x.lon, checkIn: validIso(area.from) ? area.from : "", checkOut: validIso(area.to) ? area.to : "", checkInTime: "15:00", checkOutTime: "11:00", planned: true });
    });
    load();
  });
}

// ================================================================ RESTAURANTS
const FOODT = ["food", "cafe", "night"];
const RF = { kind: "", city: "", country: "" };
const EATQ = { food: ['[amenity~"^(restaurant|fast_food|food_court)$"]'], cafe: ['[amenity~"^(cafe|ice_cream)$"]', '[shop~"^(bakery|pastry)$"]'], night: ['[amenity~"^(bar|pub|biergarten)$"]'] };
const EATL = { food: "Restaurants", cafe: "Cafés & bakeries", night: "Bars & pubs" };
let eat = { area: null, kind: "food", list: null, busy: false };
function viewFood(v) {
  backfillCountries(); loadAirports();
  const all = placeList().filter(p => FOODT.includes(p.type)), areas = tripAreas().filter(a => !a.airport);
  const L2 = all.filter(p => (!RF.kind || p.type === RF.kind) && (!RF.country || p.country === RF.country) && (!RF.city || p.city === RF.city))
    .sort((a, b) => (a.city || "").localeCompare(b.city || "") || Object.keys(b.hearts).length - Object.keys(a.hearts).length);
  const resv = Object.entries(T.bookings).filter(([, b]) => b.kind === "reservation").sort((a, b) => bkStart(a[1]).localeCompare(bkStart(b[1])));
  const count = f => { const m = {}; all.forEach(p => { const k = f(p); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])); };
  const chips = (key, items) => `<div class="chips" data-rf="${key}"><button type="button" class="chip ${!RF[key] ? "on" : ""}" data-v="">All</button>${items.map(([val, l, n]) => `<button type="button" class="chip ${RF[key] === val ? "on" : ""}" data-v="${esc(val)}">${esc(l)}<span class="n">${n}</span></button>`).join("")}</div>`;
  if (!eat.area && areas.length) eat.area = areas[0].key;
  const area = areas.find(a => a.key === eat.area);
  v.innerHTML = `<div class="row between"><h2>Restaurants</h2><div class="row" style="gap:6px"><button class="btn ghost small" type="button" data-new-res>+ Reservation</button><button class="btn small" type="button" id="addFood">+ Add a place to eat</button></div></div>
    ${resv.length ? `<div class="card"><h3>Reservations</h3><ul class="res-list">${resv.map(([id, b]) => `<li><b>${esc(fmtD(b.date, { weekday: "short", month: "short", day: "numeric" }) || "No date")}${b.time ? " · " + esc(b.time) : ""}</b><span>${esc(b.title || "Reservation")}</span>${b.conf ? `<span class="mono hint">${esc(b.conf)}</span>` : ""}<button class="linkbtn" type="button" data-bedit="${id}">Edit</button></li>`).join("")}</ul></div>` : ""}
    <div class="card" style="display:grid;gap:10px"><h3 style="color:var(--accent)">Find places to eat near your plans</h3>
      ${areas.length ? `<div class="row" style="gap:8px;flex-wrap:wrap"><select id="eatArea" class="input" style="width:auto" aria-label="Near">${areas.map(a => `<option value="${esc(a.key)}" ${a.key === eat.area ? "selected" : ""}>${esc(a.label)} · ${esc(a.sub)}</option>`).join("")}</select>
        <div class="seg" role="group" aria-label="Kind">${Object.entries(EATL).map(([k, l]) => `<button type="button" data-eatk="${k}" aria-pressed="${eat.kind === k}">${l}</button>`).join("")}</div>
        <button class="btn accent small" type="button" id="eatGo">${eat.busy ? "Searching…" : "Search"}</button></div>
        ${eat.list?.err ? `<p class="hint">${esc(eat.list.err)}</p>` : eat.list ? `<div class="near-list">${eat.list.slice(0, 24).map(x => { const t = x.tags, saved = all.some(p => p.name.toLowerCase() === t.name.toLowerCase());
          return `<div class="near"><div class="grow"><b>${esc(t.name)}</b><span class="hint">${t._rating ? `<b class="g-rate">${esc(ratingTxt(t))}</b> · ` : ""}${esc((t.cuisine || "").split(";").map(c => c.replace(/_/g, " ")).filter(Boolean).slice(0, 3).join(", ") || EATL[eat.kind].replace(/s( &.*)?$/, ""))} · ${distTxt(x.d)} away${t.opening_hours ? " · " + esc(t.opening_hours.slice(0, 40)) : ""}</span></div>
            <button class="btn small ${saved ? "ghost" : ""}" type="button" data-eat="${esc(x.id)}" ${saved ? "disabled" : ""}>${saved ? "Saved" : "Save"}</button></div>`; }).join("") || `<p class="hint">Nothing found nearby.</p>`}${eat.list.some(x => x.g) ? G_ATTR : ""}</div>` : `<p class="hint">Searches OpenStreetMap around ${area ? `your ${esc(area.label)} places` : "your plans"}.</p>`}`
      : `<p class="hint">Schedule a few places in the Itinerary, and you can search for food around them here.</p>`}</div>
    ${all.length ? `<div class="card filters">${chips("kind", Object.entries(EATL).map(([k, l]) => [k, l, all.filter(p => p.type === k).length]).filter(x => x[2]))}
      ${count(p => p.country).length > 1 ? chips("country", count(p => p.country).map(([c, n]) => [c, c, n])) : ""}
      ${count(p => (!RF.country || p.country === RF.country) ? p.city : "").length > 1 ? chips("city", count(p => (!RF.country || p.country === RF.country) ? p.city : "").map(([c, n]) => [c, c, n])) : ""}</div>` : ""}
    <div class="place-grid">${L2.map(placeCard).join("") || `<div class="empty" style="grid-column:1/-1">${all.length ? "No places match these filters." : "Restaurants, cafés and bars you save show up here, and on the Places tab too."}</div>`}</div>`;
  $("#addFood").onclick = () => { placeModal(null); setTimeout(() => { const t = $("#pmType"); if (t) t.value = "food"; }, 0); };
  if ($("#eatArea")) $("#eatArea").onchange = e => { eat.area = e.target.value; eat.list = null; renderTrip(); };
  const go = async () => {
    const a = tripAreas().find(x => x.key === eat.area); if (!a) return;
    eat.busy = true; renderTrip();
    const GT = { food: ["restaurant"], cafe: ["cafe", "bakery", "coffee_shop"], night: ["bar", "pub"] };
    try { let r = null;
      if (useGoogle()) { try { r = await googleNearby(a.lat, a.lon, 1200, GT[eat.kind]); if (r.length < 8) r = await googleNearby(a.lat, a.lon, 3000, GT[eat.kind]); } catch { r = null; } }
      if (!r) { r = await overpass(a.lat, a.lon, 800, EATQ[eat.kind], 120); if (r.length < 8) r = await overpass(a.lat, a.lon, 2000, EATQ[eat.kind], 120); }
      r.forEach(x => x.d = km(a, x)); if (!r.some(x => x.g)) r.sort((p, q) => (q.tags.cuisine ? 0.15 : 0) - (p.tags.cuisine ? 0.15 : 0) + p.d - q.d); eat.list = r; eat.city = a.label; eat.country = a.country; }
    catch { eat.list = { err: "The map service is busy right now. Try again in a minute." }; }
    eat.busy = false; if (cur?.tab === "food") renderTrip();
  };
  $("#eatGo") && ($("#eatGo").onclick = go);
  v.addEventListener("click", e => {
    const k = e.target.closest("[data-eatk]"); if (k) { eat.kind = k.dataset.eatk; eat.list = null; renderTrip(); return; }
    const sv = e.target.closest("[data-eat]");
    if (sv) { const x = eat.list.find(y => y.id === sv.dataset.eat), t = x.tags;
      const id = addPlace(x.g ? { name: t.name, type: eat.kind, city: eat.city, country: eat.country, lat: x.lat, lon: x.lon, addr: t._addr, full: true, gid: t._gid, link: safeUrl(t._maps) || gmapsUrl({ name: t.name, city: eat.city }) }
        : { name: t.name, type: eat.kind, city: t["addr:city"] || eat.city, country: eat.country, lat: x.lat, lon: x.lon, addr: [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), link: safeUrl(t.website) || gmapsUrl({ name: t.name, city: t["addr:city"] || eat.city }) },
        { notes: [(t.cuisine || "").split(";").map(c => c.replace(/_/g, " ")).filter(Boolean).slice(0, 3).join(", "), ratingTxt(t)].filter(Boolean).join(" · ") });
      if (!eat.country) reverseGeo(x.lat, x.lon).then(g => { if (g?.country && T.places[id]) { T.places[id] = { ...T.places[id], country: g.country }; savePlace(id); } });
      toast(`Saved ${esc(t.name)}.`); renderTrip(); renderMap(); return; }
    if (e.target.closest("[data-new-res]")) return bookingModal(null, "reservation");
    const be = e.target.closest("[data-bedit]"); if (be) return bookingModal(be.dataset.bedit);
    const chip = e.target.closest(".chips[data-rf] .chip");
    if (chip) { const key = chip.parentElement.dataset.rf; RF[key] = RF[key] === chip.dataset.v ? "" : chip.dataset.v; if (key === "country") RF.city = ""; renderTrip(); renderMap(); return; }
    const card = e.target.closest(".place"); if (!card) return; const id = card.dataset.id;
    if (e.target.closest("[data-heart]")) {
      const hk = ekey(ME.email), on = !(T.places[id].hearts || {})[hk], hearts = { ...(T.places[id].hearts || {}) };
      if (on) hearts[hk] = ME.name; else delete hearts[hk];
      T.places[id] = { ...T.places[id], hearts }; updateDoc(doc(fs, tp("places/" + id)), { ["hearts." + hk]: on ? ME.name : deleteField() }).catch(fail); renderTrip(); return;
    }
    if (e.target.closest("[data-edit]")) return placeModal(id);
    if (e.target.closest("[data-zoom]")) return lightbox(e.target.src);
    if (e.target.closest("[data-locate]")) mapFocusPlace(id);
  });
  v.addEventListener("change", e => {
    if (e.target.dataset.pday != null) { const id = e.target.closest(".place").dataset.id, iso = e.target.value; T.places[id] = { ...T.places[id], day: iso, order: iso ? dayPlaces(iso).length : 0 }; savePlace(id); renderTrip(); renderMap(); }
  });
}

// ================================================================ GMAIL IMPORT
// Reads confirmation emails in your browser (read-only) and picks out the booking details airlines,
// hotels and rental companies put in them for Gmail (schema.org markup). Nothing is stored but what you add.
const GMAIL_Q = 'newer_than:3y subject:(confirmation OR confirmed OR itinerary OR reservation OR booking OR "e-ticket" OR "your trip" OR receipt)';
const b64 = d => { try { const bin = atob(d.replace(/-/g, "+").replace(/_/g, "/")); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch { return ""; } };
function htmlOf(part, out = []) { if (!part) return out; if (/text\/html/.test(part.mimeType) && part.body?.data) out.push(b64(part.body.data)); (part.parts || []).forEach(p => htmlOf(p, out)); return out; }
const tname = x => String(x?.["@type"] || x?.type || "").replace(/^https?:\/\/schema\.org\//, "");
function microdata(el) {
  const o = { "@type": (el.getAttribute("itemtype") || "").split("/").pop() };
  el.querySelectorAll("[itemprop]").forEach(p => {
    if (p.parentElement.closest("[itemscope]") !== el) return;
    const v = p.hasAttribute("itemscope") ? microdata(p) : (p.getAttribute("content") ?? p.getAttribute("datetime") ?? p.getAttribute("href") ?? p.textContent.trim());
    const k = p.getAttribute("itemprop"); o[k] = o[k] === undefined ? v : [].concat(o[k], v);
  });
  return o;
}
function reservationsIn(html) {
  const d = new DOMParser().parseFromString(html, "text/html"), out = [];
  const take = x => { if (!x) return; if (Array.isArray(x)) return x.forEach(take); if (x["@graph"]) take(x["@graph"]); if (/Reservation$/.test(tname(x))) out.push(x); };
  d.querySelectorAll('script[type="application/ld+json"]').forEach(sc => { try { take(JSON.parse(sc.textContent)); } catch {} });
  d.querySelectorAll('[itemscope][itemtype*="Reservation"]').forEach(el => { if (!el.parentElement?.closest('[itemscope][itemtype*="Reservation"]')) out.push(microdata(el)); });
  return out;
}
const one = x => Array.isArray(x) ? x[0] : x;
const local = v => { const m = String(v || "").match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/); return m ? { d: m[1], t: m[2] || "" } : { d: "", t: "" }; };
const addrTxt = a => { a = one(a); if (!a) return ""; if (typeof a === "string") return a; return [a.name, a.streetAddress, a.addressLocality, a.addressCountry?.name || a.addressCountry].filter(x => typeof x === "string" && x).join(", "); };
function toBooking(r) {
  const t = tname(r), f = one(r.reservationFor) || {};
  if (/cancel/i.test(String(r.reservationStatus || ""))) return null;
  const price = num(String(r.totalPrice?.price ?? r.totalPrice ?? r.price ?? "").replace(/[^\d.]/g, "")), cur = String(r.priceCurrency || r.totalPrice?.priceCurrency || "").toUpperCase();
  const base = { conf: String(r.reservationNumber || r.confirmationNumber || "").slice(0, 40), cost: price, costCur: CURRENCIES.includes(cur) ? cur : homeCur(), notes: "Imported from Gmail" };
  if (t === "FlightReservation") {
    const dep = one(f.departureAirport) || {}, arr = one(f.arrivalAirport) || {}, a = local(f.departureTime), b = local(f.arrivalTime);
    const al = one(f.airline)?.iataCode || "", fn = String(f.flightNumber || ""), seat = r.airplaneSeat || one(r.reservedTicket)?.ticketedSeat?.seatNumber || "";
    return { ...base, kind: "flight", from: dep.iataCode || dep.name || "", to: arr.iataCode || arr.name || "", depDate: a.d, depTime: a.t, arrDate: b.d, arrTime: b.t, num: (fn.startsWith(al) ? fn : `${al} ${fn}`).trim(), seats: String(seat), _dep: f.departureTime, _arr: f.arrivalTime };
  }
  if (t === "LodgingReservation") {
    const a = local(r.checkinDate || r.checkinTime), b = local(r.checkoutDate || r.checkoutTime), g = one(f.geo);
    return { ...base, kind: "lodging", title: f.name || "Stay", addr: [f.name, addrTxt(f.address)].filter(Boolean).join(", "), checkIn: a.d, checkInTime: a.t || "15:00", checkOut: b.d, checkOutTime: b.t || "11:00", lat: g?.latitude ? num(g.latitude) : null, lon: g?.longitude ? num(g.longitude) : null };
  }
  if (t === "RentalCarReservation") {
    const a = local(r.pickupTime), b = local(r.dropoffTime), co = one(f.rentalCompany)?.name || one(f.brand)?.name || "";
    return { ...base, kind: "car", title: [co, "rental car"].filter(Boolean).join(" "), from: one(r.pickupLocation)?.name || addrTxt(one(r.pickupLocation)?.address), to: one(r.dropoffLocation)?.name || addrTxt(one(r.dropoffLocation)?.address), depDate: a.d, depTime: a.t, arrDate: b.d, arrTime: b.t, num: co };
  }
  if (t === "TrainReservation" || t === "BusReservation") {
    const a = local(f.departureTime), b = local(f.arrivalTime), ds = one(f.departureStation || f.departureBusStop) || {}, as = one(f.arrivalStation || f.arrivalBusStop) || {};
    return { ...base, kind: t === "TrainReservation" ? "train" : "bus", from: ds.name || "", to: as.name || "", depDate: a.d, depTime: a.t, arrDate: b.d, arrTime: b.t, num: String(f.trainNumber || f.busNumber || f.trainName || "") };
  }
  if (t === "FoodEstablishmentReservation") { const a = local(r.startTime); return { ...base, kind: "reservation", title: f.name || "Dinner", date: a.d, time: a.t, addr: [f.name, addrTxt(f.address)].filter(Boolean).join(", ") }; }
  if (t === "EventReservation" || t === "ReservationPackage") { const a = local(f.startDate || r.startTime); return { ...base, kind: "activity", title: f.name || "Tickets", date: a.d, time: a.t, addr: addrTxt(one(f.location)?.address) || one(f.location)?.name || "" }; }
  return null;
}
// flights on one booking with connecting segments become one booking with layovers
function joinFlights(list) {
  const flights = list.filter(b => b.kind === "flight").sort((a, b) => String(a._dep).localeCompare(String(b._dep))), out = list.filter(b => b.kind !== "flight"), used = new Set();
  const legOf = f => ({ from: f.from, to: f.to, num: f.num, seat: f.seats || "", depDate: f.depDate, depTime: f.depTime, arrDate: f.arrDate, arrTime: f.arrTime });
  flights.forEach((f, i) => {
    if (used.has(i)) return; used.add(i); const trip = { ...f, stops: [], legs: [legOf(f)] }; let last = f;
    for (let j = i + 1; j < flights.length; j++) {
      const n = flights[j]; if (used.has(j) || n.conf !== f.conf || n.from !== last.to) continue;
      const gap = (new Date(local(n._dep).d + "T" + (local(n._dep).t || "00:00")) - new Date(local(last._arr).d + "T" + (local(last._arr).t || "00:00"))) / 6e4;
      if (!(gap > 0 && gap < 24 * 60)) continue;
      trip.stops.push({ at: n.from, dur: fmtMin(Math.round(gap)) }); trip.legs.push(legOf(n)); trip.to = n.to; trip.arrDate = n.arrDate; trip.arrTime = n.arrTime; trip.num += " / " + n.num; if (n.cost) { if (!trip.cost) trip.costCur = n.costCur; trip.cost += n.cost; } used.add(j); last = n;
    }
    if (trip.stops.length) trip.num = trip.num.split(" / ")[0];
    out.push(trip);
  });
  return out.map(({ _dep, _arr, ...b }) => ({ ...b, title: b.title || (b.from && b.to ? `${b.from} → ${b.to}` : KINDS[b.kind].label) }));
}
const bkDate = b => b.depDate || b.checkIn || b.date || "";
const isDup = b => Object.values(T.bookings).some(x => x.kind === b.kind && ((b.conf && x.conf === b.conf && bkDate(x) === bkDate(b)) || (!b.conf && x.title === b.title && bkDate(x) === bkDate(b))));
async function gmailToken() {
  const p = new GoogleAuthProvider(); p.addScope("https://www.googleapis.com/auth/gmail.readonly"); p.setCustomParameters({ login_hint: ME.email });
  const res = await reauthenticateWithPopup(auth.currentUser, p);
  const tok = GoogleAuthProvider.credentialFromResult(res)?.accessToken; if (!tok) throw new Error("Gmail didn't give access.");
  return tok;
}
async function gmailGet(tok, path) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); const msg = j.error?.message || ""; throw Object.assign(new Error(/has not been used|is disabled/i.test(msg) ? "The Gmail API isn't turned on for this Firebase project yet. See Help → Import from Gmail for the one-time setup." : r.status === 403 ? "Gmail access wasn't allowed. Try again and tick the box to let Wayfinder read your email." : "Couldn't read Gmail (" + r.status + ")."), { status: r.status }); }
  return r.json();
}
function gmailModal() {
  let found = [], plain = [], picked = new Set();
  const t = T.trip, lo = validIso(t.start) ? addDays(t.start, -7) : "", hi = validIso(t.end) ? addDays(t.end, 7) : "";
  const inTrip = b => !lo || (bkDate(b) >= lo && bkDate(b) <= hi);
  openModal(`<div class="row between"><h2>Import from Gmail</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Wayfinder looks through your confirmation emails for flights, stays, rental cars, trains and restaurant reservations, and lets you pick which to add. It only reads (it can't send, change or delete anything), the emails are read right here in your browser, and only the bookings you add are saved.</p>
    <details><summary class="hint">Search settings</summary><label class="field" for="gmQ">Gmail search<input id="gmQ" value="${esc(GMAIL_Q)}"></label></details>
    <div class="row" style="justify-content:flex-end"><button class="btn accent" type="button" id="gmGo">Connect Gmail and scan</button></div>
    <p class="hint" id="gmMsg" role="status"></p><div id="gmList"></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    const paint = () => {
      const row = (b, i) => { const dup = isDup(b), k = KINDS[b.kind];
        return `<label class="gm-row ${dup ? "dup" : ""}"><input type="checkbox" data-gi="${i}" ${picked.has(i) ? "checked" : ""} ${dup ? "disabled" : ""}><span class="gm-k" style="--bc:${k.col}">${esc(k.label)}</span><span class="grow"><b>${esc(b.title)}</b><span class="hint">${esc(fmtD(bkDate(b), { weekday: "short", month: "short", day: "numeric", year: "numeric" }) || "No date")}${b.stops?.length ? " · via " + esc(b.stops.map(s => s.at).join(", ")) : ""}${b.num ? " · " + esc(b.num) : ""}${b.conf ? " · " + esc(b.conf) : ""}${b.cost ? " · " + esc(fmtCur(b.cost, b.costCur)) : ""}${dup ? " · already added" : ""}</span></span></label>`; };
      const inT = found.map((b, i) => [b, i]).filter(([b]) => inTrip(b)), outT = found.map((b, i) => [b, i]).filter(([b]) => !inTrip(b));
      $("#gmList").innerHTML = (found.length ? `<h3>${lo ? "Around this trip's dates" : "Bookings found"}</h3>${inT.map(([b, i]) => row(b, i)).join("") || `<p class="hint">None in this trip's dates.</p>`}
        ${outT.length ? `<details><summary class="hint">${outT.length} from other dates</summary>${outT.map(([b, i]) => row(b, i)).join("")}</details>` : ""}
        <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn accent" type="button" id="gmAdd" ${picked.size ? "" : "disabled"}>Add ${picked.size || ""} booking${picked.size === 1 ? "" : "s"}</button></div>` : "")
        + (plain.length ? `<details ${found.length ? "" : "open"}><summary class="hint">${plain.length} confirmation email${plain.length === 1 ? "" : "s"} without details Wayfinder can read</summary>${plain.slice(0, 20).map((p, i) => `<div class="gm-row"><span class="grow"><b>${esc(p.subject)}</b><span class="hint">${esc(p.from)} · ${esc(p.date)}</span></span><button class="btn ghost small" type="button" data-gp="${i}">Add by hand</button></div>`).join("")}</details>` : "");
      if ($("#gmAdd")) $("#gmAdd").onclick = add;
    };
    const add = async () => {
      const btn = $("#gmAdd"); btn.disabled = true; btn.textContent = "Adding…"; let n = 0;
      for (const i of picked) {
        const b = found[i], out = { ...b, split: members(), paidBy: ME.email, planned: false, created: Date.now(), home: homeCur(), stops: b.stops || [] };
        out.costRate = out.costCur === homeCur() ? 1 : (b.cost ? await getRate(out.costCur, homeCur(), bkDate(b)).catch(() => 0) : 0);
        if (out.cost && !out.costRate) { out.notes += ` · cost ${fmtCur(out.cost, out.costCur)}, add the exchange rate`; out.cost = 0; }
        ["lat", "lon"].forEach(k => { if (out[k] == null) out[k] = null; });
        const id = uidGen(); T.bookings[id] = out; save(tp("bookings/" + id), out, 0); n++;
      }
      closeModal(); renderTrip(); renderMap(); toast(`Added ${n} booking${n === 1 ? "" : "s"} from Gmail.`);
    };
    $("#gmList").addEventListener("change", e => { const i = e.target.dataset.gi; if (i == null) return; e.target.checked ? picked.add(+i) : picked.delete(+i); const b = $("#gmAdd"); if (b) { b.disabled = !picked.size; b.textContent = `Add ${picked.size || ""} booking${picked.size === 1 ? "" : "s"}`; } });
    $("#gmList").addEventListener("click", e => { const g = e.target.closest("[data-gp]"); if (!g) return; const p = plain[+g.dataset.gp]; closeModal(); bookingModal(null, "other", { title: p.subject.slice(0, 80), notes: `From ${p.from}, ${p.date} (Gmail)` }); });
    $("#gmGo").onclick = async () => {
      const go = $("#gmGo"), msg = $("#gmMsg"); go.disabled = true; msg.textContent = "Waiting for Google…";
      try {
        const tok = await gmailToken();
        msg.textContent = "Searching your email…";
        const ids = []; let page = "";
        do { const j = await gmailGet(tok, `messages?maxResults=100&q=${encodeURIComponent($("#gmQ").value)}${page ? "&pageToken=" + page : ""}`); (j.messages || []).forEach(x => ids.push(x.id)); page = j.nextPageToken; } while (page && ids.length < 200);
        const raw = []; plain = [];
        for (let i = 0; i < ids.length; i += 8) {
          msg.textContent = `Reading ${Math.min(i + 8, ids.length)} of ${ids.length} emails…`;
          await Promise.all(ids.slice(i, i + 8).map(async id => {
            const mm = await gmailGet(tok, `messages/${id}?format=full`).catch(() => null); if (!mm) return;
            const H = n => (mm.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || "";
            const res = htmlOf(mm.payload).flatMap(reservationsIn).map(toBooking).filter(Boolean);
            if (res.length) raw.push(...res); else plain.push({ subject: H("subject") || "(no subject)", from: H("from").replace(/<.*>/, "").trim(), date: new Date(+mm.internalDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) });
          }));
        }
        const seen = new Set(); found = joinFlights(raw).filter(b => { const k = [b.kind, b.conf, bkDate(b), b.title].join("|"); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => bkDate(a).localeCompare(bkDate(b)));
        picked = new Set(found.map((b, i) => i).filter(i => inTrip(found[i]) && !isDup(found[i])));
        msg.textContent = found.length ? `Found ${found.length} booking${found.length === 1 ? "" : "s"} in ${ids.length} emails.` : `Checked ${ids.length} emails and found no booking details Wayfinder can read.`;
        go.textContent = "Scan again"; paint();
      } catch (e) {
        msg.textContent = e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request" ? "The Google window was closed." : e.code === "auth/user-mismatch" ? `Pick the same Google account you're signed in with (${ME.email}).` : e.code === "auth/popup-blocked" ? "Your browser blocked the Google window. Allow pop-ups for this site and try again." : e.message;
      }
      go.disabled = false;
    };
  });
}

// ================================================================ HELP
const HELP = [
  ["start", "Getting started", `<p>Each trip has its own map, day-by-day plan, bookings and budget. Make one with <b>New trip</b> on the home page, then open <b>Share</b> to invite people by their Google email. Everyone on a trip can edit it, and changes show up for everyone right away. Anyone with a Google account can join a trip they're invited to. To let someone <b>start their own trips</b>, add them in your picture menu → <b>People &amp; access</b>.</p>
    <p>Wide screens show sections on the left, the page in the middle and the map on the right. Use <b>List / Split / Map</b> at the top to hide the map or make it bigger. On a phone, the <b>Map</b> button switches between the two.</p>
    <p>Map labels are in English by default, even in places like Japan. To change that, tap your picture (top right) → <b>Map labels</b> and pick English, Both (English with the local name under it) or Local.</p>`],
  ["today", "Today and weather", `<p><b>Today</b> (top of the sidebar) is your during-the-trip screen: the day's weather, bookings, what's next with one-tap directions, and a checklist to tick off places as you go. Use ‹ › to look at other days. While a trip is on, Wayfinder opens straight to it.</p>
    <p>Each day shows its <b>weather</b>: a forecast in the two weeks before, and the typical weather for those dates before that. Switch °F/°C in your picture menu (top right). With Google turned on, stops show <b>opening hours</b> and warn you if a place is closed that day or at the time you planned. Holidays aren't included, so double-check those.</p>
    <p>The <b>Journal</b> box on Today is for memories. It goes into the memory book.</p>`],
  ["places", "Places to visit", `<p>Search for anything (a museum, a beach, a café) and pick it from the list. Wayfinder fills in the type, city, country, map pin and a photo when one is free to use. Tap ♥ on the places you're most excited about.</p>
    <p>Filter by type, <b>country</b> and city. The city list narrows to the country you pick. Places saved without a country get one filled in automatically from their location.</p>`],
  ["plan", "Itinerary", `<ul><li><b>Add places</b> with <i>+ Add a place</i> on a day, or open <b>Saved places</b> and drag them into days. If search shows several branches, check the street and neighborhood under each name. You can also paste a Google Maps link, or coordinates copied by pressing and holding a spot in Google Maps.</li>
    <li><b>Reorder</b> by dragging, or with the ↑ ↓ buttons.</li>
    <li><b>Notes</b>: <i>+ Note</i> adds a note bubble to a day, with an optional time. Drag it between stops (say, one for the airport and one for when you reach the hotel), or onto another day.</li>
    <li><b>Optimize route</b>: the planner works out the shortest order for the day's stops. You can start and end the day at your hotel. It measures straight-line distance, and you can undo it.</li>
    <li><b>Directions</b> opens the day in Apple Maps or Google Maps, your choice, and it can remember which one you like.</li>
    <li><b>Day colors</b>: tap the colored dot next to a day's date and pick from 18 colors. The map uses the same color.</li>
    <li><b>Getting around</b>: pick walking, transit, driving or biking for the day, or <i>Walk when close, transit otherwise</i>. To change one stretch, tap the little icon (🚶 🚆 🚗 🚲) between two stops. Travel times and Directions follow your choices.</li>
    <li><b>Ideas nearby</b> suggests well-known sights close to that day's places.</li></ul>`],
  ["bookings", "Bookings and flights", `<p>Add flights, trains, stays, rental cars and reservations with times and confirmation numbers. They appear on the right days in the itinerary.</p>
    <ul><li><b>Layovers</b>: add each stop in a flight. <b>Route map</b> on a flight draws the whole travel day with dashed lines through every layover. Tapping a travel day on the map shows the same thing.</li>
    <li><b>Tracking</b>: flights with a number get FlightAware and Flightradar24 links. <b>Watch for changes</b> alerts you to delays, gate changes and cancellations while Wayfinder is open (this needs the live-status key below).</li>
    <li><b>Find stays nearby</b> lists hotels, hostels and B&amp;Bs close to the places on your days, or near where your flight lands, with links to check prices. <i>Add as stay</i> fills in a booking for you.</li></ul>`],
  ["together", "Deciding together", `<p>Tap <b>💬</b> on any place to leave a comment for the group ("too touristy?", "her friend loved it"). On <b>Notes &amp; votes</b>, start a <b>quick vote</b> when you can't decide. Everyone taps an option, you see who picked what, and whoever started it closes the vote.</p>
    <p><b>Duplicate trip</b> (bottom of Overview) copies a trip as a starting point for the next one, with the dates moved.</p>`],
  ["parks", "Theme parks", `<p>On any itinerary day, tap <b>🎢 Theme park</b> and pick the park (Disneyland, California Adventure, Universal, Tokyo Disney and 70+ more). The <b>Theme parks</b> tab then has:</p>
    <ul><li><b>Park hours</b> for your date, including early entry and special ticketed events (posted about 1–2 months ahead).</li>
    <li><b>Park map</b>: every ride, show and restaurant appears on the map (purple rides, orange shows, green food). Tap one to see its wait and add it to your plan. Your plan shows as a numbered route. On a phone, tap <b>🗺 Park map</b>.</li>
    <li><b>Your plan</b>: pick rides, shows and food, star your <b>must-dos</b>, note Lightning Lane plans and return times, and drag to reorder. Each stop shows a rough time (≈ 10:15am) based on opening time, walking and typical waits.</li>
    <li><b>Best order</b>: <i>Rope drop</i> puts must-dos first while lines are short, <i>Shortest walk</i> avoids zigzagging, and on the day, <i>Shortest waits right now</i> re-plans using live waits.</li>
    <li><b>Who's riding</b>: add everyone's height, and rides with a minimum height flag anyone too short.</li>
    <li><b>Live wait times</b> on the day, shortest first, refreshing every 5 minutes, with single rider, Lightning Lane return times and showtimes. Today shows them too, and rides you check off go into the memory book.</li>
    <li><b>Wait alerts</b>: open a ride's details and set <i>Alert me under</i> (say 30 minutes). On the day, Wayfinder alerts you when the wait drops below it.</li>
    <li><b>Lightning Lane helper</b>: tap <i>I just booked one</i> and it counts down to when you can book the next. Return times you enter count down too, with a "Go now" nudge.</li>
    <li><b>Planned times</b>: give a show or dining reservation a time (today's showtimes are suggested) and it stays at that time in the plan and in Best order, with an alert 15 minutes before.</li>
    <li><b>Snacks and characters</b>: add a Dole Whip, churros or a character meet to your plan like any ride.</li>
    <li><b>Before you go</b>: booking reminders for the park day. Disneyland and Walt Disney World dining reservations (60 days ahead) are added automatically, and you can add your own, like buying tickets.</li></ul>
    <p>Park data comes from ThemeParks.wiki. Book Lightning Lanes in the official park app.</p>`],
  ["food", "Restaurants", `<p>The Restaurants tab gathers the places to eat and drink you've saved, plus your restaurant reservations. <b>Find places to eat</b> searches around the places on your days, by restaurants, cafés or bars, and <i>Save</i> adds one to your list.</p>`],
  ["gmail", "Import from Gmail", `<p>In <b>Bookings → Import from Gmail</b>, Wayfinder asks Google for read-only access, finds confirmation emails, and shows the flights, stays, cars, trains and reservations it can read. You pick which to add. Connecting flights on one booking become one flight with layovers. Emails are read in your browser and nothing else is kept.</p>
    <p>It works with emails that carry booking details for Gmail (most airlines, hotel chains, booking sites and rental companies). For the rest, it lists the email so you can add it by hand.</p>
    <p><b>One-time setup (trip owner):</b></p><ol><li>Open <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API in Google Cloud</a>, pick your Firebase project, and click <b>Enable</b>.</li>
    <li>In <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Google Auth Platform → Audience</a>: if it says <i>Testing</i>, add each person's Gmail under <b>Test users</b>.</li>
    <li>The first time, Google says it hasn't verified the app. That's expected for a personal app: click <b>Advanced → Go to …</b> and tick the box to allow reading email.</li></ol>`],
  ["budget", "Budget and money", `<p>Log what you spend in any currency. Wayfinder converts it to the trip's home currency with that day's exchange rate, splits it between the people you pick, and works out who owes whom. Bookings with a cost count too.</p To settle up, add how people can pay you (Venmo, PayPal, Cash App or Zelle). Whoever owes gets a pay button with the amount filled in, then taps <b>Mark paid</b>.</p>`],
  ["lists", "To-do and packing", `<p><b>To-do</b> is shared: assign tasks and set due dates. <b>Packing</b> is private: everyone on the trip has their own list. <b>Suggested for this trip</b> at the top of Packing adds things the weather and destinations call for, like an umbrella when rain is likely or the right plug adapter.</p>`],
  ["photos", "Photos and the family link", `<p><b>Photos</b> is a shared album: everyone on the trip can add photos (several at once), pick the day they belong to, add captions, and filter by day or person. Tap a photo to flip through them. They also go into the memory book.</p>
    <p><b>Family link</b> (in <b>Share</b>) makes a view-only page of the day-by-day plan, flights and where you're staying for family at home. They don't need to sign in. It leaves out costs, confirmation numbers, notes and photos, and turning it off deletes the page.</p>`],
  ["calendar", "Calendar and reminders", `<p><b>Add to calendar</b> (top of a trip) downloads a calendar file with your flights, check-ins, each day's plan and stops with times. Open it on your iPhone or Mac, or import it into Google Calendar. It includes alerts: 3 hours before a flight, when online check-in opens, and the day before free cancellation ends.</p>
    <p>In a booking, set <b>Free cancellation until</b> and, for flights, when <b>online check-in opens</b>. Bookings show these, and Wayfinder alerts you while it's open.</p>
    <p>For anything that has to be booked ahead (tickets that go on sale on a date, a popular restaurant), edit the place and set <b>Book by</b>. <b>Coming up</b> on Overview lists everything due soon, and these go into Add to calendar too.</p>
    <p>Add your <b>passport expiry date</b> in your profile, and Wayfinder warns you on any trip where you'd have less than 6 months left. Overview also shows the <b>time difference</b> and a simple <b>jet lag plan</b>, and Today shows the local time next to the time at home.</p>
    <p><b>Loyalty numbers</b> (picture menu, top right) are private to you. Each one shows on matching bookings, like your Atmos number on Alaska and Hawaiian flights, with a copy button.</p>`],
  ["guide", "Country guide", `<p>For each country on your trip: plug type and voltage, emergency numbers, tipping customs, entry steps for US passports with links to the official sites, and handy phrases. Tap 🔊 to hear a phrase (it uses your phone's voices, so it works offline). Entry rules change, so always confirm on the official sites before you fly.</p>`],
  ["export", "Export and offline", `<p><b>Export PDF</b> has two styles: a <b>Memory book</b> (photos, journal entries, places you visited) and a printable trip book (itinerary with route sketches, bookings, budget, lists). Pick what to include, then save as PDF. Once you've opened a trip, it keeps working offline, and your edits sync when you're back online.</p>`],
  ["google", "Google Maps (optional)", `<p>With a Google Maps key, Wayfinder uses Google for the map, for search (so it can tell branches like Ippudo Harajuku and Ippudo Shinjuku apart, with exact addresses), and for <i>Stays nearby</i> and <i>Find places to eat</i>, with ratings. Without a key, it uses the free OpenStreetMap versions.</p>
    <ol><li>In <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener">Google Cloud → Billing</a>, link a billing account to your Firebase project.</li>
    <li>Enable <a href="https://console.cloud.google.com/apis/library/maps-backend.googleapis.com" target="_blank" rel="noopener">Maps JavaScript API</a> and <a href="https://console.cloud.google.com/apis/library/places.googleapis.com" target="_blank" rel="noopener">Places API (New)</a>.</li>
    <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a>, click <b>Create credentials → API key</b>. Under <b>Application restrictions</b>, choose <b>Websites</b> and add <code>https://sallylsm.github.io/*</code>. Under <b>API restrictions</b>, pick the two APIs above.</li>
    <li>Add this line to <code>config.js</code>: <code>export const googleMapsKey = "your-key";</code></li>
    <li>To be sure it stays free: set daily limits on each API's <b>Quotas</b> page, and add a $1 alert in <b>Billing → Budgets &amp; alerts</b>.</li></ol>`],
  ["status", "Live flight status (optional)", `<p>Tracking links always work. To see live status and get change alerts inside Wayfinder, add a free flight-status key:</p>
    <ol><li>Make a free account at <a href="https://rapidapi.com/aedbx-aedbx/api/aerodatabox" target="_blank" rel="noopener">AeroDataBox on RapidAPI</a> and subscribe to the free <b>Basic</b> plan.</li>
    <li>Copy your <b>X-RapidAPI-Key</b> and add this line to <code>config.js</code>: <code>export const flightStatusKey = "your-key";</code></li></ol>
    <p>Status shows up in the week of each flight. Alerts work while Wayfinder is open in a tab or installed on your phone's home screen. For alerts when the app is closed, also turn on notifications in your airline's app.</p>`],
];
function renderHelp() {
  $("#crumb").textContent = "Guide"; $("#backBtn").hidden = false; $("#layoutSeg").hidden = true;
  $("#app").innerHTML = `<div class="help"><aside class="help-toc"><b>How to use Wayfinder</b>${HELP.map(([k, h]) => `<a href="#/help/${k}">${h}</a>`).join("")}</aside>
    <div class="help-body"><h1>How to use Wayfinder</h1><p class="hint">A quick tour of everything the planner does.</p>${HELP.map(([k, h, body], i) => `<section class="card" id="h-${k}"><h2><span class="help-n">${i + 1}</span>${h}</h2>${body}</section>`).join("")}</div></div>`;
  const sec = location.hash.split("/")[2]; if (sec) document.getElementById("h-" + sec)?.scrollIntoView();
  $(".help-toc").onclick = e => { const a = e.target.closest("a"); if (!a) return; e.preventDefault(); document.getElementById("h-" + a.getAttribute("href").split("/")[2])?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" }); };
  try { localStorage.setItem("trips-seen-help", "1"); } catch {}
}

// ================================================================ WEATHER (Open-Meteo: free, no key)
// forecast for the next ~2 weeks; before that, what the same dates were like over the last 5 years
const WXC = (() => { try { return JSON.parse(localStorage.getItem("trips-wx") || "{}"); } catch { return {}; } })();
const saveWx = debounce(() => { try { const keep = Object.entries(WXC).filter(([, v]) => Date.now() - v.at < 40 * 864e5).slice(-600); localStorage.setItem("trips-wx", JSON.stringify(Object.fromEntries(keep))); } catch {} }, 500);
const tDeg = c => c == null ? "–" : Math.round(useF() ? c * 9 / 5 + 32 : c) + "°";
const WXI = c => c == null ? "🌤️" : c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 57 ? "🌦️" : c <= 67 ? "🌧️" : c <= 77 ? "🌨️" : c <= 82 ? "🌧️" : c <= 86 ? "🌨️" : "⛈️";
const WXT = c => c == null ? "" : c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c <= 86 ? "Snow showers" : "Thunderstorms";
// where the day happens: its places, else your stay, else where your flight lands, else the trip's destination
function dayPoint(iso) {
  const pk = (T.days[iso]?.parks || []).find(p => p.lat != null); if (pk && !dayPlaces(iso).some(hasPt)) return { lat: pk.lat, lon: pk.lon };
  const pts = dayPlaces(iso).filter(hasPt);
  if (pts.length) return { lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length, lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length };
  const st = stayFor(iso); if (st && st[1].lat != null) return { lat: st[1].lat, lon: st[1].lon };
  const fl = Object.values(T.bookings).find(b => b.kind === "flight" && segDates(b).has(iso)); const ap = fl && airportOf(flightSegs(fl).filter(l => l.depDate === iso || l.arrDate === iso).pop()?.to);
  if (ap) return { lat: ap.lat, lon: ap.lon };
  const d = tripDests(T.trip).find(hasPt); return d ? { lat: d.lat, lon: d.lon } : null;
}
const wxKey = (pt, iso) => `${pt.lat.toFixed(1)},${pt.lon.toFixed(1)}|${iso}`;
function wxFor(iso) { const pt = dayPoint(iso); return pt ? WXC[wxKey(pt, iso)] || null : null; }
let wxBusy = false, wxSig = "";
async function loadWeather() {
  if (wxBusy || !navigator.onLine || !T.trip) return;
  const today = isoOf(new Date()), horizon = addDays(today, 15), groups = {};
  for (const iso of tripDays()) {
    const pt = dayPoint(iso); if (!pt) continue;
    const k = wxKey(pt, iso), c = WXC[k], fc = iso >= today && iso <= horizon;
    if (c && (fc ? c.fc && Date.now() - c.at < 3 * 36e5 : !c.fc && Date.now() - c.at < 30 * 864e5)) continue;
    if (iso < addDays(today, -1)) continue;   // past days: nothing to look up
    const g = `${pt.lat.toFixed(1)},${pt.lon.toFixed(1)}|${fc ? "f" : "t"}`; (groups[g] ||= { pt, fc, days: [] }).days.push(iso);
  }
  const sig = Object.keys(groups).join(";"); if (!sig || sig === wxSig) return;
  wxBusy = true; wxSig = sig;
  try {
    for (const g of Object.values(groups)) {
      const a = g.days[0], b = g.days[g.days.length - 1], ll = `latitude=${g.pt.lat.toFixed(3)}&longitude=${g.pt.lon.toFixed(3)}`;
      if (g.fc) {
        const j = await fetch(`https://api.open-meteo.com/v1/forecast?${ll}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&start_date=${a}&end_date=${b}`).then(r => r.json());
        (j.daily?.time || []).forEach((d, i) => { WXC[wxKey(g.pt, d)] = { fc: true, at: Date.now(), hi: j.daily.temperature_2m_max[i], lo: j.daily.temperature_2m_min[i], rain: j.daily.precipitation_probability_max?.[i], code: j.daily.weather_code[i] }; });
      } else {
        // the same dates in each of the last 5 years (Feb 29 → Feb 28)
        const y0 = +today.slice(0, 4), acc = {};
        for (let y = y0 - 5; y < y0; y++) {
          const shift = d => { const yy = +d.slice(0, 4) - (+a.slice(0, 4) - y); let md = d.slice(5); if (md === "02-29") md = "02-28"; return `${yy}-${md}`; };
          const j = await fetch(`https://archive-api.open-meteo.com/v1/archive?${ll}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&start_date=${shift(a)}&end_date=${shift(b)}`).then(r => r.json()).catch(() => null);
          (j?.daily?.time || []).forEach((d, i) => { const md = d.slice(5); const o = acc[md] ||= { hi: [], lo: [], wet: 0, n: 0, codes: [] }; if (j.daily.temperature_2m_max[i] == null) return; o.hi.push(j.daily.temperature_2m_max[i]); o.lo.push(j.daily.temperature_2m_min[i]); o.n++; if ((j.daily.precipitation_sum[i] || 0) >= 1) o.wet++; o.codes.push(j.daily.weather_code[i]); });
        }
        const avg = x => x.reduce((p, q) => p + q, 0) / x.length;
        for (const iso of g.days) { const o = acc[iso.slice(5) === "02-29" ? "02-28" : iso.slice(5)]; if (!o || !o.n) continue;
          const wet = Math.round(o.wet / o.n * 100), code = wet >= 50 ? 61 : wet >= 25 ? 80 : Math.round(avg(o.codes)) <= 1 ? 0 : 2;
          WXC[wxKey(g.pt, iso)] = { fc: false, at: Date.now(), hi: avg(o.hi), lo: avg(o.lo), rain: wet, code }; }
      }
    }
    saveWx();
  } catch {} finally { wxBusy = false; }
  if (cur && (cur.tab === "plan" || cur.tab === "today")) renderTrip(true);
}
function wxChip(iso, big) {
  const w = wxFor(iso); if (!w) return "";
  const tip = w.fc ? `${WXT(w.code)} forecast` : `Typical for this date (average of the last 5 years)${w.rain != null ? `: rain on ${w.rain}% of days` : ""}`;
  if (big) return `<div class="wx-big"><span class="wx-ic">${WXI(w.code)}</span><div><b>${tDeg(w.hi)} / ${tDeg(w.lo)}</b><span>${w.fc ? `${esc(WXT(w.code))}${w.rain != null ? ` · ${w.rain}% chance of rain` : ""}` : `Typical for this date · rain on ${w.rain}% of days`}</span><span class="hint">${w.fc ? "Forecast from Open-Meteo" : "Forecast shows up two weeks before"}</span></div></div>`;
  return `<span class="wx ${w.fc ? "" : "typ"}" title="${esc(tip)}">${WXI(w.code)} ${tDeg(w.hi)}/${tDeg(w.lo)}${w.fc ? "" : " avg"}</span>`;
}

// ================================================================ OPENING HOURS (Google places only)
const WDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
let hoursBusy = false;
async function loadHours() {
  if (hoursBusy || !useGoogle() || !navigator.onLine) return;
  const days = new Set(tripDays()), need = placeList().filter(p => p.gid && days.has(p.day) && (!p.hours || Date.now() - (p.hours.at || 0) > 30 * 864e5)).slice(0, 12);
  if (!need.length) return;
  hoursBusy = true; let n = 0;
  try {
    const { Place } = await gPlaces();
    for (const p of need) {
      try {
        const pl = new Place({ id: p.gid }); await pl.fetchFields({ fields: ["regularOpeningHours"] });
        const per = pl.regularOpeningHours?.periods || [];
        const hours = { at: Date.now() };
        if (!pl.regularOpeningHours) hours.none = true;
        else if (per.length === 1 && !per[0].close) hours.always = true;
        else hours.p = per.map(x => [x.open.day, x.open.hour * 60 + x.open.minute, x.close ? x.close.day : x.open.day, x.close ? x.close.hour * 60 + x.close.minute : 1440]);
        if (T.places[p.id]) { T.places[p.id] = { ...T.places[p.id], hours }; savePlace(p.id); n++; }
      } catch {}
    }
  } finally { hoursBusy = false; }
  if (n && cur && (cur.tab === "plan" || cur.tab === "today")) renderTrip(true);
}
const hm = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// is this place open on that day (and at the planned time)? → { cls, txt } or null when unknown
function hoursNote(p, iso) {
  const h = p.hours; if (!h || h.none || !validIso(iso)) return null;
  if (h.always) return { cls: "ok", txt: "Open 24 hours" };
  const wd = new Date(iso + "T12:00").getDay(), today = (h.p || []).filter(x => x[0] === wd);
  if (!today.length) return { cls: "bad", txt: `Closed on ${WDAY[wd]}s` };
  const spans = today.map(x => [x[1], x[2] === x[0] ? x[3] : x[3] + 1440]).sort((a, b) => a[0] - b[0]), txt = spans.map(([a, b]) => `${hm(a)}–${hm(b)}`).join(", ");
  if (p.time && /^\d\d:\d\d$/.test(p.time)) {
    const t = +p.time.slice(0, 2) * 60 + +p.time.slice(3);
    if (!spans.some(([a, b]) => t >= a && t < b)) return { cls: "warn", txt: `Open ${txt} on ${WDAY[wd]}s, not at ${p.time}` };
    const end = spans.find(([a, b]) => t >= a && t < b)[1];
    if (end - t < 45) return { cls: "warn", txt: `Closes at ${hm(end)}` };
  }
  return { cls: "ok", txt: `Open ${txt}` };
}
const hoursBadge = (p, iso) => { const n = hoursNote(p, iso); return n ? `<span class="hrs ${n.cls}" title="Regular opening hours from Google. Holidays may differ.">${n.cls === "bad" ? "⚠ " : n.cls === "warn" ? "⏰ " : ""}${esc(n.txt)}</span>` : ""; };

// ================================================================ TODAY
let todayIso = null;
function todayDefault() {
  const days = tripDays(), t = isoOf(new Date());
  return days.includes(t) ? t : t < days[0] ? days[0] : days[days.length - 1];
}
function viewToday(v) {
  const days = tripDays();
  if (!days.length) { v.innerHTML = `<div class="empty">Add the trip's dates in Overview to see each day here.</div>`; return; }
  const real = isoOf(new Date());
  if (!todayIso || !days.includes(todayIso)) todayIso = todayDefault();
  const iso = todayIso, i = days.indexOf(iso), isToday = iso === real, items = dayItems(iso), places = items.filter(x => x.k === "p");
  const next = places.find(p => !p.visited), bk = bookingsOn(iso), stay = stayFor(iso);
  let nextHtml = "";
  if (next) {
    const k = places.indexOf(next), prev = places.slice(0, k).reverse().find(hasPt);
    const d = prev && hasPt(next) ? km(prev, next) : null, md = legModeOf(iso, next, d ?? 0);
    const ll = `${next.lat},${next.lon}`;
    nextHtml = `<div class="card next-up" style="--tc:${TYPE[next.type].col}"><span class="k">${places.some(p => p.visited) ? "Up next" : isToday ? "First stop" : "First stop that day"}</span>
      <div class="row" style="gap:12px;align-items:center"><span class="thumb big">${photoSrcOf(next) ? `<img src="${esc(photoSrcOf(next))}" alt="" onerror="this.remove()">` : esc(next.name.charAt(0))}</span>
        <div class="grow"><h2>${esc(next.name)}</h2><span class="hint">${next.time ? `<b>${esc(next.time)}</b> · ` : ""}${esc(TYPE[next.type].label)}${next.addr ? " · " + esc(next.addr) : ""}</span>${hoursBadge(next, iso)}
        ${d != null ? `<span class="hint">${MODE_IC[md]} ${esc(legText(d, md))} from ${esc(prev.name)}</span>` : ""}</div></div>
      ${hasPt(next) ? `<div class="row" style="gap:8px;flex-wrap:wrap"><a class="btn accent small" href="https://maps.apple.com/directions?destination=${ll}&mode=${APPLE_MODE[md]}" target="_blank" rel="noopener">Directions in Apple Maps</a><a class="btn small" href="https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=${MODES[md].g}" target="_blank" rel="noopener">Google Maps</a><button class="btn ghost small" type="button" data-visit="${next.id}">Mark as visited ✓</button></div>` : `<button class="btn ghost small" type="button" data-visit="${next.id}">Mark as visited ✓</button>`}
    </div>`;
  } else if (places.length) nextHtml = `<div class="card"><b>All done for the day 🎉</b><p class="hint">You've visited every stop.</p></div>`;
  v.innerHTML = `<div class="today-nav row between"><button class="iconbtn" type="button" data-tday="${days[i - 1] || ""}" ${i ? "" : "disabled"} aria-label="Previous day">‹</button>
      <div style="text-align:center"><h2>${isToday ? "Today" : esc(fmtD(iso, { weekday: "long" }))}</h2><span class="hint">${esc(fmtD(iso, { weekday: isToday ? "long" : undefined, month: "long", day: "numeric" }))} · Day ${i + 1} of ${days.length}${!isToday && real < days[0] ? ` · in ${daysBetween(real, iso)} days` : ""}</span></div>
      <button class="iconbtn" type="button" data-tday="${days[i + 1] || ""}" ${i < days.length - 1 ? "" : "disabled"} aria-label="Next day">›</button></div>
    ${wxChip(iso, true)}
    ${isToday ? tzLine(iso) + comingUpHtml(3) : ""}
    ${bk.length || stay ? `<div class="card"><h3>Bookings</h3><div class="today-bk">${bk.map(x => `<button type="button" class="bk-mini" data-bedit="${x.id}">${x.txt}</button>`).join("")}${stay && !bk.some(x => x.id === stay[0]) ? `<button type="button" class="bk-mini" data-bedit="${stay[0]}"><b>Staying at</b> ${esc(stay[1].title || "your stay")}${stay[1].addr ? " · " + esc(stay[1].addr) : ""}</button>` : ""}</div></div>` : ""}
    ${todayParksHtml(iso)}
    ${nextHtml}
    <div class="card"><div class="row between"><h3>The plan</h3><a class="linkbtn" href="#/t/${cur.id}/plan" data-goday="${iso}">Edit in Itinerary</a></div>
      ${items.length ? `<ol class="today-list">${items.map(x => x.k === "n" ? (x.text ? `<li class="tl-note">${x.time ? `<b>${esc(x.time)}</b> ` : ""}${esc(x.text).replace(/\n/g, "<br>")}</li>` : "") : `<li class="${x.visited ? "done" : ""} ${x === next ? "is-next" : ""}"><label><input type="checkbox" data-visit="${x.id}" ${x.visited ? "checked" : ""} aria-label="Visited ${esc(x.name)}"><span class="tl-time">${esc(x.time || "")}</span><span class="grow"><b>${esc(x.name)}</b>${hoursBadge(x, iso)}</span></label></li>`).join("")}</ol>` : `<p class="hint">Nothing planned for this day yet.</p>`}
      ${T.days[iso]?.notes ? `<p class="today-notes">${esc(T.days[iso].notes)}</p>` : ""}</div>
    <div class="card"><h3>Journal</h3><textarea id="jr-${iso}" data-journal="${iso}" rows="3" maxlength="4000" placeholder="${isToday ? "How was today? A favorite moment, a meal to remember…" : "Notes or memories from this day"}">${esc(T.days[iso]?.journal || "")}</textarea><p class="hint">Journal entries go into the memory book (Export PDF → Memory book).</p></div>`;
  v.onclick = e => {
    const d = e.target.closest("[data-tday]"); if (d && d.dataset.tday) { todayIso = d.dataset.tday; renderTrip(); return; }
    const vb = e.target.closest("button[data-visit]"); if (vb) { const id = vb.dataset.visit; T.places[id] = { ...T.places[id], visited: true }; savePlace(id); renderTrip(); return; }
    const be = e.target.closest("[data-bedit]"); if (be) return bookingModal(be.dataset.bedit);
    const g = e.target.closest("[data-goday]"); if (g) { mapFocus = g.dataset.goday; scrollToDay = g.dataset.goday; fitPending = true; }
    const gp = e.target.closest("[data-gopark]"); if (gp) { const [a, c] = gp.dataset.gopark.split("|"); parkSel = { iso: a, pid: c }; }
  };
  fillTodayParks(iso);
  v.onchange = e => { const id = e.target.dataset?.visit; if (id && e.target.type === "checkbox") { T.places[id] = { ...T.places[id], visited: e.target.checked }; savePlace(id); renderTrip(); } };
  v.oninput = e => { const iso2 = e.target.dataset?.journal; if (iso2) { T.days[iso2] = { ...(T.days[iso2] || {}), journal: e.target.value.slice(0, 4000) }; saveDay(iso2, 800); } };
  loadWeather(); loadHours();
}

// ================================================================ REMINDERS (check-in opens, free cancellation ends)
const localDT = (d, t) => validIso(d) ? new Date(`${d}T${t || "00:00"}`) : null;
function reminders(withPast) {
  const out = [], now = Date.now();
  for (const [id, b] of Object.entries(T.bookings)) {
    const k = KINDS[b.kind] || KINDS.other, nm = b.title || k.label;
    if (validIso(b.cancelBy)) out.push({ id, at: localDT(b.cancelBy, "23:59"), kind: "cancel", txt: `Last day to cancel ${nm} for free`, short: `Free cancellation until ${fmtD(b.cancelBy, { weekday: "short", month: "short", day: "numeric" })}` });
    if (b.kind === "flight" && b.checkinH !== "0") {
      const f = flightSegs(b)[0], dep = localDT(f.depDate, f.depTime);
      if (dep && f.depTime) { const at = new Date(dep - (+(b.checkinH || 24)) * 36e5); out.push({ id, at, kind: "checkin", txt: `Online check-in opens for ${f.num || nm}`, short: `Check-in opens ${fmtD(isoOf(at), { weekday: "short", month: "short", day: "numeric" })} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` }); }
    }
  }
  for (const p of Object.values(T.places)) if (validIso(p.bookBy)) { const what = p.bookNote || "Book"; out.push({ id: p.id, at: localDT(p.bookBy, "09:00"), kind: "book", txt: `${what}: ${p.name}`, short: `${what} by ${fmtD(p.bookBy, { weekday: "short", month: "short", day: "numeric" })}` }); }
  for (const iso of parkDays()) for (const pk of T.days[iso].parks) for (const r of parkReminders(iso, pk)) out.push({ id: `park:${iso}:${pk.pid}:${r.id}`, at: localDT(r.d, "09:00"), kind: "book", txt: `${r.t} (${pk.name})`, short: r.t, park: { iso, pid: pk.pid } });
  return out.filter(r => r.at && (withPast || r.at > now - 864e5)).sort((a, b) => a.at - b.at);
}
const REM_IC = { cancel: "↩", checkin: "🛫", book: "📌", doc: "🛂" };
// passport (and Global Entry) from your profile: many countries want 6 months left after you travel
function docWarnings(t = T.trip) {
  if (!validIso(t?.end)) return [];
  const out = [], six = addDays(t.end, 182), abroad = tripCountries().length > 0;
  if (validIso(PROFILE.passportExp) && abroad) {
    if (PROFILE.passportExp < t.end) out.push({ lvl: "bad", txt: `Your passport expires ${fmtD(PROFILE.passportExp, { month: "short", day: "numeric", year: "numeric" })}, before this trip ends. Renew it now.` });
    else if (PROFILE.passportExp < six) out.push({ lvl: "warn", txt: `Your passport expires ${fmtD(PROFILE.passportExp, { month: "short", day: "numeric", year: "numeric" })}, less than 6 months after this trip. Many countries require 6 months left, so plan to renew (routine renewal takes weeks).` });
  }
  if (validIso(PROFILE.geExp) && PROFILE.geExp < t.end) out.push({ lvl: "warn", txt: `Your Global Entry / trusted traveler membership expires ${fmtD(PROFILE.geExp, { month: "short", day: "numeric", year: "numeric" })}, before this trip ends.` });
  return out;
}
function comingUpHtml(limit = 6) {
  const now = Date.now(), list = reminders().filter(r => r.at - now < 120 * 864e5).slice(0, limit), dw = docWarnings();
  if (!list.length && !dw.length) return "";
  return `<div class="card coming"><h3>Coming up</h3>
    ${dw.map(w => `<div class="warn-banner ${w.lvl}">🛂 ${esc(w.txt)}</div>`).join("")}
    ${list.map(r => { const d = Math.ceil((r.at - now) / 864e5); return `<div class="cu ${r.at < now ? "now" : remSoon(r) ? "soon" : ""}"><span class="cu-ic">${REM_IC[r.kind] || "•"}</span><span class="grow">${esc(r.txt)}</span><span class="hint">${r.at < now ? "today" : d <= 1 ? "tomorrow" : fmtD(isoOf(r.at), { month: "short", day: "numeric" }) + ` · ${d} days`}</span></div>`; }).join("")}</div>`;
}
const remSoon = r => r.at - Date.now() < 3 * 864e5;
function reminderFacts(id) { return reminders(true).filter(r => r.id === id).map(r => `<span class="rem ${r.at < Date.now() ? "past" : remSoon(r) ? "soon" : ""}">${REM_IC[r.kind] || ""} ${esc(r.short)}</span>`).join(""); }
// alerts while the app is open (the calendar export carries the same reminders as alarms)
function checkReminders() {
  if (!cur || !T.trip) return;
  let seen = {}; try { seen = JSON.parse(localStorage.getItem("trips-rem") || "{}"); } catch {}
  for (const r of reminders()) {
    const key = `${cur.id}|${r.id}|${r.kind}|${+r.at}`, dt = r.at - Date.now();
    const due = r.kind === "checkin" || r.kind === "book" ? dt <= 0 && dt > -(r.kind === "book" ? 15 : 6) * 36e5 : dt > 0 && dt < 24 * 36e5;
    if (due && !seen[key]) { seen[key] = 1; notify(r.kind === "checkin" ? "Check-in is open" : r.kind === "book" ? "Book today" : "Free cancellation ends soon", r.txt); }
  }
  try { localStorage.setItem("trips-rem", JSON.stringify(seen)); } catch {}
}
setInterval(checkReminders, 10 * 60 * 1000);

// ================================================================ CALENDAR EXPORT (.ics)
const icsEsc = x => String(x || "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsD = d => d.replace(/-/g, "");
// "floating" local times: they show at that clock time wherever your phone is, which suits travel
const icsT = (d, t) => `${icsD(d)}T${(t || "09:00").replace(":", "")}00`;
const icsAdd = (d, t, mins) => { const x = new Date(`${d}T${t || "09:00"}`); x.setMinutes(x.getMinutes() + mins); return icsT(isoOf(x), `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`); };
const icsFold = line => { const out = []; let l = line; while (l.length > 74) { out.push(l.slice(0, 74)); l = " " + l.slice(74); } out.push(l); return out.join("\r\n"); };
function icsText(o) {
  const t = T.trip, ev = [], stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const add = (uid, summary, start, end, { allDay, desc, loc, alarms = [] } = {}) => {
    const L2 = ["BEGIN:VEVENT", `UID:${uid}@wayfinder-${cur.id}`, `DTSTAMP:${stamp}`];
    if (allDay) { L2.push(`DTSTART;VALUE=DATE:${icsD(start)}`, `DTEND;VALUE=DATE:${icsD(end || addDays(start, 1))}`); }
    else { L2.push(`DTSTART:${start}`, `DTEND:${end > start ? end : start.slice(0, 9) + String(+start.slice(9, 11) + 1).padStart(2, "0") + start.slice(11)}`); }
    L2.push(`SUMMARY:${icsEsc(summary)}`); if (desc) L2.push(`DESCRIPTION:${icsEsc(desc)}`); if (loc) L2.push(`LOCATION:${icsEsc(loc)}`);
    for (const [trig, txt] of alarms) L2.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(txt)}`, `TRIGGER:${trig}`, "END:VALARM");
    L2.push("END:VEVENT"); ev.push(L2.map(icsFold).join("\r\n"));
  };
  if (o.bookings) for (const [id, b] of Object.entries(T.bookings)) {
    const k = KINDS[b.kind] || KINDS.other, conf = b.conf ? `Confirmation: ${b.conf}` : "", note = [conf, b.notes].filter(Boolean).join("\n");
    if (b.kind === "flight") flightSegs(b).forEach((l, i) => { if (!validIso(l.depDate)) return;
      add(`${id}-${i}`, `✈ ${l.num ? l.num + " " : ""}${l.from || "?"} → ${l.to || "?"}`, icsT(l.depDate, l.depTime), validIso(l.arrDate) && l.arrTime ? icsT(l.arrDate, l.arrTime) : icsAdd(l.depDate, l.depTime, 120),
        { allDay: !l.depTime, desc: [l.seat && "Seats: " + l.seat, note, "Times are local to each airport."].filter(Boolean).join("\n"), alarms: i === 0 && l.depTime ? [["-PT3H", "Head to the airport"]] : [] }); });
    else if (k.group === "transport" || k.group === "car") { if (validIso(b.depDate)) add(id, `${k.label}: ${b.title || [b.from, b.to].filter(Boolean).join(" → ")}`, icsT(b.depDate, b.depTime), validIso(b.arrDate) && b.arrTime ? icsT(b.arrDate, b.arrTime) : icsAdd(b.depDate, b.depTime, 60), { allDay: !b.depTime, desc: note, loc: b.from, alarms: b.depTime ? [["-PT1H", "Leave soon"]] : [] }); }
    else if (k.group === "lodging") {
      if (validIso(b.checkIn)) add(id + "-in", `Check in: ${b.title || "stay"}`, icsT(b.checkIn, b.checkInTime || "15:00"), icsAdd(b.checkIn, b.checkInTime || "15:00", 30), { desc: note, loc: b.addr });
      if (validIso(b.checkOut)) add(id + "-out", `Check out: ${b.title || "stay"}`, icsT(b.checkOut, b.checkOutTime || "11:00"), icsAdd(b.checkOut, b.checkOutTime || "11:00", 30), { loc: b.addr, alarms: [["-PT1H", "Check-out in an hour"]] });
    } else if (validIso(b.date)) add(id, `${k.label}: ${b.title || ""}`, b.time ? icsT(b.date, b.time) : b.date, b.time ? icsAdd(b.date, b.time, 90) : "", { allDay: !b.time, desc: note, loc: b.addr, alarms: b.time ? [["-PT1H", b.title || k.label]] : [] });
  }
  if (o.reminders) for (const r of reminders(true)) { const d = isoOf(r.at), tm = `${String(r.at.getHours()).padStart(2, "0")}:${String(r.at.getMinutes()).padStart(2, "0")}`;
    if (r.kind === "cancel") add(`${r.id}-cancel`, `↩ ${r.txt}`, d, "", { allDay: true, alarms: [["-PT15H", r.txt]] });
    else if (r.kind === "book") add(`${r.id.replace(/[^\w-]/g, "-")}-book`, `📌 ${r.txt}`, d, "", { allDay: true, alarms: [["PT8H", r.txt], ["-P1D", "Tomorrow: " + r.txt]] });
    else add(`${r.id}-checkin`, `🛫 ${r.txt}`, icsT(d, tm), icsAdd(d, tm, 15), { alarms: [["PT0M", r.txt]] }); }
  if (o.days || o.stops) tripDays().forEach((iso, i) => {
    const ps = dayPlaces(iso); if (!ps.length && !dayCards(iso).length) return;
    if (o.days) add(`day-${iso}`, `Day ${i + 1}: ${ps.map(p => p.name).slice(0, 4).join(", ")}${ps.length > 4 ? "…" : ""}`, iso, "", { allDay: true,
      desc: [...dayItems(iso).map(x => x.k === "n" ? (x.text ? `• ${x.time ? x.time + " " : ""}${x.text}` : "") : `${x.time ? x.time + " " : ""}${x.name}${x.addr ? " (" + x.addr + ")" : ""}`).filter(Boolean), T.days[iso]?.notes || ""].filter(Boolean).join("\n") });
    if (o.stops) ps.filter(p => p.time).forEach(p => add(`stop-${p.id}-${iso}`, p.name, icsT(iso, p.time), icsAdd(iso, p.time, 60), { loc: p.addr || [p.name, p.city].filter(Boolean).join(", "), alarms: [["-PT30M", p.name]] }));
  });
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Wayfinder//Trips//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEsc(t.name || "Trip")}`, ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n";
}
function calendarModal() {
  const o = (() => { try { return { bookings: true, reminders: true, days: true, stops: true, ...JSON.parse(localStorage.getItem("trips-ics") || "{}") }; } catch { return { bookings: true, reminders: true, days: true, stops: true }; } })();
  const opt = (k, l, h) => `<label class="ics-opt"><input type="checkbox" data-ics="${k}" ${o[k] ? "checked" : ""}><span><b>${l}</b><span class="hint">${h}</span></span></label>`;
  openModal(`<div class="row between"><h2>Add to calendar</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Downloads a calendar file. Open it on your iPhone or Mac to add everything to Apple Calendar, or import it in Google Calendar (Settings → Import). Times stay at the local clock time wherever you are.</p>
    <div class="ics-opts">${opt("bookings", "Bookings", "Flights, trains, hotel check-in and check-out, cars, reservations")}${opt("reminders", "Reminders", "Check-in opening, last day to cancel for free, and anything you need to book by a date")}${opt("days", "Each day's plan", "An all-day event listing the day's stops and notes")}${opt("stops", "Stops with a time", "Their own events, with a 30-minute heads-up")}</div>
    <p class="hint">If you add it again after changing plans, delete the old events first so nothing is doubled.</p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="icsGo">Download calendar file</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    $("#icsGo").onclick = () => {
      $$("[data-ics]", m).forEach(c => o[c.dataset.ics] = c.checked); try { localStorage.setItem("trips-ics", JSON.stringify(o)); } catch {}
      const blob = new Blob([icsText(o)], { type: "text/calendar;charset=utf-8" }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = (T.trip.name || "trip").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") + ".ics"; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000); closeModal(); toast("Calendar file downloaded. Open it to add the events.");
    };
  });
}

// ================================================================ LOYALTY NUMBERS (private to you)
const LOYP = [["Atmos Rewards (Alaska & Hawaiian)", "AS, HA, Alaska, Hawaiian"], ["Delta SkyMiles", "DL, Delta"], ["United MileagePlus", "UA, United"], ["American AAdvantage", "AA, American Airlines"], ["Southwest Rapid Rewards", "WN, Southwest"],
  ["JAL Mileage Bank", "JL, Japan Airlines, JAL"], ["ANA Mileage Club", "NH, ANA, All Nippon"], ["British Airways Club", "BA, British Airways"], ["Flying Blue (Air France-KLM)", "AF, KL, Air France, KLM"], ["Cathay", "CX, Cathay"],
  ["Marriott Bonvoy", "Marriott, Sheraton, Westin, Ritz-Carlton, St. Regis, Courtyard, Moxy, Aloft, Le Méridien, Renaissance, Autograph Collection, Four Points, Fairfield, Residence Inn, AC Hotel, W Hotel"],
  ["Hilton Honors", "Hilton, DoubleTree, Hampton, Conrad, Waldorf, Embassy Suites, Canopy, Curio, Tapestry, Homewood"], ["World of Hyatt", "Hyatt, Andaz, Thompson, Alila"], ["IHG One Rewards", "InterContinental, Holiday Inn, Crowne Plaza, Kimpton, Hotel Indigo, Staybridge, voco, Regent"],
  ["Hertz Gold Plus Rewards", "Hertz"], ["Enterprise Plus", "Enterprise"], ["National Emerald Club", "National"], ["Avis Preferred", "Avis"]];
let LOY = [], loyUnsub = null;
function subscribeLoyalty() { loyUnsub?.(); loyUnsub = onSnapshot(doc(fs, `users/${ME.uid}/prefs/loyalty`), s => { LOY = s.exists() ? (s.data().list || []) : []; if (cur?.tab === "bookings") renderTrip(true); }, () => {}); }
function loyaltyFor(b) {
  const nums = flightSegs(b).map(l => String(l.num || "").toUpperCase().replace(/\s/g, "")).filter(Boolean);
  const hay = [b.title, b.num, b.addr, ...(b.legs || []).map(l => l.num)].filter(Boolean).join(" ").toLowerCase();
  return LOY.filter(x => x.num && String(x.match || "").split(",").map(w => w.trim()).filter(Boolean).some(w =>
    /^[A-Z0-9]{2}$/.test(w) && b.kind === "flight" ? nums.some(n => n.startsWith(w)) : w.length > 2 && hay.includes(w.toLowerCase())));
}
const loyaltyHtml = b => loyaltyFor(b).map(x => `<span class="loy" title="Only you see this">🎟 ${esc(x.prog)} <b class="mono">${esc(x.num)}</b><button class="linkbtn" type="button" data-copy="${esc(x.num)}">Copy</button></span>`).join("");
function loyaltyModal() {
  let list = LOY.map(x => ({ ...x }));
  const paint = () => { $("#loyList").innerHTML = list.map((x, i) => `<div class="loy-row"><input class="input" data-li="${i}" data-lf="prog" value="${esc(x.prog)}" list="loyProgs" placeholder="Program" aria-label="Program">
      <input class="input mono" data-li="${i}" data-lf="num" value="${esc(x.num)}" placeholder="Member number" aria-label="Member number" maxlength="30">
      <input class="input" data-li="${i}" data-lf="match" value="${esc(x.match)}" placeholder="Shows on: airline codes or brands" aria-label="Shows on bookings matching">
      <button class="iconbtn del" type="button" data-ld="${i}" aria-label="Remove">×</button></div>`).join("") || `<p class="hint">No numbers yet.</p>`; };
  openModal(`<div class="row between"><h2>Loyalty numbers</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Only you can see these. Each number shows on your bookings that match it: an airline code like <b>AS</b> matches flight AS 841, and a brand like <b>Marriott</b> matches hotels with that name.</p>
    <datalist id="loyProgs">${LOYP.map(([p]) => `<option value="${esc(p)}">`).join("")}</datalist>
    <div id="loyList" class="loy-list"></div>
    <button class="linkbtn" type="button" id="loyAdd" style="justify-self:start">+ Add a number</button>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="loySave">Save</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paint();
    $("#loyAdd").onclick = () => { list.push({ id: uidGen(), prog: "", num: "", match: "" }); paint(); $$('[data-lf="prog"]', m).pop()?.focus(); };
    $("#loyList").addEventListener("input", e => { const i = e.target.dataset.li; if (i == null) return; const x = list[+i], f = e.target.dataset.lf; x[f] = e.target.value;
      if (f === "prog") { const p = LOYP.find(q => q[0] === e.target.value); if (p && !x.match) { x.match = p[1]; const mi = $(`[data-li="${i}"][data-lf="match"]`, m); if (mi) mi.value = p[1]; } } });
    $("#loyList").addEventListener("click", e => { const d = e.target.closest("[data-ld]"); if (d) { list.splice(+d.dataset.ld, 1); paint(); } });
    $("#loySave").onclick = async () => { const clean = list.filter(x => x.num.trim()).map(x => ({ id: x.id || uidGen(), prog: x.prog.trim().slice(0, 60) || "Loyalty", num: x.num.trim().slice(0, 30), match: x.match.trim().slice(0, 400) }));
      try { await setDoc(doc(fs, `users/${ME.uid}/prefs/loyalty`), { list: clean }); LOY = clean; closeModal(); toast("Saved. Only you can see these."); if (cur) renderTrip(); } catch (e) { fail(e); } };
  });
}

// ================================================================ COMMENTS ON PLACES
const commentsOf = p => Object.entries(p?.comments || {}).filter(([, c]) => c && c.text).sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
const cmtBtn = p => { const n = commentsOf(p).length; return `<button class="cmt-btn ${n ? "has" : ""}" type="button" data-cmt="${p.id}" aria-label="${n ? n + " comments" : "Comment"} on ${esc(p.name)}" title="Comments">💬${n ? " " + n : ""}</button>`; };
function commentsModal(pid) {
  const paint = () => {
    const p = T.places[pid]; if (!p) return closeModal();
    $("#cmList").innerHTML = commentsOf(p).map(([cid, c]) => `<div class="cmt ${c.by === ME.email ? "mine" : ""}">${avatar(c.by)}<div><span class="hint"><b>${esc(c.name || nameOf(c.by))}</b> · ${esc(new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</span><p>${esc(c.text).replace(/\n/g, "<br>")}</p></div>${c.by === ME.email ? `<button class="iconbtn del" type="button" data-cdel="${cid}" aria-label="Delete comment">×</button>` : ""}</div>`).join("") || `<p class="hint">No comments yet. Ask a question or share a tip.</p>`;
    const l = $("#cmList"); l.scrollTop = l.scrollHeight;
  };
  const p = T.places[pid];
  openModal(`<div class="row between"><h2>${esc(p.name)}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <div class="cmt-list" id="cmList"></div>
    <form class="cmt-add" id="cmForm"><textarea class="input" id="cmText" rows="2" maxlength="1000" placeholder="Write a comment…" aria-label="Comment"></textarea><button class="btn accent" type="submit">Post</button></form>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paint();
    const post = () => { const text = $("#cmText").value.trim(); if (!text) return; const cid = uidGen(), c = { by: ME.email, name: ME.name, text, at: Date.now() };
      T.places[pid] = { ...T.places[pid], comments: { ...(T.places[pid].comments || {}), [cid]: c } }; updateDoc(doc(fs, tp("places/" + pid)), { ["comments." + cid]: c }).catch(fail);
      $("#cmText").value = ""; paint(); renderTrip(); };
    $("#cmForm").onsubmit = e => { e.preventDefault(); post(); };
    $("#cmText").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); post(); } };
    $("#cmList").onclick = e => { const d = e.target.closest("[data-cdel]"); if (!d) return; const cid = d.dataset.cdel, cm = { ...(T.places[pid].comments || {}) }; delete cm[cid];
      T.places[pid] = { ...T.places[pid], comments: cm }; updateDoc(doc(fs, tp("places/" + pid)), { ["comments." + cid]: deleteField() }).catch(fail); paint(); renderTrip(); };
    setTimeout(() => $("#cmText")?.focus(), 30);
  });
}
// one click handler for comment buttons anywhere in the trip
document.addEventListener("click", e => { const b = e.target.closest("[data-cmt]"); if (b && cur) { e.preventDefault(); e.stopPropagation(); commentsModal(b.dataset.cmt); } }, true);

// ================================================================ QUICK VOTES
function pollsHtml() {
  const polls = Object.entries(T.polls || {}).sort((a, b) => (a[1].closed ? 1 : 0) - (b[1].closed ? 1 : 0) || (b[1].at || 0) - (a[1].at || 0));
  return `<div class="row between" style="margin-top:4px"><h2>Quick votes</h2><button class="btn small" type="button" id="newPoll">+ New vote</button></div>
    ${polls.map(([id, p]) => {
      const votes = p.votes || {}, total = Object.keys(votes).length, mine = votes[ekey(ME.email)];
      const counts = Object.fromEntries((p.opts || []).map(o => [o.id, Object.entries(votes).filter(([, v]) => v === o.id).map(([k]) => k)]));
      const top = Math.max(0, ...Object.values(counts).map(x => x.length));
      const waiting = members().filter(e => !votes[ekey(e)]);
      return `<div class="card poll ${p.closed ? "closed" : ""}" data-poll="${id}"><div class="row between"><h3>${esc(p.q)}</h3>${p.closed ? `<span class="pill">Decided</span>` : ""}</div>
        <div class="poll-opts">${(p.opts || []).map(o => { const who = counts[o.id] || [], pct = total ? who.length / total * 100 : 0, win = p.closed && who.length === top && top > 0;
          return `<button type="button" class="poll-opt ${mine === o.id ? "mine" : ""} ${win ? "win" : ""}" data-vote="${o.id}" ${p.closed ? "disabled" : ""}><i style="width:${pct}%"></i><span class="po-t">${win ? "🏆 " : ""}${esc(o.text)}</span><span class="po-n">${who.map(k => esc(nameOf(k.replace(/,/g, ".")))).join(", ")}</span></button>`; }).join("")}</div>
        <div class="row between"><span class="hint">${esc(nameOf(p.by))} asked${!p.closed && waiting.length ? ` · waiting on ${waiting.map(e => esc(nameOf(e))).join(", ")}` : ""}</span>
          <span class="row" style="gap:6px">${p.by === ME.email || isOwner() ? `${p.closed ? "" : `<button class="btn ghost small" type="button" data-pclose>Close vote</button>`}<button class="iconbtn del" type="button" data-pdel aria-label="Delete vote">×</button>` : ""}</span></div></div>`; }).join("") || `<p class="hint">Can't decide between two restaurants, or which day trip? Start a quick vote and everyone picks.</p>`}`;
}
function pollModal() {
  let opts = ["", ""];
  const names = placeList().map(p => p.name);
  const paint = () => { $("#pmOpts").innerHTML = opts.map((o, i) => `<div class="row" style="gap:6px"><input class="input grow" data-oi="${i}" value="${esc(o)}" list="pollPlaces" placeholder="Option ${i + 1}" maxlength="80" aria-label="Option ${i + 1}">${opts.length > 2 ? `<button class="iconbtn del" type="button" data-or="${i}" aria-label="Remove option">×</button>` : ""}</div>`).join(""); };
  openModal(`<div class="row between"><h2>New vote</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <label class="field" for="pmQ">Question<input id="pmQ" maxlength="100" placeholder="e.g. Dinner on Saturday?"></label>
    <datalist id="pollPlaces">${names.map(n => `<option value="${esc(n)}">`).join("")}</datalist>
    <div class="field"><span>Options <span class="hint" style="display:inline">(type anything, or pick a saved place)</span></span><div id="pmOpts" style="display:grid;gap:6px"></div><button class="linkbtn" type="button" id="pmAdd" style="justify-self:start">+ Add option</button></div>
    <p class="hint" id="pmMsg"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="pmGo">Start vote</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paint();
    $("#pmAdd").onclick = () => { if (opts.length >= 8) return; opts.push(""); paint(); $(`[data-oi="${opts.length - 1}"]`, m)?.focus(); };
    $("#pmOpts").oninput = e => { const i = e.target.dataset.oi; if (i != null) opts[+i] = e.target.value; };
    $("#pmOpts").onclick = e => { const r = e.target.closest("[data-or]"); if (r) { opts.splice(+r.dataset.or, 1); paint(); } };
    $("#pmGo").onclick = () => {
      const q = $("#pmQ").value.trim(), o = opts.map(x => x.trim()).filter(Boolean);
      if (!q) { $("#pmMsg").textContent = "Add a question."; return; } if (o.length < 2) { $("#pmMsg").textContent = "Add at least two options."; return; }
      const id = uidGen(), poll = { q: q.slice(0, 100), opts: o.map(t => ({ id: uidGen(), text: t.slice(0, 80), pid: placeList().find(p => p.name === t)?.id || "" })), votes: {}, by: ME.email, at: Date.now(), closed: false };
      T.polls[id] = poll; save(tp("polls/" + id), poll, 0); closeModal(); renderTrip();
    };
    setTimeout(() => $("#pmQ")?.focus(), 30);
  });
}
function wirePolls(v) {
  $("#newPoll").onclick = pollModal;
  v.addEventListener("click", e => {
    const card = e.target.closest("[data-poll]"); if (!card) return; const id = card.dataset.poll, p = T.polls[id]; if (!p) return;
    const vb = e.target.closest("[data-vote]");
    if (vb) { const k = ekey(ME.email), on = (p.votes || {})[k] !== vb.dataset.vote, votes = { ...(p.votes || {}) }; if (on) votes[k] = vb.dataset.vote; else delete votes[k];
      T.polls[id] = { ...p, votes }; updateDoc(doc(fs, tp("polls/" + id)), { ["votes." + k]: on ? vb.dataset.vote : deleteField() }).catch(fail); renderTrip(); return; }
    if (e.target.closest("[data-pclose]")) { T.polls[id] = { ...p, closed: true }; updateDoc(doc(fs, tp("polls/" + id)), { closed: true }).catch(fail); renderTrip(); return; }
    if (e.target.closest("[data-pdel]")) { if (!confirmTap(e.target.closest("[data-pdel]"))) return; delete T.polls[id]; remove(tp("polls/" + id)); renderTrip(); }
  });
}
// tap once to arm, again to confirm
function confirmTap(btn) { if (btn.dataset.armed) return true; btn.dataset.armed = "1"; btn.textContent = "Delete?"; btn.style.width = "auto"; setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "×"; btn.style.width = ""; } }, 3000); return false; }

// ================================================================ DUPLICATE A TRIP
function duplicateModal() {
  const t = T.trip;
  openModal(`<div class="row between"><h2>Duplicate trip</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Makes a new trip from this one, as a starting point. You'll be its planner.</p>
    <label class="field" for="dpName">Name<input id="dpName" maxlength="60" value="${esc((t.name || "Trip") + " (copy)")}"></label>
    <label class="field" for="dpStart">Starts on<input id="dpStart" type="date" value="${esc(t.start || "")}"></label>
    <div class="ics-opts">${[["places", "Places and the day-by-day plan", true], ["days", "Day notes, note bubbles and day colors", true], ["notes", "Notes", true], ["todo", "To-do list (unchecked)", true], ["packing", "My packing list (unchecked)", true], ["bookings", "Bookings, marked as estimates", false], ["people", "Invite the same people", false]]
      .map(([k, l, on]) => `<label class="ics-opt"><input type="checkbox" data-dp="${k}" ${on ? "checked" : ""}><span><b>${l}</b></span></label>`).join("")}</div>
    <p class="hint">Dates move with the new start date. Spending, photos, comments and votes stay with the original.</p>
    <p class="hint" id="dpMsg" role="status"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="dpGo">Duplicate</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    $("#dpGo").onclick = async () => {
      const inc = Object.fromEntries($$("[data-dp]", m).map(c => [c.dataset.dp, c.checked])), go = $("#dpGo"); go.disabled = true; $("#dpMsg").textContent = "Copying…";
      const start = $("#dpStart").value, off = validIso(start) && validIso(t.start) ? daysBetween(t.start, start) : 0, sh = d => validIso(d) && off ? addDays(d, off) : d;
      const nid = uidGen(), people = inc.people ? members() : [ME.email];
      const trip = { name: ($("#dpName").value.trim() || t.name || "Trip").slice(0, 60), dest: t.dest || null, dests: tripDests(t), start: sh(t.start || ""), end: sh(t.end || ""), members: people,
        names: Object.fromEntries(people.map(e => [ekey(e), nameOf(e)])), owner: ME.uid, ownerEmail: ME.email, created: Date.now(), currency: homeCur(), budget: num(t.budget), notes: inc.notes ? t.notes || "" : "", cover: t.cover || "", coverCredit: t.coverCredit || "", mode: t.mode || "walk" };
      try {
        await setDoc(doc(fs, "trips/" + nid), trip);
        const writes = [];
        if (inc.places) for (const [id, p] of Object.entries(T.places)) { const { comments, visited, hours, ...rest } = p; writes.push([`trips/${nid}/places/${id}`, { ...rest, day: sh(p.day || ""), hearts: {} }]); }
        if (inc.days) for (const [d, x] of Object.entries(T.days)) { const { journal, ...rest } = x || {}; writes.push([`trips/${nid}/days/${sh(d)}`, rest]); }
        if (inc.notes) for (const [id, n] of Object.entries(T.notes)) writes.push([`trips/${nid}/notes/${id}`, n]);
        if (inc.todo) for (const [id, c] of Object.entries(T.checklist)) writes.push([`trips/${nid}/checklist/${id}`, { ...c, done: false, due: sh(c.due || "") }]);
        if (inc.bookings) for (const [id, b] of Object.entries(T.bookings)) { const nb = { ...b, planned: true, conf: "", cancelBy: sh(b.cancelBy || "") };
          ["depDate", "arrDate", "checkIn", "checkOut", "date"].forEach(k => { if (nb[k]) nb[k] = sh(nb[k]); }); if (nb.legs) nb.legs = nb.legs.map(l => ({ ...l, depDate: sh(l.depDate), arrDate: sh(l.arrDate) }));
          writes.push([`trips/${nid}/bookings/${id}`, nb]); }
        for (let i = 0; i < writes.length; i += 400) { const bt = writeBatch(fs); writes.slice(i, i + 400).forEach(([path, data]) => bt.set(doc(fs, path), data)); await bt.commit(); }
        if (inc.packing && T.packing && !T.packing.empty) await setDoc(doc(fs, `users/${ME.uid}/packing/${nid}`), { groups: (T.packing.groups || []).map(g => ({ ...g, items: (g.items || []).map(it => ({ ...it, done: false })) })) });
        closeModal(); toast("Trip duplicated."); location.hash = `#/t/${nid}/overview`;
      } catch (e) { go.disabled = false; $("#dpMsg").textContent = e.code === "permission-denied" ? "Your account can't start trips yet. Ask whoever set up Wayfinder to add you under People & access." : "Couldn't duplicate the trip. Check your connection."; }
    };
  });
}

// ================================================================ COUNTRY GUIDE
let CG = null, cgLoading = null, cgPick = "";
const loadCG = () => CG ? Promise.resolve(CG) : (cgLoading ||= fetch("countries.json").then(r => r.json()).then(j => { CG = j; if (cur?.tab === "guide") renderTrip(); return j; }).catch(() => { cgLoading = null; return null; }));
const cgFind = n => { if (!CG || !n) return null; const q = String(n).trim().toLowerCase(); return CG.countries.find(c => c.name.toLowerCase() === q || c.aka.some(a => a.toLowerCase() === q)) || null; };
function tripCountries() {
  const seen = new Map();
  const add = n => { const c = cgFind(n); if (c && !seen.has(c.name)) seen.set(c.name, c); };
  tripDests(T.trip).forEach(d => { add(d.country); add(d.name); });
  placeList().forEach(p => add(p.country));
  Object.values(T.bookings).filter(b => b.kind === "flight").forEach(b => flightSegs(b).forEach(l => { const ap = airportOf(l.to); if (ap && CG) { const c = CG.countries.find(x => x.cc === ap.cc); if (c) add(c.name); } }));
  return [...seen.values()].filter(c => c.name !== "United States");
}
loadCG();
// ---- tap to hear a phrase (the phone's own voices; works offline on most phones)
const SPEECH = { ja: "ja-JP", ko: "ko-KR", yue: "zh-HK", zh: "zh-CN", zht: "zh-TW", th: "th-TH", vi: "vi-VN", fr: "fr-FR", es: "es-ES", it: "it-IT", de: "de-DE", ptp: "pt-PT", ptb: "pt-BR", nl: "nl-NL", da: "da-DK", sv: "sv-SE", no: "nb-NO", fi: "fi-FI", is: "is-IS", el: "el-GR", cs: "cs-CZ", hu: "hu-HU", pl: "pl-PL", hr: "hr-HR", tr: "tr-TR", id: "id-ID", ms: "ms-MY", fil: "fil-PH", hi: "hi-IN", ar: "ar-SA" };
const canSpeak = lang => "speechSynthesis" in window && !!SPEECH[lang];
function voiceFor(tag) {
  const vs = speechSynthesis.getVoices(), base = tag.split("-")[0];
  return vs.find(v => v.lang.replace("_", "-") === tag) || (base === "nb" && vs.find(v => /^no/.test(v.lang))) || (tag === "fil-PH" && vs.find(v => /^tl/.test(v.lang))) || vs.find(v => v.lang.startsWith(base));
}
if ("speechSynthesis" in window) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices(); }
function say(text, lang, btn) {
  const tag = SPEECH[lang]; if (!tag) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text), v = voiceFor(tag); u.lang = tag; if (v) u.voice = v; u.rate = 0.85;
  if (!v && speechSynthesis.getVoices().length) toast("Your phone doesn't have a voice for this language. Add one in Settings → Accessibility → Spoken Content (iPhone) or Text-to-speech (Android).");
  btn?.classList.add("on"); u.onend = u.onerror = () => btn?.classList.remove("on");
  speechSynthesis.speak(u);
}
function viewGuide(v) {
  if (!CG) { v.innerHTML = `<p class="hint">Loading…</p>`; loadCG(); return; }
  const list = tripCountries(), pick = cgFind(cgPick);
  const shown = pick && !list.includes(pick) ? [...list, pick] : list;
  const us = ["A", "B"], plugs = c => c.plugs.split(",").map(x => x.trim());
  const card = c => {
    const fits = plugs(c).some(p => us.includes(p)), hiV = c.v >= 200;
    const ph = CG.phrases[c.lang] || [];
    return `<section class="card cg" id="cg-${esc(c.name.replace(/\W+/g, "-"))}"><div class="row between"><h2>${esc(c.name)}</h2><span class="hint">${esc(c.cur)} · drives on the ${esc(c.drive)}</span></div>
      <div class="cg-grid">
        <div class="cg-tile"><span class="k">Plugs &amp; power</span><b>Type ${esc(c.plugs)} · ${c.v}V</b><span class="hint">${fits ? "Your US plugs fit." : `Bring a type ${esc(plugs(c)[0])} adapter.`} ${hiV ? "Phone and laptop chargers handle the voltage, but US hair tools may not." : ""}</span></div>
        <div class="cg-tile"><span class="k">Emergency</span><b>${esc(c.em)}</b><span class="hint">Save these in your phone.</span></div>
        <div class="cg-tile"><span class="k">Tipping</span><span>${esc(c.tip)}</span></div>
      </div>
      ${c.entry.length ? `<div class="cg-entry"><span class="k">Before you go <span class="hint" style="display:inline;text-transform:none;letter-spacing:0;font-weight:500">for US passports</span></span><ul>${c.entry.map(e => `<li>${esc(e.t)}${e.u ? ` <a class="ext" href="${esc(e.u)}" target="_blank" rel="noopener">Official site ↗</a>` : ""}</li>`).join("")}
        <li>Many countries need your passport valid 3–6 months past your trip. <a class="ext" href="https://travel.state.gov/content/travel/en/international-travel/International-Travel-Country-Information-Pages.html" target="_blank" rel="noopener">US State Dept country info ↗</a></li></ul></div>` : ""}
      ${ph.length ? `<div class="cg-ph"><span class="k">Handy phrases</span><table>${ph.map(([en, loc, rom]) => `<tr><td>${esc(en)}</td><td><b>${esc(loc)}</b>${rom ? `<span class="hint">${esc(rom)}</span>` : ""}</td><td>${canSpeak(c.lang) ? `<button class="iconbtn say" type="button" data-say="${esc(loc)}" data-lang="${esc(c.lang)}" aria-label="Hear ${esc(en)}">🔊</button>` : ""}</td></tr>`).join("")}</table></div>` : ""}</section>`;
  };
  v.innerHTML = `<div class="row between"><h2>Country guide</h2><select class="input" id="cgAdd" style="width:auto" aria-label="Look up another country"><option value="">Look up another country…</option>${CG.countries.map(c => `<option ${pick?.name === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
    <p class="hint">Plugs, emergency numbers, tipping, entry steps and a few phrases for the countries on this trip. Entry rules change, so always confirm on the official sites before you fly.</p>
    ${shown.length > 1 ? `<div class="chips">${shown.map(c => `<a class="chip" href="#cg-${esc(c.name.replace(/\W+/g, "-"))}" data-jump>${esc(c.name)}</a>`).join("")}</div>` : ""}
    ${shown.map(card).join("") || `<div class="empty">Add your destinations in Overview (or places with a country) and their guides show up here.</div>`}`;
  $("#cgAdd").onchange = e => { cgPick = e.target.value; renderTrip(); setTimeout(() => document.getElementById("cg-" + cgPick.replace(/\W+/g, "-"))?.scrollIntoView({ behavior: "smooth" }), 50); };
  v.onclick = e => { const sb = e.target.closest("[data-say]"); if (sb) return say(sb.dataset.say, sb.dataset.lang, sb);
    const a = e.target.closest("[data-jump]"); if (a) { e.preventDefault(); document.querySelector(a.getAttribute("href"))?.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" }); } };
}

// ================================================================ MEMORY BOOK (PDF)
function memoryHtml() {
  const t = T.trip, days = tripDays(), range = validIso(t.start) ? `${fmtD(t.start, { month: "long", day: "numeric" })} – ${fmtD(t.end, { month: "long", day: "numeric", year: "numeric" })}` : "";
  let kmTot = 0, nPlaces = 0;
  const countries = new Set(placeList().filter(p => days.includes(p.day) && p.country).map(p => p.country));
  let body = "";
  days.forEach((iso, i) => {
    const ps = dayPlaces(iso), went = ps.some(p => p.visited) ? ps.filter(p => p.visited) : ps;
    const pts = went.filter(hasPt); for (let k = 1; k < pts.length; k++) kmTot += km(pts[k - 1], pts[k]); nPlaces += went.length;
    const photos = Object.values(T.photos).filter(p => p.day === iso), j = T.days[iso]?.journal || "", notes = [T.days[iso]?.notes, ...dayCards(iso).map(c => c.text)].filter(Boolean);
    if (!went.length && !photos.length && !j && !notes.length && !(T.days[iso]?.parks || []).some(p => (p.items || []).some(i => i.done))) return;
    const col = colVal(dayColor(iso, i));
    body += `<article class="mb-day"><header><span class="mb-n" style="background:${col}">${i + 1}</span><div><h2>${esc(fmtD(iso, { weekday: "long", month: "long", day: "numeric" }))}</h2><span>${esc([...new Set(went.map(p => p.city).filter(Boolean))].join(" · "))}</span></div></header>
      ${photos.length ? `<div class="mb-photos n${Math.min(photos.length, 4)}">${photos.slice(0, 4).map(p => `<img src="${esc(p.data)}" alt="">`).join("")}</div>` : ""}
      ${j ? `<blockquote class="mb-journal">${esc(j).replace(/\n/g, "<br>")}</blockquote>` : ""}
      ${went.length ? `<ul class="mb-places">${went.map(p => `<li>${photoSrcOf(p) ? `<img src="${esc(photoSrcOf(p))}" alt="">` : `<span class="mb-ph">${esc(p.name.charAt(0))}</span>`}<span><b>${esc(p.name)}</b>${p.notes ? `<br><i>${esc(p.notes)}</i>` : ""}</span></li>`).join("")}</ul>` : ""}
      ${(T.days[iso]?.parks || []).map(p => { const d = (p.items || []).filter(i => i.done); return d.length ? `<p class="mb-rides">🎢 <b>${esc(p.name)}</b>: ${d.map(i => esc(i.name)).join(" · ")}</p>` : ""; }).join("")}
      ${notes.length ? `<p class="mb-notes">${notes.map(n => esc(n)).join("<br>")}</p>` : ""}</article>`;
  });
  return `<section class="mb-cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : ""}<div><h1>${esc(t.name || "Our trip")}</h1><p>${esc(range)}</p><p>${members().map(e => esc(nameOf(e))).join(" & ")}</p></div></section>
    <section class="mb-stats"><div><b>${days.length}</b><span>days</span></div><div><b>${nPlaces}</b><span>places</span></div><div><b>${Math.round(kmTot)}</b><span>km between stops</span></div><div><b>${countries.size || tripDests(t).length}</b><span>${(countries.size || tripDests(t).length) === 1 ? "country" : "countries"}</span></div></section>
    ${body || `<p class="hint">Add journal entries on the Today page, day photos and visited places, and they'll fill this book.</p>`}`;
}

// ================================================================ SETTLE UP: payment links
const payOf = e => (T.trip?.pay || {})[ekey(e)] || {};
function payLinks(t) {
  const p = payOf(t.to), amt = t.amt.toFixed(2), cur = homeCur(), note = encodeURIComponent((T.trip.name || "Trip") + " – settle up"), out = [];
  if (p.venmo && cur === "USD") out.push(`<a class="btn small pay venmo" href="https://venmo.com/?txn=pay&audience=private&recipients=${encodeURIComponent(p.venmo.replace(/^@/, ""))}&amount=${amt}&note=${note}" target="_blank" rel="noopener">Venmo</a>`);
  if (p.paypal) out.push(`<a class="btn small pay paypal" href="https://paypal.me/${encodeURIComponent(p.paypal.replace(/^.*paypal\.me\//i, ""))}/${amt}${cur}" target="_blank" rel="noopener">PayPal</a>`);
  if (p.cashapp && cur === "USD") out.push(`<a class="btn small pay cashapp" href="https://cash.app/$${encodeURIComponent(p.cashapp.replace(/^\$/, ""))}/${amt}" target="_blank" rel="noopener">Cash App</a>`);
  if (p.zelle) out.push(`<span class="hint">Zelle: ${esc(p.zelle)}</span>`);
  return out.join("");
}
function payModal() {
  const p = payOf(ME.email);
  openModal(`<div class="row between"><h2>How to pay you</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Add any of these and anyone who owes you gets a one-tap button with the amount filled in. Everyone on this trip can see them.</p>
    <label class="field" for="pyV">Venmo username<input id="pyV" value="${esc(p.venmo || "")}" placeholder="@your-name" maxlength="40"></label>
    <label class="field" for="pyP">PayPal.me name<input id="pyP" value="${esc(p.paypal || "")}" placeholder="yourname" maxlength="60"></label>
    <label class="field" for="pyC">Cash App $cashtag<input id="pyC" value="${esc(p.cashapp || "")}" placeholder="$yourname" maxlength="40"></label>
    <label class="field" for="pyZ">Zelle (phone or email to show)<input id="pyZ" value="${esc(p.zelle || "")}" maxlength="60"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="pySave">Save</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    $("#pySave").onclick = () => { const v = { venmo: $("#pyV").value.trim(), paypal: $("#pyP").value.trim(), cashapp: $("#pyC").value.trim(), zelle: $("#pyZ").value.trim() };
      T.trip.pay = { ...(T.trip.pay || {}), [ekey(ME.email)]: v }; updateDoc(doc(fs, "trips/" + cur.id), { ["pay." + ekey(ME.email)]: v }).catch(fail); closeModal(); renderTrip(); };
  });
}

// ================================================================ PEOPLE & ACCESS (who can start trips)
let ACCESS = null, accessUnsub = null;
function subscribeAccess() {
  accessUnsub?.();
  accessUnsub = onSnapshot(doc(fs, "settings/access"), s => { ACCESS = s.exists() ? s.data() : { missing: true }; $("#accessBtn").hidden = !canManage(); probeAdmin(); }, () => { ACCESS = { denied: true }; $("#accessBtn").hidden = true; });   // not allowed to read it: not an admin
}
// someone who can read the list but isn't marked as an admin yet: the rules decide, so try a harmless write once
let probed = false;
async function probeAdmin() {
  if (probed || !ACCESS || ACCESS.missing || ACCESS.denied || (ACCESS.admins || []).includes(ME.email)) return;
  probed = true;
  try { await updateDoc(doc(fs, "settings/access"), { admins: [...new Set([...(ACCESS.admins || []), ME.email])] }); } catch {}   // only an admin's write goes through
}
// the rules decide for real; this only decides whether to show the screen
const canManage = () => !!ACCESS && !ACCESS.denied && (ACCESS.missing || (ACCESS.admins || []).includes(ME.email));
function accessModal() {
  let list = [...(ACCESS?.creators || [])];
  const paint = () => { $("#acList").innerHTML = list.map((e, i) => `<div class="bal">${avatar(e)}<span class="grow"><b>${esc(nameOf(e) !== e ? nameOf(e) : e)}</b>${nameOf(e) !== e ? ` <span class="hint" style="display:inline">${esc(e)}</span>` : ""}</span><button class="iconbtn del" type="button" data-ar="${i}" aria-label="Remove ${esc(e)}">×</button></div>`).join("") || `<p class="hint">Only you so far.</p>`; };
  openModal(`<div class="row between"><h2>People & access</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Anyone with a Google account can sign in and edit the trips they're invited to (use <b>Share</b> on a trip). The people here can also <b>start their own trips</b>.</p>
    <div id="acList" style="display:grid;gap:8px"></div>
    <form class="row" id="acForm" style="gap:8px"><input class="input grow" id="acEmail" type="email" placeholder="their Google email" autocomplete="off" aria-label="Google email"><button class="btn small" type="submit">Add</button></form>
    <p class="hint" id="acMsg" role="status"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="acSave">Save</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paint();
    $("#acForm").onsubmit = e => { e.preventDefault(); const v = $("#acEmail").value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { $("#acMsg").textContent = "That doesn't look like an email address."; return; }
      if (v === ME.email || list.includes(v)) { $("#acMsg").textContent = "Already on the list."; return; }
      list.push(v); $("#acEmail").value = ""; $("#acMsg").textContent = ""; paint(); };
    $("#acList").onclick = e => { const r = e.target.closest("[data-ar]"); if (r) { list.splice(+r.dataset.ar, 1); paint(); } };
    $("#acSave").onclick = async () => {
      const pending = $("#acEmail").value.trim().toLowerCase(); if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(pending) && !list.includes(pending)) list.push(pending);
      const admins = [...new Set([...(ACCESS?.admins || []), ME.email])];
      try { await setDoc(doc(fs, "settings/access"), { admins, creators: list, updated: Date.now() }); closeModal(); toast("Saved. They can start trips now."); }
      catch (e) { $("#acMsg").innerHTML = e.code === "permission-denied" ? "Only the app's admin can change this. If that's you, put your email in <code>admin()</code> in the Firebase rules (one time)." : "Couldn't save. Check your connection."; }
    };
    setTimeout(() => $("#acEmail")?.focus(), 30);
  });
}

// ================================================================ PROFILE
let PROFILE = {}, profUnsub = null;
function subscribeProfile() {
  profUnsub?.();
  profUnsub = onSnapshot(doc(fs, `users/${ME.uid}/prefs/profile`), s => { PROFILE = s.exists() ? s.data() : {}; applyProfile(); }, () => {});
}
function applyProfile() {
  if (!ME) return;
  ME.name = (PROFILE.name || "").trim() || (ME.gname || "").split(" ")[0] || ME.email.split("@")[0];
  ME.photo = PROFILE.photo === "google" ? ME.gphoto : PROFILE.photo || "";
  const av = $("#meAv"); av.classList.toggle("has-img", !!ME.photo); av.innerHTML = ME.photo ? `<img src="${esc(ME.photo)}" alt="">` : esc(ME.name.charAt(0).toUpperCase());
  $("#meName").textContent = PROFILE.name || ME.gname || ME.name;
  if (cur && T.trip) renderTrip(true); else if (!cur && ME) renderHome?.();
}
// your name and photo travel with you onto every trip you're on, so others see them
async function pushProfileToTrips() {
  const ek = ekey(ME.email), photo = ME.photo && ME.photo.length < 60000 ? ME.photo : "";
  await Promise.all(Object.keys(TRIPS).map(id => updateDoc(doc(fs, "trips/" + id), { ["names." + ek]: ME.name, ["avatars." + ek]: photo }).catch(() => {})));
}
function syncProfileTo(id, t) {   // when opening a trip, fix anything out of date
  if (!ME || !t || !(t.members || []).includes(ME.email)) return;
  const ek = ekey(ME.email), photo = ME.photo && ME.photo.length < 60000 ? ME.photo : "";
  const patch = {};
  if ((t.names || {})[ek] !== ME.name) patch["names." + ek] = ME.name;
  if (((t.avatars || {})[ek] || "") !== photo) patch["avatars." + ek] = photo;
  if (Object.keys(patch).length) updateDoc(doc(fs, "trips/" + id), patch).catch(() => {});
}
function squareThumb(file, size = 160) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); const s = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas"); c.width = c.height = size;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size); res(c.toDataURL("image/jpeg", 0.82)); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("That file isn't an image this browser can read.")); };
    img.src = url;
  });
}
function profileModal() {
  let photo = PROFILE.photo || "";
  const shown = () => photo === "google" ? ME.gphoto : photo;
  const paintPhoto = () => { const s = shown(); $("#pfPic").innerHTML = s ? `<img src="${esc(s)}" alt="">` : esc(($("#pfName")?.value || ME.name).charAt(0).toUpperCase());
    $("#pfPic").style.setProperty("--av", avColor(ME.email)); $("#pfRemove").hidden = !photo; };
  openModal(`<div class="row between"><h2>Your profile</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <div class="pf-top"><span class="avatar pf-pic" id="pfPic"></span><div class="pf-btns">
      <label class="btn small file-btn">Upload a photo<input type="file" id="pfFile" accept="image/*"></label>
      ${ME.gphoto ? `<button class="btn ghost small" type="button" id="pfGoogle">Use my Google photo</button>` : ""}
      <button class="linkbtn" type="button" id="pfRemove">Remove photo</button></div></div>
    <label class="field" for="pfName">Name<input id="pfName" maxlength="40" value="${esc(PROFILE.name || ME.name)}" placeholder="What friends see on your trips"></label>
    <div class="field"><span>Email</span><span class="hint">${esc(ME.email)} · signed in with Google</span></div>
    <div class="grid2">
      <label class="field" for="pfAir">Home airport<input id="pfAir" maxlength="40" value="${esc(PROFILE.homeAirport || "")}" placeholder="e.g. ITO"><span class="hint" id="pfAirName"></span></label>
      <label class="field" for="pfCur">Home currency<select id="pfCur">${CURRENCIES.map(c => `<option ${c === (PROFILE.homeCur || "USD") ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    </div>
    <label class="field" for="pfTz">Home time zone<select id="pfTz">${(Intl.supportedValuesOf?.("timeZone") || [homeTz()]).map(z => `<option ${z === homeTz() ? "selected" : ""}>${esc(z)}</option>`).join("")}</select><span class="hint">Used for the time zone and jet lag tips on each trip.</span></label>
    <div class="grid2">
      <label class="field" for="pfPass">Passport expires<input id="pfPass" type="date" value="${esc(PROFILE.passportExp || "")}"></label>
      <label class="field" for="pfGE">Global Entry / TSA PreCheck expires<input id="pfGE" type="date" value="${esc(PROFILE.geExp || "")}"></label>
    </div>
    <p class="hint">Only the dates are saved, and only you can see them. Wayfinder warns you on any trip where your passport would have less than 6 months left.</p>
    <p class="hint">Your home airport fills in the first flight of new bookings, and your home currency is the default for new trips. Your name and photo show on every trip you're on.</p>
    <p class="hint" id="pfMsg" role="status"></p>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="pfSave">Save</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paintPhoto();
    const airHint = () => { const ap = airportOf($("#pfAir").value); $("#pfAirName").textContent = ap ? `${ap.code} · ${ap.name}` : ""; };
    loadAirports().then(airHint); $("#pfAir").oninput = airHint;
    $("#pfName").oninput = paintPhoto;
    $("#pfFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { photo = await squareThumb(f); paintPhoto(); } catch (err) { $("#pfMsg").textContent = err.message; } };
    $("#pfGoogle") && ($("#pfGoogle").onclick = () => { photo = "google"; paintPhoto(); });
    $("#pfRemove").onclick = () => { photo = ""; paintPhoto(); };
    $("#pfSave").onclick = async () => {
      const ap = airportOf($("#pfAir").value);
      const p = { name: $("#pfName").value.trim().slice(0, 40), photo, homeAirport: ap ? ap.code : $("#pfAir").value.trim().toUpperCase().slice(0, 40), homeCur: $("#pfCur").value, passportExp: validIso($("#pfPass").value) ? $("#pfPass").value : "", geExp: validIso($("#pfGE").value) ? $("#pfGE").value : "", homeTz: $("#pfTz").value, updated: Date.now() };
      const btn = $("#pfSave"); btn.disabled = true;
      try { await setDoc(doc(fs, `users/${ME.uid}/prefs/profile`), p); PROFILE = p; applyProfile(); await pushProfileToTrips(); closeModal(); toast("Profile saved."); }
      catch (e) { btn.disabled = false; $("#pfMsg").textContent = "Couldn't save. Check your connection."; }
    };
  });
}

// ================================================================ THEME PARKS (ThemeParks.wiki: free, no key)
const TPW = "https://api.themeparks.wiki/v1";
const tpCache = (k, ttl, fn) => {   // localStorage cache for park lists and ride catalogs
  try { const c = JSON.parse(localStorage.getItem("tp:" + k) || "null"); if (c && Date.now() - c.at < ttl) return Promise.resolve(c.v); } catch {}
  return fn().then(v => { try { localStorage.setItem("tp:" + k, JSON.stringify({ at: Date.now(), v })); } catch {} return v; });
};
const tpGet = path => fetch(TPW + path).then(r => { if (!r.ok) throw new Error("tp " + r.status); return r.json(); });
const tpDestinations = () => tpCache("dest", 7 * 864e5, () => tpGet("/destinations").then(j => (j.destinations || []).map(d => ({ id: d.id, name: d.name, parks: (d.parks || []).map(p => ({ id: p.id, name: p.name })) }))));
// everything inside a park we'd plan around: rides, shows, places to eat
const tpCatalog = pid => tpCache("cat:" + pid, 3 * 864e5, () => tpGet(`/entity/${pid}/children`).then(j => (j.children || [])
  .filter(c => ["ATTRACTION", "SHOW", "RESTAURANT"].includes(c.entityType))
  .map(c => ({ id: c.id, name: c.name, t: c.entityType, lat: c.location?.latitude ?? null, lon: c.location?.longitude ?? null }))
  .sort((a, b) => a.name.localeCompare(b.name))));
const tpSchedule = (pid, iso) => tpCache(`sch:${pid}:${iso.slice(0, 7)}`, 6 * 36e5, () => tpGet(`/entity/${pid}/schedule/${iso.slice(0, 4)}/${iso.slice(5, 7)}`).then(j => j.schedule || []));
const TPLIVE = {};   // pid -> { at, data: {id: live} }
async function tpLive(pid, force) {
  const c = TPLIVE[pid]; if (!force && c && Date.now() - c.at < 4 * 60e3) return c.data;
  const j = await tpGet(`/entity/${pid}/live`), data = {};
  (j.liveData || []).forEach(x => data[x.id] = x);
  TPLIVE[pid] = { at: Date.now(), data }; return data;
}
const TPT = { ATTRACTION: ["🎢", "Ride"], SHOW: ["🎭", "Show"], RESTAURANT: ["🍽️", "Dining"], SNACK: ["🍦", "Snack"], CHARACTER: ["🤝", "Character"] };
const LLOPT = [["", "Standby"], ["multi", "Lightning Lane Multi Pass"], ["single", "Lightning Lane Single Pass"], ["vq", "Virtual queue"], ["single-rider", "Single rider"]];
const parkDays = () => tripDays().filter(iso => (T.days[iso]?.parks || []).length);
const hhmm = t => String(t || "").slice(11, 16);   // park-local time from "2027-03-10T08:00:00-07:00"
const fmt12 = t => { if (!/^\d\d:\d\d/.test(t || "")) return t || ""; let [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${h}${m ? ":" + String(m).padStart(2, "0") : ""}${ap}`; };
const heightUnit = () => useF() ? "in" : "cm";
const showH = inches => !inches ? "" : useF() ? `${Math.round(inches)}″` : `${Math.round(inches * 2.54)} cm`;
const toInches = v => { const n = parseFloat(v); return !n ? 0 : useF() ? n : n / 2.54; };
function savePark(iso) { saveDay(iso, 400); }
function parkOf(iso, pid) { return (T.days[iso]?.parks || []).find(p => p.pid === pid); }
function updPark(iso, pid, fn) { T.days[iso] = { ...T.days[iso], parks: (T.days[iso]?.parks || []).map(p => p.pid === pid ? fn({ ...p, items: [...(p.items || [])] }) : p) }; savePark(iso); }

// ---- add a park to a day
function parkPickModal(iso) {
  openModal(`<div class="row between"><h2>Theme park day</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">${esc(dayLabel(iso))}. Pick the park you'll be at. Doing a park hopper? Add more than one.</p>
    <input class="input" id="tpQ" placeholder="Search: Disneyland, Universal, Tokyo Disney…" autocomplete="off" aria-label="Search parks">
    <div id="tpList" class="tp-list"><p class="hint">Loading parks…</p></div>
    <p class="hint">Park data from <a class="ext" href="https://themeparks.wiki" target="_blank" rel="noopener">ThemeParks.wiki ↗</a></p>`, async m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    let dests = [];
    try { dests = await tpDestinations(); } catch { $("#tpList").innerHTML = `<p class="hint">Couldn't reach the theme park data service. Check your connection and try again.</p>`; return; }
    const have = new Set((T.days[iso]?.parks || []).map(p => p.pid));
    const paint = () => {
      const q = $("#tpQ").value.trim().toLowerCase();
      const L2 = dests.map(d => ({ ...d, parks: d.parks.filter(p => !q || (p.name + " " + d.name).toLowerCase().includes(q)) })).filter(d => d.parks.length).slice(0, 30);
      $("#tpList").innerHTML = L2.map(d => `<div class="tp-dest"><b>${esc(d.name)}</b>${d.parks.map(p => `<button type="button" class="tp-park ${have.has(p.id) ? "on" : ""}" data-pid="${esc(p.id)}" data-pn="${esc(p.name)}" data-dn="${esc(d.name)}">${have.has(p.id) ? "✓ " : "🎢 "}${esc(p.name)}</button>`).join("")}</div>`).join("") || `<p class="hint">No parks match.</p>`;
    };
    paint(); $("#tpQ").oninput = paint; $("#tpQ").focus();
    $("#tpList").onclick = async e => {
      const b = e.target.closest("[data-pid]"); if (!b || have.has(b.dataset.pid)) return;
      b.disabled = true; b.textContent = "Adding…";
      let lat = null, lon = null;
      try { const cat = await tpCatalog(b.dataset.pid), pts = cat.filter(c => c.lat != null); if (pts.length) { lat = pts.reduce((a, c) => a + c.lat, 0) / pts.length; lon = pts.reduce((a, c) => a + c.lon, 0) / pts.length; } } catch {}
      T.days[iso] = { ...(T.days[iso] || {}), parks: [...(T.days[iso]?.parks || []), { pid: b.dataset.pid, name: b.dataset.pn, dest: b.dataset.dn, lat, lon, items: [] }] };
      saveDay(iso, 0); closeModal(); location.hash = `#/t/${cur.id}/parks`; parkSel = { iso, pid: b.dataset.pid };
    };
  });
}

// ---- pick rides, shows and food
function parkItemsModal(iso, pid) {
  const pk = parkOf(iso, pid); let filt = "ATTRACTION";
  openModal(`<div class="row between"><h2>${esc(pk.name)}</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><input class="input grow" id="tiQ" placeholder="Search rides, shows, restaurants" autocomplete="off" aria-label="Search">
      <div class="seg" role="group" aria-label="Type">${Object.entries(TPT).map(([k, [ic, l]]) => `<button type="button" data-tf="${k}" aria-pressed="${k === filt}">${ic} ${l}s</button>`).join("")}</div></div>
    <div id="tiList" class="ti-list"><p class="hint">Loading…</p></div>
    <div class="row" style="justify-content:space-between"><span class="hint" id="tiN"></span><button class="btn accent" type="button" data-close>Done</button></div>`, async m => {
    $$("[data-close]", m).forEach(x => x.onclick = () => { closeModal(); renderTrip(); });
    let cat = [];
    try { cat = await tpCatalog(pid); } catch { $("#tiList").innerHTML = `<p class="hint">Couldn't load this park's list. Check your connection.</p>`; return; }
    const sel = () => new Set((parkOf(iso, pid)?.items || []).map(i => i.eid));
    const paint = () => {
      const q = $("#tiQ").value.trim().toLowerCase(), S = sel();
      const L2 = cat.filter(c => c.t === filt && (!q || c.name.toLowerCase().includes(q)));
      $("#tiList").innerHTML = L2.map(c => `<label class="ti-row"><input type="checkbox" data-eid="${esc(c.id)}" ${S.has(c.id) ? "checked" : ""}><span>${esc(c.name)}</span></label>`).join("") || `<p class="hint">Nothing here.</p>`;
      $("#tiN").textContent = `${S.size} picked`;
    };
    paint(); $("#tiQ").oninput = paint;
    m.querySelector(".seg").onclick = e => { const b = e.target.closest("[data-tf]"); if (!b) return; filt = b.dataset.tf; $$("[data-tf]", m).forEach(x => x.setAttribute("aria-pressed", x === b)); paint(); };
    $("#tiList").onchange = e => {
      const id = e.target.dataset.eid; if (!id) return; const c = cat.find(x => x.id === id);
      updPark(iso, pid, p => { if (e.target.checked) p.items.push({ eid: c.id, name: c.name, t: c.t, lat: c.lat, lon: c.lon, must: false, ll: "", llTime: "", minH: 0, done: false, notes: "" }); else p.items = p.items.filter(i => i.eid !== id); return p; });
      $("#tiN").textContent = `${sel().size} picked`;
    };
  });
}

// suggested order: must-dos first (rope drop), then the rest, each group walking the shortest way
function suggestOrder(items) {
  const walk = (list, start) => { const out = [], left = list.slice(); let at = start;
    while (left.length) { left.sort((a, b) => (at && a.lat != null && b.lat != null ? km(at, a) - km(at, b) : 0)); const n = left.shift(); out.push(n); if (n.lat != null) at = n; }
    return out; };
  const must = items.filter(i => i.must && !i.done), rest = items.filter(i => !i.must && !i.done), done = items.filter(i => i.done);
  const a = walk(must, null), b = walk(rest, [...a].reverse().find(i => i.lat != null) || null);
  return [...a, ...b, ...done];
}

// ---- ride order: rope drop, shortest walk, or shortest waits right now
const walkMin = (a, b) => a && b && a.lat != null && b.lat != null ? Math.round(km(a, b) / 4.5 * 60 * 1.3) : 4;   // paths wind, so ×1.3
const DEF_WAIT = { ATTRACTION: 35, SHOW: 25, RESTAURANT: 45, SNACK: 10, CHARACTER: 20 }, RIDE_LEN = { ATTRACTION: 8, SHOW: 25, RESTAURANT: 0, SNACK: 5, CHARACTER: 5 };
const hm2m = t => /^\d\d:\d\d$/.test(t || "") ? +t.slice(0, 2) * 60 + +t.slice(3) : null;
const liveWait = (pid, it) => { const l = TPLIVE[pid]?.data?.[it.eid]; return l?.status === "OPERATING" ? (l.queue?.STANDBY?.waitTime ?? null) : l && l.status && l.status !== "OPERATING" ? Infinity : null; };
// items planned for a set time stay put: the rest are ordered, then each timed item slots in where the day reaches its time
function orderBy(items, how, pid, iso) {
  const timed = items.filter(i => !i.done && hm2m(i.at) != null), free = items.filter(i => !timed.includes(i));
  let seq = orderFree(free, how, pid);
  for (const a of timed.sort((x, y) => hm2m(x.at) - hm2m(y.at))) {
    const est = estTimes(iso || "", pid, seq).at; let k = seq.findIndex(i => !i.done && est[i.eid] != null && est[i.eid] >= hm2m(a.at));
    if (k < 0) k = seq.length; seq = [...seq.slice(0, k), a, ...seq.slice(k)];
  }
  return seq;
}
function orderFree(items, how, pid) {
  if (how === "rope") return suggestOrder(items);
  // shows and meals run on their own schedule, so they go after the rides; you can drag them into place
  const done = items.filter(i => i.done), todo = items.filter(i => !i.done && (how !== "waits" || i.t === "ATTRACTION")), later = how === "waits" ? items.filter(i => !i.done && i.t !== "ATTRACTION") : [];
  const out = []; let at = [...done].reverse().find(i => i.lat != null) || null, left = todo.slice();
  while (left.length) {
    const cost = i => walkMin(at, i) + (how === "waits" ? (() => { const w = liveWait(pid, i); return w === Infinity ? 1e4 : (w ?? DEF_WAIT[i.t] ?? 30); })() : 0) - (i.must ? (how === "waits" ? 25 : 3) : 0);
    left.sort((a, b) => cost(a) - cost(b)); const n = left.shift(); out.push(n); if (n.lat != null) at = n;
  }
  return [...done, ...out, ...later];
}
function orderModal(iso, pid) {
  const pk = parkOf(iso, pid), open = Object.values(TPLIVE[pid]?.data || {}).some(l => l.status === "OPERATING");
  const opt = (k, t, d, dis) => `<button type="button" class="order-opt" data-how="${k}" ${dis ? "disabled" : ""}><b>${t}</b><span>${d}</span></button>`;
  openModal(`<div class="row between"><h2>Best order</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Reorders what you haven't done yet at ${esc(pk.name)}. Anything with a planned time (a show, a dining reservation) stays at its time. You can still drag things around afterwards.</p>
    <div class="order-opts">${opt("rope", "🌅 Rope drop", "Must-dos first while lines are short at opening, then the shortest walk for the rest. Best for planning ahead.")}
      ${opt("walk", "🚶 Shortest walk", "The least walking from ride to ride, so you don't zigzag across the park.")}
      ${opt("waits", "⏱️ Shortest waits right now", open ? "Uses live wait times: picks the next ride that saves the most time between walking and waiting. Must-dos get priority, and rides that are down go last." : "Available while the park is open. Use it on the day to re-plan as lines change.", !open)}</div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal);
    m.querySelector(".order-opts").onclick = e => { const b = e.target.closest("[data-how]"); if (!b) return;
      updPark(iso, pid, p => { p.items = orderBy(p.items, b.dataset.how, pid, iso); return p; }); closeModal(); renderTrip(); renderMap(); toast(b.dataset.how === "waits" ? "Re-planned around the current waits." : "Reordered."); };
  });
}
// rough timeline: start at opening (or now, on the day), add walking + waiting + ride time
const PKOPEN = {};
function estTimes(iso, pid, items) {
  const isToday = iso === isoOf(new Date()), nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const o = PKOPEN[pid + iso]; let t = o != null ? o : 9 * 60;
  if (isToday && nowM > t) t = nowM;
  const out = {}; let at = null;
  for (const it of items) {
    if (it.done) { if (it.lat != null) at = it; continue; }
    t += walkMin(at, it);
    if (hm2m(it.at) != null) t = Math.max(t, hm2m(it.at));   // planned for a set time (a show, a meal)
    else if (it.ll && /^\d\d:\d\d$/.test(it.llTime || "")) { const r = +it.llTime.slice(0, 2) * 60 + +it.llTime.slice(3); t = Math.max(t, r) + 10; }
    else { const w = isToday ? liveWait(pid, it) : null; t += w == null || w === Infinity ? DEF_WAIT[it.t] ?? 30 : w; }
    out[it.eid] = t; t += RIDE_LEN[it.t] ?? 8; if (it.lat != null) at = it;
  }
  return { at: out, end: t };
}
const mm12 = m => fmt12(`${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`);
// ---- the park on the map: every ride and show, with yours numbered
let mapCat = { pid: null, items: null };
function parkMapLayer(pts, add) {
  const { iso, pid } = parkSel, pk = parkOf(iso, pid); if (!pk) return;
  if (mapCat.pid !== pid) { mapCat = { pid, items: null }; tpCatalog(pid).then(c => { if (mapCat.pid === pid) { mapCat.items = c; fitPending = true; renderMap(); } }).catch(() => {}); }
  const planned = new Map(pk.items.map((i, k) => [i.eid, k])), col = colVal(dayColor(iso, tripDays().indexOf(iso)));
  const TC = { ATTRACTION: "#7646B3", SHOW: "#E08A1E", RESTAURANT: "#2E9E78" };
  const live = TPLIVE[pid]?.data || {};
  const popup = c => { const l = live[c.id], w = l?.status === "OPERATING" ? (l.queue?.STANDBY?.waitTime != null ? `${l.queue.STANDBY.waitTime} min wait now` : "Open now") : l?.status ? l.status.toLowerCase() : "";
    return `<b>${TPT[c.t][0]} ${esc(c.name)}</b>${w ? `<br><span style="color:var(--muted)">${esc(w)}</span>` : ""}<br><button class="btn small ${planned.has(c.id) ? "ghost" : "accent"}" type="button" data-mapadd="${esc(c.id)}" style="margin-top:6px">${planned.has(c.id) ? "Remove from plan" : "+ Add to plan"}</button>`; };
  (mapCat.items || []).filter(c => c.lat != null && !planned.has(c.id)).forEach(c => L.circleMarker([c.lat, c.lon], { radius: 5, color: "#fff", weight: 1.5, fillColor: TC[c.t], fillOpacity: .85 }).addTo(layer).bindPopup(popup(c)).bindTooltip(c.name, { direction: "top", offset: [0, -4] }));
  const its = pk.items.filter(i => i.lat != null && !i.done);
  if (its.length > 1) L.polyline(its.map(i => [i.lat, i.lon]), { color: col, weight: 3, opacity: .75, dashArray: "5 6" }).addTo(layer);
  pk.items.filter(i => i.lat != null).forEach(it => add(it.lat, it.lon, icon(it.done ? "✓" : String(its.indexOf(it) + 1), "num", it.done ? "#8a96a3" : it.must ? "#C9A227" : col, 24), popup({ id: it.eid, name: it.name, t: it.t })));
  const bounds = its.length ? its : (mapCat.items || []).filter(c => c.lat != null);
  bounds.forEach(c => pts.push([c.lat, c.lon]));
  if (!bounds.length && pk.lat != null) pts.push([pk.lat, pk.lon]);
}
document.addEventListener("click", e => {
  const b = e.target.closest("[data-mapadd]"); if (!b || !parkSel) return;
  const { iso, pid } = parkSel, id = b.dataset.mapadd, c = (mapCat.items || []).find(x => x.id === id);
  updPark(iso, pid, p => { if (p.items.some(i => i.eid === id)) p.items = p.items.filter(i => i.eid !== id); else if (c) p.items.push({ eid: c.id, name: c.name, t: c.t, lat: c.lat, lon: c.lon, must: false, ll: "", llTime: "", minH: 0, done: false, notes: "" }); return p; });
  map?.closePopup(); renderTrip(); renderMap();
});

// ---- Lightning Lane helper: when you can book the next one, and countdowns to your return times
const minsTo = hhmmStr => { const m = hm2m(hhmmStr); if (m == null) return null; const n = new Date(); return m - (n.getHours() * 60 + n.getMinutes()); };
const inTxt = m => m <= 0 ? "now" : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)}h ${m % 60}m`;
function llCard(iso, pid, pk) {
  const isToday = iso === isoOf(new Date()), rides = (pk.items || []).filter(i => i.ll && !i.done && hm2m(i.llTime) != null).sort((a, b) => hm2m(a.llTime) - hm2m(b.llTime));
  if (!(pk.items || []).some(i => i.ll && i.ll !== "single-rider") && !pk.llNext) return "";
  const next = hm2m(pk.llNext), left = next != null && isToday ? minsTo(pk.llNext) : null;
  return `<div class="card ll-card"><div class="row between"><h3>⚡ Lightning Lane</h3>${isToday ? `<button class="btn small" type="button" id="llBooked">I just booked one</button>` : ""}</div>
    ${next != null ? `<p class="ll-next"><b>${left != null && left <= 0 ? "You can book your next Lightning Lane now" : `Next booking: ${fmt12(pk.llNext)}`}</b>${left != null && left > 0 ? ` · ${inTxt(left)}` : ""} <button class="linkbtn" type="button" id="llClear">Clear</button></p>`
      : `<p class="hint">${isToday ? "Tap <b>I just booked one</b> and Wayfinder will tell you when you can book the next (2 hours later, or sooner once you tap in)." : "On the day, use this to keep track of when you can book your next Lightning Lane."}</p>`}
    <label class="field" style="max-width:220px">Next booking at<input type="time" id="llNextIn" value="${esc(pk.llNext || "")}"></label>
    ${rides.length ? `<div class="ll-returns">${rides.map(r => { const m = isToday ? minsTo(r.llTime) : null; return `<div class="tl-row"><span><b>${esc(r.name)}</b><span class="hint">Return at ${fmt12(r.llTime)}${m != null ? " · " + (m < -60 ? "window passed" : inTxt(m)) : ""}</span></span>${m != null && m <= 15 && m > -60 ? `<b class="wt lo">Go now</b>` : ""}</div>`; }).join("")}</div>` : ""}
    <p class="hint">Book Lightning Lanes in the official park app. Wayfinder only keeps the times.</p></div>`;
}
// ---- before you go: booking windows for this park day
const isDisney = pk => /disney/i.test((pk.dest || "") + " " + pk.name);
function parkReminders(iso, pk) {
  const out = (pk.rem || []).map(r => ({ id: r.id, d: r.d, t: r.t, custom: true }));
  if (isDisney(pk) && /disneyland resort|walt disney world/i.test(pk.dest || "")) out.unshift({ id: "dining", d: addDays(iso, -60), t: `Dining reservations open for ${fmtD(iso, { month: "short", day: "numeric" })} (60 days ahead)` });
  return out.sort((a, b) => a.d.localeCompare(b.d));
}
function beforeCard(iso, pid, pk) {
  const rs = parkReminders(iso, pk), today = isoOf(new Date());
  return `<div class="card"><h3>📅 Before you go</h3>
    ${rs.length ? `<div class="bf-list">${rs.map(r => `<div class="bf ${r.d < today ? "past" : daysBetween(today, r.d) <= 7 ? "soon" : ""}"><b>${esc(fmtD(r.d, { weekday: "short", month: "short", day: "numeric", year: r.d.slice(0, 4) !== today.slice(0, 4) ? "numeric" : undefined }))}</b><span>${esc(r.t)}</span>${r.custom ? `<button class="iconbtn del" type="button" data-bfdel="${esc(r.id)}" aria-label="Remove reminder">×</button>` : ""}</div>`).join("")}</div>` : ""}
    <form class="row" id="bfForm" style="gap:6px;flex-wrap:wrap"><input class="input grow" id="bfT" maxlength="80" placeholder="e.g. Buy park tickets, book Oga's Cantina" aria-label="Reminder"><input class="input" id="bfD" type="date" style="width:auto" aria-label="Date"><button class="btn ghost small" type="submit">Add reminder</button></form>
    <p class="hint">These show under Coming up, alert you while Wayfinder is open, and go into Add to calendar.</p></div>`;
}
function wireParkExtras(iso, pid) {
  $("#llBooked") && ($("#llBooked").onclick = () => { const n = new Date(Date.now() + 120 * 60e3); updPark(iso, pid, p => ({ ...p, llNext: `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}` })); if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {}); renderTrip(); });
  $("#llClear") && ($("#llClear").onclick = () => { updPark(iso, pid, p => ({ ...p, llNext: "" })); renderTrip(); });
  $("#llNextIn") && ($("#llNextIn").onchange = e => { updPark(iso, pid, p => ({ ...p, llNext: e.target.value })); renderTrip(); });
  $("#bfForm").onsubmit = e => { e.preventDefault(); const t = $("#bfT").value.trim(), d = $("#bfD").value; if (!t || !validIso(d)) { toast("Add what to do and a date."); return; }
    updPark(iso, pid, p => ({ ...p, rem: [...(p.rem || []), { id: uidGen(), t: t.slice(0, 80), d }] })); renderTrip(); };
  document.querySelectorAll("[data-bfdel]").forEach(b => b.onclick = () => { updPark(iso, pid, p => ({ ...p, rem: (p.rem || []).filter(r => r.id !== b.dataset.bfdel) })); renderTrip(); });
}
// ---- on the day: alerts for waits, Lightning Lane bookings and return times (while Wayfinder is open)
const tpSeen = (() => { try { return JSON.parse(sessionStorage.getItem("tp-seen") || "{}"); } catch { return {}; } })();
const tpOnce = (k, title, body) => { if (tpSeen[k]) return; tpSeen[k] = 1; try { sessionStorage.setItem("tp-seen", JSON.stringify(tpSeen)); } catch {} notify(title, body); };
let tpTick = 0;
setInterval(async () => {
  if (!cur || !T.trip) return;
  const iso = isoOf(new Date()), pks = T.days[iso]?.parks || []; if (!pks.length) return;
  tpTick++;
  for (const pk of pks) {
    const ln = minsTo(pk.llNext); if (ln != null && ln <= 0 && ln > -30) tpOnce(`ll|${iso}|${pk.pid}|${pk.llNext}`, "Lightning Lane", `You can book your next Lightning Lane at ${pk.name}.`);
    for (const it of pk.items || []) {
      if (it.done) continue;
      const rm = minsTo(it.llTime); if (it.ll && rm != null && rm <= 10 && rm > -5) tpOnce(`ret|${iso}|${it.eid}|${it.llTime}`, "Time to head over", `${it.name}: your return time is ${fmt12(it.llTime)}.`);
      const am = minsTo(it.at); if (am != null && am <= 15 && am > 0 && (it.t === "SHOW" || it.t === "RESTAURANT")) tpOnce(`at|${iso}|${it.eid}|${it.at}`, it.t === "SHOW" ? "Showtime soon" : "Reservation soon", `${it.name} at ${fmt12(it.at)}.`);
    }
    if (tpTick % 5 === 1 && (pk.items || []).some(i => i.alertBelow && !i.done)) {
      try { const data = await tpLive(pk.pid, true);
        for (const it of pk.items.filter(i => i.alertBelow && !i.done)) { const l = data[it.eid], w = l?.queue?.STANDBY?.waitTime;
          if (l?.status === "OPERATING" && w != null && w <= it.alertBelow) tpOnce(`wait|${iso}|${it.eid}|${Math.floor(Date.now() / 36e5)}`, `${it.name}: ${w} min`, `The wait just dropped under ${it.alertBelow} minutes.`); }
        if (cur?.tab === "parks") renderTrip(true);
      } catch {}
    }
  }
}, 60e3);

// ---- the Theme parks tab
let parkSel = null, parkTimer = 0; const liveShown = {};
function viewParks(v) {
  const days = parkDays();
  clearInterval(parkTimer);
  if (!days.length) { v.innerHTML = `<div class="row between"><h2>Theme parks</h2></div><div class="empty">On an itinerary day, tap <b>🎢 Theme park</b> to plan a park day: hours, a must-do list, a smart ride order and live wait times.</div>`; return; }
  const all = days.flatMap(iso => T.days[iso].parks.map(p => ({ iso, p })));
  if (!parkSel || !parkOf(parkSel.iso, parkSel.pid)) { const t = isoOf(new Date()); parkSel = (all.find(x => x.iso === t) || all[0]); parkSel = { iso: parkSel.iso, pid: parkSel.p.pid }; }
  const { iso, pid } = parkSel, pk = parkOf(iso, pid), items = pk.items || [], party = T.trip.party || [];
  const isToday = iso === isoOf(new Date());
  v.innerHTML = `<div class="row between"><h2>Theme parks</h2><span class="row" style="gap:6px"><button class="btn ghost small map-only" type="button" id="tpMap">🗺 Park map</button><button class="btn ghost small" type="button" data-addpark="${iso}">+ Add a park</button></span></div>
    <div class="chips tp-days">${all.map(x => `<button type="button" class="chip ${x.iso === iso && x.p.pid === pid ? "on" : ""}" data-psel="${x.iso}|${esc(x.p.pid)}">${esc(fmtD(x.iso, { weekday: "short", month: "short", day: "numeric" }))} · ${esc(x.p.name)}</button>`).join("")}</div>
    <div class="card tp-head"><div class="row between"><div><h2>${esc(pk.name)}</h2><span class="hint">${esc(pk.dest || "")} · ${esc(dayLabel(iso))}</span></div><button class="iconbtn del" type="button" data-rmpark aria-label="Remove this park from the day">×</button></div>
      <div id="tpHours" class="tp-hours"><span class="hint">Loading park hours…</span></div>
      <p class="hint" style="margin:8px 0 0">Tap any ride on the map to add it. <a class="ext" href="https://www.google.com/search?q=${encodeURIComponent(pk.name + " official park map")}" target="_blank" rel="noopener">Official park map ↗</a></p></div>
    <div class="card"><div class="row between"><h3>Who's riding</h3><button class="linkbtn" type="button" id="partyEdit">${party.length ? "Edit" : "Add heights"}</button></div>
      ${party.length ? `<div class="party">${party.map(x => `<span class="pill">${esc(x.name)}${x.h ? " · " + showH(x.h) : ""}</span>`).join("")}</div>` : `<p class="hint">Add everyone's height and rides with a minimum height will flag anyone too short.</p>`}</div>
    <div class="card"><div class="row between"><h3>Plan <span class="hint" style="display:inline">${items.filter(i => i.done).length}/${items.length} done</span></h3>
      <span class="row" style="gap:6px"><button class="btn ghost small" type="button" id="tpOrder" ${items.length > 1 ? "" : "disabled"}>Best order…</button><button class="btn small" type="button" id="tpAdd">+ Rides, shows & food</button></span></div>
      ${items.length ? `<ol class="tp-items" id="tpItems">${(() => { const est = estTimes(iso, pid, items); return items.map((it, k) => tpItemHtml(it, k, party, est.at[it.eid])).join("") + (items.some(i => !i.done) ? `<li class="tp-end hint">Done around <b>${mm12(est.end)}</b>${PKOPEN[pid + iso] == null ? " (assuming a 9am start)" : ""}</li>` : ""); })()}</ol>
        <form class="row tp-custom" id="tpCustom" style="gap:6px"><select class="input" id="tcType" style="width:auto" aria-label="Kind"><option value="SNACK">🍦 Snack</option><option value="CHARACTER">🤝 Character</option></select><input class="input grow" id="tcName" maxlength="60" placeholder="Dole Whip, churro, meet Mickey…" aria-label="Snack or character"><button class="btn ghost small" type="submit">Add</button></form>
        <p class="hint">⭐ marks a must-do. Times are rough estimates from opening, counting walking and typical waits${isToday ? " (live waits today)" : ""}. <b>Best order</b> plans it for you, or drag to change it.</p>`
      : `<p class="hint">Pick the rides, shows and places to eat you're thinking about, then star your must-dos.</p><form class="row tp-custom" id="tpCustom" style="gap:6px"><select class="input" id="tcType" style="width:auto" aria-label="Kind"><option value="SNACK">🍦 Snack</option><option value="CHARACTER">🤝 Character</option></select><input class="input grow" id="tcName" maxlength="60" placeholder="Dole Whip, churro, meet Mickey…" aria-label="Snack or character"><button class="btn ghost small" type="submit">Add</button></form>`}</div>
    ${llCard(iso, pid, pk)}
    ${beforeCard(iso, pid, pk)}
    <div class="card"><div class="row between"><h3>${isToday ? "Live wait times" : "Wait times right now"}</h3><button class="linkbtn" type="button" id="tpRefresh">Refresh</button></div>
      ${isToday ? "" : `<p class="hint">These are today's live waits at ${esc(pk.name)}, handy for getting a feel for it. On your park day, they're your real waits.</p>`}
      <div id="tpLive"><span class="hint">Loading…</span></div></div>
    <p class="hint">Park data from <a class="ext" href="https://themeparks.wiki" target="_blank" rel="noopener">ThemeParks.wiki ↗</a> · book Lightning Lanes in the official park app.</p>`;
  // hours
  tpSchedule(pid, iso).then(sch => {
    const el = $("#tpHours"); if (!el || parkSel?.iso !== iso) return;
    const day = sch.filter(x => x.date === iso);
    const op = day.find(x => x.type === "OPERATING"); if (op && PKOPEN[pid + iso] == null) { const h = hhmm(op.openingTime); PKOPEN[pid + iso] = +h.slice(0, 2) * 60 + +h.slice(3); renderTrip(true); }
    if (!day.length) { el.innerHTML = `<span class="hint">Hours aren't posted yet. Parks usually publish them 1–2 months ahead.</span>`; return; }
    const lab = { OPERATING: "Park hours", EXTRA_HOURS: "Early entry / extra hours", TICKETED_EVENT: "Special ticketed event", PRIVATE_EVENT: "Private event", INFO: "Note" };
    el.innerHTML = day.sort((a, b) => (a.type === "OPERATING" ? -1 : 0) - (b.type === "OPERATING" ? -1 : 0)).map(x => `<div class="tp-hr ${x.type === "OPERATING" ? "main" : ""}"><span>${lab[x.type] || x.type}${x.description ? ` · ${esc(x.description)}` : ""}</span><b>${fmt12(hhmm(x.openingTime))} – ${fmt12(hhmm(x.closingTime))}</b></div>`).join("")
      + ((day.find(x => x.purchases?.length)?.purchases || []).filter(p => p.price?.amount).slice(0, 4).map(p => `<div class="tp-hr"><span>${esc(p.name || "")}</span><span>${esc(p.price.formatted || fmtCur(p.price.amount / 100, p.price.currency))}</span></div>`).join(""));
  }).catch(() => { const el = $("#tpHours"); if (el) el.innerHTML = `<span class="hint">Couldn't load park hours.</span>`; });
  // live
  const paintLive = async force => {
    const el = $("#tpLive"); if (!el) return;
    let data; try { data = await tpLive(pid, force); } catch { el.innerHTML = `<span class="hint">Couldn't reach live wait times right now.</span>`; return; }
    if (parkSel?.pid !== pid || !$("#tpLive")) return;
    // new live data: refresh time estimates and the map's wait times (once per update)
    if (liveShown[pid] !== TPLIVE[pid].at) { liveShown[pid] = TPLIVE[pid].at; if (isToday) setTimeout(() => renderTrip(true), 0); renderMap(); }
    const mine = items.length ? items.filter(i => !i.done) : [];
    const rows = (mine.length ? mine.map(i => ({ i, l: data[i.eid] })) : Object.values(data).filter(l => l.entityType === "ATTRACTION").map(l => ({ i: { name: l.name, eid: l.id, t: "ATTRACTION" }, l })))
      .filter(r => r.i.t !== "RESTAURANT" || r.l?.queue);
    const wait = r => (r.i.t || r.l?.entityType) === "SHOW" ? 500 : r.l?.status === "OPERATING" ? (r.l.queue?.STANDBY?.waitTime ?? 0) : 999;
    rows.sort((a, b) => wait(a) - wait(b));
    const open = Object.values(data).some(l => l.status === "OPERATING");
    el.innerHTML = (!open ? `<p class="hint">${esc(pk.name)} is closed right now.</p>` : "") + `<div class="tp-live">${rows.slice(0, mine.length ? 60 : 25).map(r => liveRow(r.i, r.l)).join("")}</div>
      <p class="hint">Updated ${new Date(TPLIVE[pid].at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${mine.length ? "" : " · showing the whole park; pick rides above to focus on yours"}</p>`;
  };
  paintLive(); if (isToday) parkTimer = setInterval(() => { if (cur?.tab === "parks" && !document.hidden) paintLive(true); else clearInterval(parkTimer); }, 5 * 60e3);
  wireParkExtras(iso, pid);
  $("#tpCustom").onsubmit = e => { e.preventDefault(); const n = $("#tcName").value.trim(); if (!n) return;
    updPark(iso, pid, p => { p.items.push({ eid: "c_" + uidGen(), name: n.slice(0, 60), t: $("#tcType").value, lat: null, lon: null, must: false, ll: "", llTime: "", minH: 0, done: false, notes: "" }); return p; }); renderTrip(); $("#tcName")?.focus(); };
  // drag to reorder
  if (window.Sortable && $("#tpItems")) Sortable.create($("#tpItems"), { handle: ".grip", animation: 160, forceFallback: true, ghostClass: "sort-ghost",
    onStart: () => { dragging = true; }, onEnd: () => { dragging = false; const ids = $$("#tpItems > li").map(li => li.dataset.eid); updPark(iso, pid, p => { p.items = ids.map(id => p.items.find(i => i.eid === id)).filter(Boolean); return p; }); renderTrip(); } });
  v.onclick = e => {
    const t = e.target;
    const ps = t.closest("[data-psel]"); if (ps) { const [a, b] = ps.dataset.psel.split("|"); parkSel = { iso: a, pid: b }; fitPending = true; renderTrip(); renderMap(); return; }
    if (t.closest("[data-addpark]")) return parkPickModal(iso);
    if (t.closest("#tpAdd")) return parkItemsModal(iso, pid);
    if (t.closest("#tpRefresh")) return paintLive(true);
    if (t.closest("#partyEdit")) return partyModal();
    if (t.closest("#tpOrder")) return orderModal(iso, pid);
    if (t.closest("#tpMap")) { document.body.classList.add("show-map"); $("#mapToggle").textContent = "List"; fitPending = true; setTimeout(() => { map?.invalidateSize(); renderMap(); }, 50); return; }
    if (t.closest("[data-rmpark]")) { if (!confirmTap(t.closest("[data-rmpark]"))) return; T.days[iso] = { ...T.days[iso], parks: T.days[iso].parks.filter(p => p.pid !== pid) }; saveDay(iso, 0); parkSel = null; renderTrip(); return; }
    const li = t.closest("[data-eid]"); if (!li) return; const eid = li.dataset.eid;
    if (t.closest("[data-must]")) { updPark(iso, pid, p => { p.items = p.items.map(i => i.eid === eid ? { ...i, must: !i.must } : i); return p; }); renderTrip(); return; }
    if (t.closest("[data-tirm]")) { updPark(iso, pid, p => { p.items = p.items.filter(i => i.eid !== eid); return p; }); renderTrip(); renderMap(); return; }
    if (t.closest("[data-more]")) { li.classList.toggle("open"); return; }
  };
  v.onchange = e => {
    const li = e.target.closest("[data-eid]"); if (!li) return; const eid = li.dataset.eid, f = e.target.dataset.f; if (!f) return;
    const val = f === "done" ? e.target.checked : f === "minH" ? toInches(e.target.value) : f === "alertBelow" ? (parseInt(e.target.value) || 0) : e.target.value;
    if (f === "alertBelow" && val && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    updPark(iso, pid, p => { p.items = p.items.map(i => i.eid === eid ? { ...i, [f]: val } : i); return p; });
    if (["done", "minH", "ll", "at", "alertBelow", "llTime"].includes(f)) renderTrip();
  };
  v.oninput = e => { const li = e.target.closest("[data-eid]"); if (li && e.target.dataset.f === "notes") updPark(iso, pid, p => { p.items = p.items.map(i => i.eid === li.dataset.eid ? { ...i, notes: e.target.value.slice(0, 300) } : i); return p; }); };
}
function tpItemHtml(it, k, party, eta) {
  const short = it.minH ? party.filter(x => x.h && x.h < it.minH) : [];
  return `<li class="tp-item ${it.done ? "done" : ""} ${it.must ? "must" : ""}" data-eid="${esc(it.eid)}">
    <div class="tp-row"><span class="grip" aria-hidden="true">⋮⋮</span><input type="checkbox" data-f="done" ${it.done ? "checked" : ""} aria-label="Done: ${esc(it.name)}">
      <span class="tp-n">${k + 1}</span><span class="grow"><b>${TPT[it.t]?.[0] || ""} ${esc(it.name)}</b>${eta != null && !it.done ? `<span class="tp-eta">≈ ${mm12(eta)}</span>` : ""}
        <span class="tp-tags">${it.ll ? `<span class="pill ll">${esc(LLOPT.find(o => o[0] === it.ll)?.[1] || "")}${it.llTime ? " · " + fmt12(it.llTime) : ""}</span>` : ""}${it.minH ? `<span class="pill">${showH(it.minH)} min</span>` : ""}${short.length ? `<span class="pill warn">⚠ Too short: ${short.map(x => esc(x.name)).join(", ")}</span>` : ""}${hm2m(it.at) != null ? `<span class="pill">🕒 ${fmt12(it.at)}</span>` : ""}${it.alertBelow ? `<span class="pill">🔔 under ${it.alertBelow}m</span>` : ""}${it.notes ? `<span class="hint">${esc(it.notes)}</span>` : ""}</span></span>
      <button class="iconbtn star ${it.must ? "on" : ""}" type="button" data-must aria-pressed="${!!it.must}" aria-label="Must-do">${it.must ? "★" : "☆"}</button>
      <button class="iconbtn" type="button" data-more aria-label="Details for ${esc(it.name)}">⋯</button>
      <button class="iconbtn del" type="button" data-tirm aria-label="Remove ${esc(it.name)}">×</button></div>
    <div class="tp-more"><label class="field">Planned time<input type="time" data-f="at" value="${esc(it.at || "")}" list="st-${esc(it.eid)}"></label>${showtimeList(it)}
      ${it.t === "ATTRACTION" ? `<label class="field">Alert me under (min)<input type="number" min="5" step="5" data-f="alertBelow" value="${it.alertBelow || ""}" placeholder="e.g. 30"></label>` : ""}
      ${it.t === "ATTRACTION" ? `<label class="field">How you'll ride<select data-f="ll">${LLOPT.map(([v2, l]) => `<option value="${v2}" ${it.ll === v2 ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field">Return time<input type="time" data-f="llTime" value="${esc(it.llTime || "")}"></label>
      <label class="field">Min height (${heightUnit()})<input type="number" min="0" step="1" data-f="minH" value="${it.minH ? Math.round(useF() ? it.minH : it.minH * 2.54) : ""}" placeholder="${useF() ? "40" : "102"}"></label>` : ""}
      <label class="field" style="grid-column:1/-1">Notes<input data-f="notes" maxlength="300" value="${esc(it.notes || "")}" placeholder="${it.t === "SHOW" ? "Where to stand…" : it.t === "RESTAURANT" ? "Confirmation, what to order…" : it.t === "SNACK" ? "Where to get it…" : it.t === "CHARACTER" ? "Where they appear…" : "Ride photo, best seat…"}"></label></div></li>`;
}
// today's showtimes as suggestions for a show's planned time
function showtimeList(it) {
  if (it.t !== "SHOW") return "";
  const l = Object.values(TPLIVE).map(x => x.data?.[it.eid]).find(Boolean), times = (l?.showtimes || []).map(x => hhmm(x.startTime)).filter(Boolean);
  return times.length ? `<datalist id="st-${esc(it.eid)}">${times.map(t => `<option value="${t}">`).join("")}</datalist>` : "";
}
function liveRow(it, l) {
  if (!l) return `<div class="tl-row"><span>${esc(it.name)}</span><span class="hint">No live data</span></div>`;
  const st = l.status || "", q = l.queue || {}, w = q.STANDBY?.waitTime;
  const badge = st === "OPERATING" ? (w != null ? `<b class="wt ${w >= 60 ? "hi" : w >= 30 ? "mid" : "lo"}">${w} min</b>` : `<b class="wt lo">Open</b>`) : st === "DOWN" ? `<b class="wt down">Down</b>` : st === "REFURBISHMENT" ? `<b class="wt down">Refurb</b>` : `<b class="wt closed">Closed</b>`;
  const extra = [q.SINGLE_RIDER?.waitTime != null && `Single rider ${q.SINGLE_RIDER.waitTime}m`, q.RETURN_TIME?.returnStart && `LL return ${fmt12(hhmm(q.RETURN_TIME.returnStart))}`,
    q.PAID_RETURN_TIME?.returnStart && `Paid LL ${fmt12(hhmm(q.PAID_RETURN_TIME.returnStart))}${q.PAID_RETURN_TIME.price?.formatted ? " · " + q.PAID_RETURN_TIME.price.formatted : ""}`,
    q.BOARDING_GROUP && `Virtual queue: ${String(q.BOARDING_GROUP.allocationStatus || "").toLowerCase()}`].filter(Boolean);
  const now = Date.now(), shows = (l.showtimes || []).filter(x => x.startTime && new Date(x.startTime) > now - 15 * 60e3).slice(0, 4).map(x => fmt12(hhmm(x.startTime)));
  return `<div class="tl-row ${it.done ? "done" : ""}"><span><b>${TPT[it.t || l.entityType]?.[0] || ""} ${esc(it.name || l.name)}</b>${extra.length ? `<span class="hint">${esc(extra.join(" · "))}</span>` : ""}${shows.length ? `<span class="hint">Next shows: ${esc(shows.join(", "))}</span>` : ""}</span>${l.entityType === "SHOW" && !w ? (shows.length ? `<b class="wt lo">${esc(shows[0])}</b>` : badge) : badge}</div>`;
}
function partyModal() {
  let party = (T.trip.party || []).map(x => ({ ...x }));
  if (!party.length) party = members().map(e => ({ name: nameOf(e), h: 0 }));
  const paint = () => { $("#ptList").innerHTML = party.map((x, i) => `<div class="row" style="gap:6px"><input class="input grow" data-pi="${i}" data-pf="name" value="${esc(x.name)}" placeholder="Name" maxlength="30" aria-label="Name">
    <input class="input" style="width:110px" type="number" min="0" data-pi="${i}" data-pf="h" value="${x.h ? Math.round(useF() ? x.h : x.h * 2.54) : ""}" placeholder="${heightUnit()}" aria-label="Height in ${heightUnit()}"><button class="iconbtn del" type="button" data-pr="${i}" aria-label="Remove">×</button></div>`).join(""); };
  openModal(`<div class="row between"><h2>Who's riding</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">Heights in ${useF() ? "inches" : "centimeters"}. Kids and anyone not on the trip list can go here too. Rides with a minimum height flag anyone who's too short.</p>
    <div id="ptList" style="display:grid;gap:6px"></div><button class="linkbtn" type="button" id="ptAdd" style="justify-self:start">+ Add someone</button>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="ptSave">Save</button></div>`, m => {
    $$("[data-close]", m).forEach(x => x.onclick = closeModal); paint();
    $("#ptAdd").onclick = () => { party.push({ name: "", h: 0 }); paint(); };
    $("#ptList").oninput = e => { const i = e.target.dataset.pi; if (i == null) return; party[+i][e.target.dataset.pf] = e.target.dataset.pf === "h" ? toInches(e.target.value) : e.target.value; };
    $("#ptList").onclick = e => { const r = e.target.closest("[data-pr]"); if (r) { party.splice(+r.dataset.pr, 1); paint(); } };
    $("#ptSave").onclick = () => { const p = party.filter(x => x.name.trim()).map(x => ({ name: x.name.trim().slice(0, 30), h: Math.round((x.h || 0) * 10) / 10 }));
      T.trip.party = p; updateDoc(doc(fs, "trips/" + cur.id), { party: p }).catch(fail); closeModal(); renderTrip(); };
  });
}
// a compact live list for Today, for the park(s) that day
function todayParksHtml(iso) {
  const pks = T.days[iso]?.parks || []; if (!pks.length) return "";
  return pks.map(p => `<div class="card"><div class="row between"><h3>🎢 ${esc(p.name)}</h3><a class="linkbtn" href="#/t/${cur.id}/parks" data-gopark="${iso}|${esc(p.pid)}">Open park plan</a></div><div class="tp-live" data-tlive="${esc(p.pid)}"><span class="hint">Loading wait times…</span></div></div>`).join("");
}
async function fillTodayParks(iso) {
  for (const p of T.days[iso]?.parks || []) {
    const el = document.querySelector(`[data-tlive="${CSS.escape(p.pid)}"]`); if (!el) continue;
    try { const data = await tpLive(p.pid); const its = (p.items || []).filter(i => !i.done && i.t !== "RESTAURANT");
      const wv = r => r.i.t === "SHOW" ? 500 : r.l?.status === "OPERATING" ? r.l.queue?.STANDBY?.waitTime ?? 0 : 999;
      const rows = its.map(i => ({ i, l: data[i.eid] })).sort((a, b) => wv(a) - wv(b));
      el.innerHTML = rows.length ? rows.slice(0, 12).map(r => liveRow(r.i, r.l)).join("") : `<p class="hint">Add rides to your park plan to see their waits here.</p>`;
    } catch { el.innerHTML = `<span class="hint">Couldn't reach live wait times.</span>`; }
  }
}

// ================================================================ BUDGET
function spendItems() {
  const out = [];
  for (const [id, e] of Object.entries(T.expenses)) {
    const c = e.currency || e.home || homeCur(), h = inHome(num(e.amount), c, e.rate, e.home);
    out.push({ id, src: "expense", ...e, orig: num(e.amount), cur: c, amount: h.v, noRate: !h.ok, approx: h.approx });
  }
  for (const [id, b] of Object.entries(T.bookings)) if (num(b.cost)) {
    const k = KINDS[b.kind] || KINDS.other, c = b.costCur || b.home || homeCur(), h = inHome(num(b.cost), c, b.costRate, b.home);
    out.push({ id, src: "booking", desc: b.title || k.label, orig: num(b.cost), cur: c, amount: h.v, noRate: !h.ok, approx: h.approx, category: k.cat, date: b.depDate || b.checkIn || b.date || "", paidBy: b.paidBy || "", split: b.split || [], planned: !!b.planned, kind: "expense", created: b.created || 0 });
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
  const needRate = items.filter(x => x.noRate), byCur = {};
  items.filter(x => x.kind !== "payment" && !x.planned).forEach(x => { byCur[x.cur] = (byCur[x.cur] || 0) + x.orig; });
  v.innerHTML = `<div class="row between"><h2>Budget</h2><button class="btn accent small" type="button" id="addExp">+ Add expense</button></div>
    <div class="stats">
      <div class="stat"><span class="k">Budget</span><span class="v">${budget ? money(budget) : "—"}</span><span class="s"><button class="linkbtn" type="button" id="setBudget">${budget ? "Change" : "Set a budget"}</button></span></div>
      <div class="stat"><span class="k">Spent</span><span class="v">${money(spent)}</span><span class="s">${n > 1 ? money(spent / n) + " each on average" : ""}</span></div>
      <div class="stat"><span class="k">Still planned</span><span class="v">${money(planned)}</span><span class="s">estimates</span></div>
      <div class="stat"><span class="k">Left</span><span class="v" style="color:${budget && budget - spent - planned < 0 ? "var(--warn)" : "inherit"}">${budget ? money(budget - spent - planned) : "—"}</span><span class="s">${budget ? Math.round((spent + planned) / budget * 100) + "% used or planned" : ""}</span></div>
    </div>
    ${budget ? `<div class="meter ${spent + planned > budget ? "over" : ""}"><i style="width:${Math.min(100, (spent + planned) / budget * 100)}%"></i></div>` : ""}
    ${needRate.length ? `<p class="banner">${needRate.length} cost${needRate.length === 1 ? "" : "s"} in another currency still need${needRate.length === 1 ? "s" : ""} an exchange rate, so ${needRate.length === 1 ? "it isn't" : "they aren't"} in the totals yet. Tap ${needRate.length === 1 ? "it" : "them"} below to add one.</p>` : ""}
    ${Object.keys(byCur).length > 1 ? `<p class="hint">Spent by currency: ${Object.entries(byCur).map(([c, v]) => `<b>${fmtCur(v, c)}</b>`).join(" · ")} <span style="opacity:.8">(totals above in ${esc(homeCur())})</span></p>` : ""}
    ${n > 1 ? `<div class="card" style="display:grid;gap:10px"><div class="row between"><h3>Who owes whom</h3><button class="linkbtn" type="button" id="payMe">${Object.values(payOf(ME.email)).some(Boolean) ? "Edit how to pay me" : "Add how to pay me (Venmo, PayPal…)"}</button></div>
      ${transfers.length ? `<div class="owes">${transfers.map(t => `<div class="owe">${avatar(t.from)}<span><b>${esc(nameOf(t.from))}</b> owes <b>${esc(nameOf(t.to))}</b></span><span class="amt">${money(t.amt, { cents: true })}</span><button class="btn ghost small" type="button" data-settle="${esc(t.from)}|${esc(t.to)}|${t.amt}">Mark paid</button>${t.from === ME.email && payLinks(t) ? `<div class="pay-row">Pay ${esc(nameOf(t.to))}: ${payLinks(t)}</div>` : ""}</div>`).join("")}</div>` : `<p class="hint">Everyone's even.</p>`}
      <div style="display:grid;gap:4px">${members().map(e => `<div class="bal">${avatar(e)}<span>${esc(nameOf(e))}</span><b style="color:${bal[e] > 0.005 ? "var(--leaf)" : bal[e] < -0.005 ? "var(--accent)" : "var(--muted)"}">${bal[e] > 0.005 ? "gets back " : bal[e] < -0.005 ? "owes " : ""}${money(Math.abs(bal[e]), { cents: true })}</b></div>`).join("")}</div></div>` : `<p class="hint">Invite people with <b>Share</b> to split costs between you.</p>`}
    ${Object.keys(byCat).length ? `<div class="card" style="display:grid;gap:10px"><h3>By category</h3><div class="bars">${CATS.filter(c => byCat[c]).map(c => `<div class="bar"><span>${c}</span><span class="track"><i style="width:${byCat[c].s / maxC * 100}%;background:var(--accent)"></i><i style="width:${byCat[c].p / maxC * 100}%;background:var(--accent-soft)"></i></span><b>${money(byCat[c].s + byCat[c].p)}</b></div>`).join("")}</div><p class="hint"><span style="color:var(--accent)">■</span> spent · <span style="color:var(--accent-soft)">■</span> planned</p></div>` : ""}
    <div class="card"><h3 style="margin-bottom:6px">All costs</h3>${items.length ? `<table class="tbl"><thead><tr><th>Date</th><th>What</th><th>Paid by</th><th class="num">Amount</th></tr></thead><tbody>
      ${items.map(x => `<tr class="${x.planned ? "planned" : ""}" data-src="${x.src}" data-id="${x.id}" style="cursor:pointer"><td>${esc(fmtD(x.date) || "—")}</td><td>${x.kind === "payment" ? `<b>${esc(nameOf(x.paidBy))}</b> paid <b>${esc(nameOf(x.to))}</b>` : esc(x.desc || "")}<br><span class="hint" style="font-size:11.5px">${x.kind === "payment" ? "Settle up" : esc(x.category || "")}${x.src === "booking" ? " · booking" : ""}${x.planned ? " · estimate" : ""}</span></td><td>${x.paidBy ? esc(nameOf(x.paidBy)) : "—"}</td><td class="num">${x.cur !== homeCur() ? `<span class="hint" style="display:block;font-size:11.5px">${fmtCur(x.orig, x.cur, x.orig % 1 !== 0)}</span>` : ""}<b>${x.noRate ? "needs rate" : (x.approx ? "~" : "") + money(x.amount, { cents: x.amount % 1 !== 0 })}</b></td></tr>`).join("")}</tbody></table>` : `<div class="empty">No costs yet. Add expenses as you go, or add costs to your bookings.</div>`}</div>`;
  $("#addExp").onclick = () => expenseModal(null);
  $("#payMe") && ($("#payMe").onclick = payModal);
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
    <div class="grid3"><label class="field" for="exAmt">Amount<input id="exAmt" type="number" min="0" step="0.01" value="${esc(x.amount ?? "")}" placeholder="0.00"></label>
      <label class="field" for="exCur">Currency<select id="exCur">${CURRENCIES.map(c => `<option ${c === (x.currency || homeCur()) ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field" for="exDate">Date<input id="exDate" type="date" value="${esc(x.date || "")}"></label></div>
    <div class="fx-row" id="exFx"><span id="exLab">1 EUR =</span><input id="exRate" type="number" min="0" step="any" value="${esc(x.home === homeCur() && x.rate ? x.rate : "")}" aria-label="Exchange rate"><span id="exHome">USD</span><b id="exOut"></b><span class="hint" id="exSrc"></span></div>
    <label class="field" for="exDesc">What for<input id="exDesc" maxlength="80" value="${esc(x.desc || "")}" placeholder="Dinner, museum tickets, groceries…"></label>
    <div class="grid2"><label class="field" for="exCat">Category<select id="exCat">${CATS.map(c => `<option ${c === x.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field" for="exPaid">Paid by<select id="exPaid">${members().map(e => `<option value="${esc(e)}" ${e === x.paidBy ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select></label></div>
    <div class="field"><span>Split between</span><div class="splitbox">${members().map(e => `<label><input type="checkbox" data-split value="${esc(e)}" ${(x.split && x.split.length ? x.split : members()).includes(e) ? "checked" : ""}> ${esc(nameOf(e))}</label>`).join("")}</div></div>
    <label class="row" style="gap:8px;font-weight:600"><input type="checkbox" id="exPlanned" ${x.planned ? "checked" : ""}> Just an estimate (not spent yet)</label>
    <p class="hint" id="exMsg"></p>
    <div class="row between">${id ? `<button class="btn danger" type="button" id="exDel">Delete</button>` : "<span></span>"}<div class="row"><button class="btn ghost" type="button" data-close>Cancel</button><button class="btn accent" type="button" id="exSave">Save</button></div></div>`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    const fx = rateWidget(m, { amt: "#exAmt", cur: "#exCur", rate: "#exRate", row: "#exFx", out: "#exOut", lab: "#exLab", home: "#exHome", src: "#exSrc" }, () => $("#exDate").value);
    if ($("#exCur").value !== homeCur() && !$("#exRate").value) fx.fetchRate();
    $("#exDate").addEventListener("change", () => { if ($("#exCur").value !== homeCur() && $("#exSrc").textContent !== "Your rate") fx.fetchRate(); });
    if (id) $("#exDel").onclick = () => { if (!armed) { armed = true; $("#exDel").textContent = "Tap again to delete"; return; } delete T.expenses[id]; remove(tp("expenses/" + id)); closeModal(); renderTrip(); };
    $("#exSave").onclick = () => {
      const amount = num($("#exAmt").value); if (!amount) { $("#exMsg").textContent = "Enter an amount."; $("#exAmt").focus(); return; }
      const split = $$("[data-split]", m).filter(c => c.checked).map(c => c.value); if (!split.length) { $("#exMsg").textContent = "Pick at least one person to split with."; return; }
      const c = $("#exCur").value, rate = c === homeCur() ? 1 : num($("#exRate").value);
      if (!rate) { $("#exMsg").textContent = `Add the exchange rate from ${c} to ${homeCur()}.`; $("#exRate").focus(); return; }
      const eid = id || uidGen();
      T.expenses[eid] = { kind: "expense", amount, currency: c, rate, home: homeCur(), date: $("#exDate").value, desc: $("#exDesc").value.trim() || $("#exCat").value, category: $("#exCat").value, paidBy: $("#exPaid").value, split, planned: $("#exPlanned").checked, created: x.created || Date.now() };
      save(tp("expenses/" + eid), T.expenses[eid], 0); closeModal(); renderTrip();
    };
  });
}

// ================================================================ EXPLORE
let exploreAt = null;
async function fetchIdeas(c) {
  const key = `${c.lat.toFixed(3)},${c.lon.toFixed(3)}`;
  if (ideasCache[key]) return ideasCache[key];
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${c.lat}|${c.lon}&ggsradius=10000&ggslimit=80&prop=pageimages|description|coordinates|pageviews&piprop=thumbnail&pithumbsize=480&pvipdays=30&pvipmetric=pageviews`;
  const j = await (await fetch(u)).json();
  const list = Object.values(j?.query?.pages || {}).map(pg => ({ title: pg.title, desc: pg.description || "", thumb: pg.thumbnail?.source || "", lat: pg.coordinates?.[0]?.lat, lon: pg.coordinates?.[0]?.lon,
    views: Object.values(pg.pageviews || {}).reduce((a, v) => a + (v || 0), 0) }))
    .filter(x => x.lat != null && x.desc && !SKIP.test(x.desc) && !SKIP.test(x.title) && !/^List of|^\d/.test(x.title)).sort((a, b) => b.views - a.views).slice(0, 30);
  return (ideasCache[key] = { list, name: c.name });
}
function exploreCenters() {
  const m = new Map();
  placeList().filter(hasPt).forEach(p => { const n = p.type === "city" ? p.name : p.city; if (n && !m.has(n)) m.set(n, { name: n, lat: p.lat, lon: p.lon }); });
  tripDests(T.trip).forEach(d => { if (hasPt(d) && !m.has(d.name)) m.set(d.name, { ...d }); });
  return [...m.values()];
}
function viewExplore(v) {
  const centers = exploreCenters();
  if (!exploreAt && centers.length) exploreAt = centers[0];
  const st = exploreAt ? ideasCache[`${exploreAt.lat.toFixed(3)},${exploreAt.lon.toFixed(3)}`] : null;
  const have = new Set(placeList().map(p => p.name.toLowerCase()));
  v.innerHTML = `<div><h2>Explore</h2><p class="hint">Popular sights, museums, parks and markets around the places on your trip.</p></div>
    <div class="chips">${centers.map(c => `<button type="button" class="chip ${exploreAt?.name === c.name ? "on" : ""}" data-ex="${esc(c.name)}">${esc(c.name)}</button>`).join("")}</div>
    <div class="suggest-wrap"><input id="exQ" autocomplete="off" placeholder="Explore somewhere else: a city or neighborhood" role="combobox" aria-expanded="false" aria-controls="exL"><ul class="suggest" id="exL" role="listbox" hidden></ul></div>
    ${!exploreAt ? `<div class="empty">Pick a city above, or search for one.</div>` : !st ? `<p class="hint">Finding popular places near ${esc(exploreAt.name)}…</p>` :
      `<h3>Popular near ${esc(exploreAt.name)}</h3><div class="ex-grid">${st.list.map((x, n) => `<article class="ex" style="--tc:${TYPE[ideaType(x.desc)].col}">
        <div class="ex-img">${x.thumb ? `<img src="${esc(x.thumb)}" alt="" loading="lazy" onerror="this.remove()">` : `<span>${esc(x.title.charAt(0))}</span>`}<span class="type-chip">${esc(TYPE[ideaType(x.desc)].label)}</span></div>
        <div class="ex-body"><b>${esc(x.title)}</b><small>${esc(x.desc)}</small>
        <div class="row" style="gap:6px;margin-top:4px">${have.has(x.title.toLowerCase()) ? `<span class="pill ok">Saved</span>` : `<button class="btn small" type="button" data-exsave="${n}">Save</button><select class="ex-day" data-exday="${n}" aria-label="Add ${esc(x.title)} to a day">${dayOptions("").replace("Not scheduled", "Add to a day…")}</select>`}</div></div></article>`).join("")}</div>`}`;
  if (exploreAt && !st) fetchIdeas(exploreAt).then(() => { if (cur?.tab === "explore") renderTrip(); }).catch(() => { v.querySelector("p.hint:last-of-type") && (v.querySelector("p.hint:last-of-type").textContent = "Couldn't load ideas right now."); });
  attachSuggest($("#exQ"), $("#exL"), { onPick: x => { exploreAt = { name: x.name, lat: x.lat, lon: x.lon }; renderTrip(); } });
  v.onclick = e => { const c = e.target.closest("[data-ex]"); if (c) { exploreAt = centers.find(x => x.name === c.dataset.ex) || exploreAt; renderTrip(); return; }
    const sv = e.target.closest("[data-exsave]"); if (sv) { const x = st.list[+sv.dataset.exsave]; addPlace({ name: x.title, type: ideaType(x.desc), city: exploreAt.name, lat: x.lat, lon: x.lon }, { notes: x.desc }); toast(`Saved ${esc(x.title)}.`); renderTrip(); renderMap(); } };
  v.onchange = e => { const s_ = e.target.closest("[data-exday]"); if (s_ && s_.value) { const x = st.list[+s_.dataset.exday], iso = s_.value; addPlace({ name: x.title, type: ideaType(x.desc), city: exploreAt.name, lat: x.lat, lon: x.lon }, { notes: x.desc, day: iso, order: dayPlaces(iso).length }); toast(`Added ${esc(x.title)} to ${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}.`); renderTrip(); renderMap(); } };
}

// ================================================================ TO-DO
function viewTodo(v) {
  const items = Object.entries(T.checklist).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const open = items.filter(([, c]) => !c.done), done = items.filter(([, c]) => c.done);
  const row = ([id, c]) => `<li class="${c.done ? "done" : ""}" data-id="${id}"><input type="checkbox" ${c.done ? "checked" : ""} aria-label="Done">
    <input type="text" id="ck-${id}" value="${esc(c.text || "")}" maxlength="140" aria-label="To-do">
    <span class="row" style="gap:4px;flex-wrap:nowrap"><input type="date" class="ck-due" value="${esc(c.due || "")}" aria-label="Due date" title="Due date">
    <select class="ck-who" aria-label="Who's doing it"><option value="">Anyone</option>${members().map(e => `<option value="${esc(e)}" ${c.who === e ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select>
    <button class="iconbtn del" type="button" data-rm aria-label="Delete">×</button></span></li>`;
  v.innerHTML = `<div class="row between"><h2>To-do</h2><span class="hint">${done.length} of ${items.length} done</span></div>
    ${items.length ? `<div class="meter"><i style="width:${items.length ? done.length / items.length * 100 : 0}%;background:var(--leaf)"></i></div>` : ""}
    <div class="card" style="display:grid;gap:8px"><form id="ckAdd" class="row" style="gap:6px"><input class="input grow" id="ckNew" placeholder="Add a to-do, e.g. Renew passport" maxlength="140"><button class="btn small" type="submit">Add</button></form>
      <ul class="check todo">${open.map(row).join("") || `<li class="hint" style="display:block">Nothing left to do.</li>`}</ul></div>
    ${done.length ? `<details class="card"><summary class="hint" style="cursor:pointer">Done (${done.length})</summary><ul class="check todo" style="margin-top:8px">${done.map(row).join("")}</ul></details>` : ""}`;
  const upd = (id, patch, d = 0) => { T.checklist[id] = { ...T.checklist[id], ...patch }; save(tp("checklist/" + id), T.checklist[id], d); };
  v.addEventListener("change", e => { const li = e.target.closest("li[data-id]"); if (!li) return; const id = li.dataset.id;
    if (e.target.type === "checkbox") { upd(id, { done: e.target.checked }); renderTrip(); }
    else if (e.target.classList.contains("ck-due")) upd(id, { due: e.target.value });
    else if (e.target.classList.contains("ck-who")) upd(id, { who: e.target.value }); });
  v.addEventListener("input", e => { const li = e.target.closest("li[data-id]"); if (li && e.target.type === "text") upd(li.dataset.id, { text: e.target.value }, 600); });
  v.addEventListener("click", e => { if (e.target.closest("[data-rm]")) { const id = e.target.closest("li").dataset.id; delete T.checklist[id]; remove(tp("checklist/" + id)); renderTrip(); } });
  $("#ckAdd").onsubmit = e => { e.preventDefault(); const text = $("#ckNew").value.trim(); if (!text) return; const id = uidGen(); T.checklist[id] = { text, done: false, order: Date.now(), who: "", due: "" }; save(tp("checklist/" + id), T.checklist[id], 0); renderTrip(); $("#ckNew")?.focus(); };
}

// ================================================================ PACKING (private to each person)
const PACK_TEMPLATE = {
  "Documents": ["Passport", "Travel authorizations (visa / ETA / ETIAS)", "Insurance details", "Booking confirmations", "Credit + debit cards", "Some local cash"],
  "Tech": ["Phone + charger", "Plug adapters", "Power bank", "Headphones", "eSIM set up"],
  "Clothes": ["Comfortable walking shoes", "Light layers + rain jacket", "One nice dinner outfit", "Swimsuit", "Laundry bag"],
  "Long flight": ["Neck pillow", "Compression socks", "Snacks", "Refillable bottle", "Eye mask + earplugs"],
  "Toiletries": ["Travel-size liquids bag", "Sunscreen", "Medications", "Hand sanitizer"],
  "Extras": ["Day bag", "Packing cubes", "Small umbrella", "Pen for forms"],
};
const packPath = () => `users/${ME.uid}/packing/${cur.id}`;
function packStats() { const g = T.packing?.groups || []; let total = 0, done = 0; g.forEach(x => (x.items || []).forEach(i => { total++; if (i.done) done++; })); return { total, done }; }
function savePack(d = 400) { T.packing = { ...T.packing, empty: false, updated: Date.now() }; const { empty, ...data } = T.packing; save(packPath(), data, d); }
const fromTemplate = (tpl, doneSet = new Set()) => Object.entries(tpl).map(([name, items]) => ({ id: uidGen(), name, items: items.map(t => ({ id: uidGen(), text: t, done: doneSet.has(name + "|" + t) })) }));
// what the weather and destinations say you'll need (skips anything already on your list)
function packSuggestions() {
  const days = tripDays(), wx = days.map(wxFor).filter(Boolean), out = [];
  const has = re => (T.packing?.groups || []).some(g => g.items.some(i => re.test(i.text)));
  const add = (text, re, why) => { if (!has(re)) out.push({ text, why }); };
  if (wx.length) {
    const wet = wx.filter(w => (w.rain ?? 0) >= 40).length, lo = Math.min(...wx.map(w => w.lo)), hi = Math.max(...wx.map(w => w.hi));
    if (wet) add("Umbrella or rain jacket", /umbrella|rain ?(jacket|coat)|poncho/i, `${wet} day${wet === 1 ? "" : "s"} look rainy`);
    if (lo <= 5) add("Warm coat, hat and gloves", /coat|gloves|beanie|hat/i, `Lows near ${tDeg(lo)}`);
    else if (lo <= 13) add("Warm layer for evenings", /layer|sweater|hoodie|fleece|jacket/i, `Lows around ${tDeg(lo)}`);
    if (hi >= 27) add("Sunscreen, hat and sunglasses", /sunscreen|sunblock/i, `Highs up to ${tDeg(hi)}`);
    if (hi >= 30) add("Refillable water bottle", /bottle/i, "Hot days");
  }
  if (CG) { const plugs = new Set(); tripCountries().forEach(c => c.plugs.split(",").map(x => x.trim()).filter(p => !["A", "B"].includes(p)).slice(0, 1).forEach(p => plugs.add(p)));
    if (plugs.size) add(`Plug adapter (type ${[...plugs].join(", ")})`, /adapter/i, "For the countries on this trip");
    if (tripCountries().some(c => c.v >= 200)) add("Check hair tools are dual voltage", /voltage|converter/i, "220–240V outlets"); }
  if (parkDays().length) { add("Portable battery for park apps", /power ?bank|battery|charger/i, "Theme park days drain your phone"); add("Comfortable walking shoes", /shoes|sneakers/i, "Lots of walking"); }
  if (tripCountries().length) add("Passport", /passport/i, "International trip");
  return out;
}
function viewPacking(v) {
  const P = T.packing;
  if (!P) { v.innerHTML = `<p class="hint">Loading your packing list…</p>`; return; }
  if (P.empty || !P.groups) {
    v.innerHTML = `<div><h2>Packing</h2><p class="hint">Your own list for this trip. Only you can see it.</p></div>
      <div class="card" style="display:grid;gap:10px"><b>Start your list</b>
        <div class="row"><button class="btn accent" type="button" id="pkTpl">Use the travel template</button><button class="btn ghost" type="button" id="pkEu">Copy my list from the Europe 2029 site</button><button class="btn ghost" type="button" id="pkBlank">Start blank</button></div>
        <p class="hint" id="pkMsg"></p></div>`;
    $("#pkTpl").onclick = () => { T.packing = { groups: fromTemplate(PACK_TEMPLATE) }; savePack(0); renderTrip(); };
    $("#pkBlank").onclick = () => { T.packing = { groups: [{ id: uidGen(), name: "Things to pack", items: [] }] }; savePack(0); renderTrip(); };
    $("#pkEu").onclick = async () => {
      try {
        const s_ = await getDoc(doc(fs, `users/${ME.uid}/lists/packing`));
        if (!s_.exists()) { $("#pkMsg").textContent = "No packing list found on the Europe 2029 site for your account. Use the template instead."; return; }
        const d = s_.data(), got = new Set(Object.entries(d.got || {}).filter(([, v]) => v).map(([k]) => k));
        const old = { "Documents": ["Passport", "Travel authorizations (UK ETA / EU ETIAS)", "Insurance details", "Booking confirmations", "Credit + debit cards", "Some € and £ cash"], "Tech": ["Phone + charger", "Plug adapters (UK type G, EU type C/F)", "Power bank", "Headphones", "eSIM set up"], "Clothes": ["Comfortable walking shoes", "Light layers + rain jacket", "One nice dinner outfit", "Swimsuit", "Laundry bag"], "Long flight": ["Neck pillow", "Compression socks", "Snacks", "Refillable bottle", "Eye mask + earplugs"], "Toiletries": ["Travel-size liquids bag", "Sunscreen", "Medications", "Hand sanitizer"], "Extras": ["Crossbody day bag", "Packing cubes", "Small umbrella", "Pen for forms"] };
        for (const [g, extra] of Object.entries(d.extra || {})) old[g] = [...(old[g] || []), ...extra];
        T.packing = { groups: fromTemplate(old, got) }; savePack(0); renderTrip(); toast("Copied your packing list from the Europe 2029 site.");
      } catch { $("#pkMsg").textContent = "Couldn't read the old list. Use the template instead."; }
    };
    return;
  }
  const st = packStats(), sug = packSuggestions();
  v.innerHTML = `${sug.length ? `<div class="card pk-sug"><div class="row between"><h3>Suggested for this trip</h3><button class="btn small" type="button" id="pkSugAll">Add all</button></div>
      <p class="hint">From the forecast (or typical weather) and the countries you're visiting.</p>
      <div class="chips">${sug.map((x, i) => `<button class="chip" type="button" data-sug="${i}" title="${esc(x.why)}">+ ${esc(x.text)}</button>`).join("")}</div></div>` : ""}
    <div class="row between"><div><h2>Packing</h2><p class="hint">Only you can see your list. Everyone on the trip has their own.</p></div><span class="hint">${st.done} of ${st.total} packed</span></div>
    <div class="meter"><i style="width:${st.total ? st.done / st.total * 100 : 0}%;background:var(--leaf)"></i></div>
    <div class="row"><button class="btn ghost small" type="button" id="pkGroup">+ New section</button>${st.done ? `<button class="btn ghost small" type="button" id="pkReset" title="For packing up to go home">Uncheck everything</button>` : ""}</div>
    <div class="packs">${P.groups.map((g, gi) => { const n = g.items.filter(i => i.done).length; return `<div class="card pack" data-g="${gi}">
      <div class="pk-head"><input class="note-title" value="${esc(g.name)}" data-gname aria-label="Section name" maxlength="40"><span class="pk-count ${g.items.length && n === g.items.length ? "all" : ""}">${n}/${g.items.length}</span><button class="iconbtn del" type="button" data-gdel aria-label="Delete section ${esc(g.name)}">×</button></div>
      <ul class="check">${g.items.map((it, ii) => `<li class="${it.done ? "done" : ""}" data-i="${ii}"><input type="checkbox" ${it.done ? "checked" : ""} aria-label="Packed"><textarea class="pk-text" rows="1" maxlength="80" aria-label="Item">${esc(it.text)}</textarea><button class="iconbtn del" type="button" data-idel aria-label="Remove item">×</button></li>`).join("")}</ul>
      <form class="pk-add"><input class="input" placeholder="Add an item" maxlength="80" aria-label="Add to ${esc(g.name)}"><button class="btn small" type="submit">Add</button></form></div>`; }).join("")}</div>`;
  const grow = el => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
  v.addEventListener("keydown", e => { if (e.target.classList?.contains("pk-text") && e.key === "Enter") { e.preventDefault(); e.target.blur(); } });
  $$(".pk-text", v).forEach(grow);
  const G = gi => T.packing.groups[+gi];
  v.addEventListener("change", e => { const c = e.target.closest(".pack"), li = e.target.closest("li[data-i]"); if (c && li && e.target.type === "checkbox") { G(c.dataset.g).items[+li.dataset.i].done = e.target.checked; savePack(250); li.classList.toggle("done", e.target.checked); renderSide(); } });
  v.addEventListener("input", e => { const c = e.target.closest(".pack"); if (!c) return; const li = e.target.closest("li[data-i]");
    if (e.target.matches("[data-gname]")) { G(c.dataset.g).name = e.target.value; savePack(600); }
    else if (li && e.target.classList.contains("pk-text")) { grow(e.target); G(c.dataset.g).items[+li.dataset.i].text = e.target.value; savePack(600); } });
  const armed = new Set();
  v.addEventListener("click", e => { const c = e.target.closest(".pack");
    if (c && e.target.closest("[data-idel]")) { G(c.dataset.g).items.splice(+e.target.closest("li").dataset.i, 1); savePack(0); renderTrip(); }
    if (c && e.target.closest("[data-gdel]")) { const g = G(c.dataset.g); if (g.items.length && !armed.has(c.dataset.g)) { armed.add(c.dataset.g); e.target.textContent = "Delete?"; return; } T.packing.groups.splice(+c.dataset.g, 1); savePack(0); renderTrip(); } });
  v.addEventListener("submit", e => { const c = e.target.closest(".pack"); if (!c) return; e.preventDefault(); const inp = e.target.querySelector("input"), t = inp.value.trim(); if (!t) return; G(c.dataset.g).items.push({ id: uidGen(), text: t, done: false }); savePack(0); renderTrip(); setTimeout(() => $(`.pack[data-g="${c.dataset.g}"] .pk-add input`)?.focus(), 0); });
  const addSug = list => { let g = T.packing.groups.find(g => g.name === "Suggested"); if (!g) { g = { id: uidGen(), name: "Suggested", items: [] }; T.packing.groups.unshift(g); }
    list.forEach(x => g.items.push({ id: uidGen(), text: x.text, done: false })); savePack(0); renderTrip(); };
  $$("[data-sug]", v).forEach(b => b.onclick = () => addSug([sug[+b.dataset.sug]]));
  $("#pkSugAll") && ($("#pkSugAll").onclick = () => addSug(sug));
  $("#pkGroup").onclick = () => { T.packing.groups.push({ id: uidGen(), name: "New section", items: [] }); savePack(0); renderTrip(); const last = $$(".pack [data-gname]").pop(); last?.focus(); last?.select(); };
  if ($("#pkReset")) $("#pkReset").onclick = () => { T.packing.groups.forEach(g => g.items.forEach(i => i.done = false)); savePack(0); renderTrip(); };
}

// ================================================================ EXPORT (printable trip book → Save as PDF)
const PRINT = { itinerary: true, bookings: true, places: true, budget: true, todo: true, notes: true, packing: true, photos: true, sketches: true };
try { Object.assign(PRINT, JSON.parse(localStorage.getItem("trips-print") || "{}")); } catch {}
// a small drawn route for one day (no map tiles, so it prints crisply and works offline)
function routeSketch(items, col) {
  const pts = items.filter(hasPt); if (pts.length < 2) return "";
  const W = 220, H = 150, pad = 18;
  const lat0 = Math.min(...pts.map(p => p.lat)), lat1 = Math.max(...pts.map(p => p.lat)), lon0 = Math.min(...pts.map(p => p.lon)), lon1 = Math.max(...pts.map(p => p.lon));
  const kx = Math.cos((lat0 + lat1) / 2 * Math.PI / 180), spanX = Math.max(1e-4, (lon1 - lon0) * kx), spanY = Math.max(1e-4, lat1 - lat0), sc = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const ox = (W - spanX * sc) / 2, oy = (H - spanY * sc) / 2;
  const xy = p => [ox + (p.lon - lon0) * kx * sc, H - (oy + (p.lat - lat0) * sc)];
  const line = pts.map((p, i) => (i ? "L" : "M") + xy(p).map(v => v.toFixed(1)).join(" ")).join(" ");
  const nums = items.map((p, i) => hasPt(p) ? (() => { const [x, y] = xy(p); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" fill="${col}" stroke="#fff" stroke-width="2"/><text x="${x.toFixed(1)}" y="${(y + 3.5).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Arial">${i + 1}</text>`; })() : "").join("");
  const kmTot = pts.reduce((a, p, i) => i ? a + km(pts[i - 1], p) : 0, 0);
  return `<figure class="sketch"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Route sketch"><rect width="${W}" height="${H}" rx="8" fill="#F3F6F7"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2.2" stroke-dasharray="5 4"/>${nums}</svg><figcaption>${kmTot.toFixed(1)} km route · not to scale with streets</figcaption></figure>`;
}
function bookingLine(b) {
  const k = KINDS[b.kind] || KINDS.other, g = k.group;
  if (b.kind === "flight" && b.legs?.length > 1) return b.legs.map(l => `${fmtD(l.depDate, { weekday: "short", month: "short", day: "numeric" }) || "—"} ${esc(l.depTime || "")} ${esc(l.from || "")} → ${esc(l.to || "")} ${esc(l.arrTime || "")}${l.num ? " · " + esc(l.num) : ""}`).join("<br>");
  if (g === "transport" || g === "car") return `${fmtD(b.depDate, { weekday: "short", month: "short", day: "numeric" }) || "—"} ${esc(b.depTime || "")} ${esc(b.from || "")} → ${fmtD(b.arrDate, { weekday: "short", month: "short", day: "numeric" }) || ""} ${esc(b.arrTime || "")} ${esc(b.to || "")}`;
  if (g === "lodging") return `${fmtD(b.checkIn, { weekday: "short", month: "short", day: "numeric" }) || "—"} → ${fmtD(b.checkOut, { weekday: "short", month: "short", day: "numeric" }) || "—"}${validIso(b.checkIn) && validIso(b.checkOut) ? ` · ${daysBetween(b.checkIn, b.checkOut)} nights` : ""}`;
  return `${fmtD(b.date, { weekday: "short", month: "short", day: "numeric" }) || "—"}${b.time ? " · " + esc(b.time) : ""}`;
}
function printHtml() {
  const t = T.trip, days = tripDays(), all = placeList(), O = PRINT;
  const img = src => O.photos && src ? `<img src="${esc(src)}" alt="">` : "";
  const range = validIso(t.start) ? `${fmtD(t.start, { weekday: "long", month: "long", day: "numeric" })} – ${fmtD(t.end, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}` : "";
  const items = spendItems(), real = items.filter(x => !x.planned && x.kind !== "payment"), plan = items.filter(x => x.planned);
  const spent = real.reduce((a, x) => a + x.amount, 0), planned = plan.reduce((a, x) => a + x.amount, 0), budget = num(t.budget);
  const bkAll = Object.values(T.bookings).sort((a, b) => bkStart(a).localeCompare(bkStart(b)));
  let h = `<section class="pb-cover">${O.photos && t.cover ? `<div class="pb-cover-img"><img src="${esc(t.cover)}" alt=""></div>` : ""}
    <h1>${esc(t.name || "Trip")}</h1><p class="pb-sub">${esc(range)}${destLabel(t) ? " · " + esc(destLabel(t)) : ""}</p>
    <p class="pb-sub">${members().map(e => esc(nameOf(e))).join(", ")}</p>
    <div class="pb-stats"><div><b>${days.length}</b><span>days</span></div><div><b>${all.filter(p => days.includes(p.day)).length}</b><span>places planned</span></div><div><b>${bkAll.length}</b><span>bookings</span></div><div><b>${money(spent + planned)}</b><span>${budget ? "of " + money(budget) + " budget" : "spent + planned"}</span></div></div>
    ${bkAll.filter(b => (KINDS[b.kind] || KINDS.other).group === "transport").length ? `<h3>Getting there and around</h3><table class="pb-tbl"><tbody>${bkAll.filter(b => (KINDS[b.kind] || KINDS.other).group === "transport").map(b => `<tr><td><b>${esc((KINDS[b.kind] || KINDS.other).label)}</b>${b.num ? " " + esc(b.num) : ""}</td><td>${bookingLine(b)}</td><td>${b.conf ? `Conf. <b>${esc(b.conf)}</b>` : ""}</td></tr>`).join("")}</tbody></table>` : ""}
    <p class="pb-foot">Exported ${esc(new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))} from Wayfinder</p></section>`;
  if (O.itinerary && days.length) {
    h += `<section class="pb-sec pb-big"><h2>Itinerary</h2>`;
    days.forEach((iso, i) => {
      const ps = dayPlaces(iso), bk = bookingsOn(iso), stay = stayFor(iso), mode = routeMode(iso), notes = T.days[iso]?.notes || "", col = colVal(dayColor(iso, i));
      const legs = ps.map((p, k) => { if (!k || !hasPt(ps[k - 1]) || !hasPt(p)) return ""; const d = km(ps[k - 1], p), md = legModeOf(iso, p, d); return MODE_IC[md] + " " + legText(d, md); });
      h += `<article class="pb-day"><header style="border-color:${col}"><span class="pb-dn" style="background:${col}">${i + 1}</span><div><h3>${esc(fmtD(iso, { weekday: "long", month: "long", day: "numeric" }))}</h3><span>${ps.length ? ps.length + " place" + (ps.length === 1 ? "" : "s") + " · " + (dayMode(iso) === "auto" ? "walking and transit" : MODES[mode].label) : bk.some(x => (KINDS[x.b.kind] || KINDS.other).group === "transport") ? "Travel day" : "Free day"}${stay ? " · staying at " + esc(stay[1].title || "") : ""}</span></div></header>
        ${!ps.length && !bk.length && !notes && !dayCards(iso).some(c => c.text) ? "" : `<div class="pb-day-body"><div class="pb-day-main">
          ${bk.map(x => `<p class="pb-bk">${x.txt}${x.b.conf ? ` · conf. <b>${esc(x.b.conf)}</b>` : ""}</p>`).join("")}
          ${ps.length || dayCards(iso).some(c => c.text) ? `<ol class="pb-stops">${dayItems(iso).map(x => { if (x.k === "n") return x.text ? `<li class="pb-cnote">${x.time ? `<b>${esc(x.time)}</b> ` : ""}${esc(x.text).replace(/\n/g, "<br>")}</li>` : ""; const p = x, k = ps.findIndex(y => y.id === p.id); return `${legs[k] ? `<li class="pb-leg">${esc(legs[k])}</li>` : ""}<li class="pb-stop"><span class="pb-num" style="background:${col}">${k + 1}</span>${O.photos && photoSrcOf(p) ? `<span class="pb-thumb">${img(photoSrcOf(p))}</span>` : ""}<div><b>${esc(p.name)}</b>${p.time ? ` <span class="pb-time">${esc(p.time)}</span>` : ""}<br><span class="pb-meta">${esc(TYPE[p.type].label)}${p.city && p.city !== p.name ? " · " + esc(p.city) : ""}${hasPt(p) ? ` · <a href="${esc(gmapsUrl(p))}">map</a>` : ""}</span>${p.notes ? `<br><span class="pb-note">${esc(p.notes)}</span>` : ""}</div></li>`; }).join("")}</ol>` : ""}
          ${notes ? `<p class="pb-notes">${esc(notes).replace(/\n/g, "<br>")}</p>` : ""}
        </div>${O.sketches ? routeSketch(ps, col) : ""}</div>`}</article>`;
    });
    h += `</section>`;
  }
  if (O.bookings && bkAll.length) {
    h += `<section class="pb-sec pb-big"><h2>Bookings</h2><table class="pb-tbl"><thead><tr><th>What</th><th>When</th><th>Details</th><th>Confirmation</th><th class="r">Cost</th></tr></thead><tbody>
      ${bkAll.map(b => { const k = KINDS[b.kind] || KINDS.other, via = (b.stops || []).filter(x => (x.at || "").trim()); return `<tr><td><b>${esc(b.title || k.label)}</b><br><span class="pb-meta">${esc(k.label)}${b.num ? " · " + esc(b.num) : ""}</span></td><td>${bookingLine(b)}</td><td>${via.length ? "via " + via.map(x => esc(x.at) + (parseDur(x.dur) ? " (" + fmtMin(parseDur(x.dur)) + ")" : "")).join(", ") : ""}${b.seats ? " Seats " + esc(b.seats) : ""}${b.addr ? esc(b.addr) : ""}${b.notes ? `<br><span class="pb-note">${esc(b.notes)}</span>` : ""}</td><td><b>${esc(b.conf || "")}</b></td><td class="r">${num(b.cost) ? ((b.costCur || homeCur()) === homeCur() ? money(num(b.cost)) : fmtCur(num(b.cost), b.costCur)) : ""}</td></tr>`; }).join("")}</tbody></table></section>`;
  }
  const unsched = all.filter(p => !days.includes(p.day));
  if (O.places && unsched.length) {
    h += `<section class="pb-sec"><h2>Places not scheduled yet</h2><div class="pb-places">${unsched.sort((a, b) => (a.city || "").localeCompare(b.city || "") || a.name.localeCompare(b.name)).map(p => `<div class="pb-place">${O.photos && photoSrcOf(p) ? `<span class="pb-thumb">${img(photoSrcOf(p))}</span>` : ""}<div><b>${esc(p.name)}</b><br><span class="pb-meta">${esc(TYPE[p.type].label)}${p.city && p.city !== p.name ? " · " + esc(p.city) : ""}${hasPt(p) ? ` · <a href="${esc(gmapsUrl(p))}">map</a>` : ""}</span>${p.notes ? `<br><span class="pb-note">${esc(p.notes)}</span>` : ""}</div></div>`).join("")}</div></section>`;
  }
  if (O.budget && items.length) {
    const { transfers } = balances();
    h += `<section class="pb-sec pb-big"><h2>Budget</h2><div class="pb-stats"><div><b>${budget ? money(budget) : "—"}</b><span>budget</span></div><div><b>${money(spent)}</b><span>spent</span></div><div><b>${money(planned)}</b><span>still planned</span></div><div><b>${budget ? money(budget - spent - planned) : "—"}</b><span>left</span></div></div>
      ${transfers.length ? `<h3>Who owes whom</h3><ul class="pb-list">${transfers.map(x => `<li>${esc(nameOf(x.from))} owes ${esc(nameOf(x.to))} <b>${money(x.amt, { cents: true })}</b></li>`).join("")}</ul>` : ""}
      <h3>All costs (in ${esc(homeCur())})</h3><table class="pb-tbl"><thead><tr><th>Date</th><th>What</th><th>Paid by</th><th class="r">Amount</th></tr></thead><tbody>
      ${items.map(x => `<tr><td>${esc(fmtD(x.date) || "—")}</td><td>${x.kind === "payment" ? `${esc(nameOf(x.paidBy))} paid ${esc(nameOf(x.to))}` : esc(x.desc || "")}${x.planned ? " <span class='pb-meta'>(estimate)</span>" : ""}</td><td>${x.paidBy ? esc(nameOf(x.paidBy)) : ""}</td><td class="r">${x.cur !== homeCur() ? `<span class="pb-meta">${fmtCur(x.orig, x.cur, true)}</span> ` : ""}${x.noRate ? "—" : money(x.amount, { cents: true })}</td></tr>`).join("")}</tbody></table></section>`;
  }
  const todos = Object.values(T.checklist).sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || (a.order || 0) - (b.order || 0));
  if (O.todo && todos.length) h += `<section class="pb-sec"><h2>To-do</h2><ul class="pb-checks">${todos.map(c => `<li class="${c.done ? "done" : ""}"><span class="box">${c.done ? "✓" : ""}</span>${esc(c.text || "")}${c.who ? ` <span class="pb-meta">· ${esc(nameOf(c.who))}</span>` : ""}${c.due ? ` <span class="pb-meta">· by ${esc(fmtD(c.due))}</span>` : ""}</li>`).join("")}</ul></section>`;
  const notes = Object.values(T.notes).filter(n => (n.title || n.body || "").trim());
  if (O.notes && (t.notes || notes.length)) h += `<section class="pb-sec"><h2>Notes</h2>${t.notes ? `<div class="pb-notebox"><h3>Trip notes</h3><p>${esc(t.notes).replace(/\n/g, "<br>")}</p></div>` : ""}${notes.map(n => `<div class="pb-notebox"><h3>${esc(n.title || "Note")}</h3><p>${esc(n.body || "").replace(/\n/g, "<br>")}</p></div>`).join("")}</section>`;
  if (O.packing && T.packing?.groups?.length) h += `<section class="pb-sec"><h2>${esc(ME.name)}'s packing list</h2><div class="pb-pack">${T.packing.groups.map(g => `<div><h3>${esc(g.name)}</h3><ul class="pb-checks">${g.items.map(i => `<li class="${i.done ? "done" : ""}"><span class="box">${i.done ? "✓" : ""}</span>${esc(i.text)}</li>`).join("")}</ul></div>`).join("")}</div></section>`;
  return h;
}
function viewPrint(v) {
  const memory = PRINT.mode === "memory";
  const opts = [["itinerary", "Itinerary"], ["sketches", "Route sketches"], ["bookings", "Bookings"], ["places", "Unscheduled places"], ["budget", "Budget"], ["todo", "To-do"], ["notes", "Notes"], ["packing", "My packing list"], ["photos", "Photos"]];
  v.innerHTML = `<div class="print-bar no-print"><div class="row between"><div><h2>Export PDF</h2><p class="hint">Pick what to include, then <b>Save as PDF</b>. In the print window choose <b>Save as PDF</b> as the printer (on iPhone: Share → Print, then Share again → Save to Files).</p></div>
      <div class="row"><a class="btn ghost" href="#/t/${cur.id}/plan">Back</a><button class="btn accent" type="button" id="doPrint">Save as PDF</button></div></div>
      <div class="seg" role="group" aria-label="Book style" style="justify-self:start"><button type="button" data-pmode="planner" aria-pressed="${!memory}">Trip planner</button><button type="button" data-pmode="memory" aria-pressed="${memory}">Memory book</button></div>
      ${memory ? `<p class="hint">A keepsake: each day's photos, journal entry, the places you visited and your notes.</p>` : `<div class="chips">${opts.map(([k, l]) => `<label class="chip ${PRINT[k] ? "on" : ""}"><input type="checkbox" data-po="${k}" ${PRINT[k] ? "checked" : ""} hidden>${l}</label>`).join("")}</div>`}</div>
    <div class="pb ${memory ? "mb" : ""}" id="pb">${memory ? memoryHtml() : printHtml()}</div>`;
  v.querySelectorAll("[data-pmode]").forEach(b => b.onclick = () => { PRINT.mode = b.dataset.pmode; try { localStorage.setItem("trips-print", JSON.stringify(PRINT)); } catch {} renderTrip(); });
  v.querySelectorAll("[data-po]").forEach(c => c.onchange = () => { PRINT[c.dataset.po] = c.checked; try { localStorage.setItem("trips-print", JSON.stringify(PRINT)); } catch {} renderTrip(); });
  $("#doPrint").onclick = () => { const old = document.title; document.title = (T.trip.name || "Trip") + (memory ? " – memory book" : " – trip book"); window.print(); setTimeout(() => { document.title = old; }, 1000); };
}

// ================================================================ NOTES
function viewNotes(v) {
  const notes = Object.entries(T.notes || {}).sort((a, b) => (b[1].pinned ? 1 : 0) - (a[1].pinned ? 1 : 0) || (b[1].updated || b[1].created || 0) - (a[1].updated || a[1].created || 0));
  v.innerHTML = `${pollsHtml()}<div class="row between" style="margin-top:8px"><h2>Notes</h2><button class="btn accent small" type="button" id="addNote">+ New note</button></div>
    <div class="card note"><div class="row between"><h3>Trip notes</h3><span class="hint">shared with everyone on the trip</span></div>
      <textarea class="input note-body" id="tripNotes" rows="${Math.min(14, Math.max(3, (T.trip.notes || "").split("\n").length + 1))}" maxlength="5000" placeholder="Ideas, links, things to remember…">${esc(T.trip.notes || "")}</textarea></div>
    ${notes.map(([id, n]) => `<div class="card note" data-id="${id}">
      <div class="row" style="gap:6px"><input class="note-title grow" id="nt-${id}" value="${esc(n.title || "")}" placeholder="Title, e.g. Restaurants to try" maxlength="80" aria-label="Note title">
        <button class="iconbtn" type="button" data-pin aria-pressed="${!!n.pinned}" title="${n.pinned ? "Unpin" : "Pin to top"}" aria-label="${n.pinned ? "Unpin" : "Pin to top"}">${n.pinned ? "★" : "☆"}</button>
        <button class="iconbtn del" type="button" data-rmnote aria-label="Delete note">×</button></div>
      <textarea class="input note-body" id="nb-${id}" rows="${Math.min(14, Math.max(3, (n.body || "").split("\n").length + 1))}" maxlength="8000" placeholder="Write anything…">${esc(n.body || "")}</textarea>
      <span class="hint" style="font-size:11.5px">${n.by ? "By " + esc(nameOf(n.by)) + " · " : ""}${n.updated ? "edited " + esc(new Date(n.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" })) : ""}</span></div>`).join("")}
    ${notes.length ? "" : `<p class="hint">Add notes for anything: restaurants to try, packing lists, phrases, recommendations from friends.</p>`}`;
  wirePolls(v);
  const upd = debounce(val => updateDoc(doc(fs, "trips/" + cur.id), { notes: val.slice(0, 5000) }).catch(fail), 600);
  $("#tripNotes").oninput = e => { T.trip.notes = e.target.value; upd(e.target.value); };
  $("#addNote").onclick = () => { const id = uidGen(); T.notes[id] = { title: "", body: "", by: ME.email, created: Date.now(), updated: Date.now(), pinned: false }; save(tp("notes/" + id), T.notes[id], 0); renderTrip(); $("#nt-" + id)?.focus(); };
  v.addEventListener("input", e => {
    const card = e.target.closest(".note[data-id]"); if (!card) return; const id = card.dataset.id;
    const f = e.target.classList.contains("note-title") ? "title" : e.target.classList.contains("note-body") ? "body" : null; if (!f) return;
    T.notes[id] = { ...T.notes[id], [f]: e.target.value, updated: Date.now() }; save(tp("notes/" + id), T.notes[id], 700);
  });
  const armed = new Set();
  v.addEventListener("click", e => {
    const card = e.target.closest(".note[data-id]"); if (!card) return; const id = card.dataset.id;
    if (e.target.closest("[data-pin]")) { T.notes[id] = { ...T.notes[id], pinned: !T.notes[id].pinned }; save(tp("notes/" + id), T.notes[id], 0); renderTrip(); }
    const rm = e.target.closest("[data-rmnote]");
    if (rm) { if (!armed.has(id)) { armed.add(id); rm.textContent = "Delete?"; rm.style.width = "auto"; return; } delete T.notes[id]; remove(tp("notes/" + id)); renderTrip(); }
  });
}

// ================================================================ OVERVIEW
// ================================================================ TIME ZONES & JET LAG
const homeTz = () => { if (PROFILE.homeTz) return PROFILE.homeTz; let h = localStorage.getItem("home-tz"); if (!h) { h = Intl.DateTimeFormat().resolvedOptions().timeZone; try { localStorage.setItem("home-tz", h); } catch {} } return h; };
const TZC = (() => { try { return JSON.parse(localStorage.getItem("trips-tz") || "{}"); } catch { return {}; } })();
function tzOffset(tz, at = new Date()) {   // minutes ahead of UTC
  try { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at), g = t => +p.find(x => x.type === t).value;
    return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) - Math.floor(at.getTime() / 60e3) * 60e3) / 60e3); } catch { return null; }
}
const clockIn = (tz, at = new Date()) => { try { return at.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }); } catch { return ""; } };
const dayIn = (tz, at = new Date()) => { try { return at.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" }); } catch { return ""; } };
// the destination's time zone: where the trip's first day is (or the first destination)
function tripTzPoint(iso) { const d = iso && dayPoint(iso); if (d) return d; const t = tripDests(T.trip)[0]; return t?.lat != null ? t : null; }
function tzAt(pt) {
  if (!pt) return null; const k = `${pt.lat.toFixed(1)},${pt.lon.toFixed(1)}`;
  if (TZC[k]) return TZC[k];
  if (!tzAt.busy?.[k] && navigator.onLine) { (tzAt.busy ||= {})[k] = 1;
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pt.lat.toFixed(3)}&longitude=${pt.lon.toFixed(3)}&timezone=auto&forecast_days=1&daily=weather_code`).then(r => r.json()).then(j => { if (j.timezone) { TZC[k] = j.timezone; try { localStorage.setItem("trips-tz", JSON.stringify(TZC)); } catch {} if (cur && ["overview", "today"].includes(cur.tab)) renderTrip(true); } }).catch(() => {}); }
  return null;
}
const tzName = tz => (tz || "").split("/").pop().replace(/_/g, " ");
function tzDiff(tz, at) { const a = tzOffset(tz, at), b = tzOffset(homeTz(), at); return a == null || b == null ? null : a - b; }
const hrs = m => { const h = Math.abs(m) / 60; return `${Number.isInteger(h) ? h : h.toFixed(1)} hour${h === 1 ? "" : "s"}`; };
function tzLine(iso) {   // for Today: local time and home time
  const tz = tzAt(tripTzPoint(iso)); if (!tz) return "";
  const d = tzDiff(tz); if (!d) return "";
  return `<div class="tz-line">🕒 <b>${clockIn(tz)}</b> in ${esc(tzName(tz))} · <span class="hint" style="display:inline">${clockIn(homeTz())} ${dayIn(homeTz()) !== dayIn(tz) ? dayIn(homeTz()) + " " : ""}at home</span></div>`;
}
function jetLagHtml() {
  const days = tripDays(); if (!days.length) return "";
  const tz = tzAt(tripTzPoint(days[0])); if (!tz) return "";
  const at = new Date(days[0] + "T12:00"), raw = tzDiff(tz, at); if (raw == null || Math.abs(raw) < 120) return "";
  let d = raw; if (d > 720) d -= 1440; if (d < -720) d += 1440;   // the shorter way round the clock
  const east = d > 0, h = Math.round(Math.abs(d) / 60), pre = Math.min(3, Math.ceil(h / 2)), start = addDays(days[0], -pre);
  return `<div class="card tz-card"><h3>🕒 Time zone & jet lag</h3>
    <div class="tz-clocks"><div><span class="k">${esc(tzName(tz))}</span><b>${clockIn(tz)}</b><span class="hint">${dayIn(tz)}</span></div><div><span class="k">Home (${esc(tzName(homeTz()))})</span><b>${clockIn(homeTz())}</b><span class="hint">${dayIn(homeTz())}</span></div></div>
    <p>${esc(tzName(tz))} is <b>${hrs(Math.abs(raw))} ${raw > 0 ? "ahead of" : "behind"}</b> home${Math.abs(raw) !== Math.abs(d) ? `. For your body clock that's like going ${hrs(Math.abs(d))} ${east ? "east" : "west"}` : ""}.</p>
    <ul class="tz-plan">
      ${isoOf(new Date()) < days[0] ? `<li><b>From ${esc(fmtD(start, { weekday: "short", month: "short", day: "numeric" }))}:</b> go to bed and wake up about an hour ${east ? "earlier" : "later"} each day for ${pre} day${pre === 1 ? "" : "s"}.</li>` : ""}
      <li><b>On the plane:</b> set your watch to ${esc(tzName(tz))} time. Sleep if it's night there, stay awake if it's day.</li>
      <li><b>When you land:</b> ${east ? "get outside in the morning light and avoid bright light late in the evening" : "get outside in the afternoon and evening light, and try to stay up until about 9pm local time"}. Eat meals at local times.</li>
      <li><b>First day:</b> plan something easy. Most people adjust about a day for every ${east ? "hour" : "1 to 1.5 hours"} of difference.</li>
    </ul></div>`;
}
function viewOverview(v) {
  const t = T.trip, days = tripDays(), all = placeList(), sched = all.filter(p => days.includes(p.day)).length;
  const items = Object.entries(T.checklist).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  const spent = spendItems().filter(x => !x.planned && x.kind !== "payment").reduce((a, x) => a + x.amount, 0);
  v.innerHTML = `<div class="stats">
      <div class="stat"><span class="k">${validIso(t.start) && isoOf(new Date()) < t.start ? "Days to go" : "Status"}</span><span class="v">${validIso(t.start) && isoOf(new Date()) < t.start ? daysBetween(isoOf(new Date()), t.start).toLocaleString("en-US") : esc(tripWhen(t))}</span><span class="s">${days.length ? days.length + " days" : "no dates"}</span></div>
      <div class="stat"><span class="k">Places</span><span class="v">${all.length}</span><span class="s">${sched} scheduled</span></div>
      <div class="stat"><span class="k">Bookings</span><span class="v">${Object.keys(T.bookings).length}</span><span class="s">flights, stays & more</span></div>
      <div class="stat"><span class="k">Spent</span><span class="v">${money(spent)}</span><span class="s">${num(t.budget) ? "of " + money(num(t.budget)) : "no budget set"}</span></div></div>
    ${comingUpHtml()}
    ${jetLagHtml()}
    <div class="card" style="display:grid;gap:12px"><h3>Trip details</h3>
      <label class="field" for="ovName">Name<input id="ovName" maxlength="60" value="${esc(t.name || "")}" data-live></label>
      <div class="field"><label for="ovDest">Destinations</label><div class="dchips" id="ovChips"></div><div class="suggest-wrap"><input id="ovDest" autocomplete="off" placeholder="Add a country, region or city" role="combobox" aria-expanded="false" aria-controls="ovDestL"><ul class="suggest" id="ovDestL" role="listbox" hidden></ul></div></div>
      <div class="grid2"><label class="field" for="ovStart">Start<input id="ovStart" type="date" value="${esc(t.start || "")}"></label><label class="field" for="ovEnd">End<input id="ovEnd" type="date" value="${esc(t.end || "")}"></label></div>
      <div class="grid2"><label class="field" for="ovBudget">Total budget<input id="ovBudget" type="number" min="0" step="50" value="${num(t.budget) || ""}" placeholder="0" data-live></label>
        <label class="field" for="ovCur">Home currency (totals are shown in)<select id="ovCur">${CURRENCIES.map(c => `<option ${c === (t.currency || "USD") ? "selected" : ""}>${c}</option>`).join("")}</select></label></div>
      <label class="field" for="ovMode">Usually getting around by<select id="ovMode">${DAY_MODES.map(([k, l]) => `<option value="${k}" ${k === (t.mode || "walk") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <div class="row"><button class="btn ghost small" type="button" id="ovCover">New cover photo</button><label class="btn ghost small file-btn">Upload cover<input type="file" id="ovCoverFile" accept="image/*"></label>${t.coverCredit ? `<span class="hint">${esc(t.coverCredit)}</span>` : ""}</div></div>
    <div class="card" style="display:grid;gap:10px"><div class="row between"><h3>People</h3><button class="btn ghost small" type="button" id="ovInvite">Share & invite</button></div>
      ${members().map(e => `<div class="bal">${avatar(e)}<span><b>${esc(nameOf(e))}</b> <span class="hint" style="display:inline">${esc(e)}</span></span><span class="hint">${t.ownerEmail === e ? "Planner" : ""}</span></div>`).join("")}</div>
    <div class="card row between"><span class="hint">Use this trip as a starting point for another one.</span><button class="btn ghost small" type="button" id="ovDup">Duplicate trip</button></div>
    <div class="card row between"><span class="hint">${isOwner() ? "Deleting removes this trip for everyone." : "Leaving removes you from this trip. You can be invited back."}</span><button class="btn danger" type="button" id="ovDanger">${isOwner() ? "Delete trip" : "Leave trip"}</button></div>`;
  const tripRef = doc(fs, "trips/" + cur.id);
  $("#ovDup").onclick = duplicateModal;
  const upd = debounce(patch => updateDoc(tripRef, patch).catch(fail), 600);
  $("#ovName").oninput = e => { T.trip.name = e.target.value; upd({ name: e.target.value.slice(0, 60) }); $("#crumb").textContent = e.target.value; };
  $("#ovBudget").oninput = e => { T.trip.budget = num(e.target.value); upd({ budget: num(e.target.value) }); };
  $("#ovMode").onchange = e => { updateDoc(tripRef, { mode: e.target.value }).catch(fail); };
  $("#ovCur").onchange = e => rebaseCurrency(e.target.value);
  const dates = () => { let s = $("#ovStart").value, en = $("#ovEnd").value; if (validIso(s) && (!validIso(en) || en < s)) { en = s; $("#ovEnd").value = s; } if (validIso(s) && daysBetween(s, en) > 59) { toast("Wayfinder can be up to 60 days."); return; } updateDoc(tripRef, { start: s, end: en }).catch(fail); };
  $("#ovStart").onchange = dates; $("#ovEnd").onchange = dates;
  destEditor($("#ovDest"), $("#ovDestL"), $("#ovChips"), () => tripDests(T.trip), l => { T.trip.dests = l; T.trip.dest = l[0] || null; updateDoc(tripRef, { dests: l, dest: l[0] || null }).catch(fail); });
  $("#ovCover").onclick = async () => {
    const d = t.dest || { name: t.name }; $("#ovCover").disabled = true; $("#ovCover").textContent = "Looking…";
    const cands = await photoCandidates({ name: d.name, city: d.name, lat: d.lat, lon: d.lon }, "all").catch(() => []);
    const curIdx = cands.findIndex(c => c.src === t.coverSrc || c.url === t.cover), pick = cands[(curIdx + 1) % Math.max(1, cands.length)];
    if (!pick) { toast("No free photos found. Upload one instead."); $("#ovCover").disabled = false; $("#ovCover").textContent = "New cover photo"; return; }
    try { const ph = await materialize(pick); await updateDoc(tripRef, { cover: ph.photo || ph.photoUrl, coverCredit: ph.photoCredit || "", coverSrc: pick.src || pick.url || "" }); trackUnsplash(ph.dl); } catch { toast("Couldn't load that photo."); }
  };
  $("#ovCoverFile").onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const d = await shrink(f, 1400, 450000); await updateDoc(tripRef, { cover: d, coverCredit: "", coverSrc: "" }); } catch (err) { toast(esc(err.message)); } };
  $("#ovInvite").onclick = inviteModal;
  let armed = false;
  $("#ovDanger").onclick = async () => {
    if (!armed) { armed = true; $("#ovDanger").textContent = isOwner() ? "Tap again to delete for everyone" : "Tap again to leave"; return; }
    const tid = cur.id;
    if (isOwner()) {
      for (const sub of ["places", "days", "bookings", "expenses", "checklist", "photos", "notes"]) { const s = await getDocs(collection(fs, `trips/${tid}/${sub}`)).catch(() => null); s?.docs.forEach(d => deleteDoc(d.ref).catch(() => {})); }
      await deleteDoc(doc(fs, "trips/" + tid)).catch(fail);
    } else await updateDoc(doc(fs, "trips/" + tid), { members: members().filter(e => e !== ME.email) }).catch(fail);
    location.hash = "#/";
  };
}

// Changing the home currency: convert every cost to the new one at the rate for its date
async function rebaseCurrency(newHome) {
  const old = homeCur(); if (newHome === old) return;
  const tid = cur.id; toast(`Switching to ${newHome}…`);
  let fixed = 0, missing = 0;
  const conv = async (cur_, amt, date) => { const r = await getRate(cur_, newHome, date); return r ? r.rate : null; };
  for (const [id, e] of Object.entries(T.expenses)) {
    const c = e.currency || old, r = await conv(c, num(e.amount), e.date); if (r == null) { missing++; continue; }
    T.expenses[id] = { ...e, currency: c, rate: r, home: newHome }; save(`trips/${tid}/expenses/${id}`, T.expenses[id], 0); fixed++;
  }
  for (const [id, b] of Object.entries(T.bookings)) {
    if (!num(b.cost)) continue;
    const c = b.costCur || old, r = await conv(c, num(b.cost), b.depDate || b.checkIn || b.date); if (r == null) { missing++; continue; }
    T.bookings[id] = { ...b, costCur: c, costRate: r, home: newHome }; save(`trips/${tid}/bookings/${id}`, T.bookings[id], 0); fixed++;
  }
  // convert the budget too
  const br = await conv(old, num(T.trip.budget), "");
  await updateDoc(doc(fs, "trips/" + tid), { currency: newHome, ...(br && num(T.trip.budget) ? { budget: Math.round(num(T.trip.budget) * br) } : {}) }).catch(fail);
  toast(`Totals now in ${newHome}.${missing ? ` ${missing} cost${missing === 1 ? "" : "s"} still need an exchange rate (see Budget).` : ""}`);
}

// rate picker shared by the expense and booking forms
function rateWidget(m, ids, getDate) {
  const amt = $(ids.amt, m), cs = $(ids.cur, m), rate = $(ids.rate, m), row = $(ids.row, m), out = $(ids.out, m), lab = $(ids.lab, m);
  const show = () => {
    const c = cs.value, h = homeCur(), same = c === h; row.hidden = same;
    lab.textContent = `1 ${c} =`; $(ids.home, m).textContent = h;
    const v = num(amt.value) * (same ? 1 : num(rate.value));
    out.textContent = same ? "" : num(rate.value) ? `≈ ${fmtCur(v, h, true)}` : "Enter the rate";
  };
  const fetchRate = async () => {
    if (cs.value === homeCur()) { show(); return; }
    out.textContent = "Getting today's rate…";
    const r = await getRate(cs.value, homeCur(), getDate());
    if (r) { rate.value = +r.rate.toFixed(6); $(ids.src, m).textContent = r.src ? `Rate for ${r.date === "latest" ? "today" : fmtD(r.date, { month: "short", day: "numeric", year: "numeric" })} · ${r.src}` : ""; }
    else $(ids.src, m).textContent = "Couldn't look up a rate. Type it in from your bank or card statement.";
    show();
  };
  cs.onchange = fetchRate; amt.oninput = show; rate.oninput = () => { $(ids.src, m).textContent = "Your rate"; show(); };
  show(); return { fetchRate, show };
}

// ================================================================ SHARE / INVITE
function inviteModal() {
  const link = location.href.split("#")[0] + "#/t/" + cur.id;
  openModal(`<div class="row between"><h2>Share this trip</h2><button class="iconbtn" type="button" data-close aria-label="Close">×</button></div>
    <p class="hint">People you add can see and edit everything in this trip. They sign in with the Google account for that email.</p>
    <div style="display:grid;gap:6px" id="invList">${members().map(e => `<div class="bal">${avatar(e)}<span><b>${esc(nameOf(e))}</b> <span class="hint" style="display:inline">${esc(e)}</span></span>${isOwner() && e !== T.trip.ownerEmail ? `<button class="iconbtn del" type="button" data-rmm="${esc(e)}" aria-label="Remove ${esc(e)}">×</button>` : `<span class="hint">${e === T.trip.ownerEmail ? "Planner" : ""}</span>`}</div>`).join("")}</div>
    ${isOwner() ? `<form id="invForm" class="row" style="gap:6px"><input class="input grow" id="invEmail" type="email" placeholder="friend@gmail.com" required><button class="btn accent" type="submit">Invite</button></form>` : `<p class="hint">Only the planner (${esc(T.trip.ownerEmail || "")}) can add or remove people.</p>`}
    <p class="hint" id="invMsg"></p>
    <div class="field"><span>Link to send them</span><div class="row" style="gap:6px"><input class="input grow" readonly value="${esc(link)}" id="invLink" aria-label="Trip link"><button class="btn ghost" type="button" id="invCopy">Copy</button></div></div>
    ${shareSection()}`, m => {
    $$("[data-close]", m).forEach(b => b.onclick = closeModal);
    wireShare(m);
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

// ================================================================ FAMILY LINK (read-only, no sign-in)
// A snapshot of the plan goes to shares/{token}. Anyone with the link can view it; nothing else in the trip is reachable from it.
const shareUrl = tok => location.href.split("#")[0] + "#/s/" + tok;
function shareSnapshot() {
  const t = T.trip, o = { bookings: true, ...(t.share?.opts || {}) }, days = tripDays();
  const snap = { tid: cur.id, v: 1, name: t.name || "Trip", start: t.start || "", end: t.end || "", where: destLabel(t) || "", by: nameOf(t.ownerEmail || ""), cover: /^https:/.test(t.cover || "") ? t.cover : "",
    days: days.map(iso => { const st = stayFor(iso);
      return { iso, col: colVal(dayColor(iso, days.indexOf(iso))), stay: st ? st[1].title || "" : "", parks: (T.days[iso]?.parks || []).map(p => p.name),
        items: dayItems(iso).map(x => x.k === "n" ? { n: 1, text: (x.text || "").slice(0, 300), time: x.time || "" } : { name: x.name, time: x.time || "", type: x.type, city: x.city || "", lat: x.lat ?? null, lon: x.lon ?? null }).filter(x => !x.n || x.text) }; }),
    flights: [], stays: [], updated: Date.now() };
  if (o.bookings) for (const b of Object.values(T.bookings)) {
    if (b.kind === "flight") flightSegs(b).forEach(l => validIso(l.depDate) && snap.flights.push({ num: l.num || "", from: l.from || "", to: l.to || "", d: l.depDate, t: l.depTime || "", ad: l.arrDate || "", at: l.arrTime || "" }));
    else if ((KINDS[b.kind] || KINDS.other).group === "lodging" && validIso(b.checkIn)) snap.stays.push({ name: b.title || "Stay", addr: b.addr || "", in: b.checkIn, out: b.checkOut || "" });
  }
  snap.flights.sort((a, b) => (a.d + a.t).localeCompare(b.d + b.t)); snap.stays.sort((a, b) => a.in.localeCompare(b.in));
  return snap;
}
let shareLast = "";
const pushShare = debounce(() => {
  const sh = T.trip?.share; if (!cur || !sh?.on || !sh.token || !ME || !members().includes(ME.email)) return;
  const snap = shareSnapshot(), { updated, ...cmp } = snap, sig = JSON.stringify(cmp);
  if (sig === shareLast) return; shareLast = sig;
  setDoc(doc(fs, "shares/" + sh.token), snap).catch(e => { if (e.code === "permission-denied") shareLast = ""; });
}, 4000);
function shareSection() {
  const sh = T.trip.share || {}, on = !!(sh.on && sh.token);
  return `<div class="card share-box"><div class="row between"><div><b>Family link</b><p class="hint">A view-only page of the day-by-day plan${(sh.opts?.bookings ?? true) ? ", flights and where you're staying" : ""}. No sign-in needed. Costs, confirmation numbers, notes pages and photos aren't included.</p></div>
      <label class="switch"><input type="checkbox" id="shOn" ${on ? "checked" : ""}><span>${on ? "On" : "Off"}</span></label></div>
    ${on ? `<div class="row" style="gap:6px"><input class="input grow" readonly value="${esc(shareUrl(sh.token))}" id="shLink" aria-label="Family link"><button class="btn ghost" type="button" id="shCopy">Copy</button></div>
      <label class="row" style="gap:6px"><input type="checkbox" id="shBk" ${(sh.opts?.bookings ?? true) ? "checked" : ""}> <span class="hint" style="display:inline">Include flights and stays</span></label>
      <p class="hint">It updates whenever someone on the trip has it open. Turning it off deletes the page, and turning it back on makes a new link.</p>` : ""}
    <p class="hint" id="shMsg" role="status"></p></div>`;
}
function wireShare(m) {
  const ref = doc(fs, "trips/" + cur.id);
  $("#shOn", m).onchange = async e => {
    const sh = T.trip.share || {};
    try {
      if (e.target.checked) { const token = (crypto.randomUUID?.() || uidGen() + uidGen() + uidGen()).replace(/-/g, "");
        T.trip.share = { token, on: true, opts: sh.opts || { bookings: true } }; shareLast = "";
        await setDoc(doc(fs, "shares/" + token), shareSnapshot()); await updateDoc(ref, { share: T.trip.share }); }
      else { if (sh.token) await deleteDoc(doc(fs, "shares/" + sh.token)).catch(() => {}); T.trip.share = { on: false }; await updateDoc(ref, { share: { on: false } }); }
      inviteModal();
    } catch (err) { e.target.checked = !e.target.checked; $("#shMsg").textContent = err.code === "permission-denied" ? "The database rules need the family link section added (see the setup notes)." : "Couldn't save. Check your connection."; }
  };
  $("#shCopy", m) && ($("#shCopy", m).onclick = () => navigator.clipboard?.writeText($("#shLink").value).then(() => { $("#shMsg").textContent = "Copied. Send it to family or friends."; }, () => $("#shLink").select()));
  $("#shBk", m) && ($("#shBk", m).onchange = async e => { T.trip.share = { ...T.trip.share, opts: { ...(T.trip.share.opts || {}), bookings: e.target.checked } }; shareLast = ""; await updateDoc(ref, { share: T.trip.share }).catch(fail); pushShare(); });
}
async function renderShare(token) {
  $("#crumb").textContent = ""; $("#meBtn").hidden = !ME; $("#backBtn").hidden = true; $("#layoutSeg").hidden = true;
  $("#app").innerHTML = `<div class="share-page"><p class="hint">Loading…</p></div>`;
  let d; try { const s = await getDoc(doc(fs, "shares/" + token)); d = s.exists() ? s.data() : null; } catch { d = undefined; }
  const box = $(".share-page"); if (!box) return;
  if (!d) { box.innerHTML = `<div class="card"><h2>${d === null ? "This link isn't active" : "Couldn't load this trip"}</h2><p class="hint">${d === null ? "The planner may have turned the family link off. Ask them for a new one." : "Check your connection and try again."}</p></div>`; return; }
  const today = isoOf(new Date()), fl = d.flights || [], st = d.stays || [];
  const t12 = t => t ? fmt12(t) : "";
  box.innerHTML = `<header class="share-hero">${d.cover ? `<img src="${esc(d.cover)}" alt="">` : ""}<div><h1>${esc(d.name)}</h1><span>${validIso(d.start) ? esc(`${fmtD(d.start, { month: "short", day: "numeric" })} – ${fmtD(d.end, { month: "short", day: "numeric", year: "numeric" })}`) : ""}${d.where ? " · " + esc(d.where) : ""}</span>${d.by ? `<span class="hint">Planned by ${esc(d.by)} · updated ${esc(new Date(d.updated).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</span>` : ""}</div></header>
    ${fl.length ? `<section class="card"><h3>✈ Flights</h3>${fl.map(f => `<div class="sh-row"><b>${esc(fmtD(f.d, { weekday: "short", month: "short", day: "numeric" }))}</b><span>${esc(f.num)} ${esc(f.from)} ${t12(f.t)} → ${esc(f.to)} ${t12(f.at)}${f.ad && f.ad !== f.d ? " (+" + daysBetween(f.d, f.ad) + ")" : ""}</span>${f.num ? `<a class="ext" href="https://www.flightaware.com/live/flight/${encodeURIComponent(f.num.replace(/\s/g, ""))}" target="_blank" rel="noopener">Track ↗</a>` : ""}</div>`).join("")}</section>` : ""}
    ${st.length ? `<section class="card"><h3>🛏 Where we're staying</h3>${st.map(x => `<div class="sh-row"><b>${esc(fmtD(x.in, { month: "short", day: "numeric" }))}${x.out ? "–" + esc(fmtD(x.out, { month: "short", day: "numeric" })) : ""}</b><span>${esc(x.name)}${x.addr ? `<span class="hint">${esc(x.addr)}</span>` : ""}</span></div>`).join("")}</section>` : ""}
    ${(d.days || []).map((dy, i) => `<section class="card sh-day ${dy.iso === today ? "is-today" : ""}" id="sd-${dy.iso}"><div class="row between"><h3><span class="sh-n" style="background:${esc(dy.col || "#888")}">${i + 1}</span>${dy.iso === today ? "Today · " : ""}${esc(fmtD(dy.iso, { weekday: "long", month: "short", day: "numeric" }))}</h3>${dy.stay ? `<span class="hint">🛏 ${esc(dy.stay)}</span>` : ""}</div>
      ${dy.parks?.length ? `<p class="hint">🎢 ${esc(dy.parks.join(" + "))}</p>` : ""}
      ${dy.items?.length ? `<ol class="sh-items">${dy.items.map(x => x.n ? `<li class="sh-note">${x.time ? `<b>${esc(t12(x.time))}</b> ` : ""}${esc(x.text).replace(/\n/g, "<br>")}</li>` : `<li><span class="tl-time">${esc(t12(x.time))}</span><span><b>${esc(x.name)}</b>${x.city && x.city !== x.name ? `<span class="hint">${esc(x.city)}</span>` : ""}</span>${x.lat != null ? `<a class="ext" href="https://maps.apple.com/?ll=${x.lat},${x.lon}&q=${encodeURIComponent(x.name)}" target="_blank" rel="noopener">Map ↗</a>` : ""}</li>`).join("")}</ol>` : `<p class="hint">Free day.</p>`}</section>`).join("")}
    <p class="hint" style="text-align:center">Made with Wayfinder. This page is view-only.</p>`;
  document.title = d.name + " · Wayfinder";
  const td = document.getElementById("sd-" + today); if (td) td.scrollIntoView({ block: "start" });
}

// ================================================================ SHARED PHOTO ALBUM
const AL = { day: "", who: "" };
function viewAlbum(v) {
  const days = tripDays(), all = Object.entries(T.photos).map(([id, p]) => ({ id, ...p })).sort((a, b) => (a.day || "9").localeCompare(b.day || "9") || (a.created || 0) - (b.created || 0));
  const whos = [...new Set(all.map(p => p.by).filter(Boolean))];
  const list = all.filter(p => (!AL.day || p.day === AL.day) && (!AL.who || p.by === AL.who));
  const groups = {}; list.forEach(p => (groups[p.day || ""] ||= []).push(p));
  v.innerHTML = `<div class="row between"><div><h2>Photos</h2><p class="hint">Everyone on the trip can add photos and see them here. They also go into the memory book.</p></div>
      <label class="btn accent file-btn">Add photos<input type="file" id="alFile" accept="image/*" multiple></label></div>
    <div class="row" style="gap:8px;flex-wrap:wrap"><label class="field" style="flex:1 1 180px">Add to<select id="alDay"><option value="">No day</option>${days.map((iso, i) => `<option value="${iso}" ${iso === (AL.addDay ?? (days.includes(isoOf(new Date())) ? isoOf(new Date()) : "")) ? "selected" : ""}>Day ${i + 1} · ${esc(fmtD(iso, { weekday: "short", month: "short", day: "numeric" }))}</option>`).join("")}</select></label>
      <label class="field" style="flex:1 1 160px">Show<select id="alF"><option value="">All days</option>${days.map((iso, i) => `<option value="${iso}" ${AL.day === iso ? "selected" : ""}>Day ${i + 1}</option>`).join("")}</select></label>
      ${whos.length > 1 ? `<label class="field" style="flex:1 1 160px">From<select id="alW"><option value="">Everyone</option>${whos.map(e => `<option value="${esc(e)}" ${AL.who === e ? "selected" : ""}>${esc(nameOf(e))}</option>`).join("")}</select></label>` : ""}</div>
    <p class="hint" id="alMsg" role="status"></p>
    ${list.length ? Object.entries(groups).map(([iso, ps]) => `<section class="al-day"><h3>${iso ? `Day ${days.indexOf(iso) + 1} · ${esc(fmtD(iso, { weekday: "long", month: "short", day: "numeric" }))}` : "Other photos"}</h3>
      <div class="al-grid">${ps.map(p => `<figure class="al-ph"><img src="${esc(p.data)}" alt="${esc(p.cap || "Trip photo")}" data-alopen="${p.id}" loading="lazy">${p.by ? `<span class="al-by">${avatar(p.by)}</span>` : ""}${p.cap ? `<figcaption>${esc(p.cap)}</figcaption>` : ""}</figure>`).join("")}</div></section>`).join("")
      : `<div class="empty">${all.length ? "No photos match." : "No photos yet. Add some from your phone, during the trip or after."}</div>`}`;
  $("#alDay").onchange = e => { AL.addDay = e.target.value; };
  $("#alF").onchange = e => { AL.day = e.target.value; renderTrip(); };
  $("#alW") && ($("#alW").onchange = e => { AL.who = e.target.value; renderTrip(); });
  $("#alFile").onchange = async e => {
    const files = [...e.target.files].filter(f => f.type.startsWith("image/")); e.target.value = ""; if (!files.length) return;
    const day = $("#alDay").value, tid = cur.id; let ok = 0;
    for (let i = 0; i < files.length; i++) {
      $("#alMsg").textContent = `Uploading ${i + 1} of ${files.length}…`;
      try { const data = await shrink(files[i], 1400, 300000), id = uidGen();
        await setDoc(doc(fs, `trips/${tid}/photos/${id}`), { day, data, by: ME.email, created: Date.now(), cap: "" }); ok++; }
      catch (err) { console.warn(err); }
    }
    $("#alMsg").textContent = ok === files.length ? `Added ${ok} photo${ok === 1 ? "" : "s"}.` : `Added ${ok} of ${files.length}. Some couldn't be uploaded.`;
  };
  v.onclick = e => { const im = e.target.closest("[data-alopen]"); if (im) albumLightbox(list, im.dataset.alopen); };
}
function albumLightbox(list, id) {
  let k = list.findIndex(p => p.id === id); if (k < 0) return;
  const lb = document.createElement("div"); lb.className = "lightbox al-lb"; document.body.append(lb);
  const close = () => { lb.remove(); document.removeEventListener("keydown", key); };
  const paint = () => { const p = list[k], mine = p.by === ME.email || isOwner();
    lb.innerHTML = `<img src="${esc(p.data)}" alt="${esc(p.cap || "Trip photo")}"><div class="al-bar" data-bar>
      <button class="iconbtn" type="button" data-nav="-1" ${k ? "" : "disabled"} aria-label="Previous">‹</button>
      <span class="grow">${mine ? `<input class="input" id="alCap" maxlength="120" placeholder="Add a caption" value="${esc(p.cap || "")}" aria-label="Caption">` : `<span>${esc(p.cap || "")}</span>`}<span class="hint">${p.by ? esc(nameOf(p.by)) : ""}${p.day ? " · " + esc(fmtD(p.day, { month: "short", day: "numeric" })) : ""}</span></span>
      ${mine ? `<button class="btn ghost small" type="button" data-aldel>Delete</button>` : ""}<a class="btn ghost small" href="${esc(p.data)}" download="photo-${esc(p.day || "trip")}.jpg">Save</a>
      <button class="iconbtn" type="button" data-nav="1" ${k < list.length - 1 ? "" : "disabled"} aria-label="Next">›</button><button class="iconbtn" type="button" data-x aria-label="Close">×</button></div>`;
    const cap = lb.querySelector("#alCap"); if (cap) cap.onchange = () => updateDoc(doc(fs, `trips/${cur.id}/photos/${p.id}`), { cap: cap.value.trim().slice(0, 120) }).then(() => { p.cap = cap.value.trim(); }).catch(fail);
  };
  let armed = false;
  lb.onclick = e => {
    if (e.target.closest("[data-x]") || e.target === lb) return close();
    const n = e.target.closest("[data-nav]"); if (n) { k = Math.max(0, Math.min(list.length - 1, k + +n.dataset.nav)); armed = false; return paint(); }
    const d = e.target.closest("[data-aldel]"); if (d) { if (!armed) { armed = true; d.textContent = "Tap again to delete"; return; } deleteDoc(doc(fs, `trips/${cur.id}/photos/${list[k].id}`)).catch(fail); list.splice(k, 1); if (!list.length) return close(); k = Math.min(k, list.length - 1); armed = false; paint(); }
  };
  const key = e => { if (e.target.tagName === "INPUT") return; if (e.key === "Escape") close(); if (e.key === "ArrowLeft" && k) { k--; paint(); } if (e.key === "ArrowRight" && k < list.length - 1) { k++; paint(); } };
  document.addEventListener("keydown", key); paint();
}

// ================================================================ MAP (Leaflet + OpenStreetMap/CARTO tiles)
let map = null, tiles = null, layer = null, mapFocus = null, fitPending = true, lastFitKey = "";
function initMap() {
  if (!window.L) { $("#map").innerHTML = `<div class="empty" style="margin:20px">The map couldn't load. Check your connection.</div>`; return; }
  map = L.map("map", { zoomControl: true, worldCopyJump: true, attributionControl: true }).setView([30, 0], 2);
  layer = L.layerGroup().addTo(map);
  setTiles(); fitPending = true;
}

// ================================================================ GOOGLE MAPS (when a key is in config.js)
let gReady = null, gFailed = false;
const useGoogle = () => !!GKEY && !gFailed;
function loadGoogle() {
  if (!useGoogle()) return Promise.reject(new Error("off"));
  return gReady ||= new Promise((res, rej) => {
    window.__gmInit = () => res();
    // Google calls this when the key is wrong or not allowed on this site
    window.gm_authFailure = () => { gFailed = true; gReady = null; toast("Google Maps didn't accept the key, so Wayfinder is using the free map and search. Check the key's website restriction and that billing is on."); setTiles(); };
    const el = document.createElement("script");
    el.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GKEY)}&v=weekly&language=en&libraries=places&loading=async&callback=__gmInit`;
    el.async = true; el.onerror = () => { gReady = null; rej(new Error("load")); }; document.head.append(el);
    setTimeout(() => rej(new Error("slow")), 12000);
  });
}
const gPlaces = async () => { await loadGoogle(); return google.maps.importLibrary("places"); };
// Google place types → this app's types
function gType(types = []) {
  const has = (...k) => k.some(x => types.includes(x));
  if (has("country", "locality", "administrative_area_level_1", "administrative_area_level_2", "sublocality", "neighborhood", "postal_town", "colloquial_area", "archipelago", "island")) return "city";
  if (has("cafe", "coffee_shop", "bakery", "tea_house", "dessert_shop", "ice_cream_shop", "donut_shop")) return "cafe";
  if (has("bar", "pub", "night_club", "wine_bar", "casino")) return "night";
  if (has("restaurant", "food", "meal_takeaway", "meal_delivery", "food_court", "fast_food_restaurant")) return "food";
  if (has("museum", "art_gallery")) return "museum";
  if (has("market", "farmers_market", "flea_market")) return "market";
  if (has("park", "natural_feature", "beach", "hiking_area", "national_park", "garden", "botanical_garden", "observation_deck", "scenic_spot")) return "nature";
  if (has("amusement_park", "zoo", "aquarium", "movie_theater", "performing_arts_theater", "concert_hall", "stadium", "water_park", "spa")) return "experience";
  if (has("store", "shopping_mall", "clothing_store", "book_store", "department_store", "gift_shop", "shoe_store", "jewelry_store")) return "shop";
  if (has("tourist_attraction", "church", "place_of_worship", "hindu_temple", "mosque", "synagogue", "historical_landmark", "monument", "cultural_landmark", "city_hall", "castle", "shrine", "buddhist_temple")) return "sight";
  return "other";
}
async function googleSuggest(q, near, token) {
  const { AutocompleteSuggestion } = await gPlaces();
  const req = { input: q, sessionToken: token, language: "en" };
  if (near) req.locationBias = { center: { lat: near.lat, lng: near.lon }, radius: 50000 };
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
  return (suggestions || []).filter(x => x.placePrediction).map(x => { const p = x.placePrediction;
    return { name: p.mainText?.text || p.text?.text || "", addr: p.secondaryText?.text || "", city: "", country: "", area: "", type: gType(p.types || []), lat: null, lon: null, pred: p, g: true }; });
}
const G_FIELDS = ["id", "displayName", "formattedAddress", "location", "types", "addressComponents", "googleMapsURI"];   // "Place Details Pro" fields only
function fromGPlace(pl) {
  const comp = (...t) => { for (const k of t) { const c = (pl.addressComponents || []).find(c => c.types.includes(k)); if (c) return c.longText; } return ""; };
  const type = gType(pl.types || []), name = pl.displayName || "";
  return { name, type, city: type === "city" ? name : comp("locality", "postal_town", "administrative_area_level_2", "administrative_area_level_1"), country: comp("country"), area: comp("sublocality_level_1", "neighborhood", "sublocality"),
    lat: pl.location?.lat(), lon: pl.location?.lng(), addr: pl.formattedAddress || "", full: true, link: pl.googleMapsURI || "", gid: pl.id || "" };
}
async function googleDetails(pred) {
  const pl = pred.toPlace();
  await pl.fetchFields({ fields: G_FIELDS });   // ends the search session (so the typing is free)
  return fromGPlace(pl);
}
// nearby search: stays and places to eat. Returns items shaped like the OpenStreetMap ones.
const G_NEAR = ["id", "displayName", "location", "formattedAddress", "types", "primaryType", "primaryTypeDisplayName", "rating", "userRatingCount", "priceLevel", "googleMapsURI", "websiteURI"];
const STAYG = t => t.includes("hostel") ? "hostel" : t.some(x => ["bed_and_breakfast", "guest_house", "inn"].includes(x)) ? "guest_house" : t.includes("motel") ? "motel" : t.some(x => ["private_guest_room", "cottage", "farmstay"].includes(x)) ? "apartment" : "hotel";
const PRICE = { INEXPENSIVE: "$", MODERATE: "$$", EXPENSIVE: "$$$", VERY_EXPENSIVE: "$$$$" };
async function googleNearby(lat, lon, radius, types) {
  const { Place, SearchNearbyRankPreference } = await gPlaces();
  const { places } = await Place.searchNearby({ fields: G_NEAR, locationRestriction: { center: { lat, lng: lon }, radius }, includedTypes: types, maxResultCount: 20, rankPreference: SearchNearbyRankPreference.POPULARITY, language: "en" });
  return (places || []).map(pl => ({ id: "g:" + pl.id, lat: pl.location.lat(), lon: pl.location.lng(), g: true,
    tags: { name: pl.displayName || "", tourism: STAYG(pl.types || []), cuisine: pl.primaryTypeDisplayName || "", website: pl.websiteURI || "", _addr: pl.formattedAddress || "", _rating: pl.rating || 0, _count: pl.userRatingCount || 0, _price: PRICE[String(pl.priceLevel || "").replace(/^PRICE_LEVEL_/, "")] || "", _maps: pl.googleMapsURI || "", _gid: pl.id, _gtype: gType(pl.types || []) } }));
}
const ratingTxt = t => t._rating ? `★ ${t._rating.toFixed(1)}${t._count ? ` (${t._count.toLocaleString("en-US")})` : ""}${t._price ? " · " + t._price : ""}` : "";
const G_ATTR = `<p class="hint g-attr">Results from Google Maps</p>`;
// dark style for the Google map
const G_DARK = [{ elementType: "geometry", stylers: [{ color: "#242f3e" }] }, { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] }, { elementType: "labels.text.fill", stylers: [{ color: "#9aa5b4" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#b9a07a" }] }, { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] }, { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] }, { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] }, { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] }, { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] }];
const GM_MUTANT = "https://unpkg.com/leaflet.gridlayer.googlemutant@0.16.0/dist/Leaflet.GoogleMutant.js";

// Base map: OpenFreeMap vector tiles (free, no key) drawn with MapLibre, so labels can be shown in English.
// Falls back to standard OpenStreetMap tiles if that can't load (old device, no WebGL, offline).
const ML_JS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js", ML_CSS = "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css", MLL_JS = "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js";
const OFM_ATTR = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
let glReady = null, glFailed = false, tileSeq = 0;
const loadScript = src => new Promise((res, rej) => { const el = document.createElement("script"); el.src = src; el.onload = res; el.onerror = rej; document.head.append(el); });
const hasWebGL = () => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } };
function loadGL() {
  return glReady ||= (async () => {
    if (!hasWebGL()) throw new Error("no webgl");
    if (!document.querySelector("link[data-ml]")) { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = ML_CSS; l.dataset.ml = "1"; document.head.append(l); }
    if (!window.maplibregl) await loadScript(ML_JS);
    if (!L.maplibreGL) await loadScript(MLL_JS);
  })();
}
const styleCache = {};
const mapLang = () => theme.labels || "en";
// rewrite every place-name label to English (falling back to the romanized, then local name)
function labelStyle(st, lang) {
  if (lang === "local") return st;
  const en = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
  const both = ["case", ["all", ["has", "name"], ["!=", ["get", "name"], en]], ["format", en, {}, "\n", {}, ["get", "name"], { "font-scale": 0.8 }], en];
  const out = JSON.parse(JSON.stringify(st));
  for (const ly of out.layers || []) {
    const tf = ly.layout?.["text-field"]; if (!tf) continue;
    if (/name/.test(JSON.stringify(tf))) ly.layout["text-field"] = lang === "both" ? both : en;
  }
  return out;
}
async function setTiles() {
  if (!map) return;
  const my = ++tileSeq, dark = document.documentElement.dataset.theme === "dark", lang = mapLang();
  const raster = () => {
    if (my !== tileSeq || !map) return;
    if (tiles) map.removeLayer(tiles);
    map.attributionControl?.removeAttribution(OFM_ATTR);
    tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    map.getContainer().classList.toggle("dark-tiles", dark);
  };
  if (useGoogle()) {
    try {
      await loadGoogle(); if (!L.gridLayer.googleMutant) await loadScript(GM_MUTANT);
      if (my !== tileSeq || !map) return;
      if (tiles) map.removeLayer(tiles);
      map.attributionControl?.removeAttribution(OFM_ATTR); map.getContainer().classList.remove("dark-tiles");
      tiles = L.gridLayer.googleMutant({ type: "roadmap", maxZoom: 21, styles: dark ? G_DARK : [] }).addTo(map);
      return;
    } catch { if (my !== tileSeq) return; }
  }
  if (glFailed) return raster();
  try {
    await Promise.race([loadGL(), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 9000))]);
    const name = dark ? "dark" : "liberty";
    const st = styleCache[name] ||= await fetch("https://tiles.openfreemap.org/styles/" + name).then(r => { if (!r.ok) throw new Error("style"); return r.json(); });
    if (my !== tileSeq || !map) return;
    if (tiles) map.removeLayer(tiles);
    map.attributionControl?.removeAttribution(OFM_ATTR);
    map.getContainer().classList.remove("dark-tiles");
    tiles = L.maplibreGL({ style: labelStyle(st, lang), interactive: false, attributionControl: false }).addTo(map);
    tiles.getAttribution = () => OFM_ATTR; map.attributionControl?.addAttribution(OFM_ATTR);
  } catch (e) { glFailed = true; glReady = null; raster(); }
}
function destroyMap() { if (map) { map.remove(); map = null; tiles = null; layer = null; } lastFitKey = ""; }
const icon = (html, cls = "", col = "var(--accent)", size = 26) => L.divIcon({ className: "", html: `<div class="mk ${cls}" style="--mc:${col}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
// map pin with a symbol inside, for stays and bookings
const GLYPH = {
  home: '<path d="M8.5 15.5 15 10l6.5 5.5V22h-4.3v-4.2h-4.4V22H8.5z" fill="#fff"/>',
  star: '<path d="m15 8.8 1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#fff"/>',
};
const pin = (glyph, col) => L.divIcon({ className: "", html: `<svg class="pin" width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s12-12.6 12-22A12 12 0 0 0 3 15c0 9.4 12 22 12 22z" style="fill:${col}" stroke="#fff" stroke-width="2"/>${GLYPH[glyph]}</svg>`, iconSize: [30, 38], iconAnchor: [15, 37], popupAnchor: [0, -34] });
function popupFor(p) {
  const d = tripDays().includes(p.day) ? dayLabel(p.day) : "Not scheduled";
  return `<b>${esc(p.name)}</b><br><span style="color:var(--muted)">${esc(TYPE[p.type]?.label || "")}${p.city ? " · " + esc(p.city) : ""}</span><br>${esc(d)}${p.time ? " · " + esc(p.time) : ""}`;
}
function renderMap() {
  // a sync from someone else shouldn't close the popup you're reading: redraw once it closes
  if (arguments[0] === "data" && map && map._popup && map.hasLayer(map._popup)) { if (!renderMap.waiting) { renderMap.waiting = true; map.once("popupclose", () => { renderMap.waiting = false; setTimeout(renderMap, 0); }); } return; }
  if (!map || !cur || !T.trip) return;
  layer.clearLayers();
  const pts = [], days = tripDays(), tab = cur.tab;
  const add = (lat, lon, ic, pop, id) => { const m = L.marker([lat, lon], { icon: ic, keyboard: true, title: "" }).addTo(layer); if (pop) m.bindPopup(pop); if (id) m.on("click", () => { if (tab === "places" || tab === "food") flashPlace(id); else if (tab === "plan") document.querySelector(`.stop[data-id="${id}"]`)?.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" }); }); pts.push([lat, lon]); return m; };
  if (tab === "plan" || tab === "overview") {
    days.forEach((iso, i) => {
      if (mapFocus && mapFocus !== iso) return;
      const items = dayPlaces(iso).filter(hasPt); if (!items.length) return;
      const col = dayColor(iso, i);
      L.polyline(items.map(p => [p.lat, p.lon]), { color: colVal(col), weight: 3, opacity: .8, dashArray: "6 6" }).addTo(layer);
      items.forEach((p, k) => add(p.lat, p.lon, icon(k + 1, "", col), popupFor(p), p.id));
    });
    // a travel day on its own: show the flight path with its layovers
    if (mapFocus) { loadAirports(); Object.values(T.bookings).forEach(b => { if (b.kind === "flight" && segDates(b).has(mapFocus)) drawFlight(b, colVal(dayColor(mapFocus, days.indexOf(mapFocus)))).forEach(q => pts.push(q)); }); }
    if (!mapFocus) placeList().filter(p => hasPt(p) && !days.includes(p.day)).forEach(p => add(p.lat, p.lon, icon("", "dot", "var(--muted)", 16), popupFor(p), p.id));
    Object.values(T.bookings).forEach(b => { if (b.kind === "lodging" && b.lat != null && (!mapFocus || (b.checkIn <= mapFocus && mapFocus < b.checkOut))) add(b.lat, b.lon, pin("home", "var(--d3)"), `<b>${esc(b.title || "Stay")}</b><br>${esc(fmtD(b.checkIn))} – ${esc(fmtD(b.checkOut))}`); });
  } else if (tab === "places") {
    placeList().filter(hasPt).filter(p => (!PF.type || p.type === PF.type) && (!PF.city || p.city === PF.city) && (!PF.country || p.country === PF.country)).forEach(p => add(p.lat, p.lon, icon("", "dot", TYPE[p.type].col, 16), popupFor(p), p.id));
  } else if (tab === "parks" && parkSel && parkOf(parkSel.iso, parkSel.pid)) {
    parkMapLayer(pts, add);
  } else if (tab === "food") {
    placeList().filter(p => hasPt(p) && FOODT.includes(p.type) && (!RF.kind || p.type === RF.kind) && (!RF.country || p.country === RF.country) && (!RF.city || p.city === RF.city)).forEach(p => add(p.lat, p.lon, icon("", "dot", TYPE[p.type].col, 16), popupFor(p), p.id));
    if (Array.isArray(eat.list)) eat.list.slice(0, 24).forEach(x => add(x.lat, x.lon, icon("", "dot", "var(--muted)", 11), `<b>${esc(x.tags.name)}</b>${x.tags.cuisine ? "<br>" + esc(x.tags.cuisine.replace(/[_;]/g, " ")) : ""}`));
  } else if (tab === "bookings") {
    loadAirports();
    Object.entries(T.bookings).forEach(([id, b]) => { if (b.kind === "flight" && (!bkFocus || bkFocus === id) && (!BF.kind || BF.kind === "transport")) drawFlight(b, colVal(KINDS.flight.col)).forEach(q => pts.push(q)); });
    if (!bkFocus) Object.values(T.bookings).forEach(b => { if (b.lat != null && (!BF.kind || (KINDS[b.kind] || KINDS.other).group === BF.kind)) add(b.lat, b.lon, pin(b.kind === "lodging" ? "home" : "star", (KINDS[b.kind] || KINDS.other).col), `<b>${esc(b.title || "")}</b>`); });
    if (!bkFocus && !BF.kind) placeList().filter(hasPt).forEach(p => add(p.lat, p.lon, icon("", "dot", "var(--muted)", 12), popupFor(p), p.id));
  } else {
    placeList().filter(hasPt).forEach(p => add(p.lat, p.lon, icon("", "dot", TYPE[p.type].col, 14), popupFor(p), p.id));
  }
  const chips = $("#mapDays");
  if (chips) {
    const flies = iso => Object.values(T.bookings).some(b => b.kind === "flight" && segDates(b).has(iso));
    const withPlaces = days.map((iso, i) => [iso, i, dayPlaces(iso).filter(hasPt).length]).filter(x => x[2] || flies(x[0]));
    chips.hidden = !(tab === "plan" || tab === "overview") || !withPlaces.length;
    chips.innerHTML = `<button type="button" class="${!mapFocus ? "on" : ""}" data-mday="">All days</button>` + withPlaces.map(([iso, i, n]) => `<button type="button" class="${mapFocus === iso ? "on" : ""}" data-mday="${iso}" style="--mc:${dayColor(iso, i)}" title="${esc(dayLabel(iso))}${n ? ` · ${n} place${n === 1 ? "" : "s"}` : " · travel day"}"><i></i>Day ${i + 1}${n ? "" : " ✈"}</button>`).join("");
    chips.onclick = e => { const b = e.target.closest("[data-mday]"); if (!b) return; focusDay(b.dataset.mday || null); if (b.dataset.mday && cur.tab === "plan") document.getElementById("day-" + b.dataset.mday)?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" }); };
  }
  const key = tab + "|" + (mapFocus || "") + "|" + (bkFocus || "") + "|" + BF.kind + "|" + (tab === "parks" && parkSel ? parkSel.iso + parkSel.pid + (mapCat.items ? "c" : "") : "") + "|" + pts.length;
  if (fitPending || key !== lastFitKey) {
    // Leaflet skips a new zoom while one is still animating, so wait for it
    const fit = () => { if (!map) return; if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15, animate: !reduceMotion() }); else { const ds = tripDests(T.trip).filter(hasPt); if (ds.length > 1) map.fitBounds(L.latLngBounds(ds.map(d => [d.lat, d.lon])).pad(0.3), { maxZoom: 6 }); else if (ds.length) map.setView([ds[0].lat, ds[0].lon], 6); } };
    if (map._animatingZoom) map.once("zoomend", () => setTimeout(fit, 0)); else fit();
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
