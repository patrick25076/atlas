// Server-only. Restaurants, cafés and sweet places near a point from the Foursquare Places
// API (FOURSQUARE_API_KEY): rating out of 10, price tier 1 to 4, a tip or two. The one keyed
// source of ratings that may be shown on a non-Google map. Cached a day per query; a 429 (no
// credits on the Foursquare org) is reported, not thrown.
export type Eat = { id: string; name: string; rating?: number; price?: number; category?: string; address?: string; tip?: string; lat?: number; lon?: number; distance?: number; url?: string };
export type EatsResult = { status: "ok" | "no-key" | "no-credits" | "error"; note?: string; places: Eat[] };

const BASE = "https://places-api.foursquare.com";

export function hasFoursquare(): boolean {
  return !!process.env.FOURSQUARE_API_KEY?.trim();
}

type Place = {
  fsq_place_id: string;
  name: string;
  rating?: number;
  price?: number;
  distance?: number;
  categories?: { name: string }[];
  location?: { formatted_address?: string; locality?: string };
  latitude?: number;
  longitude?: number;
  tips?: { text: string }[];
  website?: string;
  popularity?: number;
};

export async function eatsNear(lat: number, lon: number, query = "restaurant", opts: { radius?: number; limit?: number; maxPrice?: number } = {}): Promise<EatsResult> {
  const key = process.env.FOURSQUARE_API_KEY?.trim();
  if (!key) return { status: "no-key", note: "Foursquare key missing (SETUP.md §13)", places: [] };
  const q = new URLSearchParams({
    ll: `${lat.toFixed(4)},${lon.toFixed(4)}`,
    query,
    radius: String(opts.radius ?? 3000),
    limit: String(Math.min(50, opts.limit ?? 30)),
    fields: "fsq_place_id,name,rating,price,distance,categories,location,latitude,longitude,tips,website,popularity",
  });
  try {
    const r = await fetch(`${BASE}/places/search?${q}`, {
      headers: { Authorization: `Bearer ${key}`, "X-Places-Api-Version": "2025-06-17", Accept: "application/json" },
      next: { revalidate: 86_400 },
    });
    if (r.status === 429) return { status: "no-credits", note: "Foursquare: no API credits on the organisation; enable billing on foursquare.com/developers/orgs (the free allowance needs it)", places: [] };
    if (!r.ok) return { status: "error", note: `Foursquare ${r.status}`, places: [] };
    const j = (await r.json()) as { results?: Place[] };
    const places = (j.results ?? [])
      .filter((p) => p.rating != null && (opts.maxPrice == null || p.price == null || p.price <= opts.maxPrice))
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0))
      .map((p) => ({
        id: p.fsq_place_id,
        name: p.name,
        rating: p.rating,
        price: p.price,
        category: p.categories?.[0]?.name,
        address: p.location?.formatted_address,
        tip: p.tips?.[0]?.text?.slice(0, 200),
        lat: p.latitude,
        lon: p.longitude,
        distance: p.distance,
        url: p.website,
      }));
    return { status: "ok", places };
  } catch (err) {
    return { status: "error", note: err instanceof Error ? err.message : "Foursquare failed", places: [] };
  }
}

/** "Where to eat well without paying tourist prices": rating 8+, price tier 1 or 2, best first. */
export async function goodValueEats(lat: number, lon: number): Promise<EatsResult> {
  const r = await eatsNear(lat, lon, "restaurant", { radius: 3500, limit: 50, maxPrice: 2 });
  if (r.status !== "ok") return r;
  return { ...r, places: r.places.filter((p) => (p.rating ?? 0) >= 7.8).slice(0, 8) };
}

export async function sweetsNear(lat: number, lon: number): Promise<EatsResult> {
  const r = await eatsNear(lat, lon, "ice cream gelato dessert bakery", { radius: 3000, limit: 40 });
  if (r.status !== "ok") return r;
  return { ...r, places: r.places.filter((p) => (p.rating ?? 0) >= 7.5 && /ice cream|gelato|dessert|bakery|pastry|pâtisserie|sweet|chocolate|café/i.test(p.category ?? "")).slice(0, 4) };
}
