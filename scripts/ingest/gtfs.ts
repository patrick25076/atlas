// Source 5: GTFS timetables → the ground graph. For every feed in feeds.ts: download the zip,
// unpack it, and let DuckDB turn stop_times into "direct connections": every pair of stops a
// single trip serves, with the shortest in-vehicle time and how many trips a week do it.
// Stations from all feeds are clustered on a ~500 m grid so "Wien Hbf" is one node.
//
// Usage: pnpm ingest:gtfs            (all feeds)
//        pnpm ingest:gtfs de-fv      (one feed)
//        GTFS_OFFLINE=1 ...          (reuse the files already in data/raw, no download)
import { DuckDBInstance } from "@duckdb/node-api";
import { unzipSync } from "fflate";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { haversineKm } from "../../lib/geo";
import { FEEDS, type Feed } from "./feeds";
import type { ManifestEntry } from "./manifest";

const RAW = "data/raw/gtfs";
// GTFS_OUT points a test run at another file (and skips the manifest), so trying one feed
// never replaces the graph the running site imports: a partial run rewrites the whole graph.
const OUT = process.env.GTFS_OUT || "public/data/ground-graph.json";
const TEST_RUN = Boolean(process.env.GTFS_OUT);
// Files in a GTFS zip the ingest never reads. shapes.txt alone is 153 MB in the Thai feed and
// the fare tables another 64 MB; writing them once filled the disk (2026-10-10).
const SKIP_FILES = new Set(["shapes.txt", "fare_attributes.txt", "fare_rules.txt", "pathways.txt", "transfers.txt", "levels.txt"]);
const GRID = 200; // 1/200 degree ≈ 500 m: stops closer than that are one station
// Fastest straight-line average a direct connection can honestly run at (a TGV leg averages
// under 300 km/h); anything above means the feed's times are placeholders, not a timetable.
// A feed can lower these per mode (feeds.ts `maxKmh`): Thailand's trains never average over 80.
const MAX_KMH: Record<string, number> = { rail: 350, coach: 140, ferry: 90, other: 140 };
// When a time is a placeholder the duration is estimated from distance. The straight line is
// shorter than the track or road, so the kilometres are stretched by DETOUR (the same 1.3 as
// driveMinutes in lib/geo.ts) and run at a slow average, so the estimate errs long: Bangkok to
// Chiang Mai (577 km straight, 751 km of rail, 11 to 13 h by train) comes out at 12.6 h.
const DETOUR = 1.3;
const ESTIMATE_KMH: Record<string, number> = { rail: 60, coach: 55, ferry: 25, other: 50 };
const estimateMinutes = (km: number, mode: string) => Math.round(5 + ((km * DETOUR) / ESTIMATE_KMH[mode]) * 60);

type Station = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  feeds: string[];
  /** Neighbouring stations on any line: 2 for a halt in the middle of a line, 3+ for a junction. */
  nbrs: Set<number>;
  /** Departures per week, summed over feeds. */
  dep: number;
  /** Nearest GeoNames town within 10 km (biggest wins) and its population. */
  town?: string;
  pop?: number;
};
type Edge = { from: number; to: number; minutes: number; tripsPerWeek: number; mode: string };

const wanted = process.argv.slice(2);
const feeds = wanted.length ? FEEDS.filter((f) => wanted.includes(f.id)) : FEEDS;
if (!feeds.length) throw new Error(`No feed matches ${wanted.join(", ")}`);

// A zip entry the ingest reads: a plain GTFS text file at the root of the archive. The feeds are
// third-party downloads, so an entry name is untrusted: one with a folder part, a backslash
// (Node treats it as a separator on Windows) or ".." could be written outside the feed folder.
function wantedEntry(name: string): boolean {
  if (!name.endsWith(".txt") || SKIP_FILES.has(name)) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return false;
  return path.basename(name) === name;
}

// When the timetable was fetched, for the manifest. Files reused from an earlier download carry
// that download's date (their mtime), not today's: PKP PLK's re-use terms require the source
// date to be stated, and the app shows the manifest's date as that date.
async function filesDate(dir: string): Promise<string> {
  return (await stat(`${dir}/stop_times.txt`)).mtime.toISOString();
}

