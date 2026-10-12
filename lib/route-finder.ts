// Server-only. The cheapest way from A to B: two places (a city name, an airport code, a
// place name or "lat,lon"), one date window, and every way the data can get between them,
// ranked by price and by time. The ways are: the fare memory (free), ONE Kiwi search with
// every candidate airport of each side as a comma list (direct, nearby airports and open-jaw
// landings fall out of it; a landing at an airport that is not the nearest one becomes
// "ground then fly" or "fly then ground" with the ground leg from the graph or an estimate),
// a via-hub split on separate tickets for a few hubs between the points, and the ground graph
// alone when the points are within twelve hours by train or coach. Everything live is bounded
// by a search budget (default 24) and a deadline (default 90 s): the main search first, then
// the hubs until the budget or the time is gone, each search capped at 35 s so one slow
// answer never holds the run. Nothing is invented: every flight price is a Kiwi itinerary
// with its booking link, and every ground price is an estimate labelled as one (0.10 euro per
// km, the going rate for a regional train or coach in Europe) unless the graph gives the
// minutes. Under 150 km no flight is searched at all: the graph answers alone.
//
// Searches: 1 (the main window) + up to 4 hubs x 2 one-ways (x 2 more for a return), plus 1
// when a side had to be resolved by Kiwi itself; all held under `budget`.
//
// The budget is a ceiling, not part of the question: an answer is memoised for an hour by
// the places (as resolved, not as typed), the window and the filters, and a later ask with a
// smaller or equal budget is served from it as is. A later ask with a bigger budget extends
// it: the main search's options are kept and only the hubs not yet searched are tried, with
// the new ceiling. A run cut short by the clock keeps what it spent as its ceiling, and a run
// the breaker refused is not stored at all.
import citiesJson from "@/public/data/cities.json";
import airportsJson from "@/public/data/airports.json";
import townsJson from "@/public/data/towns.json";
import { countryAllowed } from "./been";
import { hubDegree, mainGateway, resolveGateway } from "./board";
import { readBoard } from "./boards-store";
import { logSearch } from "./db";
import { driveMinutes, haversineKm, nearestGateways } from "./geo";
import { reachFrom } from "./ground";
import { rememberedFare, type RememberedFare } from "./insights";
import { kiwiDate, kiwiThrottled, searchFlight, THROTTLED_MESSAGE, type KiwiItinerary, type KiwiLeg } from "./kiwi";
import { landmarkOf } from "./landmarks";
import { InFlight, TtlLru } from "./memo";
import { OVERLAND, overlandTown, overlandTownNamed } from "./overland";
import type { Airport, City } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const AIRPORTS = airportsJson as unknown as Airport[];
/** [name, lat, lon, country, population] per GeoNames town. */
const TOWNS = townsJson as unknown as [string, number, number, string, number][];

// ---------------------------------------------------------------------------------------
// The shared contract (the route streams it, the chat and the UI consume it).

/**
 * One leg of a way. `remembered` marks a fly leg built from the fare memory (a price someone
 * saw this week, dates known, times not), so a consumer can say so without reading the note.
 */
export type RouteLeg = { kind: "fly" | "train" | "coach" | "ferry" | "road" | "walk"; from: string; fromName: string; to: string; toName: string; date?: string; depart?: string; arrive?: string; minutes: number; price: number | null; estimated?: boolean; carrier?: string; url?: string; note?: string; remembered?: true };
/**
 * One way from A to B. `kind` says which airports were used, not whether the flight is
 * nonstop: "direct" means the nearest airport on both sides (a one-stop ticket is still
 * "direct" here); `nonstop` is true only when every flight leg has no stop. `total` is the
 * whole trip, there and (for a return) back, flights plus ground estimates. `backTotal` is
 * the part of `total` that is the way back, never to be added on top of it; it is left out
 * when the return is on the same ticket as the outbound, because that ticket cannot be split.
 */
export type RouteOption = { kind: "direct" | "nearby-airports" | "ground-then-fly" | "fly-then-ground" | "via-hub" | "open-jaw" | "ground-only"; legs: RouteLeg[]; total: number; hours: number; stops: number; title: string; why: string; urls: string[]; score: number; back?: RouteLeg[]; backTotal?: number; nonstop?: boolean };
/**
 * The two ends always carry finite coordinates. A place that could not be placed (no data of
 * ours knows it and Kiwi found nothing under the name) has `placed: false`, no airports, and
 * borrows the other end's coordinates (0, 0 when neither is known), so a globe that frames
 * the two ends still lands somewhere sensible; the `note` says what happened.
 */
export type RouteEnd = { label: string; lat: number; lon: number; airports: string[]; placed?: boolean };
/**
 * What fed the options: `live` when any option is a Kiwi itinerary (the main search or a
 * hub pair, fresh or from Kiwi's own memo), `memory` when one is a remembered fare, `ground`
 * when the ground graph or the road estimate gave a whole way (`ground-only`). The estimated
 * legs to and from an airport are part of every option and are not a source of their own.
 */
export type RouteSource = "live" | "memory" | "ground";
export type RouteResult = { from: RouteEnd; to: RouteEnd; options: RouteOption[]; cheapest: RouteOption | null; fastest: RouteOption | null; searched: number; failed: number; considered: string[]; sources: RouteSource[]; note?: string; generatedAt: string };

export type RouteQuery = {
  from: string;
  to: string;
  /** YYYY-MM-DD; default three weeks out. */
  depart?: string;
  /** Days either side of `depart` (0 to 3, default 2). */
  flex?: number;
  /** Nights there for a return (default 4); ignored when oneWay. */
  nights?: number;
  oneWay?: boolean;
  /** Door to door, hours: options longer than this are dropped. */
  maxHours?: number;
  /** "Been" countries (ISO2): never a landing or an overnight stop, fine as a connection. */
  exclude?: string[];
  /**
   * Live Kiwi searches this answer may have spent in all (default 24); 0 answers from memory
   * and the ground graph alone. A ceiling, not a key: a memoised answer run under a bigger
   * budget is served as is, one run under a smaller budget is extended up to this one.
   */
  budget?: number;
  /**
   * Milliseconds the run may take (default 90 s, under the route's 120 s): past it no new hub
   * search is issued and what was found is returned with a note, so a slow Kiwi day ends in
   * an answer instead of a killed function.
   */
  deadlineMs?: number;
  onProgress?: (line: string) => void;
  /** Each option as it is found, for streaming; the final list is in the result. */
  onOption?: (option: RouteOption) => void;
};

// ---------------------------------------------------------------------------------------
// Constants, in one place so the tradeoffs are easy to read.

/**
 * Euros per hour door to door behind `score`. Money first (the owner, 2026-10-12): hours only
 * break ties; the fastest way is still picked and badged on its own.
 */
const EURO_PER_HOUR = 2;
/** What a kilometre of train or coach costs when no fare is known. */
const EURO_PER_KM = 0.1;
/** Candidate airports per side. */
const MAX_AIRPORTS = 4;
/** Train or coach to an airport counts when it is this quick. */
const GROUND_ACCESS_MIN = 180;
/** Ground only is worth proposing when the graph gets there in twelve hours. */
const GROUND_ONLY_MIN = 720;
/** Beyond this great-circle distance the ground graph is not even asked (twelve hours at train speed). */
const GROUND_ONLY_KM = 1500;
/** Hubs between the points: how far off the straight line they may be, and how many. */
const HUB_DETOUR = 0.35;
const BOARD_HUB_DETOUR = 0.6;
const MAX_HUBS = 4;
/** Minutes at the airport before departure and after landing, counted in door-to-door hours. */
const CHECK_IN_MIN = 90;
const LANDING_MIN = 30;
/** The shortest self-transfer between two tickets at a hub, on top of any change of airport. */
const MIN_CONNECT_MIN = 120;
/**
 * Two airports of one hub this close (Treviso and Marco Polo, Beauvais and Charles de
 * Gaulle, Stansted and Heathrow) are joined by an estimated road leg; farther apart the two
 * tickets must use one airport.
 */
const AIRPORT_CHANGE_KM = 150;
const DEFAULT_BUDGET = 24;
const MEMO_TTL_MS = 60 * 60_000;
/** The run's own deadline, and how long one live search may hold the run (Kiwi's full retry ladder is longer). */
const DEFAULT_DEADLINE_MS = 90_000;
const SEARCH_CAP_MS = 35_000;
/** Two points closer than this are a ground trip and no flight is searched. */
const GROUND_TRIP_KM = 150;

// ---------------------------------------------------------------------------------------
// Lookups built once per process.

const airportByIata = new Map(AIRPORTS.map((a) => [a.iata, a]));
const cityOfAirport = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!cityOfAirport.has(a)) cityOfAirport.set(a, code);

