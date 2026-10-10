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
// --only=command,dispatch,itinerary runs just those (no live tool at all); --only=tools just
// the live table.
import { atlasTools, parseDay, rememberOutput, type AgentContext } from "../lib/agent-tools";
import { parseCommand, type Command } from "../lib/command";
import { eventCommand, eventRoute, eventTripDays, routeDetail, routeResultDetail, type ChatEvent } from "../lib/chat-widgets";
import { skeletonFromDeal, skeletonFromRoute, type Itinerary } from "../lib/itinerary";
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
    const r = (await t.execute(input, { toolCallId: `check-${name}`, messages: [] })) as Record<string, unknown> | null | undefined;
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
    await tools[name]?.execute?.(input, { toolCallId: `dry-${name}`, messages: [] });
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
await check("wild_trip", wildPick ? { region: wildPick.region, nights: wildPick.nights } : {}, { skip: wildPick ? undefined : `no wild trip stored under wild/${gw}-<region>-next-<nights>-experiences-mid.json in the last 24 h; a build would cost ~60 searches` });
// The day plan only when one is already stored for that trip (the planner is a minute of model calls).
const planPick = wildPick ? await readJson<Plan>(planPath(wildPath(gw, wildPick.region, undefined, wildPick.nights, "experiences", "mid"))).catch(() => null) : null;
await check("plan_days", wildPick ? { key: { region: wildPick.region, nights: wildPick.nights, style: "experiences", budget: "mid", custom: "" } } : {}, { skip: planPick ? undefined : "no plan stored for the stored trip; planning would cost about a minute of model calls" });

// Live, smallest inputs, cheapest first. Each estimate is checked against the cap before the call.
await check("scan_cheapest", { to: "Lisbon", months: 1, startMonth: nextMonth }, { estimate: 1 });
await check("reprice_route", { from: "OTP", to: "LIS", depart: plus(30), nights: 4 }, { estimate: 1 });
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
    ["wild_trip", "buildWild", { region: "sea", nights: 10, countries: ["Vietnam", "Thailand"] }, (p, at) => [p.region === "custom" && near(p.deadline, at + WILD_BUILD_MS - DEADLINE_MARGIN_MS) && Array.isArray(p.countries) && p.countries.join() === "VN,TH", `region ${p.region}, countries ${String(p.countries)}, deadline in ${Math.round(((p.deadline as number) - at) / 1000)} s`]],
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
await check("hotels_near", { city: "Lisbon", checkin: plus(40), checkout: plus(38) }, { edge: true });
await check("wild_trip", wildPick ? { region: "Southeast Asia", nights: wildPick.nights } : {}, { edge: true, skip: wildPick?.region === "sea" ? undefined : "needs the stored Southeast Asia trip" });
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