async function fetchZip(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function download(feed: Feed): Promise<{ dir: string; fetchedAt: string }> {
  const dir = `${RAW}/${feed.id}`;
  await mkdir(dir, { recursive: true });
  const haveFiles = existsSync(`${dir}/stop_times.txt`);
  if (process.env.GTFS_OFFLINE && haveFiles) {
    console.log(`${feed.id}: GTFS_OFFLINE set, using the files in ${dir}`);
    return { dir, fetchedAt: await filesDate(dir) };
  }
  let url = feed.url;
  if (feed.resolveUrl) {
    try {
      url = await feed.resolveUrl();
    } catch (err) {
      console.log(`${feed.id}: link lookup failed (${(err as Error).message}), trying ${feed.url}`);
    }
  }
  // One quiet retry: some hosts (a private server for the Czech feed) blink, and the workflow's
  // own retry reruns all 18 feeds. A second failure falls back to an earlier download on this
  // machine when there is one; otherwise the caller skips the feed.
  let zip: Uint8Array;
  try {
    zip = await fetchZip(url).catch(async (err) => {
      console.log(`${feed.id}: ${(err as Error).message}, retrying in 20 s`);
      await new Promise((r) => setTimeout(r, 20_000));
      return fetchZip(url);
    });
  } catch (err) {
    if (!haveFiles) throw new Error(`${feed.id}: ${(err as Error).message}`);
    console.log(`${feed.id}: download failed (${(err as Error).message}), reusing the earlier files in ${dir}`);
    return { dir, fetchedAt: await filesDate(dir) };
  }
  // The filter stops fflate inflating the skipped entries at all: without it the Thai feed's
  // 153 MB shapes.txt and the SNCB zip were decompressed in memory only to be thrown away.
  const files = unzipSync(zip, { filter: (f) => wantedEntry(f.name) });
  for (const [name, data] of Object.entries(files)) {
    if (!wantedEntry(name)) continue;
    await writeFile(path.join(dir, name), data);
  }
  console.log(`${feed.id}: ${(zip.length / 1e6).toFixed(1)} MB, ${Object.keys(files).length} files kept`);
  return { dir, fetchedAt: new Date().toISOString() };
}

const secs = (col: string) =>
  `(split_part(${col}, ':', 1)::INT * 3600 + split_part(${col}, ':', 2)::INT * 60 + split_part(${col}, ':', 3)::INT)`;

// The column names of a GTFS file, from its first line. GTFS makes many columns optional
// (parent_station, agency_id), and DuckDB fails the whole query when a SELECT names a column
// the file does not have, so every optional column is checked here before it is used.
async function columnsOf(file: string): Promise<Set<string>> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const firstLine = buf.toString("utf8", 0, bytesRead).replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
    return new Set(firstLine.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  } finally {
    await fh.close();
  }
}

// A stop's name for the app. BDZ's feed names Bulgarian stations in Cyrillic only ("София"),
// which neither the traveller nor a search for "Sofia" can read; its translations.txt carries
// the English name. The translation is used only when the name is in Cyrillic or Greek script,
// so SNCB's bilingual Belgian names, which also have English entries, stay as they were.
// translations.txt keys a row either by record_id (the stop_id) or by field_value (the name).
async function stopNameSql(dir: string, csv: (f: string) => string): Promise<string> {
  const file = `${dir}/translations.txt`;
  if (!existsSync(file)) return "stop_name";
  const cols = await columnsOf(file);
  if (!cols.has("translation") || !cols.has("language") || !cols.has("table_name")) return "stop_name";
  const en = `FROM ${csv("translations.txt")} WHERE table_name = 'stops' AND field_name = 'stop_name' AND lower(language) = 'en' AND COALESCE(translation, '') <> ''`;
  const byId = cols.has("record_id") ? `(SELECT any_value(translation) ${en} AND record_id = s_id.stop_id)` : "NULL";
  const byName = cols.has("field_value") ? `(SELECT any_value(translation) ${en} AND field_value = s_id.stop_name)` : "NULL";
  return `CASE WHEN regexp_matches(stop_name, '\\p{Cyrillic}|\\p{Greek}')
               THEN COALESCE(${byId}, ${byName}, stop_name) ELSE stop_name END`;
}

// Only some of a feed's routes are wanted (feeds.ts `keep`): a national feed that mixes
// intercity trains with a capital's city buses would otherwise flood the graph with bus stops.
function routeFilterSql(feed: Feed, routeColumns: Set<string>): string {
  const clauses: string[] = [];
  const keep = feed.keep;
  if (!keep) return "";
  if (keep.routeTypes?.length) clauses.push(`r.route_type IN (${keep.routeTypes.map((t) => `'${t}'`).join(", ")})`);
  if (keep.dropAgencies?.length) {
    if (routeColumns.has("agency_id")) {
      clauses.push(`COALESCE(r.agency_id, '') NOT IN (${keep.dropAgencies.map((a) => `'${a.replace(/'/g, "''")}'`).join(", ")})`);
    } else {
      console.log(`${feed.id}: routes.txt has no agency_id column, dropAgencies ignored`);
    }
  }
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

const stations = new Map<string, Station>();
const edgeAgg = new Map<string, Edge>();
const feedStats: Record<string, { stations: number; edges: number }> = {};

