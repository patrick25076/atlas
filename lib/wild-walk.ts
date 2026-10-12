// Server-only. Wild trips built by the graph walk (lib/graph-walk.ts) instead of the classic
// chain by country (lib/wild.ts buildWild). The walk is aimed at the region: the way in is one
// search from the home airports to the region's biggest hubs, every hop after it searches the
// hubs of the countries not seen yet (or flies to a second city of a country when the region has
// fewer countries than the trip needs stops), trains and coaches come from the ground graph,
// and one search to every home airport closes the loop. Every stop takes the nights asked for
// (2 to 3 means 2 or 3), and the loop comes back as a WildTrip, so the Wild tab, plan_days and
// the itineraries read it as they read a classic one: stops with nights, legs, totals with the
// living costs per stop the classic builder uses, the judge's verdict, and the other loops the
// walk closed as alternatives.
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import visaJson from "@/public/data/visa.json";
import { countryAllowed } from "./been";
import { countryLabel, mainGateway, resolveGateway } from "./board";
import { countryGroup, walkTrips, type WalkEvent, type WalkLeg, type WalkLoop, type WalkResult } from "./graph-walk";
import { judgeTrip } from "./judge";
import { findCityCode, perDayFor, REGIONS, resolveCities, resolveCountries, wildWindow, wishesToken, type Budget, type Region, type Style, type WildLeg, type WildParams, type WildStop, type WildTrip } from "./wild";
import { visaFor, type City, type CountryInfo, type VisaFile } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
const VISA = visaJson as unknown as VisaFile;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) if (!cityOf.has(a)) cityOf.set(a, code);

/** The walk's own ceiling on stops (lib/graph-walk.ts MAX_STOPS). */
const MAX_STOPS = 16;
/** Countries a trip considers, as the classic builder caps them. */
const MAX_COUNTRIES = 8;
/** How long the walk may search when the caller gives no deadline: /api/wild runs for 300 s and the judge follows. */
const WALK_DEADLINE_MS = 150_000;
/** Loops kept as alternatives next to the best one. */
const MAX_ALTERNATIVES = 4;
/** The walk's own name for the traveller's door in legs. */
const HOME = "HOME";

const addDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const unsafe = (cc: string) => COUNTRIES[cc]?.advisory?.warning === true;
const cityCode = (code: string) => cityOf.get(code) ?? code;

/**
 * Nights a stop for the walk. With nightsPerStopMax the range is exact (2-3 is 2 or 3, 2-2 is 2: the trip style's
 * "at most 2 a place" never becomes 3); a bare nightsPerStop keeps the walk's one day of slack (2 means 2 or 3).
 * Left out, two to three, as the trip style's default, for as long as 16 stops of three nights cover the trip (about
 * seven weeks); past that the stops lengthen just enough that 16 of them still fill it.
 */
function stopNights(p: WildParams, nights: number): { value: number | [number, number]; min: number; max: number } {
  const given = p.nightsPerStop != null && Number.isFinite(p.nightsPerStop) && p.nightsPerStop > 0 ? Math.round(p.nightsPerStop) : 0;
  if (given) {
    const top = p.nightsPerStopMax != null && Number.isFinite(p.nightsPerStopMax) && Math.round(p.nightsPerStopMax) >= given ? Math.round(p.nightsPerStopMax) : 0;
    return top ? { value: [given, top], min: given, max: top } : { value: given, min: given, max: given + 1 };
  }
  const n = Math.max(2, Math.ceil(Math.max(1, nights - 1) / MAX_STOPS) - 1);
  return { value: [n, n + 1], min: n, max: n + 1 };
}

