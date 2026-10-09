// Source 3: Travelpayouts static airport list (free, no token). Used for one thing: the fares
// API answers with city codes (PAR, LON, BUH) as often as airport codes, and the globe only
// knows airports. This maps every city code to its airports, biggest first.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile, writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const SRC = "https://api.travelpayouts.com/data/en/airports.json";
const OUT = "public/data/city-airports.json";

const instance = await DuckDBInstance.create();
const db = await instance.connect();
const reader = await db.runAndReadAll(`
  SELECT city_code, code
  FROM read_json_auto('${SRC}')
  WHERE flightable = true AND iata_type = 'airport' AND city_code IS NOT NULL AND code IS NOT NULL
`);
const rows = reader.getRowObjects() as { city_code: string; code: string }[];

// Only airports on our globe matter, ordered large → medium → small.
const ours = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const rank = new Map(ours.map((a) => [a.iata, a.size === "large" ? 0 : a.size === "medium" ? 1 : 2]));

const byCity: Record<string, string[]> = {};
for (const { city_code, code } of rows) {
  if (!rank.has(code)) continue;
  (byCity[city_code] ??= []).push(code);
}
for (const list of Object.values(byCity)) list.sort((a, b) => rank.get(a)! - rank.get(b)!);

await writeFile(OUT, JSON.stringify(byCity) + "\n");
await recordManifest("cityAirports", {
  source: "Travelpayouts airports.json",
  url: SRC,
  licence: "Travelpayouts static data (free for partner use)",
  note: "City IATA code → airports on the globe, biggest first.",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(byCity).length,
  file: OUT,
});
