// Server-only. The graph walk: trips searched the way a person does with Skyscanner Explore.
// From home, one "anywhere" search gives the fifteen cheapest places to fly to; from each of
// those, another; trains and coaches from the ground graph add the hops no airline sells;
// a multi-airport search closes the loop back to a home airport. A best-first search over
// those lazy edges, with a beam per depth so the number of live Kiwi searches stays small
// (about two a stop plus the way in and home by default, the beam narrowing when the searches
// left only just reach a closed loop), ranks the loops it closes. With a region the hops are
// targeted at its biggest hubs instead of "anywhere", so a far region is reachable too. See docs/plans/graph-walk.md for the design in the owner's words.
//
// Honesty: every flight price is a Kiwi itinerary (live, or seen in the fare memory in the
// last day) with its booking link; a board fare is half a return and is marked estimated;
// ground prices are estimates at 0.10 euro per km and are marked. The walk never spends more
// than its budget, stops at its deadline, and when Kiwi's breaker is open it finishes from
// what is known and says so in the note.
import airportsJson from "@/public/data/airports.json";
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import fameJson from "@/public/data/fame.json";
import cityPlacesJson from "@/public/data/city-places.json";
import heritageJson from "@/public/data/heritage.json";
import postgres from "postgres";
import { countryAllowed } from "./been";
import { countryLabel, hubDegree, resolveGateway } from "./board";
import { dealsFor } from "./deals-source";
import { FAME_FLOOR, isGem } from "./gems";
import { driveMinutes, flightMinutes, haversineKm } from "./geo";
import { reachFrom } from "./ground";
import { kiwiDate, kiwiStats, kiwiThrottled, searchFlight, THROTTLED_MESSAGE, type KiwiItinerary } from "./kiwi";
import { TtlLru } from "./memo";
import type { Airport, City, CityPlaces, CountryInfo, HeritageRow } from "./types";
import { findCityCode, REGIONS, resolveCountries, wishTilt } from "./wild";

// ---------------------------------------------------------------------------------------
// The contract (the route streams it, the chat and the globe consume it).

export type WalkParams = {
  origin: { lat: number; lon: number; label: string };
  /** Home airports (IATA), the way out and the way back. */
  gateways: string[];
  /** Home country (ISO2): never a stop. */
  home: string;
  /** The trip lies inside [from, to] (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The latest day the first leg may leave home (YYYY-MM-DD). Left out, any day that still leaves minNights before
   * `to`. Wild gives its departure window here and the whole trip's end as `to`, so a trip asked to leave between
   * the 20th and the 24th never leaves on the 25th, and from == to is one fixed day. */
  departBy?: string;
  minNights: number;
  maxNights: number;
  /** Nights a stop takes. A pair is exact: [2, 3] means every stop gets 2 or 3 nights, never more, and [2, 2] means
   * 2. A bare number keeps one night of slack (2 means 2 or 3), so a hop is searched over two days; left out, 2. */
  nightsPerStop?: number | [number, number];
  /** Stops at the most. Default and ceiling: ceil(maxNights / the fewest nights a stop), capped at 16, so a
   * 14-night trip at 2 to 3 nights a stop may run to 7 stops. */
  maxStops?: number;
  beam?: number;
  /** Live Kiwi searches the walk may spend in all (at most 40); 0 answers from memory, boards and the ground graph
   * alone. Default: about two a stop plus the way in and home (2 x maxStops + 2), never under 12, at most 40. */
  budget?: number;
  deadlineMs?: number;
  /** Minutes a ground hop may take (default 5.5 h); 0 turns trains and coaches off (flights only). */
  maxGroundMin?: number;
  /** The longest flight (hours, door to door) any leg may take; longer itineraries are never used. */
  maxFlightHours?: number;
  /** A far region (a lib/wild.ts REGIONS key such as "sea" or "balkans"): its countries are the allowed ones when
   * allowedCountries is not given. See allowedCountries for what the walk does with them. */
  region?: string;
  tradeoff?: "price" | "balanced" | "comfort";
  /** "Been" countries (ISO2): never a stop; a connection through one is fine. */
  exclude?: string[];
  /** Cities (codes or names) every loop must pass through. */
  mustInclude?: string[];
  /** Country codes or city codes (or names) the traveller dislikes: never a stop. A group word ("dach", "germanic",
   * "nordics", "benelux", "baltics", "balkans", "iberia", "british isles") or "like:DE" / "like Germany" avoids the
   * whole group the country belongs to ("countries like Germany"); see countryGroup. */
  avoid?: string[];
  /** Countries (ISO2 or names) to favour. */
  prefer?: string[];
  /** A region's countries (for Wild): every stop is in one of them. The walk then searches targeted instead of
   * "anywhere": the way in goes from the home airports to the region's biggest hubs (one per country first, six in
   * all, as a comma list of airports, because Kiwi answers a comma list of country names with nothing), and every
   * later flight hop searches the hubs of the countries not yet seen. An "anywhere" search from Brasov lands in
   * Europe, never in Southeast Asia. When the trip needs more stops than the region has countries (14 nights at 2
   * to 3 a stop in Oceania), a flight may land in a country already visited; never in a city already visited. */
  allowedCountries?: string[];
  /** Free words ("street food, no big cities"): a tilt on the worth of a place. "unique" (or "hidden gems",
   * "off the beaten path", "underrated") weights hidden gems and smaller cities up and the 25 biggest hubs down,
   * so "cheap but unique" is not answered with Milan and Rome. */
  style?: string;
  /**
   * The traveller's own first flight, chosen or booked (2026-10-12: the owner had found Brasov to Warsaw on the
   * 24th and the walk answered with a loop that started Bucharest to Gdansk). The walk then starts at the city that
   * flight lands in, on its day, with that leg kept as given: priced when a price is passed, unpriced otherwise. No
   * search is spent on the way out. from and to are airport or city codes; date is YYYY-MM-DD.
   */
  fixedOut?: { from: string; to: string; date: string; price?: number; minutes?: number; carrier?: string; url?: string; depart?: string; arrive?: string };
  /**
   * Towns without an airport that the traveller named (Torun, Sopot, Malbork): a stop reached by train or coach
   * only, flights never land there and never leave from there. A mustInclude entry may be a town's code.
   */
  towns?: WalkTown[];
  /** When it aborts (the client went away), no more live searches are spent and the walk answers from what it has. */
  signal?: AbortSignal;
  onEvent?: (e: WalkEvent) => void;
  /** Stream how every decision was made (knobs, expand, beam events): the admin's engine room. */
  trace?: boolean;
};

/** A town the walk may stop in by ground only (WalkParams.towns). The code is the caller's own (never three letters). */
export type WalkTown = { code: string; name: string; country: string; lat: number; lon: number };
/** "given": the traveller's own flight (WalkParams.fixedOut), kept as they gave it. */
export type WalkLeg = { kind: "fly" | "train" | "coach" | "ferry" | "road"; from: string; fromName: string; to: string; toName: string; date: string; depart?: string; arrive?: string; minutes: number; price: number; estimated?: boolean; carrier?: string; url?: string; source: "live" | "memory" | "boards" | "ground" | "given"; /** Flights: changes on the ticket, and the airports it passes (live itineraries only). */ stops?: number; route?: string[]; /** A layover of LAYOVER_MIN_H or more on the ticket (live itineraries only): the walk makes it a free night in that city. */ layover?: WalkLayover };
export type WalkStop = { code: string; name: string; country: string; lat: number; lon: number; arrive: string; leave: string; nights: number; worth: number; img?: string };
export type WalkLoop = { id: string; title: string; stops: WalkStop[]; legs: WalkLeg[]; /** The home airport the loop flies out of, else the one it flies back into, else HOME (ground both ways). */ home: string; start: string; end: string; nights: number; flights: number; ground: number; total: number; hours: number; score: number; why: string[] };
export type WalkEvent =
  | { type: "node"; code: string; name: string; lat: number; lon: number; date: string; depth: number; cost: number }
  | { type: "edge"; from: string; to: string; toName: string; lat: number; lon: number; kind: WalkLeg["kind"]; price: number; minutes: number; chosen?: boolean; source: WalkLeg["source"]; /** The way home: `to` is HOME, lat/lon the home airport (or the door for a ground way home). */ home?: boolean }
  | { type: "loop"; loop: WalkLoop }
  | { type: "progress"; text: string }
  // Trace events, sent only when WalkParams.trace is set (the admin's engine room): how the walk decides.
  | { type: "knobs"; values: Record<string, string | number> }
  | { type: "expand"; id: number; parent: number; depth: number; city: string; name: string; date: string; window: [string, string] | null; cost: number; path: string; notes: string[]; candidates: WalkCandidate[] }
  | { type: "beam"; depth: number; width: number; kept: WalkBeamRow[]; dropped: WalkBeamRow[] };
/** A layover long enough for a night out: the city, its hours and the days it spans. */
export type WalkLayover = { code: string; name: string; country: string; hours: number; arrive: string; leave: string };
/** One way out of a stop as the walk weighed it: cost = price + hoursCost + stopsCost - bonus (the lower wins). */
export type WalkCandidate = { to: string; name: string; country: string; kind: WalkLeg["kind"]; source: WalkLeg["source"]; date: string; price: number; minutes: number; stops: number; hoursCost: number; stopsCost: number; bonus: number; cost: number; best: boolean; layover?: { name: string; hours: number } };
/** A state at a depth: kept by the beam (walked on) or dropped. */
export type WalkBeamRow = { id: number; parent: number; city: string; name: string; date: string; money: number; cost: number; priority: number; path: string };
export type WalkResult = { loops: WalkLoop[]; searched: number; failed: number; fromMemory: number; expanded: number; considered: string[]; note?: string; partial?: boolean; generatedAt: string };

// ---------------------------------------------------------------------------------------
// Constants, in one place so the tradeoffs are easy to read.

type Tradeoff = NonNullable<WalkParams["tradeoff"]>;
/** Euros one hour of travel is worth, per tradeoff: way in, hops, way home (the table lib/wild.ts uses). */
const HOUR_VALUE: Record<Tradeoff, [number, number, number]> = { price: [1.5, 2, 2], balanced: [9, 11, 12], comfort: [18, 20, 24] };
/** What a kilometre of train or coach costs when no fare is known (lib/route-finder.ts uses the same). */
const EURO_PER_KM = 0.1;
/** Minutes at the airport around a flight, so a 50-minute flight is judged against a 3-hour train fairly. */
const FLIGHT_OVERHEAD_MIN = 90;
/** How much of a place's worth (0 to about 150) is taken off its price. */
const WORTH_WEIGHT = 0.5;
/**
 * What a change of plane costs on top of the fare, in euros, per tradeoff. The owner (2026-10-12): "I'm looking for
 * fewer stops". Even at Cheapest a stop is worth avoiding for a few euros: twelve is about six hours at the price rate.
 */
const STOP_EURO: Record<"price" | "balanced" | "comfort", number> = { price: 12, balanced: 25, comfort: 60 };
/**
 * The most a place's worth (fame, listings, variety, style) may take off an edge, in euros, per tradeoff; a must city
 * comes on top. Without it a famous new country paid for a flight twice the price of the cheaper one (Hanoi to
 * Vientiane for 157 euro over Bangkok for 76, 2026-10-12): at Cheapest, taste breaks ties, it does not pay double.
 */
const BONUS_CAP: Record<"price" | "balanced" | "comfort", number> = { price: 45, balanced: 80, comfort: 130 };
/**
 * A layover this long (hours) on one ticket is a night in that city for free: the owner's trick ("if I have a layover,
 * I would prefer it to be over 20 hours and get a night extra"). Up to LAYOVER_MAX_H; longer is two tickets' worth.
 */
const LAYOVER_MIN_H = 18;
const LAYOVER_MAX_H = 60;
/** x, saturating towards cap: about x while small, never past cap, and a bigger x always a little more. */
const soft = (x: number, cap: number) => (x <= 0 ? x : cap * (1 - Math.exp(-x / cap)));
/** Remembered one-way destinations out of a stop at or past which its "anywhere" search is skipped: the size of a Kiwi
 * "anywhere" answer, so a handful of rows left by someone's pair search never stands in for the explore. Home always searches. */
const KNOWN_ENOUGH = 15;
/** Ground hops kept per state, the cheapest by edge cost (price, hours, minus worth), must cities always. */
const MAX_GROUND_EDGES = 8;
const MAX_LOOPS = 6;
/** The floor of the default budget: the owner's short walks (3 stops) keep the twelve they always had. */
const DEFAULT_BUDGET = 12;
const DEFAULT_BEAM = 3;
/** Stops at the most, whatever the nights: 30 nights at 2 a stop would be 15 stops, already a sprint. */
const MAX_STOPS = 16;
/** Live searches one walk may spend at the most: two a stop for 16 stops, plus the way in and home, rounded down. */
const MAX_BUDGET = 40;
/** Hubs a targeted hop asks for in one search (one per country first). Kiwi answers 15 itineraries, so six
 * destinations keep two or three dates each and still leave room for a cheaper one. */
