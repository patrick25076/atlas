import type { Airport, Gateway } from "./types";

const EARTH_KM = 6371;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

/** Straight-line distance to a rough door-to-door drive. Real routing comes later. */
export function driveMinutes(km: number): number {
  const roadFactor = 1.3;
  const avgKmh = km < 30 ? 45 : 75;
  return Math.round(((km * roadFactor) / avgKmh) * 60);
}

/**
 * The airports worth driving to. Bigger airports count even when they are farther away,
 * because they are where the cheap and direct flights are.
 */
export function nearestGateways(
  airports: Airport[],
  lat: number,
  lon: number,
  { maxKm = 350, limit = 6 } = {},
): Gateway[] {
  const reach: Record<Airport["size"], number> = { large: maxKm, medium: maxKm * 0.7, small: maxKm * 0.4 };
  const out: Gateway[] = [];
  for (const airport of airports) {
    const km = haversineKm(lat, lon, airport.lat, airport.lon);
    if (km <= reach[airport.size]) out.push({ airport, km, driveMin: driveMinutes(km) });
  }
  const weight: Record<Airport["size"], number> = { large: 0.45, medium: 0.75, small: 1 };
  out.sort((a, b) => a.km * weight[a.airport.size] - b.km * weight[b.airport.size]);
  return out.slice(0, limit);
}

export function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m.toString().padStart(2, "0")}` : `${h}h`;
}

/** Great-circle flight time estimate: taxi + climb overhead, then cruise. */
export function flightMinutes(km: number): number {
  return Math.round(35 + (km / 800) * 60);
}
