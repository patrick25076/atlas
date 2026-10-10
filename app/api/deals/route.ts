import { NextResponse } from "next/server";
import { kiwiDate, nightsOf, searchFlight } from "@/lib/kiwi";
import { TtlLru } from "@/lib/memo";
import { bad, iata, intIn, isoDay } from "@/lib/params";

// GET /api/deals?from=OTP&to=BCN&depart=2026-10-16&flex=3&nights=4
// Live re-price of one route on Kiwi.com: the cheapest itineraries around the dates asked.
// One search (memoised a day inside lib/kiwi); the shaped answer is memoised 30 minutes.
export const maxDuration = 60;
const memo = new TtlLru<unknown>(500, 30 * 60_000);
const CACHE = { "Cache-Control": "public, max-age=600, stale-while-revalidate=1800" };

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = iata(p.get("from"));
  const to = iata(p.get("to"));
  const depart = isoDay(p.get("depart"));
  const flex = intIn(p.get("flex"), 0, 10, 3);
  const nights = intIn(p.get("nights"), 0, 30, 0);
  if (!from || !to) return bad("from and to must be three-letter IATA codes");
  if (from === to) return bad("from and to must differ");
  if (!depart) return bad("depart must be a real date, YYYY-MM-DD");
  if (depart < new Date().toISOString().slice(0, 10)) return bad("depart is in the past");
  const key = `${from}|${to}|${depart}|${flex}|${nights}`;
  const hit = memo.get(key);
  if (hit) return NextResponse.json(hit, { headers: { ...CACHE, "X-Deals": "memo" } });
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
    memo.set(key, body);
    return NextResponse.json(body, { headers: { ...CACHE, "X-Deals": "live" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "search failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
