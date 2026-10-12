// Server-only. The flight graph: Dijkstra on price (docs/plans/flight-graph.md). Patrick, 12 October
// 2026: "money is more important than hours; why does ground have Dijkstra, when flights should have
// had it with price as the edge". The ground graph could always be searched properly because its
// edges were on disk; flights were asked of Kiwi one place at a time, so the walk kept a beam of two
// or three and missed loops. Here the flights are on disk too: the nightly job
// (scripts/ingest/flight-edges.ts) stores every one-way "anywhere" answer from about 160 airports
// for six weeks as edges, the fare memory adds the one-way fares anyone saw in the last three days,
// and the search below runs over all of them with no live Kiwi call.
//
// The search is a label-setting Dijkstra on a time-expanded graph. A label is a traveller in a city
// on a day, with the places visited so far. Its edges are a flight on that day (its price), a train
// or coach from the ground graph on the same day (an estimate at 0.10 euro per km), and a stay of
// n nights (free), where n is inside the traveller's nights per place. Cheapest first, hours only
// break ties (unless the trade-off asks to pay for time). A trip closes when it lands at a home
// airport, or reaches the door by land, with its nights inside the window.
//
// Honesty: graph prices are up to a day old and memory prices up to three days; every flight leg
// says where its price came from and when it was seen, and ground legs are marked estimated. A
// caller confirms the winners live before anyone books.
import citiesJson from "@/public/data/cities.json";
import { OVERLAND, OVERLAND_GENERATED, overlandArrival, overlandTown } from "./overland";
import { bookingUrl } from "./travelpayouts";
import countriesJson from "@/public/data/countries.json";
import { head } from "@vercel/blob";
import postgres from "postgres";
import { countryAllowed } from "./been";
import { airportCity, countryAirports, countryLabel, graphEnd, landMinutes, resolveGateway } from "./board";
import { hasStore, listJson, readJson, type StoredFile } from "./boards-store";
import { driveMinutes, haversineKm } from "./geo";
import { reachFrom } from "./ground";
import { InFlight, TtlLru } from "./memo";
import type { City, CountryInfo } from "./types";
import { findCityCode, resolveCountries } from "./wild";

// ---------------------------------------------------------------------------------------
// The stored format, shared with the ingest.

/** Where the nightly graph lives in Blob. FLIGHT_GRAPH_PREFIX points the reader somewhere else (a test run). */
export const FLIGHT_ROOT = "graph/flights";
export const flightRoot = (sub?: string) => (sub ? `${FLIGHT_ROOT}/${sub}` : FLIGHT_ROOT);
export const manifestPath = (root: string) => `${root}/latest.json`;

/** One flight as the ingest sees it. h (local departure time) and a (local arrival day) are extras the plan's list
 * did not name: without the arrival day an overnight flight would give its first stop a night it never has. */
export type RawEdge = { f: string; t: string; d: string; h: string; a: string; p: number; m: number; s: number; c: string; u: string; w: string };
const COLS = ["f", "t", "d", "h", "a", "p", "m", "s", "c", "u", "w"] as const;

/** A shard as stored: one array per field, so 30,000 edges do not repeat eleven keys each. */
export type FlightShard = {
  v: 1;
  generatedAt: string;
  date: string;
  shard: string;
  airports: string[];
  searched: number;
  failed: number;
  partial?: boolean;
  window: { from: string; to: string };
  bucket: number;
  n: number;
  cols: { [K in keyof RawEdge]: RawEdge[K][] };
};

export function encodeShard(edges: RawEdge[], meta: Omit<FlightShard, "v" | "n" | "cols">): FlightShard {
  const cols = Object.fromEntries(COLS.map((k) => [k, edges.map((e) => e[k])])) as FlightShard["cols"];
  return { v: 1, ...meta, n: edges.length, cols };
}

function decodeShard(s: FlightShard): RawEdge[] {
  const out: RawEdge[] = [];
  const c = s.cols;
  for (let i = 0; i < s.n; i++) out.push({ f: c.f[i], t: c.t[i], d: c.d[i], h: c.h?.[i] ?? "", a: c.a?.[i] ?? c.d[i], p: c.p[i], m: c.m[i], s: c.s[i], c: c.c[i], u: c.u[i], w: c.w[i] });
  return out;
}

export type ShardEntry = { path: string; url?: string; date: string; edges?: number; airports?: number; searched?: number; failed?: number; bytes?: number; at: string; partial?: boolean };
export type FlightManifest = { v: 1; generatedAt: string; root: string; date: string; n: number; shards: Record<string, ShardEntry> };

/** How long a shard stays in the manifest when its runner failed on later nights. */
export const MANIFEST_KEEP_DAYS = 3;
const SHARD_FILE = /shard-(\d+)\.json$/;

/**
 * The manifest after one shard finished: the previous one, every shard file of the day the store lists (so a
 * runner whose write was lost to a race is still named), and this shard's own entry. Entries older than three
 * days are dropped; for each shard index the newest day wins.
 */
export function mergeManifest(prev: FlightManifest | null, own: { root: string; n: number; index: number; entry: ShardEntry; listed: StoredFile[]; today: string }): FlightManifest {
  const shards: Record<string, ShardEntry> = {};
  const keepFrom = new Date(Date.parse(own.today + "T00:00:00Z") - MANIFEST_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const put = (idx: string, e: ShardEntry) => {
    if (e.date < keepFrom) return;
    const cur = shards[idx];
    if (!cur || e.date > cur.date || (e.date === cur.date && (e.edges != null || cur.edges == null))) shards[idx] = e;
  };
  for (const [idx, e] of Object.entries(prev?.shards ?? {})) put(idx, e);
  for (const f of own.listed) {
    const m = SHARD_FILE.exec(f.pathname);
    if (m) put(m[1], { path: f.pathname, url: f.url, date: own.today, bytes: f.size, at: f.uploadedAt });
  }
  shards[String(own.index)] = own.entry;
  const date = Object.values(shards).reduce((a, e) => (e.date > a ? e.date : a), "");
  return { v: 1, generatedAt: new Date().toISOString(), root: own.root, date, n: Math.max(own.n, prev?.n ?? 0), shards };
}

// ---------------------------------------------------------------------------------------
// The loaded graph.

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;

/** One flight edge in memory: the stored fields, the two cities, the day numbers, where the price came from. */
export type FlightEdge = RawEdge & { fc: string; tc: string; dn: number; an: number; src: "graph" | "memory" | "tp" | "overland"; /** A Travelpayouts fare moved this many days off the day it was seen (an estimate for this day). */ flex?: number; /** An overland link (lib/overland.ts): how it goes. */ mode?: "train" | "coach" | "ferry" };
export type FlightGraph = {
  edges: FlightEdge[];
  /** `${from city}|${day number}` → edge indexes, cheapest first. */
  byFromDay: Map<string, number[]>;
  graphDate: string;
  shards: number;
  bytes: number;
  fromGraph: number;
  fromMemory: number;
  /** Travelpayouts' cached fares (the breadth), with their one-day-either-side estimates. */
  fromTp: number;
  /** Overland links where no timetable is public (lib/overland.ts), one a day. */
  fromOverland: number;
  loadedAt: string;
  loadMs: number;
  /** No manifest, no shard, or a shard that could not be read: kept a minute, not ten, so a Blob hiccup heals. */
  thin?: boolean;
};

const CACHE_MS = 10 * 60_000;
/** The nightly Travelpayouts map (scripts/ingest/tp-edges.ts) and what a fare costs a day off the day it was seen. */
const TP_LATEST = "graph/tp/latest.json";
const TP_FLEX_EURO = 4;
/**
 * Days ahead the overland links are laid out for, every day: the search's whole horizon (anytime is six months), or a
 * March trip to Japan has no Tokyo to Kyoto train and no Kyoto (measured 2026-10-12 at 100 days).
 */
const OVERLAND_DAYS = 200;
const THIN_CACHE_MS = 60_000;
const graphCache = new TtlLru<FlightGraph>(2, CACHE_MS);
const graphLoads = new InFlight<FlightGraph>();
const MEMORY_DAYS = 3;
const MEMORY_ROWS = 60_000;
const DB_CAP_MS = 6_000;

const DAY_MS = 86_400_000;
/** Two sightings of one airport pair and day this close are one night's answers; further apart, the newer is the price. */
const SAME_NIGHT_MS = 12 * 3_600_000;
const dayNum = (iso: string) => Math.round(Date.parse(iso.slice(0, 10) + "T00:00:00Z") / DAY_MS);
const dayIso = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);

/** The fare memory's own small pool (as lib/insights.ts and lib/graph-walk.ts do): reads only, two connections. */
let sql: ReturnType<typeof postgres> | null = null;
function client() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const ssl = /sslmode=/i.test(url) ? undefined : /localhost|127\.0\.0\.1|@db:/i.test(url) ? false : ("require" as const);
  if (!sql) sql = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl, onnotice: () => {} });
  return sql;
}

type MemRow = { src: string; dst: string; out: string; price: string; stops: number; hours: string; carriers: string[] | null; url: string; seen: string };

