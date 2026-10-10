import { NextResponse } from "next/server";
import { readJson } from "@/lib/boards-store";
import { listTrips, logSearch } from "@/lib/db";
import { InFlight, keepAlive, TtlLru } from "@/lib/memo";
import { bad } from "@/lib/params";
import { BUDGET_TIERS, itineraryKey, PACES, type BudgetTier, type ItinDay, type Itinerary, type Pace, type Skeleton } from "@/lib/itinerary";
import { generateItinerary, indexPathOf, ItineraryInputError, normaliseSkeleton, ownerOf, planFingerprint, recallPlan, rememberPlan, savedItem, type OwnerIndex, type SavedItem } from "@/lib/itinerary-server";

// POST /api/itinerary  body { skeleton: Skeleton, wishes?: string, pace?: "slow"|"balanced"|"packed", budget?: "backpacker"|"mid"|"comfort", fresh?: boolean }
// Streams NDJSON: {skeleton} (normalised: every place has coordinates, nights and dates
// recomputed) first, then {progress} lines, a {day} per day as it is written, in order, and
// {done: Itinerary} last; {error} instead when something breaks. A plan already made from
// exactly the same skeleton (every field: links, notes, titles), wishes, pace and budget
// answers with {skeleton} and {done} only: kept a week in Blob (itin/plan/<key>.json) and six
// hours in memory, checked against a SHA-256 of all of it (recallPlan, lib/itinerary-server.ts),
// so nobody's links or words are served on another person's trip. `fresh` skips the cache
// and writes again (the Regenerate button). A partial plan (a day the model did not write)
// is returned but never kept, so the next ask tries again.
//
// Limits per address (x-forwarded-for), counted only when a plan is written (a cached answer
// is free): GENERATIONS_PER_HOUR plans, of which FRESH_PER_HOUR regenerations, and
// FRESH_PER_KEY_PER_HOUR regenerations of one plan from everyone together; past them a 429.
// Cost: 0 Kiwi searches. One Bedrock call per stop per week of days, about two Tavily
// searches and two Foursquare calls per stop (capped at six and eight stops), the
// Wikivoyage pages and the city event feeds. At most four plans are written at once per
// instance; a fifth is answered "busy" (429) rather than queued past the time limit.
//
// GET /api/itinerary  header x-atlas-owner: <the browser's id>
// The itineraries this browser saved, newest first: { items: { id, title, start, nights, total, img?, savedAt }[] }.
export const maxDuration = 300;

const inflight = new InFlight<Itinerary>();
const MAX_BODY = 200_000;
const GENERATIONS_PER_HOUR = 20;
const FRESH_PER_HOUR = 6;
const FRESH_PER_KEY_PER_HOUR = 3;
/** Counters, each forgotten an hour after its first count (the chat route's pattern). */
const perIp = new TtlLru<{ n: number; fresh: number }>(10_000, 3_600_000);
const perKey = new TtlLru<{ n: number }>(5_000, 3_600_000);

