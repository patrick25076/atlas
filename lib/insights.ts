// Server-only. Price insight from the shared fare memory (the fares table lib/db.ts fills on
// every Kiwi search): what a route typically costs for a departure month, and whether a price
// in hand is great, good, typical or high. Reads only; its own small connection pool so the
// infra stream's lib/db.ts stays untouched. Without DATABASE_URL every answer is null.
//
// A return fare and a one-way fare are different products, so every query says which kind it
// wants (back_date null or not) and, when known, the nights band; a two-week return judged
// against one-way history would always read "high".
import postgres from "postgres";
import { TtlLru } from "./memo";

export type Verdict = "great" | "good" | "typical" | "high" | "unknown";
export type PriceInsight = { typical: number | null; samples: number; low: number | null; verdict: Verdict; oneWay: boolean };
export type InsightOpts = {
  /** Judge against one-way fares (default: return fares). */
  oneWay?: boolean;
  /** Only return fares with this many nights, when known. */
  minNights?: number;
  maxNights?: number;
};

let sql: ReturnType<typeof postgres> | null = null;
/** Hosted Postgres wants TLS; a local one usually has none. The URL's sslmode wins when set. */
function sslFor(url: string): "require" | false | undefined {
  if (/sslmode=/i.test(url)) return undefined;
  return /localhost|127\.0\.0\.1|@db:/i.test(url) ? false : "require";
}
function client() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!sql) sql = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: sslFor(url), onnotice: () => {} });
  return sql;
}

const LOOKBACK_DAYS = 60;
type Stats = { typical: number | null; low: number | null; samples: number };
const memo = new TtlLru<Stats>(500, 10 * 60_000);

/** Great under 70% of typical, good under 90%, high over 115%; unknown without history or a price. */
export function verdictFor(typical: number | null, current?: number | null): Verdict {
  if (typical == null || current == null || !Number.isFinite(current)) return "unknown";
  const ratio = current / typical;
  if (ratio <= 0.7) return "great";
  if (ratio <= 0.9) return "good";
  if (ratio > 1.15) return "high";
  return "typical";
}

const band = (o: InsightOpts) => {
  const lo = o.minNights != null && Number.isFinite(o.minNights) ? Math.max(0, Math.round(o.minNights)) : null;
  const hi = o.maxNights != null && Number.isFinite(o.maxNights) ? Math.max(lo ?? 0, Math.round(o.maxNights)) : null;
  return { lo, hi };
};

async function stats(src: string, dst: string, month: string, o: InsightOpts): Promise<Stats | null> {
  const db = client();
  if (!db) return null;
  const { lo, hi } = band(o);
  const key = `${src}|${dst}|${month}|${o.oneWay ? "ow" : "rt"}|${lo ?? ""}-${hi ?? ""}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  try {
    // Typical = the median of the cheapest fare seen per departure date, so a day searched
    // ten times counts once; low = the cheapest of those days. Same kind of ticket only.
    const rows = await db<{ typical: string | null; low: string | null; samples: string }[]>`
      with per_day as (
        select out_date, min(price) as price from fares
        where src = ${src} and dst = ${dst} and out_date >= ${from} and out_date < ${to}
          and seen_at > now() - (${LOOKBACK_DAYS} || ' days')::interval
          and ${o.oneWay ? db`back_date is null` : db`back_date is not null`}
          ${!o.oneWay && lo != null ? db`and nights >= ${lo}` : db``}
          ${!o.oneWay && hi != null ? db`and nights <= ${hi}` : db``}
        group by out_date
      )
      select percentile_cont(0.5) within group (order by price) as typical, min(price) as low, count(*) as samples from per_day`;
    const r = rows[0];
    const value = { typical: r?.typical != null ? Math.round(Number(r.typical)) : null, low: r?.low != null ? Math.round(Number(r.low)) : null, samples: Number(r?.samples ?? 0) };
    memo.set(key, value);
    return value;
  } catch (err) {
    console.log(`insights: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  }
}

