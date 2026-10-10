// Source 23: how famous a city is, and how much there is to see, for the hidden-gem score.
// Fame = English Wikipedia page views over the last 12 months (Wikimedia REST, CC0 metrics).
// Substance = Wikivoyage listings in the See and Do sections (CC BY-SA, counts only).
// Output: public/data/fame.json → { code: [views, see, do] }; absent when the article is
// missing or ambiguous (never a zero that would pass as obscurity).
//
// Namesakes: a bare name like "Glasgow" lands on the Scottish city for Glasgow, Montana, which
// handed small American towns a million views and a full Wikivoyage guide. Every article is now
// checked against the city's coordinates (Wikipedia's coordinates, Wikivoyage's {{geo}} line)
// and a page more than 120 km away is refused; the fallbacks are "Name, Country" and a
// geosearch around the city for a title that starts with the name.
import { readFile, writeFile } from "node:fs/promises";
import type { City } from "../../lib/types";
import { recordManifest } from "./manifest";

const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const OUT = "public/data/fame.json";
// Two at a time: Wikivoyage answers 429 to anything hungrier, and the run is monthly anyway.
const CONCURRENCY = 2;
/** An article further than this from the city is a namesake, not the city. */
const MAX_KM = 120;

const cities = JSON.parse(await readFile("public/data/cities.json", "utf8")) as Record<string, City>;
const airports = JSON.parse(await readFile("public/data/airports.json", "utf8")) as { iata: string; size: string }[];
const size = new Map(airports.map((a) => [a.iata, a.size]));
// FAME_ONLY=GGW,GLA runs a few cities, prints what they resolve to and writes nothing (a probe).
const only = process.env.FAME_ONLY?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const targets = Object.entries(cities).filter(([code, c]) => (only ? only.includes(code) : ["large", "medium"].includes(size.get(c.airports[0]) ?? "")));

const end = new Date();
end.setUTCDate(1);
end.setUTCDate(0); // last day of the previous month
const start = new Date(end);
start.setUTCMonth(start.getUTCMonth() - 11);
start.setUTCDate(1);
const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}00`;

function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (!r.ok) return null; // 404 and the like: no article
      return (await r.json()) as T;
    } catch {
      // A dropped connection or a timeout: wait and try again, never crash a 40-minute run.
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  return null;
}

type WikiPage = { title: string; missing?: boolean; pageprops?: Record<string, string>; coordinates?: { lat: number; lon: number }[] };
type GeoHit = { title: string; lat: number; lon: number; dist: number };

/** The first page of a query result, or null when the title is missing or a disambiguation. */
function usable(j: { query?: { pages?: Record<string, WikiPage> } } | null): WikiPage | null {
  const page = Object.values(j?.query?.pages ?? {})[0];
  if (!page || page.missing) return null;
  if (page.pageprops && "disambiguation" in page.pageprops) return null;
  return page;
}

/** "St. Augustine, Florida" and "st augustine" compare equal: no punctuation, no accents, lower case. */
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'’\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** Among the titles starting with a prefix ("Portland, " or "Portland ("), the one with coordinates closest to the city. */
async function closestTitled(host: string, prefix: string, lat: number, lon: number): Promise<string | null> {
  const s = await getJson<{ query?: { prefixsearch?: { title: string }[] } }>(
    `https://${host}/w/api.php?action=query&list=prefixsearch&pssearch=${encodeURIComponent(prefix)}&pslimit=10&psnamespace=0&format=json`,
  );
  const titles = (s?.query?.prefixsearch ?? []).map((t) => t.title);
  if (!titles.length) return null;
  const j = await getJson<{ query?: { pages?: Record<string, WikiPage> } }>(
    `https://${host}/w/api.php?action=query&titles=${encodeURIComponent(titles.join("|"))}&redirects=1&prop=coordinates%7Cpageprops&ppprop=disambiguation&format=json`,
  );
  let best: { title: string; d: number } | null = null;
  for (const p of Object.values(j?.query?.pages ?? {})) {
    if (p.missing || (p.pageprops && "disambiguation" in p.pageprops)) continue;
    const c = p.coordinates?.[0];
    if (!c) continue;
    const d = km(lat, lon, c.lat, c.lon);
    if (d <= MAX_KM && (!best || d < best.d)) best = { title: p.title, d };
  }
  return best?.title ?? null;
}