/** A walk leg as the Wild tab draws it: flights with their times and booking link, everything else as a ground leg. */
function wildLeg(l: WalkLeg, loop: WalkLoop, origin: string): WildLeg {
  const name = (code: string, fallback: string) => (code === HOME ? origin : fallback);
  if (l.kind === "fly") {
    const to = cityCode(l.to);
    // The arrival day: the stop the flight lands at says it; the way home lands the same day, or the next when the
    // clock reads earlier on arrival than on departure (an overnight flight).
    const stop = loop.stops.find((s) => s.code === to && s.arrive >= l.date);
    const arriveDay = stop?.arrive ?? (l.arrive && l.depart && l.arrive < l.depart ? addDays(l.date, 1) : l.date);
    return {
      kind: "fly",
      from: cityCode(l.from),
      to,
      fromName: l.fromName,
      toName: l.toName,
      date: l.date,
      // A remembered fare knows its day, not its hour: the time is left out rather than invented.
      departAt: l.depart ? `${l.date}T${l.depart}:00` : l.date,
      arriveAt: l.arrive ? `${arriveDay}T${l.arrive}:00` : arriveDay,
      price: l.price,
      hours: Math.round(l.minutes / 6) / 10,
      stops: l.stops ?? 0,
      route: l.route?.length ? l.route : [l.from, l.to],
      carriers: l.carrier ? l.carrier.split(", ").filter(Boolean) : [],
      url: l.url ?? "",
    };
  }
  return {
    kind: "ground",
    from: l.from === HOME ? origin : cityCode(l.from),
    to: l.to === HOME ? origin : cityCode(l.to),
    fromName: name(l.from, l.fromName),
    toName: name(l.to, l.toName),
    date: l.date,
    minutes: l.minutes,
    mode: l.kind === "train" ? "rail" : l.kind,
    estimated: true,
    price: l.price,
  };
}

/** A closed loop as the pieces of a WildTrip: stops with living costs and visas, legs, totals, dates. */
function tripParts(loop: WalkLoop, passport: string, budget: Budget, origin: string) {
  const stops: WildStop[] = loop.stops.map((s) => ({
    code: s.code,
    name: s.name,
    country: s.country,
    lat: s.lat,
    lon: s.lon,
    arrive: s.arrive,
    depart: s.leave,
    nights: s.nights,
    perDay: perDayFor(s.country, budget),
    visa: s.country && s.country !== passport ? visaFor(VISA, passport, s.country) : null,
    warning: COUNTRIES[s.country]?.advisory?.partial || undefined,
  }));
  const legs = loop.legs.map((l) => wildLeg(l, loop, origin));
  const fly = legs.filter((l): l is Extract<WildLeg, { kind: "fly" }> => l.kind === "fly");
  const flights = fly.reduce((a, l) => a + l.price, 0);
  const ground = legs.filter((l) => l.kind === "ground").reduce((a, l) => a + l.price, 0);
  // Living costs the way lib/wild.ts counts them: each stop's nights at its country's daily budget.
  const living = stops.reduce((a, s) => a + s.nights * s.perDay, 0);
  const nights = stops.reduce((a, s) => a + s.nights, 0);
  const all = flights + ground + living;
  const totals: WildTrip["totals"] = { flights, ground, living, all, perDay: Math.round(all / Math.max(1, nights)), nights, hoursInAir: Math.round(fly.reduce((a, l) => a + l.hours, 0)), countries: new Set(stops.map((s) => s.country)).size };
  return { stops, legs, totals, title: stops.map((s) => s.name).join(" → "), outDate: fly[0]?.date ?? loop.start, backDate: fly.at(-1)?.date ?? loop.end };
}

/**
 * A wild trip through the graph walk. Takes the classic builder's parameters (region or countries, nights, the
 * window or month, nights a stop, tradeoff, been list, must cities, favourites, the longest flight, wishes) plus
 * `avoid` (countries, cities, group words), `searchBudget` (the live searches it may spend) and `maxGroundMin` (0 for
 * flights only). Throws a plain sentence when the question cannot work or no loop closes; never returns null.
 * `onEvent` receives every step of the walk (nodes, edges, loops, progress) for the globe.
 */
