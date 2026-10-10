/** Points along the great circle between two places, for animated trails on the globe. */
export function greatCircle(from: [number, number], to: [number, number], n = 64): [number, number][] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const [lon1, lat1] = [toRad(from[0]), toRad(from[1])];
  const [lon2, lat2] = [toRad(to[0]), toRad(to[1])];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d < 1e-9) return [from, to];
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    out.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return out;
}

/** One leg of a route on the globe: a flight follows the great circle, a ground hop a straight line. */
export type RouteLeg = { from: [number, number]; to: [number, number]; kind: "fly" | "ground" };

/**
 * The whole route as one path with evenly spaced timestamps, so a TripsLayer trail can run
 * from home through every stop and back. Flights get more points the longer they are and
 * ground hops a few, so the trail keeps a steady speed over the surface.
 */
export function routePath(legs: RouteLeg[]): { path: [number, number][]; timestamps: number[] } | null {
  const path: [number, number][] = [];
  for (const leg of legs) {
    const pts = leg.kind === "fly" ? greatCircle(leg.from, leg.to, Math.max(16, Math.min(96, Math.round(spanDeg(leg.from, leg.to) * 1.2)))) : lerpLine(leg.from, leg.to, 8);
    // Skip the first point of every leg after the first so the joints are not doubled.
    for (let i = path.length ? 1 : 0; i < pts.length; i++) path.push(pts[i]);
  }
  if (path.length < 2) return null;
  return { path, timestamps: path.map((_, i) => i) };
}

function spanDeg(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function lerpLine(a: [number, number], b: [number, number], n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  return out;
}

/** Latitude rings for the quiet grid behind the globe at low zoom: one path per line. */
export function latitudeLines(step = 15): [number, number][][] {
  const out: [number, number][][] = [];
  for (let lat = -75; lat <= 75; lat += step) {
    const ring: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 5) ring.push([lon, lat]);
    out.push(ring);
  }
  return out;
}
