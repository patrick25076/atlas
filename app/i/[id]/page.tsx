import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import Itinerary from "@/components/Itinerary";
import s from "@/components/Itinerary.module.css";
import { loadItinerary as loadStored } from "@/lib/itinerary-server";
import { euro } from "@/lib/format";
import type { Itinerary as Itin, ItinPlace } from "@/lib/itinerary";

// The public page of a saved itinerary: /i/<id>, server-rendered, readable without the app,
// the globe or an account. The route map is a plain SVG drawn here from the stops, so the
// page is light enough to open from a chat on a phone; the itinerary itself is the same
// component the panel shows, read only.

export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9_-]{3,80}$/;

/** The stored document may be the itinerary itself or a wrapper around it (owner, savedAt). */
function unwrap(x: unknown): Itin | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (Array.isArray(o.days) && Array.isArray(o.stops) && typeof o.title === "string") return o as unknown as Itin;
  if (o.itinerary) return unwrap(o.itinerary);
  return null;
}

// One load per request, shared by generateMetadata and the page. The store directly (no hop
// through our own HTTP stack); the GET route only when the store throws.
const loadItinerary = cache(async (id: string): Promise<Itin | null> => {
  if (!ID.test(id)) return null;
  try {
    // Blob (itin/saved/<id>.json) first, then the trips table: the engine's own loader.
    const got = await loadStored(id);
    return got ? unwrap(got.itinerary) : null;
  } catch {
    // Storage unreachable from here: try the public route below.
  }
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.)/.test(host) ? "http" : "https");
    const res = await fetch(`${proto}://${host}/api/itinerary/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return unwrap(await res.json());
  } catch {
    return null;
  }
});

function describe(it: Itin): string {
  const names = it.stops.map((p) => p.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
  const total = it.costs?.total ? `, about ${euro(it.costs.total)} in all` : "";
  return `${it.nights} nights from ${it.origin.name}: ${list}${total}. A day by day plan with tickets, food and costs.`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const it = await loadItinerary(id);
  if (!it) return { title: "Itinerary not found · Atlas" };
  const description = describe(it);
  return {
    title: `${it.title} · Atlas`,
    description,
    openGraph: { title: it.title, description, type: "article" },
    twitter: { card: "summary_large_image", title: it.title, description },
  };
}

// ---------- the route map ----------

// A 2:1 frame with big labels: on a phone the map is drawn at about 360 px, so the text is
// sized to stay readable at that scale.
const W = 640;
const H = 320;
const PAD = 56;

/**
 * Equirectangular, longitudes squeezed by the middle latitude so a trip in Norway is not stretched sideways.
 * Longitudes are first unwrapped to within 180 degrees of the first point (the origin), so a
 * Los Angeles to Tokyo trip is drawn across the Pacific, not the long way round through Europe.
 * `at` unwraps; `atRaw` places an already continuous longitude (the graticule lines).
 */
function projector(points: { lat: number; lon: number }[]) {
  const ref = points[0]?.lon ?? 0;
  const unwrap = (lon: number) => {
    let x = lon;
    while (x - ref > 180) x -= 360;
    while (x - ref < -180) x += 360;
    return x;
  };
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => unwrap(p.lon));
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLon = Math.min(...lons);
  let maxLon = Math.max(...lons);
  // A one-city trip or two towns next door still gets a sensible frame, not a division by zero.
  const minSpan = 1.5;
  if (maxLat - minLat < minSpan) {
    const m = (maxLat + minLat) / 2;
    minLat = m - minSpan / 2;
    maxLat = m + minSpan / 2;
  }
  if (maxLon - minLon < minSpan) {
    const m = (maxLon + minLon) / 2;
    minLon = m - minSpan / 2;
    maxLon = m + minSpan / 2;
  }
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const spanX = (maxLon - minLon) * k;
  const spanY = maxLat - minLat;
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  const atRaw = (p: { lat: number; lon: number }) => ({ x: offX + (p.lon - minLon) * k * scale, y: offY + (maxLat - p.lat) * scale });
  const at = (p: { lat: number; lon: number }) => atRaw({ lat: p.lat, lon: unwrap(p.lon) });
  return { at, atRaw, minLat, maxLat, minLon, maxLon };
}

function niceStep(span: number): number {
  return span > 80 ? 20 : span > 30 ? 10 : span > 12 ? 5 : span > 5 ? 2 : 1;
}

function RouteMap({ it }: { it: Itin }) {
  const placed = (p: ItinPlace) => Number.isFinite(p.lat) && Number.isFinite(p.lon);
  const stops = it.stops.filter(placed);
  const legs = it.legs.filter((l) => placed(l.from) && placed(l.to));
  const points = [...(placed(it.origin) ? [it.origin] : []), ...stops, ...legs.flatMap((l) => [l.from, l.to])];
  if (!points.length) return null;
  const { at, atRaw, minLat, maxLat, minLon, maxLon } = projector(points);
  const latStep = niceStep(maxLat - minLat);
  const lonStep = niceStep(maxLon - minLon);
  const grid: string[] = [];
  for (let la = Math.ceil((minLat - 10) / latStep) * latStep; la <= maxLat + 10; la += latStep) {
    const a = atRaw({ lat: la, lon: minLon - 30 });
    const b = atRaw({ lat: la, lon: maxLon + 30 });
    grid.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
  for (let lo = Math.ceil((minLon - 30) / lonStep) * lonStep; lo <= maxLon + 30; lo += lonStep) {
    const a = atRaw({ lat: minLat - 10, lon: lo });
    const b = atRaw({ lat: maxLat + 10, lon: lo });
    grid.push(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
  }
  // Without legs the stops are joined in order, as ground, so the shape still reads.
  const paths =
    legs.length > 0
      ? legs.map((l) => ({ from: l.from, to: l.to, fly: l.kind === "fly" || l.kind === "ferry" }))
      : [it.origin, ...stops].filter(placed).flatMap((p, i, arr) => (i ? [{ from: arr[i - 1], to: p, fly: false }] : []));
  const home = placed(it.origin) ? at(it.origin) : null;
  // A hop flown both ways (there and back) bows to one side by its direction, so the two
  // arcs sit on opposite sides instead of on top of each other; a one-way hop bows upwards.
  const hopKey = (a: { x: number; y: number }, b: { x: number; y: number }) => `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}`;
  const flown = new Set(paths.filter((p) => p.fly).map((p) => hopKey(at(p.from), at(p.to))));
  return (
    <figure className={s.map} style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Route map: ${[it.origin.name, ...it.stops.map((p) => p.name)].join(", ")}`}>
        <defs>
          <linearGradient id="arc" x1="0" x2="1">
            <stop offset="0" stopColor="#6ff0c4" />
            <stop offset="1" stopColor="#7cc4ff" />
          </linearGradient>
          <radialGradient id="glow">
            <stop offset="0" stopColor="#6ff0c4" stopOpacity="0.55" />
            <stop offset="1" stopColor="#6ff0c4" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d={grid.join("")} stroke="rgba(255,255,255,0.06)" strokeWidth="1" fill="none" />
        {paths.map((p, i) => {
          const a = at(p.from);
          const b = at(p.to);
          if (Math.hypot(b.x - a.x, b.y - a.y) < 1) return null;
          if (!p.fly) return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(238,242,255,0.55)" strokeWidth="3" strokeDasharray="1 7" strokeLinecap="round" />;
          // A flight bows away from the straight line by a fifth of its length: upwards on the map,
          // except a hop that is also flown back, which bows to a side set by its direction (see `flown`).
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          let px = -dy * 0.22;
          let py = dx * 0.22;
          if (py > 0 && !flown.has(hopKey(b, a))) {
            px = -px;
            py = -py;
          }
          const cx = (a.x + b.x) / 2 + px;
          const cy = (a.y + b.y) / 2 + py;
          return <path key={i} d={`M${a.x.toFixed(1)} ${a.y.toFixed(1)}Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`} stroke="url(#arc)" strokeWidth="3" fill="none" strokeLinecap="round" />;
        })}
        {home && (
          <g>
            <circle cx={home.x} cy={home.y} r="9" fill="#05070e" stroke="#eef2ff" strokeWidth="3" />
            <text x={home.x} y={home.y + 30} textAnchor="middle" fontSize="17" fill="rgba(238,242,255,0.7)" fontFamily="system-ui, sans-serif">
              {it.origin.name}
            </text>
          </g>
        )}
        {stops.map((p, i) => {
          const c = at(p);
          return (
            <g key={`${p.name}${i}`}>
              <circle cx={c.x} cy={c.y} r="26" fill="url(#glow)" />
              <circle cx={c.x} cy={c.y} r="14" fill="#6ff0c4" />
              <text x={c.x} y={c.y + 5.5} textAnchor="middle" fontSize="16" fontWeight="700" fill="#04261b" fontFamily="system-ui, sans-serif">
                {i + 1}
              </text>
              <text x={c.x} y={c.y - 22} textAnchor="middle" fontSize="20" fontWeight="600" fill="#eef2ff" fontFamily="system-ui, sans-serif" paintOrder="stroke" stroke="rgba(5,7,14,0.85)" strokeWidth="4">
                {p.name}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export default async function SharedItineraryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const it = await loadItinerary(id);
  if (!it) notFound();
  return (
    <main className={s.sharePage}>
      <div className={s.shareInner}>
        <header className={s.shareHeader}>
          <a className={s.brand} href="/">
            atlas.
          </a>
          <a className={s.planOwn} href="/">
            Plan your own
          </a>
        </header>
        <RouteMap it={it} />
        <Itinerary itinerary={it} readOnly savedId={id} />
        <p className={s.shareFoot}>
          Planned with Atlas. Prices are what we found when it was written; check the booking links before you buy.
        </p>
      </div>
    </main>
  );
}
