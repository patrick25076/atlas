// Server-only. The trip finder: open-jaw trips of two or three cities. Fly from any home gateway
// to an entry city, move between cities by train or coach (each leg under a limit), fly home
// from the last city to any gateway. Priced from cached fares, dates aligned to the trip length,
// ranked by value: countries and cities per euro and hour of travel.
import citiesJson from "@/public/data/cities.json";
import { flightMinutes, haversineKm } from "./geo";
import { reachFrom, type ReachResult } from "./ground";
import { allFares, hasToken } from "./travelpayouts";
import { countryAllowed } from "./been";
import { countryLabel } from "./board";
import { TtlLru } from "./memo";
import { findCityCode, resolveCountries } from "./wild";
import type { City, Fare } from "./types";

// Without a Travelpayouts token, the nightly Kiwi one-way file (scripts/ingest/oneway.ts) prices
// the trips. The placeholder file has no fares until the ingest has run.
import onewayJson from "@/public/data/oneway.json";
type OnewayFile = { updated: string; window: { from: string; to: string }; gateways: string[]; fares: Fare[] };
const ONEWAY = onewayJson as unknown as OnewayFile;
async function loadOneway(): Promise<OnewayFile | null> {
  return ONEWAY.fares.length ? ONEWAY : null;
}

const CITIES: Record<string, City> = citiesJson;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);

// Grid index over city centres for "which city is this station in".
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
  for (let dl = -1; dl <= 1; dl++) {
    for (let dn = -1; dn <= 1; dn++) {
      for (const code of grid.get(`${cl + dl},${co + dn}`) ?? []) {
        const c = CITIES[code];
        const km = haversineKm(lat, lon, c.lat, c.lon);
        if (km < bestKm) {
          bestKm = km;
          best = code;
        }
      }
    }
  }
  return best;
}

export type GatewayInput = { iata: string; lat: number; lon: number; driveMin: number };
export type TripParams = {
  gateways: GatewayInput[];
  /** Home country code: entry and exit cities must be abroad. */
  home: string;
  /** Nights away; fares are aligned to this ±1. */
  days: number;
  /** Optional YYYY-MM-DD: leave within three days before it (a holiday, a long weekend). */
  around?: string;
  /** Minutes a ground leg may take; up to twelve hours (an overnight train). */
  maxGroundMin: number;
  limit: number;
  /** ISO2 countries that never host a night (the Been list with "only new countries" on). A flight through one is fine. */
  exclude?: string[];
  /** A city (code or name) every trip must pass through: as the entry, a via or the exit. */
  mustInclude?: string;
  /** Only these countries (ISO2 or names) host a night; the home country is still excluded. */
  countries?: string[];
  /** Exactly this many cities per trip, 2 to 4; without it two or three, as before. */
  cities?: number;
};

/** What shaped the answer, so the panel and the chat can say which constraints applied. */
export type TripsApplied = {
  days: number;
  /** "2 or 3" by default, else the exact count asked for. */
  cities: string;
  maxGroundMin: number;
  /** The city code every trip passes through, when asked. */
  mustInclude?: string;
  /** The countries (ISO2) the trips keep to, when asked. */
  countries?: string[];
  exclude?: string[];
  /** Plain lines, one per constraint, for the UI. */
  lines: string[];
};

export type TripCity = { code: string; name: string; country: string; lat: number; lon: number };
export type TripLeg =
  | {
      kind: "fly";
      from: string;
      to: string;
      fromName: string;
      toName: string;
      date: string;
      price: number;
      url: string;
      minutes: number;
      airline?: string;
      transfers: number;
    }
  | {
      kind: "ground";
      from: string;
      to: string;
      fromName: string;
      toName: string;
      minutes: number;
      changes: number;
      mode: string;
      path: [number, number][];
    };
export type Trip = {
  id: string;
  cities: TripCity[];
  legs: TripLeg[];
  price: number;
  travelHours: number;
  nights: number;
  countries: number;
  value: number;
  outDate: string;
  backDate: string;
};
export type TripsResult = { status: "ok" | "no-token" | "error"; note?: string; trips: Trip[]; generatedAt: string; applied?: TripsApplied };

/** A request the engine cannot answer as asked (an unknown city or country); the route answers 400 with the message. */
export class TripsInputError extends Error {}

