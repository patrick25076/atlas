// Server-only. Hotels with live prices from LiteAPI (LITEAPI_KEY; sandbox keys answer with
// test rates, so prices only show on the site when LITEAPI_ENV=production). The cheapest few
// decent hotels near a point for given nights. Each lookup is two LiteAPI calls and counts as
// two against the daily LiteAPI cap (lib/usage-caps.ts); past it the answer is an error with
// "daily limit reached". The nightly snapshot job runs on GitHub Actions and is not counted.
import { allowUsage } from "./usage-caps";

export type Hotel = { id: string; name: string; stars?: number; rating?: number; lat?: number; lon?: number; total?: number; perNight?: number; currency: string; image?: string };
export type HotelsResult = { status: "ok" | "no-key" | "sandbox" | "error"; note?: string; checkin: string; checkout: string; hotels: Hotel[] };

const BASE = "https://api.liteapi.travel/v3.0";

export function hasLiteApi(): boolean {
  return !!process.env.LITEAPI_KEY?.trim();
}
export function liteApiLive(): boolean {
  return (process.env.LITEAPI_ENV ?? "sandbox").trim() === "production";
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  const key = process.env.LITEAPI_KEY?.trim();
  if (!key) return null;
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { "X-API-Key": key, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) {
    console.log(`liteapi: ${r.status} ${path}`);
    return null;
  }
  return (await r.json()) as T;
}

type HotelRow = { id: string; name: string; stars?: number; rating?: number; latitude?: number; longitude?: number; main_photo?: string; thumbnail?: string };
type RatesRow = { hotelId: string; roomTypes?: { rates?: { retailRate?: { total?: { amount?: number; currency?: string }[] } }[] }[] };

export async function hotelsNear(lat: number, lon: number, checkin: string, checkout: string, nationality = "RO"): Promise<HotelsResult> {
  if (!hasLiteApi()) return { status: "no-key", note: "LiteAPI key missing (SETUP.md §5)", checkin, checkout, hotels: [] };
  if (!(await allowUsage("liteapi", 2)).ok) return { status: "error", note: "daily limit reached", checkin, checkout, hotels: [] };
  const list = await call<{ data?: HotelRow[] }>(`/data/hotels?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&distance=4000&limit=40`, { next: { revalidate: 86_400 } } as RequestInit);
  const rows = (list?.data ?? []).filter((h) => (h.stars ?? 3) >= 3 && (h.rating ?? 7) >= 7).slice(0, 25);
  if (!rows.length) return { status: liteApiLive() ? "ok" : "sandbox", checkin, checkout, hotels: [] };
  const rates = await call<{ data?: RatesRow[] }>("/hotels/rates", {
    method: "POST",
    body: JSON.stringify({ hotelIds: rows.map((h) => h.id), occupancies: [{ adults: 1 }], currency: "EUR", guestNationality: nationality, checkin, checkout }),
  });
  const nights = Math.max(1, Math.round((Date.parse(checkout) - Date.parse(checkin)) / 86_400_000));
  const byId = new Map(rows.map((h) => [h.id, h]));
  const hotels: Hotel[] = [];
  for (const r of rates?.data ?? []) {
    const h = byId.get(r.hotelId);
    if (!h) continue;
    let best: number | undefined;
    for (const rt of r.roomTypes ?? []) for (const rate of rt.rates ?? []) for (const t of rate.retailRate?.total ?? []) if (t.amount != null && (best == null || t.amount < best)) best = t.amount;
    if (best == null) continue;
    hotels.push({ id: h.id, name: h.name, stars: h.stars, rating: h.rating, lat: h.latitude, lon: h.longitude, total: Math.round(best), perNight: Math.round(best / nights), currency: "EUR", image: h.main_photo ?? h.thumbnail });
  }
  hotels.sort((a, b) => (a.perNight ?? 1e9) - (b.perNight ?? 1e9));
  return { status: liteApiLive() ? "ok" : "sandbox", note: liteApiLive() ? undefined : "sandbox key: test prices, not shown to visitors", checkin, checkout, hotels: hotels.slice(0, 6) };
}
