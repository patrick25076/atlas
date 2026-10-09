// Source 4: Travelpayouts static airline list (free, no token). Turns "W6" into "Wizz Air".
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const SRC = "https://api.travelpayouts.com/data/en/airlines.json";
const OUT = "public/data/airlines.json";

const instance = await DuckDBInstance.create();
const db = await instance.connect();
const reader = await db.runAndReadAll(`
  SELECT code, name
  FROM read_json_auto('${SRC}')
  WHERE is_lowcost IS NOT NULL AND code IS NOT NULL AND name IS NOT NULL AND length(code) = 2
`);
const rows = reader.getRowObjects() as { code: string; name: string }[];
const names: Record<string, string> = {};
for (const { code, name } of rows) names[code] = name;

await writeFile(OUT, JSON.stringify(names) + "\n");
await recordManifest("airlines", {
  source: "Travelpayouts airlines.json",
  url: SRC,
  licence: "Travelpayouts static data (free for partner use)",
  note: "IATA airline code → name.",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(names).length,
  file: OUT,
});
