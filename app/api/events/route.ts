import { NextResponse } from "next/server";
import { isNoise, sourcesNear, type EventItem as OpenEvent } from "@/lib/events/sources";

// GET /api/events?lat=48.85&lon=2.35&days=30 → what's on near a point: the city's own open
// event feed where one exists (lib/events/sources.ts: markets, exhibitions, festivals, film,
// music), plus Ticketmaster Discovery for ticketed shows when the key exists (SETUP.md §10).
export type EventItem = {
  name: string;
  date: string;
  end?: string;
  time?: string;
  venue?: string;
  city?: string;
  kind?: string;
  url: string;
  image?: string;
  priceFrom?: number;
  currency?: string;
  free?: boolean;
  source?: string;
};
export type EventsResponse = { status: "ok" | "none" | "no-key" | "error"; note?: string; events: EventItem[]; sources: { id: string; name: string; licence: string }[] };

const memo = new Map<string, { at: number; body: EventsResponse }>();
const TTL = 3 * 3_600_000;

async function ticketmaster(lat: number, lon: number, from: Date, to: Date, key: string): Promise<EventItem[]> {
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const q = new URLSearchParams({ apikey: key, latlong: `${lat.toFixed(4)},${lon.toFixed(4)}`, radius: "40", unit: "km", startDateTime: iso(from), endDateTime: iso(to), sort: "date,asc", size: "20" });
  const res = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${q}`, { next: { revalidate: 21_600 } });
  if (!res.ok) throw new Error(`Ticketmaster ${res.status}`);
  const j = (await res.json()) as {
    _embedded?: {
      events?: {
        name: string;
        url: string;
        dates?: { start?: { localDate?: string; localTime?: string } };
        classifications?: { segment?: { name?: string }; genre?: { name?: string } }[];
        images?: { url: string; width: number; ratio?: string }[];
        priceRanges?: { min?: number; currency?: string }[];
        _embedded?: { venues?: { name?: string; city?: { name?: string } }[] };
      }[];
    };
  };
  return (j._embedded?.events ?? []).map((e) => {
    const img = (e.images ?? []).filter((i) => i.ratio === "16_9").sort((a, b) => b.width - a.width)[0] ?? e.images?.[0];
    const c = e.classifications?.[0];
    return {
      name: e.name,
      date: e.dates?.start?.localDate ?? "",
      time: e.dates?.start?.localTime,
      venue: e._embedded?.venues?.[0]?.name,
      city: e._embedded?.venues?.[0]?.city?.name,
      kind: [c?.segment?.name, c?.genre?.name].filter(Boolean).join(" · ") || undefined,
      url: e.url,
      image: img?.url,
      priceFrom: e.priceRanges?.[0]?.min,
      currency: e.priceRanges?.[0]?.currency,
      source: "ticketmaster",
    };
  });
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const days = Math.min(90, Math.max(1, Number(p.get("days")) || 30));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${days}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.body, { headers: { "Cache-Control": "public, max-age=1800" } });

  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const from = iso(start);
  const to = iso(end);
  const near = sourcesNear(lat, lon);
  const tm = process.env.TICKETMASTER_KEY;
  // A feed sorted by date answers with the first days only; three windows give the month a
  // spread: the next three days, the week after, the rest.
  const cut = (d: number) => iso(new Date(start.getTime() + d * 86_400_000));
  const windows: [string, string][] = days <= 4 ? [[from, to]] : [[from, cut(2)], [cut(3), cut(Math.min(10, days))], ...(days > 10 ? [[cut(11), to] as [string, string]] : [])];
  const results = await Promise.all([
    ...near.flatMap((s) => windows.map(([a, b]) => s.fetch(a, b).catch(() => [] as OpenEvent[]))),
    tm ? ticketmaster(lat, lon, start, end, tm).catch(() => [] as EventItem[]) : Promise.resolve([] as EventItem[]),
  ]);
  const seen = new Set<string>();
  const events: EventItem[] = [];
  for (const list of results) {
    let kept = 0;
    for (const e of list as EventItem[]) {
      if (!e.name || !e.date || e.date < from || e.date > to) continue;
      if (isNoise(e.name, e.kind)) continue;
      const k = `${e.name.toLowerCase().slice(0, 40)}|${e.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      events.push(e);
      if (++kept >= 10) break;
    }
  }
  // Soonest first, at most three per day, so the list reads like a month, not a Monday.
  events.sort((a, b) => a.date.localeCompare(b.date));
  const perDay = new Map<string, number>();
  const picked = events
    .filter((e) => {
      const n = perDay.get(e.date) ?? 0;
      perDay.set(e.date, n + 1);
      return n < 3;
    })
    .slice(0, 24);
  const body: EventsResponse = {
    status: picked.length ? "ok" : near.length || tm ? "none" : "no-key",
    note: picked.length ? undefined : near.length || tm ? "Nothing listed for these dates." : "No open event feed for this city yet; Ticketmaster needs a key (SETUP.md §10).",
    events: picked,
    sources: [...near.map((s) => ({ id: s.id, name: s.attribution, licence: s.licence })), ...(tm ? [{ id: "ticketmaster", name: "Ticketmaster Discovery", licence: "Ticketmaster terms" }] : [])],
  };
  memo.set(key, { at: Date.now(), body });
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=1800, stale-while-revalidate=10800" } });
}
