// Server-only. One search behind the one search bar (docs/plans/one-search.md): a SearchQuery goes
// in, the right engines run, and everything they find comes out as TripResults (lib/trip-result.ts)
// in one list, cheapest first. The traveller never picks an engine.
//
// The order, every time:
//   1. the flight graph (lib/flight-graph.ts), when it has data: Dijkstra on euros over last
//      night's one-way edges and the fare memory, zero Kiwi searches, an answer in seconds;
//   2. the live engines, within a search budget (default 25, the query's `budget` changes it;
//      0 answers from the graph, the fare memory and the ground graph alone), chosen by the
//      spec's table:
//        to a place, dates or a window    route finder (A to B) + Kiwi's returns to that city
//        anywhere or a country, window    paired one-ways (lib/pairs.ts via findDeals), aimed at
//                                         the countries the graph found cheapest when it has data
//        two cities, a loop, > 7 nights   the graph walk, to confirm the graph's trips live
//        a region, 7+ nights (Wild)       the wild walk
//        Advanced: long stay / group      long stay / group
//        anytime, to a place or country   the price calendar (scan), six months
//      An engine whose usual cost does not fit what is left is skipped, except the one engine
//      that must answer when the graph had nothing (the note says so).
//   3. every result is placed on the map, badged (direct, events on, a train between cities),
//      checked against the Been list, de-duplicated (the same cities on the same days from two
//      engines: the cheaper stays), ranked money first (tickets plus the ground estimate; hours
//      only break ties unless the trip style weighs time) and cut to 60.
//
// Honesty: no price is made up here. Flight prices are the engines' (live, graph or memory,
// with `source` and `seen`), ground legs keep their estimate flag, `groundPrice` stays apart.
// The filter chips are applied to what is sent but are not part of the memo key, so changing a
// chip is a memo hit, not a new search. Answers are kept 30 minutes per query; one that a
// refused or failed search made partial is not kept. Two callers of the same query share one
// run, and the second is replayed what the first has seen so far, then follows it live; a run
// that every caller has left starts no live engine it has not started yet.
import airportsJson from "@/public/data/airports.json";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import { countryAllowed } from "./been";
import { countryLabel, resolveGateway } from "./board";
import { cheapestTripsIn, everywhereIn, homeAirportsFor, loadFlightGraph, type FlightGraph, type TripsQuery } from "./flight-graph";
import { findDeals, isCityTarget, REGION_COUNTRIES, regionCountries } from "./finder";
import { countryGroup, walkTrips, type WalkParams } from "./graph-walk";
import { groupTrip, GroupInputError } from "./group";
import { haversineKm } from "./geo";
import { BUDGET_MESSAGE, kiwiStats, kiwiThrottled, THROTTLED_MESSAGE } from "./kiwi";
import { longStay, LongStayInputError } from "./longstay";
import { TtlLru } from "./memo";
import { AVOID_GROUPS, cleanPrefs, type Prefs } from "./prefs";
import { eventsAt } from "./purpose-events";
import { cheapestWay, resolvePlace } from "./route-finder";
import { scanCheapest } from "./scan";
import {
  applyFilters,
  tripFromDeal,
  tripFromEverywhereCity,
  tripFromGraphTrip,
  tripFromGroupOption,
  tripFromLongStayBase,
  tripFromRouteOption,
  tripFromWalkLoop,
  tripFromWildTrip,
  HOME_CODE,
  type Locate,
  type SearchQuery,
  type TripResult,
} from "./trip-result";
import type { Airport, City, CountryInfo, Deal } from "./types";
import { findCityCode, REGIONS, resolveCountries, type Region } from "./wild";
import { wildByWalk } from "./wild-walk";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const AIRPORTS = airportsJson as unknown as Airport[];
const AIRPORT_BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));
const CITY_OF_AIRPORT = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!CITY_OF_AIRPORT.has(a)) CITY_OF_AIRPORT.set(a, code);

// ---------------------------------------------------------------------------------------
// Numbers in one place.

/** Live searches one search may spend when the query does not say. */
export const DEFAULT_BUDGET = 25;
export const MAX_BUDGET = 60;
/** Results sent at the most, after the filters. */
export const MAX_RESULTS = 60;
/** Results kept in the memo before the filters, so changing a chip still has enough to show. */
const POOL_MAX = 200;
const MEMO_TTL_MS = 30 * 60_000;
/** The nights asked for when the query does not say (the search bar's default). */
const DEFAULT_NIGHTS: [number, number] = [3, 7];
/** The widest window the flight graph is asked about at once (its route refuses more: CPU on a serverless instance). */
const GRAPH_WINDOW_DAYS = 35;
/** Places a graph trip may have at the most (the graph route's own cap). */
const GRAPH_MAX_PLACES = 5;
/** Euros an hour of travel is worth, per trade-off: nothing on price (hours only break ties), the graph's two rates otherwise. */
export const HOUR_EURO = { price: 0, balanced: 6, comfort: 18 } as const;
/** What the engines usually spend: used to decide what fits in the budget. */
const COST = { pairsAnywhere: 31, pairsCountry: 12, pairsListed: 16, returnsCity: 1, route: 12, walkMin: 6, wild: 30, scan: 6, longStay: 16, group: 20 } as const;
/** Trips the graph answers per run, each a different sequence of cities (its default is 10). */
const GRAPH_TOP = 20;
/** The whole search stops starting new work after this (the route runs for 300 s). */
const DEADLINE_MS = 200_000;

// ---------------------------------------------------------------------------------------
// The stream's lines.

export type SearchDone = { count: number; searched: number; engines: string[]; note?: string };
export type SearchLine = { progress: string } | { results: TripResult[] } | { graph: true } | { done: SearchDone };

type Answer = { pool: TripResult[]; done: SearchDone; graph: boolean };
const memo = new TtlLru<Answer>(200, MEMO_TTL_MS);
/** A run in flight: every line it has sent (for a caller who joins late) and who is listening now. */
type Run = { lines: SearchLine[]; subs: Set<(line: SearchLine) => void>; promise: Promise<Answer> };
const runs = new Map<string, Run>();

/** Thrown for a query the engines cannot run as asked (a date in the past, an unknown region): the route answers 400. */
export class SearchInputError extends Error {}

// ---------------------------------------------------------------------------------------
// Places.

const fold = (s: string) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Cities by folded name; a name can be several cities (Cordoba in Spain and in Argentina). */
const CITIES_BY_NAME = new Map<string, string[]>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = fold(c.name);
  CITIES_BY_NAME.set(k, [...(CITIES_BY_NAME.get(k) ?? []), code]);
}

/**
 * The city a place of To means: the code the search bar sent (a city or one of its airports)
 * first; then the name, and when several cities share it, the one nearest the traveller (a
 * traveller in Europe typing Cordoba means Spain); then the gazetteer's own reading.
 */
