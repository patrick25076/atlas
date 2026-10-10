// Source 23: how famous a city is, and how much there is to see, for the hidden-gem score.
// Fame = English Wikipedia page views over the last 12 months (Wikimedia REST, CC0 metrics).
// Substance = Wikivoyage listings in the See and Do sections (CC BY-SA, counts only).
// Output: public/data/fame.json → { code: [views, see, do] }; absent when the article is
// missing or ambiguous (never a zero that would pass as obscurity).
import { readFile, writeFile } from "node:fs/promises";
import type { City } from "../../lib/types";
import { recordManifest } from "./manifest";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/fame.json";
// Two at a time: Wikivoyage answers 429 to anything hungrier, and the run is monthly anyway.
const CONCURRENCY = 2;

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const airports = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const size = new Map(airports.map((a) => [a.iata, a.size]));
const targets = Object.entries(cities).filter(([, c]) => ["large", "medium"].includes(size.get(c.airports[0]) ?? ""));

const end = new Date();
end.setUTCDate(1);
end.setUTCDate(0); // last day of the previous month
const start = new Date(end);
start.setUTCMonth(start.getUTCMonth() - 11);
start.setUTCDate(1);
const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}00`;

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return (await r.json()) as T;
  }
  return null;
}

/** Canonical English Wikipedia title for a city, following redirects; null when missing or ambiguous. */
async function canonical(name: string, country: string): Promise<string | null> {
  for (const q of [name, `${name}, ${country}`]) {
    const j = await getJson<{ query?: { pages?: Record<string, { title: string; missing?: boolean; pageprops?: Record<string, string> }> } }>(
      `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(q)}&redirects=1&prop=pageprops&ppprop=disambiguation&format=json`,
    );
    const page = Object.values(j?.query?.pages ?? {})[0];
    if (!page || page.missing) continue;
    if (page.pageprops && "disambiguation" in page.pageprops) continue;
    return page.title;
  }
  return null;
}

async function views(title: string): Promise<number | null> {
  const j = await getJson<{ items?: { views: number }[] }>(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/${ym(start)}/${ym(end)}`,
  );
  if (!j?.items?.length) return null;
  return j.items.reduce((s, i) => s + i.views, 0);
}

async function listings(name: string): Promise<[number, number] | null> {
  const j = await getJson<{ parse?: { wikitext: { "*": string } } }>(
    `https://en.wikivoyage.org/w/api.php?action=parse&page=${encodeURIComponent(name)}&prop=wikitext&format=json&redirects=1`,
  );
  const wt = j?.parse?.wikitext["*"];
  if (!wt) return null;
  const see = (wt.match(/\{\{see\s*\|/gi) ?? []).length;
  const doo = (wt.match(/\{\{do\s*\|/gi) ?? []).length;
  return [see, doo];
}

const out: Record<string, [number, number, number]> = {};
let done = 0;
let missing = 0;
const queue = [...targets];
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [code, c] = next;
    const countryName = new Intl.DisplayNames(["en"], { type: "region" }).of(c.country) ?? c.country;
    const title = await canonical(c.name, countryName);
    const v = title ? await views(title) : null;
    const l = await listings(c.name);
    if (v == null && !l) missing++;
    else out[code] = [v ?? -1, l?.[0] ?? -1, l?.[1] ?? -1];
    if (++done % 200 === 0) console.log(`  ${done}/${targets.length} (${missing} without an article)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("fame", {
  source: "Wikimedia pageviews (English Wikipedia, 12 months) + Wikivoyage listing counts",
  url: "https://wikimedia.org/api/rest_v1/",
  licence: "Wikimedia metrics CC0; Wikivoyage CC BY-SA 4.0 (counts only)",
  note: `${ym(start).slice(0, 6)} to ${ym(end).slice(0, 6)}; -1 where a value is unknown.`,
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`fame: ${Object.keys(out).length} of ${targets.length} cities (${missing} without an article) → ${OUT}`);
