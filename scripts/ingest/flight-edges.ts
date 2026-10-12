// The nightly flight graph (docs/plans/flight-graph.md): for every popular airport and every
// airport of the travellers' home countries, one one-way Kiwi search to "anywhere" per 3-day
// bucket over the next six weeks. Every itinerary that comes back is an edge (from airport,
// to airport, day, price, minutes, stops, carrier, booking link, when it was seen), so the
// cheapest-path search in lib/flight-graph.ts has its edges before it starts, the way the
// ground graph does. Stored in Vercel Blob, never in git, sharded like the boards so each
// GitHub runner (its own address) spends about 290 searches, far under Kiwi's daily limit.
//
// Usage: FLIGHT_PRODUCTION=1 FLIGHT_SHARD=2/8 pnpm ingest:flight-edges   (the nightly job: one shard of eight)
//        FLIGHT_AIRPORTS=OTP,GHV FLIGHT_LIMIT=2 FLIGHT_DAYS=12 FLIGHT_BUCKET=3 pnpm ingest:flight-edges
//          a test run, written under graph/flights/test-<date>/ only.
// Only FLIGHT_PRODUCTION=1 (set by the workflow alone) with none of the test knobs (FLIGHT_AIRPORTS, FLIGHT_LIMIT,
// FLIGHT_DAYS, FLIGHT_BUCKET, FLIGHT_FROM) writes where the site reads; anything else is a test run, so a run
// from a laptop can never overwrite tonight's shard or its manifest entry.
// Other knobs: FLIGHT_FROM=YYYY-MM-DD (first departure day, default tomorrow), FLIGHT_CONCURRENCY (default 3).
import { del } from "@vercel/blob";
import { cityAirports, popularGateways } from "../../lib/board";
import { forget, hasStore, listJson, readJson, writeJson } from "../../lib/boards-store";
import { FLIGHT_ROOT, MANIFEST_KEEP_DAYS, encodeShard, flightRoot, manifestPath, mergeManifest, type FlightManifest, type RawEdge } from "../../lib/flight-graph";
import { kiwiDate, searchFlight, THROTTLED_MESSAGE } from "../../lib/kiwi";

/**
 * Every airport of the home countries the usage log shows (Romania only, 12 October 2026): the
 * way out and the way home of every trip starts and ends at one of these, so they are searched
 * whatever their size. Baneasa (BBU) and the small regional ones often answer with nothing;
 * that is a cheap empty search, not a failure.
 */
const HOME_AIRPORTS = ["OTP", "BBU", "CLJ", "IAS", "TSR", "SBZ", "GHV", "CND", "CRA", "BCM", "SCV", "SUJ", "OMR", "TGM", "BAY"];
/** The boards' airport list: every real hub, then the best airport of each country still missing. */
const POPULAR = 150;
/** Consecutive failed searches after which a shard stops and keeps what it found (a throttled address). */
const MAX_FAIL_STREAK = 8;
const PAUSE_MS = 150;

if (!hasStore()) {
  console.error("BLOB_READ_WRITE_TOKEN missing: the flight graph is stored in Vercel Blob (SETUP.md §12)");
  process.exit(1);
}

const posInt = (v: string | undefined, fallback: number, max: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 1 ? Math.min(max, Math.round(n)) : fallback;
};
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

const DAYS = posInt(process.env.FLIGHT_DAYS, 42, 120);
const BUCKET = posInt(process.env.FLIGHT_BUCKET, 3, 14);
const CONCURRENCY = posInt(process.env.FLIGHT_CONCURRENCY, 3, 6);
const LIMIT = process.env.FLIGHT_LIMIT ? posInt(process.env.FLIGHT_LIMIT, 2, 500) : null;
/** A test run never writes where the site reads: any test knob, or no explicit production flag, makes one. */
const TEST_KNOBS = ["FLIGHT_AIRPORTS", "FLIGHT_LIMIT", "FLIGHT_DAYS", "FLIGHT_BUCKET", "FLIGHT_FROM"].filter((k) => process.env[k]?.trim());
const TEST = process.env.FLIGHT_PRODUCTION !== "1" || TEST_KNOBS.length > 0;
if (process.env.FLIGHT_PRODUCTION === "1" && TEST_KNOBS.length) console.log(`flight edges: ${TEST_KNOBS.join(", ")} set, so this is a test run despite FLIGHT_PRODUCTION`);
const START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.FLIGHT_FROM ?? "") ? process.env.FLIGHT_FROM! : addDays(today, 1);