/** Medium and large airports on a quarter-degree grid, so "airports near this station" is a cell lookup. */
const CELL = 0.25;
const airportGrid = new Map<string, Airport[]>();
for (const a of AIRPORTS) {
  if (a.size === "small") continue;
  const k = `${Math.floor(a.lat / CELL)},${Math.floor(a.lon / CELL)}`;
  const list = airportGrid.get(k);
  if (list) list.push(a);
  else airportGrid.set(k, [a]);
}
function airportsNear(lat: number, lon: number, maxKm: number): { airport: Airport; km: number }[] {
  const cl = Math.floor(lat / CELL);
  const co = Math.floor(lon / CELL);
  const out: { airport: Airport; km: number }[] = [];
  for (let dl = -1; dl <= 1; dl++)
    for (let dn = -1; dn <= 1; dn++)
      for (const airport of airportGrid.get(`${cl + dl},${co + dn}`) ?? []) {
        const km = haversineKm(lat, lon, airport.lat, airport.lon);
        if (km <= maxKm) out.push({ airport, km });
      }
  return out;
}

/** Letters only, no accents, lower case: "Brașov", "Brasov" and "BRASOV" are one key. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const cityByName = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = fold(c.name);
  const prev = cityByName.get(k);
  if (!prev || hubDegree(code) > hubDegree(prev)) cityByName.set(k, code);
}
const airportName = (code: string) => {
  const a = airportByIata.get(code);
  const city = cityOfAirport.get(code);
  return (city && CITIES[city]?.name) || a?.city || a?.name || code;
};
const cityName = (code: string) => CITIES[code]?.name ?? airportName(code);
const hubOfAirport = (code: string) => hubDegree(cityOfAirport.get(code) ?? code);

// ---------------------------------------------------------------------------------------
// Places and their airports.

type Place = { label: string; lat: number; lon: number; country?: string; /** The code the traveller typed, when it was one. */ own?: string; /** Unknown to our data: Kiwi resolves it. */ unknown?: boolean };

/** How the traveller gets between their point and an airport. */
type Access = { code: string; name: string; country: string; size: Airport["size"]; km: number; minutes: number; kind: RouteLeg["kind"]; via?: string };

/**
 * A place from what the traveller typed: "lat,lon", an airport or city code, a city name
 * (cities.json), an airport's city or name, a GeoNames town. Null when none of our data knows
 * it; the caller then lets Kiwi resolve the name with the one main search.
 */
