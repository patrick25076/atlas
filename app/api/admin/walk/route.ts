import { adminAllowed, adminRefused } from "@/lib/admin";
import { walkTrips, type WalkEvent } from "@/lib/graph-walk";

// GET /api/admin/walk?q=<json>: the graph walk with its trace on, every event streamed as it happens (NDJSON, one
// event a line, the engine's own shape: knobs, expand, beam, node, edge, loop, progress), then {"type":"done"}.
// No memo, no sharing: the engine room watches one walk think. The budget defaults to 0 (the fare memory, the boards
// and the ground graph only), so watching costs no live search unless the owner asks for some (at most 40).
//
// q: { origin: {lat, lon, label}, gateways: ["GHV","SBZ","OTP"], home: "RO", from, to, minNights, maxNights,
//      nightsPerStop?: [2,3], maxStops?, beam?, budget?, tradeoff?, region?, mustInclude?, avoid?, prefer?, style?,
//      maxGroundMin?, departBy? }
export const maxDuration = 120;

type Q = {
  origin?: { lat?: number; lon?: number; label?: string };
  gateways?: string[];
  home?: string;
  from?: string;
  to?: string;
  departBy?: string;
  minNights?: number;
  maxNights?: number;
  nightsPerStop?: [number, number] | number;
  maxStops?: number;
  beam?: number;
  budget?: number;
  tradeoff?: "price" | "balanced" | "comfort";
  region?: string;
  mustInclude?: string[];
  avoid?: string[];
  prefer?: string[];
  style?: string;
  maxGroundMin?: number;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown, lo: number, hi: number, d?: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : d;
};

export async function GET(request: Request) {
  if (!adminAllowed()) return adminRefused();
  let q: Q;
  try {
    q = JSON.parse(new URL(request.url).searchParams.get("q") ?? "{}");
  } catch {
    return Response.json({ error: "q must be JSON" }, { status: 400 });
  }
  const lat = Number(q.origin?.lat);
  const lon = Number(q.origin?.lon);
  const gateways = (q.gateways ?? []).map((g) => String(g).trim().toUpperCase()).filter((g) => /^[A-Z]{3}$/.test(g)).slice(0, 4);
  const home = String(q.home ?? "").trim().toUpperCase();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return Response.json({ error: "origin.lat and origin.lon are needed" }, { status: 400 });
  if (!gateways.length || !/^[A-Z]{2}$/.test(home)) return Response.json({ error: "gateways (IATA codes) and home (ISO2) are needed" }, { status: 400 });
  if (!DAY.test(q.from ?? "") || !DAY.test(q.to ?? "") || q.to! < q.from!) return Response.json({ error: "from and to must be days, to not before from" }, { status: 400 });
  const minNights = num(q.minNights, 1, 90, 4)!;
  const maxNights = Math.max(minNights, num(q.maxNights, 1, 90, minNights)!);
  const nps = Array.isArray(q.nightsPerStop) ? ([num(q.nightsPerStop[0], 1, 14, 2)!, num(q.nightsPerStop[1], 1, 14, 3)!] as [number, number]) : typeof q.nightsPerStop === "number" ? num(q.nightsPerStop, 1, 14) : undefined;

  const gone = new AbortController();
  request.signal.addEventListener("abort", () => gone.abort());
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
        } catch {
          gone.abort();
        }
      };
      const t0 = Date.now();
      try {
        const result = await walkTrips({
          origin: { lat, lon, label: String(q.origin?.label ?? "home").slice(0, 60) },
          gateways,
          home,
          from: q.from!,
          to: q.to!,
          ...(q.departBy && DAY.test(q.departBy) ? { departBy: q.departBy } : {}),
          minNights,
          maxNights,
          ...(nps ? { nightsPerStop: nps } : {}),
          ...(q.maxStops ? { maxStops: num(q.maxStops, 1, 16) } : {}),
          ...(q.beam ? { beam: num(q.beam, 1, 6) } : {}),
          budget: num(q.budget, 0, 40, 0),
          ...(q.tradeoff ? { tradeoff: q.tradeoff } : {}),
          ...(q.region ? { region: String(q.region) } : {}),
          ...(q.mustInclude?.length ? { mustInclude: q.mustInclude.map(String) } : {}),
          ...(q.avoid?.length ? { avoid: q.avoid.map(String) } : {}),
          ...(q.prefer?.length ? { prefer: q.prefer.map(String) } : {}),
          ...(q.style ? { style: String(q.style) } : {}),
          ...(q.maxGroundMin != null ? { maxGroundMin: num(q.maxGroundMin, 0, 720) } : {}),
          signal: gone.signal,
          trace: true,
          onEvent: (e: WalkEvent) => send(e),
        });
        send({ type: "done", ms: Date.now() - t0, result });
      } catch (err) {
        send({ type: "error", error: err instanceof Error ? err.message : "the walk failed" });
      } finally {
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
