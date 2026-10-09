// The combined view: one list of places with the best way to each. Air candidates come from
// every gateway (drive + airport buffer + flight); ground candidates from /api/reach. A station
// within MERGE_KM of an airport belongs to that airport's place, and the faster mode wins.
import { flightMinutes, haversineKm } from "./geo";
import type { Airport, City, Fare, FaresResponse, Gateway, ReachResponse, ReachStation, Route } from "./types";

export type PlaceMode = "plane" | "rail" | "coach" | "ferry" | "other";

export type Place = {
  key: string;
  name: string;
  country?: string;
  lat: number;
  lon: number;
  mode: PlaceMode;
  /** Door-to-door estimate in minutes for the best mode. */
  minutes: number;
  changes?: number;
  price?: number;
  /** 0..1, airports by size, stations by topology and departures (stationImportance). */
  importance: number;
  air?: { gateway: Airport; airport: Airport; km: number; minutes: number; fare?: Fare; fareGateway?: Airport };
  ground?: ReachStation;
};

/** Check-in, security, boarding, taxiing, baggage: what a flight costs beyond the air time. */
export const AIRPORT_BUFFER_MIN = 120;
const MERGE_KM = 25;
const NEAR_ORIGIN_KM = 30;

/**
 * 0..1 from topology and busyness. "Neighbours" are the next stops of trips calling there, so
 * express services inflate halts to 4-6 while real junctions reach 13-27 (Bucharest Nord 27,
 * Arad 22, a town like Făgăraș 7, the halt Ozun 5). Scaled so that 7+ neighbours or a busy
 * line (60 departures a day) clears the "big places" bar of 0.33.
 */
export function stationImportance(s: Pick<ReachStation, "links" | "depDay" | "pop">): number {
  const topology = Math.min(1, Math.max(0, s.links - 2) / 10);
  const busyness = Math.min(1, s.depDay / 60);
  const base = topology * 0.6 + busyness * 0.4;
  // A town of 15,000 scores 0.35 and clears the bar; a million people scores 1. Without a town
  // nearby only a busy junction gets through.
  if (s.pop >= 15_000) return Math.max(base, 0.35 + 0.65 * Math.min(1, Math.log10(s.pop / 15_000) / Math.log10(1e6 / 15_000)));
  return base * 0.5;
}

export function groundMode(mode: string): PlaceMode {
  return mode === "coach" ? "coach" : mode === "ferry" ? "ferry" : mode === "rail" ? "rail" : "other";
}

export function combinePlaces(input: {
  origin: { lat: number; lon: number };
  gateways: Gateway[];
  routesFrom: Map<string, Route[]>;
  byIata: Map<string, Airport>;
  cities: Record<string, City>;
  cityOf: Map<string, string>;
  faresByGateway: Record<string, FaresResponse | undefined>;
  reach: ReachResponse | null;
}): Place[] {
  const { origin, gateways, routesFrom, byIata, cities, cityOf, faresByGateway, reach } = input;
  const nearOrigin = (lat: number, lon: number) => haversineKm(origin.lat, origin.lon, lat, lon) < NEAR_ORIGIN_KM;
  const sizeScore = (a: Airport) => (a.size === "large" ? 1 : a.size === "medium" ? 0.7 : 0.45);

  // 1. Air: one place per city; the fastest gateway+airport and the cheapest fare from any gateway.
  const air = new Map<string, Place>();
  for (const g of gateways) {
    const response = faresByGateway[g.airport.iata];
    const fares = new Map((response?.status === "ok" ? response.fares : []).map((f) => [f.dst, f] as const));
    const destinations = new Set<string>(fares.keys());
    for (const r of routesFrom.get(g.airport.iata) ?? []) destinations.add(r.dst);
    for (const iata of destinations) {
      const airport = byIata.get(iata);
      if (!airport || nearOrigin(airport.lat, airport.lon)) continue;
      const km = haversineKm(g.airport.lat, g.airport.lon, airport.lat, airport.lon);
      const minutes = g.driveMin + AIRPORT_BUFFER_MIN + flightMinutes(km);
      const fare = fares.get(iata);
      const cityCode = cityOf.get(iata) ?? iata;
      const city = cities[cityCode];
      const prev = air.get(cityCode);
      if (!prev) {
        air.set(cityCode, {
          key: `air:${cityCode}`,
          name: city?.name ?? airport.city ?? airport.name,
          country: city?.country ?? airport.country,
          lat: city?.lat ?? airport.lat,
          lon: city?.lon ?? airport.lon,
          mode: "plane",
          minutes,
          price: fare?.price,
          importance: sizeScore(airport),
          air: { gateway: g.airport, airport, km, minutes, fare, fareGateway: fare ? g.airport : undefined },
        });
        continue;
      }
      const a = prev.air!;
      prev.importance = Math.max(prev.importance, sizeScore(airport));
      if (minutes < a.minutes) {
        a.minutes = minutes;
        a.gateway = g.airport;
        a.airport = airport;
        a.km = km;
        prev.minutes = minutes;
      }
      if (fare && (prev.price == null || fare.price < prev.price)) {
        prev.price = fare.price;
        a.fare = fare;
        a.fareGateway = g.airport;
      }
    }
  }
  const places = [...air.values()];

  // 2. Ground: join a nearby airport's place, or stand alone. The faster mode wins.
  const ground = new Map<string, Place>();
  for (const s of reach?.reached ?? []) {
    if (nearOrigin(s.lat, s.lon)) continue;
    let host: Place | null = null;
    let hostKm = MERGE_KM;
    for (const p of places) {
      const km = haversineKm(p.lat, p.lon, s.lat, s.lon);
      if (km < hostKm) {
        hostKm = km;
        host = p;
      }
    }
    if (host) {
      if (!host.ground || s.minutes < host.ground.minutes) {
        host.ground = s;
        if (s.minutes < host.minutes) {
          host.mode = groundMode(s.mode);
          host.minutes = s.minutes;
          host.changes = s.changes;
        }
      }
      continue;
    }
    // Stations of one town are one place, named after the town.
    const label = s.town || s.name;
    const prev = ground.get(label);
    if (prev && prev.minutes <= s.minutes) continue;
    ground.set(label, {
      key: `ground:${s.id}`,
      name: label,
      lat: s.lat,
      lon: s.lon,
      mode: groundMode(s.mode),
      minutes: s.minutes,
      changes: s.changes,
      importance: stationImportance(s),
      ground: s,
    });
  }

  return [...places, ...ground.values()].sort((a, b) => a.minutes - b.minutes);
}
