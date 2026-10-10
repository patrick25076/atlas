// Shared by the chat route and the chat panel: the widget the agent can ask for instead of
// a prose question, the short message a widget answer becomes, the labels and progress
// lines of each tool, and the follow-up chips per tool. No server imports: the browser
// bundles this file too.

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
  ask: "One question",
};

/** The tools that can take a while: their chip shows the seconds elapsed while they run. */
export const LONG_TOOLS = new Set(["wild_trip", "long_stay", "group_trip", "plan_days", "find_getaways", "scan_cheapest", "cheapest_way", "two_city_combos", "events_worth_travelling_for"]);

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
      case "wild_trip":
        return `Building a ${a.nights ?? 14} night loop in ${a.region ?? "the region"}${skipping} (a minute or two)`;
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
      case "plan_days":
        return "Planning the days (about a minute)";
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
  find_getaways: ["Direct flights only", "Try my other airports too", "Two-city version", "What do I eat there?", "Hotels for those dates"],
  cheapest_deals: ["Warm places only", "Hidden gems", "Direct flights only", "Next month instead", "Two-city version"],
  reprice_route: ["A day earlier or later", "Make it a week", "Is this a good price?", "Hotels for those dates"],
  wild_trip: ["Plan the days", "Cheaper version", "Fewer stops, longer stays", "Skip the hub", "Show two variants"],
  long_stay: ["Cheaper bases", "Nearer the beach", "What would a month cost there?", "Flights for the first base"],
  group_trip: ["Only windows where everyone can", "Direct flights only", "Try a warmer place", "What do we do there?"],
  plan_days: ["Make it cheaper", "More food, fewer museums", "Hotels for the first stop"],
  sights: ["What do I eat there?", "What's on while I am there?", "Hotels for those dates"],
  best_months: ["Scan prices for the best month", "Cheaper month instead"],
  price_insight: ["Show the cheapest month", "Try a nearby airport"],
  hotel_deals: ["Flights to the first one", "Only in Europe", "What do I do there?"],
  cheapest_way: ["Show the route on the globe", "Fastest instead", "A week later", "One way only", "Is this a good price?"],
  default: ["Direct flights only", "Try my other airports too", "Two-city version", "What do I eat there?", "Hotels for those dates"],
};
