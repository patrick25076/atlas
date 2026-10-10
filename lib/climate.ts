// Climate normals per city (public/data/climate.json, NASA POWER 2001 to 2025): twelve
// typical daily highs and twelve rain figures, so the engine can rank months without a
// forecast. Works on the server and in the browser; the file is small.
import climateJson from "@/public/data/climate.json";

/** `t`: typical daily high per month in C; `r`: rain per month in mm per DAY (0 to about 12), not per month. */
export type Climate = { t: number[]; r: number[] };
const CLIMATE = climateJson as unknown as Record<string, Climate>;

export type MonthScore = { m: number; tmax: number; rain: number; score: number };

/** The normals for a city code, or null when the city has none. */
export function climateFor(code: string): Climate | null {
  const c = CLIMATE[code];
  return c && c.t?.length === 12 && c.r?.length === 12 ? c : null;
}

/**
 * Comfort out of 100: a daily high between 18 and 30 C is ideal and loses four points per
 * degree outside that band; rain costs six points per mm a day above 2 (a tropical wet
 * season runs 8 to 12 mm a day, a Mediterranean summer near 0).
 */
export function comfortScore(tmax: number, rain: number): number {
  const tempPenalty = tmax < 18 ? (18 - tmax) * 4 : tmax > 30 ? (tmax - 30) * 4 : 0;
  const rainPenalty = Math.max(0, rain - 2) * 6;
  return Math.max(0, Math.round(100 - Math.min(70, tempPenalty) - Math.min(50, rainPenalty)));
}

/** Every month scored, and the three best (1 = January), for a city code in cities.json. */
export function bestMonths(code: string): { months: MonthScore[]; best: number[] } | null {
  const c = climateFor(code);
  if (!c) return null;
  const months = c.t.map((tmax, i) => ({ m: i + 1, tmax, rain: c.r[i], score: comfortScore(tmax, c.r[i]) }));
  const best = [...months].sort((a, b) => b.score - a.score || a.rain - b.rain).slice(0, 3).map((x) => x.m);
  return { months, best };
}

const NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov to Feb, 28 to 32 C, dry" style line for a card or the chat. */
export function climateLine(code: string): string | null {
  const b = bestMonths(code);
  if (!b) return null;
  const best = [...b.best].sort((x, y) => x - y);
  const t = best.map((m) => b.months[m - 1].tmax);
  const rain = best.map((m) => b.months[m - 1].rain);
  const wet = Math.max(...rain) > 5 ? "some rain" : Math.max(...rain) > 2 ? "a little rain" : "dry";
  return `Best months ${best.map((m) => NAMES[m - 1]).join(", ")}: ${Math.min(...t)} to ${Math.max(...t)} C, ${wet}`;
}
