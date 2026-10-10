// Server-only. Long stays: living somewhere for one to six months. Candidate bases are the
// cities of a region (or a country list) that are well known, cheap to live in, safe, and
// have a proper airport; the eight best by worth-for-money get a flight in and a flight out
// priced live, a monthly living and rent estimate from World Bank price levels, side trips
// from the ground graph, the climate normals and the visa rule. Ranked by what a day there
// costs all in.
//
// Dates are honest: the flight in is searched over the month asked for (one Kiwi one-way
// search), the flight out over a three-week window anchored to the day that flight lands plus
// the months asked (one more search), and rent and living are counted for the days between
// the two, not for a nominal "two months". Bound: two searches a base, eight bases, so sixteen
// live searches, plus one retry each at the most.
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import costsJson from "@/public/data/costs.json";
import fameJson from "@/public/data/fame.json";
import airportsJson from "@/public/data/airports.json";
import weatherJson from "@/public/data/weather.json";
import visaJson from "@/public/data/visa.json";
import { countryAllowed } from "./been";
import { countryLabel, hubDegree } from "./board";
import { bestMonths, climateFor } from "./climate";
import { neighboursOf } from "./combos";
import { kiwiDate, searchFlight } from "./kiwi";
import { TtlLru } from "./memo";
import { BUDGET_SCALE, perDayFor, REGIONS, type Budget } from "./wild";
import { visaFor, type Airport, type City, type CountryInfo, type VisaFile } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const COSTS = costsJson as unknown as Record<string, number>;
const FAME = fameJson as unknown as Record<string, [number, number, number]>;
const VISA = visaJson as unknown as VisaFile;
const AIRPORTS = airportsJson as unknown as Airport[];
const sizeOf = new Map(AIRPORTS.map((a) => [a.iata, a.size]));
const COASTAL = new Set(Object.keys((weatherJson as { sea?: Record<string, number> }).sea ?? {}));

export type LongStayBase = {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  /** The months asked for; `days` is what the flights found actually span. */
  months: number;
  /** Days between the flight in and the flight out (months x 30 when a flight is missing). */
  days?: number;
  flightIn: { price: number; date: string; url: string; from: string } | null;
  flightOut: { price: number; date: string; url: string; to: string } | null;
  monthlyLiving: number;
  rent: number;
  /** Kiwi photo id of the base city (images.kiwi.com/photos/600x600/{img}.jpg), from the flight in; absent when no flight was found. */
  img?: string;
  /** Flights plus (days / 30) months of living and rent. */
  total: number;
  perDay: number;
  why: string[];
  sideTrips: { name: string; code: string; minutes: number; mode: string }[];
  visa?: string | null;
  /** Twelve monthly normals: tmax in C, rain in mm per day (not per month). */
  climate?: { tmax: number[]; rain: number[] };
  /** True when a flight search for this base was refused (Kiwi), so a missing flight is unknown, not absent. */
  failed?: true;
};

export type LongStayParams = {
  gateways: string[];
  /** Passport country (ISO2). */
  home: string;
  region?: string;
  countries?: string[];
  months: number;
  /** YYYY-MM of arrival; default the month after next. */
  startMonth?: string;
  budget?: Budget;
  style?: string;
  origin?: { lat: number; lon: number; label: string };
  /** "Been" (ISO2): these countries drop out of the candidate bases before any search. */
  exclude?: string[];
};
export type LongStayResult = {
  bases: LongStayBase[];
  searched: number;
  /** Searches Kiwi refused after a retry. */
  failed: number;
  /** True when a search failed, so a base may lack a flight it would otherwise have. */
  partial?: true;
  /** Countries of the region left out, and why, so the chat can say so. */
  skipped: { country: string; reason: string }[];
  generatedAt: string;
  note: string;
};

/** A request the engine cannot answer as asked (an unknown region); the route may answer 400 with the message. */
export class LongStayInputError extends Error {}

