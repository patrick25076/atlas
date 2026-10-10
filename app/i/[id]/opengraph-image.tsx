import { ImageResponse } from "next/og";
import { headers } from "next/headers";
import { loadItinerary as loadStored } from "@/lib/itinerary-server";
import { euro } from "@/lib/format";
import type { Itinerary } from "@/lib/itinerary";

// The picture a shared itinerary link shows in a chat: the title, the dates, the stops as a
// little route and the total, in the app's colours. Read from the same store as the page.
export const alt = "An Atlas itinerary";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ID = /^[A-Za-z0-9_-]{3,80}$/;

function unwrap(x: unknown): Itinerary | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (Array.isArray(o.days) && Array.isArray(o.stops) && typeof o.title === "string") return o as unknown as Itinerary;
  if (o.itinerary) return unwrap(o.itinerary);
  return null;
}

async function load(id: string): Promise<Itinerary | null> {
  if (!ID.test(id)) return null;
  try {
    const got = await loadStored(id);
    return got ? unwrap(got.itinerary) : null;
  } catch {
    /* fall through to the route */
  }
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.)/.test(host) ? "http" : "https");
    const res = await fetch(`${proto}://${host}/api/itinerary/${encodeURIComponent(id)}`, { cache: "no-store" });
    return res.ok ? unwrap(await res.json()) : null;
  } catch {
    return null;
  }
}

function dates(a: string, b: string): string {
  const f = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(a)} to ${f(b)} ${b.slice(0, 4)}`;
}

/** The stops as dots on a small frame fitted to them, joined in order. */
function miniRoute(it: Itinerary, w: number, h: number) {
  const pts = [it.origin, ...it.stops].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) return null;
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180) || 1;
  const sx = Math.max(0.5, (Math.max(...lons) - Math.min(...lons)) * k);
  const sy = Math.max(0.5, Math.max(...lats) - Math.min(...lats));
  const pad = 30;
  const sc = Math.min((w - pad * 2) / sx, (h - pad * 2) / sy);
  const ox = (w - sx * sc) / 2;
  const oy = (h - sy * sc) / 2;
  const xy = pts.map((p) => ({ x: ox + (p.lon - Math.min(...lons)) * k * sc, y: oy + (Math.max(...lats) - p.lat) * sc }));
  const d = xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <path d={d} stroke="#7cc4ff" strokeWidth="4" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 12" />
      {xy.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={i === 0 ? 9 : 13} fill={i === 0 ? "#05070e" : "#6ff0c4"} stroke={i === 0 ? "#eef2ff" : "none"} strokeWidth="3" />
      ))}
    </svg>
  );
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const it = await load(id);
  const title = it?.title ?? "An Atlas itinerary";
  const stops = it?.stops.map((p) => p.name) ?? [];
  const shown = stops.slice(0, 5);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          padding: 56,
          background: "linear-gradient(135deg, #05070e 0%, #0c1328 60%, #06261f 100%)",
          color: "#eef2ff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, color: "#6ff0c4", fontWeight: 700 }}>atlas.</div>
            <div style={{ fontSize: title.length > 40 ? 50 : 62, fontWeight: 800, marginTop: 18, lineHeight: 1.05, letterSpacing: -1.5, maxWidth: 720 }}>{title}</div>
            {it && <div style={{ fontSize: 28, color: "#9aa3b8", marginTop: 14 }}>{`${dates(it.start, it.end)} · ${it.nights} nights from ${it.origin.name}`}</div>}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, maxWidth: 720 }}>
            {shown.map((name, i) => (
              <div key={`${name}${i}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 999, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.14)", fontSize: 26 }}>
                <div style={{ display: "flex", width: 30, height: 30, borderRadius: 15, background: "#6ff0c4", color: "#04261b", fontSize: 18, fontWeight: 800, alignItems: "center", justifyContent: "center" }}>{String(i + 1)}</div>
                {name}
              </div>
            ))}
            {stops.length > shown.length && <div style={{ display: "flex", alignItems: "center", fontSize: 24, color: "#9aa3b8" }}>{`+${stops.length - shown.length} more`}</div>}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", alignItems: "flex-end", width: 340 }}>
          {it ? miniRoute(it, 340, 300) : <div style={{ display: "flex" }} />}
          {it?.costs?.total ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <div style={{ fontSize: 22, color: "#9aa3b8", letterSpacing: 2 }}>{it.costs.estimated ? "ABOUT, IN ALL" : "IN ALL"}</div>
              <div style={{ fontSize: 84, fontWeight: 800, color: "#6ff0c4", letterSpacing: -2, lineHeight: 1 }}>{euro(it.costs.total)}</div>
              <div style={{ fontSize: 24, color: "#9aa3b8", marginTop: 6 }}>{`${euro(it.costs.perDay)} a day`}</div>
            </div>
          ) : (
            <div style={{ display: "flex" }} />
          )}
        </div>
      </div>
    ),
    { ...size },
  );
}
