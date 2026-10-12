// Server-only. The custom search on paired one-way tickets, for "a getaway from my airports in
// this period, there on that date, these many nights".
//
// Why not Kiwi's returns: a return search to "anywhere" answers with its 15 cheapest
// itineraries, and on 12 October 2026 all 15 for Brasov were split tickets (land in one city,
// fly home from another anywhere), so after the sense filter one deal was left. Returns to a
// country behave the same (13 of 15 split for Greece). One-way searches do not have that
// problem, and chained one-ways make better trips anyway. Three shapes come out:
//   - a stay: out to a city, home from that city;
//   - two cities by land: out to one, home from another the ground graph reaches in 3 to 4 hours;
//   - two cities by air: out to one, a one-way on to a second city, home from there.
// The way home may land at any airport of the home country the traveller can reach in six hours
// by train, coach or road. Every airport is scored with its real ground leg from the traveller,
// the traveller's own included, so one an hour farther than Otopeni costs that hour.
//
// Searches (everything through lib/kiwi.ts's gate, so repeats within a day are free):
//   1. out: the caller's jobs ("anywhere" and the nearest countries), over the out days only;
//   2. home per destination country (the best ten by their cheapest way out, fifteen when
//      exhaustive), FROM the airports the traveller lands at there plus those a short train
//      away, TO the home airports within reach. A country name on either side wastes Kiwi's 15
//      answers on airports nobody can use (measured: 6 of 15 for Germany to Romania);
//   3. home per landing city still without a stay after step 2 (citySearches of them), so a
//      big country cannot spend its 15 answers on one or two routes;
//   4. a one-way on from the cheapest few landing cities to anywhere during the stay (hopSources
//      of them), and one search home from the cities those reach that have no way home yet.
// About 13 + 10 + 4 + 4 = 31 for "anywhere"; the done line counts them.
import citiesJson from "@/public/data/cities.json";
import { airportCity, airportsWithin, cityAirports, countryAirports, countryLabel, gapFits, graphEnd, groundGap, landMinutes, resolveGateway, SPLIT_MAX_MIN, toDeal, type GroundGap } from "./board";
import { driveMinutes, formatDuration, haversineKm } from "./geo";
import { BUDGET_MESSAGE, kiwiDate, kiwiStats, searchFlight, THROTTLED_MESSAGE, type KiwiItinerary, type KiwiResult, type SearchArgs } from "./kiwi";
import type { City, Deal } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;

/** What a kilometre of train, coach or road costs when no fare is known (lib/route-finder.ts). */
export const EURO_PER_KM = 0.1;
/**
 * Euros per hour on the ground. Money first (the owner, 2026-10-12): an hour of train or coach
 * only breaks ties between prices and keeps a five-hour transfer from beating a fare a few
 * euros dearer.
 */
export const EURO_PER_HOUR = 2;
/** A home airport farther than this from the traveller by ground is not a way home. */
export const HOME_MAX_MIN = 360;
/** Trips shorter than this many nights allow less time between the two cities. */
export const SHORT_TRIP_NIGHTS = 5;
export const SHORT_TRIP_GAP_MIN = 180;
/**
 * Between landing and the next flight: out of the airport, across town, checked in again.
 * Kiwi's times are local, so this also absorbs a time-zone step of an hour or two.
 */
export const CONNECT_MS = 3 * 3_600_000;
/** Stays kept per landing city, on distinct out dates. */
const KEEP_PER_GROUP = 3;
/** Second cities kept per landing city: by land, and by air. One date each. */
const TWO_CITY_PER_CITY = 3;
const HOPS_PER_CITY = 3;
/** The whole answer, best first. */
const MAX_DEALS = 150;
/** The traveller's point reaches stations this far away, as route-finder's access does. */
const POINT_ACCESS_KM = 40;
/** Airports a home search flies from, and home airports it aims at, in one comma list each. */
const MAX_FROM_LIST = 8;
const MAX_HOME_LIST = 10;
/** Airports this close in a straight line are asked of the graph as a second city by land. */
const NEAR_KM = 350;
/** Cities reached by a hop whose way home is searched together, in one search. */
const HOP_HOME_CITIES = 8;
const CONCURRENCY = 5;