const BASES = 8;
const MIN_VIEWS = 100_000;
/** With an explicit country list the traveller chose the place; fame only has to be real. */
const MIN_VIEWS_EXPLICIT = 20_000;
const MAX_RATIO = 0.95;
const CONCURRENCY = 4;
/** The flight out window around arrival + months x 30 days: a week early to two weeks late. */
const OUT_BEFORE = 7;
const OUT_AFTER = 14;
const memo = new TtlLru<LongStayResult>(100, 60 * 60_000);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;
const hasRealAirport = (c: City) => c.airports.some((a) => sizeOf.get(a) === "large" || sizeOf.get(a) === "medium");
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD from a Kiwi timestamp; anything else is parsed and reformatted, never passed through. */
const isoOf = (t: string) => {
  const s = t.slice(0, 10);
  if (ISO_DAY.test(s)) return s;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
};
const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}`;

/** `img` is the destination photo id Kiwi attaches to an itinerary: free, so the base card has a picture. */
type Fare = { cheapest: number; out: string; url: string; from: string; to: string; img?: string };
type OneWay = { fare: Fare | null; searched: number; failed: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The cheapest one-way leaving in [from, to]: one Kiwi search, one retry; failed when both are refused. */
async function oneWayIn(flyFrom: string, flyTo: string, from: string, to: string): Promise<OneWay> {
  if (from > to) return { fare: null, searched: 0, failed: 0 };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await searchFlight({ flyFrom, flyTo, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to) });
      const it = r.itineraries
        .filter((x) => !x.inbound && isoOf(x.outbound.departureTime))
        .sort((a, b) => a.price - b.price)[0];
      return { fare: it ? { cheapest: Math.round(it.price), out: isoOf(it.outbound.departureTime), url: it.bookingUrl, from: it.outbound.from, to: it.outbound.to, img: it.imageId || undefined } : null, searched: 1, failed: 0 };
    } catch {
      if (attempt === 0) await sleep(1500);
    }
  }
  return { fare: null, searched: 0, failed: 1 };
}

/** Rent for a month, mid-range one-bedroom, scaled by the country's price level: an estimate. */
export function rentFor(cc: string, budget: Budget = "mid"): number {
  const ratio = Math.min(1.6, Math.max(0.25, COSTS[cc] ?? 0.7));
  return Math.round(650 * Math.pow(ratio, 0.9) * BUDGET_SCALE[budget]);
}

/** Worth minus cost: fame and guide listings earn points, the price level takes them away. */
function score(code: string, c: City, style: string): number {
  const [views, see, doo] = FAME[code] ?? [0, 0, 0];
  const fame = views > 0 ? Math.min(90, 22 * Math.log10(Math.max(1, views / 8000))) : 0;
  const listings = Math.min(30, Math.max(0, see) + Math.max(0, doo));
  const ratio = COSTS[c.country] ?? 0.7;
  let s = fame + listings - 60 * ratio;
  const big = hubDegree(code) >= 60;
  if (style === "beaches") s += COASTAL.has(code) ? 35 : -15;
  if (style === "cities") s += big ? 25 : 0;
  if (style === "slow" || style === "experiences") s += big ? -10 : 15;
  if (style === "food") s += listings >= 10 ? 10 : 0;
  // Climate during the stay is judged later per base; here a place with normals at all is a plus.
  if (climateFor(code)) s += 5;
  return s;
}

/** The YYYY-MM months from one ISO day to another, inclusive. */
function monthsCovered(from: string, to: string): number[] {
  const out: number[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(m);
    if (out.length >= 12) break;
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export async function longStay(p: LongStayParams): Promise<LongStayResult> {
  const gateways = [...new Set(p.gateways.map((g) => g.toUpperCase()).filter((g) => /^[A-Z]{3}$/.test(g)))].slice(0, 3);
  const months = Math.min(6, Math.max(1, Math.round(p.months)));
  const budget: Budget = p.budget && p.budget in BUDGET_SCALE ? p.budget : "mid";
  const style = p.style ?? "experiences";
  const defaultStart = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 7);
  // Flights are searched from the day after tomorrow. A start month with no departure day
  // left (today is within two days of its end) rolls to the next month, so the flight-in
  // window is never empty, every base coming back without a flight in, and that answer cached
  // for an hour as a clean one. The result says so in its note.
  const earliest = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const askedMonth = p.startMonth && /^\d{4}-\d{2}$/.test(p.startMonth) && p.startMonth >= new Date().toISOString().slice(0, 7) ? p.startMonth : defaultStart;
  const startMonth = askedMonth < earliest.slice(0, 7) ? earliest.slice(0, 7) : askedMonth;
  const rolled = startMonth !== askedMonth;
  // Own keys only: "constructor" passes an `in` check and a truthy lookup but is no region.
  if (p.region && !Object.hasOwn(REGIONS, p.region)) throw new LongStayInputError(`unknown region ${p.region}; one of ${Object.keys(REGIONS).join(", ")}`);
  const region = p.region ? REGIONS[p.region as keyof typeof REGIONS] : undefined;
  const only = new Set((p.countries ?? []).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)));
  const explicit = only.size > 0;
  const wanted: string[] = explicit ? [...only] : (region?.countries ?? []).map(([cc]) => cc);
  const exclude = p.exclude ?? [];
  const key = JSON.stringify([gateways, p.home, [...wanted].sort(), months, startMonth, budget, style, exclude]);
  const hit = memo.get(key);
  if (hit) return hit;
  const note =
    "Rent and living are estimates from World Bank price levels (mid-range one-bedroom, 30 days at three quarters of a traveller's daily budget), counted for the days between the two flights; the day planner refines them." +
    (rolled ? ` ${MONTH_NAMES[Number(askedMonth.slice(5, 7)) - 1]} has no departure day left, so flights in were searched for ${MONTH_NAMES[Number(startMonth.slice(5, 7)) - 1]}.` : "");
  const generatedAt = new Date().toISOString();
  if (!wanted.length || !gateways.length) return { bases: [], searched: 0, failed: 0, skipped: [], generatedAt, note };

  // 1. Candidates: known, safe, with a real airport, affordable unless the traveller named the
  // country; the eight best by worth for money. A country that loses every city is reported.
  const skipped: LongStayResult["skipped"] = [];
  const countries = new Set<string>();
  for (const cc of wanted) {
    if (unsafe(cc)) {
      skipped.push({ country: cc, reason: "under a full travel warning" });
      continue;
    }
    // "Been": a base is months of nights, so a visited country is out when only new ones are wanted.
    if (!countryAllowed(cc, exclude)) {
      skipped.push({ country: cc, reason: "on your been list (only new countries)" });
      continue;
    }
    if (!explicit && (COSTS[cc] ?? 0.7) > MAX_RATIO) {
      skipped.push({ country: cc, reason: "expensive to live in; name it to include it" });
      continue;
    }
    countries.add(cc);
  }
  const minViews = explicit ? MIN_VIEWS_EXPLICIT : MIN_VIEWS;
  const candidates = Object.entries(CITIES)
    .filter(([code, c]) => countries.has(c.country) && hasRealAirport(c) && (FAME[code]?.[0] ?? 0) >= minViews)
    .map(([code, c]) => ({ code, c, s: score(code, c, style) }))
    .sort((a, b) => b.s - a.s);
  for (const cc of countries) if (!candidates.some((x) => x.c.country === cc)) skipped.push({ country: cc, reason: "no well-known city with a proper airport in the data" });
  // Two bases per country at most, so a region does not come back as eight Thai cities.
  const perCountry = new Map<string, number>();
  const picked: typeof candidates = [];
  for (const x of candidates) {
    const n = perCountry.get(x.c.country) ?? 0;
    if (n >= 2 && countries.size > 1) continue;
    perCountry.set(x.c.country, n + 1);
    picked.push(x);
    if (picked.length >= BASES) break;
  }

  // 2. Flights in over the start month, out around arrival + months x 30 days, then the money.
  const [sy, sm] = startMonth.split("-").map(Number);
  const monthFirst = new Date(Date.UTC(sy, sm - 1, 1)).toISOString().slice(0, 10);
  const monthLast = new Date(Date.UTC(sy, sm, 0)).toISOString().slice(0, 10);
  // Never empty: the start month is the month of `earliest` or a later one (see above).
  const inFrom = monthFirst > earliest ? monthFirst : earliest;
  let searched = 0;
  let failed = 0;
  const bases: LongStayBase[] = [];
  const queue = [...picked];
  async function worker() {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const { code, c } = next;
      const cc = c.country;
      const inFare = await oneWayIn(gateways.join(","), code, inFrom, monthLast);
      searched += inFare.searched;
      failed += inFare.failed;
      const bestIn = inFare.fare;
      // The way home leaves close to the day the stay should end, counted from the real arrival
      // (or from the first of the month when no flight in was found).
      const anchor = addDays(bestIn?.out ?? inFrom, months * 30);
      const outFare = await oneWayIn(code, gateways.join(","), addDays(anchor, -OUT_BEFORE), addDays(anchor, OUT_AFTER));
      searched += outFare.searched;
      failed += outFare.failed;
      const bestOut = outFare.fare;
      const arrive = bestIn?.out ?? inFrom;
      const leave = bestOut?.out ?? addDays(arrive, months * 30);
      const days = Math.max(1, daysBetween(arrive, leave));
      const monthsReal = days / 30;
      const monthlyLiving = Math.round(perDayFor(cc, budget) * 30 * 0.75);
      const rent = rentFor(cc, budget);
      const flights = (bestIn?.cheapest ?? 0) + (bestOut?.cheapest ?? 0);
      const total = Math.round(flights + monthsReal * (monthlyLiving + rent));
      const why: string[] = [];
      const [views, see, doo] = FAME[code] ?? [0, 0, 0];
      if (see > 0 || doo > 0) why.push(`${Math.max(0, see) + Math.max(0, doo)} things to see and do in the guide`);
      if (views >= 1_000_000) why.push("a place the whole world knows");
      else if (views >= MIN_VIEWS) why.push("well known, not overrun");
      why.push(`about €${perDayFor(cc, budget)} a day to live, rent around €${rent} a month (estimate)`);
      if (COASTAL.has(code)) why.push("on the coast");
      if (hubDegree(code) >= 60) why.push("a hub: cheap flights onward");
      // Say when the flights found do not match the request: a different month, or a stay a
      // week or more longer or shorter than asked.
      if (bestIn && bestOut) {
        const drift = days - months * 30;
        if (arrive.slice(0, 7) !== startMonth || Math.abs(drift) >= 7) why.push(`flights found ${dm(arrive)} to ${dm(leave)}: ${days} days, ${drift >= 0 ? `${drift} more` : `${-drift} fewer`} than ${months} month${months === 1 ? "" : "s"}; costs count the real days`);
      }
      if (!explicit && (COSTS[cc] ?? 0.7) > 0.85) why.push("on the pricier side for the region");
      const normals = climateFor(code);
      if (normals) {
        const stay = monthsCovered(arrive, leave);
        const scores = bestMonths(code)!.months.filter((m) => stay.includes(m.m));
        if (scores.length) {
          const t = scores.map((m) => m.tmax);
          const wet = scores.some((m) => m.rain > 6);
          const good = scores.every((m) => m.score >= 70);
          why.push(`${good ? "comfortable" : wet ? "wet season" : "so-so weather"} in ${stay.map((m) => MONTH_NAMES[m - 1]).join(" and ")}: ${Math.min(...t)} to ${Math.max(...t)} C${wet ? ", rainy" : ""}`);
        }
      }
      const sideTrips = neighboursOf(code)
        .slice(0, 3)
        .map((n) => ({ name: CITIES[n.code]?.name ?? n.code, code: n.code, minutes: n.minutes, mode: n.mode }));
      bases.push({
        code,
        name: c.name,
        country: cc,
        lat: c.lat,
        lon: c.lon,
        months,
        days,
        flightIn: bestIn?.cheapest != null && bestIn.out && bestIn.url ? { price: bestIn.cheapest, date: bestIn.out, url: bestIn.url, from: bestIn.from ?? gateways[0] } : null,
        flightOut: bestOut?.cheapest != null && bestOut.out && bestOut.url ? { price: bestOut.cheapest, date: bestOut.out, url: bestOut.url, to: bestOut.to } : null,
        monthlyLiving,
        rent,
        // The photo comes with the flight in (its destination is the base); the flight out's
        // image would be the home airport.
        img: bestIn?.img,
        total,
        perDay: Math.round(total / days),
        why,
        sideTrips,
        visa: cc !== p.home ? visaFor(VISA, p.home, cc) : null,
        climate: normals ? { tmax: normals.t, rain: normals.r } : undefined,
        failed: inFare.failed + outFare.failed > 0 ? true : undefined,
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  // Cheapest day first; a base with no flight found goes to the end, its total is incomplete.
  bases.sort((a, b) => Number(!a.flightIn || !a.flightOut) - Number(!b.flightIn || !b.flightOut) || a.perDay - b.perDay);
  const result: LongStayResult = { bases, searched, failed, partial: failed > 0 ? true : undefined, skipped, generatedAt, note };
  // An answer shaped by refused searches is not kept: a retry costs only the failed searches.
  if (failed === 0) memo.set(key, result);
  return result;
}

/** The flight home lands at the first gateway; the label a card shows for it. */
export function gatewayLabel(code: string): string {
  return CITIES[code]?.name ?? code;
}

export { countryLabel };
