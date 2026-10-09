// Source 1: OurAirports. Public domain, refreshed nightly.
// Keeps only airports with scheduled passenger service and an IATA code: the nodes of the air graph.
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { recordManifest } from "./manifest";

const SRC = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OUT = "public/data/airports.json";

const instance = await DuckDBInstance.create();
const db = await instance.connect();
await mkdir("public/data", { recursive: true });

await db.run(`
  COPY (
    SELECT
      iata_code              AS iata,
      ident                  AS icao,
      name,
      municipality           AS city,
      iso_country            AS country,
      iso_region             AS region,
      replace(type, '_airport', '') AS size,
      round(latitude_deg, 4)  AS lat,
      round(longitude_deg, 4) AS lon
    FROM read_csv('${SRC}', header = true)
    WHERE scheduled_service = 'yes'
      AND iata_code IS NOT NULL AND iata_code <> ''
      AND type IN ('large_airport', 'medium_airport', 'small_airport')
    ORDER BY size, name
  ) TO '${OUT}' (FORMAT JSON, ARRAY true)
`);

const count = await db.runAndReadAll(`SELECT count(*)::INTEGER AS n FROM read_json_auto('${OUT}')`);
const rows = Number(count.getRowObjects()[0].n);

await recordManifest("airports", {
  source: "OurAirports",
  url: SRC,
  licence: "Public domain",
  note: "Airports with scheduled passenger service and an IATA code.",
  fetchedAt: new Date().toISOString(),
  rows,
  file: OUT,
});
