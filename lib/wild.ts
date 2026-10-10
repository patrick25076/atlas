// Server-only. Wild trips: the long, cheap, many-country loops a patient traveller builds by
// hand. Fly out (sometimes through a cheaper hub nearby), chain cheap one-way flights and
// ground hops through a far region for two or three nights a stop, fly home from the last
// city. Every price is a live Kiwi.com fare; living costs are estimated per country from
// World Bank price levels; an LLM then says whether the result is worth it (lib/judge.ts).
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import costsJson from "@/public/data/costs.json";
import visaJson from "@/public/data/visa.json";
import fameJson from "@/public/data/fame.json";
import weatherJson from "@/public/data/weather.json";
import { haversineKm } from "./geo";
import { countryAllowed } from "./been";
import { countryLabel, hubDegree, resolveGateway } from "./board";
import { neighboursOf } from "./combos";
import { kiwiDate, searchFlight, type KiwiItinerary } from "./kiwi";
import { visaFor, type City, type CountryInfo, type VisaFile } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const COSTS = costsJson as unknown as Record<string, number>;
const VISA = visaJson as unknown as VisaFile;
const FAME = fameJson as unknown as Record<string, [number, number, number]>;
/** Cities with a sea temperature are on the water: the beach half of a city-and-beach trip. */
const COASTAL = new Set(Object.keys((weatherJson as { sea?: Record<string, number> }).sea ?? {}));
const bigCity = (code: string) => hubDegree(code) >= 60;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);

/** How much a place is worth a stop: Wikipedia views and hub size, as a discount on its price. */
function worth(code: string): number {
  const views = FAME[code]?.[0] ?? 0;
  const listings = Math.max(0, FAME[code]?.[1] ?? 0);
  const fame = views > 0 ? Math.min(90, 22 * Math.log10(Math.max(1, views / 8000))) : 0;
  return fame + Math.min(30, listings) + Math.min(30, hubDegree(code) / 4);
}

/** Where a country is, for "which countries are near me now": the mean of its hub cities. */
const centroid = new Map<string, { lat: number; lon: number }>();
{
  const acc = new Map<string, { lat: number; lon: number; n: number }>();
  for (const [code, c] of Object.entries(CITIES)) {
    if (hubDegree(code) < 10) continue;
    const a = acc.get(c.country) ?? { lat: 0, lon: 0, n: 0 };
    acc.set(c.country, { lat: a.lat + c.lat, lon: a.lon + c.lon, n: a.n + 1 });
  }
  for (const [cc, a] of acc) centroid.set(cc, { lat: a.lat / a.n, lon: a.lon / a.n });
}

export type Region = keyof typeof REGIONS;
export const REGIONS = {
  sea: { label: "Southeast Asia", countries: [["TH", "Thailand"], ["VN", "Vietnam"], ["MY", "Malaysia"], ["SG", "Singapore"], ["ID", "Indonesia"], ["PH", "Philippines"], ["KH", "Cambodia"], ["LA", "Laos"]] },
  "east-asia": { label: "East Asia", countries: [["CN", "China"], ["HK", "Hong Kong"], ["JP", "Japan"], ["KR", "South Korea"], ["TW", "Taiwan"]] },
  "south-asia": { label: "South Asia", countries: [["IN", "India"], ["LK", "Sri Lanka"], ["MV", "Maldives"], ["NP", "Nepal"]] },
  "central-asia": { label: "Central Asia", countries: [["UZ", "Uzbekistan"], ["KZ", "Kazakhstan"], ["KG", "Kyrgyzstan"], ["TJ", "Tajikistan"], ["AZ", "Azerbaijan"]] },
  caucasus: { label: "Caucasus and Turkey", countries: [["GE", "Georgia"], ["AM", "Armenia"], ["AZ", "Azerbaijan"], ["TR", "Türkiye"]] },
  balkans: { label: "Balkans", countries: [["AL", "Albania"], ["ME", "Montenegro"], ["BA", "Bosnia & Herzegovina"], ["RS", "Serbia"], ["MK", "North Macedonia"], ["GR", "Greece"], ["BG", "Bulgaria"], ["HR", "Croatia"]] },
  "north-africa": { label: "North Africa and the Levant", countries: [["MA", "Morocco"], ["TN", "Tunisia"], ["EG", "Egypt"], ["JO", "Jordan"]] },
  gulf: { label: "Gulf", countries: [["AE", "United Arab Emirates"], ["OM", "Oman"], ["QA", "Qatar"], ["BH", "Bahrain"], ["SA", "Saudi Arabia"]] },
  "east-africa": { label: "East Africa", countries: [["KE", "Kenya"], ["TZ", "Tanzania"], ["UG", "Uganda"], ["RW", "Rwanda"], ["ET", "Ethiopia"]] },
  "southern-africa": { label: "Southern Africa", countries: [["ZA", "South Africa"], ["NA", "Namibia"], ["BW", "Botswana"], ["ZW", "Zimbabwe"], ["MU", "Mauritius"]] },
  americas: { label: "North and Central America", countries: [["US", "United States"], ["MX", "Mexico"], ["CU", "Cuba"], ["CR", "Costa Rica"], ["GT", "Guatemala"], ["CA", "Canada"]] },
  caribbean: { label: "Caribbean", countries: [["CU", "Cuba"], ["DO", "Dominican Republic"], ["JM", "Jamaica"], ["PR", "Puerto Rico"], ["CW", "Curaçao"]] },
  "south-america": { label: "South America", countries: [["BR", "Brazil"], ["AR", "Argentina"], ["CL", "Chile"], ["PE", "Peru"], ["CO", "Colombia"], ["BO", "Bolivia"], ["EC", "Ecuador"]] },
  oceania: { label: "Australia and the Pacific", countries: [["AU", "Australia"], ["NZ", "New Zealand"], ["FJ", "Fiji"]] },
  /** Any set of countries anywhere, given with `countries`; the engine refuses it without one. */
  custom: { label: "Custom countries", countries: [] },
} satisfies Record<string, { label: string; countries: [string, string][] }>;

