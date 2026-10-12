// Server-only. The way back home from where the traveller is going, over a range of days, as a
// calendar: the cheapest flight and the cheapest DIRECT flight each day, the best direct, the
// cheapest overall and the cheapest door to door, and the ground leg from each home airport to
// the traveller's door. Shared by GET /api/way-home (the trip page's "Ways home") and the chat's
// way_home tool (lib/agent-tools.ts), so both answer the same question the same way.
//
// Searches (all through lib/kiwi.ts's gate, so a repeat within a day is free): one one-way search
// from the place's own airports to every home airport over the whole window, a second from the
// airports a train or coach reaches within three hours of the place; then, when a direct is asked
// for, none came back, or most days are empty, up to 2 more (4 with direct) aimed at one home
// airport each, because one search to many home airports returns the 15 cheapest fares of the
// whole window and on a busy route those are all one-stop (the owner's direct Ryanair Gdansk to
// Otopeni at 32 euros never showed until he said "direct"). At most 6, never more than the
// caller's `maxSearches`. With `live: false` (live prices off, or the caller's budget spent) it
// answers from the fare memory alone.
import airportsJson from "@/public/data/airports.json";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import { countryAirports, graphEnd, graphMinutes } from "./board";
import { cheapestSeen, type FareSeen } from "./db";
import { driveMinutes, haversineKm, nearestGateways } from "./geo";
import { BUDGET_MESSAGE, kiwiDate, kiwiStats, searchFlight, THROTTLED_MESSAGE, type KiwiItinerary } from "./kiwi";
import { HOME_MAX_MIN } from "./pairs";
import { gatewaysFor, resolvePlace } from "./route-finder";
import type { Airport, City, CountryInfo } from "./types";

const AIRPORTS = airportsJson as unknown as Airport[];
const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const AIRPORT_BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));
const CITY_OF_AIRPORT = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!CITY_OF_AIRPORT.has(a)) CITY_OF_AIRPORT.set(a, code);

/** The days of the window when none is given, the most it searches in one go, the home airports one search aims at. */
export const WAY_HOME_DAYS = 8;
export const WAY_HOME_MAX_DAYS = 14;
const HOME_LIST_MAX = 10;
/** Airports a train or coach reaches from the place within this many minutes also fly home. */
const ACCESS_MIN = 180;
/** What a kilometre on the ground costs when no fare is known (every engine uses the same rate). */
const EURO_PER_KM = 0.1;

// ---------------------------------------------------------------------------------------
// The contract.

/** The place the traveller comes back from, as the engines know it. A town without an airport lists the airports around it. */
export type WayHomePlace = { kind: "city" | "town"; code?: string; name: string; country: string; lat: number; lon: number; airports: string[] };
export type WayHomeQuery = {
  /** A city, town or airport by name or code, or a place the caller already resolved (the chat has its own gazetteer). */
  from: string | WayHomePlace;
  /** The city or airport code of `from` when the caller knows it (a trip stop's code): it decides between places of one name. */
  code?: string;
  /** The country (ISO2) of `from`, when known: a name shared by several cities is read as the one there. */
  country?: string;
  /** The first and last day they could fly back, YYYY-MM-DD; the caller checks and clips them. */
  fromDate: string;
  toDate: string;
  /** Nonstop flights only. */
  direct?: boolean;
  /** The traveller's home country (ISO2). */
  home: string;
  /** Where the traveller lives, for the ground leg home from each airport. */
  origin?: { lat: number; lon: number; label?: string };
  /** The traveller's own airports, listed first among the home airports. */
  gateways?: string[];
  /** Specific home airports or cities instead of every airport of the home country within six hours. */
  to?: string[];
  /** Live searches this answer may spend (default 6). */
  maxSearches?: number;
  /** False: no live search, the fare memory alone. */
  live?: boolean;
};
export type WayHomeFlight = { date: string; price: number; direct: boolean; stops: number; depart: string; arrive: string; carrier: string; url: string; from: string; fromName: string; to: string; toName: string; hours: number; /** The train or coach from the place to the airport, when it is not the place's own. */ first?: string; /** The ground leg from the landing airport to the door. */ last?: string; /** The flight plus both ground legs, euros (the ground legs estimated). */ doorToDoor: number; remembered?: true };
export type WayHomeDay = { date: string; cheapest?: WayHomeFlight; direct?: WayHomeFlight };
export type WayHomeLeg = { airport: string; name: string; minutes: number; price: number; km: number; how: string };
export type WayHomeResult = {
  from: string;
  /** Set when the place has no airport of its own. */
  placeNote?: string;
  window: { from: string; to: string };
  days: WayHomeDay[];
  bestDirect?: WayHomeFlight;
  cheapest?: WayHomeFlight;
  cheapestDoorToDoor?: WayHomeFlight;
  homeLegs: WayHomeLeg[];
  searchedFrom: string[];
  /** Live searches that left this process for this answer. */
  searched: number;
  failed: number;
  count: number;
  source: "live" | "memo" | "memory" | "none";
  /** True when every search was refused because live prices are rate-limited. */
  refused?: boolean;
  note?: string;
};
/** A place the engine could not read, or one with no airport that flies home: the route answers 400 or a note. */
export class WayHomeInputError extends Error {}

