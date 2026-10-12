// Shared by the chat route and the chat panel: the widget the agent can ask for instead of
// a prose question, the short message a widget answer becomes, the labels and progress
// lines of each tool, and the follow-up chips per tool. No server imports: the browser
// bundles this file too.
//
// Also the UI event bus as the chat uses it: the detail of each `atlas:*` event the chat
// dispatches (a computed route, an itinerary to open, a command line to run, a route to
// search), built by plain functions so scripts/check-tools.ts can check their shapes.
import type { RouteResult } from "./route-finder";
import type { BudgetTier, Itinerary, Pace, Skeleton } from "./itinerary";
import type { WalkLoop, WalkResult } from "./graph-walk";
import type { Command } from "./command";
import type { Prefs } from "./prefs";

export type WidgetKind = "dates" | "month" | "nights" | "region" | "choices" | "people" | "map-region" | "map-place";

/** What the ask tool takes and returns: the chat renders it as an interactive component. */
export type WidgetSpec = {
  kind: WidgetKind;
  question: string;
  options?: string[];
  defaults?: Record<string, unknown>;
};

export const WIDGET_KINDS: WidgetKind[] = ["dates", "month", "nights", "region", "choices", "people", "map-region", "map-place"];

/** A row of the people editor (group trips). */
export type PersonRow = { name: string; origin: string; from: string; to: string };

export const ISO_DAY = (d: Date) => d.toISOString().slice(0, 10);
export const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (iso: string, n: number) => ISO_DAY(new Date(Date.parse(iso) + n * 86_400_000));
/** The visitor's calendar day, from the browser's local clock: late in the evening in Bucharest
 * it is still "yesterday" in UTC, and a date picker whose minimum is yesterday looks wrong. */
