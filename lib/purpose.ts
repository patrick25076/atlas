// Server-only. Travel with a purpose: the events worth flying for inside a window, each with
// the cheapest way there from the traveller's airports. Tonight's boards answer first (free),
// a live search fills the rest for the best few. Dates of the edition are the usual ones;
// the chat verifies the exact edition on the web when it matters.
import { countryAllowed } from "./been";
import { eventsInWindow, type PurposeEvent } from "./purpose-events";
import { dealsFor } from "./deals-source";
import { kiwiDate, nightsOf, searchFlight } from "./kiwi";
import { haversineKm } from "./geo";
import { resolveGateway } from "./board";
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
  const words = `${fold(e.name)} ${fold(e.city)}`.split(" ").filter(Boolean);
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
          .filter((x) => x.n != null && x.n >= 2 && x.n <= 6 && x.it.outbound.departureTime.slice(0, 10) <= e.end && (x.it.inbound?.departureTime.slice(0, 10) ?? "") >= e.start)
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
