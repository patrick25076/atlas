// Server-only. Everything Atlas can do, as tools the chat agent calls: the boards, the
// period search, the month-by-month scan, live re-pricing, combos, wild trips and their day
// plans, long stays, group trips, climate, the fare memory, sights, events, rated
// restaurants, hotels, one-way fares, trains and coaches, facts, the live web, and one
// widget question. Each answer is compact (a dozen items) so the model reads it whole; the
// deals it returns carry enough to draw cards and pins on the globe. No tool throws: a
// failure comes back as { error } with a one-line reason so the agent can say so and go on.
import { jsonSchema, tool, type JSONValue } from "ai";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import cityPlacesJson from "@/public/data/city-places.json";
import weatherJson from "@/public/data/weather.json";
import visaJson from "@/public/data/visa.json";
import airportsJson from "@/public/data/airports.json";
import fameJson from "@/public/data/fame.json";
import { haversineKm, nearestGateways } from "./geo";
import { reachFrom } from "./ground";
import { dealsFor } from "./deals-source";
import { findDeals } from "./finder";
import { findCombos } from "./combos";
import { kiwiDate, nightsOf, searchFlight } from "./kiwi";
import { buildWild, customKey, wildPath, REGIONS, STOPOVER_PROGRAMMES, type Budget, type Region, type Style, type Tradeoff, type WildTrip } from "./wild";
import { buildWildVariants, VARIANTS } from "./wild-variants";
import { hotelDeals } from "./hotel-deals";
import { purposeTrips } from "./purpose";
import { fareHistory, hasDb } from "./db";
import { judgeTrip } from "./judge";
import { planDays, planPath, type Plan } from "./plan";
import { readJson, writeJson } from "./boards-store";
import { countryGuide, getSights } from "./sights";
import { isNoise, sourcesNear } from "./events/sources";
import { goodValueEats, hasFoursquare, sweetsNear } from "./foursquare";
import { hasLiteApi, hotelsNear, liteApiLive } from "./liteapi";
import { allFares, hasToken } from "./travelpayouts";
import { hasTavily, webSearch } from "./tavily";
import { mainGateway, resolveGateway } from "./board";
import { isGem, type FameFile } from "./gems";
import { scanCheapest, type ScanMonth } from "./scan";
import { longStay } from "./longstay";
import { groupTrip, type GroupMember } from "./group";
import { bestMonths } from "./climate";
import { priceInsight } from "./insights";
import { WIDGET_KINDS, type WidgetKind, type WidgetSpec } from "./chat-widgets";
import { cleanCodes, countryAllowed, filterByCountry, type BeenPrefs } from "./been";
import { expandWeather, visaFor, type Airport, type City, type CityPlaces, type CountryInfo, type Deal, type VisaFile, type WeatherCompact } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const PLACES = cityPlacesJson as unknown as Record<string, CityPlaces>;
const WEATHER = (weatherJson as unknown as WeatherCompact).syms ? expandWeather(weatherJson as unknown as WeatherCompact) : null;
const VISA = visaJson as unknown as VisaFile;
const AIRPORTS = airportsJson as unknown as Airport[];
const FAME = fameJson as unknown as FameFile;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type AgentContext = {
  origin?: { lat: number; lon: number; label: string };
  gateways: string[];
  home: string;
  month?: string;
  today: string;
  /** Kiwi searches this turn may spend; the live tools count what they used and refuse past the cap. */
  budget?: { used: number; max: number };
  /** The countries the traveller has been to, and whether they want only new ones (lib/been.ts). */
  been?: BeenPrefs;
  /** ISO2 countries no search may land or sleep in: the been list when "only new" is on, else empty. */
  exclude?: string[];
};

/** The `exclude` and `allow` inputs every searching tool takes: the same shape and the same
 * words everywhere. `exclude` ADDS to the Been list of the context (it never replaces it), so a
 * partial list from the chat can never re-admit a country the chip excludes; `allow` lifts the
 * filter for named countries only; an explicit [] in exclude lifts the whole filter once. */
const EXCLUDE_PROP = {
  type: "array",
  items: { type: "string" },
  description: "ISO2 countries never to propose as a destination or an overnight stop, ADDED to the traveller's Been list from the context (that list always applies on its own; omit this when there is nothing new to add). A layover or connection through them is always fine. Pass an empty array [] only when the traveller asks to lift the whole filter for this one search; to lift it for some countries only, use allow.",
} as const;
const ALLOW_PROP = {
  type: "array",
  items: { type: "string" },
  description: "ISO2 countries the traveller says are fine again for this one search (removed from the Been filter just this once). Omit otherwise.",
} as const;
const BEEN_PROPS = { exclude: EXCLUDE_PROP, allow: ALLOW_PROP } as const;

/** How many Kiwi searches one chat turn may make: a third of a day's allowance for one address
 * would be gone in three turns otherwise (Kiwi throttles an address after about two thousand). */
export const TURN_SEARCH_BUDGET = 120;

/** "Brașov" and "Brasov" are the same name: compare without accents and case. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
/** Country names, folded, so a country is never mistaken for a city that starts the same way. */
const COUNTRY_NAMES = new Set(Object.values(COUNTRIES).map((c) => fold(c.name)));
const CITY_LIST: [string, City][] = Object.entries(CITIES);
/** Several cities share a name (London, Ontario); the biggest one is the one people mean. */
const byPop = (a: [string, City], b: [string, City]) => (b[1].pop ?? b[1].airports.length) - (a[1].pop ?? a[1].airports.length);

/**
 * A city by name, city code or airport code. The exact name wins (accents ignored), then an
 * upper-case three-letter code, then a whole leading word of the name ("Cluj" finds
 * Cluj-Napoca). A country name is never a city, and nothing is matched inside a name: "Spain"
 * must not become Port Of Spain, "India" Indianapolis, "Goa" Genoa. Null means the caller
 * passes the words through for Kiwi to resolve.
 */
function findCity(name: string): [string, City] | null {
  const raw = (name ?? "").trim();
  const q = fold(raw);
  if (!q) return null;
  if (COUNTRY_NAMES.has(q)) return null;
  const exact = CITY_LIST.filter(([, c]) => fold(c.name) === q).sort(byPop);
  if (exact.length) return exact[0];
  // A code only when written as one (upper case): "LIS" is Lisbon, "Goa" is the city in India.
  if (/^[A-Z]{3}$/.test(raw)) {
    if (CITIES[raw]) return [raw, CITIES[raw]];
    const hit = CITY_LIST.find(([, c]) => c.airports.includes(raw));
    if (hit) return hit;
  }
  if (q.length < 4) return null;
  const leading = CITY_LIST.filter(([, c]) => {
    const n = fold(c.name);
    return n.startsWith(q) && !/[a-z0-9]/.test(n.charAt(q.length));
  }).sort(byPop);
  return leading[0] ?? null;
}

/** What to hand Kiwi as a place: a code stays a code, a city name becomes its code (SFO, LON),
 * anything else (a country, "anywhere") is passed through as written. Never uppercased. */
function placeArg(s: string | undefined, fallback: string): string {
  const raw = (s ?? "").trim();
  if (!raw) return fallback;
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  if (/^[A-Za-z]{3}(,[A-Za-z]{3})+$/.test(raw)) return raw.toUpperCase();
  const hit = findCity(raw);
  if (hit) return hit[1].airports.length === 1 ? hit[1].airports[0] : hit[0];
  return raw;
}
/** The main airport of a city (for the fare memory, which is keyed by airports); "" when the
 * words name no city or airport we know, so callers can say so instead of guessing. */
function airportArg(s: string | undefined, fallback: string): string {
  const raw = (s ?? "").trim();
  if (!raw) return fallback;
  if (/^[A-Za-z]{3}$/.test(raw)) return raw.toUpperCase();
  const hit = findCity(raw);
  return hit ? hit[1].airports[0] : "";
}
/** Airport codes from a list that may hold city names; the fallback only when the list is empty,
 * never when it was given and nothing in it resolved (that is the caller's error to report). */
function codesOf(list: string[] | undefined, fallback: string[]): string[] {
  const given = (list ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!given.length) return [...new Set(fallback)].slice(0, 5);
  const out = given.map((x) => airportArg(x, "")).filter((x) => /^[A-Z]{3}$/.test(x));
  return [...new Set(out)].slice(0, 5);
}

/** The ISO code of a country given by name or code; undefined when it is not a country. */
const countryCode = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  if (/^[A-Za-z]{2}$/.test(s)) return COUNTRIES[s.toUpperCase()] ? s.toUpperCase() : undefined;
  const q = fold(s);
  const hit = Object.entries(COUNTRIES).find(([, c]) => fold(c.name) === q);
  return hit?.[0];
};
/** Where a country is: the mean of its cities, as lib/wild.ts does for "which countries are near". */
const COUNTRY_CENTROID = new Map<string, { lat: number; lon: number }>();
{
  const acc = new Map<string, { lat: number; lon: number; n: number }>();
  for (const [, c] of CITY_LIST) {
    const a = acc.get(c.country) ?? { lat: 0, lon: 0, n: 0 };
    acc.set(c.country, { lat: a.lat + c.lat, lon: a.lon + c.lon, n: a.n + 1 });
  }
  for (const [cc, a] of acc) COUNTRY_CENTROID.set(cc, { lat: a.lat / a.n, lon: a.lon / a.n });
}
/** Where a destination is, as a point: a city we know, else a country's centroid; null otherwise. */
function placePoint(s: string): { lat: number; lon: number } | null {
  const city = findCity(s);
  if (city) return { lat: city[1].lat, lon: city[1].lon };
  const cc = countryCode(s);
  return cc ? (COUNTRY_CENTROID.get(cc) ?? null) : null;
}
/** Long-haul means roughly another continent: over 3,500 km, the Bucharest to Dubai line. */
const LONG_HAUL_KM = 3500;
function weekendMax(code: string): number | null {
  const days = WEATHER?.cities[code];
  if (!days) return null;
  const d = new Date();
  const toSat = (6 - d.getDay() + 7) % 7;
  const sat = new Date(d.getTime() + toSat * 86_400_000).toISOString().slice(0, 10);
  const sun = new Date(d.getTime() + (toSat + 1) * 86_400_000).toISOString().slice(0, 10);
  const t = days.filter((x) => x.d === sat || x.d === sun).map((x) => x.tmax);
  return t.length ? Math.max(...t) : null;
}
const compactDeal = (d: Deal) => ({
  key: `${d.gw}|${d.dst}|${d.out}`,
  city: d.city,
  country: COUNTRIES[d.country]?.name ?? d.country,
  price: d.price,
  perNight: d.nights ? Math.round(d.price / d.nights) : undefined,
  dates: `${d.out} to ${d.back}`,
  nights: d.nights,
  from: d.gw,
  stops: d.stops,
  airline: d.carriers[0],
  flightMinutes: d.outMin,
  homeVia: d.backTo,
  trick: d.trick,
  url: d.url,
});
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const isoDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** Every airport a place means, for the fare memory: a code is itself, a city gives all of its
 * airports (London is LHR, LGW, STN, LTN; at most four), anything else is empty. */