export async function wildByWalk(p: WildParams & { onEvent?: (e: WalkEvent) => void }): Promise<WildTrip> {
  const say = p.onProgress ?? (() => {});
  if (!Object.hasOwn(REGIONS, p.region)) throw new Error(`unknown region ${String(p.region)}; one of ${Object.keys(REGIONS).join(", ")}`);
  const region = REGIONS[p.region];
  const style: Style = p.style ?? "experiences";
  const budget: Budget = p.budget ?? "mid";
  const exclude = p.exclude ?? [];
  const constraints: string[] = [];

  // The countries, as the classic builder reads them: a list replaces the region's (the trip is then "custom"), must
  // cities add their own country, the been list and full travel warnings take theirs away.
  const given = resolveCountries(p.countries);
  if (p.countries?.length && !given.codes.length) throw new Error(`none of those is a country we know: ${given.unknown.join(", ")} (use a name such as Vietnam or a code such as VN)`);
  if (p.region === "custom" && !given.codes.length) throw new Error("region custom needs a countries list (names or codes)");
  const must = resolveCities(p.mustInclude);
  if (must.unknown.length) throw new Error(`unknown city to pass through: ${must.unknown.join(", ")} (a city name such as Hanoi or a code such as HAN)`);
  for (const code of must.codes) {
    const cc = CITIES[code].country;
    if (!countryAllowed(cc, exclude)) throw new Error(`${CITIES[code].name} is in ${countryLabel(cc)}, which is on your been list; allow revisits or drop it`);
    if (unsafe(cc)) throw new Error(`${CITIES[code].name} is in ${countryLabel(cc)}, under a full travel warning`);
  }
  const only = given.codes.slice(0, MAX_COUNTRIES);
  const base = only.length ? [...only] : region.countries.map(([cc]) => cc);
  for (const code of must.codes) if (!base.includes(CITIES[code].country)) base.push(CITIES[code].country);
  const countries = base.filter((cc) => !unsafe(cc) && countryAllowed(cc, exclude));
  const effectiveRegion: Region = only.length ? "custom" : p.region;
  const regionLabel = effectiveRegion === "custom" ? countries.map((cc) => countryLabel(cc)).join(", ") : region.label;
  if (!countries.length && base.some((cc) => !unsafe(cc))) throw new Error(`every country of ${regionLabel} is on your been list; pick another region or allow revisits`);
  if (!countries.length) throw new Error(`no country to visit in ${regionLabel}`);

  // The trip's shape: the same departure window as the classic builder, the nights give or take one (a loop of
  // two- and three-night stops rarely lands on the exact night), every stop inside its range.
  const nights = Math.min(90, Math.max(2, Math.round(p.nights)));
  const win = wildWindow(p);
  const per = stopNights(p, nights);
  const stopsNeeded = Math.ceil(Math.max(1, nights - 1) / per.max);
  if (stopsNeeded > MAX_STOPS) throw new Error(`${nights} nights at ${per.min === per.max ? per.min : `${per.min} to ${per.max}`} nights a stop need ${stopsNeeded} stops; the walk takes at most ${MAX_STOPS}. Allow more nights a stop or ask for fewer nights`);
  const minNights = Math.max(1, nights - 1);
  const maxNights = nights + 1;
  const maxStops = p.maxStops && Number.isFinite(p.maxStops) && p.maxStops > 0 ? Math.min(MAX_STOPS, Math.round(p.maxStops)) : undefined;
  if (p.nightsPerStop) constraints.push(per.min === per.max ? `${per.min} nights a stop` : `${per.min} to ${per.max} nights a stop`);
  if (p.wishes?.trim()) constraints.push(`wishes: ${p.wishes.trim().slice(0, 120)}`);
  if (must.codes.length) constraints.push(`passes through ${must.codes.map((c) => CITIES[c].name).join(", ")}`);
  if (p.maxFlightHours) constraints.push(`no flight over ${p.maxFlightHours} h`);
  if (only.length) constraints.push(`countries: ${countries.map((cc) => countryLabel(cc)).join(", ")}`);
  if (p.avoid?.length) constraints.push(`avoiding ${p.avoid.slice(0, 8).join(", ")}`);
  if (p.maxGroundMin === 0) constraints.push("no trains or coaches, flights only");
  // The walk flies out of and back into the traveller's own airports; other start airports are the classic builder's.
  if (p.startFrom?.length) constraints.push(`starts from your own airports (other start airports such as ${p.startFrom.join(", ")} need the classic builder)`);

  // Where the traveller is: their point when given, else the main home airport.
  const gw = mainGateway(p.gateways);
  const at = p.origin ?? (() => {
    const g = resolveGateway(gw);
    return g ? { lat: g.lat, lon: g.lon, label: g.label } : null;
  })();
  if (!at) throw new Error(`unknown home airport ${p.gateways.join(", ") || "(none)"}; use three-letter codes such as OTP`);
  // The kind of trip leans the walk only where it has a reading for it: big cities, or food. The wishes are its words.
  const words = [p.wishes?.trim(), style === "cities" ? "cities" : style === "food" ? "food" : ""].filter(Boolean).join(", ");
  const deadlineMs = p.deadline ? Math.max(10_000, p.deadline - Date.now()) : WALK_DEADLINE_MS;
  say(`Walking ${regionLabel}: ${nights} nights, ${per.min === per.max ? per.min : `${per.min} to ${per.max}`} a stop, from ${at.label}.`);

  const result: WalkResult = await walkTrips({
    origin: at,
    gateways: p.gateways,
    home: p.home,
    from: win.from,
    // The walk's window holds the whole trip (the last departure day plus the most nights), and the first leg leaves
    // inside the departure window itself, as the classic builder's does: from == to is one fixed day.
    to: addDays(win.to, maxNights),
    departBy: win.to,
    minNights,
    maxNights,
    nightsPerStop: per.value,
    maxStops,
    budget: p.searchBudget,
    deadlineMs,
    maxGroundMin: p.maxGroundMin,
    maxFlightHours: p.maxFlightHours,
    tradeoff: p.tradeoff,
    exclude,
    mustInclude: must.codes,
    avoid: p.avoid,
    prefer: p.prefer,
    allowedCountries: countries,
    region: effectiveRegion === "custom" ? undefined : p.region,
    style: words || undefined,
    onEvent: (e) => {
      if (e.type === "progress") say(e.text);
      p.onEvent?.(e);
    },
  });
  if (!result.loops.length) throw new Error(result.note ?? `no loop through ${regionLabel} closed on those dates; try other dates, more nights a stop or a bigger search budget`);

  const [best, ...rest] = result.loops;
  const parts = tripParts(best, p.home, budget, at.label);
  const searchLine = `found by the graph walk: ${result.searched} live search${result.searched === 1 ? "" : "es"}${result.failed ? ` (${result.failed} failed)` : ""}, ${result.fromMemory} answer${result.fromMemory === 1 ? "" : "s"} from the fare memory, ${result.loops.length} loop${result.loops.length === 1 ? "" : "s"} closed`;
  const trip: WildTrip = {
    id: `${gw}-${effectiveRegion}-${parts.outDate}-${parts.stops.map((s) => s.code).join("-")}`,
    region: effectiveRegion,
    regionLabel,
    home: gw,
    passport: p.home,
    prefs: { style, budget },
    title: parts.title,
    legs: parts.legs,
    stops: parts.stops,
    totals: parts.totals,
    outDate: parts.outDate,
    backDate: parts.backDate,
    searched: result.searched,
    generatedAt: new Date().toISOString(),
    engine: "walk",
    variant: "Best loop",
    constraints: [...constraints, searchLine, ...(result.note ? [result.note] : [])],
    ...(result.partial ? { partial: true } : {}),
    ...(p.wishes?.trim() ? { wishes: p.wishes.trim().slice(0, 300) } : {}),
    ...(must.codes.length ? { mustInclude: parts.stops.filter((s) => must.codes.includes(s.code)).map((s) => s.code) } : {}),
    ...(p.maxFlightHours ? { maxFlightHours: p.maxFlightHours } : {}),
    alternatives: rest.slice(0, MAX_ALTERNATIVES).map((loop, i) => {
      const alt = tripParts(loop, p.home, budget, at.label);
      return { variant: `Loop ${i + 2}`, rank: i + 2, score: loop.score, title: alt.title, totals: alt.totals, outDate: alt.outDate, backDate: alt.backDate, legs: alt.legs, stops: alt.stops };
    }),
  };
  say("Asking for a second opinion…");
  const judge = await judgeTrip(trip).catch(() => null);
  return judge ? { ...trip, judge } : trip;
}

