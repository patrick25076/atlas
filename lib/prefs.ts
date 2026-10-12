// The traveller's trip style: how long a place, how fast, money against comfort, famous or
// unusual, what to avoid, the longest flight, and whether trains and coaches between places
// are welcome. One setting, kept in this browser, that every builder takes as its default
// (the Wild form, the Smart loop, Short loops, A to B, the command line) and that rides along
// with every chat turn, so the traveller says "2 to 3 nights a place" once and not per search.
// Client safe: no Node imports, so the top bar, the globe and the server can all read it.

export type Pace = "slow" | "balanced" | "packed";
export type Tradeoff = "price" | "balanced" | "comfort";
export type Taste = "popular" | "unique" | "mixed";

export type Prefs = {
  /** Nights a place, least and most (1 to 14). */
  nightsPerPlace: [number, number];
  pace: Pace;
  tradeoff: Tradeoff;
  taste: Taste;
  /** ISO2 codes (DE) or group words (dach, nordics) the trips should never stop in. */
  avoid: string[];
  /** The longest single flight, hours; absent means any length. */
  maxFlightHours?: number;
  /** Trains and coaches between places are welcome. */
  groundOk: boolean;
};

// Money first by default (the owner, 2026-10-12: "money is more important than hours"): the
// cheapest tradeoff counts about 2 euros an hour of travel, only enough to break ties.
export const DEFAULT_PREFS: Prefs = { nightsPerPlace: [2, 3], pace: "balanced", tradeoff: "price", taste: "mixed", avoid: [], groundOk: true };

/** The window event the trip style control dispatches whenever the traveller changes it; detail: { prefs }. */
export const PREFS_EVENT = "atlas:prefs";
const STORE = "atlas-prefs-v1";
const MIN_NIGHTS = 1;
const MAX_NIGHTS = 14;
const MAX_AVOID = 20;
const MAX_FLIGHT_HOURS = 40;
/** What the walk engine reads as the longest ground hop (lib/graph-walk.ts DEFAULT_GROUND_MIN): Warsaw to Gdansk by train. */
const GROUND_MINUTES = 330;

/**
 * Groups of countries people lump together, as the walk engine reads them (lib/graph-walk.ts
 * COUNTRY_GROUPS, server code and so not importable here: keep the two in step). The trip
 * style offers them as chips, and the builders that only take country codes expand them.
 */
export const AVOID_GROUPS: Record<string, { label: string; codes: string[] }> = {
  dach: { label: "Germany, Austria, Switzerland", codes: ["DE", "AT", "CH", "LI"] },
  benelux: { label: "Benelux", codes: ["BE", "NL", "LU"] },
  nordics: { label: "Nordics", codes: ["DK", "NO", "SE", "FI", "IS"] },
  baltics: { label: "Baltics", codes: ["EE", "LV", "LT"] },
  balkans: { label: "Balkans", codes: ["AL", "BA", "BG", "HR", "XK", "ME", "MK", "RS"] },
  iberia: { label: "Spain and Portugal", codes: ["ES", "PT", "AD"] },
  "british isles": { label: "Britain and Ireland", codes: ["GB", "IE", "IM", "JE", "GG"] },
};

const PACES: readonly Pace[] = ["slow", "balanced", "packed"];
const TRADEOFFS: readonly Tradeoff[] = ["price", "balanced", "comfort"];
const TASTES: readonly Taste[] = ["popular", "unique", "mixed"];

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** One avoid entry as stored: a country code in capitals, or a known group word in lower case; anything else is dropped. */
function cleanAvoid(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const s = x.trim();
    const entry = /^[a-z]{2}$/i.test(s) ? s.toUpperCase() : Object.hasOwn(AVOID_GROUPS, s.toLowerCase()) ? s.toLowerCase() : "";
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= MAX_AVOID) break;
  }
  return out;
}

/**
 * Any value to a valid Prefs: every field checked, nights clamped to 1 to 14 with the least
 * never above the most, unknown words back to the default. The server reads the chat's copy
 * through this too, so a hand-made request cannot put anything odd in the agent's prompt.
 */