const TARGET_HUBS = 6;
/** Stops one country may hold on a region walk (see landable), unless the region has too few countries. */
const PER_COUNTRY = 2;
/** A city with fewer destinations than this is no hub to aim a targeted search at. */
const TARGET_HUB_MIN_DEGREE = 5;
/** 5.5 h: Warsaw to Gdansk, the owner's own example, is 310 minutes in the ground graph. */
const DEFAULT_GROUND_MIN = 330;
/** The run's own deadline, and how long one live search may hold it (Kiwi's retry ladder is longer). */
const DEFAULT_DEADLINE_MS = 90_000;
const SEARCH_CAP_MS = 35_000;
/** The fare memory counts for a day, like Kiwi's own memo. */
const MEMORY_AGE_DAYS = 1;
const DB_CAP_MS = 4_000;
/** A city this big is a hub: the "cities" style and the variety bonus read it. */
const HUB_DEGREE = 60;
/** The home node's code in events and legs. */
const HOME = "HOME";
/**
 * A train or coach up to this long runs centre to centre with no security queue, and the hours on board can be
 * read, worked or looked out of, so they count at GROUND_HOUR_SHARE of the tradeoff's euro per hour. That is what
 * lets the owner's Warsaw to Gdansk train beat a flight that is cheaper on the ticket but not after airport time.
 */
const GROUND_EASY_MIN = 360;
const GROUND_HOUR_SHARE = 0.75;
/** The style "unique", in worth points (halved by WORTH_WEIGHT like every bonus): a hidden gem, a city below hub
 * size, a country new to the traveller up; one of the BIG_HUBS biggest hubs in the world down. */
const UNIQUE_GEM = 45;
const UNIQUE_SMALL = 20;
const UNIQUE_NEW_COUNTRY = 15;
const UNIQUE_BIG_HUB = 50;
const BIG_HUBS = 25;
/** Open states per depth whose way home is looked at one ground hop further (see homeAfter); each costs one memoised
 * ground reach (about 40 ms the first time), so the cheapest few by their own priority are enough. */
const LOOKAHEAD_STATES = 30;
/** Added to the beam's order (never to the priority the early stop reads) for a state whose way home rests on a distance
 * guess once no live search is left to confirm it: it can be walked only when nothing that can close is open. */
const BLIND_PENALTY = 1000;
/** Words that ask for the unusual over the famous. The ones that carry their own "not" or "less" ("not touristy",
 * "less crowded", "avoid the touristy places") are whole phrases here, so the negation check never reads them as a
 * refusal. */
const UNIQUE_WORDS = /\b(not (too )?touristy|non touristy|untouristy|avoid(ing)? (the )?(touristy|tourist traps?|crowds)( places| spots)?|away from the crowds|less (touristy|crowded|known)|lesser known|unique|unusual|offbeat|underrated|hidden gems?|gems?|off the beaten (path|track)|small(er)? (cities|towns|places)|quiet(er)? (towns|places))\b/;
/** A word before the unique phrase that turns it into a refusal ("not unique", "no hidden gems"). */
const NEGATION = /\b(no|not|never|without|avoid|avoiding|less|nothing|skip)\b/;

const AIRPORTS = airportsJson as unknown as Airport[];
const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const airportByIata = new Map(AIRPORTS.map((a) => [a.iata, a]));
/** Where an airport is. resolveGateway answers the city centre for a code that is also a city code (GHV), so the airport file comes first. */
const pointOf = (code: string): { lat: number; lon: number } | null => {
  const a = airportByIata.get(code);
  if (a) return { lat: a.lat, lon: a.lon };
  const g = resolveGateway(code);
  return g ? { lat: g.lat, lon: g.lon } : null;
};
/** [Wikipedia views, Wikivoyage See listings, Wikivoyage Do listings] per city. */
const FAME = fameJson as unknown as Record<string, [number, number, number]>;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!cityOf.has(a)) cityOf.set(a, code);
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;
const PLACES = cityPlacesJson as unknown as Record<string, CityPlaces>;
const HERITAGE = heritageJson as unknown as HeritageRow[];
/** The biggest hubs by destinations served (Frankfurt, Paris, Amsterdam, Istanbul, Munich, London, Rome...): what "unique" steers away from. */
const BIG_HUB_SET = new Set(
  Object.keys(CITIES)
    .sort((a, b) => hubDegree(b) - hubDegree(a))
    .slice(0, BIG_HUBS),
);
/** Hidden gems as the globe marks them (lib/gems.ts): fame under the mass-tourism line with substance behind it.
 * World Heritage within 40 km is counted once per city and kept, the file is static. */
const gemMemo = new Map<string, boolean>();
function isGemCity(code: string): boolean {
  const hit = gemMemo.get(code);
  if (hit != null) return hit;
  const c = CITIES[code];
  const near = c ? HERITAGE.filter((h) => Math.abs(h[1] - c.lat) < 0.5 && haversineKm(c.lat, c.lon, h[1], h[2]) <= 40).length : 0;
  // A fame row far below what the city's air traffic says is a bad row, not a hidden gem: fame.json gives Krakow
  // (52 destinations) 8,880 views, which would make it a gem next to Bydgoszcz. A city served from 30 places with
  // fewer than five times the gem floor in views (Krakow, Tashkent, Cork, Colombo, Ibiza) is never a gem here.
  const views = FAME[code]?.[0] ?? -1;
  const suspect = views >= 0 && views < 5 * FAME_FLOOR && hubDegree(code) >= 30;
  const gem = !suspect && isGem(FAME, code, near, PLACES[code]);
  gemMemo.set(code, gem);
  return gem;
}

/**
 * Countries people lump together. The owner said "I don't like Germany, I don't like countries like Germany": one
 * code is not what he meant, the group is. The brain passes a group word or "like:DE" and the walk avoids them all.
 */
export const COUNTRY_GROUPS: Record<string, string[]> = {
  dach: ["DE", "AT", "CH", "LI"],
  benelux: ["BE", "NL", "LU"],
  nordics: ["DK", "NO", "SE", "FI", "IS"],
  baltics: ["EE", "LV", "LT"],
  balkans: ["AL", "BA", "BG", "HR", "XK", "ME", "MK", "RS"],
  iberia: ["ES", "PT", "AD"],
  "british isles": ["GB", "IE", "IM", "JE", "GG"],
};
const GROUP_WORDS: Record<string, string> = {
  dach: "dach",
  germanic: "dach",
  "german speaking": "dach",
  "german speaking countries": "dach",
  benelux: "benelux",
  "low countries": "benelux",
  nordics: "nordics",
  nordic: "nordics",
  "nordic countries": "nordics",
  scandinavia: "nordics",
  scandinavian: "nordics",
  baltics: "baltics",
  baltic: "baltics",
  "baltic states": "baltics",
  balkans: "balkans",
  balkan: "balkans",
  iberia: "iberia",
  iberian: "iberia",
  "british isles": "british isles",
  "uk and ireland": "british isles",
  "western balkans": "balkans",
  "former yugoslavia": "balkans",
  "iberian peninsula": "iberia",
  "spain and portugal": "iberia",
};
const foldWords = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, " ")
    .trim();
/** True when the style words ask for the unusual over the famous ("unique", "hidden gems", "off the beaten path").
 * Read clause by clause, as wishTilt reads its words: "not unique, big cities please" and "no hidden gems" refuse the
 * unusual, so a clause with a negation before its unique phrase does not count. */
export function wantsUnique(style?: string): boolean {
  for (const clause of (style ?? "").split(/[,;.]|\bbut\b|\band\b/i)) {
    const s = foldWords(clause);
    const m = UNIQUE_WORDS.exec(s);
    if (m && !NEGATION.test(s.slice(0, m.index))) return true;
  }
  return false;
}

/** A group word as people write it: "the Balkans", "Benelux countries", "Baltic states", "the Iberian peninsula". */
function groupWord(s: string): string | undefined {
  const bare = s.replace(/^the /, "");
  return GROUP_WORDS[s] ?? GROUP_WORDS[bare] ?? GROUP_WORDS[bare.replace(/ (countries|states|peninsula|region)$/, "")];
}

/**
 * The countries a group expression stands for: a group word ("dach", "nordics", "benelux countries", "the iberian
 * peninsula"), or "like:DE", "like Germany", "countries like Germany", "places like Germany", "somewhere like
 * Germany" (the group the country is in, else the country alone), and "countries like Germany and Austria" (the
 * groups joined). Null when the text is not a group expression, or names a country nobody knows (the caller then
 * reads it as a plain place).
 */
export function countryGroup(raw: string): { name: string; codes: string[] } | null {
  const s = foldWords(raw);
  const word = groupWord(s);
  if (word) return { name: word, codes: COUNTRY_GROUPS[word] };
  const like = /^(?:(?:countries|places|somewhere|anywhere|anything|cities) )?like[: ]\s*(.+)$/.exec(s);
  if (!like) return null;
  const names: string[] = [];
  const codes = new Set<string>();
  for (const part of like[1].split(/ and | or /)) {
    const target = part.trim().replace(/^the /, "");
    if (!target) continue;
    // A group named after "like" ("like the balkans"), else a country (a code or a name) and the group it is in.
    const named = groupWord(target);
    const cc = named ? null : /^[a-z]{2}$/.test(target) && COUNTRIES[target.toUpperCase()] ? target.toUpperCase() : resolveCountries([target]).codes[0];
    if (!named && !cc) return null;
    const found = named ? null : Object.entries(COUNTRY_GROUPS).find(([, list]) => list.includes(cc!));
    const name = named ?? found?.[0] ?? cc!;
    if (!names.includes(name)) names.push(name);
    for (const c of named ? COUNTRY_GROUPS[named] : (found?.[1] ?? [cc!])) codes.add(c);
  }
  return names.length ? { name: names.join(" and "), codes: [...codes] } : null;
}

/** How much a place is worth a stop: Wikipedia views, Wikivoyage listings and hub size (the lines lib/wild.ts keeps private). */
function worth(code: string): number {
  const views = FAME[code]?.[0] ?? 0;
  const listings = Math.max(0, FAME[code]?.[1] ?? 0);
  const fame = views > 0 ? Math.min(90, 22 * Math.log10(Math.max(1, views / 8000))) : 0;
  return fame + Math.min(30, listings) + Math.min(30, hubDegree(code) / 4);
}

/** Grid over city centres for "which city is this station in" (as lib/trips.ts does it). */
const CELL = 0.25;
const grid = new Map<string, string[]>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = `${Math.floor(c.lat / CELL)},${Math.floor(c.lon / CELL)}`;
  const list = grid.get(k);
  if (list) list.push(code);
  else grid.set(k, [code]);
}
function nearestCity(lat: number, lon: number, maxKm = 25): string | null {
  const cl = Math.floor(lat / CELL);
  const co = Math.floor(lon / CELL);
  let best: string | null = null;
  let bestKm = maxKm;
  for (let dl = -1; dl <= 1; dl++)
    for (let dn = -1; dn <= 1; dn++)
      for (const code of grid.get(`${cl + dl},${co + dn}`) ?? []) {
        const c = CITIES[code];
        const km = haversineKm(lat, lon, c.lat, c.lon);
        if (km < bestKm) {
          bestKm = km;
          best = code;
        }
      }
  return best;
}

