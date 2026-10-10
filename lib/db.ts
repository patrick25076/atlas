// Server-only. The shared memory of Atlas: every fare any search ever saw, with its
// timestamp, so the next person asking gets history for free; saved trips; a log of searches.
// Postgres through DATABASE_URL (Supabase or Neon, SETUP.md §4). Without it every function is
// a quiet no-op, so the app runs the same with or without the database.
import postgres from "postgres";
import type { KiwiItinerary } from "./kiwi";

let sql: ReturnType<typeof postgres> | null = null;
let ready: Promise<boolean> | null = null;

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL?.trim();
}

function client() {
  if (!hasDb()) return null;
  if (!sql) sql = postgres(process.env.DATABASE_URL!.trim(), { max: 3, idle_timeout: 20, connect_timeout: 10, prepare: false });
  return sql;
}

/** Creates the tables on first use. Cheap after the first call. */
export function ensureSchema(): Promise<boolean> {
  if (!ready) {
    ready = (async () => {
      const db = client();
      if (!db) return false;
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
        return true;
      } catch (err) {
        console.log(`db: schema ${err instanceof Error ? err.message.slice(0, 200) : err}`);
        return false;
      }
    })();
  }
  return ready;
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

/** What this route cost whenever anyone looked: cheapest per departure date, newest first. */
export async function fareHistory(src: string, dst: string, from?: string, to?: string, limit = 30): Promise<FareSeen[]> {
  const db = client();
  if (!db || !(await ensureSchema())) return [];
  try {
    const rows = await db<{ src: string; dst: string; out_date: string; back_date: string | null; nights: number | null; price: string; stops: number; carriers: string[]; hours: string; url: string; seen_at: string }[]>`
      select distinct on (out_date, coalesce(back_date, '1970-01-01')) src, dst, out_date, back_date, nights, price, stops, carriers, hours, url, seen_at
      from fares where src = ${src} and dst = ${dst}
      ${from ? db`and out_date >= ${from}` : db``} ${to ? db`and out_date <= ${to}` : db``}
      order by out_date, coalesce(back_date, '1970-01-01'), price asc limit ${limit}`;
    return rows.map((r) => ({ src: r.src, dst: r.dst, out: String(r.out_date).slice(0, 10), back: r.back_date ? String(r.back_date).slice(0, 10) : null, nights: r.nights, price: Number(r.price), stops: r.stops, carriers: r.carriers, hours: Number(r.hours), url: r.url, seenAt: String(r.seen_at) }));
  } catch (err) {
    console.log(`db: history ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return [];
  }
}

/** The cheapest fare seen to a city in a window, from any of several origins, in the last days. */
export async function cheapestSeen(origins: string[], dst: string, from: string, to: string, maxAgeDays = 7): Promise<FareSeen | null> {
  const db = client();
  if (!db || !(await ensureSchema())) return null;
  try {
    const rows = await db<{ src: string; dst: string; out_date: string; back_date: string | null; nights: number | null; price: string; stops: number; carriers: string[]; hours: string; url: string; seen_at: string }[]>`
      select src, dst, out_date, back_date, nights, price, stops, carriers, hours, url, seen_at from fares
      where src = any(${origins}) and dst = ${dst} and out_date >= ${from} and out_date <= ${to} and seen_at > now() - (${maxAgeDays} || ' days')::interval
      order by price asc limit 1`;
    const r = rows[0];
    return r ? { src: r.src, dst: r.dst, out: String(r.out_date).slice(0, 10), back: r.back_date ? String(r.back_date).slice(0, 10) : null, nights: r.nights, price: Number(r.price), stops: r.stops, carriers: r.carriers, hours: Number(r.hours), url: r.url, seenAt: String(r.seen_at) } : null;
  } catch {
    return null;
  }
}

export async function logSearch(kind: string, params: unknown, results: number, ms: number): Promise<void> {
  const db = client();
  if (!db || !(await ensureSchema())) return;
  try {
    await db`insert into searches (kind, params, results, ms) values (${kind}, ${db.json(params as never)}, ${results}, ${ms})`;
  } catch {
    // never block a search on its log
  }
}

export type SavedTrip = { id: string; owner: string; kind: "wild" | "short" | "custom" | "imported"; title: string; body: unknown; createdAt: string; updatedAt: string };

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
    const rows = await db<{ id: string; owner: string; kind: SavedTrip["kind"]; title: string; body: unknown; created_at: string; updated_at: string }[]>`select * from trips where owner = ${owner} order by updated_at desc limit 50`;
    return rows.map((r) => ({ id: r.id, owner: r.owner, kind: r.kind, title: r.title, body: r.body, createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  } catch {
    return [];
  }
}

export async function deleteTrip(owner: string, id: string): Promise<boolean> {
  const db = client();
  if (!db || !(await ensureSchema())) return false;
  try {
    await db`delete from trips where owner = ${owner} and id = ${id}`;
    return true;
  } catch {
    return false;
  }
}