// ---------------------------------------------------------------------------------------
// The stored trip's key, shared by /api/wild and /api/plan (and the same scheme the chat's
// wild_trip uses), so a trip built in one place is found in the other.

/** The countries a list of avoid words stands for: group words ("dach", "like:DE") and country names or codes. A
 * country's exact name wins over a city of the same name ("Singapore", "Luxembourg", "Malta" are the countries, as
 * lib/graph-walk.ts reads them); any other city is no country (the walk avoids it as a city). */
export function avoidCountryCodes(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    const g = countryGroup(w);
    if (g) for (const cc of g.codes) out.add(cc);
    else for (const cc of resolveCountries([w]).codes) out.add(cc);
  }
  return out;
}

/** The cities a list of avoid words stands for: the words that are neither a group nor a country but a city. */
function avoidCityCodes(words: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const w of words) {
    if (countryGroup(w) || resolveCountries([w]).codes.length) continue;
    const city = findCityCode(w);
    if (city) out.add(city);
  }
  return out;
}

/**
 * The key's avoid token: the avoided countries' codes in order, as the chat has always written it, when that is all
 * there is and it is short; else a hash of every avoided country and city, so avoiding Bangkok and avoiding Kuala
 * Lumpur are two trips, and a long list is never cut into the same key as a shorter one. The hash has an odd length
 * after "h", so it can never read as a list of two-letter codes.
 */
