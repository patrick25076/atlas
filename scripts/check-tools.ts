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
import { atlasTools, parseDay, type AgentContext } from "../lib/agent-tools";
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

console.log("");
const w = { tool: 28, ms: 7, status: 62, kiwi: 5, source: 8 };
console.log(`${"tool".padEnd(w.tool)} ${"ms".padStart(w.ms)} ${"status".padEnd(w.status)} ${"kiwi".padStart(w.kiwi)} ${"source".padEnd(w.source)} note`);
for (const r of rows) console.log(`${r.tool.padEnd(w.tool)} ${String(r.ms).padStart(w.ms)} ${r.status.slice(0, w.status).padEnd(w.status)} ${String(r.kiwi).padStart(w.kiwi)} ${r.source.padEnd(w.source)} ${r.note}`);
const st = kiwiStats();
console.log("");
console.log(`${rows.length} tools, ${failures} failed; Kiwi searches sent this run: ${st.today} (${st.failedToday} failed, ${st.throttledToday} held by the breaker); turn budget used: ${ctx.budget!.used}; breaker ${st.throttledUntil ? `open until ${st.throttledUntil}` : "closed"}`);
process.exit(failures ? 1 : 0);
