import { NextResponse } from "next/server";
import { reachFrom } from "@/lib/ground";

// GET /api/reach?lat=45.66&lon=25.60&max=600 → every station reachable by train/coach within
// `max` minutes of a point, with expected minutes, changes and the predecessor for path drawing.
export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  // Rounded to about a kilometre so nearby requests share a cache entry.
  const lat = Math.round(Number(p.get("lat")) * 100) / 100;
  const lon = Math.round(Number(p.get("lon")) * 100) / 100;
  const max = Math.min(900, Math.max(60, Number(p.get("max")) || 600));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ error: "lat and lon required" }, { status: 400 });
  }
  const result = reachFrom(lat, lon, max);
  return NextResponse.json(
    { ...result, reached: result.reached.slice(0, 6000), truncated: result.reached.length > 6000 },
    { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
  );
}
