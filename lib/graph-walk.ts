// Server-only. The graph walk: trips searched the way a person does with Skyscanner Explore.
// From home, one "anywhere" search gives the fifteen cheapest places to fly to; from each of
// those, another; trains and coaches from the ground graph add the hops no airline sells;
// a multi-airport search closes the loop back to a home airport. A best-first search over
// those lazy edges, with a beam per depth so the number of live Kiwi searches stays small
// (1 + beam x depth, plus one home search per state that can go home), ranks the loops it
// closes. See docs/plans/graph-walk.md for the design in the owner's words.
//
// Honesty: every flight price is a Kiwi itinerary (live, or seen in the fare memory in the
// last day) with its booking link; a board fare is half a return and is marked estimated;
// ground prices are estimates at 0.10 euro per km and are marked. The walk never spends more
// than its budget, stops at its deadline, and when Kiwi's breaker is open it finishes from
// what is known and says so in the note.
import airportsJson from "@/public/data/airports.json";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import fameJson from "@/public/data/fame.json";
import postgres from "postgres";
import { countryAllowed } from "./been";
import { countryLabel, hubDegree, resolveGateway } from "./board";
import { dealsFor } from "./deals-source";
import { driveMinutes, haversineKm } from "./geo";
import { reachFrom } from "./ground";
import { kiwiDate, kiwiStats, kiwiThrottled, searchFlight, THROTTLED_MESSAGE, type KiwiItinerary } from "./kiwi";
import { TtlLru } from "./memo";
import type { Airport, City, CountryInfo } from "./types";
import { findCityCode, resolveCountries, wishTilt } from "./wild";

// ---------------------------------------------------------------------------------------
// The contract (the route streams it, the chat and the globe consume it).

export type WalkParams = {
  origin: { lat: number; lon: number; label: string };
  /** Home airports (IATA), the way out and the way back. */
  gateways: string[];
  /** Home country (ISO2): never a stop. */
  home: string;
  /** The trip lies inside [from, to] (YYYY-MM-DD). */
  from: string;
  to: string;
  minNights: number;
  maxNights: number;
  /** Nights a stop takes (default 2); a range tries both bounds. */
  nightsPerStop?: number | [number, number];
  maxStops?: number;
  beam?: number;
  /** Live Kiwi searches the walk may spend in all; 0 answers from memory, boards and the ground graph alone. */
  budget?: number;
  deadlineMs?: number;
  /** Minutes a ground hop may take (default 5 h). */
  maxGroundMin?: number;
  tradeoff?: "price" | "balanced" | "comfort";
  /** "Been" countries (ISO2): never a stop; a connection through one is fine. */
  exclude?: string[];
  /** Cities (codes or names) every loop must pass through. */
  mustInclude?: string[];
  /** Country codes or city codes (or names) the traveller dislikes: never a stop. */
  avoid?: string[];
  /** Countries (ISO2 or names) to favour. */
  prefer?: string[];
  /** A region's countries (for Wild): stops keep to them from depth 2; depth 1 may land in a hub outside them. */
  allowedCountries?: string[];
  /** Free words ("street food, no big cities"): a tilt on the worth of a place. */
  style?: string;
  /** When it aborts (the client went away), no more live searches are spent and the walk answers from what it has. */
  signal?: AbortSignal;
  onEvent?: (e: WalkEvent) => void;
};

export type WalkLeg = { kind: "fly" | "train" | "coach" | "ferry" | "road"; from: string; fromName: string; to: string; toName: string; date: string; depart?: string; arrive?: string; minutes: number; price: number; estimated?: boolean; carrier?: string; url?: string; source: "live" | "memory" | "boards" | "ground" };
export type WalkStop = { code: string; name: string; country: string; lat: number; lon: number; arrive: string; leave: string; nights: number; worth: number; img?: string };
export type WalkLoop = { id: string; title: string; stops: WalkStop[]; legs: WalkLeg[]; /** The home airport the loop flies out of, else the one it flies back into, else HOME (ground both ways). */ home: string; start: string; end: string; nights: number; flights: number; ground: number; total: number; hours: number; score: number; why: string[] };
export type WalkEvent =
  | { type: "node"; code: string; name: string; lat: number; lon: number; date: string; depth: number; cost: number }
  | { type: "edge"; from: string; to: string; toName: string; lat: number; lon: number; kind: WalkLeg["kind"]; price: number; minutes: number; chosen?: boolean; source: WalkLeg["source"]; /** The way home: `to` is HOME, lat/lon the home airport (or the door for a ground way home). */ home?: boolean }
  | { type: "loop"; loop: WalkLoop }
  | { type: "progress"; text: string };
export type WalkResult = { loops: WalkLoop[]; searched: number; failed: number; fromMemory: number; expanded: number; considered: string[]; note?: string; partial?: boolean; generatedAt: string };

// ---------------------------------------------------------------------------------------
// Constants, in one place so the tradeoffs are easy to read.

type Tradeoff = NonNullable<WalkParams["tradeoff"]>;
/** Euros one hour of travel is worth, per tradeoff: way in, hops, way home (the table lib/wild.ts uses). */
const HOUR_VALUE: Record<Tradeoff, [number, number, number]> = { price: [5, 7, 7], balanced: [9, 11, 12], comfort: [18, 20, 24] };
/** What a kilometre of train or coach costs when no fare is known (lib/route-finder.ts uses the same). */
const EURO_PER_KM = 0.1;
/** Minutes at the airport around a flight, so a 50-minute flight is judged against a 3-hour train fairly. */
const FLIGHT_OVERHEAD_MIN = 90;
/** How much of a place's worth (0 to about 150) is taken off its price. */
const WORTH_WEIGHT = 0.5;
/** Remembered one-way destinations out of a stop at or past which its "anywhere" search is skipped: the size of a Kiwi
 * "anywhere" answer, so a handful of rows left by someone's pair search never stands in for the explore. Home always searches. */