function cityFor(name: string, code: string | undefined, near: { lat: number; lon: number }): string | null {
  if (code) {
    if (CITIES[code]) return code;
    const c = CITY_OF_AIRPORT.get(code);
    if (c) return c;
  }
  const same = CITIES_BY_NAME.get(fold(name)) ?? [];
  if (same.length > 1) return [...same].sort((a, b) => haversineKm(near.lat, near.lon, CITIES[a].lat, CITIES[a].lon) - haversineKm(near.lat, near.lon, CITIES[b].lat, CITIES[b].lon))[0];
  return same[0] ?? findCityCode(name);
}

/** Regions cheap to live in, for a long stay with no destination; the one nearest the traveller is taken. */
const STAY_REGIONS: Region[] = ["balkans", "caucasus", "north-africa", "sea", "south-america"];
function nearestStayRegion(lat: number, lon: number): Region {
  const centre = (key: Region) => {
    const codes = new Set<string>(REGIONS[key].countries.map(([cc]) => cc));
    const pts = Object.values(CITIES).filter((c) => codes.has(c.country));
    return pts.length ? { lat: pts.reduce((a, c) => a + c.lat, 0) / pts.length, lon: pts.reduce((a, c) => a + c.lon, 0) / pts.length } : { lat: 0, lon: 0 };
  };
  return [...STAY_REGIONS].map((k) => ({ k, c: centre(k) })).sort((a, b) => haversineKm(lat, lon, a.c.lat, a.c.lon) - haversineKm(lat, lon, b.c.lat, b.c.lon))[0].k;
}

/** Where a code is: a city of the globe first, then an airport. */
export const locate: Locate = (code) => {
  if (!code || code === HOME_CODE) return null;
  const c = CITIES[code];
  if (c) return { name: c.name, country: c.country, lat: c.lat, lon: c.lon };
  const a = AIRPORT_BY_IATA.get(code);
  if (a) {
    const city = CITY_OF_AIRPORT.get(code);
    return { name: (city && CITIES[city]?.name) || a.city || a.name, country: a.country, lat: a.lat, lon: a.lon };
  }
  return null;
};

/** Every place of a result on the map and named: stops at 0,0 found by their code, legs given their ends' points. */
function placeTrip(t: TripResult, origin: SearchQuery["from"]): TripResult {
  for (const s of t.stops) {
    if (s.lat === 0 && s.lon === 0 && s.code) {
      const hit = locate(s.code);
      if (hit) {
        s.lat = hit.lat;
        s.lon = hit.lon;
        if (!s.country) s.country = hit.country;
      }
    }
    if (!s.country && s.code) s.country = locate(s.code)?.country ?? "";
  }
  for (const l of t.legs) {
    const end = (code: string, name: string): { name: string; lat?: number; lon?: number } => {
      if (code === HOME_CODE) return { name: name === "home" ? origin.label : name, lat: origin.lat, lon: origin.lon };
      const hit = locate(code);
      return { name: !name || name === code ? (hit?.name ?? name) : name, lat: hit?.lat, lon: hit?.lon };
    };
    const a = end(l.from, l.fromName);
    const b = end(l.to, l.toName);
    l.fromName = a.name;
    l.toName = b.name;
    // "drive Brasov to Brasov": the door and the airport of the same town. The airport end is named as one.
    if (l.kind !== "fly" && fold(a.name) === fold(b.name)) {
      if (AIRPORT_BY_IATA.has(l.to)) l.toName = `${b.name} airport (${l.to})`;
      else if (AIRPORT_BY_IATA.has(l.from)) l.fromName = `${a.name} airport (${l.from})`;
    }
    if (l.fromLat == null && a.lat != null) {
      l.fromLat = a.lat;
      l.fromLon = a.lon;
    }
    if (l.toLat == null && b.lat != null) {
      l.toLat = b.lat;
      l.toLon = b.lon;
    }
  }
  return t;
}

/**
 * The legs between the door and the airports for the trips whose engine leaves them out (a deal
 * knows its airports, not the traveller's door), timed and priced the way the flight graph does
 * it (homeAirportsFor: the ground graph or the road, 0.10 euro a km, estimated). Every result is
 * then door to door, so a Kiwi return from Otopeni and the route finder's same flight with the
 * train to Otopeni compare on the same terms.
 */
function withDoorLegs(t: TripResult, p: Plan): TripResult {
  if (t.kind === "group" || !t.legs.length) return t;
  const door = { lat: p.origin.lat, lon: p.origin.lon };
  const leg = (code: string, out: boolean, date?: string) => {
    const a = AIRPORT_BY_IATA.get(code);
    if (!a || a.country !== p.home) return null;
    const h = homeAirportsFor(door, p.home, [code])[0];
    if (!h || h.km < 2) return null;
    return { kind: "road" as const, from: out ? HOME_CODE : code, fromName: out ? p.origin.label : h.name, to: out ? code : HOME_CODE, toName: out ? h.name : p.origin.label, ...(date ? { date } : {}), minutes: h.minutes, price: h.price, estimated: true, note: `${out ? "to" : "from"} the airport by train, coach or road; time and fare estimated` };
  };
  const first = t.legs[0];
  const last = t.legs[t.legs.length - 1];
  const added: TripResult["legs"] = [];
  if (first.kind === "fly" && first.from !== HOME_CODE) {
    const l = leg(first.from, true, first.date);
    if (l) {
      t.legs.unshift(l);
      added.push(l);
    }
  }
  if (last.kind === "fly" && last.to !== HOME_CODE && t.back) {
    const l = leg(last.to, false, last.date);
    if (l) {
      t.legs.push(l);
      added.push(l);
    }
  }
  if (added.length) {
    const euros = added.reduce((a, l) => a + (l.price ?? 0), 0);
    const minutes = added.reduce((a, l) => a + (l.minutes ?? 0), 0);
    t.groundPrice = Math.round((t.groundPrice ?? 0) + euros) || undefined;
    if (!t.groundPrice) delete t.groundPrice;
    t.hours = Math.round(((t.hours ?? 0) + minutes / 60) * 10) / 10;
  }
  return t;
}