/**
 * Typical and lowest price for a route (airport codes) and a departure month (YYYY-MM), for
 * return fares unless opts.oneWay; null without a database. A price in hand gets a verdict.
 */
export async function priceInsight(src: string, dst: string, month: string, currentPrice?: number | null, opts: InsightOpts = {}): Promise<PriceInsight | null> {
  // YYYY-MM with a real month: "2026-13" passes the shape but would make Date.UTC roll over
  // into the next year and the query would silently cover January.
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const mm = Number(month.slice(5, 7));
  if (mm < 1 || mm > 12) return null;
  const s = await stats(src.toUpperCase(), dst.toUpperCase(), month, opts);
  if (!s) return null;
  return { typical: s.typical, samples: s.samples, low: s.low, verdict: verdictFor(s.typical, currentPrice), oneWay: !!opts.oneWay };
}

/** The same, judged against a price in hand: "great" at 30% under typical, "high" at 15% over. */
export async function insightFor(src: string, dst: string, month: string, currentPrice: number, opts: InsightOpts = {}): Promise<PriceInsight | null> {
  return priceInsight(src, dst, month, currentPrice, opts);
}

export type RememberedFare = { src: string; dst: string; /** The landing city's name as Kiwi reported it, when the row has one. */ dstCity: string | null; out: string; back: string | null; nights: number | null; price: number; stops: number; carriers: string[]; url: string };

/**
 * The cheapest fare anyone saw recently from any of `origins` to any of `dsts` leaving in
 * [from, to], of the kind asked for, plus how many distinct departure days the memory holds
 * for that window: one query, ISO dates (to_char, so no JS Date formatting leaks in). The
 * caller decides whether `days` is enough coverage to stand in for a live search.
 */