// ---------------------------------------------------------------------------------------
// Places.

const fold = (s: string) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
const COUNTRY_NAMES = new Set(Object.values(COUNTRIES).map((c) => fold(c.name)));
const CITY_LIST = Object.entries(CITIES);
const byPop = (a: [string, City], b: [string, City]) => (b[1].pop ?? b[1].airports.length) - (a[1].pop ?? a[1].airports.length);
/** What decides between cities of one name: the code given, then the country given, then the one nearest the traveller. */
export type PlaceHint = { code?: string; country?: string; near?: { lat: number; lon: number } };
/** Cities of one name in the order the hint prefers: in its country first, then nearest its point, then the biggest. */
function preferred(list: [string, City][], hint: PlaceHint): [string, City][] {
  const cc = hint.country?.toUpperCase();
  const km = (c: City) => (hint.near ? haversineKm(hint.near.lat, hint.near.lon, c.lat, c.lon) : 0);
  return [...list].sort((a, b) => Number(b[1].country === cc) - Number(a[1].country === cc) || km(a[1]) - km(b[1]) || byPop(a, b));
}

/** True for an airport in a country under a travel warning, unless the place itself is in that country. */
function unsafeAirport(code: string, placeCountry?: string): boolean {
  const cc = AIRPORT_BY_IATA.get(code)?.country;
  return !!cc && cc !== placeCountry && COUNTRIES[cc]?.advisory?.warning === true;
}
/** The airports of a point without its own: the nearest large or medium ones by road, then by train or coach within three hours. */
function airportsAround(lat: number, lon: number, country?: string): string[] {
  const road = nearestGateways(AIRPORTS, lat, lon, { maxKm: 200, limit: 6 })
    .filter((g) => g.airport.size !== "small" && !unsafeAirport(g.airport.iata, country))
    .slice(0, 3)
    .map((g) => g.airport.iata);
  let rail: string[] = [];
  try {
    rail = gatewaysFor({ lat, lon }, { max: 8 })
      .filter((a) => (a.kind === "train" || a.kind === "coach" || a.kind === "ferry") && a.minutes <= ACCESS_MIN && !unsafeAirport(a.code, country))
      .map((a) => a.code);
  } catch {
    // the ground graph is optional
  }
  return [...new Set([...road, ...rail])].slice(0, 5);
}

/**
 * A place by name or code: the hint's code first (a city or an airport), then a city of
 * cities.json (the exact name, accents ignored; a name several cities share is read by the hint:
 * its country, then the one nearest its point, so Florence from Brasov is Italy, not South
 * Carolina; an upper-case code; a whole leading word, "Cluj" for Cluj-Napoca), then a town, an
 * airport's name or "lat,lon" through the route finder. A country is never a place. Null when
 * nothing knows it.
 */