/** Counts one plan written for this address; the reason it is refused, or null. */
function overLimit(ip: string, key: string, fresh: boolean): string | null {
  const c = perIp.get(ip) ?? { n: 0, fresh: 0 };
  if (!perIp.get(ip)) perIp.set(ip, c);
  if (c.n >= GENERATIONS_PER_HOUR) return "you have planned a lot of trips this hour; try again later";
  if (fresh && c.fresh >= FRESH_PER_HOUR) return "too many regenerations this hour; try again later";
  const k = fresh ? (perKey.get(key) ?? { n: 0 }) : null;
  if (k && k.n >= FRESH_PER_KEY_PER_HOUR) return "this plan was regenerated several times this hour; try again later";
  c.n++;
  if (fresh) c.fresh++;
  if (k) {
    k.n++;
    if (k.n === 1) perKey.set(key, k);
  }
  return null;
}
const MAX_LIVE = 4;
let live = 0;

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return bad("the request is too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad("send JSON: { skeleton, wishes?, pace?, budget?, fresh? }");
  }
  if (!body || typeof body !== "object") return bad("send JSON: { skeleton, wishes?, pace?, budget?, fresh? }");
  let skeleton: Skeleton;
  try {
    skeleton = normaliseSkeleton(body.skeleton);
  } catch (err) {
    if (err instanceof ItineraryInputError) return bad(err.message);
    throw err;
  }
  if (body.pace != null && !PACES.includes(body.pace as Pace)) return bad(`pace must be one of ${PACES.join(", ")}`);
  if (body.budget != null && !BUDGET_TIERS.includes(body.budget as BudgetTier)) return bad(`budget must be one of ${BUDGET_TIERS.join(", ")}`);
  if (body.wishes != null && typeof body.wishes !== "string") return bad("wishes must be text");
  const pace = (body.pace as Pace | undefined) ?? "balanced";
  const budget = (body.budget as BudgetTier | undefined) ?? "mid";
  const wishes = typeof body.wishes === "string" ? body.wishes.trim().slice(0, 300) || undefined : undefined;
  const fresh = body.fresh === true || body.fresh === 1 || body.fresh === "1";
  const opts = { wishes, pace, budget };
  const key = itineraryKey(skeleton, opts);
  const fp = planFingerprint(skeleton, opts);
  const headers = { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Itinerary-Key": key };
  const encoder = new TextEncoder();
  const lines = (...objs: unknown[]) => encoder.encode(objs.map((o) => JSON.stringify(o) + "\n").join(""));

  // A plan made before from exactly this request: two lines, no limit spent.
  const hit = fresh ? null : await recallPlan(skeleton, opts);
  if (hit) return new Response(lines({ skeleton }, { done: hit }), { headers });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const refused = overLimit(ip, key, fresh);
  if (refused) return NextResponse.json({ error: refused, busy: true }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "600" } });

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
      const alive = keepAlive(send, 15_000, "Still writing…");
      const say = (obj: unknown) => {
        alive.touch();
        send(obj);
      };
      const t0 = Date.now();
      try {
        say({ skeleton });
        // Somebody is already writing this exact plan (same fingerprint): wait for it instead of paying twice.
        const { promise, mine } = inflight.run(fp, async () => {
          if (live >= MAX_LIVE) throw new Busy();
          live++;
          try {
            return await generateItinerary(skeleton, opts, (day: ItinDay) => say({ day }), (line) => say({ progress: line }));
          } finally {
            live--;
          }
        });
        const it = await promise;
        if (!mine) for (const day of it.days) say({ day });
        if (mine) await rememberPlan(it);
        if (mine) void logSearch("itinerary", { source: skeleton.source, stops: skeleton.stops.length, nights: skeleton.nights, pace, budget, wishes: !!wishes, fresh, status: it.status }, it.days.length, Date.now() - t0).catch(() => null);
        say({ done: it });
      } catch (err) {
        if (err instanceof Busy) say({ error: "too many itineraries are being written right now; try again in a minute", busy: true });
        else if (err instanceof ItineraryInputError) say({ error: err.message });
        else {
          console.log(`itinerary: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
          say({ error: "the itinerary could not be written; try again in a minute" });
        }
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
  return new Response(stream, { headers });
}

class Busy extends Error {}

export async function GET(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return bad("send the x-atlas-owner header: 8 to 64 letters, digits or hyphens");
  const rows = await listTrips(owner);
  let items: SavedItem[] = rows.filter((r) => r.kind === "itinerary" && r.body && typeof r.body === "object").map((r) => savedItem(r.id, r.body as Itinerary, r.updatedAt));
  // No database (or nothing in it yet for this browser): the Blob list.
  if (!items.length) {
    const index = await readJson<OwnerIndex>(indexPathOf(owner));
    items = index?.body?.items ?? [];
  }
  return NextResponse.json({ items }, { headers: { "Cache-Control": "private, no-store" } });
}
