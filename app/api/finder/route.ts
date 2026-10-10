import { findDeals, type FinderResult } from "@/lib/finder";

// GET /api/finder?origins=OTP,SBZ,GHV&from=2026-10-20&to=2026-10-30&include=2026-10-26
//     &minNights=2&maxNights=6[&direct=1][&maxHours=6][&where=anywhere|Italy|Europe][&returnTo=CLJ,TSR]
// A custom getaway search over a period, streamed as NDJSON: {"start":..}, {"deals":[..]} per
// search, {"done":{..}}. About 20 live searches (40 with open-jaw), half a minute.
export const maxDuration = 90;
const memo = new Map<string, { at: number; result: FinderResult }>();
const TTL = 30 * 60_000;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const origins = (p.get("origins") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s)).slice(0, 5);
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const include = p.get("include") || undefined;
  const minNights = Math.min(30, Math.max(1, Number(p.get("minNights")) || 2));
  const maxNights = Math.min(30, Math.max(minNights, Number(p.get("maxNights")) || 7));
  const direct = p.get("direct") === "1";
  const maxHours = Number(p.get("maxHours")) || undefined;
  const where = (p.get("where") ?? "anywhere").slice(0, 80);
  const returnTo = (p.get("returnTo") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s)).slice(0, 5);
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!origins.length || !day.test(from) || !day.test(to) || to < from || (include && !day.test(include))) {
    return Response.json({ error: "origins (codes), from and to (YYYY-MM-DD) required; optional include, minNights, maxNights, direct, maxHours, where, returnTo" }, { status: 400 });
  }
  const key = JSON.stringify({ origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo });
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return Response.json(hit.result, { headers: { "X-Finder": "memo" } });

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
      send({ start: { origins, from, to, include, minNights, maxNights } });
      try {
        const result = await findDeals({ origins, from, to, include, minNights, maxNights, direct, maxHours, where, returnTo, onDeals: (deals) => send({ deals }), onProgress: (line) => send({ progress: line }) });
        memo.set(key, { at: Date.now(), result });
        send({ done: { searched: result.searched, failed: result.failed, openJaw: result.openJaw, count: result.deals.length, generatedAt: result.generatedAt } });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "search failed" });
      } finally {
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
