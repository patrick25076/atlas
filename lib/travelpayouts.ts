// Server-only. Travelpayouts Aviasales Data API: cached prices from recent user searches.
// Free with a token (SETUP.md §2). Limit: 200 requests per hour per IP, so results are cached
// for an hour per query and month. Prices are indicative; the booking page shows the live one.
import citiesJson from "@/public/data/cities.json";
import type { City, Fare } from "./types";

const API = "https://api.travelpayouts.com/aviasales/v3/get_latest_prices";
const CURRENCY = "eur";
// City code → airports on the globe, biggest first (scripts/ingest/tp-airports.ts).
const CITY: Record<string, City> = citiesJson;

export function hasToken(): boolean {
  return Boolean(process.env.TRAVELPAYOUTS_TOKEN);
}

/** YYYY-MM-01 for this month and the next `count - 1`. */
export function upcomingMonths(count = 3, now = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function num(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** Aviasales search link with the partner marker, so a booking is credited. */
export function bookingUrl(link: string, from: string, to: string, departureAt: string): string {
  const marker = process.env.TRAVELPAYOUTS_MARKER;
  let path = link;
  if (!path) {
    // /search/OTP1511BCN1 = origin, DDMM, destination, 1 passenger
    const d = new Date(departureAt);
    const ddmm = `${String(d.getUTCDate()).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    path = `/search/${from}${ddmm}${to}1`;
  }
  const url = `https://www.aviasales.com${path}`;
  if (!marker) return url;
  return `${url}${url.includes("?") ? "&" : "?"}marker=${encodeURIComponent(marker)}`;
}

/** A city code (PAR) becomes the city's main airport on the globe (ORY/CDG); airports pass through. */
export function mainAirport(code: string): string {
  return CITY[code]?.airports[0] ?? code;
}

/** Accepts both the v3 item shape (price, departure_at, transfers) and the older one (value, depart_date, number_of_changes). */
export function normalise(raw: Record<string, unknown>): Fare | null {
  const srcCode = str(raw.origin_airport) || str(raw.origin);
  const dstCode = str(raw.destination_airport) || str(raw.destination);
  const src = mainAirport(srcCode);
  const dst = mainAirport(dstCode);
  const price = num(raw.price ?? raw.value);
  const departureAt = str(raw.departure_at) || str(raw.depart_date);
  if (!/^[A-Z]{3}$/.test(src) || !/^[A-Z]{3}$/.test(dst) || !Number.isFinite(price) || !departureAt) return null;
  const transfers = num(raw.transfers ?? raw.number_of_changes);
  const duration = num(raw.duration_to ?? raw.duration);
  return {
    src,
    dst,
    price: Math.round(price),
    currency: CURRENCY.toUpperCase(),
    departureAt: departureAt.slice(0, 10),
    airline: str(raw.airline),
    flightNumber: str(raw.flight_number) || undefined,
    transfers: Number.isFinite(transfers) ? transfers : 0,
    durationMin: Number.isFinite(duration) ? duration : undefined,
    // The booking search keeps the codes the API gave us: a city code finds all its airports.
    url: bookingUrl(str(raw.link), srcCode, dstCode, departureAt),
  };
}

export type FareQuery = { origin?: string; destination?: string };

/** Every cached one-way fare matching the query over the coming months, cheapest first, not deduplicated. */
export async function allFares(query: FareQuery, months = upcomingMonths()): Promise<Fare[]> {
  const token = process.env.TRAVELPAYOUTS_TOKEN;
  if (!token) return [];
  if (!query.origin && !query.destination) throw new Error("origin or destination required");
  const out: Fare[] = [];
  for (const month of months) {
    const params = new URLSearchParams({
      currency: CURRENCY,
      period_type: "month",
      beginning_of_period: month,
      one_way: "true",
      page: "1",
      limit: "1000",
      show_to_affiliates: "true",
      sorting: "price",
    });
    if (query.origin) params.set("origin", query.origin);
    if (query.destination) params.set("destination", query.destination);
    const res = await fetch(`${API}?${params}`, {
      headers: { "X-Access-Token": token, Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`Travelpayouts ${res.status} for ${JSON.stringify(query)} ${month}`);
    const body = (await res.json()) as { success?: boolean; data?: Record<string, unknown>[]; error?: string };
    if (body.success === false) throw new Error(`Travelpayouts: ${body.error ?? "request rejected"}`);
    for (const raw of body.data ?? []) {
      const fare = normalise(raw);
      if (fare && fare.src !== fare.dst) out.push(fare);
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

/** Cheapest fare per far-end airport: per destination when querying an origin, per origin otherwise. */
export function cheapestPerEnd(fares: Fare[], end: "dst" | "src"): Fare[] {
  const best = new Map<string, Fare>();
  for (const f of fares) {
    const key = f[end];
    const prev = best.get(key);
    if (!prev || f.price < prev.price) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => a.price - b.price);
}

/** Cheapest cached one-way fare per destination airport from `origin` over the coming months. */
export async function latestFares(origin: string, months = upcomingMonths()): Promise<Fare[]> {
  return cheapestPerEnd(await allFares({ origin }, months), "dst");
}

/** Cheapest cached one-way fare per origin airport into `destination` (the way home). */
export async function inboundFares(destination: string, months = upcomingMonths()): Promise<Fare[]> {
  return cheapestPerEnd(await allFares({ destination }, months), "src");
}
