// The Atlas command line in a terminal: the same words as the top bar's command line
// (lib/command.ts), run through the same tools as the chat (lib/agent-tools.ts), printed as
// plain tables. One question to the agent itself is `atlas ask ...`.
//
// Run: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/atlas.ts <words>
//      (or `pnpm atlas <words>`)
// Examples:
//   atlas Brasov to Bucharest
//   atlas to Lisbon 14 Nov 4 nights
//   atlas events february --live-cap 0
//   atlas loop from Brasov 20 to 30 Oct 5 to 6 nights 2 nights a stop
//   atlas itinerary Lisbon 3 nights from 2026-11-14
//   atlas wild sea 14 nights --nights-per-place 2-3 --taste unique
//   atlas ask "is Porto nice in October"
//   atlas search Lisbon in november
//   atlas search --window 2026-10-22..2026-11-30 --include 2026-10-26 --nights 3-5 --live-cap 0
//   atlas search loop from Brasov 20 to 30 Oct 6 days --direct
//   atlas style
//   atlas help
// Flags:
//   --from "lat,lon,label"   where you are (default Brașov, 45.657,25.601)
//   --airports OTP,SBZ       the airports searched nightly (default GHV,SBZ,OTP)
//   --live-cap N             the most Kiwi searches this run may make (default 12)
//   --today YYYY-MM-DD       the calendar day the words are read against (default today)
//   --json                   print the raw tool answer instead of the tables
//   --all                    print every suggestion parseCommand made, then run the first
// The one search (atlas search ...): the words as the command line reads them, then these, which win:
//   --to Lisbon|Portugal|sea|anywhere   --out D --back D   --window D..D --include D   --month YYYY-MM
//   --nights 3-5   --one-way   --shape any|return|two|loop|long   --direct   --trains   --events
//   --cities 1|2|3   --max-price N   --query '<SearchQuery as JSON>'
// The trip style (lib/prefs.ts), the defaults every tool starts from, as in the app's Trip style:
//   --nights-per-place 2-3   nights in each place, a number or a range (default 2-3)
//   --pace slow|balanced|packed          (default balanced)
//   --tradeoff price|balanced|comfort    (default balanced)
//   --taste popular|unique|mixed         (default mixed)
//   --avoid dach,DE          countries (ISO2) or group words never to stop in
//   --max-flight-hours 8     the longest single flight
//   --no-ground              no trains or coaches between places, flights only
//   --engine classic         build a wild loop with the older greedy chain instead of the walk
//
// Kiwi throttles an address after bursts, so the cap is real: it is the turn budget the tools
// spend from, and a command whose usual cost is above it runs from stored data instead.
import { generateText, hasToolCall, stepCountIs } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { atlasTools, chatContext, chatSystem, searchStream, UNIQUE_WISHES, type AgentContext, type SearchFinal } from "../lib/agent-tools";
import { COMMAND_HINTS, GROUND_PREFER_MIN, parseCommand, toSearchQuery, type Command, type SearchHere } from "../lib/command";
import { parseSearchQuery, type SearchQuery } from "../lib/trip-result";
import { REGIONS } from "../lib/wild";
import citiesJson from "../public/data/cities.json";
import countriesJson from "../public/data/countries.json";
import type { City, CountryInfo } from "../lib/types";
import { DEFAULT_PREFS, prefsLine, prefsSummary, sameAsDefault } from "../lib/prefs";
import { parseNightsRange } from "../lib/wild";
import { kiwiStats } from "../lib/kiwi";
import { eventsAt } from "../lib/purpose-events";
import { itineraryText } from "../lib/itinerary-server";
import type { Itinerary } from "../lib/itinerary";

// The AI SDK's notices (a deprecated call inside the planner) are for developers reading
// logs, not for someone reading a table: the terminal shows the answer only.
(globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
process.removeAllListeners("warning");

// ---------------------------------------------------------------------------------------
// Arguments.

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const words: string[] = [];
const VALUED = new Set(["from", "airports", "live-cap", "today", "nights-per-place", "pace", "tradeoff", "taste", "avoid", "max-flight-hours", "engine", "to", "out", "back", "window", "include", "month", "nights", "shape", "max-price", "cities", "query"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m) {
    words.push(a);
    continue;
  }
  if (m[2] != null) flags.set(m[1], m[2]);
  else if (VALUED.has(m[1]) && i + 1 < argv.length) flags.set(m[1], argv[++i]);
  else flags.set(m[1], true);
}
const flag = (k: string) => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : undefined);
const JSON_OUT = flags.has("json");
const capRaw = Number(flag("live-cap"));
const LIVE_CAP = flags.has("live-cap") && Number.isFinite(capRaw) ? Math.max(0, Math.round(capRaw)) : 12;
const today = /^\d{4}-\d{2}-\d{2}$/.test(flag("today") ?? "") ? flag("today")! : new Date().toISOString().slice(0, 10);

const origin = (() => {
  const f = flag("from");
  if (!f) return { lat: 45.657, lon: 25.601, label: "Brașov" };
  const [lat, lon, ...label] = f.split(",");
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
    console.error(`--from wants "lat,lon,label", got "${f}"`);
    process.exit(2);
  }
  return { lat: Number(lat), lon: Number(lon), label: label.join(",").trim() || "here" };
})();
const gateways = (flag("airports") ?? "GHV,SBZ,OTP")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter((s) => /^[A-Z]{3}$/.test(s));

