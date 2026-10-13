// Server-only. A board is the cheapest return getaways from one home airport (or city) over a
// date window: real Kiwi.com prices with booking links. The same code serves the nightly job
// (popular airports worldwide) and the live route (any other airport a visitor starts from).
//
// Kiwi's search accepts a country as the destination and answers with its 15 cheapest
// itineraries, so a board is one search per nearby country plus one per big city in the
// large countries, about 35 searches, instead of one per destination city.
import citiesJson from "@/public/data/cities.json";
import airportsJson from "@/public/data/airports.json";
import routesJson from "@/public/data/routes-openflights.json";
import countriesJson from "@/public/data/countries.json";
import { driveMinutes, haversineKm } from "./geo";
import { reachFrom } from "./ground";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "./kiwi";
import { TtlLru } from "./memo";
import type { Airport, City, CountryInfo, Deal, Route } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const AIRPORTS = airportsJson as unknown as Airport[];
const ROUTES = routesJson as unknown as Route[];
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
/** Countries under a full travel warning (German Foreign Office) are not getaways. */
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;

export type Board = {
  gateway: string;
  /** Where the gateway is, so a client can draw it without an airport lookup. */
  lat: number;
  lon: number;
  label: string;
  country: string;
  updated: string;
  window: { from: string; to: string };
  nights: [number, number];
  month?: string;
  deals: Deal[];
  searched: number;
  failed: number;
  /** True when the search stopped early (throttled); the board is partial. */
  partial?: boolean;
};

export const MIN_NIGHTS = 2;
export const MAX_NIGHTS = 7;
const WINDOW_DAYS = 45;
const KEEP_PER_CITY = 3;
const NEAR_COUNTRIES = 28;
const MAX_STREAK = 6;
/** Countries wide enough that one search returns only a corner of them. */
const BIG = new Set(["US", "CA", "BR", "AU", "CN", "IN", "RU", "MX", "AR", "ID", "SA", "KZ", "ZA"]);
const BIG_CITIES = 8;
const BIG_CITY_KM = 4000;

const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);
const airportByIata = new Map(AIRPORTS.map((a) => [a.iata, a]));
const sizeOf = (iata: string) => airportByIata.get(iata)?.size ?? "small";

/** Cities with a large or medium airport: the places a getaway can land. */
const DEST_CITIES = Object.entries(CITIES).filter(([, c]) => c.airports.some((a) => sizeOf(a) !== "small"));

/** Distinct destinations per city in the 2014 network: a stand-in for how big a hub it is. */
const degree = new Map<string, number>();
{
  const perAirport = new Map<string, Set<string>>();
  for (const r of ROUTES) {
    const s = perAirport.get(r.src) ?? new Set<string>();
    s.add(r.dst);
    perAirport.set(r.src, s);
  }
  for (const [code, c] of Object.entries(CITIES)) degree.set(code, Math.max(0, ...c.airports.map((a) => perAirport.get(a)?.size ?? 0)));
}
export function hubDegree(cityCode: string): number {
  return degree.get(cityCode) ?? 0;
}

/**
 * How likely a traveller at `near` means this city when several share its name: its size against its distance,
 * population over (1 + km / 2000) squared. Sydney is Australia's from Brasov (Sydney, Nova Scotia is nearer and 50
 * times smaller, and the search once flew the owner there over America, 2026-10-13); Melbourne is Australia's, not
 * Florida's; Cordoba and Valencia are Spain's from Europe; Santiago is Chile's; London is England's even from Toronto.
 */
export function cityLikeliness(cityCode: string, near?: { lat: number; lon: number }): number {
  const c = CITIES[cityCode];
  if (!c) return 0;
  const size = c.pop ?? Math.max(20_000, hubDegree(cityCode) * 20_000);
  const km = near ? haversineKm(near.lat, near.lon, c.lat, c.lon) : 0;
  return size / (1 + km / 2000) ** 2;
}