function airportsArg(s: string | undefined, fallback: string[]): string[] {
  const raw = (s ?? "").trim();
  if (!raw) return fallback;
  if (/^[A-Za-z]{3}$/.test(raw)) return [raw.toUpperCase()];
  const hit = findCity(raw);
  return hit ? hit[1].airports.slice(0, 4) : [];
}
/** Ranked variants from the chat: three up to 28 nights, two past that (the wild route does the same). */
const LONG_TRIP_NIGHTS = 28;
const MAX_VARIANTS = 3;
const MAX_VARIANTS_LONG = 2;
/** What one wild variant costs to build when nothing is stored: the way in (origins by countries),
 * the chain and the way home come to about sixty Kiwi searches. Used to size variants by budget. */
const WILD_SEARCHES_PER_VARIANT = 60;
/** Big countries where the way home from another city is worth pricing in the same scan. */
export const OPEN_JAW_COUNTRIES = ["United States", "Canada", "Brazil", "Australia", "China", "India", "Japan", "Indonesia", "Mexico", "Argentina", "Russia"];

/** Wraps a tool body: whatever goes wrong comes back as { error } in one line, never a throw. */
function safe<A, R>(fn: (a: A) => Promise<R>): (a: A) => Promise<R | { error: string }> {
  return async (a) => {
    try {
      return await fn(a);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg.replace(/\s+/g, " ").slice(0, 160) || "failed" };
    }
  };
}

/** The model reads a tool result on every step of every later turn, so the `raw` payload
 * (whole Deal arrays, a WildTrip) only travels to the browser: the compact fields say the same. */
const withoutRaw = ({ output }: { output: unknown }): { type: "json"; value: JSONValue } => {
  if (output && typeof output === "object" && "raw" in output) {
    const { raw: _raw, ...rest } = output as Record<string, unknown>;
    void _raw;
    return { type: "json", value: rest as JSONValue };
  }
  return { type: "json", value: (output ?? null) as JSONValue };
};

/** The city a destination airport belongs to, for pins: cities.json first, then the airports file. */
const CITY_OF_AIRPORT = new Map<string, string>();
for (const [code, c] of CITY_LIST) for (const a of c.airports) CITY_OF_AIRPORT.set(a, code);
const AIRPORT_BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

/** A Deal built by hand from a scan month, so the globe can pin it like any other. Null when the
 * month has no fare, or when the destination is a country and the month does not say which
 * airport the fare lands at (ScanMonth.to; the globe could not place it otherwise). The landing
 * airport is resolved the way lib/board.ts does: cities.json first, then the airports file. */
function dealFromMonth(m: ScanMonth, origins: string[], dstCode: string, dstCity: [string, City] | null, toLabel: string): Deal | null {
  if (m.cheapest == null || !m.out) return null;
  const gw = m.from ?? origins[0] ?? "";
  if (dstCity) {
    return deal(dstCode, dstCity[0], dstCity[1].name || toLabel, dstCity[1].country);
  }
  // A country scan: the engine says where the fare lands (to, and toCity when it knows the city).
  const landing = (m as ScanMonth & { to?: string; toCity?: string }).to?.toUpperCase();
  if (!landing || !/^[A-Z]{3}$/.test(landing)) return null;
  const given = (m as ScanMonth & { toCity?: string }).toCity?.toUpperCase();
  const cityCode = (given && CITIES[given] ? given : undefined) ?? CITY_OF_AIRPORT.get(landing) ?? (CITIES[landing] ? landing : undefined);
  const airport = AIRPORT_BY_IATA.get(landing);
  const known = cityCode ? CITIES[cityCode] : undefined;
  const country = known?.country ?? airport?.country ?? "";
  if (!cityCode && !airport) return null;
  return deal(landing, cityCode ?? landing, known?.name ?? airport?.city ?? landing, country);

  function deal(dst: string, cityCode: string, cityName: string, country: string): Deal {
    return {
      gw,
      dst,
      dstCity: cityCode,
      city: cityName,
      country,
      price: Math.round(m.cheapest!),
      out: m.out!,
      back: m.back ?? "",
      nights: m.nights ?? 0,
      stops: m.stops ?? 0,
      carriers: m.carriers ?? [],
      outMin: 0,
      backMin: 0,
      url: m.url ?? "",
      ...(m.openJawTo ? { backTo: m.openJawTo, url2: m.url2 } : {}),
    };
  }
}