// The trip style from the flags, over the same defaults the app starts from (DEFAULT_PREFS); chatContext clamps it
// exactly as the chat route does, so a terminal run and a chat turn with the same style ask the same thing.
const prefsGiven = ["nights-per-place", "pace", "tradeoff", "taste", "avoid", "max-flight-hours", "no-ground"].some((k) => flags.has(k));
const prefsIn = (() => {
  const nights = parseNightsRange(flag("nights-per-place")) ?? DEFAULT_PREFS.nightsPerPlace;
  const hours = Number(flag("max-flight-hours"));
  return {
    ...DEFAULT_PREFS,
    nightsPerPlace: nights,
    ...(flag("pace") ? { pace: flag("pace") } : {}),
    ...(flag("tradeoff") ? { tradeoff: flag("tradeoff") } : {}),
    ...(flag("taste") ? { taste: flag("taste") } : {}),
    avoid: (flag("avoid") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...(Number.isFinite(hours) && hours > 0 ? { maxFlightHours: hours } : {}),
    groundOk: !flags.has("no-ground"),
  };
})();
const ENGINE = flag("engine") === "classic" ? "classic" : "walk";
const ctx: AgentContext = chatContext({ origin, gateways, home: "RO", today, prefs: prefsIn });
ctx.budget = { used: 0, max: LIVE_CAP };
const prefs = ctx.prefs ?? DEFAULT_PREFS;
type Tools = Record<string, { execute?: (input: unknown, opts: unknown) => Promise<unknown> }>;
const tools = atlasTools(ctx) as unknown as Tools;
const kiwiAtStart = kiwiStats().today;

// ---------------------------------------------------------------------------------------
// Printing.

const out = (s = "") => process.stdout.write(s + "\n");
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const euro = (n: unknown) => (typeof n === "number" ? `€${Math.round(n)}` : "");
const cut = (s: unknown, n: number) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
/** A table: column widths from the content, capped, the last column free. */
function table(head: string[], rows: string[][], max = 34) {
  const w = head.map((h, i) => Math.min(max, Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : cut(c, w[i]).padEnd(w[i]))).join("  ");
  out(bold(line(head)));
  for (const r of rows) out(line(r));
}
function notes(r: Record<string, unknown>) {
  // The tools write some notes to the model ("..., say so"); the terminal shows the fact only.
  for (const k of ["corrected", "note", "unplaced", "beenFilter", "tripStyle"]) if (typeof r[k] === "string") out(dim(`${k}: ${String(r[k]).replace(/,? say so$/, "")}`));
}

/** A tool's answer: a streaming tool (walk_trips) is an async generator whose every yield before the last is
 * progress ({ running: true, progress }); those lines go to `onProgress` and the last yield is the answer. */
async function drain(r: unknown, onProgress?: (line: string) => void): Promise<unknown> {
  if (!r || typeof (r as AsyncIterable<unknown>)[Symbol.asyncIterator] !== "function") return r;
  let last: unknown;
  // A walk also yields when only its live lines for the globe are new; the same progress line prints once.
  let said = "";
  for await (const item of r as AsyncIterable<unknown>) {
    const p = item as { running?: boolean; progress?: unknown };
    if (p && p.running === true && typeof p.progress === "string") {
      if (p.progress !== said) onProgress?.(p.progress);
      said = p.progress;
    } else last = item;
  }
  return last;
}
async function call(name: string, input: unknown, onProgress?: (line: string) => void): Promise<Record<string, unknown>> {
  const t = tools[name];
  if (!t?.execute) return { error: `the tool ${name} is not available here (a key may be missing)` };
  const r = await drain(await t.execute(input, { toolCallId: `cli-${name}`, messages: [] }), onProgress);
  return r && typeof r === "object" ? (r as Record<string, unknown>) : { error: `answered ${String(r)}` };
}
/** Prints the raw answer for --json and says whether the caller should stop there. */
function json(r: unknown): boolean {
  if (!JSON_OUT) return false;
  out(JSON.stringify(r, null, 2));
  return true;
}
function failed(r: Record<string, unknown>): boolean {
  if (typeof r.error !== "string") return false;
  out(`Could not: ${r.error}`);
  return true;
}

// ---------------------------------------------------------------------------------------
// The commands.

const plus = (n: number) => new Date(Date.parse(today + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

async function runRoute(c: Extract<Command, { kind: "route" }>) {
  if (!c.to) return out("Say where to: atlas Brasov to Lisbon");
  const r = await call("cheapest_way", { ...(c.from ? { from: c.from } : {}), to: c.to, ...(c.depart ? { depart: c.depart } : {}), ...(c.nights ? { nights: c.nights } : {}), ...(c.oneWay ? { oneWay: true } : {}), ...(c.flex != null ? { flex: c.flex } : {}) });
  if (json(r) || failed(r)) return;
  // A refused or empty answer may carry no ends or day: the typed command fills them in, and
  // "one way" is said only when the tool says the trip has no return (nights null).
  const from = typeof r.from === "string" && r.from ? r.from : (c.from ?? "where you are");
  const to = typeof r.to === "string" && r.to ? r.to : c.to;
  const depart = typeof r.depart === "string" && r.depart ? r.depart : c.depart;
  const stay = typeof r.nights === "number" && r.nights > 0 ? `, ${r.nights} nights` : r.nights === null || (r.nights === undefined && c.oneWay) ? ", one way" : c.nights ? `, ${c.nights} nights` : "";
  out(bold(`${from} to ${to}${depart ? `, around ${depart}` : ""}${stay}`));
  const options = (r.options as { kind: string; title: string; total: number; hours: number; stops: number; nonstop?: boolean; legs: string[]; back?: string[]; cheapest?: boolean; fastest?: boolean; urls: string[] }[]) ?? [];
  if (!options.length) out("No way found.");
  options.forEach((o, i) => {
    const tags = [o.cheapest ? "cheapest" : "", o.fastest ? "fastest" : ""].filter(Boolean).join(", ");
    out("");
    out(`${i + 1}. ${bold(o.title)}  ${euro(o.total)}  ${o.hours} h  ${o.nonstop ? "nonstop" : o.stops ? `${o.stops} stop${o.stops > 1 ? "s" : ""}` : ""}${tags ? `  [${tags}]` : ""}  ${dim(o.kind)}`);
    for (const l of o.legs) out(`     ${l}`);
    if (o.back?.length) {
      out(dim("     back:"));
      for (const l of o.back) out(`     ${l}`);
    }
    if (o.urls?.[0]) out(dim(`     book: ${cut(o.urls[0], 110)}`));
  });
  out("");
  if (Array.isArray(r.considered) && r.considered.length) out(dim(`considered: ${(r.considered as string[]).join(", ")}`));
  out(dim(`source: ${r.source}, ${r.searched} live searches`));
  notes(r);
}

type WalkLegRow = { kind: string; from: string; to: string; date: string; depart?: string; minutes: number; price: number; estimated?: boolean; carrier?: string; source: string; url?: string };
type WalkLoopRow = { title: string; route: string; start: string; end: string; nights: number; total: number; hours: number; stops: { name: string; country: string; nights: number; arrive: string }[]; legs: WalkLegRow[]; why: string[] };
const KIND_WORD: Record<string, string> = { fly: "fly", train: "train", coach: "coach", ferry: "ferry", road: "drive" };
const span = (min: number) => (min >= 90 ? `${Math.round(min / 6) / 10} h` : `${Math.round(min)} min`);

/** A loop of cheap hops (walk_trips, lib/graph-walk.ts), printed as a tree: the route line, then each leg with the
 * stay it leads to, the booking link under each flight, and the why lines. Progress lines print as the walk runs. */
async function runWalk(c: Extract<Command, { kind: "walk" }>) {
  const nps = c.nightsPerStop;
  const input = {
    ...(c.origin ? { origin: c.origin } : {}),
    ...(c.from ? { from: c.from } : {}),
    ...(c.to ? { to: c.to } : {}),
    ...(c.minNights ? { minNights: c.minNights } : {}),
    ...(c.maxNights ? { maxNights: c.maxNights } : {}),
    ...(nps != null ? (Array.isArray(nps) ? { nightsPerStop: nps[0], nightsPerStopMax: nps[1] } : { nightsPerStop: nps }) : {}),
    ...(c.maxStops ? { maxStops: c.maxStops } : {}),
    ...(c.mustInclude?.length ? { mustInclude: c.mustInclude } : {}),
    ...(c.countries?.length ? { countries: c.countries } : {}),
    ...(c.avoid?.length ? { avoid: c.avoid } : {}),
    ...(c.style ? { style: c.style } : {}),
    // The command carries minutes (0 flights only, 480 trains between places); walk_trips takes its words.
    ...(c.ground != null ? { ground: c.ground === 0 ? "none" : c.ground >= GROUND_PREFER_MIN ? "prefer" : "ok" } : {}),
  };
  const r = await call("walk_trips", input, JSON_OUT ? undefined : (line) => out(dim(`  ... ${line}`)));
  if (json(r) || failed(r)) return;
  out(bold(`Loops from ${String(r.from ?? "here")}, ${String(r.window ?? "")}, ${String(r.nights ?? "")} nights, ${String(r.nightsPerStop ?? "")} nights a place`));
  const loops = (r.loops as WalkLoopRow[] | undefined) ?? [];
  if (!loops.length) out("No loop closed.");
  loops.forEach((l, i) => {
    out("");
    out(`${i + 1}. ${bold(l.title)}  ${euro(l.total)}  ${l.hours} h of travel  ${l.start} to ${l.end}, ${l.nights} nights`);
    out(`   ${l.route}`);
    // Each hop that is not a drive leads to the next stop, in order; the last one goes home.
    let stop = 0;
    const rows: string[] = [];
    for (const g of l.legs) {
      rows.push(`${KIND_WORD[g.kind] ?? g.kind}  ${g.from} to ${g.to}, ${g.date}${g.depart ? ` ${g.depart}` : ""}, ${span(g.minutes)}, ${euro(g.price)}${g.estimated ? " (estimate)" : ""}${g.carrier ? `, ${g.carrier}` : ""}  ${dim(g.source)}`);
      if (g.url) rows.push(dim(`  book: ${cut(g.url, 110)}`));
      if (g.kind !== "road" && stop < l.stops.length) {
        const s = l.stops[stop++];
        rows.push(`stay  ${s.name}, ${s.country}, ${s.nights} night${s.nights === 1 ? "" : "s"} from ${s.arrive}`);
      }
    }
    rows.forEach((row, k) => out(`   ${k === rows.length - 1 ? "└─" : "├─"} ${row}`));
    for (const w of l.why ?? []) out(dim(`   why: ${w}`));
  });
  out("");
  if (Array.isArray(r.considered) && r.considered.length) out(dim(`considered: ${(r.considered as string[]).join("; ")}`));
  out(dim(`source: ${r.source}, ${r.searched} live searches`));
  notes(r);
}

async function runEvents(c: Extract<Command, { kind: "events" }>) {
  const from = c.from ?? today;
  const to = c.to ?? plus(c.words?.length ? 365 : 90);
  const kinds = [...(c.words ?? []), ...(c.where ? [c.where] : [])];
  const r = await call("events_worth_travelling_for", { from, to, ...(kinds.length ? { kinds } : {}), live: Math.min(4, LIVE_CAP) });
  if (json(r) || failed(r)) return;
  out(bold(`Events worth the trip, ${from} to ${to}${kinds.length ? ` (${kinds.join(", ")})` : ""}`));
  const events = (r.events as { event: string; city: string; country?: string; dates: string; kind?: string; cheapestTrip: { price: number; dates?: string; from?: string } | null }[]) ?? [];
  if (events.length)
    table(
      ["dates", "event", "where", "fare", "trip"],
      events.map((e) => [e.dates, e.event, `${e.city}${e.country ? `, ${e.country}` : ""}`, e.cheapestTrip ? euro(e.cheapestTrip.price) : "not priced", e.cheapestTrip ? `${e.cheapestTrip.from ?? ""} ${e.cheapestTrip.dates ?? ""}`.trim() : ""]),
    );
  // A named place also gets the curated events nearby by distance (lib/purpose-events.ts).
  if (c.where) {
    const near = eventsAt({ city: c.where }, from, to);
    if (near.length) {
      out("");
      out(bold(`Near ${c.where}:`));
      table(["dates", "event", "where", "why"], near.slice(0, 8).map((e) => [`${e.start} to ${e.end}`, e.name, e.cityName, e.why]));
    }
  }
  out("");
  out(dim(`source: ${r.source}, ${r.searched} live searches`));
  notes(r);
}

async function runGetaways(c: Extract<Command, { kind: "getaways" }>) {
  // A live period search is about twenty searches; under that cap the boards answer.
  const live = !!(c.from && c.to) && LIVE_CAP >= 20;
  let r: Record<string, unknown>;
  if (live) r = await call("find_getaways", { from: c.from, to: c.to, ...(c.where ? { where: c.where } : {}), ...(c.minNights ? { minNights: c.minNights } : {}), ...(c.maxNights ? { maxNights: c.maxNights } : {}), ...(c.maxHours ? { maxHours: c.maxHours } : {}) });
  else {
    const month = c.from ? c.from.slice(0, 7) : undefined;
    r = await call("cheapest_deals", { ...(c.where ? { city: c.where } : {}), ...(month ? { month } : {}), ...(c.maxPrice ? { maxPrice: c.maxPrice } : {}), ...(c.minNights ? { minNights: c.minNights } : {}), ...(c.maxNights ? { maxNights: c.maxNights } : {}), limit: 10 });
    // A country in the city field finds nothing: try it as a country.
    if (c.where && !(r.deals as unknown[] | undefined)?.length) r = await call("cheapest_deals", { country: c.where, ...(month ? { month } : {}), limit: 10 });
    if (c.from && c.to && !live) out(dim(`(a live search for ${c.from} to ${c.to} costs about 20 Kiwi searches, over the cap of ${LIVE_CAP}; these are tonight's boards)`));
  }
  if (json(r) || failed(r)) return;
  out(bold(c.label));
  let deals = (r.deals as { city: string; country: string; price: number; dates?: string; nights?: number; from?: string; stops?: number; flightMinutes?: number }[]) ?? [];
  if (c.maxHours) deals = deals.filter((d) => !d.flightMinutes || d.flightMinutes <= c.maxHours! * 60);
  if (deals.length) table(["price", "where", "dates", "nights", "from", "flight"], deals.map((d) => [euro(d.price), `${d.city}, ${d.country}`, d.dates ?? "", String(d.nights ?? ""), d.from ?? "", d.flightMinutes ? `${Math.round(d.flightMinutes / 6) / 10} h${d.stops ? `, ${d.stops} stop` : ", direct"}` : ""]));
  else out("No deal found.");
  out("");
  out(dim(`source: ${r.source}, ${r.searched ?? 0} live searches`));
  notes(r);
}

/** Kiwi searches one wild build costs, about: the walk two a stop plus the way in and home (stops enough for the
 * nights at the shortest stay, 16 at most, 40 searches at most); the classic chain about sixty. */
function wildCost(nights: number, nps: number | [number, number] | undefined): number {
  if (ENGINE === "classic") return 60;
  const least = Array.isArray(nps) ? nps[0] : (nps ?? prefs.nightsPerPlace[0]);
  return Math.min(40, 2 * Math.min(16, Math.ceil(nights / Math.max(1, least))) + 4);
}
async function runWild(c: Extract<Command, { kind: "wild" }>) {
  // Under the build's cost only a stored loop can answer: the turn's budget is marked spent, so no search leaves.
  const nights = c.nights ?? 14;
  const cost = wildCost(nights, c.nightsPerStop);
  if (LIVE_CAP < cost && ctx.budget) ctx.budget.used = ctx.budget.max;
  // The line's own nights a place win over the trip style; "unique" rides in the wishes, as the chat passes it.
  const nps = c.nightsPerStop;
  const input = {
    region: c.countries?.length ? "custom" : (c.region ?? "sea"),
    ...(c.countries?.length ? { countries: c.countries } : {}),
    ...(c.nights ? { nights: c.nights } : {}),
    ...(nps != null ? (Array.isArray(nps) ? { nightsPerStop: nps[0], nightsPerStopMax: nps[1] } : { nightsPerStop: nps }) : {}),
    // The same words the Wild tab, /api/wild and the chat write for "unique", so all four share one stored trip.
    ...(c.style === "unique" ? { wishes: UNIQUE_WISHES } : {}),
    ...(ENGINE === "classic" ? { engine: "classic" } : {}),
  };
  const r = await call("wild_trip", input);
  if (json(r) || failed(r)) return;
  printTrip(r);
  if (c.ground != null) out(dim(`(${c.ground === 0 ? "flights only" : "trains between places"} is read by the loop walk in the app and the chat; the wild builder takes it from your trip style, --no-ground for flights only)`));
  if (LIVE_CAP < cost) out(dim(`(building a new loop costs about ${cost} Kiwi searches with the ${ENGINE} engine; run with --live-cap ${cost} to allow it)`));
}
/** A wild trip as wild_trip summarises it: the stops and legs are lines already. */
function printTrip(r: Record<string, unknown>) {
  if (r.title) out(bold(`${r.title}${r.dates ? `, ${r.dates}` : ""}${r.engine ? dim(`  (${r.engine === "walk" ? "built by the walk" : "classic chain"})`) : ""}`));
  for (const s of (r.stops as string[] | undefined) ?? []) out(`  stay  ${s}`);
  for (const l of (r.legs as string[] | undefined) ?? []) out(dim(`  leg   ${l}`));
  const t = r.totals as { flights?: number; living?: number; all?: number; perDay?: number; nights?: number } | undefined;
  if (t) out(`total ${euro(t.all)} for ${t.nights} nights (flights ${euro(t.flights)}, living ${euro(t.living)}, about ${euro(t.perDay)} a day)`);
  for (const v of (r.ranked as { rank: number; variant: string; title?: string; totals?: { all?: number } }[] | undefined) ?? []) out(`  ${v.rank}. ${v.variant}: ${v.title ?? ""} ${euro(v.totals?.all)}`);
  out(dim(`source: ${r.source}, ${r.searched ?? 0} live searches`));
  notes(r);
}

async function runLongStay(c: Extract<Command, { kind: "longstay" }>) {
  if (LIVE_CAP < 16 && ctx.budget) ctx.budget.used = ctx.budget.max;
  const r = await call("long_stay", { ...(c.region ? { region: c.region } : {}), ...(c.countries?.length ? { countries: c.countries } : {}), ...(c.months ? { months: c.months } : {}) });
  if (json(r) || failed(r)) return;
  out(bold(c.label));
  const bases = (r.bases as { base: string; country: string; total: number; perDay: number; rentPerMonth: number; flightIn: string }[]) ?? [];
  if (bases.length) table(["base", "total", "a day", "rent", "flight in"], bases.map((b) => [`${b.base}, ${b.country}`, euro(b.total), euro(b.perDay), euro(b.rentPerMonth), b.flightIn]));
  out(dim(`source: ${r.source}, ${r.searched ?? 0} live searches`));
  notes(r);
  if (LIVE_CAP < 16) out(dim("(pricing the bases live costs about 16 Kiwi searches; run with --live-cap 16 to allow it)"));
}

async function runPlace(c: Extract<Command, { kind: "place" }>) {
  const [facts, sights, months] = await Promise.all([call("place_facts", { city: c.name }), call("sights", { city: c.name }), call("best_months", { city: c.name })]);
  if (json({ facts, sights, months })) return;
  out(bold(c.name));
  for (const [k, v] of Object.entries(facts)) if (!["searched", "source", "raw"].includes(k) && v != null && typeof v !== "object") out(`${k}: ${cut(v, 120)}`);
  if (Array.isArray(months.best)) out(`best months: ${(months.best as string[]).join(", ")}`);
  // The guide's lists are lines ("Sé do Porto: This Romanesque cathedral ..."), one per listing.
  for (const [k, title] of [["see", "See"], ["do", "Do"], ["eat", "Eat"]] as const) {
    const list = sights[k] as string[] | undefined;
    if (!Array.isArray(list) || !list.length) continue;
    out("");
    out(bold(title));
    for (const line of list.slice(0, 6)) out(`  ${cut(line, 130)}`);
  }
  if (typeof sights.guideUrl === "string") out(dim(`guide: ${sights.guideUrl}`));
  const ev = eventsAt({ city: c.name }, today, plus(365));
  if (ev.length) {
    out("");
    table(["dates", "event worth the trip", "why"], ev.slice(0, 6).map((e) => [`${e.start} to ${e.end}`, e.name, e.why]));
  }
}

async function runItinerary(c: Extract<Command, { kind: "itinerary" }>) {
  if (!c.stops?.length) return out("Name the places and nights: atlas itinerary Lisbon 3 nights, Porto 2 nights from 14 Nov");
  const r = await call("make_itinerary", { stops: c.stops, ...(c.start ? { start: c.start } : {}), ...(c.from ? { origin: c.from } : {}) });
  if (json(r) || failed(r)) return;
  if (r.raw && typeof r.raw === "object") out(itineraryText(r.raw as Itinerary));
  else {
    out(bold(String(r.title ?? "Itinerary")));
    for (const d of (r.days as { day: number; date: string; where: string; title: string; plan: string }[]) ?? []) out(`Day ${d.day} ${d.date} ${d.where}: ${d.title}\n  ${d.plan}`);
  }
  out("");
  out(dim(`source: ${r.source}, ${r.searched} live searches`));
  notes(r);
}

async function runAsk(text: string) {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) return out("The agent needs a model key (AWS_BEARER_TOKEN_BEDROCK in .env.local).");
  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());
  const used: string[] = [];
  const t0 = Date.now();
  const r = await generateText({
    model,
    system: chatSystem(ctx),
    messages: [{ role: "user", content: text }],
    tools: atlasTools(ctx),
    stopWhen: [stepCountIs(10), hasToolCall("ask")],
    maxOutputTokens: 1400,
    onStepFinish: (step) => {
      for (const tc of step.toolCalls) if (tc) used.push(tc.toolName);
    },
  });
  if (JSON_OUT) return void out(JSON.stringify({ text: r.text, tools: used, steps: r.steps.length }, null, 2));
  out(r.text.trim() || dim("(no text; the agent asked a question through a widget)"));
  // The ask tool's widget, when the agent asked one: its question and choices, as text.
  for (const step of r.steps)
    for (const tr of step.toolResults)
      if (tr?.toolName === "ask") {
        const w = tr.output as { question?: string; options?: string[] };
        out(`\n? ${w.question ?? ""}${w.options?.length ? `  (${w.options.join(" / ")})` : ""}`);
      }
  out("");
  out(dim(`tools used: ${used.length ? used.join(", ") : "none"}; ${r.steps.length} steps; ${Math.round((Date.now() - t0) / 1000)} s`));
}

// ---------------------------------------------------------------------------------------
// atlas search: the one search (docs/plans/one-search.md), exactly as the Search tab and the chat's search tool run
// it. The words are read by the command line (parseCommand, then toSearchQuery, the shell's own path), the flags
// set what the words cannot say, and --query takes a whole SearchQuery as JSON. The run spends at most --live-cap
// searches (the query's budget); with 0 it answers from the nightly price graph and the fare memory.

const CITY_ROWS = Object.entries(citiesJson as unknown as Record<string, City>);
const COUNTRY_ROWS = Object.entries(countriesJson as unknown as Record<string, CountryInfo>);
const foldWord = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** A typed start as the search's `from`: the biggest city of that name and its airports. */
function cityHere(name: string): SearchHere | null {
  const q = foldWord(name);
  const hit = CITY_ROWS.filter(([, c]) => foldWord(c.name) === q || foldWord(c.name).startsWith(`${q} `)).sort((a, b) => (b[1].pop ?? 0) - (a[1].pop ?? 0))[0];
  return hit && hit[1].airports.length ? { label: hit[1].name, lat: hit[1].lat, lon: hit[1].lon, airports: hit[1].airports.slice(0, 4), home: "RO" } : null;
}
/** A typed destination: a region key or label, a country, else a place (the engines place it). */
function destinationOf(name: string): SearchQuery["to"] | null {
  const q = foldWord(name);
  const region = (Object.keys(REGIONS) as (keyof typeof REGIONS)[]).find((k) => k !== "custom" && (foldWord(k) === q || foldWord(REGIONS[k].label) === q));
  if (region) return { kind: "region", key: region };
  const country = COUNTRY_ROWS.find(([code, c]) => foldWord(c.name) === q || code.toLowerCase() === q);
  if (country && !CITY_ROWS.some(([, c]) => foldWord(c.name) === q)) return { kind: "country", name: country[1].name, code: country[0] };
  return null;
}
const dayFlag = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(flag(k) ?? "") ? flag(k)! : undefined);