/** Of a visitor's airports, the one with the most flights (Otopeni over Ghimbav): the key a trip is stored under. */
export function mainGateway(codes: string[]): string {
  return [...codes].sort((a, b) => hubDegree(cityOf.get(b) ?? b) - hubDegree(cityOf.get(a) ?? a))[0] ?? codes[0];
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const NAME_OVERRIDES: Record<string, string> = { HK: "Hong Kong", MO: "Macau", CD: "Democratic Republic of the Congo", CG: "Republic of the Congo", MM: "Myanmar", CI: "Ivory Coast", PS: "Palestine", VA: "Rome" };
export function countryLabel(code: string): string {
  if (NAME_OVERRIDES[code]) return NAME_OVERRIDES[code];
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The place a board starts from: an airport code, or a city code for multi-airport cities. */
export function resolveGateway(code: string): { code: string; lat: number; lon: number; label: string; country: string } | null {
  const c = CITIES[code];
  if (c) return { code, lat: c.lat, lon: c.lon, label: c.name, country: c.country };
  const a = airportByIata.get(code);
  if (a) return { code, lat: a.lat, lon: a.lon, label: a.city ?? a.name, country: a.country };
  return null;
}

/** Large-airport cities per country: how much there is to fly to. */
const hubsPerCountry = new Map<string, number>();
for (const [, c] of DEST_CITIES) if (c.airports.some((a) => sizeOf(a) === "large")) hubsPerCountry.set(c.country, (hubsPerCountry.get(c.country) ?? 0) + 1);

/**
 * What to search for a gateway: nearby countries, big cities in the large countries, extras.
 * Countries rank by distance discounted for how many hubs they have, so Greece beats Jersey
 * from Lisbon; places without a large airport are not worth a search of their own.
 */
export function targetsFor(lat: number, lon: number, home: string, extraCities: string[] = []): string[] {
  const nearest = new Map<string, number>();
  for (const [, c] of DEST_CITIES) {
    if (!hubsPerCountry.has(c.country) || unsafe(c.country)) continue;
    const km = haversineKm(lat, lon, c.lat, c.lon);
    if (km < 40) continue;
    const prev = nearest.get(c.country);
    if (prev == null || km < prev) nearest.set(c.country, km);
  }
  const score = (cc: string, km: number) => km / Math.sqrt(hubsPerCountry.get(cc) ?? 1);
  const countries = [...nearest.entries()].sort((a, b) => score(a[0], a[1]) - score(b[0], b[1])).slice(0, NEAR_COUNTRIES).map(([cc]) => cc);
  if (!countries.includes(home) && nearest.has(home)) countries.unshift(home);
  const targets: string[] = ["anywhere", ...countries.map(countryLabel)];
  // A wide country answers with one corner; its real hubs get a search each, nearest countries only.
  let bigAdded = 0;
  for (const cc of countries.slice(0, 8)) {
    if (!BIG.has(cc) || bigAdded >= 16) continue;
    const big = DEST_CITIES.filter(([code, c]) => c.country === cc && hubDegree(code) >= 40 && haversineKm(lat, lon, c.lat, c.lon) > 40 && haversineKm(lat, lon, c.lat, c.lon) < BIG_CITY_KM)
      .sort((a, b) => hubDegree(b[0]) - hubDegree(a[0]))
      .slice(0, BIG_CITIES)
      .map(([code]) => code);
    targets.push(...big);
    bigAdded += big.length;
  }
  for (const x of extraCities) if (!targets.includes(x)) targets.push(x);
  return targets;
}

export function windowFor(month?: string): { from: string; to: string } {
  const earliest = new Date(Date.now() + 2 * 86_400_000);
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const last = new Date(Date.UTC(y, m, 0));
    const from = first > earliest ? first : earliest;
    if (from <= last) return { from: from.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  }
  return { from: earliest.toISOString().slice(0, 10), to: new Date(earliest.getTime() + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10) };
}

/**
 * Kiwi sells "returns" that land in one city and fly home from another: for Greece, 13 of 15
 * answers on 10 October 2026, and for "anywhere" from Brasov all 15 on 12 October. That is a
 * fine two-city trip when the two are a few hours apart by land (Brussels in, Amsterdam out)
 * and nonsense when they are not: Thessaloniki in and Corfu out looks like 280 km on a map but
 * is a coach to Igoumenitsa and a ferry, about seven hours. So the trip between is timed on the
 * ground graph (16,000 train, coach and ferry stations), never guessed from the straight line
 * when the graph knows it, and the ticket is kept only when the graph gets there in four hours.
 * The road is trusted only where the graph has no stations at either airport and both are in
 * the same country (a corner the feeds do not cover), and then they must be within 120 km by
 * road. Anywhere else a missing path means no getaway: the graph has the ports and the ferries,
 * so "no path" between Kos and Bodrum, or Samos and Izmir, is a border and a seasonal boat,
 * not a 75-minute drive. Past OPEN_JAW_MAX_KM in a straight line the graph is not even asked:
 * no train, coach or ferry covers that in four hours (Madrid to Barcelona, 480 km, is two and
 * a half on the AVE).
 */
export const OPEN_JAW_MAX_KM = 700;
/** A split ticket (or two one-ways from two cities) is a getaway when the graph gets between them in this. */
export const SPLIT_MAX_MIN = 240;
/** Where the graph has no stations at either airport (same country), the two must be this close by road. */
export const SPLIT_ROAD_MAX_KM = 120;
/** Straight line to road kilometres, the factor driveMinutes uses. */
const ROAD_FACTOR = 1.3;
/**
 * How far the graph is walked from an airport: well past four hours, so "a long way by land"
 * (Thessaloniki to Sofia, five and a half hours) is told apart from "the graph has no path"
 * (Crete, whose coaches are not in the feeds). One walk is 10 to 90 ms and is memoised.
 */
const GAP_GRAPH_MIN = 600;
/** Stations within this distance of an airport are its ways onto and off the graph. */
const STATION_KM = 20;
/** Minutes added for getting off at the last station and on to the airport, besides the drive. */
const EGRESS_MIN = 5;
const GAP_TTL_MS = 6 * 3_600_000;

/** A place on the ground graph: a memo key and where it is. */
export type GraphEnd = { key: string; lat: number; lon: number };
/**
 * The trip between two airports by land: minutes, the straight line in km, and how it was
 * timed. "none" is no way by land that we trust (minutes is Infinity): never a getaway.
 */
export type GroundGap = { minutes: number; km: number; by: "graph" | "road" | "none" };

// Memos: a walk is a typed array of minutes per station (64 KB), so only a few dozen are kept;
// the answers per airport pair are small and kept by the thousand.
const walkMemo = new TtlLru<Float32Array>(48, GAP_TTL_MS);
const nearMemo = new TtlLru<{ id: number; minutes: number }[]>(2000, GAP_TTL_MS);
const gapMemo = new TtlLru<GroundGap | null>(20_000, GAP_TTL_MS);

/** Minutes from a place to every station the graph reaches from it in GAP_GRAPH_MIN (Infinity when not). */
function walkFrom(end: GraphEnd, accessKm: number): Float32Array {
  const key = `${end.key}:${accessKm}`;
  const hit = walkMemo.get(key);
  if (hit) return hit;
  const r = reachFrom(end.lat, end.lon, GAP_GRAPH_MIN, accessKm);
  const minutes = new Float32Array(r.stations).fill(Number.POSITIVE_INFINITY);
  // The start stations count too: two airports a short drive apart share one.
  for (const s of r.starts) minutes[s.id] = Math.min(minutes[s.id], s.minutes);
  for (const s of r.reached) minutes[s.id] = Math.min(minutes[s.id], s.minutes);
  walkMemo.set(key, minutes);
  return minutes;
}

/** The stations within STATION_KM of a place, with the drive from each to it. */
function stationsNear(end: GraphEnd): { id: number; minutes: number }[] {
  const hit = nearMemo.get(end.key);
  if (hit) return hit;
  // A walk of zero minutes is just the list of stations around the point.
  const near = reachFrom(end.lat, end.lon, 0, STATION_KM).starts.map((s) => ({ id: s.id, minutes: s.minutes }));
  nearMemo.set(end.key, near);
  return near;
}

/**
 * Minutes by train, coach or ferry from one place to another on the ground graph (with the
 * drive to the first station and from the last), or null when the graph has no path within
 * ten hours: no station near one of them, or no line between. Exported for lib/pairs.ts, which
 * times the traveller's own point to a home airport with it (accessKm 40, as route-finder does).
 */
export function graphMinutes(from: GraphEnd, to: GraphEnd, accessKm = STATION_KM): number | null {
  const near = stationsNear(to);
  if (!near.length) return null;
  const walk = walkFrom(from, accessKm);
  let best = Number.POSITIVE_INFINITY;
  for (const s of near) {
    const m = walk[s.id] + s.minutes + EGRESS_MIN;
    if (m < best) best = m;
  }
  return Number.isFinite(best) ? Math.round(best) : null;
}

/** An airport or city code as a place on the graph. */
export function graphEnd(code: string): GraphEnd | null {
  const a = airportByIata.get(code);
  if (a) return { key: code, lat: a.lat, lon: a.lon };
  const c = CITIES[code];
  return c ? { key: code, lat: c.lat, lon: c.lon } : null;
}

/** The city code an airport belongs to (BGY and MXP are both MIL), or the code itself. */
export function airportCity(code: string): string {
  return cityOf.get(code) ?? code;
}

/**
 * The trip by land between two airports, timed on the ground graph when it has a path and by
 * road over the straight line when it does not. Memoised per ordered pair. Null when our data
 * cannot place one of the airports.
 */
export function groundGap(from: string, to: string): GroundGap | null {
  const key = `${from}>${to}`;
  const hit = gapMemo.get(key);
  if (hit !== undefined) return hit;
  const a = graphEnd(from);
  const b = graphEnd(to);
  let gap: GroundGap | null = null;
  if (a && b) {
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const graph = km <= OPEN_JAW_MAX_KM ? graphMinutes(a, b) : null;
    if (graph != null) gap = { minutes: graph, km, by: "graph" };
    // The road only where the feeds have nothing at either end, inside one country: a
    // straight line across a sea or a border is not a drive (Kos to Bodrum is 72 km on a map).
    else if (km <= OPEN_JAW_MAX_KM && roadTrusted(from, a, to, b)) gap = { minutes: driveMinutes(km), km, by: "road" };
    else gap = { minutes: Number.POSITIVE_INFINITY, km, by: "none" };
  }
  gapMemo.set(key, gap);
  return gap;
}

/** The country an airport or city code is in, or "" when our data does not know it. */
function countryOfCode(code: string): string {
  return airportByIata.get(code)?.country ?? CITIES[code]?.country ?? CITIES[cityOf.get(code) ?? ""]?.country ?? "";
}

/**
 * Whether a road estimate may stand in for the graph between two places: both in the same
 * known country and neither with a station (train, coach or ferry port) within STATION_KM.
 * When the graph has stations at an end and still no path, the graph is the better witness.
 */
function roadTrusted(fromCode: string, a: GraphEnd, toCode: string, b: GraphEnd): boolean {
  const ca = countryOfCode(fromCode);
  if (!ca || ca !== countryOfCode(toCode)) return false;
  return !stationsNear(a).length && !stationsNear(b).length;
}

/**
 * The trip by land between two places of one country, for a leg the graph may not know (the
 * traveller's home to an airport): the graph's minutes, else the road when roadTrusted allows
 * it, else null. accessKm is how far the start may be from its first station.
 */
export function landMinutes(from: GraphEnd, to: GraphEnd, sameCountry: boolean, accessKm = STATION_KM): number | null {
  const graph = graphMinutes(from, to, accessKm);
  if (graph != null) return graph;
  if (!sameCountry || stationsNear(from).length || stationsNear(to).length) return null;
  return driveMinutes(haversineKm(from.lat, from.lon, to.lat, to.lon));
}

/** Airports a getaway flies from or to (large or medium, of a city on the globe): code and place. */
const FLIGHT_AIRPORTS = AIRPORTS.filter((a) => a.size !== "small" && cityOf.has(a.iata));

/** Those airports within `km` of a place, nearest first, with the straight line. */
export function airportsWithin(lat: number, lon: number, km: number): { code: string; km: number; country: string }[] {
  const out: { code: string; km: number; country: string }[] = [];
  for (const a of FLIGHT_AIRPORTS) {
    const d = haversineKm(lat, lon, a.lat, a.lon);
    if (d <= km) out.push({ code: a.iata, km: d, country: a.country });
  }
  return out.sort((x, y) => x.km - y.km);
}

/** Every such airport of one country (ISO2). */
export function countryAirports(cc: string): string[] {
  return FLIGHT_AIRPORTS.filter((a) => a.country === cc).map((a) => a.iata);
}

/** The airports of the city an airport belongs to (BGY gives BGY, MXP, LIN), or the code itself. */
export function cityAirports(code: string): string[] {
  return CITIES[airportCity(code)]?.airports ?? [code];
}

/**
 * Whether a trip between two cities is short enough to be part of a getaway: on the graph
 * within `maxMinutes` when the graph knows the way, or within SPLIT_ROAD_MAX_KM by road when it
 * does not.
 */
export function gapFits(g: GroundGap, maxMinutes = SPLIT_MAX_MIN): boolean {
  if (g.by === "graph") return g.minutes <= maxMinutes;
  if (g.by === "none") return false;
  return g.km * ROAD_FACTOR <= SPLIT_ROAD_MAX_KM && g.minutes <= maxMinutes;
}

/** Where the ticket lands, where it flies home from, how far apart those are and how long the trip between takes ("none": no trusted way by land). */
export function ticketGap(it: KiwiItinerary): { land: string; leave: string; landCity: string; leaveCity: string; km: number; minutes?: number; by?: GroundGap["by"] } | null {
  if (!it.inbound) return null;
  const land = it.outbound.to;
  const leave = it.inbound.from;
  const landCity = cityOf.get(land) ?? land;
  const leaveCity = cityOf.get(leave) ?? leave;
  if (land === leave || landCity === leaveCity) return { land, leave, landCity, leaveCity, km: 0 };
  const g = groundGap(land, leave);
  // Two airports our data cannot place: the ticket is not trusted.
  if (!g) return { land, leave, landCity, leaveCity, km: Number.POSITIVE_INFINITY };
  return { land, leave, landCity, leaveCity, km: g.km, minutes: g.minutes, by: g.by };
}

/** A one-way, a plain return, or a return whose two ends the ground graph joins within four hours. */
export function sensibleTicket(it: KiwiItinerary): boolean {
  const g = ticketGap(it);
  if (!g || g.km === 0) return true;
  if (g.minutes == null || !g.by) return false;
  return gapFits({ minutes: g.minutes, km: g.km, by: g.by });
}

export function toDeal(gw: string, it: KiwiItinerary, nights: number): Deal {
  const dst = it.outbound.to;
  const last = it.outbound.segments.at(-1);
  const city = cityOf.get(dst) ?? dst;
  const carriers = [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))];
  const gap = ticketGap(it);
  // Lands in one city, flies home from another: say so on the deal, with the trip between.
  const split =
    gap && gap.km > 0
      ? {
          backFrom: gap.leave,
          backFromCity: CITIES[gap.leaveCity]?.name ?? it.inbound?.segments[0]?.fromCity ?? gap.leave,
          gapKm: Number.isFinite(gap.km) ? Math.round(gap.km) : undefined,
          // The graph's minutes by train, coach or ferry, or the road estimate where it has no
          // path; never a "none" gap (no trusted way by land), which has no minutes to show.
          gapMin: gap.by === "none" ? undefined : gap.minutes,
        }
      : {};
  // The flight home lands at another of the traveller's airports than the one it left from.
  const homeFrom = cityOf.get(it.outbound.from) ?? it.outbound.from;
  const homeTo = it.inbound ? (cityOf.get(it.inbound.to) ?? it.inbound.to) : homeFrom;
  const backTo = it.inbound && homeTo !== homeFrom ? { backTo: it.inbound.to } : {};
  return {
    gw,
    dst,
    dstCity: city,
    city: CITIES[city]?.name ?? last?.toCity ?? dst,
    country: CITIES[city]?.country ?? airportByIata.get(dst)?.country ?? "",
    price: Math.round(it.price),
    out: it.outbound.departureTime.slice(0, 10),
    back: it.inbound?.departureTime.slice(0, 10) ?? "",
    nights,
    stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0),
    carriers,
    outMin: Math.round(it.outbound.durationSeconds / 60),
    backMin: it.inbound ? Math.round(it.inbound.durationSeconds / 60) : 0,
    url: it.bookingUrl,
    bags: it.baggage ? `${it.baggage.cabinBag ? "cabin bag" : "personal item"}` : undefined,
    img: it.imageId,
    ...split,
    ...backTo,
  };
}