type GroundLink = { code: string; minutes: number; mode: string };
/** Ground reaches across requests: a five-hour Dijkstra over 16,000 stations is ~40 ms, and the cheap cities repeat. */
const reachMemo = new TtlLru<GroundLink[]>(128, 30 * 60_000);
function groundFrom(lat: number, lon: number, maxMinutes: number, own: string | null): GroundLink[] {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}|${maxMinutes}`;
  const hit = reachMemo.get(key);
  if (hit) return hit;
  const links = new Map<string, GroundLink>();
  try {
    for (const s of reachFrom(lat, lon, maxMinutes, 20).reached) {
      const code = nearestCity(s.lat, s.lon);
      if (!code || code === own) continue;
      const prev = links.get(code);
      if (!prev || s.minutes < prev.minutes) links.set(code, { code, minutes: s.minutes, mode: s.mode });
    }
  } catch {
    // the graph is optional: no ground edges then
  }
  const out = [...links.values()].sort((a, b) => a.minutes - b.minutes);
  reachMemo.set(key, out);
  return out;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
const dayOf = (t: string) => t.slice(0, 10);
const hhmm = (t: string) => t.slice(11, 16);
const minDay = (a: string, b: string) => (a < b ? a : b);
/**
 * The day a flight lands when only its departure day and length are known (a remembered fare, a board fare). The
 * local clock moves about an hour per 15 degrees of longitude and a departure around midday is assumed, so a 15-hour
 * flight east from Bucharest to Kuala Lumpur lands the next day and a two-hour hop lands the same day. Without this
 * the first stop of a far region was counted from the departure day and got one night fewer than it showed.
 */
const landingDay = (out: string, minutes: number, fromLon: number | undefined, toLon: number | undefined): string => {
  const shiftH = fromLon != null && toLon != null ? ((((toLon - fromLon + 540) % 360) - 180) / 15) : 0;
  return addDays(out, Math.max(0, Math.floor((12 + minutes / 60 + shiftH) / 24)));
};
const maxDay = (a: string, b: string) => (a > b ? a : b);
const groundPrice = (km: number) => Math.max(3, Math.round(km * EURO_PER_KM));
const r1 = (x: number) => Math.round(x * 10) / 10;
const kindOfMode = (mode: string): WalkLeg["kind"] => (mode === "rail" ? "train" : mode === "ferry" ? "ferry" : "coach");
const kindWord: Record<WalkLeg["kind"], string> = { fly: "fly", train: "train", coach: "coach", ferry: "ferry", road: "drive" };
const airportName = (code: string) => {
  const city = cityOf.get(code);
  return (city && CITIES[city]?.name) || resolveGateway(code)?.label || code;
};

// ---------------------------------------------------------------------------------------
// The fare memory. The shared table (lib/db.ts) has no "everything seen from X" reader, and
// the walk needs exactly that: every one-way fare anyone saw in the last day out of a city's
// airports in a two-day window, and the cheapest way home anyone saw from anywhere. Its own
// two-connection pool, like lib/insights.ts, reads only; without DATABASE_URL both answer null.

let sql: ReturnType<typeof postgres> | null = null;
function sslFor(url: string): "require" | false | undefined {
  if (/sslmode=/i.test(url)) return undefined;
  return /localhost|127\.0\.0\.1|@db:/i.test(url) ? false : "require";
}
function client() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!sql) sql = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10, prepare: false, ssl: sslFor(url), onnotice: () => {} });
  return sql;
}
type MemFare = { src: string; dst: string; out: string; price: number; stops: number; hours: number; carriers: string[]; url: string };
type MemRow = { src: string; dst: string; out: string; price: string; stops: number; hours: string; carriers: string[]; url: string };
const fareOf = (r: MemRow): MemFare => ({ src: r.src, dst: r.dst, out: r.out, price: Number(r.price), stops: r.stops ?? 0, hours: Number(r.hours), carriers: r.carriers ?? [], url: r.url });

/** A database read capped at DB_CAP_MS: a slow pool must never hold a walk that has a deadline. */
async function capped<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DB_CAP_MS)))]);
  } catch (err) {
    console.log(`walk: memory ${err instanceof Error ? err.message.slice(0, 160) : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The cheapest one-way fare seen in the last day per destination airport, out of any of `srcs` in [from, to]. Null without a database. */
async function memoryFrom(srcs: string[], from: string, to: string): Promise<MemFare[] | null> {
  const db = client();
  if (!db || !srcs.length) return null;
  return capped(
    db<MemRow[]>`
      select distinct on (dst) src, dst, to_char(out_date, 'YYYY-MM-DD') as out, price, stops, hours, carriers, url
      from fares
      where src = any(${srcs}) and back_date is null and out_date >= ${from} and out_date <= ${to}
        and seen_at > now() - (${MEMORY_AGE_DAYS} || ' days')::interval
      order by dst, price asc`.then((rows) => rows.map(fareOf)),
  );
}

/** Every way home seen in the last day: the cheapest one-way into any home airport per origin airport and departure day
 * in [from, to]. Per day, not per airport, because a state's home window is a day or two wide and the cheapest fare of
 * the whole month would shadow the one that fits. */
async function memoryHome(gateways: string[], from: string, to: string): Promise<MemFare[]> {
  const db = client();
  if (!db || !gateways.length) return [];
  const rows = await capped(
    db<MemRow[]>`
      select distinct on (src, out_date) src, dst, to_char(out_date, 'YYYY-MM-DD') as out, price, stops, hours, carriers, url
      from fares
      where dst = any(${gateways}) and back_date is null and out_date >= ${from} and out_date <= ${to}
        and seen_at > now() - (${MEMORY_AGE_DAYS} || ' days')::interval
      order by src, out_date, price asc`.then((rows) => rows.map(fareOf)),
  );
  return rows ?? [];
}

// ---------------------------------------------------------------------------------------
// The search.

/** One open state of the walk: where the traveller is, when, and everything so far. */
type State = {
  /** City code, or HOME for the origin. */
  city: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  /** The day the traveller arrived here (can leave from). */
  date: string;
  depth: number;
  cities: string[];
  countries: Set<string>;
  legs: WalkLeg[];
  stops: WalkStop[];
  money: number;
  hours: number;
  worth: number;
  /** Money plus hours at the tradeoff's rate minus the worth taken off: what the frontier is ordered by, with the heuristic. */
  cost: number;
  priority: number;
  /** The day the first leg left home; null at the origin. */
  start: string | null;
  /** The edge that led here, re-emitted as chosen when this state is expanded. */
  via?: Extract<WalkEvent, { type: "edge" }>;
  /** This state's number and its parent's, so the beam can keep one parent's children from taking every slot. */
  id: number;
  parent: number;
};

type Edge = { to: string; leg: WalkLeg; arrive: string; img?: string };
/** What one expansion weighed, kept for the trace. */
type TraceBox = { notes: string[]; offered: (WalkCandidate & { key: Edge })[]; window: [string, string] | null; best: Map<string, Edge> };
/** A place the walk can stop in: a city of cities.json, or a named town reached by ground only (town: true). */
type Spot = { name: string; country: string; lat: number; lon: number; airports: string[]; town?: true };
/** A town counts as reached by a station of the ground graph this close to it. */
const TOWN_STATION_KM = 12;

export async function walkTrips(p: WalkParams): Promise<WalkResult> {
  const t0 = Date.now();
  const emit = p.onEvent ?? (() => {});
  const say = (text: string) => emit({ type: "progress", text });
  const at = () => new Date().toISOString();
  const considered: string[] = [];
  const fail = (note: string): WalkResult => ({ loops: [], searched: 0, failed: 0, fromMemory: 0, expanded: 0, considered, note, generatedAt: at() });

  // 1. The question, cleaned. A bad place is a plain note, never a throw.
  const gateways = [...new Set(p.gateways.map((g) => g.trim().toUpperCase()))].map((g) => ({ code: g, place: resolveGateway(g) })).filter((g) => g.place);
  if (!gateways.length) return fail(`unknown home airport ${p.gateways.join(", ") || "(none)"}; use three-letter codes such as OTP or GHV`);
  const gwCodes = gateways.map((g) => g.code);
  const home = p.home.trim().toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from) || !/^\d{4}-\d{2}-\d{2}$/.test(p.to) || !Number.isFinite(Date.parse(p.from)) || !Number.isFinite(Date.parse(p.to))) return fail("from and to must be real dates, YYYY-MM-DD");
  if (p.to < p.from) return fail("to is before from");
  if (p.departBy != null && (!/^\d{4}-\d{2}-\d{2}$/.test(p.departBy) || !Number.isFinite(Date.parse(p.departBy)) || p.departBy < p.from)) return fail("departBy must be a real date, YYYY-MM-DD, not before from");
  const minNights = Math.max(1, Math.round(p.minNights));
  const maxNights = Math.max(minNights, Math.round(p.maxNights));
  if (daysBetween(p.from, p.to) < minNights) return fail(`the window ${p.from} to ${p.to} is shorter than ${minNights} nights`);
  const range: [number, number] = Array.isArray(p.nightsPerStop) ? [Math.max(1, Math.round(p.nightsPerStop[0])), Math.max(1, Math.round(p.nightsPerStop[1]))] : [Math.max(1, Math.round(p.nightsPerStop ?? 2)), Math.max(1, Math.round(p.nightsPerStop ?? 2))];
  const nMin = Math.min(range[0], range[1]);
  const nMax = Math.max(range[0], range[1]);
  if (nMin > maxNights) return fail(`${nMin} nights a stop do not fit in ${maxNights} nights`);
  // Stops scale with the nights: a 14-night trip at 2 to 3 nights a stop needs 5 to 7 of them. More than
  // maxNights / nMin can never fit, so that is the ceiling as well as the default (16 at the most).
  const stopsCeiling = Math.max(1, Math.min(MAX_STOPS, Math.ceil(maxNights / nMin)));
  const maxStops = Math.max(1, Math.min(stopsCeiling, Math.round(p.maxStops ?? stopsCeiling)));
  // A stop never swallows the rest of the trip: its nights are nMin..nMax, so the stops together must be able to
  // fill minNights, or nothing can close. A pair is the traveller's own range and is honoured exactly ([2, 2] is two
  // nights, never three); only a bare number gets one day of slack, so its search window is two days wide.
  const stopMax = nMax + (!Array.isArray(p.nightsPerStop) && nMin === nMax ? 1 : 0);
  if (maxStops * stopMax < minNights) return fail(`${maxStops} stop${maxStops === 1 ? "" : "s"} of ${nMin === nMax ? nMin : `${nMin} to ${nMax}`} nights cannot fill ${minNights} nights; allow more stops or more nights a stop`);
  const beam = Math.max(1, Math.min(5, Math.round(p.beam ?? DEFAULT_BEAM)));
  // About two searches a stop (the hop out and a way home tried on the way) plus the way in and home: a long trip
  // needs a search per hop at the least, and twelve would leave a seven-stop loop unfinished.
  const autoBudget = Math.min(MAX_BUDGET, Math.max(DEFAULT_BUDGET, 2 * maxStops + 2));
  const budget = Math.max(0, Math.min(MAX_BUDGET, Math.round(p.budget ?? autoBudget)));
  const deadlineMs = Math.max(10_000, p.deadlineMs ?? DEFAULT_DEADLINE_MS);
  /** No trains or coaches at all (the traveller turned them off): flights only, no ground way home. */
  const groundOff = p.maxGroundMin != null && Math.round(p.maxGroundMin) <= 0;
  const maxGroundMin = groundOff ? 0 : Math.max(30, Math.min(720, Math.round(p.maxGroundMin ?? DEFAULT_GROUND_MIN)));
  /** The towns a train or coach reaches from a point: a station of the graph within TOWN_STATION_KM of the town. */
  const townMemo = new Map<string, GroundLink[]>();
  const townLinks = (lat: number, lon: number, own: string | null): GroundLink[] => {
    if (!towns.size) return [];
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    let all = townMemo.get(key);
    if (!all) {
      all = [];
      try {
        const reached = reachFrom(lat, lon, maxGroundMin, 20).reached;
        for (const [code, t] of towns) {
          let best: GroundLink | null = null;
          for (const s of reached) if (haversineKm(s.lat, s.lon, t.lat, t.lon) <= TOWN_STATION_KM && (!best || s.minutes < best.minutes)) best = { code, minutes: s.minutes, mode: s.mode };
          if (best) all.push(best);
        }
      } catch {
        // the graph is optional: no town is reachable then
      }
      townMemo.set(key, all);
    }
    return all.filter((l) => l.code !== own);
  };
  /** The ground graph's reach, or nothing when ground is off; the named towns join the cities. */
  const ground = (lat: number, lon: number, own: string | null): GroundLink[] => (groundOff ? [] : [...groundFrom(lat, lon, maxGroundMin, own), ...townLinks(lat, lon, own)]);
  /** The longest flight allowed, in minutes door to door (Infinity without a cap). */
  const maxFlyMin = p.maxFlightHours && Number.isFinite(p.maxFlightHours) && p.maxFlightHours > 0 ? p.maxFlightHours * 60 : Infinity;
  const tradeoff: Tradeoff = p.tradeoff ?? "price";
  const [hIn, hHop, hHome] = HOUR_VALUE[tradeoff];
  const stopsPenalty = (stops: number) => Math.max(0, stops) * STOP_EURO[tradeoff];
  const exclude = (p.exclude ?? []).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  // Towns without an airport (WalkParams.towns): a place like any city for the walk, but reached and left by
  // ground only. `spot` reads a city or a town the same way, so the rest of the walk needs no second path.
  const towns = new Map((p.towns ?? []).filter((t) => t && t.code && !CITIES[t.code] && Number.isFinite(t.lat) && Number.isFinite(t.lon)).map((t) => [t.code, t]));
  const spot = (code: string): Spot | undefined => {
    const c = CITIES[code];
    if (c) return c;
    const t = towns.get(code);
    return t ? { name: t.name, country: t.country, lat: t.lat, lon: t.lon, airports: [], town: true } : undefined;
  };
  const townCode = (s: string): string | undefined => {
    if (towns.has(s)) return s;
    const k = foldWords(s);
    for (const [code, t] of towns) if (foldWords(t.name) === k) return code;
    return undefined;
  };
  // Must cities: waypoints. Unknown names are the traveller's mistake, named.
  const must: string[] = [];
  for (const raw of p.mustInclude ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const code = findCityCode(s) ?? townCode(s);
    if (!code) return fail(`unknown city to pass through: ${s.slice(0, 40)} (a city name such as Gdansk or a code such as GDN)`);
    if (!must.includes(code)) must.push(code);
  }
  if (must.length > maxStops) return fail(`${must.length} cities to pass through do not fit in ${maxStops} stops`);
  // Avoid: a country code, a city code, or a name of either.
  const avoidCountries = new Set<string>();
  const avoidCities = new Set<string>();
  const avoidGroups: string[] = [];
  for (const raw of p.avoid ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    // A group first ("dach", "like:DE"): "countries like Germany" means Austria and Switzerland too.
    const group = countryGroup(s);
    if (group) {
      for (const cc of group.codes) avoidCountries.add(cc);
      avoidGroups.push(`${group.name} (${group.codes.join(", ")})`);
      continue;
    }
    const up = s.toUpperCase();
    if (/^[A-Z]{2}$/.test(up) && COUNTRIES[up]) {
      avoidCountries.add(up);
      continue;
    }
    // A country's exact name wins over a city of the same name: "Singapore", "Luxembourg" or "Malta" avoids the
    // country (the way lib/wild-walk.ts avoidCountryCodes reads it for the classic builder and the stored key).
    const cc = resolveCountries([s]).codes[0];
    if (cc) {
      avoidCountries.add(cc);
      continue;
    }
    const city = findCityCode(s);
    if (city) avoidCities.add(city);
    else return fail(`unknown place to avoid: ${s.slice(0, 40)} (a country such as DE or Germany, a city such as Berlin, or a group such as dach or like:DE)`);
  }
  if (avoidGroups.length) considered.push(`avoiding ${avoidGroups.join("; ")}`);
  const prefer = new Set(resolveCountries(p.prefer).codes);
  // A region stands for its countries when no list is given (custom has none: then the walk is open, as before).
  const regionKey = p.region ? p.region.trim().toLowerCase() : "";
  if (regionKey && !Object.hasOwn(REGIONS, regionKey)) return fail(`unknown region ${regionKey.slice(0, 30)}; one of ${Object.keys(REGIONS).join(", ")}`);
  const allowedList = p.allowedCountries?.length ? p.allowedCountries : regionKey ? REGIONS[regionKey as keyof typeof REGIONS].countries.map(([cc]) => cc) : [];
  const allowed = allowedList.length ? new Set(resolveCountries(allowedList).codes) : null;
  if (allowedList.length && !allowed?.size) return fail(`none of those is a country we know: ${allowedList.join(", ")}`);
  // A city the traveller must pass through is a stop, so its country is allowed even outside the region.
  if (allowed) for (const m of must) if (spot(m)) allowed.add(spot(m)!.country);
  /** Targeted: the flight hops search the region's hubs instead of "anywhere" (see allowedCountries). */
  const targeted = !!allowed;
  // Countries that can actually be a stop. When the trip needs more stops than that (each at its most nights),
  // a flight may land in a country already seen, a different city each time.
  const usableCountries = allowed ? [...allowed].filter((cc) => cc !== home && countryAllowed(cc, exclude) && !avoidCountries.has(cc) && !unsafe(cc)).length : Infinity;
  const revisit = targeted && Math.ceil(minNights / stopMax) > usableCountries;
  if (allowed && !usableCountries) return fail("every country of that region is on your been or avoid list, or under a travel warning");
  if (revisit) considered.push(`${minNights} nights at ${nMin === nMax ? nMin : `${nMin} to ${nMax}`} a stop need more stops than the ${usableCountries} countries allowed: a second city in a country already seen is fine`);
  const tilt = wishTilt(p.style);
  /** "Cheap but unique": hidden gems and smaller cities up, the world's biggest hubs down (UNIQUE_*). */
  const unique = wantsUnique(p.style);
  if (unique) considered.push(`style unique: hidden gems +${UNIQUE_GEM * WORTH_WEIGHT} euro, cities below hub size +${UNIQUE_SMALL * WORTH_WEIGHT}, a new country +${(15 + UNIQUE_NEW_COUNTRY) * WORTH_WEIGHT}, the ${BIG_HUBS} biggest hubs -${UNIQUE_BIG_HUB * WORTH_WEIGHT}`);
  const isHub = (code: string) => hubDegree(code) >= HUB_DEGREE;
  /** The style's tilt on a place: hubs for "cities", smaller places for "experiences", listings for "food". The coast needs the weather file; left to Wild. */
  const styleScore = (code: string): number => {
    let v = 0;
    if (tilt.cities) v += tilt.cities * (isHub(code) ? 35 : -10);
    if (tilt.experiences) v += tilt.experiences * (isHub(code) ? -15 : 30);
    if (tilt.food) v += tilt.food * Math.min(20, Math.max(0, FAME[code]?.[1] ?? 0));
    if (unique) {
      if (isGemCity(code)) v += UNIQUE_GEM;
      if (!isHub(code)) v += UNIQUE_SMALL;
      if (BIG_HUB_SET.has(code)) v -= UNIQUE_BIG_HUB;
      // worth() pays up to 30 for hub size; a traveller asking for the unusual is not paid for a big airport.
      v -= Math.min(30, hubDegree(code) / 4);
    }
    return v;
  };

  // 2. Counters and the live gate.
  let searched = 0;
  let failed = 0;
  let fromMemory = 0;
  let expanded = 0;
  let skipped = 0;
  let refused = 0;
  let timedOut = 0;
  let aborted = 0;
  /** A search of this run tripped Kiwi's breaker: the answer is partial even when no later search was refused. */
  let throttled = false;
  let saidThrottled = false;
  /** Searches taken from the budget, counted when a search starts (answered, failed or still running). */
  let reserved = 0;
  /** Stops that took their most nights because the searches left only just reached home (hopWindow's tight). */
  let lengthened = 0;
  const searchesLeft = () => Math.max(0, budget - reserved);
  const kiwiBefore = kiwiStats().today;
  const timeLeft = () => deadlineMs - (Date.now() - t0);
  const gone = () => p.signal?.aborted === true;
  const live = async (args: Parameters<typeof searchFlight>[0]): Promise<KiwiItinerary[] | null> => {
    if (gone()) {
      aborted++;
      return null;
    }
    // Reserved before the first await: the states of a depth are expanded side by side, and a count taken after
    // the answer would let them all pass the check at once and spend past the budget.
    if (reserved >= budget || timeLeft() <= 0) {
      skipped++;
      return null;
    }
    if (kiwiThrottled()) {
      refused++;
      if (!saidThrottled) {
        saidThrottled = true;
        say("Kiwi is throttling this address; finishing from what is known.");
      }
      return null;
    }
    reserved++;
    const cap = Math.min(SEARCH_CAP_MS, Math.max(1000, timeLeft()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([searchFlight(args), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), cap)))]);
      searched++;
      return r.itineraries;
    } catch (err) {
      failed++;
      if (err instanceof Error && err.message === "timed out") timedOut++;
      if (err instanceof Error && err.message === THROTTLED_MESSAGE) {
        throttled = true;
        if (!saidThrottled) {
          saidThrottled = true;
          say("Kiwi is throttling this address; finishing from what is known.");
        }
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // 3. What is known before any search: tonight's boards from the home airports (return fares,
  // so half of one is the one-way estimate) and the fare memory's ways home. Both feed the
  // heuristic (the cheapest known way home from a city) and the boards also give the first
  // hop candidates when no live search is allowed.
  const homeFrom = addDays(p.from, minNights);
  const [boardsAll, memHome] = await Promise.all([dealsFor(gwCodes).catch(() => null), memoryHome(gwCodes, homeFrom, p.to)]);
  // dealsFor falls back to the committed Romanian file when none of the home airports has a stored board; a deal
  // from another traveller's airport is no way out of this door, so only deals from the asked gateways count.
  const boards = (boardsAll?.deals ?? []).filter((d) => gwCodes.includes(d.gw));
  const boardGateways = [...new Set(boards.map((d) => d.gw))];
  /** A way home in the units a loop is scored in (see close): the fare, the hours with airport time at the way home's
   * rate, the stops penalty. A heuristic in fares alone ranked Bratislava's remembered 85 euro way home, a long
   * one-stop day that scores 437, ahead of Rome's 74 euro direct flight. */
  const flightHome = (price: number, minutes: number, stops: number) => price + (hHome * (minutes + FLIGHT_OVERHEAD_MIN)) / 60 + stopsPenalty(stops);
  /** Half of tonight's cheapest board return per city, as a way home (the outbound flight's minutes stand in for the way back). */
  const boardHalf = new Map<string, number>();
  for (const d of boards) {
    const city = CITIES[d.dstCity] ? d.dstCity : (cityOf.get(d.dst) ?? d.dstCity);
    const half = flightHome(Math.round(d.price / 2), d.outMin, d.stops);
    const prev = boardHalf.get(city);
    if (prev == null || half < prev) boardHalf.set(city, half);
  }
  /** Every remembered way home out of a city, so a state picks the cheapest that leaves inside its own home window. */
  const memHomeByCity = new Map<string, MemFare[]>();
  /** The cheapest of them per city (fare, hours and stops), for the heuristic only. */
  const memHomeMin = new Map<string, number>();
  for (const f of memHome) {
    if (f.hours * 60 > maxFlyMin) continue;
    const city = cityOf.get(f.src) ?? f.src;
    (memHomeByCity.get(city) ?? memHomeByCity.set(city, []).get(city)!).push(f);
    const cost = flightHome(f.price, f.hours * 60, f.stops);
    const prev = memHomeMin.get(city);
    if (prev == null || cost < prev) memHomeMin.set(city, cost);
  }
  if (boards.length) considered.push(`boards: ${boards.length} return fares from ${boardGateways.join(", ")}, half of one is a one-way estimate`);
  else if (boardsAll?.deals.length) considered.push(`boards: none for ${gwCodes.join(", ")} (the stored boards are for other airports)`);
  considered.push(memHome.length ? `fare memory: ${memHome.length} ways home seen in the last day` : client() ? "fare memory: no way home seen in the last day" : "fare memory: off");
  const gwPlaces = gateways.map((g) => g.place!);
  /** An optimistic cost of the way home from a city, in the units a loop is scored in: a known fare, else a cheap
   * direct one-way by distance (20 euro plus 0.04 per km, half an hour plus 800 km an hour in the air). */
  const heuristic = (code: string, lat: number, lon: number): number => {
    const mem = memHomeMin.get(code);
    if (mem != null) return mem;
    const half = boardHalf.get(code);
    if (half != null) return half;
    const km = Math.min(...gwPlaces.map((g) => haversineKm(lat, lon, g.lat, g.lon)));
    return flightHome(20 + 0.04 * km, 30 + km * 0.075, 0);
  };

  // 4. The rules for a stop. A city is never revisited, nor a country by air (unless the region
  // has fewer countries than the trip needs stops, see revisit); a train or coach may stay in
  // the country it is in (Warsaw to Gdansk is how people see Poland), never one left earlier.
  // The home country is never a stop.
  const landable = (code: string, s: State, byGround = false): boolean => {
    const c = spot(code);
    if (!c) return false;
    // A town has no airport: a flight never lands there.
    if (c.town && !byGround) return false;
    if (c.country === home || s.cities.includes(code)) return false;
    if (s.countries.has(c.country) && !(byGround && c.country === s.country && s.city !== HOME) && !(revisit && s.city !== HOME)) return false;
    if (!countryAllowed(c.country, exclude) || avoidCountries.has(c.country) || avoidCities.has(code) || unsafe(c.country)) return false;
    // Every stop is in the region. (The way in used to be allowed to land in a hub outside it, because an
    // "anywhere" search from home rarely reached the region; the targeted way in reaches it directly.)
    if (allowed && !allowed.has(c.country)) return false;
    // A region trip is a trip through its countries: two cities a country at the most (Warsaw then Gdansk by train is
    // still fine), unless the region has fewer countries than the trip needs stops. Without this the cheap trains of
    // one country fill every slot: the first live Southeast Asia walk (2026-10-12) went Kuala Lumpur, Ipoh, Penang,
    // Alor Setar by rail and only left Malaysia for its last stop.
    if (targeted && !revisit && s.stops.filter((x) => x.country === c.country).length >= PER_COUNTRY) return false;
    return true;
  };
  /** The region's cities a targeted search may aim at, biggest first. */
  const regionHubs = allowed
    ? Object.keys(CITIES)
        .filter((k) => allowed.has(CITIES[k].country) && hubDegree(k) >= TARGET_HUB_MIN_DEGREE)
        .sort((a, b) => hubDegree(b) - hubDegree(a))
    : [];
  /**
   * Where a targeted hop out of a state searches: the biggest hub of each country not seen yet, then (when the region
   * allows a second city in a country) the next biggest, six cities at the most, every airport of each. Kiwi refuses a
   * comma list of country names (0 results, measured 2026-10-12) but takes a comma list of airports, as the way home
   * does. Empty when nothing is left to land in.
   */
  const hubsFor = (s: State): { names: string[]; airports: string } => {
    const free = regionHubs.filter((k) => landable(k, s));
    const picked: string[] = [];
    const countries = new Set<string>();
    for (const k of free) {
      if (picked.length >= TARGET_HUBS) break;
      const cc = CITIES[k].country;
      if (countries.has(cc) || s.countries.has(cc)) continue;
      countries.add(cc);
      picked.push(k);
    }
    for (const k of free) if (picked.length < TARGET_HUBS && !picked.includes(k)) picked.push(k);
    return { names: picked.map((k) => CITIES[k].name), airports: [...new Set(picked.flatMap((k) => (CITIES[k].airports.length ? CITIES[k].airports : [k])))].join(",") };
  };
  /** What a stop is worth, in euros taken off its edge: fame and listings, variety, the traveller's wishes. */
  const bonus = (code: string, s: State): number => {
    const c = spot(code)!;
    let v = worth(code);
    if (!s.countries.has(c.country)) v += 15 + (unique ? UNIQUE_NEW_COUNTRY : 0);
    if (s.depth > 0 && isHub(s.city) && !isHub(code)) v += 25;
    if (prefer.has(c.country)) v += 40;
    v += styleScore(code);
    // Taste breaks ties, it does not pay double: the worth saturates towards BONUS_CAP (soft, so a famous city still
    // beats a plain one, never by more than the cap); a city the traveller must pass through comes on top.
    return soft(Math.max(0, v) * WORTH_WEIGHT, BONUS_CAP[tradeoff]) + (v < 0 ? v * WORTH_WEIGHT : 0) + (must.includes(code) ? 150 * WORTH_WEIGHT : 0);
  };
  /** The free night of a long layover, when its city can be a stop: not home, not already seen, not on the been or avoid list. */
  const layoverStop = (leg: WalkLeg, s: State): WalkLayover | null => {
    const l = leg.layover;
    if (!l) return null;
    const c = spot(l.code);
    if (!c || c.country === home || s.cities.includes(l.code) || l.code === cityOf.get(leg.to)) return null;
    if (!countryAllowed(c.country, exclude) || avoidCountries.has(c.country) || avoidCities.has(l.code) || unsafe(c.country)) return null;
    return l;
  };
  /** What a free layover night is worth, in euros taken off its ticket: the city's worth, a little less than a real stop. */
  const layoverBonus = (l: WalkLayover | null): number => (l ? soft(8 + worth(l.code) * WORTH_WEIGHT * 0.6, BONUS_CAP[tradeoff]) : 0);
  /** The minutes of a leg that are travel: a free layover night is a stay, not hours on the road. */
  const travelMinutes = (leg: WalkLeg, l: WalkLayover | null) => (l ? Math.max(60, leg.minutes - l.hours * 60) : leg.minutes);
  const hoursOfFlight = (minutes: number) => (minutes + FLIGHT_OVERHEAD_MIN) / 60;
  /** The hours a leg is charged at the tradeoff's rate: a flight with its airport time, an easy train or coach at
   * GROUND_HOUR_SHARE, a drive or a long overland day in full. One rule for every edge, so a ground hop and a
   * flight to the same city are compared on the same terms. Real hours (the loop's `hours`) are counted apart. */
  const chargedHours = (kind: WalkLeg["kind"], minutes: number) =>
    kind === "fly" ? hoursOfFlight(minutes) : kind !== "road" && minutes <= GROUND_EASY_MIN ? (minutes / 60) * GROUND_HOUR_SHARE : minutes / 60;
  const realHours = (kind: WalkLeg["kind"], minutes: number) => (kind === "fly" ? hoursOfFlight(minutes) : minutes / 60);
  /** A state that arrived by train, coach or ferry: the diversity rule keeps one in every beam when one exists. */
  const byGround = (s: State) => !!s.via && s.via.kind !== "fly" && s.via.kind !== "road";

  // 5. The frontier: one list of open states per depth, ordered by priority (cost so far plus
  // the heuristic) when the depth is walked. The beam is the best few of each depth, after
  // every state of the depth before has been expanded, so a cheap deep branch never eats the
  // slots of a sibling that was not yet looked at.
  const levels: State[][] = [];
  /** A state that cannot still pass through every must city in the depth left can never close: it takes no beam slot. */
  const push = (s: State) => {
    if (must.filter((m) => !s.cities.includes(m)).length > maxStops - s.depth) return;
    (levels[s.depth] ??= []).push(s);
  };
  const loops: WalkLoop[] = [];
  const seenLoops = new Map<string, WalkLoop>();
  let nextId = 0;
  const origin: State = { city: HOME, name: p.origin.label, lat: p.origin.lat, lon: p.origin.lon, country: home, date: p.from, depth: 0, cities: [], countries: new Set([home]), legs: [], stops: [], money: 0, hours: 0, worth: 0, cost: 0, priority: 0, start: null, id: nextId++, parent: -1 };
  push(origin);
  say(`Walking from ${p.origin.label} (${gwCodes.join(", ")}), ${p.from} to ${p.to}, ${minNights} to ${maxNights} nights, ${nMin === nMax ? nMin : `${nMin} to ${nMax}`} a stop, up to ${maxStops} stops, beam ${beam}.`);
  say(
    p.budget == null
      ? `Search budget ${budget}: about two a stop for up to ${maxStops} stops, plus the way in and the way home${autoBudget === MAX_BUDGET ? ` (capped at ${MAX_BUDGET})` : autoBudget === DEFAULT_BUDGET ? ` (never under ${DEFAULT_BUDGET})` : ""}.`
      : `Search budget ${budget}${budget === 0 ? ": the fare memory, the boards and the ground graph only" : ", as asked"}.`,
  );
  if (targeted) say(`Searching into ${[...allowed!].map((cc) => countryLabel(cc)).join(", ")} through their biggest airports, not "anywhere".`);
  if (groundOff) say("Trains and coaches are off: flights only.");
  /** The trace (the admin's engine room): a state's path, a beam row, an expanded state with what it weighed. */
  const pathOf = (x: State) => [p.origin.label, ...x.stops.map((y) => y.name)].join(" → ");
  const beamRow = (x: State): WalkBeamRow => ({ id: x.id, parent: x.parent, city: x.city, name: x.name, date: x.date, money: Math.round(x.money), cost: Math.round(x.cost), priority: Math.round(x.priority), path: pathOf(x) });
  const traceExpand = (x: State, tr: TraceBox) =>
    emit({ type: "expand", id: x.id, parent: x.parent, depth: x.depth, city: x.city, name: x.name, date: x.date, window: tr.window, cost: Math.round(x.cost), path: pathOf(x), notes: tr.notes, candidates: tr.offered.map(({ key, ...c }) => ({ ...c, best: tr.best.get(c.to) === key })).sort((y, z) => y.cost - z.cost) });
  if (p.trace)
    emit({
      type: "knobs",
      values: {
        tradeoff,
        "euro an hour (in, hop, home)": HOUR_VALUE[tradeoff].join(", "),
        "euro a change of plane": STOP_EURO[tradeoff],
        "most a place's worth takes off": BONUS_CAP[tradeoff],
        "worth weight": WORTH_WEIGHT,
        "free night from a layover of (h)": `${LAYOVER_MIN_H} to ${LAYOVER_MAX_H}`,
        "nights a stop": nMin === nMax ? nMin : `${nMin} to ${nMax}`,
        "stops at most": maxStops,
        beam,
        "live searches allowed": budget,
        "train or coach up to (min)": groundOff ? 0 : maxGroundMin,
        "searches into": targeted ? "the region's biggest hubs" : "anywhere",
        "fare memory counts for (days)": MEMORY_AGE_DAYS,
        "memory answers a stop with (fares)": KNOWN_ENOUGH,
        "flight overhead (min)": FLIGHT_OVERHEAD_MIN,
        "train or coach euro a km": EURO_PER_KM,
      },
    });

  /** The road between the traveller's door and a home airport, when it is a real drive. */
  const roadLeg = (airport: string, toAirport: boolean, date: string): WalkLeg | null => {
    const g = pointOf(airport);
    if (!g) return null;
    const km = haversineKm(p.origin.lat, p.origin.lon, g.lat, g.lon);
    if (km < 35) return null;
    const minutes = driveMinutes(km);
    const name = airportName(airport);
    return toAirport
      ? { kind: "road", from: HOME, fromName: p.origin.label, to: airport, toName: name, date, minutes, price: groundPrice(km), estimated: true, source: "ground" }
      : { kind: "road", from: airport, fromName: name, to: HOME, toName: p.origin.label, date, minutes, price: groundPrice(km), estimated: true, source: "ground" };
  };

  /** A fly leg from a Kiwi itinerary (live) or a remembered fare (memory: dates known, times not). */
  const flyFromItinerary = (from: string, it: KiwiItinerary, source: "live"): WalkLeg => ({
    kind: "fly",
    from: it.outbound.from,
    fromName: from === HOME ? airportName(it.outbound.from) : (CITIES[from]?.name ?? airportName(it.outbound.from)),
    to: it.outbound.to,
    toName: airportName(it.outbound.to),
    date: dayOf(it.outbound.departureTime),
    depart: hhmm(it.outbound.departureTime),
    arrive: hhmm(it.outbound.arrivalTime),
    minutes: Math.round(it.outbound.durationSeconds / 60),
    price: Math.round(it.price),
    carrier: [...new Set(it.outbound.segments.map((s) => s.carrierName || s.carrier))].join(", "),
    url: it.bookingUrl,
    source,
    stops: it.outbound.stops,
    route: it.outbound.route,
    ...layoverOf(it),
  });
  /** The first layover of LAYOVER_MIN_H to LAYOVER_MAX_H on an itinerary, in a city the walk knows. */
  function layoverOf(it: KiwiItinerary): { layover?: WalkLayover } {
    const seg = it.outbound.segments ?? [];
    for (let i = 0; i < seg.length - 1; i++) {
      const h = (Date.parse(seg[i + 1].departureTime) - Date.parse(seg[i].arrivalTime)) / 3_600_000;
      if (!Number.isFinite(h) || h < LAYOVER_MIN_H || h > LAYOVER_MAX_H) continue;
      const code = cityOf.get(seg[i].to) ?? (CITIES[seg[i].to] ? seg[i].to : "");
      const c = code ? CITIES[code] : undefined;
      if (!c) continue;
      return { layover: { code, name: c.name, country: c.country, hours: Math.round(h), arrive: dayOf(seg[i].arrivalTime), leave: dayOf(seg[i + 1].departureTime) } };
    }
    return {};
  }
  const flyFromMemory = (from: string, f: MemFare): WalkLeg => ({ kind: "fly", from: f.src, fromName: from === HOME ? airportName(f.src) : (CITIES[from]?.name ?? airportName(f.src)), to: f.dst, toName: airportName(f.dst), date: f.out, minutes: Math.round(f.hours * 60), price: Math.round(f.price), carrier: f.carriers.join(", ") || undefined, url: f.url, source: "memory", stops: f.stops });
  const edgeEvent = (s: State, e: Edge): Extract<WalkEvent, { type: "edge" }> => {
    const c = spot(e.to);
    return { type: "edge", from: s.city, to: e.to, toName: c?.name ?? e.leg.toName, lat: c?.lat ?? 0, lon: c?.lon ?? 0, kind: e.leg.kind, price: e.leg.price, minutes: e.leg.minutes, source: e.leg.source };
  };

  /** The child state after an edge: stops copied, the parent stop's leave day set, the new stop opened. */
  const child = (s: State, e: Edge, hv: number, stopsOnTicket: number): State => {
    const c = spot(e.to)!;
    const legs = [...s.legs];
    if (s.city === HOME) {
      const road = roadLeg(e.leg.from, true, e.leg.date);
      if (road) legs.push(road);
    }
    legs.push(e.leg);
    const stops = s.stops.map((x) => ({ ...x }));
    const last = stops.at(-1);
    if (last) {
      last.leave = e.leg.date;
      last.nights = Math.max(1, daysBetween(last.arrive, last.leave));
    }
    // A long layover on this ticket: a free night in that city, a stop of its own before the one the ticket lands in.
    const lay = layoverStop(e.leg, s);
    if (lay) {
      const lc = spot(lay.code)!;
      stops.push({ code: lay.code, name: lc.name, country: lc.country, lat: lc.lat, lon: lc.lon, arrive: lay.arrive, leave: lay.leave, nights: Math.max(1, daysBetween(lay.arrive, lay.leave)), worth: Math.round(worth(lay.code)) });
    }
    stops.push({ code: e.to, name: c.name, country: c.country, lat: c.lat, lon: c.lon, arrive: e.arrive, leave: addDays(e.arrive, nMin), nights: nMin, worth: Math.round(worth(e.to)), img: e.img });
    const road = legs.length > s.legs.length + 1 ? legs[legs.length - 2] : null;
    const roadCost = road ? road.price + hv * (road.minutes / 60) : 0;
    const b = bonus(e.to, s) + layoverBonus(lay);
    const money = s.money + e.leg.price + (road?.price ?? 0);
    const hours = s.hours + realHours(e.leg.kind, travelMinutes(e.leg, lay)) + (road ? road.minutes / 60 : 0);
    const cost = s.cost + e.leg.price + hv * chargedHours(e.leg.kind, travelMinutes(e.leg, lay)) + stopsPenalty(stopsOnTicket) + roadCost - b;
    const countries = new Set(s.countries);
    if (lay) countries.add(lay.country);
    countries.add(c.country);
    return { city: e.to, name: c.name, lat: c.lat, lon: c.lon, country: c.country, date: e.arrive, depth: s.depth + 1, cities: [...s.cities, ...(lay ? [lay.code] : []), e.to], countries, legs, stops, money, hours, worth: s.worth + b, cost, priority: cost + heuristic(e.to, c.lat, c.lon), start: s.start ?? e.leg.date, via: edgeEvent(s, e), id: nextId++, parent: s.id };
  };

  /** A loop closed by a home leg from state `s`: ranked, deduplicated by its city sequence, streamed. */
  const close = (s: State, leg: WalkLeg, stopsOnTicket: number) => {
    const legs = [...s.legs, leg];
    const road = roadLeg(leg.to, false, leg.date);
    if (road) legs.push(road);
    const stops = s.stops.map((x) => ({ ...x }));
    const last = stops.at(-1)!;
    last.leave = leg.date;
    last.nights = Math.max(1, daysBetween(last.arrive, last.leave));
    const start = s.start ?? leg.date;
    const nights = daysBetween(start, leg.date);
    const flights = legs.filter((l) => l.kind === "fly").reduce((a, l) => a + l.price, 0);
    const ground = legs.filter((l) => l.kind !== "fly").reduce((a, l) => a + l.price, 0);
    const total = flights + ground;
    const hours = r1(legs.reduce((a, l) => a + l.minutes, 0) / 60 + (legs.filter((l) => l.kind === "fly").length * FLIGHT_OVERHEAD_MIN) / 60);
    const legHours = chargedHours(leg.kind, leg.minutes) + (road ? road.minutes / 60 : 0);
    const score = Math.round(s.cost + leg.price + (road?.price ?? 0) + hHome * legHours + stopsPenalty(stopsOnTicket));
    const why: string[] = [];
    // The way out is a home airport only when the first flight leaves from one; a coach from the door to a
    // first stop (Vienna to Bratislava) departs from no airport, and the loop says so instead.
    const firstFly = legs.find((l) => l.kind === "fly");
    const wayOut = firstFly && gwCodes.includes(firstFly.from) ? firstFly.from : null;
    if (wayOut) {
      const g = pointOf(wayOut);
      const a = airportByIata.get(wayOut);
      if (g) why.push(`${a?.name ?? firstFly!.fromName} is ${driveMinutes(haversineKm(p.origin.lat, p.origin.lon, g.lat, g.lon))} minutes from you`);
    }
    for (const l of legs) {
      if (l.kind === "road") continue;
      if (l.source === "given") why.push(`your own flight ${l.fromName} to ${l.toName} on ${l.date}${l.price ? ` for ${l.price} euro, as you gave it` : ", not priced here (add what you paid)"}`);
      else if (l === leg) why.push(l.kind === "fly" ? `home from ${l.fromName} to ${l.toName} for ${l.price} euro${l.source === "memory" ? " (seen in the last day)" : ""}` : `home by ${kindWord[l.kind]} from ${l.fromName} to ${l.toName}, ${r1(l.minutes / 60)} h, about ${l.price} euro (estimated)`);
      else if (l.kind === "fly") why.push(`fly ${l.fromName} to ${l.toName} for ${l.price} euro${l.source === "memory" ? " (seen in the last day)" : l.source === "boards" ? " (about half a return on tonight's board, estimated)" : ""}`);
      else why.push(`${kindWord[l.kind]} ${l.fromName} to ${l.toName} ${r1(l.minutes / 60)} h${l.from === HOME ? " as the way out" : " instead of a flight"}`);
    }
    const countries = new Set(stops.map((x) => x.country)).size;
    why.push(`${nights} nights, ${countries} countr${countries === 1 ? "y" : "ies"}, about ${hours} h of travel`);
    const homeAirport = wayOut ?? (leg.kind === "fly" ? leg.to : HOME);
    const loop: WalkLoop = { id: `${homeAirport}-${start}-${stops.map((x) => x.code).join("-")}`, title: stops.map((x) => x.name).join(" → "), stops, legs, home: homeAirport, start, end: leg.date, nights, flights, ground, total, hours, score, why };
    const key = stops.map((x) => x.code).join(">");
    const prev = seenLoops.get(key);
    if (prev && prev.score <= loop.score) return;
    if (prev) loops.splice(loops.indexOf(prev), 1);
    seenLoops.set(key, loop);
    loops.push(loop);
    loops.sort((a, b) => a.score - b.score);
    emit({ type: "loop", loop });
    say(`Loop: ${loop.title}, ${loop.total} euro, ${loop.nights} nights.`);
  };

  /** The score an open state would have to beat: the beam-th best closed loop. */
  const worstToBeat = () => (loops.length >= beam ? loops[beam - 1].score : null);
  /** The most a single further stop can take off a path (worth, variety, a preferred country, a must city, the style),
   * so the early stop below stays admissible: a child can be cheaper than its parent. */
  const maxBonus = WORTH_WEIGHT * (150 + 15 + 25 + (prefer.size ? 40 : 0) + (must.length ? 150 : 0) + Math.max(0, (tilt.cities ?? 0) * 35) + Math.max(0, (tilt.experiences ?? 0) * 30) + Math.max(0, (tilt.food ?? 0) * 20) + (unique ? UNIQUE_GEM + UNIQUE_SMALL + UNIQUE_NEW_COUNTRY : 0));
  /** The ground graph's reach from the traveller's door, read once: a stop inside it has a train or coach home. The
   * graph is time, which runs both ways near enough, so the reach from home stands for the way back to it. */
  let homeReachMemo: Map<string, GroundLink> | null = null;
  const homeReach = () => (homeReachMemo ??= new Map(ground(p.origin.lat, p.origin.lon, null).map((g) => [g.code, g])));
  /**
   * The days a state can leave on (see 6b): from home, any day that still leaves minNights inside the window (the
   * "anywhere" search covers the whole range, as Explore does); from a stop, the stop's nights, and early enough
   * that the next stop still gets its nights and the way home still falls inside the window. Null when none is left.
   */
  const hopWindow = (s: State, tight = false): { a: string; b: string } | null => {
    const a = s.city === HOME ? p.from : addDays(s.date, nMin);
    const latestArrival = s.city === HOME ? addDays(p.to, -minNights) : addDays(minDay(addDays(s.start!, maxNights), p.to), -nMin);
    // From home, the traveller's own latest departure day (departBy) caps it too.
    const b = s.city === HOME ? (p.departBy ? minDay(latestArrival, p.departBy) : latestArrival) : minDay(addDays(s.date, stopMax), latestArrival);
    // Tight (the searches left only just cover the hops a loop still needs, see needToClose): the stop takes its
    // most nights, so the loop closes in the fewest hops. Still inside the asked range, never past it.
    if (tight && s.city !== HOME && nMax > nMin) {
      const late = addDays(s.date, nMax);
      if (late <= b) return { a: late, b };
    }
    return a <= b ? { a, b } : null;
  };
  /**
   * The live searches a state still needs before a loop can close when nothing is remembered: one hop for every
   * further stop at the most nights a stop, and the way home. A stop that can already go home needs one. The beam
   * narrows (pickWidth) and the stops lengthen (hopWindow's tight) so that one branch can still afford them.
   */
  const needToClose = (s: State): number => {
    const used = s.start ? daysBetween(s.start, s.date) : 0;
    return Math.max(1, Math.ceil((minNights - used) / nMax));
  };
  /** The days a stop reached on `arrive` (the trip having left on `start`) may fly home on (see 6a). */
  const homeWindow = (arrive: string, start: string) => ({
    earliest: maxDay(addDays(arrive, nMin), addDays(start, minNights)),
    latest: minDay(addDays(arrive, stopMax), minDay(addDays(start, maxNights), p.to)),
  });
  /** The cheapest way home out of a city that is actually known for a window: a fare the memory saw leaving inside
   * it, else half of tonight's board return, else a train or coach to the door. Null when nobody knows one. `closable`
   * leaves the board out: half a return says a route exists, but only a remembered fare, a live search or the ground
   * graph closes a loop (6a), so with no search left a board is no way home. */
  const knownHome = (code: string, lat: number, lon: number, earliest: string, latest: string, closable = false): number | null => {
    let best: number | null = null;
    for (const f of memHomeByCity.get(code) ?? []) {
      if (f.out < earliest || f.out > latest) continue;
      const cost = flightHome(f.price, f.hours * 60, f.stops);
      if (best == null || cost < best) best = cost;
    }
    if (best != null) return best;
    const half = closable ? undefined : boardHalf.get(code);
    if (half != null) return half;
    const link = homeReach().get(code);
    return link ? groundPrice(haversineKm(lat, lon, p.origin.lat, p.origin.lon)) + hHome * chargedHours(kindOfMode(link.mode), link.minutes) : null;
  };
  /**
   * The way home of a state that will go on, one ground hop ahead. A first stop is rarely the city the traveller
   * flies home from: Warsaw's own way home is dear, but the train to Gdansk and Gdansk's cheap flight home is how
   * the owner would do it. So the heuristic is the cheaper of the state's own way home and the best ground hop out
   * of it (its fare and its hours at the rate) plus that city's way home. Ground hops cost no search, so this looks
   * one step ahead for free.
   *
   * Only a neighbour whose way home is known counts (a remembered fare inside the window it could fly home in, a
   * board, a train or coach to the door). A distance guess is never used here: with it, a city ringed by towns
   * nobody has a fare for (Katowice, with Krakow, Rzeszow and Ostrava as guesses) looked cheaper than a city whose
   * way home is remembered (Naples, then Rome), took the beam, and closed nothing. A neighbour that would still owe
   * a must city cannot fly home from there, so it does not count either. The next city's worth is left out on
   * purpose: a heuristic estimates what getting home costs, and with the worth in it the beam filled with coaches.
   */
  const homeAfter = (s: State, hop: { a: string; b: string }, closable: boolean): number | null => {
    let best: number | null = null;
    // A ground hop leaves on the first day of the hop window (6b) and arrives the same day.
    const { earliest, latest } = homeWindow(hop.a, s.start!);
    if (earliest > latest) return null;
    for (const g of ground(s.lat, s.lon, s.city)) {
      if (!landable(g.code, s, true)) continue;
      if (must.some((m) => m !== g.code && !s.cities.includes(m))) continue;
      const c = spot(g.code)!;
      const home = knownHome(g.code, c.lat, c.lon, earliest, latest, closable);
      if (home == null) continue;
      const via = groundPrice(haversineKm(s.lat, s.lon, c.lat, c.lon)) + hHop * chargedHours(kindOfMode(g.mode), g.minutes) + home;
      if (best == null || via < best) best = via;
    }
    return best == null ? null : Math.max(0, best);
  };
  /** What closing a loop from this state would cost without a search: its own home window is open and a remembered
   * fare leaves inside it, or a train or coach reaches the door. Null when it cannot. */
  const closingWithoutSearch = (s: State): number | null => {
    if (!s.start) return null;
    const { earliest, latest } = homeWindow(s.date, s.start);
    return earliest <= latest ? knownHome(s.city, s.lat, s.lon, earliest, latest, true) : null;
  };
  const homeEdge = (s: State, leg: WalkLeg): Extract<WalkEvent, { type: "edge" }> => {
    const g = leg.kind === "fly" ? pointOf(leg.to) : p.origin;
    return { type: "edge", from: s.city, to: HOME, toName: leg.toName, lat: g?.lat ?? 0, lon: g?.lon ?? 0, kind: leg.kind, price: leg.price, minutes: leg.minutes, source: leg.source, home: true };
  };

  /**
   * The beam of a depth: the best states by priority, with four diversity rules that keep its size (and so the
   * number of searches) the same.
   * - One state per city: three ways into Prague all ask the same way home, and the other cities go unwalked.
   * - At most beam - 1 children of one parent from depth 2 on: one stop ringed by cheap towns (Katowice, with
   *   Ostrava by coach) could otherwise take every slot, and the cheapest branch of the depth before (Naples, then
   *   Rome by coach and a remembered way home) would never get a child walked. A slot left empty by this rule is
   *   filled by the next state in order, so the beam never shrinks.
   * - At least one branch overland when the depth has one: a flight is nearly always cheaper on paper than a
   *   five-hour train, so a beam of the cheapest states would be all flights and "plane, train, plane" (Brasov to
   *   Warsaw, the train to Gdansk, a flight on) would never be walked unless asked for.
   * - At least one branch by air when the depth has one: ground hops are known before any search and flights are
   *   not, so the lookahead can make a beam all coaches; the explore out of a stop is the other half of the walk.
   * - The branch with the cheapest known way to close (`bestKnown`: a remembered way home inside its own window, or
   *   one ground hop away, or a train or coach to the door) is always walked, when the depth has one. A distance
   *   guess is optimistic on purpose, so guessed branches outrank a remembered 74 euro way home; without this rule
   *   Naples, the coach to Rome and Rome's remembered flight home (123 euro, the cheapest loop the memory holds)
   *   lost its slot to Ostrava, whose live way home came back at 242. It costs no search. When its parent already
   *   has its share of the beam it replaces its own costliest sibling, so the per-parent cap still holds.
   * A rule takes the beam's last slot that the rules before it do not need.
   */
  /**
   * How many states a depth may expand: the beam, unless the searches left would then not cover what the cheapest
   * state still needs to close a loop (needToClose: a hop per further stop and the way home). Each extra state costs
   * about one search now, so the width is one plus the spare searches. A 14-night loop at 2 to 3 nights a stop on
   * twelve searches walks three branches at the first depths and one at the last, instead of three everywhere and
   * running out at stop four. With no search left at all the width costs nothing and stays the beam (memory walks).
   */
  const pickWidth = (best: State): number => {
    const left = searchesLeft();
    if (!left || kiwiThrottled() || gone()) return beam;
    return Math.max(1, Math.min(beam, 1 + left - needToClose(best)));
  };
  const pickBeam = (level: State[], depth: number, bestKnown: State | null, size: number): State[] => {
    const perParent = depth >= 2 && size >= 2 ? size - 1 : size;
    const picked: State[] = [];
    const seen = new Set<string>();
    const children = new Map<number, number>();
    const take = (s: State) => {
      seen.add(s.city);
      children.set(s.parent, (children.get(s.parent) ?? 0) + 1);
      picked.push(s);
    };
    const held: State[] = [];
    for (const s of level) {
      if (picked.length >= size) break;
      if (seen.has(s.city)) continue;
      if ((children.get(s.parent) ?? 0) >= perParent) {
        held.push(s);
        continue;
      }
      take(s);
    }
    // Only when no other parent has a state left: the cap is about sharing slots, never about leaving one empty.
    for (const s of held) if (picked.length < size && !seen.has(s.city)) take(s);
    if (held.length && picked.length === size) considered.push(`depth ${depth}: at most ${perParent} cities from one stop, so another branch keeps a slot`);
    if (size < 2 || picked.length < size) return picked;
    const swapIn = (want: (s: State) => boolean, keep: (s: State) => boolean, why: string) => {
      if (picked.some(want)) return;
      const at = picked.map((x, i) => (keep(x) ? -1 : i)).filter((i) => i >= 0).pop();
      if (at == null) return;
      // The newcomer must not break the per-parent cap once the state it replaces has left.
      const fits = (x: State) => (children.get(x.parent) ?? 0) - (picked[at].parent === x.parent ? 1 : 0) < perParent;
      const g = level.find((x) => want(x) && !seen.has(x.city) && fits(x));
      if (!g) return;
      considered.push(`depth ${depth}: ${g.name} by ${g.via?.kind ?? "air"} from ${g.stops.at(-2)?.name ?? p.origin.label} kept in the beam in place of ${picked[at].name}, ${why}`);
      children.set(picked[at].parent, (children.get(picked[at].parent) ?? 1) - 1);
      children.set(g.parent, (children.get(g.parent) ?? 0) + 1);
      seen.add(g.city);
      picked[at] = g;
    };
    if (bestKnown && !picked.includes(bestKnown) && !seen.has(bestKnown.city)) {
      const siblings = picked.map((x, i) => (x.parent === bestKnown.parent ? i : -1)).filter((i) => i >= 0);
      const at = siblings.length >= perParent ? siblings[siblings.length - 1] : picked.length - 1;
      considered.push(`depth ${depth}: ${bestKnown.name} kept in the beam in place of ${picked[at].name}, the cheapest branch that closes from what is already known`);
      children.set(picked[at].parent, (children.get(picked[at].parent) ?? 1) - 1);
      children.set(bestKnown.parent, (children.get(bestKnown.parent) ?? 0) + 1);
      seen.add(bestKnown.city);
      picked[at] = bestKnown;
    }
    // Each rule keeps what the rules before it needed: the best known branch, then the only overland one.
    const onlyGround = (x: State) => byGround(x) && picked.filter(byGround).length === 1;
    swapIn(byGround, (x) => x === bestKnown, "so one branch goes overland");
    swapIn((x) => !byGround(x), (x) => x === bestKnown || onlyGround(x), "so one branch flies on");
    return picked;
  };

  // The traveller's own way out (fixedOut): its landing city is the first stop, on its day, and the walk starts
  // there (depth 1). The way out is never searched and never replaced.
  let firstDepth = 0;
  if (p.fixedOut) {
    const f = p.fixedOut;
    const fromRaw = String(f.from ?? "").trim().toUpperCase();
    const toRaw = String(f.to ?? "").trim().toUpperCase();
    const toCity = CITIES[toRaw] ? toRaw : cityOf.get(toRaw);
    if (!toCity) return fail(`the flight out lands at ${toRaw || "(nothing)"}, which is no airport or city we know; give its airport code (WAW, GDN)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") || !Number.isFinite(Date.parse(f.date))) return fail("the flight out needs its day as YYYY-MM-DD");
    const toAirport = airportByIata.has(toRaw) ? toRaw : (CITIES[toCity].airports[0] ?? toRaw);
    const fromAirport = airportByIata.has(fromRaw) ? fromRaw : (CITIES[fromRaw]?.airports[0] ?? gwCodes[0]);
    const a = pointOf(fromAirport);
    const b = pointOf(toAirport) ?? { lat: CITIES[toCity].lat, lon: CITIES[toCity].lon };
    const minutes = Number.isFinite(f.minutes) && f.minutes! > 0 ? Math.round(f.minutes!) : a ? flightMinutes(haversineKm(a.lat, a.lon, b.lat, b.lon)) : 120;
    const priced = Number.isFinite(f.price) && f.price! >= 0;
    const leg: WalkLeg = { kind: "fly", from: fromAirport, fromName: airportName(fromAirport), to: toAirport, toName: airportName(toAirport), date: f.date, ...(f.depart ? { depart: f.depart } : {}), ...(f.arrive ? { arrive: f.arrive } : {}), minutes, price: priced ? Math.round(f.price!) : 0, ...(f.carrier ? { carrier: f.carrier } : {}), ...(f.url ? { url: f.url } : {}), source: "given" };
    if (!landable(toCity, origin)) return fail(`${CITIES[toCity].name}, where the flight out lands, cannot be a stop (the home country, or on the avoid or been list)`);
    push(child(origin, { to: toCity, leg, arrive: landingDay(f.date, minutes, a?.lon, b.lon) }, hIn, 0));
    if (!levels[1]?.length) return fail(`${CITIES[toCity].name} leaves too few stops for the cities to pass through`);
    firstDepth = 1;
    considered.push(`the way out is the traveller's own: ${leg.fromName} to ${leg.toName} on ${f.date}${priced ? ` for ${leg.price} euro, as given` : ", not priced (their own ticket)"}; the walk starts in ${CITIES[toCity].name}`);
  }
  // 6. The walk, depth by depth.
  walk: for (let depth = firstDepth; depth <= maxStops; depth++) {
    const level = (levels[depth] ?? []).sort((a, b) => a.priority - b.priority);
    if (!level.length) break;
    // The one-hop ground lookahead (homeAfter) for states that can still go deeper, by depth and by date; it only
    // ever lowers a priority, so it runs before the early stop reads the best one.
    // Then the order the beam reads. With no live search left (budget 0, spent, the breaker open, the caller gone),
    // a way home nobody knows can never be found: a state that rests on a distance guess, for itself and for every
    // ground neighbour, goes behind every state that can still close. Its priority stays honest for the early stop.
    // `bestKnown` is the state with the cheapest way to close without a search (the beam always walks it, see pickBeam).
    const rank = new Map<State, number>();
    let bestKnown: State | null = null;
    let bestKnownCost = Infinity;
    if (depth > 0) {
      const canSearch = reserved < budget && timeLeft() > 0 && !kiwiThrottled() && !gone();
      level.forEach((s, i) => {
        const hop = depth < maxStops && i < LOOKAHEAD_STATES ? hopWindow(s) : null;
        const ahead = hop ? homeAfter(s, hop, !canSearch) : null;
        if (ahead != null) s.priority = Math.min(s.priority, s.cost + ahead);
        // With searches left the lookahead above may count a board; what the state closes at for free is asked apart.
        const own = closingWithoutSearch(s);
        const next = hop ? (canSearch ? homeAfter(s, hop, true) : ahead) : null;
        const free = own == null ? next : next == null ? own : Math.min(own, next);
        if (free != null && s.cost + free < bestKnownCost) {
          bestKnownCost = s.cost + free;
          bestKnown = s;
        }
        rank.set(s, s.priority + (canSearch || free != null ? 0 : BLIND_PENALTY));
      });
      level.sort((a, b) => rank.get(a)! - rank.get(b)! || a.priority - b.priority);
    }
    const bar = worstToBeat();
    if (bar != null && Math.min(...level.map((x) => x.priority)) - (maxStops - depth) * maxBonus >= bar) {
      considered.push(`stopped at depth ${depth}: ${loops.length} loops closed and no open state can beat a score of ${bar}`);
      break;
    }
    // The beam's width at this depth (pickWidth): as wide as asked while the searches left still cover the cheapest
    // branch's way to a closed loop, narrower when they do not. The early depths explore, the late ones finish.
    const width = depth === 0 ? 1 : pickWidth(level[0]);
    if (depth > 0 && width < beam) considered.push(`depth ${depth}: beam ${width} instead of ${beam}, keeping ${needToClose(level[0])} of the ${searchesLeft()} searches left for the cheapest branch's hops and way home`);
    const picked = depth === 0 ? level.slice(0, 1) : pickBeam(level, depth, bestKnown, width);
    if (p.trace) emit({ type: "beam", depth, width, kept: picked.map(beamRow), dropped: level.filter((x) => !picked.includes(x)).slice(0, 20).map(beamRow) });
    // The states of a depth are expanded side by side: their searches go through Kiwi's gate together (six at a
    // time), so a seven-stop walk takes seven rounds of searches, not twenty. The budget is reserved per search.
    let stop = false;
    const expand = async (s: State): Promise<void> => {
      if (timeLeft() <= 0 || gone()) {
        if (!stop) considered.push(gone() ? "stopped: the caller went away" : `stopped at the ${Math.round(deadlineMs / 1000)} s limit`);
        stop = true;
        return;
      }
      expanded++;
      const tr: TraceBox = { notes: [], offered: [], window: null, best: new Map() };
      const note = (t: string) => {
        considered.push(t);
        tr.notes.push(t);
      };
      try {
      emit({ type: "node", code: s.city, name: s.name, lat: s.lat, lon: s.lon, date: s.date, depth: s.depth, cost: Math.round(s.cost) });
      if (s.via) emit({ ...s.via, chosen: true });
      const srcs = s.city === HOME ? gwCodes : (spot(s.city)?.airports ?? []);
      const flyFrom = s.city === HOME ? gwCodes.join(",") : s.city;
      /** A town without an airport: no flight leaves from here, the hops and the way home are by ground. */
      const noAirport = s.city !== HOME && !srcs.length;

      // 6a. Home: when this stop has had its nights (and not more than asked), the trip is inside
      // the asked range, and every must city is behind us. The last stop never swallows the rest
      // of the trip: a loop that needs more nights goes one stop deeper instead.
      if (s.depth > 0 && s.start && must.every((m) => s.cities.includes(m))) {
        const { earliest, latest } = homeWindow(s.date, s.start);
        if (earliest <= latest) {
          // The fare memory: the cheapest remembered way home that leaves inside this state's own window.
          const mem = (memHomeByCity.get(s.city) ?? [])
            .filter((f) => f.out >= earliest && f.out <= latest)
            .sort((x, y) => x.price + hHome * hoursOfFlight(x.hours * 60) + stopsPenalty(x.stops) - (y.price + hHome * hoursOfFlight(y.hours * 60) + stopsPenalty(y.stops)))[0];
          if (mem) {
            fromMemory++;
            const leg = flyFromMemory(s.city, mem);
            emit(homeEdge(s, leg));
            close(s, leg, mem.stops);
          } else if (!noAirport) {
            const its = await live({ flyFrom: s.city, flyTo: gwCodes.join(","), departureDate: kiwiDate(earliest), departureDateTo: kiwiDate(latest) });
            note(`${s.name} home to ${gwCodes.join(",")} ${earliest}..${latest}: ${its ? `${its.length} fares` : "not searched"}`);
            const best = (its ?? [])
              .filter((it) => (gwCodes.includes(it.outbound.to) || gwCodes.includes(cityOf.get(it.outbound.to) ?? "")) && it.outbound.durationSeconds / 60 <= maxFlyMin)
              .sort((a, b) => a.price + hHome * hoursOfFlight(a.outbound.durationSeconds / 60) + stopsPenalty(a.outbound.stops) - (b.price + hHome * hoursOfFlight(b.outbound.durationSeconds / 60) + stopsPenalty(b.outbound.stops)))[0];
            if (best) {
              const leg = flyFromItinerary(s.city, best, "live");
              emit(homeEdge(s, leg));
              close(s, leg, best.outbound.stops);
            }
          }
          // The ground way home, alongside the flight: a train or coach to the door when the graph reaches
          // this city from it (Ruse, Chisinau or Budapest for a Brasov home), estimated like every ground leg.
          const link = homeReach().get(s.city);
          if (link) {
            const leg: WalkLeg = { kind: kindOfMode(link.mode), from: s.city, fromName: s.name, to: HOME, toName: p.origin.label, date: earliest, minutes: link.minutes, price: groundPrice(haversineKm(s.lat, s.lon, p.origin.lat, p.origin.lon)), estimated: true, source: "ground" };
            emit(homeEdge(s, leg));
            close(s, leg, 0);
          }
        }
      }
      if (s.depth >= maxStops) return;

      // 6b. The hop window out of here (hopWindow): the days this state may leave on, if any are left.
      // Tight: the searches left only just cover this branch's hops and way home, so this stop takes its most nights.
      const tight = searchesLeft() > 0 && searchesLeft() <= needToClose(s);
      const hop = hopWindow(s, tight);
      if (!hop) return;
      if (tight && nMax > nMin && s.city !== HOME) lengthened++;
      const { a, b } = hop;
      tr.window = [a, b];
      const hv = s.city === HOME ? hIn : hHop;
      const edges = new Map<string, { edge: Edge; cost: number; stops: number }>();
      const offer = (e: Edge, stopsOnTicket: number) => {
        const lay = layoverStop(e.leg, s);
        const hoursCost = hv * chargedHours(e.leg.kind, travelMinutes(e.leg, lay));
        const b = bonus(e.to, s) + layoverBonus(lay);
        const cost = e.leg.price + hoursCost + stopsPenalty(stopsOnTicket) - b;
        if (p.trace) {
          const c = spot(e.to);
          tr.offered.push({ key: e, to: e.to, name: c?.name ?? e.leg.toName, country: c?.country ?? "", kind: e.leg.kind, source: e.leg.source, date: e.leg.date, price: e.leg.price, minutes: e.leg.minutes, stops: stopsOnTicket, hoursCost: Math.round(hoursCost), stopsCost: stopsPenalty(stopsOnTicket), bonus: Math.round(b), cost: Math.round(cost), best: false, ...(lay ? { layover: { name: lay.name, hours: lay.hours } } : {}) });
        }
        const prev = edges.get(e.to);
        // A live itinerary wins a tie with a remembered fare: it knows its real arrival time, the memory only a guess.
        if (!prev || cost < prev.cost || (cost === prev.cost && e.leg.source === "live" && prev.edge.leg.source !== "live")) edges.set(e.to, { edge: e, cost, stops: stopsOnTicket });
      };

      // Flights: the memory first, then the live "anywhere" search merged on top (the cheaper fare per city wins).
      // From home the explore is always asked, it is the one question the walk is built on and a single search;
      // from a stop it is skipped only when the memory already holds an "anywhere"-sized answer, because what the
      // memory holds is whatever other features searched (a pair, a country), not the cheapest places overall.
      const mem = noAirport ? null : await memoryFrom(srcs, a, b);
      let known = 0;
      for (const f of mem ?? []) {
        const to = cityOf.get(f.dst);
        if (!to || !landable(to, s) || f.hours * 60 > maxFlyMin) continue;
        known++;
        offer({ to, leg: flyFromMemory(s.city, f), arrive: landingDay(f.out, f.hours * 60, pointOf(f.src)?.lon, CITIES[to]?.lon) }, f.stops);
      }
      // Targeted (a region): the hubs of the countries not seen yet instead of "anywhere"; six cities, so six
      // remembered ones are as good as the search. Open: the explore, skipped only for an "anywhere"-sized memory.
      const target = targeted ? hubsFor(s) : null;
      const where = target ? target.names.join(", ") || "the region" : "anywhere";
      if (noAirport) {
        note(`${s.name} has no airport: on by train or coach only`);
      } else if (s.city !== HOME && known >= (target ? TARGET_HUBS : KNOWN_ENOUGH)) {
        fromMemory++;
        note(`${s.name} to ${where} ${a}..${b}: ${known} fares from memory, no live search`);
      } else if (target && !target.airports) {
        note(`${s.name}: no city of the region left to fly to`);
      } else {
        const its = await live({ flyFrom, flyTo: target ? target.airports : "anywhere", departureDate: kiwiDate(a), departureDateTo: kiwiDate(b) });
        let used = 0;
        let tooLong = 0;
        for (const it of its ?? []) {
          const to = cityOf.get(it.outbound.to);
          if (!to || !landable(to, s)) continue;
          if (it.outbound.durationSeconds / 60 > maxFlyMin) {
            tooLong++;
            continue;
          }
          used++;
          offer({ to, leg: flyFromItinerary(s.city, it, "live"), arrive: dayOf(it.outbound.arrivalTime), img: it.imageId }, it.outbound.stops);
        }
        // The boards are the last resort for the first hop: half a return fare is an estimate,
        // offered only when neither the memory nor a live search gave real one-way fares.
        let fromBoards = 0;
        if (s.city === HOME && !its && !known) {
          for (const d of boards) {
            const to = CITIES[d.dstCity] ? d.dstCity : (cityOf.get(d.dst) ?? "");
            if (!to || d.out < a || d.out > b || edges.has(to) || !landable(to, s) || d.outMin > maxFlyMin) continue;
            fromBoards++;
            offer({ to, leg: { kind: "fly", from: d.gw, fromName: airportName(d.gw), to: d.dst, toName: airportName(d.dst), date: d.out, minutes: d.outMin, price: Math.round(d.price / 2), estimated: true, carrier: d.carriers.join(", ") || undefined, url: d.url, source: "boards", stops: d.stops }, arrive: landingDay(d.out, d.outMin, pointOf(d.gw)?.lon, CITIES[to]?.lon), img: d.img }, d.stops);
          }
        }
        note(`${s.name} to ${where} ${a}..${b}: ${its ? `${its.length} fares, ${used} usable` : known ? `not searched, ${known} from memory` : "not searched"}${tooLong ? `, ${tooLong} over ${p.maxFlightHours} h` : ""}${fromBoards ? `, ${fromBoards} from the boards (half a return, estimated)` : ""}`);
      }

      // Ground: the graph's reach, cities only (a hop may stay in the country), leaving on the stop's last day.
      // Ranked by edge cost, not minutes, so a four-hour train to a city worth seeing (Warsaw to Gdansk) is
      // kept ahead of a quick coach to a town nobody asked for; a must city is kept whatever its rank.
      const links = ground(s.lat, s.lon, s.city === HOME ? null : s.city)
        .filter((g) => landable(g.code, s, true))
        .map((g) => {
          const c = spot(g.code)!;
          const leg: WalkLeg = { kind: kindOfMode(g.mode), from: s.city, fromName: s.name, to: g.code, toName: c.name, date: a, minutes: g.minutes, price: groundPrice(haversineKm(s.lat, s.lon, c.lat, c.lon)), estimated: true, source: "ground" };
          return { edge: { to: g.code, leg, arrive: a } as Edge, cost: leg.price + hv * chargedHours(leg.kind, g.minutes) - bonus(g.code, s), must: must.includes(g.code) };
        })
        .sort((x, y) => x.cost - y.cost);
      let groundUsed = 0;
      for (const g of links) {
        if (groundUsed >= MAX_GROUND_EDGES && !g.must) continue;
        offer(g.edge, 0);
        groundUsed++;
      }
      if (groundUsed) note(`${s.name} by ground within ${Math.round(maxGroundMin / 60)} h: ${groundUsed} of ${links.length} cities`);

      for (const [k, v] of edges) tr.best.set(k, v.edge);
      // Every edge is streamed (the fan-out), every child joins the next depth; the beam decides there.
      for (const { edge, stops } of edges.values()) {
        emit(edgeEvent(s, edge));
        push(child(s, edge, hv, stops));
      }
      } finally {
        if (p.trace) traceExpand(s, tr);
      }
    };
    await Promise.all(picked.map(expand));
    if (stop) break walk;
  }

  // 7. The answer.
  const kiwiCalls = kiwiStats().today - kiwiBefore;
  // kiwiCalls counts every request sent to Kiwi today by this instance, failed ones included, so it is reported
  // beside the answered and failed counts rather than as a share of the answered ones.
  if (searched || failed) considered.push(`${searched + failed} search${searched + failed === 1 ? "" : "es"} through the gate: ${searched} answered${failed ? `, ${failed} failed` : ""}; ${kiwiCalls} request${kiwiCalls === 1 ? "" : "s"} sent to Kiwi${kiwiCalls < searched + failed ? ", the rest answered from its memo" : ""}`);
  if (skipped) considered.push(timeLeft() <= 0 ? `${skipped} search${skipped > 1 ? "es" : ""} not made: the run reached its ${Math.round(deadlineMs / 1000)} s limit` : `${skipped} search${skipped > 1 ? "es" : ""} skipped at the budget of ${budget}`);
  if (refused) considered.push(`${refused} search${refused > 1 ? "es" : ""} not made while Kiwi throttles this address`);
  if (timedOut) considered.push(`${timedOut} search${timedOut > 1 ? "es" : ""} took longer than ${SEARCH_CAP_MS / 1000} s and ${timedOut > 1 ? "were" : "was"} not waited for`);
  if (aborted) considered.push(`${aborted} search${aborted > 1 ? "es" : ""} not made: the caller went away`);
  if (lengthened) considered.push(`${lengthened} stop${lengthened > 1 ? "s" : ""} took ${nMax} nights instead of ${nMin} to ${nMax}, so the searches left could still close the loop`);
  const late = timeLeft() <= 0 && skipped > 0;
  // Partial: the breaker refused a search, or one of this run's own searches tripped it (a 429 with nothing
  // refused afterwards is the same hole), or the deadline cut the run, or the caller left.
  const partial = refused > 0 || throttled || late || aborted > 0;
  let note: string | undefined;
  if (refused > 0 || throttled) note = `Kiwi is throttling live searches from this address; ${loops.length ? "the loops shown come from what is known (the fare memory, the boards, the ground graph)" : "nothing is known for these dates yet"}. Try again in a few minutes.`;
  else if (!loops.length && budget === 0) note = "No loop closes from the fare memory, the boards and the ground graph alone; allow a few live searches.";
  // As many searches lost as made (the threshold the route uses before it keeps an answer): the failures, not the
  // window, are why nothing closed.
  else if (!loops.length && failed > 0 && failed >= searched) note = `${failed} of ${searched + failed} live searches failed and nothing remembered closes a loop for these dates; try again in a few minutes.`;
  else if (!loops.length) note = `No loop closed inside ${p.from} to ${p.to} with ${minNights} to ${maxNights} nights; try a wider window, fewer nights a stop or a bigger budget.`;
  else if (late) note = `Kiwi was slow: ${loops.length} loop${loops.length === 1 ? "" : "s"} found before the run reached its time limit.`;
  const top = loops.slice(0, MAX_LOOPS);
  say(`Done: ${top.length} loop${top.length === 1 ? "" : "s"}, ${searched} live search${searched === 1 ? "" : "es"}${failed ? `, ${failed} failed` : ""}, ${expanded} states expanded.`);
  return { loops: top, searched, failed, fromMemory, expanded, considered, note, partial: partial || undefined, generatedAt: at() };
}
