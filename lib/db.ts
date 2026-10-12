// Server-only. The shared memory of Atlas: every fare any search ever saw, with its
// timestamp, so the next person asking gets history for free; saved trips; a log of searches.
// Postgres through DATABASE_URL (Supabase or Neon, SETUP.md §4). Without it every function is
// a quiet no-op, so the app runs the same with or without the database; the moment the
// variable appears, the tables are created on first use and everything switches on.
//
// Connection notes (Supabase): use the pooler host in transaction mode (port 6543, user
// postgres.<ref>), never the direct db.<ref>.supabase.co host, which is IPv6-only and
// unreachable from Vercel. Transaction mode forbids prepared statements, hence prepare: false.
//
// Dates: the postgres driver turns a `date` column into a JS Date (and a timestamptz into a
// Date too), and String(date) is "Tue Dec 15 2026 ...", so every date column is read through
// to_char(..., 'YYYY-MM-DD') in the SQL and every timestamp through isoStamp(), so callers
// always get "2026-12-15" and an ISO timestamp, never a locale string.
import postgres from "postgres";
import type { KiwiItinerary } from "./kiwi";

let sql: ReturnType<typeof postgres> | null = null;
let ready: Promise<boolean> | null = null;
/** When the schema check last failed twice in a row (0 when it never did, or it worked since). */
let failedAt = 0;
/** How long a failed database is remembered as down before a call tries it again. */
const DOWN_MS = 60_000;
/** Seconds to wait for one connection; two attempts plus the pause bound a dead host at ~11 s, once a minute. */
const CONNECT_TIMEOUT_S = 5;

/** A YYYY-MM-DD from whatever the driver handed back: a string already, or a Date. */
function isoDay(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
}

/** An ISO timestamp from a Date or a string the driver handed back. */
function isoStamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : String(v ?? "");
}

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL?.trim();
}

/** Hosted Postgres wants TLS; a local one usually has none. The URL's sslmode wins when set. */
function sslFor(url: string): "require" | false | undefined {
  if (/sslmode=/i.test(url)) return undefined;
  return /localhost|127\.0\.0\.1|@db:/i.test(url) ? false : "require";
}

function client() {
  if (!hasDb()) return null;
  if (!sql) {
    const url = process.env.DATABASE_URL!.trim();
    // Few connections per instance: a serverless deploy has many instances and the pooler has a cap.
    // onnotice: "create table if not exists" prints a NOTICE per existing table otherwise.
    sql = postgres(url, { max: 3, idle_timeout: 20, connect_timeout: CONNECT_TIMEOUT_S, prepare: false, ssl: sslFor(url), onnotice: () => {} });
  }
  return sql;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Creates the tables on first use. Cheap after the first success. A failure (the pooler
 * dropping the first connection of a cold instance, a short outage) is retried once after a
 * second and, if that fails too, the database is remembered as down for DOWN_MS: every call
 * in that minute returns false at once instead of each paying two connect timeouts (an
 * unreachable host, a pooler behind a stale password), and after the minute the next call
 * tries again, so a transient error never disables the database for the life of the process.
 */
export function ensureSchema(): Promise<boolean> {
  if (failedAt && Date.now() - failedAt < DOWN_MS) return Promise.resolve(false);
  if (!ready) {
    ready = (async () => {
      const db = client();
      if (!db) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ok = await createTables(db);
        if (ok) {
          failedAt = 0;
          return true;
        }
        if (attempt === 0) await sleep(1000);
      }
      // Forget the failed promise and remember the time: down for a minute, then try again.
      ready = null;
      failedAt = Date.now();
      return false;
    })();
  }
  return ready;
}

