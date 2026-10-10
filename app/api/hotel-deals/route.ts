import { NextResponse } from "next/server";
import { hotelDeals } from "@/lib/hotel-deals";

// GET /api/hotel-deals → the cities where tonight's cheapest decent hotel (a standard weekend
// about four weeks out, LiteAPI) is at least 25% under its own median of the last snapshots:
// hotel name, price, typical price, city. Status "warming-up" until three nightly snapshots
// exist. No parameters; memoised an hour in the process and cached at the edge.
export const maxDuration = 30;

export async function GET() {
  const body = await hotelDeals();
  const cache = body.status === "ok" || body.status === "warming-up" ? "public, s-maxage=3600, stale-while-revalidate=21600" : "public, s-maxage=300";
  return NextResponse.json(body, { headers: { "Cache-Control": cache, "X-Hotel-Deals": body.status } });
}
