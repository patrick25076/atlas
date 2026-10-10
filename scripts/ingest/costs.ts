// Source 24: how expensive a country is for a visitor, as a ratio to the US price level:
// World Bank PPP conversion factor divided by the official exchange rate (both CC BY 4.0).
// Thailand lands near 0.4, China 0.55, Switzerland 1.3. Output: public/data/costs.json
// { ISO2: ratio }, used for the daily budget of a trip stop.
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const OUT = "public/data/costs.json";
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
type Row = { countryiso3code: string; date: string; value: number | null };

async function indicator(code: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const year of [2024, 2023, 2022]) {
    const r = await fetch(`https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&date=${year}&per_page=400`, { headers: { "User-Agent": UA } });
    if (!r.ok) continue;
    const j = (await r.json()) as [unknown, Row[] | undefined];
    for (const row of j[1] ?? []) if (row.value != null && !out.has(row.countryiso3code)) out.set(row.countryiso3code, row.value);
  }
  return out;
}

const countries = (await (await fetch("https://api.worldbank.org/v2/country?format=json&per_page=400", { headers: { "User-Agent": UA } })).json()) as [unknown, { id: string; iso2Code: string; region: { value: string } }[]];
const iso2 = new Map(countries[1].filter((c) => c.region.value !== "Aggregates").map((c) => [c.id, c.iso2Code]));
const [ppp, fx] = await Promise.all([indicator("PA.NUS.PPP"), indicator("PA.NUS.FCRF")]);

const out: Record<string, number> = {};
for (const [iso3, p] of ppp) {
  const f = fx.get(iso3);
  const cc = iso2.get(iso3);
  if (!cc || !f || f <= 0) continue;
  out[cc] = Math.round((p / f) * 100) / 100;
}
// Euro-area members report no exchange rate of their own; the euro's rate is the US dollar line.
const eurArea = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];
const usdPerEur = (await (await fetch("https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD")).json()) as { rates: { USD: number } };
for (const cc of eurArea) {
  const iso3 = [...iso2.entries()].find(([, v]) => v === cc)?.[0];
  const p = iso3 ? ppp.get(iso3) : undefined;
  if (p && !out[cc]) out[cc] = Math.round(p * usdPerEur.rates.USD * 100) / 100;
}
await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("costs", {
  source: "World Bank PPP conversion factor / official exchange rate",
  url: "https://data.worldbank.org/indicator/PA.NUS.PPP",
  licence: "CC BY 4.0",
  note: "Price level relative to the United States (1.0); latest of 2022-2024.",
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`costs: ${Object.keys(out).length} countries → ${OUT}; TH ${out.TH} CN ${out.CN} SG ${out.SG} RO ${out.RO} CH ${out.CH} DE ${out.DE} US ${out.US}`);
