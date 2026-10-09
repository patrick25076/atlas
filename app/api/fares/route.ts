import { NextResponse } from "next/server";
import { hasToken, latestFares } from "@/lib/travelpayouts";
import type { FaresResponse } from "@/lib/types";

// GET /api/fares?origin=OTP → cheapest cached one-way fare per destination for the coming months.
export async function GET(request: Request) {
  const origin = new URL(request.url).searchParams.get("origin")?.toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(origin)) {
    return NextResponse.json({ error: "origin must be a 3-letter IATA code" }, { status: 400 });
  }
  const base = { origin, currency: "EUR", fares: [] as FaresResponse["fares"] };

  if (!hasToken()) {
    const body: FaresResponse = { ...base, status: "no-token", note: "Set TRAVELPAYOUTS_TOKEN (SETUP.md §2) for live fares." };
    return NextResponse.json(body);
  }
  try {
    const fares = await latestFares(origin);
    const body: FaresResponse = { ...base, status: "ok", fetchedAt: new Date().toISOString(), fares };
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=600, stale-while-revalidate=3000" } });
  } catch (err) {
    const body: FaresResponse = { ...base, status: "error", note: err instanceof Error ? err.message : "fares unavailable" };
    return NextResponse.json(body, { status: 502 });
  }
}
