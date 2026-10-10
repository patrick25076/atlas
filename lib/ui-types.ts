// Types the globe, the panel and the top bar share. Kept apart so the components do not
// import each other for a type.
import type { BoardMeta } from "./boards-client";
import type { Deal } from "./types";

export type Origin = { lat: number; lon: number; label: string; source: "gps" | "ip" | "default" | "search" };

export type View = "deals" | "all" | "fly" | "ground" | "trips";
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
