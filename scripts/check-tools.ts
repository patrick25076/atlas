// The chat tools, checked one by one: builds the tools for the Brasov context (GHV, SBZ, OTP,
// home RO, the origin at 45.657/25.601, today) and calls every tool with one realistic input,
// stored or memoised paths wherever possible and the smallest live input otherwise, then
// prints a table (tool, ms, ok or the error, Kiwi searches spent, source, the note) and
// exits non-zero when any tool answered { error } for a valid input, threw, or answered
// nothing at all. A tool that returns a plain note (live prices off, nothing stored) is fine:
// that is the behaviour under test. Live searches are capped at LIVE_CAP for the whole run;
// a live tool whose estimate would cross the cap is skipped and the table says so.
//
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/check-tools.ts
// Flags: --long-stay prices one long stay live (about 16 searches); --live-cap=N changes the cap.
// Then the unit cases: parseDay on the words the model writes (never 1 January next year), a
// tool called with the turn's budget already spent (no search may leave), a search asked
// twice in one process (the second is a memo hit: searched 0, source memo), the parameters
// the tools hand their engines (read through AgentContext.trace, which stops the tool before
// any search leaves: the deadlines, the route budget, region custom for a countries list),
// a dated route whose window would start in the past, and a long stay refused in a sentence.
//
// Three more sections, zero Kiwi searches each, run first:
//   command    parseCommand (lib/command.ts) on a table of typed lines, against a fixed today;
//   dispatch   the details the chat sends on the UI bus (atlas:route-result, atlas:itinerary,
//              atlas:command, atlas:route), built from real converters on fixed inputs;
//   itinerary  make_itinerary: a two-stop list (the model, or with --itin-stub the engine's
//              no-model path that builds the days from the guides), nothing to plan from,
//              last_route replayed from a thread's history, and an unknown place.
//   walk       walk_trips (the graph walk): its parameters through the trace, the budget-0 path
//              (the turn's budget spent: no search may leave, the fare memory still answers),
//              the progress it streams, what the model reads, cheapest_way at budget 0, and one
//              live walk of at most --walk-live=N searches (default 2, never past --live-cap).
//   prefs      the trip style (lib/prefs.ts) as the chat reads it: the clamps of chatPrefs, the
//              system prompt's line, and the defaults reaching walk_trips, wild_trip (the walk
//              engine by default, classic on request), cheapest_way, group_trip and
//              find_getaways, all through the trace or a spent budget: zero Kiwi searches.
//   owner      the owner's conversation of 2026-10-12, case by case: way_home over a window (the budget spent, a
//              town, an unknown place), his own flight kept in a walk through Torun (fixedOut, a town without an
//              airport), a city passed as an event kind and event words kept as kinds, one web search for three
//              cities, price_insight like with like and two prices in one turn, dates read from web text (ranges,
//              26.10.), an itinerary through Torun priced with a remembered way home, the walk's params for the map, no
//              Kaliningrad from Sopot, the prompt's way-home rule. Zero Kiwi searches.
// --only=command,dispatch,itinerary,walk,prefs,owner runs just those; --only=tools just the live table.
import { atlasTools, chatContext, chatPrefs, chatSystem, dateInText, parseDay, rememberOutput, UNIQUE_WISHES, type AgentContext } from "../lib/agent-tools";
import type { Prefs } from "../lib/prefs";
import { parseCommand, type Command } from "../lib/command";
import { WALK_PARAM_KEYS, walkQueryString, type WalkQuery } from "../lib/ui-types";
import { eventCommand, eventRoute, eventTripDays, routeDetail, routeResultDetail, walkCommandQuery, walkResultDetail, walkWindow, type ChatEvent } from "../lib/chat-widgets";
import { skeletonFromDeal, skeletonFromRoute, skeletonFromWalk, type Itinerary } from "../lib/itinerary";
import type { WalkLoop, WalkResult } from "../lib/graph-walk";
import type { RouteResult } from "../lib/route-finder";
import type { Deal } from "../lib/types";
import { kiwiStats, kiwiThrottled } from "../lib/kiwi";
import { readJson } from "../lib/boards-store";
import { wildPath, type WildTrip } from "../lib/wild";
import { planPath, type Plan } from "../lib/plan";
import { neighboursOf } from "../lib/combos";
import { mainGateway } from "../lib/board";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
// "--live-cap=0" is a real value (skip every live tool), so the default applies only when the flag is absent or not a number.
const capArg = args.find((a) => a.startsWith("--live-cap="))?.split("=")[1];
const LIVE_CAP = capArg != null && Number.isFinite(Number(capArg)) ? Math.max(0, Number(capArg)) : 12;

const ISO = (d: Date) => d.toISOString().slice(0, 10);
const today = ISO(new Date());
const plus = (n: number) => ISO(new Date(Date.now() + n * 86_400_000));
const nextMonth = (() => {
  const d = new Date();
  return `${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7)}`;
})();

const ctx: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 0, max: 120 } };
// The AI SDK types each tool's execute precisely; the harness only needs "callable with an input".
type Tools = Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
// A tools instance is one chat turn, with its own clock (270 s): the parameter cases below
// are run on a fresh instance, because the live checks before them can take minutes.
let tools = atlasTools(ctx) as unknown as Tools;

type Row = { tool: string; ms: number; status: string; kiwi: number; source: string; note: string };
const rows: Row[] = [];
let failures = 0;
/** Kiwi searches this process sent so far (memo hits do not count; refused ones do). */
const sent = () => kiwiStats().today;
/** A tool's answer: a streaming tool (walk_trips) is an async generator whose last yield is the answer and whose
 * earlier yields are progress ({ running: true, progress }); `seen` collects those. Anything else is awaited as is. */
async function drain(r: unknown, seen?: unknown[]): Promise<unknown> {
  if (!r || typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") return r;
  let last: unknown;
  for await (const item of r as AsyncIterable<unknown>) {
    if (item && typeof item === "object" && (item as { running?: unknown }).running === true) seen?.push(item);
    else last = item;
  }
  return last;
}

/** Calls one tool and records the row; returns the answer so a case can look at its fields
 * (undefined when the tool was skipped or missing). `edge` rows test odd inputs: a note or an
 * error is fine there, a throw or nothing is not. */
async function check(name: string, input: unknown, opts: { edge?: boolean; estimate?: number; skip?: string; label?: string } = {}): Promise<Record<string, unknown> | undefined> {
  const t = tools[name];
  const label = opts.label ?? name;
  if (!t?.execute) {
    rows.push({ tool: label, ms: 0, status: "missing (not registered in this environment)", kiwi: 0, source: "", note: "" });
    failures++;
    return undefined;
  }
  if (opts.skip) {
    rows.push({ tool: label, ms: 0, status: `skipped: ${opts.skip}`, kiwi: 0, source: "", note: "" });
    return undefined;
  }
  const est = opts.estimate ?? 0;
  if (est > 0 && sent() + est > LIVE_CAP && !kiwiThrottled()) {
    rows.push({ tool: label, ms: 0, status: `skipped: would spend ~${est} live searches, ${LIVE_CAP - sent()} left under the cap`, kiwi: 0, source: "", note: "" });
    return undefined;
  }
  const before = sent();
  const t0 = Date.now();
  let status = "ok";
  let source = "";
  let note = "";
  let answer: Record<string, unknown> | undefined;
  try {
    const r = (await drain(await t.execute(input, { toolCallId: `check-${name}`, messages: [] }))) as Record<string, unknown> | null | undefined;
    if (r && typeof r === "object") answer = r;
    if (r == null || typeof r !== "object") {
      status = `FAIL: answered ${String(r)}`;
      failures++;
    } else {
      const undef = Object.entries(r).filter(([, v]) => v === undefined).map(([k]) => k);
      source = typeof r.source === "string" ? r.source : "";
      note = typeof r.note === "string" ? r.note : "";
      if (typeof r.error === "string") {
        status = opts.edge ? `error (edge input): ${r.error}` : `FAIL: { error: ${r.error} }`;
        if (!opts.edge) failures++;
      } else if (!Object.keys(r).length) {
        status = "FAIL: empty object";
        failures++;
      } else if (undef.length) {
        status = `FAIL: undefined fields ${undef.join(", ")}`;
        failures++;
      } else if (opts.edge && !note) {
        status = "FAIL: edge input answered without a note";
        failures++;
      } else {
        const n = typeof r.count === "number" ? r.count : typeof r.found === "number" ? r.found : Array.isArray(r.options) ? r.options.length : Array.isArray(r.bases) ? r.bases.length : Array.isArray(r.months) ? r.months.length : Array.isArray(r.deals) ? r.deals.length : Array.isArray(r.itineraries) ? r.itineraries.length : Array.isArray(r.fares) ? r.fares.length : Array.isArray(r.events) ? r.events.length : Array.isArray(r.towns) ? r.towns.length : Array.isArray(r.places) ? r.places.length : Array.isArray(r.hotels) ? r.hotels.length : Array.isArray(r.results) ? r.results.length : Array.isArray(r.combos) ? r.combos.length : Array.isArray(r.legs) ? r.legs.length : null;
        status = `ok${n != null ? ` (${n})` : ""}${note && !n ? " with a note" : ""}`;
      }
    }
  } catch (err) {
    status = `FAIL: threw ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`;
    failures++;
  }
  rows.push({ tool: label, ms: Date.now() - t0, status, kiwi: sent() - before, source, note: note.slice(0, 90) });
  process.stdout.write(`  ${label.padEnd(28)} ${status.slice(0, 70)}\n`);
  return answer;
}

/** A row the harness judged itself (a field of an answer, a parameter read through the trace). */
function verdict(label: string, ok: boolean, detail: string, kiwi = 0) {
  if (!ok) failures++;
  rows.push({ tool: label.slice(0, 28), ms: 0, status: ok ? `ok (${detail})` : `FAIL: ${detail}`, kiwi, source: "", note: "" });
  process.stdout.write(`  ${label.padEnd(28)} ${ok ? "ok" : "FAIL"} ${detail.slice(0, 66)}\n`);
}

/** The parameters a tool hands its engine, without the engine running: the trace hook records
 * them and throws, which the tool's safe() wrapper turns into { error }; no search leaves. */
async function dry(name: string, input: unknown): Promise<{ engine: string; params: Record<string, unknown>; leaked: number } | null> {
  // A holder, not a bare variable: the hook assigns it inside a closure, which the type
  // checker does not follow.
  const seen: { got: { engine: string; params: Record<string, unknown> } | null } = { got: null };
  const before = sent();
  ctx.trace = (engine, params) => {
    seen.got = { engine, params };
    throw new Error("harness: parameters read, the engine was not called");
  };
  try {
    await drain(await tools[name]?.execute?.(input, { toolCallId: `dry-${name}`, messages: [] }));
  } catch {
    // safe() never throws; a throw here would be a tool outside it, and the verdict says so
  } finally {
    ctx.trace = undefined;
  }
  return seen.got ? { ...seen.got, leaked: sent() - before } : null;
}
/** The engines' deadlines as the tools compute them (lib/agent-tools.ts reads the same env). */
const WILD_BUILD_MS = Math.max(30_000, Number(process.env.WILD_BUILD_MS) || 170_000);
const LONG_BUILD_MS = Math.max(30_000, Number(process.env.LONG_BUILD_MS) || 150_000);
const DEADLINE_MARGIN_MS = 10_000;
/** True when `at` (epoch ms) is within five seconds of `want`. */
const near = (at: unknown, want: number) => typeof at === "number" && Math.abs(at - want) < 5_000;

const only = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",").map((x) => x.trim()) ?? null;
const want = (section: string) => !only || only.includes(section);

/** The whole table and the verdict; exits non-zero when anything failed. */
function report(): never {
  console.log("");
  const w = { tool: 28, ms: 7, status: 62, kiwi: 5, source: 8 };
  console.log(`${"tool".padEnd(w.tool)} ${"ms".padStart(w.ms)} ${"status".padEnd(w.status)} ${"kiwi".padStart(w.kiwi)} ${"source".padEnd(w.source)} note`);
  for (const r of rows) console.log(`${r.tool.padEnd(w.tool)} ${String(r.ms).padStart(w.ms)} ${r.status.slice(0, w.status).padEnd(w.status)} ${String(r.kiwi).padStart(w.kiwi)} ${r.source.padEnd(w.source)} ${r.note}`);
  const st = kiwiStats();
  console.log("");
  console.log(`${rows.length} tools, ${failures} failed; Kiwi searches sent this run: ${st.today} (${st.failedToday} failed, ${st.throttledToday} held by the breaker); turn budget used: ${ctx.budget!.used}; breaker ${st.throttledUntil ? `open until ${st.throttledUntil}` : "closed"}`);
  process.exit(failures ? 1 : 0);
}