async function createTables(db: NonNullable<ReturnType<typeof client>>): Promise<boolean> {
  try {
    await db`create table if not exists fares (
      id bigserial primary key,
      src text not null, dst text not null, src_city text, dst_city text,
      out_date date not null, back_date date, nights int,
      price numeric(10,2) not null, currency text default 'EUR',
      stops int, carriers text[], hours numeric(6,1), route text[], url text,
      seen_at timestamptz not null default now()
    )`;
    await db`create index if not exists fares_route_idx on fares (src, dst, out_date, seen_at desc)`;
    await db`create index if not exists fares_dst_idx on fares (dst, seen_at desc)`;
    await db`create table if not exists trips (
      id text primary key, owner text not null, kind text not null, title text not null,
      body jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    )`;
    await db`create index if not exists trips_owner_idx on trips (owner, updated_at desc)`;
    await db`create table if not exists searches (
      id bigserial primary key, kind text not null, params jsonb not null, results int, ms int, at timestamptz not null default now()
    )`;
    // Nightly hotel snapshots (scripts/ingest/hotels.ts): the cheapest decent hotel per
    // city for a standard weekend, so a price well under its own history is a hotel deal.
    await db`create table if not exists hotel_prices (
      id bigserial primary key,
      city_code text not null, checkin date not null, checkout date not null,
      hotel_id text not null, hotel_name text not null, stars int,
      per_night numeric(10,2) not null, seen_at timestamptz not null default now()
    )`;
    await db`create index if not exists hotel_prices_city_idx on hotel_prices (city_code, seen_at desc)`;
    // The run log (lib/run-log.ts): what Atlas did for each search, chat turn and walk, for the engine room.
    await db`create table if not exists runs (
      id bigserial primary key, at timestamptz not null default now(),
      kind text not null, source text not null, device text not null, title text not null,
      ms int, errors int not null default 0, body jsonb not null
    )`;
    await db`create index if not exists runs_at_idx on runs (at desc)`;
    // Answers shared across server instances and visitors (lib/shared-cache.ts): a search, a walk or a way home
    // asked again within the hour is answered from here instead of running again.
    await db`create table if not exists answers (
      key text primary key, kind text not null, at timestamptz not null default now(), body jsonb not null
    )`;
    return true;
  } catch (err) {
    console.log(`db: schema ${err instanceof Error ? err.message.slice(0, 200) : err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// Shared answers (lib/shared-cache.ts).

/** A kept answer no older than maxAgeMs, or null. Never throws. */
export async function getAnswer(key: string, maxAgeMs: number): Promise<{ at: string; body: unknown } | null> {
  const db = client();
  if (!db || !(await ensureSchema())) return null;
  try {
    const rows = await db<{ at: Date; body: unknown }[]>`select at, body from answers where key = ${key} and at > now() - (${Math.round(maxAgeMs / 1000)} || ' seconds')::interval`;
    const x = rows[0];
    if (!x) return null;
    return { at: new Date(x.at).toISOString(), body: typeof x.body === "string" ? JSON.parse(x.body) : x.body };
  } catch (err) {
    console.log(`db: answer ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  }
}

/** Keeps an answer (its JSON already made), replacing an older one; now and then drops answers past a day. */
export async function putAnswer(key: string, kind: string, json: string): Promise<boolean> {
  const db = client();
  if (!db || !(await ensureSchema())) return false;
  try {
    await db`insert into answers (key, kind, at, body) values (${key}, ${kind}, now(), ${json}::text::jsonb)
      on conflict (key) do update set at = now(), body = excluded.body, kind = excluded.kind`;
    if (Math.random() < 0.02) await db`delete from answers where at < now() - interval '1 day'`;
    return true;
  } catch (err) {
    console.log(`db: answer ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// The run log (lib/run-log.ts writes, the engine room reads).

export type RunRow = { id: number; at: string; kind: string; source: string; device: string; title: string; ms: number | null; errors: number };
/** Days a run is kept. */
const RUN_KEEP_DAYS = 7;

/** One run, its body already JSON. Now and then the runs past RUN_KEEP_DAYS are dropped. */
export async function insertRun(r: { kind: string; source: string; device: string; title: string; ms: number; errors: number; body: string }): Promise<boolean> {
  const db = client();
  if (!db || !(await ensureSchema())) return false;
  try {
    await db`insert into runs (kind, source, device, title, ms, errors, body) values (${r.kind}, ${r.source}, ${r.device}, ${r.title}, ${r.ms}, ${r.errors}, ${r.body}::text::jsonb)`;
    if (Math.random() < 0.03) await db`delete from runs where at < now() - (${RUN_KEEP_DAYS} || ' days')::interval`;
    return true;
  } catch (err) {
    console.log(`db: run ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return false;
  }
}

/** The newest runs (after an id, for polling), without their bodies. */
export async function listRuns(opts: { after?: number; limit?: number; device?: string; kind?: string } = {}): Promise<RunRow[]> {
  const db = client();
  if (!db || !(await ensureSchema())) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 60));
  try {
    const rows = await db<{ id: string; at: Date; kind: string; source: string; device: string; title: string; ms: number | null; errors: number }[]>`
      select id, at, kind, source, device, title, ms, errors from runs
      where true ${opts.after ? db`and id > ${opts.after}` : db``} ${opts.device ? db`and device = ${opts.device}` : db``} ${opts.kind ? db`and kind = ${opts.kind}` : db``}
      order by id desc limit ${limit}`;
    return rows.map((x) => ({ id: Number(x.id), at: new Date(x.at).toISOString(), kind: x.kind, source: x.source, device: x.device, title: x.title, ms: x.ms, errors: x.errors }));
  } catch (err) {
    console.log(`db: runs ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  }
}

/** One run with its body. */
export async function getRun(id: number): Promise<(RunRow & { body: unknown }) | null> {
  const db = client();
  if (!db || !(await ensureSchema())) return null;
  try {
    const rows = await db<{ id: string; at: Date; kind: string; source: string; device: string; title: string; ms: number | null; errors: number; body: unknown }[]>`select * from runs where id = ${id}`;
    const x = rows[0];
    // A row written as a JSON string (before ::text::jsonb) still reads as the object it holds.
    const body = typeof x?.body === "string" ? JSON.parse(x.body) : x?.body;
    return x ? { id: Number(x.id), at: new Date(x.at).toISOString(), kind: x.kind, source: x.source, device: x.device, title: x.title, ms: x.ms, errors: x.errors, body } : null;
  } catch (err) {
    console.log(`db: run ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  }
}

/** Every itinerary a Kiwi search returned, remembered with the time it was seen. */
export async function recordFares(itineraries: KiwiItinerary[]): Promise<void> {
  const db = client();
  if (!db || !itineraries.length) return;
  if (!(await ensureSchema())) return;
  const rows = itineraries.slice(0, 30).map((it) => ({
    src: it.outbound.from,
    dst: it.outbound.to,
    src_city: it.outbound.segments[0]?.fromCity ?? null,
    dst_city: it.outbound.segments.at(-1)?.toCity ?? null,
    out_date: it.outbound.departureTime.slice(0, 10),
    back_date: it.inbound?.departureTime.slice(0, 10) ?? null,
    nights: it.inbound ? Math.round((Date.parse(it.inbound.departureTime.slice(0, 10)) - Date.parse(it.outbound.departureTime.slice(0, 10))) / 86_400_000) : null,
    price: Math.round(it.price * 100) / 100,
    currency: "EUR",
    stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0),
    carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))],
    hours: Math.round(it.outbound.durationSeconds / 360) / 10,
    route: it.outbound.route,
    url: it.bookingUrl,
  }));
  try {
    await db`insert into fares ${db(rows, "src", "dst", "src_city", "dst_city", "out_date", "back_date", "nights", "price", "currency", "stops", "carriers", "hours", "route", "url")}`;
  } catch (err) {
    console.log(`db: fares ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
}

export type FareSeen = { src: string; dst: string; out: string; back: string | null; nights: number | null; price: number; stops: number; carriers: string[]; hours: number; url: string; seenAt: string };

/** A fares row as the queries below select it: dates already text through to_char. */
type FareRow = { src: string; dst: string; out_iso: string; back_iso: string | null; nights: number | null; price: string; stops: number; carriers: string[]; hours: string; url: string; seen_at: string | Date };

function fareOf(r: FareRow): FareSeen {
  return { src: r.src, dst: r.dst, out: isoDay(r.out_iso), back: r.back_iso ? isoDay(r.back_iso) : null, nights: r.nights, price: Number(r.price), stops: r.stops, carriers: r.carriers, hours: Number(r.hours), url: r.url, seenAt: isoStamp(r.seen_at) };
}

/**
 * Every one-way sighting between two sets of airports in a window (the admin's engine room): one row per departure
 * day and price, newest sighting first, so a gap reads as a gap (a day nobody searched) and a price as when it was seen.
 */
export async function fareSightings(srcs: string[], dsts: string[], from: string, to: string, limit = 400): Promise<FareSeen[]> {
  const db = client();
  if (!db || !srcs.length || !dsts.length || !(await ensureSchema())) return [];
  try {
    const rows = await db<FareRow[]>`
      select src, dst, to_char(out_date, 'YYYY-MM-DD') as out_iso, to_char(back_date, 'YYYY-MM-DD') as back_iso,
        nights, price, stops, carriers, hours, url, seen_at
      from fares where src = any(${srcs}) and dst = any(${dsts}) and back_date is null
        and out_date >= ${from} and out_date <= ${to}
      order by out_date, price asc, seen_at desc limit ${limit}`;
    return rows.map(fareOf);
  } catch (err) {
    console.log(`db: sightings ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  }
}

