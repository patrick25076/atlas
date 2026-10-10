// Server-only. The "cheapest whenever" scan: a price calendar for one destination from a set
// of home airports, one Kiwi search per month with the whole month as the departure range and
// the return range covering the nights wanted. Kiwi takes several origins in one flyFrom and a
// country as a flyFrom or flyTo, and answers with its 15 cheapest itineraries, so a six-month
// scan is six searches (eighteen with open-jaw). The shared fare memory (lib/insights.ts) is
// asked first: a fare anyone saw in the last day stands in for the search only when the
// memory covers the month well (fares on at least MEMORY_MIN_DAYS distinct departure days),
// so a one-day reprice never becomes "the cheapest in November".
//
// Bound: months x (1 + 2 with open-jaw, 3 when the country search finds nothing), at most 12
// months (6 with open-jaw), so 12 or 18 live searches at the most; retries add one each.
import citiesJson from "@/public/data/cities.json";
import countriesJson from "@/public/data/countries.json";
import { countryAllowed } from "./been";
import { hubDegree, resolveGateway } from "./board";
import { targetCountry } from "./finder";
import { rememberedFare, type RememberedFare } from "./insights";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "./kiwi";
import { TtlLru } from "./memo";
import type { City, CountryInfo } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;

export type ScanMonth = {
  /** YYYY-MM */
  month: string;
  cheapest: number | null;
  out?: string;
  back?: string;
  nights?: number;
  stops?: number;
  carriers?: string[];
  url?: string;
  /** The origin airport the fare leaves from. */
  from?: string;
  /** The IATA code of the landing airport, so a country scan ("Italy") can be pinned per month. */
  to?: string;
  /** The landing city's name when the itinerary carries it. */
  toCity?: string;
  /** Open-jaw: the airport the flight home leaves from. */
  openJawTo?: string;
  url2?: string;
  /** The next cheapest fares of the month (up to two), for a "more dates" line. */
  also?: ScanMonth[];
  /** True when the search for this month failed (Kiwi refused), as opposed to finding no fare. */
  failed?: true;
  /** True when the fare came from the shared memory instead of a live search. */
  remembered?: true;
};
export type ScanResult = {
  origins: string[];
  to: string;
  months: ScanMonth[];
  best: ScanMonth | null;
  openJaw: ScanMonth[];
  searched: number;
  /** Searches that failed after a retry; a month with `failed` is unknown, not empty. */
  failed: number;
  /** True when at least one search failed, so the calendar is incomplete. */
  partial?: true;
  generatedAt: string;
  /** A plain sentence when the destination is on the been list and nothing was searched. */
  note?: string;
};

export type ScanParams = {
  origins: string[];
  /** IATA code, city or country name; Kiwi resolves names. */
  to: string;
  months?: number;
  minNights?: number;
  maxNights?: number;
  oneWay?: boolean;
  /** A country name: also price flying home from anywhere in it (one way in, one way out). */
  openJawFrom?: string;
  /** YYYY-MM; default the current month. */
  startMonth?: string;
  /** "Been" (ISO2): a destination in one of these is not searched; a connection through one is fine. */
  exclude?: string[];
};

const KEEP_PER_MONTH = 3;
/** Months searched at once; each month is up to three searches and the Kiwi gate allows six. */
const CONCURRENCY = 4;
const MAX_MONTHS = 12;
/** With open-jaw a month is three searches, so fewer months fit the route's time. */
const MAX_MONTHS_OPEN_JAW = 6;
/** Distinct departure days the memory must hold for a month before it stands in for a search. */
const MEMORY_MIN_DAYS = 5;
const memo = new TtlLru<ScanResult>(200, 60 * 60_000);

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD from a Kiwi timestamp; anything else is parsed and reformatted, never passed through. */
const day = (t: string) => {
  const s = t.slice(0, 10);
  if (ISO_DAY.test(s)) return s;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
};