export function resolvePlace(input: string): Place | null {
  const s = input.trim();
  if (!s) return null;
  const ll = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (ll) {
    const lat = Number(ll[1]);
    const lon = Number(ll[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { label: `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon };
    return null;
  }
  // A three-letter word is a code when it is typed as one (upper case); typed as a name
  // ("Bar", the town in Montenegro) the places are tried first and the code is the fallback,
  // so "otp" still finds Bucharest and "Bar" does not land in China at airport BAR.
  const code = /^[A-Za-z]{3}$/.test(s) ? resolveGateway(s.toUpperCase()) : null;
  // An airport code is labelled by the city it serves ("Bucharest" for OTP, not "Otopeni").
  const byCode = code ? { label: CITIES[code.code] ? code.label : airportName(code.code), lat: code.lat, lon: code.lon, country: code.country, own: code.code } : null;
  if (byCode && s === s.toUpperCase()) return byCode;
  const k = fold(s);
  if (!k) return byCode;
  // A landmark (Machu Picchu, the Uyuni salt flats, Bali): the city or town a traveller stays in to see it.
  const lm = landmarkOf(s);
  if (lm?.code && CITIES[lm.code]) return { label: CITIES[lm.code].name, lat: CITIES[lm.code].lat, lon: CITIES[lm.code].lon, country: CITIES[lm.code].country };
  const lmTown = lm?.town ? overlandTownNamed(lm.town) : undefined;
  if (lmTown) return { label: lmTown.name, lat: lmTown.lat, lon: lmTown.lon, country: lmTown.country };
  // A base in the towns file (La Spezia for the Cinque Terre); its name is never a landmark, so this ends.
  if (lm?.town) {
    const base = resolvePlace(lm.town);
    if (base) return base;
  }
  const city = cityByName.get(k);
  if (city) {
    const c = CITIES[city];
    return { label: c.name, lat: c.lat, lon: c.lon, country: c.country };
  }
  // An airport's city or its own name ("Otopeni", "Heathrow"): the biggest match wins.
  const byAirport = AIRPORTS.filter((a) => fold(a.city ?? "") === k || fold(a.name) === k).sort((a, b) => hubOfAirport(b.iata) - hubOfAirport(a.iata))[0];
  if (byAirport) return { label: byAirport.city ?? byAirport.name, lat: byAirport.lat, lon: byAirport.lon, country: byAirport.country, own: byAirport.iata };
  let town: (typeof TOWNS)[number] | null = null;
  for (const t of TOWNS) if (fold(t[0]) === k && (!town || t[4] > town[4])) town = t;
  if (town) return { label: town[0], lat: town[1], lon: town[2], country: town[3] };
  // A town only the overland links know (Ella, Kazbegi, Huacachina, Merzouga).
  const ov = overlandTownNamed(s);
  if (ov) return { label: ov.name, lat: ov.lat, lon: ov.lon, country: ov.country };
  return byCode;
}

/**
 * The airports worth using from a point, ranked the way lib/board.ts ranks a home: the
 * nearest large and medium airports by drive time, plus any airport a train or coach reaches
 * within three hours (the graph's minutes plus the hop from the station), de-duplicated, at
 * most four. The traveller's own code, when they typed one, is always first. Exported for the
 * finder's exhaustive mode.
 */
export function gatewaysFor(point: { lat: number; lon: number; own?: string }, opts: { exclude?: string[]; homeCountry?: string; max?: number } = {}): Access[] {
  const max = opts.max ?? MAX_AIRPORTS;
  const exclude = opts.exclude ?? [];
  const found = new Map<string, Access>();
  const add = (a: Access) => {
    const prev = found.get(a.code);
    if (!prev || a.minutes < prev.minutes) found.set(a.code, a);
  };
  // An airport in a visited country is a landing there, unless it is the place's own country.
  const allowed = (a: Airport) => a.country === opts.homeCountry || countryAllowed(a.country, exclude);
  for (const g of nearestGateways(AIRPORTS, point.lat, point.lon, { maxKm: 350, limit: 8 })) {
    if (g.airport.size === "small" || !allowed(g.airport)) continue;
    add({ code: g.airport.iata, name: airportName(g.airport.iata), country: g.airport.country, size: g.airport.size, km: g.km, minutes: g.driveMin, kind: g.km < 2 ? "walk" : "road" });
  }
  // Train or coach: every station within three hours, then the airports a short hop from it.
  // A far airport the road list already has is kept on the road when the road is quicker and
  // under 60 km; past that people take the train to the airport, so the train access wins.
  try {
    const r = reachFrom(point.lat, point.lon, GROUND_ACCESS_MIN, 40);
    for (const s of r.reached) {
      for (const { airport, km } of airportsNear(s.lat, s.lon, 20)) {
        if (!allowed(airport)) continue;
        const minutes = s.minutes + (km < 2 ? 5 : driveMinutes(km) + 10);
        const road = found.get(airport.iata);
        if (road && road.kind === "road" && road.km < 60 && road.minutes <= minutes) continue;
        const kind: RouteLeg["kind"] = s.mode === "rail" ? "train" : s.mode === "ferry" ? "ferry" : "coach";
        const cur = found.get(airport.iata);
        if (!cur || cur.kind === "road" || minutes < cur.minutes) found.set(airport.iata, { code: airport.iata, name: airportName(airport.iata), country: airport.country, size: airport.size, km: haversineKm(point.lat, point.lon, airport.lat, airport.lon), minutes, kind, via: s.name });
      }
    }
  } catch {
    // the graph is optional: the road list stands
  }
  const own = point.own ? (CITIES[point.own]?.airports ?? [point.own]).filter((c) => airportByIata.has(c)) : [];
  for (const code of own) {
    if (found.has(code)) continue;
    const a = airportByIata.get(code)!;
    const km = haversineKm(point.lat, point.lon, a.lat, a.lon);
    found.set(code, { code, name: airportName(code), country: a.country, size: a.size, km, minutes: driveMinutes(km), kind: km < 2 ? "walk" : "road" });
  }
  // A place with no medium or large airport in reach (Arctic Bay, Nain, a small island) still
  // has its own small strip: the nearest two within 150 km are its access, or the main search
  // would be sent by name and every landing dropped as unmappable.
  if (!found.size) {
    for (const g of nearestGateways(AIRPORTS, point.lat, point.lon, { maxKm: 375, limit: 2 })) {
      if (g.km > 150 || !allowed(g.airport)) continue;
      add({ code: g.airport.iata, name: airportName(g.airport.iata), country: g.airport.country, size: g.airport.size, km: g.km, minutes: g.driveMin, kind: g.km < 2 ? "walk" : "road" });
    }
  }
  // Rank: minutes discounted for size (a big airport is where the cheap flights are), own first.
  const weight = (s: Airport["size"]) => (s === "large" ? 0.7 : 1);
  const ranked = [...found.values()].sort((a, b) => a.minutes * weight(a.size) - b.minutes * weight(b.size));
  const first = ranked.filter((a) => own.includes(a.code));
  return [...first, ...ranked.filter((a) => !own.includes(a.code))].slice(0, max);
}

/** The airport codes a train or coach reaches within `maxMinutes` of a point, nearest first. For the finder. */
export function airportsByGround(lat: number, lon: number, maxMinutes = GROUND_ACCESS_MIN, limit = 4): string[] {
  return gatewaysFor({ lat, lon }, { max: 12 })
    .filter((a) => a.kind === "train" || a.kind === "coach" || a.kind === "ferry")
    .filter((a) => a.minutes <= maxMinutes)
    .slice(0, limit)
    .map((a) => a.code);
}

// ---------------------------------------------------------------------------------------
// Small helpers for legs, dates and words.

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const dayOf = (t: string) => t.slice(0, 10);
/** Whole days from one YYYY-MM-DD to another (the nights between two departures). */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const hhmm = (t: string) => t.slice(11, 16);
const minutesBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
const groundPrice = (km: number) => Math.max(3, Math.round(km * EURO_PER_KM));
const modeWord: Record<RouteLeg["kind"], string> = { fly: "Fly", train: "Train", coach: "Coach", ferry: "Ferry", road: "Drive", walk: "Walk" };
const list = (codes: string[]) => codes.join(", ");
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The ground leg between the traveller's point and an airport, priced as an estimate. */
function accessLeg(place: Place, a: Access, toAirport: boolean): RouteLeg | null {
  if (a.kind === "walk" && a.km < 2) return null;
  const via = a.via ? ` via ${a.via}` : "";
  const leg: RouteLeg = toAirport
    ? { kind: a.kind, from: place.label, fromName: place.label, to: a.code, toName: a.name, minutes: a.minutes, price: groundPrice(a.km), estimated: true, note: `${modeWord[a.kind]} to the airport${via}, about ${Math.round(a.km)} km` }
    : { kind: a.kind, from: a.code, fromName: a.name, to: place.label, toName: place.label, minutes: a.minutes, price: groundPrice(a.km), estimated: true, note: `${modeWord[a.kind]} from the airport${via}, about ${Math.round(a.km)} km` };
  return leg;
}

/**
 * The road between two airports of one hub when two tickets land at one and leave from the
 * other (Treviso to Marco Polo, Beauvais to Charles de Gaulle): minutes from the drive
 * estimate over the straight line, the price at the engine's euro per km, all marked as an
 * estimate. Null when either airport is unknown to the data or they are too far apart to be
 * one hub, in which case the two tickets must use the same airport. Exported for tests.
 */
export function airportChange(fromCode: string, toCode: string): RouteLeg | null {
  const a = airportByIata.get(fromCode);
  const b = airportByIata.get(toCode);
  if (!a || !b) return null;
  const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
  if (km > AIRPORT_CHANGE_KM) return null;
  return { kind: "road", from: fromCode, fromName: a.name, to: toCode, toName: b.name, minutes: driveMinutes(km), price: groundPrice(km), estimated: true, note: `change of airport, about ${Math.round(km)} km by road` };
}

/** One Kiwi leg (an outbound or an inbound) as a fly leg; the ticket price sits on `priced` legs only. */
function flyLeg(leg: KiwiLeg, price: number | null, url: string): RouteLeg {
  const carriers = [...new Set(leg.segments.map((s) => s.carrierName || s.carrier))];
  const via = leg.route.slice(1, -1).map(cityName);
  return { kind: "fly", from: leg.from, fromName: airportName(leg.from), to: leg.to, toName: airportName(leg.to), date: dayOf(leg.departureTime), depart: hhmm(leg.departureTime), arrive: hhmm(leg.arrivalTime), minutes: Math.round(leg.durationSeconds / 60), price, carrier: carriers.join(", "), url, note: via.length ? `${leg.stops} stop${leg.stops > 1 ? "s" : ""} via ${via.join(", ")}` : "direct" };
}

function finish(o: Omit<RouteOption, "score" | "urls">): RouteOption {
  const urls = [...new Set([...o.legs, ...(o.back ?? [])].map((l) => l.url).filter((u): u is string => !!u))];
  return { ...o, urls, score: Math.round(o.total + o.hours * EURO_PER_HOUR) };
}

/** The non-flight part of a leg list, all of it estimated. */
const groundSum = (legs: RouteLeg[]) => legs.filter((l) => l.kind !== "fly").reduce((s, l) => s + (l.price ?? 0), 0);
const sumMinutes = (legs: RouteLeg[]) => legs.reduce((s, l) => s + l.minutes, 0);

// ---------------------------------------------------------------------------------------
// The engine.

/**
 * What a finished run leaves behind so a later ask with a bigger budget can grow it instead
 * of starting over: the two placed ends, the window actually searched, the hubs picked and
 * which of them were searched, every option found, the considered lines up to the hub step,
 * the sources, and the searches spent (they count against the new ceiling). Null when the run
 * never reached the main search (budget 0, or a place that could not be resolved).
 */
type Stage = { A: Place; B: Place; aAcc: Access[]; bAcc: Access[]; from: string; to: string; hubs: Hub[]; hubsDone: string[]; options: RouteOption[]; considered: string[]; sources: RouteSource[]; searched: number; at: number };
/**
 * What a run hands back: the result, the stage to extend it from, whether it is complete,
 * whether the breaker refused any of its searches (such a run is never stored: the breaker
 * closes in minutes and the answer would outlive it by an hour), and whether it stopped for
 * time rather than for the budget (then the ceiling stored is what it spent, not what it was
 * allowed, so the same budget asked again resumes instead of being served the cut answer).
 */
type Outcome = { result: RouteResult; stage: Stage | null; complete: boolean; throttled: boolean; cutShort: boolean };
/**
 * A memoised answer: the result, its ceiling (the budget it was run with, or the searches it
 * spent when it stopped for time), whether it needs no more searches (none failed, no hub
 * left out for the budget, the deadline or the breaker), and the stage to extend it from.
 */
type Stored = { result: RouteResult; budget: number; complete: boolean; stage: Stage | null };

const memo = new TtlLru<Stored>(300, MEMO_TTL_MS);
const inflight = new InFlight<Outcome>();

/** The question's defaults, computed once so the memo key and the run agree on them. */
const normalise = (q: RouteQuery) => {
  const today = new Date().toISOString().slice(0, 10);
  return { flex: Math.min(3, Math.max(0, Math.round(q.flex ?? 2))), nights: Math.max(1, Math.round(q.nights ?? 4)), oneWay: !!q.oneWay, depart: q.depart ?? addDays(today, 21), today };
};
/**
 * A side of the memo key: the place as our data resolves it (coordinates to three decimals
 * and the code the traveller typed), so "BAR" the airport and "Bar" the town, or "41.9,12.5"
 * and "-41.9,12.5", never share an entry. A name none of our data knows is keyed by its text
 * as typed, case kept, since Kiwi will place it by that text.
 */
const placeKey = (text: string, p: Place | null) => (p ? `${p.lat.toFixed(3)},${p.lon.toFixed(3)}|${p.own ?? ""}` : text.trim());
/** The memo key: the question without its budget, so the budget can act as a ceiling. */
const memoKey = (q: RouteQuery, A: Place | null, B: Place | null) => {
  const n = normalise(q);
  // A one-way ask has no nights: the UI still sends its nights box, and each value would be a new key.
  return JSON.stringify({ f: placeKey(q.from, A), t: placeKey(q.to, B), d: n.depart, x: n.flex, n: n.oneWay ? 0 : n.nights, o: n.oneWay, h: q.maxHours ?? 0, e: [...(q.exclude ?? [])].sort() });
};

export async function cheapestWay(q: RouteQuery): Promise<RouteResult> {
  // 0 is honoured: a caller may want the fare memory and the ground graph alone.
  const budget = Math.max(0, Math.round(q.budget ?? DEFAULT_BUDGET));
  // The places are resolved once, for the key and for the run (the town list is a linear scan).
  const A = resolvePlace(q.from);
  const B = resolvePlace(q.to);
  const key = memoKey(q, A, B);
  const stored = memo.get(key);
  // A stored answer that needs nothing more, or that already had this much budget, is the
  // answer; one cut short by a smaller budget grows from its stage (a full run when the
  // stored run never reached the main search).
  if (stored && (stored.complete || stored.budget >= budget)) return stored.result;
  const resume = stored?.stage ?? null;
  const { promise, mine } = inflight.run(`${key}|${budget}`, () => run(q, resume, A, B));
  const out = await promise;
  // A run in which a live search failed (a throttled address, a timed-out search) or was
  // refused by the open breaker is a partial answer and must not become the answer for an
  // hour; the next caller gets a fresh try, and Kiwi's own memo makes the searches that did
  // answer free the second time. An extension that failed leaves the stored answer as it was.
  // A run that stopped for time is stored with what it spent as its ceiling, so the same
  // budget asked again a minute later resumes from its stage, as its note promises.
  if (mine && out.result.failed === 0 && !out.throttled) memo.set(key, { result: out.result, budget: out.cutShort ? out.result.searched : Math.max(budget, stored?.budget ?? 0), complete: out.complete, stage: out.stage });
  return out.result;
}

async function run(q: RouteQuery, resume: Stage | null, placedA: Place | null, placedB: Place | null): Promise<Outcome> {
  const say = q.onProgress ?? (() => {});
  const exclude = q.exclude ?? [];
  const { flex, nights, oneWay, depart, today } = normalise(q);
  const budget = Math.max(0, Math.round(q.budget ?? DEFAULT_BUDGET));
  const deadlineMs = Math.max(10_000, q.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const t0 = Date.now();
  const timeLeft = () => deadlineMs - (Date.now() - t0);
  const considered: string[] = [];
  const options: RouteOption[] = [];
  const sources = new Set<RouteSource>();
  // Searches already spent by the answer being extended count against the ceiling.
  const spentBefore = resume?.searched ?? 0;
  let searched = spentBefore;
  let failed = 0;
  /** Searches not made for the budget or the deadline. */
  let skipped = 0;
  /** Searches not made because the breaker was open (Kiwi said 403 or 429 in the last minutes). */
  let refused = 0;
  let timedOut = 0;
  let saidThrottled = false;
  const emit = (o: RouteOption) => {
    if (q.maxHours && o.hours > q.maxHours) return;
    options.push(o);
    q.onOption?.(o);
  };
  const at = () => new Date().toISOString();
  const done = (result: RouteResult, stage: Stage | null, complete: boolean): Outcome => ({ result, stage, complete, throttled: refused > 0, cutShort: timeLeft() <= 0 && skipped > 0 });
  /**
   * One live search under the budget and the deadline; null when the budget is gone, the
   * deadline has passed, the breaker is open, or the search failed. A search is raced against
   * a cap shorter than Kiwi's full retry ladder (three retries with sleeps can hold a request
   * past two minutes), so one slow search never holds the whole run; the search itself goes
   * on in the gate and lands in Kiwi's memo for the next caller.
   */
  const live = async (args: Parameters<typeof searchFlight>[0]): Promise<Awaited<ReturnType<typeof searchFlight>> | null> => {
    // The budget is checked first: at budget 0 nothing is refused, whatever the breaker says.
    if (searched + failed >= budget || timeLeft() <= 0) {
      skipped++;
      return null;
    }
    if (kiwiThrottled()) {
      refused++;
      return null;
    }
    const cap = Math.min(SEARCH_CAP_MS, Math.max(1000, timeLeft()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        searchFlight(args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), cap);
        }),
      ]);
      searched++;
      return r;
    } catch (err) {
      failed++;
      if (err instanceof Error && err.message === "timed out") timedOut++;
      if (err instanceof Error && err.message === THROTTLED_MESSAGE && !saidThrottled) {
        saidThrottled = true;
        say("Kiwi is throttling this address; using what is remembered.");
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. The two places. A name our data does not know is left to Kiwi: the main search takes
  // the name itself as flyFrom or flyTo and the landing airports place it afterwards. An
  // extension takes the ends as the earlier run placed them.
  let A: Place = resume?.A ?? placedA ?? { label: q.from.trim(), lat: NaN, lon: NaN, unknown: true };
  let B: Place = resume?.B ?? placedB ?? { label: q.to.trim(), lat: NaN, lon: NaN, unknown: true };
  let aAcc: Access[] = resume?.aAcc ?? (A.unknown ? [] : gatewaysFor(A, { homeCountry: A.country }));
  let bAcc: Access[] = resume?.bAcc ?? (B.unknown ? [] : gatewaysFor(B, { exclude, homeCountry: B.country }));
  const accA = () => new Map(aAcc.map((a) => [a.code, a]));
  const accB = () => new Map(bAcc.map((a) => [a.code, a]));
  /** The two ends for the result: finite coordinates always (see RouteEnd). */
  const ends = (): Pick<RouteResult, "from" | "to"> => {
    const okA = Number.isFinite(A.lat) && Number.isFinite(A.lon);
    const okB = Number.isFinite(B.lat) && Number.isFinite(B.lon);
    const a = okA ? { lat: A.lat, lon: A.lon } : okB ? { lat: B.lat, lon: B.lon } : { lat: 0, lon: 0 };
    const b = okB ? { lat: B.lat, lon: B.lon } : okA ? { lat: A.lat, lon: A.lon } : { lat: 0, lon: 0 };
    return { from: { label: A.label, ...a, airports: aAcc.map((x) => x.code), placed: okA }, to: { label: B.label, ...b, airports: bAcc.map((x) => x.code), placed: okB } };
  };
  if (!resume && !A.unknown && !B.unknown && haversineKm(A.lat, A.lon, B.lat, B.lon) < 5) {
    return done({ ...ends(), options: [], cheapest: null, fastest: null, searched: 0, failed: 0, considered: [], sources: [], note: "Those two places are the same place.", generatedAt: at() }, null, true);
  }
  // An airport in reach of both ends belongs to the end it is nearer to; from the other end it
  // would make the main search ask for a flight from an airport to itself.
  if (!resume && aAcc.length && bAcc.length) {
    const shared = aAcc.filter((a) => bAcc.some((b) => b.code === a.code)).map((a) => a.code);
    for (const code of shared) {
      const ma = accA().get(code)!.minutes;
      const mb = accB().get(code)!.minutes;
      if (ma <= mb) bAcc = bAcc.filter((b) => b.code !== code);
      else aAcc = aAcc.filter((a) => a.code !== code);
    }
    if (shared.length) considered.push(`${list(shared)} serves both ends; kept on the nearer side`);
  }
  if (resume) say(`Extending the answer found ${Math.max(1, Math.round((Date.now() - resume.at) / 60_000))} min ago (${resume.searched} live search${resume.searched === 1 ? "" : "es"}): up to ${Math.max(0, budget - resume.searched)} more now.`);
  else {
    say(`${A.label}: ${aAcc.length ? aAcc.map((a) => `${a.code} (${modeWord[a.kind].toLowerCase()} ${a.minutes} min)`).join(", ") : "Kiwi will place it"}`);
    say(`${B.label}: ${bAcc.length ? bAcc.map((a) => `${a.code} (${modeWord[a.kind].toLowerCase()} ${a.minutes} min)`).join(", ") : "Kiwi will place it"}`);
  }

  // The window never starts in the past: a departure within `flex` days of today is trimmed
  // to start today, or Kiwi answers nothing and the empty answer would be kept for an hour.
  // An extension keeps the window the earlier run searched.
  const wanted = addDays(depart, -flex);
  const from = resume?.from ?? (wanted < today ? today : wanted);
  const to = resume?.to ?? (addDays(depart, flex) < from ? from : addDays(depart, flex));
  // The trim is a considered line too, so the chat can quote the engine instead of recomputing it.
  if (!resume && wanted < today) {
    const line = `The window starts today (${from}), not ${wanted}.`;
    say(line);
    considered.push(line);
  }
  const retFrom = addDays(from, nights);
  const retTo = addDays(to, nights);
  const minNights = Math.max(1, nights - flex);
  const maxNights = nights + flex;
  const nightsOk = (n: number | null) => oneWay || (n != null && n >= minNights && n <= maxNights);
  const dAB = A.unknown || B.unknown ? Infinity : haversineKm(A.lat, A.lon, B.lat, B.lon);
  let hubs: Hub[] = resume?.hubs ?? [];
  const hubsDone: string[] = [...(resume?.hubsDone ?? [])];
  /** Whether the main search answered (an extension starts from one that did). */
  let mainDone = !!resume;

  if (resume) {
    considered.push(...resume.considered);
    for (const s of resume.sources) sources.add(s);
    for (const o of resume.options) emit(o);
  } else {
    // Two places within 150 km are a ground trip: no flight is worth a search, so none is
    // spent and the graph answers alone. Past that a flight is searched even when the two ends
    // reach the same airport (Madrid and Valencia both have VLC by train, and ten flights a day).
    if (dAB < GROUND_TRIP_KM) {
      considered.push(`${Math.round(dAB)} km apart: ground only, no flight searched`);
      const g = groundOnly(A, B, oneWay) ?? overlandOnly(A, B, oneWay) ?? roadOnly(A, B, oneWay);
      if (g) {
        emit(g);
        say(`By ground: ${g.title}, ${g.hours} h`);
      }
      options.sort((a, b) => a.score - b.score);
      const only = options[0] ?? null;
      say(`Done: ${options.length ? "1 way" : "no way found"}, 0 live searches.`);
      return done({ ...ends(), options, cheapest: only, fastest: only, searched: 0, failed: 0, considered, sources: only ? ["ground"] : [], note: only ? undefined : "No ground route in the graph between those two places.", generatedAt: at() }, null, true);
    }

    // 2. The fare memory, in parallel with the main search: whatever anyone saw this week for
    // any pair of these airports in the window is an option at zero cost.
    const memory = aAcc.length && bAcc.length ? rememberedFare(aAcc.map((a) => a.code), bAcc.map((b) => b.code), from, to, { oneWay, minNights: oneWay ? undefined : minNights, maxNights: oneWay ? undefined : maxNights, maxAgeDays: 7 }).catch(() => null) : Promise.resolve(null);

    // 3. The one main search: every origin airport to every destination airport, the window
    // out, the window plus nights back. Direct, nearby airports, ground legs and open jaws all
    // fall out of its 15 itineraries.
    const flyFrom = aAcc.length ? aAcc.map((a) => a.code).join(",") : A.label;
    const flyTo = bAcc.length ? bAcc.map((a) => a.code).join(",") : B.label;
    if (budget > 0) say(`Searching ${flyFrom} to ${flyTo}, ${from} to ${to}${oneWay ? ", one way" : `, ${nights} nights`}…`);
    else say("No live search: the fare memory and the ground graph only.");
    const main = await live({ flyFrom, flyTo, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to), ...(oneWay ? {} : { returnDate: kiwiDate(retFrom), returnDateTo: kiwiDate(retTo) }) });
    considered.push(`${flyFrom} to ${flyTo} in one search${oneWay ? ", one way" : `, ${nights} nights`}`);

    // A side Kiwi had to place (a name our data does not know, or a known place with no airport
    // in reach, searched by its name): the landing airports become its airports, the first one
    // its point when it had none.
    const placeBy = (codes: string[], side: Place): { place: Place; acc: Access[] } | null => {
      const g = resolveGateway(codes[0]);
      if (!g) return null;
      const place: Place = side.unknown ? { label: side.label, lat: g.lat, lon: g.lon, country: g.country } : side;
      const acc = codes.map((code) => {
        const a = airportByIata.get(code);
        const km = Number.isFinite(place.lat) && a ? haversineKm(place.lat, place.lon, a.lat, a.lon) : 0;
        return { code, name: airportName(code), country: a?.country ?? g.country, size: a?.size ?? "medium", km, minutes: km < 2 ? 0 : driveMinutes(km), kind: km < 2 ? ("walk" as const) : ("road" as const) };
      });
      return { place, acc };
    };
    if (main?.itineraries.length) {
      if (!aAcc.length) {
        const codes = [...new Set(main.itineraries.map((it) => it.outbound.from))].slice(0, MAX_AIRPORTS);
        const p = placeBy(codes, A);
        if (p) {
          A = p.place;
          aAcc = p.acc;
          considered.push(`Kiwi placed ${A.label} at ${list(codes)}`);
        }
      }
      if (!bAcc.length) {
        const codes = [...new Set(main.itineraries.map((it) => it.outbound.to))].slice(0, MAX_AIRPORTS);
        const p = placeBy(codes, B);
        if (p) {
          B = p.place;
          bAcc = p.acc;
          considered.push(`Kiwi placed ${B.label} at ${list(codes)}`);
        }
      }
    }
    if (!aAcc.length || !bAcc.length) {
      const which = [!aAcc.length ? A.label : "", !bAcc.length ? B.label : ""].filter(Boolean).join(" and ");
      const note = main ? `Could not place ${which}: no flights found under that name. Try a city name or an airport code.` : `Could not place ${which}, and the live search did not answer. Try a city name or an airport code${kiwiThrottled() ? ", or again in a few minutes" : ""}.`;
      say(note);
      // Nothing to extend here: with a budget the answer is final, without one a bigger
      // budget must run the main search itself.
      return done({ ...ends(), options: [], cheapest: null, fastest: null, searched, failed, considered, sources: [], note, generatedAt: at() }, null, !!main);
    }
    const nearestA = aAcc[0]?.code;
    const nearestB = bAcc[0]?.code;
    const isGround = (a: Access | undefined) => !!a && (a.kind === "train" || a.kind === "coach" || a.kind === "ferry");

    /** An itinerary of the main search (or a remembered fare) as an option with its ground legs. */
    const fromItinerary = (it: { price: number; url: string; out: KiwiLeg; back?: KiwiLeg }, remembered: boolean): RouteOption | null => {
      const oa = accA().get(it.out.from);
      const ob = accB().get(it.out.to);
      if (!oa || !ob) return null;
      const legs: RouteLeg[] = [];
      const inA = accessLeg(A, oa, true);
      const outB = accessLeg(B, ob, false);
      if (inA) legs.push(inA);
      legs.push(flyLeg(it.out, Math.round(it.price), it.url));
      if (outB) legs.push(outB);
      let back: RouteLeg[] | undefined;
      if (it.back) {
        const ba = accA().get(it.back.to);
        const bb = accB().get(it.back.from);
        back = [];
        const b1 = bb ? accessLeg(B, bb, true) : null;
        const b2 = ba ? accessLeg(A, ba, false) : null;
        if (b1) back.push(b1);
        back.push({ ...flyLeg(it.back, null, it.url), note: `${flyLeg(it.back, null, it.url).note}, same ticket` });
        if (b2) back.push(b2);
      }
      const openJaw = !!it.back && (it.back.to !== it.out.from || it.back.from !== it.out.to);
      const kind: RouteOption["kind"] = openJaw ? "open-jaw" : isGround(oa) ? "ground-then-fly" : isGround(ob) ? "fly-then-ground" : it.out.from !== nearestA || it.out.to !== nearestB ? "nearby-airports" : "direct";
      const ground = groundSum(legs) + (back ? groundSum(back) : 0);
      const total = Math.round(it.price + ground);
      const hours = r1((sumMinutes(legs) + CHECK_IN_MIN + LANDING_MIN) / 60);
      const stops = it.out.stops + (it.back?.stops ?? 0);
      // The title names the legs that matter: a short drive to or from the airport stays a leg
      // but not a word ("Train to Bucharest, fly to Lisbon", not "..., drive to Lisbon").
      const worthAWord = (l: RouteLeg | null, a: Access) => !!l && !((l.kind === "road" || l.kind === "walk") && a.km < 30);
      const parts: string[] = [];
      const sayIn = worthAWord(inA, oa);
      if (sayIn) parts.push(`${modeWord[inA!.kind]} to ${oa.name}`);
      parts.push(`${sayIn ? "fly" : "Fly"} ${sayIn ? "" : `from ${oa.name} `}to ${ob.name}`);
      if (worthAWord(outB, ob)) parts.push(`${modeWord[outB!.kind].toLowerCase()} to ${B.label}`);
      let title = parts.join(", ");
      // "direct" is the nearest airports, not a nonstop flight: the title says when it stops.
      if (kind === "direct" && it.out.stops) title += ` (${it.out.stops} stop${it.out.stops > 1 ? "s" : ""})`;
      if (openJaw) title += ` (back ${it.back!.from} to ${it.back!.to})`;
      const whyBits = [`${Math.round(it.price)} euro ticket${it.out.stops ? `, ${it.out.stops} stop${it.out.stops > 1 ? "s" : ""}` : ", nonstop"}`, ground ? `about ${Math.round(ground)} euro of ground, estimated` : "", `${hours} h door to door`, remembered ? "a fare seen this week, check it is still there" : `out ${dayOf(it.out.departureTime)}${it.back ? `, back ${dayOf(it.back.departureTime)}` : ""}`];
      // The return is on the same ticket, so its price cannot be split out: no backTotal.
      return finish({ kind, legs, back, total, hours, stops, title, why: whyBits.filter(Boolean).join("; "), nonstop: stops === 0 });
    };

    const seen = new Set<string>();
    if (main) {
      let added = 0;
      for (const it of [...main.itineraries].sort((a, b) => a.price - b.price)) {
        if (!nightsOk(oneWay ? 0 : nightsOfIt(it))) continue;
        if (!countryAllowed(resolveGateway(it.outbound.to)?.country, exclude) && resolveGateway(it.outbound.to)?.country !== B.country) continue;
        const sig = [it.outbound.from, it.outbound.to, it.inbound?.from ?? "", it.inbound?.to ?? ""].join("-");
        if (seen.has(sig)) continue;
        const o = fromItinerary({ price: it.price, url: it.bookingUrl, out: it.outbound, back: it.inbound }, false);
        if (!o) continue;
        seen.add(sig);
        emit(o);
        sources.add("live");
        if (++added >= 6) break;
      }
      say(added ? `${added} way${added > 1 ? "s" : ""} by air from the main search` : "The main search found nothing in that window");
    }
    const mem = await memory;
    if (mem?.fare) {
      const f = mem.fare;
      const sig = [f.src, f.dst, f.back ? f.dst : "", f.back ? f.src : ""].join("-");
      const o = rememberedOption(f, fromItinerary);
      // The same pair from the live search is the fresher answer; the memory still gets its line.
      const dup = seen.has(sig);
      if (o && !dup) {
        seen.add(sig);
        emit(o);
        sources.add("memory");
        say(`Remembered: ${f.src} to ${f.dst} at ${Math.round(f.price)} euro`);
      }
      considered.push(`fare memory: ${f.src} to ${f.dst} at ${Math.round(f.price)} euro${dup ? ", also in the live search" : ""}`);
    } else if (aAcc.length && bAcc.length) considered.push(mem ? "fare memory: nothing this week" : "fare memory: off");

    // 4. The ground graph alone, when the two points are close enough for it. Zero searches.
    if (dAB <= GROUND_ONLY_KM) {
      const g = groundOnly(A, B, oneWay) ?? (dAB <= 300 ? roadOnly(A, B, oneWay) : null);
      if (g) {
        emit(g);
        sources.add("ground");
        considered.push(`ground graph: ${A.label} to ${B.label} in ${g.hours} h`);
        say(`By ground: ${g.title}, ${g.hours} h`);
      } else considered.push(`ground graph: no way within ${GROUND_ONLY_MIN / 60} h`);
    }
    // 4b. A sourced overland link (lib/overland.ts): the sleeper bus, train or ferry between the two, however long
    // (Lima to Cusco is 22 h by coach), at its typical fare. Zero searches.
    const ov = overlandOnly(A, B, oneWay);
    if (ov) {
      emit(ov);
      sources.add("ground");
      considered.push(`overland link: ${ov.title}, ${ov.hours} h, about ${ov.legs[0].price} euro`);
      say(`Overland: ${ov.title}, ${ov.hours} h`);
    }

    hubs = await pickHubs(A, B, aAcc, exclude);
    // A run without the main search (budget 0, or a search that failed) leaves no stage: a
    // bigger budget later runs it all.
    mainDone = !!main;
  }

  // The lines above the hub step are what an extension starts from; the hub summary and the
  // skipped line are written fresh each time.
  const consideredBase = [...considered];
  const flyFrom = aAcc.map((a) => a.code).join(",");
  const flyTo = bAcc.map((a) => a.code).join(",");

  // 5. Via a hub on two tickets: a few big airports close to the straight line, the board's
  // cheapest big cities from the origin first. A to hub and hub to B on the same or the next
  // day, the cheapest pairing; for a return, the same the other way. An extension tries only
  // the hubs the earlier run left out.
  const perHub = oneWay ? 2 : 4;
  const left = hubs.filter((h) => !hubsDone.includes(h.code));
  const wantedHubs = left.slice(0, Math.max(0, Math.floor((budget - searched - failed) / perHub)));
  // Hubs the budget allows but the clock or the breaker does not are counted as searches not
  // made, so the run knows it was cut short (stored with what it spent as its ceiling) or
  // refused (not stored at all), instead of looking like a run that spent its budget.
  let affordable: Hub[] = wantedHubs;
  if (wantedHubs.length && timeLeft() <= 0) {
    skipped += wantedHubs.length * perHub;
    affordable = [];
  } else if (wantedHubs.length && kiwiThrottled()) {
    refused += wantedHubs.length * perHub;
    affordable = [];
  }
  if (affordable.length) {
    say(`Trying ${affordable.length} hub${affordable.length > 1 ? "s" : ""}: ${affordable.map((h) => h.name).join(", ")}…`);
    /** Minutes door to door for two tickets: flight durations (right across time zones) plus the wait at the hub, which is one clock and covers any change of airport. */
    const pairMinutes = (p: HubPair) => Math.round((p.first.outbound.durationSeconds + p.second.outbound.durationSeconds) / 60) + minutesBetween(p.first.outbound.arrivalTime, p.second.outbound.departureTime);
    const hubWait = (p: HubPair, name: string) => {
      const wait = minutesBetween(p.first.outbound.arrivalTime, p.second.outbound.departureTime);
      return p.transfer ? `about ${p.transfer.minutes} min by road from ${p.transfer.from} to ${p.transfer.to}, then ${r1((wait - p.transfer.minutes) / 60)} h at ${name}` : `${Math.round(wait / 60)} h at ${name}`;
    };
    await Promise.all(
      affordable.map(async (hub) => {
        const [o1, o2] = await Promise.all([
          live({ flyFrom, flyTo: hub.code, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to) }),
          live({ flyFrom: hub.code, flyTo, departureDate: kiwiDate(from), departureDateTo: kiwiDate(addDays(to, 1)) }),
        ]);
        if (!o1 || !o2) return;
        const out = pairLegs(o1.itineraries, o2.itineraries, hub.sameDayOnly);
        if (!out) {
          hubsDone.push(hub.code);
          return;
        }
        let back: HubPair | null = null;
        if (!oneWay) {
          // The way back follows the outbound that was chosen: its window is `nights` after
          // the day the traveller leaves, give or take the flex, and never before they have
          // arrived, so the pair is a real trip of about `nights` nights.
          const outDay = dayOf(out.first.outbound.departureTime);
          const arrived = out.second.outbound.arrivalTime;
          const bFrom = addDays(outDay, minNights) < dayOf(arrived) ? dayOf(arrived) : addDays(outDay, minNights);
          const bTo = addDays(outDay, maxNights) < bFrom ? bFrom : addDays(outDay, maxNights);
          const [b1, b2] = await Promise.all([
            live({ flyFrom: flyTo, flyTo: hub.code, departureDate: kiwiDate(bFrom), departureDateTo: kiwiDate(bTo) }),
            live({ flyFrom: hub.code, flyTo: flyFrom, departureDate: kiwiDate(bFrom), departureDateTo: kiwiDate(addDays(bTo, 1)) }),
          ]);
          if (!b1 || !b2) return;
          back = pairLegs(b1.itineraries, b2.itineraries, hub.sameDayOnly, (first) => Date.parse(first.outbound.departureTime) >= Date.parse(arrived) && nightsOk(daysBetween(outDay, dayOf(first.outbound.departureTime))));
          if (!back) {
            hubsDone.push(hub.code);
            return;
          }
        }
        hubsDone.push(hub.code);
        const oa = accA().get(out.first.outbound.from);
        const ob = accB().get(out.second.outbound.to);
        if (!oa || !ob) return;
        const legs: RouteLeg[] = [];
        const inA = accessLeg(A, oa, true);
        if (inA) legs.push(inA);
        legs.push(flyLeg(out.first.outbound, Math.round(out.first.price), out.first.bookingUrl));
        // Two airports of the hub: the road between them is a leg of its own, priced and timed as an estimate.
        if (out.transfer) legs.push(out.transfer);
        legs.push({ ...flyLeg(out.second.outbound, Math.round(out.second.price), out.second.bookingUrl), note: `second ticket, ${hubWait(out, hub.name)}` });
        const outB = accessLeg(B, ob, false);
        if (outB) legs.push(outB);
        let backLegs: RouteLeg[] | undefined;
        let backTotal: number | undefined;
        if (back) {
          const bb = accB().get(back.first.outbound.from);
          const ba = accA().get(back.second.outbound.to);
          backLegs = [];
          const l1 = bb ? accessLeg(B, bb, true) : null;
          const l2 = ba ? accessLeg(A, ba, false) : null;
          if (l1) backLegs.push(l1);
          backLegs.push(flyLeg(back.first.outbound, Math.round(back.first.price), back.first.bookingUrl));
          if (back.transfer) backLegs.push(back.transfer);
          backLegs.push({ ...flyLeg(back.second.outbound, Math.round(back.second.price), back.second.bookingUrl), note: `second ticket, ${hubWait(back, hub.name)}` });
          if (l2) backLegs.push(l2);
          // The way back's share of the total: its two tickets and its ground estimates (the change of airport among them).
          backTotal = Math.round(back.total + groundSum(backLegs));
        }
        const flights = out.total + (back?.total ?? 0);
        // The transfer legs are ground, so they are in this sum and in the total.
        const ground = groundSum(legs) + (backLegs ? groundSum(backLegs) : 0);
        // Hours: the access legs, then the two flights and the wait at the hub (one clock, the
        // change of airport inside it), so the transfer's minutes are not counted twice.
        const access = [inA, outB].filter((l): l is RouteLeg => !!l);
        const hours = r1((sumMinutes(access) + pairMinutes(out) + CHECK_IN_MIN + LANDING_MIN) / 60);
        const stops = 1 + out.first.outbound.stops + out.second.outbound.stops;
        const nightsThere = back ? daysBetween(dayOf(out.first.outbound.departureTime), dayOf(back.first.outbound.departureTime)) : null;
        const changes = [out.transfer, back?.transfer].filter((t): t is RouteLeg => !!t);
        const changeWhy = changes.length ? `; a change of airport at ${hub.name} (${changes.map((t) => `${t.from} to ${t.to}, about ${t.minutes} min and ${t.price} euro by road, estimated`).join("; ")})` : "";
        const o = finish({ kind: "via-hub", legs, back: backLegs, backTotal, total: Math.round(flights + ground), hours, stops, title: `Via ${hub.name} on two tickets${changes.length ? " (change of airport)" : ""}`, why: `${Math.round(flights)} euro in ${back ? "four" : "two"} tickets; a self transfer at ${hub.name}, your own risk if the first flight is late${changeWhy}; ${hours} h door to door${nightsThere != null ? `; out ${dayOf(out.first.outbound.departureTime)}, back ${dayOf(back!.first.outbound.departureTime)}, ${nightsThere} nights` : `; out ${dayOf(out.first.outbound.departureTime)}`}`, nonstop: false });
        emit(o);
        sources.add("live");
        say(`Via ${hub.name}: ${o.total} euro`);
      }),
    );
  }
  if (hubs.length) considered.push(`hubs ${list(hubs.map((h) => h.code))}${hubsDone.length < hubs.length ? ` (${hubsDone.length} searched, budget ${budget})` : ""}`);
  if (resume) considered.push(`extended: ${spentBefore} search${spentBefore === 1 ? "" : "es"} kept from the answer of ${Math.max(1, Math.round((Date.now() - resume.at) / 60_000))} min ago, ${searched - spentBefore} made now`);

  options.sort((a, b) => a.score - b.score);
  const result = assemble();
  // Complete when nothing failed and nothing was left out, whatever the reason (the budget,
  // the deadline, the breaker): only then can every later ask be served as is.
  const complete = failed === 0 && skipped === 0 && refused === 0 && hubsDone.length >= hubs.length;
  const stage: Stage | null = mainDone ? { A, B, aAcc, bAcc, from, to, hubs, hubsDone, options: [...options], considered: consideredBase, sources: [...sources], searched, at: Date.now() } : null;
  // The usage log, never awaited and never personal: codes and numbers, no labels or coordinates.
  void logSearch("route", { from: aAcc.map((a) => a.code), to: bAcc.map((a) => a.code), depart, flex, nights: oneWay ? 0 : nights, oneWay, maxHours: q.maxHours ?? 0, excluded: exclude.length, budget, searched, failed, options: options.length, extended: !!resume }, options.length, Date.now() - t0).catch(() => null);
  say(`Done: ${options.length} way${options.length === 1 ? "" : "s"}, ${searched} live search${searched === 1 ? "" : "es"}${resume ? ` (${searched - spentBefore} new)` : ""}${failed ? `, ${failed} failed` : ""}.`);
  return done(result, stage, complete);

  /** The result from the options as they stand: the extremes, the skipped line, the note. */
  function assemble(): RouteResult {
    const cheapest = options.length ? options.reduce((m, o) => (o.total < m.total ? o : m)) : null;
    const fastest = options.length ? options.reduce((m, o) => (o.hours < m.hours ? o : m)) : null;
    const late = timeLeft() <= 0;
    const lines = [...considered];
    if (refused) lines.push(`${refused} search${refused > 1 ? "es" : ""} not made while Kiwi throttles this address`);
    if (skipped) lines.push(late ? `${skipped} search${skipped > 1 ? "es" : ""} not made: the run reached its ${Math.round(deadlineMs / 1000)} s limit` : `${skipped} search${skipped > 1 ? "es" : ""} skipped at the budget of ${budget}`);
    if (timedOut) lines.push(`${timedOut} search${timedOut > 1 ? "es" : ""} took longer than ${SEARCH_CAP_MS / 1000} s and ${timedOut > 1 ? "were" : "was"} not waited for`);
    /** No live search answered in this run: nothing new beyond the memory, the graph and what an extension kept. */
    const nothingLive = searched === spentBefore;
    let note: string | undefined;
    if (searched === 0 && failed > 0) note = kiwiThrottled() ? "Kiwi is throttling live searches from this address right now; only remembered fares and ground routes are shown. Try again in a few minutes." : `${failed} live search${failed > 1 ? "es" : ""} failed; only remembered fares and ground routes are shown.`;
    // The breaker was already open when the run started: the right advice is to wait, not to
    // change the dates, and an extension says the stored answer stands as it was.
    else if (nothingLive && refused > 0) note = `Kiwi is throttling live searches from this address right now; ${resume ? "the answer found earlier is shown as it was" : "only remembered fares and ground routes are shown"}. Try again in a few minutes.`;
    else if (!options.length) note = budget === 0 ? "Nothing remembered between these places and no ground route; a live search would be needed." : "No way found in that window. Try other dates or a wider flex.";
    else if (late || timedOut) note = `Kiwi was slow today: ${options.length} way${options.length === 1 ? "" : "s"} found before the run reached its time limit; some hub options may be missing. Ask again in a minute for the rest.`;
    return { ...ends(), options, cheapest, fastest, searched, failed, considered: lines, sources: [...sources], note, generatedAt: at() };
  }
}

function nightsOfIt(it: KiwiItinerary): number | null {
  if (!it.inbound) return null;
  return Math.round((Date.parse(dayOf(it.inbound.departureTime)) - Date.parse(dayOf(it.outbound.departureTime))) / 86_400_000);
}

/** A remembered fare as an itinerary-shaped option: dates known, times unknown, one fly leg marked `remembered`. */
function rememberedOption(f: RememberedFare, build: (it: { price: number; url: string; out: KiwiLeg; back?: KiwiLeg }, remembered: boolean) => RouteOption | null): RouteOption | null {
  const km = (() => {
    const a = resolveGateway(f.src);
    const b = resolveGateway(f.dst);
    return a && b ? haversineKm(a.lat, a.lon, b.lat, b.lon) : 1000;
  })();
  const minutes = Math.round(35 + (km / 800) * 60 + f.stops * 120);
  const leg = (from: string, to: string, day: string): KiwiLeg => ({ from, to, departureTime: `${day}T00:00:00`, arrivalTime: `${day}T00:00:00`, durationSeconds: minutes * 60, stops: f.stops, route: [from, to], segments: f.carriers.map((c) => ({ from, to, fromCity: "", toCity: "", fromCountry: "", toCountry: "", carrier: c, carrierName: c, flightNumber: "", departureTime: "", arrivalTime: "", durationSeconds: 0 })) });
  const o = build({ price: f.price, url: f.url, out: leg(f.src, f.dst, f.out), back: f.back ? leg(f.dst, f.src, f.back) : undefined }, true);
  if (!o) return null;
  for (const l of [...o.legs, ...(o.back ?? [])]) if (l.kind === "fly") {
    l.depart = undefined;
    l.arrive = undefined;
    l.estimated = true;
    l.remembered = true;
    l.note = `${l.note ?? ""}; remembered fare, times not known`.replace(/^; /, "");
  }
  return o;
}

/** Two tickets through a hub: `total` is the tickets alone; `transfer` the road between two airports of the hub when the tickets use different ones. */
export type HubPair = { first: KiwiItinerary; second: KiwiItinerary; total: number; transfer?: RouteLeg };

/**
 * The cheapest pairing of a first ticket and a second one that leaves after it, the same day
 * or the next, with at least two hours to change, plus the road between the airports when
 * the first lands at one airport of the hub and the second leaves from another (its price
 * counts in the choice, its minutes in the wait needed). Two airports the data cannot join by
 * road are not a pair. `okFirst` filters the first tickets (the way back must leave after
 * the outbound has arrived and make the right number of nights). Exported for tests only.
 */
export function pairLegs(firsts: KiwiItinerary[], seconds: KiwiItinerary[], sameDayOnly: boolean, okFirst: (first: KiwiItinerary) => boolean = () => true): HubPair | null {
  let best: HubPair | null = null;
  let bestCost = Infinity;
  for (const first of firsts) {
    if (!okFirst(first)) continue;
    const arrive = first.outbound.arrivalTime;
    const arriveDay = dayOf(arrive);
    for (const second of seconds) {
      const dep = second.outbound.departureTime;
      const gap = minutesBetween(arrive, dep);
      if (!Number.isFinite(gap)) continue;
      let transfer: RouteLeg | undefined;
      if (first.outbound.to !== second.outbound.from) {
        const t = airportChange(first.outbound.to, second.outbound.from);
        if (!t) continue;
        transfer = t;
      }
      if (gap < MIN_CONNECT_MIN + (transfer?.minutes ?? 0)) continue;
      const depDay = dayOf(dep);
      if (depDay !== arriveDay && (sameDayOnly || depDay !== addDays(arriveDay, 1))) continue;
      const total = first.price + second.price;
      const cost = total + (transfer?.price ?? 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = { first, second, total, ...(transfer ? { transfer } : {}) };
      }
    }
  }
  return best;
}

type Hub = { code: string; name: string; /** A hub in a visited country: a same-day connection only, never a night there. */ sameDayOnly: boolean };

/**
 * Up to four hubs between the points: the origin's stored board's cheapest big cities that are
 * not too far off the line, then the biggest hubs whose detour over the great circle is under
 * 35 percent. A hub needs to be a real distance from both ends to be worth a second ticket.
 */
async function pickHubs(A: Place, B: Place, aAcc: Access[], exclude: string[]): Promise<Hub[]> {
  const dAB = haversineKm(A.lat, A.lon, B.lat, B.lon);
  if (dAB < 400) return [];
  const detourOf = (c: City) => (haversineKm(A.lat, A.lon, c.lat, c.lon) + haversineKm(c.lat, c.lon, B.lat, B.lon)) / dAB - 1;
  const farEnough = (c: City) => haversineKm(A.lat, A.lon, c.lat, c.lon) > 150 && haversineKm(c.lat, c.lon, B.lat, B.lon) > 150;
  const aCodes = new Set(aAcc.map((a) => a.code));
  const usable = (c: City) => farEnough(c) && !c.airports.some((x) => aCodes.has(x)) && c.country !== B.country;
  const out: Hub[] = [];
  const push = (code: string) => {
    const c = CITIES[code];
    if (!c || out.some((h) => h.code === code) || !usable(c)) return;
    out.push({ code, name: c.name, sameDayOnly: !countryAllowed(c.country, exclude) });
  };
  if (aAcc.length) {
    try {
      const board = await readBoard(mainGateway(aAcc.map((a) => a.code)));
      const cheap = [...(board?.board.deals ?? [])].sort((a, b) => a.price - b.price);
      let added = 0;
      for (const d of cheap) {
        const c = CITIES[d.dstCity];
        if (!c || hubDegree(d.dstCity) < 60 || detourOf(c) > BOARD_HUB_DETOUR) continue;
        push(d.dstCity);
        if (++added >= 2) break;
      }
    } catch {
      // no board: the degree-ranked list alone
    }
  }
  const ranked = Object.entries(CITIES)
    .filter(([code, c]) => hubDegree(code) >= 40 && detourOf(c) <= HUB_DETOUR)
    .sort((a, b) => hubDegree(b[0]) - hubDegree(a[0]));
  for (const [code] of ranked) {
    if (out.length >= MAX_HUBS) break;
    push(code);
  }
  return out.slice(0, MAX_HUBS);
}

/** Where an overland link's end is: a city of cities.json or an overland town. */
function overlandPoint(code: string): { lat: number; lon: number; name: string } | null {
  const c = CITIES[code];
  if (c) return { lat: c.lat, lon: c.lon, name: c.name };
  const t = overlandTown(code);
  return t ? { lat: t.lat, lon: t.lon, name: t.name } : null;
}

/**
 * A sourced overland link between the two (public/data/overland*.json: Lima to Cusco by coach, Cusco to Aguas
 * Calientes by train), each end within 25 km of the place: the cheapest, at the middle of its fare range, marked
 * estimated, with its operator and booking page. Null when no link joins them.
 */
function overlandOnly(A: Place, B: Place, oneWay: boolean): RouteOption | null {
  let best: { link: (typeof OVERLAND)[number]; a: number; b: number } | null = null;
  for (const link of OVERLAND) {
    const pa = overlandPoint(link.from);
    const pb = pa ? overlandPoint(link.to) : null;
    if (!pa || !pb) continue;
    const a = haversineKm(pa.lat, pa.lon, A.lat, A.lon);
    if (a > 25) continue;
    const b = haversineKm(pb.lat, pb.lon, B.lat, B.lon);
    if (b > 25) continue;
    if (!best || link.price < best.link.price) best = { link, a, b };
  }
  if (!best) return null;
  const l = best.link;
  const kind: RouteLeg["kind"] = l.mode === "train" ? "train" : l.mode === "ferry" ? "ferry" : "coach";
  const leg: RouteLeg = { kind, from: A.label, fromName: A.label, to: B.label, toName: B.label, minutes: l.minutes, price: l.price, estimated: true, ...(l.operator ? { carrier: l.operator } : {}), ...(l.book ? { url: l.book } : {}), note: `typical fare ${l.low} to ${l.high} euro${l.overnight ? ", overnight" : ""}; ${l.note}`.slice(0, 300) };
  const hours = r1(l.minutes / 60);
  const back = oneWay ? undefined : [{ ...leg, from: B.label, fromName: B.label, to: A.label, toName: A.label, note: "the same way back, if it runs both ways; check the operator" }];
  return finish({ kind: "ground-only", legs: [leg], back, backTotal: back ? l.price : undefined, total: l.price * (oneWay ? 1 : 2), hours, stops: 0, title: `${modeWord[kind]} from ${A.label} to ${B.label}`, why: `No flight needed: about ${hours} h by ${kind}${l.operator ? ` (${l.operator})` : ""}, ${l.low} to ${l.high} euro each way, a typical fare from the operators' and travellers' pages; check before you go` });
}

/**
 * Train, coach or ferry all the way, from the graph: Dijkstra from A to the stations near B,
 * the last hop to the door estimated. The return is the same way back, same minutes.
 */
function groundOnly(A: Place, B: Place, oneWay: boolean): RouteOption | null {
  let r: ReturnType<typeof reachFrom>;
  try {
    r = reachFrom(A.lat, A.lon, GROUND_ONLY_MIN, 40);
  } catch {
    return null;
  }
  let best: { minutes: number; mode: string; changes: number; name: string; last: number } | null = null;
  for (const s of r.reached) {
    const km = haversineKm(s.lat, s.lon, B.lat, B.lon);
    if (km > 25) continue;
    const minutes = s.minutes + (km < 1.5 ? 10 : driveMinutes(km) + 10);
    if (!best || minutes < best.minutes) best = { minutes, mode: s.mode, changes: s.changes, name: s.name, last: Math.round(km) };
  }
  if (!best || best.minutes > GROUND_ONLY_MIN) return null;
  const km = haversineKm(A.lat, A.lon, B.lat, B.lon);
  const kind: RouteLeg["kind"] = best.mode === "rail" ? "train" : best.mode === "ferry" ? "ferry" : "coach";
  const price = groundPrice(km * 1.2);
  const leg: RouteLeg = { kind, from: A.label, fromName: A.label, to: B.label, toName: B.label, minutes: Math.round(best.minutes), price, estimated: true, note: `${best.changes ? `${best.changes} change${best.changes > 1 ? "s" : ""}` : "no change"}, arriving at ${best.name}; expected time from the timetable's frequency, not a booking` };
  const hours = r1(best.minutes / 60);
  const back = oneWay ? undefined : [{ ...leg, from: B.label, fromName: B.label, to: A.label, toName: A.label, note: "the same way back" }];
  return finish({ kind: "ground-only", legs: [leg], back, backTotal: back ? price : undefined, total: price * (oneWay ? 1 : 2), hours, stops: best.changes, title: `${modeWord[kind]} from ${A.label} to ${B.label}`, why: `No flight needed: about ${hours} h by ${kind}${best.changes ? ` with ${best.changes} change${best.changes > 1 ? "s" : ""}` : ""}; about ${price} euro each way, estimated at ${EURO_PER_KM * 100} cents a km` });
}

/** The road when the graph has no path over a short distance: a drive or a taxi, all estimated. */
function roadOnly(A: Place, B: Place, oneWay: boolean): RouteOption | null {
  const km = haversineKm(A.lat, A.lon, B.lat, B.lon);
  if (km > 300) return null;
  const minutes = driveMinutes(km);
  const price = groundPrice(km * 1.3);
  const leg: RouteLeg = { kind: "road", from: A.label, fromName: A.label, to: B.label, toName: B.label, minutes, price, estimated: true, note: `About ${Math.round(km * 1.3)} km by road; the ground graph has no train or coach for this pair` };
  const hours = r1(minutes / 60);
  const back = oneWay ? undefined : [{ ...leg, from: B.label, fromName: B.label, to: A.label, toName: A.label, note: "the same way back" }];
  return finish({ kind: "ground-only", legs: [leg], back, backTotal: back ? price : undefined, total: price * (oneWay ? 1 : 2), hours, stops: 0, title: `Drive from ${A.label} to ${B.label}`, why: `About ${hours} h by road, roughly ${price} euro each way in fuel or a shared ride, estimated` });
}