export function resolveWayHomePlace(raw: string, hint: PlaceHint = {}): WayHomePlace | null {
  const asCity = (c: [string, City]): WayHomePlace => ({ kind: "city", code: c[0], name: c[1].name, country: c[1].country, lat: c[1].lat, lon: c[1].lon, airports: c[1].airports });
  const code = (hint.code ?? "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    if (CITIES[code]) return asCity([code, CITIES[code]]);
    const city = CITY_OF_AIRPORT.get(code);
    if (city) return asCity([city, CITIES[city]]);
    const ap = AIRPORT_BY_IATA.get(code);
    if (ap) return { kind: "city", code, name: ap.city || ap.name, country: ap.country, lat: ap.lat, lon: ap.lon, airports: [code] };
  }
  const s = (raw ?? "").trim();
  const q = fold(s);
  if (!q || COUNTRY_NAMES.has(q)) return null;
  const exact = preferred(CITY_LIST.filter(([, c]) => fold(c.name) === q), hint);
  if (exact.length) return asCity(exact[0]);
  if (/^[A-Z]{3}$/.test(s)) {
    if (CITIES[s]) return asCity([s, CITIES[s]]);
    const city = CITY_OF_AIRPORT.get(s);
    if (city) return asCity([city, CITIES[city]]);
  }
  if (q.length >= 4) {
    const leading = preferred(
      CITY_LIST.filter(([, c]) => {
        const n = fold(c.name);
        return n.startsWith(q) && !/[a-z0-9]/.test(n.charAt(q.length));
      }),
      hint,
    );
    if (leading.length) return asCity(leading[0]);
  }
  const p = resolvePlace(s);
  if (!p) return null;
  const country = p.country ?? nearestGateways(AIRPORTS, p.lat, p.lon, { maxKm: 400, limit: 1 })[0]?.airport.country ?? "";
  return { kind: "town", name: p.label, country, lat: p.lat, lon: p.lon, airports: p.own ? [p.own] : airportsAround(p.lat, p.lon, country) };
}

// ---------------------------------------------------------------------------------------
// The engine.

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const isRefusal = (msg: string) => msg.includes(THROTTLED_MESSAGE) || msg.includes(BUDGET_MESSAGE) || /rate-limit|throttl|429|403/i.test(msg);
const label = (code: string) => AIRPORT_BY_IATA.get(code)?.city ?? CITIES[CITY_OF_AIRPORT.get(code) ?? ""]?.name ?? code;
const hoursText = (min: number) => `${Math.round((min / 60) * 10) / 10} h`;

type Ground = { minutes: number; km: number; euros: number; how: string };

/**
 * The way home over a window of days. Throws WayHomeInputError for a place nobody knows; answers
 * with a note (and no days) for a place with no airport that flies home or a window with no fare.
 */