export function atlasTools(ctx: AgentContext) {
  const gateways = ctx.gateways.length ? ctx.gateways : ["OTP"];
  // The per-turn search budget: shared by every live tool of this turn (the route makes one
  // context per request). A tool refuses before it starts when the budget is gone, and books
  // what it used afterwards; the model sees the refusal as a plain { error }.
  const budget = ctx.budget ?? (ctx.budget = { used: 0, max: TURN_SEARCH_BUDGET });
  const exhausted = (): { error: string } | null => (budget.used >= budget.max ? { error: `the search budget for this turn (${budget.max} Kiwi searches) is used up; answer with what you have, or the traveller can ask again in a new message` } : null);
  const spend = (n: number | undefined) => {
    budget.used += Math.max(0, Math.round(n ?? 0));
  };
  /** Searches this turn may still make (wild_trip reads it where `budget` names the trip's tier). */
  const searchesLeft = () => Math.max(0, budget.max - budget.used);
  // An engine answer carries the search count of the run that produced it, which may be a
  // memoised scan or a trip stored yesterday: only a result generated during this turn cost
  // anything now, and only once (the same scan asked twice in a turn is one run), so a result
  // is charged when its generatedAt is after the turn began and has not been charged before.
  const turnStart = Date.now();
  const charged = new Set<string>();
  const builtNow = (r: { generatedAt?: string } | null | undefined): boolean => {
    const at = r?.generatedAt;
    if (!at || Date.parse(at) < turnStart || charged.has(at)) return false;
    charged.add(at);
    return true;
  };
  /** The origin point for "how far is that": the browser's location, else the first airport. */
  const originPoint = (): { lat: number; lon: number } | null => ctx.origin ?? resolveGateway(gateways[0]) ?? null;
  // The Been filter: countries the traveller has seen and does not want again as a destination
  // or an overnight stop (a layover through one is fine). The context carries the lasting
  // setting (ctx.exclude, the chip's list when "only new" is on). A tool's own `exclude` input
  // ADDS to it: a partial list from the chat ("I have also been to Spain") must never re-admit
  // a country the chip excludes. `allow` takes named countries out for this one search
  // ("Italy again is fine this time"); an explicit empty `exclude` lifts the whole filter once.
  /** Codes from a list the model wrote: ISO2 codes, or country names resolved to codes. */
  const codesFrom = (given: unknown): string[] => {
    const list = Array.isArray(given) ? given : typeof given === "string" ? given.split(",") : [];
    return cleanCodes(list.map((x) => countryCode(String(x ?? "").trim()) ?? String(x ?? "")));
  };
  const excludeOf = (given: unknown, allow?: unknown): string[] => {
    const lasting = ctx.exclude ?? [];
    let out: string[];
    if (given === undefined || given === null) out = lasting;
    else if (Array.isArray(given) && !given.length) out = []; // an explicit [] lifts the filter once
    else {
      const extra = codesFrom(given);
      // A list that resolves to nothing (a typo, a word that is no country) is not a request
      // to lift the filter: the lasting list stays, and excludedSummary says the input was lost.
      out = extra.length ? cleanCodes([...lasting, ...extra]) : lasting;
    }
    const fine = codesFrom(allow);
    return fine.length ? out.filter((cc) => !fine.includes(cc)) : out;
  };
  /** True when the model wrote an exclude list that resolved to no country at all. */
  const excludeLost = (given: unknown): boolean => given != null && !(Array.isArray(given) && !given.length) && !codesFrom(given).length;
  const nameOf = (cc: string) => COUNTRIES[cc]?.name ?? cc;
  /** The plain line a tool answers with when the filter leaves nothing to search: no Kiwi call made. */
  const excludedNote = (codes: string[]) => `${codes.map(nameOf).join(", ")} ${codes.length === 1 ? "is" : "are"} on the traveller's been list and they want only new countries, so nothing was searched; a layover there is still fine. Suggest somewhere they have not seen.`;
  /** The country a place means: a city we know, a country by name or code, or an airport code;
   * undefined for a region word or "anywhere". */
  const placeCountry = (s: string | undefined): string | undefined => {
    const raw = (s ?? "").trim();
    if (!raw) return undefined;
    const city = findCity(raw);
    if (city) return city[1].country;
    const cc = countryCode(raw);
    if (cc) return cc;
    return /^[A-Za-z]{3}$/.test(raw) ? resolveGateway(raw.toUpperCase())?.country : undefined;
  };
  /** A comma list of places with the excluded countries and the cities in them taken out
   * (regions and unknown words stay): what to search, and what was dropped so the answer can
   * say so. A city in a been country is named as the city (Rome), a country by its name. */
  const splitWhere = (where: string | undefined, exclude: string[]): { kept: string[]; dropped: string[] } => {
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const w of (where ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const city = findCity(w);
      const cc = city ? city[1].country : countryCode(w);
      if (cc && !countryAllowed(cc, exclude)) dropped.push(city ? `${city[1].name} (${nameOf(cc)})` : nameOf(cc));
      else kept.push(w);
    }
    return { kept, dropped };
  };
  /** The compact summary of what the filter did, for the model; nothing when it is off. `given`
   * is the model's own exclude input, so a list that resolved to nothing is reported. */
  const excludedSummary = (exclude: string[], dropped: string[] = [], given?: unknown) => {
    const lost = excludeLost(given) ? "the exclude input was not understood (use ISO2 codes); the Been list from the context was applied as before" : "";
    if (!exclude.length) return lost ? { beenFilter: lost } : {};
    return { beenFilter: `${exclude.length} been countr${exclude.length === 1 ? "y" : "ies"} skipped as destinations${dropped.length ? `; dropped from the request: ${dropped.join(", ")}` : ""}${lost ? `; ${lost}` : ""}` };
  };
  return {
    home_airports: tool({
      description: "The traveller's airports with drive time, size and whether a nightly price board exists. Use for 'which airport should I fly from'.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: safe(async () => {
        if (!ctx.origin) return { airports: gateways.map((g) => ({ iata: g })) };
        return nearestGateways(AIRPORTS, ctx.origin.lat, ctx.origin.lon, { maxKm: 350, limit: 6 }).map((g) => ({ iata: g.airport.iata, name: g.airport.name, city: g.airport.city, size: g.airport.size, driveMinutes: g.driveMin, km: Math.round(g.km), searchedNightly: gateways.includes(g.airport.iata) }));
      }),
    }),

    cheapest_deals: tool({
      description: "Tonight's cheapest return getaways from the traveller's airports (real Kiwi.com fares, searched nightly): the next six weeks, or a month. Filters: max price, nights, direct, warm this weekend, country, city, hidden gems. Fast, no live searches. Use for open questions ('where could I go cheaply', 'a warm weekend'). For a specific period of dates use find_getaways; for a named far destination use scan_cheapest. Deals landing in an excluded (been) country are left out; layovers through them are fine.",
      inputSchema: jsonSchema<{ month?: string; maxPrice?: number; minNights?: number; maxNights?: number; direct?: boolean; warm?: boolean; country?: string; city?: string; gems?: boolean; limit?: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM; omit for the next six weeks" },
          maxPrice: { type: "number" },
          minNights: { type: "number" },
          maxNights: { type: "number" },
          direct: { type: "boolean" },
          warm: { type: "boolean", description: "20 C or more this weekend" },
          country: { type: "string", description: "country name or ISO code" },
          city: { type: "string" },
          gems: { type: "boolean", description: "hidden gems only: lots to see, few tourists" },
          limit: { type: "number", description: "default 10, max 20" },
          ...BEEN_PROPS,
        },
      }),
      execute: safe(async (a) => {
        const exclude = excludeOf(a.exclude, a.allow);
        const cc = countryCode(a.country);
        // A country the traveller has been to and does not want again: say so, read nothing.
        if (cc && !countryAllowed(cc, exclude)) return { count: 0, deals: [], note: excludedNote([cc]) };
        const src = await dealsFor(gateways, a.month ?? ctx.month);
        const seen = new Set<string>();
        const out: Deal[] = [];
        for (const d of filterByCountry(src.deals, exclude)) {
          if (a.maxPrice != null && d.price > a.maxPrice) continue;
          if (a.minNights != null && d.nights < a.minNights) continue;
          if (a.maxNights != null && d.nights > a.maxNights) continue;
          if (a.direct && d.stops > 0) continue;
          if (cc && d.country !== cc) continue;
          if (a.city && !d.city.toLowerCase().includes(a.city.toLowerCase())) continue;
          if (a.warm && (weekendMax(d.dstCity) ?? -99) < 20) continue;
          if (a.gems && !isGem(FAME, d.dstCity, 0, PLACES[d.dstCity])) continue;
          if (seen.has(d.dstCity)) continue;
          seen.add(d.dstCity);
          out.push(d);
          if (out.length >= Math.min(20, a.limit ?? 10)) break;
        }
        return { searchedOn: src.updated.slice(0, 10), airports: src.gateways, count: out.length, ...excludedSummary(exclude, [], a.exclude), deals: out.map((d) => ({ ...compactDeal(d), weekendHighC: weekendMax(d.dstCity) })), raw: out };
      }),
      toModelOutput: withoutRaw,
    }),

    find_getaways: tool({
      description: "A live search for a trip inside a period: 'between 20 and 30 October, 3 to 6 nights, away on the 26th, from any of my airports, anywhere or a country, direct, home may land at another of my airports'. About 20 live Kiwi searches, half a minute. Use whenever the traveller gives dates or a period and the place is open (anywhere, a region, a country). Several countries: a comma list in where. Excluded (been) countries are taken out of where before searching and never land; layovers through them are fine.",
      inputSchema: jsonSchema<{ from: string; to: string; include?: string; minNights?: number; maxNights?: number; direct?: boolean; maxHours?: number; where?: string; origins?: string[]; returnTo?: string[]; tricks?: boolean; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD, start of the period" },
          to: { type: "string", description: "YYYY-MM-DD, end of the period (be home by)" },
          include: { type: "string", description: "YYYY-MM-DD the traveller must be away on, optional" },
          minNights: { type: "number", description: "default 2" },
          maxNights: { type: "number", description: "default 7" },
          direct: { type: "boolean" },
          maxHours: { type: "number", description: "max hours per flight leg; 0 or omitted for no limit" },
          where: { type: "string", description: "'anywhere' (default), a region (Europe, Asia) or country names, comma separated" },
          origins: { type: "array", items: { type: "string" }, description: "IATA codes or city names; default the traveller's airports" },
          returnTo: { type: "array", items: { type: "string" }, description: "other home airports the flight back may land at (open-jaw)" },
          tricks: { type: "boolean", description: "also scan hidden-city one-ways (risky; only when asked)" },
          ...BEEN_PROPS,
        },
        required: ["from", "to"],
      }),
      execute: safe(async (a) => {
        if (!isoDay(a.from) || !isoDay(a.to)) return { error: "from and to must be YYYY-MM-DD" };
        // A period that ends before it starts, or starts in the past, would search nothing.
        if (a.to < a.from) return { error: `the period ends (${a.to}) before it starts (${a.from})` };
        if (a.from < ctx.today) return { error: `the period starts in the past (${a.from}); today is ${ctx.today}` };
        const origins = codesOf(a.origins, gateways);
        if (!origins.length) return { error: `unknown airport or city in origins: ${(a.origins ?? []).join(", ")}` };
        // Been countries asked for by name are dropped before any search is sent; when every
        // place asked for is one of them there is nothing to search, and the answer says so.
        const exclude = excludeOf(a.exclude, a.allow);
        const { kept, dropped } = splitWhere(a.where, exclude);
        if (!kept.length && dropped.length) return { searched: 0, found: 0, deals: [], note: excludedNote(dropped) };
        const over = exhausted();
        if (over) return over;
        // A comma list of countries is one search per country per target; four is the cap.
        const where = kept.slice(0, 4).join(",") || "anywhere";
        const r = await findDeals({ origins, from: a.from, to: a.to, include: isoDay(a.include) ? a.include : undefined, minNights: a.minNights ?? 2, maxNights: a.maxNights ?? 7, direct: a.direct, maxHours: a.maxHours, where, returnTo: codesOf(a.returnTo, []), tricks: a.tricks, exclude });
        spend(r.searched);
        const seen = new Set<string>();
        const deals = filterByCountry(r.deals, exclude);
        const top = deals.filter((d) => !seen.has(d.dstCity + (d.backTo ?? "")) && seen.add(d.dstCity + (d.backTo ?? ""))).slice(0, 14);
        return { searched: r.searched, found: deals.length, openJaw: r.openJaw, ...excludedSummary(exclude, dropped, a.exclude), ...(r.note ? { note: r.note } : {}), deals: top.map(compactDeal), raw: top };
      }),
      toModelOutput: withoutRaw,
    }),

    scan_cheapest: tool({
      description: "The price calendar for a named destination: the cheapest return (or one-way) month by month from the traveller's airports (all origins go in one search, so it is one Kiwi search per month: 6 months = 6 searches, 20 seconds; with openJawFrom it is 3 to 4 per month, and months are capped at 6). Use first whenever the traveller names a destination (a city, a country) and the dates are open or wide. openJawFrom: fly in to the destination and home from another city of that country (the big hubs), so 'back to San Francisco, I can return from another US city' is ONE call with openJawFrom 'United States' (never a second call for the open-jaw). Returns months, best, openJaw options and raw deals for the globe (a country scan pins the city each month's fare lands in). A destination in an excluded (been) country is not scanned; layovers through one are fine.",
      inputSchema: jsonSchema<{ to: string; origins?: string[]; months?: number; minNights?: number; maxNights?: number; oneWay?: boolean; openJawFrom?: string; startMonth?: string; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          to: { type: "string", description: "city name, airport code or country name" },
          origins: { type: "array", items: { type: "string" }, description: "IATA codes or city names; default the traveller's airports" },
          months: { type: "number", description: "how many months to scan, default 6, max 9" },
          minNights: { type: "number", description: "default 7 for long-haul, 3 for Europe" },
          maxNights: { type: "number", description: "default 14 for long-haul, 7 for Europe" },
          oneWay: { type: "boolean" },
          openJawFrom: { type: "string", description: "a country or city: also price coming home from its other big cities" },
          startMonth: { type: "string", description: "YYYY-MM, default the current month" },
          ...BEEN_PROPS,
        },
        required: ["to"],
      }),
      execute: safe(async (a) => {
        if (!a.to?.trim()) return { error: "a destination is needed" };
        const origins = codesOf(a.origins, gateways).slice(0, 3);
        if (!origins.length) return { error: `unknown airport or city in origins: ${(a.origins ?? []).join(", ")}` };
        const exclude = excludeOf(a.exclude, a.allow);
        const dst = findCity(a.to);
        // A city in a been country, or the country itself: nothing to scan, and no search spent.
        const dstCountry = dst ? dst[1].country : countryCode(a.to);
        if (dstCountry && !countryAllowed(dstCountry, exclude)) return { to: dst?.[1].name ?? a.to.trim(), searched: 0, best: null, months: [], note: excludedNote([dstCountry]) };
        // Coming home from another city of a been country would mean a stay there: the
        // open-jaw leg is dropped and the answer says so.
        const jawCountry = countryCode(a.openJawFrom?.trim()) ?? findCity(a.openJawFrom ?? "")?.[1].country;
        const jawDropped = !!jawCountry && !countryAllowed(jawCountry, exclude);
        const over = exhausted();
        if (over) return over;
        const to = dst ? (dst[1].airports.length === 1 ? dst[1].airports[0] : dst[0]) : a.to.trim();
        // Long-haul nights only when the place (a city, or a country's middle) is really far
        // from where the traveller starts; Italy from Brașov is a short break, not two weeks.
        const here = originPoint();
        const there = placePoint(a.to);
        const far = here && there ? haversineKm(here.lat, here.lon, there.lat, there.lon) > LONG_HAUL_KM : !there;
        const openJawFrom = jawDropped ? undefined : a.openJawFrom?.trim() || undefined;
        // One search a month, three to four with open-jaw: the open-jaw calendar stops at six months.
        const months = Math.min(openJawFrom ? 6 : 9, Math.max(1, Math.round(a.months ?? 6)));
        const minNights = Math.max(1, Math.round(a.minNights ?? (far ? 7 : 3)));
        const maxNights = Math.max(minNights, Math.round(a.maxNights ?? (far ? 14 : 7)));
        const startMonth = a.startMonth && /^\d{4}-\d{2}$/.test(a.startMonth) ? a.startMonth : undefined;
        const r = await scanCheapest({ origins, to, months, minNights, maxNights, oneWay: a.oneWay, openJawFrom, startMonth, exclude });
        // A memoised calendar (the same scan within the hour) made no live search now.
        spend(builtNow(r) ? r.searched : 0);
        const label = dst?.[1].name ?? a.to.trim();
        // A month whose search failed (Kiwi refused) is unknown, not empty: the calendar says so.
        const row = (m: ScanMonth) => ({ month: m.month, cheapest: m.cheapest, out: m.out, back: m.back, nights: m.nights, perNight: m.cheapest != null && m.nights ? Math.round(m.cheapest / m.nights) : undefined, stops: m.stops, airline: m.carriers?.[0], from: m.from, homeFrom: m.openJawTo, url: m.url, url2: m.url2, also: m.also?.slice(0, 2).map((x) => ({ cheapest: x.cheapest, out: x.out, back: x.back })), ...(m.failed ? { failed: true } : {}) });
        // A country scan may land a month in a been country: that pin is dropped (the engine
        // skips such months itself once it knows the list; this keeps the globe honest anyway).
        const raw = filterByCountry(r.months.map((m) => dealFromMonth(m, origins, to, dst, label)).filter((d): d is Deal => !!d), exclude);
        return {
          to: label,
          origins: r.origins,
          nights: `${minNights} to ${maxNights}`,
          oneWay: !!a.oneWay,
          searched: r.searched,
          ...excludedSummary(exclude, jawDropped && jawCountry ? [`open-jaw via ${nameOf(jawCountry)}`] : [], a.exclude),
          ...(r.failed ? { failed: r.failed, note: `${r.failed} search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); those months are unknown, not empty` } : r.note ? { note: r.note } : {}),
          best: r.best ? row(r.best) : null,
          months: r.months.map(row),
          openJaw: r.openJaw.slice(0, 6).map(row),
          raw,
        };
      }),
      toModelOutput: withoutRaw,
    }),

    reprice_route: tool({
      description: "Live Kiwi.com prices for one route around a date: 'what does Bucharest to Venice cost on 7 November for 3 nights'. One search. Returns the cheapest itineraries with booking links. City names or codes. A destination in an excluded (been) country is not priced; with 'anywhere' as the destination, landings in one are dropped; layovers through one are fine.",
      inputSchema: jsonSchema<{ from: string; to: string; depart: string; nights?: number; flexDays?: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: { from: { type: "string", description: "IATA, city code or city name" }, to: { type: "string" }, depart: { type: "string", description: "YYYY-MM-DD" }, nights: { type: "number", description: "omit for one-way" }, flexDays: { type: "number", description: "default 2" }, ...BEEN_PROPS },
        required: ["from", "to", "depart"],
      }),
      execute: safe(async (a) => {
        if (!isoDay(a.depart)) return { error: "depart must be YYYY-MM-DD" };
        // A named destination in a been country is an answer, not a search; an open destination
        // ("anywhere") is searched and the landings in been countries are dropped afterwards.
        const exclude = excludeOf(a.exclude, a.allow);
        const toCountry = placeCountry(a.to);
        if (toCountry && !countryAllowed(toCountry, exclude)) return { searched: 0, found: 0, itineraries: [], note: excludedNote([toCountry]) };
        const over = exhausted();
        if (over) return over;
        const flex = Math.min(5, Math.max(0, Math.round(a.flexDays ?? 2)));
        const back = a.nights ? addDays(a.depart, Math.min(90, Math.max(1, Math.round(a.nights)))) : null;
        spend(1);
        const r = await searchFlight({ flyFrom: placeArg(a.from, gateways.join(",")), flyTo: placeArg(a.to, "anywhere"), departureDate: kiwiDate(a.depart), departureDateFlexDays: flex, ...(back ? { returnDate: kiwiDate(back), returnDateFlexDays: flex } : {}) });
        // Where an itinerary lands (the outbound's last airport), by country: cities.json first,
        // then the airports file, the way the boards resolve a gateway.
        const landsIn = (code: string) => resolveGateway(code)?.country ?? AIRPORT_BY_IATA.get(code)?.country;
        const kept = r.itineraries.filter((it) => countryAllowed(landsIn(it.outbound.to), exclude));
        const items = kept
          .sort((x, y) => x.price - y.price)
          .slice(0, 6)
          .map((it) => ({ price: Math.round(it.price), to: it.outbound.to, out: it.outbound.departureTime.slice(0, 16), back: it.inbound?.departureTime.slice(0, 16), nights: nightsOf(it), stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0), via: it.outbound.route.slice(1, -1), carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName))], hours: Math.round(it.outbound.durationSeconds / 360) / 10, url: it.bookingUrl }));
        const droppedN = r.itineraries.length - kept.length;
        return { searched: 1, found: items.length, ...excludedSummary(exclude, droppedN ? [`${droppedN} itinerar${droppedN === 1 ? "y" : "ies"} landing in a been country`] : [], a.exclude), itineraries: items };
      }),
    }),

    two_city_combos: tool({
      description: "For a return deal: fly in to the city, hop by train or coach to a neighbour, fly home from there, priced live. Often cheaper and you see two places. Needs the deal's home airport, destination airport, city code, dates and price (from a deals result). A neighbour in an excluded (been) country is never proposed as the second city; passing through one is fine.",
      inputSchema: jsonSchema<{ from: string; dst: string; city: string; out: string; back: string; price: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: { from: { type: "string" }, dst: { type: "string" }, city: { type: "string", description: "destination city code" }, out: { type: "string" }, back: { type: "string" }, price: { type: "number" }, ...BEEN_PROPS },
        required: ["from", "dst", "city", "out", "back", "price"],
      }),
      execute: safe(async (a) => {
        const over = exhausted();
        if (over) return over;
        const exclude = excludeOf(a.exclude, a.allow);
        const city = findCity(a.city)?.[0] ?? a.city.toUpperCase();
        const from = airportArg(a.from, gateways[0]) || gateways[0];
        const dst = airportArg(a.dst, "") || a.dst.toUpperCase();
        const r = await findCombos(from, dst, city, a.out, a.back, a.price, { exclude });
        spend(r.searched);
        return { base: r.base, outOneWay: r.outPrice, ...excludedSummary(exclude, [], a.exclude), ...(r.note ? { note: r.note } : {}), combos: filterByCountry(r.combos, exclude).slice(0, 4).map((c) => ({ next: c.name, country: c.country, ground: `${c.groundMode} ${Math.round((c.groundMin / 60) * 10) / 10} h${c.estimated ? " (estimate)" : ""}`, homeFromThere: c.inPrice, total: c.total, saves: c.saves, outUrl: r.outUrl, homeUrl: c.inUrl })) };
      }),
    }),

    wild_trip: tool({
      description: "A long multi-country loop (7 to 90 nights) into a far region: fly out (via a cheaper hub when that wins), chain cheap one-way flights and border hops through the region, fly home (any of the traveller's airports, plus the last leg to their door), with living costs per stop, visas, a stopover night in a hub when it costs about the same, and a model's verdict. Long trips get longer stays (60 nights is 5 to 7 bases of 8 to 12 nights). Regions: " + Object.entries(REGIONS).map(([k, v]) => `${k} (${v.label})`).join(", ") + ". Style: experiences, beaches, food, cities, slow. Budget: backpacker, mid, comfort. Tradeoff: price, balanced, comfort. variants=3 builds the balanced, cheapest and comfortable versions and ranks them. noHubs skips the positioning hub. Either month (YYYY-MM) or an explicit departure window from/to (a window works with variants too; one wider than ten days is clipped to its first ten). Optional custom country list, countries to favour, max stops, nights per stop. Cost: about sixty Kiwi searches per variant that is not already built (one to two minutes each), so variants=3 is about 180 when none is stored, more than one turn's budget of " + TURN_SEARCH_BUDGET + "; the tool builds only as many variants as the budget left allows (stored ones are free), and a trip built in the last day is served at no cost. Default to one variant; say so before calling. Excluded (been) countries never become a stop or the optional hub night; flying through a hub there to position is fine.",
      inputSchema: jsonSchema<{ region: Region; nights?: number; style?: Style; budget?: Budget; month?: string; from?: string; to?: string; countries?: string[]; prefer?: string[]; maxStops?: number; nightsPerStop?: number; stopover?: boolean; tradeoff?: Tradeoff; noHubs?: boolean; variants?: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          region: { type: "string", enum: Object.keys(REGIONS) },
          nights: { type: "number", description: "7 to 90, default 14" },
          style: { type: "string", enum: ["experiences", "beaches", "food", "cities", "slow"] },
          budget: { type: "string", enum: ["backpacker", "mid", "comfort"] },
          month: { type: "string", description: "YYYY-MM" },
          from: { type: "string", description: "YYYY-MM-DD, earliest departure (used instead of month)" },
          to: { type: "string", description: "YYYY-MM-DD, latest departure" },
          countries: { type: "array", items: { type: "string" }, description: "ISO2 codes to restrict to, e.g. ['VN','TH']" },
          prefer: { type: "array", items: { type: "string" }, description: "ISO2 codes to favour" },
          maxStops: { type: "number" },
          nightsPerStop: { type: "number" },
          stopover: { type: "boolean", description: "allow a hub night on the way home, default true" },
          tradeoff: { type: "string", enum: ["price", "balanced", "comfort"] },
          noHubs: { type: "boolean", description: "fly only from the traveller's own airports" },
          variants: { type: "number", description: "1 (default), 2 or 3 ranked variants (balanced, price first, comfort first); 2 at most past 28 nights" },
          ...BEEN_PROPS,
        },
        required: ["region"],
      }),
      execute: safe(async (a) => {
        if (!Object.hasOwn(REGIONS, a.region)) return { error: `unknown region ${a.region}; one of ${Object.keys(REGIONS).join(", ")}` };
        const nights = Math.min(90, Math.max(7, Math.round(a.nights ?? 14)));
        const style = a.style ?? "experiences";
        const budget = a.budget ?? "mid";
        const month = a.month ?? ctx.month;
        const from = isoDay(a.from) ? a.from : undefined;
        const to = isoDay(a.to) ? a.to : undefined;
        // Been countries drop out of a custom list and the favourites before the build; a list
        // that was all been countries is an answer, not a build.
        const exclude = excludeOf(a.exclude, a.allow);
        const given = a.countries?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
        const countries = given?.filter((c) => countryAllowed(c, exclude));
        if (given?.length && !countries?.length) return { error: excludedNote(given) };
        const prefer = a.prefer?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c) && countryAllowed(c, exclude));
        const summarise = (trip: WildTrip) => ({
          title: trip.title,
          dates: `${trip.outDate} to ${trip.backDate}`,
          totals: trip.totals,
          legs: trip.legs.map((l) => (l.kind === "fly" ? `${l.date} fly ${l.fromName} → ${l.toName} €${l.price}, ${l.hours} h, ${l.stops ? `${l.stops} stop` : "direct"}` : `${l.date} ${l.mode} ${l.fromName} → ${l.toName} ~${Math.round(l.minutes / 60)} h`)),
          stops: trip.stops.map((s) => `${s.name} (${s.country}) ${s.nights} nights, about €${s.perDay}/day${s.visa ? `, ${s.visa}` : ""}${s.note ? `; ${s.note}` : ""}`),
          judge: trip.judge,
        });
        // The key plan_days needs to find the stored trip again: the same custom suffix the
        // trip was written under, window and been list included (lib/wild.ts customKey takes
        // from, to and exclude), which is also what lib/wild-variants.ts keys each ranked
        // version on. A build with countries excluded never answers for a plain one.
        const keyOf = (tradeoff?: Tradeoff, noHubs?: boolean) => ({ region: a.region, nights, style, budget, month, custom: customKey(countries, prefer, a.maxStops, a.nightsPerStop, tradeoff, noHubs, from, to, exclude.length ? exclude : undefined) });
        const gw = mainGateway(gateways);
        const params = { gateways, home: ctx.home, region: a.region, month, from, to, nights, style, budget, origin: ctx.origin, stopover: a.stopover, countries, prefer, maxStops: a.maxStops, nightsPerStop: a.nightsPerStop, exclude };
        const pathOf = (tradeoff?: Tradeoff, noHubs?: boolean) => wildPath(gw, a.region, month, nights, style, budget, keyOf(tradeoff, noHubs).custom);
        if ((a.variants ?? 1) > 1) {
          // The engine builds and ranks the versions (dated windows included, each stored under
          // its own window key); the chat caps them like the wild route: three, two past 28 nights.
          let wanted = Math.min(Math.round(a.variants ?? 1), nights > LONG_TRIP_NIGHTS ? MAX_VARIANTS_LONG : MAX_VARIANTS);
          // The engine builds the first `wanted` variants at once, about sixty searches each,
          // and a stored one (built in the last day) costs nothing: the list is trimmed from the
          // end until the ones still to build fit in what is left of the turn's budget. A
          // stored trip is served even when the budget is spent.
          const fresh = await Promise.all(VARIANTS.slice(0, wanted).map(async (v) => {
            const stored = await readJson<WildTrip>(pathOf(v.tradeoff, v.noHubs));
            return !!stored && stored.ageHours < 24;
          }));
          const left = searchesLeft();
          let toBuild = fresh.filter((f) => !f).length;
          while (wanted > 1 && toBuild * WILD_SEARCHES_PER_VARIANT > left) {
            wanted--;
            toBuild = fresh.slice(0, wanted).filter((f) => !f).length;
          }
          if (toBuild > 0) {
            const over = exhausted();
            if (over) return over;
          }
          const ranked = await buildWildVariants(params, wanted);
          // Only the variants built during this turn cost searches; a stored one carries the
          // count of the run that made it. (A built variant that the engine dropped as a
          // duplicate of another chain is not charged; it is rare and errs on the cheap side.)
          spend(ranked.reduce((n, t) => n + (builtNow(t) ? t.searched ?? 0 : 0), 0));
          if (!ranked.length) return { error: "no way into that region on those dates from here; try another month or region" };
          const variantKey = (label: string) => {
            const v = VARIANTS.find((x) => x.label === label) ?? VARIANTS[0];
            return keyOf(v.tradeoff, v.noHubs);
          };
          return { ...excludedSummary(exclude, [], a.exclude), ranked: ranked.map((t) => ({ rank: t.rank, variant: t.variant, score: t.score, key: variantKey(t.variant), ...summarise(t) })), key: variantKey(ranked[0].variant), raw: ranked[0] };
        }
        const key = keyOf(a.tradeoff, a.noHubs);
        const path = pathOf(a.tradeoff, a.noHubs);
        const stored = await readJson<WildTrip>(path);
        let trip = stored && stored.ageHours < 24 ? stored.body : null;
        if (!trip) {
          // The budget is checked only once a build is really needed: a stored trip is free.
          const over = exhausted();
          if (over) return over;
          const built = await buildWild({ ...params, tradeoff: a.tradeoff, noHubs: a.noHubs });
          if (!built) return { error: "no way into that region on those dates from here; try another month or region" };
          spend(built.searched);
          const judge = await judgeTrip(built);
          trip = { ...built, judge: judge ?? undefined };
          await writeJson(path, trip).catch(() => null);
        }
        return { ...summarise(trip), ...excludedSummary(exclude, [], a.exclude), key, raw: trip };
      }),
      toModelOutput: withoutRaw,
    }),

    long_stay: tool({
      description: "Bases for living somewhere for a month or more: for a region or a country list, the flight in, the flight out, rent and monthly living per base, the total and per day, why each base, side trips, visa, climate. Use for 'two months in Southeast Asia this winter', 'where could I work remotely cheaply'. Bounded to about 20 live searches. Bases in excluded (been) countries are never proposed; a flight through one is fine.",
      inputSchema: jsonSchema<{ region?: string; countries?: string[]; months?: number; startMonth?: string; budget?: "backpacker" | "mid" | "comfort"; style?: string; gateways?: string[]; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          region: { type: "string", enum: Object.keys(REGIONS), description: "one of the wild regions" },
          countries: { type: "array", items: { type: "string" }, description: "ISO2 codes instead of a region" },
          months: { type: "number", description: "how long, 1 to 6, default 2" },
          startMonth: { type: "string", description: "YYYY-MM" },
          budget: { type: "string", enum: ["backpacker", "mid", "comfort"] },
          style: { type: "string", description: "beaches, cities, food, experiences, slow" },
          gateways: { type: "array", items: { type: "string" }, description: "IATA codes or city names; default the traveller's airports" },
          ...BEEN_PROPS,
        },
      }),
      execute: safe(async (a) => {
        const exclude = excludeOf(a.exclude, a.allow);
        const given = a.countries?.map((c) => countryCode(c) ?? c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
        // A country list of been countries only is an answer, not twenty searches.
        const countries = given?.filter((c) => countryAllowed(c, exclude));
        if (given?.length && !countries?.length) return { error: excludedNote(given) };
        if (!a.region && !countries?.length) return { error: "a region or a country list is needed" };
        if (a.region && !Object.hasOwn(REGIONS, a.region)) return { error: `unknown region ${a.region}` };
        const from = codesOf(a.gateways, gateways);
        if (!from.length) return { error: `unknown airport or city in gateways: ${(a.gateways ?? []).join(", ")}` };
        const over = exhausted();
        if (over) return over;
        const months = Math.min(6, Math.max(1, Math.round(a.months ?? 2)));
        const startMonth = a.startMonth && /^\d{4}-\d{2}$/.test(a.startMonth) ? a.startMonth : undefined;
        const r = await longStay({ gateways: from, home: ctx.home, region: a.region, countries, months, startMonth, budget: a.budget, style: a.style, origin: ctx.origin, exclude });
        spend(r.searched);
        const bases = filterByCountry(r.bases, exclude).slice(0, 8);
        // The nights of a base are the days the engine counted between its two flights
        // (LongStayBase.days), not a nominal months x 30: the costs were counted for those days.
        const nightsOf = (b: (typeof bases)[number]) => Math.max(1, Math.round(b.days ?? (b.flightIn && b.flightOut ? (Date.parse(b.flightOut.date) - Date.parse(b.flightIn.date)) / 86_400_000 : months * 30)));
        const raw: Deal[] = bases
          .filter((b) => b.flightIn)
          .map((b) => ({ gw: b.flightIn!.from, dst: CITIES[b.code]?.airports[0] ?? b.code, dstCity: b.code, city: b.name, country: b.country, price: Math.round(b.flightIn!.price + (b.flightOut?.price ?? 0)), out: b.flightIn!.date, back: b.flightOut?.date ?? "", nights: nightsOf(b), stops: 0, carriers: [], outMin: 0, backMin: 0, url: b.flightIn!.url, ...(b.flightOut ? { backTo: b.flightOut.to, url2: b.flightOut.url } : {}) }));
        const skipped = (r.skipped ?? []).slice(0, 12).map((x) => ({ country: COUNTRIES[x.country]?.name ?? x.country, reason: x.reason }));
        return {
          months,
          searched: r.searched,
          ...excludedSummary(exclude, [], a.exclude),
          ...(r.failed ? { failed: r.failed, note: `${r.failed} search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); a base may lack a flight it would otherwise have` } : {}),
          bases: bases.map((b) => ({ base: b.name, country: COUNTRIES[b.country]?.name ?? b.country, code: b.code, days: nightsOf(b), flightIn: b.flightIn ? `€${b.flightIn.price} on ${b.flightIn.date} from ${b.flightIn.from}` : "not found", flightOut: b.flightOut ? `€${b.flightOut.price} on ${b.flightOut.date} to ${b.flightOut.to}` : "not found", rentPerMonth: b.rent, livingPerMonth: b.monthlyLiving, total: b.total, perDay: b.perDay, why: b.why.slice(0, 4), sideTrips: b.sideTrips.slice(0, 4).map((s) => `${s.name} ${Math.round(s.minutes / 60)} h by ${s.mode}`), visa: b.visa, climate: b.climate ? { tmax: b.climate.tmax, rain: b.climate.rain } : undefined, urlIn: b.flightIn?.url, urlOut: b.flightOut?.url })),
          // Countries of the region left out (a travel warning, too expensive, no known city) and why.
          ...(skipped.length ? { skipped } : {}),
          estimates: r.note,
          raw,
        };
      }),
      toModelOutput: withoutRaw,
    }),

    group_trip: tool({
      description: "Several people from different cities meet somewhere: give each person's name, home airports or city, and the dates they are free; the tool finds the windows that fit everyone (or almost), then the cities where the sum of their fares is lowest, with a fare per person and booking links. Use for 'me and two friends, I am in Brasov, Ana in Cluj, free 7 to 16 Nov'. About 25 to 45 live searches. Meeting cities in excluded (been) countries are never proposed; connections through them are fine.",
      inputSchema: jsonSchema<{ members: { name: string; origins: string[]; available: { from: string; to: string }[] }[]; minNights?: number; maxNights?: number; where?: string; direct?: boolean; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          members: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                origins: { type: "array", items: { type: "string" }, description: "IATA codes or a city name" },
                available: { type: "array", items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }, description: "YYYY-MM-DD windows when free" },
              },
              required: ["name", "origins", "available"],
            },
          },
          minNights: { type: "number", description: "default 2" },
          maxNights: { type: "number", description: "default 4 for a weekend" },
          where: { type: "string", description: "a city, country or region to meet in; omit for anywhere" },
          direct: { type: "boolean" },
          ...BEEN_PROPS,
        },
        required: ["members"],
      }),
      execute: safe(async (a) => {
        // Each person flies from their own airports, never from the traveller's: a town we
        // cannot resolve is an error naming the person, so the agent asks with a people widget.
        const members: GroupMember[] = [];
        for (const m of (a.members ?? []).slice(0, 8)) {
          const name = String(m?.name ?? "").slice(0, 40) || "someone";
          const given = Array.isArray(m?.origins) ? m.origins.map((o) => String(o ?? "")) : [];
          const origins = codesOf(given, []);
          if (!origins.length) return { error: `${name}: unknown airport or city ${given.join(", ") || "(none given)"}; ask for the nearest airport` };
          members.push({ name, origins, available: (Array.isArray(m.available) ? m.available : []).filter((w) => w && isoDay(w.from) && isoDay(w.to)).slice(0, 6) });
        }
        if (members.length < 2) return { error: "at least two people with their airports and free dates are needed" };
        const bad = members.find((m) => !m.available.length);
        if (bad) return { error: `${bad.name} has no dates (YYYY-MM-DD from and to)` };
        const over = exhausted();
        if (over) return over;
        const minNights = Math.max(1, Math.round(a.minNights ?? 2));
        const maxNights = Math.max(minNights, Math.round(a.maxNights ?? 4));
        // The engine prices every target for every airport group for three windows, so the
        // country list is capped: four, or two once the group flies from more than two places.
        const groups = new Set(members.map((m) => [...m.origins].sort().join(","))).size;
        // A meeting country the traveller has been to is dropped from the list before searching.
        const exclude = excludeOf(a.exclude, a.allow);
        const { kept, dropped } = splitWhere(a.where, exclude);
        if (!kept.length && dropped.length) return { searched: 0, windows: [], options: [], note: excludedNote(dropped) };
        const where = kept.slice(0, groups > 2 ? 2 : 4).join(",") || undefined;
        const r = await groupTrip({ members, minNights, maxNights, where, direct: a.direct, exclude });
        spend(r.searched);
        const options = filterByCountry(r.options, exclude).slice(0, 6);
        const raw: Deal[] = options.map((o) => ({ gw: o.perMember[0]?.from ?? members[0].origins[0], dst: CITIES[o.dstCity]?.airports[0] ?? o.dstCity, dstCity: o.dstCity, city: o.city, country: o.country, price: Math.round(o.total), out: o.window.from, back: o.window.to, nights: o.window.nights, stops: 0, carriers: [], outMin: 0, backMin: 0, url: o.perMember[0]?.url ?? "" }));
        return {
          searched: r.searched,
          ...excludedSummary(exclude, dropped, a.exclude),
          windows: r.windows.slice(0, 6).map((w) => ({ dates: `${w.from} to ${w.to}`, nights: w.nights, everyone: w.everyone, compromises: w.compromises })),
          options: options.map((o) => ({ city: o.city, country: COUNTRIES[o.country]?.name ?? o.country, dates: `${o.window.from} to ${o.window.to}`, nights: o.window.nights, everyone: o.window.everyone, total: o.total, perMember: o.perMember.map((m) => ({ name: m.name, price: m.price, from: m.from, out: m.out, back: m.back, url: m.url, note: m.note })) })),
          raw,
        };
      }),
      toModelOutput: withoutRaw,
    }),

    best_months: tool({
      description: "The best months to visit a city by climate (monthly highs and rain, scored), from the climate data. Instant. Use when the traveller is flexible on when, or asks 'when is good for X'.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: safe(async ({ city }) => {
        const hit = findCity(city);
        if (!hit) return { error: `no city named ${city}` };
        const r = bestMonths(hit[0]);
        if (!r) return { error: `no climate data for ${hit[1].name}` };
        return { city: hit[1].name, best: r.best.map((m) => MONTH_NAMES[m - 1]), months: r.months.map((m) => ({ month: MONTH_NAMES[m.m - 1], highC: m.tmax, rainMm: m.rain, score: m.score })) };
      }),
    }),

    price_insight: tool({
      description: "The fare memory's verdict on a route in a month: what it usually costs, the lowest seen, how many fares were seen, and whether a given price is great, good, typical or high. Use after a search to say whether the price is worth taking. Instant; says unknown when the database has no history.",
      inputSchema: jsonSchema<{ from: string; to: string; month: string; price?: number; oneWay?: boolean; minNights?: number; maxNights?: number }>({ type: "object", properties: { from: { type: "string", description: "airport code or city" }, to: { type: "string" }, month: { type: "string", description: "YYYY-MM" }, price: { type: "number", description: "the fare in hand, so the verdict judges it" }, oneWay: { type: "boolean", description: "judge against one-way fares (default return fares)" }, minNights: { type: "number", description: "compare only return fares of these nights" }, maxNights: { type: "number" } }, required: ["from", "to", "month"] }),
      execute: safe(async (a) => {
        if (!/^\d{4}-\d{2}$/.test(a.month ?? "")) return { error: "month must be YYYY-MM" };
        // "2026-13" has the shape but no such month exists: a bad input, not an empty memory.
        const mm = Number(a.month.slice(5, 7));
        if (mm < 1 || mm > 12) return { error: `month must be YYYY-MM with a real month (01 to 12), not ${a.month}` };
        // The memory is keyed by airports: a country or an unknown town has no history to read.
        // A multi-airport city (London, Paris, Milan, New York, Bangkok, Tokyo) is asked for
        // every airport, at most four a side, and the pair with the most history answers.
        const srcs = airportsArg(a.from, [gateways[0]]);
        const dsts = airportsArg(a.to, []);
        if (!srcs.length) return { error: `unknown airport or city ${a.from}` };
        if (!dsts.length) return { error: `a destination airport or city is needed (${a.to || "none given"} is not one we know)` };
        // Return fares against return fares, one-ways against one-ways: an open-jaw scan fills
        // the memory with one-way fares for the same route and month.
        const opts = { oneWay: !!a.oneWay, minNights: Number.isFinite(a.minNights) ? a.minNights : undefined, maxNights: Number.isFinite(a.maxNights) ? a.maxNights : undefined };
        const price = Number.isFinite(a.price) ? a.price : undefined;
        const pairs = srcs.flatMap((src) => dsts.map((dst) => ({ src, dst })));
        const results = await Promise.all(pairs.map(async (p) => ({ ...p, r: await priceInsight(p.src, p.dst, a.month, price, opts) })));
        const best = results.filter((x) => x.r).sort((x, y) => y.r!.samples - x.r!.samples)[0];
        const route = best ? `${best.src} to ${best.dst}` : `${srcs[0]} to ${dsts[0]}`;
        const airports = pairs.length > 1 ? { airportsTried: [...new Set(dsts)] } : {};
        // Null from every pair means the memory itself did not answer (no database), which is
        // not the same as a route nobody has searched yet.
        if (!best) return { error: "the fare memory is not available right now (no database)" };
        if (!best.r!.samples) return { route, month: a.month, verdict: "unknown", samples: 0, note: "no fare history for this route yet", ...airports };
        const r = best.r!;
        // Fewer than three days of history is no history: the median of one or two fares says nothing.
        if (r.samples < 3) return { route, month: a.month, ...r, verdict: "unknown" as const, note: `only ${r.samples} day${r.samples === 1 ? "" : "s"} of fares seen; not enough to judge`, ...airports };
        return { route, month: a.month, ...r, ...airports };
      }),
    }),

    ask: tool({
      description: "The only way to ask the traveller something: a widget, never prose. kinds: dates (a date range picker with quick chips), month (month chips), nights (nights chips), region (the fourteen far regions), choices (your own options, 2 to 5 short labels), people (a group editor: name, home airport, dates per person), map-region (pick a region on the globe), map-place (pick a place on the globe). Ask at most one question per turn, after you have shown results, and only when the answer would change the search. The reply arrives as the next user message ('Dates: ...', 'Nights: ...').",
      inputSchema: jsonSchema<{ kind: WidgetKind; question: string; options?: string[]; defaults?: Record<string, unknown> }>({
        type: "object",
        properties: {
          kind: { type: "string", enum: WIDGET_KINDS },
          question: { type: "string", description: "one short line" },
          options: { type: "array", items: { type: "string" }, description: "for choices (2 to 5) or nights (ranges like '7 to 14')" },
          defaults: { type: "object", description: "prefill: {from,to} for dates, {month} for month, {people:[{name,origin,from,to}]} for people, {value} for others", additionalProperties: true },
        },
        required: ["kind", "question"],
      }),
      execute: async (a): Promise<WidgetSpec & { widget: true }> => {
        const kind = WIDGET_KINDS.includes(a.kind) ? a.kind : "choices";
        const options = (a.options ?? []).map((o) => String(o).slice(0, 60)).filter(Boolean).slice(0, 8);
        // The widget renders whatever is in defaults, so only known shapes with string values
        // get through: a number for a name, or a null row, would break the people editor.
        const d = a.defaults && typeof a.defaults === "object" && !Array.isArray(a.defaults) ? (a.defaults as Record<string, unknown>) : {};
        const str = (v: unknown, max: number) => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : "");
        const defaults: Record<string, unknown> = {};
        if (isoDay(d.from)) defaults.from = d.from;
        if (isoDay(d.to)) defaults.to = d.to;
        if (typeof d.month === "string") defaults.month = d.month.slice(0, 20);
        if (typeof d.value === "string" || typeof d.value === "number") defaults.value = String(d.value).slice(0, 60);
        if (Array.isArray(d.people)) {
          defaults.people = sanitizePeople(d.people);
        }
        return { widget: true, kind, question: String(a.question ?? "").slice(0, 160) || "Which do you prefer?", options: options.length ? options : undefined, defaults: Object.keys(defaults).length ? defaults : undefined };
        function sanitizePeople(rows: unknown[]) {
          return rows
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
            .slice(0, 8)
            .map((r) => ({ name: str(r.name, 40), origin: str(r.origin, 40), from: isoDay(r.from) ? r.from : "", to: isoDay(r.to) ? r.to : "" }));
        }
      },
    }),

    events_worth_travelling_for: tool({
      description: "Travel with a purpose: the events worth flying for inside a window (carnivals, festivals, marathons, fire festivals, lantern nights, seasons like cherry blossom or northern lights), each with the cheapest way there from the traveller's airports (tonight's boards, then a live search for the nearest few). Use for 'something special to go to in November', 'Halloween somewhere cool', 'a marathon abroad'. Events in excluded (been) countries are hidden; flying through one is fine.",
      inputSchema: jsonSchema<{ from: string; to: string; kinds?: string[]; live?: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, kinds: { type: "array", items: { type: "string", enum: ["festival", "sport", "culture", "season", "music", "food"] } }, live: { type: "number", description: "how many unpriced events to price live (default 4, slow)" }, ...BEEN_PROPS },
        required: ["from", "to"],
      }),
      execute: safe(async (a) => {
        if (!isoDay(a.from) || !isoDay(a.to)) return { error: "from and to must be YYYY-MM-DD" };
        const over = exhausted();
        if (over) return over;
        const exclude = excludeOf(a.exclude, a.allow);
        const live = Math.min(6, Math.max(0, Math.round(a.live ?? 4)));
        const r = await purposeTrips(gateways, a.from, a.to, { live, kinds: a.kinds as never, exclude });
        // The engine counts the searches it really sent (a memoised answer sends none).
        spend(r.searched ?? live);
        // An event in a been country is not a reason to go back there.
        const events = r.filter((t) => countryAllowed(t.event.country, exclude));
        return { searched: r.searched ?? live, ...excludedSummary(exclude, [], a.exclude), ...(r.failed ? { failed: r.failed, note: `${r.failed} live search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); those events are unpriced, not absent` } : {}), events: events.slice(0, 12).map((t) => ({ event: t.event.name, city: t.event.city, country: t.event.country, dates: `${t.event.start} to ${t.event.end}`, kind: t.event.kind, note: t.event.note, cheapestTrip: t.deal ? compactDeal(t.deal) : null, priced: t.source })), raw: events.map((t) => t.deal).filter((d): d is Deal => !!d) };
      }),
      toModelOutput: withoutRaw,
    }),

    stopover_programmes: tool({
      description: "Airlines that give a free or very cheap hotel night in their hub on the way (Turkish Airlines in Istanbul, Qatar in Doha, TAP in Lisbon, Icelandair, Finnair, Emirates, Singapore). Use when a route goes through one of these hubs or the traveller asks about layover hacks.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => Object.entries(STOPOVER_PROGRAMMES).map(([hub, p]) => ({ hub, airline: p.airline, note: p.note })),
    }),

    hotel_deals: tool({
      description: "Where hotels are cheap right now: the cities (of the eighty most visited) whose cheapest decent hotel for the standard weekend four weeks out is at least 25% under its own recent median, from Atlas's nightly LiteAPI snapshots. Instant, no searches. Use when the traveller asks where is cheap to stay, about hotel deals or hotels in general without a city. Says 'warming up' until three nightly snapshots exist; say so plainly. Hotels in excluded (been) countries are left out: a hotel night there is a stay there.",
      inputSchema: jsonSchema<{ country?: string; limit?: number; exclude?: string[]; allow?: string[] }>({ type: "object", properties: { country: { type: "string", description: "only this country (name or ISO code), optional" }, limit: { type: "number", description: "default 10, max 20" }, ...BEEN_PROPS } }),
      execute: safe(async (a) => {
        const exclude = excludeOf(a.exclude, a.allow);
        const cc = countryCode(a.country);
        if (cc && !countryAllowed(cc, exclude)) return { status: "ok", note: excludedNote([cc]), deals: [] };
        const r = await hotelDeals();
        const deals = filterByCountry(r.deals, exclude).filter((d) => !cc || d.country === cc).slice(0, Math.min(20, Math.max(1, Math.round(a.limit ?? 10))));
        return {
          status: r.status,
          note: r.note ?? (r.status === "ok" && !deals.length ? (cc ? `no hotel deal in ${COUNTRIES[cc]?.name ?? cc} tonight` : "no city is a deal tonight: nowhere is 25% under its own typical price") : undefined),
          snapshots: r.snapshots,
          weekend: r.latest ? `${r.latest.checkin} to ${r.latest.checkout}` : undefined,
          citiesTracked: r.latest?.cities,
          deals: deals.map((d) => ({ city: d.city, country: COUNTRIES[d.country]?.name ?? d.country, hotel: d.hotel, stars: d.stars, rating: d.rating, perNight: Math.round(d.price), typical: d.typical, below: `${d.below}%`, nights: `${d.checkin} to ${d.checkout}` })),
        };
      }),
    }),

    ...(hasDb()
      ? {
          fare_history: tool({
            description: "What a route cost whenever anyone on Atlas looked, cheapest per departure date with the time it was seen: tells whether a fare is good now and how it moved. Airport codes or city names.",
            inputSchema: jsonSchema<{ from: string; to: string; dateFrom?: string; dateTo?: string }>({ type: "object", properties: { from: { type: "string" }, to: { type: "string" }, dateFrom: { type: "string" }, dateTo: { type: "string" } }, required: ["from", "to"] }),
            execute: safe(async (a) => {
              // A multi-airport city is asked for every airport (four at most a side); the pair
              // with the most fares seen is the history shown.
              const srcs = airportsArg(a.from, [gateways[0]]);
              const dsts = airportsArg(a.to, []);
              if (!srcs.length || !dsts.length) return { error: `unknown airport or city: ${!srcs.length ? a.from : a.to}` };
              const dateFrom = isoDay(a.dateFrom) ? a.dateFrom : undefined;
              const dateTo = isoDay(a.dateTo) ? a.dateTo : undefined;
              const pairs = srcs.flatMap((src) => dsts.map((dst) => ({ src, dst })));
              const results = await Promise.all(pairs.map(async (p) => ({ ...p, fares: await fareHistory(p.src, p.dst, dateFrom, dateTo, 25) })));
              const best = results.sort((x, y) => y.fares.length - x.fares.length)[0];
              return { route: `${best.src} to ${best.dst}`, ...(pairs.length > 1 ? { airportsTried: [...new Set(dsts)] } : {}), fares: best.fares };
            }),
          }),
        }
      : {}),

    plan_days: tool({
      description: "The day-by-day plan of a wild trip already built in this conversation: experiences, food and where, costs per day, a month's rent per city. Grounded in guides, live web research and rated restaurants. About a minute. Pass the `key` object exactly as wild_trip returned it (region, nights, style, budget, month, custom), either as `key` or as the same fields; `custom` already carries the window and the been list the trip was built with, so never rebuild it.",
      inputSchema: jsonSchema<{ key?: { region?: Region; nights?: number; style?: Style; budget?: Budget; month?: string; custom?: string }; region?: Region; nights?: number; style?: Style; budget?: Budget; month?: string; custom?: string }>({
        type: "object",
        properties: {
          key: { type: "object", description: "the key object wild_trip returned", properties: { region: { type: "string" }, nights: { type: "number" }, style: { type: "string" }, budget: { type: "string" }, month: { type: "string" }, custom: { type: "string" } } },
          region: { type: "string", enum: Object.keys(REGIONS) },
          nights: { type: "number" },
          style: { type: "string" },
          budget: { type: "string" },
          month: { type: "string" },
          custom: { type: "string" },
        },
      }),
      execute: safe(async (raw) => {
        // The key as wild_trip returned it, or the same fields flattened: both address the file.
        const a = { ...(raw.key && typeof raw.key === "object" ? raw.key : {}), ...Object.fromEntries(Object.entries(raw).filter(([k, v]) => k !== "key" && v != null)) } as { region?: Region; nights?: number; style?: Style; budget?: Budget; month?: string; custom?: string };
        if (!a.region || !Object.hasOwn(REGIONS, a.region)) return { error: "the trip's key (region, nights, style, budget, month, custom) as wild_trip returned it is needed" };
        const nights = Math.min(90, Math.max(7, Math.round(a.nights ?? 14)));
        const tripPath = wildPath(mainGateway(gateways), a.region, a.month ?? ctx.month, nights, a.style ?? "experiences", a.budget ?? "mid", a.custom ?? "");
        const path = planPath(tripPath);
        const stored = await readJson<Plan>(path);
        if (stored && stored.ageHours < 72) return { highlights: stored.body.highlights, days: stored.body.days, food: stored.body.food, monthly: stored.body.monthly, total: stored.body.total };
        const trip = await readJson<WildTrip>(tripPath);
        if (!trip) return { error: "build the trip first with wild_trip" };
        const plan = await planDays(trip.body, path);
        if (!plan) return { error: "the planner did not answer; try again" };
        await writeJson(path, plan).catch(() => null);
        return { highlights: plan.highlights, days: plan.days, food: plan.food, monthly: plan.monthly, total: plan.total };
      }),
    }),

    sights: tool({
      description: "What to see and do in a city from the Wikivoyage guide (names, a line each, photos exist), its festivals, and what the country is known for doing and eating.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: safe(async ({ city }) => {
        const hit = findCity(city);
        const name = hit ? hit[1].name : city;
        const [s, g] = await Promise.all([getSights(name), hit ? countryGuide(COUNTRIES[hit[1].country]?.name ?? hit[1].country) : null]);
        return { city: name, see: s?.see.slice(0, 8).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`), do: s?.do.slice(0, 6).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`), eat: s?.eat.slice(0, 5).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 90)}` : ""}`), festivals: s?.events.slice(0, 5), countryDo: g?.do.slice(0, 5), countryEat: g?.eat.slice(0, 4), guideUrl: s?.url };
      }),
    }),

    events_near: tool({
      description: "What's on in a city in the next weeks from the city's own open event feed (20 cities have one: Paris, Madrid, Lisbon, Bologna, Berlin, Helsinki, New York, Chicago, San Francisco, Brisbane, Taipei and more). Says so when a city has none.",
      inputSchema: jsonSchema<{ city: string; days?: number }>({ type: "object", properties: { city: { type: "string" }, days: { type: "number", description: "default 30" } }, required: ["city"] }),
      execute: safe(async ({ city, days }) => {
        const hit = findCity(city);
        if (!hit) return { error: `no city named ${city}` };
        const [, c] = hit;
        const near = sourcesNear(c.lat, c.lon);
        if (!near.length) return { city: c.name, events: [], note: "no open event feed for this city; use web_search for what's on" };
        const from = ctx.today;
        // One to sixty days ahead: the feeds are cached for three hours and list the coming weeks.
        const to = addDays(from, Math.min(60, Math.max(1, Math.round(Number(days) || 30))));
        const lists = await Promise.all(near.map((s) => s.fetch(from, to).catch(() => [])));
        const ev = lists.flat().filter((e) => !isNoise(e.name, e.kind)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
        return { city: c.name, sources: near.map((s) => s.attribution), events: ev.map((e) => ({ date: e.date, name: e.name, venue: e.venue, kind: e.kind, url: e.url })) };
      }),
    }),

    ...(hasFoursquare()
      ? {
          eats_near: tool({
            description: "Rated restaurants near a city centre that are good value (Foursquare rating 8+/10, price tier 1 or 2) with a tip each, or the best sweet places. Use for 'where should I eat in X', 'best ice cream in X'.",
            inputSchema: jsonSchema<{ city: string; sweet?: boolean }>({ type: "object", properties: { city: { type: "string" }, sweet: { type: "boolean" } }, required: ["city"] }),
            execute: safe(async ({ city, sweet }) => {
              const hit = findCity(city);
              if (!hit) return { error: `no city named ${city}` };
              const [, c] = hit;
              const r = sweet ? await sweetsNear(c.lat, c.lon) : await goodValueEats(c.lat, c.lon);
              if (r.status !== "ok") return { error: r.note ?? r.status };
              return r.places.map((p) => ({ name: p.name, rating: p.rating, price: "€".repeat(p.price ?? 1), category: p.category, address: p.address, tip: p.tip }));
            }),
          }),
        }
      : {}),

    ...(hasLiteApi()
      ? {
          hotels_near: tool({
            description: `The cheapest decent hotels near a city centre for given nights (LiteAPI, live prices${liteApiLive() ? "" : "; sandbox key: test prices, say so"}). A city in an excluded (been) country gets a note instead of hotels: a hotel night there is a stay there.`,
            inputSchema: jsonSchema<{ city: string; checkin: string; checkout: string; exclude?: string[]; allow?: string[] }>({ type: "object", properties: { city: { type: "string" }, checkin: { type: "string" }, checkout: { type: "string" }, ...BEEN_PROPS }, required: ["city", "checkin", "checkout"] }),
            execute: safe(async (a) => {
              const { city, checkin, checkout } = a;
              const hit = findCity(city);
              if (!hit) return { error: `no city named ${city}` };
              if (!isoDay(checkin) || !isoDay(checkout)) return { error: "checkin and checkout must be YYYY-MM-DD" };
              const [, c] = hit;
              // Sleeping in a been country is a stay there: the note answers, no hotel is fetched.
              const exclude = excludeOf(a.exclude, a.allow);
              if (!countryAllowed(c.country, exclude)) return { status: "skipped", note: excludedNote([c.country]), hotels: [] };
              const r = await hotelsNear(c.lat, c.lon, checkin, checkout, ctx.home);
              return { status: r.status, note: r.note, hotels: r.hotels.map((h) => ({ name: h.name, stars: h.stars, guests: h.rating, perNight: h.perNight, total: h.total })) };
            }),
          }),
        }
      : {}),

    ...(hasToken()
      ? {
          oneway_fares: tool({
            description: "Cheapest cached one-way fares out of an airport over the coming months (what people recently paid, Travelpayouts), by destination. Good for building your own multi-city routes. Destinations in excluded (been) countries are left out.",
            inputSchema: jsonSchema<{ origin: string; limit?: number; exclude?: string[]; allow?: string[] }>({ type: "object", properties: { origin: { type: "string", description: "IATA or city" }, limit: { type: "number" }, ...BEEN_PROPS }, required: ["origin"] }),
            execute: safe(async (a) => {
              const { origin, limit } = a;
              const from = airportArg(origin, gateways[0]);
              if (!from) return { error: `unknown airport or city ${origin}` };
              // The country a fare lands in: its city when we know one, else the airports file.
              const exclude = excludeOf(a.exclude, a.allow);
              const landsIn = (dst: string) => CITIES[CITY_OF_AIRPORT.get(dst) ?? ""]?.country ?? AIRPORT_BY_IATA.get(dst)?.country;
              const fares = (await allFares({ origin: from })).filter((f) => countryAllowed(landsIn(f.dst), exclude)).sort((a, b) => a.price - b.price).slice(0, Math.min(30, limit ?? 15));
              return { ...excludedSummary(exclude, [], a.exclude), fares: fares.map((f) => ({ to: f.dst, city: CITIES[CITY_OF_AIRPORT.get(f.dst) ?? ""]?.name, price: f.price, date: f.departureAt.slice(0, 10), stops: f.transfers, url: f.url })) };
            }),
          }),
        }
      : {}),

    ground_reach: tool({
      description: "Towns reachable by train, coach or ferry from where the traveller is, within a time limit (expected door-to-door minutes from timetables, Europe only), biggest first.",
      inputSchema: jsonSchema<{ maxHours?: number; limit?: number }>({ type: "object", properties: { maxHours: { type: "number", description: "default 5, max 10" }, limit: { type: "number" } } }),
      execute: safe(async (a) => {
        if (!ctx.origin) return { error: "the traveller's location is unknown" };
        const max = Math.min(600, Math.max(60, Math.round((a.maxHours ?? 5) * 60)));
        const r = reachFrom(ctx.origin.lat, ctx.origin.lon, max);
        const seen = new Set<string>();
        return r.reached
          .filter((s) => s.pop >= 15_000)
          .sort((x, y) => y.pop - x.pop)
          .filter((s) => !seen.has(s.town ?? s.name) && seen.add(s.town ?? s.name))
          .slice(0, Math.min(25, a.limit ?? 12))
          .map((s) => ({ town: s.town ?? s.name, population: s.pop, minutes: s.minutes, changes: s.changes, mode: s.mode }));
      }),
    }),

    place_facts: tool({
      description: "Facts about a city and its country: population, how known it is, counts of restaurants, bars, nightlife, culture, nature, currency and rate, plugs, languages, visa for the traveller's passport, travel warning, this weekend's high.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: safe(async ({ city }) => {
        const hit = findCity(city);
        if (!hit) return { error: `no city named ${city}` };
        const [code, c] = hit;
        const co = COUNTRIES[c.country];
        return { city: c.name, country: co?.name ?? c.country, population: c.pop, wikipediaViewsPerYear: FAME[code]?.[0], places: PLACES[code], currency: co?.currency, eurRate: co?.rate, plugs: co?.plugs, voltage: co?.voltage, languages: co?.languages, visaForHomePassport: c.country !== ctx.home ? visaFor(VISA, ctx.home, c.country) : "home country", travelWarning: co?.advisory?.warning ? "full" : co?.advisory?.partial ? "partial" : "none", weekendHighC: weekendMax(code), hiddenGem: isGem(FAME, code, 0, PLACES[code]) };
      }),
    }),

    ...(hasTavily()
      ? {
          web_search: tool({
            description: "Search the live web for current recommendations and facts: best traditional food and where locals eat, what's on this month, how to do a loop or a cruise, entry rules, prices. Returns page snippets with their sources; cite the site.",
            inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
            execute: safe(async ({ query }) => (await webSearch(String(query).slice(0, 200), 5)).map((h) => ({ title: h.title, source: h.url, snippet: h.content.slice(0, 600) }))),
          }),
        }
      : {}),
  };
}
