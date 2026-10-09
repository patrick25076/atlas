// Server-only. The trip finder: open-jaw trips of two or three cities. Fly from any home gateway
// to an entry city, move between cities by train or coach (each leg under a limit), fly home
// from the last city to any gateway. Priced from cached fares, dates aligned to the trip length,
// ranked by value: countries and cities per euro and hour of travel.
import citiesJson from "@/public/data/cities.json";
import { flightMinutes, haversineKm } from "./geo";
import { reachFrom, type ReachResult } from "./ground";
import { allFares, hasToken } from "./travelpayouts";
import type { City, Fare } from "./types";

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
  maxGroundMin: number;
  limit: number;
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
export type TripsResult = { status: "ok" | "no-token" | "error"; note?: string; trips: Trip[]; generatedAt: string };

const AIRPORT_BUFFER_MIN = 120;
const ENTRY_CANDIDATES = 50;
const VIA_CANDIDATES = 12;
const FARE_TRIES = 10;

type GroundLink = { minutes: number; changes: number; mode: string; station: number };
const reachMemo = new Map<string, { result: ReachResult; links: Map<string, GroundLink> }>();

/** Cities reachable from a city by train/coach within the limit, with the station used. */
function groundFrom(code: string, maxGroundMin: number) {
  const key = `${code}:${maxGroundMin}`;
  const hit = reachMemo.get(key);
  if (hit) return hit;
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
  reachMemo.set(key, entry);
  return entry;
}

function pathTo(result: ReachResult, stationId: number, from: City): [number, number][] {
  const byId = new Map<number, { lat: number; lon: number; prev: number }>();
  for (const s of result.reached) byId.set(s.id, s);
  for (const s of result.starts) byId.set(s.id, { lat: s.lat, lon: s.lon, prev: -1 });
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
  if (!hasToken()) {
    return { status: "no-token", note: "Trips need cached fares: set TRAVELPAYOUTS_TOKEN (SETUP.md §2).", trips: [], generatedAt };
  }
  const { gateways, home, days, maxGroundMin, limit } = params;
  const gatewayByIata = new Map(gateways.map((g) => [g.iata, g]));

  // Fares out of and back into every gateway, grouped by the far city.
  const outByCity = new Map<string, (Fare & { gateway: GatewayInput })[]>();
  const inByCity = new Map<string, (Fare & { gateway: GatewayInput })[]>();
  await Promise.all(
    gateways.flatMap((g) => [
      allFares({ origin: g.iata }).then((fares) => {
        for (const f of fares) {
          const city = cityOf.get(f.dst) ?? f.dst;
          if (!CITIES[city] || CITIES[city].country === home) continue;
          const list = outByCity.get(city);
          if (list) list.push({ ...f, gateway: g });
          else outByCity.set(city, [{ ...f, gateway: g }]);
        }
      }),
      allFares({ destination: g.iata }).then((fares) => {
        for (const f of fares) {
          const city = cityOf.get(f.src) ?? f.src;
          if (!CITIES[city] || CITIES[city].country === home) continue;
          const list = inByCity.get(city);
          if (list) list.push({ ...f, gateway: g });
          else inByCity.set(city, [{ ...f, gateway: g }]);
        }
      }),
    ]),
  );
  for (const list of outByCity.values()) list.sort((a, b) => a.price - b.price);
  for (const list of inByCity.values()) list.sort((a, b) => a.price - b.price);

  const entries = [...outByCity.entries()].sort((a, b) => a[1][0].price - b[1][0].price).slice(0, ENTRY_CANDIDATES);

  const trips: Trip[] = [];
  const seen = new Set<string>();

  function evaluate(codes: string[], ground: { from: string; to: string; link: GroundLink }[]) {
    const first = codes[0];
    const last = codes[codes.length - 1];
    const outs = outByCity.get(first);
    const ins = inByCity.get(last);
    if (!outs || !ins) return;
    const key = codes.join(">");
    if (seen.has(key)) return;

    // Cheapest aligned pair of dates: back = out + days, give or take a day.
    let best: { out: (typeof outs)[number]; back: (typeof ins)[number]; nights: number } | null = null;
    for (const o of outs.slice(0, FARE_TRIES)) {
      for (const i of ins.slice(0, FARE_TRIES)) {
        const nights = daysBetween(o.departureAt, i.departureAt);
        if (Math.abs(nights - days) > 1) continue;
        if (!best || o.price + i.price < best.out.price + best.back.price) best = { out: o, back: i, nights };
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
          path: pathTo(groundFrom(g.from, maxGroundMin).result, g.link.station, CITIES[g.from]),
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

  for (const [a] of entries) {
    const fromA = groundFrom(a, maxGroundMin);
    const vias = [...fromA.links.entries()].sort((x, y) => x[1].minutes - y[1].minutes);
    // Two cities: A → B, fly home from B.
    for (const [b, link] of vias) if (inByCity.has(b)) evaluate([a, b], [{ from: a, to: b, link }]);
    // Three cities: A → M → B.
    for (const [m, linkAM] of vias.slice(0, VIA_CANDIDATES)) {
      const fromM = groundFrom(m, maxGroundMin);
      for (const [b, linkMB] of fromM.links) {
        if (b === a || !inByCity.has(b)) continue;
        evaluate([a, m, b], [{ from: a, to: m, link: linkAM }, { from: m, to: b, link: linkMB }]);
      }
    }
  }

  trips.sort((x, y) => y.value - x.value);
  return { status: "ok", trips: trips.slice(0, limit), generatedAt };
}
