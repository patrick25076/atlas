// Source 18: one-way fares for the trip finder, from Kiwi.com's public MCP (no key): the cheapest
// dates out from each home gateway to each candidate city, and back from each city to each
// gateway, over the same six-week window as the deals. Same Fare shape as the Travelpayouts
// client, so lib/trips.ts can use either. Output: public/data/oneway.json.
import { readFile, writeFile } from "node:fs/promises";
import { kiwiDate, searchFlight, type KiwiItinerary } from "../../lib/kiwi";
import type { City, Fare } from "../../lib/types";
import { DESTINATIONS } from "./destinations";
import { recordManifest } from "./manifest";

const OUT = "public/data/oneway.json";
const GATEWAYS = (process.env.DEALS_GATEWAYS ?? "OTP,CLJ,IAS,TSR").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const WINDOW_DAYS = 45;
const KEEP = 6;
const CONCURRENCY = 2;
const PAUSE_MS = 250;

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const mainAirport = (code: string) => cities[code]?.airports[0] ?? code;

const start = new Date(Date.now() + 2 * 86_400_000);
const from = start.toISOString().slice(0, 10);
const to = new Date(start.getTime() + WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

function toFare(it: KiwiItinerary): Fare {
  const seg = it.outbound.segments;
  return {
    src: mainAirport(it.outbound.from),
    dst: mainAirport(it.outbound.to),
    price: Math.round(it.price),
    currency: "EUR",
    departureAt: it.outbound.departureTime.slice(0, 10),
    airline: seg[0]?.carrierName || seg[0]?.carrier || "",
    flightNumber: seg[0]?.flightNumber,
    transfers: it.outbound.stops,
    durationMin: Math.round(it.outbound.durationSeconds / 60),
    url: it.bookingUrl,
  };
}

const fares: Fare[] = [];
let calls = 0;
let failed = 0;
const jobs: [string, string][] = [];
for (const gw of GATEWAYS) {
  for (const dst of DESTINATIONS) {
    if (dst === gw) continue;
    jobs.push([gw, dst], [dst, gw]);
  }
}
console.log(`${jobs.length} one-way searches, ${from} to ${to}`);

async function worker() {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const [a, b] = job;
    try {
      const r = await searchFlight({ flyFrom: a, flyTo: b, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to) });
      calls++;
      const seen = new Set<string>();
      for (const it of r.itineraries.sort((x, y) => x.price - y.price)) {
        const f = toFare(it);
        if (seen.has(f.departureAt)) continue;
        seen.add(f.departureAt);
        fares.push(f);
        if (seen.size >= KEEP) break;
      }
      if (calls % 50 === 0) console.log(`  ${calls} searches, ${fares.length} fares`);
    } catch (err) {
      failed++;
      if (failed <= 5) console.log(`  ${a}→${b}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), window: { from, to }, gateways: GATEWAYS, fares }) + "\n");
await recordManifest("oneway", {
  source: "Kiwi.com flight search (public MCP), one-way",
  url: "https://mcp.kiwi.com/",
  licence: "Kiwi.com public MCP, no key; prices and booking links as returned",
  note: `Cheapest one-way dates out of and back into ${GATEWAYS.join(", ")} for ${DESTINATIONS.length} cities, ${from} to ${to}. ${failed} searches failed.`,
  fetchedAt: new Date().toISOString(),
  rows: fares.length,
  file: OUT,
});
console.log(`one-way: ${fares.length} fares from ${calls} searches (${failed} failed) → ${OUT}`);
