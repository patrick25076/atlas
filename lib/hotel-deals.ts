// Server-only. Hotel deals from our own price history. Every night scripts/ingest/hotels.ts
// asks LiteAPI (the licensed hotel-rate API; no Booking, Google or Tripadvisor scraping) for
// the cheapest decent hotel in each of the eighty most popular destination cities, for the
// same standard weekend about four weeks out, and stores the snapshot in Blob (and in
// Postgres when DATABASE_URL exists). A city is a "hotel deal" when tonight's price is at
// least DROP below the median of the earlier snapshots FOR THE SAME CHECK-IN DATE: a price
// for one weekend is never compared with a price for another. Three snapshots of that
// weekend are the minimum for a median to mean anything; before that the answer says
// "warming up". The ingest picks the first Friday at least 28 days out, so the weekend
// rolls over every Saturday and the history starts again (docs/architecture.md, "The
// hotel window rollover").
//
// Only real nights count: a snapshot marked sandbox (LiteAPI test rates) is ignored, and so
// is any day with fewer than MIN_CITIES_PER_DAY cities (a limited test run such as the three
// cities written on 2026-10-10), whether it came from Blob or from Postgres.
import { hasDb, hotelPriceHistory } from "./db";
import { hasStore, readJson } from "./boards-store";
import { TtlLru } from "./memo";

export const SNAPSHOT_PREFIX = "hotels/snapshot-";
export const LATEST_PATH = "hotels/latest.json";
/** Where a limited or sandbox run of the ingest writes, so it never touches the paths above. */
export const TEST_PREFIX = "hotels/test-";
/** The full city list of the nightly job; a run shorter than this is a test. */
export const FULL_CITIES = 80;
/** A day with fewer priced cities than this is a test run, not a night of history. */
export const MIN_CITIES_PER_DAY = 40;
/** Tonight's price must be this far under the median to count. */
export const DROP = 0.25;
/** Snapshots of the same check-in date needed (today's included) before deals are declared. */
export const MIN_SNAPSHOTS = 3;
/** How far back the history looks: that many expected paths hotels/snapshot-<date>.json, or days of Postgres rows. */
export const HISTORY_DAYS = 45;

export type HotelSnapshotCity = {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  hotelId: string;
  hotelName: string;
  stars?: number;
  rating?: number;
  perNight: number;
  total: number;
  currency: string;
  /** How many decent hotels came back priced; a low number means a thin market that night. */
  priced: number;
};
export type HotelSnapshot = {
  generatedAt: string;
  /** The snapshot's day, YYYY-MM-DD (UTC). One snapshot per day; a rerun overwrites it. */
  date: string;
  checkin: string;
  checkout: string;
  nights: number;
  nationality: string;
  cities: HotelSnapshotCity[];
  searched: number;
  failed: number;
  /** Cities LiteAPI answered for but with no priced hotel. */
  empty: number;
  /** True when the rates came from LiteAPI's sandbox (test data): never history, never deals. */
  sandbox?: boolean;
  /** True when the run covered the full city list; a limited run is a test. */
  complete?: boolean;
};

export type HotelDeal = {
  code: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
  hotel: string;
  hotelId: string;
  stars?: number;
  rating?: number;
  /** Tonight's cheapest decent per-night price, EUR. */
  price: number;
  /** The median of the earlier snapshots with the same check-in, EUR. */
  typical: number;
  /** Percent under typical, whole number. */
  below: number;
  /** Earlier snapshots with the same check-in this city had a price in. */
  samples: number;
  checkin: string;
  checkout: string;
  currency: string;
};
export type HotelDealsResult = {
  status: "ok" | "warming-up" | "no-data" | "no-store";
  note?: string;
  /** Distinct snapshot days found with the latest snapshot's check-in date, today's included. */
  snapshots: number;
  latest?: { date: string; checkin: string; checkout: string; cities: number };
  deals: HotelDeal[];
  generatedAt: string;
};

const memo = new TtlLru<HotelDealsResult>(4, 60 * 60_000);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The key the history is grouped by: a city and the weekend it was priced for. */
function cityKey(code: string, checkin: string): string {
  return `${code}|${checkin}`;
}

/** The expected Blob path of the snapshot written on a day. */
export function snapshotPath(date: string): string {
  return `${SNAPSHOT_PREFIX}${date}.json`;
}

/**
 * Earlier prices per city and check-in: cityKey → snapshot day → per-night. Postgres first
 * when DATABASE_URL exists (the rows carry their check-in), then the Blob snapshots as well,
 * read by their expected paths, hotels/snapshot-<date>.json for each of the HISTORY_DAYS days
 * before the latest one, five at a time (no listing: a night that was never written is one
 * cheap 404, remembered a minute). Both sources are merged: a night whose Postgres insert
 * failed (a stale DATABASE_URL on the ingest runner, a short outage) still has its Blob
 * snapshot, and a day present in both keeps the lower price. The Blob pass is skipped only
 * when Postgres already holds a real night for `latestCheckin`, so the common case costs no
 * Blob reads. Sandbox snapshots and thin days (fewer than MIN_CITIES_PER_DAY cities, a test
 * run) are left out, so they never sit in a median. `days` says which real snapshot days
 * exist per check-in, so the caller can count the ones for tonight's weekend.
 */