const KNOWN_ENOUGH = 15;
/** Ground hops kept per state, the cheapest by edge cost (price, hours, minus worth), must cities always. */
const MAX_GROUND_EDGES = 8;
const MAX_LOOPS = 6;
const DEFAULT_BUDGET = 12;
const DEFAULT_BEAM = 3;
const DEFAULT_MAX_STOPS = 3;
/** 5.5 h: Warsaw to Gdansk, the owner's own example, is 310 minutes in the ground graph. */
const DEFAULT_GROUND_MIN = 330;
/** The run's own deadline, and how long one live search may hold it (Kiwi's retry ladder is longer). */
const DEFAULT_DEADLINE_MS = 90_000;
const SEARCH_CAP_MS = 35_000;
/** The fare memory counts for a day, like Kiwi's own memo. */
const MEMORY_AGE_DAYS = 1;
const DB_CAP_MS = 4_000;
/** A city this big is a hub: the way in may land in one outside the allowed countries (the hub trick). */
const HUB_DEGREE = 60;
/** The home node's code in events and legs. */
const HOME = "HOME";

const AIRPORTS = airportsJson as unknown as Airport[];
const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const airportByIata = new Map(AIRPORTS.map((a) => [a.iata, a]));
/** Where an airport is. resolveGateway answers the city centre for a code that is also a city code (GHV), so the airport file comes first. */
const pointOf = (code: string): { lat: number; lon: number } | null => {
  const a = airportByIata.get(code);
  if (a) return { lat: a.lat, lon: a.lon };
  const g = resolveGateway(code);
  return g ? { lat: g.lat, lon: g.lon } : null;
};
/** [Wikipedia views, Wikivoyage See listings, Wikivoyage Do listings] per city. */
const FAME = fameJson as unknown as Record<string, [number, number, number]>;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!cityOf.has(a)) cityOf.set(a, code);
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;

/** How much a place is worth a stop: Wikipedia views, Wikivoyage listings and hub size (the lines lib/wild.ts keeps private). */
function worth(code: string): number {
  const views = FAME[code]?.[0] ?? 0;
  const listings = Math.max(0, FAME[code]?.[1] ?? 0);
  const fame = views > 0 ? Math.min(90, 22 * Math.log10(Math.max(1, views / 8000))) : 0;
  return fame + Math.min(30, listings) + Math.min(30, hubDegree(code) / 4);
}

/** Grid over city centres for "which city is this station in" (as lib/trips.ts does it). */
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

type GroundLink = { code: string; minutes: number; mode: string };
/** Ground reaches across requests: a five-hour Dijkstra over 16,000 stations is ~40 ms, and the cheap cities repeat. */
const reachMemo = new TtlLru<GroundLink[]>(128, 30 * 60_000);
function groundFrom(lat: number, lon: number, maxMinutes: number, own: string | null): GroundLink[] {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}|${maxMinutes}`;
  const hit = reachMemo.get(key);
  if (hit) return hit;
  const links = new Map<string, GroundLink>();
  try {
    for (const s of reachFrom(lat, lon, maxMinutes, 20).reached) {
      const code = nearestCity(s.lat, s.lon);
      if (!code || code === own) continue;
      const prev = links.get(code);
      if (!prev || s.minutes < prev.minutes) links.set(code, { code, minutes: s.minutes, mode: s.mode });
    }
  } catch {
    // the graph is optional: no ground edges then
  }
  const out = [...links.values()].sort((a, b) => a.minutes - b.minutes);
  reachMemo.set(key, out);
  return out;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const dayOf = (t: string) => t.slice(0, 10);
const hhmm = (t: string) => t.slice(11, 16);
const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);
const groundPrice = (km: number) => Math.max(3, Math.round(km * EURO_PER_KM));
const r1 = (x: number) => Math.round(x * 10) / 10;
const kindOfMode = (mode: string): WalkLeg["kind"] => (mode === "rail" ? "train" : mode === "ferry" ? "ferry" : "coach");
const kindWord: Record<WalkLeg["kind"], string> = { fly: "fly", train: "train", coach: "coach", ferry: "ferry", road: "drive" };
const airportName = (code: string) => {
  const city = cityOf.get(code);
  return (city && CITIES[city]?.name) || resolveGateway(code)?.label || code;
};

// ---------------------------------------------------------------------------------------
// The fare memory. The shared table (lib/db.ts) has no "everything seen from X" reader, and
// the walk needs exactly that: every one-way fare anyone saw in the last day out of a city's
// airports in a two-day window, and the cheapest way home anyone saw from anywhere. Its own
// two-connection pool, like lib/insights.ts, reads only; without DATABASE_URL both answer null.

let sql: ReturnType<typeof postgres> | null = null;
function sslFor(url: string): "require" | false | undefined {
  if (/sslmode=/i.test(url)) return undefined;
  return /localhost|127\.0\.0\.1|@db:/i.test(url) ? false : "require";
}
function client() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!sql) sql = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: sslFor(url), onnotice: () => {} });
  return sql;
}
type MemFare = { src: string; dst: string; out: string; price: number; stops: number; hours: number; carriers: string[]; url: string };
type MemRow = { src: string; dst: string; out: string; price: string; stops: number; hours: string; carriers: string[]; url: string };
const fareOf = (r: MemRow): MemFare => ({ src: r.src, dst: r.dst, out: r.out, price: Number(r.price), stops: r.stops ?? 0, hours: Number(r.hours), carriers: r.carriers ?? [], url: r.url });

/** A database read capped at DB_CAP_MS: a slow pool must never hold a walk that has a deadline. */
async function capped<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DB_CAP_MS)))]);
  } catch (err) {
    console.log(`walk: memory ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The cheapest one-way fare seen in the last day per destination airport, out of any of `srcs` in [from, to]. Null without a database. */
async function memoryFrom(srcs: string[], from: string, to: string): Promise<MemFare[] | null> {
  const db = client();
  if (!db || !srcs.length) return null;
  return capped(
    db<MemRow[]>`
      select distinct on (dst) src, dst, to_char(out_date, 'YYYY-MM-DD') as out, price, stops, hours, carriers, url
      from fares
      where src = any(${srcs}) and back_date is null and out_date >= ${from} and out_date <= ${to}
        and seen_at > now() - (${MEMORY_AGE_DAYS} || ' days')::interval
      order by dst, price asc`.then((rows) => rows.map(fareOf)),
  );
}