// ---------------------------------------------------------------------------------------
// command: the command line, pure. Each case is a typed line and the fields its FIRST
// suggestion must have (anything not named is free); every list must end with an ask.
if (want("command")) {
  console.log("parseCommand (today 2026-10-10, a Saturday):");
  const T = "2026-10-10";
  type Want = Partial<Record<string, unknown>> & { kind: Command["kind"] };
  // An optional third field is the day the line is typed on (default T).
  const cases: [string, Want, string?][] = [
    ["Brasov to Lisbon", { kind: "route", from: "Brasov", to: "Lisbon" }],
    ["to Lisbon 14 Nov 4 nights", { kind: "route", from: undefined, to: "Lisbon", depart: "2026-11-14", nights: 4 }],
    ["Bucharest -> Rome one way", { kind: "route", from: "Bucharest", to: "Rome", oneWay: true, nights: undefined }],
    ["lisbon in november", { kind: "getaways", where: "Lisbon", from: "2026-11-01", to: "2026-11-30" }],
    ["events in february", { kind: "events", from: "2027-02-01", to: "2027-02-28" }],
    ["carnival", { kind: "events", words: ["carnival"] }],
    ["jazz festivals in march", { kind: "events", words: ["jazz", "festival"], from: "2027-03-01", to: "2027-03-31" }],
    ["getaways under 3h this weekend", { kind: "getaways", from: "2026-10-10", to: "2026-10-11", maxHours: 3 }],
    ["/route", { kind: "route", to: "" }],
    ["/events", { kind: "events", from: undefined, words: undefined }],
    ["/wild sea 21", { kind: "wild", region: "sea", nights: 21 }],
    ["/stay thailand 2 months", { kind: "longstay", countries: ["Thailand"], months: 2 }],
    ["/place Porto", { kind: "place", name: "Porto" }],
    ["/itinerary", { kind: "itinerary", stops: undefined }],
    ["Brasov to Lisbon 2026-11-14", { kind: "route", from: "Brasov", to: "Lisbon", depart: "2026-11-14" }],
    ["Cluj to Paris next friday", { kind: "route", from: "Cluj", to: "Paris", depart: "2026-10-16" }],
    ["to Vienna 14/11 for a week", { kind: "route", to: "Vienna", depart: "2026-11-14", nights: 7 }],
    ["Bucharest → Barcelona 14 to 18 Nov", { kind: "route", from: "Bucharest", to: "Barcelona", depart: "2026-11-14", nights: 4 }],
    ["Brasov to Lisbon 20 Dec to 3 Jan", { kind: "route", depart: "2026-12-20", nights: 14 }],
    ["how do I get from Brasov to Vienna", { kind: "route", from: "Brasov", to: "Vienna" }],
    ["cheapest way to Lisbon", { kind: "route", from: undefined, to: "Lisbon" }],
    ["Brasov - Budapest this weekend", { kind: "route", from: "Brasov", to: "Budapest", depart: "2026-10-10", nights: 1 }],
    ["OTP to LIS 2 weeks", { kind: "route", from: "OTP", to: "LIS", nights: 14 }],
    ["Brasov to Lisbon flex 3", { kind: "route", flex: 3 }],
    ["trip to Japan for 2 weeks", { kind: "route", to: "Japan", nights: 14 }],
    ["Rome", { kind: "place", name: "Rome" }],
    ["porto", { kind: "place", name: "Porto" }],
    ["new york", { kind: "place", name: "New York" }],
    ["is Porto nice in October", { kind: "ask", text: "is Porto nice in October" }],
    ["tell me about Porto", { kind: "ask" }],
    ["what's on in Lisbon in november", { kind: "events", where: "Lisbon", from: "2026-11-01", to: "2026-11-30" }],
    ["oktoberfest", { kind: "events", words: ["oktoberfest"] }],
    ["marathons in april", { kind: "events", words: ["marathon"], from: "2027-04-01", to: "2027-04-30" }],
    ["christmas markets in december", { kind: "events", words: ["christmas market"], from: "2026-12-01", to: "2026-12-31" }],
    ["northern lights", { kind: "events", words: ["northern lights"] }],
    ["festivals in Spain in june", { kind: "events", words: ["festival"], where: "Spain", from: "2027-06-01" }],
    ["/wild southeast asia 3 weeks", { kind: "wild", region: "sea", nights: 21 }],
    ["Balkans loop 10 nights", { kind: "wild", region: "balkans", nights: 10 }],
    ["/wild vietnam, laos 18", { kind: "wild", countries: ["Vietnam", "Laos"], nights: 18 }],
    ["2 months in Bali", { kind: "longstay", countries: ["Bali"], months: 2 }],
    ["/stay sea 3", { kind: "longstay", region: "sea", months: 3 }],
    ["itinerary Lisbon 3 nights from 2026-11-14", { kind: "itinerary", stops: [{ place: "Lisbon", nights: 3 }], start: "2026-11-14" }],
    ["itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov", { kind: "itinerary", stops: [{ place: "Lisbon", nights: 3 }, { place: "Porto", nights: 2 }], start: "2026-11-14" }],
    ["plan my days: 2 nights in Rome then Florence 3", { kind: "itinerary", stops: [{ place: "Rome", nights: 2 }, { place: "Florence", nights: 3 }] }],
    ["/itinerary Porto 2 from Brasov on 1 Dec", { kind: "itinerary", stops: [{ place: "Porto", nights: 2 }], start: "2026-12-01", from: "Brasov" }],
    ["weekend in Rome", { kind: "getaways", where: "Rome", minNights: 2, maxNights: 3 }],
    ["anywhere warm in december", { kind: "getaways", where: undefined, from: "2026-12-01", to: "2026-12-31" }],
    ["getaways under €100 next weekend", { kind: "getaways", maxPrice: 100, from: "2026-10-16", to: "2026-10-18" }],
    ["somewhere this weekend", { kind: "getaways", from: "2026-10-10", to: "2026-10-11" }],
    ["14 Nov", { kind: "getaways", from: "2026-11-14" }],
    ["next month", { kind: "getaways", from: "2026-11-01", to: "2026-11-30" }],
    ["Lisbon early december", { kind: "getaways", where: "Lisbon", from: "2026-12-01", to: "2026-12-10" }],
    ["/route Brasov to Lisbon 4 nights", { kind: "route", from: "Brasov", to: "Lisbon", nights: 4 }],
    ["/ask is it cold in Oslo", { kind: "ask", text: "is it cold in Oslo" }],
    ["", { kind: "ask" }],
    // Weekday ranges end on the first such weekday after the start, never a year on.
    ["friday to sunday", { kind: "getaways", from: "2026-10-16", to: "2026-10-18" }],
    ["Rome friday to sunday", { kind: "getaways", where: "Rome", from: "2026-10-16", to: "2026-10-18" }],
    ["friday to sunday in Rome", { kind: "getaways", where: "Rome", from: "2026-10-16", to: "2026-10-18" }],
    ["between march and june", { kind: "getaways", from: "2027-03-01", to: "2027-06-30" }],
    // "this friday" said on a Friday is today; "next friday" is a week on.
    ["fly from Vienna to Rome on friday", { kind: "route", from: "Vienna", to: "Rome", depart: "2026-10-16" }, "2026-10-16"],
    ["Paris this friday", { kind: "getaways", where: "Paris", from: "2026-10-16" }, "2026-10-16"],
    ["friday to sunday", { kind: "getaways", from: "2026-10-16", to: "2026-10-18" }, "2026-10-16"],
    ["Cluj to Paris next friday", { kind: "route", depart: "2026-10-23" }, "2026-10-16"],
    // Words after the destination are not part of its name.
    ["Lisbon to Porto by train", { kind: "route", from: "Lisbon", to: "Porto" }],
    ["Brasov to Lisbon and back", { kind: "route", from: "Brasov", to: "Lisbon" }],
    ["Brasov to Lisbon on 14 Nov flexible", { kind: "route", to: "Lisbon", depart: "2026-11-14", flex: 3 }],
    ["Rome to Paris to London", { kind: "route", from: "Rome", to: "Paris" }],
    ["Lisbon 4 nights from Brasov", { kind: "route", from: "Brasov", to: "Lisbon", nights: 4 }],
    // A list of stays is an itinerary without the word.
    ["Lisbon 3 nights, Porto 2 nights from 14 Nov", { kind: "itinerary", stops: [{ place: "Lisbon", nights: 3 }, { place: "Porto", nights: 2 }], start: "2026-11-14" }],
    ["Lisbon 3 nights then Porto 2 nights", { kind: "itinerary", stops: [{ place: "Lisbon", nights: 3 }, { place: "Porto", nights: 2 }] }],
    ["Porto 2 from Brasov on 1 Dec", { kind: "itinerary", stops: [{ place: "Porto", nights: 2 }], start: "2026-12-01", from: "Brasov" }],
    ["itinerary from Brasov: Lisbon 3 nights, Porto 2 nights", { kind: "itinerary", stops: [{ place: "Lisbon", nights: 3 }, { place: "Porto", nights: 2 }], from: "Brasov" }],
    ["itinerary Rome 2 nights, Florence 2 days, Venice a week", { kind: "itinerary", stops: [{ place: "Rome", nights: 2 }, { place: "Florence", nights: 1 }, { place: "Venice", nights: 7 }] }],
    // A bare name keeps one way and a price cap; holidays are events, not places.
    ["Lisbon 14 Nov 4 nights one way", { kind: "route", to: "Lisbon", oneWay: true, depart: "2026-11-14" }],
    ["Lisbon under 100", { kind: "getaways", where: "Lisbon", maxPrice: 100 }],
    ["Christmas in Vienna", { kind: "events", where: "Vienna", words: ["christmas"] }],
    ["Easter in Seville", { kind: "events", where: "Seville", words: ["easter"] }],
    ["new year in Berlin", { kind: "events", where: "Berlin", words: ["new year"] }],
    // Walks: a loop of cheap hops (lib/graph-walk.ts), the way the owner searches with Skyscanner Explore.
    ["loop from Brasov 20-30 Oct 6 days", { kind: "walk", origin: "Brasov", from: "2026-10-20", to: "2026-10-30", minNights: 5, maxNights: 6 }],
    ["loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop", { kind: "walk", origin: "Brasov", from: "2026-10-20", to: "2026-10-30", minNights: 5, maxNights: 6, nightsPerStop: 2 }],
    ["3 cities in 6 days", { kind: "walk", from: undefined, maxStops: 3, minNights: 5, maxNights: 6 }],
    ["Brasov to Warsaw then train then home", { kind: "walk", origin: "Brasov", mustInclude: ["Warsaw"] }],
    ["cheap unique loop next month not germany", { kind: "walk", from: "2026-11-01", to: "2026-11-30", style: "unique", avoid: ["Germany"] }],
    ["Brasov to Warsaw by plane, Warsaw to Gdansk by train, then another city and back to Brasov or Bucharest, 6 days, cheapest but unique, not Germany", { kind: "walk", origin: "Brasov", mustInclude: ["Warsaw", "Gdansk"], minNights: 5, maxNights: 6, style: "unique", avoid: ["Germany"] }],
    ["a loop, 2 nights a stop, nothing like germany", { kind: "walk", nightsPerStop: 2, avoid: ["like:DE"] }],
    ["I don't like countries like Germany, a loop in november", { kind: "walk", from: "2026-11-01", to: "2026-11-30", avoid: ["like:DE"] }],
    ["loop from Cluj, 3 cities, 2-3 nights each", { kind: "walk", origin: "Cluj", maxStops: 3, nightsPerStop: [2, 3] }],
    ["city hopping in december, 8 nights, 4 stops", { kind: "walk", from: "2026-12-01", to: "2026-12-31", minNights: 8, maxNights: 8, maxStops: 4 }],
    ["plane then train then home from Bucharest in november", { kind: "walk", origin: "Bucharest", from: "2026-11-01" }],
    ["loop 6 days, not Germany or Austria, hidden gems", { kind: "walk", minNights: 5, maxNights: 6, style: "unique", avoid: ["Germany", "Austria"] }],
    ["2 cities 4 nights not touristy", { kind: "walk", maxStops: 2, minNights: 4, maxNights: 4, style: "unique" }],
    ["/loop Brasov 6 days", { kind: "walk", origin: "Brasov", minNights: 5, maxNights: 6 }],
    ["/walk from Brasov 20 to 30 Oct", { kind: "walk", origin: "Brasov", from: "2026-10-20", to: "2026-10-30" }],
    ["loop from Brasov 2 weeks, no night flights", { kind: "walk", origin: "Brasov", minNights: 14, avoid: undefined }],
    // The owner's own chain, as he wrote it: an A-B pair is two places, the first place starts the loop, the
    // ways home ("back to Brasov or Sibiu or Otopeni") are no stops.
    ["Brasov-Warsaw plane, then Warsaw-Gdansk train, then Gdansk to another city and that back to Brasov or Sibiu or Otopeni", { kind: "walk", origin: "Brasov", mustInclude: ["Warsaw", "Gdansk"] }],
    ["I would have done Brasov-Warsaw plane, then Warsaw-Gdansk train, then Gdansk to another city and that back to Brasov or Sibiu or Otopeni", { kind: "walk", origin: "Brasov", mustInclude: ["Warsaw", "Gdansk"] }],
    ["Brasov - Warsaw plane, then Warsaw - Gdansk train, then back home", { kind: "walk", origin: "Brasov", mustInclude: ["Warsaw", "Gdansk"] }],
    // A chain that begins with a hop starts where the traveller is: Warsaw is a stop, never the start.
    ["fly to Warsaw then train to Gdansk then home", { kind: "walk", origin: undefined, mustInclude: ["Warsaw", "Gdansk"] }],
    ["Warsaw by plane then train to Gdansk then home", { kind: "walk", origin: undefined, mustInclude: ["Warsaw", "Gdansk"] }],
    ["Cluj-Napoca to Warsaw then train to Gdansk then home", { kind: "walk", origin: "Cluj-Napoca", mustInclude: ["Warsaw", "Gdansk"] }],
    ["go from Brasov and come back from Gdansk, 6 days", { kind: "walk", origin: "Brasov", mustInclude: ["Gdansk"], minNights: 5, maxNights: 6 }],
    ["loop from Bucharest 6 days with Krakow", { kind: "walk", origin: "Bucharest", mustInclude: ["Krakow"] }],
    ["multi city trip Warsaw and Gdansk 6 days", { kind: "walk", origin: undefined, mustInclude: ["Warsaw", "Gdansk"] }],
    ["loop with my partner 6 days", { kind: "walk", mustInclude: undefined }],
    // Avoid words the walk can resolve: a way to travel is none, "via X" is X, a group word loses its "countries".
    ["loop from Brasov next week 5 nights, not by plane", { kind: "walk", origin: "Brasov", avoid: undefined }],
    ["loop from Brasov 6 days not via Munich", { kind: "walk", avoid: ["Munich"] }],
    ["a few cities, avoid the dach countries", { kind: "walk", maxStops: 3, avoid: ["dach"] }],
    ["loop from Brasov 6 days not the balkans", { kind: "walk", avoid: ["balkans"] }],
    // "through" a European country for a week is a walk kept to it; weeks, or a far country, stay Wild.
    ["loop through Poland 6 days", { kind: "walk", countries: ["Poland"], minNights: 5, maxNights: 6 }],
    ["loop through Poland 3 weeks", { kind: "wild", countries: ["Poland"], nights: 21 }],
    // What stays what it was: a far region or weeks overland is Wild, "then back" is a return, a list of stays an itinerary.
    ["/loop sea 21", { kind: "wild", region: "sea", nights: 21 }],
    ["loop through Vietnam 3 weeks", { kind: "wild", countries: ["Vietnam"], nights: 21 }],
    ["Brasov to Lisbon then back", { kind: "route", from: "Brasov", to: "Lisbon" }],
    // The trip style in words (lib/command.ts readTripStyle): nights a place, a cap on them, the pace, trains between
    // places, unique. Read before the stay, so "2-3 nights a place" is never the trip's own length.
    ["loop 2 weeks, 2-3 nights per place", { kind: "walk", minNights: 14, maxNights: 14, nightsPerStop: [2, 3] }],
    ["loop from Brasov 6 days, 2 to 3 days each", { kind: "walk", origin: "Brasov", minNights: 5, maxNights: 6, nightsPerStop: [2, 3] }],
    ["loop 10 nights, max 3 nights a city", { kind: "walk", minNights: 10, maxNights: 10, nightsPerStop: [2, 3] }],
    ["loop 10 nights, 2-3 days per location max", { kind: "walk", minNights: 10, nightsPerStop: [2, 3] }],
    ["loop 6 days, max 2 nights a place", { kind: "walk", nightsPerStop: 2 }],
    ["loop 8 nights, slow pace", { kind: "walk", minNights: 8, nightsPerStop: [3, 4], pace: "slow" }],
    ["loop 8 nights, 2 nights a stop, slow pace", { kind: "walk", nightsPerStop: 2, pace: "slow" }],
    // The ground limit travels in minutes (480 trains between places, 0 flights only): the shell copies it as it is.
    ["loop from Brasov 6 days, only trains between cities", { kind: "walk", origin: "Brasov", ground: 480, mustInclude: undefined }],
    ["loop 6 days, flights only", { kind: "walk", ground: 0 }],
    ["/wild balkans 14, flights only", { kind: "wild", region: "balkans", nights: 14, ground: 0 }],
    // Style words outside a loop stay part of the line: "by train only" never leaves "Vienna by", "flights only" never
    // turns the cheapest dates to Spain into a route.
    ["Brasov to Vienna by train only", { kind: "route", from: "Brasov", to: "Vienna" }],
    ["cheap flights only to Spain in november", { kind: "getaways" }],
    ["loop 6 days, unique places", { kind: "walk", style: "unique" }],
    ["/wild sea 21, 2-3 days per location max", { kind: "wild", region: "sea", nights: 21, nightsPerStop: [2, 3] }],
    ["/wild balkans 14, max 3 nights a city, unique", { kind: "wild", region: "balkans", nights: 14, nightsPerStop: [2, 3], style: "unique" }],
    ["southeast asia 3 weeks, 2-3 days per location max", { kind: "wild", region: "sea", nights: 21, nightsPerStop: [2, 3] }],
    ["two weeks in the Balkans, cheapest", { kind: "wild", region: "balkans", nights: 14, nightsPerStop: undefined }],
    // The trip style editor and the guide.
    ["/style", { kind: "prefs" }],
    ["/settings", { kind: "prefs" }],
    ["trip style", { kind: "prefs" }],
    ["/help", { kind: "help" }],
    ["help", { kind: "help" }],
    ["how does this work", { kind: "help" }],
    ["help me find a cheap weekend", { kind: "ask" }],
    // Words the command bar does not open by itself stay questions for the chat (the shell has no case for help or
    // prefs, so suggesting them would do nothing).
    ["what can you do", { kind: "ask" }],
    ["open my trip style", { kind: "ask" }],
    ["/h", { kind: "ask" }],
  ];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const [input, wantFirst, on] of cases) {
    const list = parseCommand(input, on ?? T);
    const first = list[0] as unknown as Record<string, unknown>;
    const wrong = Object.entries(wantFirst).filter(([k, v]) => !same(first?.[k], v)).map(([k, v]) => `${k} ${JSON.stringify(first?.[k]) ?? "undefined"} (wanted ${JSON.stringify(v) ?? "undefined"})`);
    const askLast = list.at(-1)?.kind === "ask" && list.filter((c) => c.kind === "ask").length === 1;
    const labelled = list.every((c) => typeof c.label === "string" && c.label.length > 0 && !c.label.includes("—"));
    const ok = !wrong.length && askLast && labelled;
    if (!ok) failures++;
    const detail = ok ? `${first.kind}: ${first.label}` : [...wrong, askLast ? "" : "the list does not end with exactly one ask", labelled ? "" : "a label is empty or has an em dash"].filter(Boolean).join("; ");
    rows.push({ tool: `cmd "${input}"`.slice(0, 28), ms: 0, status: ok ? `ok (${first.kind})` : `FAIL: ${detail}`, kiwi: 0, source: "", note: ok ? String(first.label).slice(0, 90) : "" });
    process.stdout.write(`  ${`"${input}"`.slice(0, 46).padEnd(46)} ${ok ? "ok  " : "FAIL"} ${detail.slice(0, 110)}\n`);
  }
  // The same line on the same day is the same answer (the bar re-ranks on every keystroke).
  const a1 = JSON.stringify(parseCommand("to Lisbon 14 Nov 4 nights", T));
  const a2 = JSON.stringify(parseCommand("to Lisbon 14 Nov 4 nights", T));
  verdict("command: deterministic", a1 === a2, a1 === a2 ? "same input, same suggestions" : "two runs differ");
  console.log("");
}