export async function hotelHistory(latestDate: string, latestCheckin?: string): Promise<{ perCity: Map<string, Map<string, number>>; days: Map<string, Set<string>> }> {
  // Collect per day first (a day prices one weekend), then keep only the days that look like a real night.
  const byDay = new Map<string, { checkin: string; cities: Map<string, number> }>();
  const add = (code: string, day: string, checkin: string, perNight: number) => {
    if (day === latestDate || !(perNight > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(checkin)) return;
    const d = byDay.get(day) ?? { checkin, cities: new Map<string, number>() };
    // The same day twice (a rerun, or Postgres and Blob both) keeps the lower price, the one a visitor could have had.
    d.cities.set(code, Math.min(d.cities.get(code) ?? Infinity, perNight));
    byDay.set(day, d);
  };
  /** True when Postgres already gave a real (non-thin) night for the weekend being judged. */
  const dbCoversLatest = () => {
    if (!latestCheckin) return false;
    for (const { checkin, cities } of byDay.values()) if (checkin === latestCheckin && cities.size >= MIN_CITIES_PER_DAY) return true;
    return false;
  };
  if (hasDb()) {
    const rows = await hotelPriceHistory(HISTORY_DAYS);
    for (const r of rows) add(r.cityCode, (r.seenAt ?? "").slice(0, 10), r.checkin, r.perNight);
  }
  if (!dbCoversLatest()) {
    const paths: string[] = [];
    for (let i = 1; i <= HISTORY_DAYS; i++) paths.push(snapshotPath(new Date(Date.parse(latestDate) - i * 86_400_000).toISOString().slice(0, 10)));
    // Five reads at a time: the read cache keeps a found document for ten minutes anyway.
    for (let i = 0; i < paths.length; i += 5) {
      const batch = await Promise.all(paths.slice(i, i + 5).map((path) => readJson<HotelSnapshot>(path)));
      for (const got of batch) {
        if (!got || got.body.sandbox) continue;
        for (const c of got.body.cities) add(c.code, got.body.date, got.body.checkin, c.perNight);
      }
    }
  }
  const perCity = new Map<string, Map<string, number>>();
  const days = new Map<string, Set<string>>();
  for (const [day, { checkin, cities }] of byDay) {
    if (cities.size < MIN_CITIES_PER_DAY) continue;
    const set = days.get(checkin) ?? new Set<string>();
    set.add(day);
    days.set(checkin, set);
    for (const [code, perNight] of cities) {
      const key = cityKey(code, checkin);
      const m = perCity.get(key) ?? new Map<string, number>();
      m.set(day, perNight);
      perCity.set(key, m);
    }
  }
  return { perCity, days };
}

/** The current hotel deals, memoised an hour. Never throws: a missing store or history is a status. */
export async function hotelDeals(): Promise<HotelDealsResult> {
  const hit = memo.get("deals");
  if (hit) return hit;
  const generatedAt = new Date().toISOString();
  if (!hasStore()) return { status: "no-store", note: "No Blob store configured (SETUP.md §12), so there are no hotel snapshots.", snapshots: 0, deals: [], generatedAt };
  const latest = await readJson<HotelSnapshot>(LATEST_PATH);
  if (!latest || !latest.body.cities?.length) {
    const r: HotelDealsResult = { status: "no-data", note: "No hotel snapshot yet; the nightly job writes the first one.", snapshots: 0, deals: [], generatedAt };
    memo.set("deals", r);
    return r;
  }
  const snap = latest.body;
  // A sandbox or thin latest snapshot is never a night of prices to compare. Thin and
  // complete means the full nightly run priced too few cities (a LiteAPI outage), which is
  // not a test run, so the note says what happened instead of promising a first real one.
  if (snap.sandbox || snap.cities.length < MIN_CITIES_PER_DAY) {
    const note = snap.sandbox
      ? "The latest snapshot is a test run (sandbox rates); the nightly job writes the first real one."
      : snap.complete
        ? `Tonight's snapshot priced only ${snap.cities.length} of ${FULL_CITIES} cities, so there are no hotel deals tonight; the next nightly run should fill it in.`
        : `The latest snapshot is a test run (${snap.cities.length} cities); the nightly job writes the first real one.`;
    const r: HotelDealsResult = { status: "no-data", note, snapshots: 0, deals: [], generatedAt };
    memo.set("deals", r);
    return r;
  }
  const { perCity, days } = await hotelHistory(snap.date, snap.checkin);
  // Only the nights that priced the same weekend count: after the Saturday rollover the count starts again.
  const snapshots = (days.get(snap.checkin)?.size ?? 0) + 1;
  const meta = { date: snap.date, checkin: snap.checkin, checkout: snap.checkout, cities: snap.cities.length };
  if (snapshots < MIN_SNAPSHOTS) {
    const r: HotelDealsResult = { status: "warming-up", note: `Warming up: ${snapshots} of ${MIN_SNAPSHOTS} nightly snapshots for the weekend of ${snap.checkin} so far. Deals compare a weekend with its own history, which starts again when the window rolls to the next Friday.`, snapshots, latest: meta, deals: [], generatedAt };
    memo.set("deals", r);
    return r;
  }
  const deals: HotelDeal[] = [];
  for (const c of snap.cities) {
    const prev = perCity.get(cityKey(c.code, snap.checkin));
    if (!prev || prev.size < MIN_SNAPSHOTS - 1) continue;
    const typical = median([...prev.values()]);
    if (!(typical > 0) || c.perNight > typical * (1 - DROP)) continue;
    deals.push({
      code: c.code,
      city: c.name,
      country: c.country,
      lat: c.lat,
      lon: c.lon,
      hotel: c.hotelName,
      hotelId: c.hotelId,
      stars: c.stars,
      rating: c.rating,
      price: c.perNight,
      typical: Math.round(typical),
      below: Math.round((1 - c.perNight / typical) * 100),
      samples: prev.size,
      checkin: snap.checkin,
      checkout: snap.checkout,
      currency: c.currency,
    });
  }
  deals.sort((a, b) => b.below - a.below || a.price - b.price);
  const r: HotelDealsResult = { status: "ok", snapshots, latest: meta, deals, generatedAt };
  memo.set("deals", r);
  return r;
}
