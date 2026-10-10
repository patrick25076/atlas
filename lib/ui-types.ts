// Types the globe, the panel and the top bar share. Kept apart so the components do not
// import each other for a type.
import type { BoardMeta } from "./boards-client";
import type { Deal } from "./types";
import type { WalkLeg, WalkLoop, WalkResult } from "./graph-walk";

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "ip" | "default" | "search" };

/** "wild" stays a valid view for old links; the globe maps it to the Trips tab in Wild mode. */
export type View = "chat" | "deals" | "all" | "fly" | "ground" | "trips" | "wild";

/**
 * The modes of the Trips tab: the trip builders only. "A to B" and "events worth flying for"
 * used to be modes here; they are capabilities now (the command line, the route card on the
 * map, the Events layer, "Get there" on every place), so they are not tied to one tab.
 */
export type TripMode = "short" | "wild" | "longstay" | "group";
export const TRIP_MODES: { key: TripMode; label: string; hint: string }[] = [
  { key: "short", label: "Short loops", hint: "fly out, hop by train, fly home: 2 to 21 nights" },
  { key: "wild", label: "Wild loops", hint: "a far region or your own countries, many stops, live fares" },
  { key: "longstay", label: "Long stay", hint: "one base for a month or more, priced all in" },
  { key: "group", label: "Group", hint: "friends from different cities meet somewhere cheap" },
];
/** The region key that means "custom countries" in the Wild form (WILD_REGIONS has no chip for it; the form adds a box). */
export const WILD_CUSTOM_CHIP: { key: string; label: string } = { key: "custom", label: "Custom countries" };

/** Regions a wild trip can go to; labels for the chips (the engine has the countries). */
export const WILD_REGIONS: { key: string; label: string }[] = [
  { key: "sea", label: "Southeast Asia" },
  { key: "east-asia", label: "East Asia" },
  { key: "south-asia", label: "South Asia" },
  { key: "central-asia", label: "Central Asia" },
  { key: "caucasus", label: "Caucasus and Turkey" },
  { key: "balkans", label: "Balkans" },
  { key: "north-africa", label: "North Africa and Levant" },
  { key: "gulf", label: "Gulf" },
  { key: "east-africa", label: "East Africa" },
  { key: "southern-africa", label: "Southern Africa" },
  { key: "americas", label: "North and Central America" },
  { key: "caribbean", label: "Caribbean" },
  { key: "south-america", label: "South America" },
  { key: "oceania", label: "Australia and Pacific" },
];
/** Where each region's tag sits on the globe: a hand-placed centre, lat then lon. */
export const REGION_CENTROIDS: Record<string, [number, number]> = {
  sea: [10, 105],
  "east-asia": [33, 120],
  "south-asia": [22, 80],
  "central-asia": [42, 65],
  caucasus: [41, 44],
  balkans: [42, 20],
  "north-africa": [31, 5],
  gulf: [24, 52],
  "east-africa": [0, 37],
  "southern-africa": [-25, 25],
  americas: [35, -100],
  caribbean: [19, -72],
  "south-america": [-15, -60],
  oceania: [-27, 140],
};
export const WILD_STYLES: { key: string; label: string; hint: string }[] = [
  { key: "experiences", label: "True experiences", hint: "loops, boats, treks, homestays; out of the big city" },
  { key: "beaches", label: "Beaches", hint: "water, islands, sunsets" },
  { key: "food", label: "Food first", hint: "markets, the dish, where locals eat" },
  { key: "cities", label: "Big cities", hint: "neighbourhoods, nightlife, museums" },
  { key: "slow", label: "Slow travel", hint: "fewer, longer stops" },
];
export const WILD_BUDGETS: { key: string; label: string }[] = [
  { key: "backpacker", label: "Backpacker" },
  { key: "mid", label: "Mid-range" },
  { key: "comfort", label: "Comfort" },
];
export type Band = "all" | "short" | "medium" | "long";
export type DealNights = "any" | "2-3" | "4-5" | "6-7";
/** The bottom sheet on phones. */
export type Sheet = "peek" | "half" | "full";

export const BANDS: { key: Band; label: string; test: (min: number) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "short", label: "Under 2h", test: (m) => m < 120 },
  { key: "medium", label: "2 to 5h", test: (m) => m >= 120 && m < 300 },
  { key: "long", label: "5h and more", test: (m) => m >= 300 },
];