// ---------------------------------------------------------------------------------------
// dispatch: what the chat sends on the UI bus, from fixed inputs (no network).
if (want("dispatch")) {
  console.log("UI event details (atlas:route-result, atlas:itinerary, atlas:command, atlas:route):");
  const leg = (from: string, to: string, date: string, price: number | null, kind: "fly" | "train" = "fly") => ({ kind, from, fromName: from, to, toName: to, date, minutes: 180, price, ...(kind === "fly" ? { url: "https://www.kiwi.com/x" } : {}) });
  const opt = { kind: "direct" as const, legs: [leg("OTP", "LIS", "2026-11-14", 120)], back: [leg("LIS", "OTP", "2026-11-18", null)], backTotal: 0, total: 120, hours: 5, stops: 0, title: "Bucharest to Lisbon", why: "the cheapest", urls: ["https://www.kiwi.com/x"], score: 1, nonstop: true };
  const result: RouteResult = { from: { label: "Brașov", lat: 45.657, lon: 25.601, airports: ["OTP"] }, to: { label: "Lisbon", lat: 38.72, lon: -9.14, airports: ["LIS"] }, options: [opt, { ...opt, kind: "via-hub", title: "Via Madrid", total: 140 }], cheapest: opt, fastest: opt, searched: 1, failed: 0, considered: ["the direct fare"], sources: ["live"], generatedAt: "2026-10-10T10:00:00Z" };
  const d1 = routeResultDetail(result);
  verdict("route-result: whole result", d1.result === result && !("option" in d1), JSON.stringify({ option: (d1 as { option?: number }).option, options: d1.result.options.length }));
  const d2 = routeResultDetail(result, 1);
  verdict("route-result: one option", d2.option === 1, `option ${d2.option}`);
  verdict("route-result: bad option", !("option" in routeResultDetail(result, 7)), "an index past the list is dropped, not sent");
  const r1 = routeDetail({ from: "Brașov", to: "Lisbon", depart: "2026-11-14", flex: 2, nights: 4 });
  verdict("route: return", r1.to === "Lisbon" && r1.nights === 4 && r1.oneWay === false && r1.depart === "2026-11-14", JSON.stringify(r1));
  const r2 = routeDetail({ from: "Brașov", to: "Lisbon", depart: "2026-11-14", nights: null });
  verdict("route: one way", r2.oneWay === true && !("nights" in r2), JSON.stringify(r2));
  const sk = skeletonFromRoute(result, 0);
  verdict("itinerary: route skeleton", sk.source === "route" && sk.stops.length === 1 && sk.stops[0].nights === 4 && sk.legs.length === 2, `${sk.title}; ${sk.stops.length} stop, ${sk.legs.length} legs`);
  const deal = { gw: "OTP", dst: "LIS", dstCity: "LIS", city: "Lisbon", country: "PT", price: 120, out: "2026-11-14", back: "2026-11-18", nights: 4, stops: 0, carriers: ["W6"], outMin: 230, backMin: 240, url: "https://www.kiwi.com/x" } as Deal;
  const sd = skeletonFromDeal(deal, { name: "Brașov", lat: 45.657, lon: 25.601 });
  verdict("itinerary: deal skeleton", sd.source === "deal" && sd.stops[0].nights === 4 && sd.origin.name === "Brașov", `${sd.title}; from ${sd.origin.name}`);
  const ev: ChatEvent = { event: "Carnival of Venice", city: "Venice", code: "VCE", country: "IT", start: "2027-02-07", end: "2027-02-17", dates: "2027-02-07 to 2027-02-17" };
  const cmd = eventCommand(ev);
  const parsed = parseCommand(cmd.text, "2026-10-10")[0] as Extract<Command, { kind: "events" }>;
  verdict("command: event on the map", parsed.kind === "events" && parsed.where === "Venice" && parsed.from === "2027-02-07" && parsed.to === "2027-02-17", `${cmd.text} -> ${parsed.kind} ${parsed.where} ${parsed.from} to ${parsed.to}`);
  // A run longer than five days gets four nights (what skeletonFromEvent plans).
  const er = eventRoute(ev, "2026-10-10");
  verdict("route: get to the event", er.to === "Venice" && er.depart === "2027-02-07" && er.nights === 4, JSON.stringify(er));
  const short = eventRoute({ event: "Holi", city: "Jaipur", dates: "2027-03-03 to 2027-03-03" }, "2026-10-10");
  verdict("route: a one-day event", short.nights === 2 && short.depart === "2027-03-03", JSON.stringify(short));
  // An event already on is joined from tomorrow, never from its first day in the past.
  const fiesta: ChatEvent = { event: "Balloon Fiesta", city: "Albuquerque", start: "2026-10-03", end: "2026-10-11" };
  const on = eventRoute(fiesta, "2026-10-10");
  const onDays = eventTripDays(fiesta, "2026-10-10");
  verdict("route: an event under way", on.depart === "2026-10-11" && on.nights === 2 && onDays?.start === "2026-10-11" && onDays.end === "2026-10-11", `${JSON.stringify(on)}; trip days ${JSON.stringify(onDays)}`);
  const xmas = eventRoute({ event: "Christmas markets", city: "Vienna", start: "2026-12-01", end: "2026-12-23" }, "2026-10-10");
  verdict("route: a season", xmas.nights === 4 && xmas.depart === "2026-12-01", JSON.stringify(xmas));
  // The walk on the bus: a fixed two-stop loop (Warsaw by plane, Gdansk by train, home by plane).
  const wl = (kind: "fly" | "train" | "road", from: string, fromName: string, to: string, toName: string, date: string, price: number, minutes: number) => ({ kind, from, fromName, to, toName, date, minutes, price, source: kind === "fly" ? ("live" as const) : ("ground" as const), ...(kind === "fly" ? { url: "https://www.kiwi.com/x" } : { estimated: true }) });
  const loopA: WalkLoop = {
    id: "a",
    title: "Warsaw, Gdansk",
    stops: [
      { code: "WAW", name: "Warsaw", country: "PL", lat: 52.23, lon: 21.01, arrive: "2026-10-20", leave: "2026-10-22", nights: 2, worth: 90 },
      { code: "GDN", name: "Gdansk", country: "PL", lat: 54.35, lon: 18.65, arrive: "2026-10-22", leave: "2026-10-25", nights: 3, worth: 80 },
    ],
    legs: [wl("road", "HOME", "Brașov", "GHV", "Brasov", "2026-10-20", 3, 25), wl("fly", "GHV", "Brasov", "WMI", "Warsaw", "2026-10-20", 35, 120), wl("train", "WAW", "Warsaw", "GDN", "Gdansk", "2026-10-22", 34, 170), wl("fly", "GDN", "Gdansk", "OTP", "Bucharest", "2026-10-25", 40, 150), wl("road", "OTP", "Bucharest", "HOME", "Brașov", "2026-10-25", 17, 150)],
    home: "GHV",
    start: "2026-10-20",
    end: "2026-10-25",
    nights: 5,
    flights: 2,
    ground: 1,
    total: 129,
    hours: 12,
    score: 200,
    why: ["the cheapest flight out of Brasov in the window"],
  };
  const walkRes: WalkResult = { loops: [loopA, { ...loopA, id: "b", title: "Gdansk" }], searched: 3, failed: 0, fromMemory: 0, expanded: 4, considered: [], generatedAt: "2026-10-10T10:00:00Z" };
  const wd = walkResultDetail(walkRes);
  verdict("walk-result: whole result", wd.result === walkRes && !("params" in wd), `${wd.result.loops.length} loops, first ${wd.result.loops[0].id}`);
  const wd2 = walkResultDetail(walkRes, 1, { g: "GHV", home: "RO", lat: 45.657, lon: 25.601, label: "Brașov", from: "2026-10-20", to: "2026-10-30" });
  verdict("walk-result: loop first", wd2.result.loops[0].id === "b" && wd2.result.loops.length === 2 && wd2.params?.g === "GHV", `first ${wd2.result.loops[0].id}, params ${wd2.params?.label}`);
  verdict("walk-result: bad loop", walkResultDetail(walkRes, 9).result.loops[0].id === "a", "an index past the list keeps the order");
  const sw = skeletonFromWalk(loopA, { name: "Brașov", lat: 45.657, lon: 25.601 });
  verdict("itinerary: walk skeleton", sw.stops.length === 2 && sw.stops[0].nights === 2 && sw.start === "2026-10-20" && sw.legs.length >= 3 && sw.origin.name === "Brașov", `${sw.title}; ${sw.stops.length} stops, ${sw.legs.length} legs, ${sw.source}`);
  // The command line's walk becomes the atlas:walk query: the window defaults of walkWindow, the traveller's airports.
  const here = { lat: 45.657, lon: 25.601, label: "Brașov", gateways: ["GHV", "SBZ", "OTP"], home: "RO" };
  const wc = parseCommand("loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop, not germany", "2026-10-10")[0] as Extract<Command, { kind: "walk" }>;
  const wq = walkCommandQuery(wc, here, "2026-10-10").params;
  verdict("walk: command to query", wq.g === "GHV,SBZ,OTP" && wq.from === "2026-10-20" && wq.to === "2026-10-30" && wq.minNights === 5 && wq.maxNights === 6 && wq.nightsPerStop === "2" && wq.avoid === "Germany", JSON.stringify(wq).slice(0, 110));
  const cluj = parseCommand("loop from Cluj 3 cities", "2026-10-10")[0] as Extract<Command, { kind: "walk" }>;
  const cq = walkCommandQuery(cluj, here, "2026-10-10", (n) => (n === "Cluj" ? { lat: 46.77, lon: 23.6, label: "Cluj-Napoca", gateways: ["CLJ"], home: "RO" } : null));
  verdict("walk: a named start", cq.params.g === "CLJ" && cq.params.label === "Cluj-Napoca" && cq.params.maxStops === 3 && cq.params.from === "2026-10-17", `${cq.params.label} ${cq.params.g}, ${cq.params.from} to ${cq.params.to}; ${cq.notes.join(" | ").slice(0, 60)}`);
  const w0 = walkWindow({}, "2026-10-10");
  verdict("walk: default window", w0.from === "2026-10-17" && w0.to === "2026-10-30" && w0.minNights === 5 && w0.maxNights === 6 && w0.notes.length === 2, `${w0.from} to ${w0.to}, ${w0.minNights} to ${w0.maxNights} nights`);
  const w1 = walkWindow({ from: "2026-10-20", to: "2026-10-22", minNights: 5 }, "2026-10-10");
  verdict("walk: short window widened", w1.to === "2026-10-25" && w1.notes.some((n) => /widened/.test(n)), `${w1.from} to ${w1.to}: ${w1.notes.join(" | ")}`);
  // Both ends in the past: the note names the window really searched, never a swapped one.
  const w2 = walkWindow({ from: "2026-09-01", to: "2026-09-10" }, "2026-10-10");
  verdict("walk: past window", w2.from === "2026-10-10" && w2.to > w2.from && !w2.notes.some((n) => /read as/.test(n)) && w2.notes.some((n) => n.includes(w2.to)), `${w2.from} to ${w2.to}: ${w2.notes.join(" | ")}`);
  const w3 = walkWindow({ from: "2026-11-10", to: "2026-11-01" }, "2026-10-10");
  verdict("walk: swapped window", w3.from === "2026-11-01" && w3.to === "2026-11-10" && w3.notes.some((n) => n.includes("read as 2026-11-01 to 2026-11-10")), w3.notes.join(" | "));
  const pq = walkCommandQuery(parseCommand("loop through Poland 6 days", "2026-10-10")[0] as Extract<Command, { kind: "walk" }>, here, "2026-10-10").params;
  verdict("walk: countries to query", pq.countries === "Poland", `countries ${pq.countries}`);
  // The trip style fills what the line did not say; the line's own words win.
  const style: Prefs = { nightsPerPlace: [2, 3], pace: "balanced", tradeoff: "price", taste: "unique", avoid: ["dach"], groundOk: false };
  const sq = walkCommandQuery(parseCommand("loop 2 weeks, not Poland", "2026-10-10")[0] as Extract<Command, { kind: "walk" }>, here, "2026-10-10", undefined, style).params;
  verdict("walk: style to query", sq.nightsPerStop === "2-3" && sq.style === "unique" && sq.avoid === "Poland,dach" && sq.ground === 0 && (sq.tradeoff ?? "price") === "price", JSON.stringify({ nps: sq.nightsPerStop, style: sq.style, avoid: sq.avoid, ground: sq.ground, tradeoff: sq.tradeoff }));
  const lq = walkCommandQuery(parseCommand("loop 2 weeks, 3-4 nights a place, only trains between cities", "2026-10-10")[0] as Extract<Command, { kind: "walk" }>, here, "2026-10-10", undefined, style).params;
  verdict("walk: the line wins", lq.nightsPerStop === "3-4" && lq.ground === 480, `nps ${lq.nightsPerStop}, ground ${lq.ground}`);
  // The shell's own rule (walkFromCommand in components/Globe.tsx): every WALK_PARAM_KEYS field of the command that is a
  // number or a string is copied as it is, then the trip style fills only what is still empty. The ground field must
  // therefore already be minutes, or "flights only" reaches /api/walk as a word it reads as its 330-minute default.
  const shellCopy = (c: Record<string, unknown>, styleGround?: number): WalkQuery => {
    const q: WalkQuery = {};
    for (const k of WALK_PARAM_KEYS) {
      const v = c[k];
      if (typeof v === "number" || (typeof v === "string" && v.trim())) q[k] = v;
    }
    if (q.ground == null && styleGround != null) q.ground = styleGround;
    return q;
  };
  const flightsOnly = new URLSearchParams(walkQueryString(shellCopy(parseCommand("loop 6 days, flights only", "2026-10-10")[0] as unknown as Record<string, unknown>, 330))).get("ground");
  const trainsOnly = new URLSearchParams(walkQueryString(shellCopy(parseCommand("loop 2 weeks, only trains between cities", "2026-10-10")[0] as unknown as Record<string, unknown>))).get("ground");
  const styleOff = new URLSearchParams(walkQueryString(shellCopy(parseCommand("loop 6 days", "2026-10-10")[0] as unknown as Record<string, unknown>, 0))).get("ground");
  verdict("walk: shell copy, ground", flightsOnly === "0" && trainsOnly === "480" && styleOff === "0", `flights only -> ground=${flightsOnly}, trains between cities -> ground=${trainsOnly}, style off -> ground=${styleOff}`);
  console.log("");
}