// The airports: the home countries' first (they are the ends of every trip), then the popular ones not already
// covered. popularGateways answers city codes (BUH for Bucharest); a city whose airports are all in the home
// list is skipped, so Bucharest is not searched twice.
let airports: string[];
if (process.env.FLIGHT_AIRPORTS) {
  airports = [...new Set(process.env.FLIGHT_AIRPORTS.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s)))];
} else {
  const popular = popularGateways(POPULAR).filter((code) => {
    const own = cityAirports(code);
    return !HOME_AIRPORTS.includes(code) && !(own.length && own.every((a) => HOME_AIRPORTS.includes(a)));
  });
  airports = [...new Set([...HOME_AIRPORTS, ...popular])];
}
if (LIMIT != null) airports = airports.slice(0, LIMIT);
const shard = process.env.FLIGHT_SHARD?.match(/^(\d+)\/(\d+)$/);
const shardIndex = shard ? Number(shard[1]) : 0;
const shardCount = shard ? Math.max(1, Number(shard[2])) : 1;
if (shard) airports = airports.filter((_, idx) => idx % shardCount === shardIndex);

const buckets: { from: string; to: string }[] = [];
for (let off = 0; off < DAYS; off += BUCKET) buckets.push({ from: addDays(START, off), to: addDays(START, Math.min(DAYS, off + BUCKET) - 1) });
const root = flightRoot(TEST ? `test-${today}` : undefined);
const shardPath = TEST ? `${root}/shard-${shardIndex}.json` : `${root}/${today}/shard-${shardIndex}.json`;
console.log(
  `flight edges: ${airports.length} airports${shard ? ` (shard ${shard[0]})` : ""}, ${buckets.length} buckets of ${BUCKET} days from ${START} (${buckets.length * airports.length} searches)${TEST ? `, TEST run under ${root}/` : ""}: ${airports.join(" ")}`,
);

// The work: one search per airport and bucket, a few at a time (kiwi.ts paces the starts).
const tasks = airports.flatMap((code) => buckets.map((b) => ({ code, ...b })));
const edges: RawEdge[] = [];
const seenKey = new Set<string>();
let searched = 0;
let failed = 0;
let streak = 0;
let stopped = false;
const perAirport = new Map<string, number>();
const t0 = Date.now();

