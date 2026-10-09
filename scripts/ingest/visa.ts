// Source 16: visa requirements by passport and destination, from the open Passport Index
// dataset (MIT, 199 × 199 pairs). Indicative only: rules change, and the card says so with
// the dataset date. Output: public/data/visa.json, one character per destination per passport:
//   F visa-free (90 days or unspecified)  S visa-free, shorter  L visa-free, longer
//   A visa on arrival  T electronic travel authorisation  E e-visa  V visa required
//   N no admission  H home country  ? unknown
// plus `days` for the visa-free entries whose allowance is not 90.
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

// imorte/passport-index-data continues ilyankou's archived dataset (same format, MIT).
const SRC = process.env.VISA_CSV ?? "https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index-tidy-iso2.csv";
const UPDATED = process.env.VISA_DATE ?? "2026-02-17";
const OUT = "public/data/visa.json";

const res = await fetch(SRC, { headers: { "User-Agent": "atlas travel globe (https://github.com/patrick25076/atlas)" } });
if (!res.ok) throw new Error(`visa csv ${res.status}`);
const text = await res.text();
const lines = text.trim().split(/\r?\n/);
const header = lines.shift()!.split(",").map((s) => s.trim().toLowerCase());
const iP = header.indexOf("passport");
const iD = header.indexOf("destination");
const iR = header.indexOf("requirement");
if (iP < 0 || iD < 0 || iR < 0) throw new Error(`unexpected header: ${header.join(",")}`);

type Cell = { code: string; days?: number };
const pairs = new Map<string, Map<string, Cell>>();
const countries = new Set<string>();
for (const line of lines) {
  const cols = line.split(",");
  const p = cols[iP]?.trim();
  const d = cols[iD]?.trim();
  const r = cols.slice(iR).join(",").trim().toLowerCase();
  if (!/^[A-Z]{2}$/.test(p) || !/^[A-Z]{2}$/.test(d)) continue;
  countries.add(p);
  countries.add(d);
  let cell: Cell;
  if (r === "-1") cell = { code: "H" };
  else if (/^\d+$/.test(r)) {
    const days = Number(r);
    cell = { code: days === 90 ? "F" : days < 90 ? "S" : "L", days: days === 90 ? undefined : days };
  } else if (r === "visa free") cell = { code: "F" };
  else if (r === "visa on arrival") cell = { code: "A" };
  else if (r === "eta") cell = { code: "T" };
  else if (r === "e-visa") cell = { code: "E" };
  else if (r === "visa required") cell = { code: "V" };
  else if (r === "no admission") cell = { code: "N" };
  else cell = { code: "?" };
  let row = pairs.get(p);
  if (!row) pairs.set(p, (row = new Map()));
  row.set(d, cell);
}

const order = [...countries].sort();
const passports: Record<string, string> = {};
const days: Record<string, Record<string, number>> = {};
for (const [p, row] of pairs) {
  passports[p] = order.map((d) => (d === p ? "H" : (row.get(d)?.code ?? "?"))).join("");
  for (const [d, cell] of row) if (cell.days) (days[p] ??= {})[d] = cell.days;
}

await writeFile(OUT, JSON.stringify({ updated: UPDATED, source: SRC, countries: order, passports, days }) + "\n");
await recordManifest("visa", {
  source: "Passport Index dataset (imorte, continuing ilyankou)",
  url: SRC,
  licence: "MIT",
  note: `Visa requirements by passport and destination, indicative, as of ${UPDATED}.`,
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(passports).length * order.length,
  file: OUT,
});
console.log(`visa: ${Object.keys(passports).length} passports × ${order.length} destinations`);