function avoidToken(words: readonly string[]): string {
  const countries = [...avoidCountryCodes(words)].map((cc) => cc.toLowerCase()).sort();
  const cities = [...avoidCityCodes(words)].map((c) => `c${c.toLowerCase()}`).sort();
  const plain = countries.join("");
  if (!cities.length && plain.length <= 24) return plain;
  return `h${wishesToken([...countries, ...cities].join(",")).slice(1)}`;
}

/** The avoid words of a query (a comma list, twelve at most, forty characters each) and the ones nobody can read. */
export function readAvoid(raw: string | null | undefined): { words: string[]; unknown: string[] } {
  const words = [...new Set((raw ?? "").split(",").map((s) => s.trim().slice(0, 40)).filter(Boolean))].slice(0, 12);
  const unknown = words.filter((w) => !countryGroup(w) && !findCityCode(w) && !resolveCountries([w]).codes.length);
  return { words, unknown };
}

/**
 * What goes after customKey for the engine: nothing for the classic chain (its trips keep the keys they always had),
 * "-walk" plus the avoid token for the walk (avoidToken: the countries as the chat writes them, a hash once cities or
 * a long list are in it), "-g0" when trains and coaches are off,
 * "-g<minutes>" for another ground limit on the walk, "-q<n>" when a search budget was given (a walk on the fare
 * memory alone never answers for a full one).
 */
export function engineKeySuffix(o: { engine: "walk" | "classic"; avoid: readonly string[]; ground?: number; searches?: number }): string {
  const avoid = o.engine === "walk" && o.avoid.length ? `-a${avoidToken(o.avoid)}` : "";
  const ground = o.ground === 0 ? "-g0" : o.engine === "walk" && o.ground != null && o.ground !== DEFAULT_GROUND_MIN ? `-g${o.ground}` : "";
  const searches = o.engine === "walk" && o.searches != null ? `-q${o.searches}` : "";
  return (o.engine === "walk" ? `-walk${avoid}` : "") + ground + searches;
}

/** The walk's ground limit when none is given (lib/graph-walk.ts DEFAULT_GROUND_MIN). */
export const DEFAULT_GROUND_MIN = 330;