/** The query this run searches: --query as given, else the words through the command line, then the flags. */
function searchQueryOf(text: string): { query: SearchQuery; from: string } | { error: string } {
  const here: SearchHere = { label: origin.label, lat: origin.lat, lon: origin.lon, airports: gateways.length ? gateways : ["OTP"], home: "RO" };
  let q: SearchQuery | null = null;
  let from = "the flags";
  const raw = flag("query");
  if (raw) {
    try {
      const p = parseSearchQuery(JSON.parse(raw));
      if ("error" in p) return { error: `--query: ${p.error}` };
      q = p.query;
      from = "--query";
    } catch {
      return { error: "--query must be a SearchQuery as JSON" };
    }
  } else if (text && !/^(?:anywhere|cheapest|the cheapest|anything)$/i.test(text)) {
    const ctxQ = { here, today, prefs, resolve: cityHere, destination: destinationOf };
    for (const c of parseCommand(text, today)) {
      const got = toSearchQuery(c, ctxQ);
      if (got) {
        q = got;
        from = `the words (${c.kind}: ${c.label})`;
        break;
      }
    }
    if (!q) return { error: `"${text}" is not a search the command line can read; say where and when with flags (--to, --window, --nights), or ask: atlas ask "${text}"` };
  }
  q ??= { from: here, to: { kind: "anywhere" }, when: { kind: "anytime" } };
  // The flags win over the words: what a line cannot say ("including the 26th") is said here.
  const to = flag("to");
  if (to) q.to = /^anywhere$/i.test(to) ? { kind: "anywhere" } : (destinationOf(to) ?? { kind: "place", name: to });
  const win = flag("window")?.split("..");
  if (dayFlag("out")) q.when = { kind: "dates", out: dayFlag("out")!, ...(dayFlag("back") ? { back: dayFlag("back")! } : {}) };
  else if (win && /^\d{4}-\d{2}-\d{2}$/.test(win[0] ?? "") && /^\d{4}-\d{2}-\d{2}$/.test(win[1] ?? "")) q.when = { kind: "window", from: win[0], to: win[1], ...(dayFlag("include") ? { include: dayFlag("include")! } : {}) };
  else if (/^\d{4}-\d{2}$/.test(flag("month") ?? "")) q.when = { kind: "month", month: flag("month")! };
  else if (dayFlag("include") && q.when.kind === "window") q.when = { ...q.when, include: dayFlag("include")! };
  const nights = flag("nights")?.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
  if (nights) q.nights = [Number(nights[1]), Number(nights[2] ?? nights[1])];
  if (flags.has("one-way")) q.oneWay = true;
  const shape = flag("shape");
  if (shape && ["any", "return", "two", "loop", "long"].includes(shape)) q.shape = shape as SearchQuery["shape"];
  const f = { ...q.filters };
  if (flags.has("direct")) f.direct = true;
  if (flags.has("trains")) f.trainsOk = true;
  if (flags.has("events")) f.eventsOn = true;
  const maxPrice = Number(flag("max-price"));
  if (maxPrice > 0) f.maxPrice = Math.round(maxPrice);
  const cities = Number(flag("cities"));
  if (cities === 1 || cities === 2 || cities === 3) f.cities = cities;
  if (Object.keys(f).length) q.filters = f;
  q.prefs = q.prefs ?? prefs;
  // The run's cap is the search's budget (the Search tab's route takes 0 to 60).
  q.budget = Math.min(60, LIVE_CAP);
  const checked = parseSearchQuery(q);
  if ("error" in checked) return { error: checked.error };
  return { query: { ...checked.query, prefs: q.prefs }, from };
}

