// Source 17: cheapest return getaways, searched on Kiwi.com's public MCP (no key) for every
// home gateway × destination over a six-week window, 2 to 7 nights. Reproducible: the site
// shows this file, the schedule rebuilds it nightly, and the live route re-prices one route
// on demand. Output: public/data/deals.json.
//
// Usage: pnpm ingest:deals            (gateways from DEALS_GATEWAYS, default OTP,CLJ,IAS,TSR)
//        DEALS_GATEWAYS=OTP pnpm ingest:deals
import { readFile, writeFile } from "node:fs/promises";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "../../lib/kiwi";
import { sensibleTicket } from "../../lib/board";
import type { City, Deal, DealsFile } from "../../lib/types";
import { DESTINATIONS } from "./destinations";
import { recordManifest } from "./manifest";

const OUT = "public/data/deals.json";
const GATEWAYS = (process.env.DEALS_GATEWAYS ?? "OTP,CLJ,IAS,TSR").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const WINDOW_DAYS = 45;
const MIN_NIGHTS = 2;
const MAX_NIGHTS = 7;
const KEEP_PER_ROUTE = 3;
const CONCURRENCY = 2;
const PAUSE_MS = 250;

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(cities)) for (const a of c.airports) cityOf.set(a, code);
const cityName = (code: string) => cities[code]?.name ?? cities[cityOf.get(code) ?? ""]?.name ?? code;
const countryOf = (code: string) => cities[code]?.country ?? cities[cityOf.get(code) ?? ""]?.country ?? "";

const start = new Date(Date.now() + 2 * 86_400_000);
const from = start.toISOString().slice(0, 10);
const to = new Date(start.getTime() + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
const returnTo = new Date(start.getTime() + (WINDOW_DAYS + MAX_NIGHTS) * 86_400_000).toISOString().slice(0, 10);

function toDeal(gw: string, dst: string, it: KiwiItinerary, nights: number): Deal {
  const carriers = [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))];
  return {
    gw,
    dst,
    dstCity: cityOf.get(dst) ?? dst,
    city: cityName(dst),
    country: countryOf(dst),
    price: Math.round(it.price),
    out: it.outbound.departureTime.slice(0, 10),
    back: it.inbound?.departureTime.slice(0, 10) ?? "",
    nights,
    stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0),
    carriers,
    outMin: Math.round(it.outbound.durationSeconds / 60),
    backMin: it.inbound ? Math.round(it.inbound.durationSeconds / 60) : 0,
    url: it.bookingUrl,
    bags: it.baggage ? `${it.baggage.cabinBag ? "cabin bag" : "personal item"}` : undefined,
  };
}

const deals: Deal[] = [];
let calls = 0;
let failed = 0;
let streak = 0;
const MAX_STREAK = 8; // Kiwi blocks the IP for a while after a few thousand searches; stop knocking.
const jobs: [string, string][] = [];
for (const gw of GATEWAYS) for (const dst of DESTINATIONS) if (dst !== gw && cityOf.get(gw) !== dst) jobs.push([gw, dst]);
console.log(`${GATEWAYS.join(",")} × ${DESTINATIONS.length} destinations, ${from} to ${to}, ${MIN_NIGHTS}-${MAX_NIGHTS} nights`);

async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    if (streak >= MAX_STREAK) {
      jobs.length = 0;
      break;
    }
    const [gw, dst] = job;
    try {
      const r = await searchFlight({
        flyFrom: gw,
        flyTo: dst,
        departureDate: kiwiDate(from),
        departureDateTo: kiwiDate(to),
        returnDate: kiwiDate(new Date(start.getTime() + MIN_NIGHTS * 86_400_000).toISOString()),
        returnDateTo: kiwiDate(returnTo),
      });
      calls++;
      const ok = r.itineraries
        .map((it) => ({ it, nights: nightsOf(it) }))
        .filter((x): x is { it: KiwiItinerary; nights: number } => x.nights != null && x.nights >= MIN_NIGHTS && x.nights <= MAX_NIGHTS)
        // A "return" into one city and home from a far one (Chania in, Corfu out) is no getaway.
        .filter(({ it }) => sensibleTicket(it))
        .sort((a, b) => a.it.price - b.it.price)
        .slice(0, KEEP_PER_ROUTE);
      for (const { it, nights } of ok) deals.push(toDeal(gw, dst, it, nights));
      streak = 0;
      if (calls % 25 === 0) console.log(`  ${calls} routes searched, ${deals.length} deals`);
    } catch (err) {
      failed++;
      streak++;
      if (failed <= 5) console.log(`  ${gw}→${dst}: ${err instanceof Error ? err.message : err}`);
      if (streak >= MAX_STREAK) console.log(`  ${MAX_STREAK} failures in a row (blocked?); stopping with what we have`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// DEALS_MERGE=1 keeps the other gateways' deals from the existing file (adding an airport
// without re-searching the rest).
let gatewaysOut = GATEWAYS;
const searchedGateways = new Set(deals.map((d) => d.gw));
if (process.env.DEALS_MERGE) {
  try {
    const prev = JSON.parse(await readFile(OUT, "utf8")) as DealsFile;
    // Keep other airports' deals, and keep an airport's old deals when this run found none for it.
    for (const d of prev.deals) if (!GATEWAYS.includes(d.gw) || !searchedGateways.has(d.gw)) deals.push(d);
    gatewaysOut = [...new Set([...prev.gateways, ...GATEWAYS])];
    console.log(`merged with ${prev.deals.length} existing deals from ${prev.gateways.join(", ")}`);
  } catch {
    console.log("no existing deals file to merge");
  }
}
deals.sort((a, b) => a.price - b.price);
const file: DealsFile = { updated: new Date().toISOString(), window: { from, to }, gateways: gatewaysOut, nights: [MIN_NIGHTS, MAX_NIGHTS], deals };
await writeFile(OUT, JSON.stringify(file) + "\n");
await recordManifest("deals", {
  source: "Kiwi.com flight search (public MCP)",
  url: "https://mcp.kiwi.com/",
  licence: "Kiwi.com public MCP, no key; prices and booking links as returned",
  note: `Cheapest return getaways ${from} to ${to}, ${MIN_NIGHTS}-${MAX_NIGHTS} nights, from ${GATEWAYS.join(", ")}. ${failed} routes failed.`,
  fetchedAt: new Date().toISOString(),
  rows: deals.length,
  file: OUT,
});
console.log(`deals: ${deals.length} from ${calls} routes (${failed} failed) → ${OUT}`);