/** The months to scan as [YYYY-MM, first searchable day, last day], skipping any already over. */
function monthWindows(startMonth: string | undefined, count: number): [string, string, string][] {
  const earliest = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  let y = Number(earliest.slice(0, 4));
  let m = Number(earliest.slice(5, 7));
  if (startMonth && /^\d{4}-\d{2}$/.test(startMonth) && startMonth > earliest.slice(0, 7)) {
    y = Number(startMonth.slice(0, 4));
    m = Number(startMonth.slice(5, 7));
  }
  const out: [string, string, string][] = [];
  for (let i = 0; i < count; i++) {
    const first = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const from = first > earliest ? first : earliest;
    if (from <= last) out.push([first.slice(0, 7), from, last]);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** The airports a destination means, when it is a code or a city we know; empty for a country. */
function airportsOf(to: string): string[] {
  const code = to.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    if (CITIES[code]) return CITIES[code].airports.slice(0, 4);
    const city = Object.values(CITIES).find((c) => c.airports.includes(code));
    return city ? city.airports.slice(0, 4) : [code];
  }
  const q = to.trim().toLowerCase();
  const hit = Object.values(CITIES).find((c) => c.name.toLowerCase() === q);
  return hit ? hit.airports.slice(0, 4) : [];
}

/** The four biggest hub cities of a country named in English, as a Kiwi comma list; "" when unknown. */
export function hubsOfCountry(name: string): string {
  const q = name.trim().toLowerCase();
  const cc = /^[a-z]{2}$/.test(q) ? q.toUpperCase() : Object.entries(COUNTRIES).find(([, c]) => c.name.toLowerCase() === q)?.[0];
  if (!cc) return "";
  return Object.entries(CITIES)
    .filter(([, c]) => c.country === cc)
    .sort((a, b) => hubDegree(b[0]) - hubDegree(a[0]))
    .slice(0, 4)
    .map(([, c]) => c.airports[0])
    .join(",");
}

function fromItinerary(month: string, it: KiwiItinerary): ScanMonth {
  const nights = nightsOf(it);
  return {
    month,
    cheapest: Math.round(it.price),
    out: day(it.outbound.departureTime),
    back: it.inbound ? day(it.inbound.departureTime) : undefined,
    nights: nights ?? undefined,
    stops: Math.max(it.outbound.stops, it.inbound?.stops ?? 0),
    carriers: [...new Set([...it.outbound.segments, ...(it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))],
    url: it.bookingUrl,
    from: it.outbound.from,
    to: it.outbound.to,
    toCity: it.outbound.segments.at(-1)?.toCity || undefined,
  };
}

function fromMemory(month: string, f: RememberedFare): ScanMonth {
  return { month, cheapest: Math.round(f.price), out: f.out, back: f.back ?? undefined, nights: f.nights ?? undefined, stops: f.stops, carriers: f.carriers, url: f.url, from: f.src, to: f.dst, toCity: f.dstCity ?? undefined, remembered: true };
}

/** One one-way search; null (not an empty list) when Kiwi refused, so the caller can count it. */
async function oneWaySearch(flyFrom: string, flyTo: string, from: string, to: string): Promise<KiwiItinerary[] | null> {
  try {
    return (await searchFlight({ flyFrom, flyTo, departureDate: kiwiDate(from), departureDateTo: kiwiDate(to) })).itineraries;
  } catch {
    return null;
  }
}

export async function scanCheapest(p: ScanParams): Promise<ScanResult> {
  const origins = [...new Set(p.origins.map((o) => o.trim().toUpperCase()).filter((o) => /^[A-Z]{3}$/.test(o)))].slice(0, 5);
  const to = p.to.trim();
  const ojCountry = p.openJawFrom?.trim() || undefined;
  const count = Math.min(ojCountry ? MAX_MONTHS_OPEN_JAW : MAX_MONTHS, Math.max(1, Math.round(p.months ?? 6)));
  const minN = Math.max(1, Math.round(p.minNights ?? 3));
  const maxN = Math.min(90, Math.max(minN, Math.round(p.maxNights ?? 14)));
  const oneWay = !!p.oneWay;
  const exclude = p.exclude ?? [];
  const key = JSON.stringify([origins, to.toLowerCase(), count, minN, maxN, oneWay, ojCountry?.toLowerCase() ?? "", p.startMonth ?? "", exclude]);
  const hit = memo.get(key);
  if (hit) return hit;
  // "Been": a destination in a visited country is answered with a note, never searched. The
  // open-jaw country is where the flight home leaves from, so a night there: dropped too.
  const generatedAt = new Date().toISOString();
  /**
   * The country a place means: the finder resolves country and city names and codes; what it
   * cannot tell (a city known only by its airports) is read off the first airport we know
   * for it. Null stays null: a region word or an unknown name is filtered by landing instead.
   */
  const countryOf = (place: string) => targetCountry(place) ?? resolveGateway(airportsOf(place)[0] ?? "")?.country ?? null;
  const toCountry = countryOf(to);
  if (!countryAllowed(toCountry ?? undefined, exclude)) {
    return { origins, to, months: [], best: null, openJaw: [], searched: 0, failed: 0, generatedAt, note: `${to} is on your been list (only new countries), so nothing was searched; a layover there is still fine.` };
  }
  const ojAllowed = countryAllowed(ojCountry ? (countryOf(ojCountry) ?? undefined) : undefined, exclude);
  /** The landing country of an itinerary, when known; a name search ("Europe") may land anywhere. */
  const lands = (it: KiwiItinerary) => countryAllowed(resolveGateway(it.outbound.to)?.country, exclude);

  const flyFrom = origins.join(",");
  const windows = monthWindows(p.startMonth, count);
  const dstAirports = airportsOf(to);
  let searched = 0;
  let failed = 0;
  const months: ScanMonth[] = [];
  const openJaw: ScanMonth[] = [];
  const fits = (nights: number | null) => nights != null && nights >= minN && nights <= maxN;

  // Open-jaw home leg: Kiwi takes the country as flyFrom (tested); its hubs are the fallback.
  const ojHubs = ojCountry && ojAllowed ? hubsOfCountry(ojCountry) : "";

  async function scanMonth([month, from, last]: [string, string, string]) {
    // 1. The memory first: a fare seen in the last 24 hours for this month and these nights,
    // trusted only when the memory holds fares on enough distinct days of the month and the
    // dates are real ISO days (a narrow reprice around one date is not a month's cheapest).
    // A remembered fare landing in a visited country is skipped like a live one would be.
    let remembered: ScanMonth | null = null;
    if (origins.length && dstAirports.length) {
      const mem = await rememberedFare(origins, dstAirports.slice(0, 4), from, last, { oneWay, minNights: minN, maxNights: maxN, maxAgeDays: 1 });
      const f = mem?.fare;
      const landsOk = !!f && countryAllowed(resolveGateway(f.dst)?.country, exclude);
      if (f && landsOk && mem.days >= MEMORY_MIN_DAYS && ISO_DAY.test(f.out) && (oneWay ? f.back == null : f.back != null && ISO_DAY.test(f.back) && fits(f.nights))) remembered = fromMemory(month, f);
    }
    let entry: ScanMonth = remembered ?? { month, cheapest: null };
    if (!remembered) {
      // 2. One search for the month: the whole month out, the nights wanted back. A failed
      // search (Kiwi sheds load with 403s and 503s) gets one more try; a month that fails
      // twice is marked failed, which is not the same as a month with no fare.
      let r: { itineraries: KiwiItinerary[] } | null = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try {
          r = oneWay
            ? await searchFlight({ flyFrom, flyTo: to, departureDate: kiwiDate(from), departureDateTo: kiwiDate(last) })
            : await searchFlight({ flyFrom, flyTo: to, departureDate: kiwiDate(from), departureDateTo: kiwiDate(last), returnDate: kiwiDate(addDays(from, minN)), returnDateTo: kiwiDate(addDays(last, maxN)) });
          searched++;
        } catch {
          if (attempt === 0) await new Promise((res) => setTimeout(res, 1500));
        }
      }
      if (r) {
        const its = r.itineraries.filter((it) => (oneWay ? !it.inbound : fits(nightsOf(it))) && lands(it)).sort((a, b) => a.price - b.price);
        const seenDates = new Set<string>();
        const kept: ScanMonth[] = [];
        for (const it of its) {
          const d = day(it.outbound.departureTime);
          if (!d || seenDates.has(d)) continue;
          seenDates.add(d);
          kept.push(fromItinerary(month, it));
          if (kept.length >= KEEP_PER_MONTH) break;
        }
        if (kept.length) entry = { ...kept[0], also: kept.slice(1) };
      } else {
        failed++;
        entry = { month, cheapest: null, failed: true };
      }
    }
    months.push(entry);

    // 3. Open-jaw: in to the destination, home from anywhere in the country named. A refused
    // search counts as failed and the month simply has no open-jaw row.
    if (ojCountry && ojAllowed) {
      const [outs, backsRaw] = await Promise.all([oneWaySearch(flyFrom, to, from, last), oneWaySearch(ojCountry, flyFrom, addDays(from, minN), addDays(last, maxN))]);
      searched += Number(outs != null) + Number(backsRaw != null);
      failed += Number(outs == null) + Number(backsRaw == null);
      let backs = backsRaw;
      if (backs != null && !backs.length && ojHubs) {
        backs = await oneWaySearch(ojHubs, flyFrom, addDays(from, minN), addDays(last, maxN));
        searched += Number(backs != null);
        failed += Number(backs == null);
      }
      let best: { o: KiwiItinerary; b: KiwiItinerary; total: number } | null = null;
      for (const o of (outs ?? []).filter(lands)) {
        for (const b of backs ?? []) {
          const oDay = day(o.outbound.departureTime);
          const bDay = day(b.outbound.departureTime);
          if (!oDay || !bDay) continue;
          const nights = daysBetween(oDay, bDay);
          if (!fits(nights)) continue;
          const total = o.price + b.price;
          if (!best || total < best.total) best = { o, b, total };
        }
      }
      if (best) {
        openJaw.push({
          month,
          cheapest: Math.round(best.total),
          out: day(best.o.outbound.departureTime),
          back: day(best.b.outbound.departureTime),
          nights: daysBetween(day(best.o.outbound.departureTime), day(best.b.outbound.departureTime)),
          stops: Math.max(best.o.outbound.stops, best.b.outbound.stops),
          carriers: [...new Set([...best.o.outbound.segments, ...best.b.outbound.segments].map((s) => s.carrierName || s.carrier))],
          url: best.o.bookingUrl,
          from: best.o.outbound.from,
          to: best.o.outbound.to,
          toCity: best.o.outbound.segments.at(-1)?.toCity || undefined,
          openJawTo: best.b.outbound.from,
          url2: best.b.bookingUrl,
        });
      }
    }
  }

  const queue = [...windows];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let w = queue.shift(); w; w = queue.shift()) await scanMonth(w);
  }));
  months.sort((a, b) => a.month.localeCompare(b.month));
  openJaw.sort((a, b) => a.month.localeCompare(b.month));
  const priced = months.filter((m) => m.cheapest != null);
  const best = priced.length ? priced.reduce((a, b) => (b.cheapest! < a.cheapest! ? b : a)) : null;
  const note = ojCountry && !ojAllowed ? `${ojCountry} is on your been list, so no open-jaw flight home from there was priced.` : undefined;
  const result: ScanResult = { origins, to, months, best, openJaw, searched, failed, partial: failed > 0 ? true : undefined, generatedAt, note };
  // A calendar with a failed month is not kept: the next call retries only the failed
  // searches (the successful ones sit in the Kiwi memo for a day).
  if (failed === 0) memo.set(key, result);
  return result;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dm = (iso?: string) => (iso && ISO_DAY.test(iso) ? `${Number(iso.slice(8, 10))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]}` : (iso ?? ""));