async function worker() {
  for (let task = tasks.shift(); task && !stopped; task = tasks.shift()) {
    try {
      const r = await searchFlight({ flyFrom: task.code, flyTo: "anywhere", departureDate: kiwiDate(task.from), departureDateTo: kiwiDate(task.to) });
      searched++;
      streak = 0;
      const w = new Date().toISOString();
      for (const it of r.itineraries) {
        const o = it.outbound;
        if (!o || it.inbound || !Number.isFinite(it.price) || it.price <= 0) continue;
        const d = o.departureTime.slice(0, 10);
        // The same flight can come back from two overlapping answers; one edge is enough.
        const key = `${o.from}|${o.to}|${o.departureTime}|${it.price}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        edges.push({
          f: o.from,
          t: o.to,
          d,
          h: o.departureTime.slice(11, 16),
          a: o.arrivalTime.slice(0, 10),
          p: Math.round(it.price),
          m: Math.round(o.durationSeconds / 60),
          s: o.stops,
          c: [...new Set(o.segments.map((s) => s.carrierName || s.carrier))].join(", "),
          u: it.bookingUrl,
          w,
        });
        perAirport.set(task.code, (perAirport.get(task.code) ?? 0) + 1);
      }
    } catch (err) {
      failed++;
      streak++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${task.code} ${task.from}..${task.to}: ${msg.slice(0, 160)}`);
      // A throttled address or a run of failures: stop asking and keep what was found, so a bad night costs a
      // shard some edges, never the edges it already has.
      if (streak >= MAX_FAIL_STREAK) {
        console.log(`  ${MAX_FAIL_STREAK} failures in a row${msg === THROTTLED_MESSAGE ? " (throttled)" : ""}; stopping this shard and keeping what it found`);
        stopped = true;
      }
    }
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

for (const code of airports) console.log(`  ${code}: ${perAirport.get(code) ?? 0} edges`);
if (!edges.length) {
  console.log(`flight edges: nothing found (${searched} searches, ${failed} failed); the stored shard and manifest stay as they were`);
  process.exit(failed && !searched ? 1 : 0);
}

// The shard: column arrays, not objects, so the keys are written once instead of 30,000 times.
const generatedAt = new Date().toISOString();
const body = encodeShard(edges, { generatedAt, date: today, shard: `${shardIndex}/${shardCount}`, airports, searched, failed, partial: stopped || undefined, window: { from: START, to: addDays(START, DAYS - 1) }, bucket: BUCKET });
const text = JSON.stringify(body);
const url = await writeJson(shardPath, body);
console.log(`flight edges: wrote ${shardPath} (${edges.length} edges, ${(text.length / 1024).toFixed(0)} KB)`);

// The manifest, merge-safe: eight runners finish at about the same time, so each one reads it fresh, adds its own
// shard, writes it back, then reads it again and retries when another runner's write took its entry away. The
// reader (lib/flight-graph.ts) also lists the newest day's folder, so a shard lost here is still found.
const mPath = manifestPath(root);
const entry = { path: shardPath, url: url ?? undefined, date: today, edges: edges.length, airports: airports.length, searched, failed, bytes: text.length, at: generatedAt, partial: stopped || undefined };
for (let attempt = 0; attempt < 4; attempt++) {
  forget(mPath);
  const prev = (await readJson<FlightManifest>(mPath))?.body ?? null;
  const listed = await listJson(TEST ? `${root}/shard-` : `${root}/${today}/`, 100);
  const next = mergeManifest(prev, { root, n: shardCount, index: shardIndex, entry, listed, today });
  await writeJson(mPath, next);
  await new Promise((res) => setTimeout(res, 1500 + Math.random() * 2500));
  forget(mPath);
  const check = (await readJson<FlightManifest>(mPath))?.body;
  if (check?.shards?.[String(shardIndex)]?.path === shardPath) break;
  console.log(`  manifest: another runner wrote over shard ${shardIndex}'s entry; trying again`);
}
// Old nights: shard 0 deletes the day folders the manifest no longer names (it keeps three days), so Blob does not
// grow by a night's graph every night. Looked for a week back, which covers a few missed nights.
if (!TEST && shardIndex === 0)
  for (let back = MANIFEST_KEEP_DAYS + 1; back <= MANIFEST_KEEP_DAYS + 7; back++) {
    const old = await listJson(`${root}/${addDays(today, -back)}/`, 100);
    if (old.length) await del(old.map((f) => f.url)).then(() => console.log(`  deleted ${old.length} shard files of ${addDays(today, -back)}`), (err) => console.log(`  delete ${addDays(today, -back)}: ${String(err).slice(0, 120)}`));
  }
console.log(`flight edges: ${edges.length} edges from ${airports.length} airports, ${searched} searches (${failed} failed), ${((Date.now() - t0) / 60_000).toFixed(1)} min; manifest ${mPath}${TEST ? "" : ` (root ${FLIGHT_ROOT})`}`);