const LEG_SIGN: Record<string, string> = { fly: "plane", train: "train", coach: "coach", ferry: "ferry", road: "drive", walk: "walk" };
async function runSearch(text: string) {
  const got = searchQueryOf(text);
  if ("error" in got) return out(`Could not: ${got.error}`);
  const q = got.query;
  if (!JSON_OUT) {
    out(dim(`query from ${got.from}: ${JSON.stringify({ to: q.to, when: q.when, nights: q.nights, shape: q.shape, oneWay: q.oneWay, filters: q.filters, advanced: q.advanced, budget: q.budget })}`));
  }
  let final: SearchFinal | null = null;
  for await (const ev of searchStream(q, 280_000)) {
    if ("progress" in ev) {
      if (!JSON_OUT) out(dim(`  ... ${ev.progress}`));
    } else final = ev.final;
  }
  if (!final) return out("The search ended without an answer.");
  if (JSON_OUT) return void out(JSON.stringify({ query: q, ...final }, null, 2));
  const where = q.to.kind === "anywhere" ? "anywhere" : q.to.kind === "region" ? q.to.key : q.to.name;
  out(bold(`${q.from.label} to ${where}: ${final.results.length} trip${final.results.length === 1 ? "" : "s"}, cheapest first`));
  if (!final.results.length) out("Nothing came back for this search.");
  final.results.slice(0, 12).forEach((t, i) => {
    out("");
    const dates = `${t.out}${t.back ? ` to ${t.back}` : ""}, ${t.nights} night${t.nights === 1 ? "" : "s"}`;
    out(`${i + 1}. ${bold(t.title)}  ${euro(t.price)}${t.groundPrice ? ` + ${euro(t.groundPrice)} ground (estimate)` : ""}  ${t.hours != null ? `${Math.round(t.hours)} h  ` : ""}${dates}${t.direct ? "  direct" : ""}  ${dim(`${t.source}, ${t.engine}`)}`);
    if (t.badges.length) out(dim(`   ${t.badges.join(", ")}`));
    const rows: string[] = [];
    let stop = 0;
    for (const g of t.legs) {
      rows.push(`${LEG_SIGN[g.kind] ?? g.kind}  ${g.fromName || g.from} to ${g.toName || g.to}${g.date ? `, ${g.date}` : ""}${g.depart ? ` ${g.depart.slice(-5)}` : ""}${g.minutes ? `, ${span(g.minutes)}` : ""}${g.price != null ? `, ${euro(g.price)}` : ""}${g.estimated ? " (estimate)" : ""}${g.carrier ? `, ${g.carrier}` : ""}${g.stops ? `, ${g.stops} stop${g.stops === 1 ? "" : "s"}` : ""}`);
      if (g.url) rows.push(dim(`  book: ${cut(g.url, 110)}`));
      if (g.kind !== "road" && g.kind !== "walk" && stop < t.stops.length) {
        const s = t.stops[stop++];
        rows.push(`stay  ${s.name}, ${s.country}, ${s.nights} night${s.nights === 1 ? "" : "s"} from ${s.arrive}`);
      }
    }
    rows.forEach((row, k) => out(`   ${k === rows.length - 1 ? "└─" : "├─"} ${row}`));
    for (const w of t.why.slice(0, 3)) out(dim(`   why: ${w}`));
  });
  out("");
  out(dim(`engines: ${final.engines.join(", ") || "none"}${final.graph ? "; the nightly price graph answered first" : ""}`));
  if (final.note) out(dim(`note: ${final.note}`));
}