/** "Events on": the curated events within 60 km of a stop during the nights there. */
function badgeEvents(t: TripResult): TripResult {
  const names: string[] = [];
  for (const s of t.stops) {
    if (!s.arrive || !s.leave || (s.lat === 0 && s.lon === 0)) continue;
    for (const e of eventsAt({ lat: s.lat, lon: s.lon, km: 60 }, s.arrive, s.leave)) if (!names.includes(e.name)) names.push(`${e.name}`);
  }
  if (names.length) {
    if (!t.badges.includes("events on")) t.badges.push("events on");
    const line = `Events on: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
    if (!t.why.includes(line)) t.why.push(line);
  }
  return t;
}

/** The money a result costs for ranking: the tickets plus the ground estimate, plus hours at the trade-off's rate. */
export function moneyOf(t: TripResult, rate: number): number {
  // A long stay is ranked by what the engine ranks it by: the whole stay, all in.
  const raw = t.kind === "long-stay" ? (t.raw as { total?: number } | undefined)?.total : undefined;
  const base = typeof raw === "number" ? raw : t.price + (t.groundPrice ?? 0);
  return base + rate * (t.hours ?? 0);
}
export function rank(list: TripResult[], rate: number): TripResult[] {
  return [...list].sort((a, b) => moneyOf(a, rate) - moneyOf(b, rate) || (a.hours ?? 0) - (b.hours ?? 0) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------
// The query as the engines need it.

type Plan = {
  q: SearchQuery;
  prefs: Prefs;
  origin: { lat: number; lon: number; label: string };
  airports: string[];
  home: string;
  /** The window the whole trip lies in, and the must-include day. */
  from: string;
  to: string;
  include?: string;
  /** Exact dates, when the traveller gave them. */
  out?: string;
  back?: string;
  nights: [number, number];
  npp: [number, number];
  oneWay: boolean;
  shape: NonNullable<SearchQuery["shape"]>;
  budget: number;
  exclude: string[];
  /** The trip style's avoid list as country codes (groups expanded) and as the words the walk reads. */
  avoidCodes: string[];
  avoidWords: string[];
  groundMax: number;
  rate: number;
  /** The destination as the engines read it. */
  target:
    | { kind: "anywhere" }
    | { kind: "place"; name: string; city: string | null; country: string | null; lat?: number; lon?: number }
    | { kind: "country"; name: string; code: string }
    | { kind: "region"; key: string; label: string; countries: string[]; wild: boolean };
  notes: string[];
};

const DAY_MS = 86_400_000;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const todayIso = () => new Date().toISOString().slice(0, 10);
const maxDay = (a: string, b: string) => (a > b ? a : b);
const minDay = (a: string, b: string) => (a < b ? a : b);

/** ISO2 to the name Kiwi and the finder understand ("Italy", "Türkiye"). */
const countryName = (cc: string) => COUNTRIES[cc]?.name ?? countryLabel(cc);

function planOf(q: SearchQuery): Plan {
  const prefs = cleanPrefs(q.prefs ?? {});
  const notes: string[] = [];
  const today = todayIso();
  const tomorrow = addDays(today, 1);
  let nights: [number, number] = q.nights ?? DEFAULT_NIGHTS;
  let from: string;
  let to: string;
  let include: string | undefined;
  let out: string | undefined;
  let back: string | undefined;
  let oneWay = !!q.oneWay;
  const w = q.when;
  if (w.kind === "dates") {
    if (w.out < today) throw new SearchInputError("the day out is in the past");
    out = w.out;
    back = oneWay ? undefined : w.back;
    if (!back) oneWay = true;
    from = out;
    to = back ?? out;
    if (back) nights = [daysBetween(out, back), daysBetween(out, back)];
  } else if (w.kind === "window") {
    if (w.to < today) throw new SearchInputError("the window is in the past");
    from = maxDay(w.from, tomorrow);
    to = w.to;
    include = w.include && w.include >= from ? w.include : undefined;
    if (w.include && !include) notes.push(`the must-include day ${w.include} has passed, so it was dropped`);
    if (from !== w.from) notes.push(`the window starts tomorrow, ${from}, not in the past`);
  } else if (w.kind === "month") {
    const first = `${w.month}-01`;
    const last = addDays(addDays(first, 32).slice(0, 8) + "01", -1);
    if (last < today) throw new SearchInputError("that month is in the past");
    from = maxDay(first, tomorrow);
    to = last;
    // A trip in November may come home in early December: the nights may run past the month's end.
    // A one-way leaves in the month, so its window stays the month.
    if (!oneWay) to = addDays(to, Math.min(7, nights[1]));
  } else {
    from = addDays(today, 2);
    to = addDays(today, 180);
  }
  if (!oneWay && daysBetween(from, to) < nights[0]) {
    if (w.kind === "window") throw new SearchInputError(`the window from ${from} to ${to} is shorter than ${nights[0]} nights`);
  }

  // The destination.
  let target: Plan["target"] = { kind: "anywhere" };
  const t = q.to;
  if (t.kind === "place") {
    const city = cityFor(t.name, t.code, q.from);
    const place = city ? null : resolvePlace(t.name);
    const country = city ? CITIES[city].country : (place?.country ?? null);
    target = { kind: "place", name: city ? CITIES[city].name : (place?.label ?? t.name), city, country, ...(city ? { lat: CITIES[city].lat, lon: CITIES[city].lon } : place ? { lat: place.lat, lon: place.lon } : {}) };
  } else if (t.kind === "country") {
    const code = t.code ?? resolveCountries([t.name]).codes[0];
    if (!code) throw new SearchInputError(`${t.name} is not a country we know`);
    target = { kind: "country", name: countryName(code), code };
  } else if (t.kind === "region") {
    if (Object.hasOwn(REGIONS, t.key) && t.key !== "custom") {
      const r = REGIONS[t.key as Region];
      target = { kind: "region", key: t.key, label: r.label, countries: r.countries.map(([cc]) => cc), wild: true };
    } else {
      const list = regionCountries(t.key);
      if (!list) throw new SearchInputError(`${t.key} is not a region we know; one of ${[...new Set([...Object.keys(REGIONS).filter((k) => k !== "custom"), ...Object.keys(REGION_COUNTRIES)])].join(", ")}`);
      target = { kind: "region", key: t.key, label: t.key.replace(/\b\w/g, (c) => c.toUpperCase()), countries: resolveCountries(list).codes, wild: false };
    }
  }
  // Advanced: Wild loop. The drawer leaves To on Anywhere, so the loop's region is the destination;
  // a To that lies in the region narrows nothing, and one outside it is a contradiction to say out loud.
  const wild = q.advanced?.wild;
  if (wild) {
    if (!Object.hasOwn(REGIONS, wild.region) || wild.region === "custom") throw new SearchInputError(`${wild.region} is not a Wild region; one of ${Object.keys(REGIONS).filter((k) => k !== "custom").join(", ")}`);
    const r = REGIONS[wild.region as Region];
    const countries = r.countries.map(([cc]) => cc);
    const inside =
      target.kind === "anywhere" ||
      (target.kind === "region" && target.countries.some((cc) => countries.includes(cc))) ||
      (target.kind === "country" && countries.includes(target.code)) ||
      (target.kind === "place" && !!target.country && countries.includes(target.country));
    if (!inside) throw new SearchInputError(`To is ${target.kind === "region" ? target.label : target.kind === "anywhere" ? "Anywhere" : target.name}, but the Wild loop is set to ${r.label}; set To to Anywhere or to a place in ${r.label}`);
    target = { kind: "region", key: wild.region, label: r.label, countries, wild: true };
  }
  // Advanced: Long stay with To on Anywhere: the cheap-to-live region nearest the traveller, said in the note.
  if (q.advanced?.longStay && !q.advanced.group && target.kind === "anywhere") {
    const key = nearestStayRegion(q.from.lat, q.from.lon);
    const r = REGIONS[key];
    target = { kind: "region", key, label: r.label, countries: r.countries.map(([cc]) => cc), wild: true };
    notes.push(`To was Anywhere, so the long stay looked at ${r.label}, the cheap region to live in nearest you; pick a region or a country in To for another`);
  }
  const exclude = (q.exclude ?? []).map((c) => c.toUpperCase());
  const avoidCodes = [...new Set(prefs.avoid.flatMap((a) => AVOID_GROUPS[a]?.codes ?? countryGroup(a)?.codes ?? [a]))].filter((c) => /^[A-Z]{2}$/.test(c));
  const groundMax = prefs.groundOk ? 330 : 0;
  return {
    q,
    prefs,
    origin: { lat: q.from.lat, lon: q.from.lon, label: q.from.label },
    airports: q.from.airports.slice(0, 4),
    home: q.from.home,
    from,
    to,
    ...(include ? { include } : {}),
    ...(out ? { out } : {}),
    ...(back ? { back } : {}),
    nights,
    npp: prefs.nightsPerPlace,
    oneWay,
    shape: q.shape ?? "any",
    budget: Math.max(0, Math.min(MAX_BUDGET, Math.round(q.budget ?? DEFAULT_BUDGET))),
    exclude,
    avoidCodes,
    avoidWords: prefs.avoid,
    groundMax,
    rate: HOUR_EURO[prefs.tradeoff] ?? 0,
    target,
    notes,
  };
}

/**
 * The first thing that keeps a query from running as asked (a date in the past, an unknown
 * country or region, a window shorter than the nights), in plain words, or null. The route
 * answers 400 with it before the stream starts.
 */
export function checkSearch(q: SearchQuery): string | null {
  try {
    planOf(q);
  } catch (err) {
    if (err instanceof SearchInputError) return err.message;
    throw err;
  }
  return null;
}

/**
 * The trip shape asked for in Advanced, checked on every engine's results alike: one place for
 * a return, two for two cities, three or more for a loop. A long stay or a group meeting point
 * is its own shape and passes.
 */
function fitsShape(shape: Plan["shape"], r: TripResult): boolean {
  if (r.kind === "long-stay" || r.kind === "group") return true;
  const n = r.stops.length;
  if (shape === "return") return n === 1;
  if (shape === "two") return n === 2;
  if (shape === "loop") return n >= 3;
  return true;
}

/** The countries a result may stop in for this target; null for anywhere. */
function allowedCountries(p: Plan): string[] | null {
  const t = p.target;
  if (t.kind === "country") return [t.code];
  if (t.kind === "region") return t.countries;
  if (t.kind === "place") return t.country ? [t.country] : null;
  return null;
}

/** True when a result goes where the query asked and never sleeps where it must not. */
function fitsTarget(p: Plan, r: TripResult): boolean {
  const t = p.target;
  // Been: never a night in a country already seen (a group's meeting city is the group's own choice).
  if (r.kind !== "group" && r.stops.some((s) => s.country && !countryAllowed(s.country, p.exclude))) return false;
  // A getaway leaves the home country, unless the traveller named a place or the country itself.
  const named = (t.kind === "place" && t.country === p.home) || (t.kind === "country" && t.code === p.home);
  if (!named && r.kind !== "group" && r.stops.some((s) => s.country === p.home)) return false;
  if (t.kind === "anywhere") return true;
  if (t.kind === "place") {
    const want = fold(t.name);
    const near = (s: { lat: number; lon: number }) => t.lat != null && t.lon != null && !(s.lat === 0 && s.lon === 0) && haversineKm(s.lat, s.lon, t.lat, t.lon!) <= 60;
    return r.stops.some((s) => fold(s.name) === want || (!!t.city && s.code === t.city) || near(s));
  }
  const allowed = allowedCountries(p) ?? [];
  // A region or country trip has at least one stop there; for a country, every stop is.
  return t.kind === "country" ? r.stops.every((s) => allowed.includes(s.country)) : r.stops.some((s) => allowed.includes(s.country));
}

// ---------------------------------------------------------------------------------------
// The run.

/**
 * Runs one search and streams its lines. Identical searches in flight share one run: a caller who
 * joins late is replayed every line so far, then follows the run live. When `signal` aborts, this
 * caller stops listening and gets back at once; a run every caller has left starts no live engine
 * it has not started yet (and is not kept). A finished answer is kept 30 minutes. Throws
 * SearchInputError for a query that cannot run as asked.
 */
export async function runSearch(q: SearchQuery, emit: (line: SearchLine) => void, signal?: AbortSignal): Promise<SearchDone> {
  const plan = planOf(q);
  const key = memoKey(q);
  const been = q.exclude ?? [];
  const finishFrom = (a: Answer): SearchDone => {
    const shown = rank(applyFilters(a.pool, q.filters, been), plan.rate).slice(0, MAX_RESULTS);
    return { ...a.done, count: shown.length };
  };
  const hit = memo.get(key);
  if (hit) {
    if (hit.graph) emit({ graph: true });
    const shown = rank(applyFilters(hit.pool, q.filters, been), plan.rate).slice(0, MAX_RESULTS);
    if (shown.length) emit({ results: shown });
    return finishFrom(hit);
  }
  const left: SearchDone = { count: 0, searched: 0, engines: [], note: "the search was left" };
  if (signal?.aborted) return left;
  // This caller's view of the run: its own filter chips on every results line.
  const listen = (line: SearchLine) => {
    if ("results" in line) {
      const shown = applyFilters(line.results, q.filters, been);
      if (shown.length) emit({ results: shown });
    } else emit(line);
  };
  let run = runs.get(key);
  if (run) {
    for (const line of run.lines) listen(line);
    run.subs.add(listen);
  } else {
    const fresh: Run = { lines: [], subs: new Set([listen]), promise: Promise.resolve(null as unknown as Answer) };
    runs.set(key, fresh);
    fresh.promise = execute(
      plan,
      (line) => {
        fresh.lines.push(line);
        for (const sub of fresh.subs) sub(line);
      },
      () => fresh.subs.size === 0,
    ).finally(() => {
      if (runs.get(key) === fresh) runs.delete(key);
    });
    run = fresh;
  }
  const current = run;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => {
      current.subs.delete(listen);
      resolve(null);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const answer = await Promise.race([current.promise, aborted]);
    return answer ? finishFrom(answer) : left;
  } finally {
    current.subs.delete(listen);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The memo key: the query without its filter chips (applied after) and with the trip style cleaned. */
function memoKey(q: SearchQuery): string {
  const { filters: _f, prefs, ...rest } = q;
  void _f;
  return JSON.stringify({ v: 1, ...rest, prefs: cleanPrefs(prefs ?? {}) });
}

async function execute(p: Plan, emit: (line: SearchLine) => void, nobodyLeft: () => boolean): Promise<Answer> {
  const t0 = Date.now();
  const deadline = t0 + DEADLINE_MS;
  const say = (text: string) => emit({ progress: text });
  const engines: string[] = [];
  const notes = [...p.notes];
  const pool = new Map<string, TripResult>();
  let refused = false;
  let failed = false;
  let abandoned = false;
  const startCount = kiwiStats().today;
  const spent = () => Math.max(0, kiwiStats().today - startCount);

  /** Adds results: placed, badged, Been and target checked, the cheaper of two ids kept; new and improved ones go out. */
  const add = (list: TripResult[], quiet = false): TripResult[] => {
    const fresh: TripResult[] = [];
    for (const raw of list) {
      const r = badgeEvents(placeTrip(withDoorLegs(raw, p), p.q.from));
      if (!r.out || !fitsTarget(p, r) || !fitsShape(p.shape, r)) continue;
      // A one-way over a window leaves within it (the graph is asked a few days either side of each week).
      if (p.oneWay && !p.out && (r.out < p.from || r.out > p.to)) continue;
      if (r.legs.some((l) => l.kind === "fly" && p.prefs.maxFlightHours && (l.minutes ?? 0) > p.prefs.maxFlightHours * 60)) continue;
      const prev = pool.get(r.id);
      if (prev && moneyOf(prev, p.rate) <= moneyOf(r, p.rate)) continue;
      pool.set(r.id, r);
      fresh.push(r);
    }
    // Keep the pool bounded: the dearest go first.
    if (pool.size > POOL_MAX) for (const r of rank([...pool.values()], p.rate).slice(POOL_MAX)) pool.delete(r.id);
    if (fresh.length && !quiet) emit({ results: rank(fresh, p.rate) });
    return fresh;
  };
  const noteFrom = (engine: string, note: string | undefined) => {
    if (!note) return;
    if (note.includes(THROTTLED_MESSAGE) || note.includes(BUDGET_MESSAGE) || /rate-limited/i.test(note)) refused = true;
    notes.push(`${engine}: ${note}`);
  };
  const errorFrom = (engine: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(THROTTLED_MESSAGE) || msg.includes(BUDGET_MESSAGE)) refused = true;
    else failed = true;
    notes.push(`${engine}: ${msg.slice(0, 200)}`);
  };

  // 1. The flight graph.
  let graphCount = 0;
  let graphAnswered = false;
  const graphCountries: string[] = [];
  if (!p.q.advanced?.group && !p.q.advanced?.longStay) {
    say("Reading last night's flight graph");
    try {
      const g = await loadFlightGraph();
      if (!g.edges.length) notes.push("the flight graph is still filling tonight; live engines answered instead");
      else {
        // Added quietly, so the {graph: true} line goes out before the graph's results.
        const fresh = add(graphTrips(g, p, notes), true);
        graphCount = fresh.length;
        if (graphCount > 0) {
          graphAnswered = true;
          engines.push("graph");
          emit({ graph: true });
          emit({ results: rank(fresh, p.rate) });
          say(`The flight graph found ${graphCount} trip${graphCount === 1 ? "" : "s"} from last night's prices; checking live`);
          // The countries the graph found cheapest, for the paired search to confirm live.
          for (const r of rank([...pool.values()], p.rate)) for (const s of r.stops) if (s.country && !graphCountries.includes(s.country)) graphCountries.push(s.country);
        } else say("The flight graph has nothing that fits; searching live");
      }
    } catch (err) {
      notes.push(`the flight graph could not be read (${err instanceof Error ? err.message.slice(0, 80) : "error"}); live engines answered`);
    }
  }

  // 2. The live engines, within the budget.
  if (kiwiThrottled()) {
    refused = true;
    notes.push("live prices are rate-limited right now; showing what the graph and the fare memory know");
  }
  // Everyone who asked has gone (a new search replaced this one): no live search is spent on it.
  abandoned = nobodyLeft();
  if (abandoned) notes.push("the search was left before the live engines ran");
  const tasks = abandoned ? [] : liveTasks(p, { graphCount, graphCountries });
  let left = kiwiThrottled() ? 0 : p.budget;
  const chosen: { task: LiveTask; budget: number }[] = [];
  for (const task of tasks) {
    // An engine that only answers from memory at budget 0 (the walks, the route finder) still runs at 0.
    const need = task.min;
    if (need > left && !(task.mustRun && !graphAnswered && left > 0) && !task.free) {
      if (task.skipNote) notes.push(task.skipNote);
      continue;
    }
    if (need > left && task.mustRun && !graphAnswered && left > 0) notes.push(`${task.label} usually takes about ${task.est} live searches, more than the budget of ${p.budget}; it ran anyway because the flight graph had nothing for this search`);
    const give = task.free && left <= 0 ? 0 : Math.min(left, task.est);
    left -= give;
    chosen.push({ task, budget: give });
  }
  if (chosen.length) say(`Searching ${chosen.map((c) => c.task.label).join(", ")}${p.budget ? ` (up to ${p.budget} live searches)` : " (stored prices only)"}`);
  await Promise.all(
    chosen.map(async ({ task, budget }) => {
      engines.push(task.engine);
      try {
        await task.run(budget, { add, say, note: (n) => noteFrom(task.engine, n), deadline });
      } catch (err) {
        errorFrom(task.engine, err);
      }
    }),
  );

  const all = rank([...pool.values()], p.rate);
  const shownCount = all.length;
  if (!shownCount && !notes.length) notes.push("nothing fits this search; try a wider window, more nights or another place");
  const done: SearchDone = { count: Math.min(MAX_RESULTS, shownCount), searched: spent(), engines: [...new Set(engines)], ...(notes.length ? { note: notes.join("; ") } : {}) };
  const answer: Answer = { pool: all.slice(0, POOL_MAX), done, graph: graphAnswered };
  if (!refused && !failed && !abandoned) memo.set(memoKey(p.q), answer);
  say(`Done in ${Math.round((Date.now() - t0) / 1000)} s`);
  return answer;
}

