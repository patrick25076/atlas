import { buildWild, customKey, REGIONS, wildPath, type Budget, type Region, type Style, type Tradeoff, type WildTrip } from "@/lib/wild";
import { buildWildVariants } from "@/lib/wild-variants";
import { judgeTrip } from "@/lib/judge";
import { readJson, writeJson } from "@/lib/boards-store";
import { mainGateway } from "@/lib/board";

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
  const style = (["experiences", "beaches", "food", "cities", "slow"].includes(p.get("style") ?? "") ? p.get("style") : "experiences") as Style;
  const budget = (["backpacker", "mid", "comfort"].includes(p.get("budget") ?? "") ? p.get("budget") : "mid") as Budget;
  const lat = Number(p.get("lat"));
  const lon = Number(p.get("lon"));
  const origin = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, label: (p.get("label") ?? "home").slice(0, 60) } : undefined;
  const stopover = p.get("stopover") !== "0";
  const tradeoff = (["price", "balanced", "comfort"].includes(p.get("tradeoff") ?? "") ? p.get("tradeoff") : "balanced") as Tradeoff;
  const noHubs = p.get("noHubs") === "1";
  const variants = Math.min(4, Math.max(1, Number(p.get("variants")) || 1));
  if (!gateways.length || !/^[A-Z]{2}$/.test(home)) return Response.json({ error: "g (airport codes) and home (country) required" }, { status: 400 });
  if (!REGIONS[region]) return Response.json({ error: `region must be one of ${Object.keys(REGIONS).join(", ")}` }, { status: 400 });
  if (month && !/^\d{4}-\d{2}$/.test(month)) return Response.json({ error: "month must be YYYY-MM" }, { status: 400 });

  const path = wildPath(mainGateway(gateways), region, month, nights, style, budget, customKey(undefined, undefined, undefined, undefined, tradeoff, noHubs) + (variants > 1 ? `-v${variants}` : ""));
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
            if (variants > 1) {
              send({ progress: `Building ${variants} versions in parallel and ranking them…` });
              const ranked = await buildWildVariants({ gateways, home, region, month, nights, style, budget, origin, stopover }, variants, (line) => send({ progress: line }));
              if (!ranked.length) return null;
              const done = { ...ranked[0], alternatives: ranked.slice(1).map((t) => ({ variant: t.variant, rank: t.rank, score: t.score, title: t.title, totals: t.totals, judge: t.judge, outDate: t.outDate, backDate: t.backDate, legs: t.legs, stops: t.stops })) } as WildTrip;
              await writeJson(path, done).catch(() => null);
              return done;
            }
            const trip = await buildWild({ gateways, home, region, month, nights, style, budget, origin, stopover, tradeoff, noHubs, onProgress: (line) => send({ progress: line }) });
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
