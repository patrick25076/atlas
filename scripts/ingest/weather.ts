// Source 11: MET Norway forecasts (CC BY 4.0) for every city with a large or medium airport.
// Seven days of max/min temperature, rain and a sky symbol, so the globe can answer "where is
// it warm this weekend". Terms: identify the app in the User-Agent, stay under 20 requests a
// second, honour Expires. We run nightly, well under that.
import { readFile, writeFile } from "node:fs/promises";
import { haversineKm } from "../../lib/geo";
import { recordManifest } from "./manifest";
import { compactWeather, type City, type WeatherDay as Day } from "../../lib/types";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/weather.json";
const DAYS = 7;
const CONCURRENCY = 6;
type Series = {
  time: string;
  data: {
    instant: { details: { air_temperature?: number } };
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } };
  };
};

function summarise(timeseries: Series[]): Day[] {
  const days = new Map<string, { tmax: number; tmin: number; rain: number; sym: string }>();
  for (const e of timeseries) {
    const d = e.time.slice(0, 10);
    const hour = Number(e.time.slice(11, 13));
    const t = e.data.instant.details.air_temperature;
    const day = days.get(d) ?? { tmax: -Infinity, tmin: Infinity, rain: 0, sym: "" };
    if (typeof t === "number") {
      day.tmax = Math.max(day.tmax, t);
      day.tmin = Math.min(day.tmin, t);
    }
    // Six-hour blocks at 00/06/12/18 cover the day without double counting.
    if (hour % 6 === 0 && e.data.next_6_hours) {
      day.rain += e.data.next_6_hours.details?.precipitation_amount ?? 0;
      if (hour === 12 || (!day.sym && hour === 6)) day.sym = e.data.next_6_hours.summary?.symbol_code ?? day.sym;
    }
    days.set(d, day);
  }
  return [...days.entries()]
    .filter(([, v]) => Number.isFinite(v.tmax))
    .slice(0, DAYS)
    .map(([d, v]) => ({ d, tmax: Math.round(v.tmax), tmin: Math.round(v.tmin), rain: Math.round(v.rain * 10) / 10, sym: v.sym.replace(/_(day|night|polartwilight)$/, "") }));
}

async function forecast(lat: number, lon: number): Promise<Day[] | null> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { properties: { timeseries: Series[] } };
    return summarise(body.properties.timeseries);
  }
  return null;
}

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const airports = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const size = new Map(airports.map((a) => [a.iata, a.size]));
const targets = Object.entries(cities).filter(([, c]) => ["large", "medium"].includes(size.get(c.airports[0]) ?? ""));

const out: Record<string, Day[]> = {};
let done = 0;
const queue = [...targets];
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [code, c] = next;
    const days = await forecast(c.lat, c.lon);
    if (days?.length) out[code] = days;
    if (++done % 200 === 0) console.log(`  ${done}/${targets.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Sea temperature for coastal cities: a city within 15 km of a ferry port (scripts/ingest/
// ferries.ts) is on the water, and the port is a point the ocean forecast can answer for.
const sea: Record<string, number> = {};
try {
  const ferries = JSON.parse(await readFile("public/data/ferries.json", "utf8")) as [string, number, number, number, number, number][];
  const ports: [number, number][] = [];
  for (const f of ferries) ports.push([f[1], f[2]], [f[3], f[4]]);
  const coastal: [string, number, number][] = [];
  for (const [code, c] of targets) {
    let best: [number, number] | null = null;
    let bestKm = 15;
    for (const p of ports) {
      if (Math.abs(p[0] - c.lat) > 0.2 || Math.abs(p[1] - c.lon) > 0.3) continue;
      const km = haversineKm(c.lat, c.lon, p[0], p[1]);
      if (km < bestKm) {
        bestKm = km;
        best = p;
      }
    }
    if (best) coastal.push([code, best[0], best[1]]);
  }
  const q2 = [...coastal];
  async function seaWorker() {
    for (let next = q2.shift(); next; next = q2.shift()) {
      const [code, lat, lon] = next;
      const res = await fetch(`https://api.met.no/weatherapi/oceanforecast/2.0/complete?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { properties?: { timeseries?: { data: { instant: { details: { sea_water_temperature?: number } } } }[] } };
      const t = body.properties?.timeseries?.[0]?.data.instant.details.sea_water_temperature;
      if (typeof t === "number") sea[code] = Math.round(t);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, seaWorker));
  console.log(`sea temperature: ${Object.keys(sea).length} of ${coastal.length} coastal cities`);
} catch {
  console.log("no ferries.json yet; skipping sea temperature");
}

await writeFile(OUT, JSON.stringify(compactWeather(new Date().toISOString(), out, sea)) + "\n");
await recordManifest("weather", {
  source: "MET Norway locationforecast",
  url: "https://api.met.no/weatherapi/locationforecast/2.0/documentation",
  licence: "CC BY 4.0 (Norwegian Meteorological Institute)",
  note: `${DAYS}-day forecast for cities with a large or medium airport; sea temperature where a ferry port is within 15 km.`,
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`weather: ${Object.keys(out).length} of ${targets.length} cities`);
