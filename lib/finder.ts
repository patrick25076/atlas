// Server-only. The custom search: "the best getaway from my airports, somewhere in this
// period, including that date, these many nights, direct, back to any of my airports".
// Kiwi takes several origins in one search and a date range for each leg, so a period
// search is one call per target (anywhere, then the nearest countries); the nights, the
// must-include date and the flight length are filtered afterwards. Returning to a different
// home airport is two one-way searches per shortlisted city.
import { targetsFor, resolveGateway, toDeal, trimDeals } from "./board";
import { kiwiDate, nightsOf, searchFlight, type KiwiItinerary } from "./kiwi";
import type { Deal } from "./types";

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
  onDeals?: (deals: Deal[], target: string) => void;
  onProgress?: (line: string) => void;
};
export type FinderResult = { deals: Deal[]; searched: number; failed: number; openJaw: number; generatedAt: string };

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const hoursOf = (it: KiwiItinerary) => Math.max(it.outbound.durationSeconds, it.inbound?.durationSeconds ?? 0) / 3600;

export async function findDeals(p: FinderParams): Promise<FinderResult> {
  const say = p.onProgress ?? (() => {});
  const origins = p.origins.filter((o) => /^[A-Z]{3}$/.test(o)).slice(0, 5);
  const flyFrom = origins.join(",");
  const minN = Math.max(1, p.minNights);
  const maxN = Math.max(minN, p.maxNights);
  const depTo = addDays(p.to, -minN);
  if (depTo < p.from) return { deals: [], searched: 0, failed: 0, openJaw: 0, generatedAt: new Date().toISOString() };
  const fits = (out: string, back: string, nights: number | null) =>
    nights != null && nights >= minN && nights <= maxN && out >= p.from && back <= p.to && (!p.include || (out <= p.include && back >= p.include));

  // Targets: the whole world first, then the nearest countries for breadth.
  const first = resolveGateway(origins[0]);
  let targets: string[] = [];
  if (p.where && p.where !== "anywhere") targets = p.where.split(",").map((s) => s.trim()).filter(Boolean);
  else if (first) targets = targetsFor(first.lat, first.lon, first.country).filter((t) => /^[A-Za-z]/.test(t) && t.length > 3).slice(0, 18);
  if (!targets.includes("anywhere") && (!p.where || p.where === "anywhere")) targets.unshift("anywhere");

  // A getaway leaves the country unless the search names it.
  const home = first?.country ?? "";
  const domesticOk = !!p.where && p.where !== "anywhere";
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
        const found: Deal[] = [];
        for (const it of r.itineraries) {
          const out = it.outbound.departureTime.slice(0, 10);
          const back = it.inbound?.departureTime.slice(0, 10) ?? "";
          if (!fits(out, back, nightsOf(it))) continue;
          if (p.direct && (it.outbound.stops > 0 || (it.inbound?.stops ?? 0) > 0)) continue;
          if (p.maxHours && hoursOf(it) > p.maxHours) continue;
          const d = toDeal(it.outbound.from, it, nightsOf(it)!);
          if (!domesticOk && d.country === home) continue;
          found.push(d);
        }
        if (found.length) {
          all.push(...found);
          p.onDeals?.(trimDeals(found), t);
        }
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: 5 }, worker));

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
  return { deals: trimDeals(all), searched, failed, openJaw, generatedAt: new Date().toISOString() };
}
