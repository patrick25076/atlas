// The breadth of the price map (docs/plans/one-brain.md, step 1): Travelpayouts' cache of recent Aviasales fares,
// read for about 250 departure cities, so the cheapest-path search knows far more places to fly on to than Kiwi's
// nightly "anywhere" search gives it (15 answers, about 11 places a city). For each city and each of the next three
// months, two questions, both free and outside Kiwi's limit:
//   group_by=directions  the cheapest fare to every place seen that month (Hanoi: 161 places, Budapest: 158)
//   no grouping          the cheapest fare of each day of the month (where to on a given day)
// Every answer is a one-way fare seen by some traveller in the last days (found_at kept as "seen"), not a live quote:
// the map marks it so, and Search confirms the best trips live before it shows them as found.
//
// Usage: TP_PRODUCTION=1 pnpm ingest:tp-edges            (the nightly job: writes graph/tp/latest.json, the site reads it)
//        TP_ORIGINS=HAN,BUD TP_MONTHS=1 pnpm ingest:tp-edges   (a test: writes graph/tp/test-<date>.json only)
// Knobs: TP_TOP (places kept a city and month, default 80), TP_PAUSE_MS (default 180), TP_CONCURRENCY (default 3).
import citiesJson from "../../public/data/cities.json";
import { hubDegree, popularGateways } from "../../lib/board";
import { hasStore, writeJson } from "../../lib/boards-store";
import { encodeShard, type RawEdge } from "../../lib/flight-graph";
import { bookingUrl } from "../../lib/travelpayouts";
import { REGIONS } from "../../lib/wild";
import type { City } from "../../lib/types";

const CITIES = citiesJson as unknown as Record<string, City>;
/** Airport code to its city, built once (a fare names an airport or a city). */
const CITY_OF = new Map<string, City>();
for (const c of Object.values(CITIES)) for (const a of c.airports ?? []) if (!CITY_OF.has(a)) CITY_OF.set(a, c);
const API = "https://api.travelpayouts.com/aviasales/v3/get_latest_prices";
const HOME_AIRPORTS = ["OTP", "BBU", "CLJ", "IAS", "TSR", "SBZ", "GHV", "CND", "CRA", "BCM", "SCV", "SUJ", "OMR", "TGM", "BAY"];
export const TP_ROOT = "graph/tp";

const token = process.env.TRAVELPAYOUTS_TOKEN?.trim();
if (!token) {
  console.error("TRAVELPAYOUTS_TOKEN missing (SETUP.md §2)");
  process.exit(1);
}
if (!hasStore()) {
  console.error("BLOB_READ_WRITE_TOKEN missing: the price map is stored in Vercel Blob (SETUP.md §12)");
  process.exit(1);
}
const posInt = (v: string | undefined, fallback: number, max: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) && n >= 1 ? Math.min(max, Math.round(n)) : fallback;
};
const TOP = posInt(process.env.TP_TOP, 80, 300);
const PAUSE_MS = posInt(process.env.TP_PAUSE_MS, 180, 5000);
const CONCURRENCY = posInt(process.env.TP_CONCURRENCY, 3, 6);
const MONTHS = posInt(process.env.TP_MONTHS, 3, 6);
const TEST = process.env.TP_PRODUCTION !== "1" || !!process.env.TP_ORIGINS?.trim() || !!process.env.TP_MONTHS?.trim();
const today = new Date().toISOString().slice(0, 10);

// The departure cities: the home airports (every trip starts and ends there), the boards' popular gateways, and
// the two biggest cities of every country of every region the app plans trips through.
let origins: string[];
if (process.env.TP_ORIGINS?.trim()) origins = process.env.TP_ORIGINS.split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{3}$/.test(s));
else {
  const regionHubs: string[] = [];
  for (const [key, r] of Object.entries(REGIONS)) {
    if (key === "custom") continue;
    for (const [cc] of r.countries) {
      const top = Object.keys(CITIES)
        .filter((k) => CITIES[k].country === cc && hubDegree(k) >= 5)
        .sort((a, b) => hubDegree(b) - hubDegree(a))
        .slice(0, 2);
      regionHubs.push(...top);
    }
  }
  origins = [...new Set([...HOME_AIRPORTS, ...popularGateways(150), ...regionHubs])];
}
const months: string[] = [];
{
  const d = new Date(today + "T00:00:00Z");
  for (let i = 0; i < MONTHS; i++) months.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)).toISOString().slice(0, 10));
}
console.log(`tp edges: ${origins.length} cities × ${months.length} months × 2 questions = ${origins.length * months.length * 2} calls${TEST ? " (TEST run)" : ""}`);