// ---------------------------------------------------------------------------------------
// The flight graph's part.

/** The countries the graph must never stop in for this target: every country but the allowed ones (the graph has no "only" list). */
function avoidAllBut(allowed: string[] | null, avoid: string[]): string[] {
  if (!allowed) return avoid;
  const keep = new Set(allowed);
  return [...new Set([...avoid, ...Object.keys(COUNTRIES).filter((cc) => !keep.has(cc))])];
}

function graphTrips(g: FlightGraph, p: Plan, notes: string[]): TripResult[] {
  const out: TripResult[] = [];
  const origin = p.origin;
  const avoid = avoidAllBut(allowedCountries(p), p.avoidCodes);
  const convert = { origin: origin.label };
  // One way, or exact dates: everywhere on the day (each city with its cheapest way there and, with a day back, home).
  if (p.oneWay || (p.out && p.back)) {
    // The graph answers a day plus or minus three; a one-way over a window is asked once a week,
    // centred three days in, so the whole window is covered (or the must-include day alone).
    const asks: { depart: string; flex: number }[] = [];
    if (p.out) asks.push({ depart: p.out, flex: 0 });
    else if (p.include) asks.push({ depart: p.include, flex: 3 });
    else {
      const last = minDay(p.to, addDays(p.from, GRAPH_WINDOW_DAYS));
      if (last < p.to) notes.push(`the flight graph looked at the first ${GRAPH_WINDOW_DAYS} days of the window`);
      for (let d = addDays(p.from, 3); addDays(d, -3) <= last; d = addDays(d, 7)) asks.push({ depart: d, flex: 3 });
    }
    const found: TripResult[] = [];
    for (const a of asks) {
      const r = everywhereIn(g, { origin, homeCountry: p.home, ...a, ...(p.back ? { back: p.back } : {}), oneWay: p.oneWay, exclude: p.exclude, avoid });
      for (const c of r.countries) for (const city of c.cities) if (p.oneWay || city.back?.length) found.push(tripFromEverywhereCity(city, convert));
      if (r.note && !notes.includes(`graph: ${r.note}`)) notes.push(`graph: ${r.note}`);
    }
    // To anywhere, a country or a region, each city once at its cheapest day of the window, so the
    // list is many places, not one place on five days; to one place every day stays, as a calendar.
    if (asks.length > 1 && p.target.kind !== "place") {
      const best = new Map<string, TripResult>();
      for (const t of found) {
        const k = t.stops.map((x) => x.code ?? x.name).join("+");
        const prev = best.get(k);
        if (!prev || moneyOf(t, p.rate) < moneyOf(prev, p.rate)) best.set(k, t);
      }
      out.push(...best.values());
    } else out.push(...found);
    if (p.oneWay) return out;
  }
  // A window: the cheapest trips in it, the must-include day narrowing it first.
  let from = p.from;
  let to = p.to;
  const [lo, hi] = p.nights;
  if (p.include) {
    from = maxDay(from, addDays(p.include, -hi));
    to = minDay(to, addDays(p.include, hi));
  }
  const wild = wildNights(p);
  const minN = wild ? Math.max(1, wild - 1) : lo;
  const maxN = wild ? wild + 1 : hi;
  if (wild) to = minDay(addDays(from, 10 + maxN), addDays(from, GRAPH_WINDOW_DAYS));
  if (daysBetween(from, to) > GRAPH_WINDOW_DAYS) {
    to = addDays(from, GRAPH_WINDOW_DAYS);
    notes.push(`the flight graph looked at the first ${GRAPH_WINDOW_DAYS} days of the window`);
  }
  if (daysBetween(from, to) < minN) return out;
  const npp = p.npp;
  const fill = Math.max(1, Math.ceil(maxN / npp[0]));
  const places = (n: number) => Math.max(1, Math.min(wild ? 8 : GRAPH_MAX_PLACES, n));
  // Each run asks for its own number of places, so cheap returns never fill the slots of a
  // two-city or loop answer: [fewest, most].
  const runs: [number, number][] = [];
  if (p.shape === "return") runs.push([1, 1]);
  else if (p.shape === "two") runs.push([2, 2]);
  else if (p.shape === "loop" || p.shape === "long" || wild) runs.push([3, places(Math.max(3, fill))]);
  else {
    runs.push([1, 1]);
    if (places(fill) >= 2) runs.push([2, places(fill)]);
  }
  for (const [minPlaces, maxPlaces] of runs) {
    // A place takes npp nights; one place alone may take the whole trip (a return of five nights).
    const nightsPerPlace: [number, number] = maxPlaces === 1 ? [minN, maxN] : [npp[0], Math.max(npp[1], Math.ceil(minN / maxPlaces))];
    if (maxPlaces * nightsPerPlace[1] < minN) continue;
    const q: TripsQuery = { origin, homeCountry: p.home, from, to, minNights: minN, maxNights: maxN, nightsPerPlace, maxPlaces, minPlaces: Math.min(minPlaces, maxPlaces), top: GRAPH_TOP, tradeoff: p.prefs.tradeoff, exclude: p.exclude, avoid, groundMaxMin: p.groundMax };
    const r = cheapestTripsIn(g, q);
    if (r.note) notes.push(`graph: ${r.note}`);
    for (const t of r.trips) {
      if (p.include && !(t.start <= p.include && t.end >= p.include)) continue;
      if (p.shape === "two" && t.stops.length !== 2) continue;
      if ((p.shape === "loop" || p.shape === "long") && t.stops.length < 3) continue;
      out.push(tripFromGraphTrip(t, convert));
    }
  }
  return out;
}