export const LOCAL_DAY = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The quick chips of the date widget: concrete ranges the agent can act on at once. `today`
 * is a YYYY-MM-DD calendar day (the visitor's local one); the arithmetic runs on UTC noon so
 * no daylight-saving change moves a day. */
export function quickDateRanges(today: string): { label: string; from: string; to: string }[] {
  // One base day for everything below: a caller that hands in something that is not a day
  // (a stored value, a model's guess) gets the local day, never a RangeError from addDays.
  const base = ISO_DAY_RE.test(today) ? today : LOCAL_DAY(new Date());
  const d = new Date(base + "T12:00:00Z");
  const dow = d.getUTCDay();
  const toFri = (5 - dow + 7) % 7 || 7;
  const fri = addDays(base, toFri);
  const nextMon = addDays(base, ((8 - dow) % 7) || 7);
  const m1 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const m1End = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  const monthName = m1.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return [
    { label: "This weekend", from: fri, to: addDays(fri, 2) },
    { label: "Next week", from: nextMon, to: addDays(nextMon, 6) },
    { label: monthName, from: ISO_DAY(m1), to: ISO_DAY(m1End) },
    { label: "Anytime", from: "", to: "" },
  ];
}

/** The nights chips, when the agent gives no options. */
export const NIGHT_OPTIONS = ["2 to 3", "3 to 5", "5 to 7", "7 to 14", "14 to 21", "a month or more"];

/** Formats a widget answer as the short message the chat sends on the traveller's behalf. */
export function widgetAnswer(kind: WidgetKind, value: unknown): string {
  switch (kind) {
    case "dates": {
      const v = value as { from?: string; to?: string; label?: string };
      if (!v.from && !v.to) return "Dates: anytime";
      if (v.from && v.to) return `Dates: ${v.from} to ${v.to}`;
      return `Dates: from ${v.from || v.to}`;
    }
    case "month":
      return `Month: ${String(value)}`;
    case "nights":
      return `Nights: ${String(value)}`;
    case "region":
    case "map-region":
      return `Region: ${String(value)}`;
    case "map-place":
      return `Place: ${String(value)}`;
    case "people": {
      // Rows come from the widget, but a prefilled row may carry anything the model sent.
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
      const rows = (Array.isArray(value) ? value : [])
        .filter((r): r is Partial<PersonRow> => !!r && typeof r === "object")
        .map((r) => ({ name: str(r.name), origin: str(r.origin), from: str(r.from), to: str(r.to) }))
        .filter((r) => r.name);
      // A city keeps its spelling (Brașov, Iași); only a three-letter code is upper-cased.
      const place = (o: string) => (/^[A-Za-z]{3}$/.test(o) ? o.toUpperCase() : o) || "?";
      return "People: " + rows.map((r) => `${r.name} from ${place(r.origin)}${r.from && r.to ? ` free ${r.from} to ${r.to}` : r.from ? ` free from ${r.from}` : ""}`).join("; ");
    }
    case "choices":
    default:
      return String(value);
  }
}

/** The label of a tool chip while it runs and once it is done. */
export const TOOL_LABEL: Record<string, string> = {
  home_airports: "Looking at your airports",
  cheapest_deals: "Reading tonight's prices",
  find_getaways: "Searching live for your dates",
  reprice_route: "Pricing the route live",
  two_city_combos: "Checking two-city combos",
  wild_trip: "Building the loop",
  plan_days: "Planning the days",
  sights: "Reading the guide",
  events_near: "Checking what's on",
  events_worth_travelling_for: "Finding events worth the trip",
  eats_near: "Checking rated restaurants",
  hotels_near: "Checking hotel prices",
  hotel_deals: "Checking where hotels are cheap",
  oneway_fares: "Reading one-way fares",
  ground_reach: "Checking trains and coaches",
  place_facts: "Looking up the facts",
  web_search: "Searching the web",
  stopover_programmes: "Checking stopover programmes",
  fare_history: "Reading the fare memory",
  scan_cheapest: "Scanning month by month",
  long_stay: "Pricing long stays",
  group_trip: "Matching the group",
  best_months: "Reading the climate",
  price_insight: "Checking the fare memory",
  cheapest_way: "Finding the cheapest way",
  walk_trips: "Walking the cheapest hops",
  make_itinerary: "Writing the itinerary",
  ask: "One question",
};

/** The tools that can take a while: their chip shows the seconds elapsed while they run. */
export const LONG_TOOLS = new Set(["wild_trip", "long_stay", "group_trip", "plan_days", "find_getaways", "scan_cheapest", "cheapest_way", "walk_trips", "two_city_combos", "events_worth_travelling_for", "make_itinerary"]);

/** A short word for each kind of route option, for the badge on its card. */
export const ROUTE_KIND_LABEL: Record<string, string> = {
  direct: "direct",
  "nearby-airports": "nearby airport",
  "ground-then-fly": "train, then fly",
  "fly-then-ground": "fly, then train",
  "via-hub": "two tickets via a hub",
  "open-jaw": "open-jaw",
  "ground-only": "train or coach",
};

/** A progress line built from a tool's input, shown while the tool runs. */
export function toolProgress(name: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "string" ? v : "");
  // The Been filter rides along as `exclude` only when the model passes it by hand (the
  // context default is invisible here); when it does, the line says the search skips them.
  // The suffix goes on every tool's line, once, so the same input reads the same everywhere.
  const skipping = Array.isArray(a.exclude) && a.exclude.length ? ` (skipping ${a.exclude.length} countr${a.exclude.length === 1 ? "y" : "ies"} you have been to)` : "";
  const line = (() => {
    switch (name) {
      case "scan_cheapest":
        return `Searching ${a.months ?? 6} months${a.origins ? ` from ${list(a.origins)}` : ""} to ${a.to ?? "there"}${a.openJawFrom ? `, then open-jaw via ${a.openJawFrom}` : ""}`;
      case "find_getaways":
        return `Searching ${a.where && a.where !== "anywhere" ? a.where : "anywhere"}, ${a.from ?? ""} to ${a.to ?? ""}${a.minNights || a.maxNights ? `, ${a.minNights ?? 2} to ${a.maxNights ?? 7} nights` : ""}`;
      case "reprice_route":
        return `Pricing ${a.from ?? ""} to ${a.to ?? ""} around ${a.depart ?? ""}`;
      case "wild_trip": {
        const nps = a.nightsPerStop ? `, ${a.nightsPerStop}${a.nightsPerStopMax ? ` to ${a.nightsPerStopMax}` : ""} nights a place` : "";
        const how = a.engine === "classic" ? "" : ", walking the cheapest hops";
        return `Building a ${a.nights ?? 14} night loop in ${a.region ?? "the region"}${nps}${how}${skipping} (a minute or two)`;
      }
      case "long_stay":
        return `Pricing ${a.months ?? 2} month stays in ${a.region ?? list(a.countries) ?? "the region"}`;
      case "group_trip":
        return `Matching ${Array.isArray(a.members) ? a.members.length : "the"} people's dates and airports`;
      case "price_insight":
        return `Checking what ${a.from ?? ""} to ${a.to ?? ""} usually costs in ${a.month ?? "that month"}`;
      case "best_months":
        return `Reading the climate of ${a.city ?? "the place"}`;
      case "cheapest_deals":
        return `Reading tonight's prices${a.month ? ` for ${a.month}` : ""}`;
      case "web_search":
        return `Searching the web: ${String(a.query ?? "").slice(0, 60)}`;
      case "hotel_deals":
        return `Reading the hotel snapshots${a.country ? ` for ${a.country}` : ""}`;
      case "cheapest_way":
        return `Checking every way ${a.from ? `from ${a.from} ` : ""}to ${a.to ?? "there"}${a.depart ? ` around ${a.depart}` : ""}: nearby airports, trains to a bigger airport, hubs, open-jaw`;
      case "two_city_combos":
        return `Pricing two-city versions around ${a.city ?? a.dst ?? "the city"}`;
      case "walk_trips": {
        const must = list(a.mustInclude);
        const avoid = list(a.avoid);
        const nps = a.nightsPerStop ? `, ${a.nightsPerStop}${a.nightsPerStopMax ? ` to ${a.nightsPerStopMax}` : ""} nights a place` : "";
        return `Walking the cheapest hops${a.origin ? ` from ${a.origin}` : ""}${must ? ` through ${must}` : ""}${a.from && a.to ? `, ${a.from} to ${a.to}` : ""}${nps}: anywhere from home, the next hop by plane, train or coach, then home${avoid ? `, not ${avoid}` : ""}${a.style === "unique" ? ", off the beaten track" : ""}`;
      }
      case "plan_days":
        return "Planning the days (about a minute)";
      case "make_itinerary": {
        const stops = Array.isArray(a.stops) ? (a.stops as { place?: unknown; nights?: unknown }[]).map((x) => `${String(x?.place ?? "")}${x?.nights ? ` ${x.nights}n` : ""}`).filter(Boolean).join(", ") : "";
        const what = stops || ({ last_route: "the route", last_deal: "the deal", last_wild: "the loop" } as Record<string, string>)[String(a.from ?? "")] || "the trip";
        return `Writing the days of ${what}${a.pace ? `, ${a.pace} pace` : ""} (about a minute)`;
      }
      default:
        return TOOL_LABEL[name] ?? name;
    }
  })();
  // The wild line already placed the suffix before its "(a minute or two)" aside.
  return `${line}${name === "wild_trip" ? "" : skipping}...`;
}

