// Server-only. The custom search: "the best getaway from my airports, somewhere in this
// period, including that date, these many nights, direct, back to any of my airports".
// Kiwi takes several origins in one search and a date range for each leg, so a period
// search is one call per target (anywhere, then the nearest countries); the nights, the
// must-include date and the flight length are filtered afterwards. Returning to a different
// home airport is two one-way searches per shortlisted city.
//
// Searches: 1 ("anywhere") + up to 18 nearby countries (or a region's), or at most 4 listed
// targets; plus 16 for open-jaw (8 cities x 2) and 4 for the hidden-city scan. The exhaustive
// option adds one "anywhere" search per origin airport (at most 5, the multi-origin search
// collapses to the cheapest origin otherwise), so a run is at most 19 + 5 + 16 + 4 = 44.
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import { countryAllowed } from "./been";
import { countryLabel, hubDegree, targetsFor, resolveGateway, sensibleTicket, toDeal, trimDeals } from "./board";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "./kiwi";
import { airportsByGround } from "./route-finder";
import type { City, CountryInfo, Deal } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;

export type FinderParams = {
  origins: string[];
  /** YYYY-MM-DD: the period the whole trip must fall in. */
  from: string;
  to: string;
  /** A date the trip must include (there on that day). */
  include?: string;
  minNights: number;
  maxNights: number;
  direct?: boolean;
  /** Door to door per leg, hours. */
  maxHours?: number;
  /** "anywhere" (default), a region or country name Kiwi understands, or a comma list. */
  where?: string;
  /** Home airports the flight home may land at; different from origins means open-jaw pairs. */
  returnTo?: string[];
  /** Also scan for hidden-city one-ways. */
  tricks?: boolean;
  /**
   * Countries (ISO2) the traveller has been to and does not want again ("Been", only new
   * countries): never a destination, fine as a connection. Targets in them are not searched.
   */
  exclude?: string[];
  /**
   * Go through more of the graph: the origins grow with the airports a train or coach reaches
   * within three hours of `origin` (when given), and after the targets each origin airport
   * gets its own "anywhere" search, because a multi-origin search answers only from the
   * cheapest origin. Default false. Bounded: at most 5 origins, so at most 5 extra searches.
   */
  exhaustive?: boolean;
  /** Where the traveller is, for the exhaustive expansion of origins. */
  origin?: { lat: number; lon: number };
  onDeals?: (deals: Deal[], target: string) => void;
  onProgress?: (line: string) => void;
};
export type FinderResult = {
  deals: Deal[];
  searched: number;
  failed: number;
  openJaw: number;
  generatedAt: string;
  /** A plain sentence when nothing was searched because every target is on the been list. */
  note?: string;
};

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const hoursOf = (it: KiwiItinerary) => Math.max(it.outbound.durationSeconds, it.inbound?.durationSeconds ?? 0) / 3600;

/** A comma list in `where` is at most this many targets, one search each. */
const MAX_LISTED_TARGETS = 4;

/**
 * The countries a region word ("Europe", "Asia") stands for, as names Kiwi understands. Shared
 * with lib/group.ts, which searches only the nearest few of them.
 */
export const REGION_COUNTRIES: Record<string, string[]> = {
  europe: ["Albania", "Austria", "Belgium", "Bosnia & Herzegovina", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Montenegro", "Netherlands", "North Macedonia", "Norway", "Poland", "Portugal", "Romania", "Serbia", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Türkiye", "United Kingdom", "Georgia", "Armenia", "Iceland", "Moldova", "Kosovo"],
  asia: ["Thailand", "Vietnam", "Malaysia", "Singapore", "Indonesia", "Philippines", "Cambodia", "Japan", "South Korea", "Taiwan", "Hong Kong", "China", "India", "Sri Lanka", "Maldives", "Nepal", "Uzbekistan", "Kazakhstan", "Kyrgyzstan", "United Arab Emirates", "Oman", "Qatar", "Jordan", "Israel", "Georgia", "Armenia", "Azerbaijan", "Türkiye"],
  africa: ["Morocco", "Tunisia", "Egypt", "Kenya", "Tanzania", "South Africa", "Namibia", "Ethiopia", "Senegal", "Cape Verde", "Mauritius", "Rwanda", "Uganda", "Ghana"],
  "north america": ["United States", "Canada", "Mexico", "Cuba", "Costa Rica", "Dominican Republic", "Jamaica", "Guatemala", "Panama", "Puerto Rico"],
  "south america": ["Brazil", "Argentina", "Chile", "Peru", "Colombia", "Ecuador", "Bolivia", "Uruguay"],
  oceania: ["Australia", "New Zealand", "Fiji"],
};