export async function rememberedFare(origins: string[], dsts: string[], from: string, to: string, o: InsightOpts & { maxAgeDays?: number } = {}): Promise<{ fare: RememberedFare | null; days: number } | null> {
  const db = client();
  if (!db || !origins.length || !dsts.length) return null;
  const { lo, hi } = band(o);
  const age = Math.max(1, Math.round(o.maxAgeDays ?? 1));
  try {
    const rows = await db<{ days: string; src: string; dst: string; dst_city: string | null; out: string; back: string | null; nights: number | null; price: string; stops: number; carriers: string[]; url: string }[]>`
      with recent as (
        select src, dst, dst_city, to_char(out_date, 'YYYY-MM-DD') as out, to_char(back_date, 'YYYY-MM-DD') as back, nights, price, stops, carriers, url
        from fares
        where src = any(${origins}) and dst = any(${dsts}) and out_date >= ${from} and out_date <= ${to}
          and seen_at > now() - (${age} || ' days')::interval
          and ${o.oneWay ? db`back_date is null` : db`back_date is not null`}
          ${!o.oneWay && lo != null ? db`and nights >= ${lo}` : db``}
          ${!o.oneWay && hi != null ? db`and nights <= ${hi}` : db``}
      )
      select (select count(distinct out) from recent) as days, r.* from recent r order by r.price asc limit 1`;
    const r = rows[0];
    if (!r) return { fare: null, days: 0 };
    return { days: Number(r.days), fare: { src: r.src, dst: r.dst, dstCity: r.dst_city ?? null, out: r.out, back: r.back, nights: r.nights, price: Number(r.price), stops: r.stops ?? 0, carriers: r.carriers ?? [], url: r.url } };
  } catch (err) {
    console.log(`insights: memory ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Like with like: the chat's verdict on a fare in hand.
//
// The owner saw "high" and then "great" for the same route in one conversation (2026-10-12):
// the month-wide median mixed one-ways with returns of any length, a pair of airports with
// another pair of the same cities, and fares seen two months ago. fareVerdict compares only
// what is comparable: the same city pair (every airport of each side), the same kind of
// ticket (one-way or return, and for a return the nights within two of the fare in hand),
// departures within DEPART_SLACK_DAYS of the fare's own day, sightings of the last
// SIGHTING_DAYS. A sample is the cheapest fare per departure day per sighting day, so one
// popular day searched forty times counts once a day. Fewer than MIN_SAMPLES is not history.

/** Departures this many days either side of the fare in hand are the same product. */
export const DEPART_SLACK_DAYS = 7;
/** Sightings older than this are a different market. */
export const SIGHTING_DAYS = 30;
/** Below this many samples the memory says "not enough history", never great or high. */
export const MIN_SAMPLES = 5;

export type FareVerdict = {
  verdict: Verdict | "not enough history";
  /** The samples the verdict rests on (see above); 0 when nothing comparable was seen. */
  samples: number;
  typical: number | null;
  low: number | null;
  /** The comparison in words, for the model to repeat: "based on 12 fares, one-way, departures 24 Oct to 7 Nov, seen in the last 30 days". */
  basis: string;
};

const verdictMemo = new TtlLru<{ typical: number | null; low: number | null; samples: number }>(500, 10 * 60_000);

/**
 * The fare memory's verdict on a fare in hand, like with like (see above). Null without a
 * database (the caller says the memory is off, which is not the same as no history).
 */
export async function fareVerdict(q: { srcs: string[]; dsts: string[]; depart: string; oneWay: boolean; nights?: number | null; price?: number | null }): Promise<FareVerdict | null> {
  const db = client();
  if (!db) return null;
  const srcs = [...new Set(q.srcs.map((s) => s.toUpperCase()))].slice(0, 6);
  const dsts = [...new Set(q.dsts.map((s) => s.toUpperCase()))].slice(0, 6);
  if (!srcs.length || !dsts.length || !/^\d{4}-\d{2}-\d{2}$/.test(q.depart)) return null;
  const day = Date.parse(q.depart + "T00:00:00Z");
  if (!Number.isFinite(day)) return null;
  const from = new Date(day - DEPART_SLACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(day + DEPART_SLACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const nights = !q.oneWay && q.nights != null && Number.isFinite(q.nights) ? Math.max(1, Math.round(q.nights)) : null;
  const key = `${srcs.join(",")}|${dsts.join(",")}|${from}|${q.oneWay ? "ow" : `rt${nights ?? ""}`}`;
  let s = verdictMemo.get(key);
  if (!s) {
    try {
      const rows = await db<{ typical: string | null; low: string | null; samples: string }[]>`
        with per_day as (
          select out_date, date_trunc('day', seen_at) as seen_day, min(price) as price from fares
          where src = any(${srcs}) and dst = any(${dsts}) and out_date >= ${from} and out_date <= ${to}
            and seen_at > now() - (${SIGHTING_DAYS} || ' days')::interval
            and ${q.oneWay ? db`back_date is null` : db`back_date is not null`}
            ${nights != null ? db`and nights between ${nights - 2} and ${nights + 2}` : db``}
          group by out_date, seen_day
        )
        select percentile_cont(0.5) within group (order by price) as typical, min(price) as low, count(*) as samples from per_day`;
      const r = rows[0];
      s = { typical: r?.typical != null ? Math.round(Number(r.typical)) : null, low: r?.low != null ? Math.round(Number(r.low)) : null, samples: Number(r?.samples ?? 0) };
      verdictMemo.set(key, s);
    } catch (err) {
      console.log(`insights: verdict ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return null;
    }
  }
  const kind = q.oneWay ? "one-way" : `return${nights != null ? `, ${Math.max(1, nights - 2)} to ${nights + 2} nights` : ""}`;
  const basis = `based on ${s.samples} fare${s.samples === 1 ? "" : "s"} (${kind}, departures ${from} to ${to}, seen in the last ${SIGHTING_DAYS} days)`;
  if (s.samples < MIN_SAMPLES) return { verdict: "not enough history", samples: s.samples, typical: s.typical, low: s.low, basis };
  return { verdict: verdictFor(s.typical, q.price ?? null), samples: s.samples, typical: s.typical, low: s.low, basis };
}
