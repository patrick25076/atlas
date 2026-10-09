import { NextResponse } from "next/server";
import { hasToken, inboundFares, latestFares } from "@/lib/travelpayouts";
import type { FaresResponse } from "@/lib/types";

// GET /api/fares?origin=OTP → cheapest cached one-way fare per destination for the coming months.
// GET /api/fares?to=OTP     → cheapest cached one-way fare per origin into OTP (the way home).
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const origin = p.get("origin")?.toUpperCase() ?? "";
  const to = p.get("to")?.toUpperCase() ?? "";
  const anchor = origin || to;
  if (!/^[A-Z]{3}$/.test(anchor) || (origin && to)) {
    return NextResponse.json({ error: "give exactly one of origin or to, a 3-letter IATA code" }, { status: 400 });
  }
  const base = { origin: anchor, currency: "EUR", fares: [] as FaresResponse["fares"] };

  if (!hasToken()) {
    const body: FaresResponse = { ...base, status: "no-token", note: "Set TRAVELPAYOUTS_TOKEN (SETUP.md §2) for live fares." };
    return NextResponse.json(body);
  }
  try {
    const fares = origin ? await latestFares(origin) : await inboundFares(to);
    const body: FaresResponse = { ...base, status: "ok", fetchedAt: new Date().toISOString(), fares };
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=3000" } });
  } catch (err) {
    const body: FaresResponse = { ...base, status: "error", note: err instanceof Error ? err.message : "fares unavailable" };
    return NextResponse.json(body, { status: 502 });
  }
}
