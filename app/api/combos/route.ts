import { NextResponse } from "next/server";
import { findCombos, type CombosResult } from "@/lib/combos";

// GET /api/combos?gw=GHV&dst=WAW&city=WAW&out=2026-10-20&back=2026-10-25&price=89
// Two-city versions of a deal: fly in to the city, hop by train or coach to a neighbour,
// fly home from there. Six live Kiwi searches, memoised six hours.
const memo = new Map<string, { at: number; body: CombosResult }>();
const TTL = 6 * 3_600_000;
export const maxDuration = 60;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gw = (p.get("gw") ?? "").toUpperCase();
  const dst = (p.get("dst") ?? "").toUpperCase();
  const city = (p.get("city") ?? dst).toUpperCase();
  const out = p.get("out") ?? "";
  const back = p.get("back") ?? "";
  const price = Number(p.get("price"));
  if (![gw, dst, city].every((x) => /^[A-Z]{3}$/.test(x)) || !/^\d{4}-\d{2}-\d{2}$/.test(out) || !/^\d{4}-\d{2}-\d{2}$/.test(back) || !Number.isFinite(price)) {
    return NextResponse.json({ error: "gw, dst, city (codes), out, back (YYYY-MM-DD) and price required" }, { status: 400 });
  }
  const key = `${gw}|${dst}|${city}|${out}|${back}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.body, { headers: { "Cache-Control": "public, max-age=1800" } });
  try {
    const body = await findCombos(gw, dst, city, out, back, price);
    memo.set(key, { at: Date.now(), body });
    return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=1800" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "combo search failed" }, { status: 502 });
  }
}
