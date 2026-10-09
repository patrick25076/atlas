// Source 2 (placeholder): OpenFlights routes. ODbL, and FROZEN since June 2014.
// It only tells us which airport pairs were ever connected, so the globe can draw a network
// before any live source is wired in. The UI labels it as indicative. Replaced by
// Travelpayouts "popular directions" (current, cached) once the token is set (SETUP.md §2).
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { recordManifest } from "./manifest";

const SRC = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/routes.dat";
const OUT = "public/data/routes-openflights.json";

const instance = await DuckDBInstance.create();
const db = await instance.connect();
await mkdir("public/data", { recursive: true });

// routes.dat has no header. Columns per the OpenFlights data page.
await db.run(`
  COPY (
    SELECT src, dst, count(DISTINCT airline)::INTEGER AS airlines
    FROM read_csv(
      '${SRC}',
      header = false,
      nullstr = '\\N',
      names = ['airline', 'airline_id', 'src', 'src_id', 'dst', 'dst_id', 'codeshare', 'stops', 'equipment']
    )
    WHERE stops = 0 AND src IS NOT NULL AND dst IS NOT NULL AND src <> dst
    GROUP BY src, dst
    ORDER BY src, dst
  ) TO '${OUT}' (FORMAT JSON, ARRAY true)
`);

const count = await db.runAndReadAll(`SELECT count(*)::INTEGER AS n FROM read_json_auto('${OUT}')`);
const rows = Number(count.getRowObjects()[0].n);

await recordManifest("routes", {
  source: "OpenFlights routes",
  url: SRC,
  licence: "ODbL 1.0",
  note: "Frozen June 2014. Indicative network only; not current, no prices.",
  fetchedAt: new Date().toISOString(),
  rows,
  file: OUT,
});
