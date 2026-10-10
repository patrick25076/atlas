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
} satisfies Record<string, { label: string; countries: [string, string][] }>;

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

async function oneWay(from: string, to: string, a: string, b: string): Promise<KiwiItinerary[]> {
  try {
    const r = await searchFlight({ flyFrom: from, flyTo: to, departureDate: kiwiDate(a), departureDateTo: kiwiDate(b) });
    return r.itineraries;
  } catch {
    return [];
  }
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
  /** 7 to 90; past 28 the trip becomes five to seven bases of eight to twelve nights. */
  nights: number;
  style?: Style;
  budget?: Budget;
  /** Where the traveller actually lives: the last leg home from whichever airport is cheapest. */
  origin?: { lat: number; lon: number; label: string };
  /** A night or two in a hub on the way home when it costs about the same (default on). */
  stopover?: boolean;
  /** Only these countries (ISO2), instead of the region's list; eight at most, unknown codes ignored. */
  countries?: string[];
  /** Countries (ISO2) to favour in the chain. */
  prefer?: string[];
  /** Chain stops; clamped to the countries available and to eight. */
  maxStops?: number;
  /** Nights a stop; never under two (five past 28 nights). */
  nightsPerStop?: number;
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
  // A custom list is bounded like a region (eight countries) and keeps only codes we know:
  // the way in is one search per origin and country, so an unbounded list, or a code that
  // would reach Kiwi as "Unknown Region", multiplies searches that return nothing.
  const only = [...new Set((p.countries ?? []).map((c) => c.toUpperCase()).filter((cc) => /^[A-Z]{2}$/.test(cc) && !!COUNTRIES[cc]))].slice(0, MAX_COUNTRIES);
  if (p.countries?.length && !only.length) throw new Error("none of those country codes is a country we know (ISO2, for example VN or TH)");
  const base: [string, string][] = only.length ? only.map((cc) => [cc, countryLabel(cc)] as [string, string]) : region.countries;
  // "Been": a visited country is never a stop, so it leaves the list before any search.
  const exclude = p.exclude ?? [];
  const countries = base.filter(([cc]) => !unsafe(cc) && countryAllowed(cc, exclude));
  if (!countries.length && base.some(([cc]) => !unsafe(cc))) throw new Error(`every country of ${region.label} is on your been list; pick another region or allow revisits`);
  /** True when a night in this city is allowed (its country is not on the been list). */
  const nightOk = (cityCode: string) => countryAllowed(CITIES[cityCode]?.country, exclude);
  const prefer = new Set((p.prefer ?? []).map((c) => c.toUpperCase()));
  // The home airport is the biggest of the visitor's airports (Otopeni, not Ghimbav); the
  // nearest small one still gets a look as a second origin.
  const homeGateways = p.gateways.map((g) => resolveGateway(g)).filter((g): g is NonNullable<typeof g> => !!g);
  const gw = [...homeGateways].sort((a, b) => hubDegree(cityOf.get(b.code) ?? b.code) - hubDegree(cityOf.get(a.code) ?? a.code))[0];
  if (!gw) return null;
  const homeCity = cityOf.get(gw.code) ?? gw.code;
  const secondHome = homeGateways.find((g) => g.code !== gw.code);
  let searched = 0;
  const count = <T,>(x: T): T => {
    searched++;
    return x;
  };

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
  say(`Looking for the cheapest way into ${region.label} from ${gw.label}${secondHome ? ` or ${secondHome.label}` : ""}${hubs.length ? `, or via ${hubs.map((h) => CITIES[h].name).join(" and ")}` : ""}…`);
  const inbound = await Promise.all(origins.flatMap((o) => countries.map(async ([cc, name]) => ({ origin: o, cc, its: count(await oneWay(o, name, from, to)) }))));
  type Entry = { origin: string; it: KiwiItinerary; score: number; positioning?: KiwiItinerary };
  const entries: Entry[] = [];
  for (const r of inbound) {
    for (const it of r.its) {
      // A country search can still land at an airport we map to a neighbour: checked per landing.
      if (!nightOk(cityOfItinerary(it))) continue;
      const hubPenalty = isHome(r.origin) ? 0 : 70;
      // Landing somewhere worth the first nights beats landing in the cheapest corner of a country.
      entries.push({ origin: r.origin, it, score: it.price + hubPenalty + hIn * hoursOf(it) + stopsPenalty(it.outbound.stops) - 0.8 * worth(cityOfItinerary(it)) });
    }
  }
  entries.sort((a, b) => a.score - b.score);
  if (!entries.length) return null;
  // A cheap landing in a place nobody wants three nights in (Urumqi for China) only wins
  // when it undercuts the best known city by a wide margin.
  const famous = entries.find((e) => worth(cityOfItinerary(e.it)) >= 70);
  if (famous) {
    const cut = famous.score - 120;
    const keep = entries.filter((e) => worth(cityOfItinerary(e.it)) >= 70 || e.score < cut);
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
    const pos = count(await oneWay(gw.code, e.origin, addDays(lhDay, -1), lhDay));
    // Positioning through a visited hub is a connection and stays allowed; arriving the day
    // before would be a night there, so for such a hub only same-day arrivals count.
    const hubNight = nightOk(e.origin);
    const ok = pos
      .filter((x) => Date.parse(x.outbound.arrivalTime) + 3 * 3_600_000 <= Date.parse(e.it.outbound.departureTime) && (hubNight || dayOf(x.outbound.arrivalTime) === lhDay))
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
  const maxStops = Math.min(
    MAX_CHAIN_STEPS,
    asked(p.maxStops)
      ? Math.max(1, long ? asked(p.maxStops) : Math.min(countries.length, asked(p.maxStops)))
      : long
        ? Math.max(5, Math.min(7, Math.round(totalNights / 10)))
        : style === "slow"
          ? Math.min(countries.length, 3)
          : Math.min(countries.length, 5),
  );
  const floorNights = style === "slow" ? 4 : style === "experiences" ? 3 : 2;
  // Up to two weeks a stop is two or three nights; past that the stops grow with the nights
  // asked (28 nights over five stops is five a stop), so the chain itself covers the trip
  // instead of ending around night fifteen and leaving the way home to pick the length.
  const capNights = style === "slow" ? 7 : totalNights > 14 ? 6 : 3;
  const nightsPerStop = asked(p.nightsPerStop)
    ? Math.max(long ? 5 : 2, Math.min(long ? 30 : 10, asked(p.nightsPerStop)))
    : long
      ? Math.max(8, Math.min(12, Math.floor((totalNights - 1) / maxStops)))
      : Math.min(capNights, Math.max(floorNights, Math.floor((totalNights - 1) / maxStops)));
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
  for (let step = 0; step < maxStops; step++) {
    const earliest = addDays(stops.at(-1)!.arrive, nightsPerStop);
    if (daysBetween(earliest, endDate) < nightsPerStop + 1) break;
    const cur = CITIES[current];
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
    const flights = await Promise.all(remaining.map(async ({ cc, name }) => ({ cc, its: count(await oneWay(current, name, earliest, addDays(earliest, 1))) })));
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
      return v;
    };
    for (const g of ground) cands.push({ code: g.code, score: 25 + g.minutes / 10 - worth(g.code) - variety(g.code), ground: g });
    for (const f of flights) {
      for (const it of f.its.slice(0, 6)) {
        const code = cityOfItinerary(it);
        if (code === current || !farEnough(code) || !nightOk(code)) continue;
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
  const homeGws = homeGateways.slice(0, 3);
  const homeCodes = homeGws.map((g) => g.code).join(",");
  let backLeg: Extract<WildLeg, { kind: "fly" }> | null = null;
  let lastStop: WildStop | null = null;
  for (const from of [stops.at(-1), stops.at(-2)].filter((s): s is WildStop => !!s)) {
    // Leave on the planned end date, give or take a day; never before two nights there. The
    // window stays within three days of the end even when the chain stopped early (the last
    // stop just gets longer), so the cheapest fare never sets the trip length: someone who
    // asked for 28 nights does not get 18 because day 18 happened to be cheap.
    const latest = addDays(endDate, 1);
    const anchor = addDays(endDate, -3);
    let earliest = addDays(from.arrive, Math.max(2, Math.min(nightsPerStop, daysBetween(from.arrive, endDate) - 1)));
    if (earliest < anchor) earliest = anchor;
    if (daysBetween(earliest, latest) < 0) continue;
    // Hours weigh more on the way home: a 33-hour saving of €40 is no saving. Over 30 hours
    // only when nothing shorter exists.
    const all = count(await oneWay(from.code, homeCodes, earliest, latest));
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
  if (!backLeg || !lastStop) return null;

  // 3b. A stopover on the way home: a night or two in a hub when it costs about the same as
  // flying straight through (Istanbul, Dubai, Doha, or the hubs used on the way in).
  if (p.stopover !== false && style !== "slow") {
    // The stopover is a night in the hub: skipped for a hub in a visited country.
    const hubCands = [...new Set([...hubs, "IST", "DXB", "DOH"])].filter((h) => h !== lastStop!.code && CITIES[h] && nightOk(h) && !homeGws.some((g) => (cityOf.get(g.code) ?? g.code) === h)).slice(0, 4);
    const d0 = backLeg.date;
    const options = await Promise.all(
      hubCands.map(async (h) => {
        const [a, b] = await Promise.all([oneWay(lastStop!.code, h, addDays(d0, -1), d0), oneWay(h, homeCodes, addDays(d0, 1), addDays(d0, 2))]);
        count(a);
        count(b);
        let best: { a: KiwiItinerary; b: KiwiItinerary; total: number } | null = null;
        for (const x of a.filter((it) => hoursOf(it) <= 16)) {
          for (const y of b.filter((it) => hoursOf(it) <= 16)) {
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
    id: `${gw.code}-${p.region}-${outDate}-${stops.map((s) => s.code).join("-")}`,
    region: p.region,
    regionLabel: region.label,
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

/** A short stable suffix for custom country lists, so custom trips are stored apart. */
export function customKey(countries?: string[], prefer?: string[], maxStops?: number, nightsPerStop?: number, tradeoff?: Tradeoff, noHubs?: boolean, from?: string, to?: string, exclude?: string[]): string {
  // An explicit departure window is part of the key, so a dated trip never answers a month one.
  const window = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? `w${from.replace(/-/g, "")}${to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to.slice(8, 10) : ""}` : "";
  const parts = [...(countries ?? []).map((c) => c.toUpperCase()).sort(), ...(prefer ?? []).map((c) => `+${c.toUpperCase()}`).sort(), maxStops ? `s${maxStops}` : "", nightsPerStop ? `n${nightsPerStop}` : "", tradeoff && tradeoff !== "balanced" ? tradeoff : "", noHubs ? "direct" : "", window].filter(Boolean);
  // The been token goes after the cut, so a long custom key can never drop it and make an
  // excluded build collide with a plain one. Without a list the key is exactly what it was.
  return parts.join("").toLowerCase().slice(0, 60) + excludeToken(exclude);
}

export { hubDegree };