/** A compact text calendar for the chat: one line per month, the best, the open-jaw pairs. */
export function fmtCalendar(r: ScanResult): string {
  const lines = [`${r.origins.join(", ")} to ${r.to}, ${r.searched} live searches${r.failed ? `, ${r.failed} failed` : ""}`];
  if (r.note) lines.push(r.note);
  for (const m of r.months) {
    if (m.failed) {
      lines.push(`${label(m.month)}: search failed, try again`);
      continue;
    }
    if (m.cheapest == null) {
      lines.push(`${label(m.month)}: no fare found`);
      continue;
    }
    const dates = m.back ? `${dm(m.out)} to ${dm(m.back)}, ${m.nights} nights` : `${dm(m.out)}, one way`;
    const hops = m.stops === 0 ? "direct" : `${m.stops} stop${m.stops === 1 ? "" : "s"}`;
    const more = m.also?.length ? `; also ${m.also.map((a) => `€${a.cheapest} on ${dm(a.out)}`).join(", ")}` : "";
    lines.push(`${label(m.month)}: €${m.cheapest} ${dates}, ${hops}, ${m.carriers?.[0] ?? ""} from ${m.from}${m.remembered ? " (seen today)" : ""}${more}`);
  }
  if (r.best?.cheapest != null) lines.push(`Best: ${label(r.best.month)} at €${r.best.cheapest}${r.best.out ? ` (${dm(r.best.out)}${r.best.back ? ` to ${dm(r.best.back)}` : ""})` : ""}`);
  for (const o of r.openJaw) lines.push(`Open-jaw ${label(o.month)}: €${o.cheapest}, in to ${r.to} ${dm(o.out)} from ${o.from}, home from ${o.openJawTo} ${dm(o.back)}, two tickets`);
  return lines.join("\n");
}
