// Server-only. Everything Atlas can do, as tools the chat agent calls: the boards, the
// period search, the month-by-month scan, live re-pricing, combos, the graph walk (a loop of
// the cheapest hops, lib/graph-walk.ts), wild trips and their day
// plans, long stays, group trips, climate, the fare memory, sights, events, rated
// restaurants, hotels, one-way fares, trains and coaches, facts, the live web, and one
// widget question. Each answer is compact (a dozen items) so the model reads it whole; the
// deals it returns carry enough to draw cards and pins on the globe. No tool throws: a
// failure comes back as { error } with a one-line reason so the agent can say so and go on.
//
// Reliability rules (scripts/check-tools.ts checks them, docs/plans/chat-reliability.md
// explains them): every result carries `searched` (Kiwi searches spent now) and `source`
// (live, memo, boards, memory, data, feed, web, ...), so the model can say where a price came
// from; a live tool that cannot search (Kiwi's breaker open, the daily budget spent, every
// search refused) answers from what is known (tonight's boards, the fare memory, a stored
// trip) under a plain rate-limit note instead of { error }; an unknown place gets a note with
// close matches; a past or oddly written date gets a one-line correction; long builds report
// what they have when the time runs out. { error } is kept for inputs that cannot be acted on.
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
import { findCombos, neighboursOf } from "./combos";
import { BUDGET_MESSAGE, kiwiBudgetSpent, kiwiDate, kiwiStats, kiwiThrottled, nightsOf, searchFlight, THROTTLED_MESSAGE } from "./kiwi";
import { buildWild, customKey, findCityCode, resolveCountries, wildPath, REGIONS, STOPOVER_PROGRAMMES, type Budget, type Region, type Style, type Tradeoff, type WildTrip } from "./wild";
import { engineKeySuffix, wildByWalk } from "./wild-walk";
import { cleanPrefs, DEFAULT_PREFS, prefsLine, sameAsDefault, type Prefs } from "./prefs";
import { buildWildVariants, VARIANTS } from "./wild-variants";
import { hotelDeals } from "./hotel-deals";
import { purposeTrips } from "./purpose";
import { cheapestSeen, fareHistory, hasDb, type FareSeen } from "./db";
import { isoDay as realDay } from "./params";
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
import { cheapestWay, resolvePlace, type RouteLeg, type RouteOption, type RouteResult } from "./route-finder";
import { isGem, type FameFile } from "./gems";
import { scanCheapest, type ScanMonth } from "./scan";
import { longStay, LongStayInputError } from "./longstay";
import { GroupInputError, groupTrip, groupWindows, type GroupMember } from "./group";
import { bestMonths } from "./climate";
import { priceInsight } from "./insights";
import { WIDGET_KINDS, type WidgetKind, type WidgetSpec } from "./chat-widgets";
import { beenLine, cleanCodes, countryAllowed, excludedCountries, filterByCountry, type BeenPrefs } from "./been";
import { expandWeather, visaFor, type Airport, type City, type CityPlaces, type CountryInfo, type Deal, type VisaFile, type WeatherCompact } from "./types";
import { generateItinerary, hasItineraryModel, ItineraryInputError, normaliseSkeleton, skeletonFromStops } from "./itinerary-server";
import { itineraryKey, skeletonFromDeal, skeletonFromRoute, skeletonFromWild, type BudgetTier, type ItinDay, type Itinerary, type ItinPlace, type Pace, type Skeleton } from "./itinerary";
import { countryGroup, walkTrips, type WalkEvent, type WalkLeg, type WalkLoop, type WalkResult } from "./graph-walk";
import { walkQuery, walkWindow, type WalkLiveLine } from "./chat-widgets";

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
  /**
   * The traveller's trip style (lib/prefs.ts, kept in their browser and sent with every turn):
   * nights a place, pace, the price/comfort tradeoff, taste, places to avoid, the longest flight,
   * trains and coaches welcome. Every tool takes its defaults from it; what the traveller says
   * in the message wins for that trip. Absent means the tools' own defaults (DEFAULT_PREFS).
   */
  prefs?: Prefs;
  /**
   * Called with the parameters a tool is about to hand an engine (cheapest_way, wild_trip,
   * long_stay, group_trip), just before the call: the harness reads the deadline and budget
   * fields through it. A throw from it stops the tool before any search leaves (safe() turns
   * it into { error }), which is how the harness checks the parameters at no cost.
   */
  trace?: (engine: string, params: Record<string, unknown>) => void;
  /**
   * The latest route, deals, wild trip and loop this conversation showed, by kind: what
   * make_itinerary's `from: "last_route"` means. One map per request: the chat route fills it
   * from the thread's history first (rememberOutput), and every tool of the turn that
   * produces one of these replaces the entry, so "the latest" is the latest in the thread.
   */
  recent?: Map<RecentKind, unknown>;
};

/** What make_itinerary can be asked to plan from: the latest of each kind shown in the thread. */
export type RecentKind = "route" | "deal" | "wild";
/** The tools whose answers are remembered, and as what. */
const RECENT_KIND: Record<string, RecentKind> = { cheapest_way: "route", find_getaways: "deal", cheapest_deals: "deal", scan_cheapest: "deal", reprice_route: "deal", events_worth_travelling_for: "deal", wild_trip: "wild" };

/**
 * Records one tool answer in the context's recent map when it is a route, deals or a wild
 * trip (the chat has no short-loop tool, so a loop is never remembered). The raw payload is kept when the answer has it (this session's own results);
 * a thread restored from the browser has only the compact rows, which are kept instead, so
 * make_itinerary can still plan by place names. Errors, notes without data and other tools
 * are ignored. Exported for the chat route, which replays the thread's history through it.
 */
export function rememberOutput(ctx: AgentContext, toolName: string, output: unknown): void {
  const kind = RECENT_KIND[toolName];
  if (!kind || !output || typeof output !== "object") return;
  const o = output as Record<string, unknown>;
  if (typeof o.error === "string") return;
  const recent = ctx.recent ?? (ctx.recent = new Map());
  const raw = o.raw as Record<string, unknown> | unknown[] | undefined;
  if (kind === "route") {
    if (raw && !Array.isArray(raw) && Array.isArray(raw.options) && raw.options.length) recent.set("route", raw);
    // A restored thread has only the compact rows: the ends, the dates and each option's kind
    // and title (its legs are sentences, not places), so make_itinerary can at least say
    // which option it could not rebuild and keep a one-way trip one way.
    else if (Array.isArray(o.options) && o.options.length && typeof o.to === "string")
      recent.set("route", { from: o.from, to: o.to, depart: o.depart, nights: o.nights, compact: (o.options as Record<string, unknown>[]).map((x) => ({ kind: String(x?.kind ?? ""), title: String(x?.title ?? "") })) });
  } else if (kind === "deal") {
    if (Array.isArray(raw) && raw.length) recent.set("deal", raw);
    else if (Array.isArray(o.deals) && o.deals.length) recent.set("deal", o.deals);
  } else if (kind === "wild") {
    if (raw && !Array.isArray(raw) && Array.isArray(raw.stops) && raw.stops.length) recent.set("wild", raw);
  }
}

/** True when the walk can read the word as a place to avoid: a group ("dach", "like:DE"), a country by code or
 * name, or a city. A word it cannot read would refuse every walk ("unknown place to avoid"), so the chat never
 * carries one: lib/prefs.ts keeps any two letters, and "XX" is no country. */
function avoidable(s: string): boolean {
  if (countryGroup(s)) return true;
  if (/^[A-Za-z]{2}$/.test(s)) return !!COUNTRIES[s.toUpperCase()];
  return !!findCityCode(s) || resolveCountries([s]).codes.length > 0;
}
/**
 * The trip style a client sent with the turn: lib/prefs.ts cleanPrefs clamps every field (nights
 * a place 1 to 14, the least first; each choice from its own list; the longest flight 1 to 40 h),
 * then the avoid words the walk could not read are dropped. Undefined when no object was sent, so
 * an old client (or the CLI without flags) keeps the tools on their own defaults. Exported for the
 * CLI and the harness.
 */
export function chatPrefs(raw: unknown): Prefs | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = cleanPrefs(raw);
  return { ...p, avoid: p.avoid.filter(avoidable) };
}

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
  // The ticket lands in `city` and flies home from another city nearby: a two-city trip.
  ...(d.backFromCity ? { homeFrom: d.backFromCity, between: d.gapMin ? `about ${Math.round((d.gapMin / 60) * 10) / 10} h by road, train or ferry, not on the ticket` : "not on the ticket" } : {}),
  trick: d.trick,
  url: d.url,
});
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetweenIso = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
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
/** How long one chat turn waits for a wild build before answering with what is stored; the
 * build goes on in the background and is stored when done. The chat route allows 300 s in all,
 * and the model needs some of that to write. */
const WILD_BUILD_MS = Math.max(30_000, Number(process.env.WILD_BUILD_MS) || 170_000);
/** The same cap for a long stay or a group trip: the engines answer what they priced so far. */
const LONG_BUILD_MS = Math.max(30_000, Number(process.env.LONG_BUILD_MS) || 150_000);
/** The engines get a deadline this much before the race fires, so they close their answer
 * (the way home, the bases priced so far) and hand it back whole; the race is the last resort. */
const DEADLINE_MARGIN_MS = 10_000;
/** How long one chat turn's tools may run in all: the route allows 300 s and the model needs
 * the rest to write. cheapest_way's own deadline never reaches past this. */
const TURN_MS = Math.max(60_000, Number(process.env.CHAT_TURN_MS) || 270_000);
/** Searches cheapest_way may spend from the turn's budget: twelve, twenty-four when the
 * traveller asked to look harder ("search harder", "every option"). */
const ROUTE_SEARCHES = 12;
const ROUTE_SEARCHES_HARDER = 24;
/** How long cheapest_way lets the route engine run: its own default, longer when asked to
 * look harder; always cut to what is left of the turn, and the engine floors it at ten seconds. */
const ROUTE_DEADLINE_MS = 90_000;
/** How long make_itinerary waits for the days: the engine writes a stop a model call at a
 * time, so a week in two cities is about a minute; past this the days written so far come
 * back as a partial itinerary (the view can finish it). Never past the turn's own clock. */
const ITINERARY_MS = Math.max(30_000, Number(process.env.CHAT_ITINERARY_MS) || 150_000);
const ROUTE_DEADLINE_HARDER_MS = 150_000;
/** Searches walk_trips may spend from the turn's budget: the owner's own case (beam 2, three stops) needs
 * about ten (one "anywhere" from home, one per expanded stop, the ways home); the engine stops at this. */
const WALK_SEARCHES = 12;
/** The most a long walk may spend: two searches a stop plus the way out and home, for up to 16 stops, capped. */
const WALK_SEARCHES_MAX = 40;
/** A ground hop's limit in minutes: the walk's default (Warsaw to Gdansk is 310), and "only trains between cities". */
const WALK_GROUND_MIN = 330;
const WALK_GROUND_PREFER_MIN = 480;
/** The wishes "unique" adds to a wild trip: word for word what /api/wild, /api/plan and the Wild tab add (joined with
 * ", "), because the wishes are hashed into the stored trip's key and any other wording keys the same trip twice. */
export const UNIQUE_WISHES = "unique places and hidden gems over the big hubs";
/** States followed at each depth of the walk in the chat: two, the owner's case (docs/plans/graph-walk.md). */
const WALK_BEAM = 2;
/** The walk's own limit (the engine's default); always cut to what is left of the turn. */
const WALK_DEADLINE_MS = 90_000;
/** A walk of many stops gets more time, but never past this (the turn has 270 s for everything). */
const WALK_DEADLINE_MAX_MS = 150_000;
/** The live lines (nodes, edges, loops) a chat walk sends the globe, and how often: a walk sees a few hundred edges,
 * past this only the chosen ones and the loops go on. */
const WALK_LIVE_MAX = 600;
const WALK_LIVE_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Big countries where the way home from another city is worth pricing in the same scan. */
export const OPEN_JAW_COUNTRIES = ["United States", "Canada", "Brazil", "Australia", "China", "India", "Japan", "Indonesia", "Mexico", "Argentina", "Russia"];

/** The one sentence every fallback answer carries, so the model says it in one line. */
export const RATE_NOTE = "live prices are rate-limited, this is from tonight's boards and the fare memory";
/** The sentence when it is only this turn's budget that is spent: nothing is rate-limited,
 * a new message searches at once. Never joined with RATE_NOTE. */
export const TURN_NOTE = "this turn's search budget is spent; ask again in a new message for live prices";
/** Where a result came from; the model is told to say so when it quotes a price. */
export type Source = "live" | "memo" | "boards" | "memory" | "stored" | "data" | "feed" | "web" | "liteapi" | "foursquare" | "travelpayouts" | "model" | "none";
type Plain = { searched: number; source: Source; note: string; count: 0 };
/** A plain note answer: no data, but a sentence the model can act on. Never an empty object.
 * `count: 0` is what the chat's chip reads to show the note in amber instead of a tick. */
const plain = (note: string, source: Source = "none", searched = 0): Plain => ({ searched, source, note, count: 0 });

/** True for the errors Kiwi's gate throws when live prices are off: the breaker, the daily budget. */
const isRateLimit = (msg: string) => msg.includes(THROTTLED_MESSAGE) || msg.includes(BUDGET_MESSAGE) || /rate-limit|throttl|429|403/i.test(msg);
/** True while no live search can leave this process: the breaker is open or the budget is spent. */
const liveOff = () => kiwiThrottled() || kiwiBudgetSpent();

/** Wraps a tool body: whatever goes wrong comes back as { error } in one line, never a throw.
 * A throw caused by Kiwi's throttle is not an error of the request: it becomes a note, so
 * the model says live prices are off and offers to retry, instead of reporting a failure. */
function safe<A, R>(fn: (a: A) => Promise<R>): (a: A) => Promise<R | { error: string } | Plain> {
  return async (a) => {
    try {
      return await fn(a);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160) || "failed";
      if (isRateLimit(msg)) return plain(`${RATE_NOTE}; nothing stored matched this request, so there is no price to show. Offer to try again in a few minutes.`);
      return { error: msg };
    }
  };
}

/** A bounded edit distance, for "did you mean" over city names; stops counting past `max`. */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The cities in cities.json that look like what was typed: a prefix or a word inside the name
 * first, then names within three edits; biggest first within each group, five at most. */