/** Lower case, no diacritics, single spaces: "Türkiye", "turkiye" and "TÜRKIYE" are one word. */
export function fold(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every name a country goes by, folded, to ISO2: countries.json, the Intl label, the region tables, common aliases. */
const COUNTRY_BY_NAME = new Map<string, string>();
{
  const put = (name: string | undefined, cc: string) => {
    const k = name ? fold(name) : "";
    if (k && !COUNTRY_BY_NAME.has(k)) COUNTRY_BY_NAME.set(k, cc);
  };
  for (const cc of Object.keys(COUNTRIES)) put(COUNTRIES[cc].name, cc);
  // VA's label is "Rome" (the boards' habit); a traveller typing Rome means the city, not a country.
  for (const cc of Object.keys(COUNTRIES)) if (cc !== "VA") put(countryLabel(cc), cc);
  for (const r of Object.values(REGIONS)) for (const [cc, name] of r.countries) put(name, cc);
  const aliases: Record<string, string> = { usa: "US", "united states of america": "US", america: "US", uk: "GB", britain: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", holland: "NL", turkey: "TR", "czech republic": "CZ", "south korea": "KR", korea: "KR", vietnam: "VN", "viet nam": "VN", uae: "AE", emirates: "AE", russia: "RU", macedonia: "MK", bosnia: "BA", "ivory coast": "CI", "cape verde": "CV", burma: "MM", laos: "LA", iran: "IR", syria: "SY", tanzania: "TZ", moldova: "MD", bolivia: "BO", venezuela: "VE", taiwan: "TW", "hong kong": "HK", macau: "MO", palestine: "PS", brunei: "BN", "st lucia": "LC", "saint lucia": "LC", "the netherlands": "NL", "the philippines": "PH", "the gambia": "GM", "the maldives": "MV", "the bahamas": "BS" };
  for (const [name, cc] of Object.entries(aliases)) if (COUNTRIES[cc]) put(name, cc);
}

/**
 * Countries given any way a traveller writes them (ISO2, a name, "Türkiye", "turkey"): the
 * codes we know, in the order given without repeats, and the entries we could not read.
 */
export function resolveCountries(list: readonly unknown[] | undefined): { codes: string[]; unknown: string[] } {
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const raw of list ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const up = s.toUpperCase();
    const cc = /^[A-Z]{2}$/.test(up) && COUNTRIES[up] ? up : COUNTRY_BY_NAME.get(fold(s));
    if (cc) {
      if (!codes.includes(cc)) codes.push(cc);
    } else unknown.push(s.slice(0, 40));
  }
  return { codes, unknown };
}

/** A comma list of countries from a query string, names or codes mixed. */
export function parseCountries(raw: string | null | undefined): { codes: string[]; unknown: string[] } {
  return resolveCountries((raw ?? "").split(","));
}

/** City names, folded, to the city code; when two cities share a name the bigger hub wins. */
const CITY_BY_NAME = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = fold(c.name);
  const prev = CITY_BY_NAME.get(k);
  if (!prev || hubDegree(code) > hubDegree(prev)) CITY_BY_NAME.set(k, code);
}

/** A city given as its code (BKK), one of its airports (HAN) or a name ("Hanoi", "hanoi"): the city code, or null. */
export function findCityCode(s: unknown): string | null {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const up = t.toUpperCase();
  if (/^[A-Z]{3}$/.test(up)) {
    if (CITIES[up]) return up;
    const c = cityOf.get(up);
    if (c) return c;
  }
  return CITY_BY_NAME.get(fold(t)) ?? null;
}

/** Cities given any way: the codes we know, in order without repeats, and what we could not read. */
export function resolveCities(list: readonly unknown[] | undefined): { codes: string[]; unknown: string[] } {
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const raw of list ?? []) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const code = findCityCode(s);
    if (code) {
      if (!codes.includes(code)) codes.push(code);
    } else unknown.push(s.slice(0, 40));
  }
  return { codes, unknown };
}

/** A comma list of cities from a query string, names or codes mixed. */
export function parseCities(raw: string | null | undefined): { codes: string[]; unknown: string[] } {
  return resolveCities((raw ?? "").split(","));
}

/** "3" or "3-5": the nights a stop may run, as [min, max]; null when it is not a number. */
export function parseNightsRange(raw: string | number | null | undefined): [number, number] | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const m = /^(\d{1,2})\s*(?:-|to)\s*(\d{1,2})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a > 0 && b > 0 ? [Math.min(a, b), Math.max(a, b)] : null;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? [Math.round(n), Math.round(n)] : null;
}

/** Words in a wish that name a style: "street food" leans to food, "no beaches" away from the coast. */
const WISH_WORDS: [RegExp, Style][] = [
  [/\b(beach|beaches|island|islands|sea|snorkel|snorkeling|diving|surf|surfing|swim|swimming|sunsets?)\b/, "beaches"],
  [/\b(food|eat|eating|street food|markets?|cuisine|dishes?|restaurants?|cooking|coffee)\b/, "food"],
  [/\b(temples?|treks?|trekking|hikes?|hiking|nature|mountains?|jungle|villages?|homestays?|loops?|boats?|caves|wildlife|ruins|waterfalls?|adventure)\b/, "experiences"],
  [/\b(city|cities|nightlife|museums?|bars|clubs|architecture|shopping|urban|skyline)\b/, "cities"],
  [/\b(slow|relax|relaxed|calm|quiet|rest|chill|unhurried|peaceful)\b/, "slow"],
];
export type WishTilt = Partial<Record<Style, 1 | -1>>;
/**
 * The style tilt a wish text implies: 1 for a style it asks for, -1 for one it refuses
 * ("no beaches", "skip the big cities"). Each clause is read on its own, so "no beaches,
 * lots of street food" is a minus on beaches and a plus on food.
 */
