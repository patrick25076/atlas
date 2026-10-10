import { NextResponse } from "next/server";
import { findTrips, type GatewayInput, type TripsResult } from "@/lib/trips";
import { parseExclude } from "@/lib/been";

// GET /api/trips?g=OTP:44.571:26.085:132,SBZ:45.786:24.091:123&home=RO&days=5&ground=300&limit=20
// Open-jaw trips: fly out from any gateway, train/coach between cities, fly home from the last.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways: GatewayInput[] = [];
  for (const part of (p.get("g") ?? "").split(",")) {
    const [iata, lat, lon, drive] = part.split(":");
    if (/^[A-Z]{3}$/.test(iata ?? "") && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
      gateways.push({ iata, lat: Number(lat), lon: Number(lon), driveMin: Math.max(0, Number(drive) || 60) });
    }
  }
  const home = (p.get("home") ?? "").toUpperCase();
  if (!gateways.length || !/^[A-Z]{2}$/.test(home)) {
    return NextResponse.json({ error: "g (IATA:lat:lon:driveMin, comma separated) and home (country code) required" }, { status: 400 });
  }
  const days = Math.min(14, Math.max(2, Number(p.get("days")) || 5));
  const aroundRaw = p.get("around") ?? "";
  const around = /^\d{4}-\d{2}-\d{2}$/.test(aroundRaw) ? aroundRaw : undefined;
  const maxGroundMin = Math.min(600, Math.max(60, Number(p.get("ground")) || 300));
  const limit = Math.min(50, Math.max(1, Number(p.get("limit")) || 20));
  // exclude=IT,HU: the Been list with "only new countries" on; those countries never host a night.
  const exclude = parseExclude(p.get("exclude"));
  try {
    const result = await findTrips({ gateways: gateways.slice(0, 6), home, days, around, maxGroundMin, limit, exclude });
    return NextResponse.json(result, {
      headers: { "Cache-Control": result.status === "ok" ? "public, max-age=600, stale-while-revalidate=3000" : "no-store" },
    });
  } catch (err) {
    const body: TripsResult = {
      status: "error",
      note: err instanceof Error ? err.message : "trip search failed",
      trips: [],
      generatedAt: new Date().toISOString(),
    };
    return NextResponse.json(body, { status: 502 });
  }
}