/** Follow-up chips, chosen from the last tool the agent used. */
export const FOLLOWUPS: Record<string, string[]> = {
  scan_cheapest: ["Show the best month in detail", "Direct or one stop only", "Try my other airports", "Fewer nights", "Is this a good price?"],
  find_getaways: ["Make the first one an itinerary", "Direct flights only", "Try my other airports too", "Two-city version", "Hotels for those dates"],
  cheapest_deals: ["Warm places only", "Hidden gems", "Direct flights only", "Next month instead", "Two-city version"],
  reprice_route: ["A day earlier or later", "Make it a week", "Is this a good price?", "Hotels for those dates"],
  wild_trip: ["Make it an itinerary", "Cheaper version", "Fewer stops, longer stays", "Skip the hub", "Show two variants"],
  long_stay: ["Cheaper bases", "Nearer the beach", "What would a month cost there?", "Flights for the first base"],
  group_trip: ["Only windows where everyone can", "Direct flights only", "Try a warmer place", "What do we do there?"],
  plan_days: ["Make it cheaper", "More food, fewer museums", "Hotels for the first stop"],
  sights: ["What do I eat there?", "What's on while I am there?", "Hotels for those dates"],
  best_months: ["Scan prices for the best month", "Cheaper month instead"],
  price_insight: ["Show the cheapest month", "Try a nearby airport"],
  hotel_deals: ["Flights to the first one", "Only in Europe", "What do I do there?"],
  cheapest_way: ["Make it an itinerary", "Fastest instead", "A week later", "One way only", "Is this a good price?"],
  walk_trips: ["Make the first loop an itinerary", "One more city", "Smaller places, fewer hubs", "Trains between cities where they exist", "A week later"],
  make_itinerary: ["Slower pace", "More food, fewer museums", "Make it cheaper", "Hotels for the first stop"],
  events_worth_travelling_for: ["Get to the first one", "Only in Europe", "Make the first one an itinerary", "Next month instead"],
  default: ["Direct flights only", "Try my other airports too", "Two-city version", "What do I eat there?", "Hotels for those dates"],
};

