// Server-only. Wild trips: the long, cheap, many-country loops a patient traveller builds by
// hand. Fly out (sometimes through a cheaper hub nearby), chain cheap one-way flights and
// ground hops through a far region for two or three nights a stop, fly home from the last
// city. Every price is a live Kiwi.com fare; living costs are estimated per country from
// World Bank price levels; an LLM then says whether the result is worth it (lib/judge.ts).
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import costsJson from "@/public/data/costs.json";
import visaJson from "@/public/data/visa.json";
import fameJson from "@/public/data/fame.json";
import weatherJson from "@/public/data/weather.json";
import { haversineKm } from "./geo";
import { hubDegree, resolveGateway } from "./board";
import { neighboursOf } from "./combos";
import { kiwiDate, searchFlight, type KiwiItinerary } from "./kiwi";
import { visaFor, type City, type CountryInfo, type VisaFile } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const COSTS = costsJson as unknown as Record<string, number>;
const VISA = visaJson as unknown as VisaFile;
const FAME = fameJson as unknown as Record<string, [number, number, number]>;
/** Cities with a sea temperature are on the water: the beach half of a city-and-beach trip. */
const COASTAL = new Set(Object.keys((weatherJson as { sea?: Record<string, number> }).sea ?? {}));
const bigCity = (code: string) => hubDegree(code) >= 60;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);

/** How much a place is worth a stop: Wikipedia views and hub size, as a discount on its price. */
function worth(code: string): number {
  const views = FAME[code]?.[0] ?? 0;
  const listings = Math.max(0, FAME[code]?.[1] ?? 0);
  const fame = views > 0 ? Math.min(90, 22 * Math.log10(Math.max(1, views / 8000))) : 0;
  return fame + Math.min(30, listings) + Math.min(30, hubDegree(code) / 4);
}

/** Where a country is, for "which countries are near me now": the mean of its hub cities. */
const centroid = new Map<string, { lat: number; lon: number }>();
{
  const acc = new Map<string, { lat: number; lon: number; n: number }>();
  for (const [code, c] of Object.entries(CITIES)) {
    if (hubDegree(code) < 10) continue;
    const a = acc.get(c.country) ?? { lat: 0, lon: 0, n: 0 };
    acc.set(c.country, { lat: a.lat + c.lat, lon: a.lon + c.lon, n: a.n + 1 });
  }
  for (const [cc, a] of acc) centroid.set(cc, { lat: a.lat / a.n, lon: a.lon / a.n });
}

export type Region = "sea" | "east-asia" | "south-asia" | "gulf-africa" | "americas" | "south-america";
export const REGIONS: Record<Region, { label: string; countries: [string, string][] }> = {
  sea: { label: "Southeast Asia", countries: [["TH", "Thailand"], ["VN", "Vietnam"], ["MY", "Malaysia"], ["SG", "Singapore"], ["ID", "Indonesia"], ["PH", "Philippines"], ["KH", "Cambodia"]] },
  "east-asia": { label: "East Asia", countries: [["CN", "China"], ["HK", "Hong Kong"], ["JP", "Japan"], ["KR", "South Korea"], ["TW", "Taiwan"]] },
  "south-asia": { label: "South Asia", countries: [["IN", "India"], ["LK", "Sri Lanka"], ["MV", "Maldives"], ["NP", "Nepal"]] },
  "gulf-africa": { label: "Gulf and East Africa", countries: [["AE", "United Arab Emirates"], ["QA", "Qatar"], ["OM", "Oman"], ["JO", "Jordan"], ["EG", "Egypt"], ["KE", "Kenya"], ["TZ", "Tanzania"]] },
  americas: { label: "North and Central America", countries: [["US", "United States"], ["MX", "Mexico"], ["CU", "Cuba"], ["CR", "Costa Rica"], ["CO", "Colombia"], ["CA", "Canada"]] },
  "south-america": { label: "South America", countries: [["BR", "Brazil"], ["AR", "Argentina"], ["CL", "Chile"], ["PE", "Peru"], ["CO", "Colombia"]] },
};
/** Nearby hubs that often sell the cheap long-hauls: positioning flights go here first. */
const HUBS = ["BUD", "VIE", "WAW", "IST", "MIL", "LON", "PAR", "FRA", "AMS", "MAD", "ROM", "BER", "PRG", "ATH", "DUB", "CPH", "STO", "LIS", "BCN", "MUC", "ZRH", "BRU"];

