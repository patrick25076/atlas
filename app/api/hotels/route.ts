import { NextResponse } from "next/server";
import { hotelsNear, type HotelsResult } from "@/lib/liteapi";
import { TtlLru } from "@/lib/memo";
import { bad, iso2, isoDay, latLon } from "@/lib/params";

// GET /api/hotels?lat=&lon=&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD[&nat=RO]
// The cheapest decent hotels near a point for those nights (LiteAPI, two calls). With a
// sandbox key the answer carries status "sandbox" and the site does not show the prices.
// Memoised 30 minutes per point (rounded to about 100 m), dates and nationality.
export const maxDuration = 30;
const memo = new TtlLru<HotelsResult>(500, 30 * 60_000);
const CACHE = { "Cache-Control": "public, max-age=900, stale-while-revalidate=1800" };
const MAX_NIGHTS = 30;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const at = latLon(p.get("lat"), p.get("lon"));
  const checkin = isoDay(p.get("checkin"));
  const checkout = isoDay(p.get("checkout"));
  const nat = iso2(p.get("nat")) ?? "RO";
  if (!at) return bad("lat and lon must be coordinates");
  if (!checkin || !checkout) return bad("checkin and checkout must be real dates, YYYY-MM-DD");
  if (checkout <= checkin) return bad("checkout must be after checkin");
  if (checkin < new Date().toISOString().slice(0, 10)) return bad("checkin is in the past");
  if ((Date.parse(checkout) - Date.parse(checkin)) / 86_400_000 > MAX_NIGHTS) return bad(`at most ${MAX_NIGHTS} nights`);
  const key = `${at.lat.toFixed(3)},${at.lon.toFixed(3)},${checkin},${checkout},${nat}`;
  const hit = memo.get(key);
  if (hit) return NextResponse.json(hit, { headers: { ...CACHE, "X-Hotels": "memo" } });
  const body = await hotelsNear(at.lat, at.lon, checkin, checkout, nat);
  if (body.status !== "error") memo.set(key, body);
  return NextResponse.json(body, { headers: { ...CACHE, "X-Hotels": "live" } });
}