const AIRPORT_BUFFER_MIN = 120;
const ENTRY_CANDIDATES = 50;
const VIA_CANDIDATES = 12;
/** Four-city chains fan out one level more, so each level is narrower to keep the work bounded. */
const ENTRY_CANDIDATES_4 = 30;
const VIA_CANDIDATES_4 = 6;
const FARE_TRIES = 10;
/** Fares out tried per chain when the search is constrained and the chains are few. */
const FARE_TRIES_CONSTRAINED = 40;
/** The most minutes a ground leg may take: twelve hours, an overnight train. */
export const MAX_GROUND_MIN = 720;

type GroundLink = { minutes: number; changes: number; mode: string; station: number };
/** byId is built once, the first time a path through this reach is drawn, over its thousands of stations. */
type Reach = { result: ReachResult; links: Map<string, GroundLink>; byId?: Map<number, { lat: number; lon: number; prev: number }> };
/**
 * Reach results across requests, bounded: a twelve-hour reach from a hub touches thousands
 * of stations, and an unbounded map once grew the server by hundreds of megabytes in one
 * request. The cities walked repeat (the cheapest ones from the gateways), so a small memo
 * still answers most passes.
 */
const reachMemo = new TtlLru<Reach>(64, 30 * 60_000);
/**
 * Dijkstra passes one request may run over the 16,000-station graph: each is synchronous
 * and costs in proportion to the ground limit (about 80 ms at twelve hours, a few at two),
 * so a four-city chain at twelve hours could otherwise block the server for a quarter of a
 * minute. The budget shrinks with the limit (150 passes up to four hours, 50 at twelve) so a
 * request stays around four seconds of walking; past it a city is not walked further and the
 * trips found so far stand. The chains are walked cheapest entry first, so the cut falls on
 * the dearest ways out. Under the memo's size, so a repeat of the same request walks nothing.
 */
const MAX_REACH_PASSES = 150;
const passBudgetFor = (maxGroundMin: number) => Math.max(40, Math.min(MAX_REACH_PASSES, Math.round((MAX_REACH_PASSES * 240) / maxGroundMin)));
const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** One request's view of the reaches: its own map (never evicted mid-request) over the shared memo, and its pass budget. */
function reachWalker(maxGroundMin: number) {
  const local = new Map<string, Reach>();
  const budget = passBudgetFor(maxGroundMin);
  let passes = 0;
  /** Cities reachable from a city by train/coach within the limit, with the station used; null once the pass budget is spent. */
  return async function groundFrom(code: string): Promise<Reach | null> {
    const key = `${code}:${maxGroundMin}`;
    const mine = local.get(key);
    if (mine) return mine;
    const shared = reachMemo.get(key);
    if (shared) {
      local.set(key, shared);
      return shared;
    }
    if (passes >= budget) return null;
    passes++;
    // Let other requests in before each pass: the walk itself cannot be interrupted.
    await yieldNow();
    const c = CITIES[code];
    const result = reachFrom(c.lat, c.lon, maxGroundMin, 20);
    const links = new Map<string, GroundLink>();
    for (const s of result.reached) {
      const city = nearestCity(s.lat, s.lon);
      if (!city || city === code) continue;
      const prev = links.get(city);
      if (!prev || s.minutes < prev.minutes) links.set(city, { minutes: s.minutes, changes: s.changes, mode: s.mode, station: s.id });
    }
    const entry = { result, links };
    local.set(key, entry);
    reachMemo.set(key, entry);
    return entry;
  };
}