// ---------------------------------------------------------------------------------------
// The UI event bus, as the chat speaks it (the globe and the shell listen).

/** `atlas:route`: search the cheapest way and draw it. */
export type RouteDetail = { from?: string; to: string; depart?: string; nights?: number; flex?: number; oneWay?: boolean };
/** `atlas:route-result`: draw a result already computed (no search). */
export type RouteResultDetail = { result: RouteResult; option?: number };
/** `atlas:itinerary`: open the itinerary view; with only a skeleton it generates. */
export type ItineraryDetail = { skeleton?: Skeleton; itinerary?: Itinerary; wishes?: string; pace?: Pace; budget?: BudgetTier };
/** `atlas:command`: run a line through the command bar (lib/command.ts). */
export type CommandDetail = { text: string };
/** `atlas:place`: open a place page. */
export type PlaceDetail = { name?: string; code?: string };

/**
 * The /api/walk query as an object (the shell turns it into the URL's search params): what
 * `atlas:walk` carries and what a walk result says it was asked. Lists are comma strings, as
 * the route reads them; nightsPerStop is "2" or "2-3". Only g, home, lat, lon, label, from and
 * to are always there; the rest are the route's defaults when absent.
 */
export type WalkQuery = {
  g: string;
  home: string;
  lat: number;
  lon: number;
  label: string;
  from: string;
  to: string;
  minNights?: number;
  maxNights?: number;
  nightsPerStop?: string;
  maxStops?: number;
  beam?: number;
  budget?: number;
  ground?: number;
  tradeoff?: string;
  exclude?: string;
  mustInclude?: string;
  avoid?: string;
  prefer?: string;
  countries?: string;
  style?: string;
};
/** `atlas:walk`: run a graph walk in the shell and draw it live, edge by edge. */
export type WalkDetail = { params: WalkQuery };
/** `atlas:walk-result`: draw a finished walk without searching; the first loop is the one shown. */
export type WalkResultDetail = { result: WalkResult; params?: WalkQuery };
/** One line of a walk as /api/walk streams it, for a walk that runs somewhere else than the globe. */
export type WalkLiveLine =
  | { node: { code: string; name: string; lat: number; lon: number; date: string; depth: number; cost: number } }
  | { edge: { from: string; to: string; toName: string; lat: number; lon: number; kind: WalkLoop["legs"][number]["kind"]; price: number; minutes: number; source: string; chosen?: boolean; home?: boolean } }
  | { loop: WalkLoop };
/**
 * `atlas:walk-live`: the lines of a walk the chat runs (walk_trips), drawn as they arrive, the same lines
 * `atlas:walk` reads from /api/walk. `id` is the walk's own (the tool call): a new id starts a new drawing at
 * `params` (the home point and the window); the same id adds to it. `atlas:walk-result` ends it.
 */
