// Source 13: GeoNames cities15000 (CC BY 4.0): every town over 15,000 people with population
// and coordinates. Two uses: population on the place card (and in ranking), and a proper town
// name for stations ("Comarnic", not "Comarnic Hm."). Output: public/data/towns.json, compact
// rows [name, lat, lon, country, population], and population merged into cities.json.
import { DuckDBInstance } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { haversineKm } from "../../lib/geo";
import { recordManifest } from "./manifest";
import type { City } from "../../lib/types";

const SRC = "https://download.geonames.org/export/dump/cities15000.zip";
const RAW = "data/raw/geonames";
const OUT = "public/data/towns.json";

await mkdir(RAW, { recursive: true });
const res = await fetch(SRC, { headers: { "User-Agent": "atlas travel globe (https://github.com/patrick25076/atlas)" } });
if (!res.ok) throw new Error(`GeoNames ${res.status}`);
const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
await writeFile(`${RAW}/cities15000.txt`, files["cities15000.txt"]);

const db = await (await DuckDBInstance.create()).connect();
const rows = (
  await db.runAndReadAll(`
    SELECT name, lat::DOUBLE AS lat, lon::DOUBLE AS lon, cc, pop::BIGINT AS pop
    FROM read_csv('${RAW}/cities15000.txt', delim = '\t', header = false, quote = '', escape = '',
      columns = {
        'geonameid': 'VARCHAR', 'name': 'VARCHAR', 'asciiname': 'VARCHAR', 'alternatenames': 'VARCHAR',
        'lat': 'VARCHAR', 'lon': 'VARCHAR', 'fclass': 'VARCHAR', 'fcode': 'VARCHAR', 'cc': 'VARCHAR', 'cc2': 'VARCHAR',
        'admin1': 'VARCHAR', 'admin2': 'VARCHAR', 'admin3': 'VARCHAR', 'admin4': 'VARCHAR',
        'pop': 'VARCHAR', 'elevation': 'VARCHAR', 'dem': 'VARCHAR', 'timezone': 'VARCHAR', 'modified': 'VARCHAR'
      })
    WHERE fclass = 'P' AND pop IS NOT NULL AND pop <> ''
    ORDER BY pop DESC
  `)
).getRowObjects() as { name: string; lat: number; lon: number; cc: string; pop: number | bigint }[];

const towns = rows.map((r) => [r.name, +r.lat.toFixed(4), +r.lon.toFixed(4), r.cc, Number(r.pop)] as const);
await writeFile(OUT, JSON.stringify(towns) + "\n");

// Population for our airport cities: the biggest GeoNames town within 20 km of the city centre.
const citiesPath = "public/data/cities.json";
const cities = JSON.parse(await readFile(citiesPath, "utf8")) as Record<string, City & { pop?: number }>;
const CELL = 0.25;
const grid = new Map<string, (typeof towns)[number][]>();
for (const t of towns) {
  const k = `${Math.floor(t[1] / CELL)},${Math.floor(t[2] / CELL)}`;
  const list = grid.get(k);
  if (list) list.push(t);
  else grid.set(k, [t]);
}
let matched = 0;
for (const c of Object.values(cities)) {
  const cl = Math.floor(c.lat / CELL);
  const co = Math.floor(c.lon / CELL);
  let best = 0;
  for (let dl = -1; dl <= 1; dl++) {
    for (let dn = -1; dn <= 1; dn++) {
      for (const t of grid.get(`${cl + dl},${co + dn}`) ?? []) {
        if (t[4] > best && haversineKm(c.lat, c.lon, t[1], t[2]) <= 20) best = t[4];
      }
    }
  }
  if (best) {
    c.pop = best;
    matched++;
  } else {
    delete c.pop;
  }
}
await writeFile(citiesPath, JSON.stringify(cities) + "\n");

await recordManifest("towns", {
  source: "GeoNames cities15000",
  url: SRC,
  licence: "CC BY 4.0",
  note: `Towns over 15,000 people with population; ${matched} airport cities got a population.`,
  fetchedAt: new Date().toISOString(),
  rows: towns.length,
  file: OUT,
});
console.log(`towns: ${towns.length} · cities with population: ${matched}`);
