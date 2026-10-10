// Source: NASA POWER climatology (public domain, no key) for every city with a large or medium
// airport, the same set as weather.ts. Twelve monthly values each: a typical daily high and
// the rain per day, averaged over 2001 to 2025, so the engine can say "February is the month
// for Bangkok" without a forecast. Terms: free for any use, cite NASA POWER; stay polite on
// request rate (the API answers 429 when pushed; we back off and slow down).
//
// T2M_MAX in a climatology is the hottest hour of the whole month (42 C for Bucharest in July),
// not the number a traveller means by "the high". The daily high is the mean temperature plus
// half the daily range: T2M + T2M_RANGE / 2, which gives 31 C for Bucharest in July.
//
// Usage: pnpm ingest:climate            (keeps cities already in the file, fetches the rest)
//        pnpm ingest:climate --fresh    (refetches everything)
import { readFile, writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";
import type { City } from "../../lib/types";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/climate.json";
const API = "https://power.larc.nasa.gov/api/temporal/climatology/point";
const CONCURRENCY = 4;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const FILL = -999;

type Entry = { t: number[]; r: number[] };
type Answer = { properties?: { parameter?: Record<string, Record<string, number>> } };

// One shared pause, grown on 429 or 5xx and shrunk slowly on success, so four workers slow
// down together instead of each hammering the API after a limit.
let pause = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function climatology(lat: number, lon: number): Promise<Entry | null> {
  const url = `${API}?parameters=T2M,T2M_RANGE,PRECTOTCORR&community=RE&longitude=${lon.toFixed(3)}&latitude=${lat.toFixed(3)}&format=JSON`;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (pause) await sleep(pause);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    } catch {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      pause = Math.min(15_000, Math.max(1000, pause * 2));
      await sleep(2000 * (attempt + 1) + pause);
      continue;
    }
    if (!res.ok) return null;
    pause = Math.max(0, Math.floor(pause * 0.8) - 50);
    const body = (await res.json()) as Answer;
    const p = body.properties?.parameter;
    const t2m = p?.T2M;
    const range = p?.T2M_RANGE;
    const rain = p?.PRECTOTCORR;
    if (!t2m || !range || !rain) return null;
    const t: number[] = [];
    const r: number[] = [];
    for (const m of MONTHS) {
      const mean = t2m[m];
      const rng = range[m];
      const mm = rain[m];
      if ([mean, rng, mm].some((v) => typeof v !== "number" || v === FILL)) return null;
      t.push(Math.round(mean + rng / 2));
      r.push(Math.round(Math.max(0, mm) * 10) / 10);
    }
    return { t, r };
  }
  return null;
}

const fresh = process.argv.includes("--fresh");
const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const airports = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const size = new Map(airports.map((a) => [a.iata, a.size]));
const targets = Object.entries(cities).filter(([, c]) => ["large", "medium"].includes(size.get(c.airports[0]) ?? ""));

let out: Record<string, Entry> = {};
if (!fresh) {
  try {
    out = JSON.parse(await readFile(OUT, "utf8")) as Record<string, Entry>;
  } catch {
    // first run
  }
}
const todo = targets.filter(([code]) => !out[code]?.t?.length);
console.log(`climate: ${targets.length} cities, ${Object.keys(out).length} already done, ${todo.length} to fetch`);

const save = async () => writeFile(OUT, JSON.stringify(out) + "\n");
let done = 0;
let failed = 0;
const queue = [...todo];
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [code, c] = next;
    const e = await climatology(c.lat, c.lon);
    if (e) out[code] = e;
    else failed++;
    done++;
    if (done % 100 === 0) {
      console.log(`  ${done}/${todo.length} (${failed} failed, pause ${pause} ms)`);
      // Partial progress is kept, so an interrupted run resumes where it stopped.
      await save();
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await save();
await recordManifest("climate", {
  source: "NASA POWER climatology (MERRA-2), 2001 to 2025",
  url: "https://power.larc.nasa.gov/docs/services/api/temporal/climatology/",
  licence: "Public domain (NASA); cite NASA POWER",
  note: "Per city with a large or medium airport: 12 monthly typical daily highs (T2M + T2M_RANGE/2, C) and rain (PRECTOTCORR, mm/day).",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`climate: ${Object.keys(out).length} of ${targets.length} cities (${failed} failed this run)`);
