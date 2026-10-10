import { parseExclude } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { findDeals, type FinderResult } from "@/lib/finder";
import { keepAlive, TtlLru } from "@/lib/memo";
import { bad, iataList, intIn, isoDay } from "@/lib/params";

// GET /api/finder?origins=OTP,SBZ,GHV&from=2026-10-20&to=2026-10-30&include=2026-10-26
//     &minNights=2&maxNights=6[&direct=1][&maxHours=6][&where=anywhere|Italy|Europe][&returnTo=CLJ,TSR]
//     [&exclude=RO,HU]
// maxHours=0 (or absent) means no limit on the flight length. exclude is the "Been" list
// (ISO2): targets in those countries are not searched and deals landing there are dropped;
// a connection through one is fine. When it leaves nothing to search the done line carries
// a note and 0 searches.
// A custom getaway search over a period, streamed as NDJSON: {"start":..}, {"progress":".."},
// {"deals":[..]} per search, {"done":{..}}. About 20 live searches (40 with open-jaw, a few
// more with tricks), half a minute to a minute. The finished result is memoised 30 minutes.
export const maxDuration = 120;
const memo = new TtlLru<FinderResult>(500, 30 * 60_000);
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

  const key = JSON.stringify({ origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, exclude });
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
        const result = await findDeals({ origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, exclude, onDeals: (deals) => say({ deals }), onProgress: (line) => say({ progress: line }) });
        // Memoise a real answer only: deals, or a clean run that found none. A run where every
        // search failed (Kiwi throttling) must not become "no deals" for the next 30 minutes.
        if (result.deals.length || result.failed === 0) memo.set(key, result);
        // The usage log, never awaited: a slow database must not hold the stream open.
        // The been list itself stays in the browser; the log only counts how many countries it held.
        void logSearch("finder", { origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, tricks, excluded: exclude.length }, result.deals.length, Date.now() - t0).catch(() => null);
        const note = result.note ?? (!result.deals.length && result.failed > 0 ? `${result.failed} of ${result.searched + result.failed} searches failed; live prices may be rate-limited right now, try again in a few minutes` : undefined);
        say({ done: { searched: result.searched, failed: result.failed, openJaw: result.openJaw, count: result.deals.length, generatedAt: result.generatedAt, note } });
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
