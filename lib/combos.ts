// Server-only. Two-city combos for a deal: fly in to A as found, hop to a nearby city B by
// train or coach, fly home from B. Often cheaper than the return from A, and you see B.
// Candidates come from the ground graph (expected door-to-door minutes); where the graph has
// no coverage, nearby cities with an airport stand in with an estimated road time.
import citiesJson from "@/public/data/cities.json";
import airportsJson from "@/public/data/airports.json";
import { countryAllowed } from "./been";
import { haversineKm } from "./geo";
import { reachFrom } from "./ground";
import { hubDegree, resolveGateway } from "./board";
import { kiwiDate, searchFlight } from "./kiwi";
import type { Airport, City } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const AIRPORTS = airportsJson as unknown as Airport[];
const sizeOf = new Map(AIRPORTS.map((a) => [a.iata, a.size]));
const flyable = (code: string) => (CITIES[code]?.airports ?? []).some((a) => sizeOf.get(a) !== "small");

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
  for (let dl = -1; dl <= 1; dl++)
    for (let dn = -1; dn <= 1; dn++)
      for (const code of grid.get(`${cl + dl},${co + dn}`) ?? []) {
        const km = haversineKm(lat, lon, CITIES[code].lat, CITIES[code].lon);
        if (km < bestKm) {
          bestKm = km;
          best = code;
        }
      }
  return best;
}

export type Combo = {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  groundMin: number;
  groundMode: string;
  changes: number;
  estimated: boolean;
  /** One-way home from here on the return date (±1 day). */
  inPrice: number;
  inDate: string;
  inUrl: string;
  inStops: number;
  total: number;
  saves: number;
};
export type CombosResult = {
  gateway: string;
  city: string;
  base: number;
  outPrice: number | null;
  outUrl: string | null;
  outDate: string;
  combos: Combo[];
  searched: number;
  generatedAt: string;
  /** A plain sentence when the deal's own destination is on the been list and nothing was searched. */
  note?: string;
};

const MAX_GROUND_MIN = 300;
const CANDIDATES = 5;

/** Nearby cities with an airport, by ground graph first, then by road estimate. */
export function neighboursOf(cityCode: string): { code: string; minutes: number; mode: string; changes: number; estimated: boolean }[] {
  const x = CITIES[cityCode];
  if (!x) return [];
  const out = new Map<string, { code: string; minutes: number; mode: string; changes: number; estimated: boolean }>();
  const r = reachFrom(x.lat, x.lon, MAX_GROUND_MIN, 25);
  for (const s of r.reached) {
    const code = nearestCity(s.lat, s.lon);
    if (!code || code === cityCode || !flyable(code)) continue;
    const prev = out.get(code);
    if (!prev || s.minutes < prev.minutes) out.set(code, { code, minutes: s.minutes, mode: s.mode, changes: s.changes, estimated: false });
  }
  if (out.size < 3) {
    for (const [code, c] of Object.entries(CITIES)) {
      if (code === cityCode || out.has(code) || !flyable(code)) continue;
      const km = haversineKm(x.lat, x.lon, c.lat, c.lon);
      if (km < 40 || km > 350) continue;
      out.set(code, { code, minutes: Math.round(30 + (km * 1.3) / 80 * 60), mode: "road", changes: 0, estimated: true });
    }
  }
  return [...out.values()].sort((a, b) => a.minutes - b.minutes || hubDegree(b.code) - hubDegree(a.code)).slice(0, CANDIDATES);
}

/** Options a caller may add: the "Been" list (ISO2), so a neighbour in a visited country is never proposed (nor searched). */
export type CombosOptions = { exclude?: string[] };
/** The same request as one object, the shape the chat tools use. */
export type CombosParams = { gateway: string; dst: string; dstCity: string; out: string; back: string; base: number } & CombosOptions;

export async function findCombos(params: CombosParams): Promise<CombosResult>;
export async function findCombos(gateway: string, dst: string, dstCity: string, out: string, back: string, base: number, opts?: CombosOptions): Promise<CombosResult>;
/** Both call shapes land here: the positional one the route always used, and the object one. */
export async function findCombos(a: CombosParams | string, dstArg?: string, dstCityArg?: string, outArg?: string, backArg?: string, baseArg?: number, opts: CombosOptions = {}): Promise<CombosResult> {
  const { gateway, dst, dstCity, out, back, base, exclude = [] }: CombosParams = typeof a === "string" ? { gateway: a, dst: dstArg ?? "", dstCity: dstCityArg ?? "", out: outArg ?? "", back: backArg ?? "", base: baseArg ?? 0, exclude: opts.exclude } : a;
  // The deal's own destination is where the traveller lands and sleeps first: in a visited
  // country the combo is not proposed at all, so none of its six searches is spent.
  const dstCountry = CITIES[dstCity]?.country ?? resolveGateway(dst)?.country;
  if (!countryAllowed(dstCountry, exclude)) {
    return { gateway, city: dstCity, base, outPrice: null, outUrl: null, outDate: out, combos: [], searched: 0, generatedAt: new Date().toISOString(), note: `${CITIES[dstCity]?.name ?? dstCity} is on your been list (only new countries), so no two-city combo was searched; a layover there is still fine.` };
  }
  // The neighbour is where the traveller sleeps and flies home from: a destination, not a layover.
  const neighbours = neighboursOf(dstCity).filter((n) => countryAllowed(CITIES[n.code]?.country, exclude));
  const oneWay = async (from: string, to: string, date: string) => {
    const r = await searchFlight({ flyFrom: from, flyTo: to, departureDate: kiwiDate(date), departureDateFlexDays: 1 });
    const it = r.itineraries.sort((a, b) => a.price - b.price)[0];
    return it ? { price: Math.round(it.price), url: it.bookingUrl, date: it.outbound.departureTime.slice(0, 10), stops: it.outbound.stops } : null;
  };
  let searched = 0;
  const [outOne, ...ins] = await Promise.all([
    oneWay(gateway, dst, out).catch(() => null),
    ...neighbours.map((n) => oneWay(n.code, gateway, back).catch(() => null)),
  ]);
  searched = 1 + neighbours.length;
  const combos: Combo[] = [];
  neighbours.forEach((n, i) => {
    const inn = ins[i];
    if (!inn || !outOne) return;
    const c = CITIES[n.code];
    const total = outOne.price + inn.price;
    combos.push({
      code: n.code,
      name: c.name,
      country: c.country,
      lat: c.lat,
      lon: c.lon,
      groundMin: n.minutes,
      groundMode: n.mode,
      changes: n.changes,
      estimated: n.estimated,
      inPrice: inn.price,
      inDate: inn.date,
      inUrl: inn.url,
      inStops: inn.stops,
      total,
      saves: base - total,
    });
  });
  combos.sort((a, b) => a.total - b.total);
  return { gateway, city: dstCity, base, outPrice: outOne?.price ?? null, outUrl: outOne?.url ?? null, outDate: outOne?.date ?? out, combos, searched, generatedAt: new Date().toISOString() };
}