export function dealKey(d: Deal): string {
  return `${d.gw}|${d.dst}|${d.out}`;
}

/** One home airport's board as the client sees it while it loads. */
export type BoardState = {
  gateway: string;
  label: string;
  status: "loading" | "ok" | "error";
  source?: "stored" | "live";
  deals: Deal[];
  meta?: BoardMeta;
  note?: string;
};

export type AskState = { status: string; text: string; used: string[]; note?: string; question: string };

/** A live re-price of one route for chosen dates (/api/deals). */
export type LiveSearch = {
  status: "loading" | "ok" | "error";
  from: string;
  to: string;
  depart: string;
  nights: number;
  itineraries: { price: number; out: string; back: string | null; nights: number | null; stops: number; carriers: string[]; outMin: number; backMin: number; url: string }[];
  fetchedAt?: string;
  note?: string;
};

/** A departure window: both ends YYYY-MM-DD, or empty for "whenever is cheapest". */
export type Period = { from: string; to: string };

/** What the chat asks the globe to pick, through the atlas:pick / atlas:picked events. */
export type PickMode = "region" | "dates" | "place";
export type PickedDetail = { mode: PickMode; region?: string; from?: string; to?: string; place?: string };

// ---- Long stay and group trips: the shapes /api/longstay and /api/group answer with. These
// mirror lib/longstay.ts and lib/group.ts (the engine's) field for field, so the panel can
// render them without importing server-only modules.
export type LongStayBase = {
  code: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  months: number;
  flightIn: { price: number; date: string; url: string; from: string } | null;
  flightOut: { price: number; date: string; url: string; to: string } | null;
  monthlyLiving: number;
  rent: number;
  total: number;
  perDay: number;
  why: string[];
  sideTrips: { name: string; code: string; minutes: number; mode: string }[];
  visa?: string | null;
  climate?: { tmax: number[]; rain: number[] };
};
/**
 * note: the engine's one-line disclaimer on the estimates, shown under the cards.
 * skipped: countries the engine left out and why (a travel warning, too expensive unless named,
 * no known city with an airport). failed and partial: searches Kiwi refused, so a base may lack
 * a flight it would otherwise have.
 */
export type LongStayResult = { bases: LongStayBase[]; searched: number; failed?: number; partial?: true; skipped?: { country: string; reason: string }[]; generatedAt: string; note?: string; constraints?: string[] };
export type LongStayState = { status: "idle" | "loading" | "ok" | "error"; result?: LongStayResult; note?: string };

export type GroupMember = { name: string; origins: string[]; available: { from: string; to: string }[] };
/** late and early: the members only free from the second day, or until the day before the end. */
export type GroupWindow = { from: string; to: string; nights: number; everyone: boolean; compromises: string[]; late?: string[]; early?: string[] };
export type GroupOption = {
  window: GroupWindow;
  city: string;
  country: string;
  dstCity: string;
  total: number;
  /** A member already in the city has note "at home", price 0 and no url. */
  perMember: { name: string; price: number; from: string; out: string; back: string; url: string; note?: string }[];
};
/** dropped and note: what the per-person budget took out; where: the places as the engine searched them. */
export type GroupResult = { windows: GroupWindow[]; options: GroupOption[]; searched: number; failed?: number; partial?: true; generatedAt: string; dropped?: number; note?: string; where?: string };
export type GroupState = { status: "idle" | "loading" | "ok" | "error"; result?: GroupResult; note?: string };
/** where: a region word, a city, or countries by name or code, comma separated; budgetPerPerson: euros, drops options above it. */
export type GroupQuery = { members: GroupMember[]; minNights: number; maxNights: number; where?: string; direct?: boolean; budgetPerPerson?: number };

