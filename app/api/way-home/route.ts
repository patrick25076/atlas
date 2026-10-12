import { TtlLru } from "@/lib/memo";
import { newRun, saveRun, small, step, withRun } from "@/lib/run-log";
import { bad, iataList, iso2, isoDay, latLon, today } from "@/lib/params";
import { homeCountryOf, wayHome, WayHomeInputError, WAY_HOME_MAX_DAYS, type WayHomeResult } from "@/lib/way-home";

// GET /api/way-home?from=Gdansk&fromDate=2026-10-29&toDate=2026-10-31[&code=GDN][&cc=PL][&direct=1][&home=RO&lat=45.657&lon=25.601][&g=GHV,OTP]
// The way back home from a city, town or airport over a range of days, as a calendar (lib/way-home.ts, shared with
// the chat's way_home tool): per day the cheapest flight and the cheapest direct one, the best direct, the cheapest
// overall and door to door, and the ground leg from each home airport to the traveller (home, lat and lon). g lists
// the traveller's own airports, shown first. Without a home point the app's default traveller (Brasov, Romania) is
// assumed and the answer says so. The window is at most 14 days; a first day in the past starts today.
// code (a city or airport code, such as a trip stop's) and cc (the place's country) decide between places of one
// name: Florence with code=FLR is Italy, never South Carolina. Without them a shared name is read as the one nearest
// the traveller's home point. from may be left out when code is given.
// JSON: { days: [{ date, cheapest?, direct? }], bestDirect?, cheapest?, cheapestDoorToDoor?, homeLegs: [{ airport,
// minutes, price, ... }], searched, note?, ... }. Searches: one or two one-way searches over the window, then up to
// two more (four with direct=1) aimed at one home airport each; six at most, and a repeat within a day is free
// (Kiwi's memo). Answers are kept 30 minutes, unless a search failed or was refused.
export const maxDuration = 60;

const memo = new TtlLru<WayHomeResult>(300, 30 * 60_000);
/** The app's default traveller (components/Globe.tsx DEFAULT_ORIGIN). */
const DEFAULT_POINT = { lat: 45.6579, lon: 25.6012, label: "Brașov" };
const DEFAULT_HOME = "RO";
/** A place name as cities.json writes them, "Leipzig/Halle" and "Metz/Nancy" included (the same as lib/trip-result.ts TEXT). */
const PLACE = /^[\p{L}\p{N} ,.'()&/-]{1,80}$/u;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = (p.get("from") ?? "").trim();
  const codeRaw = (p.get("code") ?? "").trim().toUpperCase();
  if (codeRaw && !/^[A-Z]{3}$/.test(codeRaw)) return bad("code must be a city or airport code, such as FLR");
  const ccRaw = p.get("cc");
  const cc = ccRaw ? iso2(ccRaw) : null;
  if (ccRaw && !cc) return bad("cc must be a two-letter country code, such as IT");
  if (!from && !codeRaw) return bad("from must be a city, town or airport, such as Gdansk or GDN");
  if (from && !PLACE.test(from)) return bad("from must be a city, town or airport, such as Gdansk or GDN");
  const fromRaw = isoDay(p.get("fromDate"));
  const toRaw = isoDay(p.get("toDate"));
  if (!fromRaw || !toRaw) return bad("fromDate and toDate must be real dates, YYYY-MM-DD");
  if (toRaw < fromRaw) return bad("toDate must not be before fromDate");
  const first = today();
  if (toRaw < first) return bad("the window is in the past");
  const fromDate = fromRaw < first ? first : fromRaw;
  const span = (Date.parse(toRaw) - Date.parse(fromDate)) / 86_400_000;
  if (span > 366) return bad("the window must be within a year");
  const toDate = span > WAY_HOME_MAX_DAYS - 1 ? new Date(Date.parse(fromDate) + (WAY_HOME_MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10) : toRaw;
  const direct = p.get("direct") === "1" || p.get("direct") === "true";
  const hasPoint = p.get("lat") != null || p.get("lon") != null;
  const point = hasPoint ? latLon(p.get("lat"), p.get("lon")) : null;
  if (hasPoint && !point) return bad("lat and lon must be a point on Earth");
  const homeRaw = p.get("home");
  const home = homeRaw ? iso2(homeRaw) : null;
  if (homeRaw && !home) return bad("home must be a two-letter country code, such as RO");
  const g = p.get("g");
  const gateways = g ? iataList(g, 5) : [];
  if (g && !gateways.length) return bad("g must be airport codes, such as g=GHV,OTP");
  const notes: string[] = [];
  if (fromDate !== fromRaw) notes.push(`the first day was in the past; searched from today, ${fromDate}`);
  if (toDate !== toRaw) notes.push(`the window was cut to ${WAY_HOME_MAX_DAYS} days, ${fromDate} to ${toDate}`);
  let origin: { lat: number; lon: number; label?: string };
  let homeCountry: string;
  if (point) {
    origin = { ...point, label: (p.get("label") ?? "").trim().slice(0, 60) || "home" };
    homeCountry = home ?? homeCountryOf(point.lat, point.lon) ?? DEFAULT_HOME;
  } else if (home && home !== DEFAULT_HOME) {
    return bad("lat and lon are needed with a home country other than RO, to time the way from the airport to the door");
  } else {
    origin = DEFAULT_POINT;
    homeCountry = DEFAULT_HOME;
    notes.push("no home point given; timed to Brasov, Romania");
  }

  const key = JSON.stringify([from.toLowerCase(), codeRaw, cc, fromDate, toDate, direct, homeCountry, origin.lat.toFixed(3), origin.lon.toFixed(3), gateways]);
  const hit = memo.get(key);
  if (hit) return Response.json(withNotes(hit, notes), { headers: { "Cache-Control": "private, max-age=300", "X-Way-Home": "memo" } });
  // The run log (the engine room's Live tab): the question and a short form of the calendar it answered.
  const rec = newRun(request, { kind: "way-home", source: "Trip page", title: `Ways home from ${from || codeRaw}, ${fromDate} to ${toDate}${direct ? ", direct" : ""}`, input: { from: from || codeRaw, code: codeRaw, cc, fromDate, toDate, direct, home: homeCountry, gateways } });
  const t0 = Date.now();
  try {
    const r = await withRun(rec, () => wayHome({ from: from || codeRaw, ...(codeRaw ? { code: codeRaw } : {}), ...(cc ? { country: cc } : {}), fromDate, toDate, direct, home: homeCountry, origin, gateways }));
    if (!r.failed && !r.refused) memo.set(key, r);
    if (rec) {
      step("engine", `Ways home: ${r.days.filter((d) => d.cheapest || d.direct).length} days with a flight, ${r.searched} live searches${r.failed ? `, ${r.failed} failed` : ""}`, { ms: Date.now() - t0, ...(r.refused ? { error: "live prices rate-limited" } : {}), data: small(r) }, rec);
      await saveRun(rec);
    }
    return Response.json(withNotes(r, notes), { headers: { "Cache-Control": "private, max-age=300", "X-Way-Home": "live" } });
  } catch (err) {
    if (rec) {
      rec.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
      await saveRun(rec);
    }
    if (err instanceof WayHomeInputError) return bad(err.message);
    console.log(`way-home: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return Response.json({ error: "the way home could not be searched right now" }, { status: 502 });
  }
}

function withNotes(r: WayHomeResult, notes: string[]): WayHomeResult {
  return notes.length ? { ...r, note: [...notes, r.note].filter(Boolean).join("; ") } : r;
}
