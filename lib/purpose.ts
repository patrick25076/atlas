// Server-only. Travel with a purpose: the events worth flying for inside a window, each with
// the cheapest way there from the traveller's airports. Tonight's boards answer first (free),
// a live search fills the rest for the best few. Dates of the edition are the usual ones;
// the chat verifies the exact edition on the web when it matters.
import { countryAllowed } from "./been";
import { eventsAt, eventsInWindow, type PlaceEvent, type PurposeEvent } from "./purpose-events";
import { dealsFor } from "./deals-source";
import { kiwiDate, nightsOf, searchFlight } from "./kiwi";
import { haversineKm } from "./geo";
import { resolveGateway, sensibleTicket } from "./board";
import citiesJson from "@/public/data/cities.json";
import type { City, Deal } from "./types";

const CITIES = citiesJson as unknown as Record<string, City>;
const cityOf = new Map<string, string>();
for (const [code, c] of Object.entries(CITIES)) for (const a of c.airports) cityOf.set(a, code);

export type PurposeTrip = { event: PurposeEvent & { start: string; end: string }; deal: Deal | null; source: "board" | "live" | "none"; km: number };
/**
 * The list of trips, carrying the count of Kiwi searches this run sent (`searched`) and how
 * many of them Kiwi refused (`failed`), so a caller's budget counts the exact number instead
 * of the `live` cap. Still an array: every existing caller keeps working. JSON drops the two
 * properties, so a route that wants them spreads them into its body.
 */
export type PurposeTrips = PurposeTrip[] & { searched: number; failed: number };

/** Lower case, no diacritics, hyphens and punctuation as spaces: "Tromsø", "tromso" and "tango-week" read as words. */
const fold = (s: string) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Whether an event answers a free-text filter: its kind (festival, sport, culture, season,
 * music, food), a word of its name ("carnival", "marathon", "lantern"), its city, or its
 * country or city code. Codes are exact: a two-letter token is a country and nothing else
 * ("ro" never reads as a piece of "Roskilde"); a three-letter one is a city code or a word.
 * Words match whole words of the name and city (a word of four letters or more also as a
 * prefix, so "lantern" finds "lanterns"), never the note, which is description, not a tag.
 */
export function eventMatches(e: PurposeEvent, kinds: readonly string[] | undefined): boolean {
  if (!kinds?.length) return true;
  // The venue counts as the city too: "kyoto" finds Gion Matsuri, filed under Osaka for the flight.
  const words = `${fold(e.name)} ${fold(e.city)} ${fold(e.venue ?? "")}`.split(" ").filter(Boolean);
  const matchesWord = (k: string) => words.some((w) => w === k || (k.length >= 4 && w.startsWith(k)));
  return kinds.some((raw) => {
    const k = fold(raw);
    if (!k) return false;
    if (k === e.kind) return true;
    if (k.length === 2) return k.toUpperCase() === e.country;
    if (k.length === 3 && k.toUpperCase() === e.code) return true;
    // A phrase ("tango week", once "tango-week") must have every one of its words in the event.
    return k.split(" ").every(matchesWord);
  });
}

