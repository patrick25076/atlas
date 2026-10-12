import { NextResponse } from "next/server";
import { parseExclude } from "@/lib/been";
import { readJson, writeJson } from "@/lib/boards-store";
import { planDays, planPath, type Plan } from "@/lib/plan";
import { customKey, parseCities, parseCountries, parseNightsRange, wildPath, REGIONS, type Budget, type Style, type Tradeoff, type WildTrip } from "@/lib/wild";
import { mainGateway } from "@/lib/board";
import { avoidCountryCodes, engineKeySuffix, readAvoid } from "@/lib/wild-walk";
import { InFlight } from "@/lib/memo";
import { bad, iataList, intIn, isoDay, isoMonth, oneOf } from "@/lib/params";

// GET /api/plan?g=OTP&region=sea&nights=14[&month=][&from=&to=][&style=][&budget=][&tradeoff=][&noHubs=1][&variants=3][&exclude=TH,VN]
//     [&countries=][&prefer=][&maxStops=][&nightsPerStop=3-5][&mustInclude=][&maxFlightHours=][&startFrom=][&wishes=][&fresh=<token>]
//     [&engine=walk|classic][&avoid=][&ground=][&searches=][&style=unique]
// The day-by-day plan of a stored wild trip: experiences, food, costs, a month's rent. Built
// once (one to two minutes of model and research calls), then stored next to the trip. Two
// visitors asking for the same plan share one build. The trip is looked up under exactly the
// key /api/wild stored it with, so every parameter that shapes that key (month or window,
// style, budget, tradeoff, noHubs, variants, exclude, countries, prefer, maxStops,
// nightsPerStop, mustInclude, maxFlightHours, startFrom, wishes, and the engine with its own: avoid, ground,
// searches, style=unique as wishes; walk is the default and classic is used when variants > 1 or startFrom is
// given, exactly as /api/wild decides) is accepted here with the
// same validation and clamps (a window wider than ten days is clipped to from + 10 days, as
// /api/wild clips it, so the key matches; the been list becomes the same token; names become
// the same codes); a caller must send what it sent to /api/wild. No Kiwi searches. `fresh`
// rebuilds only with the shared token (ATLAS_FRESH_TOKEN): a plan costs a minute of model
// calls and about ten Tavily searches.
export const maxDuration = 300;
const inflight = new InFlight<Plan | null>();
const STYLES = ["experiences", "beaches", "food", "cities", "slow"] as const;
const BUDGETS = ["backpacker", "mid", "comfort"] as const;
const TRADEOFFS = ["price", "balanced", "comfort"] as const;
/** Same bounds as /api/wild, so a plan key always matches a trip key. */
const MIN_NIGHTS = 5;
const MAX_NIGHTS = 90;
const MAX_WINDOW_DAYS = 10;
const LONG_TRIP_NIGHTS = 28;
const MAX_VARIANTS = 3;
const MAX_VARIANTS_LONG = 2;
const MAX_FLIGHT_HOURS = 40;
const MAX_WISHES = 300;
const ENGINES = ["walk", "classic"] as const;
/** The same words /api/wild adds to the wishes for style=unique, so the key's wishes hash matches. */
const UNIQUE_WORDS = "unique places and hidden gems over the big hubs";
const MAX_SEARCHES = 40;

