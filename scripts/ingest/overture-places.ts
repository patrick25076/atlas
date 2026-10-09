// Source 12: Overture Maps places (CDLA-Permissive 2.0): 81M points of interest, read straight
// from the public S3 parquet with DuckDB. We keep no places, only counts: for each city with a
// sizeable airport, how many restaurants, cafés, bars, nightlife venues, cultural sights, parks
// and beaches, shops and places to stay lie within about 5 km of the centre. That answers
// "what is there to do" without storing anyone's database.
//
// Join strategy: places and cities both get a 0.09° grid cell; cities are expanded to their
// nine neighbouring cells, the join is a hash join on the cell, then an exact box filter.
import { DuckDBInstance } from "@duckdb/node-api";
import { readFile, writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";
import type { City } from "../../lib/types";

const RELEASE = process.env.OVERTURE_RELEASE ?? "2026-09-23.1";
const SRC = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=places/type=place/*`;
const OUT = "public/data/city-places.json";
const HALF_DEG = 0.045; // ≈ 5 km of latitude
const CELL = 0.09;

// Category families from Overture's flat taxonomy (taxonomy.primary).
const GROUP_SQL = `CASE
  WHEN cat = 'restaurant' OR cat LIKE '%_restaurant' OR cat IN ('food_court','diner','bistro','steakhouse','pizzeria','brasserie','taverna','trattoria') THEN 'food'
  WHEN cat IN ('cafe','coffee_shop','tea_room','bakery','dessert_shop','ice_cream_shop','patisserie','bubble_tea','gelato','coffee_roastery','internet_cafe') THEN 'cafe'
  WHEN cat IN ('bar','pub','brewery','beer_garden','lounge','gastropub','taproom','biergarten') OR cat LIKE '%_bar' OR cat LIKE '%_pub' THEN 'bar'
  WHEN cat IN ('night_club','dance_club','karaoke','comedy_club','jazz_club','music_venue','casino','nightlife','discotheque') OR cat LIKE '%_club' THEN 'night'
  WHEN cat IN ('museum','art_gallery','historic_site','landmark_and_historical_building','monument','theatre','theater','performing_arts','opera_house','concert_hall','cultural_center','castle','palace','cathedral','ruins','archaeological_site','zoo','aquarium','planetarium','arts_and_entertainment','tourist_attraction','observatory','fortress','memorial') OR cat LIKE '%_museum' OR cat LIKE '%_theater' OR cat LIKE '%_theatre' THEN 'culture'
  WHEN cat IN ('park','beach','national_park','state_park','hiking_trail','mountain','lake','waterfall','nature_preserve','garden','botanical_garden','scenic_point','lookout','island','forest','cave','hot_spring','ski_resort','ski_area','marina','river','dog_park','playground','beach_resort','surf_spot','dive_spot') OR cat LIKE '%_park' OR cat LIKE '%_beach' OR cat LIKE '%_trail' THEN 'nature'
  WHEN cat IN ('shopping_mall','shopping','market','flea_market','farmers_market','souvenir_shop','department_store','outlet_store','night_market','street_market','antique_store','bookstore','gift_shop','shopping_center') THEN 'shop'
  WHEN cat IN ('hotel','lodging','hostel','bed_and_breakfast','motel','resort','guest_house','inn','vacation_rental','boutique_hotel','apartment_hotel','campground','rv_park','holiday_apartment','aparthotel','pension','ryokan','riad') OR cat LIKE '%_hotel' THEN 'stay'
END`;

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const airports = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const size = new Map(airports.map((a) => [a.iata, a.size]));
const targets = Object.entries(cities).filter(([, c]) => ["large", "medium"].includes(size.get(c.airports[0]) ?? ""));

const db = await (await DuckDBInstance.create()).connect();
await db.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");
await db.run("CREATE TABLE cities (code VARCHAR, lat DOUBLE, lon DOUBLE)");
const appender = await db.createAppender("cities");
for (const [code, c] of targets) {
  appender.appendVarchar(code);
  appender.appendDouble(c.lat);
  appender.appendDouble(c.lon);
  appender.endRow();
}
appender.closeSync();

const t0 = Date.now();
console.log(`${targets.length} cities · scanning Overture ${RELEASE} (this reads the world's bbox and category columns)`);
await db.run(`
  CREATE TABLE city_cells AS
  SELECT code, lat, lon, floor(lat / ${CELL})::INT + dy AS cy, floor(lon / ${CELL})::INT + dx AS cx
  FROM cities, (VALUES (-1), (0), (1)) t(dy), (VALUES (-1), (0), (1)) u(dx);

  CREATE TABLE near AS
  SELECT c.code, p.grp
  FROM (
    SELECT grp, y, x, floor(y / ${CELL})::INT AS cy, floor(x / ${CELL})::INT AS cx
    FROM (
      SELECT ${GROUP_SQL} AS grp, bbox.ymin AS y, bbox.xmin AS x
      FROM (SELECT taxonomy.primary AS cat, bbox FROM read_parquet('${SRC}', hive_partitioning = 1))
    )
    WHERE grp IS NOT NULL
  ) p
  JOIN city_cells c ON c.cy = p.cy AND c.cx = p.cx
  WHERE p.y BETWEEN c.lat - ${HALF_DEG} AND c.lat + ${HALF_DEG}
    AND p.x BETWEEN c.lon - ${HALF_DEG} / cos(radians(c.lat)) AND c.lon + ${HALF_DEG} / cos(radians(c.lat));
`);
console.log(`scan + join: ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const rows = (await db.runAndReadAll("SELECT code, grp, count(*)::INT AS n FROM near GROUP BY 1, 2")).getRowObjects() as {
  code: string;
  grp: string;
  n: number;
}[];
const out: Record<string, Record<string, number>> = {};
for (const r of rows) (out[r.code] ??= {})[r.grp] = Number(r.n);

await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("cityPlaces", {
  source: `Overture Maps places ${RELEASE}`,
  url: "https://docs.overturemaps.org/guides/places/",
  licence: "CDLA-Permissive 2.0",
  note: "Counts of restaurants, cafés, bars, nightlife, culture, nature, shops and lodging within ~5 km of each city centre. No places stored.",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`city places: ${Object.keys(out).length} cities → ${OUT}`);
