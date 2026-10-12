import { parseExclude } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { walkTrips, wantsUnique, type WalkEvent, type WalkResult } from "@/lib/graph-walk";
import { InFlight, keepAlive, TtlLru } from "@/lib/memo";
import { newRun, saveRun, withRun } from "@/lib/run-log";
import { SHARED_TTL_MS, sharedGet, sharedPut } from "@/lib/shared-cache";
import { bad, iataList, intIn, iso2, isoDay, latLon, oneOf } from "@/lib/params";
import { parseCities, parseCountries, parseNightsRange, REGIONS } from "@/lib/wild";

// GET /api/walk?g=GHV,SBZ,OTP&home=RO&lat=45.657&lon=25.601&label=Brasov&from=2026-10-20&to=2026-10-30
//     &minNights=5&maxNights=6[&nightsPerStop=2|2-3][&maxStops=3][&beam=2][&budget=12][&ground=330]
//     [&tradeoff=balanced][&exclude=HU][&mustInclude=Gdansk][&avoid=DE,Berlin][&prefer=PL][&countries=PL,CZ][&region=sea][&style=street+food]
// maxStops defaults to ceil(maxNights / the fewest nights a stop), at most 16; budget defaults to about two searches a
// stop plus the way in and home (never under 12, at most 40). ground=0 turns trains and coaches off. region (a
// lib/wild.ts REGIONS key) or countries make the walk targeted: the way in and every hop search the region's
// biggest hubs instead of "anywhere", so a far region (Southeast Asia from Brasov) is reachable.
// style=unique (or "hidden gems", "off the beaten path") weights hidden gems and smaller cities up and the 25 biggest
// hubs down ("not unique" or "no hidden gems" does not); avoid also takes a group ("dach", "germanic", "nordics",
// "benelux countries", "baltic states", "the balkans", "iberian peninsula", "british isles") or "like:DE",
// "like:Germany", "places like Germany", which avoids every country of the group DE is in ("countries like Germany").
// The graph walk (lib/graph-walk.ts): loops from the traveller's door, out through a home
// airport, a few cities by air or by train, and home, inside [from, to] with minNights to
// maxNights away. Streamed as NDJSON, one object a line: {"node":..} when a state is
// expanded, {"edge":..} for every edge found (the fan-out the globe draws; the edge that led
// to an expanded state comes again with chosen: true), {"loop":..} when a loop closes,
// {"progress":".."} as it works, and {"done":{..WalkResult}} last. At most `budget` live
// Kiwi searches (default about two a stop plus the way in and home, never under 12, at most 40;
// 0 answers from the fare memory, the boards and the ground graph alone). nightsPerStop is exact:
// "2-3" is 2 or 3 nights a stop and "2" is exactly 2; left out, 2 with a day of slack (2 or 3). The engine stops issuing searches after 90 s, so the done line always
// arrives inside maxDuration. An answer is kept for an hour per normalised question and
// served as one {"done"} line; two visitors asking the same thing share one walk (the second
// gets the done line only). A partial walk (the breaker refused or tripped, the deadline or the
// caller cut it) or one that lost as many searches as it made is not kept, so the next ask gets
// a fresh try.
export const maxDuration = 120;