function freshAllowed(v: string | null): boolean {
  const token = process.env.ATLAS_FRESH_TOKEN?.trim();
  return !!token && !!v && v === token;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 3);
  if (!gateways.length) return bad("g must be a comma list of three-letter airport codes");
  const g = mainGateway(gateways);
  const regionRaw = (p.get("region") ?? "sea").toLowerCase();
  // Own keys only: "constructor" passes an `in` check but is no region.
  if (!Object.hasOwn(REGIONS, regionRaw)) return bad(`region must be one of ${Object.keys(REGIONS).join(", ")}`);
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
  // The traveller's constraints, read exactly as /api/wild reads them (names become codes).
  const countriesRaw = p.get("countries");
  const countriesParsed = parseCountries(countriesRaw);
  const countries = countriesParsed.codes.length ? countriesParsed.codes.slice(0, 8) : undefined;
  // /api/wild stores a trip with a country list under the custom key whatever region was named; same here.
  const region = countries ? "custom" : regionRaw;
  if (countriesRaw && !countries) return bad(`none of those is a country we know: ${countriesParsed.unknown.join(", ")}`);
  if (countriesParsed.unknown.length) return bad(`unknown country: ${countriesParsed.unknown.join(", ")}`);
  const preferParsed = parseCountries(p.get("prefer"));
  if (preferParsed.unknown.length) return bad(`unknown country in prefer: ${preferParsed.unknown.join(", ")}`);
  const prefer = preferParsed.codes.length ? preferParsed.codes.slice(0, 8) : undefined;
  const maxStopsRaw = p.get("maxStops");
  const maxStops = maxStopsRaw ? intIn(maxStopsRaw, 1, 8, 0) || undefined : undefined;
  const nightsRangeRaw = p.get("nightsPerStop");
  const nightsRange = nightsRangeRaw ? parseNightsRange(nightsRangeRaw) : null;
  if (nightsRangeRaw && !nightsRange) return bad("nightsPerStop must be a number or a range such as 3-5");
  const nightsPerStop = nightsRange ? Math.min(30, nightsRange[0]) : undefined;
  // The top of the range is always passed, also when it equals the bottom: "2" (the trip style's "at most 2 a place")
  // is exactly two nights, never the engines' old two-or-three. The key writes it as n2-2.
  const nightsPerStopMax = nightsRange ? Math.min(30, nightsRange[1]) : undefined;
  const mustRaw = p.get("mustInclude");
  const mustParsed = parseCities(mustRaw);
  const mustInclude = mustParsed.codes.length ? mustParsed.codes.slice(0, 8) : undefined;
  if (mustRaw && !mustInclude) return bad(`unknown city to pass through: ${mustParsed.unknown.join(", ")}`);
  if (mustParsed.unknown.length) return bad(`unknown city to pass through: ${mustParsed.unknown.join(", ")}`);
  const hoursRaw = p.get("maxFlightHours");
  const hoursNum = hoursRaw ? Number(hoursRaw) : NaN;
  const maxFlightHours = hoursRaw && Number.isFinite(hoursNum) && hoursNum >= 1 && hoursNum <= MAX_FLIGHT_HOURS ? Math.round(hoursNum) : undefined;
  if (hoursRaw && !maxFlightHours) return bad(`maxFlightHours must be a number from 1 to ${MAX_FLIGHT_HOURS}`);
  const startFromRaw = p.get("startFrom");
  const startFrom = startFromRaw ? iataList(startFromRaw, 3) : [];
  if (startFromRaw && !startFrom.length) return bad("startFrom must be a comma list of three-letter airport codes");
  const uniqueAsked = (p.get("style") ?? "").trim().toLowerCase() === "unique";
  const wishesRaw = (p.get("wishes") ?? "").trim();
  const wishes = [wishesRaw, uniqueAsked && !/unique|hidden gem|off the beaten/i.test(wishesRaw) ? UNIQUE_WORDS : ""].filter(Boolean).join(", ").slice(0, MAX_WISHES) || undefined;
  // The engine and its parameters, read as /api/wild reads them, so the key is the one the trip was stored under.
  const engineRaw = p.get("engine");
  if (engineRaw && !(ENGINES as readonly string[]).includes(engineRaw)) return bad("engine must be walk or classic");
  const engineAsked = oneOf(engineRaw, ENGINES, "walk");
  const engine: "walk" | "classic" = engineAsked === "classic" || variants > 1 || startFrom.length ? "classic" : "walk";
  const avoidParsed = readAvoid(p.get("avoid"));
  if (avoidParsed.unknown.length) return bad(`unknown place to avoid: ${avoidParsed.unknown.join(", ")}`);
  const groundRaw = p.get("ground");
  if (groundRaw && !Number.isFinite(Number(groundRaw))) return bad("ground must be minutes from 0 to 720");
  const ground = groundRaw != null && groundRaw !== "" ? intIn(groundRaw, 0, 720, 330) : undefined;
  const searchesRaw = p.get("searches");
  if (searchesRaw && !Number.isFinite(Number(searchesRaw))) return bad(`searches must be a number from 0 to ${MAX_SEARCHES}`);
  const searches = searchesRaw != null && searchesRaw !== "" ? intIn(searchesRaw, 0, MAX_SEARCHES, 0) : undefined;
  const avoidCodes = [...avoidCountryCodes(avoidParsed.words)];
  const engineExclude = engine === "classic" && avoidCodes.length ? [...new Set([...exclude, ...avoidCodes])] : exclude;
  const extras = { mustInclude, maxFlightHours, startFrom: startFrom.length ? startFrom : undefined, wishes, nightsPerStopMax };
  const suffix = engineKeySuffix({ engine, avoid: avoidParsed.words, ground, searches });
  const tripPath = wildPath(g, region, month, nights, style, budget, customKey(countries, prefer, maxStops, nightsPerStop, tradeoff, noHubs, from, to, engineExclude, extras) + suffix + (variants > 1 ? `-v${variants}` : ""));
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
