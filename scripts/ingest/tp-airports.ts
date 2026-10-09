// Source 3: Travelpayouts static cities + airports (free, no token). Two jobs:
//  - the fares API answers with city codes (PAR, LON, BUH) as often as airport codes;
//  - a place on the globe is a city, not an airport (Bucharest, not "Otopeni"; one Istanbul).
// Output: { [cityCode]: { name, country, lat, lon, airports: [biggest first] } }, only for cities
// with at least one airport on our globe.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile, writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const AIRPORTS = "https://api.travelpayouts.com/data/en/airports.json";
const CITIES = "https://api.travelpayouts.com/data/en/cities.json";
const OUT = "public/data/cities.json";

type City = { name: string; country: string; lat: number; lon: number; airports: string[] };

const db = await (await DuckDBInstance.create()).connect();
const airportRows = (
  await db.runAndReadAll(`
    SELECT city_code, code
    FROM read_json_auto('${AIRPORTS}')
    WHERE flightable = true AND iata_type = 'airport' AND city_code IS NOT NULL AND code IS NOT NULL
  `)
).getRowObjects() as { city_code: string; code: string }[];
const cityRows = (
  await db.runAndReadAll(`
    SELECT code, name, country_code, coordinates.lat AS lat, coordinates.lon AS lon
    FROM read_json_auto('${CITIES}')
    WHERE code IS NOT NULL AND name IS NOT NULL
  `)
).getRowObjects() as { code: string; name: string; country_code: string; lat: number | null; lon: number | null }[];

// Only airports on our globe matter, ordered large → medium → small.
const ours = JSON.parse(await readFile("public/data/airports.json", "utf8")) as {
  iata: string;
  size: string;
  lat: number;
  lon: number;
  country: string;
  city: string | null;
  name: string;
}[];
const byIata = new Map(ours.map((a) => [a.iata, a]));
const rank = (iata: string) => {
  const s = byIata.get(iata)?.size;
  return s === "large" ? 0 : s === "medium" ? 1 : 2;
};

const cities: Record<string, City> = {};
for (const { city_code, code } of airportRows) {
  if (!byIata.has(code)) continue;
  (cities[city_code] ??= { name: "", country: "", lat: 0, lon: 0, airports: [] }).airports.push(code);
}
const meta = new Map(cityRows.map((c) => [c.code, c]));
for (const [code, city] of Object.entries(cities)) {
  city.airports.sort((a, b) => rank(a) - rank(b));
  const m = meta.get(code);
  const first = byIata.get(city.airports[0])!;
  city.name = m?.name ?? first.city ?? first.name;
  city.country = m?.country_code ?? first.country;
  city.lat = +(m?.lat ?? first.lat).toFixed(4);
  city.lon = +(m?.lon ?? first.lon).toFixed(4);
}

await writeFile(OUT, JSON.stringify(cities) + "\n");
await recordManifest("cities", {
  source: "Travelpayouts cities.json + airports.json",
  url: CITIES,
  licence: "Travelpayouts static data (free for partner use)",
  note: "City IATA code → name, coordinates, airports on the globe (biggest first).",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(cities).length,
  file: OUT,
});
