import { NextResponse } from "next/server";
import { purposeTrips, type PurposeTrip } from "@/lib/purpose";

// GET /api/purpose?g=OTP,SBZ&from=2026-10-15&to=2026-12-15[&kinds=festival,sport][&live=4]
// Events worth flying for in a window, each with the cheapest way there. Memoised an hour.
export const maxDuration = 90;
const memo = new Map<string, { at: number; body: PurposeTrip[] }>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = (p.get("g") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s)).slice(0, 4);
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const kinds = (p.get("kinds") ?? "").split(",").filter(Boolean) as never;
  const live = Math.min(8, Math.max(0, Number(p.get("live")) || 4));
  if (!gateways.length || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return NextResponse.json({ error: "g, from and to required" }, { status: 400 });
  const key = `${gateways.join(",")}|${from}|${to}|${kinds}|${live}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return NextResponse.json({ trips: hit.body }, { headers: { "Cache-Control": "public, max-age=900" } });
  const trips = await purposeTrips(gateways, from, to, { live, kinds });
  memo.set(key, { at: Date.now(), body: trips });
  return NextResponse.json({ trips }, { headers: { "Cache-Control": "public, max-age=900" } });
}