export async function purposeTrips(gateways: string[], from: string, to: string, opts: { live?: number; kinds?: readonly string[]; exclude?: string[] } = {}): Promise<PurposeTrips> {
  // "Been": an event in a visited country is hidden before any board lookup or search.
  const exclude = opts.exclude ?? [];
  const events = eventsInWindow(from, to).filter((e) => eventMatches(e, opts.kinds) && countryAllowed(e.country, exclude));
  const home = resolveGateway(gateways[0]);
  const boards = await dealsFor(gateways);
  const out: PurposeTrip[] = [];
  const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
  for (const e of events) {
    const city = CITIES[e.code] ?? CITIES[cityOf.get(e.code) ?? ""];
    const km = home && city ? haversineKm(home.lat, home.lon, city.lat, city.lon) : 0;
    // A board deal that overlaps the event: there on at least one of its days.
    const hit = boards.deals
      .filter((d) => (d.dstCity === e.code || d.dst === e.code || cityOf.get(d.dst) === e.code) && d.out <= e.end && d.back >= e.start)
      .sort((a, b) => a.price - b.price)[0];
    out.push({ event: e, deal: hit ?? null, source: hit ? "board" : "none", km });
  }
  // Live for the nearest few without a board hit: a return around the event, 2 to 5 nights.
  const live = out.filter((t) => !t.deal).sort((a, b) => a.km - b.km).slice(0, opts.live ?? 4);
  let searched = 0;
  let failed = 0;
  await Promise.all(
    live.map(async (t) => {
      try {
        const e = t.event;
        const r = await searchFlight({ flyFrom: gateways.join(","), flyTo: e.code, departureDate: kiwiDate(addDays(e.start, -2)), departureDateTo: kiwiDate(e.end), returnDate: kiwiDate(addDays(e.start, 1)), returnDateTo: kiwiDate(addDays(e.end, 3)) });
        searched++;
        const it = r.itineraries
          .map((x) => ({ it: x, n: nightsOf(x) }))
          .filter((x) => x.n != null && x.n >= 2 && x.n <= 6 && x.it.outbound.departureTime.slice(0, 10) <= e.end && (x.it.inbound?.departureTime.slice(0, 10) ?? "") >= e.start && sensibleTicket(x.it))
          .sort((a, b) => a.it.price - b.it.price)[0];
        if (!it) return;
        const d: Deal = {
          gw: it.it.outbound.from,
          dst: it.it.outbound.to,
          dstCity: cityOf.get(it.it.outbound.to) ?? it.it.outbound.to,
          city: CITIES[cityOf.get(it.it.outbound.to) ?? ""]?.name ?? e.city,
          country: e.country,
          price: Math.round(it.it.price),
          out: it.it.outbound.departureTime.slice(0, 10),
          back: it.it.inbound?.departureTime.slice(0, 10) ?? "",
          nights: it.n!,
          stops: Math.max(it.it.outbound.stops, it.it.inbound?.stops ?? 0),
          carriers: [...new Set([...it.it.outbound.segments, ...(it.it.inbound?.segments ?? [])].map((s) => s.carrierName || s.carrier))],
          outMin: Math.round(it.it.outbound.durationSeconds / 60),
          backMin: it.it.inbound ? Math.round(it.it.inbound.durationSeconds / 60) : 0,
          url: it.it.bookingUrl,
          img: it.it.imageId,
        };
        // A ticket home from a nearby airport of another city (Milan in, Bergamo out) says so.
        if (it.it.inbound && it.it.inbound.from !== it.it.outbound.to) {
          const back = cityOf.get(it.it.inbound.from) ?? it.it.inbound.from;
          if (back !== d.dstCity) {
            d.backFrom = it.it.inbound.from;
            d.backFromCity = CITIES[back]?.name ?? it.it.inbound.segments[0]?.fromCity ?? it.it.inbound.from;
          }
        }
        t.deal = d;
        t.source = "live";
      } catch {
        // Kiwi refused the search (throttle, budget): the event stays unpriced, the count says so.
        failed++;
      }
    }),
  );
  const sorted = out.sort((a, b) => (a.deal ? a.deal.price : 9999) - (b.deal ? b.deal.price : 9999));
  return Object.assign(sorted, { searched, failed });
}

/**
 * "What is on here": the curated events at a city (a code such as "LIS" or a name such as
 * "Lisbon") or near a point, during a window. No board lookup, no search: the place pages
 * call it through GET /api/purpose?city= or ?near=. A city the data knows also matches by
 * distance to the venue (within `km`, default 150): a point near Bath finds Glastonbury at Pilton.
 */
export function placeEvents(q: { city?: string; lat?: number; lon?: number; km?: number }, from: string, to: string, exclude: string[] = []): { place: { code?: string; name: string; lat?: number; lon?: number } | null; events: PlaceEvent[] } {
  let lat = q.lat;
  let lon = q.lon;
  let place: { code?: string; name: string; lat?: number; lon?: number } | null = null;
  if (q.city) {
    const raw = q.city.trim();
    const code = /^[A-Za-z]{3}$/.test(raw) ? (CITIES[raw.toUpperCase()] ? raw.toUpperCase() : cityOf.get(raw.toUpperCase())) : undefined;
    const byName = code ? undefined : cityByFoldedName().get(fold(raw));
    const found = code ?? byName;
    if (found && CITIES[found]) {
      const c = CITIES[found];
      place = { code: found, name: c.name, lat: c.lat, lon: c.lon };
      lat ??= c.lat;
      lon ??= c.lon;
    } else place = { name: raw };
  } else if (lat != null && lon != null) place = { name: `${lat.toFixed(2)},${lon.toFixed(2)}`, lat, lon };
  const events = eventsAt({ city: place?.code ?? q.city, lat, lon, km: q.km }, from, to).filter((e) => countryAllowed(e.country, exclude));
  return { place, events };
}

let foldedNames: Map<string, string> | null = null;
/** Folded city name to code, built on first use (the bigger city wins a shared name). */
function cityByFoldedName(): Map<string, string> {
  if (foldedNames) return foldedNames;
  foldedNames = new Map();
  for (const [code, c] of Object.entries(CITIES)) {
    const k = fold(c.name);
    const had = foldedNames.get(k);
    if (!had || (CITIES[had].pop ?? 0) < (c.pop ?? 0)) foldedNames.set(k, code);
  }
  return foldedNames;
}