/** A title within 10 km of the city whose name starts with the city's name (the API's radius limit). */
async function nearby(host: string, name: string, lat: number, lon: number): Promise<string | null> {
  const j = await getJson<{ query?: { geosearch?: GeoHit[] } }>(
    `https://${host}/w/api.php?action=query&list=geosearch&gscoord=${lat}%7C${lon}&gsradius=10000&gslimit=20&gsnamespace=0&format=json`,
  );
  const want = plain(name);
  const hit = (j?.query?.geosearch ?? []).find((h) => plain(h.title).startsWith(want));
  return hit?.title ?? null;
}

/** Canonical English Wikipedia title for a city, following redirects; null when missing, ambiguous or a namesake. */
async function canonical(name: string, country: string, lat: number, lon: number): Promise<string | null> {
  const bare = usable(
    await getJson(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(name)}&redirects=1&prop=pageprops%7Ccoordinates&ppprop=disambiguation&format=json`),
  );
  const c = bare?.coordinates?.[0];
  if (bare && c && km(lat, lon, c.lat, c.lon) <= MAX_KM) return bare.title;
  // The bare name is missing, ambiguous or a namesake elsewhere: look for "Name, Somewhere" near the city.
  const titled = (await closestTitled("en.wikipedia.org", `${name}, `, lat, lon)) ?? (await nearby("en.wikipedia.org", name, lat, lon));
  if (titled) return titled;
  const qualified = usable(
    await getJson(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(`${name}, ${country}`)}&redirects=1&prop=pageprops%7Ccoordinates&ppprop=disambiguation&format=json`),
  );
  const qc = qualified?.coordinates?.[0];
  if (qualified && (!qc || km(lat, lon, qc.lat, qc.lon) <= MAX_KM)) return qualified.title;
  // An article without coordinates under the bare name is accepted last: rare, and the old behaviour.
  return bare && !c ? bare.title : null;
}

async function views(title: string): Promise<number | null> {
  const j = await getJson<{ items?: { views: number }[] }>(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/${ym(start)}/${ym(end)}`,
  );
  if (!j?.items?.length) return null;
  return j.items.reduce((s, i) => s + i.views, 0);
}

async function wikitext(title: string): Promise<string | null> {
  const j = await getJson<{ parse?: { wikitext: { "*": string } } }>(
    `https://en.wikivoyage.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&redirects=1`,
  );
  return j?.parse?.wikitext["*"] ?? null;
}

/** See and Do listing counts from the Wikivoyage guide, refused when the guide's {{geo}} line is far from the city. */
async function listings(name: string, lat: number, lon: number): Promise<[number, number] | null> {
  let wt = await wikitext(name);
  const geo = wt?.match(/\{\{\s*geo\s*\|\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)/i);
  const disambiguation = !!wt && /\{\{\s*disamb/i.test(wt);
  if (wt && (disambiguation || (geo && km(lat, lon, Number(geo[1]), Number(geo[2])) > MAX_KM))) {
    // Wikivoyage disambiguates as "Glasgow (Montana)"; the guide's {{geo}} line is its coordinate.
    const title = (await closestTitled("en.wikivoyage.org", `${name} (`, lat, lon)) ?? (await nearby("en.wikivoyage.org", name, lat, lon));
    wt = title ? await wikitext(title) : null;
  }
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
    const title = await canonical(c.name, countryName, c.lat, c.lon);
    const v = title ? await views(title) : null;
    const l = await listings(c.name, c.lat, c.lon);
    if (v == null && !l) missing++;
    else out[code] = [v ?? -1, l?.[0] ?? -1, l?.[1] ?? -1];
    if (only) console.log(`  ${code} ${c.name} (${c.country}): article ${title ?? "none"}, views ${v ?? "none"}, listings ${l ? `${l[0]} see / ${l[1]} do` : "none"}`);
    if (++done % 200 === 0) console.log(`  ${done}/${targets.length} (${missing} without an article)`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (only) {
  console.log(`fame probe: ${Object.keys(out).length} of ${targets.length} cities resolved; nothing written`);
  process.exit(0);
}
await writeFile(OUT, JSON.stringify(out) + "\n");
await recordManifest("fame", {
  source: "Wikimedia pageviews (English Wikipedia, 12 months) + Wikivoyage listing counts",
  url: "https://wikimedia.org/api/rest_v1/",
  licence: "Wikimedia metrics CC0; Wikivoyage CC BY-SA 4.0 (counts only)",
  note: `${ym(start).slice(0, 6)} to ${ym(end).slice(0, 6)}; -1 where a value is unknown; articles checked against the city's coordinates (namesakes refused).`,
  fetchedAt: new Date().toISOString(),
  rows: Object.keys(out).length,
  file: OUT,
});
console.log(`fame: ${Object.keys(out).length} of ${targets.length} cities (${missing} without an article) → ${OUT}`);