export async function wayHome(q: WayHomeQuery): Promise<WayHomeResult> {
  const near = q.origin ? { lat: q.origin.lat, lon: q.origin.lon } : undefined;
  const place = typeof q.from === "string" ? resolveWayHomePlace(q.from, { code: q.code, country: q.country, near }) : q.from;
  if (!place) throw new WayHomeInputError(`"${String(q.from || q.code || "").slice(0, 60)}" is not a city, town or airport we know`);
  const fromDay = q.fromDate;
  const toDay = q.toDate < fromDay ? fromDay : q.toDate;
  const home = q.home.trim().toUpperCase();
  const me = q.origin ?? null;
  const meEnd = me ? { key: `me:${me.lat.toFixed(3)},${me.lon.toFixed(3)}`, lat: me.lat, lon: me.lon } : null;
  const hereName = me?.label || "home";
  const maxSearches = Math.max(0, Math.min(6, Math.round(q.maxSearches ?? 6)));

  // The ground leg from a home airport to the door: a short drive under 35 km, else the ground graph, else the road.
  const groundMemo = new Map<string, Ground | null>();
  const groundHome = (code: string): Ground | null => {
    if (groundMemo.has(code)) return groundMemo.get(code)!;
    const ap = AIRPORT_BY_IATA.get(code);
    let g: Ground | null = null;
    if (ap && me && meEnd) {
      const km = haversineKm(ap.lat, ap.lon, me.lat, me.lon);
      const end = graphEnd(code);
      const graph = km >= 35 && end ? graphMinutes(end, meEnd, 40) : null;
      g = km < 35 ? { minutes: driveMinutes(km), km, euros: 0, how: "a short drive" } : graph != null ? { minutes: graph, km, euros: Math.max(3, Math.round(km * EURO_PER_KM)), how: "train or coach" } : { minutes: driveMinutes(km), km, euros: Math.max(3, Math.round(km * EURO_PER_KM)), how: "by road" };
    }
    groundMemo.set(code, g);
    return g;
  };

  // Home: the traveller's own airports first, then every airport of their country within six hours of them.
  let homes: string[];
  const given = (q.to ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (given.length) {
    homes = given.flatMap((x) => (/^[A-Za-z]{3}$/.test(x) && AIRPORT_BY_IATA.has(x.toUpperCase()) ? [x.toUpperCase()] : (resolveWayHomePlace(x, { country: home, ...(near ? { near } : {}) })?.airports ?? []))).filter((x, i, l) => l.indexOf(x) === i).slice(0, HOME_LIST_MAX);
    if (!homes.length) throw new WayHomeInputError(`the home airport "${given.join(", ").slice(0, 60)}" is not one we know`);
  } else {
    const own = (q.gateways ?? []).filter((g) => /^[A-Z]{3}$/.test(g));
    const others = countryAirports(home)
      .filter((c) => !own.includes(c))
      .map((c) => ({ c, g: groundHome(c) }))
      // Without a door to time from, every airport of the home country counts, nearest the place first.
      .filter((x) => !me || (x.g && x.g.minutes <= HOME_MAX_MIN))
      .sort((x, y) => (x.g && y.g ? x.g.minutes - y.g.minutes : distanceTo(place, x.c) - distanceTo(place, y.c)))
      .map((x) => x.c);
    homes = [...own, ...others].slice(0, HOME_LIST_MAX);
  }

  // Where the flight home leaves from: the place's own airports, and the airports a train or coach reaches within three hours.
  const access = new Map<string, { minutes: number; km: number; kind: string; via?: string }>();
  try {
    for (const g of gatewaysFor({ lat: place.lat, lon: place.lon }, { max: 12 })) if (g.minutes <= ACCESS_MIN) access.set(g.code, { minutes: g.minutes, km: g.km, kind: g.kind, via: g.via });
  } catch {
    // the graph is optional: the place's own airports still fly
  }
  const ownAirports = place.airports.filter((c) => /^[A-Z]{3}$/.test(c) && !homes.includes(c)).slice(0, 4);
  const groundAirports = [...access.entries()]
    .filter(([c, x]) => (x.kind === "train" || x.kind === "coach" || x.kind === "ferry") && !ownAirports.includes(c) && !homes.includes(c) && AIRPORT_BY_IATA.get(c)?.country !== home && !unsafeAirport(c, place.country))
    .map(([c]) => c)
    .slice(0, 4);
  const homeLegs: WayHomeLeg[] = homes.map((c) => {
    const g = groundHome(c);
    return { airport: c, name: label(c), minutes: g?.minutes ?? 0, price: g?.euros ?? 0, km: Math.round(g?.km ?? 0), how: g ? (g.km < 35 ? "a short drive" : g.how) : "not timed: no home point given" };
  });
  const base = {
    from: place.name,
    ...(place.kind !== "city" ? { placeNote: `${place.name} has no airport of its own; flights leave from ${[...ownAirports, ...groundAirports].map(label).join(", ") || "none we know"}` } : {}),
    window: { from: fromDay, to: toDay },
    homeLegs,
    searchedFrom: [...ownAirports, ...groundAirports],
  };
  const emptyDays = (): WayHomeDay[] => {
    const out: WayHomeDay[] = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push({ date: d });
    return out;
  };
  if (!ownAirports.length && !groundAirports.length) return { ...base, days: emptyDays(), searched: 0, failed: 0, count: 0, source: "none", note: `no airport near ${place.name} that flies home; try the route finder for a train or coach` };

  const doorOf = (fromCode: string, toCode: string, price: number) => {
    const acc = ownAirports.includes(fromCode) ? null : access.get(fromCode);
    const firstEuros = acc ? Math.max(3, Math.round(acc.km * EURO_PER_KM)) : 0;
    const g = groundHome(toCode);
    return {
      first: acc ? `${acc.kind} from ${place.name} to ${label(fromCode)} airport, about ${hoursText(acc.minutes)}${acc.via ? ` via ${acc.via}` : ""}, about ${firstEuros} euros (estimate)` : undefined,
      last: g && g.km >= 35 ? `${g.how} from ${label(toCode)} to ${hereName}, about ${hoursText(g.minutes)}, about ${g.euros} euros (estimate)` : undefined,
      door: price + firstEuros + (g?.euros ?? 0),
    };
  };

  // Live prices off: the fare memory's cheapest one-way home in the window.
  if (q.live === false || maxSearches === 0) {
    let fare: FareSeen | null = null;
    try {
      fare = await cheapestSeen([...ownAirports, ...groundAirports], homes, fromDay, toDay, 7);
    } catch {
      // the memory is optional
    }
    const one = fare && !fare.back ? fare : null;
    if (!one) return { ...base, days: emptyDays(), searched: 0, failed: 0, count: 0, source: "none", note: "no live search was made, and nothing is remembered for this window" };
    const d = doorOf(one.src, one.dst, Math.round(one.price));
    const flight: WayHomeFlight = { date: one.out, price: Math.round(one.price), direct: one.stops === 0, stops: one.stops, depart: "", arrive: "", carrier: one.carriers.join(", "), url: one.url, from: one.src, fromName: label(one.src), to: one.dst, toName: label(one.dst), hours: Math.round(one.hours * 10) / 10, ...(d.first ? { first: d.first } : {}), ...(d.last ? { last: d.last } : {}), doorToDoor: d.door, remembered: true };
    const days = emptyDays().map((x) => (x.date === one.out ? { ...x, cheapest: flight, ...(flight.direct ? { direct: flight } : {}) } : x));
    return { ...base, days, cheapest: flight, ...(flight.direct ? { bestDirect: flight } : {}), cheapestDoorToDoor: flight, searched: 0, failed: 0, count: 1, source: "memory", note: `a fare someone saw in the last week (${one.seenAt.slice(0, 10)}); times not known, check the link` };
  }

  const before = kiwiStats().today;
  const failures: string[] = [];
  let jobsRun = 0;
  const search = (flyFrom: string[], flyTo: string[]) => {
    jobsRun++;
    return searchFlight({ flyFrom: flyFrom.join(","), flyTo: flyTo.join(","), departureDate: kiwiDate(fromDay), departureDateTo: kiwiDate(toDay) }).then(
      (r) => r.itineraries,
      (err: unknown) => {
        failures.push(err instanceof Error ? err.message : String(err));
        return [] as KiwiItinerary[];
      },
    );
  };
  // Two searches at most here, the place's own airports first.
  const jobs = [ownAirports, groundAirports].filter((l) => l.length).slice(0, Math.max(1, maxSearches));
  const answers = await Promise.all(jobs.map((list) => search(list, homes)));
  const homeSet = new Set(homes);
  const seen = new Set<string>();
  const rows: WayHomeFlight[] = [];
  const addRows = (its: KiwiItinerary[]) => {
    for (const it of its) {
      const o = it.outbound;
      if (it.inbound || !(homeSet.has(o.to) || homeSet.has(CITY_OF_AIRPORT.get(o.to) ?? ""))) continue;
      if (q.direct && o.stops > 0) continue;
      const key = `${o.from}|${o.to}|${o.departureTime}|${Math.round(it.price)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const price = Math.round(it.price);
      const d = doorOf(o.from, o.to, price);
      rows.push({
        date: o.departureTime.slice(0, 10),
        depart: o.departureTime.slice(11, 16),
        arrive: o.arrivalTime.slice(11, 16),
        from: o.from,
        fromName: label(o.from),
        to: o.to,
        toName: label(o.to),
        price,
        direct: o.stops === 0,
        stops: o.stops,
        hours: Math.round((o.durationSeconds / 3600) * 10) / 10,
        carrier: [...new Set(o.segments.map((s) => s.carrierName || s.carrier))].join(", "),
        url: it.bookingUrl,
        ...(d.first ? { first: d.first } : {}),
        ...(d.last ? { last: d.last } : {}),
        doorToDoor: d.door,
      });
    }
  };
  addRows(answers.flat());
  // The same window again, one home airport at a time (the big airports first), where a nonstop shows among that
  // pair's cheapest: when a direct is asked for, none came back, or half the days or more are empty.
  const dayCount = daysBetween(fromDay, toDay) + 1;
  const emptyCount = () => {
    const days = new Set(rows.map((r) => r.date));
    let n = 0;
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) if (!days.has(d)) n++;
    return n;
  };
  const firstRefused = failures.length === jobs.length && failures.some(isRefusal);
  const wantNarrow = !firstRefused && (q.direct || !rows.some((r) => r.direct) || emptyCount() * 2 >= dayCount);
  const narrowFrom = ownAirports.length ? ownAirports : groundAirports;
  if (wantNarrow && narrowFrom.length && homes.length > 1) {
    const sizeRank = (c: string) => {
      const z = AIRPORT_BY_IATA.get(c)?.size;
      return z === "large" ? 0 : z === "medium" ? 1 : 2;
    };
    const targets = [...homes].sort((x, y) => sizeRank(x) - sizeRank(y)).slice(0, Math.min(q.direct ? 4 : 2, maxSearches - jobs.length));
    if (targets.length > 0) addRows((await Promise.all(targets.map((h) => search(narrowFrom, [h])))).flat());
  }
  const searched = Math.max(0, kiwiStats().today - before);
  rows.sort((x, y) => x.price - y.price || x.hours - y.hours);
  const allFailed = failures.length === jobsRun;
  if (allFailed && failures.some(isRefusal)) return { ...base, days: emptyDays(), searched, failed: failures.length, count: 0, source: "none", refused: true, note: "live prices are rate-limited right now; try again in a few minutes" };

  // An empty day is one where nothing was among the cheapest fares returned, never proof that nothing flies.
  const days: WayHomeDay[] = emptyDays().map((x) => {
    const day = rows.filter((r) => r.date === x.date);
    const direct = day.find((r) => r.direct);
    return { date: x.date, ...(day[0] ? { cheapest: day[0] } : {}), ...(direct ? { direct } : {}) };
  });
  const bestDirect = rows.find((r) => r.direct);
  const cheapest = rows[0];
  const cheapestDoor = [...rows].sort((x, y) => x.doorToDoor - y.doorToDoor)[0];
  const failedLine = failures.length ? `${failures.length} of ${jobsRun} searches failed; ` : "";
  const note = !rows.length
    ? `${failedLine}no ${q.direct ? "direct " : ""}flight from ${place.name} home between ${fromDay} and ${toDay} among the cheapest fares of ${jobsRun} search${jobsRun === 1 ? "" : "es"}, which is not proof there is none`
    : `each search returns the cheapest 15 fares of the window (${jobsRun} here), so a day with nothing had nothing among the cheapest, not nothing at all${!bestDirect ? "; no direct was among them, which is not proof there is none" : ""}${failures.length ? `; ${failedLine.slice(0, -2)}` : ""}`;
  return {
    ...base,
    days,
    ...(bestDirect ? { bestDirect } : {}),
    ...(cheapest ? { cheapest } : {}),
    ...(cheapestDoor ? { cheapestDoorToDoor: cheapestDoor } : {}),
    searched,
    failed: failures.length,
    count: rows.length,
    source: searched > 0 ? "live" : "memo",
    note,
  };
}

function distanceTo(place: { lat: number; lon: number }, code: string): number {
  const a = AIRPORT_BY_IATA.get(code);
  return a ? haversineKm(place.lat, place.lon, a.lat, a.lon) : Number.POSITIVE_INFINITY;
}

/**
 * The answer in the shape the chat's way_home tool has always returned (calendar, bestDirect
 * with its day and door-to-door, cheapestDoorToDoor, homeAirports with the ground leg in words),
 * so switching the tool to this module changes nothing the model or the chat cards read.
 */
export function wayHomeToolShape(r: WayHomeResult, hereName: string) {
  const short = (f: WayHomeFlight) => ({ from: f.from, to: f.to, depart: f.depart, arrive: f.arrive, price: f.price, ...(f.direct ? { direct: true } : { stops: f.stops }), hours: f.hours, carrier: f.carrier, url: f.url });
  const full = (f: WayHomeFlight | undefined) => (f ? { day: f.date, ...short(f), ...(f.first ? { first: f.first } : {}), ...(f.last ? { last: f.last } : {}), doorToDoor: f.doorToDoor, ...(f.remembered ? { remembered: true } : {}) } : null);
  return {
    searched: r.searched,
    source: r.source,
    from: r.from,
    ...(r.placeNote ? { placeNote: r.placeNote } : {}),
    window: `${r.window.from} to ${r.window.to}`,
    homeAirports: r.homeLegs.map((h) => ({ airport: h.airport, name: h.name, ...(h.how !== "not timed: no home point given" ? { toYou: h.km < 35 ? "a short drive" : `${h.how} to ${hereName}, about ${hoursText(h.minutes)}, about €${h.price} (estimate)` } : {}) })),
    count: r.count,
    searchedFrom: r.searchedFrom,
    bestDirect: full(r.bestDirect),
    cheapest: full(r.cheapest),
    ...(r.cheapestDoorToDoor && r.cheapestDoorToDoor !== r.cheapest ? { cheapestDoorToDoor: full(r.cheapestDoorToDoor) } : {}),
    calendar: r.days.map((d) => ({ day: d.date, cheapest: d.cheapest ? short(d.cheapest) : null, direct: d.direct ? short(d.direct) : null, ...(d.cheapest ? {} : { none: "not among the cheapest fares found" }) })),
    ...(r.note ? { note: r.note } : {}),
  };
}

/** The home airport nearest a point, its country, for a caller that knows the door but not the country. */
export function homeCountryOf(lat: number, lon: number): string | null {
  const g = nearestGateways(AIRPORTS, lat, lon, { maxKm: 400, limit: 1 })[0];
  return g?.airport.country ?? null;
}
