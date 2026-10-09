// Sources 6-9: one record per country for the place card.
//  - Travelpayouts countries.json: name and currency (free static data)
//  - Frankfurter: today's rate per euro for 32 currencies (free, commercial OK)
//  - Wikidata: plug types and mains voltage (CC0)
//  - German Federal Foreign Office: travel warnings, full and partial (open data)
import { writeFile } from "node:fs/promises";
import { recordManifest } from "./manifest";
import type { CountryInfo } from "../../lib/types";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/countries.json";

const get = async (url: string, accept = "application/json") => {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
};

const out: Record<string, CountryInfo> = {};
const now = new Date().toISOString();

// Names and currencies.
const TP = "https://api.travelpayouts.com/data/en/countries.json";
const tp = (await get(TP)) as { code: string; name: string; currency?: string }[];
for (const c of tp) if (/^[A-Z]{2}$/.test(c.code)) out[c.code] = { name: c.name, currency: c.currency || undefined };
await recordManifest("countries", {
  source: "Travelpayouts countries.json",
  url: TP,
  licence: "Travelpayouts static data (free for partner use)",
  note: "Country name and currency code.",
  fetchedAt: now,
  rows: tp.length,
  file: OUT,
});

// Exchange rates.
const FX = "https://api.frankfurter.dev/v1/latest?base=EUR";
const fx = (await get(FX)) as { date: string; rates: Record<string, number> };
let rated = 0;
for (const c of Object.values(out)) {
  if (c.currency === "EUR") {
    c.rate = 1;
    rated++;
  } else if (c.currency && fx.rates[c.currency]) {
    c.rate = fx.rates[c.currency];
    rated++;
  }
}
await recordManifest("fx", {
  source: "Frankfurter (ECB reference rates)",
  url: FX,
  licence: "Free, commercial use allowed",
  note: `Rates per EUR as of ${fx.date}.`,
  fetchedAt: now,
  rows: rated,
  file: OUT,
});

// Plugs and voltage.
const SPARQL =
  "https://query.wikidata.org/sparql?format=json&query=" +
  encodeURIComponent(
    `SELECT ?iso2 (GROUP_CONCAT(DISTINCT ?plugLabel;separator="|") AS ?plugs) (SAMPLE(?voltage) AS ?v) WHERE {
      ?c wdt:P297 ?iso2.
      OPTIONAL { ?c wdt:P2853 ?plug. ?plug rdfs:label ?plugLabel FILTER(LANG(?plugLabel)="en") }
      OPTIONAL { ?c wdt:P2884 ?voltage }
    } GROUP BY ?iso2`,
  );
const wd = (await get(SPARQL, "application/sparql-results+json")) as {
  results: { bindings: { iso2: { value: string }; plugs?: { value: string }; v?: { value: string } }[] };
};
let plugged = 0;
for (const b of wd.results.bindings) {
  const c = out[b.iso2.value];
  if (!c) continue;
  const plugs = (b.plugs?.value ?? "").split("|").filter(Boolean);
  if (plugs.length) c.plugs = plugs;
  const v = Number(b.v?.value);
  if (Number.isFinite(v) && v > 0) c.voltage = v;
  if (plugs.length || c.voltage) plugged++;
}
await recordManifest("plugs", {
  source: "Wikidata (P2853 plug type, P2884 mains voltage)",
  url: "https://query.wikidata.org/",
  licence: "CC0",
  note: "Plug types and voltage per country.",
  fetchedAt: now,
  rows: plugged,
  file: OUT,
});

// Travel warnings.
const AA = "https://www.auswaertiges-amt.de/opendata/travelwarning";
const aa = (await get(AA)) as {
  response: Record<string, { countryCode?: string; warning?: boolean; partialWarning?: boolean; situationWarning?: boolean; situationPartWarning?: boolean; lastModified?: number } | unknown>;
};
let advised = 0;
for (const entry of Object.values(aa.response)) {
  if (!entry || typeof entry !== "object" || !("countryCode" in entry)) continue;
  const e = entry as { countryCode: string; warning?: boolean; partialWarning?: boolean; situationWarning?: boolean; situationPartWarning?: boolean; lastModified?: number };
  const c = out[e.countryCode];
  if (!c) continue;
  c.advisory = {
    warning: !!e.warning,
    partial: !!e.partialWarning,
    situation: !!e.situationWarning,
    situationPart: !!e.situationPartWarning,
    updated: e.lastModified ? new Date(e.lastModified * 1000).toISOString().slice(0, 10) : "",
  };
  advised++;
}
await recordManifest("advisories", {
  source: "German Federal Foreign Office travel warnings",
  url: AA,
  licence: "Open data of the Auswärtiges Amt",
  note: "Full and partial travel warnings per country.",
  fetchedAt: now,
  rows: advised,
  file: OUT,
});

await writeFile(OUT, JSON.stringify(out) + "\n");
console.log(`countries: ${Object.keys(out).length} · rated ${rated} · plugs ${plugged} · advisories ${advised}`);
