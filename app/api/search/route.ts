import { logSearch } from "@/lib/db";
import { keepAlive } from "@/lib/memo";
import { bad } from "@/lib/params";
import { checkSearch, runSearch, SearchInputError, type SearchLine } from "@/lib/search";
import { parseSearchQuery } from "@/lib/trip-result";

// GET /api/search?q=<encoded SearchQuery JSON>   (the contract: lib/trip-result.ts, docs/plans/one-search.md)
// The one search: the flight graph first (no Kiwi search), then the live engines the query calls for, within a
// budget of live searches (q.budget, default 25, at most 60; 0 answers from stored prices alone). Streamed as NDJSON,
// one object a line:
//   {"progress": "..."}           what it is doing, never silent for more than 15 s
//   {"graph": true}               the flight graph answered; its results are the next line
//   {"results": [TripResult...]}  new or cheaper results as each engine answers; ids are stable, so merge by id
//   {"done": {count, searched, engines, note?}}   last; count is what passes the filters, at most 60
//   {"error": "..."}              instead of done, when the search broke
// A bad query is a 400 before the stream starts. The filter chips (q.filters) are applied to what is sent but are
// not part of the memo key, so a chip change answers from the memo; an answer is kept 30 minutes unless a search
// was refused or failed. Searches: 0 when the memo or the graph answers alone; otherwise what the chosen engines
// spend, at most the budget (the paired search may run past it once, and says so, when the graph had nothing).
export const maxDuration = 300;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("q");
  if (!raw) return bad("q must be the search as JSON: { from, to, when, ... }");
  if (raw.length > 8_000) return bad("q is too long");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return bad("q must be valid JSON");
  }
  const parsed = parseSearchQuery(json);
  if ("error" in parsed) return bad(parsed.error);
  const query = parsed.query;
  const problem = checkSearch(query);
  if (problem) return bad(problem);

  const encoder = new TextEncoder();
  // The client leaving (a new search, a closed tab) stops this caller listening, so a repeat of the
  // same search joins the run live instead of waiting behind an orphan, and a run nobody follows
  // starts no live engine it has not started yet.
  const leave = new AbortController();
  request.signal.addEventListener("abort", () => leave.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      leave.abort();
    },
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
      const say = (line: SearchLine | { error: string }) => {
        alive.touch();
        send(line);
      };
      const t0 = Date.now();
      try {
        const done = await runSearch(query, say, leave.signal);
        if (leave.signal.aborted) return;
        say({ done });
        // The usage log, never awaited: the kind of search, never the traveller's place or names.
        const where = query.to.kind === "anywhere" ? "anywhere" : query.to.kind === "region" ? `region:${query.to.key}` : `${query.to.kind}:${query.to.name}`;
        void logSearch("search", { to: where, when: query.when.kind, shape: query.shape ?? "any", advanced: Object.keys(query.advanced ?? {}), budget: query.budget, excluded: query.exclude?.length ?? 0, searched: done.searched, engines: done.engines }, done.count, Date.now() - t0).catch(() => null);
      } catch (err) {
        if (leave.signal.aborted) return;
        say({ error: err instanceof SearchInputError ? err.message : err instanceof Error ? err.message.slice(0, 200) : "the search failed" });
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
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}