/** Every way home seen in the last day: the cheapest one-way into any home airport per origin airport and departure day
 * in [from, to]. Per day, not per airport, because a state's home window is a day or two wide and the cheapest fare of
 * the whole month would shadow the one that fits. */
async function memoryHome(gateways: string[], from: string, to: string): Promise<MemFare[]> {
  const db = client();
  if (!db || !gateways.length) return [];
  const rows = await capped(
    db<MemRow[]>`
      select distinct on (src, out_date) src, dst, to_char(out_date, 'YYYY-MM-DD') as out, price, stops, hours, carriers, url
      from fares
      where dst = any(${gateways}) and back_date is null and out_date >= ${from} and out_date <= ${to}
        and seen_at > now() - (${MEMORY_AGE_DAYS} || ' days')::interval
      order by src, out_date, price asc`.then((rows) => rows.map(fareOf)),
  );
  return rows ?? [];
}

// ---------------------------------------------------------------------------------------
// The search.

/** One open state of the walk: where the traveller is, when, and everything so far. */
type State = {
  /** City code, or HOME for the origin. */
  city: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  /** The day the traveller arrived here (can leave from). */
  date: string;
  depth: number;
  cities: string[];
  countries: Set<string>;
  legs: WalkLeg[];
  stops: WalkStop[];
  money: number;
  hours: number;
  worth: number;
  /** Money plus hours at the tradeoff's rate minus the worth taken off: what the frontier is ordered by, with the heuristic. */
  cost: number;
  priority: number;
  /** The day the first leg left home; null at the origin. */
  start: string | null;
  /** The edge that led here, re-emitted as chosen when this state is expanded. */
  via?: Extract<WalkEvent, { type: "edge" }>;
};

type Edge = { to: string; leg: WalkLeg; arrive: string; img?: string };

