import { NextResponse } from "next/server";
import { parseExclude } from "@/lib/been";
import { findCombos, type CombosResult } from "@/lib/combos";
import { InFlight, TtlLru } from "@/lib/memo";
import { bad, iata, isoDay } from "@/lib/params";

// GET /api/combos?gw=GHV&dst=WAW&city=WAW&out=2026-10-20&back=2026-10-25&price=89[&exclude=RO,HU]
// Two-city versions of a deal: fly in to the city, hop by train or coach to a neighbour,
// fly home from there. Six live Kiwi searches, memoised six hours; identical requests in
// flight share one search. exclude is the "Been" list (ISO2): neighbours in those countries
// are left out before searching (the traveller would sleep there), and a deal whose own
// destination is in one is answered with a note, no search, not memoised.
const memo = new TtlLru<CombosResult>(500, 6 * 3_600_000);
const inflight = new InFlight<CombosResult>();
export const maxDuration = 60;
const CACHE = { "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600" };

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gw = iata(p.get("gw"));
  const dst = iata(p.get("dst"));
  const city = iata(p.get("city") ?? dst);
  const out = isoDay(p.get("out"));
  const back = isoDay(p.get("back"));
  const price = Number(p.get("price"));
  const exclude = parseExclude(p.get("exclude"));
  if (!gw || !dst || !city) return bad("gw, dst and city must be three-letter airport or city codes");
  if (!out || !back) return bad("out and back must be real dates, YYYY-MM-DD");
  if (back <= out) return bad("back must be after out");
  if (out < new Date().toISOString().slice(0, 10)) return bad("out is in the past");
  if (!Number.isFinite(price) || price < 0 || price > 20_000) return bad("price must be a number of euros");
  if (gw === dst) return bad("gw and dst must differ");
  const key = `${gw}|${dst}|${city}|${out}|${back}|${exclude.join(",")}`;
  const hit = memo.get(key);
  if (hit) return NextResponse.json(hit, { headers: { ...CACHE, "X-Combos": "memo" } });
  try {
    const { promise } = inflight.run(key, () => findCombos({ gateway: gw, dst, dstCity: city, out, back, base: price, exclude }));
    const body = await promise;
    // A destination on the been list is answered with its note and not kept: the list can
    // change on the next click, and nothing was searched anyway.
    if (body.note) return NextResponse.json(body, { headers: { "Cache-Control": "no-store", "X-Combos": "skipped" } });
    // lib/combos.ts swallows failed one-way searches; a run with no outbound fare and no combo
    // is what a throttled address produces, so it is answered but not kept for six hours.
    const nothing = body.outPrice == null && !body.combos.length;
    if (!nothing) memo.set(key, body);
    return NextResponse.json(body, { headers: { ...(nothing ? { "Cache-Control": "no-store" } : CACHE), "X-Combos": nothing ? "live-empty" : "live" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "combo search failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