export type WildStop = { code: string; name: string; country: string; lat: number; lon: number; arrive: string; depart: string; nights: number; perDay: number; visa?: string | null; warning?: boolean };
export type WildLeg =
  | { kind: "fly"; from: string; to: string; fromName: string; toName: string; date: string; departAt: string; arriveAt: string; price: number; hours: number; stops: number; route: string[]; carriers: string[]; url: string }
  | { kind: "ground"; from: string; to: string; fromName: string; toName: string; date: string; minutes: number; mode: string; estimated: boolean; price: number };
export type Judge = { score: number; verdict: string; reasons: string[]; tweaks: string[]; bestFor: string };
export type WildTrip = {
  id: string;
  region: Region;
  regionLabel: string;
  home: string;
  passport: string;
  title: string;
  legs: WildLeg[];
  stops: WildStop[];
  totals: { flights: number; ground: number; living: number; all: number; perDay: number; nights: number; hoursInAir: number; countries: number };
  outDate: string;
  backDate: string;
  judge?: Judge;
  searched: number;
  generatedAt: string;
};

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const dayOf = (t: string) => t.slice(0, 10);
const hoursOf = (it: KiwiItinerary) => Math.round(it.outbound.durationSeconds / 360) / 10;
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;

/** Daily budget for a mid-range careful traveller: hotel, food, local transport, one activity. */
export function perDayFor(cc: string): number {
  const ratio = COSTS[cc] ?? 0.7;
  return Math.round(92 * Math.pow(Math.min(1.6, Math.max(0.25, ratio)), 0.8));
}

function cityOfItinerary(it: KiwiItinerary): string {
  return cityOf.get(it.outbound.to) ?? it.outbound.to;
}

async function oneWay(from: string, to: string, a: string, b: string): Promise<KiwiItinerary[]> {
  try {
    const r = await searchFlight({ flyFrom: from, flyTo: to, departureDate: kiwiDate(a), departureDateTo: kiwiDate(b) });
    return r.itineraries;
  } catch {
    return [];
  }
}

function flyLeg(from: string, it: KiwiItinerary): WildLeg {
  const to = cityOfItinerary(it);
  return {
    kind: "fly",
    from,
    to,
    fromName: CITIES[from]?.name ?? it.outbound.segments[0]?.fromCity ?? from,
    toName: CITIES[to]?.name ?? it.outbound.segments.at(-1)?.toCity ?? to,
    date: dayOf(it.outbound.departureTime),
    departAt: it.outbound.departureTime,
    arriveAt: it.outbound.arrivalTime,
    price: Math.round(it.price),
    hours: hoursOf(it),
    stops: it.outbound.stops,
    route: it.outbound.route,
    carriers: [...new Set(it.outbound.segments.map((s) => s.carrierName || s.carrier))],
    url: it.bookingUrl,
  };
}

export type WildParams = {
  gateways: string[];
  home: string;
  region: Region;
  month?: string;
  nights: number;
  onProgress?: (line: string) => void;
};

