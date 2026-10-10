// Server-only. Kiwi.com's public MCP server (https://mcp.kiwi.com, no key): live flight
// search with prices and booking links. We speak just enough JSON-RPC over streamable HTTP
// to call its search-flight tool. The nightly boards ingest is the main consumer, the live
// routes (board, finder, deals, combos, wild) the rest.
//
// Kiwi returns the 15 cheapest itineraries per search and throttles an address after a
// couple of thousand searches a day, so every call goes through one process-wide gate:
// at most MAX_CONCURRENT searches at a time with a small gap between starts (the start time
// is reserved under the lock, so a burst is spread out instead of landing in one instant), a
// daily counter that logs when it crosses a threshold and refuses new live searches past a
// hard budget (so one visitor cannot spend the address for everyone), and a 24-hour memo
// keyed by the exact arguments so the same search is never sent twice from one process.
// Identical searches in flight share one promise. On Vercel each function instance has its
// own gate, counter and memo; the budget is per instance, which still bounds what one warm
// instance can do in a day.
//
// A circuit breaker sits in front of all of that: the moment Kiwi answers 403 or 429 (on a
// search or on the initialize handshake) the address is marked throttled for THROTTLE_MS and
// every live search in that window throws the plain throttle sentence at once, without a
// request leaving the process. Hammering a throttled address only makes the block longer;
// five quiet minutes is what lifted it when this machine was blocked.
import { InFlight, TtlLru } from "./memo";

const ENDPOINT = "https://mcp.kiwi.com/";
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";
const HEADERS = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

export type KiwiLeg = {
  from: string;
  to: string;
  departureTime: string;
  arrivalTime: string;
  durationSeconds: number;
  stops: number;
  route: string[];
  segments: { from: string; to: string; fromCity: string; toCity: string; fromCountry: string; toCountry: string; carrier: string; carrierName: string; flightNumber: string; departureTime: string; arrivalTime: string; durationSeconds: number }[];
};
export type KiwiItinerary = {
  id: string;
  price: number;
  priceFormatted: string;
  totalDurationSeconds: number;
  bookingUrl: string;
  imageId?: string;
  baggage?: { personalItem: number; cabinBag: number; checkedBag: number };
  outbound: KiwiLeg;
  inbound?: KiwiLeg;
};
export type KiwiResult = { query: string; currency: string; resultsCount: number; itineraries: KiwiItinerary[] };

export type SearchArgs = {
  flyFrom: string;
  flyTo: string;
  /** dd/mm/yyyy */
  departureDate: string;
  departureDateTo?: string;
  departureDateFlexDays?: number;
  returnDate?: string;
  returnDateTo?: string;
  returnDateFlexDays?: number;
  adults?: number;
  currency?: string;
};

// ---------------------------------------------------------------------------------------
// The gate: concurrency, pacing, the daily counter.

const MAX_CONCURRENT = Math.max(1, Number(process.env.KIWI_MAX_CONCURRENT) || 6);
/** Milliseconds between two search starts, so a burst of six does not land in one instant. */
const GAP_MS = 120;
/** The counter logs at each of these, then every 500 after. */
const LOG_AT = [250, 500, 1000, 1500, 2000];
/**
 * The hard daily budget per process: past it, a live search is refused with a plain error
 * instead of being sent, so one busy day (or one visitor reloading a 300-search page) never
 * takes the address into Kiwi's throttle for every other feature. Below Kiwi's observed
 * limit (~2,000) on purpose. The nightly ingest runs on its own runner and may raise it.
 */
const DAILY_BUDGET = Math.max(100, Number(process.env.KIWI_DAILY_BUDGET) || 1500);
const MEMO_TTL_MS = 24 * 3_600_000;
const MEMO_MAX = 500;
/** How long a 403 or 429 keeps live searches from leaving this process. */
const THROTTLE_MS = 5 * 60_000;
/** What a caller sees when the budget or Kiwi's own throttle stops a search. Plain, for the chat. */
export const THROTTLED_MESSAGE = "Kiwi is throttling searches from this address; live prices are rate-limited right now, try again in a few minutes";
export const BUDGET_MESSAGE = "live prices are rate-limited today, showing stored results";

let active = 0;
/** The start time reserved for the most recent search; the next one starts GAP_MS later. */
let lastStart = 0;
const queue: (() => void)[] = [];
let dayKey = "";
let dayCount = 0;
let dayFailed = 0;
let dayRefused = 0;
/** Epoch ms until which the breaker is open (0 when closed), and how many searches it held back today. */
let throttledUntil = 0;
let dayThrottled = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rolls the daily counters over at midnight UTC. */
function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
    dayFailed = 0;
    dayRefused = 0;
    dayThrottled = 0;
  }
}