const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const maxDay = (a: string, b: string) => (a > b ? a : b);
const minDay = (a: string, b: string) => (a < b ? a : b);
const groundEuros = (km: number) => (km > 0 ? Math.max(3, Math.round(km * EURO_PER_KM)) : 0);
const yieldNow = () => new Promise<void>((r) => setImmediate(r));
const isRefusal = (err: unknown) => err instanceof Error && (err.message === THROTTLED_MESSAGE || err.message === BUDGET_MESSAGE);
/** Kiwi's local times read on one clock: both ends of a comparison are local, so only the zone step differs. */
const ms = (t: string) => Date.parse(t.slice(0, 19) + "Z");

/** The days a trip may leave and come back on, searched exactly (nothing is filtered after the fact for the must-include date). */
export type PairWindows = { outFrom: string; outTo: string; backFrom: string; backTo: string };

/**
 * With a must-include date the way out is on [max(from, include - maxNights), min(include,
 * to - minNights)] and the way back on [max(include, out + minNights), min(to, out +
 * maxNights)] for each out day; without one the way out is on [from, to - minNights]. The back
 * window searched is the union over the out days. Null when no trip fits.
 */
export function pairWindows(from: string, to: string, include: string | undefined, minNights: number, maxNights: number): PairWindows | null {
  const outFrom = include ? maxDay(from, addDays(include, -maxNights)) : from;
  const outTo = include ? minDay(include, addDays(to, -minNights)) : addDays(to, -minNights);
  if (outFrom > outTo) return null;
  const backFrom = include ? maxDay(include, addDays(outFrom, minNights)) : addDays(outFrom, minNights);
  const backTo = minDay(to, addDays(outTo, maxNights));
  if (backFrom > backTo) return null;
  return { outFrom, outTo, backFrom, backTo };
}

/** One out search: a label for progress lines, the origins (one or several) and the target. */
export type OutJob = { label: string; flyFrom: string; flyTo: string };

export type PairsParams = {
  /** The traveller's airports: the way out leaves from them, and the way home may land at them with no ground leg. */
  origins: string[];
  /** Other airports the traveller counts as theirs for the way home (the form's returnTo). */
  extraHomes: string[];
  /** ISO2 of the home country: the way home may land at any of its airports within HOME_MAX_MIN. */
  home: string;
  /** Where the traveller is, for the ground leg from a home airport that is not one of theirs. */
  point: { lat: number; lon: number };
  windows: PairWindows;
  include?: string;
  minNights: number;
  maxNights: number;
  outJobs: OutJob[];
  /** How many destination countries get a search for the way home. */
  homeSearches: number;
  /** How many landing cities still without a stay get a search home of their own. */
  citySearches: number;
  /** How many of the cheapest landing cities (one per country) get a one-way on to a second city by air. */
  hopSources: number;
  direct?: boolean;
  /** Hours per flight, door to door on the ticket. */
  maxHours?: number;
  /** Whether a flight may land in this country for the trip (home rule, been list, the named region). */
  keepLanding: (country: string) => boolean;
  onDeals?: (deals: Deal[], label: string) => void;
  say: (line: string) => void;
  /** The search to use: lib/kiwi.ts's gate unless a test passes its own. */
  search?: (args: SearchArgs) => Promise<KiwiResult>;
};

export type PairsResult = {
  deals: Deal[];
  /** Every one-way the out searches answered, for the hidden-city scan (no extra searches). */
  outRaw: KiwiItinerary[];
  searched: number;
  failed: number;
  outEdges: number;
  /** Searches that answered: home per country, home per city, and the hops with their way home. */
  homeSearches: number;
  citySearches: number;
  hopSearches: number;
  /** Searches after the way out that failed, and of those the ones the gate refused (Kiwi throttling or the daily budget). */
  homeFailed: number;
  homeRefused: number;
  /** Pairings that met every rule, before keeping the best few per city. */
  pairs: number;
  /** Deals of each shape besides a stay: a second city by land, a second city by air. */
  twoCity: number;
  hops: number;
  /** Deals whose way home lands at an airport that is not one of the traveller's. */
  otherHome: number;
  /** Searches that left this process during the run; other features' searches in the same process count too, so an upper bound. */
  sent: number;
  note?: string;
};

type OutEdge = { it: KiwiItinerary; from: string; land: string; landCity: string; country: string; date: string; arrive: number; arriveDay: string; price: number };
type HopEdge = { it: KiwiItinerary; from: string; fromCity: string; to: string; toCity: string; country: string; date: string; depart: number; arrive: number; arriveDay: string; price: number };
type BackEdge = { it: KiwiItinerary; leave: string; leaveCity: string; homeAirport: string; date: string; depart: number; price: number };
/**
 * The ground leg between the traveller and an airport: what the deal shows (nothing for the
 * traveller's own airports) and what the score charges (the real leg for every airport but the
 * ones the traveller counts as theirs with returnTo).
 */