type Raw = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" ? x : "");
const num = (x: unknown) => (typeof x === "number" ? x : Number(x));
let calls = 0;
let failed = 0;
async function ask(origin: string, month: string, grouped: boolean): Promise<Raw[]> {
  const p = new URLSearchParams({ origin, period_type: "month", beginning_of_period: month, one_way: "true", currency: "eur", sorting: "price", limit: "1000", show_to_affiliates: "true" });
  if (grouped) p.set("group_by", "directions");
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    try {
      const res = await fetch(`${API}?${p}`, { headers: { "X-Access-Token": token!, Accept: "application/json" } });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { success?: boolean; data?: Raw[] };
      return Array.isArray(body.data) ? body.data : [];
    } catch (err) {
      if (attempt === 2) {
        failed++;
        console.log(`  ${origin} ${month}${grouped ? " directions" : " days"}: ${err instanceof Error ? err.message : err}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return [];
}

/** A Travelpayouts row as an edge of the map: the local departure day and time, the landing day, the seen time. */
function edgeOf(r: Raw, origin: string): RawEdge | null {
  const at = str(r.depart_date) || str(r.departure_at);
  const to = str(r.destination_airport) || str(r.destination);
  const from = str(r.origin_airport) || str(r.origin) || origin;
  const price = num(r.value ?? r.price);
  if (!/^\d{4}-\d{2}-\d{2}/.test(at) || !/^[A-Z]{3}$/.test(to) || !/^[A-Z]{3}$/.test(from) || from === to || !(price > 0)) return null;
  const d = at.slice(0, 10);
  if (d < today) return null;
  const h = /T(\d{2}:\d{2})/.exec(at)?.[1] ?? "";
  const minutes = Math.max(0, Math.round(num(r.duration ?? r.duration_to) || 0));
  // The landing day: the local departure plus the flight, the clock shifted by the longitude between the two.
  const a1 = CITIES[from] ?? CITY_OF.get(from);
  const a2 = CITIES[to] ?? CITY_OF.get(to);
  const shiftH = a1 && a2 ? (((a2.lon - a1.lon + 540) % 360) - 180) / 15 : 0;
  const depH = h ? Number(h.slice(0, 2)) + Number(h.slice(3)) / 60 : 12;
  const arrive = new Date(Date.parse(d + "T00:00:00Z") + Math.floor((depH + minutes / 60 + shiftH) / 24) * 86_400_000).toISOString().slice(0, 10);
  return { f: from, t: to, d, h, a: arrive < d ? d : arrive, p: Math.round(price), m: minutes, s: Math.max(0, Math.round(num(r.number_of_changes ?? r.transfers) || 0)), c: str(r.airline), u: bookingUrl(str(r.link), from, to, at), w: str(r.found_at) || new Date().toISOString() };
}

const edges: RawEdge[] = [];
const seen = new Set<string>();
const perOrigin = new Map<string, number>();
const t0 = Date.now();
const tasks = origins.flatMap((o) => months.flatMap((m) => [{ o, m, grouped: true }, { o, m, grouped: false }]));
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    const rows = await ask(t.o, t.m, t.grouped);
    // Cheapest first; for the grouped answer the TOP cheapest places, for the daily one every day.
    const kept = (t.grouped ? rows.slice(0, TOP) : rows).map((r) => edgeOf(r, t.o)).filter((e): e is RawEdge => !!e);
    for (const e of kept) {
      const k = `${e.f}|${e.t}|${e.d}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push(e);
      perOrigin.set(t.o, (perOrigin.get(t.o) ?? 0) + 1);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const generatedAt = new Date().toISOString();
const body = encodeShard(edges, { generatedAt, date: today, shard: "tp", airports: origins, searched: calls, failed, window: { from: months[0], to: months.at(-1)! }, bucket: 0 });
const path = TEST ? `${TP_ROOT}/test-${today}.json` : `${TP_ROOT}/latest.json`;
await writeJson(path, body);
if (!TEST) await writeJson(`${TP_ROOT}/${today}.json`, body);
const places = new Set(edges.map((e) => e.t)).size;
const sorted = [...perOrigin.values()].sort((a, b) => a - b);
console.log(`tp edges: ${edges.length} edges, ${places} places, from ${perOrigin.size} cities (median ${sorted[Math.floor(sorted.length / 2)] ?? 0} each), ${calls} calls (${failed} failed), ${((Date.now() - t0) / 60_000).toFixed(1)} min → ${path}`);