/** What this route cost whenever anyone looked: cheapest per departure date, newest first. */
export async function fareHistory(src: string, dst: string, from?: string, to?: string, limit = 30): Promise<FareSeen[]> {
  const db = client();
  if (!db || !(await ensureSchema())) return [];
  try {
    // The ISO aliases are named apart from the columns so distinct on / order by keep using the real date columns.
    const rows = await db<FareRow[]>`
      select distinct on (out_date, coalesce(back_date, '1970-01-01')) src, dst,
        to_char(out_date, 'YYYY-MM-DD') as out_iso, to_char(back_date, 'YYYY-MM-DD') as back_iso,
        nights, price, stops, carriers, hours, url, seen_at
      from fares where src = ${src} and dst = ${dst}
      ${from ? db`and out_date >= ${from}` : db``} ${to ? db`and out_date <= ${to}` : db``}
      order by out_date, coalesce(back_date, '1970-01-01'), price asc limit ${limit}`;
    return rows.map(fareOf);
  } catch (err) {
    console.log(`db: history ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  }
}

/**
 * The cheapest fare seen to a destination in a window, from any of several origins, in the
 * last days. `dst` is one airport code or a list of them (a city's airports: BKK and DMK for
 * Bangkok), and `dstCity` optionally matches the city name Kiwi reported (dst_city), so a
 * fare into any airport of a multi-airport city is found in one query.
 */
export async function cheapestSeen(origins: string[], dst: string | string[], from: string, to: string, maxAgeDays = 7, dstCity?: string): Promise<FareSeen | null> {
  const db = client();
  if (!db || !(await ensureSchema())) return null;
  const dsts = (Array.isArray(dst) ? dst : [dst]).map((d) => d.trim().toUpperCase()).filter(Boolean);
  const city = dstCity?.trim();
  if (!dsts.length && !city) return null;
  try {
    const rows = await db<FareRow[]>`
      select src, dst, to_char(out_date, 'YYYY-MM-DD') as out_iso, to_char(back_date, 'YYYY-MM-DD') as back_iso,
        nights, price, stops, carriers, hours, url, seen_at from fares
      where src = any(${origins}) and (dst = any(${dsts}) ${city ? db`or lower(dst_city) = lower(${city})` : db``})
      and out_date >= ${from} and out_date <= ${to} and seen_at > now() - (${maxAgeDays} || ' days')::interval
      order by price asc limit 1`;
    const r = rows[0];
    return r ? fareOf(r) : null;
  } catch {
    return null;
  }
}

/**
 * The usage log: what kind of search ran, with which parameters (never personal data: no
 * names, coordinates or addresses), how many results, how long. Fire and forget: the routes
 * call it without awaiting, and it never throws, so a slow or absent database costs the
 * visitor nothing.
 */
export async function logSearch(kind: string, params: unknown, results: number, ms: number): Promise<void> {
  try {
    const db = client();
    if (!db || !(await ensureSchema())) return;
    await db`insert into searches (kind, params, results, ms) values (${kind}, ${db.json(params as never)}, ${Math.round(results)}, ${Math.round(ms)})`;
  } catch {
    // never block a search on its log
  }
}

export type HotelPriceRow = { cityCode: string; checkin: string; checkout: string; hotelId: string; hotelName: string; stars: number | null; perNight: number; seenAt?: string };

/** One row per city per nightly snapshot. The whole snapshot is one insert. */
export async function recordHotelPrices(rows: HotelPriceRow[]): Promise<boolean> {
  const db = client();
  if (!db || !rows.length || !(await ensureSchema())) return false;
  const seenAt = rows[0].seenAt ?? new Date().toISOString();
  const values = rows.map((r) => ({ city_code: r.cityCode, checkin: r.checkin, checkout: r.checkout, hotel_id: r.hotelId, hotel_name: r.hotelName.slice(0, 200), stars: r.stars, per_night: Math.round(r.perNight * 100) / 100, seen_at: r.seenAt ?? seenAt }));
  try {
    await db`insert into hotel_prices ${db(values, "city_code", "checkin", "checkout", "hotel_id", "hotel_name", "stars", "per_night", "seen_at")}`;
    return true;
  } catch (err) {
    console.log(`db: hotel_prices ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return false;
  }
}

/** Every snapshot of the last `days`, newest first: what each city's cheapest decent hotel cost each night. */
export async function hotelPriceHistory(days = 45): Promise<HotelPriceRow[]> {
  const db = client();
  if (!db || !(await ensureSchema())) return [];
  try {
    const rows = await db<{ city_code: string; checkin_iso: string; checkout_iso: string; hotel_id: string; hotel_name: string; stars: number | null; per_night: string; seen_at: string | Date }[]>`
      select city_code, to_char(checkin, 'YYYY-MM-DD') as checkin_iso, to_char(checkout, 'YYYY-MM-DD') as checkout_iso,
        hotel_id, hotel_name, stars, per_night, seen_at from hotel_prices
      where seen_at > now() - (${days} || ' days')::interval order by seen_at desc limit 20000`;
    return rows.map((r) => ({ cityCode: r.city_code, checkin: isoDay(r.checkin_iso), checkout: isoDay(r.checkout_iso), hotelId: r.hotel_id, hotelName: r.hotel_name, stars: r.stars, perNight: Number(r.per_night), seenAt: isoStamp(r.seen_at) }));
  } catch (err) {
    console.log(`db: hotel history ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  }
}

/** `itinerary`: a generated day-by-day plan (lib/itinerary.ts), saved from the itinerary view. */
export type SavedTrip = { id: string; owner: string; kind: "wild" | "short" | "custom" | "imported" | "itinerary"; title: string; body: unknown; createdAt: string; updatedAt: string };

export async function saveTrip(t: { id: string; owner: string; kind: SavedTrip["kind"]; title: string; body: unknown }): Promise<boolean> {
  const db = client();
  if (!db || !(await ensureSchema())) return false;
  try {
    await db`insert into trips (id, owner, kind, title, body) values (${t.id}, ${t.owner}, ${t.kind}, ${t.title}, ${db.json(t.body as never)})
      on conflict (id) do update set title = excluded.title, body = excluded.body, updated_at = now()`;
    return true;
  } catch (err) {
    console.log(`db: save ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return false;
  }
}

export async function listTrips(owner: string): Promise<SavedTrip[]> {
  const db = client();
  if (!db || !(await ensureSchema())) return [];
  try {
    const rows = await db<{ id: string; owner: string; kind: SavedTrip["kind"]; title: string; body: unknown; created_at: string | Date; updated_at: string | Date }[]>`select * from trips where owner = ${owner} order by updated_at desc limit 50`;
    return rows.map((r) => ({ id: r.id, owner: r.owner, kind: r.kind, title: r.title, body: r.body, createdAt: isoStamp(r.created_at), updatedAt: isoStamp(r.updated_at) }));
  } catch {
    return [];
  }
}

/** One saved trip by id, whoever owns it (a shared link), or null. */
export async function getTrip(id: string): Promise<SavedTrip | null> {
  const db = client();
  if (!db || !(await ensureSchema())) return null;
  try {
    const rows = await db<{ id: string; owner: string; kind: SavedTrip["kind"]; title: string; body: unknown; created_at: string | Date; updated_at: string | Date }[]>`select * from trips where id = ${id} limit 1`;
    const r = rows[0];
    return r ? { id: r.id, owner: r.owner, kind: r.kind, title: r.title, body: r.body, createdAt: isoStamp(r.created_at), updatedAt: isoStamp(r.updated_at) } : null;
  } catch {
    return null;
  }
}

/** Deletes only the owner's own row; true when a row went. */
export async function deleteTrip(owner: string, id: string): Promise<boolean> {
  const db = client();
  if (!db || !(await ensureSchema())) return false;
  try {
    const gone = await db`delete from trips where owner = ${owner} and id = ${id} returning id`;
    return gone.length > 0;
  } catch {
    return false;
  }
}
