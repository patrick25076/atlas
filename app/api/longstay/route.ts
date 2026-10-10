import { parseExclude } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { longStay, LongStayInputError } from "@/lib/longstay";
import { parseCities, parseCountries, REGIONS } from "@/lib/wild";
import { bad, iataList, intIn, iso2, isoMonth, latLon, oneOf } from "@/lib/params";

// GET /api/longstay?g=OTP,SBZ&home=RO&region=sea&months=2[&startMonth=2027-01][&budget=mid]
//     [&countries=Thailand,VN][&style=slow][&lat=..&lon=..&label=..][&exclude=RO,HU]
//     [&wishes=warm,+by+the+sea][&mustInclude=Lisbon,Porto]
// exclude is the "Been" list (ISO2): those countries leave the candidate bases before any
// search and are listed under `skipped` with the reason. countries takes names or codes;
// mustInclude (city names or codes; `cities` is an alias, the name the form sends) makes
// those the only bases; wishes is free text that
// tilts the ranking and is answered in each base's why lines. An unknown country or city is
// a 400 naming it.
// Bases for a stay of one to six months: eight candidates priced with a flight in (over the
// start month) and out (a three-week window anchored to the arrival plus the months asked),
// two live searches a base, sixteen in all plus a retry each at most; rent and living counted
// for the real days between the flights, side trips, climate, visa. Kept in memory for an
// hour per request, except when a search failed: then failed > 0 and nothing is cached.
export const maxDuration = 120;
const BUDGETS = ["backpacker", "mid", "comfort"] as const;
const STYLES = ["experiences", "beaches", "food", "cities", "slow"] as const;
const MAX_WISHES = 300;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 3);
  const home = iso2(p.get("home"));
  const region = p.get("region") ?? undefined;
  const countriesRaw = p.get("countries");
  const countriesParsed = parseCountries(countriesRaw);
  const countries = countriesParsed.codes.slice(0, 12);
  // The form sends the chosen bases as cities=; mustInclude is the same list under the engine's name.
  const mustRaw = p.get("mustInclude") ?? p.get("cities");
  const mustParsed = parseCities(mustRaw);
  const mustInclude = mustParsed.codes.slice(0, 8);
  const wishes = (p.get("wishes") ?? "").trim().slice(0, MAX_WISHES) || undefined;
  const months = intIn(p.get("months"), 1, 6, 2);
  const startRaw = p.get("startMonth");
  const startMonth = startRaw ? (isoMonth(startRaw) ?? undefined) : undefined;
  const budget = oneOf(p.get("budget"), BUDGETS, "mid");
  const style = oneOf(p.get("style"), STYLES, "experiences");
  const at = p.get("lat") != null || p.get("lon") != null ? latLon(p.get("lat"), p.get("lon")) : null;
  const origin = at ? { ...at, label: (p.get("label") ?? "home").slice(0, 60) } : undefined;
  const exclude = parseExclude(p.get("exclude"));
  if (!gateways.length) return bad("g must be a comma list of three-letter airport codes");
  if (!home) return bad("home must be a two-letter passport country code");
  if (countriesRaw && !countries.length) return bad(`none of those is a country we know: ${countriesParsed.unknown.join(", ")} (a name such as Portugal or a code such as PT)`);
  if (countriesParsed.unknown.length) return bad(`unknown country: ${countriesParsed.unknown.join(", ")}`);
  if (mustRaw && !mustInclude.length) return bad(`unknown city: ${mustParsed.unknown.join(", ")} (a city name such as Lisbon or a code such as LIS)`);
  if (mustParsed.unknown.length) return bad(`unknown city: ${mustParsed.unknown.join(", ")}`);
  if (!region && !countries.length && !mustInclude.length) return bad(`region (${Object.keys(REGIONS).join(", ")}), countries (names or codes) or mustInclude (cities) required`);
  // Own keys only: "constructor" passes an `in` check but is no region.
  if (region && !Object.hasOwn(REGIONS, region)) return bad(`region must be one of ${Object.keys(REGIONS).join(", ")}`);
  if (region === "custom" && !countries.length && !mustInclude.length) return bad("region custom needs countries (names or codes) or mustInclude (cities)");
  if (startRaw && !startMonth) return bad("startMonth must be YYYY-MM");
  if ((p.get("lat") != null || p.get("lon") != null) && !at) return bad("lat and lon must be coordinates");
  const t0 = Date.now();
  try {
    const r = await longStay({ gateways, home, region, countries: countries.length ? countries : undefined, months, startMonth, budget, style, origin, exclude, wishes, mustInclude: mustInclude.length ? mustInclude : undefined });
    const priced = r.bases.some((b) => b.flightIn || b.flightOut);
    // The usage log, never awaited; the visitor's coordinates, label and wish text stay out of it.
    void logSearch("longstay", { gateways, home, region, countries, months, startMonth, budget, style, excluded: exclude.length, mustInclude, wishes: !!wishes }, r.bases.length, Date.now() - t0).catch(() => null);
    if (!priced && r.searched === 0 && r.failed > 0) return Response.json({ error: "The flight search refused every request just now (Kiwi is throttling this address). Try again in a few minutes.", ...r }, { status: 502, headers: { "Cache-Control": "no-store" } });
    const cache = r.failed > 0 ? "no-store" : "public, s-maxage=1800, stale-while-revalidate=3600";
    return Response.json(r, { headers: { "Cache-Control": cache } });
  } catch (err) {
    // A request the engine cannot answer as asked is the caller's mistake, not an upstream failure.
    if (err instanceof LongStayInputError) return bad(err.message);
    return Response.json({ error: err instanceof Error ? err.message : "long stay search failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