type Access = { minutes: number; km: number; euros: number; scoreMin: number; scoreEuros: number };
type Kind = "stay" | "ground" | "hop";
type Cand = { kind: Kind; o: OutEdge; h?: HopEdge; b: BackEdge; nights: number; gap: GroundGap | null; access: Access; euros: number; score: number; group: string };

const countryOfAirport = (code: string) => resolveGateway(airportCity(code))?.country ?? resolveGateway(code)?.country ?? "";
const cityName = (code: string, fallback: string) => CITIES[code]?.name ?? fallback;

/** Minutes between two airports of one city: the graph's, or a drive where it has no trusted path (they are one city). */
function inCityMinutes(a: string, b: string): number {
  if (a === b) return 0;
  const g = groundGap(a, b);
  if (g && g.by !== "none") return g.minutes;
  const ea = graphEnd(a);
  const eb = graphEnd(b);
  return ea && eb ? driveMinutes(haversineKm(ea.lat, ea.lon, eb.lat, eb.lon)) : 60;
}

export async function findPairs(p: PairsParams): Promise<PairsResult> {
  const search = p.search ?? searchFlight;
  const sentAtStart = kiwiStats().today;
  const sent = () => Math.max(0, kiwiStats().today - sentAtStart);
  const w = p.windows;
  const origins = new Set(p.origins);
  const freeHomes = new Set([...p.origins, ...p.extraHomes]);
  const homeName = countryLabel(p.home);
  let searched = 0;
  let failed = 0;
  let homeFailed = 0;
  let homeRefused = 0;
  let homeDone = 0;
  let cityDone = 0;
  let hopDone = 0;
  let pairsFound = 0;
  const outRaw: KiwiItinerary[] = [];
  const fitsFlight = (it: KiwiItinerary) => (!p.direct || it.outbound.stops === 0) && (!p.maxHours || it.outbound.durationSeconds / 3600 <= p.maxHours);

  // ---- 1. The way out: one-ways from the traveller's airports over the out days only.
  const outs: OutEdge[] = [];
  const seenOut = new Set<string>();
  p.say(`Out: one-way tickets from ${p.origins.join(", ")} to ${p.outJobs.length > 1 ? `${p.outJobs[0].flyTo} and ${p.outJobs.length - 1} more` : (p.outJobs[0]?.flyTo ?? "anywhere")}, leaving ${w.outFrom} to ${w.outTo}…`);
  const outQueue = [...p.outJobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = outQueue.shift(); job; job = outQueue.shift()) {
        try {
          const r = await search({ flyFrom: job.flyFrom, flyTo: job.flyTo, departureDate: kiwiDate(w.outFrom), departureDateTo: kiwiDate(w.outTo) });
          searched++;
          for (const it of r.itineraries) {
            if (it.inbound) continue;
            outRaw.push(it);
            const date = it.outbound.departureTime.slice(0, 10);
            const id = `${it.outbound.from}|${it.outbound.to}|${it.outbound.departureTime}`;
            if (seenOut.has(id) || date < w.outFrom || date > w.outTo || !fitsFlight(it)) continue;
            const land = it.outbound.to;
            const country = countryOfAirport(land);
            if (!country || !p.keepLanding(country)) continue;
            seenOut.add(id);
            outs.push({ it, from: it.outbound.from, land, landCity: airportCity(land), country, date, arrive: ms(it.outbound.arrivalTime), arriveDay: it.outbound.arrivalTime.slice(0, 10), price: it.price });
          }
        } catch {
          failed++;
        }
      }
    }),
  );
  outs.sort((a, b) => a.price - b.price);
  if (!outs.length) {
    return { deals: [], outRaw, searched, failed, outEdges: 0, homeSearches: 0, citySearches: 0, hopSearches: 0, homeFailed: 0, homeRefused: 0, pairs: 0, twoCity: 0, hops: 0, otherHome: 0, sent: sent(), note: failed ? undefined : "No one-way flights out fit those days." };
  }

  // ---- 2. Where home may land, and what the ground leg from there costs.
  // Every ground leg is timed from the traveller's point on the graph (one walk, memoised), or
  // by road where the feeds have nothing near either end. The score charges every airport its
  // real leg, the traveller's own included: from Brasov, Otopeni costs its 153 minutes and Targu
  // Mures its 218, so Targu Mures is 65 minutes worse, not 218 (when own airports counted as
  // zero, no other airport of the country ever won). The way out is charged the same way, so a
  // flight from Ghimbav beats the same fare from Otopeni. Only the airports the traveller marks
  // as theirs (returnTo) are free, and the deal shows a leg only for airports not their own.
  const pointEnd = { key: `pt:${p.point.lat.toFixed(3)},${p.point.lon.toFixed(3)}`, lat: p.point.lat, lon: p.point.lon };
  type Raw = { minutes: number; km: number; euros: number };
  const rawMemo = new Map<string, Raw | null>();
  const rawOf = (code: string): Raw | null => {
    if (rawMemo.has(code)) return rawMemo.get(code)!;
    const end = graphEnd(code);
    let raw: Raw | null = null;
    if (end) {
      const km = haversineKm(p.point.lat, p.point.lon, end.lat, end.lon);
      const minutes = landMinutes(pointEnd, end, countryOfAirport(code) === p.home, POINT_ACCESS_KM);
      if (minutes != null) raw = { minutes, km, euros: groundEuros(km) };
    }
    rawMemo.set(code, raw);
    return raw;
  };
  const extraHomes = new Set(p.extraHomes.filter((c) => !origins.has(c)));
  const accessMemo = new Map<string, Access | null>();
  const accessOf = (code: string): Access | null => {
    if (extraHomes.has(code)) return { minutes: 0, km: 0, euros: 0, scoreMin: 0, scoreEuros: 0 };
    if (accessMemo.has(code)) return accessMemo.get(code)!;
    let a: Access | null;
    if (origins.has(code)) {
      // The traveller's own airport: always a way home, no leg shown, its real leg scored.
      const raw = rawOf(code);
      a = { minutes: 0, km: 0, euros: 0, scoreMin: raw?.minutes ?? 0, scoreEuros: raw?.euros ?? 0 };
    } else {
      const raw = countryOfAirport(code) === p.home ? rawOf(code) : null;
      a = raw && raw.minutes <= HOME_MAX_MIN ? { ...raw, scoreMin: raw.minutes, scoreEuros: raw.euros } : null;
    }
    accessMemo.set(code, a);
    return a;
  };
  // The home airports every search aims at: the traveller's own first, then the others in reach, nearest first.
  const homeTargets = [
    ...freeHomes,
    ...countryAirports(p.home)
      .filter((c) => !freeHomes.has(c) && accessOf(c))
      .sort((a, b) => accessOf(a)!.minutes - accessOf(b)!.minutes),
  ].slice(0, MAX_HOME_LIST);
  const homeTo = homeTargets.join(",");

  // ---- 3. Pairing state: the best candidate per (shape, landing city, second city, out date).
  const best = new Map<string, Cand>();
  const emitted = new Set<Cand>();
  const backs: BackEdge[] = [];
  const seenBack = new Set<string>();
  const byLand = new Map<string, OutEdge[]>();
  for (const o of outs) {
    const list = byLand.get(o.land);
    if (list) list.push(o);
    else byLand.set(o.land, [o]);
  }
  /** Nights from the day the traveller lands to the flight home, inside the length asked for, with the must-include date inside the trip. */
  const tripFits = (arriveDay: string, backDay: string): number | null => {
    const nights = daysBetween(arriveDay, backDay);
    if (nights < p.minNights || nights > p.maxNights) return null;
    if (p.include && (arriveDay > p.include || backDay < p.include)) return null;
    return nights;
  };
  const offer = (c: Omit<Cand, "score" | "group">, groundMin: number, scoreEuros: number, second: string) => {
    pairsFound++;
    const score = c.o.price + (c.h?.price ?? 0) + c.b.price + scoreEuros + (groundMin / 60) * EURO_PER_HOUR;
    const group = `${c.kind}|${c.o.landCity}|${second}`;
    const key = `${group}|${c.o.date}`;
    const prev = best.get(key);
    if (!prev || score < prev.score) best.set(key, { ...c, score, group });
  };

  /** The one-ways home in a search's answer: home airports in reach only, each flight once. */
  function readBacks(r: KiwiResult): BackEdge[] {
    const fresh: BackEdge[] = [];
    for (const it of r.itineraries) {
      if (it.inbound || !fitsFlight(it)) continue;
      const date = it.outbound.departureTime.slice(0, 10);
      if (date < w.backFrom || date > w.backTo) continue;
      const homeAirport = it.outbound.to;
      if (!accessOf(homeAirport)) continue;
      const id = `${it.outbound.from}|${homeAirport}|${it.outbound.departureTime}`;
      if (seenBack.has(id)) continue;
      seenBack.add(id);
      const b: BackEdge = { it, leave: it.outbound.from, leaveCity: airportCity(it.outbound.from), homeAirport, date, depart: ms(it.outbound.departureTime), price: it.price };
      fresh.push(b);
      backs.push(b);
    }
    return fresh;
  }

  /** New ways home against every way out: a stay when they share a city, two cities when the graph joins them. */
  async function pairUp(fresh: BackEdge[]): Promise<void> {
    for (const [land, os] of byLand) {
      const landCity = os[0].landCity;
      for (const b of fresh) {
        const sameCity = b.leaveCity === landCity;
        let gap: GroundGap | null = null;
        if (b.leave !== land) {
          // Timed on the graph between the two airports, memoised per pair; a far one is
          // refused on the straight line before any graph work.
          gap = groundGap(land, b.leave);
          if (!gap) continue;
          if (sameCity && gap.by === "none") gap = { ...gap, minutes: inCityMinutes(land, b.leave), by: "road" };
          if (!sameCity && !gapFits(gap, SPLIT_MAX_MIN)) continue;
        }
        const access = accessOf(b.homeAirport);
        if (!access) continue;
        const gapMin = gap?.minutes ?? 0;
        for (const o of os) {
          // The flight home must leave after the flight out lands, plus the trip between and a
          // margin; nights count from the day the traveller lands, not the day they leave.
          if (b.depart < o.arrive + gapMin * 60_000 + CONNECT_MS) continue;
          const nights = tripFits(o.arriveDay, b.date);
          if (nights == null) continue;
          if (!sameCity && gap && !gapFits(gap, nights < SHORT_TRIP_NIGHTS ? SHORT_TRIP_GAP_MIN : SPLIT_MAX_MIN)) continue;
          const gapEuros = gap && !sameCity ? groundEuros(gap.km) : 0;
          const start = accessOf(o.from);
          offer({ kind: sameCity ? "stay" : "ground", o, b, nights, gap, access, euros: gapEuros + access.euros }, gapMin + access.scoreMin + (start?.scoreMin ?? 0), gapEuros + access.scoreEuros + (start?.scoreEuros ?? 0), sameCity ? "" : b.leaveCity);
        }
      }
      // One graph walk per landing airport at most: let the stream breathe between them.
      await yieldNow();
    }
  }

  /** Out, a one-way on to a second city, home from that city: at least a night in each. */
  function pairHops(hops: HopEdge[]): void {
    const backsByCity = new Map<string, BackEdge[]>();
    for (const b of backs) {
      const list = backsByCity.get(b.leaveCity);
      if (list) list.push(b);
      else backsByCity.set(b.leaveCity, [b]);
    }
    for (const h of hops) {
      const homes = backsByCity.get(h.toCity);
      if (!homes?.length) continue;
      for (const o of outs) {
        if (o.landCity !== h.fromCity) continue;
        const firstMin = inCityMinutes(o.land, h.from);
        if (h.depart < o.arrive + firstMin * 60_000 + CONNECT_MS || daysBetween(o.arriveDay, h.date) < 1) continue;
        for (const b of homes) {
          const secondMin = inCityMinutes(h.to, b.leave);
          if (b.depart < h.arrive + secondMin * 60_000 + CONNECT_MS || daysBetween(h.arriveDay, b.date) < 1) continue;
          const nights = tripFits(o.arriveDay, b.date);
          if (nights == null) continue;
          const access = accessOf(b.homeAirport);
          if (!access) continue;
          const start = accessOf(o.from);
          offer({ kind: "hop", o, h, b, nights, gap: null, access, euros: access.euros }, firstMin + secondMin + access.scoreMin + (start?.scoreMin ?? 0), access.scoreEuros + (start?.scoreEuros ?? 0), h.toCity);
        }
      }
    }
  }

  /**
   * The best few: three stays per landing city on distinct out dates, and beside them (never
   * instead of them) up to three second cities by land and three by air per landing city, one
   * date each. A two-city trip is its own option even when staying put is cheaper.
   */
  function kept(): Cand[] {
    const all = [...best.values()].sort((a, b) => a.score - b.score);
    const perGroup = new Map<string, number>();
    const seconds = new Map<string, Set<string>>();
    const out: Cand[] = [];
    for (const c of all) {
      const n = perGroup.get(c.group) ?? 0;
      if (n >= (c.kind === "stay" ? KEEP_PER_GROUP : 1)) continue;
      if (c.kind !== "stay") {
        const k = `${c.kind}|${c.o.landCity}`;
        const set = seconds.get(k) ?? new Set<string>();
        if (!set.has(c.group) && set.size >= (c.kind === "ground" ? TWO_CITY_PER_CITY : HOPS_PER_CITY)) continue;
        set.add(c.group);
        seconds.set(k, set);
      }
      perGroup.set(c.group, n + 1);
      out.push(c);
      if (out.length >= MAX_DEALS) break;
    }
    return out;
  }
  /** Streams the candidates that are in the best few now and were not sent before. */
  const stream = (label: string) => {
    const fresh = kept().filter((c) => !emitted.has(c));
    for (const c of fresh) emitted.add(c);
    if (fresh.length) p.onDeals?.(fresh.map(toPairDeal), label);
  };

  // The airports around a landing airport the graph reaches within four hours: the second
  // cities by land, and more places the way home may leave from.
  const nearMemo = new Map<string, string[]>();
  const nearOf = (land: string): string[] => {
    const hit = nearMemo.get(land);
    if (hit) return hit;
    const end = graphEnd(land);
    const city = airportCity(land);
    const near = end
      ? airportsWithin(end.lat, end.lon, NEAR_KM)
          .filter((a) => airportCity(a.code) !== city)
          .map((a) => ({ code: a.code, gap: groundGap(land, a.code) }))
          .filter((a): a is { code: string; gap: GroundGap } => !!a.gap && gapFits(a.gap, SPLIT_MAX_MIN))
          .sort((a, b) => a.gap.minutes - b.gap.minutes)
          .map((a) => a.code)
      : [];
    nearMemo.set(land, near);
    return near;
  };
  /** The airports a home search flies from: where the traveller lands, the other airports of those cities, then the nearest second cities. */
  const fromList = (lands: string[]): string[] => {
    const list: string[] = [];
    const add = (c: string) => {
      if (list.length < MAX_FROM_LIST && !list.includes(c)) list.push(c);
    };
    for (const l of lands) add(l);
    for (const l of lands) for (const c of cityAirports(l)) add(c);
    for (const l of lands.slice(0, 3)) for (const c of nearOf(l).slice(0, 3)) add(c);
    return list;
  };

  type HomeJob = { label: string; flyFrom: string[]; kind: "country" | "city" | "hop" };
  async function runHome(jobs: HomeJob[]): Promise<void> {
    const queue = [...jobs];
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) {
          let r: KiwiResult;
          try {
            r = await search({ flyFrom: job.flyFrom.join(","), flyTo: homeTo, departureDate: kiwiDate(w.backFrom), departureDateTo: kiwiDate(w.backTo) });
            searched++;
            if (job.kind === "country") homeDone++;
            else if (job.kind === "city") cityDone++;
            else hopDone++;
          } catch (err) {
            failed++;
            homeFailed++;
            if (isRefusal(err)) homeRefused++;
            continue;
          }
          const fresh = readBacks(r);
          if (fresh.length) {
            await pairUp(fresh);
            stream(job.label);
          }
          p.say(`${job.label} (${job.flyFrom.join(",")}): ${fresh.length} one-ways to ${homeName}; ${best.size} trips paired so far…`);
        }
      }),
    );
  }

  // ---- 4. Home per destination country, from the airports landed at there and around them.
  const landsByCountry = new Map<string, string[]>();
  for (const o of outs) {
    const list = landsByCountry.get(o.country) ?? [];
    if (!list.includes(o.land)) list.push(o.land);
    landsByCountry.set(o.country, list);
  }
  // outs is cheapest first, so the countries come in the order of their cheapest way out.
  const homeCountries = [...landsByCountry.keys()].filter((cc) => cc !== p.home).slice(0, p.homeSearches);
  const cityCount = new Set(outs.map((o) => o.landCity)).size;
  const names = homeCountries.map(countryLabel);
  p.say(`Out: ${outs.length} cheap one-ways to ${cityCount} cities. Home: from ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""} to ${homeTargets.join(", ")}, ${w.backFrom} to ${w.backTo}…`);
  const countryJobs: HomeJob[] = [];
  for (const cc of homeCountries) {
    countryJobs.push({ label: `Home from ${countryLabel(cc)}`, flyFrom: fromList(landsByCountry.get(cc)!), kind: "country" });
    await yieldNow();
  }
  await runHome(countryJobs);

  // ---- 5. Home per landing city that still has no stay, cheapest way out first.
  const covered = new Set([...best.values()].filter((c) => c.kind === "stay").map((c) => c.o.landCity));
  const openCities: { city: string; lands: string[] }[] = [];
  for (const o of outs) {
    if (o.country === p.home || covered.has(o.landCity)) continue;
    const entry = openCities.find((x) => x.city === o.landCity);
    if (entry) {
      if (!entry.lands.includes(o.land)) entry.lands.push(o.land);
    } else openCities.push({ city: o.landCity, lands: [o.land] });
  }
  // A city search flies from that city's own airports only, so all 15 answers are about it;
  // one that would repeat a country search exactly (a country with one landing city) is skipped.
  const asked = new Set(countryJobs.map((j) => j.flyFrom.join(",")));
  const cityJobs: HomeJob[] = [];
  for (const c of openCities) {
    if (cityJobs.length >= p.citySearches) break;
    const flyFrom = [...new Set([...c.lands, ...c.lands.flatMap(cityAirports)])].slice(0, MAX_FROM_LIST);
    if (asked.has(flyFrom.join(","))) continue;
    asked.add(flyFrom.join(","));
    cityJobs.push({ label: `Home from ${cityName(c.city, c.city)}`, flyFrom, kind: "city" });
  }
  if (cityJobs.length) {
    p.say(`No way home yet from ${cityJobs.map((j) => j.label.replace("Home from ", "")).join(", ")}: one search each…`);
    await runHome(cityJobs);
  }

  // ---- 6. Two cities by air: from the cheapest landing cities (one per country), a one-way on
  // to anywhere during the stay, then home from wherever that lands.
  const hopFrom = addDays(w.outFrom, 1);
  const hopTo = addDays(w.backTo, -1);
  const hops: HopEdge[] = [];
  if (p.hopSources > 0 && p.maxNights >= 2 && hopFrom <= hopTo) {
    const sources: { city: string; lands: string[] }[] = [];
    const seenCountry = new Set<string>();
    for (const o of outs) {
      if (sources.length >= p.hopSources) break;
      if (o.country === p.home || seenCountry.has(o.country)) continue;
      seenCountry.add(o.country);
      sources.push({ city: o.landCity, lands: [...new Set([o.land, ...cityAirports(o.land)])].slice(0, 4) });
    }
    p.say(`Two cities by air: one-ways on from ${sources.map((s) => cityName(s.city, s.city)).join(", ")}, ${hopFrom} to ${hopTo}…`);
    const seenHop = new Set<string>();
    await Promise.all(
      sources.map(async (s) => {
        try {
          const r = await search({ flyFrom: s.lands.join(","), flyTo: "anywhere", departureDate: kiwiDate(hopFrom), departureDateTo: kiwiDate(hopTo) });
          searched++;
          hopDone++;
          for (const it of r.itineraries) {
            if (it.inbound || !fitsFlight(it)) continue;
            const to = it.outbound.to;
            const toCity = airportCity(to);
            const country = countryOfAirport(to);
            const id = `${it.outbound.from}|${to}|${it.outbound.departureTime}`;
            if (seenHop.has(id) || toCity === s.city || !country || country === p.home || !p.keepLanding(country)) continue;
            seenHop.add(id);
            hops.push({ it, from: it.outbound.from, fromCity: s.city, to, toCity, country, date: it.outbound.departureTime.slice(0, 10), depart: ms(it.outbound.departureTime), arrive: ms(it.outbound.arrivalTime), arriveDay: it.outbound.arrivalTime.slice(0, 10), price: it.price });
          }
        } catch (err) {
          failed++;
          homeFailed++;
          if (isRefusal(err)) homeRefused++;
        }
      }),
    );
    // The hop cities with no way home yet, cheapest hop first, share one search home.
    const homeCities = new Set(backs.map((b) => b.leaveCity));
    const open: string[] = [];
    for (const h of [...hops].sort((a, b) => a.price - b.price)) {
      if (open.length >= HOP_HOME_CITIES) break;
      if (homeCities.has(h.toCity) || open.some((c) => airportCity(c) === h.toCity)) continue;
      open.push(h.to);
    }
    if (open.length) await runHome([{ label: `Home from ${open.length === 1 ? "the city" : `${open.length} cities`} a hop away`, flyFrom: open, kind: "hop" }]);
    pairHops(hops);
    stream("two cities by air");
  }

  const finalCands = kept();
  const final = finalCands.map(toPairDeal);
  const note =
    homeFailed > 0
      ? homeRefused > 0
        ? `${homeFailed} of the searches for the way home could not be made (live prices are rate-limited right now); try again in a few minutes for more.`
        : `${homeFailed} of the searches for the way home failed, so some ways home are missing; try again in a few minutes for more.`
      : !final.length
        ? `No way home from ${names.join(", ") || "those places"} fits ${p.minNights} to ${p.maxNights} nights${p.include ? ` around ${p.include}` : ""}.`
        : undefined;
  return {
    deals: final,
    outRaw,
    searched,
    failed,
    outEdges: outs.length,
    homeSearches: homeDone,
    citySearches: cityDone,
    hopSearches: hopDone,
    homeFailed,
    homeRefused,
    pairs: pairsFound,
    twoCity: finalCands.filter((c) => c.kind === "ground").length,
    hops: finalCands.filter((c) => c.kind === "hop").length,
    otherHome: finalCands.filter((c) => !origins.has(c.b.homeAirport)).length,
    sent: sent(),
    note,
  };

  /** One candidate as a Deal: the way out's fields, the flights added, the way home and the ground legs alongside. */
  function toPairDeal(c: Cand): Deal {
    const d = toDeal(c.o.from, c.o.it, c.nights);
    const back = c.b.it.outbound;
    const legs = [c.o.it.outbound, ...(c.h ? [c.h.it.outbound] : []), back];
    d.price = Math.round(c.o.price + (c.h?.price ?? 0) + c.b.price);
    d.back = c.b.date;
    d.nights = c.nights;
    d.stops = Math.max(...legs.map((l) => l.stops));
    d.carriers = [...new Set(legs.flatMap((l) => l.segments).map((s) => s.carrierName || s.carrier))];
    d.backMin = Math.round(back.durationSeconds / 60);
    d.url2 = c.b.it.bookingUrl;
    if (c.b.homeAirport !== c.o.from) d.backTo = c.b.homeAirport;
    const city = d.city;
    let note: string;
    if (c.h) {
      // backFromCity names the second city, so the cards already read "Rome → Barcelona, two cities".
      const hopCity = cityName(c.h.toCity, c.h.it.outbound.segments.at(-1)?.toCity || c.h.to);
      const first = daysBetween(c.o.arriveDay, c.h.date);
      d.hop = { from: c.h.from, to: c.h.to, city: hopCity, country: c.h.country, date: c.h.date, nights: first, price: Math.round(c.h.price), min: Math.round(c.h.it.outbound.durationSeconds / 60), stops: c.h.it.outbound.stops, url: c.h.it.bookingUrl };
      d.backFromCity = hopCity;
      if (c.b.leave !== c.h.to) d.backFrom = c.b.leave;
      const second = c.nights - first;
      note = `${city} for ${first} night${first === 1 ? "" : "s"}, then fly to ${hopCity} for ${second} night${second === 1 ? "" : "s"}; three one-way tickets`;
    } else if (c.b.leave !== c.o.land) {
      // backFrom alone is another airport of the same city; with backFromCity it is a second city.
      d.backFrom = c.b.leave;
      if (c.kind === "ground") d.backFromCity = cityName(c.b.leaveCity, back.segments[0]?.fromCity || c.b.leave);
      if (c.gap && c.gap.by !== "none") {
        d.gapMin = c.gap.minutes;
        d.gapKm = Math.round(c.gap.km);
      }
      note =
        c.kind === "ground" && c.gap
          ? `In to ${city}, home from ${d.backFromCity}: about ${formatDuration(c.gap.minutes)} between them by ${c.gap.by === "graph" ? "train, coach or ferry" : "road"}`
          : `${city}, there and back (home from another airport of the city)`;
    } else {
      note = `${city}, there and back`;
    }
    if (c.access.minutes > 0) {
      d.homeGapMin = c.access.minutes;
      note += `; home lands at ${c.b.homeAirport}, about ${formatDuration(c.access.minutes)} from you by train, coach or road`;
    }
    d.pairNote = note;
    if (c.euros > 0) d.groundPrice = c.euros;
    d.pair = true;
    return d;
  }
}
