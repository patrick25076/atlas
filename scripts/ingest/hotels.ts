// Nightly hotel price snapshot. For the eighty most popular destination cities (the biggest
// hubs by route count, plus the home market's favourite destinations) ask LiteAPI, the
// licensed hotel-rate API, for the cheapest decent hotel per night over one standard window:
// the Friday to Sunday about four weeks out, one adult, Romanian nationality. Store the
// snapshot in Blob as hotels/snapshot-<date>.json and hotels/latest.json, and in the Postgres
// table hotel_prices when DATABASE_URL exists. lib/hotel-deals.ts compares the snapshots,
// only ever against earlier ones with the same check-in: the window below moves to the next
// Friday every Saturday, so the first two nights of each week are "warming up" again
// (docs/architecture.md, "The hotel window rollover").
//
// Calls: two LiteAPI requests per city (hotel list, then rates), so 160 a night, three at a
// time. No Kiwi searches. No scraping of Booking, Google, Yelp or Tripadvisor: LiteAPI is the
// legal source and its terms allow live lookups; the snapshot keeps one price per city, not
// a hotel database (SETUP.md §5 has the note on asking LiteAPI in writing).
//
// Usage: pnpm ingest:hotels
//        HOTELS_LIMIT=20 pnpm ingest:hotels          (a quick run)
//        HOTELS_CITIES=BKK,LIS pnpm ingest:hotels
//
// Only a complete, live run (the full city list, LITEAPI_ENV=production) writes the paths
// the site reads (hotels/latest.json, hotels/snapshot-<date>.json) and the Postgres rows:
// a limited or sandbox run would otherwise replace tonight's real snapshot with three cities
// or test rates and sit in every median for 45 days. Such a run writes hotels/test-<date>.json
// only, unless HOTELS_WRITE=1 says it is meant for real.
import citiesJson from "../../public/data/cities.json";
import { hubDegree } from "../../lib/board";
import { hasStore, writeJson } from "../../lib/boards-store";
import { hasDb, recordHotelPrices } from "../../lib/db";
import { FULL_CITIES, LATEST_PATH, SNAPSHOT_PREFIX, TEST_PREFIX, type HotelSnapshot, type HotelSnapshotCity } from "../../lib/hotel-deals";
import { hasLiteApi, hotelsNear, liteApiLive } from "../../lib/liteapi";
import type { City } from "../../lib/types";
import { DESTINATIONS } from "./destinations";

const CITIES = citiesJson as unknown as Record<string, City>;
const LIMIT = Math.max(1, Number(process.env.HOTELS_LIMIT) || FULL_CITIES);
const CONCURRENCY = 3;
const PAUSE_MS = 200;
const NATIONALITY = "RO";
/** The weekend searched: the first Friday at least this many days out. */
const LEAD_DAYS = 28;

if (!hasLiteApi()) {
  console.error("LITEAPI_KEY missing: hotel snapshots need the LiteAPI key (SETUP.md §5)");
  process.exit(1);
}
if (!hasStore()) {
  console.error("BLOB_READ_WRITE_TOKEN missing: snapshots are stored in Vercel Blob (SETUP.md §12)");
  process.exit(1);
}
const sandbox = !liteApiLive();
/** A full, live run is the nightly job; anything else is a test unless HOTELS_WRITE=1. */
const limited = LIMIT < FULL_CITIES || !!process.env.HOTELS_CITIES;
const forReal = process.env.HOTELS_WRITE === "1" || (!limited && !sandbox);
if (sandbox) console.log("LITEAPI_ENV is not production: sandbox prices are test data; the snapshot is marked sandbox and the site ignores it");
if (!forReal) console.log(`test run (${limited ? "a limited city list" : "sandbox rates"}): writing ${TEST_PREFIX}<date>.json only, no latest.json, no Postgres; set HOTELS_WRITE=1 to write for real`);

/** An airport or city code → the city code on the globe. */
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);
const toCity = (code: string) => (CITIES[code] ? code : cityOf.get(code));

/** Home-market favourites first (every one of them), then the biggest hubs until the limit. */
function pickCities(): string[] {
  const forced = process.env.HOTELS_CITIES?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (forced?.length) return forced.map(toCity).filter((c): c is string => !!c);
  const out: string[] = [];
  for (const d of DESTINATIONS) {
    const c = toCity(d);
    if (c && !out.includes(c)) out.push(c);
  }
  const ranked = Object.keys(CITIES).filter((c) => hubDegree(c) > 0).sort((a, b) => hubDegree(b) - hubDegree(a));
  for (const c of ranked) {
    if (out.length >= LIMIT) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, LIMIT);
}