// Thailand's OTP feed writes every stop name as "ไทย;English" and some with a trailing tab;
// the app shows the name, so keep the English half. No other feed uses a semicolon in names.
function cleanName(raw: string, feedId: string): string {
  const parts = raw.split(";").map((p) => p.trim()).filter(Boolean);
  const name = (parts.length > 1 ? parts[parts.length - 1] : parts[0]) ?? raw.trim();
  return /\p{Script=Cyrillic}/u.test(name) ? latinise(name, feedId.startsWith("bg-")) : name;
}

// A Cyrillic name with no English translation in the feed (the Polish feed's 26 Ukrainian
// stations, "Київ-Пасажирський") is unreadable and unsearchable, and some have no GeoNames
// town to fall back on. Ukrainian national romanisation by default, Bulgarian's for BDZ.
const UK: Record<string, string> = { а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ы: "y", э: "e", ё: "io", ъ: "", "'": "", "’": "" };
const UK_START: Record<string, string> = { є: "ye", ї: "yi", й: "y", ю: "yu", я: "ya" };
const BG: Record<string, string> = { ...UK, г: "g", и: "i", й: "y", х: "h", щ: "sht", ъ: "a", ю: "yu", я: "ya" };
function latinise(name: string, bulgarian: boolean): string {
  return name.replace(/\p{Script=Cyrillic}+(?:['’]\p{Script=Cyrillic}+)*/gu, (word) =>
    [...word]
      .map((ch, i) => {
        const lc = ch.toLowerCase();
        const t = (!bulgarian && i === 0 && UK_START[lc]) || ((bulgarian ? BG : UK)[lc] ?? "");
        return ch === lc ? t : t.charAt(0).toUpperCase() + t.slice(1);
      })
      .join(""),
  );
}

function stationFor(rawName: string, lat: number, lon: number, feedId: string): number {
  const key = `${Math.round(lat * GRID)},${Math.round(lon * GRID)}`;
  let s = stations.get(key);
  if (!s) {
    const name = cleanName(rawName, feedId);
    s = { id: stations.size, name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), feeds: [], nbrs: new Set(), dep: 0 };
    stations.set(key, s);
  }
  if (!s.feeds.includes(feedId)) s.feeds.push(feedId);
  return s.id;
}

// DuckDB is capped because this runs on a 16 GB laptop next to the dev server: the SNCB feed
// (198 MB stop_times) self-joined without a limit helped exhaust the machine's memory on
// 2026-10-10. Under the cap DuckDB spills to disk in temp_directory instead of growing.
const DUCKDB_TMP = `${RAW}/.duckdb-tmp`;
const DUCKDB_LIMITS = `SET memory_limit = '2GB'; SET threads = 2; SET preserve_insertion_order = false; SET temp_directory = '${DUCKDB_TMP}';`;

// Manifest rows wait until the graph file is written: recorded inside the loop, a run that died
// on a later feed left a manifest naming data the graph did not contain.
const manifestRows: [string, ManifestEntry][] = [];
// Feeds that could not be downloaded (nor reused from disk), or that gave no connection at all.
const failed: string[] = [];

for (const feed of feeds) {
  let dir: string;
  let fetchedAt: string;
  try {
    ({ dir, fetchedAt } = await download(feed));
  } catch (err) {
    console.log(`${(err as Error).message}: skipping this feed`);
    failed.push(feed.id);
    continue;
  }
  // A run that died mid-query leaves its spill files behind (2 GB on 2026-10-10); clear them
  // before the next feed so a crash never eats the disk twice.
  await rm(DUCKDB_TMP, { recursive: true, force: true });
  await mkdir(DUCKDB_TMP, { recursive: true });
  const instance = await DuckDBInstance.create();
  const db = await instance.connect();
  await db.run(DUCKDB_LIMITS);
  const csv = (f: string) => `read_csv('${dir}/${f}', header = true, all_varchar = true)`;

  // Days per week each service runs, counted over one 28-day window shared by the whole feed:
  // calendar.txt expanded by weekday, plus the dates calendar_dates.txt adds, minus those it
  // removes. The window starts today, or inside the feed's own dates when it has none then.
  // Before 2026-10-12 a calendar_dates-only feed was counted per service over that service's
  // own first-to-last date, so a variant running on one single date counted as daily: the
  // Polish feed (868 irregular services over a year) gave Warsaw to Gdansk 1,095 trains a week
  // instead of about 175, and lib/ground.ts turned that into a 5-minute wait instead of 30.
  const hasCalendar = existsSync(`${dir}/calendar.txt`);
  const hasDates = existsSync(`${dir}/calendar_dates.txt`);
  const serviceSql = serviceDaysSql(
    hasCalendar ? csv("calendar.txt") : null,
    hasDates ? csv("calendar_dates.txt") : null,
  );

  // parent_station is optional in GTFS (Amtrak, KTM and Thailand's feed leave it out). Without
  // it every stop is its own station; the 500 m grid in stationFor still merges platforms.
  const stopColumns = await columnsOf(`${dir}/stops.txt`);
  const stationExpr = stopColumns.has("parent_station") ? "COALESCE(NULLIF(parent_station, ''), stop_id)" : "stop_id";
  const routeFilter = routeFilterSql(feed, await columnsOf(`${dir}/routes.txt`));
  const stopNameExpr = await stopNameSql(dir, csv);

  // frequencies.txt (optional) describes a trip that repeats all day: "every 30 minutes from
  // 06:00 to 20:00". Thailand's coaches and ferries are written that way; without this a coach
  // that runs 28 times a day would count as one, and lib/ground.ts would give every such leg
  // the maximum wait. The multiplier is the number of runs a day over all of a trip's rows.
  const hasFrequencies = existsSync(`${dir}/frequencies.txt`);
  const freqSql = hasFrequencies
    ? `SELECT trip_id, greatest(1, sum(greatest(0, ${secs("end_time")} - ${secs("start_time")}) / headway_secs::DOUBLE)) AS runs
       FROM ${csv("frequencies.txt")} WHERE headway_secs IS NOT NULL AND TRY_CAST(headway_secs AS INT) > 0 GROUP BY trip_id`
    : `SELECT NULL::VARCHAR AS trip_id, 1.0 AS runs WHERE false`;
  const ceilings = { ...MAX_KMH, ...feed.maxKmh };
  const maxKmhSql = `CASE mode WHEN 'rail' THEN ${ceilings.rail} WHEN 'coach' THEN ${ceilings.coach} WHEN 'ferry' THEN ${ceilings.ferry} ELSE ${ceilings.other} END`;

  await db.run(`
    CREATE TABLE services AS ${serviceSql};
    CREATE TABLE stops AS
      SELECT stop_id, ${stopNameExpr} AS stop_name, stop_lat::DOUBLE AS lat, stop_lon::DOUBLE AS lon,
             ${stationExpr} AS station
      FROM ${csv("stops.txt")} s_id
      WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL AND stop_lat <> '' AND stop_lon <> '';
    CREATE TABLE trips AS
      SELECT t.trip_id, t.service_id, t.route_id, ${modeSql("r.route_type", feed.mode)} AS mode
      FROM ${csv("trips.txt")} t JOIN ${csv("routes.txt")} r USING (route_id)
      ${routeFilter};
    CREATE TABLE st AS
      SELECT trip_id, stop_sequence::INT AS seq, stop_id,
             ${secs("arrival_time")} AS arr, ${secs("departure_time")} AS dep
      FROM ${csv("stop_times.txt")}
      WHERE arrival_time IS NOT NULL AND departure_time IS NOT NULL AND arrival_time <> '' AND departure_time <> ''
        -- Only the kept routes' trips. The self-join below grows with the square of a trip's
        -- stops, and the queries join trips anyway, so dropped routes (Bangkok's 11,800 minibus
        -- stops in the Thai feed) must leave here, not after the join: with them the Thai feed
        -- made 3.7 million pairs and spilled over a gigabyte to disk; without, 63,000 pairs.
        AND trip_id IN (SELECT trip_id FROM trips);
    CREATE TABLE freq AS ${freqSql};
    -- One row per trip: its mode and how many times a week it runs.
    CREATE TABLE trip_info AS
      SELECT t.trip_id, t.mode, COALESCE(sv.days, 1) * COALESCE(fq.runs, 1) AS per_week
      FROM trips t
      LEFT JOIN services sv ON sv.service_id = t.service_id
      LEFT JOIN freq fq ON fq.trip_id = t.trip_id;
    -- A rail feed lists the same train once per calendar (SNCF: 60,000 trips), with identical
    -- stops and times. The pair query below is quadratic in a trip's stops, so it runs over
    -- distinct stop patterns, each carrying the summed weekly runs of its trips. On 2026-10-10
    -- the per-trip version spilled 2.8 GB to a full disk on the SNCF feed and died.
    -- The pattern id folds a hash of every stop row (sequence, stop, times) with XOR plus the
    -- row count: order-independent, so it needs no sorted string aggregate, which held the
    -- SNCB feed's 2.4 million rows in memory and died at the 2 GB cap.
    CREATE TABLE trip_pattern AS
      SELECT trip_id, hash(count(*), bit_xor(hash(seq, stop_id, arr, dep))) AS pid
      FROM st GROUP BY trip_id;
    -- One row per pattern: a representative trip, its mode, weekly runs, and the fastest
    -- straight-line average a time on it may imply before it counts as a placeholder.
    -- Only trips that run in the 28-day window: a pattern of a train that does not run in the
    -- next four weeks made an edge with 0 trips a week, and lib/ground.ts routed over it as a
    -- weekly train (Prague to Ostrava, 220 min, 0 a week). A feed that has run out counts its
    -- last 28 days instead (serviceDaysSql), so it keeps its patterns.
    CREATE TABLE patterns AS
      SELECT pid, min(p.trip_id) AS trip_id, any_value(ti.mode) AS mode, sum(ti.per_week) AS per_week
      FROM trip_pattern p JOIN trip_info ti ON ti.trip_id = p.trip_id
      WHERE ti.per_week > 0
      GROUP BY pid;
    ALTER TABLE patterns ADD COLUMN max_kmh DOUBLE;
    UPDATE patterns SET max_kmh = ${maxKmhSql};
    CREATE TABLE pst AS
      SELECT p.pid, s.seq, s.stop_id, s.arr, s.dep FROM patterns p JOIN st s ON s.trip_id = p.trip_id;
    -- Patterns whose times are placeholders as a whole: the end-to-end run implies a speed over
    -- the ceiling, or no time at all. Thailand's feed times Bangkok to Chiang Mai at 7 minutes,
    -- and the stops in between share the same compression, so a pair inside such a trip that
    -- happens to pass the per-pair check (short hop, times a minute apart) is not real either.
    -- Stored as a column of patterns: a LEFT JOIN of this list after the self-join below sent
    -- DuckDB into a plan that spilled a gigabyte on the SNCF feed; as a flag it costs nothing.
    ALTER TABLE patterns ADD COLUMN placeholder BOOLEAN DEFAULT false;
    UPDATE patterns SET placeholder = true WHERE pid IN (
      SELECT e.pid
      FROM (SELECT pid, arg_min(stop_id, seq) AS first_stop, arg_max(stop_id, seq) AS last_stop,
                   arg_min(dep, seq) AS dep0, arg_max(arr, seq) AS arr1
            FROM pst GROUP BY pid) e
      JOIN stops a ON a.stop_id = e.first_stop
      JOIN stops b ON b.stop_id = e.last_stop
      JOIN patterns p ON p.pid = e.pid
      WHERE arr1 - dep0 <= 0 OR ${kmSql("a", "b")} / ((arr1 - dep0) / 3600.0) > p.max_kmh);
    -- One position per station (a platform's coordinates; the 500 m grid merges the rest), so
    -- the pair query groups on station ids alone and joins names and coordinates afterwards.
    CREATE TABLE station_pos AS
      SELECT station, arg_min(stop_name, stop_id) AS name, arg_min(lat, stop_id) AS lat, arg_min(lon, stop_id) AS lon
      FROM stops GROUP BY station;
  `);

  // Every (from, to) a single trip serves, weighted by how many times a week that trip runs.
  // The shortest time is taken only over plausible times (per-trip and per-pair check); a pair
  // no trip times plausibly gets NULL and is estimated by distance below. Checking before the
  // minimum matters: one glitched trip (Emmerich to Arnhem in 60 s in the German feed) used to
  // discard the 94 trips that timed the same pair at 13 minutes.
  // No cap on how many stops apart a pair may be: Amtrak's Floridian has 46 stops, Thai coaches
  // up to 144, and the old 40 cut their end-to-end edge. Size is kept in check by the route
  // filter above and the pattern table, not by trip length.
  const reader = await db.runAndReadAll(`
    WITH pairs AS (
      SELECT sf.station AS from_station, stt.station AS to_station, p.mode, p.per_week,
             -- Equal times are kept in the count (placeholder feeds give several stops the same
             -- minute); the time only counts when positive and plausible.
             CASE WHEN NOT p.placeholder AND b.arr > a.dep AND ${kmSql("sf", "stt")} / ((b.arr - a.dep) / 3600.0) <= p.max_kmh
                  THEN b.arr - a.dep END AS ok_s
      FROM pst a
      JOIN pst b ON a.pid = b.pid AND b.seq > a.seq
      JOIN patterns p ON p.pid = a.pid
      JOIN stops sf ON sf.stop_id = a.stop_id
      JOIN stops stt ON stt.stop_id = b.stop_id
      WHERE b.arr >= a.dep AND sf.station <> stt.station
    ),
    agg AS (
      SELECT from_station, to_station, mode, min(ok_s)::INT AS min_secs, sum(per_week)::DOUBLE AS trips_per_week
      FROM pairs GROUP BY 1, 2, 3
    )
    SELECT f.name AS from_name, f.lat AS from_lat, f.lon AS from_lon,
           t.name AS to_name, t.lat AS to_lat, t.lon AS to_lon,
           agg.mode, agg.min_secs, agg.trips_per_week
    FROM agg
    JOIN station_pos f ON f.station = agg.from_station
    JOIN station_pos t ON t.station = agg.to_station
  `);
  const rows = reader.getRowObjects() as Record<string, unknown>[];

  const before = stations.size;
  let edges = 0;
  let timedByDistance = 0;
  for (const r of rows) {
    const fromLat = Number(r.from_lat);
    const fromLon = Number(r.from_lon);
    const toLat = Number(r.to_lat);
    const toLon = Number(r.to_lon);
    const from = stationFor(String(r.from_name), fromLat, fromLon, feed.id);
    const to = stationFor(String(r.to_name), toLat, toLon, feed.id);
    if (from === to) continue;
    const mode = String(r.mode);
    const key = `${from}>${to}>${mode}`;
    // A pair without a plausible time keeps the connection with a distance estimate at a slow
    // average, rather than pretending to know its duration.
    const km = haversineKm(fromLat, fromLon, toLat, toLon);
    const secs = r.min_secs == null ? null : Number(r.min_secs);
    let minutes: number;
    if (secs == null || secs <= 0) {
      minutes = estimateMinutes(km, mode);
      timedByDistance++;
    } else {
      minutes = Math.round(secs / 60);
    }
    // At least 1 for a train that runs at all (once in four weeks rounds to 0 otherwise), so 0
    // in the file keeps meaning a walk, never a train that does not run.
    const perWeek = Number(r.trips_per_week);
    const tpw = perWeek > 0 ? Math.max(1, Math.round(perWeek)) : 0;
    const prev = edgeAgg.get(key);
    if (prev) {
      prev.minutes = Math.min(prev.minutes, minutes);
      prev.tripsPerWeek += tpw;
    } else {
      edgeAgg.set(key, { from, to, minutes, tripsPerWeek: tpw, mode });
      edges++;
    }
  }
  // Station importance, independent of how a feed defines "route": which stations are next to
  // each other on any trip (a halt has two neighbours, a junction three or more), and how many
  // departures a week leave each one.
  const hops = await db.runAndReadAll(`
    WITH ordered AS (
      SELECT pid, stop_id, LEAD(stop_id) OVER (PARTITION BY pid ORDER BY seq) AS next_stop FROM pst
    ),
    agg AS (
      SELECT a.station AS from_station, b.station AS to_station, sum(p.per_week)::DOUBLE AS dep_per_week
      FROM ordered o
      JOIN stops a ON a.stop_id = o.stop_id
      JOIN stops b ON b.stop_id = o.next_stop
      JOIN patterns p ON p.pid = o.pid
      WHERE a.station <> b.station
      GROUP BY 1, 2
    )
    SELECT f.name AS from_name, f.lat AS from_lat, f.lon AS from_lon,
           t.name AS to_name, t.lat AS to_lat, t.lon AS to_lon, agg.dep_per_week
    FROM agg
    JOIN station_pos f ON f.station = agg.from_station
    JOIN station_pos t ON t.station = agg.to_station
  `);
  const byId = [...stations.values()];
  for (const r of hops.getRowObjects() as Record<string, unknown>[]) {
    const from = stationFor(String(r.from_name), Number(r.from_lat), Number(r.from_lon), feed.id);
    const to = stationFor(String(r.to_name), Number(r.to_lat), Number(r.to_lon), feed.id);
    if (from === to) continue;
    const a = byId[from] ?? [...stations.values()][from];
    const b = byId[to] ?? [...stations.values()][to];
    a.nbrs.add(to);
    b.nbrs.add(from);
    a.dep += Number(r.dep_per_week);
  }

  feedStats[feed.id] = { stations: stations.size - before, edges };
  console.log(
    `${feed.id}: +${stations.size - before} stations, ${edges} direct connections` +
      (timedByDistance ? `, ${timedByDistance} timed by distance (no trip gave a plausible time)` : ""),
  );

  // Free the feed's tables before the next download; each feed gets a fresh instance, so an
  // instance left open would keep its memory for the rest of the run.
  db.closeSync();
  instance.closeSync();

  if (!rows.length) {
    console.log(`${feed.id}: no connection runs in the 28-day window; treating the feed as failed`);
    failed.push(feed.id);
    continue;
  }
  manifestRows.push([
    `gtfs:${feed.id}`,
    {
      source: feed.name,
      url: feed.url,
      licence: feed.licence,
      note: `${feed.attribution}. Direct connections with shortest in-vehicle time; not a timetable.`,
      fetchedAt,
      rows: edges,
      file: OUT,
    },
  ]);
}
// DuckDB deletes its spill files on close but leaves the folder; the run should leave no trace.
await rm(DUCKDB_TMP, { recursive: true, force: true });

// A feed the current graph has (its gtfs: row in the manifest) failed: keep the whole previous
// graph rather than ship one without, say, every Czech train. Week-old timetables are fine for
// direct connections; a missing country is not. A feed that is new this run and failed is only
// left out. Either way the run exits non-zero at the end so the workflow reports it.
const MANIFEST = "public/data/manifest.json";
async function readManifest(): Promise<Record<string, ManifestEntry>> {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8")) as Record<string, ManifestEntry>;
  } catch {
    return {};
  }
}
if (failed.length && !TEST_RUN) {
  const had = await readManifest();
  const lost = failed.filter((id) => had[`gtfs:${id}`]);
  if (lost.length) {
    console.log(`failed: ${failed.join(", ")}; the graph has ${lost.join(", ")}, so it stays as it was (nothing written)`);
    process.exit(1);
  }
}

