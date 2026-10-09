import { NextResponse } from "next/server";

// GET /api/events?lat=44.43&lon=26.10&days=30 → concerts, sport and theatre near a point from
// Ticketmaster Discovery (free key, SETUP.md §10). Honest "no-key" answer until then.
export type EventItem = {
  name: string;
  date: string;
  time?: string;
  venue?: string;
  city?: string;
  kind?: string;
  url: string;
  image?: string;
  priceFrom?: number;
  currency?: string;
};
export type EventsResponse = { status: "ok" | "no-key" | "error"; note?: string; events: EventItem[]; source?: string };

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const days = Math.min(90, Math.max(1, Number(p.get("days")) || 30));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  const key = process.env.TICKETMASTER_KEY;
  if (!key) {
    const body: EventsResponse = { status: "no-key", note: "Events need a Ticketmaster key (SETUP.md §10).", events: [] };
    return NextResponse.json(body);
  }
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  const q = new URLSearchParams({
    apikey: key,
    latlong: `${lat.toFixed(4)},${lon.toFixed(4)}`,
    radius: "40",
    unit: "km",
    startDateTime: iso(start),
    endDateTime: iso(end),
    sort: "date,asc",
    size: "20",
  });
  try {
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
    const events: EventItem[] = (j._embedded?.events ?? []).map((e) => {
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
      };
    });
    const body: EventsResponse = { status: "ok", events, source: "Ticketmaster Discovery" };
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=21600" } });
  } catch (err) {
    const body: EventsResponse = { status: "error", note: err instanceof Error ? err.message : "events unavailable", events: [] };
    return NextResponse.json(body, { status: 502 });
  }
}