export function cleanPrefs(raw: unknown): Prefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const n = Array.isArray(r.nightsPerPlace) ? r.nightsPerPlace : [];
  let lo = clampInt(n[0], MIN_NIGHTS, MAX_NIGHTS, DEFAULT_PREFS.nightsPerPlace[0]);
  let hi = clampInt(n[1] ?? n[0], MIN_NIGHTS, MAX_NIGHTS, Math.max(lo, DEFAULT_PREFS.nightsPerPlace[1]));
  if (lo > hi) [lo, hi] = [hi, lo];
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly unknown[]).includes(v) ? (v as T) : fallback);
  // Under one hour (0, a negative, a typo) means no cap, never a one-hour cap that empties every search.
  const h = typeof r.maxFlightHours === "number" || typeof r.maxFlightHours === "string" ? Number(r.maxFlightHours) : NaN;
  const hours = Number.isFinite(h) && h >= 1 ? Math.min(MAX_FLIGHT_HOURS, Math.round(h)) : undefined;
  const out: Prefs = {
    nightsPerPlace: [lo, hi],
    pace: pick(r.pace, PACES, DEFAULT_PREFS.pace),
    tradeoff: pick(r.tradeoff, TRADEOFFS, DEFAULT_PREFS.tradeoff),
    taste: pick(r.taste, TASTES, DEFAULT_PREFS.taste),
    avoid: cleanAvoid(r.avoid),
    groundOk: r.groundOk !== false,
  };
  if (hours) out.maxFlightHours = hours;
  return out;
}

/** The saved trip style, or the defaults (server side, in a private window, or with storage blocked). */
export function loadPrefs(): Prefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS, avoid: [] };
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return { ...DEFAULT_PREFS, avoid: [] };
    return cleanPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS, avoid: [] };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(cleanPrefs(p)));
  } catch {
    // storage off: the trip style holds for this page only
  }
}

/** Save and tell everyone listening (the globe, the forms). The trip style control calls this on every change. */
export function publishPrefs(p: Prefs): Prefs {
  const clean = cleanPrefs(p);
  savePrefs(clean);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { prefs: clean } }));
  return clean;
}

/** "2-3", or "2" when both ends are the same: the key the Smart loop's nights chips use. */
export function nightsParam(p: Prefs): string {
  const [a, b] = p.nightsPerPlace;
  return a === b ? String(a) : `${a}-${b}`;
}

/**
 * Nights a stop as the engines should read a setting (not a typed number): always both ends,
 * "2-3" or "2-2". A bare "2" is the engines' old shorthand for "2, or 3 if that is cheaper";
 * a trip style of exactly two nights means two, so it is sent as "2-2".
 */
export function nightsRangeParam(range: readonly [number, number]): string {
  const a = Math.min(range[0], range[1]);
  const b = Math.max(range[0], range[1]);
  return `${a}-${b}`;
}

/** The most stops each Wild engine builds in one loop (lib/wild-walk.ts MAX_STOPS; lib/wild.ts MAX_CHAIN_STEPS and _SHORT). */
export const WALK_MAX_STOPS = 16;
const CLASSIC_MAX_STOPS_SHORT = 16;
const CLASSIC_MAX_STOPS = 8;

/** The stops a Wild loop of `nights` needs at most `most` nights a stop, counted the way each engine counts them. */
export function wildStopsNeeded(nights: number, most: number, engine: "walk" | "classic"): { needed: number; cap: number } {
  const m = Math.max(1, Math.round(most));
  if (engine === "walk") return { needed: Math.ceil(Math.max(1, nights - 1) / m), cap: WALK_MAX_STOPS };
  return { needed: Math.ceil(nights / m), cap: m <= 3 ? CLASSIC_MAX_STOPS_SHORT : CLASSIC_MAX_STOPS };
}

/**
 * The nights a stop a Wild build can actually use. When the range fits the engine's stop cap it
 * is sent as it is. When it does not (60 nights at 2 to 3 a stop need 20 stops, the walk builds
 * 16), the engine would refuse the build, so the range is stretched to the shortest stays that
 * fit (60 nights: 3 to 4 on the walk) and the form says so. The stretch keeps the stays as close
 * to the traveller's taste as the cap allows, rather than dropping back to the old long bases.
 */
