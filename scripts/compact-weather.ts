// One-off: convert an expanded weather.json (first ingest run) into the compact on-disk format.
// Safe to run on an already compact file (it is left alone).
import { readFile, writeFile } from "node:fs/promises";
import { compactWeather, type WeatherDay } from "../lib/types";

const FILE = "public/data/weather.json";
const raw = JSON.parse(await readFile(FILE, "utf8")) as { updated: string; syms?: string[]; cities: Record<string, WeatherDay[]> };
if (raw.syms) {
  console.log("already compact");
} else {
  const before = (await readFile(FILE)).length;
  await writeFile(FILE, JSON.stringify(compactWeather(raw.updated, raw.cities)) + "\n");
  const after = (await readFile(FILE)).length;
  console.log(`compacted ${(before / 1e6).toFixed(2)} MB → ${(after / 1e6).toFixed(2)} MB`);
}
