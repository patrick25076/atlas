// Server-only. Daily caps on everything that costs money or quota per call, so a script
// hammering the public site cannot run up the model bill or burn a month of Tavily in an
// hour: chat turns, model calls, Tavily searches, Foursquare calls, LiteAPI calls.
//
// allowUsage(kind, weight) adds `weight` to today's counter (UTC day) and says whether the
// call may go ahead. With DATABASE_URL the counter is one row per day and kind in Postgres
// (table usage_daily, an atomic upsert that only adds while under the limit), so the cap is
// global across every Vercel instance. Without the database, or for a minute after it
// failed, the counter lives in this process: the cap then holds per instance, which is
// weaker but never blocks the site because Postgres had a bad minute (it fails open).
//
// Limits: ATLAS_CAP_<KIND> (ATLAS_CAP_CHAT_TURN, ATLAS_CAP_MODEL_CALL, ATLAS_CAP_TAVILY,
// ATLAS_CAP_FOURSQUARE, ATLAS_CAP_LITEAPI), defaults below. The scheduled GitHub jobs (the
// nightly hotel snapshot calls LiteAPI 160 times) are ours and bounded, so they are not
// counted: GITHUB_ACTIONS=true or ATLAS_CAPS_OFF=1 skips the cap.
//
// chatRateLimit(ip): 30 chat turns an hour per address, in process (a TtlLru, bounded).
import postgres from "postgres";
import { TtlLru } from "./memo";

export type UsageKind = "chat_turn" | "model_call" | "tavily" | "foursquare" | "liteapi";
export type UsageResult = { ok: boolean; used: number; limit: number };

const DEFAULTS: Record<UsageKind, number> = { chat_turn: 400, model_call: 250, tavily: 250, foursquare: 250, liteapi: 400 };

export function usageLimit(kind: UsageKind): number {
  // An empty value (a line uncommented with nothing after "=") means unset: Number("") is 0,
  // which would otherwise block that service from the first call of the day.
  const v = process.env[`ATLAS_CAP_${kind.toUpperCase()}`]?.trim();
  if (!v) return DEFAULTS[kind];
  const raw = Number(v);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULTS[kind];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---- the in-process counter (no database, or the database is down) ----
const local = new Map<string, number>();
function countLocal(day: string, kind: UsageKind, weight: number, limit: number): UsageResult {
  // Keep only today's keys, so the map holds at most five entries.
  for (const k of local.keys()) if (!k.startsWith(day)) local.delete(k);
  const key = `${day}|${kind}`;
  const used = local.get(key) ?? 0;
  if (used + weight > limit) return { ok: false, used, limit };
  local.set(key, used + weight);
  return { ok: true, used: used + weight, limit };
}

// ---- Postgres ----
let sql: ReturnType<typeof postgres> | null = null;
let schema: Promise<void> | null = null;
let downUntil = 0;
const DOWN_MS = 60_000;
const QUERY_TIMEOUT_MS = 2_500;

function db() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  // One connection is plenty for a counter; prepare: false for the Supabase transaction pooler.
  sql ??= postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 5, prepare: false, ssl: /sslmode=|localhost|127\.0\.0\.1/i.test(url) ? undefined : "require", onnotice: () => {} });
  return sql;
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}

async function countDb(client: NonNullable<ReturnType<typeof db>>, day: string, kind: UsageKind, weight: number, limit: number): Promise<UsageResult> {
  schema ??= (async () => {
    await client`create table if not exists usage_daily (day date not null, kind text not null, n int not null default 0, primary key (day, kind))`;
  })().catch((err) => {
    schema = null;
    throw err;
  });
  await within(schema, QUERY_TIMEOUT_MS);
  // One statement: insert today's row or add to it, but only while the sum stays within the
  // limit, so concurrent instances can never push it past the cap and refusals are not counted
  // (the select's where covers the first call of the day, the update's where every later one).
  const rows = await within(
    client<{ n: number }[]>`
      insert into usage_daily (day, kind, n)
      select ${day}::date, ${kind}, ${weight}::int where ${weight}::int <= ${limit}::int
      on conflict (day, kind) do update set n = usage_daily.n + excluded.n
      where usage_daily.n + excluded.n <= ${limit}::int
      returning n`,
    QUERY_TIMEOUT_MS,
  );
  if (rows.length) return { ok: true, used: rows[0].n, limit };
  const cur = await within(client<{ n: number }[]>`select n from usage_daily where day = ${day} and kind = ${kind}`, QUERY_TIMEOUT_MS);
  return { ok: false, used: cur[0]?.n ?? limit, limit };
}

/** Adds `weight` uses of `kind` to today's counter; ok false once the daily limit is reached. Never throws. */
export async function allowUsage(kind: UsageKind, weight = 1): Promise<UsageResult> {
  const limit = usageLimit(kind);
  const w = Math.max(1, Math.floor(weight));
  if (process.env.GITHUB_ACTIONS === "true" || process.env.ATLAS_CAPS_OFF === "1") return { ok: true, used: 0, limit };
  const day = today();
  const client = Date.now() < downUntil ? null : db();
  if (client) {
    try {
      const r = await countDb(client, day, kind, w, limit);
      if (!r.ok) console.log(`usage cap: ${kind} at ${r.used}/${limit} today, refusing`);
      return r;
    } catch (err) {
      downUntil = Date.now() + DOWN_MS;
      console.log(`usage cap: database ${err instanceof Error ? err.message.slice(0, 160) : err}; counting in process for a minute`);
    }
  }
  const r = countLocal(day, kind, w, limit);
  if (!r.ok) console.log(`usage cap: ${kind} at ${r.used}/${limit} today in this process, refusing`);
  return r;
}

/** Today's counters as the database (or this process) has them, for a status line or a test. */
export async function usageToday(): Promise<Record<string, number>> {
  const day = today();
  const client = db();
  if (client) {
    try {
      const rows = await within(client<{ kind: string; n: number }[]>`select kind, n from usage_daily where day = ${day}`, QUERY_TIMEOUT_MS);
      return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    } catch {
      // Fall through to the local counters.
    }
  }
  return Object.fromEntries([...local].filter(([k]) => k.startsWith(day)).map(([k, n]) => [k.split("|")[1], n]));
}

// ---- per-address chat limit ----
const CHAT_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
// Bounded to 10,000 addresses; an address idle for an hour drops out by itself.
const chatWindows = new TtlLru<{ start: number; n: number }>(10_000, HOUR_MS);

/** 30 chat turns an hour per address. retryAfter is in seconds (0 when ok). */
export function chatRateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const key = ip || "unknown";
  const w = chatWindows.get(key);
  if (!w || now - w.start >= HOUR_MS) {
    chatWindows.set(key, { start: now, n: 1 });
    return { ok: true, retryAfter: 0 };
  }
  if (w.n >= CHAT_PER_HOUR) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + HOUR_MS - now) / 1000)) };
  w.n++;
  chatWindows.set(key, w);
  return { ok: true, retryAfter: 0 };
}
