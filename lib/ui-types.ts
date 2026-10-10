// Types the globe, the panel and the top bar share. Kept apart so the components do not
// import each other for a type.
import type { BoardMeta } from "./boards-client";
import type { Deal } from "./types";

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "ip" | "default" | "search" };

export type View = "chat" | "deals" | "all" | "fly" | "ground" | "trips" | "wild";

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