export function wildStopFit(range: readonly [number, number], nights: number, engine: "walk" | "classic"): { range: [number, number]; stretched: boolean; needed: number; cap: number } {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const fit = wildStopsNeeded(nights, hi, engine);
  if (fit.needed <= fit.cap) return { range: [lo, hi], stretched: false, ...fit };
  // The fewest nights a stop that fits: on the classic chain a stay over three nights also lowers its cap to 8.
  let most = Math.ceil(Math.max(1, engine === "walk" ? nights - 1 : nights) / fit.cap);
  if (engine === "classic" && most > 3) most = Math.ceil(nights / CLASSIC_MAX_STOPS);
  return { range: [Math.max(lo, most - 1), most], stretched: true, ...fit };
}

/** "2 to 3 nights", "1 night". */
export function nightsLabel(p: Prefs): string {
  const [a, b] = p.nightsPerPlace;
  return a === b ? `${a} night${a === 1 ? "" : "s"}` : `${a} to ${b} nights`;
}

/** The avoid list as country codes only: group words expanded, for the builders that take ISO2 lists. */
export function avoidCodes(p: Prefs): string[] {
  const out = new Set<string>();
  for (const a of p.avoid) for (const c of AVOID_GROUPS[a]?.codes ?? [a]) out.add(c);
  return [...out];
}

/**
 * The trip style as query parameters, the names the engines read: nightsPerStop ("2-3", and
 * "2-2" for exactly two: see nightsRangeParam), tradeoff, style ("unique" only when the traveller wants the unusual), avoid (codes
 * and group words), maxFlightHours, and ground (the minutes a train or coach hop may take,
 * 0 when they are not wanted). A builder's own form fields are laid over these.
 */
export function prefsQuery(p: Prefs): Record<string, string> {
  const q: Record<string, string> = { nightsPerStop: nightsRangeParam(p.nightsPerPlace), tradeoff: p.tradeoff, ground: String(p.groundOk ? GROUND_MINUTES : 0) };
  if (p.taste === "unique") q.style = "unique";
  if (p.avoid.length) q.avoid = p.avoid.join(",");
  if (p.maxFlightHours) q.maxFlightHours = String(p.maxFlightHours);
  return q;
}

const TRADEOFF_WORDS: Record<Tradeoff, string> = { price: "cheapest first", balanced: "money and time weighed evenly", comfort: "comfort first, shorter journeys over small savings" };
const PACE_WORDS: Record<Pace, string> = { slow: "a slow pace", balanced: "a balanced pace", packed: "a packed pace" };
const TASTE_WORDS: Record<Taste, string> = { popular: "the famous places", unique: "smaller places and hidden gems over the big hubs", mixed: "a mix of famous and lesser known places" };

/** The short note the forms show: "2 to 3 nights a place, balanced". */
export function prefsSummary(p: Prefs): string {
  const parts = [`${nightsLabel(p)} a place`, p.tradeoff === "price" ? "cheapest" : p.tradeoff];
  if (p.taste !== "mixed") parts.push(p.taste === "unique" ? "unique places" : "popular places");
  if (p.maxFlightHours) parts.push(`flights under ${p.maxFlightHours} h`);
  if (!p.groundOk) parts.push("no trains or coaches");
  if (p.avoid.length) parts.push(`avoiding ${p.avoid.length === 1 ? "one choice" : `${p.avoid.length} choices`}`);
  return parts.join(", ");
}

/** One plain sentence for the agent's system prompt. */
export function prefsLine(p: Prefs): string {
  const bits = [`${nightsLabel(p)} in each place`, PACE_WORDS[p.pace], TRADEOFF_WORDS[p.tradeoff], TASTE_WORDS[p.taste], p.groundOk ? "trains and coaches between places welcome" : "no trains or coaches between places, flights only"];
  if (p.maxFlightHours) bits.push(`no single flight over ${p.maxFlightHours} hours`);
  if (p.avoid.length) bits.push(`never stopping in ${p.avoid.map((a) => (AVOID_GROUPS[a] ? `${a} (${AVOID_GROUPS[a].codes.join(", ")})` : a)).join(", ")}`);
  return `The traveller's trip style: ${bits.join("; ")}. Use it as the default for every trip unless they ask for something else.`;
}

export function sameAsDefault(p: Prefs): boolean {
  const c = cleanPrefs(p);
  const d = DEFAULT_PREFS;
  return c.nightsPerPlace[0] === d.nightsPerPlace[0] && c.nightsPerPlace[1] === d.nightsPerPlace[1] && c.pace === d.pace && c.tradeoff === d.tradeoff && c.taste === d.taste && c.avoid.length === 0 && !c.maxFlightHours && c.groundOk === d.groundOk;
}