export async function walkTrips(p: WalkParams): Promise<WalkResult> {
  const t0 = Date.now();
  const emit = p.onEvent ?? (() => {});
  const say = (text: string) => emit({ type: "progress", text });
  const at = () => new Date().toISOString();
  const considered: string[] = [];
  const fail = (note: string): WalkResult => ({ loops: [], searched: 0, failed: 0, fromMemory: 0, expanded: 0, considered, note, generatedAt: at() });

  // 1. The question, cleaned. A bad place is a plain note, never a throw.
  const gateways = [...new Set(p.gateways.map((g) => g.trim().toUpperCase()))].map((g) => ({ code: g, place: resolveGateway(g) })).filter((g) => g.place);
  if (!gateways.length) return fail(`unknown home airport ${p.gateways.join(", ") || "(none)"}; use three-letter codes such as OTP or GHV`);
  const gwCodes = gateways.map((g) => g.code);
  const home = p.home.trim().toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || !Number.isFinite(Date.parse(p.from)) || !Number.isFinite(Date.parse(p.to))) return fail("from and to must be real dates, YYYY-MM-DD");
  if (p.to < p.from) return fail("to is before from");
  const minNights = Math.max(1, Math.round(p.minNights));
  const maxNights = Math.max(minNights, Math.round(p.maxNights));
  if (daysBetween(p.from, p.to) < minNights) return fail(`the window ${p.from} to ${p.to} is shorter than ${minNights} nights`);
  const range: [number, number] = Array.isArray(p.nightsPerStop) ? [Math.max(1, Math.round(p.nightsPerStop[0])), Math.max(1, Math.round(p.nightsPerStop[1]))] : [Math.max(1, Math.round(p.nightsPerStop ?? 2)), Math.max(1, Math.round(p.nightsPerStop ?? 2))];
  const nMin = Math.min(range[0], range[1]);
  const nMax = Math.max(range[0], range[1]);
  if (nMin > maxNights) return fail(`${nMin} nights a stop do not fit in ${maxNights} nights`);
  const maxStops = Math.max(1, Math.min(6, Math.round(p.maxStops ?? DEFAULT_MAX_STOPS)));
  // A stop never swallows the rest of the trip: its nights are nMin..nMax (one day of slack when fixed, so a
  // search window is two days wide), so the stops together must be able to fill minNights, or nothing can close.
  const stopMax = nMax + (nMin === nMax ? 1 : 0);
  if (maxStops * stopMax < minNights) return fail(`${maxStops} stop${maxStops === 1 ? "" : "s"} of ${nMin === nMax ? nMin : `${nMin} to ${nMax}`} nights cannot fill ${minNights} nights; allow more stops or more nights a stop`);
  const beam = Math.max(1, Math.min(5, Math.round(p.beam ?? DEFAULT_BEAM)));
  const budget = Math.max(0, Math.round(p.budget ?? DEFAULT_BUDGET));
  const deadlineMs = Math.max(10_000, p.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxGroundMin = Math.max(30, Math.min(720, Math.round(p.maxGroundMin ?? DEFAULT_GROUND_MIN)));
  const tradeoff: Tradeoff = p.tradeoff ?? "balanced";
  const [hIn, hHop, hHome] = HOUR_VALUE[tradeoff];
  const stopsPenalty = (stops: number) => (tradeoff === "comfort" ? stops * 60 : tradeoff === "balanced" ? stops * 20 : 0);
  const exclude = (p.exclude ?? []).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  // Must cities: waypoints. Unknown names are the traveller's mistake, named.
  const must: string[] = [];
  for (const raw of p.mustInclude ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const code = findCityCode(s);
    if (!code) return fail(`unknown city to pass through: ${s.slice(0, 40)} (a city name such as Gdansk or a code such as GDN)`);
    if (!must.includes(code)) must.push(code);
  }
  if (must.length > maxStops) return fail(`${must.length} cities to pass through do not fit in ${maxStops} stops`);
  // Avoid: a country code, a city code, or a name of either.
  const avoidCountries = new Set<string>();
  const avoidCities = new Set<string>();
  for (const raw of p.avoid ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const up = s.toUpperCase();
    if (/^[A-Z]{2}$/.test(up) && COUNTRIES[up]) {
      avoidCountries.add(up);
      continue;
    }
    const city = findCityCode(s);
    if (city) {
      avoidCities.add(city);
      continue;
    }
    const cc = resolveCountries([s]).codes[0];
    if (cc) avoidCountries.add(cc);
    else return fail(`unknown place to avoid: ${s.slice(0, 40)} (a country such as DE or Germany, or a city such as Berlin)`);
  }
  const prefer = new Set(resolveCountries(p.prefer).codes);
  const allowed = p.allowedCountries?.length ? new Set(resolveCountries(p.allowedCountries).codes) : null;
  if (p.allowedCountries?.length && !allowed?.size) return fail(`none of those is a country we know: ${p.allowedCountries.join(", ")}`);
  const tilt = wishTilt(p.style);
  const isHub = (code: string) => hubDegree(code) >= HUB_DEGREE;
  /** The style's tilt on a place: hubs for "cities", smaller places for "experiences", listings for "food". The coast needs the weather file; left to Wild. */
  const styleScore = (code: string): number => {
    let v = 0;
    if (tilt.cities) v += tilt.cities * (isHub(code) ? 35 : -10);
    if (tilt.experiences) v += tilt.experiences * (isHub(code) ? -15 : 30);
    if (tilt.food) v += tilt.food * Math.min(20, Math.max(0, FAME[code]?.[1] ?? 0));
    return v;
  };

  // 2. Counters and the live gate.
  let searched = 0;
  let failed = 0;
  let fromMemory = 0;
  let expanded = 0;
  let skipped = 0;
  let refused = 0;
  let timedOut = 0;
  let aborted = 0;
  /** A search of this run tripped Kiwi's breaker: the answer is partial even when no later search was refused. */
  let throttled = false;
  let saidThrottled = false;
  const kiwiBefore = kiwiStats().today;
  const timeLeft = () => deadlineMs - (Date.now() - t0);
  const gone = () => p.signal?.aborted === true;
  const live = async (args: Parameters<typeof searchFlight>[0]): Promise<KiwiItinerary[] | null> => {
    if (gone()) {
      aborted++;
      return null;
    }
    if (searched + failed >= budget || timeLeft() <= 0) {
      skipped++;
      return null;
    }
    if (kiwiThrottled()) {
      refused++;
      if (!saidThrottled) {
        saidThrottled = true;
        say("Kiwi is throttling this address; finishing from what is known.");
      }
      return null;
    }
    const cap = Math.min(SEARCH_CAP_MS, Math.max(1000, timeLeft()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([searchFlight(args), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), cap)))]);
      searched++;
      return r.itineraries;
    } catch (err) {
      failed++;
      if (err instanceof Error && err.message === "timed out") timedOut++;
      if (err instanceof Error && err.message === THROTTLED_MESSAGE) {
        throttled = true;
        if (!saidThrottled) {
          saidThrottled = true;
          say("Kiwi is throttling this address; finishing from what is known.");
        }
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 3. What is known before any search: tonight's boards from the home airports (return fares,
  // so half of one is the one-way estimate) and the fare memory's ways home. Both feed the
  // heuristic (the cheapest known way home from a city) and the boards also give the first
  // hop candidates when no live search is allowed.
  const homeFrom = addDays(p.from, minNights);
  const [boardsAll, memHome] = await Promise.all([dealsFor(gwCodes).catch(() => null), memoryHome(gwCodes, homeFrom, p.to)]);
  // dealsFor falls back to the committed Romanian file when none of the home airports has a stored board; a deal
  // from another traveller's airport is no way out of this door, so only deals from the asked gateways count.
  const boards = (boardsAll?.deals ?? []).filter((d) => gwCodes.includes(d.gw));
  const boardGateways = [...new Set(boards.map((d) => d.gw))];
  const boardHalf = new Map<string, number>();
  for (const d of boards) {
    const city = CITIES[d.dstCity] ? d.dstCity : (cityOf.get(d.dst) ?? d.dstCity);
    const half = Math.round(d.price / 2);
    const prev = boardHalf.get(city);
    if (prev == null || half < prev) boardHalf.set(city, half);
  }
  /** Every remembered way home out of a city, so a state picks the cheapest that leaves inside its own home window. */
  const memHomeByCity = new Map<string, MemFare[]>();
  /** The cheapest of them per city, for the heuristic only. */
  const memHomeMin = new Map<string, number>();
  for (const f of memHome) {
    const city = cityOf.get(f.src) ?? f.src;
    (memHomeByCity.get(city) ?? memHomeByCity.set(city, []).get(city)!).push(f);
    const prev = memHomeMin.get(city);
    if (prev == null || f.price < prev) memHomeMin.set(city, f.price);
  }
  if (boards.length) considered.push(`boards: ${boards.length} return fares from ${boardGateways.join(", ")}, half of one is a one-way estimate`);
  else if (boardsAll?.deals.length) considered.push(`boards: none for ${gwCodes.join(", ")} (the stored boards are for other airports)`);
  considered.push(memHome.length ? `fare memory: ${memHome.length} ways home seen in the last day` : client() ? "fare memory: no way home seen in the last day" : "fare memory: off");
  const gwPlaces = gateways.map((g) => g.place!);
  /** An optimistic cost of the way home from a city: a known fare, else a cheap one-way by distance. */
  const heuristic = (code: string, lat: number, lon: number): number => {
    const mem = memHomeMin.get(code);
    if (mem != null) return mem;
    const half = boardHalf.get(code);
    if (half != null) return half;
    const km = Math.min(...gwPlaces.map((g) => haversineKm(lat, lon, g.lat, g.lon)));
    return 20 + 0.04 * km;
  };

  // 4. The rules for a stop. A city is never revisited, nor a country by air; a train or
  // coach may stay in the country it is in (Warsaw to Gdansk is how people see Poland),
  // never one left earlier. The home country is never a stop.
  const landable = (code: string, s: State, byGround = false): boolean => {
    const c = CITIES[code];
    if (!c) return false;
    if (s.cities.includes(code)) return false;
    if (s.countries.has(c.country) && !(byGround && c.country === s.country && s.city !== HOME)) return false;
    if (!countryAllowed(c.country, exclude) || avoidCountries.has(c.country) || avoidCities.has(code) || unsafe(c.country)) return false;
    // The hub trick: the way in may land in a hub outside the region's countries, deeper stops may not.
    if (allowed && !allowed.has(c.country) && !(s.depth === 0 && isHub(code))) return false;
    return true;
  };
  /** What a stop is worth, in euros taken off its edge: fame and listings, variety, the traveller's wishes. */
  const bonus = (code: string, s: State): number => {
    const c = CITIES[code];
    let v = worth(code);
    if (!s.countries.has(c.country)) v += 15;
    if (s.depth > 0 && isHub(s.city) && !isHub(code)) v += 25;
    if (prefer.has(c.country)) v += 40;
    if (must.includes(code)) v += 150;
    v += styleScore(code);
    return v * WORTH_WEIGHT;
  };
  const hoursOfFlight = (minutes: number) => (minutes + FLIGHT_OVERHEAD_MIN) / 60;

  // 5. The frontier: one list of open states per depth, ordered by priority (cost so far plus
  // the heuristic) when the depth is walked. The beam is the best few of each depth, after
  // every state of the depth before has been expanded, so a cheap deep branch never eats the
  // slots of a sibling that was not yet looked at.
  const levels: State[][] = [];
  /** A state that cannot still pass through every must city in the depth left can never close: it takes no beam slot. */
  const push = (s: State) => {
    if (must.filter((m) => !s.cities.includes(m)).length > maxStops - s.depth) return;
    (levels[s.depth] ??= []).push(s);
  };
  const loops: WalkLoop[] = [];
  const seenLoops = new Map<string, WalkLoop>();
  const origin: State = { city: HOME, name: p.origin.label, lat: p.origin.lat, lon: p.origin.lon, country: home, date: p.from, depth: 0, cities: [], countries: new Set([home]), legs: [], stops: [], money: 0, hours: 0, worth: 0, cost: 0, priority: 0, start: null };
  push(origin);
  say(`Walking from ${p.origin.label} (${gwCodes.join(", ")}), ${p.from} to ${p.to}, ${minNights} to ${maxNights} nights, ${nMin === nMax ? nMin : `${nMin} to ${nMax}`} a stop, up to ${maxStops} stops, beam ${beam}, budget ${budget}.`);

  /** The road between the traveller's door and a home airport, when it is a real drive. */
  const roadLeg = (airport: string, toAirport: boolean, date: string): WalkLeg | null => {
    const g = pointOf(airport);
    if (!g) return null;
    const km = haversineKm(p.origin.lat, p.origin.lon, g.lat, g.lon);
    if (km < 35) return null;
    const minutes = driveMinutes(km);
    const name = airportName(airport);
    return toAirport
      ? { kind: "road", from: HOME, fromName: p.origin.label, to: airport, toName: name, date, minutes, price: groundPrice(km), estimated: true, source: "ground" }
      : { kind: "road", from: airport, fromName: name, to: HOME, toName: p.origin.label, date, minutes, price: groundPrice(km), estimated: true, source: "ground" };
  };

  /** A fly leg from a Kiwi itinerary (live) or a remembered fare (memory: dates known, times not). */
  const flyFromItinerary = (from: string, it: KiwiItinerary, source: "live"): WalkLeg => ({
    kind: "fly",
    from: it.outbound.from,
    fromName: from === HOME ? airportName(it.outbound.from) : (CITIES[from]?.name ?? airportName(it.outbound.from)),
    to: it.outbound.to,
    toName: airportName(it.outbound.to),
    date: dayOf(it.outbound.departureTime),
    depart: hhmm(it.outbound.departureTime),
    arrive: hhmm(it.outbound.arrivalTime),
    minutes: Math.round(it.outbound.durationSeconds / 60),
    price: Math.round(it.price),
    carrier: [...new Set(it.outbound.segments.map((s) => s.carrierName || s.carrier))].join(", "),
    url: it.bookingUrl,
    source,
  });
  const flyFromMemory = (from: string, f: MemFare): WalkLeg => ({ kind: "fly", from: f.src, fromName: from === HOME ? airportName(f.src) : (CITIES[from]?.name ?? airportName(f.src)), to: f.dst, toName: airportName(f.dst), date: f.out, minutes: Math.round(f.hours * 60), price: Math.round(f.price), carrier: f.carriers.join(", ") || undefined, url: f.url, source: "memory" });
  const edgeEvent = (s: State, e: Edge): Extract<WalkEvent, { type: "edge" }> => {
    const c = CITIES[e.to];
    return { type: "edge", from: s.city, to: e.to, toName: c?.name ?? e.leg.toName, lat: c?.lat ?? 0, lon: c?.lon ?? 0, kind: e.leg.kind, price: e.leg.price, minutes: e.leg.minutes, source: e.leg.source };
  };

  /** The child state after an edge: stops copied, the parent stop's leave day set, the new stop opened. */
  const child = (s: State, e: Edge, hv: number, stopsOnTicket: number): State => {
    const c = CITIES[e.to];
    const legs = [...s.legs];
    if (s.city === HOME) {
      const road = roadLeg(e.leg.from, true, e.leg.date);
      if (road) legs.push(road);
    }
    legs.push(e.leg);
    const stops = s.stops.map((x) => ({ ...x }));
    const last = stops.at(-1);
    if (last) {
      last.leave = e.leg.date;
      last.nights = Math.max(1, daysBetween(last.arrive, last.leave));
    }
    stops.push({ code: e.to, name: c.name, country: c.country, lat: c.lat, lon: c.lon, arrive: e.arrive, leave: addDays(e.arrive, nMin), nights: nMin, worth: Math.round(worth(e.to)), img: e.img });
    const road = legs.length > s.legs.length + 1 ? legs[legs.length - 2] : null;
    const roadCost = road ? road.price + hv * (road.minutes / 60) : 0;
    const legHours = e.leg.kind === "fly" ? hoursOfFlight(e.leg.minutes) : e.leg.minutes / 60;
    const b = bonus(e.to, s);
    const money = s.money + e.leg.price + (road?.price ?? 0);
    const hours = s.hours + legHours + (road ? road.minutes / 60 : 0);
    const cost = s.cost + e.leg.price + hv * legHours + stopsPenalty(stopsOnTicket) + roadCost - b;
    const countries = new Set(s.countries);
    countries.add(c.country);
    return { city: e.to, name: c.name, lat: c.lat, lon: c.lon, country: c.country, date: e.arrive, depth: s.depth + 1, cities: [...s.cities, e.to], countries, legs, stops, money, hours, worth: s.worth + b, cost, priority: cost + heuristic(e.to, c.lat, c.lon), start: s.start ?? e.leg.date, via: edgeEvent(s, e) };
  };

  /** A loop closed by a home leg from state `s`: ranked, deduplicated by its city sequence, streamed. */
  const close = (s: State, leg: WalkLeg, stopsOnTicket: number) => {
    const legs = [...s.legs, leg];
    const road = roadLeg(leg.to, false, leg.date);
    if (road) legs.push(road);
    const stops = s.stops.map((x) => ({ ...x }));
    const last = stops.at(-1)!;
    last.leave = leg.date;
    last.nights = Math.max(1, daysBetween(last.arrive, last.leave));
    const start = s.start ?? leg.date;
    const nights = daysBetween(start, leg.date);
    const flights = legs.filter((l) => l.kind === "fly").reduce((a, l) => a + l.price, 0);
    const ground = legs.filter((l) => l.kind !== "fly").reduce((a, l) => a + l.price, 0);
    const total = flights + ground;
    const hours = r1(legs.reduce((a, l) => a + l.minutes, 0) / 60 + (legs.filter((l) => l.kind === "fly").length * FLIGHT_OVERHEAD_MIN) / 60);
    const legHours = (leg.kind === "fly" ? hoursOfFlight(leg.minutes) : leg.minutes / 60) + (road ? road.minutes / 60 : 0);
    const score = Math.round(s.cost + leg.price + (road?.price ?? 0) + hHome * legHours + stopsPenalty(stopsOnTicket));
    const why: string[] = [];
    // The way out is a home airport only when the first flight leaves from one; a coach from the door to a
    // first stop (Vienna to Bratislava) departs from no airport, and the loop says so instead.
    const firstFly = legs.find((l) => l.kind === "fly");
    const wayOut = firstFly && gwCodes.includes(firstFly.from) ? firstFly.from : null;
    if (wayOut) {
      const g = pointOf(wayOut);
      const a = airportByIata.get(wayOut);
      if (g) why.push(`${a?.name ?? firstFly!.fromName} is ${driveMinutes(haversineKm(p.origin.lat, p.origin.lon, g.lat, g.lon))} minutes from you`);
    }
    for (const l of legs) {
      if (l.kind === "road") continue;
      if (l === leg) why.push(l.kind === "fly" ? `home from ${l.fromName} to ${l.toName} for ${l.price} euro${l.source === "memory" ? " (seen in the last day)" : ""}` : `home by ${kindWord[l.kind]} from ${l.fromName} to ${l.toName}, ${r1(l.minutes / 60)} h, about ${l.price} euro (estimated)`);
      else if (l.kind === "fly") why.push(`fly ${l.fromName} to ${l.toName} for ${l.price} euro${l.source === "memory" ? " (seen in the last day)" : l.source === "boards" ? " (about half a return on tonight's board, estimated)" : ""}`);
      else why.push(`${kindWord[l.kind]} ${l.fromName} to ${l.toName} ${r1(l.minutes / 60)} h${l.from === HOME ? " as the way out" : " instead of a flight"}`);
    }
    const countries = new Set(stops.map((x) => x.country)).size;
    why.push(`${nights} nights, ${countries} countr${countries === 1 ? "y" : "ies"}, about ${hours} h of travel`);
    const homeAirport = wayOut ?? (leg.kind === "fly" ? leg.to : HOME);
    const loop: WalkLoop = { id: `${homeAirport}-${start}-${stops.map((x) => x.code).join("-")}`, title: stops.map((x) => x.name).join(" → "), stops, legs, home: homeAirport, start, end: leg.date, nights, flights, ground, total, hours, score, why };
    const key = stops.map((x) => x.code).join(">");
    const prev = seenLoops.get(key);
    if (prev && prev.score <= loop.score) return;
    if (prev) loops.splice(loops.indexOf(prev), 1);
    seenLoops.set(key, loop);
    loops.push(loop);
    loops.sort((a, b) => a.score - b.score);
    emit({ type: "loop", loop });
    say(`Loop: ${loop.title}, ${loop.total} euro, ${loop.nights} nights.`);
  };

  /** The score an open state would have to beat: the beam-th best closed loop. */
  const worstToBeat = () => (loops.length >= beam ? loops[beam - 1].score : null);
  /** The most a single further stop can take off a path (worth, variety, a preferred country, a must city, the style),
   * so the early stop below stays admissible: a child can be cheaper than its parent. */
  const maxBonus = WORTH_WEIGHT * (150 + 15 + 25 + (prefer.size ? 40 : 0) + (must.length ? 150 : 0) + Math.max(0, (tilt.cities ?? 0) * 35) + Math.max(0, (tilt.experiences ?? 0) * 30) + Math.max(0, (tilt.food ?? 0) * 20));
  /** The ground graph's reach from the traveller's door, read once: a stop inside it has a train or coach home. The
   * graph is time, which runs both ways near enough, so the reach from home stands for the way back to it. */
  let homeReachMemo: Map<string, GroundLink> | null = null;
  const homeReach = () => (homeReachMemo ??= new Map(groundFrom(p.origin.lat, p.origin.lon, maxGroundMin, null).map((g) => [g.code, g])));
  const homeEdge = (s: State, leg: WalkLeg): Extract<WalkEvent, { type: "edge" }> => {
    const g = leg.kind === "fly" ? pointOf(leg.to) : p.origin;
    return { type: "edge", from: s.city, to: HOME, toName: leg.toName, lat: g?.lat ?? 0, lon: g?.lon ?? 0, kind: leg.kind, price: leg.price, minutes: leg.minutes, source: leg.source, home: true };
  };

  // 6. The walk, depth by depth.
  walk: for (let depth = 0; depth <= maxStops; depth++) {
    const level = (levels[depth] ?? []).sort((a, b) => a.priority - b.priority);
    if (!level.length) break;
    const bar = worstToBeat();
    if (bar != null && level[0].priority - (maxStops - depth) * maxBonus >= bar) {
      considered.push(`stopped at depth ${depth}: ${loops.length} loops closed and no open state can beat a score of ${bar}`);
      break;
    }
    for (const s of level.slice(0, depth === 0 ? 1 : beam)) {
      if (timeLeft() <= 0 || gone()) {
        considered.push(gone() ? "stopped: the caller went away" : `stopped at the ${Math.round(deadlineMs / 1000)} s limit`);
        break walk;
      }
      expanded++;
      emit({ type: "node", code: s.city, name: s.name, lat: s.lat, lon: s.lon, date: s.date, depth: s.depth, cost: Math.round(s.cost) });
      if (s.via) emit({ ...s.via, chosen: true });
      const srcs = s.city === HOME ? gwCodes : CITIES[s.city].airports;
      const flyFrom = s.city === HOME ? gwCodes.join(",") : s.city;

      // 6a. Home: when this stop has had its nights (and not more than asked), the trip is inside
      // the asked range, and every must city is behind us. The last stop never swallows the rest
      // of the trip: a loop that needs more nights goes one stop deeper instead.
      if (s.depth > 0 && s.start && must.every((m) => s.cities.includes(m))) {
        const earliest = maxDay(addDays(s.date, nMin), addDays(s.start, minNights));
        const latest = minDay(addDays(s.date, stopMax), minDay(addDays(s.start, maxNights), p.to));
        if (earliest <= latest) {
          // The fare memory: the cheapest remembered way home that leaves inside this state's own window.
          const mem = (memHomeByCity.get(s.city) ?? [])
            .filter((f) => f.out >= earliest && f.out <= latest)
            .sort((x, y) => x.price + hHome * hoursOfFlight(x.hours * 60) + stopsPenalty(x.stops) - (y.price + hHome * hoursOfFlight(y.hours * 60) + stopsPenalty(y.stops)))[0];
          if (mem) {
            fromMemory++;
            const leg = flyFromMemory(s.city, mem);
            emit(homeEdge(s, leg));
            close(s, leg, mem.stops);
          } else {
            const its = await live({ flyFrom: s.city, flyTo: gwCodes.join(","), departureDate: kiwiDate(earliest), departureDateTo: kiwiDate(latest) });
            considered.push(`${s.name} home to ${gwCodes.join(",")} ${earliest}..${latest}: ${its ? `${its.length} fares` : "not searched"}`);
            const best = (its ?? [])
              .filter((it) => gwCodes.includes(it.outbound.to) || gwCodes.includes(cityOf.get(it.outbound.to) ?? ""))
              .sort((a, b) => a.price + hHome * hoursOfFlight(a.outbound.durationSeconds / 60) + stopsPenalty(a.outbound.stops) - (b.price + hHome * hoursOfFlight(b.outbound.durationSeconds / 60) + stopsPenalty(b.outbound.stops)))[0];
            if (best) {
              const leg = flyFromItinerary(s.city, best, "live");
              emit(homeEdge(s, leg));
              close(s, leg, best.outbound.stops);
            }
          }
          // The ground way home, alongside the flight: a train or coach to the door when the graph reaches
          // this city from it (Ruse, Chisinau or Budapest for a Brasov home), estimated like every ground leg.
          const link = homeReach().get(s.city);
          if (link) {
            const leg: WalkLeg = { kind: kindOfMode(link.mode), from: s.city, fromName: s.name, to: HOME, toName: p.origin.label, date: earliest, minutes: link.minutes, price: groundPrice(haversineKm(s.lat, s.lon, p.origin.lat, p.origin.lon)), estimated: true, source: "ground" };
            emit(homeEdge(s, leg));
            close(s, leg, 0);
          }
        }
      }
      if (s.depth >= maxStops) continue;

      // 6b. The hop window out of here: from home, any day that still leaves minNights inside the
      // window (the "anywhere" search covers the whole range, as Explore does); from a stop, the
      // stop's nights, and early enough that the next stop still gets its nights and the way home
      // still falls inside the window.
      const a = s.city === HOME ? p.from : addDays(s.date, nMin);
      const latestArrival = s.city === HOME ? addDays(p.to, -minNights) : addDays(minDay(addDays(s.start!, maxNights), p.to), -nMin);
      const b = s.city === HOME ? latestArrival : minDay(addDays(s.date, stopMax), latestArrival);
      if (a > b) continue;
      const hv = s.city === HOME ? hIn : hHop;
      const edges = new Map<string, { edge: Edge; cost: number; stops: number }>();
      const offer = (e: Edge, stopsOnTicket: number) => {
        const legHours = e.leg.kind === "fly" ? hoursOfFlight(e.leg.minutes) : e.leg.minutes / 60;
        const cost = e.leg.price + hv * legHours + stopsPenalty(stopsOnTicket) - bonus(e.to, s);
        const prev = edges.get(e.to);
        if (!prev || cost < prev.cost) edges.set(e.to, { edge: e, cost, stops: stopsOnTicket });
      };

      // Flights: the memory first, then the live "anywhere" search merged on top (the cheaper fare per city wins).
      // From home the explore is always asked, it is the one question the walk is built on and a single search;
      // from a stop it is skipped only when the memory already holds an "anywhere"-sized answer, because what the
      // memory holds is whatever other features searched (a pair, a country), not the cheapest places overall.
      const mem = await memoryFrom(srcs, a, b);
      let known = 0;
      for (const f of mem ?? []) {
        const to = cityOf.get(f.dst);
        if (!to || !landable(to, s)) continue;
        known++;
        offer({ to, leg: flyFromMemory(s.city, f), arrive: f.out }, f.stops);
      }
      if (s.city !== HOME && known >= KNOWN_ENOUGH) {
        fromMemory++;
        considered.push(`${s.name} to anywhere ${a}..${b}: ${known} fares from memory, no live search`);
      } else {
        const its = await live({ flyFrom, flyTo: "anywhere", departureDate: kiwiDate(a), departureDateTo: kiwiDate(b) });
        let used = 0;
        for (const it of its ?? []) {
          const to = cityOf.get(it.outbound.to);
          if (!to || !landable(to, s)) continue;
          used++;
          offer({ to, leg: flyFromItinerary(s.city, it, "live"), arrive: dayOf(it.outbound.arrivalTime), img: it.imageId }, it.outbound.stops);
        }
        // The boards are the last resort for the first hop: half a return fare is an estimate,
        // offered only when neither the memory nor a live search gave real one-way fares.
        let fromBoards = 0;
        if (s.city === HOME && !its && !known) {
          for (const d of boards) {
            const to = CITIES[d.dstCity] ? d.dstCity : (cityOf.get(d.dst) ?? "");
            if (!to || d.out < a || d.out > b || edges.has(to) || !landable(to, s)) continue;
            fromBoards++;
            offer({ to, leg: { kind: "fly", from: d.gw, fromName: airportName(d.gw), to: d.dst, toName: airportName(d.dst), date: d.out, minutes: d.outMin, price: Math.round(d.price / 2), estimated: true, carrier: d.carriers.join(", ") || undefined, url: d.url, source: "boards" }, arrive: d.out, img: d.img }, d.stops);
          }
        }
        considered.push(`${s.name} to anywhere ${a}..${b}: ${its ? `${its.length} fares, ${used} usable` : known ? `not searched, ${known} from memory` : "not searched"}${fromBoards ? `, ${fromBoards} from the boards (half a return, estimated)` : ""}`);
      }

      // Ground: the graph's reach, cities only (a hop may stay in the country), leaving on the stop's last day.
      // Ranked by edge cost, not minutes, so a four-hour train to a city worth seeing (Warsaw to Gdansk) is
      // kept ahead of a quick coach to a town nobody asked for; a must city is kept whatever its rank.
      const links = groundFrom(s.lat, s.lon, maxGroundMin, s.city === HOME ? null : s.city)
        .filter((g) => landable(g.code, s, true))
        .map((g) => {
          const c = CITIES[g.code];
          const leg: WalkLeg = { kind: kindOfMode(g.mode), from: s.city, fromName: s.name, to: g.code, toName: c.name, date: a, minutes: g.minutes, price: groundPrice(haversineKm(s.lat, s.lon, c.lat, c.lon)), estimated: true, source: "ground" };
          return { edge: { to: g.code, leg, arrive: a } as Edge, cost: leg.price + hv * (g.minutes / 60) - bonus(g.code, s), must: must.includes(g.code) };
        })
        .sort((x, y) => x.cost - y.cost);
      let groundUsed = 0;
      for (const g of links) {
        if (groundUsed >= MAX_GROUND_EDGES && !g.must) continue;
        offer(g.edge, 0);
        groundUsed++;
      }
      if (groundUsed) considered.push(`${s.name} by ground within ${Math.round(maxGroundMin / 60)} h: ${groundUsed} of ${links.length} cities`);

      // Every edge is streamed (the fan-out), every child joins the next depth; the beam decides there.
      for (const { edge, stops } of edges.values()) {
        emit(edgeEvent(s, edge));
        push(child(s, edge, hv, stops));
      }
    }
  }

  // 7. The answer.
  const kiwiCalls = kiwiStats().today - kiwiBefore;
  if (searched) considered.push(`${searched} search${searched === 1 ? "" : "es"} through the gate, ${kiwiCalls} reached Kiwi (the rest hit its memo)`);
  if (skipped) considered.push(timeLeft() <= 0 ? `${skipped} search${skipped > 1 ? "es" : ""} not made: the run reached its ${Math.round(deadlineMs / 1000)} s limit` : `${skipped} search${skipped > 1 ? "es" : ""} skipped at the budget of ${budget}`);
  if (refused) considered.push(`${refused} search${refused > 1 ? "es" : ""} not made while Kiwi throttles this address`);
  if (timedOut) considered.push(`${timedOut} search${timedOut > 1 ? "es" : ""} took longer than ${SEARCH_CAP_MS / 1000} s and ${timedOut > 1 ? "were" : "was"} not waited for`);
  if (aborted) considered.push(`${aborted} search${aborted > 1 ? "es" : ""} not made: the caller went away`);
  const late = timeLeft() <= 0 && skipped > 0;
  // Partial: the breaker refused a search, or one of this run's own searches tripped it (a 429 with nothing
  // refused afterwards is the same hole), or the deadline cut the run, or the caller left.
  const partial = refused > 0 || throttled || late || aborted > 0;
  let note: string | undefined;
  if (refused > 0 || throttled) note = `Kiwi is throttling live searches from this address; ${loops.length ? "the loops shown come from what is known (the fare memory, the boards, the ground graph)" : "nothing is known for these dates yet"}. Try again in a few minutes.`;
  else if (!loops.length && budget === 0) note = "No loop closes from the fare memory, the boards and the ground graph alone; allow a few live searches.";
  else if (!loops.length && failed > 0 && searched === 0) note = `${failed} live search${failed > 1 ? "es" : ""} failed and nothing is remembered for these dates.`;
  else if (!loops.length) note = `No loop closed inside ${p.from} to ${p.to} with ${minNights} to ${maxNights} nights; try a wider window, fewer nights a stop or a bigger budget.`;
  else if (late) note = `Kiwi was slow: ${loops.length} loop${loops.length === 1 ? "" : "s"} found before the run reached its time limit.`;
  const top = loops.slice(0, MAX_LOOPS);
  say(`Done: ${top.length} loop${top.length === 1 ? "" : "s"}, ${searched} live search${searched === 1 ? "" : "es"}${failed ? `, ${failed} failed` : ""}, ${expanded} states expanded.`);
  return { loops: top, searched, failed, fromMemory, expanded, considered, note, partial: partial || undefined, generatedAt: at() };
}