/** True while the breaker is open: Kiwi said 403 or 429 less than THROTTLE_MS ago. */
export function kiwiThrottled(): boolean {
  return Date.now() < throttledUntil;
}

/** Opens the breaker. Logged once per opening, not once per refused search. */
function tripBreaker(status: number): void {
  const until = Date.now() + THROTTLE_MS;
  if (!kiwiThrottled()) console.log(`kiwi: ${status} from Kiwi; no live searches for ${THROTTLE_MS / 60_000} minutes (until ${new Date(until).toISOString()})`);
  throttledUntil = until;
}

async function acquire(): Promise<void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
  // Reserve the slot before sleeping: every caller that wakes in the same tick would read the
  // same lastStart and start together otherwise. Reserving serialises the start times.
  const nextStart = Math.max(Date.now(), lastStart + GAP_MS);
  lastStart = nextStart;
  const wait = nextStart - Date.now();
  if (wait > 0) await sleep(wait);
}

function release(): void {
  active--;
  queue.shift()?.();
}

function countOne(failed: boolean): void {
  rollDay();
  dayCount++;
  if (failed) dayFailed++;
  const mark = LOG_AT.includes(dayCount) || (dayCount > 2000 && dayCount % 500 === 0);
  if (mark) console.log(`kiwi: ${dayCount} searches today (${dayFailed} failed); the public server throttles an address after a couple of thousand`);
}

/** True when this process has spent its daily budget of live searches. */
export function kiwiBudgetSpent(): boolean {
  rollDay();
  return dayCount >= DAILY_BUDGET;
}

/** How busy the gate is, for logs and health checks. Counts reset at midnight UTC. */
export function kiwiStats(): { active: number; waiting: number; today: number; failedToday: number; refusedToday: number; throttledToday: number; budget: number; budgetSpent: boolean; throttledUntil: string | null; memo: number } {
  rollDay();
  return { active, waiting: queue.length, today: dayCount, failedToday: dayFailed, refusedToday: dayRefused, throttledToday: dayThrottled, budget: DAILY_BUDGET, budgetSpent: dayCount >= DAILY_BUDGET, throttledUntil: kiwiThrottled() ? new Date(throttledUntil).toISOString() : null, memo: memo.size };
}

// ---------------------------------------------------------------------------------------
// The session and the raw call.

let session: string | null = null;
let rpcId = 0;

/** How long one request may take before it counts as Kiwi shedding load (a 503 in effect). */
const REQUEST_TIMEOUT_MS = 30_000;

async function post(body: unknown): Promise<{ status: number; sid: string | null; events: Record<string, unknown>[] }> {
  let res: Response;
  try {
    // A connection Kiwi accepts and never answers would otherwise hold a gate slot and the
    // shared in-flight promise until the function is killed; a timeout is treated as a 503.
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: session ? { ...HEADERS, "mcp-session-id": session } : HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return { status: 503, sid: null, events: [] };
    throw err;
  }
  const sid = res.headers.get("mcp-session-id");
  const text = await res.text();
  const events: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      events.push(JSON.parse(line.slice(5)));
    } catch {
      // keep-alive or partial line
    }
  }
  return { status: res.status, sid, events };
}

async function ensureSession() {
  if (session) return;
  const id = ++rpcId;
  const init = await post({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "atlas", version: "0.1" } },
  });
  if (init.status === 403 || init.status === 429) {
    tripBreaker(init.status);
    throw new Error(THROTTLED_MESSAGE);
  }
  if (init.status !== 200) throw new Error(`kiwi mcp initialize ${init.status}`);
  session = init.sid;
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** dd/mm/yyyy for the Kiwi tool from an ISO date. */
export function kiwiDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