/**
 * Every one-way fare seen in the last three days that still departs, one per airport pair and day: the cheapest of
 * the newest sighting (rows seen within 12 hours of the newest, so one search's 15 answers count together). Not the
 * cheapest of three days: a fare that has risen since must not undercut tonight's price. Empty without a database.
 */
async function memoryEdges(): Promise<RawEdge[]> {
  const db = client();
  if (!db) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      db<MemRow[]>`
        select distinct on (src, dst, out_date) src, dst, to_char(out_date, 'YYYY-MM-DD') as out, price, stops, hours, carriers, url,
          to_char(seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as seen
        from (
          select *, max(seen_at) over (partition by src, dst, out_date) as newest
          from fares
          where back_date is null and out_date >= current_date and seen_at > now() - (${MEMORY_DAYS} || ' days')::interval
        ) f
        where seen_at > newest - interval '12 hours'
        order by src, dst, out_date, price asc
        limit ${MEMORY_ROWS}`,
      new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DB_CAP_MS))),
    ]);
    if (!rows) {
      console.log("flight graph: fare memory too slow, loading without it");
      return [];
    }
    return rows.map((r) => {
      const m = Math.round(Number(r.hours) * 60);
      return { f: r.src, t: r.dst, d: r.out, h: "", a: landingDay(r.out, m, r.src, r.dst), p: Math.round(Number(r.price)), m, s: r.stops ?? 0, c: (r.carriers ?? []).join(", "), u: r.url, w: r.seen };
    });
  } catch (err) {
    console.log(`flight graph: memory ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The day a remembered flight lands, from its departure day and length only: about an hour of clock per 15
 * degrees of longitude and a departure around midday (as lib/graph-walk.ts estimates it), so a long flight east
 * lands the next day and a two-hour hop the same day.
 */
function landingDay(out: string, minutes: number, from: string, to: string): string {
  const a = resolveGateway(from);
  const b = resolveGateway(to);
  const shiftH = a && b ? (((b.lon - a.lon + 540) % 360) - 180) / 15 : 0;
  return dayIso(dayNum(out) + Math.max(0, Math.floor((12 + minutes / 60 + shiftH) / 24)));
}

/** A shard's address: the URL the manifest or the listing gave, else Blob's head. */
async function fetchShard(e: { path: string; url?: string }): Promise<{ shard: FlightShard; bytes: number } | null> {
  try {
    const url = e.url ?? (await head(e.path)).url;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.log(`flight graph: ${e.path}: ${res.status}`);
      return null;
    }
    const text = await res.text();
    return { shard: JSON.parse(text) as FlightShard, bytes: text.length };
  } catch (err) {
    console.log(`flight graph: ${e.path}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return null;
  }
}

/** The shards to read: the manifest's, with the newest day's folder listed so a shard the manifest lost is still read. */
async function shardList(root: string): Promise<{ entries: { path: string; url?: string; date: string }[]; date: string; manifest: boolean }> {
  const manifest = (await readJson<FlightManifest & { generatedAt?: string }>(manifestPath(root)))?.body ?? null;
  const byIndex = new Map<string, { path: string; url?: string; date: string }>();
  for (const [idx, e] of Object.entries(manifest?.shards ?? {})) byIndex.set(idx, e);
  const date = manifest?.date ?? "";
  // A test root keeps its shards next to the manifest; the nightly root keeps one folder a day. Without a manifest
  // the nightly root is not listed whole (test folders, and old days past the first page): the folders of the last
  // few days are asked for by name, newest first, and the first that holds shards is the graph.
  let listed: StoredFile[] = [];
  if (root.includes("/test-")) listed = await listJson(`${root}/shard-`, 200);
  else if (date) listed = await listJson(`${root}/${date}/`, 200);
  else
    for (let back = 0; back <= MANIFEST_KEEP_DAYS && !listed.length; back++)
      listed = await listJson(`${root}/${new Date(Date.now() - back * DAY_MS).toISOString().slice(0, 10)}/`, 200);
  for (const f of listed) {
    const m = SHARD_FILE.exec(f.pathname);
    if (!m) continue;
    const day = /(\d{4}-\d{2}-\d{2})\/shard-/.exec(f.pathname)?.[1] ?? date ?? f.uploadedAt.slice(0, 10);
    const cur = byIndex.get(m[1]);
    if (!cur || day > cur.date) byIndex.set(m[1], { path: f.pathname, url: f.url, date: day });
  }
  const entries = [...byIndex.values()];
  return { entries, date: entries.reduce((a, e) => (e.date > a ? e.date : a), date), manifest: !!manifest };
}

async function buildGraph(root: string): Promise<FlightGraph> {
  const t0 = Date.now();
  // The breadth (docs/plans/one-brain.md): Travelpayouts' nightly cache of recent Aviasales fares, for the nightly root only.
  const tpOn = root === FLIGHT_ROOT && hasStore() && process.env.ATLAS_TP_EDGES?.trim() !== "0";
  const [{ entries, date, manifest }, memory, tpShard] = await Promise.all([hasStore() ? shardList(root) : Promise.resolve({ entries: [], date: "", manifest: false }), memoryEdges(), tpOn ? fetchShard({ path: TP_LATEST }) : Promise.resolve(null)]);
  const shards = (await Promise.all(entries.map(fetchShard))).filter((s): s is { shard: FlightShard; bytes: number } => !!s);
  const todayN = dayNum(new Date().toISOString());
  // One edge per airport pair and day. Sightings more than 12 hours apart: the newer wins, so a fare that has
  // risen since is not shown at its old low. Within one night: the cheapest (the flights of that day as one search
  // saw them), on a tie the nightly edge (it knows the departure time and the real arrival day, a remembered row
  // only the day; every nightly search also lands in the memory, so the two usually hold the same fare), then
  // the newer.
  const best = new Map<string, FlightEdge>();
  let fromGraph = 0;
  let fromMemory = 0;
  const keepPrev = (prev: FlightEdge, e: RawEdge, src: FlightEdge["src"]): boolean => {
    const a = Date.parse(prev.w);
    const b = Date.parse(e.w);
    if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > SAME_NIGHT_MS) return a > b;
    if (prev.p !== e.p) return prev.p < e.p;
    if (prev.src !== src) return prev.src === "graph";
    return prev.w >= e.w;
  };
  const add = (e: RawEdge, src: FlightEdge["src"]) => {
    const dn = dayNum(e.d);
    if (dn < todayN || !(e.p > 0)) return;
    const key = `${e.f}|${e.t}|${e.d}`;
    const prev = best.get(key);
    if (prev && keepPrev(prev, e, src)) return;
    best.set(key, { ...e, fc: airportCity(e.f), tc: airportCity(e.t), dn, an: Math.max(dn, dayNum(e.a || e.d)), src });
  };
  for (const s of shards) for (const e of decodeShard(s.shard)) add(e, "graph");
  for (const e of memory) add(e, "memory");
  // Travelpayouts never stands over a Kiwi fare of the same flight and day (Kiwi's is bookable and usually newer).
  // A fare seen on one day is also offered a day either side, TP_FLEX_EURO dearer and marked: the cheapest month fare
  // to a place is one day of the month, and a stay of two or three nights rarely lands on exactly that day.
  let fromTp = 0;
  if (tpShard) {
    const tp = decodeShard(tpShard.shard);
    for (const e of tp) if (!best.has(`${e.f}|${e.t}|${e.d}`)) add(e, "tp");
    // Only a month's cheapest fare to a place is moved a day either side; a day's own cheapest is that day's (older
    // files mark nothing, and then every fare is moved, as before).
    const monthRows = (tpShard.shard as FlightShard & { month?: number[] }).month;
    const moved = monthRows ? monthRows.map((i) => tp[i]).filter(Boolean) : tp;
    for (const e of moved) {
      for (const off of [-1, 1]) {
        const d = dayIso(dayNum(e.d) + off);
        const key = `${e.f}|${e.t}|${d}`;
        if (best.has(key)) continue;
        add({ ...e, d, a: dayIso(dayNum(e.a || e.d) + off), p: e.p + TP_FLEX_EURO }, "tp");
        const x = best.get(key);
        if (x) x.flex = 1;
      }
    }
  }
  // Overland links (lib/overland.ts): every day of the map, a typical fare (the middle of the range), never over
  // anything else; kept under keys of their own, so a bus and a flight between the same two cities both stay.
  const ovEdges: FlightEdge[] = [];
  for (let n = todayN; n <= todayN + OVERLAND_DAYS; n++) {
    const d = dayIso(n);
    for (const l of OVERLAND) {
      const an = overlandArrival(l, n);
      ovEdges.push({ f: l.from, t: l.to, d, h: l.overnight ? "20:00" : "", a: dayIso(an), p: l.price, m: l.minutes, s: 0, c: l.operator, u: l.book, w: OVERLAND_GENERATED, fc: l.from, tc: l.to, dn: n, an, src: "overland", mode: l.mode });
    }
  }
  const edges = [...best.values(), ...ovEdges];
  let fromOverland = 0;
  for (const e of edges) e.src === "graph" ? fromGraph++ : e.src === "memory" ? fromMemory++ : e.src === "tp" ? fromTp++ : fromOverland++;
  edges.sort((a, b) => a.p - b.p);
  const byFromDay = new Map<string, number[]>();
  edges.forEach((e, i) => {
    const k = `${e.fc}|${e.dn}`;
    const list = byFromDay.get(k);
    if (list) list.push(i);
    else byFromDay.set(k, [i]);
  });
  const g: FlightGraph = {
    edges,
    byFromDay,
    graphDate: date,
    shards: shards.length,
    bytes: shards.reduce((a, s) => a + s.bytes, 0) + (tpShard?.bytes ?? 0),
    fromGraph,
    fromMemory,
    fromTp,
    fromOverland,
    loadedAt: new Date().toISOString(),
    loadMs: Date.now() - t0,
    thin: !manifest || !shards.length || shards.length < entries.length,
  };
  console.log(`flight graph: ${edges.length} edges (${fromGraph} graph from ${shards.length} shards of ${date || "none"}, ${fromMemory} memory, ${fromTp} Travelpayouts, ${fromOverland} overland), ${(g.bytes / 1024).toFixed(0)} KB, ${g.loadMs} ms`);
  return g;
}