// ---- The bounds the engines now accept, for the forms (the routes clamp to the same numbers).
/** Wild loops: nights 5 to 90. */
export const WILD_NIGHTS = { min: 5, max: 90 } as const;
/** Short loops: 2 to 21 nights, 2 to 4 cities, a ground leg up to 12 hours. */
export const SHORT_TRIP_DAYS = { min: 2, max: 21 } as const;
export const SHORT_TRIP_CITIES = { min: 2, max: 4 } as const;
export const SHORT_TRIP_GROUND_HOURS = { min: 1, max: 12 } as const;
/** Long stay: 1 to 6 months. */
export const LONGSTAY_MONTHS = { min: 1, max: 6 } as const;
/** Group: 1 to 21 nights in the form (the route accepts up to 30). */
export const GROUP_NIGHTS = { min: 1, max: 21 } as const;
/** The region key that means "any countries I name" on /api/wild and /api/longstay (needs `countries`). */
export const WILD_CUSTOM_REGION = "custom";
/** The longest flight a wild leg may be capped at, hours door to door (maxFlightHours). */
export const WILD_MAX_FLIGHT_HOURS = 40;

/**
 * The free-form extras /api/wild and /api/plan take beyond region, nights, style and budget,
 * all optional, all strings as they go into the query: countries and prefer take names or
 * codes ("Vietnam,TH"); mustInclude takes city names or codes ("Hanoi,BKK"); nightsPerStop
 * a number or a range ("3-5"); maxFlightHours 1 to 40; startFrom airport codes ("LON,PAR");
 * wishes the traveller's own words. /api/plan must receive exactly what /api/wild received.
 */
export type WildExtras = { countries?: string; prefer?: string; maxStops?: string; nightsPerStop?: string; mustInclude?: string; maxFlightHours?: string; startFrom?: string; wishes?: string };

/** The constraints /api/trips reports back (`applied`): the request as the engine read it, with plain lines. */
export type TripsApplied = { days: number; cities: string; maxGroundMin: number; mustInclude?: string; countries?: string[]; exclude?: string[]; lines: string[] };

// ---- The forms of the Trips tab live in Globe state, so coming back to a mode shows the
// form that produced the results on the globe.
/** A member as the visitor builds them: ids are React keys and are stripped before the search. */
export type GroupWindowForm = { id: string; from: string; to: string };
export type GroupMemberForm = { id: string; name: string; origins: string[]; available: GroupWindowForm[] };
/** defaultsApplied: the visitor's airports fill the first member once; a member they emptied stays empty. budgetPerPerson: the box as typed, euros or empty. */
export type GroupForm = { members: GroupMemberForm[]; minNights: number; maxNights: number; where: string; direct: boolean; defaultsApplied: boolean; budgetPerPerson?: string };
/** start: null follows the When pill in the top bar, "" is "whenever is cheapest" chosen on purpose, otherwise YYYY-MM. countries: the box as typed, names or codes. wishes and mustInclude (cities, names or codes) as typed. */
export type LongStayForm = { months: number; start: string | null; budget: string; countries: string; wishes?: string; mustInclude?: string };

let idSeq = 0;
/** A short id for a row the visitor adds; unique within the page, which is all a React key needs. */
export function newId(): string {
  idSeq += 1;
  return `${Date.now().toString(36)}-${idSeq}`;
}

/** Months of the year, one letter each, for the climate strip. */
export const MONTH_LETTERS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

/** How pleasant a month is at a base: warm but not hot, and dry. 0..1. */
export function climateScore(tmax: number, rain: number): number {
  const warm = tmax >= 20 && tmax <= 31 ? 1 : tmax > 31 ? Math.max(0, 1 - (tmax - 31) / 8) : Math.max(0, 1 - (20 - tmax) / 12);
  const dry = rain <= 60 ? 1 : Math.max(0, 1 - (rain - 60) / 200);
  return Math.round((warm * 0.6 + dry * 0.4) * 100) / 100;
}

// ---- Capabilities that live everywhere, not in one tab: the events layer, place pages, the
// route card. Kept here so the globe, the panel and the cards share one shape.

/**
 * An event worth flying for as the map and the cards show it: the curated entry with its
 * dates in the window asked and a point on the globe. key is stable across renders (name and
 * start date), city is the city code, cityName the readable name.
 */
/** deal: the cheapest stored fare from the traveller's airports that overlaps the event (from /api/purpose with live=0), when one is known. */
export type EventSpot = { key: string; name: string; city: string; cityName: string; country: string; lat: number; lon: number; start: string; end: string; kind: string; why?: string; url?: string; deal?: Deal | null };

/** The Events layer: on or off, the window it shows (empty: the When pill, else the next four months), optional words to narrow it ("jazz"), a country (ISO2), and whether the list card is open. */
export type EventsLayer = { on: boolean; from: string; to: string; words?: string[]; country?: string; list: boolean };

