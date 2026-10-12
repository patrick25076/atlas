import { parseExclude } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { findDeals, type FinderResult } from "@/lib/finder";
import { keepAlive, TtlLru } from "@/lib/memo";
import { bad, iataList, intIn, isoDay, latLon } from "@/lib/params";

// GET /api/finder?origins=OTP,SBZ,GHV&from=2026-10-20&to=2026-10-30&include=2026-10-26
//     &minNights=2&maxNights=6[&direct=1][&maxHours=6][&where=anywhere|Italy|Europe][&returnTo=CLJ,TSR]
//     [&exclude=RO,HU][&lat=45.65&lon=25.6][&exhaustive=1]
// The search pairs one-way tickets (lib/pairs.ts): out to anywhere and the nearest countries,
// home from the airports landed at to any airport of the home country within six hours of the
// traveller, with a train or coach between two cities when the ground graph says it is short,
// or a one-way flight on to a second city. lat/lon is where the traveller is, for the ground
// legs to and from the airports (without it, the origin airport nearest the others). A where
// naming only cities keeps Kiwi's returns.
// exhaustive=1 widens the search: airports reachable by train or coach within three hours of
// lat/lon join the origins, and every origin airport gets its own search of the same question
// (a multi-origin search only returns the cheapest origin); about five extra searches.
// maxHours=0 (or absent) means no limit on the flight length. exclude is the "Been" list
// (ISO2): targets in those countries are not searched and deals landing there are dropped;
// a connection through one is fine. When it leaves nothing to search the done line carries
// a note and 0 searches.
// A custom getaway search over a period, streamed as NDJSON: {"start":..}, {"progress":".."},
// {"deals":[..]} per search, {"done":{..}}. About 31 searches (1 + 12 out, 10 countries and up
// to 4 cities home, 3 hops and 1 home from them; 49 at most when exhaustive), half a minute to
// a minute; Kiwi's own 24-hour memo makes a repeat nearly free. The done line counts the pairs
// (outEdges, homeSearches, citySearches, hopSearches, pairs, twoCity, hops, otherHome, sent)
// and says when searches after the way out failed or were refused. The finished result is
// memoised 30 minutes, unless one of those searches failed (a partial answer).
export const maxDuration = 120;
const memo = new TtlLru<FinderResult>(500, 30 * 60_000);
/** Part of the memo key: a change of engine must not serve answers the old one gave. */
const ENGINE = "pairs-2";
/** The whole period must fit in a year: Kiwi has no fares further out. */
const MAX_SPAN_DAYS = 366;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const origins = iataList(p.get("origins"), 5);
  const from = isoDay(p.get("from"));
  const to = isoDay(p.get("to"));
  const includeRaw = p.get("include") || undefined;
  const include = includeRaw ? (isoDay(includeRaw) ?? undefined) : undefined;
  const minNights = intIn(p.get("minNights"), 1, 30, 2);
  const maxNights = Math.max(minNights, intIn(p.get("maxNights"), 1, 30, 7));
  const direct = p.get("direct") === "1";
  const maxHoursRaw = p.get("maxHours");
  // 0 or less is "no limit", the same as leaving it out (a negative must not clamp to one
  // hour and memoise an empty answer); a fraction rounds up (0.4 means "up to an hour"); the
  // rest is capped at 48 hours.
  const maxHoursNum = Number(maxHoursRaw);
  const maxHours = maxHoursRaw && Number.isFinite(maxHoursNum) && maxHoursNum > 0 ? Math.min(48, Math.ceil(maxHoursNum)) : undefined;
  const where = (p.get("where") ?? "anywhere").trim().slice(0, 80) || "anywhere";
  const tricks = p.get("tricks") === "1";
  const returnTo = iataList(p.get("returnTo"), 5);
  const exclude = parseExclude(p.get("exclude"));
  const exhaustive = p.get("exhaustive") === "1";
  // Where the traveller is: the ground leg home from another airport is timed to it, and the
  // exhaustive mode grows the origins with the airports a train or coach reaches from it.
  // Only when both are given: latLon(null, null) reads Number(null) as 0 and answers 0, 0 (the
  // Gulf of Guinea), which made every home airport but the traveller's own unreachable.
  const point = p.get("lat") && p.get("lon") ? (latLon(p.get("lat"), p.get("lon")) ?? undefined) : undefined;
  const origin = exhaustive ? point : undefined;
  if (!origins.length) return bad("origins must be a comma list of three-letter airport codes");
  if (!from || !to) return bad("from and to must be real dates, YYYY-MM-DD");
  if (to < from) return bad("to must not be before from");
  if (includeRaw && !include) return bad("include must be a date, YYYY-MM-DD");
  if (include && (include < from || include > to)) return bad("include must fall between from and to");
  const today = new Date().toISOString().slice(0, 10);
  if (to < today) return bad("the period is in the past");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_SPAN_DAYS) return bad("the period must be a year or less");
  if (maxHoursRaw && !Number.isFinite(Number(maxHoursRaw))) return bad("maxHours must be a number of hours, 0 for no limit");
  if (!/^[\p{L}\p{N} ,'&().-]+$/u.test(where)) return bad("where must be 'anywhere', a region or a country name");

  const key = JSON.stringify({ engine: ENGINE, origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, exclude, exhaustive, point });
  const hit = memo.get(key);
  if (hit) return Response.json(hit, { headers: { "Cache-Control": "private, max-age=300", "X-Finder": "memo" } });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          open = false;
        }
      };
      const alive = keepAlive(send);
      const say = (obj: unknown) => {
        alive.touch();
        send(obj);
      };
      say({ start: { origins, from, to, include, minNights, maxNights } });
      const t0 = Date.now();
      try {
        const result = await findDeals({ origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, exclude, exhaustive, origin, point, onDeals: (deals) => say({ deals }), onProgress: (line) => say({ progress: line }) });
        // Memoise a real answer only: deals, or a clean run that found none. A run where every
        // search failed (Kiwi throttling) must not become "no deals" for the next 30 minutes,
        // and neither may a run where any search for the way home failed, refused or not (a
        // 503 after retries, no reply, a place Kiwi does not resolve): that answer is partial.
        if ((result.deals.length || result.failed === 0) && !result.homeFailed) memo.set(key, result);
        // The usage log, never awaited: a slow database must not hold the stream open.
        // The been list itself stays in the browser; the log only counts how many countries it held.
        void logSearch("finder", { origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, exhaustive, excluded: exclude.length }, result.deals.length, Date.now() - t0).catch(() => null);
        const note = result.note ?? (!result.deals.length && result.failed > 0 ? `${result.failed} of ${result.searched + result.failed} searches failed; live prices may be rate-limited right now, try again in a few minutes` : undefined);
        const pairs =
          result.engine === "pairs"
            ? { engine: result.engine, outEdges: result.outEdges, homeSearches: result.homeSearches, citySearches: result.citySearches, hopSearches: result.hopSearches, homeFailed: result.homeFailed, homeRefused: result.homeRefused, pairs: result.pairs, twoCity: result.twoCity, hops: result.hops, otherHome: result.otherHome, sent: result.sent }
            : { engine: result.engine };
        say({ done: { searched: result.searched, failed: result.failed, openJaw: result.openJaw, count: result.deals.length, generatedAt: result.generatedAt, note, ...pairs } });
      } catch (err) {
        say({ error: err instanceof Error ? err.message : "search failed" });
      } finally {
        alive.stop();
        try {
          controller.close();
        } catch {
          // closed by the client
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Finder": "live" } });
}