function help() {
  out(bold("atlas: the command line of Atlas"));
  out("");
  // "/itinerary" alone means "what is on screen", which a terminal does not have; /style and /help are below.
  const rows = COMMAND_HINTS.filter((h) => !["/itinerary", "/style", "/help"].includes(h.example)).map((h) => [`atlas ${h.example.replace(/^\//, "")}`, h.what]);
  rows.push(["atlas search <words> [flags]", "the one search, as the Search tab and the chat run it: trips cheapest first"], ["atlas ask <question>", "one turn with the agent, which picks the tools"], ["atlas style", "the trip style this run uses"], ["atlas help", "this list"]);
  table(["try", "what it does"], rows, 48);
  out("");
  out("Flags: --from \"lat,lon,label\"  --airports OTP,SBZ  --live-cap N (default 12)  --today YYYY-MM-DD  --json  --all");
  out("Search: --to Lisbon  --out D --back D  --window D..D --include D  --month YYYY-MM  --nights 3-5  --one-way  --shape two|loop  --direct  --trains  --events  --cities N  --max-price N  --query JSON");
  out("Trip style: --nights-per-place 2-3  --pace slow|balanced|packed  --tradeoff price|balanced|comfort  --taste popular|unique|mixed  --avoid dach,DE  --max-flight-hours 8  --no-ground  --engine classic");
}

