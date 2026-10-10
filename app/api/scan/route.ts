import { parseExclude } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { fmtCalendar, scanCheapest } from "@/lib/scan";
import { bad, iataList, intIn, isoMonth } from "@/lib/params";

// GET /api/scan?origins=OTP,SBZ&to=San%20Francisco&months=6&minNights=7&maxNights=21
//     [&oneWay=1][&openJawFrom=United%20States][&startMonth=2026-11][&text=1][&exclude=RO,HU]
// exclude is the "Been" list (ISO2): a destination in one of those countries is answered
// with a note and no search; fares landing in one are dropped; layovers are untouched.
// The price calendar: the cheapest fare per month for one destination from a set of airports.
// One live Kiwi search per month (three with open-jaw), minus the months the shared fare
// memory already covers; at most 12 months, 6 with open-jaw, so 18 searches at the most plus
// a retry each. Answers are kept in memory for an hour, except when a search failed: then the
// answer carries failed > 0, is not cached anywhere, and the failed months read "search
// failed" rather than "no fare". text=1 adds the chat table.
export const maxDuration = 180;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const origins = iataList(p.get("origins"), 5);
  const to = (p.get("to") ?? "").trim().slice(0, 60);
  const openJawFrom = (p.get("openJawFrom") ?? "").trim().slice(0, 60) || undefined;
  const months = intIn(p.get("months"), 1, openJawFrom ? 6 : 12, 6);
  const minNights = intIn(p.get("minNights"), 1, 90, 3);
  const maxNights = intIn(p.get("maxNights"), minNights, 90, Math.max(minNights, 14));
  const oneWay = p.get("oneWay") === "1";
  const startRaw = p.get("startMonth");
  const startMonth = startRaw ? (isoMonth(startRaw) ?? undefined) : undefined;
  const exclude = parseExclude(p.get("exclude"));
  if (!origins.length) return bad("origins must be a comma list of three-letter airport codes");
  if (!to) return bad("to is required: an airport code, a city or a country");
  if (startRaw && !startMonth) return bad("startMonth must be YYYY-MM");
  const t0 = Date.now();
  try {
    const result = await scanCheapest({ origins, to, months, minNights, maxNights, oneWay, openJawFrom, startMonth, exclude });
    const priced = result.months.some((m) => m.cheapest != null) || result.openJaw.length > 0;
    // The usage log, never awaited: results = months with a fare plus open-jaw pairs.
    void logSearch("scan", { origins, to, months, minNights, maxNights, oneWay, openJawFrom, startMonth, excluded: exclude.length }, result.months.filter((m) => m.cheapest != null).length + result.openJaw.length, Date.now() - t0).catch(() => null);
    // Every search refused and nothing priced: that is Kiwi throttling this address, not an empty calendar.
    if (!priced && result.searched === 0 && result.failed > 0) return Response.json({ error: "The flight search refused every request just now (Kiwi is throttling this address). Try again in a few minutes.", ...result }, { status: 502, headers: { "Cache-Control": "no-store" } });
    const body = p.get("text") === "1" ? { ...result, text: fmtCalendar(result) } : result;
    const cache = result.failed > 0 ? "no-store" : "public, s-maxage=1800, stale-while-revalidate=3600";
    return Response.json(body, { headers: { "Cache-Control": cache } });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "scan failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
