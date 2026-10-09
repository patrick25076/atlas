import { headers } from "next/headers";
import GlobeLoader, { type LocationHint } from "@/components/GlobeLoader";

// Vercel adds the visitor's approximate location to every request. It is a hint, not a fix:
// the browser's own geolocation replaces it when the visitor allows it.
export default async function Page() {
  const h = await headers();
  const lat = Number(h.get("x-vercel-ip-latitude"));
  const lon = Number(h.get("x-vercel-ip-longitude"));
  const city = h.get("x-vercel-ip-city");
  const hint: LocationHint | null =
    Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)
      ? { lat, lon, label: city ? decodeURIComponent(city) : "your area" }
      : null;
  return <GlobeLoader hint={hint} />;
}