/** The trip style this run uses: the flags over the app's defaults, as the agent reads it. */
function style() {
  if (JSON_OUT) return void out(JSON.stringify(prefs, null, 2));
  out(bold(`Trip style${sameAsDefault(prefs) ? " (the defaults)" : ""}: ${prefsSummary(prefs)}`));
  out(prefsLine(prefs));
  out(dim(`wild loops are built by the ${ENGINE === "walk" ? "graph walk (the default)" : "classic chain"}`));
  if (!prefsGiven) out(dim("change it for one run with --nights-per-place 2-3, --taste unique, --tradeoff price, --avoid dach (see atlas help)"));
}

// ---------------------------------------------------------------------------------------

async function main() {
  const text = words.join(" ").trim();
  if (!text || /^(help|-h|--help|\?)$/i.test(text) || flags.has("help")) return help();
  if (/^ask\b/i.test(text)) return runAsk(text.replace(/^ask\s*/i, ""));
  if (/^search\b/i.test(text)) return runSearch(text.replace(/^search\s*/i, ""));
  // The words after `atlas` read like the top bar's line; "itinerary ..." and "events ..."
  // work as they are, and a leading verb that names a slash command is read as one.
  const line = /^(route|events|getaways|wild|stay|place|itinerary|loop|walk|style|prefs|settings)\b/i.test(text) && !/^(events|itinerary)\b/i.test(text) ? `/${text}` : text;
  const list = parseCommand(line, today);
  if (flags.has("all")) {
    out(dim("suggestions:"));
    list.forEach((c, i) => out(dim(`  ${i + 1}. ${c.kind}: ${c.label}`)));
    out("");
  }
  const c = list[0];
  if (!JSON_OUT) out(dim(`> ${c.label}`));
  switch (c.kind) {
    case "route":
      return runRoute(c);
    case "events":
      return runEvents(c);
    case "getaways":
      return runGetaways(c);
    case "wild":
      return runWild(c);
    case "longstay":
      return runLongStay(c);
    case "place":
      return runPlace(c);
    case "itinerary":
      return runItinerary(c);
    case "walk":
      return runWalk(c);
    case "prefs":
      return style();
    case "help":
      return help();
    case "ask":
      return runAsk(c.text);
  }
}

main()
  .then(() => {
    const st = kiwiStats();
    if (!JSON_OUT) out(dim(`Kiwi searches this run: ${st.today - kiwiAtStart} (cap ${LIVE_CAP})`));
    process.exit(0);
  })
  .catch((err) => {
    console.error(`atlas failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
