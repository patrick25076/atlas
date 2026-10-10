import { NextResponse } from "next/server";
import { goodValueEats, sweetsNear, type EatsResult } from "@/lib/foursquare";

// GET /api/eats?lat=38.72&lon=-9.14 → where to eat well without tourist prices near a point
// (Foursquare: rating 8+, price tier 1 or 2), plus the best sweet places. Honest status when
// the key is missing or the Foursquare organisation has no credits.
export type EatsResponse = { food: EatsResult; sweet: EatsResult };

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  const [food, sweet] = await Promise.all([goodValueEats(lat, lon), sweetsNear(lat, lon)]);
  const body: EatsResponse = { food, sweet };
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } });
}
