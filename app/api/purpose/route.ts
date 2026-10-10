import { NextResponse } from "next/server";
import { parseExclude } from "@/lib/been";
import { purposeTrips, type PurposeTrips } from "@/lib/purpose";
import { InFlight, TtlLru } from "@/lib/memo";
import { bad, iataList, intIn, isoDay } from "@/lib/params";

// GET /api/purpose?g=OTP,SBZ&from=2026-10-15&to=2026-12-15[&kinds=festival,sport][&live=4][&exclude=RO,HU]
// kinds is free text, comma separated: a kind (festival, sport, culture, season, music, food),
// a word of an event's name ("carnival", "marathon", "lanterns"), a city ("Edinburgh") or a
// country code; an event matches any one of them.
// exclude is the "Been" list (ISO2): events in those countries are hidden, no search spent.
// Events worth flying for in a window, each with the cheapest way there: the stored boards
// first, then up to `live` Kiwi searches for the events the boards miss. Memoised an hour,
// except when every live search of the run failed (throttling): that answer is returned
// once with a note and not kept, so the next visitor searches again. The body carries
// `searched` and `failed` (this run's live searches and how many Kiwi refused) so the chat
// can budget on exact numbers; a memo hit repeats the counts of the run that produced it.
export const maxDuration = 90;
const memo = new TtlLru<PurposeTrips>(500, 3_600_000);
const inflight = new InFlight<PurposeTrips>();
const CACHE = { "Cache-Control": "public, max-age=900, stale-while-revalidate=3600" };
/** A kind, a word of a name, a city: letters, digits, spaces, hyphens and apostrophes, 2 to 40 long. */
const KIND = /^[\p{L}\p{N}' -]{2,40}$/u;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 4);
  const from = isoDay(p.get("from"));
  const to = isoDay(p.get("to"));
  const kinds = (p.get("kinds") ?? "").split(",").map((k) => k.trim().toLowerCase()).filter((k) => KIND.test(k)).slice(0, 8);
  const live = intIn(p.get("live"), 0, 8, 4);
  const exclude = parseExclude(p.get("exclude"));
  if (!gateways.length) return bad("g must be a comma list of three-letter airport codes");
  if (!from || !to) return bad("from and to must be real dates, YYYY-MM-DD");
  if (to < from) return bad("to must not be before from");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) return bad("the window must be 400 days or less");
  const key = `${gateways.join(",")}|${from}|${to}|${kinds}|${live}|${exclude.join(",")}`;
  const hit = memo.get(key);
  // JSON.stringify drops the counts hung on the array, so they are spread into the body by hand.
  if (hit) return NextResponse.json({ trips: hit, searched: hit.searched, failed: hit.failed }, { headers: { ...CACHE, "X-Purpose": "memo" } });
  try {
    // lib/purpose.ts swallows each failed live search (the event stays unpriced) and counts
    // this run's own searches, so the counts say whether its live searches all failed, with
    // no help from the gate's process-wide counters (other routes move those too).
    const { promise } = inflight.run(key, () => purposeTrips(gateways, from, to, { live, kinds, exclude }));
    const trips = await promise;
    const { searched, failed } = trips;
    const allLiveFailed = searched > 0 && failed >= searched && !trips.some((t) => t.source === "live");
    if (!allLiveFailed) memo.set(key, trips);
    const note = allLiveFailed ? "live prices are rate-limited right now; events without a stored fare are unpriced, try again in a few minutes" : undefined;
    return NextResponse.json({ trips, searched, failed, note }, { headers: { ...(allLiveFailed ? { "Cache-Control": "no-store" } : CACHE), "X-Purpose": allLiveFailed ? "live-failed" : "live" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "the event search failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
