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
import { haversineKm } from "./geo";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "./kiwi";
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

export function toDeal(gw: string, it: KiwiItinerary, nights: number): Deal {
  const dst = it.outbound.to;
  const last = it.outbound.segments.at(-1);
  const city = cityOf.get(dst) ?? dst;
  const carriers = [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))];
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
