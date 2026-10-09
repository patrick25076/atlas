// Source 15: ferry routes from Overture Maps transportation (CDLA-Permissive 2.0): water
// segments with a name, a start port and an end port. No timetable, so the ground graph gets
// an estimated crossing (30 km/h plus 30 min) once a day, labelled as such. Europe, the
// Mediterranean and the Black Sea for now; widen the bbox to add a region.
import { DuckDBInstance } from "@duckdb/node-api";
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const RELEASE = process.env.OVERTURE_RELEASE ?? "2026-09-23.1";
const SRC = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=transportation/type=segment/*`;
const OUT = "public/data/ferries.json";
const BBOX = { west: -25, east: 45, south: 27, north: 72 };
const MIN_KM = 2;

const db = await (await DuckDBInstance.create()).connect();
await db.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
const t0 = Date.now();
const rows = (
  await db.runAndReadAll(`
    SELECT names.primary AS name,
           ST_Y(ST_StartPoint(geometry)) AS lat1, ST_X(ST_StartPoint(geometry)) AS lon1,
           ST_Y(ST_EndPoint(geometry)) AS lat2, ST_X(ST_EndPoint(geometry)) AS lon2,
           ST_Length_Spheroid(geometry) / 1000 AS km
    FROM read_parquet('${SRC}', hive_partitioning = 1)
    WHERE subtype = 'water' AND names.primary IS NOT NULL
      AND bbox.xmin BETWEEN ${BBOX.west} AND ${BBOX.east} AND bbox.ymin BETWEEN ${BBOX.south} AND ${BBOX.north}
  `)
).getRowObjects() as { name: string; lat1: number; lon1: number; lat2: number; lon2: number; km: number }[];
console.log(`scan: ${((Date.now() - t0) / 1000).toFixed(0)} s, ${rows.length} named water segments`);

// One row per route name and port pair; the longest segment of a name is the crossing itself.
const best = new Map<string, (typeof rows)[number]>();
for (const r of rows) {
  if (r.km < MIN_KM) continue;
  const key = `${r.name}|${r.lat1.toFixed(2)},${r.lon1.toFixed(2)}>${r.lat2.toFixed(2)},${r.lon2.toFixed(2)}`;
  const prev = best.get(key);
  if (!prev || r.km > prev.km) best.set(key, r);
}
const out = [...best.values()].map((r) => [r.name, +r.lat1.toFixed(4), +r.lon1.toFixed(4), +r.lat2.toFixed(4), +r.lon2.toFixed(4), Math.round(r.km)] as const);
await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("ferries", {
  source: `Overture Maps transportation ${RELEASE} (water segments)`,
  url: "https://docs.overturemaps.org/guides/transportation/",
  licence: "CDLA-Permissive 2.0",
  note: "Named ferry routes with ports and length; crossing time estimated at 30 km/h plus 30 min, once a day.",
  fetchedAt: new Date().toISOString(),
  rows: out.length,
  file: OUT,
});
console.log(`ferries: ${out.length} routes → ${OUT}`);