export function closeCities(name: string, limit = 5): string[] {
  const q = fold(name);
  if (!q || q.length < 2) return [];
  const label = ([, c]: [string, City]) => `${c.name} (${COUNTRIES[c.country]?.name ?? c.country})`;
  const starts = CITY_LIST.filter(([, c]) => fold(c.name).startsWith(q)).sort(byPop);
  const inside = CITY_LIST.filter(([, c]) => !fold(c.name).startsWith(q) && fold(c.name).includes(q)).sort(byPop);
  const near = q.length >= 4 ? CITY_LIST.filter(([, c]) => editDistance(fold(c.name), q) <= (q.length >= 7 ? 3 : 2)).sort(byPop) : [];
  const out: string[] = [];
  for (const hit of [...starts, ...inside, ...near]) {
    const l = label(hit);
    if (!out.includes(l)) out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}

/** The note for a place we do not know: what was typed and the closest names, so the model
 * can pick one or ask, instead of a dead end. */
function unknownPlace(what: string, raw: string): Plain {
  const close = closeCities(raw);
  return plain(`${what} "${raw}" is not a city or airport we know${close.length ? `; close matches: ${close.join(", ")}` : "; try the nearest big city or its airport code"}`, "data");
}

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const pad2 = (n: string | number) => String(n).padStart(2, "0");

/**
 * A day written any of the usual ways, as YYYY-MM-DD: ISO, "2026-11-5", "14/11/2026",
 * "14.11.2026", "14 November 2026", "Nov 14 2026", "today", "tomorrow", "next friday". A
 * year-less "14 November" is placed in the next twelve months from `today`; a weekday is the
 * coming one. Words are read only when a month name AND a day number are really there: the
 * engine's own Date.parse keeps a bare year out of "this weekend 2026" and answers 1 January,
 * so it is never used. Null when nothing readable is there, and never a throw.
 */
export function parseDay(s: unknown, today: string): string | null {
  if (typeof s !== "string") return null;
  const raw = s.trim();
  if (!raw) return null;
  const strict = realDay(raw);
  if (strict) return strict;
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return realDay(`${m[1]}-${pad2(m[2])}-${pad2(m[3])}`);
  m = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return realDay(`${m[3]}-${pad2(m[2])}-${pad2(m[1])}`);
  const q = fold(raw).replace(/[,.]/g, " ").replace(/\s+/g, " ").trim();
  // Relative words, from the traveller's own calendar day.
  if (q === "today" || q === "now" || q === "tonight" || q === "asap") return today;
  if (q === "tomorrow") return addDays(today, 1);
  if (q === "day after tomorrow" || q === "the day after tomorrow") return addDays(today, 2);
  // "friday", "this friday", "next friday", "on friday": the coming one, never today itself.
  const wd = q.match(/^(?:on |this |next |coming |this coming )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (wd) {
    const target = WEEKDAYS.findIndex((d) => d.startsWith(wd[1]));
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    const delta = ((target - cur + 7) % 7) || 7;
    return addDays(today, delta);
  }
  // Words with a month name and a day number: "14 November 2026", "Nov 14", "November 14, 2026".
  const monthHit = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  const dayHit = q.replace(/\b\d{4}\b/g, " ").match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (!monthHit || !dayHit) return null;
  const month = MONTH_ABBR.indexOf(monthHit[1]) + 1;
  const day = Number(dayHit[1]);
  if (month < 1 || day < 1 || day > 31) return null;
  const yearHit = q.match(/\b(\d{4})\b/);
  const year = yearHit ? Number(yearHit[1]) : Number(today.slice(0, 4));
  const iso = realDay(`${year}-${pad2(month)}-${pad2(day)}`);
  if (!iso) return null;
  if (!yearHit && iso < today) return realDay(`${year + 1}-${pad2(month)}-${pad2(day)}`);
  return iso;
}

/** A day as parseDay reads it, with a one-line note saying how a non-ISO input was read, so
 * the answer can state the interpretation ("next friday" read as 2026-10-16). */
function readDay(s: unknown, today: string, what: string): { day: string | null; note?: string } {
  const day = parseDay(s, today);
  if (!day) return { day: null, note: typeof s === "string" && s.trim() ? `${what} "${String(s).trim()}" is not a date I can read; use YYYY-MM-DD` : `${what} is needed as YYYY-MM-DD` };
  const raw = typeof s === "string" ? s.trim() : "";
  return raw === day ? { day } : { day, note: `${what} "${raw}" read as ${day}` };
}

/** A day that must be in the future: a past one moves to today, with a one-line note. */
function futureDay(s: unknown, today: string, what: string): { day: string | null; note?: string } {
  const r = readDay(s, today, what);
  if (!r.day) return r;
  if (r.day < today) return { day: today, note: `${what} ${r.day} is in the past; searched from today (${today}) instead` };
  return r;
}

/** A deal from the fare memory, so a remembered fare draws like any other card. */
function dealFromFare(f: FareSeen): Deal {
  const cityCode = CITY_OF_AIRPORT.get(f.dst) ?? (CITIES[f.dst] ? f.dst : f.dst);
  const known = CITIES[cityCode];
  const airport = AIRPORT_BY_IATA.get(f.dst);
  return { gw: f.src, dst: f.dst, dstCity: cityCode, city: known?.name ?? airport?.city ?? f.dst, country: known?.country ?? airport?.country ?? "", price: Math.round(f.price), out: f.out, back: f.back ?? "", nights: f.nights ?? 0, stops: f.stops, carriers: f.carriers, outMin: Math.round(f.hours * 60), backMin: 0, url: f.url };
}

/** What is known without a live search: tonight's boards for the traveller's airports and
 * the fare memory, for a place (a city, a country, an airport, or nothing for "anywhere")
 * inside a departure window. The answer says which source it came from. */
async function knownFares(gateways: string[], origins: string[], place: string | undefined, from?: string, to?: string, month?: string, turn = false): Promise<{ source: Source; deals: Deal[]; fares: FareSeen[]; note: string }> {
  const city = place ? findCity(place) : null;
  const cc = city ? city[1].country : countryCode(place);
  const airports = place ? airportsArg(place, []) : [];
  const inWindow = (d: { out: string }) => (!from || d.out >= from) && (!to || d.out <= to);
  let deals: Deal[] = [];
  try {
    const src = await dealsFor(gateways, month);
    deals = src.deals.filter((d) => (city ? d.dstCity === city[0] || fold(d.city) === fold(city[1].name) : cc ? d.country === cc : true) && inWindow(d)).slice(0, 6);
  } catch {
    // no store and no fallback file: the memory may still answer
  }
  let fares: FareSeen[] = [];
  if (airports.length && from && to) {
    try {
      const one = await cheapestSeen(origins, airports, from, to, 30, city?.[1].name);
      const hist = await fareHistory(origins[0] ?? gateways[0], airports[0], from, to, 8);
      fares = [...(one ? [one] : []), ...hist.filter((h) => !one || h.url !== one.url)].slice(0, 8);
    } catch {
      // the memory is optional
    }
  }
  const source: Source = deals.length ? "boards" : fares.length ? "memory" : "none";
  const has = [deals.length ? "tonight's boards" : "", fares.length ? "the fare memory" : ""].filter(Boolean);
  // The turn's own budget is not a rate limit: the note then says a new message works at once.
  const note = turn
    ? `${TURN_NOTE}; ${has.length ? `shown from ${has.join(" and ")}` : "nothing stored matches this request"}`
    : has.length
      ? `${RATE_NOTE} (${has.join(" and ")}; a board fare was searched last night, a remembered fare is what someone saw in the last 30 days). Offer to try live again in a few minutes.`
      : `${RATE_NOTE}; nothing stored matches this request. Offer to try again in a few minutes.`;
  return { source, deals, fares, note };
}

/** A fare memory row shaped like a reprice itinerary, so the same cards draw it. */
const itinFromFare = (f: FareSeen) => ({ price: Math.round(f.price), to: f.dst, out: f.out, back: f.back ?? undefined, nights: f.nights, stops: f.stops, via: [] as string[], carriers: f.carriers, hours: f.hours, url: f.url, seenAt: f.seenAt.slice(0, 10) });

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
/** walk_trips' answer for the model: no raw WalkResult and no query object (both only draw the globe and
 * run the walk again in the browser); the compact loops say the same. */
const withoutClientFields = ({ output }: { output: unknown }): { type: "json"; value: JSONValue } => {
  if (output && typeof output === "object") {
    const { raw: _raw, params: _params, ...rest } = output as Record<string, unknown>;
    void _raw;
    void _params;
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
  /** Milliseconds this turn's tools may still run; a tool's own deadline never reaches past it. */
  const turnLeftMs = () => Math.max(0, turnStart + TURN_MS - Date.now());
  /** The parameters handed to an engine, shown to the harness first (see AgentContext.trace). */
  const trace = (engine: string, params: Record<string, unknown>) => ctx.trace?.(engine, params);
  const charged = new Set<string>();
  const builtNow = (r: { generatedAt?: string } | null | undefined): boolean => {
    const at = r?.generatedAt;
    if (!at || Date.parse(at) < turnStart || charged.has(at)) return false;
    charged.add(at);
    return true;
  };
  /** The origin point for "how far is that": the browser's location, else the first airport. */
  const originPoint = (): { lat: number; lon: number } | null => ctx.origin ?? resolveGateway(gateways[0]) ?? null;
  // The trip style (lib/prefs.ts): the defaults of every tool below, so "2 to 3 nights a place"
  // set once in the app reaches the walk, the wild loop and the rest without the model having to
  // repeat it. An input the model writes (the traveller's words this time) always wins.
  const prefs: Prefs = ctx.prefs ?? DEFAULT_PREFS;
  /** True when the traveller changed the nights a place themselves. The single-place tools
   * (find_getaways, group_trip) read those nights only then: a getaway is one place, and the
   * default 2 to 3 nights a place would cut every week-long trip to three nights. Another
   * change (the tradeoff, the avoid list) leaves their nights alone. */
  const nightsStyled = !!ctx.prefs && (ctx.prefs.nightsPerPlace[0] !== DEFAULT_PREFS.nightsPerPlace[0] || ctx.prefs.nightsPerPlace[1] !== DEFAULT_PREFS.nightsPerPlace[1]);
  const styleNights = (p: Prefs = prefs) => (p.nightsPerPlace[0] === p.nightsPerPlace[1] ? `${p.nightsPerPlace[0]}` : `${p.nightsPerPlace[0]} to ${p.nightsPerPlace[1]}`);
  /** The style's avoid words as ISO2 codes (a group word is its countries; a city is none), for
   * the tools that filter a list of places by country. */
  const avoidCountries = (words: string[]): Set<string> => {
    const out = new Set<string>();
    for (const w of words) {
      const g = countryGroup(w);
      if (g) for (const cc of g.codes) out.add(cc);
      else if (!findCityCode(w)) for (const cc of resolveCountries([w]).codes) out.add(cc);
    }
    return out;
  };
  /** The line an answer carries when it used the style's defaults, so the model can say so in a few words. */
  const styleLine = (used: string[]) => (used.length ? { tripStyle: `from the traveller's trip style: ${used.join(", ")}` } : {});
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
  const tools = {
    home_airports: tool({
      description: "The traveller's airports with drive time, size and whether a nightly price board exists. Use for 'which airport should I fly from'.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: safe(async () => {
        if (!ctx.origin) return { searched: 0, source: "data" as Source, count: gateways.length, airports: gateways.map((g) => ({ iata: g, name: AIRPORT_BY_IATA.get(g)?.name, city: AIRPORT_BY_IATA.get(g)?.city, searchedNightly: true })), note: "the traveller's exact location is unknown; these are the airports the app searches nightly" };
        const airports = nearestGateways(AIRPORTS, ctx.origin.lat, ctx.origin.lon, { maxKm: 350, limit: 6 }).map((g) => ({ iata: g.airport.iata, name: g.airport.name, city: g.airport.city, size: g.airport.size, driveMinutes: g.driveMin, km: Math.round(g.km), searchedNightly: gateways.includes(g.airport.iata) }));
        return { searched: 0, source: "data" as Source, count: airports.length, airports, ...(airports.length ? {} : { note: "no airport within 350 km of the traveller's location in the airports file" }) };
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
        // A country by name or code; a city name in the country field ("Lisbon") means its
        // country; anything else is a note with close matches, never a silent empty list.
        const countryRaw = (a.country ?? "").trim();
        const cc = countryCode(countryRaw) ?? (countryRaw ? findCity(countryRaw)?.[1].country : undefined);
        if (countryRaw && !cc) return { ...unknownPlace("country", countryRaw), source: "boards" as Source, count: 0, deals: [] };
        // A country the traveller has been to and does not want again: say so, read nothing.
        if (cc && !countryAllowed(cc, exclude)) return { searched: 0, source: "boards" as Source, count: 0, deals: [], note: excludedNote([cc]) };
        const month = a.month && /^\d{4}-\d{2}$/.test(a.month) ? a.month : ctx.month;
        const src = await dealsFor(gateways, month);
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
        const filters = [a.maxPrice != null ? `under €${a.maxPrice}` : "", a.direct ? "direct" : "", a.warm ? "warm this weekend" : "", cc ? nameOf(cc) : "", a.city ? a.city : "", a.gems ? "hidden gems" : "", a.minNights != null || a.maxNights != null ? `${a.minNights ?? 2} to ${a.maxNights ?? 7} nights` : ""].filter(Boolean);
        return { searched: 0, source: "boards" as Source, searchedOn: src.updated.slice(0, 10), airports: src.gateways, count: out.length, ...excludedSummary(exclude, [], a.exclude), ...(out.length ? {} : { note: `no board deal from ${src.gateways.join(", ")} matches ${filters.join(", ") || "the filters"} (${src.deals.length} deals on the boards); loosen a filter or use find_getaways for a live search` }), deals: out.map((d) => ({ ...compactDeal(d), weekendHighC: weekendMax(d.dstCity) })), raw: out };
      }),
      toModelOutput: withoutRaw,
    }),

    find_getaways: tool({
      description: "A live search for a trip inside a period: 'between 20 and 30 October, 3 to 6 nights, away on the 26th, from any of my airports, anywhere or a country, direct, home may land at another of my airports'. About 20 live Kiwi searches, half a minute. Use whenever the traveller gives dates or a period and the place is open (anywhere, a region, a country). Several countries: a comma list in where. Excluded (been) countries are taken out of where before searching and never land; layovers through them are fine.",
      inputSchema: jsonSchema<{ from: string; to: string; include?: string; minNights?: number; maxNights?: number; direct?: boolean; maxHours?: number; where?: string; origins?: string[]; returnTo?: string[]; tricks?: boolean; exhaustive?: boolean; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          from: { type: "string", description: "YYYY-MM-DD, start of the period" },
          to: { type: "string", description: "YYYY-MM-DD, end of the period (be home by)" },
          include: { type: "string", description: "YYYY-MM-DD the traveller must be away on, optional" },
          minNights: { type: "number", description: "default 2 (or the trip style's nights a place when the traveller changed it)" },
          maxNights: { type: "number", description: "default 7 (or the trip style's nights a place when the traveller changed it)" },
          direct: { type: "boolean" },
          maxHours: { type: "number", description: "max hours per flight leg; 0 for no limit; omitted means the trip style's longest flight, if set" },
          where: { type: "string", description: "'anywhere' (default), a region (Europe, Asia) or country names, comma separated" },
          origins: { type: "array", items: { type: "string" }, description: "IATA codes or city names; default the traveller's airports" },
          returnTo: { type: "array", items: { type: "string" }, description: "other home airports the flight back may land at (open-jaw)" },
          tricks: { type: "boolean", description: "also scan hidden-city one-ways (risky; only when asked)" },
          exhaustive: { type: "boolean", description: "true when the traveller says 'anywhere' or 'the cheapest possible': the engine goes through many more targets (nearby airports, hubs, ground legs) and spends more searches" },
          ...BEEN_PROPS,
        },
        required: ["from", "to"],
      }),
      execute: safe(async (a) => {
        // Dates written any usual way; a past start moves to today; an end before the start
        // becomes a week after it. Each correction is one line in the answer, not a refusal.
        const corrections: string[] = [];
        const f = futureDay(a.from, ctx.today, "the period start");
        if (!f.day) return { error: f.note! };
        if (f.note) corrections.push(f.note);
        const t = readDay(a.to, ctx.today, "the period end");
        if (!t.day) return { error: t.note! };
        if (t.note) corrections.push(t.note);
        let to = t.day;
        if (to < f.day) {
          corrections.push(`the period ended (${to}) before it started (${f.day}); searched ${f.day} to ${addDays(f.day, 7)} instead`);
          to = addDays(f.day, 7);
        }
        const from = f.day;
        const include = parseDay(a.include, ctx.today);
        const origins = codesOf(a.origins, gateways);
        if (!origins.length) return { ...unknownPlace("origin", (a.origins ?? []).join(", ")), found: 0, deals: [] };
        // Been countries asked for by name are dropped before any search is sent; when every
        // place asked for is one of them there is nothing to search, and the answer says so.
        const exclude = excludeOf(a.exclude, a.allow);
        const { kept, dropped } = splitWhere(a.where, exclude);
        if (!kept.length && dropped.length) return { searched: 0, source: "none" as Source, found: 0, deals: [], note: excludedNote(dropped) };
        // A comma list of countries is one search per country per target; four is the cap.
        const where = kept.slice(0, 4).join(",") || "anywhere";
        const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
        // The trip style's defaults: its nights a place only when the traveller changed them (a getaway is one
        // place, and the default 2 to 3 would cut every week away to three nights), its longest flight, and its
        // avoid list as countries no deal may land in.
        const fromStyle: string[] = [];
        const minNights = a.minNights ?? (nightsStyled ? prefs.nightsPerPlace[0] : 2);
        const maxNights = a.maxNights ?? (nightsStyled ? Math.max(minNights, prefs.nightsPerPlace[1]) : Math.max(minNights, 7));
        if (nightsStyled && (a.minNights == null || a.maxNights == null)) fromStyle.push(`${styleNights()} nights`);
        const maxHours = a.maxHours ?? prefs.maxFlightHours;
        if (a.maxHours == null && prefs.maxFlightHours) fromStyle.push(`flights under ${prefs.maxFlightHours} h`);
        const disliked = avoidCountries(prefs.avoid);
        if (disliked.size) fromStyle.push(`avoiding ${prefs.avoid.join(", ")}`);
        const liked = (d: Deal) => !disliked.has(d.country);
        // Known fares stand in when nothing live can be searched: the breaker, the budget, the
        // turn's cap, or a run in which every search was refused.
        const fallback = async (reason: string, searched = 0, turn = false) => {
          const known = await knownFares(gateways, origins, kept.length === 1 ? kept[0] : undefined, from, to, from.slice(0, 7), turn);
          const deals = filterByCountry([...known.deals, ...known.fares.map(dealFromFare)], exclude).filter(liked).filter((d) => d.nights >= minNights && d.nights <= maxNights || !d.nights).slice(0, 10);
          return { searched, source: known.source, found: deals.length, ...corrected, ...excludedSummary(exclude, dropped, a.exclude), ...styleLine(fromStyle), note: `${reason}; ${known.note}`, deals: deals.map(compactDeal), raw: deals };
        };
        if (liveOff()) return fallback(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent");
        const over = exhausted();
        if (over) return fallback(over.error, 0, true);
        const r = await findDeals({ origins, from, to, include: include ?? undefined, minNights, maxNights, direct: a.direct, maxHours: maxHours || undefined, where, returnTo: codesOf(a.returnTo, []), tricks: a.tricks, exclude, ...(a.exhaustive ? { exhaustive: true, origin: ctx.origin } : {}) });
        spend(r.searched);
        const seen = new Set<string>();
        const deals = filterByCountry(r.deals, exclude).filter(liked);
        if (!deals.length && r.failed > 0 && r.failed >= r.searched) return fallback(`every live search was refused (${r.failed} of ${r.searched})`, r.searched);
        const top = deals.filter((d) => !seen.has(d.dstCity + (d.backTo ?? "")) && seen.add(d.dstCity + (d.backTo ?? ""))).slice(0, 14);
        const note = r.note ?? (r.failed ? `${r.failed} of ${r.searched} searches failed (Kiwi refused); the list may be missing places` : !deals.length ? `no fare found for ${where} between ${from} and ${to} from ${origins.join(", ")} with ${minNights} to ${maxNights} nights${a.direct ? ", direct only" : ""}; widen the dates or the nights` : undefined);
        return { searched: r.searched, source: "live" as Source, found: deals.length, openJaw: r.openJaw, ...corrected, ...excludedSummary(exclude, dropped, a.exclude), ...styleLine(fromStyle), ...(note ? { note } : {}), deals: top.map(compactDeal), raw: top };
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
        if (!origins.length) return { ...unknownPlace("origin", (a.origins ?? []).join(", ")), to: a.to.trim(), best: null, months: [] };
        const exclude = excludeOf(a.exclude, a.allow);
        const dst = findCity(a.to);
        // A city in a been country, or the country itself: nothing to scan, and no search spent.
        const dstCountry = dst ? dst[1].country : countryCode(a.to);
        if (dstCountry && !countryAllowed(dstCountry, exclude)) return { to: dst?.[1].name ?? a.to.trim(), searched: 0, source: "none" as Source, best: null, months: [], note: excludedNote([dstCountry]) };
        // Coming home from another city of a been country would mean a stay there: the
        // open-jaw leg is dropped and the answer says so.
        const jawCountry = countryCode(a.openJawFrom?.trim()) ?? findCity(a.openJawFrom ?? "")?.[1].country;
        const jawDropped = !!jawCountry && !countryAllowed(jawCountry, exclude);
        const to = dst ? (dst[1].airports.length === 1 ? dst[1].airports[0] : dst[0]) : a.to.trim();
        const label = dst?.[1].name ?? a.to.trim();
        // A place that is neither a city, a country nor a code we know still goes to Kiwi
        // (it resolves many names), but the answer says so, and an empty calendar then lists
        // close matches instead of looking like "no flights".
        const unknown = !dst && !dstCountry && !/^[A-Za-z]{3}$/.test(a.to.trim());
        // The calendar from what is known: the memory's cheapest fare per month into the
        // destination's airports, then the boards. Used when nothing live can be searched.
        const fallback = async (reason: string, months: string[], searched = 0, turn = false) => {
          const airports = airportsArg(a.to, []);
          const rows: ScanMonth[] = [];
          for (const month of months) {
            const [y, m] = month.split("-").map(Number);
            const first = `${month}-01`;
            const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
            const f = airports.length ? await cheapestSeen(origins, airports, first, last, 30, dst?.[1].name).catch(() => null) : null;
            rows.push(f ? { month, cheapest: Math.round(f.price), out: f.out, back: f.back ?? undefined, nights: f.nights ?? undefined, stops: f.stops, carriers: f.carriers, url: f.url, from: f.src, to: f.dst, remembered: true } : { month, cheapest: null });
          }
          const known = await knownFares(gateways, origins, a.to, undefined, undefined, undefined);
          for (const d of known.deals) {
            const i = rows.findIndex((r) => r.month === d.out.slice(0, 7));
            if (i >= 0 && (rows[i].cheapest == null || d.price < rows[i].cheapest!)) rows[i] = { month: d.out.slice(0, 7), cheapest: d.price, out: d.out, back: d.back, nights: d.nights, stops: d.stops, carriers: d.carriers, url: d.url, from: d.gw, to: d.dst, toCity: d.city, remembered: true };
          }
          const priced = rows.filter((r) => r.cheapest != null);
          const best = priced.sort((x, y) => x.cheapest! - y.cheapest!)[0] ?? null;
          const raw = filterByCountry(rows.map((m) => dealFromMonth(m, origins, to, dst, label)).filter((d): d is Deal => !!d), exclude);
          return { to: label, origins, searched, source: (priced.length ? (known.deals.length ? "boards" : "memory") : "none") as Source, oneWay: !!a.oneWay, ...excludedSummary(exclude, [], a.exclude), note: turn ? `${reason}; ${priced.length ? `${priced.length} of ${months.length} months have a remembered fare` : `nothing stored for ${label} yet`}` : `${reason}; ${priced.length ? `${RATE_NOTE} (${priced.length} of ${months.length} months have a remembered fare)` : `${RATE_NOTE}; nothing stored for ${label} yet`}. Offer to try live again in a few minutes.`, best: best ? row(best) : null, months: rows.map(row), openJaw: [], raw };
        };
        const monthsOf = (n: number, start?: string) => {
          const base = start ? `${start}-01` : `${ctx.today.slice(0, 7)}-01`;
          const [y, m] = base.split("-").map(Number);
          return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7));
        };
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
        // A month whose search failed (Kiwi refused) is unknown, not empty: the calendar says so.
        const row = (m: ScanMonth) => ({ month: m.month, cheapest: m.cheapest, out: m.out, back: m.back, nights: m.nights, perNight: m.cheapest != null && m.nights ? Math.round(m.cheapest / m.nights) : undefined, stops: m.stops, airline: m.carriers?.[0], from: m.from, homeFrom: m.openJawTo, url: m.url, url2: m.url2, also: m.also?.slice(0, 2).map((x) => ({ cheapest: x.cheapest, out: x.out, back: x.back })), ...(m.failed ? { failed: true } : {}), ...(m.remembered ? { remembered: true } : {}) });
        if (liveOff()) return fallback(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent", monthsOf(months, startMonth));
        const over = exhausted();
        if (over) return fallback(over.error, monthsOf(months, startMonth), 0, true);
        const r = await scanCheapest({ origins, to, months, minNights, maxNights, oneWay: a.oneWay, openJawFrom, startMonth, exclude });
        // A memoised calendar (the same scan within the hour) made no live search now.
        const live = builtNow(r);
        spend(live ? r.searched : 0);
        // Every month refused: the calendar from the memory and the boards, under the note.
        if (r.months.length && r.failed >= r.months.length && !r.months.some((m) => m.cheapest != null)) return fallback(`every live search was refused (${r.failed})`, r.months.map((m) => m.month), live ? r.searched : 0);
        // A country scan may land a month in a been country: that pin is dropped (the engine
        // skips such months itself once it knows the list; this keeps the globe honest anyway).
        const raw = filterByCountry(r.months.map((m) => dealFromMonth(m, origins, to, dst, label)).filter((d): d is Deal => !!d), exclude);
        const remembered = r.months.filter((m) => m.remembered).length;
        const empty = !r.months.some((m) => m.cheapest != null);
        const note = r.failed ? `${r.failed} search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); those months are unknown, not empty` : r.note ? r.note : empty ? (unknown ? unknownPlace("destination", a.to.trim()).note : `no fare found to ${label} in these ${r.months.length} months from ${origins.join(", ")} with ${minNights} to ${maxNights} nights; try more nights, another airport or a nearby city`) : remembered >= r.months.length ? `every month came from the fare memory (fares seen in the last day), no live search was needed` : remembered ? `${remembered} month${remembered === 1 ? "" : "s"} came from the fare memory (seen in the last day), the rest live` : undefined;
        return {
          to: label,
          origins: r.origins,
          nights: `${minNights} to ${maxNights}`,
          oneWay: !!a.oneWay,
          searched: live ? r.searched : 0,
          source: (live ? (remembered && remembered >= r.months.length ? "memory" : "live") : "memo") as Source,
          ...excludedSummary(exclude, jawDropped && jawCountry ? [`open-jaw via ${nameOf(jawCountry)}`] : [], a.exclude),
          ...(r.failed ? { failed: r.failed } : {}),
          ...(note ? { note } : {}),
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
        const d = futureDay(a.depart, ctx.today, "the departure");
        if (!d.day) return { error: d.note! };
        const depart = d.day;
        const corrected = d.note ? { corrected: d.note } : {};
        // A named destination in a been country is an answer, not a search; an open destination
        // ("anywhere") is searched and the landings in been countries are dropped afterwards.
        const exclude = excludeOf(a.exclude, a.allow);
        const toCountry = placeCountry(a.to);
        if (toCountry && !countryAllowed(toCountry, exclude)) return { searched: 0, source: "none" as Source, found: 0, itineraries: [], note: excludedNote([toCountry]) };
        const flex = Math.min(5, Math.max(0, Math.round(a.flexDays ?? 2)));
        const nights = a.nights ? Math.min(90, Math.max(1, Math.round(a.nights))) : null;
        const back = nights ? addDays(depart, nights) : null;
        const from = placeArg(a.from, gateways.join(","));
        const originCodes = from.split(",").map((x) => airportArg(x, "")).filter(Boolean);
        // The route from what is known: the memory's fares around the date, the board deal
        // for the city when there is one. Used when nothing live can be searched.
        const fallback = async (reason: string, searched = 0, turn = false) => {
          const known = await knownFares(gateways, originCodes.length ? originCodes : gateways, a.to, addDays(depart, -flex), addDays(depart, flex), depart.slice(0, 7), turn);
          // Return fares first when a return was asked for, one-ways first otherwise; both are shown.
          const fares = [...known.fares].sort((x, y) => Number(nights ? y.back != null : y.back == null) - Number(nights ? x.back != null : x.back == null) || x.price - y.price).slice(0, 6);
          const deals = known.deals.slice(0, 4);
          return { searched, source: known.source, found: fares.length + deals.length, ...corrected, ...excludedSummary(exclude, [], a.exclude), note: `${reason}; ${known.note}`, itineraries: fares.map(itinFromFare), deals: deals.map(compactDeal), raw: deals };
        };
        if (liveOff()) return fallback(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent");
        const over = exhausted();
        if (over) return fallback(over.error, 0, true);
        // The gate memoises a search for a day: only a search that really left the process
        // counts against the turn and is reported as live; a memo hit is "memo", searched 0.
        const before = kiwiStats().today;
        let r;
        try {
          r = await searchFlight({ flyFrom: from, flyTo: placeArg(a.to, "anywhere"), departureDate: kiwiDate(depart), departureDateFlexDays: flex, ...(back ? { returnDate: kiwiDate(back), returnDateFlexDays: flex } : {}) });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const sentFailed = Math.max(0, kiwiStats().today - before);
          spend(sentFailed);
          if (isRateLimit(msg)) return fallback("the live search was refused", sentFailed);
          throw err;
        }
        const sentNow = Math.max(0, kiwiStats().today - before);
        spend(sentNow);
        // Where an itinerary lands (the outbound's last airport), by country: cities.json first,
        // then the airports file, the way the boards resolve a gateway.
        const landsIn = (code: string) => resolveGateway(code)?.country ?? AIRPORT_BY_IATA.get(code)?.country;
        const kept = r.itineraries.filter((it) => countryAllowed(landsIn(it.outbound.to), exclude));
        const items = kept
          .sort((x, y) => x.price - y.price)
          .slice(0, 6)
          .map((it) => ({ price: Math.round(it.price), to: it.outbound.to, out: it.outbound.departureTime.slice(0, 16), back: it.inbound?.departureTime.slice(0, 16), nights: nightsOf(it), stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0), via: it.outbound.route.slice(1, -1), carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName))], hours: Math.round(it.outbound.durationSeconds / 360) / 10, url: it.bookingUrl }));
        const droppedN = r.itineraries.length - kept.length;
        const unknownTo = !placeCountry(a.to) && !/^(anywhere|[A-Za-z]{3})$/i.test((a.to ?? "").trim());
        const note = items.length ? undefined : droppedN ? `every itinerary landed in a been country` : unknownTo ? unknownPlace("destination", a.to).note : `no itinerary found ${from} to ${a.to} around ${depart}${nights ? ` for ${nights} nights` : ", one way"} (${flex} days flex); try more flex or a nearby airport`;
        return { searched: sentNow, source: (sentNow ? "live" : "memo") as Source, found: items.length, ...corrected, ...excludedSummary(exclude, droppedN ? [`${droppedN} itinerar${droppedN === 1 ? "y" : "ies"} landing in a been country`] : [], a.exclude), ...(note ? { note } : {}), itineraries: items };
      }),
    }),

    cheapest_way: tool({
      description: "The cheapest way from one place to another (and the fastest): one engine that already checks the direct fare, the nearby airports of both sides, a train or coach to a bigger airport then a flight, a flight then ground, two tickets through a hub, open-jaw landings and the ground graph alone, from the fare memory first and then live. Use FIRST whenever the traveller asks how to get from A to B or the cheapest way somewhere. from defaults to where the traveller is. Returns the options ranked (kind, title, total, hours, stops, why, booking links), the cheapest and the fastest, and what was considered, so you can say it. About 12 Kiwi searches at most, under a minute; 24 with harder. Each option says nonstop (true only when no flight leg stops; kind 'direct' means the nearest airports, not a nonstop flight) and the answer says whether each end was placed (an unplaced end is a name nobody could put on the map, so never say 'from X' for it).",
      inputSchema: jsonSchema<{ from?: string; to: string; depart?: string; flex?: number; nights?: number; oneWay?: boolean; maxHours?: number; harder?: boolean; tradeoff?: Tradeoff; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          from: { type: "string", description: "a city, an airport code, a place name or 'lat,lon'; default the traveller's place" },
          to: { type: "string", description: "a city, an airport code, a place name or 'lat,lon'" },
          depart: { type: "string", description: "YYYY-MM-DD; default three weeks out" },
          flex: { type: "number", description: "days either side, 0 to 3, default 2" },
          nights: { type: "number", description: "nights there for a return, default 4; set oneWay for no return" },
          oneWay: { type: "boolean" },
          maxHours: { type: "number", description: "door to door; options longer than this are dropped; omitted means the trip style's longest flight, if set" },
          harder: { type: "boolean", description: "true when the traveller says 'search harder', 'look harder', 'exhaust', 'every option': twice the searches (24) and more time for the hubs" },
          tradeoff: { type: "string", enum: ["price", "balanced", "comfort"], description: "which option to lead with: price the cheapest, comfort the fastest, balanced the better of the two by euro per hour; default the trip style's" },
          ...BEEN_PROPS,
        },
        required: ["to"],
      }),
      execute: safe(async (a) => {
        const to = String(a.to ?? "").trim();
        if (!to) return { error: "a destination is needed" };
        // The traveller's place when no origin is given: its name when the engine knows it (a
        // city, an airport's town), else their location as lat,lon (the engine resolves it to
        // the nearest airports) with the name put back on the answer afterwards, so the model
        // never reads "45.66, 25.60" as a place; with no location at all, their main airport.
        const given = String(a.from ?? "").trim();
        const originName = ctx.origin?.label?.trim() ?? "";
        const originKnown = !!originName && !!resolvePlace(originName);
        const coord = ctx.origin ? `${ctx.origin.lat.toFixed(2)}, ${ctx.origin.lon.toFixed(2)}` : "";
        const from = given || (ctx.origin ? (originKnown ? originName : `${ctx.origin.lat.toFixed(3)},${ctx.origin.lon.toFixed(3)}`) : gateways[0]);
        const relabel = !given && !!ctx.origin && !originKnown && !!originName;
        const fixName = (s: string) => (relabel && s === coord ? originName : s);
        const fixText = (s: string) => (relabel && coord ? s.split(coord).join(originName) : s);
        const corrections: string[] = [];
        // The departure the engine prices: the day given, else three weeks out (the engine's
        // own default, computed here so the answer always says the day and the globe can
        // redraw the same window).
        let depart = addDays(ctx.today, 21);
        if (a.depart != null && String(a.depart).trim()) {
          const d = futureDay(a.depart, ctx.today, "the departure");
          if (!d.day) return { error: d.note! };
          if (d.note) corrections.push(d.note);
          depart = d.day;
        } else corrections.push(`no departure given; priced ${depart}, three weeks out, say so`);
        const flex = Math.min(3, Math.max(0, Math.round(a.flex ?? 2)));
        const nights = a.oneWay ? null : Math.min(60, Math.max(1, Math.round(a.nights ?? 4)));
        // The engine never searches a window that starts in the past (Kiwi would answer
        // nothing and the empty answer would be memoised): a departure within flex days of
        // today is searched from today, and the answer says so. The engine trims against the
        // server's UTC day, not the browser's (ctx.today may be a day ahead or behind it), so
        // the line is decided against that same day, or it could name a day the engine did
        // not search from, or fire when the engine did not trim.
        const engineToday = new Date().toISOString().slice(0, 10);
        if (addDays(depart, -flex) < engineToday) corrections.push(`the window around ${depart} with ${flex} days flex would start before today; searched from today (${engineToday}) to ${addDays(depart, flex)} instead`);
        const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
        const exclude = excludeOf(a.exclude, a.allow);
        const toCountry = placeCountry(to);
        if (toCountry && !countryAllowed(toCountry, exclude)) return { searched: 0, source: "none" as Source, options: [], note: excludedNote([toCountry]) };
        // The engine spends from the turn's budget: at most ROUTE_SEARCHES (twice that when
        // the traveller asked to look harder), fewer when the turn has less left. A spent turn
        // is no refusal: the engine runs at budget 0 (the fare memory and the ground graph
        // alone) and the note says live prices were not searched. When live prices are off the
        // budget of one is never sent: Kiwi's gate refuses
        // it inside the process (or the engine skips it while the breaker is open), and the
        // engine answers from the fare memory and the ground graph alone; the tool's own note
        // then says so (the engine's note for an empty answer under a budget of one reads
        // "no way found", which is not what happened).
        const offBefore = liveOff();
        const spentTurn = !offBefore && !!exhausted();
        const harder = a.harder === true;
        const budgetNow = offBefore ? 1 : spentTurn ? 0 : Math.min(harder ? ROUTE_SEARCHES_HARDER : ROUTE_SEARCHES, searchesLeft());
        // The engine's clock: its usual limit (longer when asked to look harder), and never
        // past what is left of the turn, so the tool cannot outlast the turn it runs in.
        const deadlineMs = Math.max(10_000, Math.min(harder ? ROUTE_DEADLINE_HARDER_MS : ROUTE_DEADLINE_MS, turnLeftMs() - DEADLINE_MARGIN_MS));
        // The trip style: its longest flight caps the options when the traveller gave no cap of their own. The
        // engine's cap is door to door, so the style's flight hours get the three hours of airport time a trip
        // has around its flying (an hour and a half each end, as the walk counts it); its tradeoff decides which
        // option the answer leads with.
        const fromStyle: string[] = [];
        const maxHours = a.maxHours ?? (prefs.maxFlightHours ? prefs.maxFlightHours + 3 : undefined);
        if (a.maxHours == null && prefs.maxFlightHours) fromStyle.push(`trips under ${prefs.maxFlightHours + 3} h door to door (flights under ${prefs.maxFlightHours} h)`);
        const tradeoff: Tradeoff = a.tradeoff === "price" || a.tradeoff === "comfort" || a.tradeoff === "balanced" ? a.tradeoff : prefs.tradeoff;
        if (!a.tradeoff && prefs.tradeoff !== "price") fromStyle.push(`the ${prefs.tradeoff} tradeoff`);
        const query = { from, to, depart, flex, nights: nights ?? undefined, oneWay: !!a.oneWay, maxHours: maxHours || undefined, exclude, budget: budgetNow, deadlineMs };
        trace("cheapestWay", { ...query, tradeoff });
        // The engine counts memo hits as searches and its whole answer is memoised for an
        // hour: what left the process now is the gate's own count, and that is what the turn
        // is charged and the answer calls live.
        const before = kiwiStats().today;
        const r: RouteResult = await cheapestWay(query);
        const sentNow = Math.max(0, kiwiStats().today - before);
        spend(sentNow);
        // The origin's name put back everywhere the engine wrote its coordinates: the labels,
        // the legs (from, fromName, to, toName; the way back lands at the origin too), the
        // titles and the why lines. The raw payload is relabelled first and the compact fields
        // are read from it, so a card or a globe path that reads raw legs never prints
        // "45.66, 25.60" as a town. The option objects are mapped once, so the cheapest and
        // the fastest stay the same objects as their entries in the list.
        const fixLeg = (l: RouteLeg): RouteLeg => ({ ...l, from: fixName(l.from), fromName: fixName(l.fromName), to: fixName(l.to), toName: fixName(l.toName) });
        const fixOption = (o: RouteOption): RouteOption => ({ ...o, title: fixText(o.title), why: fixText(o.why), legs: o.legs.map(fixLeg), ...(o.back ? { back: o.back.map(fixLeg) } : {}) });
        const fixed = new Map(r.options.map((o) => [o, relabel ? fixOption(o) : o] as const));
        const pick = (o: RouteOption | null): RouteOption | null => (o ? (fixed.get(o) ?? (relabel ? fixOption(o) : o)) : null);
        const raw: RouteResult = relabel ? { ...r, from: { ...r.from, label: originName }, options: [...fixed.values()], cheapest: pick(r.cheapest), fastest: pick(r.fastest), considered: r.considered.map(fixText), ...(r.note ? { note: fixText(r.note) } : {}) } : r;
        // A fly leg taken from the fare memory (RouteLeg.remembered) says so on its line.
        const leg = (l: RouteLeg) => `${l.kind} ${l.fromName || l.from} to ${l.toName || l.to}${l.date ? ` on ${l.date}` : ""}, ${Math.round((l.minutes / 60) * 10) / 10} h${l.price != null ? `, €${l.price}${l.estimated ? " (estimate)" : ""}` : ""}${l.carrier ? `, ${l.carrier}` : ""}${l.remembered ? " (remembered fare)" : ""}`;
        // nonstop is the engine's own flag (true only when no flight leg stops); kind "direct"
        // means the nearest airports on both sides and may well be a one-stop ticket.
        const compact = (o: RouteOption) => ({ kind: o.kind, title: o.title, total: o.total, hours: o.hours, stops: o.stops, nonstop: o.nonstop === true, why: o.why, legs: o.legs.map(leg), ...(o.back?.length ? { back: o.back.map(leg), backTotal: o.backTotal } : {}), urls: o.urls.slice(0, 4), cheapest: raw.cheapest === o || undefined, fastest: raw.fastest === o || undefined });
        const live = sentNow > 0;
        // The engine's count without a search leaving: the same question within the hour.
        const memoHit = !live && r.searched > 0;
        const failedAll = r.failed > 0 && r.failed >= r.searched && !live;
        // A remembered fare: the engine lists its sources (RouteResult.sources, "memory" when
        // an option was built from the fare memory) and marks such legs (RouteLeg.remembered).
        const fromMemory = r.sources.includes("memory");
        // An end the engine could not place (no data of ours knows it, Kiwi found nothing): the
        // answer says so, so the model never writes "from X" for a name nobody could map.
        const placed = { from: r.from.placed !== false, to: r.to.placed !== false };
        const fromLabel = relabel ? originName : r.from.label;
        // The note is decided from the tool's own state first: when live prices were off
        // before the run, or every search of the run was refused, it is the rate-limit
        // sentence, whatever the engine wrote (under a budget of one the engine's own note for
        // an empty answer says no way was found, when nothing was searched). The engine's
        // detail for that case is still in `considered` ("1 search not made while Kiwi
        // throttles this address"). Otherwise the engine's note leads.
        const fallback = offBefore || failedAll;
        const offReason = offBefore ? (kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent") : "every live search was refused";
        const note = fallback
          ? `${offReason}; ${RATE_NOTE}; ${r.options.length ? "the fares shown are remembered ones and ground estimates, no live search was made" : "nothing stored between these places yet"}. Offer to try again in a few minutes.`
          : spentTurn
            ? `${TURN_NOTE}; live prices were not searched, ${r.options.length ? "the options shown are remembered fares and ground estimates" : "nothing stored between these places yet"}`
            : (r.note ?? (!r.options.length ? `no way found between ${fromLabel} and ${r.to.label} around ${depart}; try another date or a nearby city` : live ? (r.failed ? `${r.failed} of ${r.searched} live searches failed (Kiwi refused); some options may be missing` : undefined) : memoHit ? "the same question was answered within the hour, no new search was made" : "answered from the fare memory and the ground graph, no live search was needed"));
        // The option to lead with, by the tradeoff: the cheapest, the fastest, or (balanced) the cheaper of the
        // two once each hour is worth 11 euro, the rate lib/wild.ts gives a hop.
        const lead = !raw.cheapest || !raw.fastest || raw.cheapest === raw.fastest ? "cheapest" : tradeoff === "comfort" ? "fastest" : tradeoff === "price" ? "cheapest" : raw.fastest.total + raw.fastest.hours * 11 < raw.cheapest.total + raw.cheapest.hours * 11 ? "fastest" : "cheapest";
        return {
          from: fromLabel,
          to: r.to.label,
          depart,
          flex,
          nights,
          placed,
          lead,
          ...styleLine(fromStyle),
          searched: sentNow,
          source: (live ? "live" : memoHit ? "memo" : fromMemory ? "memory" : "data") as Source,
          ...corrected,
          ...excludedSummary(exclude, [], a.exclude),
          ...(!placed.from || !placed.to ? { unplaced: `${[!placed.from ? fromLabel : "", !placed.to ? r.to.label : ""].filter(Boolean).join(" and ")} could not be placed on the map; name the nearest city or airport instead` } : {}),
          considered: raw.considered.slice(0, 12),
          ...(note ? { note: fixText(note) } : {}),
          cheapest: raw.cheapest ? compact(raw.cheapest) : null,
          fastest: raw.fastest && raw.fastest !== raw.cheapest ? compact(raw.fastest) : null,
          options: raw.options.slice(0, 6).map(compact),
          raw,
        };
      }),
      toModelOutput: withoutRaw,
    }),

    walk_trips: tool({
      description:
        "A loop of several cities, searched the way the traveller does it by hand with Skyscanner Explore: one 'anywhere' one-way search from where they are (the cheapest places to fly to), then from each stop the cheapest next hops by plane, train or coach, then the cheapest way home to any of their airports, a beam of the best few at each depth, the fare memory first. Use it ONCE for any trip with more than one city, a loop, 'go from X and come back from Y', 'plane then train', 'cheapest loop', 'N cities in N days', or a chain of hops the traveller wrote out; never price such legs one by one with reprice_route or cheapest_way. from/to is the window the whole trip lies in (YYYY-MM-DD or words such as '20 Oct'; default a week out); minNights/maxNights the trip's length (N days is N-1 to N nights); nightsPerStop the nights in each city (default the traveller's trip style, nights a place, 2 to 3 unless they changed it; nightsPerStopMax for a range); maxStops (default enough stops to fill the nights at that pace, up to 16); mustInclude the cities they named; avoid countries or cities they dislike ('not Germany' is DE, 'countries like Germany' is like:DE, or a group word: dach, benelux, nordics, baltics, balkans, iberia), added to the trip style's own avoid list ([] lifts that list for this search); prefer countries to favour; countries to keep to; style their words ('unique' for hidden gems, not touristy, smaller places; the trip style's taste 'unique' sets it too); tradeoff default the trip style's; ground 'prefer' for 'trains between cities' (ground hops up to 8 hours), 'none' for flights only; origin a city to start from when it is not where they are. Returns the loops ranked: the route as a line (Brasov, plane, Warsaw, train, Gdansk, plane, Bucharest), stops with nights, legs with kind, price, minutes and the booking link of each flight, the total, the hours and why lines, plus considered, searched and tripStyle (which defaults came from the trip style). About 2 Kiwi searches a stop plus the way out and home (12 at least, 40 at most) from the turn's budget, about a minute; with the budget spent it still walks the fare memory and the ground graph.",
      inputSchema: jsonSchema<{ origin?: string; from?: string; to?: string; minNights?: number; maxNights?: number; nightsPerStop?: number; nightsPerStopMax?: number; maxStops?: number; beam?: number; tradeoff?: Tradeoff; mustInclude?: string[]; avoid?: string[]; prefer?: string[]; countries?: string[]; style?: string; ground?: "ok" | "prefer" | "none"; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          origin: { type: "string", description: "a city to start and end at; default where the traveller is" },
          from: { type: "string", description: "the first day the trip may start, YYYY-MM-DD; default a week out" },
          to: { type: "string", description: "the last day the trip may end, YYYY-MM-DD; default the start plus the nights plus a week" },
          minNights: { type: "number", description: "the fewest nights away in all; default 5" },
          maxNights: { type: "number", description: "the most nights away in all; default 6" },
          nightsPerStop: { type: "number", description: "nights in each city; default the trip style's nights a place" },
          nightsPerStopMax: { type: "number", description: "with nightsPerStop, a range: 2 to 3 nights a city" },
          maxStops: { type: "number", description: "the most cities, 1 to 16; default the nights divided by the fewest nights a stop" },
          beam: { type: "number", description: "how many of the cheapest states are followed at each depth, 1 to 5, default 2; more finds more but costs more searches" },
          tradeoff: { type: "string", enum: ["price", "balanced", "comfort"], description: "how much an hour of travel is worth against a euro; default balanced" },
          mustInclude: { type: "array", items: { type: "string" }, description: "cities every loop passes through, by name or code" },
          avoid: { type: "array", items: { type: "string" }, description: "countries or cities never to stop in: ISO2 codes, names, like:DE for countries like Germany, or a group word (dach, benelux, nordics, baltics, balkans, iberia)" },
          prefer: { type: "array", items: { type: "string" }, description: "countries to favour" },
          countries: { type: "array", items: { type: "string" }, description: "keep the stops to these countries" },
          style: { type: "string", description: "the traveller's words for the kind of places; 'unique' for hidden gems, not touristy, smaller cities" },
          ground: { type: "string", enum: ["ok", "prefer", "none"], description: "trains and coaches between places: ok (up to 5.5 h, the default), prefer ('only trains between cities': up to 8 h), none (flights only); default from the trip style" },
          ...BEEN_PROPS,
        },
      }),
      // A generator: every yield before the last is a preliminary result the chat shows on the tool's chip
      // while the walk runs (the AI SDK streams them as preliminary tool outputs); the last one is the answer.
      execute: async function* (a, opts) {
        try {
          // Where the loop starts and ends: the traveller's place, airports and home from the context, or a
          // named city with its own nearest airports.
          const given = String(a.origin ?? "").trim();
          const ctxLabel = ctx.origin?.label?.trim() ?? "";
          const here = ctx.origin ?? (() => {
            const g = resolveGateway(gateways[0]);
            return g ? { lat: g.lat, lon: g.lon, label: g.label } : null;
          })();
          let start: { lat: number; lon: number; label: string; gateways: string[]; home: string } | null = here ? { ...here, gateways, home: ctx.home } : null;
          if (given && fold(given) !== fold(ctxLabel)) {
            const hit = findCity(given);
            if (!hit) {
              yield { ...unknownPlace("start", given), loops: [] };
              return;
            }
            const [, c] = hit;
            const near = here ? haversineKm(here.lat, here.lon, c.lat, c.lon) : Infinity;
            // A city within 40 km of the traveller is where they are (Brasov typed while in Brasov).
            if (near > 40) {
              const gws = nearestGateways(AIRPORTS, c.lat, c.lon, { maxKm: 250, limit: 3 }).map((g) => g.airport.iata);
              if (!gws.length) {
                yield { ...plain(`no airport within 250 km of ${c.name}; name a bigger city nearby to start from`), loops: [] };
                return;
              }
              // The home country stays the traveller's own: the engine never stops in it, and a start city's
              // country as home would ban every city of that country ("start from Warsaw, train to Gdansk").
              start = { lat: c.lat, lon: c.lon, label: c.name, gateways: gws, home: ctx.home };
            }
          }
          if (!start) {
            yield { ...plain("the traveller's place is unknown and so are their airports; ask where they start from"), loops: [] };
            return;
          }
          // The window: words read with parseDay, then the same defaults the command line uses (lib/chat-widgets.ts).
          const corrections: string[] = [];
          const dayOf = (v: unknown, what: string): string | null | { error: string } => {
            if (v == null || !String(v).trim()) return null;
            const d = readDay(v, ctx.today, what);
            if (!d.day) return { error: d.note! };
            if (d.note) corrections.push(d.note);
            return d.day;
          };
          const f = dayOf(a.from, "the start");
          const t = dayOf(a.to, "the end");
          if (f && typeof f === "object") {
            yield f;
            return;
          }
          if (t && typeof t === "object") {
            yield t;
            return;
          }
          const win = walkWindow({ from: f, to: t, minNights: a.minNights, maxNights: a.maxNights }, ctx.today);
          corrections.push(...win.notes);
          const int = (v: unknown, lo: number, hi: number, dflt: number) => (Number.isFinite(Number(v)) && v != null && String(v).trim() !== "" ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);
          // nightsPerStop may come as a number or as "2-3" written by the model; with neither it nor
          // nightsPerStopMax given, the trip style's nights a place are the stay in each city.
          const fromStyle: string[] = [];
          const npsRaw = String(a.nightsPerStop ?? "").match(/^\s*(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\s*$/);
          const npsGiven = npsRaw != null || (a.nightsPerStop != null && String(a.nightsPerStop).trim() !== "" && Number.isFinite(Number(a.nightsPerStop)));
          if (!npsGiven) fromStyle.push(`${styleNights()} nights a place`);
          const nMin = npsRaw ? int(npsRaw[1], 1, 14, 2) : npsGiven ? int(a.nightsPerStop, 1, 14, 2) : prefs.nightsPerPlace[0];
          const nMax = npsRaw ? int(npsRaw[2], nMin, 14, nMin) : npsGiven ? int(a.nightsPerStopMax, nMin, 14, nMin) : Math.max(nMin, prefs.nightsPerPlace[1]);
          const nightsPerStop: number | [number, number] = nMax > nMin ? [nMin, nMax] : nMin;
          // Enough stops to fill the longest stay at the shortest pace (14 nights at 2 to 3 a place is 7), as the
          // engine scales them, up to 16; the search budget grows with them below.
          const maxStops = int(a.maxStops, 1, 16, Math.min(16, Math.max(1, Math.ceil(win.maxNights / nMin))));
          const beam = int(a.beam, 1, 5, WALK_BEAM);
          const tradeoffGiven = (["price", "balanced", "comfort"] as Tradeoff[]).includes(a.tradeoff as Tradeoff);
          const tradeoff: Tradeoff = tradeoffGiven ? a.tradeoff! : prefs.tradeoff;
          if (!tradeoffGiven && prefs.tradeoff !== "price") fromStyle.push(`the ${prefs.tradeoff} tradeoff`);
          const words = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, max);
          // The start itself is no stop to pass through (the model sometimes lists it): a city within 40 km of it goes.
          const mustInclude = words(a.mustInclude, 6).filter((m) => {
            const c = findCity(m)?.[1];
            return !c || haversineKm(start!.lat, start!.lon, c.lat, c.lon) > 40;
          });
          // A city to pass through in the home country can never be a stop (the walk never stops at home): say so
          // now, before a search is spent on a loop that cannot close.
          const homeCode = start.home.trim().toUpperCase();
          const atHome = mustInclude.filter((m) => findCity(m)?.[1].country === homeCode);
          if (atHome.length) {
            const country = COUNTRIES[homeCode]?.name ?? homeCode;
            yield { ...plain(`${atHome.join(" and ")} ${atHome.length === 1 ? "is" : "are"} in ${country}, the home country, and a loop never stops there; to start from ${atHome[0]}, pass it as origin, or name cities abroad`), loops: [] };
            return;
          }
          // The traveller's dislikes this time, added to the style's own list; an explicit [] lifts the style's list
          // for this search ("Germany is fine this time"), the way exclude [] lifts the Been filter.
          const avoidLifted = Array.isArray(a.avoid) && !a.avoid.length;
          const avoid = avoidLifted ? [] : [...new Set([...words(a.avoid), ...prefs.avoid])];
          if (!avoidLifted && prefs.avoid.length) fromStyle.push(`avoiding ${prefs.avoid.join(", ")}`);
          const prefer = words(a.prefer);
          const countries = words(a.countries, 30);
          const styleGiven = typeof a.style === "string" ? a.style.trim().slice(0, 120) : "";
          const style = styleGiven || (prefs.taste === "unique" ? "unique" : "");
          if (!styleGiven && style) fromStyle.push("unique places");
          // Trains and coaches between places: the walk's ground hop limit in minutes. 'prefer' lets the longer
          // overland days in (8 h), 'none' is flights only; with nothing said, the style decides.
          const groundWord = a.ground === "prefer" || a.ground === "none" || a.ground === "ok" ? a.ground : prefs.groundOk ? "ok" : "none";
          if (!a.ground && !prefs.groundOk) fromStyle.push("no trains or coaches");
          const maxGroundMin = groundWord === "prefer" ? WALK_GROUND_PREFER_MIN : groundWord === "none" ? 0 : WALK_GROUND_MIN;
          // The style's longest single flight: the walk skips a flight edge past it.
          const maxFlightHours = prefs.maxFlightHours;
          if (maxFlightHours) fromStyle.push(`flights under ${maxFlightHours} h`);
          const exclude = excludeOf(a.exclude, a.allow);
          // The budget: about two searches a stop plus the way out and the way home, at least twelve and at most
          // forty, never more than the turn has left. With the turn's budget spent, or live prices off, the walk
          // still runs at budget 0: the fare memory, the boards and the ground graph alone.
          const offBefore = liveOff();
          const spentTurn = !offBefore && budget.used >= budget.max;
          const walkSearches = Math.max(WALK_SEARCHES, Math.min(WALK_SEARCHES_MAX, 2 * maxStops + 2));
          const budgetNow = offBefore || spentTurn ? 0 : Math.min(walkSearches, searchesLeft());
          // The engine's clock grows ten seconds a stop past three (more stops, more searches), at most WALK_DEADLINE_MAX_MS,
          // and never reaches past what is left of the turn (it floors it at ten seconds).
          const walkMs = Math.min(WALK_DEADLINE_MAX_MS, WALK_DEADLINE_MS + Math.max(0, maxStops - 3) * 10_000);
          const deadlineMs = Math.max(10_000, Math.min(walkMs, turnLeftMs() - DEADLINE_MARGIN_MS));
          const query = { origin: { lat: start.lat, lon: start.lon, label: start.label }, gateways: start.gateways, home: start.home, from: win.from, to: win.to, minNights: win.minNights, maxNights: win.maxNights, nightsPerStop, maxStops, beam, budget: budgetNow, deadlineMs, maxGroundMin, ...(maxFlightHours ? { maxFlightHours } : {}), tradeoff, exclude, mustInclude, avoid, prefer, allowedCountries: countries, ...(style ? { style } : {}) };
          trace("walkTrips", query);
          const params = walkQuery({ gateways: start.gateways, home: start.home, lat: start.lat, lon: start.lon, label: start.label, from: win.from, to: win.to, minNights: win.minNights, maxNights: win.maxNights, nightsPerStop, maxStops, beam, budget: budgetNow, ...(maxGroundMin !== WALK_GROUND_MIN ? { ground: maxGroundMin } : {}), tradeoff, exclude, mustInclude, avoid, prefer, countries, style });

          // The walk runs on its own; its progress lines wake this generator, which yields them as they come.
          const lines: string[] = [];
          // The walk's nodes, edges and loops, in the order they came, for the globe to draw while the walk runs
          // (ChatPanel sends them on as atlas:walk-live). Bounded: past the cap only the chosen edges and the loops
          // are kept, the ones that make the picture.
          const live: WalkLiveLine[] = [];
          let loopsSoFar = 0;
          let edges = 0;
          let finished = false;
          let pending = false;
          let wake: (() => void) | null = null;
          const poke = () => {
            pending = true;
            const w = wake;
            wake = null;
            w?.();
          };
          const onEvent = (e: WalkEvent) => {
            if (e.type === "progress") lines.push(e.text);
            else if (e.type === "loop") {
              loopsSoFar++;
              lines.push(`A loop closed: ${e.loop.title}, €${Math.round(e.loop.total)}`);
              live.push({ loop: e.loop });
            } else if (e.type === "edge") {
              edges++;
              if (live.length < WALK_LIVE_MAX || e.chosen || e.home) {
                const { type: _t, ...edge } = e;
                void _t;
                live.push({ edge });
              }
            } else if (e.type === "node") {
              if (live.length < WALK_LIVE_MAX) {
                const { type: _t, ...node } = e;
                void _t;
                live.push({ node });
              }
            } else return;
            poke();
          };
          const before = kiwiStats().today;
          // Settled into a value at once, so a failure is never an unhandled rejection while this waits for a line.
          const run = walkTrips({ ...query, signal: opts?.abortSignal, onEvent })
            .then((r) => ({ r, err: null as unknown }), (err: unknown) => ({ r: null, err }))
            .finally(() => {
              finished = true;
              poke();
            });
          // Each preliminary yield carries the live lines since the one before it, and that one's again: the browser
          // may fold two quick updates into one render, so a batch is sent twice and the panel keeps the ones it has
          // not sent on yet (by `at`, the index of the first line). At most one yield per WALK_LIVE_MS.
          let shown = 0;
          let sentTo = 0;
          let prevFrom = 0;
          let lastYield = 0;
          while (!finished) {
            if (!pending) await new Promise<void>((res) => (wake = res));
            pending = false;
            if (finished || (lines.length === shown && live.length === sentTo)) continue;
            const wait = WALK_LIVE_MS - (Date.now() - lastYield);
            if (wait > 0) await sleep(wait);
            if (finished) break;
            shown = lines.length;
            const end = live.length;
            const at = prevFrom;
            prevFrom = sentTo;
            sentTo = end;
            lastYield = Date.now();
            yield { running: true as const, progress: lines[lines.length - 1] ?? "Walking the cheapest hops", lines: lines.slice(-4), loops: loopsSoFar, edges, searched: Math.max(0, kiwiStats().today - before), live: { at, lines: live.slice(at, end) }, params };
          }
          const done = await run;
          const sentNow = Math.max(0, kiwiStats().today - before);
          spend(sentNow);
          if (!done.r) throw done.err instanceof Error ? done.err : new Error(String(done.err ?? "the walk failed"));
          const r: WalkResult = done.r;
          const loops = r.loops;
          const remembered = loops.some((l) => l.legs.some((g) => g.source === "memory"));
          const source: Source = sentNow > 0 ? "live" : r.searched > 0 ? "memo" : remembered || r.fromMemory > 0 ? "memory" : loops.length ? "data" : "none";
          const offReason = kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent";
          // The engine refusing the request itself (it expanded nothing: a bad place, nights that cannot fit) is the
          // reason, whatever the budget; a walk that ran and closed nothing keeps the engine's note after the budget's.
          const refused = !loops.length && !!r.note && r.expanded === 0;
          const budgetNote = offBefore
            ? `${offReason}; ${RATE_NOTE}; ${loops.length ? "the loops come from the fare memory and the ground graph, no live search was made" : "nothing remembered closes a loop for these dates"}. Offer to try again in a few minutes.`
            : spentTurn
              ? `${TURN_NOTE}; live prices were not searched, ${loops.length ? "the loops come from the fare memory and ground estimates" : "nothing remembered closes a loop for these dates"}`
              : "";
          const note = refused ? r.note : budgetNote ? (!loops.length && r.note ? `${budgetNote}; ${r.note}` : budgetNote) : r.note;
          const label = start.label;
          const word: Record<WalkLeg["kind"], string> = { fly: "plane", train: "train", coach: "coach", ferry: "ferry", road: "car" };
          const end = (code: string, name: string) => (code === "HOME" ? label : name);
          const compact = (l: WalkLoop) => ({
            title: l.title,
            route: [label, ...l.legs.filter((g) => g.kind !== "road").flatMap((g) => [word[g.kind], end(g.to, g.toName)])].join(", "),
            start: l.start,
            end: l.end,
            nights: l.nights,
            total: Math.round(l.total),
            hours: Math.round(l.hours),
            stops: l.stops.map((s) => ({ name: s.name, country: s.country, nights: s.nights, arrive: s.arrive })),
            legs: l.legs.map((g) => ({ kind: g.kind, from: end(g.from, g.fromName), to: end(g.to, g.toName), date: g.date, ...(g.depart ? { depart: g.depart } : {}), minutes: g.minutes, price: Math.round(g.price), ...(g.estimated ? { estimated: true } : {}), ...(g.carrier ? { carrier: g.carrier } : {}), source: g.source, ...(g.url ? { url: g.url } : {}) })),
            why: l.why.slice(0, 4),
          });
          yield {
            from: label,
            window: `${win.from} to ${win.to}`,
            nights: win.minNights === win.maxNights ? `${win.minNights}` : `${win.minNights} to ${win.maxNights}`,
            nightsPerStop: Array.isArray(nightsPerStop) ? `${nightsPerStop[0]} to ${nightsPerStop[1]}` : `${nightsPerStop}`,
            ...styleLine(fromStyle),
            searched: sentNow,
            source,
            count: loops.length,
            ...(corrections.length ? { corrected: corrections.join("; ") } : {}),
            ...excludedSummary(exclude, [], a.exclude),
            ...(note ? { note } : {}),
            ...(r.partial ? { partial: true } : {}),
            considered: r.considered.slice(0, 12),
            loops: loops.slice(0, 4).map(compact),
            params,
            raw: r,
          };
        } catch (err) {
          // The same rule as safe(): a throw caused by Kiwi's throttle is a note, anything else one line of error.
          const msg = err instanceof Error ? err.message : String(err);
          yield isRateLimit(msg) ? { ...plain(`${msg}; ${RATE_NOTE}. Offer to try again in a few minutes.`), loops: [] } : { error: msg.slice(0, 200) || "the walk failed" };
        }
      },
      toModelOutput: withoutClientFields,
    }),

    two_city_combos: tool({
      description: "For a return deal: fly in to the city, hop by train or coach to a neighbour, fly home from there, priced live. Often cheaper and you see two places. Needs the deal's home airport, destination airport, city code, dates and price (from a deals result). A neighbour in an excluded (been) country is never proposed as the second city; passing through one is fine.",
      inputSchema: jsonSchema<{ from: string; dst: string; city: string; out: string; back: string; price: number; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: { from: { type: "string" }, dst: { type: "string" }, city: { type: "string", description: "destination city code" }, out: { type: "string" }, back: { type: "string" }, price: { type: "number" }, ...BEEN_PROPS },
        required: ["from", "dst", "city", "out", "back", "price"],
      }),
      execute: safe(async (a) => {
        const exclude = excludeOf(a.exclude, a.allow);
        const cityHit = findCity(a.city ?? "");
        if (!cityHit && !CITIES[(a.city ?? "").toUpperCase()]) return { ...unknownPlace("destination city", a.city ?? ""), combos: [] };
        const city = cityHit?.[0] ?? a.city.toUpperCase();
        const from = airportArg(a.from, gateways[0]) || gateways[0];
        const dst = airportArg(a.dst, "") || CITIES[city]?.airports[0] || a.dst.toUpperCase();
        const out = parseDay(a.out, ctx.today);
        const back = parseDay(a.back, ctx.today);
        if (!out || !back) return { error: `the deal's dates are needed as YYYY-MM-DD (got out ${a.out}, back ${a.back})` };
        const base = Number.isFinite(a.price) ? Math.round(a.price) : 0;
        // The neighbours are known without a search: when nothing live can be searched the
        // answer still names them with the ground leg, under the rate-limit note.
        const neighbours = () => neighboursOf(city).filter((n) => countryAllowed(CITIES[n.code]?.country, exclude)).slice(0, 4).map((n) => ({ next: CITIES[n.code]?.name ?? n.code, country: CITIES[n.code]?.country, ground: `${n.mode} ${Math.round((n.minutes / 60) * 10) / 10} h${n.estimated ? " (estimate)" : ""}` }));
        if (liveOff()) return { searched: 0, source: "data" as Source, base, note: `${kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent"}; ${RATE_NOTE}. The neighbours reachable by ground are listed unpriced; offer to price them in a few minutes.`, combos: neighbours() };
        const over = exhausted();
        if (over) return { searched: 0, source: "data" as Source, base, note: `${over.error}; the neighbours are listed unpriced`, combos: neighbours() };
        const r = await findCombos(from, dst, city, out, back, base, { exclude });
        spend(r.searched);
        const combos = filterByCountry(r.combos, exclude).slice(0, 4).map((c) => ({ next: c.name, country: c.country, ground: `${c.groundMode} ${Math.round((c.groundMin / 60) * 10) / 10} h${c.estimated ? " (estimate)" : ""}`, homeFromThere: c.inPrice, total: c.total, saves: c.saves, outUrl: r.outUrl, homeUrl: c.inUrl }));
        const note = r.note ?? (!combos.length ? (r.outPrice == null && r.searched ? (liveOff() ? `the live searches were refused; ${RATE_NOTE}; the neighbours are listed unpriced` : `no one-way fare found ${from} to ${dst} on ${out}; the combos need it`) : !neighboursOf(city).length ? `${CITIES[city]?.name ?? city} has no neighbour with an airport within five hours by ground` : `no neighbour of ${CITIES[city]?.name ?? city} had a one-way home on ${back}`) : undefined);
        return { searched: r.searched, source: "live" as Source, base: r.base, outOneWay: r.outPrice, ...excludedSummary(exclude, [], a.exclude), ...(note ? { note } : {}), combos: combos.length ? combos : neighbours() };
      }),
    }),

    wild_trip: tool({
      description: "A long multi-country loop (5 to 90 nights) into a far region (or region 'custom' with a countries list anywhere): fly out, hop through the region by the cheapest flights, trains and coaches, fly home (any of the traveller's airports, plus the last leg to their door), with living costs per stop, visas and a model's verdict. By default it is built by the graph walk (engine 'walk': a targeted search into the region, then the cheapest next hops from each stop, Dijkstra over the train and coach graph, the cheapest way home) and each stop stays the traveller's trip style nights a place (2 to 3 unless they changed it), with the style's tradeoff, longest flight, taste and avoid list; nightsPerStop and nightsPerStopMax in the input override them for this trip only. engine 'classic' is the older greedy chain by country (a hub night on the way home), at the same nights a place; variants above 1 always use it. Regions: " + Object.entries(REGIONS).map(([k, v]) => `${k} (${v.label})`).join(", ") + ". Style: experiences, beaches, food, cities, slow. Budget: backpacker, mid, comfort. Tradeoff: price, balanced, comfort. variants=3 builds the balanced, cheapest and comfortable versions and ranks them. noHubs skips the positioning hub. Either month (YYYY-MM) or an explicit departure window from/to (a window works with variants too; one wider than ten days is clipped to its first ten). Optional custom country list, countries to favour, max stops, nights per stop (or a range with nightsPerStopMax), cities the chain must pass through, a cap on hours per flight, airports to start from, and the traveller's own wishes in words. Cost: about sixty Kiwi searches per variant that is not already built (one to two minutes each), so variants=3 is about 180 when none is stored, more than one turn's budget of " + TURN_SEARCH_BUDGET + "; the tool builds only as many variants as the budget left allows (stored ones are free), and a trip built in the last day is served at no cost. Default to one variant; say so before calling. The walk engine spends about 2 searches a stop plus the way in and home (40 at most). Excluded (been) countries never become a stop or the optional hub night; flying through a hub there to position is fine. The answer's tripStyle says which defaults came from the trip style.",
      inputSchema: jsonSchema<{ region: Region; nights?: number; style?: Style; budget?: Budget; month?: string; from?: string; to?: string; countries?: string[]; prefer?: string[]; maxStops?: number; nightsPerStop?: number; nightsPerStopMax?: number; mustInclude?: string[]; maxFlightHours?: number; startFrom?: string[]; wishes?: string; stopover?: boolean; tradeoff?: Tradeoff; noHubs?: boolean; variants?: number; engine?: "walk" | "classic"; avoid?: string[]; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          region: { type: "string", enum: Object.keys(REGIONS), description: "a far region, or 'custom' with countries. Whenever countries is given the trip is keyed as region 'custom' whatever region is named here (the engine, /api/wild and the Wild tab do the same), so the key the tool returns says custom" },
          nights: { type: "number", description: "5 to 90, default 14" },
          style: { type: "string", enum: ["experiences", "beaches", "food", "cities", "slow"] },
          budget: { type: "string", enum: ["backpacker", "mid", "comfort"] },
          month: { type: "string", description: "YYYY-MM" },
          from: { type: "string", description: "YYYY-MM-DD, earliest departure (used instead of month)" },
          to: { type: "string", description: "YYYY-MM-DD, latest departure" },
          countries: { type: "array", items: { type: "string" }, description: "countries to restrict to, names or ISO2 codes, up to 8 (required with region 'custom')" },
          prefer: { type: "array", items: { type: "string" }, description: "countries to favour, names or ISO2 codes" },
          maxStops: { type: "number", description: "1 to 16 with the walk engine, 1 to 8 with classic; default enough stops for the nights" },
          nightsPerStop: { type: "number", description: "nights in each place; default the trip style's nights a place (only when the traveller says otherwise for this trip)" },
          nightsPerStopMax: { type: "number", description: "with nightsPerStop, the top of the range a stop may run (the cheapest day wins)" },
          mustInclude: { type: "array", items: { type: "string" }, description: "cities the chain must pass through, names or codes, up to 8" },
          maxFlightHours: { type: "number", description: "the longest any flight may take, 1 to 40 hours door to door" },
          startFrom: { type: "array", items: { type: "string" }, description: "IATA codes to fly out from instead of the traveller's airports (up to 3); the way home still lands at theirs" },
          wishes: { type: "string", description: "the traveller's own words about the trip ('temples and street food, no beaches'), up to 300 characters" },
          stopover: { type: "boolean", description: "allow a hub night on the way home, default true" },
          tradeoff: { type: "string", enum: ["price", "balanced", "comfort"] },
          noHubs: { type: "boolean", description: "fly only from the traveller's own airports" },
          variants: { type: "number", description: "1 (default), 2 or 3 ranked variants (balanced, price first, comfort first) built by the classic engine; 2 at most past 28 nights" },
          engine: { type: "string", enum: ["walk", "classic"], description: "walk (default): the graph walk, the cheapest hops by plane, train or coach; classic: the older greedy chain by country, only when the traveller asks for it" },
          avoid: { type: "array", items: { type: "string" }, description: "countries or cities never to stop in (ISO2, names, like:DE or a group word), added to the trip style's avoid list; [] lifts that list for this trip" },
          ...BEEN_PROPS,
        },
        required: ["region"],
      }),
      execute: safe(async (a) => {
        // A region written as its label ("Southeast Asia") or loosely is matched to its key.
        const regionKey = (Object.keys(REGIONS) as Region[]).find((k) => k === a.region || fold(k) === fold(String(a.region ?? "")) || fold(REGIONS[k].label) === fold(String(a.region ?? "")));
        if (!regionKey) return { error: `unknown region ${a.region}; one of ${Object.keys(REGIONS).join(", ")}` };
        const nights = Math.min(90, Math.max(5, Math.round(a.nights ?? 14)));
        const style = (["experiences", "beaches", "food", "cities", "slow"] as Style[]).includes(a.style as Style) ? a.style! : "experiences";
        const budget = (["backpacker", "mid", "comfort"] as Budget[]).includes(a.budget as Budget) ? a.budget! : "mid";
        const month = a.month && /^\d{4}-\d{2}$/.test(a.month) ? a.month : ctx.month;
        const corrections: string[] = [];
        let from = parseDay(a.from, ctx.today) ?? undefined;
        let to = parseDay(a.to, ctx.today) ?? undefined;
        if (from && from < ctx.today) {
          corrections.push(`the departure window started in the past (${from}); moved to today`);
          from = ctx.today;
        }
        if (from && to && to < from) {
          corrections.push(`the window ended (${to}) before it started (${from}); set to ${from} plus ten days`);
          to = addDays(from, 10);
        }
        const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
        // Been countries drop out of a custom list and the favourites before the build; a list
        // that was all been countries is an answer, not a build.
        const exclude = excludeOf(a.exclude, a.allow);
        const given = a.countries?.map((c) => countryCode(String(c ?? "").trim()) ?? String(c ?? "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 8);
        const countries = given?.filter((c) => countryAllowed(c, exclude));
        if (given?.length && !countries?.length) return plain(excludedNote(given));
        if (a.countries?.length && !given?.length) return plain(`none of ${a.countries.join(", ")} is a country I know; use names or ISO2 codes (VN, TH)`, "data");
        if (regionKey === "custom" && !countries?.length) return plain("region custom needs a countries list (names or codes); pick a region or name the countries", "data");
        // A country list replaces the region's list whatever region was named: the engine
        // labels the trip by its countries and /api/wild and /api/plan store it under region
        // custom, so the chat keys it the same way and the Wild tab finds the same trip.
        a = { ...a, region: countries?.length ? "custom" : regionKey };
        const prefer =a.prefer?.map((c) => countryCode(String(c ?? "").trim()) ?? String(c ?? "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c) && countryAllowed(c, exclude));
        // The engine's finer constraints, bounded here so a wild input never reaches it: they
        // shape the stored trip's key too (customKey's extras), so plan_days finds the trip.
        const strList = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim().slice(0, len)).filter(Boolean).slice(0, max) : []);
        const mustInclude = strList(a.mustInclude, 8, 40);
        const startFrom = strList(a.startFrom, 3, 3).map((x) => x.toUpperCase()).filter((x) => /^[A-Z]{3}$/.test(x));
        const maxFlightHours = Number.isFinite(a.maxFlightHours) && a.maxFlightHours! > 0 ? Math.min(40, Math.max(1, Math.round(a.maxFlightHours!))) : undefined;
        const wishes = typeof a.wishes === "string" && a.wishes.trim() ? a.wishes.trim().slice(0, 300) : undefined;
        // The engine: the graph walk unless the traveller asked for the classic chain; ranked variants are the
        // classic engine's (the walk ranks its own loops and returns the others as alternatives).
        const engine: "walk" | "classic" = a.engine === "classic" || (a.variants ?? 1) > 1 ? "classic" : "walk";
        // The trip style's defaults (lib/prefs.ts), each only where the input leaves it out, and each named in
        // the answer's tripStyle line so the model can say what it assumed.
        const fromStyle: string[] = [];
        const npsGiven = Number.isFinite(a.nightsPerStop) && a.nightsPerStop! > 0;
        const npsTop = npsGiven && Number.isFinite(a.nightsPerStopMax) && a.nightsPerStopMax! > a.nightsPerStop! ? Math.round(a.nightsPerStopMax!) : undefined;
        // The style's nights a place fill the trip only when its stops can: 16 stops at the most a place (the walk's
        // cap; the classic chain's is 16 at three nights or less) must reach the nights, else the engine's own
        // longer stays are kept and the answer says why. Both engines take them, the way the Wild tab sends them
        // (its classic toggle sends nightsPerStop=2-3 too), so the chat and the tab key the same trip.
        const styleFits = prefs.nightsPerPlace[1] * 16 >= nights;
        const nightsPerStop = npsGiven ? Math.round(a.nightsPerStop!) : styleFits ? prefs.nightsPerPlace[0] : undefined;
        const nightsPerStopMax = npsGiven ? npsTop : styleFits && prefs.nightsPerPlace[1] > prefs.nightsPerPlace[0] ? prefs.nightsPerPlace[1] : undefined;
        if (!npsGiven) fromStyle.push(styleFits ? `${styleNights()} nights a place` : `not the ${styleNights()} nights a place (${nights} nights do not fit in 16 stops), the engine's longer stays instead`);
        // The style's tradeoff is said only when it is not the default (money first), the same
        // rule customKey uses, so the chat and the Wild tab still key the same stored trip.
        const tradeoff: Tradeoff | undefined = a.tradeoff ?? (prefs.tradeoff !== "price" ? prefs.tradeoff : undefined);
        if (!a.tradeoff && tradeoff) fromStyle.push(`the ${tradeoff} tradeoff`);
        const flightCap = maxFlightHours ?? prefs.maxFlightHours;
        if (!maxFlightHours && flightCap) fromStyle.push(`flights under ${flightCap} h`);
        // Avoid: the traveller's words this time added to the style's list ([] lifts the style's list). The walk
        // reads the words (groups, like:DE, cities); the classic chain takes them as countries it never stops in.
        const avoidLifted = Array.isArray(a.avoid) && !a.avoid.length;
        const avoid = avoidLifted ? [] : [...new Set([...strList(a.avoid, 12, 40), ...prefs.avoid])];
        if (!avoidLifted && prefs.avoid.length) fromStyle.push(`avoiding ${prefs.avoid.join(", ")}`);
        // Taste: "unique" rides in the wishes, which the walk reads as its style and the judge reads too.
        // The words, the test and the join are /api/wild's own (UNIQUE_WISHES, ", "), so the wishes hash in the stored
        // trip's key matches the Wild tab's and a loop built in either place answers the other.
        const unique = prefs.taste === "unique" && !/unique|hidden gem|off the beaten/i.test(wishes ?? "");
        if (unique) fromStyle.push("unique places");
        const wishesNow = unique ? [wishes, UNIQUE_WISHES].filter(Boolean).join(", ").slice(0, 300) : wishes;
        const engineExclude = engine === "classic" && avoid.length ? cleanCodes([...exclude, ...avoidCountries(avoid)]) : exclude;
        const extras = { ...(mustInclude.length ? { mustInclude } : {}), ...(startFrom.length ? { startFrom } : {}), ...(flightCap ? { maxFlightHours: flightCap } : {}), ...(wishesNow ? { wishes: wishesNow } : {}), ...(nightsPerStopMax ? { nightsPerStopMax } : {}) };
        // Trains and coaches off in the style: both engines take no ground hops between places.
        const groundOff = !prefs.groundOk;
        if (groundOff) fromStyle.push("no trains or coaches");
        // The walk's search budget is its own (about two a stop, forty at most); it is handed over only when the turn
        // has less than that left. Such a walk is served but never stored, so the stored trip under the key is always
        // a full one and the key stays the one /api/wild and plan_days read (no budget token in it).
        // The walk's own budget for these nights is lib/graph-walk.ts autoBudget: two a stop plus two, twelve at least,
        // forty at most, for as many stops as the nights (plus the one of slack wildByWalk allows) hold at the fewest
        // nights a stop. The turn's leftover is handed over only when it is below that, so a short turn never lets the
        // walk spend more than it would on its own, and a build with its full budget is always stored.
        const walkStops = nightsPerStop ? Math.min(16, a.maxStops && a.maxStops > 0 ? Math.round(a.maxStops) : 16, Math.ceil((nights + 1) / nightsPerStop)) : 16;
        const walkAuto = Math.min(WALK_SEARCHES_MAX, Math.max(WALK_SEARCHES, 2 * walkStops + 2));
        const walkBudget = engine === "walk" && searchesLeft() < walkAuto ? searchesLeft() : undefined;
        /** The stored trip's key suffix for the engine (lib/wild-walk.ts engineKeySuffix, the scheme /api/wild and
         * /api/plan use): the walk's trips never answer for a classic chain and the other way round; classic keeps
         * the keys it always had, so the trips stored before still answer; the walk's avoid words and a ground limit
         * each get their token. */
        // Ranked variants are stored by lib/wild-variants.ts under customKey alone (no suffix), so their keys take none:
        // a "-g0" here would point plan_days at files that never exist and rebuild on every ask.
        const variantsAsked = (a.variants ?? 1) > 1;
        const engineTag = variantsAsked ? "" : engineKeySuffix({ engine, avoid: engine === "walk" ? avoid : [], ...(groundOff ? { ground: 0 } : {}) });
        const summarise = (trip: WildTrip) => ({
          title: trip.title,
          dates: `${trip.outDate} to ${trip.backDate}`,
          totals: trip.totals,
          legs: trip.legs.map((l) => (l.kind === "fly" ? `${l.date} fly ${l.fromName} → ${l.toName} €${l.price}, ${l.hours} h, ${l.stops ? `${l.stops} stop` : "direct"}` : `${l.date} ${l.mode} ${l.fromName} → ${l.toName} ~${Math.round(l.minutes / 60)} h`)),
          stops: trip.stops.map((s) => `${s.name} (${s.country}) ${s.nights} nights, about €${s.perDay}/day${s.visa ? `, ${s.visa}` : ""}${s.note ? `; ${s.note}` : ""}`),
          ...(trip.constraints?.length ? { constraints: trip.constraints } : {}),
          ...(trip.judge ? { judge: trip.judge } : { judge: null }),
        });
        // The key plan_days needs to find the stored trip again: the same custom suffix the
        // trip was written under, window and been list included (lib/wild.ts customKey takes
        // from, to and exclude), which is also what lib/wild-variants.ts keys each ranked
        // version on. A build with countries excluded never answers for a plain one.
        const keyOf = (tradeoff?: Tradeoff, noHubs?: boolean) => ({ region: a.region, nights, style, budget, month, custom: customKey(countries, prefer, a.maxStops, nightsPerStop, tradeoff, noHubs, from, to, engineExclude.length ? engineExclude : undefined, extras) + engineTag });
        /** The key of the undated copy of the same loop (no month, no window), when that is
         * what answers: its month is the literal "next" so plan_days reads the file it was
         * stored under (wildPath writes "next" for no month) whatever month the app has
         * selected, and never the dated path, where no such trip exists. */
        const undatedKeyOf = (tradeoff?: Tradeoff, noHubs?: boolean) => ({ region: a.region, nights, style, budget, month: "next", custom: customKey(countries, prefer, a.maxStops, nightsPerStop, tradeoff, noHubs, undefined, undefined, engineExclude.length ? engineExclude : undefined, extras) + engineTag });
        const gw = mainGateway(gateways);
        // The engine's deadline sits a little before the race fires: past it the chain stops
        // growing and the way home is searched from the stops found, so a time-capped turn
        // gets a whole (shorter) loop back instead of only a stored copy or a note.
        const deadline = Date.now() + WILD_BUILD_MS - DEADLINE_MARGIN_MS;
        const params = { gateways, home: ctx.home, region: a.region, month, from, to, nights, style, budget, origin: ctx.origin, stopover: a.stopover, countries, prefer, maxStops: a.maxStops, nightsPerStop, exclude: engineExclude, deadline, ...(groundOff ? { maxGroundMin: 0 } : {}), ...extras };
        /** The loop came back after its deadline: it was closed early, and the answer says so. */
        const cutShort = (trip: WildTrip): { partial?: true; note?: string } => (Date.now() > deadline && Date.parse(trip.generatedAt) > deadline ? { partial: true, note: `the build reached its time cap, so the loop was closed from the stops found by then and may be shorter than asked; ask again in two minutes for a fuller one` } : {});
        /** A refusal the engine states in a plain sentence (a must city on the been list, too
         * few nights, an unknown start airport): the sentence as is, so the model repeats it. A
         * throttle sentence is a rate limit, answered with the stored copy when there is one. */
        const refusal = (err: unknown, tradeoff?: Tradeoff, noHubs?: boolean) => {
          const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim() || "the build failed";
          if (isRateLimit(msg)) return partial(msg, tradeoff, noHubs);
          return Promise.resolve({ ...plain(msg, "data"), ...corrected, ...excludedSummary(exclude, [], a.exclude), key: keyOf(tradeoff, noHubs) });
        };
        const pathOf =(tradeoff?: Tradeoff, noHubs?: boolean) => wildPath(gw, a.region, month, nights, style, budget, keyOf(tradeoff, noHubs).custom);
        // What answers when a build cannot run or finish: the same trip stored earlier (any
        // age), then the undated version of the same loop, each under a plain note. A build
        // that ran out of time keeps going in the background and is stored, so the next ask
        // (a minute later) is served from the store at no cost.
        const storedAnyAge = async (tradeoff?: Tradeoff, noHubs?: boolean): Promise<{ trip: WildTrip; ageHours: number; dated: boolean } | null> => {
          const same = await readJson<WildTrip>(pathOf(tradeoff, noHubs)).catch(() => null);
          if (same) return { trip: same.body, ageHours: same.ageHours, dated: true };
          if (month || from) {
            const undated = await readJson<WildTrip>(wildPath(gw, a.region, undefined, nights, style, budget, undatedKeyOf(tradeoff, noHubs).custom)).catch(() => null);
            if (undated) return { trip: undated.body, ageHours: undated.ageHours, dated: false };
          }
          return null;
        };
        /** The key of the copy that answered: the dated one, or the undated loop's own key. */
        const keyOfCopy = (dated: boolean, tradeoff?: Tradeoff, noHubs?: boolean) => (dated ? keyOf(tradeoff, noHubs) : undatedKeyOf(tradeoff, noHubs));
        const partial = async (reason: string, tradeoff?: Tradeoff, noHubs?: boolean, searched = 0) => {
          const got = await storedAnyAge(tradeoff, noHubs);
          if (got) return { ...summarise(got.trip), ...corrected, ...excludedSummary(exclude, [], a.exclude), ...styleLine(fromStyle), engine, searched, source: "stored" as Source, ...(got.dated ? {} : { undated: true }), note: `${reason}; this is the ${got.dated ? "same" : "undated"} loop built ${Math.round(got.ageHours)} hours ago, from the store${got.dated ? "" : " (built for no particular dates, so its days are not the ones asked)"}${liveOff() ? `; ${RATE_NOTE}` : ""}`, key: keyOfCopy(got.dated, tradeoff, noHubs), raw: got.trip };
          return { ...corrected, ...excludedSummary(exclude, [], a.exclude), ...styleLine(fromStyle), engine, searched, source: "none" as Source, note: `${reason}; no version of this loop is stored yet${liveOff() ? `. ${RATE_NOTE}; offer to build it in a few minutes` : ". Offer to ask again in two minutes: the build goes on in the background and is stored when done"}`, key: keyOf(tradeoff, noHubs) };
        };
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
            if (liveOff()) return partial(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes, so no version could be built" : "today's live search budget is spent, so no version could be built", VARIANTS[0].tradeoff, VARIANTS[0].noHubs);
            const over = exhausted();
            if (over) return partial(over.error, VARIANTS[0].tradeoff, VARIANTS[0].noHubs);
          }
          // The variants build in parallel and each is stored as it finishes; past the time
          // cap the ones done so far are read back and ranked, the rest go on in the background.
          trace("buildWildVariants", { ...params, variants: wanted });
          const building = buildWildVariants(params, wanted);
          let ranked: Awaited<typeof building> | null;
          try {
            ranked = await Promise.race([building, sleep(WILD_BUILD_MS).then(() => null)]);
          } catch (err) {
            // No variant built and one refused with a plain sentence (the wrapper rethrows the first).
            return refusal(err, VARIANTS[0].tradeoff, VARIANTS[0].noHubs);
          }
          if (!ranked) {
            void building.catch(() => null);
            const done = (await Promise.all(VARIANTS.slice(0, wanted).map(async (v) => ({ v, got: await storedAnyAge(v.tradeoff, v.noHubs) })))).filter((x): x is { v: (typeof VARIANTS)[number]; got: NonNullable<Awaited<ReturnType<typeof storedAnyAge>>> } => !!x.got);
            if (!done.length) return partial(`the build did not finish in ${Math.round(WILD_BUILD_MS / 1000)} seconds`, VARIANTS[0].tradeoff, VARIANTS[0].noHubs);
            const spentNow = done.reduce((n, x) => n + (builtNow(x.got.trip) ? x.got.trip.searched ?? 0 : 0), 0);
            spend(spentNow);
            // Only a copy built for these dates is a version that is ready; an undated copy of
            // the same loop (storedAnyAge falls back to it) is listed after them, marked as
            // such, with its own key, so plan_days reads the file it is stored under and the
            // model never presents its days as the ones asked for.
            const ready = done.filter((x) => x.got.dated);
            const undated = done.filter((x) => !x.got.dated);
            const list = [...ready, ...undated];
            const undatedLine = undated.length ? `; ${undated.length === 1 ? "one version is" : `${undated.length} versions are`} the undated loop built earlier (${undated.map((x) => x.v.label).join(", ")}), shown in its place with its own key, its days not the ones asked` : "";
            return { ...corrected, ...excludedSummary(exclude, [], a.exclude), searched: spentNow, source: "stored" as Source, note: `the build did not finish in ${Math.round(WILD_BUILD_MS / 1000)} seconds; ${ready.length} of ${wanted} versions are ready${undatedLine} (the rest keep building and are stored; ask again in two minutes for the full ranking)`, ranked: list.map((x, i) => ({ rank: i + 1, variant: x.v.label, key: keyOfCopy(x.got.dated, x.v.tradeoff, x.v.noHubs), ...(x.got.dated ? {} : { undated: true }), ...summarise(x.got.trip) })), key: keyOfCopy(list[0].got.dated, list[0].v.tradeoff, list[0].v.noHubs), raw: list[0].got.trip };
          }
          // Only the variants built during this turn cost searches; a stored one carries the
          // count of the run that made it. (A built variant that the engine dropped as a
          // duplicate of another chain is not charged; it is rare and errs on the cheap side.)
          const spent = ranked.reduce((n, t) => n + (builtNow(t) ? t.searched ?? 0 : 0), 0);
          spend(spent);
          if (!ranked.length) return partial(liveOff() ? "every live search was refused" : "no way into that region on those dates from here; try another month or region", VARIANTS[0].tradeoff, VARIANTS[0].noHubs, spent);
          const variantKey = (label: string) => {
            const v = VARIANTS.find((x) => x.label === label) ?? VARIANTS[0];
            return keyOf(v.tradeoff, v.noHubs);
          };
          // Any ranked version closed at the deadline makes the answer partial, not only the
          // first: a fresh stored variant may rank above the one built (and cut) just now.
          const cut = ranked.map((t) => ({ variant: t.variant, ...cutShort(t) })).find((c) => c.partial);
          const fewer = ranked.length < wanted ? `${ranked.length} of ${wanted} versions could be built` : "";
          const cutNote = cut?.note ? `${cut.variant}: ${cut.note}` : "";
          return { ...corrected, ...excludedSummary(exclude, [], a.exclude), ...styleLine(fromStyle), engine, searched: spent, source: (spent ? "live" : "stored") as Source, ...(cut?.partial ? { partial: true } : {}), ...(fewer || cutNote ? { note: [fewer, cutNote].filter(Boolean).join("; ") } : {}), ranked: ranked.map((t) => ({ rank: t.rank, variant: t.variant, score: t.score, key: variantKey(t.variant), ...summarise(t) })), key: variantKey(ranked[0].variant), raw: ranked[0] };
        }
        const key = keyOf(tradeoff, a.noHubs);
        const path = pathOf(tradeoff, a.noHubs);
        const stored = await readJson<WildTrip>(path).catch(() => null);
        let trip = stored && stored.ageHours < 24 ? stored.body : null;
        let spent = 0;
        if (!trip) {
          // The budget is checked only once a build is really needed: a stored trip is free.
          if (liveOff()) return partial(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes, so the loop could not be built" : "today's live search budget is spent, so the loop could not be built", tradeoff, a.noHubs);
          const over = exhausted();
          if (over) return partial(over.error, tradeoff, a.noHubs);
          // The build is capped in time: the engine closes the loop at its deadline, and a
          // build still running at the race goes on in the background and is stored with its
          // verdict, so the next ask is served from the store. The walk engine (lib/wild-walk.ts)
          // takes the avoid words (and the searches the turn has left, when that is short) on top
          // of the wild parameters; it judges the loop itself, the classic chain is judged here.
          const walkExtra = { ...(avoid.length ? { avoid } : {}), ...(walkBudget != null ? { searchBudget: walkBudget } : {}) };
          trace(engine === "walk" ? "wildByWalk" : "buildWild", { ...params, tradeoff, noHubs: a.noHubs, ...(engine === "walk" ? walkExtra : {}) });
          const run = engine === "walk" ? wildByWalk({ ...params, tradeoff, noHubs: a.noHubs, ...walkExtra }) : buildWild({ ...params, tradeoff, noHubs: a.noHubs });
          const building = run.then(async (built) => {
            if (!built) return null;
            const judge = built.judge ?? (await judgeTrip(built).catch(() => null));
            const full: WildTrip = { ...built, judge: judge ?? undefined };
            // A walk on a short budget is this turn's answer only; the store keeps full builds.
            if (walkBudget == null) await writeJson(path, full).catch(() => null);
            return full;
          });
          // undefined means the clock won, null means the engine found no way in.
          let built: WildTrip | null | undefined;
          try {
            built = await Promise.race([building, sleep(WILD_BUILD_MS).then(() => undefined)]);
          } catch (err) {
            return refusal(err, tradeoff, a.noHubs);
          }
          if (built === undefined) {
            void building.catch(() => null);
            return partial(`the build did not finish in ${Math.round(WILD_BUILD_MS / 1000)} seconds`, tradeoff, a.noHubs);
          }
          if (!built) return partial(liveOff() ? "every live search was refused" : "no way into that region on those dates from here; try another month or region", tradeoff, a.noHubs);
          spent = built.searched ?? 0;
          spend(spent);
          trip = built;
        }
        const cut = spent ? cutShort(trip) : {};
        return { ...summarise(trip), ...corrected, ...excludedSummary(exclude, [], a.exclude), ...styleLine(fromStyle), engine, searched: spent, source: (spent ? "live" : "stored") as Source, ...(cut.partial ? { partial: true, note: cut.note } : spent ? {} : { note: `served from the store (built ${Math.round(stored?.ageHours ?? 0)} hours ago, no search spent)` }), key, raw: trip };
      }),
      toModelOutput: withoutRaw,
    }),

    long_stay: tool({
      description: "Bases for living somewhere for a month or more: for a region, a country list or named cities, the flight in, the flight out, rent and monthly living per base, the total and per day, why each base, side trips, visa, climate. Use for 'two months in Southeast Asia this winter', 'where could I work remotely cheaply'. About 16 to 20 live searches, a minute or two; not run when the turn's budget is spent. Bases in excluded (been) countries are never proposed; a flight through one is fine.",
      inputSchema: jsonSchema<{ region?: string; countries?: string[]; mustInclude?: string[]; wishes?: string; months?: number; startMonth?: string; budget?: "backpacker" | "mid" | "comfort"; style?: string; gateways?: string[]; exclude?: string[]; allow?: string[] }>({
        type: "object",
        properties: {
          region: { type: "string", enum: Object.keys(REGIONS), description: "one of the wild regions, or 'custom' with countries or mustInclude" },
          countries: { type: "array", items: { type: "string" }, description: "countries instead of a region, names or ISO2 codes" },
          mustInclude: { type: "array", items: { type: "string" }, description: "only these cities as bases (names or codes, up to 8); their countries are the list" },
          wishes: { type: "string", description: "the traveller's own words ('warm, by the sea, good coffee'), up to 300 characters; tilts the ranking and is answered in each base's why" },
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
        const given = a.countries?.map((c) => countryCode(String(c ?? "").trim()) ?? String(c ?? "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
        // A country list of been countries only is an answer, not twenty searches.
        const countries = given?.filter((c) => countryAllowed(c, exclude));
        if (given?.length && !countries?.length) return plain(excludedNote(given));
        if (a.countries?.length && !given?.length) return plain(`none of ${a.countries.join(", ")} is a country I know; use names or ISO2 codes (PT, TH)`, "data");
        const mustInclude = Array.isArray(a.mustInclude) ? a.mustInclude.map((x) => String(x ?? "").trim().slice(0, 40)).filter(Boolean).slice(0, 8) : [];
        const wishes = typeof a.wishes === "string" && a.wishes.trim() ? a.wishes.trim().slice(0, 300) : undefined;
        const region = a.region ? (Object.keys(REGIONS) as Region[]).find((k) => k === a.region || fold(k) === fold(a.region!) || fold(REGIONS[k].label) === fold(a.region!)) : undefined;
        if (!region && !countries?.length && !mustInclude.length) return { error: a.region ? `unknown region ${a.region}; one of ${Object.keys(REGIONS).join(", ")}` : "a region, a country list or cities are needed" };
        const from = codesOf(a.gateways, gateways);
        if (!from.length) return { ...unknownPlace("gateway", (a.gateways ?? []).join(", ")), bases: [] };
        const months = Math.min(6, Math.max(1, Math.round(a.months ?? 2)));
        const startMonth = a.startMonth && /^\d{4}-\d{2}$/.test(a.startMonth) ? a.startMonth : undefined;
        // Sixteen to twenty searches is most of a turn: when the turn's budget is spent or
        // live prices are off the engine is not run at all (it has no search budget of its
        // own), and the answer is a plain note naming the next step.
        const over = exhausted();
        if (over) return { months, searched: 0, source: "none" as Source, bases: [], note: `${over.error}; the long stay was not priced` };
        if (liveOff()) return { months, searched: 0, source: "none" as Source, bases: [], note: `${kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent"}; ${RATE_NOTE}; the long stay was not priced. Offer to price the bases in a few minutes.` };
        // The engine prices the bases it can and marks the flights it could not get; a search
        // refused mid-run leaves that base unpriced under a note. Past the time cap, the
        // promise is left to finish and the answer says so. An input the engine cannot act on
        // (an unknown city, custom with no countries) is its plain sentence, not a failure.
        let r;
        try {
          // The engine's deadline sits a little before the race fires: past it no further base
          // is priced and the ones done so far come back with partial: true and the engine's
          // note, so a time-capped turn still gets priced bases; the race is the last resort.
          const deadline = Date.now() + LONG_BUILD_MS - DEADLINE_MARGIN_MS;
          const query = { gateways: from, home: ctx.home, region: region, countries, months, startMonth, budget: a.budget, style: a.style, origin: ctx.origin, exclude, deadline, ...(mustInclude.length ? { mustInclude } : {}), ...(wishes ? { wishes } : {}) };
          trace("longStay", query);
          const building = longStay(query);
          r = await Promise.race([building, sleep(LONG_BUILD_MS).then(() => null)]);
          if (!r) {
            void building.catch(() => null);
            // The engine keeps no memo of a run cut short; only Kiwi's gate remembers the
            // searches already made (a day), so a retry repeats the pricing but faster.
            return { months, searched: 0, source: "none" as Source, bases: [], note: `the long stay did not finish pricing in ${Math.round(LONG_BUILD_MS / 1000)} seconds; ask again in a minute: the searches already made are remembered by the gate, so the retry is quicker` };
          }
        } catch (err) {
          if (err instanceof LongStayInputError) return { months, ...plain(err.message, "data"), bases: [] };
          throw err;
        }
        // builtNow marks the result as charged, so it is asked once: a run memoised by the
        // engine (the same ask within its window) costs nothing now and is reported as memo.
        const built = builtNow(r);
        spend(built ? r.searched : 0);
        const liveNote = liveOff() ? (kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent") : "";
        const bases = filterByCountry(r.bases, exclude).slice(0, 8);
        // The nights of a base are the days the engine counted between its two flights
        // (LongStayBase.days), not a nominal months x 30: the costs were counted for those days.
        const nightsOf = (b: (typeof bases)[number]) => Math.max(1, Math.round(b.days ?? (b.flightIn && b.flightOut ? (Date.parse(b.flightOut.date) - Date.parse(b.flightIn.date)) / 86_400_000 : months * 30)));
        const raw: Deal[] = bases
          .filter((b) => b.flightIn)
          .map((b) => ({ gw: b.flightIn!.from, dst: CITIES[b.code]?.airports[0] ?? b.code, dstCity: b.code, city: b.name, country: b.country, price: Math.round(b.flightIn!.price + (b.flightOut?.price ?? 0)), out: b.flightIn!.date, back: b.flightOut?.date ?? "", nights: nightsOf(b), stops: 0, carriers: [], outMin: 0, backMin: 0, url: b.flightIn!.url, ...(b.flightOut ? { backTo: b.flightOut.to, url2: b.flightOut.url } : {}) }));
        const skipped = (r.skipped ?? []).slice(0, 12).map((x) => ({ country: COUNTRIES[x.country]?.name ?? x.country, reason: x.reason }));
        const priced = bases.filter((b) => b.flightIn).length;
        // The engine's own note when it stopped at its deadline ("N bases not priced in time"),
        // so the model says the list is short and offers to ask again.
        const cutAt = r.partial ? r.note.search(/\d+ bases? not priced in time/) : -1;
        const cutNote = cutAt >= 0 ? r.note.slice(cutAt) : "";
        const note = r.failed && !priced ? `${liveNote || "every live search was refused"}; ${RATE_NOTE}: the bases, rent and living costs are from the data, the flights are unpriced. Offer to price them in a few minutes.` : r.failed ? `${r.failed} search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); ${priced} of ${bases.length} bases have flights, the others are unpriced${cutNote ? `; ${cutNote}` : ""}` : !bases.length ? `no base left for ${region ? REGIONS[region].label : countries?.map(nameOf).join(", ")}: ${skipped.map((s) => `${s.country} (${s.reason})`).join(", ") || "no known city there"}` : cutNote || undefined;
        return {
          months,
          searched: built ? r.searched : 0,
          source: (r.failed && !priced ? "data" : built ? "live" : "memo") as Source,
          ...excludedSummary(exclude, [], a.exclude),
          ...(r.partial ? { partial: true } : {}),
          ...(r.failed ? { failed: r.failed } : {}),
          ...(r.constraints?.length ? { constraints: r.constraints } : {}),
          ...(note ? { note } : {}),
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
      inputSchema: jsonSchema<{ members: { name: string; origins: string[]; available: { from: string; to: string }[] }[]; minNights?: number; maxNights?: number; where?: string; direct?: boolean; budgetPerPerson?: number; exclude?: string[]; allow?: string[] }>({
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
          minNights: { type: "number", description: "default 2 (or the trip style's nights a place when the traveller changed it)" },
          maxNights: { type: "number", description: "default 4 for a weekend (or the trip style's nights a place when the traveller changed it)" },
          where: { type: "string", description: "a city, a country or a region to meet in, or a comma list of country names ('Portugal, Spain'); omit for anywhere" },
          direct: { type: "boolean" },
          budgetPerPerson: { type: "number", description: "euros a person at most; options where anyone pays more are dropped and the answer says how many" },
          ...BEEN_PROPS,
        },
        required: ["members"],
      }),
      execute: safe(async (a) => {
        // Each person flies from their own airports, never from the traveller's: a town we
        // cannot resolve is an error naming the person, so the agent asks with a people widget.
        const members: GroupMember[] = [];
        const corrections: string[] = [];
        for (const m of (a.members ?? []).slice(0, 8)) {
          const name = String(m?.name ?? "").slice(0, 40) || "someone";
          const given = Array.isArray(m?.origins) ? m.origins.map((o) => String(o ?? "")) : typeof (m as { origins?: unknown })?.origins === "string" ? [String((m as { origins?: unknown }).origins)] : [];
          const origins = codesOf(given, []);
          if (!origins.length) return { ...unknownPlace(`${name}'s home`, given.join(", ") || "(none given)"), note: `${unknownPlace(`${name}'s home`, given.join(", ") || "(none given)").note}; ask for the nearest airport with a people widget`, windows: [], options: [] };
          // Dates written any usual way; a window in the past is dropped with a line saying so.
          const available = (Array.isArray(m.available) ? m.available : [])
            .map((w) => {
              const f = readDay(w?.from, ctx.today, `${name}'s window start`);
              const t = readDay(w?.to, ctx.today, `${name}'s window end`);
              for (const n of [f.note, t.note]) if (n) corrections.push(n);
              return { from: f.day, to: t.day };
            })
            .filter((w): w is { from: string; to: string } => !!w.from && !!w.to)
            .map((w) => (w.to < w.from ? { from: w.to, to: w.from } : w))
            .filter((w) => {
              if (w.to < ctx.today) corrections.push(`${name}'s window ${w.from} to ${w.to} is in the past and was dropped`);
              return w.to >= ctx.today;
            })
            .map((w) => (w.from < ctx.today ? { from: ctx.today, to: w.to } : w))
            .slice(0, 6);
          members.push({ name, origins, available });
        }
        if (members.length < 2) return { error: "at least two people with their airports and free dates are needed" };
        const bad = members.find((m) => !m.available.length);
        if (bad) return { error: `${bad.name} has no dates (YYYY-MM-DD from and to)${corrections.length ? `; ${corrections.join("; ")}` : ""}` };
        const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
        // The trip style's nights a place, only when the traveller changed them (a group meets in one place).
        const minNights = Math.max(1, Math.round(a.minNights ?? (nightsStyled ? prefs.nightsPerPlace[0] : 2)));
        const maxNights = Math.max(minNights, Math.round(a.maxNights ?? (nightsStyled ? prefs.nightsPerPlace[1] : 4)));
        // The engine prices every target for every airport group for three windows, so the
        // country list is capped: four, or two once the group flies from more than two places.
        const groups = new Set(members.map((m) => [...m.origins].sort().join(","))).size;
        // A meeting country the traveller has been to is dropped from the list before searching.
        const exclude = excludeOf(a.exclude, a.allow);
        const { kept, dropped } = splitWhere(a.where, exclude);
        if (!kept.length && dropped.length) return { searched: 0, source: "none" as Source, windows: [], options: [], note: excludedNote(dropped) };
        const where = kept.slice(0, groups > 2 ? 2 : 4).join(",") || undefined;
        // The common windows cost nothing: when live prices are off they are the answer, with
        // the note, so the group still learns when they can all go.
        const windowsOnly = (reason: string, turn = false) => ({ searched: 0, source: "data" as Source, ...corrected, ...excludedSummary(exclude, dropped, a.exclude), note: turn ? `${reason}; the windows everyone is free are listed unpriced` : `${reason}; ${RATE_NOTE}. The windows everyone is free are listed unpriced; offer to price the cities in a few minutes.`, windows: groupWindows(members, minNights, maxNights).slice(0, 6).map((w) => ({ dates: `${w.from} to ${w.to}`, nights: w.nights, everyone: w.everyone, compromises: w.compromises })), options: [] });
        if (liveOff()) return windowsOnly(kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent");
        const over = exhausted();
        if (over) return windowsOnly(over.error, true);
        const budgetPerPerson = Number.isFinite(a.budgetPerPerson) && a.budgetPerPerson! > 0 ? Math.round(a.budgetPerPerson!) : undefined;
        let r;
        try {
          // The engine's deadline sits a little before the race fires: past it no further
          // window is priced and the options found come back with partial: true and the
          // engine's note ("N windows not priced in time"); the race is the last resort.
          const deadline = Date.now() + LONG_BUILD_MS - DEADLINE_MARGIN_MS;
          const query = { members, minNights, maxNights, where, direct: a.direct, exclude, deadline, ...(budgetPerPerson ? { budgetPerPerson } : {}) };
          trace("groupTrip", query);
          const building = groupTrip(query);
          r = await Promise.race([building, sleep(LONG_BUILD_MS).then(() => null)]);
          if (!r) {
            void building.catch(() => null);
            return { ...windowsOnly(`the group search did not finish in ${Math.round(LONG_BUILD_MS / 1000)} seconds`), note: `the group search did not finish in ${Math.round(LONG_BUILD_MS / 1000)} seconds; the windows are listed, ask again in a minute for the priced cities` };
          }
        } catch (err) {
          // An input the engine cannot price (a region with every country excluded, an unknown
          // meeting place) is a note with the windows, not a failure.
          if (err instanceof GroupInputError) return { ...windowsOnly(err.message), note: err.message };
          throw err;
        }
        const built = builtNow(r);
        spend(built ? r.searched : 0);
        const options = filterByCountry(r.options, exclude).slice(0, 6);
        const raw: Deal[] = options.map((o) => ({ gw: o.perMember[0]?.from ?? members[0].origins[0], dst: CITIES[o.dstCity]?.airports[0] ?? o.dstCity, dstCity: o.dstCity, city: o.city, country: o.country, price: Math.round(o.total), out: o.window.from, back: o.window.to, nights: o.window.nights, stops: 0, carriers: [], outMin: 0, backMin: 0, url: o.perMember[0]?.url ?? "" }));
        const note = r.note ?? (!options.length ? (r.failed ? `every live search was refused (${r.failed}); ${RATE_NOTE}; the windows are listed unpriced` : !r.windows.length ? "no window fits everyone's dates with these nights; ask for more flexible dates" : r.dropped ? `${r.dropped} option${r.dropped === 1 ? "" : "s"} dropped: someone would pay more than €${budgetPerPerson}; raise the budget or widen the place` : `no city had a fare for everyone in ${r.windows.length} window${r.windows.length === 1 ? "" : "s"}${where ? ` in ${where}` : ""}; widen the place or the nights`) : r.failed ? `${r.failed} search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); a city may be missing` : undefined);
        return {
          searched: built ? r.searched : 0,
          source: (r.failed && !options.length ? "data" : built ? "live" : "memo") as Source,
          ...corrected,
          ...excludedSummary(exclude, dropped, a.exclude),
          ...(r.partial ? { partial: true } : {}),
          ...(r.where ? { where: r.where } : {}),
          ...(r.dropped ? { dropped: r.dropped } : {}),
          ...(note ? { note } : {}),
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
        const hit = findCity(city ?? "");
        if (!hit) return unknownPlace("city", city ?? "");
        const r = bestMonths(hit[0]);
        if (!r) return plain(`no climate normals for ${hit[1].name} in the data; the nearest big city may have them`, "data");
        return { searched: 0, source: "data" as Source, city: hit[1].name, best: r.best.map((m) => MONTH_NAMES[m - 1]), months: r.months.map((m) => ({ month: MONTH_NAMES[m.m - 1], highC: m.tmax, rainMm: m.rain, score: m.score })) };
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
        if (!srcs.length) return { ...unknownPlace("origin", a.from), verdict: "unknown" as const };
        if (!dsts.length) return { ...unknownPlace("destination", a.to || "(none given)"), verdict: "unknown" as const };
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
        if (!best) return { searched: 0, source: "none" as Source, route, month: a.month, verdict: "unknown" as const, samples: 0, note: "the fare memory is not available right now (no database); say the price cannot be judged against history", ...airports };
        if (!best.r!.samples) return { searched: 0, source: "memory" as Source, route, month: a.month, verdict: "unknown" as const, samples: 0, note: "no fare history for this route yet", ...airports };
        const r = best.r!;
        // Fewer than three days of history is no history: the median of one or two fares says nothing.
        if (r.samples < 3) return { searched: 0, source: "memory" as Source, route, month: a.month, ...r, verdict: "unknown" as const, note: `only ${r.samples} day${r.samples === 1 ? "" : "s"} of fares seen; not enough to judge`, ...airports };
        return { searched: 0, source: "memory" as Source, route, month: a.month, ...r, ...airports };
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
        return { widget: true, kind, question: String(a.question ?? "").slice(0, 160) || "Which do you prefer?", ...(options.length ? { options } : {}), ...(Object.keys(defaults).length ? { defaults } : {}) };
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
        properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, kinds: { type: "array", items: { type: "string" }, description: "free words: a kind (festival, sport, culture, season, music, food), a word of an event's name (carnival, marathon, lantern), a city, a country code" }, live: { type: "number", description: "how many unpriced events to price live (default 4, slow)" }, ...BEEN_PROPS },
        required: ["from", "to"],
      }),
      execute: safe(async (a) => {
        const f = futureDay(a.from, ctx.today, "the window start");
        if (!f.day) return { error: f.note! };
        const t = readDay(a.to, ctx.today, "the window end");
        if (!t.day) return { error: t.note! };
        let to = t.day;
        const corrections = [f.note, t.note].filter((n): n is string => !!n);
        if (to < f.day) {
          corrections.push(`the window ended before it started; set to ${f.day} plus 30 days`);
          to = addDays(f.day, 30);
        }
        const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
        const exclude = excludeOf(a.exclude, a.allow);
        // The events and the board fares cost nothing; only the unpriced ones are searched
        // live, and not at all when live prices are off or the turn's budget is spent.
        const over = exhausted();
        const blocked = liveOff() || !!over;
        const live = blocked ? 0 : Math.min(6, Math.max(0, Math.round(a.live ?? 4)));
        const kinds = Array.isArray(a.kinds) ? a.kinds.map((k) => String(k ?? "").trim().slice(0, 40)).filter(Boolean).slice(0, 8) : undefined;
        const r = await purposeTrips(gateways, f.day, to, { live, kinds, exclude });
        // The engine counts the searches it really sent (a memoised answer sends none).
        spend(r.searched ?? live);
        // An event in a been country is not a reason to go back there.
        const events = r.filter((t) => countryAllowed(t.event.country, exclude));
        const priced = events.filter((t) => t.deal).length;
        const note = r.failed ? `${r.failed} live search${r.failed === 1 ? "" : "es"} failed (Kiwi refused); those events are unpriced, not absent` : blocked && events.length > priced ? `${over ? over.error : kiwiThrottled() ? "Kiwi is throttling this address for a few minutes" : "today's live search budget is spent"}; ${priced} of ${events.length} events are priced from tonight's boards, the rest are listed unpriced` : !events.length ? `no event worth the trip is known between ${f.day} and ${to}${a.kinds?.length ? ` of kind ${a.kinds.join(", ")}` : ""}; widen the window or drop the kind` : undefined;
        return { searched: r.searched ?? live, source: ((r.searched ?? 0) > 0 ? "live" : priced ? "boards" : "data") as Source, ...corrected, ...excludedSummary(exclude, [], a.exclude), ...(r.failed ? { failed: r.failed } : {}), ...(note ? { note } : {}), events: events.slice(0, 12).map((t) => {
            // The events file names a city by its code (city) and its name (cityName, when
            // the engine has it); the chat cards need the name, the place and the dates.
            const e = t.event as typeof t.event & { cityName?: string; lat?: number; lon?: number; url?: string };
            const cityName = e.cityName ?? CITIES[e.city]?.name ?? e.city;
            return { event: e.name, city: cityName, code: e.code ?? e.city, country: e.country, start: e.start, end: e.end, dates: `${e.start} to ${e.end}`, kind: e.kind, note: e.note, ...(typeof e.lat === "number" && typeof e.lon === "number" ? { lat: e.lat, lon: e.lon } : {}), ...(e.url ? { url: e.url } : {}), cheapestTrip: t.deal ? compactDeal(t.deal) : null, priced: t.source };
          }), raw: events.map((t) => t.deal).filter((d): d is Deal => !!d) };
      }),
      toModelOutput: withoutRaw,
    }),

    stopover_programmes: tool({
      description: "Airlines that give a free or very cheap hotel night in their hub on the way (Turkish Airlines in Istanbul, Qatar in Doha, TAP in Lisbon, Icelandair, Finnair, Emirates, Singapore). Use when a route goes through one of these hubs or the traveller asks about layover hacks.",
      inputSchema: jsonSchema<Record<string, never>>({ type: "object", properties: {} }),
      execute: async () => ({ searched: 0, source: "data" as Source, count: Object.keys(STOPOVER_PROGRAMMES).length, programmes: Object.entries(STOPOVER_PROGRAMMES).map(([hub, p]) => ({ hub, airline: p.airline, note: p.note })) }),
    }),

    hotel_deals: tool({
      description: "Where hotels are cheap right now: the cities (of the eighty most visited) whose cheapest decent hotel for the standard weekend four weeks out is at least 25% under its own recent median, from Atlas's nightly LiteAPI snapshots. Instant, no searches. Use when the traveller asks where is cheap to stay, about hotel deals or hotels in general without a city. Says 'warming up' until three nightly snapshots exist; say so plainly. Hotels in excluded (been) countries are left out: a hotel night there is a stay there.",
      inputSchema: jsonSchema<{ country?: string; limit?: number; exclude?: string[]; allow?: string[] }>({ type: "object", properties: { country: { type: "string", description: "only this country (name or ISO code), optional" }, limit: { type: "number", description: "default 10, max 20" }, ...BEEN_PROPS } }),
      execute: safe(async (a) => {
        const exclude = excludeOf(a.exclude, a.allow);
        const countryRaw = (a.country ?? "").trim();
        const cc = countryCode(countryRaw) ?? (countryRaw ? findCity(countryRaw)?.[1].country : undefined);
        if (countryRaw && !cc) return { ...unknownPlace("country", countryRaw), status: "ok", deals: [] };
        if (cc && !countryAllowed(cc, exclude)) return { searched: 0, source: "data" as Source, status: "ok", note: excludedNote([cc]), deals: [] };
        const r = await hotelDeals();
        const deals = filterByCountry(r.deals, exclude).filter((d) => !cc || d.country === cc).slice(0, Math.min(20, Math.max(1, Math.round(a.limit ?? 10))));
        return {
          searched: 0,
          source: "liteapi" as Source,
          status: r.status,
          note: r.note ?? (!deals.length ? (r.status === "ok" ? (cc ? `no hotel deal in ${COUNTRIES[cc]?.name ?? cc} tonight` : "no city is a deal tonight: nowhere is 25% under its own typical price") : `the hotel snapshots are ${r.status}; no deal to show yet`) : `${deals.length} cities at least 25% under their own recent median`),
          snapshots: r.snapshots,
          ...(r.latest ? { weekend: `${r.latest.checkin} to ${r.latest.checkout}`, citiesTracked: r.latest.cities } : {}),
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
              if (!srcs.length) return { ...unknownPlace("origin", a.from ?? ""), fares: [] };
              if (!dsts.length) return { ...unknownPlace("destination", a.to ?? ""), fares: [] };
              const dateFrom = parseDay(a.dateFrom, ctx.today) ?? undefined;
              const dateTo = parseDay(a.dateTo, ctx.today) ?? undefined;
              const pairs = srcs.flatMap((src) => dsts.map((dst) => ({ src, dst })));
              const results = await Promise.all(pairs.map(async (p) => ({ ...p, fares: await fareHistory(p.src, p.dst, dateFrom, dateTo, 25) })));
              const best = results.sort((x, y) => y.fares.length - x.fares.length)[0];
              return { searched: 0, source: "memory" as Source, route: `${best.src} to ${best.dst}`, count: best.fares.length, ...(pairs.length > 1 ? { airportsTried: [...new Set(dsts)] } : {}), ...(best.fares.length ? {} : { note: `nobody on Atlas has searched ${best.src} to ${best.dst}${dateFrom || dateTo ? " for those dates" : ""} yet; scan_cheapest or reprice_route would fill the memory` }), fares: best.fares };
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
        const nights = Math.min(90, Math.max(5, Math.round(a.nights ?? 14)));
        // A trip built with a countries list is stored under region custom whatever region was
        // named (wild_trip's key says so); a key written back with the named region still
        // finds it, so the chat and the Wild tab read the same trip.
        const gw = mainGateway(gateways);
        const regions: Region[] = a.region === "custom" ? ["custom"] : [a.region, "custom"];
        let tripPath = wildPath(gw, regions[0], a.month ?? ctx.month, nights, a.style ?? "experiences", a.budget ?? "mid", a.custom ?? "");
        let trip = await readJson<WildTrip>(tripPath).catch(() => null);
        if (!trip && regions[1]) {
          const alt = wildPath(gw, regions[1], a.month ?? ctx.month, nights, a.style ?? "experiences", a.budget ?? "mid", a.custom ?? "");
          const under = await readJson<WildTrip>(alt).catch(() => null);
          if (under) {
            tripPath = alt;
            trip = under;
          }
        }
        const path = planPath(tripPath);
        const stored = await readJson<Plan>(path).catch(() => null);
        if (stored && stored.ageHours < 72) return { searched: 0, source: "stored" as Source, highlights: stored.body.highlights, days: stored.body.days, food: stored.body.food, monthly: stored.body.monthly, total: stored.body.total };
        if (!trip) return plain("no trip is stored under that key; build it first with wild_trip (the key it returns is what plan_days needs)", "none");
        const plan = await planDays(trip.body, path);
        if (!plan) return plain("the planner did not answer; the trip is there, offer to try the plan again", "model");
        await writeJson(path, plan).catch(() => null);
        return { searched: 0, source: "model" as Source, highlights: plan.highlights, days: plan.days, food: plan.food, monthly: plan.monthly, total: plan.total };
      }),
    }),

    make_itinerary: tool({
      description:
        "Turns a trip into a day-by-day itinerary: what to see, do and eat each morning, afternoon and evening, with the travel legs in place, the weather, events on those days and the estimated costs. Two ways in. (1) from: 'last_route' (the latest cheapest_way answer; option 1 is the first option shown, default the cheapest), 'last_deal' (the latest deals shown; option picks the card, default the first), 'last_wild' (the latest wild_trip). (2) stops: places by name with nights each, in order, plus start (YYYY-MM-DD, default three weeks out) and origin (default the traveller's place). Optional wishes (the traveller's words: 'street food, no museums'), pace (slow, balanced, packed) and budget (backpacker, mid, comfort). No Kiwi search; about a minute of writing. Returns the days in short and the costs; the app opens the full itinerary. Saving it is the traveller's click in that view, never yours.",
      inputSchema: jsonSchema<{ from?: "last_route" | "last_deal" | "last_wild"; option?: number; origin?: string; start?: string; stops?: { place: string; nights: number }[]; wishes?: string; pace?: Pace; budget?: BudgetTier }>({
        type: "object",
        properties: {
          from: { type: "string", enum: ["last_route", "last_deal", "last_wild"], description: "plan the latest thing of that kind shown in this conversation" },
          option: { type: "number", description: "which one, 1 = the first shown; a route defaults to its cheapest option, deals to the first" },
          origin: { type: "string", description: "with stops: where the trip starts and ends (a city or airport code); default the traveller's place" },
          start: { type: "string", description: "with stops: the first day, YYYY-MM-DD" },
          stops: { type: "array", items: { type: "object", properties: { place: { type: "string" }, nights: { type: "number" } }, required: ["place", "nights"] }, description: "the places in order with nights in each (up to 12)" },
          wishes: { type: "string", description: "the traveller's own words about the days, up to 300 characters" },
          pace: { type: "string", enum: ["slow", "balanced", "packed"] },
          budget: { type: "string", enum: ["backpacker", "mid", "comfort"] },
        },
      }),
      execute: safe(async (a) => {
        const recent = ctx.recent ?? (ctx.recent = new Map());
        const here: ItinPlace | undefined = ctx.origin ? { name: ctx.origin.label, lat: ctx.origin.lat, lon: ctx.origin.lon } : undefined;
        const corrections: string[] = [];
        const pick = Number.isFinite(a.option) && (a.option ?? 0) >= 1 ? Math.round(a.option!) - 1 : null;
        const stopsIn = Array.isArray(a.stops) ? a.stops.filter((x) => x && typeof x.place === "string" && x.place.trim()).slice(0, 12).map((x) => ({ place: x.place.trim().slice(0, 80), nights: Math.min(30, Math.max(1, Math.round(Number(x.nights) || 2))) })) : [];
        /** A skeleton from names: the shared way in for a stops list and for compact rows a restored thread kept. */
        const byNames = (origin: string | ItinPlace | undefined, start: string | undefined, stops: { place: string; nights: number }[]): Skeleton => {
          let day = addDays(ctx.today, 21);
          if (start != null && String(start).trim()) {
            const d = futureDay(start, ctx.today, "the start");
            if (!d.day) throw new ItineraryInputError(d.note!);
            if (d.note) corrections.push(d.note);
            day = d.day;
          } else corrections.push(`no start day given; planned from ${day}, three weeks out, say so`);
          return skeletonFromStops({ origin: origin ?? here ?? gateways[0], start: day, stops });
        };
        let skeleton: Skeleton;
        try {
          if (!a.from && stopsIn.length) skeleton = byNames(a.origin?.trim() || undefined, a.start, stopsIn);
          else if (a.from) {
            const kind = ({ last_route: "route", last_deal: "deal", last_wild: "wild" } as const)[a.from];
            if (!kind) return { error: "from must be last_route, last_deal or last_wild" };
            const got = recent.get(kind);
            const what = { route: "way from A to B (cheapest_way)", deal: "deal", wild: "wild trip (wild_trip)" }[kind];
            if (!got) return plain(`no ${what} has been shown in this conversation yet; find one first, or pass stops (places and nights) with a start day`);
            if (kind === "route") {
              const r = got as Partial<RouteResult> & { from?: unknown; to?: unknown; depart?: string; nights?: number | null; compact?: { kind: string; title: string }[] };
              if (Array.isArray(r.options) && r.options.length && typeof (r.options[0] as RouteOption).total === "number" && Array.isArray((r.options[0] as RouteOption).legs) && typeof (r.options[0] as RouteOption).legs[0] === "object") {
                const full = r as RouteResult;
                const i = pick ?? Math.max(0, full.cheapest ? full.options.indexOf(full.cheapest) : 0);
                if (i >= full.options.length) return plain(`the route has ${full.options.length} options; option ${i + 1} does not exist`);
                skeleton = skeletonFromRoute(full, i);
              } else {
                // A restored thread: planned by place names. The option asked for is checked
                // and named when its tickets differ from a plain trip there (a train to a hub,
                // an open-jaw), and a one-way answer (nights null) gets no return leg.
                const shown = r.compact ?? [];
                if (pick != null && shown.length && pick >= shown.length) return plain(`the route has ${shown.length} options; option ${pick + 1} does not exist`);
                const chosen = pick != null ? shown[pick] : undefined;
                if (chosen && chosen.kind && chosen.kind !== "direct" && chosen.kind !== "nearby-airports") corrections.push(`this conversation was reloaded, so option ${pick! + 1} (${chosen.title || chosen.kind}) could not be rebuilt leg by leg; the plan goes there by place names and its travel legs are estimates, say so`);
                const oneWay = r.nights == null;
                const sk = byNames(String(r.from ?? ""), r.depart, [{ place: String(r.to ?? ""), nights: r.nights ?? 3 }]);
                if (oneWay) corrections.push("the route was one way: planned 3 nights there with no way back, say so");
                // With an origin the names path adds the way home last (one leg more than stops).
                skeleton = oneWay && sk.legs.length > sk.stops.length ? { ...sk, legs: sk.legs.slice(0, -1) } : sk;
              }
            } else if (kind === "deal") {
              const list = got as Record<string, unknown>[];
              const i = pick ?? 0;
              const d = list[i];
              if (!d) return plain(`only ${list.length} deals were shown; option ${i + 1} does not exist`);
              if (typeof d.gw === "string" && typeof d.dstCity === "string" && typeof d.out === "string") skeleton = skeletonFromDeal(d as unknown as Deal, here);
              else {
                // A compact row (a restored thread): its key is gw|dst|out, its dates "out to back".
                const [gw = "", , keyOut = ""] = String(d.key ?? "").split("|");
                const [out, back] = String(d.dates ?? "").split(" to ");
                const nights = Number(d.nights) || (out && back ? Math.max(1, Math.round((Date.parse(back) - Date.parse(out)) / 86_400_000)) : 3);
                skeleton = byNames(gw || undefined, out || keyOut || undefined, [{ place: String(d.city ?? ""), nights }]);
              }
            } else skeleton = skeletonFromWild(got as WildTrip);
          } else return plain("say what to plan: from 'last_route', 'last_deal' or 'last_wild' for something shown in this conversation, or stops (places and nights) with a start day");
          skeleton = normaliseSkeleton(skeleton);
        } catch (err) {
          if (err instanceof ItineraryInputError) return plain(`${err.message}; name the nearest city instead`);
          throw err;
        }
        // The trip style's pace when the traveller said none for this plan.
        const pace: Pace = (["slow", "balanced", "packed"] as Pace[]).includes(a.pace as Pace) ? a.pace! : prefs.pace;
        const tier: BudgetTier = (["backpacker", "mid", "comfort"] as BudgetTier[]).includes(a.budget as BudgetTier) ? a.budget! : "mid";
        const wishes = typeof a.wishes === "string" && a.wishes.trim() ? a.wishes.trim().slice(0, 300) : undefined;
        // The engine's own clock ends a few seconds before ours, so it closes the days it has;
        // ours is the backstop that returns what was written when the engine overruns.
        const ms = Math.max(20_000, Math.min(ITINERARY_MS, turnLeftMs() - DEADLINE_MARGIN_MS));
        const opts = { wishes, pace, budget: tier, deadlineMs: Math.max(15_000, ms - 8_000) };
        trace("generateItinerary", { ...opts, stops: skeleton.stops.map((x) => x.name), start: skeleton.start, nights: skeleton.nights, legs: skeleton.legs.length, corrections: [...corrections] });
        const days: ItinDay[] = [];
        const before = kiwiStats().today;
        const building = generateItinerary(skeleton, opts, (d) => days.push(d));
        let it = await Promise.race([building, sleep(ms).then(() => undefined)]);
        spend(Math.max(0, kiwiStats().today - before));
        let timedOut = false;
        if (!it) {
          void building.catch(() => null);
          timedOut = true;
          const priced = (k: (kind: string) => boolean) => skeleton.legs.filter((l) => k(l.kind)).reduce((t, l) => t + (l.price ?? 0), 0);
          const flights = priced((k) => k === "fly");
          const ground = priced((k) => k !== "fly");
          it = { ...skeleton, id: itineraryKey(skeleton, { wishes, pace, budget: tier }), v: 1, days: [...days], costs: { flights, ground, stay: 0, food: 0, activities: 0, total: flights + ground, perDay: Math.round((flights + ground) / Math.max(1, days.length)), estimated: true }, food: [], events: [], ...(wishes ? { wishes } : {}), pace, budget: tier, sources: [], generatedAt: new Date().toISOString(), status: "partial" } satisfies Itinerary;
        }
        const itin = it;
        const brief = (d: ItinDay) => ({
          day: d.n,
          date: d.date,
          where: itin.stops[d.stop]?.name ?? "",
          title: d.title,
          plan: d.blocks.filter((b) => b.kind !== "travel").slice(0, 5).map((b) => `${b.slot}${b.time ? ` ${b.time}` : ""}: ${b.title}`).join("; "),
          ...(d.blocks.some((b) => b.kind === "travel") ? { travel: d.blocks.filter((b) => b.kind === "travel").map((b) => b.title).join("; ") } : {}),
          ...(d.weather ? { weather: d.weather } : {}),
        });
        const notes = [...corrections];
        if (timedOut) notes.push(`the writing took longer than ${Math.round(ms / 1000)} seconds: ${itin.days.length} of ${daysBetweenIso(itin.start, itin.end) + 1} days are written; opening it writes the whole trip again in the itinerary view, so offer that`);
        else if (itin.status === "partial") notes.push("some days were built from the guides because the model did not write them; they are plainer");
        return {
          searched: 0,
          // "model" when the planner wrote the days; "data" when it is not configured and the
          // engine built them from the guides alone.
          source: (hasItineraryModel() ? "model" : "data") as Source,
          title: itin.title,
          start: itin.start,
          end: itin.end,
          nights: itin.nights,
          stops: itin.stops.map((x) => `${x.name} (${x.nights} night${x.nights === 1 ? "" : "s"})`),
          days: itin.days.map(brief),
          // The parts of the total, so the answer can say what it covers; legs without a price
          // (a trip planned by names) are counted, so "flights not priced yet" is said, not 0.
          costs: { total: itin.costs.total, perDay: itin.costs.perDay, flights: itin.costs.flights, ground: itin.costs.ground, stay: itin.costs.stay, food: itin.costs.food, activities: itin.costs.activities, estimated: itin.costs.estimated, unpricedLegs: itin.legs.filter((l) => l.price == null && !l.url).length },
          ...(itin.events.length ? { events: itin.events.slice(0, 4).map((e) => `${e.date} ${e.name} (${e.city})`) } : {}),
          status: itin.status,
          ...(itin.status === "partial" ? { partial: true } : {}),
          ...(notes.length ? { note: notes.join("; ") } : {}),
          // The skeleton travels with the answer (the model never reads it, the browser keeps
          // it), so a restored thread can still open the itinerary: the view regenerates it,
          // or the itinerary API answers from its cache.
          skeleton,
          ...(wishes ? { wishes } : {}),
          pace,
          budget: tier,
          raw: itin,
        };
      }),
      // The model reads the days in short; the skeleton and the whole itinerary go only to the browser.
      toModelOutput: ({ output }: { output: unknown }): { type: "json"; value: JSONValue } => {
        if (output && typeof output === "object" && ("raw" in output || "skeleton" in output)) {
          const { raw: _raw, skeleton: _sk, ...rest } = output as Record<string, unknown>;
          void _raw;
          void _sk;
          return { type: "json", value: rest as JSONValue };
        }
        return { type: "json", value: (output ?? null) as JSONValue };
      },
    }),

    sights: tool({
      description: "What to see and do in a city from the Wikivoyage guide (names, a line each, photos exist), its festivals, and what the country is known for doing and eating.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: safe(async ({ city }) => {
        const hit = findCity(city ?? "");
        const name = hit ? hit[1].name : (city ?? "").trim();
        if (!name) return { error: "a city is needed" };
        const [s, g] = await Promise.all([getSights(name).catch(() => null), hit ? countryGuide(COUNTRIES[hit[1].country]?.name ?? hit[1].country).catch(() => null) : null]);
        if (!s && !g) return hit ? plain(`no Wikivoyage guide for ${name} in the data; web_search can fill in`, "data") : unknownPlace("city", name);
        return { searched: 0, source: "data" as Source, city: name, see: s?.see.slice(0, 8).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`) ?? [], do: s?.do.slice(0, 6).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 110)}` : ""}`) ?? [], eat: s?.eat.slice(0, 5).map((x) => `${x.name}${x.desc ? `: ${x.desc.slice(0, 90)}` : ""}`) ?? [], festivals: s?.events.slice(0, 5) ?? [], countryDo: g?.do.slice(0, 5) ?? [], countryEat: g?.eat.slice(0, 4) ?? [], ...(s?.url ? { guideUrl: s.url } : { note: `no city guide for ${name}; the country notes are shown` }) };
      }),
    }),

    events_near: tool({
      description: "What's on in a city in the next weeks from the city's own open event feed (20 cities have one: Paris, Madrid, Lisbon, Bologna, Berlin, Helsinki, New York, Chicago, San Francisco, Brisbane, Taipei and more). Says so when a city has none.",
      inputSchema: jsonSchema<{ city: string; days?: number }>({ type: "object", properties: { city: { type: "string" }, days: { type: "number", description: "default 30" } }, required: ["city"] }),
      execute: safe(async ({ city, days }) => {
        const hit = findCity(city ?? "");
        if (!hit) return { ...unknownPlace("city", city ?? ""), events: [] };
        const [, c] = hit;
        const near = sourcesNear(c.lat, c.lon);
        if (!near.length) return { searched: 0, source: "feed" as Source, city: c.name, events: [], note: "no open event feed for this city; use web_search for what's on" };
        const from = ctx.today;
        // One to sixty days ahead: the feeds are cached for three hours and list the coming weeks.
        const to = addDays(from, Math.min(60, Math.max(1, Math.round(Number(days) || 30))));
        const lists = await Promise.all(near.map((s) => s.fetch(from, to).catch(() => [])));
        const ev = lists.flat().filter((e) => !isNoise(e.name, e.kind)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12);
        return { searched: 0, source: "feed" as Source, city: c.name, sources: near.map((s) => s.attribution), count: ev.length, ...(ev.length ? {} : { note: `the feed for ${c.name} lists nothing between ${from} and ${to}; it may be down or empty, use web_search` }), events: ev.map((e) => ({ date: e.date, name: e.name, venue: e.venue, kind: e.kind, url: e.url })) };
      }),
    }),

    ...(hasFoursquare()
      ? {
          eats_near: tool({
            description: "Rated restaurants near a city centre that are good value (Foursquare rating 8+/10, price tier 1 or 2) with a tip each, or the best sweet places. Use for 'where should I eat in X', 'best ice cream in X'.",
            inputSchema: jsonSchema<{ city: string; sweet?: boolean }>({ type: "object", properties: { city: { type: "string" }, sweet: { type: "boolean" } }, required: ["city"] }),
            execute: safe(async ({ city, sweet }) => {
              const hit = findCity(city ?? "");
              if (!hit) return { ...unknownPlace("city", city ?? ""), places: [] };
              const [, c] = hit;
              const r = sweet ? await sweetsNear(c.lat, c.lon) : await goodValueEats(c.lat, c.lon);
              if (r.status !== "ok") return { searched: 0, source: "foursquare" as Source, city: c.name, places: [], note: `the restaurant ratings are not available (${r.note ?? r.status}); web_search can stand in` };
              return { searched: 0, source: "foursquare" as Source, city: c.name, count: r.places.length, ...(r.places.length ? {} : { note: `no rated ${sweet ? "sweet place" : "good value restaurant"} near the centre of ${c.name} in Foursquare; web_search can stand in` }), places: r.places.map((p) => ({ name: p.name, rating: p.rating, price: "€".repeat(p.price ?? 1), category: p.category, address: p.address, tip: p.tip })) };
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
              const { city } = a;
              const hit = findCity(city ?? "");
              if (!hit) return { ...unknownPlace("city", city ?? ""), status: "skipped", hotels: [] };
              const ci = futureDay(a.checkin, ctx.today, "check-in");
              if (!ci.day) return { error: ci.note! };
              let checkout = parseDay(a.checkout, ctx.today);
              const corrections = ci.note ? [ci.note] : [];
              if (!checkout || checkout <= ci.day) {
                corrections.push(`check-out ${checkout ?? `"${a.checkout ?? ""}"`} is not after check-in; set to ${addDays(ci.day, 2)}`);
                checkout = addDays(ci.day, 2);
              }
              const corrected = corrections.length ? { corrected: corrections.join("; ") } : {};
              const [, c] = hit;
              // Sleeping in a been country is a stay there: the note answers, no hotel is fetched.
              const exclude = excludeOf(a.exclude, a.allow);
              if (!countryAllowed(c.country, exclude)) return { searched: 0, source: "liteapi" as Source, status: "skipped", note: excludedNote([c.country]), hotels: [] };
              const r = await hotelsNear(c.lat, c.lon, ci.day, checkout, ctx.home);
              return { searched: 0, source: "liteapi" as Source, city: c.name, status: r.status, nights: `${ci.day} to ${checkout}`, ...corrected, note: r.note ?? (r.hotels.length ? `${r.hotels.length} hotels near the centre${liteApiLive() ? "" : " (sandbox prices)"}` : `no hotel priced near ${c.name} for ${ci.day} to ${checkout}; try other dates`), hotels: r.hotels.map((h) => ({ name: h.name, stars: h.stars, guests: h.rating, perNight: h.perNight, total: h.total })) };
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
              if (!from) return { ...unknownPlace("origin", origin ?? ""), fares: [] };
              // The country a fare lands in: its city when we know one, else the airports file.
              const exclude = excludeOf(a.exclude, a.allow);
              const landsIn = (dst: string) => CITIES[CITY_OF_AIRPORT.get(dst) ?? ""]?.country ?? AIRPORT_BY_IATA.get(dst)?.country;
              const fares = (await allFares({ origin: from })).filter((f) => countryAllowed(landsIn(f.dst), exclude)).sort((a, b) => a.price - b.price).slice(0, Math.min(30, limit ?? 15));
              return { searched: 0, source: "travelpayouts" as Source, origin: from, count: fares.length, ...excludedSummary(exclude, [], a.exclude), ...(fares.length ? {} : { note: `no cached one-way fare out of ${from} in Travelpayouts; the boards or a live search may still have fares` }), fares: fares.map((f) => ({ to: f.dst, city: CITIES[CITY_OF_AIRPORT.get(f.dst) ?? ""]?.name, price: f.price, date: f.departureAt.slice(0, 10), stops: f.transfers, url: f.url })) };
            }),
          }),
        }
      : {}),

    ground_reach: tool({
      description: "Towns reachable by train, coach or ferry from where the traveller is, within a time limit (expected door-to-door minutes from timetables, Europe only), biggest first.",
      inputSchema: jsonSchema<{ maxHours?: number; limit?: number; from?: string }>({ type: "object", properties: { maxHours: { type: "number", description: "default 5, max 10" }, limit: { type: "number" }, from: { type: "string", description: "a city to start from instead of the traveller's location" } } }),
      execute: safe(async (a) => {
        // From a named city, else the traveller's location, else their main airport.
        const named = a.from ? findCity(a.from) : null;
        if (a.from && !named) return { ...unknownPlace("start", a.from), towns: [] };
        const start = named ? { lat: named[1].lat, lon: named[1].lon, label: named[1].name } : ctx.origin ?? (() => {
          const g = resolveGateway(gateways[0]);
          return g ? { lat: g.lat, lon: g.lon, label: g.label } : null;
        })();
        if (!start) return plain("the traveller's location is unknown and no city was given; ask where they start", "data");
        const max = Math.min(600, Math.max(60, Math.round((a.maxHours ?? 5) * 60)));
        const r = reachFrom(start.lat, start.lon, max);
        const seen = new Set<string>();
        const towns = r.reached
          .filter((s) => s.pop >= 15_000)
          .sort((x, y) => y.pop - x.pop)
          .filter((s) => !seen.has(s.town ?? s.name) && seen.add(s.town ?? s.name))
          .slice(0, Math.min(25, a.limit ?? 12))
          .map((s) => ({ town: s.town ?? s.name, population: s.pop, minutes: s.minutes, changes: s.changes, mode: s.mode }));
        return { searched: 0, source: "data" as Source, from: start.label, maxHours: max / 60, count: towns.length, ...(towns.length ? {} : { note: `no town of 15,000 people within ${max / 60} hours of ${start.label} by train, coach or ferry in the timetables (the graph covers Europe, North America and parts of Asia)` }), towns };
      }),
    }),

    place_facts: tool({
      description: "Facts about a city and its country: population, how known it is, counts of restaurants, bars, nightlife, culture, nature, currency and rate, plugs, languages, visa for the traveller's passport, travel warning, this weekend's high.",
      inputSchema: jsonSchema<{ city: string }>({ type: "object", properties: { city: { type: "string" } }, required: ["city"] }),
      execute: safe(async ({ city }) => {
        const hit = findCity(city ?? "");
        if (!hit) return unknownPlace("city", city ?? "");
        const [code, c] = hit;
        const co = COUNTRIES[c.country];
        // Undefined fields are dropped (JSON would drop them anyway, but the shape says what is unknown).
        const facts = { city: c.name, country: co?.name ?? c.country, population: c.pop, wikipediaViewsPerYear: FAME[code]?.[0], places: PLACES[code], currency: co?.currency, eurRate: co?.rate, plugs: co?.plugs, voltage: co?.voltage, languages: co?.languages, visaForHomePassport: c.country !== ctx.home ? visaFor(VISA, ctx.home, c.country) : "home country", travelWarning: co?.advisory?.warning ? "full" : co?.advisory?.partial ? "partial" : "none", weekendHighC: weekendMax(code), hiddenGem: isGem(FAME, code, 0, PLACES[code]) };
        const missing = Object.entries(facts).filter(([, v]) => v == null).map(([k]) => k);
        return { searched: 0, source: "data" as Source, ...Object.fromEntries(Object.entries(facts).filter(([, v]) => v != null)), ...(missing.length ? { unknown: missing } : {}) };
      }),
    }),

    ...(hasTavily()
      ? {
          web_search: tool({
            description: "Search the live web for current recommendations and facts: best traditional food and where locals eat, what's on this month, how to do a loop or a cruise, entry rules, prices. Returns page snippets with their sources; cite the site.",
            inputSchema: jsonSchema<{ query: string }>({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
            execute: safe(async ({ query }) => {
              const q = String(query ?? "").trim().slice(0, 200);
              if (!q) return { error: "a query is needed" };
              const hits = (await webSearch(q, 5)).map((h) => ({ title: h.title, source: h.url, snippet: h.content.slice(0, 600) }));
              return { searched: 0, source: "web" as Source, query: q, count: hits.length, ...(hits.length ? {} : { note: `the web search returned nothing for "${q}"; try other words` }), results: hits };
            }),
          }),
        }
      : {}),
  };
  // Every route, deal list, wild trip or loop a tool of this turn produces becomes "the
  // latest" for make_itinerary (rememberOutput); the wrapper keeps each tool's own types.
  for (const [name, t] of Object.entries(tools) as unknown as [string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }][]) {
    if (!RECENT_KIND[name] || !t.execute) continue;
    const run = t.execute;
    t.execute = async (input, options) => {
      const out = await run(input, options);
      rememberOutput(ctx, name, out);
      return out;
    };
  }
  return tools;
}

// ---------------------------------------------------------------------------------------
// The conversation's frame, shared by the chat route (app/api/chat/route.ts) and the
// terminal CLI (scripts/atlas.ts), so a question asked in either gets the same agent.

const monthLong = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * The agent's context from what a client sent: the origin, airports, home country, month,
 * calendar day and Been list, each believed only when it is well formed. `today` is the
 * client's calendar day when it is within one day of the server's (in the evening west of UTC
 * the server is already on tomorrow, and a date widget would be rejected as past).
 */
export function chatContext(c: Record<string, unknown> | undefined): AgentContext {
  const raw = c ?? {};
  const o = raw.origin as { lat?: unknown; lon?: unknown; label?: unknown } | undefined;
  const origin = o && Number.isFinite(o.lat) && Number.isFinite(o.lon) ? { lat: Number(o.lat), lon: Number(o.lon), label: String(o.label ?? "their location").slice(0, 60) } : undefined;
  const gateways = (Array.isArray(raw.gateways) ? raw.gateways : []).filter((g): g is string => typeof g === "string" && /^[A-Z]{3}$/.test(g)).slice(0, 4);
  const home = typeof raw.home === "string" && /^[A-Z]{2}$/.test(raw.home) ? raw.home : "RO";
  const month = typeof raw.month === "string" && /^\d{4}-\d{2}$/.test(raw.month) ? raw.month : undefined;
  const serverDay = new Date().toISOString().slice(0, 10);
  const given = typeof raw.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.today) ? raw.today : "";
  const today = given && Math.abs(Date.parse(given) - Date.parse(serverDay)) <= 86_400_000 ? given : serverDay;
  // The Been list is believed only as clean ISO2 codes; an empty list is no list. It is never
  // stored here: it lives in the traveller's browser and rides along with each turn.
  const rawBeen = raw.been && typeof raw.been === "object" ? (raw.been as Partial<BeenPrefs>) : undefined;
  const beenCodes = rawBeen ? cleanCodes(rawBeen.countries) : [];
  const been: BeenPrefs | undefined = beenCodes.length ? { countries: beenCodes, newOnly: rawBeen?.newOnly === true } : undefined;
  // The trip style, clamped field by field (chatPrefs); like the Been list it lives in the
  // traveller's browser and rides along with each turn.
  const prefs = chatPrefs(raw.prefs);
  return { origin, gateways, home, month, today, budget: { used: 0, max: TURN_SEARCH_BUDGET }, been, exclude: excludedCountries(been), ...(prefs ? { prefs } : {}), recent: new Map() };
}

/**
 * The trip style paragraph of the system prompt: the traveller's own settings in one sentence
 * (lib/prefs.ts prefsLine) and the rule that they are every tool's defaults, so the model
 * passes them on and only a word in the message changes them, for that trip only.
 */
function prefsRule(prefs: Prefs | undefined): string {
  const p = prefs ?? DEFAULT_PREFS;
  const nights = p.nightsPerPlace[0] === p.nightsPerPlace[1] ? `${p.nightsPerPlace[0]}` : `${p.nightsPerPlace[0]} to ${p.nightsPerPlace[1]}`;
  const set = prefs && !sameAsDefault(prefs) ? "They set it themselves in the app." : "These are the app's defaults; the traveller has not changed them.";
  return `${prefsLine(p)} ${set} These are the defaults of every tool: walk_trips and wild_trip stay ${nights} nights in each place (nightsPerStop), use the ${p.tradeoff} tradeoff${p.taste === "unique" ? ", the style unique (hidden gems, smaller places)" : ""}${p.avoid.length ? `, and avoid ${p.avoid.join(", ")}` : ""}${p.maxFlightHours ? `; no flight longer than ${p.maxFlightHours} hours` : ""}${p.groundOk ? "" : "; no trains or coaches between places"}. The tools apply them on their own when you leave those inputs out, so leave them out unless the message says otherwise. A message that says otherwise wins for that trip only ("3 to 4 nights in each this time" is nightsPerStop 3, nightsPerStopMax 4 for this search; the next trip goes back to the style). When the traveller asks to change their style for good, say it is the Trip style button (or /style in the command line) in one line.`;
}

/** The system prompt for one turn: who the traveller is, the rules, the defaults, the tools' etiquette. */
export function chatSystem(ctx: AgentContext): string {
  const { origin, gateways, home, month, today, been } = ctx;
  const airports = origin ? nearestGateways(AIRPORTS, origin.lat, origin.lon, { maxKm: 350, limit: 6 }).map((g) => `${g.airport.iata} ${g.airport.city ?? g.airport.name} (${g.driveMin} min drive${gateways.includes(g.airport.iata) ? ", searched nightly" : ""})`) : gateways;
  const mainAirports = (gateways.length ? gateways : ["OTP"]).join(", ");
  // The been line names the countries (not codes) so the model can talk about them; the rule
  // after it covers the thread. A "been there" said in the chat becomes an exclusion only
  // when the traveller wants new countries (the chip's "only new", or asked for in words):
  // with revisits fine, it is a record to mention, never a filter. A tool's exclude ADDS to
  // the chip's list, so the model can only ever narrow the search, and `allow` lifts named
  // countries for one search.
  const newOnly = !!been?.newOnly;
  const chatRule = newOnly
    ? "When the traveller says in the chat that they have been somewhere else too, pass those countries (ISO2 codes) as exclude to every search tool for the rest of the thread: exclude ADDS to their Been list, which always applies on its own, so pass only the new ones. When they say a country is fine again this time, pass it in allow for that search."
    : "When the traveller says in the chat that they have been somewhere, remember it as a record for the thread and mention when a suggestion is somewhere new to them; do NOT pass it as exclude, revisits are fine. Only when they ask for new countries ('somewhere new', 'nowhere I have been') pass the countries they named (ISO2 codes) as exclude to every search tool for the rest of the thread; when they say a country is fine again this time, pass it in allow for that search.";
  const beenRule = `${beenLine(been, (cc) => COUNTRIES[cc]?.name ?? cc)}${been ? " " : ""}${chatRule} Never propose a destination or an overnight stop in an excluded country; a layover or connection through one is fine and never a reason to drop a route. For a lasting setting, suggest the Been chip in the top bar once, in one short line.`;

  return `You are Atlas, a travel agent in a chat, and you act before you ask. Today is ${today} (${monthLong(today)}). The traveller is in ${origin?.label ?? "an unknown place"}, home country ${COUNTRIES[home]?.name ?? home} (passport ${home}). Their airports: ${airports.join("; ") || "unknown"}. The airports searched nightly: ${mainAirports}.${month ? ` They have the month ${month} selected in the app.` : ""}

${beenRule}

${prefsRule(ctx.prefs)}

The rule that matters most: when something is unsaid, assume the sensible default, state the assumption in one line, search, show results, and only then ask at most ONE question, always through the ask tool (a widget), never as prose. Never ask two things. Never answer about prices without a tool result from this turn. Never say "no deals in the data" without a live search.

Defaults when the traveller does not say:
- When: open or "anytime" means a price calendar, the next 6 months month by month (scan_cheapest). A period of dates means find_getaways with those dates. A single month means that month.
- How long: 2 to 4 nights for a weekend, 3 to 7 nights inside Europe, 7 to 14 nights long-haul (another continent), 14 nights for a wild loop, 2 months for a long stay. The tools pick these by distance when you leave nights out.
- Where from: all their nightly airports at once (the tools take several origins). Mention a nearby airport only when it beats theirs by a clear margin.
- More than one city, a loop, "go from X and come back from Y", "plane then train", "cheapest loop", "3 cities in 6 days", or a chain of hops the traveller writes out ("Brasov to Warsaw by plane, Warsaw to Gdansk by train, then another city and back to Brasov or Bucharest"): walk_trips ONCE. It searches the way they do it by hand with Skyscanner Explore: one 'anywhere' search from where they are, the cheapest next hops by plane, train or coach from each stop, the cheapest way home to any of their airports. Never price such legs one by one with reprice_route or cheapest_way, and never call walk_trips twice in a turn unless its note asks for a change. Cities they name go in mustInclude (Warsaw, Gdansk), the first city they fly to too; a way home they name (Brasov, Sibiu, Otopeni) is their airports already. origin is only a start away from where they are ("loop from Cluj"); "fly to Warsaw then train to Gdansk" or "Brasov-Warsaw plane" while in Brasov has no origin. Places they dislike go in avoid: "not Germany" is DE, "countries like Germany" or "I don't like countries like Germany" is like:DE (a group word works too: dach, benelux, nordics, baltics, balkans, iberia). "Unique", "not touristy", "hidden gems", "smaller places" is style 'unique'. N days is N-1 to N nights (minNights, maxNights); "2 days a city" is nightsPerStop 2. With no dates, leave from and to out and say the assumed window from its corrected line. Then explain the best loop in their terms: its route line, the cheapest edge out of each stop and where a train or coach beat a flight, the nights per stop, the total and the hours, a booking link per flight; name the second loop in one line. To plan its days, call make_itinerary with the loop's stops (places with nights, in order) and its start day. reprice_route stays for one named leg the traveller asks to check.
- Two places named ("Brasov to Lisbon", "from Cluj to Paris"), how to get from one place to another, or the cheapest way somewhere ("cheapest way to Lisbon", "how do I get from Brasov to Vienna"): cheapest_way FIRST; it already checks nearby airports, trains to a bigger airport, hubs on two tickets and open-jaw, so never rebuild that by hand with reprice_route calls. Say what was considered (its considered list) in one line, name the cheapest and the fastest, and the tradeoff between them. When the traveller says "search harder", "look harder", "exhaust", "every option", call it again with harder: true (twice the searches). An option's kind "direct" means the nearest airports, not a nonstop flight: say nonstop only when its nonstop field is true. When placed says an end could not be placed, do not write "from X" or "to X" for it; say the place was not found and ask for the nearest city or airport.
- What is on, something to go to, festivals, carnivals, marathons, concerts, "worth flying for": events_worth_travelling_for with the window they gave (default the next three months; a single month means that month), kinds as their words. Say which events are within reach: the ones priced from their airports, cheapest first, with the dates and the fare; the unpriced ones in one line.
- "Anywhere", "the cheapest possible", "wherever is cheapest": find_getaways with exhaustive=true (it goes through many more targets and nearby origins).
- Named destination not on the boards (San Francisco, Tokyo, Bali, a country): ONE scan_cheapest call. When the destination is in a big country (${OPEN_JAW_COUNTRIES.join(", ")}) set openJawFrom to that country in that same single call, so coming home from another big city is priced too; never a second scan_cheapest for the open-jaw. Then reprice_route on the best month if a precise day matters.
- Where is cheap to stay, hotel deals, hotels in general with no city named: hotel_deals (instant, from the nightly hotel snapshots). When it says it is warming up, say plainly that the hotel history is not there yet and how many nights it has; for a named city and dates use hotels_near.
- "Return from another city": open-jaw via openJawFrom (a country or city), not a question.
- A far region word (Southeast Asia, South America, Central Asia), a loop of two weeks or more, "a trip through" a far country, backpacking, overland: wild_trip with 14 nights unless told; a loop of a few cities over a week or so, in Europe or nearby, is walk_trips; named countries go in countries, and the trip is then keyed as region custom (the key it returns says so, pass it on unchanged). A month or more somewhere: long_stay.
- Several people from different cities: group_trip at once with what is known, each person from their OWN city or airport; when a person's dates or airport are missing or the tool says a place is unknown, show the result for the others and ask with ONE people widget prefilled with what you know.
- Open "where could I go": cheapest_deals (tonight's boards, instant), then follow with find_getaways only when they give dates.
- Cool autumn, warm winter, beaches, food: pick the countries yourself (where as a comma list of at most four) rather than asking; use best_months when the traveller is flexible on when.

Itineraries:
- After you show a way from A to B, deals, a walk loop or a wild loop, close with one short line offering to make it an itinerary (the cards also carry a "Make an itinerary" button). Offer it once per result, not on every message.
- When the traveller asks to plan the days, wants a day-by-day plan, an itinerary, or says "make it an itinerary", call make_itinerary: from 'last_route', 'last_deal' or 'last_wild' (option for which one, 1 = the first shown) for what was shown, or stops (places with nights, in order) plus start when they name places ("3 nights in Lisbon from 14 November"). Pass their wishes in their words, and pace or budget when they say. For a wild trip prefer make_itinerary over plan_days unless they ask for a month's rent per city.
- After make_itinerary, say the shape in two or three lines (the days' highlights, the estimated total) and that the full itinerary opens in the app, where they can change the pace, regenerate, save and share it. Never offer to save it yourself.
- The app has a command line: "/" in the top bar opens it and runs things like "Brasov to Lisbon", "loop from Brasov 20 to 30 Oct 6 days", "events in february", "/wild sea 21" or "itinerary Lisbon 3 nights from 14 Nov" directly. Mention it once in a thread, in one line, when the request was exactly such a shape; never again after that.

Working with results:
- Rank by price per night for comparable trips, and say why the winner wins (price, direct, better dates, the right airport). Show the best three, never ten.
- When the dates are open, show the price calendar: the months with their cheapest fare. The client draws it from the scan_cheapest result; you name the best month and the best dates in words.
- Name the one or two tradeoffs that matter: a better layover or direct for €20 more, a stopover programme when the route goes through Istanbul, Doha, Lisbon, Reykjavik, Helsinki or Singapore (stopover_programmes), a nearby airport, open-jaw home from another city.
- Mention the fare memory's verdict (price_insight on the winning route and month, with the price in hand) when it has history; skip it when it says unknown.
- Remember stated preferences for the whole thread: "that one", "the second", "make it direct", "from Cluj too" refer to what you showed. Keep them for later searches too.
- Prices are return fares in euros unless you say one-way; say when a price is live versus searched nightly. Be honest about gaps (events only in 20 cities, trains only in Europe, hotels in sandbox).
- A tool answering with { error } is a fact to state in one line, then carry on with the next best tool; never retry the same call unchanged more than once.
- Every result says where it came from in source: live (searched now), memo (the same search within the hour), boards (searched last night), memory (a fare someone saw in the last days), stored (a trip built earlier), data (the static files), model (written now). Say which when you quote a price, in a few words ("searched now", "from last night's boards", "a remembered fare").
- When a result carries a note saying live prices are rate-limited (Kiwi is throttling, today's budget is spent), say so in ONE plain line, say the prices shown come from tonight's boards, the fare memory or a stored trip, and offer to try live again in a few minutes. Do not call the same live tool again in this turn. A result with a note and no data is still an answer: state the note and suggest the next step it names.
- A note saying this turn's search budget is spent is NOT a rate limit: nothing is blocked, a new message searches at once; say that in one line and never say "in a few minutes" for it.
- A note written as a plain sentence about the request (a city on the been list, nights not enough to pass through the cities asked, an unknown start airport, region custom without countries) is the engine's own refusal: repeat it to the traveller in your words and fix the input or ask, never call the same tool again unchanged.
- A result with corrected means an input was adjusted or read a certain way (a past date moved to today, a swapped window, "next friday" read as a date, a departure assumed three weeks out); say it in one short line so the traveller can object.
- Dates: write them as YYYY-MM-DD when you can; the tools also read "tomorrow", "next friday", "14 November", "Nov 14 2026" and say how they read them. Vague words ("this weekend", "Christmas", "end of October") are not dates: pick the day yourself and state it.
- plan_days takes the key object wild_trip returned, unchanged.

Searches cost: every live tool says how many Kiwi searches it makes, and a turn has ${TURN_SEARCH_BUDGET} in all; when a tool says the budget is used up, answer with what you have. Prefer one scan over many reprices and one walk over many legs; never call the same live tool twice with the same input in one turn.

Before a slow tool (scan_cheapest, find_getaways, cheapest_way, walk_trips, wild_trip, long_stay, group_trip, plan_days, make_itinerary) write one short line saying what you are searching and the assumption you made, then call it. A long build (wild_trip, long_stay, group_trip) may answer with what it had when its time ran out: partial: true with the engine's note (a shorter loop, bases or windows not priced in time), or a stored copy under a note (undated: true means that copy was built for no particular dates, so never present its days as the ones asked; its key is its own, pass it to plan_days as is); say so in one line and offer to ask again in two minutes.

Style: plain words, short paragraphs, no bullet symbols, no headings, no em dashes (use commas or full stops), links as [text](url). Name the city, the price, the dates and the airport. End with the one question, if any, through the ask tool, and nothing after it.`;
}