/** The keys (from airport, to airport, day) a graph holds, built once per graph. */
const keySets = new WeakMap<FlightGraph, Set<string>>();
const overlays = new Map<string, { at: number; g: FlightGraph }>();
/**
 * The graph with a search's own extra fares laid over it (lib/tp-map.ts homeFares: the ways out of and into the
 * traveller's home cities; or, as src "memory", the live fares a thin search asked Kiwi for), never over a fare the
 * graph already holds for that flight and day; a month's cheapest fare is offered a day either side, as the nightly
 * ones are. The graph itself is not touched: the edges are appended and only the day lists that gain an edge are
 * copied. Kept ten minutes per graph and set of extras.
 */
export function withExtraEdges(g: FlightGraph, extra: { edges: RawEdge[]; month: boolean[] }, tag: string, src: "tp" | "memory" = "tp"): FlightGraph {
  if (!extra.edges.length) return g;
  const key = `${g.loadedAt}|${g.edges.length}|${tag}`;
  const hit = overlays.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.g;
  let have = keySets.get(g);
  if (!have) {
    have = new Set(g.edges.map((e) => `${e.f}|${e.t}|${e.d}`));
    keySets.set(g, have);
  }
  const todayN = dayNum(new Date().toISOString());
  const added: FlightEdge[] = [];
  const mine = new Set<string>();
  const put = (e: RawEdge, flex?: number) => {
    const dn = dayNum(e.d);
    const k = `${e.f}|${e.t}|${e.d}`;
    if (dn < todayN || !(e.p > 0) || have!.has(k) || mine.has(k)) return;
    mine.add(k);
    added.push({ ...e, fc: airportCity(e.f), tc: airportCity(e.t), dn, an: Math.max(dn, dayNum(e.a || e.d)), src, ...(flex ? { flex } : {}) });
  };
  extra.edges.forEach((e) => put(e));
  extra.edges.forEach((e, i) => {
    if (!extra.month[i]) return;
    for (const off of [-1, 1]) put({ ...e, d: dayIso(dayNum(e.d) + off), a: dayIso(dayNum(e.a || e.d) + off), p: e.p + TP_FLEX_EURO }, 1);
  });
  if (!added.length) return g;
  const edges = g.edges.concat(added);
  const byFromDay = new Map(g.byFromDay);
  const touched = new Set<string>();
  for (let i = g.edges.length; i < edges.length; i++) {
    const k = `${edges[i].fc}|${edges[i].dn}`;
    const list = touched.has(k) ? byFromDay.get(k)! : [...(byFromDay.get(k) ?? [])];
    list.push(i);
    byFromDay.set(k, list);
    touched.add(k);
  }
  for (const k of touched) byFromDay.get(k)!.sort((a, b) => edges[a].p - edges[b].p);
  const out: FlightGraph = { ...g, edges, byFromDay, ...(src === "tp" ? { fromTp: g.fromTp + added.length } : { fromMemory: g.fromMemory + added.length }), loadedAt: `${g.loadedAt}+${tag}` };
  overlays.set(key, { at: Date.now(), g: out });
  if (overlays.size > 30) overlays.delete(overlays.keys().next().value!);
  return out;
}

/**
 * The graph: the newest shards in Blob plus the fare memory's one-way rows of the last three days, indexed by
 * (from city, day). Kept ten minutes per process (two roots at the most, the nightly one and a test one); two
 * callers loading at once share one load.
 */
export async function loadFlightGraph(root = process.env.FLIGHT_GRAPH_PREFIX?.trim() || FLIGHT_ROOT): Promise<FlightGraph> {
  const hit = graphCache.get(root);
  if (hit && !(hit.thin && (graphCache.ageMs(root) ?? 0) > THIN_CACHE_MS)) return hit;
  return graphLoads.run(root, async () => {
    const g = await buildGraph(root);
    graphCache.set(root, g);
    return g;
  }).promise;
}

// ---------------------------------------------------------------------------------------
// Places, the ground and the home airports.

/** What a place is called and where it is: a city of the globe, else the airport. */
export function placeOf(code: string): { code: string; name: string; country: string; lat: number; lon: number } | null {
  const c = CITIES[code];
  if (c) return { code, name: c.name, country: c.country, lat: c.lat, lon: c.lon };
  const t = overlandTown(code);
  if (t) return t;
  const g = resolveGateway(code);
  return g ? { code, name: g.label, country: g.country, lat: g.lat, lon: g.lon } : null;
}

/** Grid over city centres for "which city is this station in" (as lib/graph-walk.ts and lib/trips.ts do it). */
const CELL = 0.25;
const grid = new Map<string, string[]>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = `${Math.floor(c.lat / CELL)},${Math.floor(c.lon / CELL)}`;
  const list = grid.get(k);
  if (list) list.push(code);
  else grid.set(k, [code]);
}
function nearestCity(lat: number, lon: number, maxKm = 25): string | null {
  const cl = Math.floor(lat / CELL);
  const co = Math.floor(lon / CELL);
  let best: string | null = null;
  let bestKm = maxKm;
  for (let dl = -1; dl <= 1; dl++)
    for (let dn = -1; dn <= 1; dn++)
      for (const code of grid.get(`${cl + dl},${co + dn}`) ?? []) {
        const c = CITIES[code];
        const km = haversineKm(lat, lon, c.lat, c.lon);
        if (km < bestKm) {
          bestKm = km;
          best = code;
        }
      }
  return best;
}

/** What a kilometre of train or coach costs when no fare is known (lib/route-finder.ts and the walk use the same). */
const EURO_PER_KM = 0.1;
const groundPrice = (km: number) => Math.max(3, Math.round(km * EURO_PER_KM));
type GroundLink = { code: string; minutes: number; mode: string; km: number };
/** Ground reaches per city and limit, across requests: one is a Dijkstra over 16,000 stations (tens of ms). */
const reachMemo = new TtlLru<GroundLink[]>(1024, 60 * 60_000);
/** The ground reach if it is already known (memoised), without computing it. */
function groundKnown(code: string, maxMinutes: number): GroundLink[] | undefined {
  return reachMemo.get(`${code}|${maxMinutes}`);
}
function groundFrom(code: string, maxMinutes: number): GroundLink[] {
  const key = `${code}|${maxMinutes}`;
  const hit = reachMemo.get(key);
  if (hit) return hit;
  const at = placeOf(code);
  const links = new Map<string, GroundLink>();
  if (at) {
    try {
      for (const s of reachFrom(at.lat, at.lon, maxMinutes, 20).reached) {
        const city = nearestCity(s.lat, s.lon);
        if (!city || city === code) continue;
        const prev = links.get(city);
        if (!prev || s.minutes < prev.minutes) links.set(city, { code: city, minutes: s.minutes, mode: s.mode, km: haversineKm(at.lat, at.lon, CITIES[city].lat, CITIES[city].lon) });
      }
    } catch {
      // the ground graph is optional: no ground edges then
    }
  }
  const out = [...links.values()].sort((a, b) => a.minutes - b.minutes);
  reachMemo.set(key, out);
  return out;
}

export type HomeAirport = { code: string; city: string; name: string; minutes: number; km: number; price: number };
/** Ground from the door to an airport may take this long (6 h): Brasov to Otopeni, Sibiu, Cluj. */
const HOME_GROUND_MAX_MIN = 360;
const homeMemo = new TtlLru<HomeAirport[]>(200, 60 * 60_000);

/**
 * The traveller's home airports with the ground leg from the door, priced at 0.10 euro per km and timed on the
 * ground graph (the road estimate where the graph has no stations). Given codes are kept whatever the time; left
 * out, every large or medium airport of the home country within six hours.
 */