// Days per week each service runs, as SQL over the feed's calendar files (either may be absent).
// Every service named in either file gets a row, 0 when it does not run in the window, so a
// seasonal or one-off variant adds nothing to the weekly count; a trip whose service is in
// neither file keeps the old fallback of once a week (COALESCE in trip_info).
function serviceDaysSql(calendar: string | null, dates: string | null): string {
  const WINDOW = 28;
  const ymd = (col: string) => `strptime(${col}, '%Y%m%d')::DATE`;
  const cal = calendar
    ? `SELECT service_id, ${ymd("start_date")} AS s, ${ymd("end_date")} AS e,
              [sunday, monday, tuesday, wednesday, thursday, friday, saturday] AS wd
       FROM ${calendar}`
    : `SELECT NULL::VARCHAR AS service_id, NULL::DATE AS s, NULL::DATE AS e, NULL::VARCHAR[] AS wd WHERE false`;
  const cd = dates
    ? `SELECT service_id, ${ymd("date")} AS d, exception_type::INT AS x FROM ${dates}`
    : `SELECT NULL::VARCHAR AS service_id, NULL::DATE AS d, NULL::INT AS x WHERE false`;
  return `
    WITH cal AS (${cal}), cd AS (${cd}),
    bounds AS (
      SELECT least((SELECT min(s) FROM cal), (SELECT min(d) FROM cd WHERE x = 1)) AS lo,
             greatest((SELECT max(e) FROM cal), (SELECT max(d) FROM cd WHERE x = 1)) AS hi
    ),
    -- Today when the feed runs today; otherwise its first dates (a feed published ahead) or its
    -- last four weeks (a feed that has run out), so a stale feed still has a weekly pattern.
    win AS (
      SELECT greatest(lo, least(current_date, hi - ${WINDOW - 1})) AS w0 FROM bounds
    ),
    days AS (
      SELECT (w0 + i::INTEGER)::DATE AS d FROM win, range(${WINDOW}) t(i)
    ),
    active AS (
      SELECT cal.service_id, days.d FROM cal JOIN days ON days.d BETWEEN cal.s AND cal.e
      WHERE cal.wd[dayofweek(days.d) + 1] = '1'
      UNION
      SELECT cd.service_id, cd.d FROM cd JOIN days ON days.d = cd.d WHERE cd.x = 1
      EXCEPT
      SELECT service_id, d FROM cd WHERE x = 2
    ),
    counted AS (SELECT service_id, count(*) * 7.0 / ${WINDOW} AS days FROM active GROUP BY service_id),
    named AS (SELECT service_id FROM cal UNION SELECT service_id FROM cd)
    SELECT named.service_id, COALESCE(counted.days, 0) AS days
    FROM named LEFT JOIN counted USING (service_id)`;
}

