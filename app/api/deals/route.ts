import { NextResponse } from "next/server";
import { kiwiDate, nightsOf, searchFlight } from "@/lib/kiwi";

// GET /api/deals?from=OTP&to=BCN&depart=2026-10-16&flex=3&nights=4
// Live re-price of one route on Kiwi.com: the cheapest itineraries around the dates asked.
const memo = new Map<string, { at: number; body: unknown }>();
const TTL = 30 * 60_000;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = (p.get("from") ?? "").toUpperCase();
  const to = (p.get("to") ?? "").toUpperCase();
  const depart = p.get("depart") ?? "";
  const flex = Math.min(10, Math.max(0, Number(p.get("flex")) || 3));
  const nights = Math.min(30, Math.max(0, Number(p.get("nights")) || 0));
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || !/^\d{4}-\d{2}-\d{2}$/.test(depart)) {
    return NextResponse.json({ error: "from, to (IATA) and depart (YYYY-MM-DD) required; optional flex, nights" }, { status: 400 });
  }
  const key = `${from}|${to}|${depart}|${flex}|${nights}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.body, { headers: { "Cache-Control": "public, max-age=600" } });
  try {
    const back = nights ? new Date(Date.parse(depart) + nights * 86_400_000).toISOString().slice(0, 10) : null;
    const r = await searchFlight({
      flyFrom: from,
      flyTo: to,
      departureDate: kiwiDate(depart),
      departureDateFlexDays: flex,
      ...(back ? { returnDate: kiwiDate(back), returnDateFlexDays: flex } : {}),
    });
    const itineraries = r.itineraries
      .map((it) => ({
        price: Math.round(it.price),
        out: it.outbound.departureTime,
        back: it.inbound?.departureTime ?? null,
        nights: nightsOf(it),
        stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0),
        carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))],
        outMin: Math.round(it.outbound.durationSeconds / 60),
        backMin: it.inbound ? Math.round(it.inbound.durationSeconds / 60) : 0,
        url: it.bookingUrl,
      }))
      .sort((a, b) => a.price - b.price);
    const body = { from, to, depart, flex, nights, currency: r.currency, fetchedAt: new Date().toISOString(), itineraries };
    memo.set(key, { at: Date.now(), body });
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=600" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "search failed" }, { status: 502 });
  }
}
