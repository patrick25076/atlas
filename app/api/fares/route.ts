import { NextResponse } from "next/server";
import { cheapestPerEnd, hasToken, inboundFares, latestFares } from "@/lib/travelpayouts";
import onewayJson from "@/public/data/oneway.json";
import type { Fare, FaresResponse } from "@/lib/types";

// Without a Travelpayouts token, the weekly Kiwi one-way file answers for the home airports.
const ONEWAY = onewayJson as unknown as { updated: string; fares: Fare[] };

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
    const fromFile = ONEWAY.fares.filter((f) => (origin ? f.src === origin : f.dst === to));
    if (fromFile.length) {
      const body: FaresResponse = {
        ...base,
        status: "ok",
        fetchedAt: ONEWAY.updated,
        note: "One-way fares found on Kiwi.com (weekly search).",
        fares: cheapestPerEnd(fromFile, origin ? "dst" : "src"),
      };
      return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=3600" } });
    }
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