export type WalkLiveDetail = { id: string; params?: WalkQuery; lines: WalkLiveLine[] };

export type AtlasEventMap = {
  "atlas:route": RouteDetail;
  "atlas:route-result": RouteResultDetail;
  "atlas:itinerary": ItineraryDetail;
  "atlas:command": CommandDetail;
  "atlas:place": PlaceDetail;
  "atlas:walk": WalkDetail;
  "atlas:walk-result": WalkResultDetail;
  "atlas:walk-live": WalkLiveDetail;
};

/** Sends one event on the window bus; a no-op on the server. */
export function dispatchAtlas<K extends keyof AtlasEventMap>(name: K, detail: AtlasEventMap[K]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** The detail that draws a computed cheapest_way result; `option` is the card's index when one card asked. */
export function routeResultDetail(result: RouteResult, option?: number): RouteResultDetail {
  return option != null && option >= 0 && option < result.options.length ? { result, option } : { result };
}

/** The detail that searches a route again (a restored thread has no computed result to draw). */
export function routeDetail(out: { from?: string; to: string; depart?: string; flex?: number; nights?: number | null }): RouteDetail {
  return { ...(out.from ? { from: out.from } : {}), to: out.to, ...(out.depart ? { depart: out.depart } : {}), ...(out.flex != null ? { flex: out.flex } : {}), ...(out.nights != null ? { nights: out.nights } : {}), oneWay: out.nights == null };
}

// ---------------------------------------------------------------------------------------
// The graph walk on the bus: the same window defaults and query for the chat tool
// (walk_trips), the command line's walk kind and the shell's `atlas:walk`.

/** The longest trip a walk searches, and how far ahead (the route refuses past a year). */
const WALK_MAX_NIGHTS = 30;
const WALK_MAX_DAYS_OUT = 366;
/** When nothing is said: leave in a week, and give the window a week of slack past the stay so
 * the "anywhere" search (one call over the whole range, like Skyscanner Explore) has days to pick from. */
const WALK_LEAD_DAYS = 7;
const WALK_SLACK_DAYS = 7;
const posInt = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
};

/**
 * The window and nights a walk searches, from what was said (any may be missing), with one
 * plain line per assumption so the answer can state it. `today` is the traveller's calendar
 * day. The window never starts before today, never ends before it starts, always holds
 * minNights, and ends within a year.
 */
export function walkWindow(ask: { from?: string | null; to?: string | null; minNights?: number | null; maxNights?: number | null }, today: string): { from: string; to: string; minNights: number; maxNights: number; notes: string[] } {
  const base = ISO_DAY_RE.test(today) ? today : LOCAL_DAY(new Date());
  const notes: string[] = [];
  const askMin = posInt(ask.minNights);
  const askMax = posInt(ask.maxNights);
  const minNights = Math.min(WALK_MAX_NIGHTS, askMin ?? (askMax ? Math.min(askMax, 5) : 5));
  const maxNights = Math.min(WALK_MAX_NIGHTS, Math.max(minNights, askMax ?? (askMin ? minNights : 6)));
  if (!askMin && !askMax) notes.push(`no length given; searched ${minNights} to ${maxNights} nights`);
  let from = ask.from && ISO_DAY_RE.test(ask.from) ? ask.from : "";
  let to = ask.to && ISO_DAY_RE.test(ask.to) ? ask.to : "";
  if (!from) {
    from = addDays(base, WALK_LEAD_DAYS);
    notes.push(`no dates given; searched from ${from}, a week out`);
  } else if (from < base) {
    notes.push(`the start ${from} is in the past; searched from today (${base})`);
    from = base;
  }
  // An end already past is no end (the start was moved to today above); an end before a start in the future is
  // the two typed the wrong way round. Each note names the window the walk then really searched.
  if (to && to < base) {
    notes.push(`the end ${to} is in the past; it was dropped`);
    to = "";
  } else if (to && to < from) {
    const typed = `${from} to ${to}`;
    [from, to] = [to, from];
    notes.push(`the window ${typed} ends before it starts; read as ${from} to ${to}`);
  }
  if (!to) {
    to = addDays(from, maxNights + WALK_SLACK_DAYS);
    if (ask.from) notes.push(`no end given; searched ${from} to ${to}`);
  }
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  if (span < minNights) {
    to = addDays(from, maxNights);
    notes.push(`the window was shorter than ${minNights} nights; widened to ${from} to ${to}`);
  }
  const last = addDays(base, WALK_MAX_DAYS_OUT);
  if (to > last) {
    to = last;
    notes.push(`the window ends a year out at most; cut to ${to}`);
  }
  return { from, to, minNights, maxNights, notes };
}

