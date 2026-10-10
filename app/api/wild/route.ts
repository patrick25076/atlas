import { buildWild, REGIONS, wildPath, type Region, type WildTrip } from "@/lib/wild";
import { judgeTrip } from "@/lib/judge";
import { readJson, writeJson } from "@/lib/boards-store";

// GET /api/wild?g=OTP,SBZ&home=RO&region=sea&nights=14[&month=2026-11][&fresh=1]
// A wild trip: the way in, a chain of cheap hops through the region, the way home, costs and
// a verdict. Around forty live searches, so the answer streams progress lines as NDJSON and
// the finished trip is stored for a day.
export const maxDuration = 120;
const FRESH_HOURS = 24;
const inflight = new Map<string, Promise<WildTrip | null>>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = (p.get("g") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s)).slice(0, 3);
  const home = (p.get("home") ?? "").toUpperCase();
  const region = (p.get("region") ?? "sea") as Region;
  const nights = Math.min(28, Math.max(7, Number(p.get("nights")) || 14));
  const month = p.get("month") ?? undefined;
  if (!gateways.length || !/^[A-Z]{2}$/.test(home)) return Response.json({ error: "g (airport codes) and home (country) required" }, { status: 400 });
  if (!REGIONS[region]) return Response.json({ error: `region must be one of ${Object.keys(REGIONS).join(", ")}` }, { status: 400 });
  if (month && !/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });

  const path = wildPath(gateways[0], region, month, nights);
  if (!p.get("fresh")) {
    const stored = await readJson<WildTrip>(path);
    if (stored && stored.ageHours < FRESH_HOURS) return Response.json(stored.body, { headers: { "Cache-Control": "public, s-maxage=1800", "X-Wild": "stored" } });
  }

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
      try {
        let job = inflight.get(path);
        const mine = !job;
        if (!job) {
          job = (async () => {
            const trip = await buildWild({ gateways, home, region, month, nights, onProgress: (line) => send({ progress: line }) });
            if (!trip) return null;
            send({ progress: "Asking for a second opinion…" });
            const judge = await judgeTrip(trip);
            const done = { ...trip, judge: judge ?? undefined };
            await writeJson(path, done).catch(() => null);
            return done;
          })();
          inflight.set(path, job);
        } else {
          send({ progress: "Someone is building this trip right now; joining them…" });
        }
        const trip = await job;
        if (mine) inflight.delete(path);
        if (trip) send({ trip });
        else send({ error: "No way into that region on those dates from here. Try another month or region." });
      } catch (err) {
        inflight.delete(path);
        send({ error: err instanceof Error ? err.message : "the trip search failed" });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Wild": "live" } });
}