export function homeAirportsFor(origin: { lat: number; lon: number }, homeCountry: string, given?: string[]): HomeAirport[] {
  const key = `${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}|${homeCountry}|${(given ?? []).join(",")}`;
  const hit = homeMemo.get(key);
  if (hit) return hit;
  const door = { key: `door:${origin.lat.toFixed(3)},${origin.lon.toFixed(3)}`, lat: origin.lat, lon: origin.lon };
  const codes = given?.length ? given : countryAirports(homeCountry);
  const out: HomeAirport[] = [];
  for (const code of codes) {
    const end = graphEnd(code);
    if (!end) continue;
    const km = haversineKm(origin.lat, origin.lon, end.lat, end.lon);
    const timed = km < 15 ? driveMinutes(km) : landMinutes(door, end, true, 40);
    const minutes = timed ?? (given?.length ? driveMinutes(km) : null);
    if (minutes == null || (!given?.length && minutes > HOME_GROUND_MAX_MIN)) continue;
    const city = airportCity(code);
    out.push({ code, city, name: placeOf(city)?.name ?? code, minutes, km: Math.round(km), price: km < 15 ? Math.max(1, Math.round(km * EURO_PER_KM)) : groundPrice(km) });
  }
  out.sort((a, b) => a.minutes - b.minutes);
  homeMemo.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------
// What the searches answer.

export type Tradeoff = "price" | "balanced" | "comfort";
/** Euros an hour of travel is worth: nothing on price (hours only break ties), then the plan's two rates. */
const HOUR_EURO: Record<Tradeoff, number> = { price: 0, balanced: 6, comfort: 18 };
/** A change of plane on a ticket, in euros on top of its fare, per tradeoff (the walk's STOP_EURO): the owner wants
 * fewer stops, so even at Cheapest a nonstop beats a one-stop that is a few euros cheaper. Ranking only, never a price. */
const STOP_EURO: Record<Tradeoff, number> = { price: 12, balanced: 25, comfort: 60 };
/** Other flights shown beside each flight of a traced trip: out of the same city, a day either side. */
const TRACE_ALTERNATIVES = 8;
/** A tie on euros is broken by minutes: this small a weight never outvotes a whole euro over a 100-hour trip. */
const TIE = 1e-5;

export type GraphLeg = {
  kind: "fly" | "train" | "coach" | "ferry" | "ground";
  from: string;
  fromName: string;
  to: string;
  toName: string;
  date: string;
  /** Local departure time (HH:MM) when the graph knows it. */
  depart?: string;
  /** The day it arrives. */
  arrive: string;
  minutes: number;
  price: number;
  /** Ground legs: a price at 0.10 euro per km, not a fare. */
  estimated?: boolean;
  carrier?: string;
  url?: string;
  stops?: number;
  source: "graph" | "memory" | "tp" | "overland" | "ground";
  /** When the price was seen (flights). */
  seen?: string;
  /** A Travelpayouts fare seen this many days away from this leg's day: an estimate for this day. */
  offDay?: number;
  /** Traced trips only (TripsQuery.trace): the other flights out of the same city a day either side, cheapest first. */
  alternatives?: { to: string; toName: string; date: string; price: number; minutes: number; stops: number; same: boolean }[];
};
export type GraphStop = { code: string; name: string; country: string; lat: number; lon: number; arrive: string; leave: string; nights: number };
export type GraphTrip = { legs: GraphLeg[]; stops: GraphStop[]; total: number; flights: number; ground: number; hours: number; nights: number; start: string; end: string; why: string[] };
export type TripsResult = { trips: GraphTrip[]; explored: number; /** Labels made, and the ms the A* bound took (traced runs read them). */ labels?: number; boundMs?: number; /** Cities whose train and coach reach was not computed in time (GROUND_BUDGET_MS). */ groundSkipped?: number; edges: number; graphDate: string; homeAirports: HomeAirport[]; ms: number; note?: string; truncated?: boolean };

export type TripsQuery = {
  origin: { lat: number; lon: number; label: string };
  homeCountry: string;
  /** The trip lies inside [from, to] (YYYY-MM-DD): the first leg leaves on or after from, the last lands by to. */
  from: string;
  to: string;
  minNights: number;
  maxNights: number;
  /** Nights each place takes, both ends included: [2, 3] is 2 or 3. */
  nightsPerPlace: [number, number];
  maxPlaces: number;
  /** The fewest places a trip may have (default 1): 2 asks for two-city trips only, so cheap returns cannot fill the list. */
  minPlaces?: number;
  /** How many trips to answer (default 10, at most 30), each a different sequence of cities. */
  top?: number;
  tradeoff?: Tradeoff;
  /** "Been" countries (ISO2): never a stop. */
  exclude?: string[];
  /** Countries or cities (codes or names) never to stop in. Groups ("dach", "like:DE") are the caller's to expand. */
  avoid?: string[];
  /** The longest train or coach hop, minutes (default 330); 0 is flights only. */
  groundMaxMin?: number;
  /** Home airports (IATA); default every airport of homeCountry within 6 h of the door by ground. */
  homeAirports?: string[];
  /** Explain the answer (the admin's engine room): every flight of a trip lists the other flights it was chosen over. */
  trace?: boolean;
  /**
   * Places every trip must stay in (at most MAX_MUST): a city by its code, or any stop within MUST_KM of the point
   * (Machu Picchu is a stay in Aguas Calientes; Ollantaytambo, 30 km off, is not). The search itself is aimed at them, not filtered afterwards, so a
   * dearer trip that reaches the place is found even when twenty cheaper ones do not.
   */
  must?: {
    code?: string;
    lat?: number;
    lon?: number;
    name?: string;
    /** Its own radius, km (a town the stops never reach: 60). */
    km?: number;
    /** A country: any stop in it counts ("Georgia and Armenia" is a stay in each). */
    country?: string;
  }[];
  /** Stops in the home country are fine (the traveller named a place there: Cusco from Lima); never the home cities. */
  allowHome?: boolean;
  /**
   * A day every trip must include (away on it): checked inside the search, not after it. The search keeps one trip per
   * sequence of cities, so a filter afterwards dropped Warsaw and Gdansk on 20 to 24 October and never saw the same two
   * on 24 to 31 October, which includes the 26th (the owner's search, 2026-10-12).
   */
  include?: string;
};

const kindOfMode = (mode: string): GraphLeg["kind"] => (mode === "rail" ? "train" : mode === "ferry" ? "ferry" : "coach");
const DEFAULT_GROUND_MIN = 330;
const TOP = 10;
/**
 * Labels kept per node (kind, city, day, places, first day), each with a different sequence of cities. Two labels
 * with the same sequence at the same node have the same futures, so only the cheaper is kept; different sequences
 * are kept side by side (up to this many, the cheapest), so three airports of London cannot crowd a cheaper trip
 * through Paris out of the node.
 */
const PER_NODE = 6;
/**
 * Hard stops so a wide question cannot hold a serverless instance for seconds or hundreds of MB: labels popped and
 * labels made. Hitting either sets a note, because the answer is then the cheapest found, not proven the cheapest.
 */
const MAX_EXPLORED = 120_000;
const MAX_LABELS = 300_000;
/** And a wall-clock budget: a full night's graph has more edges a node than any test, so pops alone do not bound the time. */
const MAX_SEARCH_MS = 4_000;
/** What one search may spend reaching new cities by train or coach (see groundOf in cheapestTripsIn). */
const GROUND_BUDGET_MS = 1_200;

/** The traveller's avoid list as country and city codes. Unknown words are named back. */
function resolveAvoid(raw: string[] | undefined): { countries: Set<string>; cities: Set<string>; unknown: string[] } {
  const countries = new Set<string>();
  const cities = new Set<string>();
  const unknown: string[] = [];
  for (const item of raw ?? []) {
    const s = String(item ?? "").trim();
    if (!s) continue;
    const up = s.toUpperCase();
    if (/^[A-Z]{2}$/.test(up) && COUNTRIES[up]) {
      countries.add(up);
      continue;
    }
    // A country's exact name wins over a city of the same name ("Singapore", "Malta"), as the walk reads it.
    const cc = resolveCountries([s]).codes[0];
    if (cc) {
      countries.add(cc);
      continue;
    }
    const city = findCityCode(s);
    if (city) cities.add(city);
    else unknown.push(s.slice(0, 40));
  }
  return { countries, cities, unknown };
}

type Label = {
  kind: 0 | 1; // 0: just arrived in `city` on `day`; 1: about to leave it on `day`
  city: string;
  day: number;
  places: number;
  start: number;
  cost: number;
  euros: number;
  minutes: number;
  /** The cities stayed in, in order. */
  visited: string[];
  parent: number;
  /** How the label was reached, kept small because hundreds of thousands are made and ten are shown: a flight edge's
   * index, or a shared ground link (from the parent's city on this label's day), or a built leg (the door only). */
  fe?: number;
  gl?: GroundLink;
  leg?: GraphLeg;
  /** Stay labels: the nights just spent. */
  nights?: number;
  /** Euros of taste on top of the fares (changes of plane, STOP_EURO): in the cost, never in a price. */
  pen?: number;
  /** The must places stayed in so far, one bit each. */
  mm?: number;
  /** Passing back through a city already stayed in, the same day, by train, coach or ferry (Aguas Calientes to Cusco
   * to the flight home): no stay, no new place, and never two passes in a row. */
  tr?: boolean;
};
/**
 * On a short trip a place may take one night more than the style's most, at a price in the cost (never in a fare):
 * Brasov to Warsaw, 4 nights, the train to Gdansk, 3 nights, home is 97 euro on 24 to 31 October, the cheapest
 * Warsaw and Gdansk by 50 euro, and with 2 to 3 nights a place it could not be found (the owner's trip, 2026-10-12).
 */
const NIGHT_SLACK = 1;
const NIGHT_SLACK_MAX_TRIP = 14;
const NIGHT_OVER_EURO: Record<Tradeoff, number> = { price: 6, balanced: 12, comfort: 20 };
/** Musts at the most, and how near a stop must be to count as the place. */
const MAX_MUST = 4;
const MUST_KM = 20;

/**
 * A lower bound on what getting home costs from every city (the A* heuristic of cheapestTripsIn): a Dijkstra run
 * backwards from the home cities over a relaxed graph that forgets dates, nights and places. Its edges are the
 * cheapest flight cost ever seen between two cities (fare + hours at the rate + the change-of-plane euros, as a label
 * counts them) and every train or coach a city pair could have (0.10 euro a straight-line km, what groundLeg charges,
 * hours not counted). Forgetting a constraint can only make a way home cheaper, so the bound never overestimates and
 * the search stays exact; it is consistent too (a shortest-path distance), so a label popped is final. A city with no
 * way home at all gets no bound: nothing that lands there can close. Kept per graph load and home.
 */
const relaxedMemo = new Map<string, Map<string, number>>();
/** Straight-line km a train or coach hop may span in the relaxed graph: more than any real reach (330 min, 720 at most). */
const RELAXED_GROUND_KM = 900;
function relaxedHome(g: FlightGraph, targets: string[], rate: number, stopEuro: number, ground: boolean): Map<string, number> {
  const key = `${g.loadedAt}|${g.edges.length}|${targets.join(",")}|${rate}|${stopEuro}|${ground}`;
  const hit = relaxedMemo.get(key);
  if (hit) return hit;
  // Reverse adjacency: for each city, the cheapest way into it from each other city.
  const into = new Map<string, Map<string, number>>();
  const link = (from: string, to: string, cost: number) => {
    let m = into.get(to);
    if (!m) into.set(to, (m = new Map()));
    const prev = m.get(from);
    if (prev == null || cost < prev) m.set(from, cost);
  };
  for (const e of g.edges) link(e.fc, e.tc, e.p + stopEuro * (e.s || 0) + rate * e.m);
  if (ground) {
    const nodes = [...new Set([...g.edges.flatMap((e) => [e.fc, e.tc]), ...targets])]
      .map((c) => ({ c, p: placeOf(c) }))
      .filter((x): x is { c: string; p: NonNullable<ReturnType<typeof placeOf>> } => !!x.p)
      .sort((a, b) => a.p.lat - b.p.lat);
    const latSpan = RELAXED_GROUND_KM / 111;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length && nodes[j].p.lat - nodes[i].p.lat <= latSpan; j++) {
        const km = haversineKm(nodes[i].p.lat, nodes[i].p.lon, nodes[j].p.lat, nodes[j].p.lon);
        if (km > RELAXED_GROUND_KM) continue;
        const cost = groundPrice(km);
        link(nodes[i].c, nodes[j].c, cost);
        link(nodes[j].c, nodes[i].c, cost);
      }
    }
  }
  const dist = new Map<string, number>();
  const heap = new Heap();
  const names: string[] = [];
  const idOf = new Map<string, number>();
  const id = (c: string) => {
    let n = idOf.get(c);
    if (n == null) {
      n = names.length;
      names.push(c);
      idOf.set(c, n);
    }
    return n;
  };
  for (const t of targets) {
    dist.set(t, 0);
    heap.push(0, id(t));
  }
  while (heap.size) {
    const c = names[heap.pop()];
    const d = dist.get(c)!;
    for (const [from, cost] of into.get(c) ?? []) {
      const nd = d + cost;
      const prev = dist.get(from);
      if (prev == null || nd < prev - 1e-9) {
        dist.set(from, nd);
        heap.push(nd, id(from));
      }
    }
  }
  if (relaxedMemo.size > 20) relaxedMemo.clear();
  relaxedMemo.set(key, dist);
  return dist;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The other flights out of the same city a day either side of edge i, cheapest first (the trace). */
