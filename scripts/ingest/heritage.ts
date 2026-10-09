// Source 14: UNESCO World Heritage Sites, via Wikidata (CC0): every item designated a World
// Heritage Site (P1435 = Q9259) with coordinates and country. The card lists the sites within
// 60 km of a place. Output: public/data/heritage.json, compact rows [name, lat, lon, country].
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/heritage.json";
const QUERY = `
SELECT ?site ?label (SAMPLE(?coord) AS ?c) (SAMPLE(?cc) AS ?country) WHERE {
  ?site wdt:P1435 wd:Q9259; wdt:P625 ?coord; rdfs:label ?label FILTER(LANG(?label) = "en").
  OPTIONAL { ?site wdt:P17 ?ctry. ?ctry wdt:P297 ?cc }
} GROUP BY ?site ?label`;

const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(QUERY)}`, {
  headers: { "User-Agent": UA, Accept: "application/sparql-results+json" },
});
if (!res.ok) throw new Error(`Wikidata ${res.status}`);
const body = (await res.json()) as {
  results: { bindings: { label: { value: string }; c: { value: string }; country?: { value: string } }[] };
};

const rows: [string, number, number, string][] = [];
for (const b of body.results.bindings) {
  const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.c.value);
  if (!m) continue;
  rows.push([b.label.value, +Number(m[2]).toFixed(4), +Number(m[1]).toFixed(4), b.country?.value ?? ""]);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
await writeFile(OUT, JSON.stringify(rows) + "\n");
await recordManifest("heritage", {
  source: "UNESCO World Heritage Sites via Wikidata (P1435 = Q9259)",
  url: "https://query.wikidata.org/",
  licence: "CC0",
  note: "Site names and coordinates; the card lists sites within 60 km.",
  fetchedAt: new Date().toISOString(),
  rows: rows.length,
  file: OUT,
});
console.log(`heritage: ${rows.length} sites`);