/** Friday to Sunday, the first Friday at least LEAD_DAYS away, in UTC dates. */
function weekendWindow(): { checkin: string; checkout: string } {
  const base = new Date(Date.now() + LEAD_DAYS * 86_400_000);
  const toFriday = (5 - base.getUTCDay() + 7) % 7;
  const fri = new Date(base.getTime() + toFriday * 86_400_000);
  const sun = new Date(fri.getTime() + 2 * 86_400_000);
  return { checkin: fri.toISOString().slice(0, 10), checkout: sun.toISOString().slice(0, 10) };
}

const codes = pickCities();
const { checkin, checkout } = weekendWindow();
const date = new Date().toISOString().slice(0, 10);
console.log(`${codes.length} cities, ${checkin} to ${checkout}, nationality ${NATIONALITY}: ${codes.join(" ")}`);

const queue = [...codes];
const rows: HotelSnapshotCity[] = [];
let searched = 0;
let failed = 0;
let empty = 0;
const t0 = Date.now();

async function worker() {
  for (let code = queue.shift(); code; code = queue.shift()) {
    const c = CITIES[code];
    if (!c) continue;
    try {
      const r = await hotelsNear(c.lat, c.lon, checkin, checkout, NATIONALITY);
      searched++;
      if (r.status === "no-key" || r.status === "error") {
        failed++;
        console.log(`  ${code} ${c.name}: ${r.status}${r.note ? ` (${r.note})` : ""}`);
      } else {
        const best = r.hotels.find((h) => h.perNight != null && h.perNight > 0);
        if (!best) {
          empty++;
          console.log(`  ${code} ${c.name}: no priced hotel`);
        } else {
          rows.push({ code, name: c.name, country: c.country, lat: c.lat, lon: c.lon, hotelId: best.id, hotelName: best.name, stars: best.stars, rating: best.rating, perNight: best.perNight!, total: best.total ?? best.perNight! * 2, currency: best.currency, priced: r.hotels.length });
          console.log(`  ${code} ${c.name}: €${best.perNight}/night ${best.name}${best.stars ? ` (${best.stars}*)` : ""}, ${r.hotels.length} priced`);
        }
      }
    } catch (err) {
      failed++;
      console.log(`  ${code} ${c.name}: ${err instanceof Error ? err.message : err}`);
    }
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (!rows.length) {
  console.error(`hotels: nothing priced (${failed} failed, ${empty} empty); keeping the previous snapshot`);
  process.exit(1);
}
rows.sort((a, b) => a.perNight - b.perNight);
const snapshot: HotelSnapshot = { generatedAt: new Date().toISOString(), date, checkin, checkout, nights: 2, nationality: NATIONALITY, cities: rows, searched, failed, empty, sandbox, complete: !limited };
if (!forReal) {
  // A test run leaves the real snapshots and the price history alone.
  await writeJson(`${TEST_PREFIX}${date}.json`, snapshot);
  console.log(`hotels: test run written to ${TEST_PREFIX}${date}.json (${rows.length} cities, ${sandbox ? "sandbox" : "production"} rates); latest.json and Postgres untouched`);
} else {
  await writeJson(`${SNAPSHOT_PREFIX}${date}.json`, snapshot);
  await writeJson(LATEST_PATH, snapshot);
  if (sandbox) {
    // Test rates never enter the price history; the Blob document carries the sandbox mark instead.
    console.log("hotels: sandbox rates, Postgres skipped");
  } else if (hasDb()) {
    const ok = await recordHotelPrices(rows.map((r) => ({ cityCode: r.code, checkin, checkout, hotelId: r.hotelId, hotelName: r.hotelName, stars: r.stars ?? null, perNight: r.perNight, seenAt: snapshot.generatedAt })));
    console.log(`hotels: Postgres ${ok ? `${rows.length} rows written` : "write failed"}`);
  } else {
    console.log("hotels: no DATABASE_URL, Blob only");
  }
}
console.log(`hotels: ${rows.length} cities priced (${failed} failed, ${empty} empty), ${searched * 2} LiteAPI calls, cheapest €${rows[0].perNight} ${rows[0].name}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
// The Postgres pool would keep the process alive; the work is done.
process.exit(0);