const MEMO_TTL_MS = SHARED_TTL_MS;
const MAX_BUDGET = 40;
const MAX_DAYS_OUT = 366;
const TRADEOFFS = ["price", "balanced", "comfort"] as const;
/** What a label or a style may look like: letters in any script, digits, spaces and a little punctuation. */
const TEXT = /^[\p{L}\p{N} ,.'()&-]{1,120}$/u;

const memo = new TtlLru<WalkResult>(200, MEMO_TTL_MS);
const inflight = new InFlight<WalkResult>();

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const gateways = iataList(p.get("g"), 4);
  if (!gateways.length) return bad("g must be one to four home airport codes, such as g=GHV,SBZ,OTP");
  const home = iso2(p.get("home"));
  if (!home) return bad("home must be a two-letter country code, such as RO");
  const point = latLon(p.get("lat"), p.get("lon"));
  if (!point) return bad("lat and lon must be a point on Earth");
  const label = (p.get("label") ?? "").trim() || "home";
  if (!TEXT.test(label)) return bad("label must be a short place name");
  const from = isoDay(p.get("from"));
  const to = isoDay(p.get("to"));
  if (!from || !to) return bad("from and to must be real dates, YYYY-MM-DD");
  if (to < from) return bad("to must not be before from");
  const today = new Date().toISOString().slice(0, 10);
  if (from < today) return bad("from is in the past");
  if ((Date.parse(to) - Date.parse(today)) / 86_400_000 > MAX_DAYS_OUT) return bad("to must be within a year");
  const minNights = intIn(p.get("minNights"), 1, 60, 5);
  const maxNights = intIn(p.get("maxNights"), 1, 60, Math.max(minNights, 6));
  if (maxNights < minNights) return bad("maxNights must not be under minNights");
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 < minNights) return bad(`the window from ${from} to ${to} is shorter than ${minNights} nights`);
  const npsRaw = p.get("nightsPerStop");
  const nightsPerStop = npsRaw ? parseNightsRange(npsRaw) : null;
  if (npsRaw && !nightsPerStop) return bad("nightsPerStop must be a number of nights (2) or a range (2-3)");
  if (nightsPerStop && (nightsPerStop[1] > 14 || nightsPerStop[0] > maxNights)) return bad("nightsPerStop must be at most 14 and fit in maxNights");
  // Left out, stops and budget scale with the nights in the engine (see the header); given, they are clamped here.
  const maxStops = p.get("maxStops") ? intIn(p.get("maxStops"), 1, 16, 3) : undefined;
  const beam = intIn(p.get("beam"), 1, 5, 3);
  const budget = p.get("budget") ? intIn(p.get("budget"), 0, MAX_BUDGET, 12) : undefined;
  // 0 is flights only; anything else is at least half an hour of ground.
  const groundRaw = intIn(p.get("ground"), 0, 720, 330);
  const maxGroundMin = groundRaw === 0 ? 0 : Math.max(30, groundRaw);
  const region = (p.get("region") ?? "").trim().toLowerCase();
  if (region && !Object.hasOwn(REGIONS, region)) return bad(`region must be one of ${Object.keys(REGIONS).join(", ")}`);
  const tradeoff = oneOf(p.get("tradeoff"), TRADEOFFS, "balanced");
  const exclude = parseExclude(p.get("exclude"));
  const must = parseCities(p.get("mustInclude"));
  if (must.unknown.length) return bad(`unknown city to pass through: ${must.unknown.join(", ")} (a city name such as Gdansk or a code such as GDN)`);
  if (maxStops != null && must.codes.length > maxStops) return bad(`${must.codes.length} cities to pass through do not fit in ${maxStops} stops`);
  // avoid takes countries and cities mixed; the engine resolves each and answers a plain note for one it cannot read.
  const avoid = (p.get("avoid") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const prefer = parseCountries(p.get("prefer"));
  if (prefer.unknown.length) return bad(`unknown country to prefer: ${prefer.unknown.join(", ")}`);
  const countries = parseCountries(p.get("countries"));
  if (countries.unknown.length) return bad(`unknown country: ${countries.unknown.join(", ")} (a name such as Poland or a code such as PL)`);
  const style = (p.get("style") ?? "").trim().slice(0, 120);
  if (style && !TEXT.test(style)) return bad("style must be a few plain words");

  // The normalised question: what the engine will actually use, lists sorted, the point to three decimals, the label left out (it only names things).
  const key = JSON.stringify({ g: gateways, home, lat: point.lat.toFixed(3), lon: point.lon.toFixed(3), from, to, minNights, maxNights, nps: nightsPerStop ?? [2, 2], maxStops, beam, budget, ground: maxGroundMin, tradeoff, exclude: [...exclude].sort(), must: must.codes, avoid: [...avoid].map((s) => s.toLowerCase()).sort(), prefer: [...prefer.codes].sort(), countries: [...countries.codes].sort(), region, style: style.toLowerCase() });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      // A visitor who closes the tab must not keep spending live searches: the engine checks this signal before
      // every search. It fires when the request is aborted and when a write finds the stream already closed.
      const gone = new AbortController();
      request.signal.addEventListener("abort", () => gone.abort(), { once: true });
      const send = (obj: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          open = false;
          gone.abort();
        }
      };
      const alive = keepAlive(send);
      const say = (obj: unknown) => {
        alive.touch();
        send(obj);
      };
      const t0 = Date.now();
      try {
        const hit = memo.get(key) ?? (await sharedGet<WalkResult>("walk", key))?.value;
        if (hit && Array.isArray(hit.loops)) {
          memo.set(key, hit);
          say({ done: hit });
          return;
        }
        const onEvent = (e: WalkEvent) => {
          if (e.type === "progress") say({ progress: e.text });
          else if (e.type === "node") say({ node: { code: e.code, name: e.name, lat: e.lat, lon: e.lon, date: e.date, depth: e.depth, cost: e.cost } });
          else if (e.type === "edge") say({ edge: { from: e.from, to: e.to, toName: e.toName, lat: e.lat, lon: e.lon, kind: e.kind, price: e.price, minutes: e.minutes, source: e.source, ...(e.chosen ? { chosen: true } : {}), ...(e.home ? { home: true } : {}) } });
          else if (e.type === "loop") say({ loop: e.loop });
        };
        // The signal is the first caller's: a second caller sharing the walk must not cut it short by leaving.
        // The run log (the engine room's Live tab): the walk adds its whole trace as a step.
        const rec = newRun(request, { kind: "walk", source: "Loop on the globe", title: `Loop from ${label}, ${from} to ${to}, ${minNights} to ${maxNights} nights${region ? `, ${region}` : ""}`, input: { g: gateways, home, from, to, minNights, maxNights, nightsPerStop, maxStops, budget, tradeoff, region, must: must.codes, avoid, prefer: prefer.codes } });
        const { promise, mine } = inflight.run(key, () =>
          withRun(rec, () => walkTrips({ origin: { lat: point.lat, lon: point.lon, label }, gateways, home, from, to, minNights, maxNights, nightsPerStop: nightsPerStop ?? undefined, maxStops, beam, budget, maxGroundMin, tradeoff, exclude, mustInclude: must.codes, avoid, prefer: prefer.codes, allowedCountries: countries.codes, region: region || undefined, style: style || undefined, signal: gone.signal, onEvent })),
        );
        if (!mine) say({ progress: "The same walk is running for someone else; waiting for it." });
        const result = await promise;
        if (mine) await saveRun(rec);
        // A walk the breaker refused, or that lost as many searches as it made, is a weak answer and must not stand
        // for an hour: the next ask gets a fresh try (and the fare memory keeps what this one did find).
        if (mine && !result.partial && !(result.failed > 0 && result.failed >= result.searched)) {
          memo.set(key, result);
          void sharedPut("walk", key, result);
        }
        // The usage log, never awaited and never personal: codes and numbers, no label or coordinates.
        if (mine) void logSearch("walk", { g: gateways, home, from, to, minNights, maxNights, nps: nightsPerStop ?? [2, 2], maxStops, beam, budget, ground: maxGroundMin, tradeoff, excluded: exclude.length, must: must.codes.length, avoid: avoid.length, countries: countries.codes.length, region: region || undefined, unique: wantsUnique(style), searched: result.searched, failed: result.failed, fromMemory: result.fromMemory, expanded: result.expanded, loops: result.loops.length }, result.loops.length, Date.now() - t0).catch(() => null);
        say({ done: result });
      } catch (err) {
        say({ error: err instanceof Error ? err.message : "the walk failed" });
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
