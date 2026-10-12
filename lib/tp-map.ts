// Server-only. Travelpayouts' cache of recent Aviasales fares as edges of the price map: the nightly import
// (scripts/ingest/tp-edges.ts) and the search's home fares (homeFares below) read it the same way. Each fare is a one-way
// seen by some traveller in the last days, not a live quote; the map marks it, and Search confirms the best trips live.
import citiesJson from "@/public/data/cities.json";
import type { RawEdge } from "./flight-graph";
import { getAnswer, putAnswer } from "./db";
import { bookingUrl } from "./travelpayouts";
import type { City } from "./types";

const API = "https://api.travelpayouts.com/aviasales/v3/get_latest_prices";
const CITIES = citiesJson as unknown as Record<string, City>;
/** Airport code to its city, built once (a fare names an airport or a city). */
const CITY_OF = new Map<string, City>();
for (const c of Object.values(CITIES)) for (const a of c.airports ?? []) if (!CITY_OF.has(a)) CITY_OF.set(a, c);

type Raw = Record<string, unknown>;
const str = (x: unknown) => (typeof x === "string" ? x : "");
const num = (x: unknown) => (typeof x === "number" ? x : Number(x));

/** One question to the cache: a month of one-way fares out of (origin) or into (destination) a city, grouped to one fare a place or one a day. */
export async function askTp(q: { origin?: string; destination?: string; month: string; grouped: boolean }, attempts = 3): Promise<Raw[]> {
  const token = process.env.TRAVELPAYOUTS_TOKEN?.trim();
  if (!token) return [];
  const p = new URLSearchParams({ period_type: "month", beginning_of_period: q.month, one_way: "true", currency: "eur", sorting: "price", limit: "1000", show_to_affiliates: "true" });
  if (q.origin) p.set("origin", q.origin);
  if (q.destination) p.set("destination", q.destination);
  if (q.grouped) p.set("group_by", "directions");
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${API}?${p}`, { headers: { "X-Access-Token": token, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Raw[] };
      return Array.isArray(body.data) ? body.data : [];
    } catch {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return [];
}

/** A Travelpayouts row as an edge: the local departure day and time, the landing day (the clock shifted by the longitude), the seen time; no stored link (the map builds it). */
export function tpEdge(r: Raw, fallbackOrigin: string, today: string, fallbackDestination?: string): RawEdge | null {
  const at = str(r.depart_date) || str(r.departure_at);
  const to = str(r.destination_airport) || str(r.destination) || fallbackDestination || "";
  const from = str(r.origin_airport) || str(r.origin) || fallbackOrigin;
  const price = num(r.value ?? r.price);
  if (!/^\d{4}-\d{2}-\d{2}/.test(at) || !/^[A-Z]{3}$/.test(to) || !/^[A-Z]{3}$/.test(from) || from === to || !(price > 0)) return null;
  const d = at.slice(0, 10);
  if (d < today) return null;
  const h = /T(\d{2}:\d{2})/.exec(at)?.[1] ?? "";
  const minutes = Math.max(0, Math.round(num(r.duration ?? r.duration_to) || 0));
  const a1 = CITIES[from] ?? CITY_OF.get(from);
  const a2 = CITIES[to] ?? CITY_OF.get(to);
  const shiftH = a1 && a2 ? (((a2.lon - a1.lon + 540) % 360) - 180) / 15 : 0;
  const depH = h ? Number(h.slice(0, 2)) + Number(h.slice(3)) / 60 : 12;
  const arrive = new Date(Date.parse(d + "T00:00:00Z") + Math.floor((depH + minutes / 60 + shiftH) / 24) * 86_400_000).toISOString().slice(0, 10);
  return { f: from, t: to, d, h, a: arrive < d ? d : arrive, p: Math.round(price), m: minutes, s: Math.max(0, Math.round(num(r.number_of_changes ?? r.transfers) || 0)), c: str(r.airline), u: str(r.link) ? bookingUrl(str(r.link), from, to, at) : "", w: str(r.found_at) || new Date().toISOString() };
}

export type TpEdges = { edges: RawEdge[]; month: boolean[] };
/** Home fares kept: per process, and for every server in the shared answers for half a day. */
const HOME_TTL_MS = 12 * 3_600_000;
const homeMemo = new Map<string, { at: number; value: TpEdges }>();

/**
 * The fares out of and into a traveller's home cities for the given months (the nightly map holds a city's 80
 * cheapest places a month, so a home far from the nightly airports, San Francisco for one, had almost no way back:
 * Mexico City to San Francisco was in none of them). Four questions a city and month, at most three months; kept 12 h.
 */
export async function homeFares(homeCities: string[], months: string[]): Promise<TpEdges> {
  const today = new Date().toISOString().slice(0, 10);
  const out: TpEdges = { edges: [], month: [] };
  const jobs: Promise<void>[] = [];
  for (const city of [...new Set(homeCities)].slice(0, 3)) {
    for (const month of months.slice(0, 3)) {
      const key = `tp-home:${city}:${month}`;
      jobs.push(
        (async () => {
          const hit = homeMemo.get(key);
          let value: TpEdges | null = hit && Date.now() - hit.at < HOME_TTL_MS ? hit.value : null;
          if (!value) {
            const shared = await getAnswer(key, HOME_TTL_MS).catch(() => null);
            if (shared?.body && Array.isArray((shared.body as TpEdges).edges)) value = shared.body as TpEdges;
          }
          if (!value) {
            const [outG, outD, inG, inD] = await Promise.all([askTp({ origin: city, month, grouped: true }, 2), askTp({ origin: city, month, grouped: false }, 2), askTp({ destination: city, month, grouped: true }, 2), askTp({ destination: city, month, grouped: false }, 2)]);
            value = { edges: [], month: [] };
            const push = (rows: Raw[], grouped: boolean, inbound: boolean) => {
              for (const r of rows) {
                const e = tpEdge(r, inbound ? "" : city, today, inbound ? city : undefined);
                if (e) {
                  value!.edges.push(e);
                  value!.month.push(grouped);
                }
              }
            };
            push(outG, true, false);
            push(outD, false, false);
            push(inG, true, true);
            push(inD, false, true);
            if (value.edges.length) void putAnswer(key, "tp-home", JSON.stringify(value)).catch(() => false);
          }
          homeMemo.set(key, { at: Date.now(), value });
          if (homeMemo.size > 200) homeMemo.delete(homeMemo.keys().next().value!);
          out.edges.push(...value.edges);
          out.month.push(...value.month);
        })(),
      );
    }
  }
  await Promise.all(jobs);
  return out;
}