// ---------------------------------------------------------------------------------------
// itinerary: make_itinerary, no Kiwi. The two-stop case calls the model (a minute) unless
// --itin-stub is given: then the model key is hidden for the call, and the engine writes the
// days from the guides alone (its own no-model path), which needs no Bedrock at all.
if (want("itinerary")) {
  console.log(`make_itinerary (${flag("itin-stub") ? "no model: the engine's guide-only path" : "the model writes the days"}):`);
  const ictx: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 0, max: 0 } };
  const it = atlasTools(ictx) as unknown as Tools;
  const run = async (input: unknown) => (await it.make_itinerary!.execute!(input, { toolCallId: "check-itin", messages: [] })) as Record<string, unknown>;
  // Two stops by name, from Brasov, five weeks out.
  {
    const start = plus(35);
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
    if (flag("itin-stub")) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    const before = sent();
    const t0 = Date.now();
    let r: Record<string, unknown> = {};
    try {
      r = await run({ stops: [{ place: "Lisbon", nights: 2 }, { place: "Porto", nights: 2 }], start, wishes: "pastries and tiles" });
    } finally {
      if (key) process.env.AWS_BEARER_TOKEN_BEDROCK = key;
    }
    const raw = r.raw as Itinerary | undefined;
    const days = Array.isArray(r.days) ? (r.days as { day: number; date: string; where: string; title: string }[]) : [];
    const ok = !r.error && !!raw && raw.stops.length === 2 && raw.start === start && days.length === raw.days.length && days.length >= 4 && sent() === before && typeof r.skeleton === "object";
    if (!ok) failures++;
    rows.push({ tool: "make_itinerary (2 stops)", ms: Date.now() - t0, status: ok ? `ok (${days.length} days, ${raw?.status}, €${raw?.costs.total} est.)` : `FAIL: ${String(r.error ?? r.note ?? "no itinerary")}`, kiwi: sent() - before, source: String(r.source ?? ""), note: String(r.note ?? "").slice(0, 90) });
    process.stdout.write(`  ${"make_itinerary (2 stops)".padEnd(28)} ${rows.at(-1)!.status}\n`);
    for (const d of days.slice(0, 6)) process.stdout.write(`      day ${d.day} ${d.date} ${d.where}: ${d.title}\n`);
    // What the model reads: no raw, no skeleton.
    const model = (it.make_itinerary as unknown as { toModelOutput?: (o: { output: unknown }) => { value: Record<string, unknown> } }).toModelOutput?.({ output: r });
    verdict("make_itinerary: model output", !!model && !("raw" in model.value) && !("skeleton" in model.value) && Array.isArray(model.value.days), model ? `keys ${Object.keys(model.value).join(", ").slice(0, 60)}` : "no toModelOutput");
  }
  // Nothing shown yet: a plain note, never an error, no model call.
  {
    const r = await run({ from: "last_route" });
    verdict("make_itinerary: nothing yet", typeof r.error !== "string" && typeof r.note === "string" && /no way from A to B/.test(r.note as string), String(r.note ?? r.error ?? "").slice(0, 70));
  }
  // An unknown place: the engine's sentence as a note.
  {
    const r = await run({ stops: [{ place: "Narnia Town", nights: 2 }], start: plus(35) });
    verdict("make_itinerary: unknown place", typeof r.error !== "string" && typeof r.note === "string" && /Narnia/.test(r.note as string), String(r.note ?? r.error ?? "").slice(0, 70));
  }
  // last_route replayed from a thread's history (what the chat route does): the parameters
  // the tool hands the engine are read through the trace, which stops it before any model call.
  {
    const hctx: AgentContext = { ...ictx, budget: { used: 0, max: 0 } };
    const leg = (from: string, to: string, date: string, price: number | null) => ({ kind: "fly" as const, from, fromName: from, to, toName: to, date, minutes: 200, price, url: "https://www.kiwi.com/x" });
    const opt = { kind: "direct" as const, legs: [leg("OTP", "LIS", plus(30), 120)], back: [leg("LIS", "OTP", plus(34), null)], total: 120, hours: 5, stops: 0, title: "Bucharest to Lisbon", why: "", urls: [], score: 1 };
    const raw: RouteResult = { from: { label: "Brașov", lat: 45.657, lon: 25.601, airports: ["OTP"] }, to: { label: "Lisbon", lat: 38.72, lon: -9.14, airports: ["LIS"] }, options: [opt], cheapest: opt, fastest: opt, searched: 1, failed: 0, considered: [], sources: ["live"], generatedAt: new Date().toISOString() };
    rememberOutput(hctx, "cheapest_way", { from: "Brașov", to: "Lisbon", options: [{}], raw });
    let seen: Record<string, unknown> | null = null;
    hctx.trace = (_engine, params) => {
      seen = params;
      throw new Error("harness: parameters read");
    };
    await (atlasTools(hctx) as unknown as Tools).make_itinerary!.execute!({ from: "last_route", pace: "slow" }, { toolCallId: "check-itin-route", messages: [] });
    const got = seen as Record<string, unknown> | null;
    verdict("make_itinerary: last_route", !!got && Array.isArray(got.stops) && (got.stops as string[])[0] === "Lisbon" && got.start === plus(30) && got.nights === 4 && got.pace === "slow", got ? `stops ${String(got.stops)}, start ${got.start}, ${got.nights} nights, pace ${got.pace}, deadline ${got.deadlineMs} ms` : "the tool never reached the engine");
    // A restored thread keeps only the compact rows: planned by names instead.
    const cctx: AgentContext = { ...ictx, budget: { used: 0, max: 0 } };
    rememberOutput(cctx, "cheapest_way", { from: "Brașov", to: "Lisbon", depart: plus(30), nights: 3, options: [{ kind: "direct" }] });
    let seen2: Record<string, unknown> | null = null;
    cctx.trace = (_engine, params) => {
      seen2 = params;
      throw new Error("harness: parameters read");
    };
    await (atlasTools(cctx) as unknown as Tools).make_itinerary!.execute!({ from: "last_route" }, { toolCallId: "check-itin-compact", messages: [] });
    const got2 = seen2 as Record<string, unknown> | null;
    verdict("make_itinerary: compact route", !!got2 && (got2.stops as string[])?.[0] === "Lisbon" && got2.nights === 3 && got2.start === plus(30) && got2.legs === 2, got2 ? `stops ${String(got2.stops)}, ${got2.nights} nights from ${got2.start}, ${got2.legs} legs` : "the tool never reached the engine");
    // A restored one-way route stays one way, and an option whose tickets the rows cannot
    // rebuild (a train to a hub) is named in a note instead of silently ignored.
    const octx: AgentContext = { ...ictx, budget: { used: 0, max: 0 } };
    rememberOutput(octx, "cheapest_way", { from: "Brașov", to: "Lisbon", depart: plus(30), nights: null, options: [{ kind: "direct", title: "Bucharest to Lisbon" }, { kind: "ground-then-fly", title: "Train to Vienna, then fly" }] });
    let seen3: Record<string, unknown> | null = null;
    octx.trace = (_engine, params) => {
      seen3 = params;
      throw new Error("harness: parameters read");
    };
    await (atlasTools(octx) as unknown as Tools).make_itinerary!.execute!({ from: "last_route", option: 2 }, { toolCallId: "check-itin-oneway", messages: [] });
    const got3 = seen3 as Record<string, unknown> | null;
    const notes3 = (got3?.corrections as string[] | undefined) ?? [];
    verdict("make_itinerary: compact one way", !!got3 && got3.legs === 1 && notes3.some((n) => /one way/.test(n)) && notes3.some((n) => /option 2 \(Train to Vienna/.test(n)), got3 ? `${got3.legs} leg; ${notes3.join(" | ").slice(0, 120)}` : "the tool never reached the engine");
    const r4 = (await (atlasTools(octx) as unknown as Tools).make_itinerary!.execute!({ from: "last_route", option: 5 }, { toolCallId: "check-itin-nooption", messages: [] })) as Record<string, unknown>;
    verdict("make_itinerary: compact bad option", typeof r4.note === "string" && /option 5 does not exist/.test(r4.note), String(r4.note ?? r4.error ?? "").slice(0, 70));
  }
  console.log("");
}