/** The nights of a wild trip when the query is one (Advanced: Wild, or a far region for 7 nights or more). */
function wildNights(p: Plan): number | null {
  if (p.q.advanced?.wild) return p.q.advanced.wild.nights;
  if (p.target.kind === "region" && p.target.wild && p.nights[1] >= 7) return p.nights[1];
  return null;
}

// ---------------------------------------------------------------------------------------
// The live engines.

type TaskCtx = { add: (r: TripResult[]) => void; say: (s: string) => void; note: (n?: string) => void; deadline: number };
type LiveTask = {
  engine: string;
  label: string;
  /** What it usually spends, and the least it needs to be worth running. */
  est: number;
  min: number;
  /** Runs when the graph found nothing, even past the budget (it is the only way to an answer). */
  mustRun?: boolean;
  /** Answers something useful at a budget of 0 (the fare memory and the ground graph). */
  free?: boolean;
  skipNote?: string;
  run: (budget: number, ctx: TaskCtx) => Promise<void>;
};

function liveTasks(p: Plan, g: { graphCount: number; graphCountries: string[] }): LiveTask[] {
  const tasks: LiveTask[] = [];
  const t = p.target;
  const adv = p.q.advanced;
  const msLeft = (ctx: TaskCtx, cap: number) => Math.max(15_000, Math.min(cap, ctx.deadline - Date.now()));
  const seenNow = () => new Date().toISOString();

  if (adv?.group) {
    tasks.push({
      engine: "group",
      label: "the group's meeting places",
      est: COST.group,
      min: 4,
      mustRun: true,
      skipNote: `the group search prices each member live (about ${COST.group} searches), and this search's budget is ${p.budget}`,
      run: async (_budget, ctx) => {
        const where = t.kind === "place" ? t.name : t.kind === "country" ? t.name : t.kind === "region" ? t.countries.map(countryName).join(",") : undefined;
        try {
          const r = await groupTrip({ members: adv.group!.members, minNights: p.nights[0], maxNights: p.nights[1], ...(where ? { where } : {}), exclude: p.exclude, deadline: ctx.deadline - 20_000, onProgress: ctx.say });
          ctx.add(r.options.map((o) => tripFromGroupOption(o, { locate, seen: r.generatedAt })));
          ctx.note(r.note);
        } catch (err) {
          if (err instanceof GroupInputError) throw new SearchInputError(err.message);
          throw err;
        }
      },
    });
    return tasks;
  }

  if (adv?.longStay) {
    tasks.push({
      engine: "longstay",
      label: "long-stay bases",
      est: COST.longStay,
      min: 4,
      mustRun: true,
      skipNote: `a long stay prices each base live (about ${COST.longStay} searches), and this search's budget is ${p.budget}`,
      run: async (_budget, ctx) => {
        const region = t.kind === "region" && t.wild ? t.key : undefined;
        const countries = t.kind === "country" ? [t.code] : t.kind === "region" && !t.wild ? t.countries : undefined;
        const mustInclude = t.kind === "place" ? [t.name] : undefined;
        if (!region && !countries && !mustInclude) {
          ctx.note("a long stay needs a region, a country or a city in To");
          return;
        }
        const startMonth = p.q.when.kind === "month" ? p.q.when.month : p.q.when.kind === "anytime" ? undefined : p.from.slice(0, 7);
        try {
          const r = await longStay({ gateways: p.airports, home: p.home, ...(region ? { region } : {}), ...(countries ? { countries } : {}), ...(mustInclude ? { mustInclude } : {}), months: adv.longStay!.months, ...(startMonth ? { startMonth } : {}), origin: p.origin, exclude: p.exclude, deadline: ctx.deadline - 20_000 });
          ctx.add(r.bases.map((b) => tripFromLongStayBase(b, { seen: r.generatedAt })));
          ctx.note(r.note);
        } catch (err) {
          if (err instanceof LongStayInputError) throw new SearchInputError(err.message);
          throw err;
        }
      },
    });
    return tasks;
  }

  const wild = wildNights(p);
  if (wild) {
    const regionKey = adv?.wild?.region ?? (t.kind === "region" ? t.key : "");
    if (!Object.hasOwn(REGIONS, regionKey) || regionKey === "custom") throw new SearchInputError(`${regionKey || "that"} is not a Wild region; one of ${Object.keys(REGIONS).filter((k) => k !== "custom").join(", ")}`);
    tasks.push({
      engine: "wild",
      label: `a wild loop through ${REGIONS[regionKey as Region].label}`,
      est: COST.wild,
      min: 0,
      free: true,
      mustRun: true,
      run: async (budget, ctx) => {
        // The wild window is when the trip leaves (ten days at most); the trip then runs its nights.
        const leaveFrom = p.out ?? p.from;
        const leaveTo = p.out ?? minDay(p.to, addDays(leaveFrom, 10));
        const trip = await wildByWalk({
          gateways: p.airports,
          home: p.home,
          region: regionKey as Region,
          from: leaveFrom,
          to: leaveTo,
          nights: wild,
          nightsPerStop: p.npp[0],
          nightsPerStopMax: p.npp[1],
          origin: p.origin,
          exclude: p.exclude,
          ...(p.avoidWords.length ? { avoid: p.avoidWords } : {}),
          searchBudget: Math.min(40, budget),
          maxGroundMin: p.groundMax,
          tradeoff: p.prefs.tradeoff,
          ...(p.prefs.maxFlightHours ? { maxFlightHours: p.prefs.maxFlightHours } : {}),
          ...(p.prefs.taste === "unique" ? { wishes: "unique places and hidden gems over the big hubs" } : {}),
          deadline: Math.min(ctx.deadline, Date.now() + 150_000),
          onProgress: ctx.say,
          onEvent: (e) => {
            if (e.type === "loop") ctx.say(`Closed a loop: ${e.loop.title}, ${e.loop.total} euros`);
          },
        });
        if (trip.stops.length) ctx.add(tripFromWildTrip(trip, { seen: trip.generatedAt }));
        if (trip.partial) ctx.note("the walk was cut short (time or live prices), so this is what it had found");
      },
    });
    return tasks;
  }

  const [lo, hi] = p.nights;
  // A must-include day narrows the window the live engines search, as it does the graph's.
  const win = p.include ? { from: maxDay(p.from, addDays(p.include, -hi)), to: minDay(p.to, addDays(p.include, hi)) } : { from: p.from, to: p.to };

  if (t.kind === "place") {
    // The engines read a city by name and pick their own Cordoba; a name several cities share goes by its code instead.
    const cityArg = t.city ? ((CITIES_BY_NAME.get(fold(CITIES[t.city].name))?.length ?? 0) > 1 ? t.city : CITIES[t.city].name) : t.name;
    if (p.q.when.kind === "anytime") {
      tasks.push({ engine: "scan", label: `the cheapest months to ${t.name}`, est: COST.scan, min: 1, mustRun: true, run: (budget, ctx) => runScan(p, cityArg, Math.max(1, Math.min(6, budget)), ctx) });
      return tasks;
    }
    // Kiwi's returns to that city over the window: one search, often the cheapest plain return. Asked for first,
    // so a small budget still buys it before the route finder takes the rest.
    if (t.city && !p.oneWay && isCityTarget(cityArg)) {
      tasks.push({
        engine: "returns",
        label: `returns to ${t.name}`,
        est: COST.returnsCity,
        min: 1,
        run: async (_budget, ctx) => {
          const r = await findDeals({ origins: p.airports, from: win.from, to: win.to, ...(p.include ? { include: p.include } : {}), minNights: lo, maxNights: hi, where: cityArg, exclude: p.exclude, point: { lat: p.origin.lat, lon: p.origin.lon }, onProgress: ctx.say });
          ctx.add(r.deals.map((d) => tripFromDeal(d, { locate, seen: r.generatedAt })));
          ctx.note(r.note);
        },
      });
    }
    // The route finder: one window around the day, with its hubs and ground ways.
    tasks.push({
      engine: "route",
      label: `the cheapest ways to ${t.name}`,
      est: COST.route,
      min: 0,
      free: true,
      mustRun: true,
      run: async (budget, ctx) => {
        const nights = p.back && p.out ? daysBetween(p.out, p.back) : Math.round((lo + hi) / 2);
        const span = daysBetween(win.from, win.to);
        const depart = p.out ?? (p.include ? maxDay(win.from, addDays(p.include, -Math.min(2, Math.floor(nights / 2)))) : addDays(win.from, Math.max(0, Math.floor((span - nights) / 2))));
        const flex = p.out ? 0 : Math.min(3, Math.max(0, Math.floor((span - nights) / 2)));
        const fromPlace = routeFrom(p);
        const r = await cheapestWay({ from: fromPlace, to: cityArg, depart, flex, nights, oneWay: p.oneWay, exclude: p.exclude, budget, deadlineMs: Math.min(80_000, msLeft(ctx, 80_000)), onProgress: ctx.say });
        const asked = { depart, nights };
        ctx.add(r.options.map((o) => tripFromRouteOption(r, o, { asked, locate })));
        ctx.note(r.note);
      },
    });
    return tasks;
  }

  // Anywhere, a country or a short trip to a region.
  if (p.q.when.kind === "anytime" && t.kind === "country") {
    tasks.push({ engine: "scan", label: `the cheapest months to ${t.name}`, est: COST.scan, min: 1, mustRun: true, run: (budget, ctx) => runScan(p, t.name, Math.max(1, Math.min(6, budget)), ctx) });
  }
  if (p.oneWay) {
    if (!g.graphCount) tasks.push({ engine: "none", label: "one-way fares", est: 0, min: 0, free: true, run: async (_b, ctx) => ctx.note("one-way trips to anywhere come from the flight graph, which has nothing for these days yet") });
    return tasks;
  }
  const loops = p.shape === "two" || p.shape === "loop" || p.shape === "long" || hi > 7;
  const walkTask = (est: number): LiveTask => ({
    engine: "walk",
    label: "loops by plane and train",
    est,
    min: loops ? 0 : COST.walkMin,
    free: loops,
    mustRun: loops,
    run: async (budget, ctx) => {
      const allowed = allowedCountries(p);
      const maxStops = p.shape === "two" ? 2 : undefined;
      const params: WalkParams = {
        origin: p.origin,
        gateways: p.airports,
        home: p.home,
        from: win.from,
        to: win.to,
        minNights: lo,
        maxNights: hi,
        nightsPerStop: p.npp,
        ...(maxStops ? { maxStops } : {}),
        budget: Math.min(40, budget),
        deadlineMs: Math.min(90_000, msLeft(ctx, 90_000)),
        maxGroundMin: p.groundMax,
        ...(p.prefs.maxFlightHours ? { maxFlightHours: p.prefs.maxFlightHours } : {}),
        ...(t.kind === "region" && t.wild ? { region: t.key } : allowed ? { allowedCountries: allowed } : {}),
        tradeoff: p.prefs.tradeoff,
        exclude: p.exclude,
        ...(p.avoidWords.length ? { avoid: p.avoidWords } : {}),
        ...(p.prefs.taste === "unique" ? { style: "unique" } : {}),
        onEvent: (e) => {
          if (e.type === "progress") ctx.say(e.text);
        },
      };
      const r = await walkTrips(params);
      let loopsFound = r.loops;
      if (p.include) loopsFound = loopsFound.filter((l) => l.start <= p.include! && l.end >= p.include!);
      if (p.shape === "loop" || p.shape === "long") loopsFound = loopsFound.filter((l) => l.stops.length >= 3);
      ctx.add(loopsFound.map((l) => tripFromWalkLoop(l, { origin: p.origin.label, seen: r.generatedAt })));
      ctx.note(r.note);
    },
  });
  if (loops) {
    tasks.push(walkTask(Math.max(12, 2 * Math.ceil(hi / p.npp[0]) + 2)));
    return tasks;
  }
  // Return trips and two cities: the paired one-ways. Anywhere is about 31 searches; with the graph's
  // answer in hand the paired search is aimed at the four countries the graph found cheapest instead.
  const aimed = t.kind === "anywhere" && g.graphCount > 0 && g.graphCountries.length > 0;
  const where = t.kind === "country" ? t.name : t.kind === "region" ? (t.wild ? t.countries.slice(0, 4).map(countryName).join(",") : t.key) : aimed ? g.graphCountries.slice(0, 4).map(countryName).join(",") : "anywhere";
  const est = t.kind === "country" ? COST.pairsCountry : aimed || (t.kind === "region" && t.wild) ? COST.pairsListed : COST.pairsAnywhere;
  tasks.push({
    engine: "pairs",
    label: aimed ? `live fares to ${g.graphCountries.slice(0, 4).map(countryName).join(", ")}` : `paired one-way fares to ${t.kind === "anywhere" ? "anywhere" : where}`,
    est,
    min: est,
    mustRun: true,
    skipNote: `the paired search needs about ${est} live searches, more than this search's budget; showing the flight graph's prices`,
    run: async (_budget, ctx) => {
      const r = await findDeals({ origins: p.airports, from: win.from, to: win.to, ...(p.include ? { include: p.include } : {}), minNights: lo, maxNights: hi, where, exclude: p.exclude, point: { lat: p.origin.lat, lon: p.origin.lon }, onProgress: ctx.say });
      ctx.add(r.deals.map((d) => tripFromDeal(d, { locate, seen: seenNow() })));
      ctx.note(r.note);
    },
  });
  // What is left after the paired search walks a loop or two, when it is enough to be worth it.
  if (hi >= 4 && p.shape === "any") tasks.push({ ...walkTask(COST.walkMin + 6), min: COST.walkMin + 4, mustRun: false, free: false });
  return tasks;
}