// The mode of a route from its GTFS route_type (basic and extended codes), as a SQL expression.
// Computed in DuckDB because the speed ceiling per trip depends on it.
function modeSql(routeType: string, fallback: Feed["mode"]): string {
  const rt = `TRY_CAST(${routeType} AS INT)`;
  return `CASE
    WHEN ${rt} IN (0, 1, 2) OR ${rt} BETWEEN 100 AND 199 OR ${rt} BETWEEN 400 AND 499 THEN 'rail'
    WHEN ${rt} = 3 OR ${rt} BETWEEN 200 AND 299 OR ${rt} BETWEEN 700 AND 799 THEN 'coach'
    WHEN ${rt} = 4 OR ${rt} BETWEEN 1000 AND 1099 THEN 'ferry'
    ELSE '${fallback === "mixed" ? "other" : fallback}' END`;
}

// Straight-line kilometres between two stop rows (haversine), the SQL twin of lib/geo.ts.
function kmSql(a: string, b: string): string {
  return `(2 * 6371 * asin(sqrt(pow(sin(radians(${b}.lat - ${a}.lat) / 2), 2)
          + cos(radians(${a}.lat)) * cos(radians(${b}.lat)) * pow(sin(radians(${b}.lon - ${a}.lon) / 2), 2))))`;
}