// ---------------------------------------------------------------------------------------
// walk: walk_trips, the chat's graph walk. The owner's case: from Brasov, 20 to 30 October (or the same days a
// year on when the run is later), 5 to 6 nights, 2 nights a stop, not countries like Germany, unique.
if (want("walk")) {
  console.log("walk_trips (the graph walk):");
  const base = today < "2026-10-18" ? "2026-10-20" : plus(10);
  const end = new Date(Date.parse(base) + 10 * 86_400_000).toISOString().slice(0, 10);
  const owner = { from: base, to: end, minNights: 5, maxNights: 6, nightsPerStop: 2, avoid: ["like:DE"], style: "unique" };
  const wctx = (used: number, max: number): AgentContext => ({ origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used, max } });
  const run = async (c: AgentContext, input: unknown, seen?: unknown[]) => (await drain(await (atlasTools(c) as unknown as Tools).walk_trips!.execute!(input, { toolCallId: "check-walk", messages: [] }), seen)) as Record<string, unknown>;
  // The parameters the tool hands the engine, read through the trace (no engine call, nothing leaves).
  {
    const c = wctx(100, 120);
    let got: Record<string, unknown> | null = null;
    c.trace = (_e, p) => {
      got = p;
      throw new Error("harness: parameters read");
    };
    const before = sent();
    const r = await run(c, { ...owner, nightsPerStop: "2-3" as unknown as number, mustInclude: ["Gdansk"], countries: undefined });
    const p = got as Record<string, unknown> | null;
    verdict("walk_trips -> walkTrips", !!p && p.budget === 12 && p.beam === 2 && p.maxStops === 3 && JSON.stringify(p.nightsPerStop) === "[2,3]" && (p.avoid as string[])?.[0] === "like:DE" && p.style === "unique" && p.from === base && typeof p.deadlineMs === "number" && (p.deadlineMs as number) <= 90_000 && sent() === before && typeof r.error === "string", p ? `budget ${p.budget}, beam ${p.beam}, nps ${JSON.stringify(p.nightsPerStop)}, avoid ${String(p.avoid)}, deadline ${p.deadlineMs} ms` : "the tool never reached the engine");
    const c2 = wctx(115, 120);
    let got2: Record<string, unknown> | null = null;
    c2.trace = (_e, q) => {
      got2 = q;
      throw new Error("harness: parameters read");
    };
    await run(c2, owner);
    verdict("walk_trips: budget = what is left", (got2 as Record<string, unknown> | null)?.budget === 5, `budget ${(got2 as Record<string, unknown> | null)?.budget} with 5 left in the turn`);
    // A named start abroad keeps the traveller's own home country: Gdansk in the start's country stays a stop.
    const c3 = wctx(0, 120);
    let got3: Record<string, unknown> | null = null;
    c3.trace = (_e, q) => {
      got3 = q;
      throw new Error("harness: parameters read");
    };
    await run(c3, { ...owner, origin: "Warsaw", mustInclude: ["Warsaw", "Gdansk"] });
    const g3 = got3 as Record<string, unknown> | null;
    verdict("walk_trips: start abroad", !!g3 && g3.home === "RO" && JSON.stringify(g3.mustInclude) === '["Gdansk"]' && JSON.stringify(g3.gateways) !== '["GHV","SBZ","OTP"]', g3 ? `home ${g3.home}, gateways ${String(g3.gateways)}, must ${String(g3.mustInclude)}` : "the tool never reached the engine");
    // A city to pass in the home country can never close: a plain note, before any search.
    const before4 = sent();
    const r4 = await run(wctx(0, 120), { ...owner, mustInclude: ["Cluj"] });
    verdict("walk_trips: stop at home", sent() === before4 && typeof r4.note === "string" && /home country/.test(String(r4.note)) && Array.isArray(r4.loops) && !(r4.loops as unknown[]).length, String(r4.note ?? r4.error ?? "").slice(0, 80));
  }
  // The budget-0 path: the turn's budget spent. No search may leave; the walk still runs on the fare memory and the
  // ground graph, and the note names the turn, never a rate limit.
  {
    const before = sent();
    const t0 = Date.now();
    const seen: unknown[] = [];
    const r = await run(wctx(5, 5), owner, seen);
    const leaked = sent() - before;
    const note = String(r.note ?? "");
    const loops = Array.isArray(r.loops) ? (r.loops as { route: string; total: number }[]) : [];
    const ok = typeof r.error !== "string" && leaked === 0 && r.searched === 0 && /this turn's search budget is spent.*live prices were not searched/.test(note) && !/rate-limited|few minutes/.test(note) && typeof r.params === "object";
    if (!ok) failures++;
    rows.push({ tool: "walk_trips (budget 0)", ms: Date.now() - t0, status: ok ? `ok (${loops.length} loops from memory, ${seen.length} progress lines)` : `FAIL: ${String(r.error ?? note).slice(0, 60)}; leaked ${leaked}`, kiwi: leaked, source: String(r.source ?? ""), note: note.slice(0, 90) });
    process.stdout.write(`  ${"walk_trips (budget 0)".padEnd(28)} ${rows.at(-1)!.status}\n`);
    for (const l of loops.slice(0, 3)) process.stdout.write(`      ${l.route}  €${l.total}\n`);
    // The model reads the loops, never the raw result or the query object.
    const tm = (atlasTools(wctx(0, 0)).walk_trips as unknown as { toModelOutput?: (o: { output: unknown }) => { value: Record<string, unknown> } }).toModelOutput?.({ output: r });
    verdict("walk_trips: model output", !!tm && !("raw" in tm.value) && !("params" in tm.value) && Array.isArray(tm.value.loops), tm ? `keys ${Object.keys(tm.value).join(", ").slice(0, 60)}` : "no toModelOutput");
    // The globe's live lines ride on the progress: nodes and edges, by index, with the query that draws them.
    const liveLines = (seen as { live?: { at: number; lines: Record<string, unknown>[] }; params?: unknown }[]).flatMap((x) => x.live?.lines ?? []);
    const firstParams = (seen[0] as { params?: { g?: string } } | undefined)?.params;
    verdict("walk_trips: live lines", seen.length === 0 || (liveLines.some((l) => "edge" in l || "node" in l) && firstParams?.g === "GHV,SBZ,OTP"), `${seen.length} yields, ${liveLines.length} lines (${liveLines.filter((l) => "edge" in l).length} edges, ${liveLines.filter((l) => "node" in l).length} nodes, ${liveLines.filter((l) => "loop" in l).length} loops)`);
  }
  // A request the engine refuses (nights a stop that do not fit) keeps the engine's reason with the budget spent.
  {
    const before = sent();
    const r = await run(wctx(5, 5), { ...owner, nightsPerStop: 5, minNights: 3, maxNights: 3 });
    verdict("walk_trips: refused at budget 0", sent() === before && /do not fit/.test(String(r.note ?? "")) && !/budget is spent/.test(String(r.note ?? "")), String(r.note ?? r.error ?? "").slice(0, 80));
  }
  // cheapest_way with the turn's budget spent: the engine at budget 0, no refusal, no search.
  {
    const before = sent();
    const r = (await drain(await (atlasTools(wctx(5, 5)) as unknown as Tools).cheapest_way!.execute!({ to: "Vienna", depart: plus(30), nights: 3 }, { toolCallId: "check-way0", messages: [] }))) as Record<string, unknown>;
    const leaked = sent() - before;
    const note = String(r.note ?? "");
    verdict("cheapest_way (budget 0)", typeof r.error !== "string" && leaked === 0 && /live prices were not searched/.test(note) && !/needs at least one live search/.test(note), `${Array.isArray(r.options) ? r.options.length : 0} options, source ${r.source}, "${note.slice(0, 60)}"`, leaked);
  }
  // One live walk, at most --walk-live searches (default 2) and never past the run's cap. A small budget still runs
  // the "anywhere" search from home first; the rest of the walk comes from the fare memory and the ground graph.
  {
    const walkLive = Number(args.find((a) => a.startsWith("--walk-live="))?.split("=")[1] ?? 2);
    const cap = Math.max(0, Math.min(Number.isFinite(walkLive) ? walkLive : 2, LIVE_CAP - sent()));
    if (!cap) {
      rows.push({ tool: "walk_trips (live)", ms: 0, status: "skipped: no live search left under the cap", kiwi: 0, source: "", note: "" });
      process.stdout.write(`  ${"walk_trips (live)".padEnd(28)} skipped\n`);
    } else {
      const before = sent();
      const t0 = Date.now();
      const seen: unknown[] = [];
      const r = await run(wctx(0, cap), owner, seen);
      const leaked = sent() - before;
      const loops = Array.isArray(r.loops) ? (r.loops as { route: string; total: number; legs: unknown[] }[]) : [];
      const ok = typeof r.error !== "string" && leaked <= cap && r.searched === leaked && seen.length > 0 && typeof r.source === "string";
      if (!ok) failures++;
      rows.push({ tool: "walk_trips (live)", ms: Date.now() - t0, status: ok ? `ok (${loops.length} loops, ${seen.length} progress lines, cap ${cap})` : `FAIL: ${String(r.error ?? r.note ?? "")}; ${leaked} sent, ${seen.length} progress lines`, kiwi: leaked, source: String(r.source ?? ""), note: String(r.note ?? "").slice(0, 90) });
      process.stdout.write(`  ${"walk_trips (live)".padEnd(28)} ${rows.at(-1)!.status}\n`);
      for (const line of seen.slice(0, 4)) process.stdout.write(`      ... ${(line as { progress: string }).progress.slice(0, 100)}\n`);
      for (const l of loops.slice(0, 3)) process.stdout.write(`      ${l.route}  €${l.total}\n`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------------------
// prefs: the trip style as the chat reads it. Every case reads the parameters a tool hands its engine through the
// trace (which throws before the engine runs) or runs a tool with the turn's budget spent: no Kiwi search leaves.
if (want("prefs")) {
  console.log("trip style (lib/prefs.ts) in the chat tools:");
  const before = sent();
  // The clamps: nights 1 to 14, the least first; an unknown choice back to the default; avoid words the walk cannot
  // read dropped ("XX" is no country); the longest flight 40 h at most; nothing sent is no style at all.
  {
    const a = chatPrefs({ nightsPerPlace: [40, 0], tradeoff: "cheapest!", taste: "unique", avoid: ["XX", "dach", "DE", 7], maxFlightHours: 99, groundOk: "no" });
    const ok = !!a && JSON.stringify(a.nightsPerPlace) === "[1,14]" && a.tradeoff === "price" && a.taste === "unique" && JSON.stringify(a.avoid) === '["dach","DE"]' && a.maxFlightHours === 40 && a.groundOk === true && chatPrefs(undefined) === undefined && chatPrefs("2-3") === undefined;
    verdict("prefs: clamps", ok, a ? `nights ${JSON.stringify(a.nightsPerPlace)}, tradeoff ${a.tradeoff}, avoid ${JSON.stringify(a.avoid)}, hours ${a.maxFlightHours}` : "no prefs");
    const c = chatContext({ origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, prefs: { nightsPerPlace: [2, 3], pace: "slow", tradeoff: "price", taste: "mixed", avoid: [], groundOk: true } });
    const sys = chatSystem(c);
    verdict("prefs: system prompt", /2 to 3 nights in each place/.test(sys) && /cheapest first/.test(sys) && /wins for that trip only/.test(sys) && /They set it themselves/.test(sys), /2 to 3 nights in each place/.test(sys) ? "the style's sentence and the override rule are in the prompt" : "the style is not in the prompt");
    const none = chatSystem(chatContext({ gateways: ["OTP"], home: "RO", today }));
    verdict("prefs: prompt without style", /app's defaults/.test(none) && /2 to 3 nights in each place/.test(none), "no style sent: the defaults are named as such");
  }
  /** A tools instance with this style, the trace reading what one tool hands its engine. */
  const traced = async (prefs: Prefs | undefined, name: string, input: unknown, budgetLeft = 120): Promise<{ engine: string; params: Record<string, unknown> } | null> => {
    const c: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 120 - budgetLeft, max: 120 }, ...(prefs ? { prefs } : {}) };
    const seen: { got: { engine: string; params: Record<string, unknown> } | null } = { got: null };
    c.trace = (engine, params) => {
      seen.got = { engine, params };
      throw new Error("harness: parameters read");
    };
    await drain(await (atlasTools(c) as unknown as Tools)[name]?.execute?.(input, { toolCallId: `prefs-${name}`, messages: [] }));
    return seen.got;
  };
  const style: Prefs = { nightsPerPlace: [2, 3], pace: "balanced", tradeoff: "price", taste: "unique", avoid: ["dach"], groundOk: true };
  const DEFAULT_STYLE: Prefs = { nightsPerPlace: [2, 3], pace: "balanced", tradeoff: "price", taste: "mixed", avoid: [], groundOk: true };
  const twoWeeks = { from: plus(20), to: plus(40), minNights: 14, maxNights: 14 };
  // walk_trips: the style's nights a place, tradeoff, taste and avoid list are the defaults; stops and budget scale.
  {
    const g = await traced(style, "walk_trips", twoWeeks);
    const p = g?.params ?? {};
    verdict("prefs -> walk_trips", !!g && JSON.stringify(p.nightsPerStop) === "[2,3]" && p.tradeoff === "price" && p.style === "unique" && (p.avoid as string[])?.includes("dach") && p.maxStops === 7 && p.budget === 16 && p.maxGroundMin === 330, g ? `nps ${JSON.stringify(p.nightsPerStop)}, tradeoff ${p.tradeoff}, style ${p.style}, avoid ${String(p.avoid)}, stops ${p.maxStops}, budget ${p.budget}` : "the tool never reached the engine");
    const g2 = await traced(style, "walk_trips", { ...twoWeeks, nightsPerStop: 3, nightsPerStopMax: 4, tradeoff: "comfort", avoid: [] });
    const q = g2?.params ?? {};
    verdict("prefs: message overrides", !!g2 && JSON.stringify(q.nightsPerStop) === "[3,4]" && q.tradeoff === "comfort" && Array.isArray(q.avoid) && !(q.avoid as string[]).length && q.maxStops === 5, g2 ? `nps ${JSON.stringify(q.nightsPerStop)}, tradeoff ${q.tradeoff}, avoid ${JSON.stringify(q.avoid)}, stops ${q.maxStops}` : "the tool never reached the engine");
    const g3 = await traced({ ...style, groundOk: false }, "walk_trips", { ...twoWeeks, maxStops: 4 });
    verdict("prefs: no trains or coaches", g3?.params.maxGroundMin === 0 && g3?.params.maxStops === 4, `maxGroundMin ${g3?.params.maxGroundMin}, stops ${g3?.params.maxStops}`);
    const g4 = await traced(undefined, "walk_trips", { from: plus(20), to: plus(30) });
    verdict("prefs: none sent = defaults", JSON.stringify(g4?.params.nightsPerStop) === "[2,3]" && g4?.params.tradeoff === "price" && !g4?.params.style, `nps ${JSON.stringify(g4?.params.nightsPerStop)}, tradeoff ${g4?.params.tradeoff}`);
  }
  // wild_trip: the walk engine by default with the style's nights a place; classic on request; a style that cannot
  // fill the nights in 16 stops leaves the engine's own stays.
  {
    const g = await traced(style, "wild_trip", { region: "balkans", nights: 14 });
    const p = g?.params ?? {};
    verdict("prefs -> wild_trip (walk)", g?.engine === "wildByWalk" && p.nightsPerStop === 2 && p.nightsPerStopMax === 3 && ((p.tradeoff as string | undefined) ?? "price") === "price" && (p.avoid as string[])?.includes("dach") && /unique/.test(String(p.wishes)), g ? `${g.engine}: nps ${p.nightsPerStop}-${p.nightsPerStopMax}, tradeoff ${p.tradeoff}, avoid ${String(p.avoid)}` : "the tool never reached the engine");
    const g2 = await traced(style, "wild_trip", { region: "balkans", nights: 14, engine: "classic" });
    const q = g2?.params ?? {};
    verdict("prefs -> wild_trip (classic)", g2?.engine === "buildWild" && q.nightsPerStop === 2 && q.nightsPerStopMax === 3 && (q.exclude as string[])?.includes("DE") && !("avoid" in q), g2 ? `${g2.engine}: nps ${q.nightsPerStop}-${q.nightsPerStopMax}, exclude ${String(q.exclude)}` : "the tool never reached the engine");
    const g3 = await traced(undefined, "wild_trip", { region: "sea", nights: 21 });
    verdict("wild_trip default: walk 2-3", g3?.engine === "wildByWalk" && g3.params.nightsPerStop === 2 && g3.params.nightsPerStopMax === 3, g3 ? `${g3.engine}: nps ${g3.params.nightsPerStop}-${g3.params.nightsPerStopMax}` : "the tool never reached the engine");
    const g4 = await traced(undefined, "wild_trip", { region: "sea", nights: 60 });
    verdict("wild_trip: 60 nights keep stays", g4?.engine === "wildByWalk" && g4.params.nightsPerStop === undefined, `nps ${g4?.params.nightsPerStop} (3 nights x 16 stops cannot fill 60)`);
    const g5 = await traced(undefined, "wild_trip", { region: "sea", nights: 14, nightsPerStop: 3, nightsPerStopMax: 4 });
    verdict("wild_trip: message overrides", g5?.params.nightsPerStop === 3 && g5?.params.nightsPerStopMax === 4, `nps ${g5?.params.nightsPerStop}-${g5?.params.nightsPerStopMax}`);
    // Classic with no style sent stays 2 to 3 nights a place, as the prompt says and the Wild tab's classic toggle sends.
    const g6 = await traced(undefined, "wild_trip", { region: "balkans", nights: 14, engine: "classic" });
    const g7 = await traced(undefined, "wild_trip", { region: "balkans", nights: 14, variants: 2 });
    verdict("wild_trip: classic default 2-3", g6?.engine === "buildWild" && g6.params.nightsPerStop === 2 && g6.params.nightsPerStopMax === 3 && g7?.engine === "buildWildVariants" && g7.params.nightsPerStop === 2, `classic ${g6?.params.nightsPerStop}-${g6?.params.nightsPerStopMax}, variants ${g7?.params.nightsPerStop}-${g7?.params.nightsPerStopMax}`);
    // Taste unique: the wishes are word for word /api/wild's, so the key's wishes hash matches the Wild tab's.
    verdict("wild_trip: unique wishes", g?.params.wishes === UNIQUE_WISHES, `wishes "${String(g?.params.wishes)}"`);
    // The turn's leftover reaches the walk only below the walk's own budget for the nights (14 nights at 2 a stop:
    // 8 stops, 18 searches), so 39 left is a full, stored build and 10 left is a short one.
    const b39 = await traced(undefined, "wild_trip", { region: "balkans", nights: 14 }, 39);
    const b10 = await traced(undefined, "wild_trip", { region: "balkans", nights: 14 }, 10);
    verdict("wild_trip: walk budget", b39?.engine === "wildByWalk" && b39.params.searchBudget === undefined && b10?.params.searchBudget === 10, `39 left -> ${String(b39?.params.searchBudget ?? "its own 18")}, 10 left -> ${String(b10?.params.searchBudget)}`);
  }
  // The keys wild_trip returns, read without a search: the budget is spent, so each answer is a "nothing stored" note
  // carrying the key it would have stored under.
  {
    const keyOf = async (prefs: Prefs | undefined, input: Record<string, unknown>): Promise<string> => {
      const c: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 120, max: 120 }, ...(prefs ? { prefs } : {}) };
      const r = (await drain(await (atlasTools(c) as unknown as Tools).wild_trip!.execute!(input, { toolCallId: "prefs-key", messages: [] }))) as Record<string, unknown>;
      return String((r.key as { custom?: string } | undefined)?.custom ?? `(no key: ${String(r.error ?? r.note ?? "").slice(0, 60)})`);
    };
    const noTrains = { ...DEFAULT_STYLE, groundOk: false };
    const variantsKey = await keyOf(noTrains, { region: "balkans", nights: 14, variants: 3 });
    const singleKey = await keyOf(noTrains, { region: "balkans", nights: 14, engine: "classic" });
    verdict("wild_trip: variant keys", !variantsKey.includes("-g0") && singleKey.endsWith("-g0"), `variants "${variantsKey}" (as lib/wild-variants.ts stores them), one classic "${singleKey}" (as /api/wild ground=0)`);
  }
  // cheapest_way and group_trip read the style too: the longest flight (door to door plus airport time) and the
  // tradeoff; a group's nights only when the traveller changed the style.
  {
    const g = await traced({ ...style, maxFlightHours: 8 }, "cheapest_way", { to: "Lisbon", depart: plus(35), nights: 4 });
    verdict("prefs -> cheapest_way", g?.params.maxHours === 11 && g?.params.tradeoff === "price", `maxHours ${g?.params.maxHours}, tradeoff ${g?.params.tradeoff}`);
    const members = [{ name: "Ana", origins: ["Cluj"], available: [{ from: plus(30), to: plus(40) }] }, { name: "Patrick", origins: ["GHV"], available: [{ from: plus(30), to: plus(40) }] }];
    const g2 = await traced({ ...style, nightsPerPlace: [4, 5] }, "group_trip", { members, where: "Lisbon" });
    const g3 = await traced(undefined, "group_trip", { members, where: "Lisbon" });
    verdict("prefs -> group_trip", g2?.params.minNights === 4 && g2?.params.maxNights === 5 && g3?.params.minNights === 2 && g3?.params.maxNights === 4, `styled ${g2?.params.minNights}-${g2?.params.maxNights}, default ${g3?.params.minNights}-${g3?.params.maxNights}`);
  }
  // find_getaways has no trace: with the turn's budget spent it answers from known fares, and says which of the
  // style's defaults it used.
  {
    const c: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brașov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 5, max: 5 }, prefs: { ...style, nightsPerPlace: [4, 5], maxFlightHours: 6 } };
    const r = (await drain(await (atlasTools(c) as unknown as Tools).find_getaways!.execute!({ from: plus(30), to: plus(40) }, { toolCallId: "prefs-getaways", messages: [] }))) as Record<string, unknown>;
    const line = String(r.tripStyle ?? "");
    verdict("prefs -> find_getaways", /4 to 5 nights/.test(line) && /under 6 h/.test(line) && /dach/.test(line), line.slice(0, 70) || String(r.error ?? r.note ?? "").slice(0, 70));
    // A style that changed only the tradeoff leaves a getaway's nights alone (2 to 7, not the 2 to 3 a place).
    const c2: AgentContext = { ...c, budget: { used: 5, max: 5 }, prefs: { ...DEFAULT_STYLE, tradeoff: "price" } };
    const r2 = (await drain(await (atlasTools(c2) as unknown as Tools).find_getaways!.execute!({ from: plus(30), to: plus(40) }, { toolCallId: "prefs-getaways-2", messages: [] }))) as Record<string, unknown>;
    const line2 = String(r2.tripStyle ?? "");
    verdict("find_getaways: tradeoff only", !/nights/.test(line2), line2 ? line2.slice(0, 70) : "no nights from the style");
  }
  verdict("prefs: no search left", sent() === before, `${sent() - before} Kiwi searches sent by the prefs cases`);
  console.log("");
}

