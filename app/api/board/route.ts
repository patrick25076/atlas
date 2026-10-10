import { buildBoard, resolveGateway, type Board } from "@/lib/board";
import { readBoard, writeBoard } from "@/lib/boards-store";
import type { Deal } from "@/lib/types";

// GET /api/board?from=LIS[&month=2026-11][&fresh=1]
// The cheapest getaways from one airport or city. A stored board younger than FRESH_HOURS is
// returned whole as JSON. Otherwise Kiwi is searched now and the answer streams as NDJSON:
// {"start":{...}} then {"deals":[...]} per search, then {"done":{...board meta}}; the finished
// board is stored for the next visitor.
const FRESH_HOURS = 14;
export const maxDuration = 60;

const inflight = new Map<string, Promise<Board>>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const from = (p.get("from") ?? "").toUpperCase();
  const month = p.get("month") ?? undefined;
  if (!/^[A-Z]{3}$/.test(from)) return Response.json({ error: "from (IATA airport or city code) required" }, { status: 400 });
  if (month && !/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });
  const gw = resolveGateway(from);
  if (!gw) return Response.json({ error: `unknown airport ${from}` }, { status: 404 });

  if (!p.get("fresh")) {
    const stored = await readBoard(from, month);
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
      send({ start: { gateway: from, label: gw.label, month } });
      try {
        // One search per gateway at a time; a second visitor waits for the same promise.
        let job = inflight.get(key);
        const mine = !job;
        if (!job) {
          job = buildBoard(from, {
            month,
            concurrency: 6,
            onDeals: (deals: Deal[]) => {
              if (deals.length) send({ deals });
            },
          });
          inflight.set(key, job);
        }
        const board = await job;
        if (mine) {
          inflight.delete(key);
          if (board.deals.length >= 10 && !board.partial) await writeBoard(board).catch(() => null);
        } else {
          send({ deals: board.deals });
        }
        send({ done: { ...board, deals: undefined } });
      } catch (err) {
        inflight.delete(key);
        send({ error: err instanceof Error ? err.message : "search failed" });
      } finally {
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
