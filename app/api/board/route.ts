import { buildBoard, resolveGateway, type Board } from "@/lib/board";
import { readBoard, writeBoard } from "@/lib/boards-store";
import { logSearch } from "@/lib/db";
import { InFlight, keepAlive } from "@/lib/memo";
import { bad, iata, isoMonth } from "@/lib/params";
import type { Deal } from "@/lib/types";
import { DESTINATIONS } from "@/scripts/ingest/destinations";

// GET /api/board?from=LIS[&month=2026-11][&fresh=<token>]
// The cheapest getaways from one airport or city. A stored board younger than FRESH_HOURS is
// returned whole as JSON. Otherwise Kiwi is searched now (about 35 searches, up to a minute;
// about 140 for a home-market airport, which also gets the favourite destinations one by one)
// and the answer streams as NDJSON: {"start":{...}} then {"deals":[...]} per search, a
// {"progress":"..."} line whenever nothing else was sent for 15 s, then {"done":{...board
// meta}}; the finished board is stored for the next visitor. `fresh` bypasses the stored
// board only with the shared token (ATLAS_FRESH_TOKEN), so a public URL cannot be reloaded
// into 35 searches a time.
//
// The nightly job (01:00 UTC, scripts/ingest/boards.ts) rebuilds the ~150 popular boards;
// FRESH_HOURS is longer than a day so a nightly board lasts until the next run with slack
// and the evening visitors never trigger a rebuild that would replace it.
const FRESH_HOURS = 26;
/** A stored board older than this is replaced by a live one even when the live one is thinner: the nightly job has clearly missed. */
const REPLACE_AFTER_HOURS = 48;
export const maxDuration = 120;

/**
 * Home-market airports: the same list as scripts/ingest/boards.ts (keep the two in step),
 * so a live rebuild of one of these searches the favourite destinations too and comes out
 * the same shape as the nightly board instead of a thinner one.
 */
const HOME = ["OTP", "CLJ", "IAS", "TSR", "SBZ", "GHV", "CRA"];

/** One search per gateway and month at a time; a second visitor joins the same promise. */
const inflight = new InFlight<Board>();

function freshAllowed(v: string | null): boolean {
  const token = process.env.ATLAS_FRESH_TOKEN?.trim();
  return !!token && !!v && v === token;
}

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = iata(p.get("from"));
  if (!from) return bad("from must be a three-letter IATA airport or city code");
  const monthRaw = p.get("month");
  const month = monthRaw ? (isoMonth(monthRaw) ?? undefined) : undefined;
  if (monthRaw && !month) return bad("month must be YYYY-MM");
  if (month && month < new Date().toISOString().slice(0, 7)) return bad("month is in the past");
  const gw = resolveGateway(from);
  if (!gw) return Response.json({ error: `unknown airport ${from}` }, { status: 404 });

  const stored = await readBoard(from, month);
  if (!freshAllowed(p.get("fresh"))) {
    if (stored && stored.ageHours < FRESH_HOURS) {
      return Response.json(stored.board, { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600", "X-Board": "stored" } });
    }
  }

  const key = `${from}|${month ?? ""}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A visitor who leaves mid-search must not abort the search: the board still gets stored.
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
      say({ start: { gateway: from, label: gw.label, month } });
      const t0 = Date.now();
      try {
        const { promise, mine } = inflight.run(key, () =>
          buildBoard(from, {
            month,
            extraCities: HOME.includes(from) ? DESTINATIONS : [],
            concurrency: 6,
            onDeals: (deals: Deal[]) => {
              if (deals.length) say({ deals });
            },
          }),
        );
        const board = await promise;
        if (mine) {
          // The usage log for a live build only (a stored board costs nothing); never awaited.
          void logSearch("board", { from, month, home: HOME.includes(from), searched: board.searched, failed: board.failed }, board.deals.length, Date.now() - t0).catch(() => null);
          // Store a real board, and never let a thinner live rebuild replace a richer stored one
          // (a throttled run finds fewer deals) unless the stored one is clearly abandoned.
          const richerStored = stored && stored.board.deals.length > board.deals.length && stored.ageHours < REPLACE_AFTER_HOURS;
          if (board.deals.length >= 10 && !board.partial && !richerStored) await writeBoard(board).catch(() => null);
        } else {
          say({ deals: board.deals });
        }
        const note = !board.deals.length && board.failed > 0 ? "live prices may be rate-limited right now; try again in a few minutes" : undefined;
        say({ done: { ...board, deals: undefined, note } });
      } catch (err) {
        say({ error: err instanceof Error ? err.message : "search failed" });
      } finally {
        alive.stop();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Board": "live" } });
}
