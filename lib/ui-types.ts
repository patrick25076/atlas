// Types the globe, the panel and the top bar share. Kept apart so the components do not
// import each other for a type.
import type { BoardMeta } from "./boards-client";
import type { Deal } from "./types";

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "ip" | "default" | "search" };

/** "wild" stays a valid view for old links; the globe maps it to the Trips tab in Wild mode. */
export type View = "chat" | "deals" | "all" | "fly" | "ground" | "trips" | "wild";

/** The modes of the Trips tab. */
export type TripMode = "short" | "wild" | "longstay" | "group" | "purpose";
export const TRIP_MODES: { key: TripMode; label: string; hint: string }[] = [
  { key: "short", label: "Short loops", hint: "fly out, hop by train, fly home: 3 to 10 nights" },
  { key: "wild", label: "Wild loops", hint: "a far region, many countries, live fares" },
  { key: "longstay", label: "Long stay", hint: "one base for a month or more, priced all in" },
  { key: "group", label: "Group", hint: "friends from different cities meet somewhere cheap" },
  { key: "purpose", label: "Purpose", hint: "events worth flying for" },
];

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
export type LongStayResult = { bases: LongStayBase[]; searched: number; failed?: number; partial?: true; skipped?: { country: string; reason: string }[]; generatedAt: string; note?: string };
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
export type GroupResult = { windows: GroupWindow[]; options: GroupOption[]; searched: number; failed?: number; partial?: true; generatedAt: string };
export type GroupState = { status: "idle" | "loading" | "ok" | "error"; result?: GroupResult; note?: string };
export type GroupQuery = { members: GroupMember[]; minNights: number; maxNights: number; where?: string; direct?: boolean };

// ---- The forms of the Trips tab live in Globe state, so coming back to a mode shows the
// form that produced the results on the globe.
/** A member as the visitor builds them: ids are React keys and are stripped before the search. */
export type GroupWindowForm = { id: string; from: string; to: string };
export type GroupMemberForm = { id: string; name: string; origins: string[]; available: GroupWindowForm[] };
/** defaultsApplied: the visitor's airports fill the first member once; a member they emptied stays empty. */
export type GroupForm = { members: GroupMemberForm[]; minNights: number; maxNights: number; where: string; direct: boolean; defaultsApplied: boolean };
/** start: null follows the When pill in the top bar, "" is "whenever is cheapest" chosen on purpose, otherwise YYYY-MM. countries: the box as typed, names or codes. */
export type LongStayForm = { months: number; start: string | null; budget: string; countries: string };

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