export async function buildWild(p: WildParams): Promise<WildTrip | null> {
  const say = p.onProgress ?? (() => {});
  const region = REGIONS[p.region];
  const countries = region.countries.filter(([cc]) => !unsafe(cc));
  // The home airport is the biggest of the visitor's airports (Otopeni, not Ghimbav); the
  // nearest small one still gets a look as a second origin.
  const homeGateways = p.gateways.map((g) => resolveGateway(g)).filter((g): g is NonNullable<typeof g> => !!g);
  const gw = [...homeGateways].sort((a, b) => hubDegree(cityOf.get(b.code) ?? b.code) - hubDegree(cityOf.get(a.code) ?? a.code))[0];
  if (!gw) return null;
  const homeCity = cityOf.get(gw.code) ?? gw.code;
  const secondHome = homeGateways.find((g) => g.code !== gw.code);
  let searched = 0;
  const count = <T,>(x: T): T => {
    searched++;
    return x;
  };

  // The window: the first ten days of the month asked for, or three to five weeks from now.
  const today = new Date();
  let start = new Date(today.getTime() + 21 * 86_400_000);
  if (p.month && /^\d{4}-\d{2}$/.test(p.month)) {
    const [y, m] = p.month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const earliest = new Date(today.getTime() + 10 * 86_400_000);
    start = first > earliest ? first : earliest;
  }
  const from = start.toISOString().slice(0, 10);
  const to = addDays(from, 10);

  // 1. The way in: home airport and the two nearest big hubs, to every country of the region.
  const hubs = HUBS.filter((h) => h !== homeCity && CITIES[h])
    .map((h) => ({ h, km: haversineKm(gw.lat, gw.lon, CITIES[h].lat, CITIES[h].lon) }))
    .filter((x) => x.km > 150 && x.km < 1800)
    .sort((a, b) => a.km - b.km)
    .slice(0, 2)
    .map((x) => x.h);
  const origins = [gw.code, ...(secondHome ? [secondHome.code] : []), ...hubs];
  const isHome = (o: string) => o === gw.code || o === secondHome?.code;
  say(`Looking for the cheapest way into ${region.label} from ${gw.label}${secondHome ? ` or ${secondHome.label}` : ""}${hubs.length ? `, or via ${hubs.map((h) => CITIES[h].name).join(" and ")}` : ""}…`);
  const inbound = await Promise.all(origins.flatMap((o) => countries.map(async ([cc, name]) => ({ origin: o, cc, its: count(await oneWay(o, name, from, to)) }))));
  type Entry = { origin: string; it: KiwiItinerary; score: number; positioning?: KiwiItinerary };
  const entries: Entry[] = [];
  for (const r of inbound) {
    for (const it of r.its) {
      const hubPenalty = isHome(r.origin) ? 0 : 70;
      // Landing somewhere worth the first nights beats landing in the cheapest corner of a country.
      entries.push({ origin: r.origin, it, score: it.price + hubPenalty + 7 * hoursOf(it) - 0.8 * worth(cityOfItinerary(it)) });
    }
  }
  entries.sort((a, b) => a.score - b.score);
  if (!entries.length) return null;

  // Positioning for a hub entry: arrive the day before or the same day with three hours to spare.
  let entry: Entry | null = null;
  for (const e of entries.slice(0, 4)) {
    if (isHome(e.origin)) {
      entry = e;
      break;
    }
    const lhDay = dayOf(e.it.outbound.departureTime);
    const pos = count(await oneWay(gw.code, e.origin, addDays(lhDay, -1), lhDay));
    const ok = pos
      .filter((x) => Date.parse(x.outbound.arrivalTime) + 3 * 3_600_000 <= Date.parse(e.it.outbound.departureTime))
      .sort((a, b) => a.price - b.price)[0];
    if (ok) {
      entry = { ...e, positioning: ok };
      break;
    }
  }
  if (!entry) entry = entries.find((e) => isHome(e.origin)) ?? null;
  if (!entry) return null;

  const legs: WildLeg[] = [];
  const stops: WildStop[] = [];
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const maxStops = Math.min(countries.length, 5);
  const nightsPerStop = Math.min(3, Math.max(2, Math.floor((p.nights - 1) / maxStops)));
  const addStop = (code: string, arrive: string, nights = nightsPerStop) => {
    const c = CITIES[code];
    const cc = c?.country ?? "";
    stops.push({ code, name: c?.name ?? code, country: cc, lat: c?.lat ?? 0, lon: c?.lon ?? 0, arrive, depart: addDays(arrive, nights), nights, perDay: perDayFor(cc), visa: cc && cc !== p.home ? visaFor(VISA, p.home, cc) : null, warning: COUNTRIES[cc]?.advisory?.partial || undefined });
  };
  const leave = (on: string) => {
    const s = stops.at(-1)!;
    s.depart = on;
    s.nights = Math.max(1, daysBetween(s.arrive, on));
  };
  const startCity = isHome(entry.origin) ? (cityOf.get(entry.origin) ?? entry.origin) : homeCity;
  if (entry.positioning) {
    legs.push(flyLeg(startCity, entry.positioning));
    // A night in the hub before the long-haul is a night that costs money: show it as a stop.
    const posDay = dayOf(entry.positioning.outbound.arrivalTime);
    const lhDay = dayOf(entry.it.outbound.departureTime);
    if (posDay < lhDay) addStop(entry.origin, posDay, daysBetween(posDay, lhDay));
  }
  legs.push(flyLeg(entry.positioning ? entry.origin : startCity, entry.it));
  let current = cityOfItinerary(entry.it);
  let date = dayOf(entry.it.outbound.arrivalTime);
  const visited = new Set<string>([CITIES[current]?.country ?? ""]);
  const outDate = legs[0].kind === "fly" ? legs[0].date : from;
  say(`Way in found: ${legs.map((l) => (l.kind === "fly" ? `${l.fromName} → ${l.toName} €${l.price}` : "")).join(", ")}.`);

  // 2. The chain: two or three nights a stop, then the cheapest worthwhile hop to a country not
  // yet seen, among the four nearest. A stop's nights follow the flight that actually leaves it.
  const endDate = addDays(outDate, p.nights);
  addStop(current, date);
  for (let step = 0; step < maxStops; step++) {
    const earliest = addDays(stops.at(-1)!.arrive, nightsPerStop);
    if (daysBetween(earliest, endDate) < nightsPerStop + 1) break;
    const cur = CITIES[current];
    const remaining = countries
      .filter(([cc]) => !visited.has(cc))
      .map(([cc, name]) => ({ cc, name, km: centroid.has(cc) && cur ? haversineKm(cur.lat, cur.lon, centroid.get(cc)!.lat, centroid.get(cc)!.lon) : 2000 }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 4);
    if (!remaining.length) break;
    // Ground hops across a border count as a candidate without a search (Shenzhen to Hong Kong).
    const ground = cur
      ? neighboursOf(current).filter((n) => CITIES[n.code] && !visited.has(CITIES[n.code].country) && remaining.some((r) => r.cc === CITIES[n.code].country) && n.minutes <= 240 && worth(n.code) >= 40)
      : [];
    const flights = await Promise.all(remaining.map(async ({ cc, name }) => ({ cc, its: count(await oneWay(current, name, earliest, addDays(earliest, 1))) })));
    type Cand = { code: string; score: number; it?: KiwiItinerary; ground?: (typeof ground)[number] };
    const cands: Cand[] = [];
    // Variety: after two big cities a smaller place is welcome; a coast is welcome once.
    const lastTwoBig = stops.length >= 2 && stops.slice(-2).every((s) => bigCity(s.code));
    const hadCoast = stops.some((s) => COASTAL.has(s.code));
    const variety = (code: string) => (lastTwoBig && !bigCity(code) ? 45 : 0) + (!hadCoast && COASTAL.has(code) ? 30 : 0);
    for (const g of ground) cands.push({ code: g.code, score: 25 + g.minutes / 10 - worth(g.code) - variety(g.code), ground: g });
    for (const f of flights) {
      for (const it of f.its.slice(0, 6)) {
        const code = cityOfItinerary(it);
        if (code === current || !CITIES[code]) continue;
        const back = stops.some((s) => haversineKm(s.lat, s.lon, CITIES[code].lat, CITIES[code].lon) < 120);
        cands.push({ code, score: it.price + 9 * hoursOf(it) + (back ? 80 : 0) - worth(code) - variety(code), it });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    const best = cands[0];
    if (!best) break;
    if (best.ground) {
      const g = best.ground;
      leave(earliest);
      legs.push({ kind: "ground", from: current, to: g.code, fromName: cur?.name ?? current, toName: CITIES[g.code].name, date: earliest, minutes: g.minutes, mode: g.mode, estimated: g.estimated, price: 20 });
      current = g.code;
      date = earliest;
    } else if (best.it) {
      leave(dayOf(best.it.outbound.departureTime));
      legs.push(flyLeg(current, best.it));
      current = best.code;
      date = dayOf(best.it.outbound.arrivalTime);
    }
    addStop(current, date);
    visited.add(CITIES[current].country);
    say(`Next: ${CITIES[current].name} (${CITIES[current].country}).`);
  }

  // 3. The way home, from the last stop or the one before.
  const homeGws = p.gateways.map((g) => resolveGateway(g)).filter((g): g is NonNullable<typeof g> => !!g).slice(0, 2);
  let backLeg: WildLeg | null = null;
  for (const from of [stops.at(-1), stops.at(-2)].filter((s): s is WildStop => !!s)) {
    // Leave on the planned end date, give or take a day; never before two nights there.
    const earliest = addDays(from.arrive, Math.max(2, Math.min(nightsPerStop, daysBetween(from.arrive, endDate) - 1)));
    const latest = addDays(endDate, 1);
    if (daysBetween(earliest, latest) < 0) continue;
    // Hours weigh more on the way home: a 33-hour saving of €40 is no saving. Over 30 hours
    // only when nothing shorter exists.
    const all = (await Promise.all(homeGws.map((g) => oneWay(from.code, g.code, earliest, latest)))).flat().map(count);
    const sane = all.filter((it) => hoursOf(it) <= 30);
    const its = (sane.length ? sane : all).sort((a, b) => a.price + 10 * hoursOf(a) - (b.price + 10 * hoursOf(b)));
    if (its[0]) {
      if (from !== stops.at(-1)) {
        // The last stop had no way home: drop it and give its nights to the one before.
        stops.pop();
        legs.pop();
      }
      backLeg = flyLeg(from.code, its[0]);
      from.depart = backLeg.date;
      from.nights = Math.max(1, daysBetween(from.arrive, from.depart));
      break;
    }
  }
  if (!backLeg) return null;
  legs.push(backLeg);
  say(`Way home: ${backLeg.fromName} → ${backLeg.toName} €${backLeg.price}.`);

  const flights = legs.filter((l) => l.kind === "fly").reduce((s, l) => s + l.price, 0);
  const groundCost = legs.filter((l) => l.kind === "ground").reduce((s, l) => s + l.price, 0);
  const living = stops.reduce((s, x) => s + x.nights * x.perDay, 0);
  const nights = stops.reduce((s, x) => s + x.nights, 0);
  // Door to door, layovers included: what the days actually cost in transit.
  const hoursInAir = Math.round(legs.filter((l): l is Extract<WildLeg, { kind: "fly" }> => l.kind === "fly").reduce((s, l) => s + l.hours, 0));
  const all = flights + groundCost + living;
  const countriesSeen = new Set(stops.map((s) => s.country)).size;
  const title = stops.map((s) => s.name).join(" → ");
  return {
    id: `${gw.code}-${p.region}-${outDate}-${stops.map((s) => s.code).join("-")}`,
    region: p.region,
    regionLabel: region.label,
    home: gw.code,
    passport: p.home,
    title,
    legs,
    stops,
    totals: { flights, ground: groundCost, living, all, perDay: Math.round(all / Math.max(1, nights)), nights, hoursInAir, countries: countriesSeen },
    outDate,
    backDate: backLeg.date,
    searched,
    generatedAt: new Date().toISOString(),
  };
}

export function wildPath(gw: string, region: string, month: string | undefined, nights: number): string {
  return `wild/${gw}-${region}-${month ?? "next"}-${nights}.json`;
}

export { hubDegree };