// Ferries (scripts/ingest/ferries.ts): ports become stations, crossings become edges both ways.
// Added before walking transfers so a port links to the station next to it.
let ferryEdges = 0;
try {
  const ferries = JSON.parse(await readFile("public/data/ferries.json", "utf8")) as [string, number, number, number, number, number][];
  const portName = (route: string, end: 0 | 1) => {
    const parts = route.split(/\s+[-–—]\s+/);
    return parts.length === 2 ? `${parts[end].trim()} (port)` : `${route} (port)`;
  };
  for (const [name, lat1, lon1, lat2, lon2, km] of ferries) {
    const a = stationFor(portName(name, 0), lat1, lon1, "ferries");
    const b = stationFor(portName(name, 1), lat2, lon2, "ferries");
    if (a === b) continue;
    const minutes = Math.round(30 + (km / 30) * 60);
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const key = `${from}>${to}>ferry`;
      const prev = edgeAgg.get(key);
      if (!prev || minutes < prev.minutes) edgeAgg.set(key, { from, to, minutes, tripsPerWeek: 7, mode: "ferry" });
    }
    ferryEdges++;
  }
  console.log(`ferries: ${ferryEdges} crossings`);
} catch {
  console.log("no public/data/ferries.json yet (pnpm ingest:ferries); skipping ferries");
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

// Towns (scripts/ingest/geonames.ts): the biggest town within 10 km names the station's place
// and gives it a population, so "București Nord" is Bucharest and halts stay halts.
try {
  const towns = JSON.parse(await readFile("public/data/towns.json", "utf8")) as [string, number, number, string, number][];
  const TC = 0.2;
  const tcells = new Map<string, typeof towns>();
  for (const t of towns) {
    const k = `${Math.floor(t[1] / TC)},${Math.floor(t[2] / TC)}`;
    const list = tcells.get(k);
    if (list) list.push(t);
    else tcells.set(k, [t]);
  }
  let named = 0;
  for (const s of stations.values()) {
    const cl = Math.floor(s.lat / TC);
    const co = Math.floor(s.lon / TC);
    let best: (typeof towns)[number] | null = null;
    for (let dl = -1; dl <= 1; dl++) {
      for (let dn = -1; dn <= 1; dn++) {
        for (const t of tcells.get(`${cl + dl},${co + dn}`) ?? []) {
          if ((!best || t[4] > best[4]) && haversineKm(s.lat, s.lon, t[1], t[2]) <= 10) best = t;
        }
      }
    }
    if (best) {
      s.town = best[0];
      s.pop = best[4];
      named++;
    }
  }
  console.log(`towns: ${named} of ${stations.size} stations within 10 km of a town over 15,000 people`);
} catch {
  console.log("no public/data/towns.json yet (pnpm ingest:geonames); stations keep their own names");
}

// Compact arrays keep the file small: edges are [from, to, minutes, tripsPerWeek, modeIndex].
const MODES = ["rail", "coach", "ferry", "other", "walk"];
const graph = {
  generatedAt: new Date().toISOString(),
  feeds: feeds
    .filter((f) => !failed.includes(f.id))
    .map((f) => ({ id: f.id, name: f.name, licence: f.licence, attribution: f.attribution })),
  modes: MODES,
  // [name, lat, lon, neighbouring stations, departures per day, population, town (when it differs)]
  stations: [...stations.values()].map(
    (s) => [s.name, s.lat, s.lon, s.nbrs.size, Math.round(s.dep / 7), s.pop ?? 0, s.town && s.town !== s.name ? s.town : ""] as const,
  ),
  edges: [...edgeAgg.values()].map((e) => [e.from, e.to, e.minutes, e.tripsPerWeek, MODES.indexOf(e.mode)] as const),
};

// Merge with a previous run when only some feeds were refreshed? Not yet: a partial run rewrites
// the whole graph, so run all feeds for a release build.
await mkdir("public/data", { recursive: true });
await writeFile(OUT, JSON.stringify(graph) + "\n");
const size = (await readFile(OUT)).length;
console.log(`ground graph: ${graph.stations.length} stations, ${graph.edges.length} edges, ${(size / 1e6).toFixed(1)} MB → ${OUT}`);

// Only now that the graph is on disk does the manifest describe it. The run rewrites the whole
// graph, so gtfs: rows for feeds not in it (a one-feed run, a dropped feed) go too.
if (!TEST_RUN) {
  const manifest = await readManifest();
  for (const key of Object.keys(manifest)) if (key.startsWith("gtfs:")) delete manifest[key];
  for (const [key, entry] of manifestRows) {
    manifest[key] = entry;
    console.log(`${key}: ${entry.rows} rows, fetched ${entry.fetchedAt.slice(0, 10)}`);
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
}
if (failed.length) {
  console.log(`failed and left out of the graph: ${failed.join(", ")}`);
  process.exit(1);
}