function alternativesTo(g: FlightGraph, i: number): NonNullable<GraphLeg["alternatives"]> {
  const e = g.edges[i];
  const out: NonNullable<GraphLeg["alternatives"]> = [];
  for (let d = e.dn - 1; d <= e.dn + 1; d++) {
    for (const j of g.byFromDay.get(`${e.fc}|${d}`) ?? []) {
      if (j === i) continue;
      const x = g.edges[j];
      out.push({ to: x.tc, toName: placeOf(x.tc)?.name ?? x.t, date: x.d, price: x.p, minutes: x.m, stops: x.s, same: x.tc === e.tc });
    }
  }
  return out.sort((a, b) => a.price - b.price).slice(0, TRACE_ALTERNATIVES);
}

const flightLeg = (e: FlightEdge): GraphLeg => ({
  kind: e.mode ?? "fly",
  from: e.f,
  fromName: placeOf(e.fc)?.name ?? e.f,
  to: e.t,
  toName: placeOf(e.tc)?.name ?? e.t,
  date: e.d,
  depart: e.h || undefined,
  arrive: dayIso(e.an),
  minutes: e.m,
  price: e.p,
  carrier: e.c || undefined,
  url: e.u || (e.src === "tp" ? bookingUrl("", e.f, e.t, `${e.d}T12:00:00Z`) : undefined),
  stops: e.s,
  source: e.src,
  seen: e.w,
  // A cached Aviasales fare is not a live quote: shown with a ~, and Search confirms it live before calling it found.
  ...(e.src === "tp" || e.src === "overland" ? { estimated: true } : {}),
  ...(e.flex ? { offDay: e.flex } : {}),
});
const groundLeg = (from: string, to: string, day: number, link: { minutes: number; mode: string; km: number }): GraphLeg => ({
  kind: kindOfMode(link.mode),
  from,
  fromName: placeOf(from)?.name ?? from,
  to,
  toName: placeOf(to)?.name ?? to,
  date: dayIso(day),
  arrive: dayIso(day),
  minutes: link.minutes,
  price: groundPrice(link.km),
  estimated: true,
  source: "ground",
});
/**
 * The home end of an edge: a home airport for a flight; for an overland link (a bus, a train, a ferry), the home city
 * it leaves from or reaches, its centre reached by road from the door (a coach leaves from a town, not an airport).
 */
function homeEndOf(code: string, mode: FlightEdge["mode"], homeByCode: Map<string, HomeAirport>, homeCitySet: Set<string>, origin: { lat: number; lon: number }): HomeAirport | undefined {
  if (!mode) return homeByCode.get(code);
  if (!homeCitySet.has(code)) return undefined;
  const p = placeOf(code);
  if (!p) return undefined;
  const km = haversineKm(origin.lat, origin.lon, p.lat, p.lon);
  return { code, city: code, name: `${p.name} centre`, minutes: km < 3 ? 10 : driveMinutes(km), km: Math.round(km), price: km < 15 ? Math.max(1, Math.round(km * EURO_PER_KM)) : groundPrice(km) };
}

const doorLeg = (h: HomeAirport, label: string, out: boolean, day: number): GraphLeg => ({
  kind: "ground",
  from: out ? "HOME" : h.code,
  fromName: out ? label : h.name,
  to: out ? h.code : "HOME",
  toName: out ? h.name : label,
  date: dayIso(day),
  arrive: dayIso(day),
  minutes: h.minutes,
  price: h.price,
  estimated: true,
  source: "ground",
});

