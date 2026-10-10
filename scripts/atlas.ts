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
//   atlas itinerary Lisbon 3 nights from 2026-11-14
//   atlas ask "is Porto nice in October"
//   atlas help
// Flags:
//   --from "lat,lon,label"   where you are (default Brașov, 45.657,25.601)
//   --airports OTP,SBZ       the airports searched nightly (default GHV,SBZ,OTP)
//   --live-cap N             the most Kiwi searches this run may make (default 12)
//   --today YYYY-MM-DD       the calendar day the words are read against (default today)
//   --json                   print the raw tool answer instead of the tables
//   --all                    print every suggestion parseCommand made, then run the first
//
// Kiwi throttles an address after bursts, so the cap is real: it is the turn budget the tools
// spend from, and a command whose usual cost is above it runs from stored data instead.
import { generateText, hasToolCall, stepCountIs } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { atlasTools, chatContext, chatSystem, type AgentContext } from "../lib/agent-tools";
import { COMMAND_HINTS, parseCommand, type Command } from "../lib/command";
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
const VALUED = new Set(["from", "airports", "live-cap", "today"]);
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

const ctx: AgentContext = chatContext({ origin, gateways, home: "RO", today });
ctx.budget = { used: 0, max: LIVE_CAP };
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
  for (const k of ["corrected", "note", "unplaced", "beenFilter"]) if (typeof r[k] === "string") out(dim(`${k}: ${String(r[k]).replace(/,? say so$/, "")}`));
}

async function call(name: string, input: unknown): Promise<Record<string, unknown>> {
  const t = tools[name];
  if (!t?.execute) return { error: `the tool ${name} is not available here (a key may be missing)` };
  const r = await t.execute(input, { toolCallId: `cli-${name}`, messages: [] });
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

async function runWild(c: Extract<Command, { kind: "wild" }>) {
  // A build is about sixty searches: under that cap only a stored loop can answer.
  if (LIVE_CAP < 60 && ctx.budget) ctx.budget.used = ctx.budget.max;
  const r = await call("wild_trip", { region: c.countries?.length ? "custom" : (c.region ?? "sea"), ...(c.countries?.length ? { countries: c.countries } : {}), ...(c.nights ? { nights: c.nights } : {}) });
  if (json(r) || failed(r)) return;
  printTrip(r);
  if (LIVE_CAP < 60) out(dim(`(building a new loop costs about 60 Kiwi searches; run with --live-cap 60 to allow it)`));
}
/** A wild trip as wild_trip summarises it: the stops and legs are lines already. */
function printTrip(r: Record<string, unknown>) {
  if (r.title) out(bold(`${r.title}${r.dates ? `, ${r.dates}` : ""}`));
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

function help() {
  out(bold("atlas: the command line of Atlas"));
  out("");
  // "/itinerary" alone means "what is on screen", which a terminal does not have.
  const rows = COMMAND_HINTS.filter((h) => h.example !== "/itinerary").map((h) => [`atlas ${h.example}`, h.what]);
  rows.push(["atlas ask <question>", "one turn with the agent, which picks the tools"], ["atlas help", "this list"]);
  table(["try", "what it does"], rows, 48);
  out("");
  out("Flags: --from \"lat,lon,label\"  --airports OTP,SBZ  --live-cap N (default 12)  --today YYYY-MM-DD  --json  --all");
}

// ---------------------------------------------------------------------------------------

async function main() {
  const text = words.join(" ").trim();
  if (!text || /^(help|-h|--help|\?)$/i.test(text) || flags.has("help")) return help();
  if (/^ask\b/i.test(text)) return runAsk(text.replace(/^ask\s*/i, ""));
  // The words after `atlas` read like the top bar's line; "itinerary ..." and "events ..."
  // work as they are, and a leading verb that names a slash command is read as one.
  const line = /^(route|events|getaways|wild|stay|place|itinerary)\b/i.test(text) && !/^(events|itinerary)\b/i.test(text) ? `/${text}` : text;
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