// ---------------------------------------------------------------------------------------
// owner: the owner's conversation of 2026-10-12 (Brasov to Warsaw on the 24th, home from Gdansk), case by case, with
// no Kiwi search: the way home over a range of days, his own flight kept in a walk, a town without an airport, cities
// passed as event kinds, the fare memory comparing like with like, dates read from web text, and the prompt's rule.
if (want("owner")) {
  console.log("the owner's conversation (2026-10-12), zero Kiwi searches:");
  const before = sent();
  const spentCtx = (): AgentContext => ({ origin: { lat: 45.657, lon: 25.601, label: "Brasov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 120, max: 120 } });
  const spent = atlasTools(spentCtx()) as unknown as Tools;
  const run = async (t: Tools, name: string, input: unknown) => (await drain(await t[name]!.execute!(input, { toolCallId: `owner-${name}`, messages: [] }))) as Record<string, unknown>;
  {
    const r = await run(spent, "way_home", { from: "Gdansk", from_date: plus(15), to_date: plus(21) });
    const homes = (r.homeAirports as { airport: string }[] | undefined)?.map((h) => h.airport) ?? [];
    verdict("way_home: budget spent", !r.error && r.searched === 0 && homes.includes("OTP") && homes.includes("GHV") && typeof r.window === "string", `${String(r.error ?? r.note ?? "").slice(0, 40)}; home ${homes.slice(0, 5).join(",")}`);
    const t = await run(spent, "way_home", { from: "Torun", from_date: plus(15) });
    verdict("way_home: a town", !t.error && typeof t.placeNote === "string" && /no airport/.test(String(t.placeNote)), String(t.placeNote ?? t.error ?? t.note ?? "").slice(0, 66));
    const u = await run(spent, "way_home", { from: "Gdanskk" });
    verdict("way_home: unknown place", !u.error && typeof u.note === "string" && /close matches/.test(String(u.note)), String(u.note ?? u.error).slice(0, 66));
  }
  {
    const d = await dry("walk_trips", { fixedOut: { from: "Brasov", to: "Warsaw", date: plus(12) }, mustInclude: ["Torun", "Gdansk"], minNights: 6, maxNights: 8 });
    const p = d?.params ?? {};
    const fo = p.fixedOut as { to?: string; date?: string } | undefined;
    const towns = (p.towns as { name: string; code: string }[] | undefined) ?? [];
    const must = (p.mustInclude as string[] | undefined) ?? [];
    verdict("walk: fixedOut and a town", fo?.to === "WAW" && fo?.date === plus(12) && p.from === plus(12) && towns.some((x) => x.name === "Toruń") && must.includes(towns[0]?.code ?? "?") && must.includes("Gdansk") && d?.leaked === 0, `out ${fo?.to} ${fo?.date}, from ${p.from}, towns ${towns.map((x) => x.name).join(",")}, must ${must.join(",")}`);
    const r = await run(spent, "walk_trips", { fixedOut: { from: "Brasov", to: "Warsaw", date: plus(12) }, mustInclude: ["Torun", "Gdansk"], minNights: 6, maxNights: 8 });
    const loops = (r.loops as { legs: { source: string; to: string }[] }[] | undefined) ?? [];
    const first = loops[0]?.legs[0];
    verdict("walk: own flight kept", !r.error && (!loops.length || (first?.source === "given" && first.to === "Warsaw" && loops.every((l) => l.legs.some((g) => g.to === "Toruń")))), loops.length ? `${loops.length} loops, the first leg ${first?.source} to ${first?.to}, Toruń in every loop` : String(r.note ?? r.error ?? "").slice(0, 66));
  }
  {
    const r = await run(spent, "events_worth_travelling_for", { from: plus(10), to: plus(17), kinds: ["Paris", "music"] });
    const local = (r.local as { city: string }[] | undefined) ?? [];
    verdict("events: a city as a kind", !r.error && local.some((c) => c.city === "Paris") && /read as a city/.test(String(r.corrected ?? "")), `${local.map((c) => c.city).join(",")}; ${String(r.corrected ?? r.note ?? r.error ?? "").slice(0, 40)}`);
  }
  {
    const a = await run(spent, "price_insight", { from: "GHV", to: "Reykjavik", date: plus(40), price: 100 });
    const b = await run(spent, "price_insight", { from: "Brasov", to: "KEF", date: plus(40), price: 100 });
    const thin = typeof a.samples === "number" && a.samples < 5;
    const ok = !a.error && (a.source === "none" || (thin ? a.verdict === "not enough history" : typeof a.basis === "string")) && a.verdict === b.verdict && a.samples === b.samples;
    verdict("price_insight: like with like", ok, `${a.verdict}, ${a.samples ?? 0} fares, same answer twice: ${a.verdict === b.verdict}`);
    // Two prices on one route and day in ONE turn (one tools instance): each judged against the same typical. The
    // memo once kept the first verdict, so the one-stop at 150 was "great" because the direct at 32 was asked first.
    const one = atlasTools(spentCtx()) as unknown as Tools;
    const q = { from: "GDN", to: "OTP", date: "2026-10-31", oneWay: true };
    const bare = await run(one, "price_insight", q);
    const lo = await run(one, "price_insight", { ...q, price: 32 });
    const hi = await run(one, "price_insight", { ...q, price: 150 });
    const typ = typeof lo.typical === "number" ? lo.typical : null;
    const expect = (p: number) => (typ == null ? "unknown" : p / typ <= 0.7 ? "great" : p / typ <= 0.9 ? "good" : p / typ > 1.15 ? "high" : "typical");
    const judged = lo.verdict === "not enough history" || lo.source === "none" ? lo.verdict === hi.verdict : lo.verdict === expect(32) && hi.verdict === expect(150) && bare.verdict === "unknown";
    verdict("price_insight: two prices", !lo.error && !hi.error && judged, `no price ${bare.verdict}, 32 ${lo.verdict}, 150 ${hi.verdict} (typical ${typ ?? "none"}, ${lo.samples ?? 0} fares)`);
  }
  {
    // A town in the stops of an itinerary (the walk's Warsaw, Torun, Gdansk), and the fares the thread already found:
    // the way home from way_home prices the last leg instead of a distance estimate. Read through the trace: no model.
    const fakeHome = { from: "Gdansk", window: "2026-10-27 to 2026-11-03", bestDirect: { day: "2026-10-31", from: "GDN", to: "OTP", depart: "21:05", arrive: "00:40", price: 32, direct: true, hours: 2.6, carrier: "Ryanair", url: "https://www.kiwi.com/x" }, cheapest: null, calendar: [] };
    rememberOutput(ctx, "way_home", fakeHome);
    const d = await dry("make_itinerary", { origin: "Brasov", start: "2026-10-24", stops: [{ place: "Warsaw", nights: 2 }, { place: "Torun", nights: 1 }, { place: "Gdansk", nights: 4 }] });
    const stops = (d?.params.stops as string[] | undefined) ?? [];
    const prices = (d?.params.prices as (number | null)[] | undefined) ?? [];
    verdict("itinerary: a town and a fare", d?.engine === "generateItinerary" && stops.includes("Toruń") && prices[prices.length - 1] === 32 && d.leaked === 0, `stops ${stops.join(",")}, prices ${JSON.stringify(prices)}`);
    ctx.recent?.delete("fares");
  }
  {
    // The walk's params for the browser carry the town's name (never T-torun, which /api/walk refused), and a walk
    // with the traveller's own flight is marked so the map never runs it again without that flight.
    const r = await run(spent, "walk_trips", { fixedOut: { from: "Brasov", to: "Warsaw", date: plus(12) }, mustInclude: ["Torun", "Gdansk"], minNights: 6, maxNights: 8 });
    const must = String(((r.params as Record<string, unknown> | undefined)?.mustInclude as string | undefined) ?? "");
    verdict("walk: params for the map", !!r.params ? !/T-/.test(must) && /Toru/.test(must) && r.mapRerun === false : !!r.note, r.params ? `mustInclude ${must}, mapRerun ${String(r.mapRerun)}` : String(r.note ?? r.error).slice(0, 66));
  }
  {
    // Kinds that are event words stay kinds, whatever the gazetteer says (Marathon, Florida; Christmas Island).
    const m = await run(spent, "events_worth_travelling_for", { from: plus(10), to: plus(40), kinds: ["Marathon"] });
    const c = await run(spent, "events_worth_travelling_for", { from: plus(10), to: plus(40), kinds: ["Christmas"] });
    verdict("events: event words stay", !m.local && !c.local && !/read as a city/.test(String(m.corrected ?? "") + String(c.corrected ?? "")), `Marathon ${m.local ? "a city" : "a kind"}, Christmas ${c.local ? "a city" : "a kind"}`);
    // The owner's turn 4: three cities, one web search for all of them (Gdansk is never left without one).
    const t = await run(atlasTools(spentCtx()) as unknown as Tools, "events_worth_travelling_for", { from: "2026-10-24", to: "2026-11-02", kinds: ["Warsaw", "Torun", "Gdansk"] });
    const local = (t.local as { city: string }[] | undefined) ?? [];
    verdict("events: three cities", local.length === 3 && !/no web search left/.test(String(t.note ?? "")), `${local.map((x) => x.city).join(",")}; ${String(t.note ?? "").slice(0, 40)}`);
  }
  {
    // A Polish seaside town flies home from Gdansk and Bydgoszcz, never from Kaliningrad (Russia, a travel warning).
    const r = await run(spent, "way_home", { from: "Sopot", from_date: plus(15) });
    verdict("way_home: no unsafe airport", !r.error && !/Kaliningrad/i.test(String(r.placeNote ?? "")), String(r.placeNote ?? r.note ?? r.error ?? "").slice(0, 66));
  }
  {
    const w = "2026-10-24";
    const x = "2026-11-02";
    const got = [dateInText("Halloween party on 31 October at Klub Stodola", w, x), dateInText("Oct 28th, 2026 jazz night", w, x), dateInText("28.10.2026 concert", w, x), dateInText("Spring fair 12 May", w, x)];
    verdict("events: dates in web text", JSON.stringify(got) === JSON.stringify(["2026-10-31", "2026-10-28", "2026-10-28", null]), JSON.stringify(got));
    // A range that began before the window runs into it; a day written "26.10." without a year.
    const more = [dateInText("Jazz week from 20 to 25 October", w, x), dateInText("Expo 20-26 Oct", w, x), dateInText("Mon 26.10. Klub Stodola", w, x), dateInText("10-15 October fair", w, x)];
    verdict("events: ranges and dd.mm.", JSON.stringify(more) === JSON.stringify(["2026-10-24", "2026-10-24", "2026-10-26", null]), JSON.stringify(more));
  }
  {
    const sys = chatSystem(chatContext({ origin: { lat: 45.657, lon: 25.601, label: "Brasov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today }));
    verdict("prompt: the way home rule", /way_home/.test(sys) && /never search or re-plan the way out/.test(sys) && /direct options first/.test(sys) && /at most 2 web searches/.test(sys), "way_home, keep the flight, direct first, two web searches");
  }
  verdict("owner: no search left", sent() === before, `${sent() - before} Kiwi searches sent by the owner cases`);
  // --owner-live: the way home he needed, live: Gdansk, 27 Oct to 3 Nov, direct only. The first search goes to every
  // home airport at once (its cheapest 15 are one-stops), then one home airport at a time, where the direct shows.
  // At most min(6, --live-cap) Kiwi searches.
  if (flag("owner-live")) {
    const cap = Math.min(6, LIVE_CAP);
    const c: AgentContext = { origin: { lat: 45.657, lon: 25.601, label: "Brasov" }, gateways: ["GHV", "SBZ", "OTP"], home: "RO", today, budget: { used: 0, max: cap } };
    const t0 = sent();
    const r = await run(atlasTools(c) as unknown as Tools, "way_home", { from: "Gdansk", from_date: "2026-10-27", to_date: "2026-11-03", direct_only: true });
    const days = (r.calendar as { day: string; direct: { price: number; from: string; to: string; carrier: string } | null; none?: string }[] | undefined) ?? [];
    const bd = r.bestDirect as { day: string; from: string; to: string; price: number; carrier: string } | null | undefined;
    for (const d of days) console.log(`    ${d.day}  ${d.direct ? `${d.direct.from}-${d.direct.to} ${d.direct.price} EUR ${d.direct.carrier}` : d.none ?? "-"}`);
    verdict("way_home live: direct only", !r.error && sent() - t0 <= cap && (!!bd || /not proof/.test(String(r.note ?? ""))), `${bd ? `best direct ${bd.day} ${bd.from}-${bd.to} ${bd.price} EUR ${bd.carrier}` : String(r.note ?? r.error).slice(0, 50)}; ${sent() - t0} searches`, sent() - t0);
  }
  console.log("");
}

if (!want("tools")) report();

console.log(`check-tools: context GHV, SBZ, OTP, home RO, origin Brasov, today ${today}; live cap ${LIVE_CAP} searches; Kiwi ${kiwiThrottled() ? "THROTTLED (breaker open)" : "open"}`);
console.log("");

// Stored, memoised or static paths first: no Kiwi search leaves the process for these.
await check("home_airports", {});
await check("cheapest_deals", { country: "Italy", limit: 5 });
await check("sights", { city: "Lisbon" });
await check("events_near", { city: "Lisbon" });
await check("place_facts", { city: "brașov" });
await check("best_months", { city: "lisbon" });
await check("stopover_programmes", {});
await check("hotel_deals", { limit: 5 });
await check("fare_history", { from: "OTP", to: "LIS" });
await check("price_insight", { from: "OTP", to: "Lisbon", month: nextMonth, price: 120 });
await check("price_insight", { from: "OTP", to: "Lisbon", date: plus(30), price: 120, nights: 4 }, { label: "price_insight (a day)" });
await check("ground_reach", { from: "Torun", maxHours: 3 }, { label: "ground_reach (a town)" });
await check("sights", { city: "Toruń" }, { label: "sights (a town)" });
await check("ground_reach", { maxHours: 4 });
await check("ask", { kind: "dates", question: "When?" });
await check("oneway_fares", { origin: "OTP", limit: 5 });
await check("eats_near", { city: "Lisbon" });
await check("hotels_near", { city: "Lisbon", checkin: plus(35), checkout: plus(37) });
await check("web_search", { query: "best pastel de nata in Lisbon" });
await check("events_worth_travelling_for", { from: plus(1), to: plus(60), live: 0 });

// A wild trip only when one is stored and fresh for this context (a build is sixty searches).
const gw = mainGateway(ctx.gateways);
const wildPick = await (async () => {
  for (const region of ["sea", "south-america", "central-asia", "east-asia", "south-asia"]) {
    for (const nights of [14, 7, 10, 28, 60]) {
      const stored = await readJson<WildTrip>(wildPath(gw, region, undefined, nights, "experiences", "mid")).catch(() => null);
      if (stored && stored.ageHours < 24) return { region, nights, ageHours: stored.ageHours };
    }
  }
  return null;
})();
// The stored trips this looks for are the classic chain's (the walk engine's keys end in -walk), so it asks for that engine.
await check("wild_trip", wildPick ? { region: wildPick.region, nights: wildPick.nights, engine: "classic" } : {}, { skip: wildPick ? undefined : `no wild trip stored under wild/${gw}-<region>-next-<nights>-experiences-mid.json in the last 24 h; a build would cost ~60 searches` });
// The day plan only when one is already stored for that trip (the planner is a minute of model calls).
const planPick = wildPick ? await readJson<Plan>(planPath(wildPath(gw, wildPick.region, undefined, wildPick.nights, "experiences", "mid"))).catch(() => null) : null;
await check("plan_days", wildPick ? { key: { region: wildPick.region, nights: wildPick.nights, style: "experiences", budget: "mid", custom: "" } } : {}, { skip: planPick ? undefined : "no plan stored for the stored trip; planning would cost about a minute of model calls" });

// Live, smallest inputs, cheapest first. Each estimate is checked against the cap before the call.
await check("scan_cheapest", { to: "Lisbon", months: 1, startMonth: nextMonth }, { estimate: 1 });
await check("reprice_route", { from: "OTP", to: "LIS", depart: plus(30), nights: 4 }, { estimate: 1 });
await check("way_home", { from: "Gdansk", from_date: plus(14), to_date: plus(20) }, { estimate: 2 });
await check("find_getaways", { from: plus(30), to: plus(37), where: "Portugal", minNights: 3, maxNights: 5 }, { estimate: 2 });
await check("group_trip", { members: [{ name: "Ana", origins: ["Cluj"], available: [{ from: plus(30), to: plus(34) }] }, { name: "Patrick", origins: ["GHV"], available: [{ from: plus(30), to: plus(34) }] }], where: "Lisbon", minNights: 3, maxNights: 4 }, { estimate: 4 });
// cheapest_way spends from the turn's budget: cap it to what is left under LIVE_CAP. First
// the dated case: a departure tomorrow with two days of flex, whose window would start
// yesterday, so the engine searches from today and the tool's corrected line says so. One
// live search (the main one; the hubs are beyond a budget of one).
// The same call runs with an origin label the engine cannot place ("Nowhere Hamlet" at
// Brasov's coordinates): the tool then sends lat,lon and must put the name back on every
// label, the raw legs included, so nothing in the answer reads "45.66, 25.60" as a town.
{
  const left = Math.max(1, Math.min(2, LIVE_CAP - sent()));
  const saved = ctx.budget!.max;
  const savedLabel = ctx.origin!.label;
  ctx.budget!.max = ctx.budget!.used + left;
  ctx.origin!.label = "Nowhere Hamlet";
  const r = await check("cheapest_way", { to: "Vienna", depart: plus(1), flex: 2, nights: 3 }, { estimate: left, label: "cheapest_way (past window)" });
  ctx.budget!.max = saved;
  ctx.origin!.label = savedLabel;
  if (r) {
    const corrected = typeof r.corrected === "string" ? r.corrected : "";
    verdict("past window: corrected", /would start before today; searched from today/.test(corrected) && r.depart === plus(1) && r.flex === 2, corrected ? `"${corrected.slice(0, 60)}"` : "no corrected line about the window start");
    const text = JSON.stringify(r);
    const coords = text.match(/45\.6\d, 25\.6\d/g)?.length ?? 0;
    const options = Array.isArray(r.options) ? r.options.length : 0;
    verdict("origin relabel (raw too)", coords === 0 && r.from === "Nowhere Hamlet", coords ? `${coords} coordinate label(s) left in the answer` : `from "${String(r.from)}", ${options} options, no coordinates anywhere`);
  }
}
// Then the plain case, three searches at most, one at least (the engine always makes its main search).
{
  const left = Math.max(1, Math.min(3, LIVE_CAP - sent()));
  const saved = ctx.budget!.max;
  ctx.budget!.max = ctx.budget!.used + left;
  await check("cheapest_way", { to: "Lisbon", depart: plus(35), nights: 4 }, { estimate: left });
  ctx.budget!.max = saved;
}
// Combos cost one plus one per neighbour: a city with few neighbours keeps it under the cap.
const comboCity = ["OPO", "VLC", "LIS"].map((c) => ({ c, est: 1 + neighboursOf(c).length })).sort((a, b) => a.est - b.est)[0];
await check("two_city_combos", { from: "OTP", dst: comboCity.c, city: comboCity.c, out: plus(30), back: plus(34), price: 150 }, { estimate: comboCity.est });
await check("long_stay", { countries: ["PT"], months: 1 }, { estimate: 16, skip: flag("long-stay") ? undefined : "not memoised in a fresh process; run with --long-stay to price it live (about 16 searches)" });

// The same reprice again: the gate memoises it, so no search leaves and the tool must say memo.
// Only when the first call really ran (under the cap and live): otherwise this would be the
// first search, not a memo hit.
{
  const first = rows.find((r) => r.tool === "reprice_route");
  if (first?.status.startsWith("ok") && first.kiwi > 0) {
    const before = sent();
    const r = (await tools.reprice_route!.execute!({ from: "OTP", to: "LIS", depart: plus(30), nights: 4 }, { toolCallId: "check-memo", messages: [] })) as Record<string, unknown>;
    const leaked = sent() - before;
    const ok = leaked === 0 && r.searched === 0 && r.source === "memo";
    rows.push({ tool: "reprice_route (again)", ms: 0, status: ok ? "ok (memo hit: searched 0, source memo)" : `FAIL: memo hit reported searched ${String(r.searched)}, source ${String(r.source)}, ${leaked} sent`, kiwi: leaked, source: String(r.source ?? ""), note: "" });
    if (!ok) failures++;
  } else rows.push({ tool: "reprice_route (again)", ms: 0, status: "skipped: the first reprice did not search live (cap or memory), no memo hit to test", kiwi: 0, source: "", note: "" });
  process.stdout.write(`  ${"reprice_route (again)".padEnd(28)} ${rows.at(-1)!.status.slice(0, 70)}\n`);
}

// Every live tool with the turn's budget spent: nothing may leave the process, and the note
// must not call it a rate limit (a new message would search at once).
console.log("");
console.log("turn budget spent (no search may leave; the note names the turn, not a rate limit):");
{
  const saved = { ...ctx.budget! };
  ctx.budget!.used = ctx.budget!.max;
  const probes: [string, unknown][] = [
    ["find_getaways", { from: plus(30), to: plus(37), where: "Portugal" }],
    ["scan_cheapest", { to: "Porto", months: 2 }],
    ["reprice_route", { from: "OTP", to: "OPO", depart: plus(31), nights: 3 }],
    ["long_stay", { countries: ["PT"], months: 1 }],
    ["group_trip", { members: [{ name: "Ana", origins: ["Cluj"], available: [{ from: plus(30), to: plus(34) }] }, { name: "Patrick", origins: ["GHV"], available: [{ from: plus(30), to: plus(34) }] }], where: "Lisbon" }],
    ["cheapest_way", { to: "Lisbon", depart: plus(35) }],
    ["walk_trips", { from: plus(20), to: plus(30), minNights: 5, maxNights: 6 }],
    ["way_home", { from: "Gdansk", from_date: plus(20) }],
    ["two_city_combos", { from: "OTP", dst: "OPO", city: "OPO", out: plus(30), back: plus(34), price: 150 }],
    ["wild_trip", { region: "sea", nights: 10, countries: ["Vietnam", "Thailand"], wishes: "temples and street food" }],
  ];
  for (const [name, input] of probes) {
    const before = sent();
    const r = await check(name, input, { edge: true, label: `${name} (budget spent)` });
    const row = rows.at(-1)!;
    const leaked = sent() - before;
    const rateWords = /rate-limited|few minutes/.test(row.note) && !kiwiThrottled();
    if (leaked > 0 || rateWords) {
      row.status = `FAIL: ${leaked ? `${leaked} search(es) left with the budget spent` : "the note calls the turn budget a rate limit"}`;
      failures++;
      process.stdout.write(`  ${name.padEnd(28)} ${row.status.slice(0, 70)}\n`);
    }
    // A wild trip asked under a named region with a countries list is keyed as region custom
    // (what the engine, /api/wild and /api/plan do), so the chat and the Wild tab share the
    // stored trip; the key comes back on the stored path with no search spent.
    if (name === "wild_trip" && r) {
      const key = r.key as { region?: string; custom?: string } | undefined;
      verdict("wild key: countries = custom", key?.region === "custom" && !!key.custom && /vn|th/.test(key.custom), key ? `region ${key.region}, custom ${key.custom}` : "no key on the answer", leaked);
    }
  }
  ctx.budget!.used = saved.used;
  ctx.budget!.max = saved.max;
}

// The parameters the tools hand their engines, read through the trace hook (the engine is
// never called, nothing leaves): the deadlines a time-capped turn relies on, the route
// budget (12, 24 when asked to look harder, never more than the turn has left), and region
// custom whenever a countries list is given.
console.log("");
console.log("engine parameters (read through the trace, no engine call):");
{
  // cheapest_way's deadline counts down from the moment its tools instance was made (the
  // turn's clock): the live checks above may have run for minutes, so a fresh instance is
  // made here, the way the chat route makes one per request. The budget stays ctx's.
  tools = atlasTools(ctx) as unknown as Tools;
  const left = () => Math.max(0, ctx.budget!.max - ctx.budget!.used);
  const groupIn = { members: [{ name: "Ana", origins: ["Cluj"], available: [{ from: plus(30), to: plus(34) }] }, { name: "Patrick", origins: ["GHV"], available: [{ from: plus(30), to: plus(34) }] }], where: "Lisbon" };
  const cases: [string, string, unknown, (p: Record<string, unknown>, at: number) => [boolean, string]][] = [
    ["cheapest_way", "cheapestWay", { to: "Lisbon", depart: plus(35), nights: 4 }, (p) => [p.budget === Math.min(12, left()) && typeof p.deadlineMs === "number" && p.deadlineMs >= 10_000 && p.deadlineMs <= 90_000 && p.depart === plus(35) && p.flex === 2, `budget ${p.budget}, deadlineMs ${p.deadlineMs}, depart ${p.depart}`]],
    ["cheapest_way", "cheapestWay", { to: "Lisbon", depart: plus(35), nights: 4, harder: true }, (p) => [p.budget === Math.min(24, left()) && typeof p.deadlineMs === "number" && p.deadlineMs > 90_000 && p.deadlineMs <= 150_000, `harder: budget ${p.budget}, deadlineMs ${p.deadlineMs}`]],
    ["cheapest_way", "cheapestWay", { to: "Vienna", depart: plus(1), flex: 2, nights: 3 }, (p) => [p.depart === plus(1) && p.flex === 2, `past window: depart ${p.depart}, flex ${p.flex} (the engine trims it to today)`]],
    ["wild_trip", "wildByWalk", { region: "sea", nights: 10, countries: ["Vietnam", "Thailand"] }, (a, at) => [a.region === "custom" && near(a.deadline, at + WILD_BUILD_MS - DEADLINE_MARGIN_MS) && Array.isArray(a.countries) && a.countries.join() === "VN,TH" && a.nightsPerStop === 2, `region ${a.region}, countries ${String(a.countries)}, nps ${a.nightsPerStop}, deadline in ${Math.round(((a.deadline as number) - at) / 1000)} s`]],
    ["wild_trip", "buildWild", { region: "sea", nights: 10, countries: ["Vietnam", "Thailand"], engine: "classic" }, (a, at) => [a.region === "custom" && near(a.deadline, at + WILD_BUILD_MS - DEADLINE_MARGIN_MS) && Array.isArray(a.countries) && a.countries.join() === "VN,TH" && a.nightsPerStop === 2, `classic (the style's nights a place, as the Wild tab sends them): region ${a.region}, countries ${String(a.countries)}, nps ${a.nightsPerStop}`]],
    ["wild_trip", "buildWildVariants", { region: "sea", nights: 10, variants: 2 }, (p, at) => [p.region === "sea" && near(p.deadline, at + WILD_BUILD_MS - DEADLINE_MARGIN_MS) && p.variants === 2, `region ${p.region}, variants ${p.variants}, deadline in ${Math.round(((p.deadline as number) - at) / 1000)} s`]],
    ["long_stay", "longStay", { countries: ["PT"], months: 1 }, (p, at) => [near(p.deadline, at + LONG_BUILD_MS - DEADLINE_MARGIN_MS), `deadline in ${Math.round(((p.deadline as number) - at) / 1000)} s`]],
    ["group_trip", "groupTrip", groupIn, (p, at) => [near(p.deadline, at + LONG_BUILD_MS - DEADLINE_MARGIN_MS), `deadline in ${Math.round(((p.deadline as number) - at) / 1000)} s`]],
  ];
  for (const [name, engine, input, judge] of cases) {
    const at = Date.now();
    const got = await dry(name, input);
    if (!got) {
      verdict(`${name} -> ${engine}`, false, "the tool never reached its engine (an early return or a throw outside safe)");
      continue;
    }
    const [ok, detail] = judge(got.params, at);
    verdict(`${name} -> ${engine}`, ok && got.engine === engine && got.leaked === 0, got.engine !== engine ? `called ${got.engine}, wanted ${engine}` : got.leaked ? `${got.leaked} search(es) left` : detail, got.leaked);
  }
}

// parseDay: the words the model writes, against a fixed today (a Saturday).
console.log("");
console.log("parseDay (today 2026-10-10, a Saturday):");
{
  const T = "2026-10-10";
  const cases: [string, string | null][] = [
    ["2026-11-14", "2026-11-14"],
    ["2026-11-5", "2026-11-05"],
    ["14/11/2026", "2026-11-14"],
    ["14.11.2026", "2026-11-14"],
    ["14 November 2026", "2026-11-14"],
    ["Nov 14", "2026-11-14"],
    ["November 14, 2026", "2026-11-14"],
    ["3rd Jan", "2027-01-03"],
    ["today", T],
    ["tomorrow", "2026-10-11"],
    ["next friday", "2026-10-16"],
    ["saturday", "2026-10-17"],
    ["this weekend", null],
    ["Christmas", null],
    ["end of October", null],
    ["late Nov 2026", null],
    ["ASAP", T],
    ["2026-02-30", null],
    ["", null],
  ];
  for (const [input, want] of cases) {
    const got = parseDay(input, T);
    const ok = got === want;
    if (!ok) failures++;
    rows.push({ tool: `parseDay "${input}"`.slice(0, 28), ms: 0, status: ok ? `ok (${got ?? "null"})` : `FAIL: got ${got ?? "null"}, wanted ${want ?? "null"}`, kiwi: 0, source: "", note: "" });
    process.stdout.write(`  ${`"${input}"`.padEnd(28)} ${ok ? "ok" : "FAIL"} ${got ?? "null"}${ok ? "" : ` (wanted ${want ?? "null"})`}\n`);
  }
}

// Odd inputs: a note with close matches, a corrected date, never a throw.
console.log("");
console.log("edge inputs (a note or a plain error is the expected answer):");
await check("best_months", { city: "Lisbonn" }, { edge: true });
await check("cheapest_deals", { country: "Narnia" }, { edge: true });
await check("events_near", { city: "Lisboa" }, { edge: true });
await check("price_insight", { from: "OTP", to: "LIS", month: "2026-13" }, { edge: true });
await check("way_home", { from: "Narnia" }, { edge: true, label: "way_home (unknown)" });
await check("hotels_near", { city: "Lisbon", checkin: plus(40), checkout: plus(38) }, { edge: true });
await check("wild_trip", wildPick ? { region: "Southeast Asia", nights: wildPick.nights, engine: "classic" } : {}, { edge: true, skip: wildPick?.region === "sea" ? undefined : "needs the stored Southeast Asia trip" });
// A long stay the engine refuses in a sentence (region custom with no countries, thrown as
// LongStayInputError before any search): the sentence comes back as the note, never { error }.
{
  const r = await check("long_stay", { region: "custom", months: 1 }, { edge: true, label: "long_stay (custom, none)" });
  if (r) verdict("long_stay refusal = note", typeof r.error !== "string" && typeof r.note === "string" && /countries/.test(r.note), typeof r.error === "string" ? `answered { error: ${r.error.slice(0, 40)} }` : `note "${String(r.note).slice(0, 50)}"`);
}
// Valid inputs written loosely: lower case, a leading word, a named start. A note is not required.
console.log("");
console.log("loose inputs (must resolve, no note needed):");
await check("place_facts", { city: "cluj" });
await check("ground_reach", { from: "Lisbon", maxHours: 3 });

report();