function seenAgo(iso: string | undefined): string {
  const h = iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : NaN;
  if (!Number.isFinite(h)) return "at an unknown time";
  return h < 1 ? "in the last hour" : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The cheapest trips from the door and back inside a window: up to ten distinct ones (no two visit the same
 * cities in the same order), cheapest first by the trade-off's cost. Pure over the loaded graph: no Kiwi call.
 */
export async function cheapestTrips(q: TripsQuery): Promise<TripsResult> {
  const g = await loadFlightGraph();
  return cheapestTripsIn(g, q);
}

export function cheapestTripsIn(g: FlightGraph, q: TripsQuery): TripsResult {
  const t0 = Date.now();
  const home = q.homeCountry.trim().toUpperCase();
  const fromN = dayNum(q.from);
  const toN = dayNum(q.to);
  const minNights = Math.max(1, Math.round(q.minNights));
  const maxNights = Math.max(minNights, Math.round(q.maxNights));
  const lo = Math.max(1, Math.round(Math.min(q.nightsPerPlace[0], q.nightsPerPlace[1])));
  const hi = Math.max(lo, Math.round(Math.max(q.nightsPerPlace[0], q.nightsPerPlace[1])));
  // Its range of nights, with one night of slack on a short trip of several places (NIGHT_SLACK).
  const hiSoft = Math.round(q.maxNights) <= NIGHT_SLACK_MAX_TRIP && Math.round(q.maxPlaces) > 1 ? hi + NIGHT_SLACK : hi;
  const maxPlaces = Math.max(1, Math.min(12, Math.round(q.maxPlaces)));
  const minPlaces = Math.max(1, Math.min(maxPlaces, Math.round(q.minPlaces ?? 1)));
  const top = Math.max(1, Math.min(30, Math.round(q.top ?? TOP)));
  const rate = HOUR_EURO[q.tradeoff ?? "price"] / 60;
  const stopPen = (n: number | undefined) => Math.max(0, n || 0) * STOP_EURO[q.tradeoff ?? "price"];
  const groundMax = q.groundMaxMin == null ? DEFAULT_GROUND_MIN : Math.max(0, Math.min(720, Math.round(q.groundMaxMin)));
  const exclude = (q.exclude ?? []).map((c) => c.trim().toUpperCase());
  const avoid = resolveAvoid(q.avoid);
  const homes = homeAirportsFor(q.origin, home, q.homeAirports);
  const incN = q.include ? dayNum(q.include) : null;
  const empty = (note: string): TripsResult => ({ trips: [], explored: 0, edges: g.edges.length, graphDate: g.graphDate, homeAirports: homes, ms: Date.now() - t0, note });
  if (!Number.isFinite(fromN) || !Number.isFinite(toN) || toN < fromN) return empty("from and to must be real dates, to not before from");
  if (toN - fromN < minNights) return empty(`the window ${q.from} to ${q.to} is shorter than ${minNights} nights`);
  if (avoid.unknown.length) return empty(`unknown place to avoid: ${avoid.unknown.join(", ")}`);
  if (!homes.length) return empty(`no airport of ${home} within ${HOME_GROUND_MAX_MIN / 60} h of ${q.origin.label} by land`);
  if (!g.edges.length) return empty("the flight graph is empty: no stored shards and no fare memory");
  if (maxPlaces * hi < minNights) return empty(`${maxPlaces} place${maxPlaces === 1 ? "" : "s"} of at most ${hi} nights cannot fill ${minNights} nights`);

  const homeByCode = new Map(homes.map((h) => [h.code, h]));
  const homeCities = [...new Set(homes.map((h) => h.city))];
  const homeCitySet = new Set(homeCities);
  /** The door's own city: a train or coach that reaches it closes the trip. */
  const doorCity = nearestCity(q.origin.lat, q.origin.lon, 40);
  // A*: every label is ordered by its cost plus the cheapest way home its city could possibly have (relaxedHome).
  const tA = Date.now();
  const toHome = relaxedHome(g, [...new Set([...homeCities, ...(doorCity ? [doorCity] : [])])], rate, STOP_EURO[q.tradeoff ?? "price"], groundMax > 0);
  const boundMs = Date.now() - tA;
  // The search's own clock starts after the bound. Reaching a city by train or coach for the first time is a Dijkstra
  // over the ground graph (tens of ms where the timetables are dense, the US with Amtrak and FlixBus): each search may
  // spend GROUND_BUDGET_MS on new ones, then uses only the reaches already known (kept an hour, so they warm up).
  const tSearch = Date.now();
  let groundSpent = 0;
  let groundSkipped = 0;
  const groundOf = (code: string): GroundLink[] => {
    const known = groundKnown(code, groundMax);
    if (known) return known;
    if (groundSpent >= GROUND_BUDGET_MS) {
      groundSkipped++;
      return [];
    }
    const t = Date.now();
    const out = groundFrom(code, groundMax);
    groundSpent += Date.now() - t;
    return out;
  };
  /** The A* bound of a city; Infinity where nothing known gets home (a label there can never close). */
  const hOf = (city: string) => (city === "HOME" ? 0 : (toHome.get(city) ?? Infinity));
  const homeCityDoor = new Map<string, HomeAirport>();
  for (const h of homes) {
    const cur = homeCityDoor.get(h.city);
    if (!cur || h.price + rate * h.minutes < cur.price + rate * cur.minutes) homeCityDoor.set(h.city, h);
  }

  const landable = (code: string, visited: string[]): boolean => {
    const p = placeOf(code);
    if (!p || visited.includes(code)) return false;
    if (p.country === home && (!q.allowHome || homeCitySet.has(code) || code === doorCity)) return false;
    return countryAllowed(p.country, exclude) && !avoid.countries.has(p.country) && !avoid.cities.has(code) && !unsafe(p.country);
  };

  // The must places: a bit each; a city counts when it is the place or lies within MUST_KM of it.
  const musts = (q.must ?? []).slice(0, MAX_MUST);
  const fullMask = (1 << musts.length) - 1;
  const mustMemo = new Map<string, number>();
  const mustBits = (city: string): number => {
    if (!musts.length) return 0;
    let b = mustMemo.get(city);
    if (b == null) {
      b = 0;
      const p = placeOf(city);
      musts.forEach((m, i) => {
        if (
          (m.code && (m.code === city || airportCity(m.code) === city)) ||
          (m.country && p?.country === m.country) ||
          (p && m.lat != null && m.lon != null && haversineKm(p.lat, p.lon, m.lat, m.lon) <= (m.km ?? MUST_KM))
        )
          b! |= 1 << i;
      });
      mustMemo.set(city, b);
    }
    return b;
  };
  const missing = (mm: number) => {
    let n = 0;
    for (let x = fullMask & ~mm; x; x &= x - 1) n++;
    return n;
  };
  /** Room left for the musts not met yet: a label with fewer places to go than musts missing can never finish. */
  const roomFor = (places: number, mm: number) => maxPlaces - places >= missing(mm);

  const labels: Label[] = [];
  const heap = new Heap();
  /** Per node, the labels kept: their sequence of cities, cost and index. A label pushed out is marked dead. */
  const kept = new Map<string, { seq: string; cost: number; id: number }[]>();
  const dead = new Set<number>();
  let truncated = false;
  const push = (l: Label) => {
    if (labels.length >= MAX_LABELS) {
      truncated = true;
      return;
    }
    // A city with no way home known can never close a trip: no label is made for it.
    if (hOf(l.city) === Infinity) return;
    const key = `${l.kind}|${l.city}|${l.day}|${l.places}|${l.start}|${l.mm ?? 0}`;
    const seq = l.visited.join(">");
    const slots = kept.get(key) ?? [];
    // The same cities in the same order: the futures are the same, so only the cheaper label matters.
    const same = slots.findIndex((x) => x.seq === seq);
    if (same >= 0) {
      if (slots[same].cost <= l.cost) return;
      dead.add(slots[same].id);
      slots.splice(same, 1);
    } else if (slots.length >= PER_NODE && slots[slots.length - 1].cost <= l.cost) return;
    labels.push(l);
    const id = labels.length - 1;
    slots.push({ seq, cost: l.cost, id });
    slots.sort((a, b) => a.cost - b.cost);
    if (slots.length > PER_NODE) dead.add(slots.pop()!.id);
    kept.set(key, slots);
    heap.push(l.cost + hOf(l.city) + TIE * l.minutes, id);
  };
  const costOf = (euros: number, minutes: number) => euros + rate * minutes;

  // The way out: the door to a home airport (one label per airport and day, never expanded itself), then any
  // flight out of the home country in the window.
  const doorLabels = new Map<string, number>();
  const doorLabel = (h: HomeAirport, d: number): number => {
    const key = `${h.code}|${d}`;
    let id = doorLabels.get(key);
    if (id == null) {
      labels.push({ kind: 1, city: "HOME", day: d, places: 0, start: d, cost: costOf(h.price, h.minutes), euros: h.price, minutes: h.minutes, visited: [], parent: -1, leg: doorLeg(h, q.origin.label, true, d) });
      id = labels.length - 1;
      doorLabels.set(key, id);
    }
    return id;
  };
  for (const city of homeCities) {
    for (let d = fromN; d <= toN - minNights && (incN == null || d <= incN); d++) {
      for (const i of g.byFromDay.get(`${city}|${d}`) ?? []) {
        const e = g.edges[i];
        const h = homeEndOf(e.f, e.mode, homeByCode, homeCitySet, q.origin);
        if (!h || !landable(e.tc, []) || e.an + lo > toN) continue;
        const euros = h.price + e.p;
        const minutes = h.minutes + e.m;
        const mm = mustBits(e.tc);
        if (!roomFor(1, mm)) continue;
        push({ kind: 0, city: e.tc, day: e.an, places: 1, start: d, cost: costOf(euros, minutes) + stopPen(e.s), euros, minutes, visited: [e.tc], parent: doorLabel(h, d), fe: i, pen: stopPen(e.s), mm });
      }
    }
  }

  type Done = { cost: number; minutes: number; label: number; close: GraphLeg[]; euros: number; endDay: number };
  const done: Done[] = [];
  const doneSeqs = new Map<string, number>();
  let worstTop = Infinity;
  const finish = (li: number, close: GraphLeg[], endDay: number) => {
    const l = labels[li];
    if (l.places < minPlaces || (l.mm ?? 0) !== fullMask) return;
    if (incN != null && endDay < incN) return;
    const euros = l.euros + close.reduce((a, x) => a + x.price, 0);
    const minutes = l.minutes + close.reduce((a, x) => a + x.minutes, 0);
    const cost = costOf(euros, minutes) + (l.pen ?? 0) + close.reduce((a, x) => a + (x.kind === "fly" ? stopPen(x.stops) : 0), 0);
    const seq = l.visited.join(">");
    const prev = doneSeqs.get(seq);
    if (prev != null && done[prev].cost + TIE * done[prev].minutes <= cost + TIE * minutes) return;
    const item = { cost, minutes, label: li, close, euros, endDay };
    if (prev != null) done[prev] = item;
    else {
      doneSeqs.set(seq, done.length);
      done.push(item);
    }
    if (done.length >= top) worstTop = done.map((x) => x.cost).sort((a, b) => a - b)[top - 1];
  };

  let explored = 0;
  while (heap.size) {
    const li = heap.pop();
    if (dead.has(li)) continue;
    const l = labels[li];
    // Every completion from here costs at least this label plus its cheapest way home: past the top-th best, nothing better is left.
    if (l.cost + hOf(l.city) > worstTop) break;
    if (explored >= MAX_EXPLORED || ((explored & 1023) === 0 && Date.now() - tSearch > MAX_SEARCH_MS)) {
      truncated = true;
      break;
    }
    explored++;
    if (l.kind === 0) {
      // A stay: lo to hi nights, free; on a short trip of several places one night more, at a small price in the cost.
      for (let n = lo; n <= hiSoft; n++) {
        const leave = l.day + n;
        if (leave > toN || leave - l.start > maxNights) break;
        const over = n > hi ? (n - hi) * NIGHT_OVER_EURO[q.tradeoff ?? "price"] : 0;
        push({ ...l, kind: 1, day: leave, parent: li, fe: undefined, gl: undefined, leg: undefined, nights: n, ...(over ? { cost: l.cost + over, pen: (l.pen ?? 0) + over } : {}) });
      }
      continue;
    }
    const nights = l.day - l.start;
    // A train or coach home arrives the day it leaves; a flight home may land the next day, so its nights are
    // counted to the landing (the trip's reported end), never past maxNights.
    const canClose = nights >= minNights && nights <= maxNights;
    // Flights out of here today: home, or on to a new place.
    for (const i of g.byFromDay.get(`${l.city}|${l.day}`) ?? []) {
      const e = g.edges[i];
      if (e.mode && groundMax <= 0) continue;
      const h = homeEndOf(e.t, e.mode, homeByCode, homeCitySet, q.origin);
      if (h) {
        const flown = e.an - l.start;
        if (flown >= minNights && flown <= maxNights && e.an <= toN) finish(li, [flightLeg(e), doorLeg(h, q.origin.label, false, e.an)], e.an);
        continue;
      }
      // An overland link is a train, coach or ferry: off with them when the traveller wants flights only.
      if (e.mode && groundMax <= 0) continue;
      // Back through a city already stayed in, to go on from there (the way out of a dead end such as Aguas Calientes).
      if (e.mode && !l.tr && e.tc !== l.city && l.visited.includes(e.tc) && e.an <= toN && e.an - l.start <= maxNights) {
        const euros = l.euros + e.p;
        const minutes = l.minutes + e.m;
        push({ kind: 1, city: e.tc, day: e.an, places: l.places, start: l.start, cost: costOf(euros, minutes) + (l.pen ?? 0), euros, minutes, visited: l.visited, parent: li, fe: i, pen: l.pen, mm: l.mm, tr: true });
        continue;
      }
      if (l.places >= maxPlaces || !landable(e.tc, l.visited)) continue;
      if (e.an + lo > toN || e.an + lo - l.start > maxNights) continue;
      const mm = (l.mm ?? 0) | mustBits(e.tc);
      if (!roomFor(l.places + 1, mm)) continue;
      const euros = l.euros + e.p;
      const minutes = l.minutes + e.m;
      const pen = (l.pen ?? 0) + stopPen(e.s);
      push({ kind: 0, city: e.tc, day: e.an, places: l.places + 1, start: l.start, cost: costOf(euros, minutes) + pen, euros, minutes, visited: [...l.visited, e.tc], parent: li, fe: i, pen, mm });
    }
    if (groundMax <= 0) continue;
    // Trains and coaches the same day: home to the door (or to a home airport and on), or on to a new place.
    for (const link of groundOf(l.city)) {
      if (link.code === doorCity || homeCityDoor.has(link.code)) {
        if (!canClose) continue;
        const leg = groundLeg(l.city, link.code, l.day, link);
        const via = link.code === doorCity ? null : homeCityDoor.get(link.code)!;
        finish(li, via ? [leg, doorLeg(via, q.origin.label, false, l.day)] : [{ ...leg, to: "HOME", toName: q.origin.label }], l.day);
        continue;
      }
      if (!l.tr && link.code !== l.city && l.visited.includes(link.code)) {
        const euros = l.euros + groundPrice(link.km);
        const minutes = l.minutes + link.minutes;
        push({ kind: 1, city: link.code, day: l.day, places: l.places, start: l.start, cost: costOf(euros, minutes) + (l.pen ?? 0), euros, minutes, visited: l.visited, parent: li, gl: link, pen: l.pen, mm: l.mm, tr: true });
        continue;
      }
      if (l.places >= maxPlaces || !landable(link.code, l.visited)) continue;
      if (l.day + lo > toN || l.day + lo - l.start > maxNights) continue;
      const mm = (l.mm ?? 0) | mustBits(link.code);
      if (!roomFor(l.places + 1, mm)) continue;
      const euros = l.euros + groundPrice(link.km);
      const minutes = l.minutes + link.minutes;
      push({ kind: 0, city: link.code, day: l.day, places: l.places + 1, start: l.start, cost: costOf(euros, minutes) + (l.pen ?? 0), euros, minutes, visited: [...l.visited, link.code], parent: li, gl: link, pen: l.pen, mm });
    }
  }

  // The trips, rebuilt from their labels.
  const ranked = done.sort((a, b) => a.cost - b.cost || a.minutes - b.minutes).slice(0, top);
  const trips = ranked.map((d): GraphTrip => {
    const chain: Label[] = [];
    for (let i = d.label; i >= 0; i = labels[i].parent) chain.push(labels[i]);
    chain.reverse();
    const legs: GraphLeg[] = [];
    const stops: GraphStop[] = [];
    for (const l of chain) {
      const leg = l.leg ?? (l.fe != null ? flightLeg(g.edges[l.fe]) : l.gl ? groundLeg(labels[l.parent].city, l.city, l.day, l.gl) : undefined);
      if (leg && q.trace && l.fe != null) leg.alternatives = alternativesTo(g, l.fe);
      if (leg) legs.push(leg);
      if (l.kind === 0 && l.city !== "HOME") {
        const p = placeOf(l.city)!;
        stops.push({ code: l.city, name: p.name, country: p.country, lat: p.lat, lon: p.lon, arrive: dayIso(l.day), leave: dayIso(l.day), nights: 0 });
      }
      if (l.kind === 1 && l.nights != null && stops.length) {
        const s = stops[stops.length - 1];
        s.leave = dayIso(l.day);
        s.nights = l.nights;
      }
    }
    legs.push(...d.close);
    const flights = legs.filter((x) => x.kind === "fly" || x.source === "overland").reduce((a, x) => a + x.price, 0);
    const ground = legs.filter((x) => x.kind !== "fly" && x.source !== "overland").reduce((a, x) => a + x.price, 0);
    const overland = legs.filter((x) => x.source === "overland").length;
    const start = chain[0]?.start ?? fromN;
    const flown = legs.filter((x) => x.kind === "fly");
    const memory = flown.filter((x) => x.source === "memory").length;
    const tpLegs = flown.filter((x) => x.source === "tp").length;
    const oldest = flown.map((x) => x.seen ?? "").sort()[0];
    const why = [
      `${flights} euro in tickets (${flown.length} flight${flown.length === 1 ? "" : "s"}${overland ? `, ${overland} bus, train or ferry at a typical fare` : ""}), about ${ground} euro by land to and from them (estimated at 0.10 euro per km)`,
      `${stops.map((s) => `${s.name} ${s.nights}`).join(", ")} night${stops.length === 1 && stops[0]?.nights === 1 ? "" : "s"}`,
      `prices from the ${memory === flown.length ? "fare memory" : memory ? "nightly graph and the fare memory" : "nightly graph"}, the oldest seen ${seenAgo(oldest)}; confirm live before booking`,
      ...(tpLegs ? [`${tpLegs} of the flights ${tpLegs === 1 ? "is a recent Aviasales fare" : "are recent Aviasales fares"} (an estimate, not checked live)`] : []),
    ];
    return {
      legs,
      stops,
      total: flights + ground,
      flights,
      ground,
      hours: Math.round(legs.reduce((a, x) => a + x.minutes, 0) / 6) / 10,
      nights: d.endDay - start,
      start: dayIso(start),
      end: dayIso(d.endDay),
      why,
    };
  });
  return {
    trips,
    truncated: truncated || undefined,
    explored,
    boundMs,
    labels: labels.length,
    ...(groundSkipped ? { groundSkipped } : {}),
    edges: g.edges.length,
    graphDate: g.graphDate,
    homeAirports: homes,
    ms: Date.now() - t0,
    note: truncated
      ? `the search stopped at its limit (${explored} labels explored, ${labels.length} made, ${Date.now() - t0} ms): these are the cheapest it found, not proven the cheapest; a shorter window or fewer places answers exactly`
      : trips.length
        ? undefined
        : `no closed trip in the graph for ${q.from} to ${q.to}; the graph has ${g.edges.length} edges, ask live to fill the gaps`,
  };
}

// ---------------------------------------------------------------------------------------
// Everywhere on a date.

export type EverywhereQuery = {
  origin: { lat: number; lon: number; label: string };
  homeCountry: string;
  /** The day to leave (YYYY-MM-DD). */
  depart: string;
  /** Days either side of depart (and of back), 0 to 3. */
  flex?: number;
  /** The day to come home; with it every city also gets its cheapest way home. */
  back?: string;
  oneWay?: boolean;
  exclude?: string[];
  avoid?: string[];
  homeAirports?: string[];
};
export type EverywhereCity = {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** The flight there (and the door leg before it). */
  out: GraphLeg[];
  outPrice: number;
  /** The cheapest way home on the back days, maybe through a neighbour by land. */
  back?: GraphLeg[];
  backPrice?: number;
  total: number;
};
export type EverywhereCountry = { country: string; name: string; cheapest: number; cities: EverywhereCity[] };
export type EverywhereResult = { countries: EverywhereCountry[]; cities: number; withWayHome: number; edges: number; graphDate: string; homeAirports: HomeAirport[]; ms: number; note?: string };

/** A neighbour may be this far by land on the way home (4 h). */
const NEIGHBOUR_MIN = 240;

export async function everywhere(q: EverywhereQuery): Promise<EverywhereResult> {
  const g = await loadFlightGraph();
  return everywhereIn(g, q);
}

export function everywhereIn(g: FlightGraph, q: EverywhereQuery): EverywhereResult {
  const t0 = Date.now();
  const home = q.homeCountry.trim().toUpperCase();
  const flex = Math.max(0, Math.min(3, Math.round(q.flex ?? 0)));
  const dep = dayNum(q.depart);
  const back = q.back && !q.oneWay ? dayNum(q.back) : null;
  const exclude = (q.exclude ?? []).map((c) => c.trim().toUpperCase());
  const avoid = resolveAvoid(q.avoid);
  const homes = homeAirportsFor(q.origin, home, q.homeAirports);
  const result = (countries: EverywhereCountry[], note?: string): EverywhereResult => {
    const n = countries.reduce((a, c) => a + c.cities.length, 0);
    return { countries, cities: n, withWayHome: countries.reduce((a, c) => a + c.cities.filter((x) => x.back).length, 0), edges: g.edges.length, graphDate: g.graphDate, homeAirports: homes, ms: Date.now() - t0, note };
  };
  if (!Number.isFinite(dep)) return result([], "depart must be a real date");
  if (back != null && back < dep) return result([], "back is before depart");
  if (avoid.unknown.length) return result([], `unknown place to avoid: ${avoid.unknown.join(", ")}`);
  if (!homes.length) return result([], `no airport of ${home} within ${HOME_GROUND_MAX_MIN / 60} h of ${q.origin.label} by land`);
  const homeByCode = new Map(homes.map((h) => [h.code, h]));
  const homeCities = [...new Set(homes.map((h) => h.city))];
  const homeCitySet = new Set(homeCities);

  // The way out: per destination city and landing day, the cheapest flight from a home airport plus its door
  // leg. Kept per landing day, not per city, because with flex the way home must leave after the way out lands.
  type Way = { legs: GraphLeg[]; price: number; day: number };
  const outBy = new Map<string, Map<number, Way>>();
  for (const city of homeCities)
    for (let d = dep - flex; d <= dep + flex; d++)
      for (const i of g.byFromDay.get(`${city}|${d}`) ?? []) {
        const e = g.edges[i];
        const h = homeEndOf(e.f, e.mode, homeByCode, homeCitySet, q.origin);
        if (!h) continue;
        const p = placeOf(e.tc);
        if (!p || p.country === home || !countryAllowed(p.country, exclude) || avoid.countries.has(p.country) || avoid.cities.has(e.tc) || unsafe(p.country)) continue;
        const price = h.price + e.p;
        const byDay = outBy.get(e.tc) ?? outBy.set(e.tc, new Map()).get(e.tc)!;
        const cur = byDay.get(e.an);
        if (!cur || price < cur.price) byDay.set(e.an, { legs: [doorLeg(h, q.origin.label, true, d), flightLeg(e)], price, day: e.an });
      }

  // The way home: from a city on each back day, the cheapest flight to a home airport plus the door leg. `day` is
  // the day the traveller leaves the city (the flight's, or the train's before it).
  const homeFrom = (city: string): Way[] => {
    if (back == null) return [];
    const out: Way[] = [];
    for (let d = back - flex; d <= back + flex; d++) {
      let best: Way | null = null;
      for (const i of g.byFromDay.get(`${city}|${d}`) ?? []) {
        const e = g.edges[i];
        const h = homeEndOf(e.t, e.mode, homeByCode, homeCitySet, q.origin);
        if (!h) continue;
        const price = e.p + h.price;
        if (!best || price < best.price) best = { legs: [flightLeg(e), doorLeg(h, q.origin.label, false, e.an)], price, day: d };
      }
      if (best) out.push(best);
    }
    return out;
  };
  const direct = new Map<string, Way[]>();
  const directHome = (city: string) => {
    if (!direct.has(city)) direct.set(city, homeFrom(city));
    return direct.get(city)!;
  };
  /** The cheapest pair whose way home leaves at least a night after the way out lands, else null. */
  const pair = (outs: Map<number, Way>, homes: Way[]): { out: Way; way: Way } | null => {
    let best: { out: Way; way: Way } | null = null;
    for (const o of outs.values())
      for (const w of homes) if (w.day > o.day && (!best || o.price + w.price < best.out.price + best.way.price)) best = { out: o, way: w };
    return best;
  };
  // The cities with any flight home on the back days: the only neighbours worth timing by land.
  const homeBound = new Set<string>();
  if (back != null)
    for (let d = back - flex; d <= back + flex; d++)
      for (const [k, list] of g.byFromDay) {
        if (!k.endsWith(`|${d}`)) continue;
        if (list.some((i) => !!homeEndOf(g.edges[i].t, g.edges[i].mode, homeByCode, homeCitySet, q.origin))) homeBound.add(k.slice(0, k.indexOf("|")));
      }

  const cities: EverywhereCity[] = [];
  for (const [code, outs] of outBy) {
    const p = placeOf(code)!;
    let best = pair(outs, directHome(code));
    if (back != null && !best) {
      // Through a neighbour: a train or coach of up to four hours, on the day of that neighbour's flight home, to a
      // city with a flight home. Only timed when such a city is within 400 km in a straight line, so most cities
      // cost no ground search. The same rule holds: the train leaves at least a night after the way out lands.
      const near = [...homeBound].some((c) => {
        const o = placeOf(c);
        return o && haversineKm(p.lat, p.lon, o.lat, o.lon) <= 400;
      });
      const viaWays: Way[] = [];
      if (near)
        for (const link of groundFrom(code, NEIGHBOUR_MIN)) {
          if (!homeBound.has(link.code)) continue;
          for (const via of directHome(link.code)) {
            const leg = groundLeg(code, link.code, via.day, link);
            viaWays.push({ legs: [leg, ...via.legs], price: leg.price + via.price, day: via.day });
          }
        }
      best = pair(outs, viaWays);
    }
    // No way home that fits (or none asked for): the cheapest way out on its own.
    const out = best?.out ?? [...outs.values()].reduce((a, b) => (b.price < a.price ? b : a));
    const way = best?.way;
    cities.push({ code, name: p.name, country: p.country, lat: p.lat, lon: p.lon, out: out.legs, outPrice: out.price, back: way?.legs, backPrice: way?.price, total: out.price + (way?.price ?? 0) });
  }

  // Grouped by country, cheapest first. With a way back asked for, a city without one sorts after those with one.
  const rank = (c: EverywhereCity) => (back != null && !c.back ? 1e6 : 0) + c.total;
  const groups = new Map<string, EverywhereCity[]>();
  for (const c of cities.sort((a, b) => rank(a) - rank(b))) (groups.get(c.country) ?? groups.set(c.country, []).get(c.country)!).push(c);
  const countries = [...groups.entries()]
    .map(([cc, list]) => ({ country: cc, name: countryLabel(cc), cheapest: list[0].total, cities: list }))
    .sort((a, b) => rank(a.cities[0]) - rank(b.cities[0]));
  return result(countries, cities.length ? undefined : `nothing in the graph leaves ${homes.map((h) => h.code).join(", ")} around ${q.depart}`);
}