async function searchOnce(args: SearchArgs, attempt = 0): Promise<KiwiResult> {
  // A search that was queued behind the gate when the breaker opened must not go out either.
  if (kiwiThrottled()) throw new Error(THROTTLED_MESSAGE);
  try {
    await ensureSession();
  } catch (err) {
    // A throttled handshake opened the breaker: say so now, no retries against a blocked address.
    if (kiwiThrottled()) throw err;
    // The server sheds load with 503s now and then; wait and try again, three times.
    if (attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return searchOnce(args, attempt + 1);
    }
    throw err;
  }
  const id = ++rpcId;
  const r = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "search-flight", arguments: { adults: 1, currency: "EUR", ...args } } });
  if (r.status === 404 || r.status === 400) {
    // Usually an expired session: start over with a fresh one. Counted as an attempt and
    // paced, so a server that keeps answering 400 (a rejected argument, a session it refuses
    // after a deploy) ends in an error instead of an endless initialise-and-retry loop.
    session = null;
    if (attempt < 3) {
      await sleep(1000 * (attempt + 1));
      return searchOnce(args, attempt + 1);
    }
    throw new Error(`kiwi mcp: ${r.status}`);
  }
  // 429 and 403: the address is being throttled (403 is what it sends after a couple of
  // thousand searches in a day). Open the breaker at once and say so; retrying a throttled
  // address only lengthens the block, and the breaker holds every other search for five minutes.
  if (r.status === 429 || r.status === 403) {
    tripBreaker(r.status);
    throw new Error(THROTTLED_MESSAGE);
  }
  // 503: load shedding. Back off and retry three times.
  if (r.status === 503) {
    if (attempt < 3) {
      await sleep(2000 * (attempt + 1));
      return searchOnce(args, attempt + 1);
    }
    throw new Error("kiwi mcp: 503");
  }
  const reply = r.events.find((e) => e.id === id) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } } | undefined;
  if (!reply) {
    if (attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return searchOnce(args, attempt + 1);
    }
    throw new Error("kiwi mcp: no reply");
  }
  if (reply.error) throw new Error(`kiwi mcp: ${reply.error.message}`);
  const text = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (reply.result?.isError) throw new Error(`kiwi mcp: ${text.slice(0, 200)}`);
  let parsed: KiwiResult;
  try {
    parsed = JSON.parse(text) as KiwiResult;
  } catch {
    throw new Error(`kiwi mcp: unexpected answer: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.itineraries)) parsed.itineraries = [];
  // Every fare anyone sees goes into the shared history, without slowing the answer.
  if (parsed.itineraries.length) {
    import("./db")
      .then((db) => db.recordFares(parsed.itineraries))
      .catch(() => null);
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------
// The public entry: memo, shared in-flight promise, then the gate.

const memo = new TtlLru<KiwiResult>(MEMO_MAX, MEMO_TTL_MS);
const inflight = new InFlight<KiwiResult>();

/**
 * The memo key: the same search written two ways (case, spacing, defaults) is the same key.
 * flyTo is often a place name ("San Francisco", "united  states"), so it is trimmed, lower
 * cased and its whitespace collapsed; flyFrom is a code list, upper cased.
 */
function keyOf(args: SearchArgs): string {
  return JSON.stringify({
    f: args.flyFrom.trim().toUpperCase().replace(/\s+/g, ""),
    t: args.flyTo.trim().toLowerCase().replace(/\s+/g, " "),
    d: args.departureDate,
    dt: args.departureDateTo ?? "",
    df: args.departureDateFlexDays ?? 0,
    r: args.returnDate ?? "",
    rt: args.returnDateTo ?? "",
    rf: args.returnDateFlexDays ?? 0,
    a: args.adults ?? 1,
    c: args.currency ?? "EUR",
  });
}

/**
 * One Kiwi search. Memoised for a day per exact arguments; identical concurrent calls share
 * one request; at most MAX_CONCURRENT run at once. Throws on a failed search (never memoised)
 * and, past the daily budget, before the search is even sent (BUDGET_MESSAGE); memo hits
 * never count against the budget. While the breaker is open (a 403 or 429 in the last five
 * minutes) it throws THROTTLED_MESSAGE at once, and nothing leaves the process.
 */
export async function searchFlight(args: SearchArgs): Promise<KiwiResult> {
  const key = keyOf(args);
  const hit = memo.get(key);
  if (hit) return hit;
  if (kiwiThrottled()) {
    rollDay();
    dayThrottled++;
    throw new Error(THROTTLED_MESSAGE);
  }
  if (kiwiBudgetSpent()) {
    dayRefused++;
    if (dayRefused === 1 || dayRefused % 100 === 0) console.log(`kiwi: daily budget of ${DAILY_BUDGET} spent; ${dayRefused} searches refused today`);
    throw new Error(BUDGET_MESSAGE);
  }
  const { promise } = inflight.run(key, async () => {
    await acquire();
    try {
      const r = await searchOnce(args);
      countOne(false);
      memo.set(key, r);
      return r;
    } catch (err) {
      // A search that was queued behind the gate when the breaker opened never left the
      // process: it is held back, not sent and failed, so it must not burn the daily budget.
      if (err instanceof Error && err.message === THROTTLED_MESSAGE) {
        rollDay();
        dayThrottled++;
      } else {
        countOne(true);
      }
      throw err;
    } finally {
      release();
    }
  });
  return promise;
}

/** Nights between the outbound departure and the inbound departure. */
export function nightsOf(it: KiwiItinerary): number | null {
  if (!it.inbound) return null;
  return Math.round((Date.parse(it.inbound.departureTime.slice(0, 10)) - Date.parse(it.outbound.departureTime.slice(0, 10))) / 86_400_000);
}