/** One walk's parameters, as resolved values, turned into the /api/walk query object. */
export function walkQuery(p: {
  gateways: string[];
  home: string;
  lat: number;
  lon: number;
  label: string;
  from: string;
  to: string;
  minNights?: number;
  maxNights?: number;
  nightsPerStop?: number | [number, number];
  maxStops?: number;
  beam?: number;
  budget?: number;
  ground?: number;
  tradeoff?: string;
  exclude?: string[];
  mustInclude?: string[];
  avoid?: string[];
  prefer?: string[];
  countries?: string[];
  style?: string;
}): WalkQuery {
  const list = (v: string[] | undefined) => (v?.length ? v.map((x) => String(x).trim()).filter(Boolean).join(",") : "");
  const nps = p.nightsPerStop == null ? "" : Array.isArray(p.nightsPerStop) ? (p.nightsPerStop[0] === p.nightsPerStop[1] ? String(p.nightsPerStop[0]) : `${p.nightsPerStop[0]}-${p.nightsPerStop[1]}`) : String(p.nightsPerStop);
  const q: WalkQuery = { g: p.gateways.join(","), home: p.home, lat: Math.round(p.lat * 1000) / 1000, lon: Math.round(p.lon * 1000) / 1000, label: p.label, from: p.from, to: p.to };
  if (p.minNights) q.minNights = p.minNights;
  if (p.maxNights) q.maxNights = p.maxNights;
  if (nps) q.nightsPerStop = nps;
  if (p.maxStops) q.maxStops = p.maxStops;
  if (p.beam) q.beam = p.beam;
  if (p.budget != null) q.budget = p.budget;
  // 0 is a real value here (flights only), so the limit goes in whenever it was given.
  if (p.ground != null) q.ground = p.ground;
  if (p.tradeoff) q.tradeoff = p.tradeoff;
  for (const k of ["exclude", "mustInclude", "avoid", "prefer", "countries"] as const) {
    const v = list(p[k]);
    if (v) q[k] = v;
  }
  if (p.style) q.style = p.style;
  return q;
}

/** Where a walk starts: the traveller's point, airports (IATA) and home country. */
export type WalkHere = { lat: number; lon: number; label: string; gateways: string[]; home: string };

/**
 * The `atlas:walk` detail for a command line's walk (lib/command.ts): the window defaults of
 * walkWindow, the traveller's point and airports from `here`. A named start ("loop from Cluj")
 * is placed by `resolve` (the shell knows the cities file; this file does not); when it cannot
 * be placed, or no resolver is given, the walk starts from `here` and the label says so.
 * `prefs` (the traveller's trip style, lib/prefs.ts) fills what the line did not say: nights a
 * place, the tradeoff, "unique" for that taste, the places to avoid (added to the line's own),
 * and trains and coaches; the words typed win, the way the chat's walk_trips reads them.
 */
