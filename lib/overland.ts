// Overland links where no public timetable is (public/data/overland.json, researched 12 October 2026 with sources):
// the sleeper buses, trains, ferries and vans a backpacker takes in Southeast Asia, the Balkans, Turkey, the
// Caucasus, Central Asia and Morocco. Hanoi to Vientiane by sleeper bus is 26 to 47 euro and 23 hours; the price
// graph used to know only the 157 euro flight. Each link joins the price map as a daily edge (both ways when it runs
// both ways) at the middle of its fare range, marked as a typical fare, never a quote. A town with no airport
// (Ninh Binh, Hoi An, Vang Vieng, Kotor) gets a code of its own ("~ninh-binh") so a trip can stop there.
import data from "@/public/data/overland.json";

type End = { name: string; code: string | null; country: string; lat: number; lon: number };
type Raw = { from: End; to: End; mode: "train" | "coach" | "ferry" | "van"; minutes: number; priceEur: [number, number]; both: boolean; operator: string; book: string; note: string; sources: string[]; confidence: "high" | "medium" | "low" };

export type OverlandLink = { from: string; to: string; mode: "train" | "coach" | "ferry"; minutes: number; price: number; low: number; high: number; operator: string; book: string; note: string; confidence: Raw["confidence"]; overnight: boolean };
export type OverlandTown = { code: string; name: string; country: string; lat: number; lon: number };

const raw = (data as unknown as { links: Raw[]; generated?: string }).links ?? [];
export const OVERLAND_GENERATED: string = (data as unknown as { generated?: string }).generated ?? "";
/** A trip this long on board is taken overnight: it leaves in the evening and lands the next day. */
const OVERNIGHT_MIN = 8 * 60;

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const towns = new Map<string, OverlandTown>();
const codeOf = (e: End): string => {
  if (e.code) return e.code;
  const code = `~${slug(e.name)}`;
  if (!towns.has(code)) towns.set(code, { code, name: e.name.replace(/\s*\(.*?\)\s*/g, " ").trim(), country: e.country, lat: e.lat, lon: e.lon });
  return code;
};

export const OVERLAND: OverlandLink[] = [];
for (const r of raw) {
  if (!r?.from || !r?.to || !(r.minutes > 0) || !Array.isArray(r.priceEur)) continue;
  const mode = r.mode === "van" ? "coach" : r.mode;
  const [low, high] = r.priceEur;
  const base = { mode, minutes: Math.round(r.minutes), price: Math.round((low + high) / 2), low, high, operator: r.operator, book: r.book, note: r.note, confidence: r.confidence, overnight: r.minutes >= OVERNIGHT_MIN } as const;
  const a = codeOf(r.from);
  const b = codeOf(r.to);
  OVERLAND.push({ from: a, to: b, ...base });
  if (r.both) OVERLAND.push({ from: b, to: a, ...base });
}

/** A town an overland link reaches, by its code ("~ninh-binh"); undefined for anything else. */
export function overlandTown(code: string): OverlandTown | undefined {
  return towns.get(code);
}

/** The links leaving a place (a city code or a town code). */
const byFrom = new Map<string, OverlandLink[]>();
for (const l of OVERLAND) byFrom.set(l.from, [...(byFrom.get(l.from) ?? []), l]);
export function overlandFrom(code: string): OverlandLink[] {
  return byFrom.get(code) ?? [];
}

/** The day a link lands, leaving on `day`: the next day for an overnight one (it leaves in the evening). */
export function overlandArrival(l: OverlandLink, dayNum: number): number {
  const departMin = l.overnight ? 20 * 60 : 9 * 60;
  return dayNum + Math.floor((departMin + l.minutes) / 1440);
}
