// Source 5: GTFS timetables → the ground graph. For every feed in feeds.ts: download the zip,
// unpack it, and let DuckDB turn stop_times into "direct connections": every pair of stops a
// single trip serves, with the shortest in-vehicle time and how many trips a week do it.
// Stations from all feeds are clustered on a ~500 m grid so "Wien Hbf" is one node.
//
// Usage: pnpm ingest:gtfs            (all feeds)
//        pnpm ingest:gtfs de-fv      (one feed)
import { DuckDBInstance } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { haversineKm } from "../../lib/geo";
import { FEEDS, type Feed } from "./feeds";
import { recordManifest } from "./manifest";

const RAW = "data/raw/gtfs";
const OUT = "public/data/ground-graph.json";
const GRID = 200; // 1/200 degree ≈ 500 m: stops closer than that are one station

type Station = { id: number; name: string; lat: number; lon: number; feeds: string[] };
type Edge = { from: number; to: number; minutes: number; tripsPerWeek: number; mode: string };

const wanted = process.argv.slice(2);
const feeds = wanted.length ? FEEDS.filter((f) => wanted.includes(f.id)) : FEEDS;
if (!feeds.length) throw new Error(`No feed matches ${wanted.join(", ")}`);

async function download(feed: Feed): Promise<string> {
  const dir = `${RAW}/${feed.id}`;
  await mkdir(dir, { recursive: true });
  const res = await fetch(feed.url);
  if (!res.ok) throw new Error(`${feed.id}: HTTP ${res.status} from ${feed.url}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip);
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith(".txt") && !name.includes("/")) await writeFile(`${dir}/${name}`, data);
  }
  console.log(`${feed.id}: ${(zip.length / 1e6).toFixed(1)} MB, ${Object.keys(files).length} files`);
  return dir;
}

const secs = (col: string) =>
  `(split_part(${col}, ':', 1)::INT * 3600 + split_part(${col}, ':', 2)::INT * 60 + split_part(${col}, ':', 3)::INT)`;

const stations = new Map<string, Station>();
const edgeAgg = new Map<string, Edge>();
const feedStats: Record<string, { stations: number; edges: number }> = {};

function stationFor(name: string, lat: number, lon: number, feedId: string): number {
  const key = `${Math.round(lat * GRID)},${Math.round(lon * GRID)}`;
  let s = stations.get(key);
  if (!s) {
    s = { id: stations.size, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), feeds: [] };
    stations.set(key, s);
  }
  if (!s.feeds.includes(feedId)) s.feeds.push(feedId);
  return s.id;
}

for (const feed of feeds) {
  const dir = await download(feed);
  const db = await (await DuckDBInstance.create()).connect();
  const csv = (f: string) => `read_csv('${dir}/${f}', header = true, all_varchar = true)`;

  // Days per week each service runs: calendar.txt, or calendar_dates.txt when that is all there is.
  const hasCalendar = existsSync(`${dir}/calendar.txt`);
  const hasDates = existsSync(`${dir}/calendar_dates.txt`);
  const serviceSql = hasCalendar
    ? `SELECT service_id, (monday::INT + tuesday::INT + wednesday::INT + thursday::INT + friday::INT + saturday::INT + sunday::INT) AS days FROM ${csv("calendar.txt")}`
    : hasDates
      ? `SELECT service_id, least(7, count(*) * 7.0 / greatest(1, date_diff('day', min(strptime(date, '%Y%m%d')), max(strptime(date, '%Y%m%d'))) + 1)) AS days
         FROM ${csv("calendar_dates.txt")} WHERE exception_type = '1' GROUP BY service_id`
      : `SELECT NULL::VARCHAR AS service_id, 7 AS days WHERE false`;

  await db.run(`
    CREATE TABLE services AS ${serviceSql};
    CREATE TABLE stops AS
      SELECT stop_id, stop_name, stop_lat::DOUBLE AS lat, stop_lon::DOUBLE AS lon,
             COALESCE(NULLIF(parent_station, ''), stop_id) AS station
      FROM ${csv("stops.txt")}
      WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL;
    CREATE TABLE trips AS
      SELECT t.trip_id, t.service_id, r.route_type
      FROM ${csv("trips.txt")} t JOIN ${csv("routes.txt")} r USING (route_id);
    CREATE TABLE st AS
      SELECT trip_id, stop_sequence::INT AS seq, stop_id,
             ${secs("arrival_time")} AS arr, ${secs("departure_time")} AS dep
      FROM ${csv("stop_times.txt")}
      WHERE arrival_time IS NOT NULL AND departure_time IS NOT NULL AND arrival_time <> '' AND departure_time <> '';
  `);

  // Every (from, to) a single trip serves, weighted by how many days a week that trip runs.
  const reader = await db.runAndReadAll(`
    WITH pairs AS (
      SELECT a.stop_id AS from_stop, b.stop_id AS to_stop, (b.arr - a.dep) AS s,
             COALESCE(sv.days, 1) AS days, t.route_type
      FROM st a
      JOIN st b ON a.trip_id = b.trip_id AND b.seq > a.seq AND b.seq - a.seq <= 40
      JOIN trips t ON t.trip_id = a.trip_id
      LEFT JOIN services sv ON sv.service_id = t.service_id
      WHERE b.arr > a.dep
    )
    SELECT sf.station AS from_station, sf.stop_name AS from_name, sf.lat AS from_lat, sf.lon AS from_lon,
           stt.station AS to_station, stt.stop_name AS to_name, stt.lat AS to_lat, stt.lon AS to_lon,
           min(s)::INT AS min_secs, sum(days)::DOUBLE AS trips_per_week, any_value(route_type) AS route_type
    FROM pairs p
    JOIN stops sf ON sf.stop_id = p.from_stop
    JOIN stops stt ON stt.stop_id = p.to_stop
    WHERE sf.station <> stt.station
    GROUP BY 1,2,3,4,5,6,7,8
  `);
  const rows = reader.getRowObjects() as Record<string, unknown>[];

  const before = stations.size;
  let edges = 0;
  for (const r of rows) {
    const from = stationFor(String(r.from_name), Number(r.from_lat), Number(r.from_lon), feed.id);
    const to = stationFor(String(r.to_name), Number(r.to_lat), Number(r.to_lon), feed.id);
    if (from === to) continue;
    const mode = modeOf(String(r.route_type), feed.mode);
    const key = `${from}>${to}>${mode}`;
    const minutes = Math.round(Number(r.min_secs) / 60);
    const tpw = Math.round(Number(r.trips_per_week));
    const prev = edgeAgg.get(key);
    if (prev) {
      prev.minutes = Math.min(prev.minutes, minutes);
      prev.tripsPerWeek += tpw;
    } else {
      edgeAgg.set(key, { from, to, minutes, tripsPerWeek: tpw, mode });
      edges++;
    }
  }
  feedStats[feed.id] = { stations: stations.size - before, edges };
  console.log(`${feed.id}: +${stations.size - before} stations, ${edges} direct connections`);

  await recordManifest(`gtfs:${feed.id}`, {
    source: feed.name,
    url: feed.url,
    licence: feed.licence,
    note: `${feed.attribution}. Direct connections with shortest in-vehicle time; not a timetable.`,
    fetchedAt: new Date().toISOString(),
    rows: edges,
    file: OUT,
  });
}

function modeOf(routeType: string, fallback: Feed["mode"]): string {
  const t = Number(routeType);
  if ([0, 1, 2].includes(t) || (t >= 100 && t < 200) || (t >= 400 && t < 500)) return "rail";
  if (t === 3 || (t >= 200 && t < 300) || (t >= 700 && t < 800)) return "coach";
  if (t === 4 || (t >= 1000 && t < 1100)) return "ferry";
  return fallback === "mixed" ? "other" : fallback;
}

// Walking transfers: a coach stop and the rail station of the same town are different nodes,
// so connect every pair of stations within 1.5 km (5 min plus 4.5 km/h).
const WALK_KM = 1.5;
const CELL = 0.02;
const cellKey = (lat: number, lon: number) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
const cells = new Map<string, Station[]>();
for (const s of stations.values()) {
  const k = cellKey(s.lat, s.lon);
  const list = cells.get(k);
  if (list) list.push(s);
  else cells.set(k, [s]);
}
let walks = 0;
for (const s of stations.values()) {
  const cl = Math.floor(s.lat / CELL);
  const co = Math.floor(s.lon / CELL);
  for (let dl = -1; dl <= 1; dl++) {
    for (let dn = -1; dn <= 1; dn++) {
      for (const t of cells.get(`${cl + dl},${co + dn}`) ?? []) {
        if (t.id <= s.id) continue;
        const km = haversineKm(s.lat, s.lon, t.lat, t.lon);
        if (km > WALK_KM) continue;
        const minutes = Math.round(5 + (km / 4.5) * 60);
        edgeAgg.set(`${s.id}>${t.id}>walk`, { from: s.id, to: t.id, minutes, tripsPerWeek: 0, mode: "walk" });
        edgeAgg.set(`${t.id}>${s.id}>walk`, { from: t.id, to: s.id, minutes, tripsPerWeek: 0, mode: "walk" });
        walks++;
      }
    }
  }
}
console.log(`walking transfers: ${walks} station pairs`);

// Compact arrays keep the file small: edges are [from, to, minutes, tripsPerWeek, modeIndex].
const MODES = ["rail", "coach", "ferry", "other", "walk"];
const graph = {
  generatedAt: new Date().toISOString(),
  feeds: feeds.map((f) => ({ id: f.id, name: f.name, licence: f.licence, attribution: f.attribution })),
  modes: MODES,
  stations: [...stations.values()].map((s) => [s.name, s.lat, s.lon] as const),
  edges: [...edgeAgg.values()].map((e) => [e.from, e.to, e.minutes, e.tripsPerWeek, MODES.indexOf(e.mode)] as const),
};

// Merge with a previous run when only some feeds were refreshed? Not yet: a partial run rewrites
// the whole graph, so run all feeds for a release build.
await mkdir("public/data", { recursive: true });
await writeFile(OUT, JSON.stringify(graph) + "\n");
const size = (await readFile(OUT)).length;
console.log(`ground graph: ${graph.stations.length} stations, ${graph.edges.length} edges, ${(size / 1e6).toFixed(1)} MB → ${OUT}`);