export function wishTilt(wishes?: string): WishTilt {
  const tilt: WishTilt = {};
  const text = String(wishes ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  if (!text.trim()) return tilt;
  for (const clause of text.split(/[,;.!?\n]|\bbut\b|\band\b/)) {
    const words = clause.replace(/[^a-z0-9]+/g, " ").trim();
    if (!words) continue;
    const neg = /\b(no|not|without|avoid|skip|hate|never|less)\b/.test(words);
    for (const [re, style] of WISH_WORDS) if (re.test(words)) tilt[style] = neg ? -1 : 1;
  }
  return tilt;
}

/**
 * Six base-36 characters for a free text, FNV-1a over its folded words: the same wish spelled
 * with different capitals or punctuation is one key, and a stored trip never answers another wish.
 */
export function wishesToken(wishes?: string): string {
  const text = fold(wishes ?? "");
  if (!text) return "";
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `w${(h % 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** What the traveller is after; steers the chain, the costs and the planner. */
export type Style = "experiences" | "beaches" | "food" | "cities" | "slow";
export type Budget = "backpacker" | "mid" | "comfort";
export const BUDGET_SCALE: Record<Budget, number> = { backpacker: 0.65, mid: 1, comfort: 1.7 };
/** The most countries a chain considers, custom list included: the biggest region has eight. */
const MAX_COUNTRIES = 8;
/** Chain steps at the most, whatever the nights or an explicit maxStops: each step is up to four searches. */
const MAX_CHAIN_STEPS = 8;
/** Nearby hubs that often sell the cheap long-hauls: positioning flights go here first. */
const HUBS =["BUD", "VIE", "WAW", "IST", "MIL", "LON", "PAR", "FRA", "AMS", "MAD", "ROM", "BER", "PRG", "ATH", "DUB", "CPH", "STO", "LIS", "BCN", "MUC", "ZRH", "BRU"];

export type WildStop = { code: string; name: string; country: string; lat: number; lon: number; arrive: string; depart: string; nights: number; perDay: number; visa?: string | null; warning?: boolean; note?: string };
export type WildLeg =
  | { kind: "fly"; from: string; to: string; fromName: string; toName: string; date: string; departAt: string; arriveAt: string; price: number; hours: number; stops: number; route: string[]; carriers: string[]; url: string }
  | { kind: "ground"; from: string; to: string; fromName: string; toName: string; date: string; minutes: number; mode: string; estimated: boolean; price: number };
export type Judge = { score: number; verdict: string; reasons: string[]; tweaks: string[]; bestFor: string };
export type WildTrip = {
  id: string;
  region: Region;
  regionLabel: string;
  home: string;
  passport: string;
  prefs: { style: Style; budget: Budget };
  title: string;
  legs: WildLeg[];
  stops: WildStop[];
  totals: { flights: number; ground: number; living: number; all: number; perDay: number; nights: number; hoursInAir: number; countries: number };
  outDate: string;
  backDate: string;
  judge?: Judge;
  searched: number;
  generatedAt: string;
  /** The traveller's own words, when given; the judge and the planner read them. */
  wishes?: string;
  /** City codes the chain was asked to pass through, in the order it did. */
  mustInclude?: string[];
  /** The airports the way in left from when they were not the home ones. */
  startFrom?: string[];
  /** The longest flight (door to door, hours) any leg was allowed. */
  maxFlightHours?: number;
  /** Plain lines saying which of the traveller's constraints shaped this trip. */
  constraints?: string[];
  /** Other ranked versions of the same request (variants), lighter than a full trip. */
  alternatives?: { variant: string; rank: number; score: number; title: string; totals: WildTrip["totals"]; judge?: Judge; outDate: string; backDate: string; legs: WildLeg[]; stops: WildStop[] }[];
  variant?: string;
};

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const dayOf = (t: string) => t.slice(0, 10);
const hoursOf = (it: KiwiItinerary) => Math.round(it.outbound.durationSeconds / 360) / 10;
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;

/** Daily budget: hotel, food, local transport, one activity; mid-range by default. */
export function perDayFor(cc: string, budget: Budget = "mid"): number {
  const ratio = COSTS[cc] ?? 0.7;
  return Math.round(92 * BUDGET_SCALE[budget] * Math.pow(Math.min(1.6, Math.max(0.25, ratio)), 0.8));
}

function cityOfItinerary(it: KiwiItinerary): string {
  return cityOf.get(it.outbound.to) ?? it.outbound.to;
}

function flyLeg(from: string, it: KiwiItinerary): WildLeg {
  const to = cityOfItinerary(it);
  return {
    kind: "fly",
    from,
    to,
    fromName: CITIES[from]?.name ?? it.outbound.segments[0]?.fromCity ?? from,
    toName: CITIES[to]?.name ?? it.outbound.segments.at(-1)?.toCity ?? to,
    date: dayOf(it.outbound.departureTime),
    departAt: it.outbound.departureTime,
    arriveAt: it.outbound.arrivalTime,
    price: Math.round(it.price),
    hours: hoursOf(it),
    stops: it.outbound.stops,
    route: it.outbound.route,
    carriers: [...new Set(it.outbound.segments.map((s) => s.carrierName || s.carrier))],
    url: it.bookingUrl,
  };
}

export type WildParams = {
  gateways: string[];
  home: string;
  region: Region;
  month?: string;
  /** An explicit departure window (YYYY-MM-DD) used instead of month; at most ten days wide. */
  from?: string;
  to?: string;
  /** 5 to 90; past 28 the trip becomes five to seven bases of eight to twelve nights. */
  nights: number;
  style?: Style;
  budget?: Budget;
  /** Where the traveller actually lives: the last leg home from whichever airport is cheapest. */
  origin?: { lat: number; lon: number; label: string };
  /** A night or two in a hub on the way home when it costs about the same (default on). */
  stopover?: boolean;
  /** Only these countries (ISO2 or names), instead of the region's list; eight at most, unknown entries ignored. Required with region "custom". */
  countries?: string[];
  /** Countries (ISO2 or names) to favour in the chain. */
  prefer?: string[];
  /** Chain stops; clamped to the countries available and to eight. */
  maxStops?: number;
  /** Nights a stop; never under two (five past 28 nights). */
  nightsPerStop?: number;
  /** With nightsPerStop, the most nights a stop may run: the hop is searched over the whole range and the cheapest day wins. */
  nightsPerStopMax?: number;
  /** Cities (codes or names) the chain must pass through as stops, visited nearest first; an Error names the one that cannot be reached. */
  mustInclude?: string[];
  /** The longest flight (hours, door to door) any leg may take; longer itineraries are skipped. */
  maxFlightHours?: number;
  /** Airports (IATA) the way in leaves from instead of the home gateways; the way home still lands at the home ones. */
  startFrom?: string[];
  /** The traveller's own words ("temples and street food, no beaches"); a tilt on the chain, and read by the judge and the planner. */
  wishes?: string;
  /**
   * A moment (epoch ms) past which the chain stops growing and the way home is searched from
   * the stops found so far: the trip stays whole (the last stop just runs longer) instead of
   * a caller with a time cap getting nothing. The way in and the way home are never skipped.
   */
  deadline?: number;
  /** How to trade euros for hours: "price" takes the cheapest, "comfort" pays more for short flights and few stops. */
  tradeoff?: Tradeoff;
  /** Skip the hub positioning (fly only from the home airports). */
  noHubs?: boolean;
  /**
   * "Been" (ISO2): never a stop or a landing, and no stopover night in a hub there. A hub
   * is still fine as positioning on the way in (a connection), and a layover is always fine.
   */
  exclude?: string[];
  onProgress?: (line: string) => void;
};

export type Tradeoff = "price" | "balanced" | "comfort";
/** Euros one hour of travel is worth, per tradeoff: way in, chain hops, way home. */
const HOUR_VALUE: Record<Tradeoff, [number, number, number]> = { price: [5, 7, 7], balanced: [9, 11, 12], comfort: [18, 20, 24] };

/** Airlines and hubs with a free or near-free stopover programme: a night in the hub city on
 * the way, hotel included or cheap. Worth saying when a leg goes through one. */
export const STOPOVER_PROGRAMMES: Record<string, { airline: string; note: string }> = {
  IST: { airline: "Turkish Airlines", note: "Turkish Airlines Stopover: a free hotel night (two in business) in Istanbul on international connections, booked through their site; verify current terms." },
  DOH: { airline: "Qatar Airways", note: "Qatar Stopover: Doha hotel from about $14 a night for 1 to 4 nights when booked with the ticket; verify current terms." },
  DXB: { airline: "Emirates", note: "Emirates Dubai Stopover packages: discounted hotel nights; verify current terms." },
  LIS: { airline: "TAP", note: "TAP Portugal Stopover: up to 10 days in Lisbon or Porto at no extra fare; verify current terms." },
  KEF: { airline: "Icelandair", note: "Icelandair Stopover: up to 7 days in Iceland at no extra fare on transatlantic routes." },
  SIN: { airline: "Singapore Airlines", note: "Singapore Stopover Holiday: cheap hotel-and-transfer packages; verify current terms." },
  ADD: { airline: "Ethiopian", note: "Ethiopian Airlines offers free Addis Ababa stopover hotels on long layovers; verify." },
  HEL: { airline: "Finnair", note: "Finnair Stopover: up to 5 days in Finland at no extra fare." },
  AMS: { airline: "KLM", note: "KLM offers stopover-friendly fares in Amsterdam; verify." },
};

export async function buildWild(p: WildParams): Promise<WildTrip | null> {
  const say = p.onProgress ?? (() => {});
  // A plain object lookup also matches inherited names ("constructor"), and a truthy check
  // upstream lets those through; only a key of our own is a region.
  if (!Object.hasOwn(REGIONS, p.region)) throw new Error(`unknown region ${String(p.region)}; one of ${Object.keys(REGIONS).join(", ")}`);
  const region = REGIONS[p.region];
  const style: Style = p.style ?? "experiences";
  const budget: Budget = p.budget ?? "mid";
  const tradeoff: Tradeoff = p.tradeoff ?? "balanced";
  const [hIn, hHop, hHome] = HOUR_VALUE[tradeoff];
  const stopsPenalty = (stops: number) => (tradeoff === "comfort" ? stops * 60 : tradeoff === "balanced" ? stops * 20 : 0);
  const constraints: string[] = [];
  // A custom list is bounded like a region (eight countries) and keeps only countries we know,
  // given as codes or names: the way in is one search per origin and country, so an unbounded
  // list, or a word that would reach Kiwi as "Unknown Region", multiplies searches that return nothing.
  const given = resolveCountries(p.countries);
  if (p.countries?.length && !given.codes.length) throw new Error(`none of those is a country we know: ${given.unknown.join(", ")} (use a name such as Vietnam or a code such as VN)`);
  if (p.region === "custom" && !given.codes.length) throw new Error("region custom needs a countries list (names or codes)");
  const only = given.codes.slice(0, MAX_COUNTRIES);
  // "Been": a visited country is never a stop, so it leaves the list before any search.
  const exclude = p.exclude ?? [];
  // Cities the chain must pass through: their countries join the list, so a must city outside
  // the region is reachable; one in a visited or unsafe country is refused before any search.
  const must = resolveCities(p.mustInclude);
  if (must.unknown.length) throw new Error(`unknown city to pass through: ${must.unknown.join(", ")} (a city name such as Hanoi or a code such as HAN)`);
  const mustCodes = must.codes.slice(0, MAX_CHAIN_STEPS);
  for (const code of mustCodes) {
    const cc = CITIES[code].country;
    if (!countryAllowed(cc, exclude)) throw new Error(`${CITIES[code].name} is in ${countryLabel(cc)}, which is on your been list; allow revisits or drop it`);
    if (unsafe(cc)) throw new Error(`${CITIES[code].name} is in ${countryLabel(cc)}, under a full travel warning`);
    if (only.length && !only.includes(cc) && only.length < MAX_COUNTRIES) only.push(cc);
  }
  const base: [string, string][] = only.length ? only.map((cc) => [cc, countryLabel(cc)] as [string, string]) : [...region.countries];
  for (const code of mustCodes) {
    const cc = CITIES[code].country;
    if (!base.some(([c]) => c === cc)) base.push([cc, countryLabel(cc)]);
  }
  const countries = base.filter(([cc]) => !unsafe(cc) && countryAllowed(cc, exclude));
  // A country list replaces the region's list whatever region was named, so the trip is a
  // custom one: labelled by its countries, tagged on the globe by them, keyed as custom.
  const effectiveRegion: Region = only.length ? "custom" : p.region;
  const regionLabel = effectiveRegion === "custom" ? countries.map(([, name]) => name).join(", ") : region.label;
  if (!countries.length && base.some(([cc]) => !unsafe(cc))) throw new Error(`every country of ${regionLabel} is on your been list; pick another region or allow revisits`);
  if (!countries.length) throw new Error(`no country to visit in ${regionLabel}`);
  /** True when a night in this city is allowed (its country is not on the been list). */
  const nightOk = (cityCode: string) => countryAllowed(CITIES[cityCode]?.country, exclude);
  const prefer = new Set(resolveCountries(p.prefer).codes);
  const isMust = (code: string) => mustCodes.includes(code);
  // The longest flight allowed per leg, door to door; itineraries over it are never considered.
  const maxH = p.maxFlightHours && Number.isFinite(p.maxFlightHours) && p.maxFlightHours > 0 ? p.maxFlightHours : 0;
  const hoursOk = (it: KiwiItinerary) => !maxH || hoursOf(it) <= maxH;
  // The wishes tilt the chain the way a style does, but only for what they name.
  const tilt = wishTilt(p.wishes);
  const wishScore = (code: string): number => {
    let v = 0;
    const coastal = COASTAL.has(code);
    const big = bigCity(code);
    if (tilt.beaches) v += tilt.beaches * (coastal ? 50 : -10);
    if (tilt.cities) v += tilt.cities * (big ? 35 : -10);
    if (tilt.experiences) v += tilt.experiences * (big ? -15 : 30);
    if (tilt.food) v += tilt.food * Math.min(20, Math.max(0, FAME[code]?.[1] ?? 0));
    return v;
  };
  if (p.wishes?.trim()) constraints.push(`wishes: ${p.wishes.trim().slice(0, 120)}${Object.keys(tilt).length ? ` (leaning ${Object.entries(tilt).map(([k, v]) => `${v > 0 ? "towards" : "away from"} ${k}`).join(", ")})` : ""}`);
  if (mustCodes.length) constraints.push(`passes through ${mustCodes.map((c) => CITIES[c].name).join(", ")}`);
  if (maxH) constraints.push(`no flight over ${maxH} h`);
  if (only.length) constraints.push(`countries: ${countries.map(([, n]) => n).join(", ")}`);
  // The home airport is the biggest of the visitor's airports (Otopeni, not Ghimbav); the
  // nearest small one still gets a look as a second origin. An explicit startFrom replaces
  // them for the way in only; the way home still lands at the traveller's own airports.
  const startCodes = p.startFrom?.length ? p.startFrom : p.gateways;
  const homeGateways = startCodes.map((g) => resolveGateway(g)).filter((g): g is NonNullable<typeof g> => !!g);
  const returnGateways = p.gateways.map((g) => resolveGateway(g)).filter((g): g is NonNullable<typeof g> => !!g);
  const gw = [...homeGateways].sort((a, b) => hubDegree(cityOf.get(b.code) ?? b.code) - hubDegree(cityOf.get(a.code) ?? a.code))[0];
  // An airport the data does not know is the traveller's mistake, named, not "no way into the region".
  if (!gw && p.startFrom?.length) throw new Error(`unknown start airport ${p.startFrom.join(", ")}; use a three-letter airport code such as LON or VIE`);
  if (!gw) return null;
  if (p.startFrom?.length && homeGateways.length) constraints.push(`starts from ${homeGateways.map((g) => g.label).join(" or ")}`);
  const homeCity = cityOf.get(gw.code) ?? gw.code;
  const secondHome = homeGateways.find((g) => g.code !== gw.code);
  let searched = 0;
  const count = <T,>(x: T): T => {
    searched++;
    return x;
  };
  // Refused searches are counted with the last reason, so a build where every search was
  // refused (Kiwi's breaker, the daily budget) says that, not "no way into the region".
  const fails = { n: 0, last: "" };
  const search = async (from: string, to: string, a: string, b: string): Promise<KiwiItinerary[]> => {
    try {
      const r = await searchFlight({ flyFrom: from, flyTo: to, departureDate: kiwiDate(a), departureDateTo: kiwiDate(b) });
      return r.itineraries;
    } catch (err) {
      fails.n++;
      fails.last = err instanceof Error ? err.message : String(err);
      return [];
    }
  };
  const outOfTime = () => !!p.deadline && Date.now() > p.deadline;

  // The window: the dates asked for (clipped to ten days), else the first ten days of the
  // month asked for, else three to five weeks from now.
  const today = new Date();
  let start = new Date(today.getTime() + 21 * 86_400_000);
  const isoDay = (s?: string): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isoDay(p.from)) {
    const earliest = new Date(today.getTime() + 2 * 86_400_000);
    start = Date.parse(p.from) > earliest.getTime() ? new Date(Date.parse(p.from)) : earliest;
  } else if (p.month && /^\d{4}-\d{2}$/.test(p.month)) {
    const [y, m] = p.month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const earliest = new Date(today.getTime() + 10 * 86_400_000);
    start = first > earliest ? first : earliest;
  }
  const from = start.toISOString().slice(0, 10);
  // A window given as [from, to] is kept as is, up to ten days; from == to is one fixed day.
  const to = isoDay(p.from) && isoDay(p.to) && p.to >= from && p.to <= addDays(from, 10) ? p.to : addDays(from, 10);
  // Up to 90 nights; past four weeks the chain is a handful of real bases, not a sprint.
  const totalNights = Math.min(90, Math.max(2, Math.round(p.nights)));

  // The shape of the chain, settled before any search so an impossible ask costs nothing.
  // Slow travel means fewer, longer stops; experiences need three nights to get out of town.
  // Past four weeks the trip is lived in bases: five to seven of them, eight to twelve nights
  // each (sixty nights is six bases of ten), however many countries the region has: a long
  // trip may visit a second city in a country already seen (Oceania has three countries).
  const long = totalNights > 28;
  // Explicit values are clamped the way the defaults are: the chain never runs more than
  // MAX_CHAIN_STEPS steps (four searches each) and a stop is never under two nights (five on
  // a long trip), so a request for sixty one-night stops cannot spend hundreds of searches
  // on an itinerary nobody asked for.
  const asked = (n: number | undefined) => (n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
  // The chain must have room for every city the traveller named, within the hard cap.
  const maxStops = Math.max(
    Math.min(MAX_CHAIN_STEPS, mustCodes.length),
    Math.min(
      MAX_CHAIN_STEPS,
      asked(p.maxStops)
        ? Math.max(1, long ? asked(p.maxStops) : Math.min(countries.length, asked(p.maxStops)))
        : long
          ? Math.max(5, Math.min(7, Math.round(totalNights / 10)))
          : style === "slow"
            ? Math.min(countries.length, 3)
            : Math.min(countries.length, 5),
    ),
  );
  const floorNights = style === "slow" ? 4 : style === "experiences" ? 3 : 2;
  // Up to two weeks a stop is two or three nights; past that the stops grow with the nights
  // asked (28 nights over five stops is five a stop), so the chain itself covers the trip
  // instead of ending around night fifteen and leaving the way home to pick the length.
  // A short trip (under a week) keeps every stop at two nights, so three stops still fit.
  const capNights = style === "slow" ? 7 : totalNights > 14 ? 6 : 3;
  const nightsPerStop = asked(p.nightsPerStop)
    ? Math.max(long ? 5 : 2, Math.min(long ? 30 : 10, asked(p.nightsPerStop)))
    : long
      ? Math.max(8, Math.min(12, Math.floor((totalNights - 1) / maxStops)))
      : totalNights < 7
        ? 2
        : Math.min(capNights, Math.max(floorNights, Math.floor((totalNights - 1) / maxStops)));
  // A range of nights a stop ("3-5"): the hop out of a stop is searched over the whole range
  // and the cheapest day wins; without one, two departure days as before.
  const hopDays = asked(p.nightsPerStopMax) > nightsPerStop ? Math.min(10, asked(p.nightsPerStopMax) - nightsPerStop) : 1;
  if (asked(p.nightsPerStop)) constraints.push(`${nightsPerStop}${hopDays > 1 ? ` to ${nightsPerStop + hopDays}` : ""} nights a stop`);
  // Every must city after the landing costs a full stay at the stop before it, and the last
  // one at least a night: when that does not fit the nights asked, no search can make it fit.
  // The landing may itself be a must city, so one city is counted as free.
  if (mustCodes.length && (mustCodes.length - 1) * nightsPerStop + 1 > totalNights) {
    throw new Error(`${totalNights} nights are not enough to pass through ${mustCodes.map((c) => CITIES[c].name).join(", ")} at ${nightsPerStop} nights a stop; add nights, drop a city or lower nightsPerStop`);
  }

  // 1. The way in: home airport and the two nearest big hubs, to every country of the region.
  const hubs = p.noHubs
    ? []
    : HUBS.filter((h) => h !== homeCity && CITIES[h])
        .map((h) => ({ h, km: haversineKm(gw.lat, gw.lon, CITIES[h].lat, CITIES[h].lon) }))
        .filter((x) => x.km > 150 && x.km < 1800)
        .sort((a, b) => a.km - b.km)
        .slice(0, 2)
        .map((x) => x.h);
  const origins = [gw.code, ...(secondHome ? [secondHome.code] : []), ...hubs];
  const isHome = (o: string) => o === gw.code || o === secondHome?.code;
  say(`Looking for the cheapest way into ${regionLabel} from ${gw.label}${secondHome ? ` or ${secondHome.label}` : ""}${hubs.length ? `, or via ${hubs.map((h) => CITIES[h].name).join(" and ")}` : ""}…`);
  // A country search answers with the fifteen cheapest landings, which may miss a city the
  // traveller must pass through: the first must city gets a search of its own from each origin.
  const inboundTargets: [string, string][] = [...countries.map(([cc, name]) => [cc, name] as [string, string]), ...(mustCodes[0] ? [[CITIES[mustCodes[0]].country, mustCodes[0]] as [string, string]] : [])];
  const inbound = await Promise.all(origins.flatMap((o) => inboundTargets.map(async ([cc, name]) => ({ origin: o, cc, its: count(await search(o, name, from, to)) }))));
  // Every way-in search refused: the reason (throttled, budget spent) is the answer, not "no way in".
  if (inbound.length && fails.n >= inbound.length && !inbound.some((r) => r.its.length)) throw new Error(fails.last || "every live search was refused; try again in a few minutes");
  type Entry = { origin: string; it: KiwiItinerary; score: number; positioning?: KiwiItinerary };
  const entries: Entry[] = [];
  let overHours = 0;
  for (const r of inbound) {
    for (const it of r.its) {
      // A country search can still land at an airport we map to a neighbour: checked per landing.
      if (!nightOk(cityOfItinerary(it))) continue;
      if (!hoursOk(it)) {
        overHours++;
        continue;
      }
      const hubPenalty = isHome(r.origin) ? 0 : 70;
      const landing = cityOfItinerary(it);
      // Landing somewhere worth the first nights beats landing in the cheapest corner of a
      // country; landing in a city the chain must pass through anyway is worth a lot.
      entries.push({ origin: r.origin, it, score: it.price + hubPenalty + hIn * hoursOf(it) + stopsPenalty(it.outbound.stops) - 0.8 * worth(landing) - 0.5 * wishScore(landing) - (isMust(landing) ? 150 : 0) });
    }
  }
  entries.sort((a, b) => a.score - b.score);
  if (!entries.length && overHours) throw new Error(`every way into ${regionLabel} takes more than ${maxH} h door to door; raise maxFlightHours or pick a nearer region`);
  if (!entries.length) return null;
  // A cheap landing in a place nobody wants three nights in (Urumqi for China) only wins
  // when it undercuts the best known city by a wide margin. A must city always stays.
  const famous = entries.find((e) => worth(cityOfItinerary(e.it)) >= 70);
  if (famous) {
    const cut = famous.score - 120;
    const keep = entries.filter((e) => worth(cityOfItinerary(e.it)) >= 70 || e.score < cut || isMust(cityOfItinerary(e.it)));
    entries.length = 0;
    entries.push(...keep);
  }

  // Positioning for a hub entry: arrive the day before or the same day with three hours to spare.
  let entry: Entry | null = null;
  for (const e of entries.slice(0, 4)) {
    if (isHome(e.origin)) {
      entry = e;
      break;
    }
    const lhDay = dayOf(e.it.outbound.departureTime);
    const pos = count(await search(gw.code, e.origin, addDays(lhDay, -1), lhDay));
    // Positioning through a visited hub is a connection and stays allowed; arriving the day
    // before would be a night there, so for such a hub only same-day arrivals count.
    const hubNight = nightOk(e.origin);
    const ok = pos
      .filter((x) => hoursOk(x) && Date.parse(x.outbound.arrivalTime) + 3 * 3_600_000 <= Date.parse(e.it.outbound.departureTime) && (hubNight || dayOf(x.outbound.arrivalTime) === lhDay))
      .sort((a, b) => a.price - b.price)[0];
    if (ok) {
      entry = { ...e, positioning: ok };
      break;
    }
  }
  if (!entry) entry = entries.find((e) => isHome(e.origin)) ?? null;
  if (!entry) return null;

  const legs: WildLeg[] = [];
  const stops: WildStop[] = [];
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const addStop = (code: string, arrive: string, nights = nightsPerStop) => {
    const c = CITIES[code];
    const cc = c?.country ?? "";
    stops.push({ code, name: c?.name ?? code, country: cc, lat: c?.lat ?? 0, lon: c?.lon ?? 0, arrive, depart: addDays(arrive, nights), nights, perDay: perDayFor(cc, budget), visa: cc && cc !== p.home ? visaFor(VISA, p.home, cc) : null, warning: COUNTRIES[cc]?.advisory?.partial || undefined });
  };
  const leave = (on: string) => {
    const s = stops.at(-1)!;
    s.depart = on;
    s.nights = Math.max(1, daysBetween(s.arrive, on));
  };
  const startCity = isHome(entry.origin) ? (cityOf.get(entry.origin) ?? entry.origin) : homeCity;
  if (entry.positioning) {
    legs.push(flyLeg(startCity, entry.positioning));
    // A night in the hub before the long-haul is a night that costs money: show it as a stop.
    const posDay = dayOf(entry.positioning.outbound.arrivalTime);
    const lhDay = dayOf(entry.it.outbound.departureTime);
    if (posDay < lhDay) addStop(entry.origin, posDay, daysBetween(posDay, lhDay));
  }
  legs.push(flyLeg(entry.positioning ? entry.origin : startCity, entry.it));
  // A hub night on the way in may be a free hotel night with the airline's stopover programme.
  if (entry.positioning && stops.length) {
    const prog = STOPOVER_PROGRAMMES[entry.origin];
    if (prog && entry.it.outbound.segments.some((s) => (s.carrierName || "").includes(prog.airline.split(" ")[0]))) stops[stops.length - 1].note = prog.note;
  }
  let current = cityOfItinerary(entry.it);
  let date = dayOf(entry.it.outbound.arrivalTime);
  const visited = new Set<string>([CITIES[current]?.country ?? ""]);
  const visitedCities = new Set<string>([current]);
  const outDate = legs[0].kind === "fly" ? legs[0].date : from;
  say(`Way in found: ${legs.map((l) => (l.kind === "fly" ? `${l.fromName} → ${l.toName} €${l.price}` : "")).join(", ")}.`);

  // 2. The chain: two or three nights a stop, then the cheapest worthwhile hop to a country not
  // yet seen, among the four nearest. A stop's nights follow the flight that actually leaves it.
  const endDate = addDays(outDate, totalNights);
  addStop(current, date);
  // The cities still to pass through; the one nearest the current stop is next, so the chain
  // stays geographic (Hanoi then Bangkok from the north, the other way round from the south).
  const pending = new Set(mustCodes.filter((c) => c !== current));
  const passed: string[] = isMust(current) ? [current] : [];
  for (let step = 0; step < maxStops; step++) {
    const earliest = addDays(stops.at(-1)!.arrive, nightsPerStop);
    // A city still to pass through gets squeezed in as long as a day is left (the way home
    // then leaves from it); a free stop needs a full stay's worth of days.
    const room = daysBetween(earliest, endDate);
    if (pending.size ? room < 1 : room < nightsPerStop + 1) {
      if (pending.size) throw new Error(`${totalNights} nights are not enough to pass through ${[...pending].map((c) => CITIES[c].name).join(" and ")}; add nights or drop a city`);
      break;
    }
    const cur = CITIES[current];
    // A caller with a time cap gets the loop built so far, closed by the way home, rather
    // than nothing; a city still to pass through is never skipped for it.
    if (!pending.size && outOfTime()) {
      say("Out of time: heading home from here.");
      break;
    }
    // A forced hop: the nearest city still to pass through, by flight or by ground.
    if (pending.size) {
      // The current stop may be an airport we map to no city (no coordinates): then the must cities go in the order given.
      const target = cur ? [...pending].sort((a, b) => haversineKm(cur.lat, cur.lon, CITIES[a].lat, CITIES[a].lon) - haversineKm(cur.lat, cur.lon, CITIES[b].lat, CITIES[b].lon))[0] : [...pending][0];
      const link = cur ? neighboursOf(current).find((n) => n.code === target && n.minutes <= 12 * 60) : undefined;
      // The hop window never runs past the day before the end, so a stop squeezed in on the
      // last day still leaves a night there and a day for the way home.
      const hopTo = [addDays(earliest, hopDays), addDays(endDate, -1)].sort()[0];
      const its = count(await search(current, target, earliest, hopTo < earliest ? earliest : hopTo));
      const best = its.filter((it) => cityOfItinerary(it) === target && hoursOk(it)).sort((a, b) => a.price + hHop * hoursOf(a) + stopsPenalty(a.outbound.stops) - (b.price + hHop * hoursOf(b) + stopsPenalty(b.outbound.stops)))[0];
      // Ground wins when it is there and the flight is not clearly better (a short hop at a fair price).
      if (link && (!best || best.price + hHop * hoursOf(best) > 20 + hHop * (link.minutes / 60))) {
        leave(earliest);
        legs.push({ kind: "ground", from: current, to: target, fromName: cur?.name ?? current, toName: CITIES[target].name, date: earliest, minutes: link.minutes, mode: link.mode, estimated: link.estimated, price: 20 });
        current = target;
        date = earliest;
      } else if (best) {
        leave(dayOf(best.outbound.departureTime));
        legs.push(flyLeg(current, best));
        current = target;
        date = dayOf(best.outbound.arrivalTime);
      } else {
        throw new Error(`no way found from ${cur?.name ?? current} to ${CITIES[target].name} around ${earliest}${maxH ? ` under ${maxH} h` : ""}; try other dates or drop it`);
      }
      pending.delete(target);
      passed.push(target);
      addStop(current, date);
      visited.add(CITIES[current].country);
      visitedCities.add(current);
      say(`Next: ${CITIES[current].name} (${CITIES[current].country}), as asked.`);
      continue;
    }
    const byDistance = (list: [string, string][]) =>
      list
        .map(([cc, name]) => ({ cc, name, km: centroid.has(cc) && cur ? haversineKm(cur.lat, cur.lon, centroid.get(cc)!.lat, centroid.get(cc)!.lon) : 2000 }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 4);
    let remaining = byDistance(countries.filter(([cc]) => !visited.has(cc)));
    // A long trip in a small region runs out of new countries before it runs out of nights:
    // then a second city in a country already seen is fine, as long as it is a real move.
    const revisit = !remaining.length && long;
    if (revisit) remaining = byDistance(countries);
    if (!remaining.length) break;
    /** A second city in a visited country must be its own place: 250 km from every earlier base there. */
    const farEnough = (code: string) => {
      const c = CITIES[code];
      if (!c || visitedCities.has(code)) return false;
      if (!visited.has(c.country)) return true;
      return stops.every((s) => s.country !== c.country || haversineKm(s.lat, s.lon, c.lat, c.lon) >= 250);
    };
    // Ground hops across a border count as a candidate without a search (Shenzhen to Hong Kong).
    const ground = cur
      ? neighboursOf(current).filter((n) => CITIES[n.code] && farEnough(n.code) && remaining.some((r) => r.cc === CITIES[n.code].country) && n.minutes <= 240 && worth(n.code) >= 40)
      : [];
    const flights = await Promise.all(remaining.map(async ({ cc, name }) => ({ cc, its: count(await search(current, name, earliest, addDays(earliest, hopDays))) })));
    type Cand = { code: string; score: number; it?: KiwiItinerary; ground?: (typeof ground)[number] };
    const cands: Cand[] = [];
    // Variety: after two big cities a smaller place is welcome; a coast is welcome once. The
    // style tilts it: beaches want the coast every time, cities want the hubs, experiences
    // want smaller places sooner.
    const lastTwoBig = stops.length >= 2 && stops.slice(-2).every((s) => bigCity(s.code));
    const lastBig = stops.length >= 1 && bigCity(stops.at(-1)!.code);
    const hadCoast = stops.some((s) => COASTAL.has(s.code));
    const variety = (code: string) => {
      let v = (lastTwoBig && !bigCity(code) ? 45 : 0) + (!hadCoast && COASTAL.has(code) ? 30 : 0);
      if (style === "beaches") v += COASTAL.has(code) ? 70 : -20;
      if (style === "cities") v += bigCity(code) ? 40 : 0;
      if (style === "experiences") v += lastBig && !bigCity(code) ? 35 : 0;
      if (prefer.has(CITIES[code]?.country ?? "")) v += 90;
      v += wishScore(code);
      return v;
    };
    for (const g of ground) cands.push({ code: g.code, score: 25 + g.minutes / 10 - worth(g.code) - variety(g.code), ground: g });
    for (const f of flights) {
      for (const it of f.its.slice(0, 6)) {
        const code = cityOfItinerary(it);
        if (code === current || !farEnough(code) || !nightOk(code) || !hoursOk(it)) continue;
        const back = stops.some((s) => haversineKm(s.lat, s.lon, CITIES[code].lat, CITIES[code].lon) < 120);
        cands.push({ code, score: it.price + hHop * hoursOf(it) + stopsPenalty(it.outbound.stops) + (back ? 80 : 0) - worth(code) - variety(code), it });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    const best = cands[0];
    if (!best) break;
    if (best.ground) {
      const g = best.ground;
      leave(earliest);
      legs.push({ kind: "ground", from: current, to: g.code, fromName: cur?.name ?? current, toName: CITIES[g.code].name, date: earliest, minutes: g.minutes, mode: g.mode, estimated: g.estimated, price: 20 });
      current = g.code;
      date = earliest;
    } else if (best.it) {
      leave(dayOf(best.it.outbound.departureTime));
      legs.push(flyLeg(current, best.it));
      current = best.code;
      date = dayOf(best.it.outbound.arrivalTime);
    }
    addStop(current, date);
    visited.add(CITIES[current].country);
    visitedCities.add(current);
    say(`Next: ${CITIES[current].name} (${CITIES[current].country}).`);
  }

  // 3. The way home, from the last stop or the one before, into any of the traveller's airports.
  // A last stop the traveller asked for is never dropped for a cheaper way home.
  const homeGws = (returnGateways.length ? returnGateways : homeGateways).slice(0, 3);
  const homeCodes = homeGws.map((g) => g.code).join(",");
  let backLeg: Extract<WildLeg, { kind: "fly" }> | null = null;
  let lastStop: WildStop | null = null;
  const lastIsMust = !!stops.at(-1) && isMust(stops.at(-1)!.code);
  let homeOverHours = 0;
  const failsBeforeHome = fails.n;
  for (const from of [stops.at(-1), lastIsMust ? undefined : stops.at(-2)].filter((s): s is WildStop => !!s)) {
    // Leave on the planned end date, give or take a day; never before two nights there. The
    // window stays within three days of the end even when the chain stopped early (the last
    // stop just gets longer), so the cheapest fare never sets the trip length: someone who
    // asked for 28 nights does not get 18 because day 18 happened to be cheap.
    const latest = addDays(endDate, 1);
    const anchor = addDays(endDate, -3);
    let earliest = addDays(from.arrive, Math.max(2, Math.min(nightsPerStop, daysBetween(from.arrive, endDate) - 1)));
    if (earliest < anchor) earliest = anchor;
    // A stop reached on the last day or two (a must city squeezed in at the end) leaves after
    // one night rather than making the window negative and the trip fail.
    if (daysBetween(earliest, latest) < 0) earliest = addDays(from.arrive, 1);
    if (daysBetween(earliest, latest) < 0) continue;
    // Hours weigh more on the way home: a 33-hour saving of €40 is no saving. Over 30 hours
    // only when nothing shorter exists.
    const found = count(await search(from.code, homeCodes, earliest, latest));
    const all = found.filter(hoursOk);
    homeOverHours += found.length - all.length;
    const sane = all.filter((it) => hoursOf(it) <= 30);
    const its = (sane.length ? sane : all).sort((a, b) => a.price + hHome * hoursOf(a) + stopsPenalty(a.outbound.stops) - (b.price + hHome * hoursOf(b) + stopsPenalty(b.outbound.stops)));
    if (its[0]) {
      if (from !== stops.at(-1)) {
        // The last stop had no way home: drop it and give its nights to the one before.
        stops.pop();
        legs.pop();
      }
      backLeg = flyLeg(from.code, its[0]) as Extract<WildLeg, { kind: "fly" }>;
      lastStop = from;
      from.depart = backLeg.date;
      from.nights = Math.max(1, daysBetween(from.arrive, from.depart));
      break;
    }
  }
  if (!backLeg || !lastStop) {
    if (homeOverHours) throw new Error(`every flight home from ${stops.at(-1)?.name ?? "the last stop"} takes more than ${maxH} h; raise maxFlightHours`);
    // The way home was refused, not absent: the refusal (throttled, budget) is the honest answer.
    if (fails.n > failsBeforeHome && fails.last) throw new Error(fails.last);
    if (lastIsMust) throw new Error(`no flight home from ${stops.at(-1)!.name} around ${endDate}; try other dates or more nights`);
    return null;
  }

  // 3b. A stopover on the way home: a night or two in a hub when it costs about the same as
  // flying straight through (Istanbul, Dubai, Doha, or the hubs used on the way in). Skipped
  // past the caller's deadline: it is a refinement, eight searches, never the trip itself.
  if (p.stopover !== false && style !== "slow" && !outOfTime()) {
    // The stopover is a night in the hub: skipped for a hub in a visited country.
    const hubCands = [...new Set([...hubs, "IST", "DXB", "DOH"])].filter((h) => h !== lastStop!.code && CITIES[h] && nightOk(h) && !homeGws.some((g) => (cityOf.get(g.code) ?? g.code) === h)).slice(0, 4);
    const d0 = backLeg.date;
    const options = await Promise.all(
      hubCands.map(async (h) => {
        const [a, b] = await Promise.all([search(lastStop!.code, h, addDays(d0, -1), d0), search(h, homeCodes, addDays(d0, 1), addDays(d0, 2))]);
        count(a);
        count(b);
        let best: { a: KiwiItinerary; b: KiwiItinerary; total: number } | null = null;
        for (const x of a.filter((it) => hoursOf(it) <= 16 && hoursOk(it))) {
          for (const y of b.filter((it) => hoursOf(it) <= 16 && hoursOk(it))) {
            if (dayOf(y.outbound.departureTime) <= dayOf(x.outbound.arrivalTime)) continue;
            const total = x.price + y.price;
            if (!best || total < best.total) best = { a: x, b: y, total };
          }
        }
        return best ? { h, ...best } : null;
      }),
    );
    const chosen = options.filter((o): o is NonNullable<typeof o> => !!o).sort((a, b) => a.total - b.total)[0];
    if (chosen && chosen.total <= backLeg.price + 40) {
      const legA = flyLeg(lastStop.code, chosen.a) as Extract<WildLeg, { kind: "fly" }>;
      const legB = flyLeg(chosen.h, chosen.b) as Extract<WildLeg, { kind: "fly" }>;
      lastStop.depart = legA.date;
      lastStop.nights = Math.max(1, daysBetween(lastStop.arrive, lastStop.depart));
      legs.push(legA);
      addStop(chosen.h, dayOf(chosen.a.outbound.arrivalTime), Math.max(1, daysBetween(dayOf(chosen.a.outbound.arrivalTime), legB.date)));
      const prog = STOPOVER_PROGRAMMES[chosen.h] ?? STOPOVER_PROGRAMMES[chosen.b.outbound.from];
      if (prog && [...chosen.a.outbound.segments, ...chosen.b.outbound.segments].some((s) => (s.carrierName || "").includes(prog.airline.split(" ")[0]))) stops.at(-1)!.note = prog.note;
      backLeg = legB;
      say(`Stopover: ${CITIES[chosen.h].name} for ${stops.at(-1)!.nights} night${stops.at(-1)!.nights === 1 ? "" : "s"} on the way home, €${chosen.total} for both flights.`);
    }
  }
  legs.push(backLeg);
  say(`Way home: ${backLeg.fromName} → ${backLeg.toName} €${backLeg.price}.`);

  // 3c. From the landing airport to the front door, when it is not the home airport's city.
  if (p.origin) {
    const landed = CITIES[backLeg.to] ?? null;
    if (landed) {
      const km = haversineKm(landed.lat, landed.lon, p.origin.lat, p.origin.lon);
      if (km > 35) {
        const minutes = Math.round(30 + ((km * 1.3) / 80) * 60);
        legs.push({ kind: "ground", from: backLeg.to, to: p.origin.label, fromName: landed.name, toName: p.origin.label, date: backLeg.date, minutes, mode: "road", estimated: true, price: Math.max(8, Math.round(km / 10)) });
      }
    }
  }

  const flights = legs.filter((l) => l.kind === "fly").reduce((s, l) => s + l.price, 0);
  const lastFly = [...legs].reverse().find((l): l is Extract<WildLeg, { kind: "fly" }> => l.kind === "fly")!;
  const groundCost = legs.filter((l) => l.kind === "ground").reduce((s, l) => s + l.price, 0);
  const living = stops.reduce((s, x) => s + x.nights * x.perDay, 0);
  const nights = stops.reduce((s, x) => s + x.nights, 0);
  // Door to door, layovers included: what the days actually cost in transit.
  const hoursInAir = Math.round(legs.filter((l): l is Extract<WildLeg, { kind: "fly" }> => l.kind === "fly").reduce((s, l) => s + l.hours, 0));
  const all = flights + groundCost + living;
  const countriesSeen = new Set(stops.map((s) => s.country)).size;
  const title = stops.map((s) => s.name).join(" → ");
  return {
    id: `${gw.code}-${effectiveRegion}-${outDate}-${stops.map((s) => s.code).join("-")}`,
    region: effectiveRegion,
    regionLabel,
    home: gw.code,
    passport: p.home,
    prefs: { style, budget },
    title,
    legs,
    stops,
    totals: { flights, ground: groundCost, living, all, perDay: Math.round(all / Math.max(1, nights)), nights, hoursInAir, countries: countriesSeen },
    outDate,
    backDate: lastFly.date,
    searched,
    generatedAt: new Date().toISOString(),
    ...(p.wishes?.trim() ? { wishes: p.wishes.trim().slice(0, 300) } : {}),
    ...(passed.length ? { mustInclude: passed } : {}),
    ...(p.startFrom?.length ? { startFrom: homeGateways.map((g) => g.code) } : {}),
    ...(maxH ? { maxFlightHours: maxH } : {}),
    ...(constraints.length ? { constraints } : {}),
  };
}

export function wildPath(gw: string, region: string, month: string | undefined, nights: number, style: Style = "experiences", budget: Budget = "mid", custom = ""): string {
  return `wild/${gw}-${region}-${month ?? "next"}-${nights}-${style}-${budget}${custom ? `-${custom}` : ""}.json`;
}

/**
 * Six characters that stand for an excluded-country list: FNV-1a over the sorted codes, in
 * base 36. Stable across processes, so a stored trip built with a been list is found again,
 * and short enough that a long list does not blow up the Blob path.
 */
export function excludeToken(exclude?: string[]): string {
  const list = [...new Set((exclude ?? []).map((c) => c.toUpperCase()))].sort();
  if (!list.length) return "";
  let h = 0x811c9dc5;
  for (const ch of list.join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `x${(h % 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** The extra constraints that shape a stored trip's key (customKey), all optional. */
export type CustomKeyExtras = {
  /** City codes the chain must pass through (names are resolved by the caller). */
  mustInclude?: string[];
  maxFlightHours?: number;
  /** Airports the way in leaves from. */
  startFrom?: string[];
  /** The traveller's words; only a short hash goes into the key. */
  wishes?: string;
  /** The top of a nights-per-stop range. */
  nightsPerStopMax?: number;
};

/**
 * A short stable suffix for custom country lists and every other constraint, so trips never
 * collide: countries, favourites, stops, nights a stop, tradeoff, hubs, window, then the
 * extras (must cities, hours, start airports, a hash of the wishes), then the been token.
 */
export function customKey(countries?: string[], prefer?: string[], maxStops?: number, nightsPerStop?: number, tradeoff?: Tradeoff, noHubs?: boolean, from?: string, to?: string, exclude?: string[], extras?: CustomKeyExtras): string {
  // An explicit departure window is part of the key, so a dated trip never answers a month one.
  const window = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? `w${from.replace(/-/g, "")}${to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to.slice(8, 10) : ""}` : "";
  // Countries and favourites may arrive as names: the key holds codes, so a name and its code are one trip.
  const codesOf = (list?: string[]) => resolveCountries(list).codes;
  const nightsPart = nightsPerStop ? `n${nightsPerStop}${extras?.nightsPerStopMax && extras.nightsPerStopMax > nightsPerStop ? `-${extras.nightsPerStopMax}` : ""}` : "";
  const parts = [...codesOf(countries).sort(), ...codesOf(prefer).map((c) => `+${c}`).sort(), maxStops ? `s${maxStops}` : "", nightsPart, tradeoff && tradeoff !== "balanced" ? tradeoff : "", noHubs ? "direct" : "", window].filter(Boolean);
  // The extras have their own cut, so a long country list can never push them out of the key.
  const extra = [
    extras?.mustInclude?.length ? `m${resolveCities(extras.mustInclude).codes.join("")}` : "",
    extras?.maxFlightHours && extras.maxFlightHours > 0 ? `h${Math.round(extras.maxFlightHours)}` : "",
    extras?.startFrom?.length ? `f${[...new Set(extras.startFrom.map((s) => s.toUpperCase()))].sort().join("")}` : "",
    wishesToken(extras?.wishes),
  ]
    .filter(Boolean)
    .join("")
    .toLowerCase()
    .slice(0, 48);
  // The been token goes after the cut, so a long custom key can never drop it and make an
  // excluded build collide with a plain one. Without a list the key is exactly what it was.
  return parts.join("").toLowerCase().slice(0, 60) + extra + excludeToken(exclude);
}

export { hubDegree };
