import { NextResponse } from "next/server";
import { readJson, writeJson } from "@/lib/boards-store";
import { planDays, planPath, type Plan } from "@/lib/plan";
import { wildPath, type Budget, type Style, type WildTrip } from "@/lib/wild";
import { mainGateway } from "@/lib/board";

// GET /api/plan?g=OTP&region=sea&nights=14[&month=][&style=][&budget=][&fresh=1]
// The day-by-day plan of a stored wild trip: experiences, food, costs, a month's rent. Built
// once (a minute), then stored next to the trip.
export const maxDuration = 120;
const inflight = new Map<string, Promise<Plan | null>>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = (p.get("g") ?? "").split(",").map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{3}$/.test(x)).slice(0, 3);
  const g = gateways.length ? mainGateway(gateways) : "";
  const region = p.get("region") ?? "sea";
  const nights = Math.min(28, Math.max(7, Number(p.get("nights")) || 14));
  const month = p.get("month") ?? undefined;
  const style = (p.get("style") ?? "experiences") as Style;
  const budget = (p.get("budget") ?? "mid") as Budget;
  if (!/^[A-Z]{3}$/.test(g)) return NextResponse.json({ error: "g (airport code) required" }, { status: 400 });
  const tripPath = wildPath(g, region, month, nights, style, budget);
  const path = planPath(tripPath);
  if (!p.get("fresh")) {
    const stored = await readJson<Plan>(path);
    if (stored && stored.ageHours < 72) return NextResponse.json(stored.body, { headers: { "Cache-Control": "public, s-maxage=1800", "X-Plan": "stored" } });
  }
  const trip = await readJson<WildTrip>(tripPath);
  if (!trip) return NextResponse.json({ error: "build the trip first" }, { status: 404 });
  let job = inflight.get(path);
  if (!job) {
    job = planDays(trip.body, path).then(async (plan) => {
      if (plan) await writeJson(path, plan).catch(() => null);
      inflight.delete(path);
      return plan;
    });
    inflight.set(path, job);
  }
  const plan = await job;
  if (!plan) return NextResponse.json({ error: "the planner did not answer; try again in a minute" }, { status: 502 });
  return NextResponse.json(plan, { headers: { "Cache-Control": "public, s-maxage=1800", "X-Plan": "live" } });
}