/** A place page opened from anywhere: the command line, atlas:place, an event, a sight's city. */
export type PlacePage = { name: string; code?: string; country?: string; lat: number; lon: number };

// ---- The graph walk on the globe (GET /api/walk, lib/graph-walk.ts). Only types come from the
// engine: it is server code, and a type import is erased from the browser bundle.

/** The /api/walk question as an object, the detail of the 'atlas:walk' event. Lists may be arrays or comma lists. */
export const WALK_PARAM_KEYS = ["g", "home", "lat", "lon", "label", "from", "to", "minNights", "maxNights", "nightsPerStop", "maxStops", "beam", "budget", "ground", "tradeoff", "exclude", "mustInclude", "avoid", "prefer", "countries", "style"] as const;
export type WalkParamKey = (typeof WALK_PARAM_KEYS)[number];
export type WalkQuery = Partial<Record<WalkParamKey, string | number | string[]>>;

/** The walk's question as a query string: empty values dropped, lists joined with commas. */
export function walkQueryString(q: WalkQuery): string {
  const out = new URLSearchParams();
  for (const k of WALK_PARAM_KEYS) {
    const v = q[k];
    const s = Array.isArray(v) ? v.filter(Boolean).join(",") : v == null ? "" : String(v).trim();
    if (s) out.set(k, s);
  }
  return out.toString();
}

/** A state the walk expanded, as the globe draws it: where, when, and the money its chosen way in cost so far. */
export type WalkNodeView = { code: string; name: string; lat: number; lon: number; date: string; depth: number; cost: number; money?: number; at: number };
/** An edge the walk looked at: from the expanded node's point to the far end, its path precomputed (a great circle for a flight, a straight line on the ground). */
export type WalkEdgeView = { from: string; to: string; toName: string; lat: number; lon: number; kind: WalkLeg["kind"]; price: number; minutes: number; source: WalkLeg["source"]; chosen?: boolean; home?: boolean; path: [number, number][]; at: number };
/** Who asked for the walk: the card shows them all, a Trips builder shows its own under its form. */
export type WalkSource = "short" | "wild" | "command" | "event";
export type WalkState = {
  status: "idle" | "loading" | "ok" | "error";
  params?: WalkQuery;
  source?: WalkSource;
  lines: string[];
  nodes: WalkNodeView[];
  edges: WalkEdgeView[];
  loops: WalkLoop[];
  result?: WalkResult;
  note?: string;
  /** The loop drawn bold (index into loops, best first). */
  selected: number;
  open: boolean;
  collapsed: boolean;
};
export const EMPTY_WALK: WalkState = { status: "idle", lines: [], nodes: [], edges: [], loops: [], selected: 0, open: false, collapsed: false };
/** At most this many edges stay on the globe; the oldest that were not chosen go first. */
export const WALK_MAX_EDGES = 200;

/** The countries of each Wild region, for "Walk the region". The same lists as REGIONS in lib/wild.ts (server code, so not importable here): keep the two in step. */
export const WILD_REGION_COUNTRIES: Record<string, string[]> = {
  sea: ["TH", "VN", "MY", "SG", "ID", "PH", "KH", "LA"],
  "east-asia": ["CN", "HK", "JP", "KR", "TW"],
  "south-asia": ["IN", "LK", "MV", "NP"],
  "central-asia": ["UZ", "KZ", "KG", "TJ", "AZ"],
  caucasus: ["GE", "AM", "AZ", "TR"],
  balkans: ["AL", "ME", "BA", "RS", "MK", "GR", "BG", "HR"],
  "north-africa": ["MA", "TN", "EG", "JO"],
  gulf: ["AE", "OM", "QA", "BH", "SA"],
  "east-africa": ["KE", "TZ", "UG", "RW", "ET"],
  "southern-africa": ["ZA", "NA", "BW", "ZW", "MU"],
  americas: ["US", "MX", "CU", "CR", "GT", "CA"],
  caribbean: ["CU", "DO", "JM", "PR", "CW"],
  "south-america": ["BR", "AR", "CL", "PE", "CO", "BO", "EC"],
  oceania: ["AU", "NZ", "FJ"],
};
