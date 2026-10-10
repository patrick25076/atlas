import { NextResponse } from "next/server";
import { parseExclude } from "@/lib/been";
import { readJson, writeJson } from "@/lib/boards-store";
import { planDays, planPath, type Plan } from "@/lib/plan";
import { customKey, wildPath, REGIONS, type Budget, type Style, type Tradeoff, type WildTrip } from "@/lib/wild";
import { mainGateway } from "@/lib/board";
import { InFlight } from "@/lib/memo";
import { bad, iataList, intIn, isoDay, isoMonth, oneOf } from "@/lib/params";

// GET /api/plan?g=OTP&region=sea&nights=14[&month=][&from=&to=][&style=][&budget=][&tradeoff=][&noHubs=1][&variants=3][&exclude=TH,VN][&fresh=<token>]
// The day-by-day plan of a stored wild trip: experiences, food, costs, a month's rent. Built
// once (one to two minutes of model and research calls), then stored next to the trip. Two
// visitors asking for the same plan share one build. The trip is looked up under exactly the
// key /api/wild stored it with, so every parameter that shapes that key (month or window,
// style, budget, tradeoff, noHubs, variants, exclude) is accepted here with the same validation and
// clamps (a window wider than ten days is clipped to from + 10 days, as /api/wild clips it,
// so the key matches; the been list becomes the same token); a caller must send what it sent to /api/wild. No Kiwi searches. `fresh` rebuilds
// only with the shared token (ATLAS_FRESH_TOKEN): a plan costs a minute of model calls and
// about ten Tavily searches.
export const maxDuration = 300;
const inflight = new InFlight<Plan | null>();
const STYLES = ["experiences", "beaches", "food", "cities", "slow"] as const;
const BUDGETS = ["backpacker", "mid", "comfort"] as const;
const TRADEOFFS = ["price", "balanced", "comfort"] as const;
/** Same bounds as /api/wild, so a plan key always matches a trip key. */
const MIN_NIGHTS = 7;
const MAX_NIGHTS = 90;
const MAX_WINDOW_DAYS = 10;
const LONG_TRIP_NIGHTS = 28;
const MAX_VARIANTS = 3;
const MAX_VARIANTS_LONG = 2;

function freshAllowed(v: string | null): boolean {
  const token = process.env.ATLAS_FRESH_TOKEN?.trim();
  return !!token && !!v && v === token;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 3);
  if (!gateways.length) return bad("g must be a comma list of three-letter airport codes");
  const g = mainGateway(gateways);
  const region = (p.get("region") ?? "sea").toLowerCase();
  // Own keys only: "constructor" passes an `in` check but is no region.
  if (!Object.hasOwn(REGIONS, region)) return bad(`region must be one of ${Object.keys(REGIONS).join(", ")}`);
  const nightsRaw = p.get("nights");
  if (nightsRaw && !Number.isFinite(Number(nightsRaw))) return bad(`nights must be a number from ${MIN_NIGHTS} to ${MAX_NIGHTS}`);
  const nights = intIn(nightsRaw, MIN_NIGHTS, MAX_NIGHTS, 14);
  const monthRaw = p.get("month");
  const month = monthRaw ? (isoMonth(monthRaw) ?? undefined) : undefined;
  if (monthRaw && !month) return bad("month must be YYYY-MM");
  const fromRaw = p.get("from");
  const toRaw = p.get("to");
  const from = fromRaw ? (isoDay(fromRaw) ?? undefined) : undefined;
  let to = toRaw ? (isoDay(toRaw) ?? undefined) : undefined;
  if ((fromRaw && !from) || (toRaw && !to)) return bad("from and to must be real dates, YYYY-MM-DD");
  if (to && !from) return bad("to needs a from");
  if (from && to && to < from) return bad("to must not be before from");
  // The same clip as /api/wild, so the plan is looked up under the key the trip was stored with.
  if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_WINDOW_DAYS) to = new Date(Date.parse(from) + MAX_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const style = oneOf<Style>(p.get("style"), STYLES, "experiences");
  const budget = oneOf<Budget>(p.get("budget"), BUDGETS, "mid");
  const tradeoff = oneOf<Tradeoff>(p.get("tradeoff"), TRADEOFFS, "balanced");
  const noHubs = p.get("noHubs") === "1";
  const exclude = parseExclude(p.get("exclude"));
  // The same clamps as /api/wild: at most 3 versions, 2 past 28 nights (a dated window has them too).
  const variants = Math.min(intIn(p.get("variants"), 1, 4, 1), nights > LONG_TRIP_NIGHTS ? MAX_VARIANTS_LONG : MAX_VARIANTS);
  const tripPath = wildPath(g, region, month, nights, style, budget, customKey(undefined, undefined, undefined, undefined, tradeoff, noHubs, from, to, exclude) + (variants > 1 ? `-v${variants}` : ""));
  const path = planPath(tripPath);
  if (!freshAllowed(p.get("fresh"))) {
    const stored = await readJson<Plan>(path);
    if (stored && stored.ageHours < 72) return NextResponse.json(stored.body, { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600", "X-Plan": "stored" } });
  }
  const trip = await readJson<WildTrip>(tripPath);
  if (!trip) return NextResponse.json({ error: "build the trip first" }, { status: 404, headers: { "Cache-Control": "no-store", "X-Plan-Trip": tripPath } });
  const { promise } = inflight.run(path, async () => {
    const plan = await planDays(trip.body, path);
    if (plan) await writeJson(path, plan).catch(() => null);
    return plan;
  });
  const plan = await promise;
  if (!plan) return NextResponse.json({ error: "the planner did not answer; try again in a minute" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(plan, { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600", "X-Plan": "live" } });
}