/**
 * The region a word names, or null. Own keys only: a plain lookup would also match inherited
 * names ("constructor" is a function, and new Set(function) throws), so a word that is not a
 * region falls through to Kiwi as a place name instead of crashing the search.
 */
export function regionCountries(word: string): string[] | null {
  const w = word.trim().toLowerCase();
  return Object.hasOwn(REGION_COUNTRIES, w) ? REGION_COUNTRIES[w] : null;
}

/**
 * City names as the traveller types them ("Milan", "Bangkok"), lower cased, to the country of
 * that city. When two countries share a city name (London, Melbourne, Florence) the bigger hub
 * wins, which is also the one Kiwi resolves a bare name to. Built once per process.
 */
const CITY_COUNTRY_BY_NAME = new Map<string, { cc: string; degree: number }>();
/** Airport code to the city it serves, for the hidden-city tricks (the via is an airport). */
const CITY_OF_AIRPORT = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) {
  const k = c.name.toLowerCase();
  const degree = hubDegree(code);
  const prev = CITY_COUNTRY_BY_NAME.get(k);
  if (!prev || degree > prev.degree) CITY_COUNTRY_BY_NAME.set(k, { cc: c.country, degree });
  for (const a of c.airports) if (!CITY_OF_AIRPORT.has(a)) CITY_OF_AIRPORT.set(a, code);
}

/**
 * Country names as the targets and the traveller spell them, lower cased, to ISO2: the label
 * the boards use (Intl, "Türkiye", "Czechia") and the name in countries.json ("Turkey"),
 * so both "Italy" and "IT" resolve. A board label that is really a city name in another
 * country (the boards call VA "Rome") is left out, or "Rome" would mean the Vatican and
 * Rome, Italy would be refused when only Vatican City is on the been list. Built once.
 */
const COUNTRY_BY_NAME = new Map<string, string>();
for (const cc of Object.keys(COUNTRIES)) {
  const label = countryLabel(cc).toLowerCase();
  const city = CITY_COUNTRY_BY_NAME.get(label);
  if (!city || city.cc === cc) COUNTRY_BY_NAME.set(label, cc);
}
// The names in countries.json are the canonical ones, so they win over any label.
for (const cc of Object.keys(COUNTRIES)) {
  const name = COUNTRIES[cc]?.name;
  if (name) COUNTRY_BY_NAME.set(name.toLowerCase(), cc);
}

/**
 * The country (ISO2) a search target lands in: a country name or code, a city name, a city
 * or airport code. Null for "anywhere", a region word or anything unknown, which is never
 * excluded here; the results are filtered by landing country afterwards anyway.
 */
export function targetCountry(target: string): string | null {
  const t = target.trim();
  if (!t || t.toLowerCase() === "anywhere") return null;
  const upper = t.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return COUNTRIES[upper] ? upper : null;
  if (/^[A-Z]{3}$/.test(upper)) return resolveGateway(upper)?.country ?? null;
  const lower = t.toLowerCase();
  return COUNTRY_BY_NAME.get(lower) ?? CITY_COUNTRY_BY_NAME.get(lower)?.cc ?? null;
}

/** Drops the targets whose country is on the exclude list, so no search is spent on them. */
export function allowedTargets(targets: string[], exclude: string[]): string[] {
  if (!exclude.length) return targets;
  return targets.filter((t) => countryAllowed(targetCountry(t) ?? undefined, exclude));
}

