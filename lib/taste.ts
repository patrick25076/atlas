// The taste of a trip's flights on top of their fares and hours, shared by the price map's search and the server's
// ranking (lib/flight-graph.ts, lib/search.ts) and the Search tab's own sort (components/search/ResultsList.tsx), so
// the list never reorders what the server ranked. No imports: the browser bundles it too.

export type Tradeoff = "price" | "balanced" | "comfort";
/** Euros an hour of travel is worth: nothing on price (hours only break ties), then the plan's two rates. */
export const HOUR_EURO: Record<Tradeoff, number> = { price: 0, balanced: 6, comfort: 18 };
/** A change of plane on a ticket, in euros on top of its fare, per tradeoff (the walk's STOP_EURO): the owner wants
 * fewer stops, so even at Cheapest a nonstop beats a one-stop that is a few euros cheaper. Ranking only, never a price. */
export const STOP_EURO: Record<Tradeoff, number> = { price: 12, balanced: 25, comfort: 60 };
/** A flight this long (minutes in the air and between) is a long haul: a missed connection there costs a day. */
const LONG_HAUL_MIN = 8 * 60;
/** Past this many hours one journey tires twice as fast: each hour more costs the hour's euros again. */
const TIRED_AFTER_H = 20;

/**
 * The taste cost of one flight on top of its fare and its hours (never in a price): each change of plane STOP_EURO,
 * twice that on a long haul; one more for every airline past two (separate tickets, a self-transfer between low-cost
 * carriers); and the hours past TIRED_AFTER_H counted twice. Brasov to Cairns with 3 changes on Pegasus, AirAsia X,
 * AirAsia and Jetstar in 35 h for 550 euro beat Qatar through Doha, 1 change, 24 h, 695 euro, when a change was 25
 * euro whatever the flight and an hour 6 (the owner's search to Australia, 2026-10-13); with this it loses by about 140.
 */
export function flightTaste(stops: number | undefined, minutes: number | undefined, carrier: string | undefined, tradeoff: Tradeoff): number {
  const unit = STOP_EURO[tradeoff];
  const m = Math.max(0, minutes ?? 0);
  const changes = Math.max(0, stops ?? 0) * unit * (m > LONG_HAUL_MIN ? 2 : 1);
  const airlines = carrier ? new Set(carrier.split(",").map((x) => x.trim()).filter(Boolean)).size : 0;
  const tickets = Math.max(0, airlines - 2) * unit;
  const tired = Math.max(0, m / 60 - TIRED_AFTER_H) * HOUR_EURO[tradeoff];
  return changes + tickets + tired;
}

/**
 * The taste of a whole trip's flights, for ranking finished trips. Cheapest is money alone (the owner: money first,
 * hours only break ties), so it is 0 there; Balanced and Comfort count every flight's flightTaste.
 */
export function tripTaste(legs: readonly { kind: string; stops?: number; minutes?: number; carrier?: string }[], tradeoff: Tradeoff): number {
  if (tradeoff === "price") return 0;
  return legs.reduce((a, l) => a + (l.kind === "fly" ? flightTaste(l.stops, l.minutes, l.carrier, tradeoff) : 0), 0);
}