/** Keep the cheapest few per destination city, on distinct departure dates, cheapest first. */
export function trimDeals(deals: Deal[]): Deal[] {
  deals.sort((a, b) => a.price - b.price);
  const perCity = new Map<string, Set<string>>();
  const out: Deal[] = [];
  for (const d of deals) {
    const dates = perCity.get(d.dstCity) ?? new Set<string>();
    if (dates.size >= KEEP_PER_CITY || dates.has(d.out)) continue;
    dates.add(d.out);
    perCity.set(d.dstCity, dates);
    out.push(d);
  }
  return out;
}

export type BuildOptions = {
  month?: string;
  /** Extra destination codes searched one by one (the home market's favourites). */
  extraCities?: string[];
  concurrency?: number;
  pauseMs?: number;
  /** Called with each search's deals as they arrive, for streaming. */
  onDeals?: (deals: Deal[], target: string) => void;
  log?: (line: string) => void;
};

export async function buildBoard(gatewayCode: string, opts: BuildOptions = {}): Promise<Board> {
  const resolved = resolveGateway(gatewayCode);
  if (!resolved) throw new Error(`unknown gateway ${gatewayCode}`);
  const gw = resolved;
  const { from, to } = windowFor(opts.month);
  const returnFrom = new Date(Date.parse(from) + MIN_NIGHTS * 86_400_000).toISOString().slice(0, 10);
  const returnTo = new Date(Date.parse(to) + MAX_NIGHTS * 86_400_000).toISOString().slice(0, 10);
  const targets = targetsFor(gw.lat, gw.lon, gw.country, opts.extraCities);
  const queue = [...targets];
  const deals: Deal[] = [];
  let searched = 0;
  let failed = 0;
  let streak = 0;
  let partial = false;
  const own = cityOf.get(gw.code) ?? gw.code;

  async function worker() {
    for (let target = queue.shift(); target; target = queue.shift()) {
      if (streak >= MAX_STREAK) {
        partial = true;
        queue.length = 0;
        break;
      }
      try {
        const r = await searchFlight({ flyFrom: gw.code, flyTo: target, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to), returnDate: kiwiDate(returnFrom), returnDateTo: kiwiDate(returnTo) });
        searched++;
        streak = 0;
        const found = r.itineraries
          .map((it) => ({ it, nights: nightsOf(it) }))
          .filter((x): x is { it: KiwiItinerary; nights: number } => x.nights != null && x.nights >= MIN_NIGHTS && x.nights <= MAX_NIGHTS)
          // In one city and home from one the ground graph does not join within four hours is not a getaway.
          .filter(({ it }) => sensibleTicket(it))
          .map(({ it, nights }) => toDeal(gw.code, it, nights))
          // Not home, and no domestic hop with a connection (a 7-hour way to cross one country).
          .filter((d) => d.dstCity !== own && !(d.country === gw.country && d.stops > 0));
        deals.push(...found);
        opts.onDeals?.(trimDeals(found), target);
      } catch (err) {
        failed++;
        streak++;
        opts.log?.(`${gw.code} → ${target}: ${err instanceof Error ? err.message : err}`);
      }
      if (opts.pauseMs) await new Promise((res) => setTimeout(res, opts.pauseMs));
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));

  return {
    gateway: gw.code,
    lat: gw.lat,
    lon: gw.lon,
    label: gw.label,
    country: gw.country,
    updated: new Date().toISOString(),
    window: { from, to },
    nights: [MIN_NIGHTS, MAX_NIGHTS],
    month: opts.month,
    deals: trimDeals(deals),
    searched,
    failed,
    partial: partial || undefined,
  };
}

/**
 * The airports the nightly job searches: every real hub (60+ destinations in the 2014
 * network), then the best airport of each country still missing when it has 25+.
 */
export function popularGateways(limit: number): string[] {
  const ranked = DEST_CITIES.filter(([code]) => hubDegree(code) > 0).sort((a, b) => hubDegree(b[0]) - hubDegree(a[0]));
  const out: string[] = [];
  const covered = new Set<string>();
  for (const [code, c] of ranked) {
    if (hubDegree(code) < 60) break;
    out.push(code);
    covered.add(c.country);
  }
  for (const [code, c] of ranked) {
    if (covered.has(c.country) || hubDegree(code) < 25) continue;
    out.push(code);
    covered.add(c.country);
  }
  return out.slice(0, limit);
}