export function walkCommandQuery(c: Extract<Command, { kind: "walk" }>, here: WalkHere, today: string, resolve?: (name: string) => WalkHere | null, prefs?: Prefs): { params: WalkQuery; notes: string[] } {
  const win = walkWindow({ from: c.from, to: c.to, minNights: c.minNights, maxNights: c.maxNights }, today);
  const named = c.origin && c.origin.trim().toLowerCase() !== here.label.trim().toLowerCase() ? (resolve?.(c.origin) ?? null) : null;
  const start = named ?? here;
  const notes = [...win.notes, ...(c.origin && !named && c.origin.trim().toLowerCase() !== here.label.trim().toLowerCase() ? [`${c.origin} could not be placed; the loop starts from ${here.label}`] : [])];
  const nightsPerStop = c.nightsPerStop ?? prefs?.nightsPerPlace;
  const avoid = [...new Set([...(c.avoid ?? []), ...(prefs?.avoid ?? [])])];
  const style = c.style ?? (prefs?.taste === "unique" ? "unique" : undefined);
  // The command carries the ground limit in minutes already (480 for trains between places, 0 for flights only).
  const ground = c.ground ?? (prefs && !prefs.groundOk ? 0 : undefined);
  const params = walkQuery({ gateways: start.gateways, home: start.home, lat: start.lat, lon: start.lon, label: start.label, from: win.from, to: win.to, minNights: win.minNights, maxNights: win.maxNights, nightsPerStop, maxStops: c.maxStops, mustInclude: c.mustInclude, avoid, countries: c.countries, style, ...(ground != null ? { ground } : {}), ...(prefs && prefs.tradeoff !== "price" ? { tradeoff: prefs.tradeoff } : {}) });
  return { params, notes };
}

/** The detail that draws a finished walk; `loop` moves that loop to the front (the one the globe shows first). */
export function walkResultDetail(result: WalkResult, loop?: number, params?: WalkQuery): WalkResultDetail {
  const ordered = loop != null && loop > 0 && loop < result.loops.length ? { ...result, loops: [result.loops[loop], ...result.loops.filter((_, i) => i !== loop)] } : result;
  return params ? { result: ordered, params } : { result: ordered };
}

/** One event as events_worth_travelling_for compacts it. */
export type ChatEvent = { event: string; city: string; code?: string; country?: string; start?: string; end?: string; dates?: string; lat?: number; lon?: number; url?: string };

/** The event's first and last day, from its fields or its "a to b" dates line. */
export function eventDays(e: ChatEvent): { start: string; end: string } | null {
  const [a, b] = String(e.dates ?? "").split(" to ");
  const start = e.start ?? a;
  const end = e.end ?? b ?? start;
  return start && ISO_DAY_RE.test(start) ? { start, end: end && ISO_DAY_RE.test(end) ? end : start } : null;
}

/** "Show on the map": the command line that lists this event's place and days on the globe. */
export function eventCommand(e: ChatEvent): CommandDetail {
  const days = eventDays(e);
  return { text: `/events ${e.city}${days ? ` ${days.start} to ${days.end}` : ""}` };
}

/**
 * The days a trip to the event can use: an event already under way (or starting today) is
 * joined from tomorrow, the earliest day anyone can still fly, so neither "Get there" nor
 * "Make an itinerary" starts in the past. The card still shows the event's own dates.
 * `today` is the visitor's calendar day (LOCAL_DAY in the browser).
 */
export function eventTripDays(e: ChatEvent, today: string = LOCAL_DAY(new Date())): { start: string; end: string } | null {
  const days = eventDays(e);
  if (!days) return null;
  const earliest = addDays(ISO_DAY_RE.test(today) ? today : LOCAL_DAY(new Date()), 1);
  const start = days.start < earliest ? earliest : days.start;
  return { start, end: days.end < start ? start : days.end };
}

/**
 * "Get there": the cheapest way to the event's city, arriving on its first day (or tomorrow,
 * when it is already on) and staying to its last, two nights at least. A season or a run of
 * more than five days (Christmas markets, the northern lights) gets four nights, the same
 * stay skeletonFromEvent plans, so the fare and the itinerary describe one trip.
 */
export function eventRoute(e: ChatEvent, today?: string): RouteDetail {
  const days = eventTripDays(e, today);
  if (!days) return { to: e.city };
  const span = Math.round((Date.parse(days.end) - Date.parse(days.start)) / 86_400_000) || 0;
  const nights = span > 5 ? 4 : Math.max(2, span);
  return { to: e.city, depart: days.start, nights, flex: 1 };
}