/** The route finder's "from": the traveller's place by name when our data puts it near their point, else the point itself. */
function routeFrom(p: Plan): string {
  const byName = resolvePlace(p.origin.label.split(",")[0]);
  if (byName && haversineKm(byName.lat, byName.lon, p.origin.lat, p.origin.lon) <= 40) return p.origin.label.split(",")[0];
  return `${p.origin.lat.toFixed(4)},${p.origin.lon.toFixed(4)}`;
}

/** The price calendar: each month's cheapest fare to the place, as a return trip (or a one-way). */
async function runScan(p: Plan, to: string, months: number, ctx: TaskCtx): Promise<void> {
  const r = await scanCheapest({ origins: p.airports, to, months, minNights: p.nights[0], maxNights: p.nights[1], oneWay: p.oneWay, exclude: p.exclude });
  const found: TripResult[] = [];
  for (const m of r.months) {
    for (const x of [m, ...(m.also ?? [])]) {
      if (x.cheapest == null || !x.out) continue;
      const landing = x.to ?? "";
      const cityCode = CITY_OF_AIRPORT.get(landing) ?? (CITIES[landing] ? landing : findCityCode(to) ?? landing);
      const city = CITIES[cityCode];
      const deal: Deal = {
        gw: x.from ?? p.airports[0],
        dst: landing || cityCode,
        dstCity: cityCode,
        city: city?.name ?? x.toCity ?? to,
        country: city?.country ?? AIRPORT_BY_IATA.get(landing)?.country ?? "",
        price: Math.round(x.cheapest),
        out: x.out,
        back: x.back ?? "",
        nights: x.nights ?? 0,
        // An unknown number of stops never counts as direct.
        stops: x.stops ?? 1,
        carriers: x.carriers ?? [],
        outMin: 0,
        backMin: 0,
        url: x.url ?? "",
        ...(x.openJawTo ? { backFrom: x.openJawTo } : {}),
        ...(x.url2 ? { url2: x.url2 } : {}),
      };
      if (!deal.url) continue;
      found.push(tripFromDeal(deal, { locate, engine: "scan", source: x.remembered ? "memory" : "live", seen: r.generatedAt }));
    }
  }
  ctx.add(found);
  ctx.note(r.note ?? (r.partial ? "some months could not be searched (live prices refused), so the calendar has gaps" : undefined));
}

/** For the chat and tests: the label of an airport or city code. */
export function placeName(code: string): string {
  return locate(code)?.name ?? resolveGateway(code)?.label ?? code;
}
