import { NextResponse } from "next/server";
import { goodValueEats, sweetsNear, type EatsResult } from "@/lib/foursquare";
import { TtlLru } from "@/lib/memo";
import { bad, latLon } from "@/lib/params";

// GET /api/eats?lat=38.72&lon=-9.14 → where to eat well without tourist prices near a point
// (Foursquare: rating 8+, price tier 1 or 2), plus the best sweet places. Honest status when
// the key is missing or the Foursquare organisation has no credits. Two Foursquare calls per
// point, memoised a day (the points are rounded to about a kilometre, so a city is one key).
export type EatsResponse = { food: EatsResult; sweet: EatsResult };
export const maxDuration = 30;
const memo = new TtlLru<EatsResponse>(500, 24 * 3_600_000);
const CACHE = { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" };

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const at = latLon(p.get("lat"), p.get("lon"));
  if (!at) return bad("lat and lon must be coordinates");
  const key = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
  const hit = memo.get(key);
  if (hit) return NextResponse.json(hit, { headers: { ...CACHE, "X-Eats": "memo" } });
  const [food, sweet] = await Promise.all([goodValueEats(at.lat, at.lon), sweetsNear(at.lat, at.lon)]);
  const body: EatsResponse = { food, sweet };
  // A missing key or an empty credit balance is not worth remembering for a day.
  if (food.status === "ok" || sweet.status === "ok") memo.set(key, body);
  return NextResponse.json(body, { headers: { ...CACHE, "X-Eats": "live" } });
}
