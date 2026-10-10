import { NextResponse } from "next/server";
import { hotelsNear, type HotelsResult } from "@/lib/liteapi";

// GET /api/hotels?lat=&lon=&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD[&nat=RO]
// The cheapest decent hotels near a point for those nights (LiteAPI). With a sandbox key the
// answer carries status "sandbox" and the site does not show the prices.
const memo = new Map<string, { at: number; body: HotelsResult }>();
const TTL = 30 * 60_000;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const checkin = p.get("checkin") ?? "";
  const checkout = p.get("checkout") ?? "";
  const nat = /^[A-Z]{2}$/.test(p.get("nat") ?? "") ? p.get("nat")! : "RO";
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !/^\d{4}-\d{2}-\d{2}$/.test(checkin) || !/^\d{4}-\d{2}-\d{2}$/.test(checkout)) {
    return NextResponse.json({ error: "lat, lon, checkin and checkout (YYYY-MM-DD) required" }, { status: 400 });
  }
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${checkin},${checkout},${nat}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.body, { headers: { "Cache-Control": "public, max-age=900" } });
  const body = await hotelsNear(lat, lon, checkin, checkout, nat);
  memo.set(key, { at: Date.now(), body });
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=900" } });
}
