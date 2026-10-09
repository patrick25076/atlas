// Source 10: public holidays for the next 400 days, every country Nager.Date knows (open
// source, no rate limits). Used two ways: "it's a holiday there" on the place card, and your
// own long weekends as suggested trip dates. Run after countries.ts (needs the ISO list).
import { readFile, writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";
import type { CountryInfo, Holiday } from "../../lib/types";

const BASE = process.env.NAGER_BASE ?? "https://nagerholidays.com/api/v4";
const OUT = "public/data/holidays.json";
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";

type Raw = { date: string; name: string; localName?: string; nationalHoliday?: boolean; global?: boolean };

const get = async (url: string): Promise<Raw[] | null> => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404 || res.status === 204 || res.status === 400) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as Raw[];
};

const countries = Object.keys(JSON.parse(await readFile("public/data/countries.json", "utf8")) as Record<string, CountryInfo>);
const today = new Date();
const from = today.toISOString().slice(0, 10);
const to = new Date(today.getTime() + 400 * 86_400_000).toISOString().slice(0, 10);
const years = [today.getUTCFullYear(), today.getUTCFullYear() + 1];

const out: Record<string, Holiday[]> = {};
let rows = 0;
const queue = [...countries];
async function worker() {
  for (let code = queue.shift(); code; code = queue.shift()) {
    const list: Holiday[] = [];
    for (const y of years) {
      const hs = await get(`${BASE}/Holidays/${code}/${y}`);
      if (!hs) break;
      for (const h of hs) {
        if (h.date >= from && h.date <= to) {
          list.push({ date: h.date, name: h.name, localName: h.localName ?? h.name, national: h.nationalHoliday ?? h.global ?? true });
        }
      }
    }
    if (list.length) {
      out[code] = list.sort((a, b) => a.date.localeCompare(b.date));
      rows += list.length;
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);

await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("holidays", {
  source: "Nager.Date public holidays",
  url: BASE,
  licence: "Open source (Nager.Date), free API",
  note: `Holidays from ${from} to ${to}, ${Object.keys(out).length} countries.`,
  fetchedAt: new Date().toISOString(),
  rows,
  file: OUT,
});
console.log(`holidays: ${rows} in ${Object.keys(out).length} countries`);