function pathTo(reach: Reach, stationId: number, from: City): [number, number][] {
  if (!reach.byId) {
    const byId = new Map<number, { lat: number; lon: number; prev: number }>();
    for (const s of reach.result.reached) byId.set(s.id, s);
    for (const s of reach.result.starts) byId.set(s.id, { lat: s.lat, lon: s.lon, prev: -1 });
    reach.byId = byId;
  }
  const byId = reach.byId;
  const pts: [number, number][] = [];
  let cur = stationId;
  for (let guard = 0; cur >= 0 && guard < 500; guard++) {
    const s = byId.get(cur);
    if (!s) break;
    pts.push([s.lon, s.lat]);
    cur = s.prev;
  }
  pts.push([from.lon, from.lat]);
  return pts.reverse();
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

function tripCity(code: string): TripCity {
  const c = CITIES[code];
  return { code, name: c.name, country: c.country, lat: c.lat, lon: c.lon };
}

export async function findTrips(params: TripParams): Promise<TripsResult> {
  const generatedAt = new Date().toISOString();
  const oneway = hasToken() ? null : await loadOneway();
  if (!hasToken() && !oneway) {
    return { status: "no-token", note: "Trips need fares: run pnpm ingest:oneway (Kiwi) or set TRAVELPAYOUTS_TOKEN (SETUP.md §2).", trips: [], generatedAt };
  }
  const { gateways, home, around, limit, exclude = [] } = params;
  // The bounds the engine holds whatever the caller sends: 2 to 21 nights, a ground leg of an hour to twelve.
  const days = Math.min(21, Math.max(2, Math.round(params.days) || 5));
  const maxGroundMin = Math.min(MAX_GROUND_MIN, Math.max(60, Math.round(params.maxGroundMin) || 300));
  // The traveller's constraints, names resolved to codes; an unknown one is a plain refusal.
  const must = params.mustInclude?.trim() ? findCityCode(params.mustInclude) : null;
  if (params.mustInclude?.trim() && !must) throw new TripsInputError(`unknown city to pass through: ${params.mustInclude.trim().slice(0, 40)} (a city name such as Krakow or a code such as KRK)`);
  const wanted = resolveCountries(params.countries);
  if (params.countries?.length && !wanted.codes.length) throw new TripsInputError(`none of those is a country we know: ${wanted.unknown.join(", ")} (a name such as Poland or a code such as PL)`);
  // A name we cannot read is refused, not dropped in silence, as /api/wild and /api/longstay do.
  if (wanted.unknown.length) throw new TripsInputError(`unknown country: ${wanted.unknown.join(", ")} (a name such as Poland or a code such as PL)`);
  const only = wanted.codes.length ? new Set(wanted.codes) : null;
  if (must && only && !only.has(CITIES[must].country)) only.add(CITIES[must].country);
  const exactCities = params.cities && Number.isFinite(params.cities) ? Math.min(4, Math.max(2, Math.round(params.cities))) : null;
  const lengths = exactCities ? [exactCities] : [2, 3];
  const maxLen = Math.max(...lengths);
  const applied: TripsApplied = {
    days,
    cities: exactCities ? String(exactCities) : "2 or 3",
    maxGroundMin,
    mustInclude: must ?? undefined,
    countries: only ? [...only] : undefined,
    exclude: exclude.length ? exclude : undefined,
    lines: [
      `${days} nights, give or take a day`,
      `${exactCities ? `${exactCities} cities` : "two or three cities"} a trip`,
      `ground legs up to ${Math.round((maxGroundMin / 60) * 10) / 10} h`,
      ...(must ? [`every trip passes through ${CITIES[must].name}`] : []),
      ...(only ? [`only ${[...only].map((cc) => countryLabel(cc)).join(", ")}`] : []),
      ...(exclude.length ? [`never a night in ${exclude.length} been countr${exclude.length === 1 ? "y" : "ies"}`] : []),
    ],
  };
  // Entry and exit cities must be abroad, in the countries asked for, and, when the traveller wants only new countries, unvisited.
  const usable = (city: string) => !!CITIES[city] && CITIES[city].country !== home && countryAllowed(CITIES[city].country, exclude) && (!only || only.has(CITIES[city].country));
  if (must && !usable(must)) throw new TripsInputError(`${CITIES[must].name} cannot host a night on this trip (home country, been list or outside the countries asked for)`);
  const faresFor = async (q: { origin?: string; destination?: string }): Promise<Fare[]> => {
    if (!oneway) return allFares(q);
    return oneway.fares.filter((f) => (q.origin ? f.src === q.origin : f.dst === q.destination));
  };
  const leavesAround = (date: string) => {
    if (!around) return true;
    const gap = daysBetween(around, date);
    return gap >= -3 && gap <= 1;
  };
  const gatewayByIata = new Map(gateways.map((g) => [g.iata, g]));

  // Fares out of and back into every gateway, grouped by the far city.
  const outByCity = new Map<string, (Fare & { gateway: GatewayInput })[]>();
  const inByCity = new Map<string, (Fare & { gateway: GatewayInput })[]>();
  await Promise.all(
    gateways.flatMap((g) => [
      faresFor({ origin: g.iata }).then((fares) => {
        for (const f of fares) {
          const city = cityOf.get(f.dst) ?? f.dst;
          if (!usable(city)) continue;
          const list = outByCity.get(city);
          if (list) list.push({ ...f, gateway: g });
          else outByCity.set(city, [{ ...f, gateway: g }]);
        }
      }),
      faresFor({ destination: g.iata }).then((fares) => {
        for (const f of fares) {
          const city = cityOf.get(f.src) ?? f.src;
          if (!usable(city)) continue;
          const list = inByCity.get(city);
          if (list) list.push({ ...f, gateway: g });
          else inByCity.set(city, [{ ...f, gateway: g }]);
        }
      }),
    ]),
  );
  for (const list of outByCity.values()) list.sort((a, b) => a.price - b.price);
  for (const list of inByCity.values()) list.sort((a, b) => a.price - b.price);

  const fareTries = only || must || exactCities ? FARE_TRIES_CONSTRAINED : FARE_TRIES;
  const entryCount = maxLen >= 4 ? ENTRY_CANDIDATES_4 : ENTRY_CANDIDATES;
  const viaCount = maxLen >= 4 ? VIA_CANDIDATES_4 : VIA_CANDIDATES;
  const entries = [...outByCity.entries()].sort((a, b) => a[1][0].price - b[1][0].price).slice(0, entryCount);
  // A must city with a fare out of a gateway is always an entry candidate, cheap or not.
  if (must && outByCity.has(must) && !entries.some(([a]) => a === must)) entries.push([must, outByCity.get(must)!]);

  const trips: Trip[] = [];
  const seen = new Set<string>();
  const groundFrom = reachWalker(maxGroundMin);
  /** The reach a ground leg was found in: walked in this request, so a hit; a straight line when it is somehow gone. */
  const pathOf = async (g: { from: string; to: string; link: GroundLink }): Promise<[number, number][]> => {
    const reach = await groundFrom(g.from);
    return reach ? pathTo(reach, g.link.station, CITIES[g.from]) : [[CITIES[g.from].lon, CITIES[g.from].lat], [CITIES[g.to].lon, CITIES[g.to].lat]];
  };
  // The ground links of every trip, so the station paths are drawn only for the trips returned:
  // drawing one for each of thousands of candidates was most of a request's time.
  const groundOf = new Map<string, { from: string; to: string; link: GroundLink }[]>();

  function evaluate(codes: string[], ground: { from: string; to: string; link: GroundLink }[]) {
    const first = codes[0];
    const last = codes[codes.length - 1];
    const outs = outByCity.get(first);
    const ins = inByCity.get(last);
    if (!outs || !ins) return;
    // A ground hop into an excluded country would still be a night there.
    if (exclude.length && !codes.every((c) => countryAllowed(CITIES[c].country, exclude))) return;
    const key = codes.join(">");
    if (seen.has(key)) return;

    // Cheapest aligned pair of dates: back = out + days, give or take a day. The fares are
    // sorted by price, so the first aligned fare home is the cheapest for that fare out. A
    // constrained search (countries, a must city, an exact count) has few chains, so it may
    // try more fares out before giving up on a pair; an open one keeps the old cap.
    let best: { out: (typeof outs)[number]; back: (typeof ins)[number]; nights: number } | null = null;
    const outCandidates = (around ? outs.filter((o) => leavesAround(o.departureAt)) : outs).slice(0, fareTries);
    for (const o of outCandidates) {
      for (const i of ins) {
        const nights = daysBetween(o.departureAt, i.departureAt);
        if (Math.abs(nights - days) > 1) continue;
        if (!best || o.price + i.price < best.out.price + best.back.price) best = { out: o, back: i, nights };
        break;
      }
    }
    if (!best) return;
    seen.add(key);

    const gOut = best.out.gateway;
    const gBack = best.back.gateway;
    const firstCity = CITIES[first];
    const lastCity = CITIES[last];
    const outMin = gOut.driveMin + AIRPORT_BUFFER_MIN + flightMinutes(haversineKm(gOut.lat, gOut.lon, firstCity.lat, firstCity.lon));
    const backMin = flightMinutes(haversineKm(lastCity.lat, lastCity.lon, gBack.lat, gBack.lon)) + AIRPORT_BUFFER_MIN + gBack.driveMin;
    const groundMin = ground.reduce((s, g) => s + g.link.minutes, 0);
    const travelHours = (outMin + groundMin + backMin) / 60;
    const price = best.out.price + best.back.price;
    const countries = new Set(codes.map((c) => CITIES[c].country)).size;
    const value = (countries + 0.5 * codes.length) / (price / 100 + travelHours / 4 + 1);

    const legs: TripLeg[] = [
      {
        kind: "fly",
        from: gOut.iata,
        to: first,
        fromName: gatewayByIata.get(gOut.iata)?.iata ?? gOut.iata,
        toName: firstCity.name,
        date: best.out.departureAt,
        price: best.out.price,
        url: best.out.url,
        minutes: outMin,
        airline: best.out.airline || undefined,
        transfers: best.out.transfers,
      },
      ...ground.map(
        (g): TripLeg => ({
          kind: "ground",
          from: g.from,
          to: g.to,
          fromName: CITIES[g.from].name,
          toName: CITIES[g.to].name,
          minutes: g.link.minutes,
          changes: g.link.changes,
          mode: g.link.mode,
          path: [],
        }),
      ),
      {
        kind: "fly",
        from: last,
        to: gBack.iata,
        fromName: lastCity.name,
        toName: gBack.iata,
        date: best.back.departureAt,
        price: best.back.price,
        url: best.back.url,
        minutes: backMin,
        airline: best.back.airline || undefined,
        transfers: best.back.transfers,
      },
    ];
    groundOf.set(key, ground);
    trips.push({
      id: key,
      cities: codes.map(tripCity),
      legs,
      price,
      travelHours: Math.round(travelHours * 10) / 10,
      nights: best.nights,
      countries,
      value: Math.round(value * 1000) / 1000,
      outDate: best.out.departureAt,
      backDate: best.back.departureAt,
    });
  }

  // Chains grow one ground hop at a time: A → B (fly home from B), A → M → B, A → M1 → M2 → B.
  // Every city hosts a night, so each must be usable; the last needs a fare home. Only the
  // nearest few vias by ground time are walked further (each walk is a Dijkstra pass), but
  // every link closes a trip when the next city would complete a length asked for: a city
  // that is the 13th nearest and has the cheapest fare home is still a two-city trip. A must
  // city still to visit is always walked when it is reachable.
  async function extend(chain: string[], ground: { from: string; to: string; link: GroundLink }[]) {
    const cur = chain[chain.length - 1];
    if (lengths.includes(chain.length) && inByCity.has(cur) && (!must || chain.includes(must))) evaluate(chain, ground);
    if (chain.length >= maxLen) return;
    const reach = await groundFrom(cur);
    if (!reach) return;
    const lastLevel = chain.length === maxLen - 1;
    const links = [...reach.links.entries()].filter(([c]) => usable(c) && !chain.includes(c)).sort((x, y) => x[1].minutes - y[1].minutes);
    const cands = lastLevel ? links : links.slice(0, viaCount);
    if (must && !chain.includes(must) && !cands.some(([c]) => c === must)) {
      const link = links.find(([c]) => c === must);
      if (link) cands.push(link);
    }
    for (const [next, link] of cands) {
      if (lastLevel && !inByCity.has(next)) continue;
      await extend([...chain, next], [...ground, { from: cur, to: next, link }]);
    }
    // The links beyond the fan-out close a trip without being walked further (no pass needed).
    if (!lastLevel && lengths.includes(chain.length + 1)) {
      const walked = new Set(cands.map(([c]) => c));
      for (const [next, link] of links) {
        if (walked.has(next) || !inByCity.has(next)) continue;
        const codes = [...chain, next];
        if (must && !codes.includes(must)) continue;
        evaluate(codes, [...ground, { from: cur, to: next, link }]);
      }
    }
  }
  for (const [a] of entries) await extend([a], []);

  trips.sort((x, y) => y.value - x.value);
  // The station paths, for the trips returned only.
  for (const t of trips.slice(0, limit)) {
    const ground = groundOf.get(t.id) ?? [];
    let gi = 0;
    for (const leg of t.legs) if (leg.kind === "ground") leg.path = await pathOf(ground[gi++]);
  }
  const note = trips.length ? undefined : must ? `No trip found through ${CITIES[must].name} with these constraints; try more nights, a longer ground leg or fewer cities.` : only ? "No trip found in those countries with these constraints; try a longer ground leg or other countries." : undefined;
  return { status: "ok", trips: trips.slice(0, limit), generatedAt, applied, ...(note ? { note } : {}) };
}