export async function findDeals(p: FinderParams): Promise<FinderResult> {
  const say = p.onProgress ?? (() => {});
  const exclude = p.exclude ?? [];
  const origins = p.origins.filter((o) => /^[A-Z]{3}$/.test(o)).slice(0, 5);
  if (p.exhaustive && p.origin) {
    // The airports a train or coach reaches from where the traveller is: often the cheap ones.
    for (const code of airportsByGround(p.origin.lat, p.origin.lon)) if (origins.length < 5 && !origins.includes(code)) origins.push(code);
  }
  const flyFrom = origins.join(",");
  const minN = Math.max(1, p.minNights);
  const maxN = Math.max(minN, p.maxNights);
  const depTo = addDays(p.to, -minN);
  if (depTo < p.from) return { deals: [], searched: 0, failed: 0, openJaw: 0, generatedAt: new Date().toISOString() };
  const fits = (out: string, back: string, nights: number | null) =>
    nights != null && nights >= minN && nights <= maxN && out >= p.from && back <= p.to && (!p.include || (out <= p.include && back >= p.include));

  // Targets: the whole world first, then the nearest countries for breadth. A region word
  // ("Europe", "Asia") means the nearest countries of that region, not one search.
  const first = resolveGateway(origins[0]);
  let targets: string[] = [];
  const nearby = first ? targetsFor(first.lat, first.lon, first.country).filter((t) => /^[A-Za-z]/.test(t) && t.length > 3) : [];
  const regionList = regionCountries(p.where ?? "anywhere");
  // "Been": a target in a country already visited is not searched at all. The excluded
  // countries leave each list before it is cut to size, so a well-travelled visitor gets the
  // next unvisited countries instead of a shorter list (or an empty one when the nearest
  // eighteen are all visited). When nothing is left (where=Italy with Italy on the list) the
  // answer is an empty run that says why.
  let asked = 0;
  if (regionList) {
    const set = new Set(regionList);
    const near = nearby.filter((t) => set.has(t));
    const ordered = [...near, ...regionList.filter((t) => !near.includes(t))];
    asked = ordered.length;
    targets = allowedTargets(ordered, exclude).slice(0, 18);
  } else if (p.where && p.where !== "anywhere") {
    // A typed comma list is one search per entry; four at most, so a long list from the chat
    // cannot turn one finder run into dozens of searches.
    const listed = p.where
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    asked = listed.length;
    targets = allowedTargets(listed, exclude).slice(0, MAX_LISTED_TARGETS);
  } else {
    asked = 1 + nearby.length;
    targets = ["anywhere", ...allowedTargets(nearby, exclude).slice(0, 18)];
  }
  if (!targets.length) {
    const note = asked === 1 ? `${p.where} is on your been list (only new countries), so nothing was searched; a layover there is still fine.` : "Every place that search would try is on your been list (only new countries), so nothing was searched.";
    say(note);
    return { deals: [], searched: 0, failed: 0, openJaw: 0, generatedAt: new Date().toISOString(), note };
  }

  // A getaway leaves the country unless the search names it.
  const home = first?.country ?? "";
  const domesticOk = !!p.where && p.where !== "anywhere";
  // Where a deal may land when the search named a place: the region's countries, or the
  // listed targets' countries. A target our data cannot place (null) leaves the gate open,
  // since Kiwi decides what it means; "anywhere" has no gate.
  const landing = ((): Set<string> | null => {
    const named = regionList ?? (domesticOk ? targets : null);
    if (!named) return null;
    const codes = named.map(targetCountry);
    return codes.some((c) => !c) ? null : new Set(codes as string[]);
  })();
  /** The deals of one search that fit the dates, the length, the home rule, the been list and the landing gate. */
  const collect = (r: { itineraries: KiwiItinerary[] }, label: string): void => {
    const found: Deal[] = [];
    for (const it of r.itineraries) {
      const out = it.outbound.departureTime.slice(0, 10);
      const back = it.inbound?.departureTime.slice(0, 10) ?? "";
      if (!fits(out, back, nightsOf(it))) continue;
      if (p.direct && (it.outbound.stops > 0 || (it.inbound?.stops ?? 0) > 0)) continue;
      if (p.maxHours && hoursOf(it) > p.maxHours) continue;
      // Kiwi's "return" into one city and home from a far one (Chania in, Corfu out) is no getaway.
      if (!sensibleTicket(it)) continue;
      const d = toDeal(it.outbound.from, it, nightsOf(it)!);
      if (!domesticOk && d.country === home) continue;
      // An "anywhere" search may land in a visited country: the deal is dropped, the
      // search was still worth it for the other landings.
      if (!countryAllowed(d.country, exclude)) continue;
      if (landing && !landing.has(d.country)) continue;
      found.push(d);
    }
    if (found.length) {
      all.push(...found);
      p.onDeals?.(trimDeals(found), label);
    }
  };
  say(`Searching ${origins.join(", ")} → ${p.where && p.where !== "anywhere" ? p.where : "anywhere"}, ${p.from} to ${p.to}, ${minN} to ${maxN} nights${p.include ? `, there on ${p.include}` : ""}…`);
  let searched = 0;
  let failed = 0;
  const all: Deal[] = [];
  const queue = [...targets];
  async function worker() {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const r = await searchFlight({ flyFrom, flyTo: t, departureDate: kiwiDate(p.from), departureDateTo: kiwiDate(depTo), returnDate: kiwiDate(addDays(p.from, minN)), returnDateTo: kiwiDate(p.to) });
        searched++;
        collect(r, t);
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));

  // Exhaustive: the same question from each origin airport on its own. A multi-origin search
  // answers with the 15 cheapest itineraries overall, which all leave from the cheapest
  // airport; one search per airport shows what the others can do. The question stays the one
  // asked: "anywhere", or the named targets as one comma list (a region's nearest four
  // countries), so a search for Italy never answers with Spain. The lone origin with
  // where=anywhere was already searched above.
  if (p.exhaustive && origins.length) {
    const soloTarget = regionList || domesticOk ? targets.filter((t) => t !== "anywhere").slice(0, MAX_LISTED_TARGETS).join(",") : "anywhere";
    const solo = soloTarget && !(origins.length === 1 && soloTarget === "anywhere") ? origins : [];
    if (solo.length) say(`Searching ${soloTarget === "anywhere" ? "anywhere" : p.where} from ${solo.join(", ")} one by one…`);
    await Promise.all(
      solo.map(async (o) => {
        try {
          const r = await searchFlight({ flyFrom: o, flyTo: soloTarget, departureDate: kiwiDate(p.from), departureDateTo: kiwiDate(depTo), returnDate: kiwiDate(addDays(p.from, minN)), returnDateTo: kiwiDate(p.to) });
          searched++;
          collect(r, `${soloTarget === "anywhere" ? "anywhere" : p.where} from ${o}`);
        } catch {
          failed++;
        }
      }),
    );
  }

  // Open-jaw: for the best cities, fly out from any origin and home to any allowed airport.
  let openJaw = 0;
  const returnTo = (p.returnTo ?? []).filter((x) => /^[A-Z]{3}$/.test(x) && !origins.includes(x));
  const homes = [...new Set([...origins, ...returnTo])];
  if (returnTo.length && all.length) {
    const cities = [...new Set(trimDeals([...all]).map((d) => d.dst))].slice(0, 8);
    say(`Checking flights home to ${homes.join(", ")} from ${cities.length} places…`);
    await Promise.all(
      cities.map(async (dst) => {
        try {
          const [outs, backs] = await Promise.all([
            searchFlight({ flyFrom, flyTo: dst, departureDate: kiwiDate(p.from), departureDateTo: kiwiDate(depTo) }),
            searchFlight({ flyFrom: dst, flyTo: homes.join(","), departureDate: kiwiDate(addDays(p.from, minN)), departureDateTo: kiwiDate(p.to) }),
          ]);
          searched += 2;
          let best: { o: KiwiItinerary; b: KiwiItinerary; total: number } | null = null;
          for (const o of outs.itineraries) {
            if (p.direct && o.outbound.stops > 0) continue;
            const out = o.outbound.departureTime.slice(0, 10);
            for (const b of backs.itineraries) {
              if (p.direct && b.outbound.stops > 0) continue;
              const back = b.outbound.departureTime.slice(0, 10);
              const nights = Math.round((Date.parse(back) - Date.parse(out)) / 86_400_000);
              if (!fits(out, back, nights)) continue;
              const total = o.price + b.price;
              if (!best || total < best.total) best = { o, b, total };
            }
          }
          if (!best) return;
          const cheapestReturn = Math.min(...all.filter((d) => d.dst === dst).map((d) => d.price), Infinity);
          if (best.total >= cheapestReturn - 5 && best.b.outbound.to === best.o.outbound.from) return;
          const d = toDeal(best.o.outbound.from, best.o, Math.round((Date.parse(best.b.outbound.departureTime.slice(0, 10)) - Date.parse(best.o.outbound.departureTime.slice(0, 10))) / 86_400_000));
          d.price = Math.round(best.total);
          d.back = best.b.outbound.departureTime.slice(0, 10);
          d.backMin = Math.round(best.b.outbound.durationSeconds / 60);
          d.stops = Math.max(best.o.outbound.stops, best.b.outbound.stops);
          d.carriers = [...new Set([...best.o.outbound.segments, ...best.b.outbound.segments].map((s) => s.carrierName || s.carrier))];
          d.backTo = best.b.outbound.to;
          d.url2 = best.b.bookingUrl;
          openJaw++;
          all.push(d);
          p.onDeals?.([d], `open-jaw ${dst}`);
        } catch {
          failed++;
        }
      }),
    );
  }
  // Hidden-city tricks ("skiplagging"): a one-way ticket that continues past the city you want,
  // cheaper than the one-way to that city. Two searches, scanned by layover airport. Shown with
  // the warning: one way, cabin bag only, the airline's rules forbid it.
  if (p.tricks && all.length) {
    say("Checking hidden-city one-ways…");
    const wanted = new Map<string, number>();
    for (const d of all) wanted.set(d.dst, Math.min(wanted.get(d.dst) ?? Infinity, d.price));
    const scans = await Promise.all(["anywhere", ...targets.filter((t) => t !== "anywhere").slice(0, 3)].map((t) => searchFlight({ flyFrom, flyTo: t, departureDate: kiwiDate(p.from), departureDateTo: kiwiDate(depTo) }).catch(() => null)));
    searched += scans.length;
    const direct = new Map<string, number>();
    for (const r of scans) for (const it of r?.itineraries ?? []) if (it.outbound.stops === 0) direct.set(it.outbound.to, Math.min(direct.get(it.outbound.to) ?? Infinity, it.price));
    for (const r of scans) {
      for (const it of r?.itineraries ?? []) {
        if (it.outbound.stops === 0) continue;
        for (const via of it.outbound.route.slice(1, -1)) {
          if (!wanted.has(via)) continue;
          // Getting off in a visited country is a destination there, not a layover.
          if (!countryAllowed(resolveGateway(via)?.country, exclude)) continue;
          const oneWayDirect = direct.get(via) ?? wanted.get(via)! / 2;
          if (it.price >= oneWayDirect - 15) continue;
          const seg = it.outbound.segments.find((s) => s.to === via);
          if (!seg) continue;
          const d = toDeal(it.outbound.from, it, 0);
          // The deal is to the via city, where the traveller gets off: its city and country
          // are what the client filters and tags by, not the ticket's final destination.
          d.dst = via;
          d.dstCity = CITY_OF_AIRPORT.get(via) ?? d.dstCity;
          d.city = seg.toCity || CITIES[d.dstCity]?.name || via;
          // Our own airport data first (ISO2 for sure); Kiwi's segment country only when it
          // is a two-letter code too, since the client compares codes.
          d.country = resolveGateway(via)?.country ?? (/^[A-Za-z]{2}$/.test(seg.toCountry ?? "") ? seg.toCountry.toUpperCase() : d.country);
          d.price = Math.round(it.price);
          d.back = "";
          d.nights = 0;
          d.outMin = Math.round((Date.parse(seg.arrivalTime) - Date.parse(it.outbound.departureTime)) / 60_000);
          d.backMin = 0;
          d.trick = `Hidden city: a one-way ticket to ${it.outbound.segments.at(-1)?.toCity ?? it.outbound.to} that stops in ${seg.toCity || via}; you get off there. Cabin bag only, no return on the same ticket, and airlines forbid it.`;
          all.push(d);
          p.onDeals?.([d], `trick ${via}`);
        }
      }
    }
  }
  return { deals: trimDeals(all), searched, failed, openJaw, generatedAt: new Date().toISOString() };
}
