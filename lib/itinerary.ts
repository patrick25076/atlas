// The itinerary: one shape for every trip the site can build. A deal, a way from A to B, a
// short loop, a wild loop, a long stay, a group trip or an event becomes a Skeleton (the
// places, the dates, the legs with their prices and booking links), and the server turns a
// skeleton into an Itinerary (the days, hour by hour, the food, the events, the costs).
//
// CLIENT-SAFE on purpose: the panel, the deal cards, the chat cards and the command line all
// turn what they hold into a skeleton in the browser, with no request. So this file has only
// type imports and plain functions, no Node, no data files.
//
// Coordinates. Some inputs carry no coordinates for a place (a Deal knows the city code, not
// where it is; a hub airport on a route leg is a code). Those places get lat 0, lon 0 and
// their code, and the server places them by the code (normaliseSkeleton in
// lib/itinerary-server.ts) before anything is drawn: the first line of POST /api/itinerary
// is the normalised skeleton, and that is the one to put on the globe.
import type { Deal } from "./types";
import type { RouteLeg, RouteResult } from "./route-finder";
import type { Trip, TripLeg } from "./trips";
import type { WildLeg, WildTrip } from "./wild";
import type { LongStayBase } from "./longstay";
import type { GroupOption } from "./group";

export type ItinPlace = { name: string; code?: string; country?: string; lat: number; lon: number; img?: string };
export type ItinLeg = { kind: "fly" | "train" | "coach" | "ferry" | "road" | "walk"; from: ItinPlace; to: ItinPlace; date?: string; depart?: string; arrive?: string; minutes?: number; price?: number | null; estimated?: boolean; carrier?: string; url?: string; note?: string };
export type ItinStop = ItinPlace & { arrive: string; leave: string; nights: number; why?: string };
export type ItinBlock = { slot: "morning" | "afternoon" | "evening" | "night" | "all-day"; time?: string; kind: "travel" | "see" | "do" | "eat" | "drink" | "stay" | "event" | "free"; title: string; note?: string; cost?: number; url?: string; lat?: number; lon?: number; source?: string };
export type ItinDay = { n: number; date: string; stop: number; title: string; summary?: string; blocks: ItinBlock[]; cost?: number; weather?: string };
export type ItinCosts = { flights: number; ground: number; stay: number; food: number; activities: number; total: number; perDay: number; estimated: boolean };
export type ItinFood = { stop: number; dishes: string[]; where: { name: string; note?: string; url?: string; rating?: number; price?: string }[]; dessert?: string };
export type ItinEvent = { name: string; city: string; country?: string; date: string; end?: string; url?: string; why?: string };
export type Pace = "slow" | "balanced" | "packed";
export type BudgetTier = "backpacker" | "mid" | "comfort";
export type Skeleton = { title: string; subtitle?: string; origin: ItinPlace; start: string; end: string; nights: number; stops: ItinStop[]; legs: ItinLeg[]; travellers?: number; source: "deal" | "route" | "loop" | "wild" | "longstay" | "group" | "event" | "custom" };
export type Itinerary = Skeleton & { id: string; v: 1; days: ItinDay[]; costs: ItinCosts; food: ItinFood[]; events: ItinEvent[]; wishes?: string; pace: Pace; budget: BudgetTier; sources: string[]; generatedAt: string; status: "planned" | "partial" };

export const PACES: readonly Pace[] = ["slow", "balanced", "packed"];
export const BUDGET_TIERS: readonly BudgetTier[] = ["backpacker", "mid", "comfort"];

// ---------------------------------------------------------------------------------------
// Small date and wording helpers (UTC days, so a time zone never moves a date).

const DAY_MS = 86_400_000;
/** The YYYY-MM-DD part of a date or a local date-time ("2026-11-14T06:10:00" gives "2026-11-14"). */
export function dayOf(s: string | undefined | null): string {
  return typeof s === "string" ? s.slice(0, 10) : "";
}
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(dayOf(iso) + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}
/** Whole days from a to b (b minus a); 0 when either is not a date. */
export function daysBetween(a: string, b: string): number {
  const x = Date.parse(dayOf(a) + "T00:00:00Z");
  const y = Date.parse(dayOf(b) + "T00:00:00Z");
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / DAY_MS) : 0;
}
/** "06:10" from a local date-time, undefined when it has no time. */
function timeOf(s: string | undefined): string | undefined {
  return typeof s === "string" && /T\d{2}:\d{2}/.test(s) ? s.slice(11, 16) : undefined;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "Four nights", "One night", "34 nights". */
function nightsWords(n: number): string {
  const w = n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  return cap(`${w} night${n === 1 ? "" : "s"}`);
}
/** "Kuala Lumpur, Singapore, Ho Chi Minh City and Bangkok". */
export function listWords(names: string[]): string {
  const xs = names.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
/** A Kiwi destination photo id as a URL; a full URL passes through. */
function photo(img: string | undefined): string | undefined {
  if (!img) return undefined;
  return /^https?:\/\//.test(img) ? img : `https://images.kiwi.com/photos/600x600/${img}.jpg`;
}
/** A place the server will put on the map by its code (see the header). */
function byCode(name: string, code?: string, country?: string): ItinPlace {
  return { name: name || code || "", ...(code ? { code } : {}), ...(country ? { country } : {}), lat: 0, lon: 0 };
}
function groundKind(mode: string | undefined): ItinLeg["kind"] {
  const m = (mode ?? "").toLowerCase();
  if (/rail|train/.test(m)) return "train";
  if (/ferry|boat|ship/.test(m)) return "ferry";
  if (/bus|coach/.test(m)) return "coach";
  if (/walk/.test(m)) return "walk";
  return "road";
}

/**
 * The note on a leg between the traveller's own city and the airport a ticket leaves from or
 * lands at. The browser cannot tell how far apart they are (a deal knows the airport code, not
 * where it is), so it always adds the leg when the codes differ, and the server drops it when
 * the two are the same city (Bucharest and OTP) and times it by distance otherwise (Brasov to
 * OTP is about three hours by road). See normaliseSkeleton in lib/itinerary-server.ts.
 */
export const ACCESS_NOTE = "to or from the airport; time and fare are estimates";
function accessLeg(from: ItinPlace, to: ItinPlace, date: string | undefined): ItinLeg {
  return { kind: "road", from, to, ...(date ? { date } : {}), price: null, estimated: true, note: ACCESS_NOTE };
}
/** The traveller's point and an airport are the same place only when the codes say so; anything else is for the server to measure. */
function needsAccess(origin: ItinPlace | undefined, gateway: ItinPlace): origin is ItinPlace {
  return !!origin && !(origin.code && gateway.code && origin.code === gateway.code);
}
/** Wraps the flights in the ground legs from the traveller's city to the first airport and back from the last one. */
function withAccess(legs: ItinLeg[], origin: ItinPlace | undefined): ItinLeg[] {
  const firstFly = legs.find((l) => l.kind === "fly");
  const lastFly = [...legs].reverse().find((l) => l.kind === "fly");
  if (!firstFly || !lastFly) return legs;
  const out = [...legs];
  if (needsAccess(origin, firstFly.from)) out.splice(out.indexOf(firstFly), 0, accessLeg(origin, firstFly.from, firstFly.date));
  if (needsAccess(origin, lastFly.to)) out.splice(out.indexOf(lastFly) + 1, 0, accessLeg(lastFly.to, origin, lastFly.date));
  return out;
}

/** The first and last dates the skeleton touches, from its legs and its stops. */
function span(stops: ItinStop[], legs: ItinLeg[]): { start: string; end: string } {
  const dates = [...stops.flatMap((s) => [s.arrive, s.leave]), ...legs.map((l) => dayOf(l.date))].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return { start: dates[0] ?? "", end: dates[dates.length - 1] ?? "" };
}
function finish(s: Omit<Skeleton, "start" | "end" | "nights"> & { nights?: number }): Skeleton {
  const { start, end } = span(s.stops, s.legs);
  return { ...s, start, end, nights: s.nights ?? s.stops.reduce((t, x) => t + x.nights, 0) };
}

// ---------------------------------------------------------------------------------------
// The seven converters.

/**
 * A return deal (one stop from the day out to the day back), or a one-way deal (the city as a
 * pass-through). The ticket price sits on the outbound leg: a return is one ticket, so the
 * way back carries no price of its own. An open-jaw deal comes home from `backTo` on its
 * own booking link (url2), its price already inside the deal's. The flights leave from the
 * deal's own airport (`gw`); when the traveller's origin is another city, a ground leg to
 * that airport opens the trip and one back closes it.
 */
export function skeletonFromDeal(d: Deal, origin?: ItinPlace): Skeleton {
  const gateway = byCode(d.gw, d.gw);
  const home = origin ?? gateway;
  const out = dayOf(d.out);
  const back = dayOf(d.back);
  const oneWay = !back;
  const dest: ItinPlace = { ...byCode(d.city, d.dstCity || d.dst, d.country), ...(photo(d.img) ? { img: photo(d.img) } : {}) };
  const nights = oneWay ? 0 : Math.max(0, daysBetween(out, back));
  const stop: ItinStop = { ...dest, arrive: out, leave: oneWay ? out : back, nights, ...(d.trick ? { why: `the ticket continues past ${d.city}; one way, cabin bag only` } : {}) };
  const legs: ItinLeg[] = [
    { kind: "fly", from: gateway, to: dest, date: out, minutes: d.outMin || undefined, price: d.price, url: d.url, carrier: d.carriers.join(", ") || undefined, note: d.stops ? `${d.stops} stop${d.stops > 1 ? "s" : ""}` : "direct" },
  ];
  if (!oneWay) {
    const backFrom = d.backTo ? byCode(d.backTo, d.backTo) : dest;
    legs.push({ kind: "fly", from: backFrom, to: gateway, date: back, minutes: d.backMin || undefined, price: null, url: d.url2 ?? d.url, carrier: d.carriers.join(", ") || undefined, note: d.url2 ? "booked separately, included in the price above" : "on the same ticket" });
  }
  return finish({ title: oneWay ? `One way to ${d.city}` : `${nightsWords(nights)} in ${d.city}`, subtitle: `${d.price} euros ${oneWay ? "one way" : "return"}${origin ? ` from ${origin.name}` : ""}`, origin: home, stops: [stop], legs: withAccess(legs, origin), source: "deal" });
}

function routeLeg(l: RouteLeg, ends: { first?: ItinPlace; last?: ItinPlace }): ItinLeg {
  return {
    kind: l.kind,
    from: ends.first ?? byCode(l.fromName, l.from),
    to: ends.last ?? byCode(l.toName, l.to),
    ...(l.date ? { date: l.date } : {}),
    ...(l.depart ? { depart: l.depart } : {}),
    ...(l.arrive ? { arrive: l.arrive } : {}),
    minutes: l.minutes,
    price: l.price,
    ...(l.estimated ? { estimated: true } : {}),
    ...(l.carrier ? { carrier: l.carrier } : {}),
    ...(l.url ? { url: l.url } : {}),
    ...(l.note ? { note: l.note } : {}),
  };
}

/**
 * One way of a route answer: the destination as one stop for the nights between the way out
 * and the way back, or a pass-through for a one-way answer. The legs keep their prices,
 * estimates and links; the traveller's two points (not the airports) open and close the trip.
 * A ground leg without a date is dated with the leg before it (it is the same journey). An
 * answer with no dated leg at all (a ground-only free answer) takes the day asked for
 * (`asked.depart`, else three weeks out, the route finder's own default) and `asked.nights`
 * (default 4) for the way back, so the skeleton always has dates.
 */
export function skeletonFromRoute(r: RouteResult, optionIndex: number, asked: { depart?: string; nights?: number } = {}): Skeleton {
  const o = r.options[optionIndex] ?? r.cheapest ?? r.options[0];
  const origin: ItinPlace = { name: r.from.label, lat: r.from.lat, lon: r.from.lon, ...(r.from.airports[0] ? { code: r.from.airports[0] } : {}) };
  const dest: ItinPlace = { name: r.to.label, lat: r.to.lat, lon: r.to.lon, ...(r.to.airports[0] ? { code: r.to.airports[0] } : {}) };
  if (!o) return finish({ title: `${r.from.label} to ${r.to.label}`, origin, stops: [], legs: [], source: "route" });
  const datedLegs = (ls: RouteLeg[], fromPoint: ItinPlace, toPoint: ItinPlace) => {
    let last: string | undefined;
    // Ground legs before the first dated leg take its date (the drive to the airport is that morning).
    const firstDate = ls.find((l) => l.date)?.date;
    return ls.map((l, i) => {
      const leg = routeLeg(l, { first: i === 0 && l.kind !== "fly" ? fromPoint : undefined, last: i === ls.length - 1 && l.kind !== "fly" ? toPoint : undefined });
      if (leg.date) last = leg.date;
      else if (last || firstDate) leg.date = last ?? firstDate;
      return leg;
    });
  };
  const out = datedLegs(o.legs, origin, dest);
  const back = o.back?.length ? datedLegs(o.back, dest, origin) : [];
  const askedDay = /^\d{4}-\d{2}-\d{2}$/.test(dayOf(asked.depart)) ? dayOf(asked.depart) : addDays(new Date().toISOString(), 21);
  if (!out.some((l) => l.date)) for (const l of out) l.date = askedDay;
  const arrive = dayOf(out[out.length - 1]?.date) || dayOf(out[0]?.date) || askedDay;
  if (back.length && !back.some((l) => l.date)) {
    const home = addDays(arrive, Math.max(0, Math.round(asked.nights ?? 4)));
    for (const l of back) l.date = home;
  }
  const leave = back.length ? dayOf(back[0].date) || arrive : arrive;
  const nights = back.length ? Math.max(0, daysBetween(arrive, leave)) : 0;
  const stop: ItinStop = { ...dest, arrive, leave, nights, why: o.why || undefined };
  const title = back.length ? `${nightsWords(nights)} in ${r.to.label}` : `${r.from.label} to ${r.to.label}`;
  return finish({ title, subtitle: `${o.title}, ${o.total} euros${back.length ? " there and back" : ""}`, origin, stops: [stop], legs: [...out, ...back], source: "route" });
}

function tripLeg(l: TripLeg, places: Map<string, ItinPlace>, date: string): ItinLeg {
  const from = places.get(l.from) ?? byCode(l.fromName, l.from);
  const to = places.get(l.to) ?? byCode(l.toName, l.to);
  if (l.kind === "fly") return { kind: "fly", from, to, date: dayOf(l.date) || date, depart: timeOf(l.date), minutes: l.minutes, price: l.price, url: l.url, ...(l.airline ? { carrier: l.airline } : {}), note: l.transfers ? `${l.transfers} change${l.transfers > 1 ? "s" : ""}` : "direct" };
  return { kind: groundKind(l.mode), from, to, date, minutes: l.minutes, price: null, estimated: true, note: `${l.mode}${l.changes ? `, ${l.changes} change${l.changes > 1 ? "s" : ""}` : ""}; fare not known` };
}

/**
 * A short loop: its cities in order, the nights split evenly (the earlier cities take the odd
 * night), the ground hops dated on the day the city before is left.
 */
export function skeletonFromTrip(t: Trip, origin?: ItinPlace): Skeleton {
  const outDay = dayOf(t.outDate);
  const backDay = dayOf(t.backDate);
  const total = Math.max(0, t.nights || daysBetween(outDay, backDay));
  const n = Math.max(1, t.cities.length);
  const places = new Map<string, ItinPlace>(t.cities.map((c) => [c.code, { name: c.name, code: c.code, country: c.country, lat: c.lat, lon: c.lon }]));
  const firstFly = t.legs.find((l) => l.kind === "fly");
  // The flights keep their own airports; the traveller's city is joined to them by ground legs (withAccess).
  const home = origin ?? byCode(firstFly?.fromName ?? "", firstFly?.from);
  let cursor = outDay;
  const stops: ItinStop[] = t.cities.map((c, i) => {
    const nights = Math.floor(total / n) + (i < total % n ? 1 : 0);
    const arrive = cursor;
    const leave = i === n - 1 ? backDay || addDays(arrive, nights) : addDays(arrive, nights);
    cursor = leave;
    return { ...places.get(c.code)!, arrive, leave, nights: i === n - 1 ? Math.max(0, daysBetween(arrive, leave)) : nights };
  });
  const leaveOf = new Map(stops.map((s) => [s.code, s.leave]));
  const legs = t.legs.map((l) => tripLeg(l, places, l.kind === "fly" ? dayOf(l.date) : (leaveOf.get(l.from) ?? outDay)));
  return finish({ title: listWords(t.cities.map((c) => c.name)), subtitle: `${nightsWords(total).toLowerCase()}, ${t.price} euros in flights`, origin: home, stops, legs: withAccess(legs, origin), source: "loop" });
}

function wildLeg(l: WildLeg, places: Map<string, ItinPlace>): ItinLeg {
  const from = places.get(l.from) ?? byCode(l.fromName, l.from);
  const to = places.get(l.to) ?? byCode(l.toName, l.to);
  if (l.kind === "fly")
    return { kind: "fly", from, to, date: l.date, depart: timeOf(l.departAt), arrive: timeOf(l.arriveAt), minutes: Math.round(l.hours * 60), price: l.price, url: l.url, carrier: l.carriers.join(", ") || undefined, note: l.stops ? `${l.stops} stop${l.stops > 1 ? "s" : ""}${l.route.length > 2 ? ` via ${l.route.slice(1, -1).join(", ")}` : ""}` : "direct" };
  return { kind: groundKind(l.mode), from, to, date: l.date, minutes: l.minutes, price: l.price, ...(l.estimated ? { estimated: true } : {}), note: l.mode };
}

/** A wild loop as built: its stops and legs, unchanged. */
export function skeletonFromWild(t: WildTrip): Skeleton {
  const places = new Map<string, ItinPlace>(t.stops.map((s) => [s.code, { name: s.name, code: s.code, country: s.country, lat: s.lat, lon: s.lon }]));
  const firstLeg = t.legs[0];
  const home = byCode(firstLeg?.fromName ?? t.home, firstLeg?.from ?? t.home);
  const stops: ItinStop[] = t.stops.map((s) => ({ ...places.get(s.code)!, arrive: s.arrive, leave: s.depart, nights: s.nights, ...(s.note ? { why: s.note } : {}) }));
  const legs = t.legs.map((l) => wildLeg(l, places));
  return finish({ title: listWords(t.stops.map((s) => s.name)), subtitle: `${t.totals.nights} nights, ${t.totals.countries} ${t.totals.countries === 1 ? "country" : "countries"}, about ${t.totals.all} euros`, origin: home, stops, legs, source: "wild" });
}

/**
 * One long-stay base: in on the flight in, out on the flight out, `days` apart. A base with
 * no flight found is dated from the flight it has, or a month from today when it has none.
 */
export function skeletonFromLongStay(b: LongStayBase, origin?: ItinPlace): Skeleton {
  const days = b.days ?? b.months * 30;
  const arrive = b.flightIn?.date ? dayOf(b.flightIn.date) : b.flightOut?.date ? addDays(b.flightOut.date, -days) : addDays(new Date().toISOString().slice(0, 10), 30);
  const leave = b.flightOut?.date ? dayOf(b.flightOut.date) : addDays(arrive, days);
  const base: ItinPlace = { name: b.name, code: b.code, country: b.country, lat: b.lat, lon: b.lon, ...(photo(b.img) ? { img: photo(b.img) } : {}) };
  const home = origin ?? byCode(b.flightIn?.from ?? b.flightOut?.to ?? "", b.flightIn?.from ?? b.flightOut?.to);
  const legs: ItinLeg[] = [];
  if (b.flightIn) legs.push({ kind: "fly", from: byCode(b.flightIn.from, b.flightIn.from), to: base, date: dayOf(b.flightIn.date), price: b.flightIn.price, url: b.flightIn.url });
  if (b.flightOut) legs.push({ kind: "fly", from: base, to: byCode(b.flightOut.to, b.flightOut.to), date: dayOf(b.flightOut.date), price: b.flightOut.price, url: b.flightOut.url });
  const nights = Math.max(0, daysBetween(arrive, leave));
  const months = Math.max(1, Math.round(nights / 30));
  const title = months === 1 ? `A month in ${b.name}` : `${cap(WORDS[months] ?? String(months))} months in ${b.name}`;
  return finish({ title, subtitle: `about ${b.monthlyLiving} euros a month to live there, rent ${b.rent}`, origin: home, stops: [{ ...base, arrive, leave, nights, ...(b.why[0] ? { why: b.why[0] } : {}) }], legs: withAccess(legs, origin), source: "longstay" });
}

/** A group option seen by one member: their fare, the shared window, the meeting city. */
export function skeletonFromGroup(o: GroupOption, memberIndex: number): Skeleton {
  const m = o.perMember[memberIndex] ?? o.perMember[0];
  const arrive = dayOf(m?.out) || o.window.from;
  const leave = dayOf(m?.back) || o.window.to;
  const home = byCode(m?.from ?? "", m?.from);
  const dest = byCode(o.city, o.dstCity, o.country);
  const nights = Math.max(0, daysBetween(arrive, leave));
  const legs: ItinLeg[] = m
    ? [
        { kind: "fly", from: home, to: dest, date: arrive, price: m.price, url: m.url, ...(m.note ? { note: m.note } : {}) },
        { kind: "fly", from: dest, to: home, date: leave, price: null, url: m.url, note: "on the same ticket" },
      ]
    : [];
  const others = o.perMember.filter((_, i) => i !== memberIndex).map((x) => x.name);
  return finish({ title: `${nightsWords(nights)} in ${o.city}`, subtitle: others.length ? `with ${listWords(others)}` : undefined, origin: home, stops: [{ ...dest, arrive, leave, nights, why: `everyone meets here; ${o.total} euros for the group in flights` }], legs, travellers: Math.max(1, o.perMember.length), source: "group" });
}

/**
 * An event trip: the event's city around its dates (a day before to a day after; a season of
 * more than five days gets four nights from its first day), or the deal's dates when a fare
 * was found for it. Without a deal the legs are there but unpriced.
 */
export function skeletonFromEvent(e: { name: string; city: string; country: string; lat: number; lon: number; from: string; to: string; deal?: Deal | null }, origin?: ItinPlace): Skeleton {
  if (e.deal) {
    // The stop stays the deal's city (where the flight lands, placed by its code). The event
    // may be at a venue further on (Lerwick for Edinburgh), so it is named in `why` instead of
    // moving the stop onto the venue under the airport's code.
    const s = skeletonFromDeal(e.deal, origin);
    const venue = e.city && e.city !== s.stops[0].name ? ` at ${e.city}` : "";
    const stop = { ...s.stops[0], why: `for ${e.name}${venue}, ${e.from === e.to ? e.from : `${e.from} to ${e.to}`}` };
    return { ...s, title: `${e.name} in ${e.city}`, subtitle: `${nightsWords(stop.nights).toLowerCase()}, ${e.deal.price} euros return`, stops: [stop], source: "event" };
  }
  const long = daysBetween(e.from, e.to) > 5;
  const arrive = long ? dayOf(e.from) : addDays(e.from, -1);
  const leave = long ? addDays(e.from, 4) : addDays(e.to, 1);
  const place: ItinPlace = { name: e.city, country: e.country, lat: e.lat, lon: e.lon };
  const nights = Math.max(0, daysBetween(arrive, leave));
  const legs: ItinLeg[] = origin
    ? [
        { kind: "fly", from: origin, to: place, date: arrive, price: null, note: "not priced yet" },
        { kind: "fly", from: place, to: origin, date: leave, price: null, note: "not priced yet" },
      ]
    : [];
  return finish({ title: `${e.name} in ${e.city}`, subtitle: nightsWords(nights).toLowerCase(), origin: origin ?? place, stops: [{ ...place, arrive, leave, nights, why: `for ${e.name}` }], legs, source: "event" });
}

// ---------------------------------------------------------------------------------------
// The key.

/** cyrb53: a fast 53-bit string hash, good enough to key a cache (not for security). */
function hash53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Everything a plan shows and the model reads, as one string: every field of the skeleton
 * (titles, places with names and photos, stop notes, legs with times, carriers, links and
 * notes) plus the wishes, pace and budget. Two requests share a cached plan only when this
 * string is the same, so nobody can get their links or words served on someone else's trip.
 * The field order is fixed here, not taken from the object.
 */
export function itineraryCanon(s: Skeleton, opts: { wishes?: string; pace?: Pace; budget?: BudgetTier } = {}): string {
  const p = (x: ItinPlace | undefined) => (x ? [x.code ?? "", x.name ?? "", x.country ?? "", Number(x.lat).toFixed(3), Number(x.lon).toFixed(3), x.img ?? ""] : []);
  return JSON.stringify([
    "v2",
    s.title ?? "",
    s.subtitle ?? "",
    s.source ?? "",
    p(s.origin),
    s.travellers ?? 1,
    s.stops.map((x) => [...p(x), x.arrive, x.leave, x.nights, x.why ?? ""]),
    s.legs.map((l) => [l.kind, p(l.from), p(l.to), dayOf(l.date), l.depart ?? "", l.arrive ?? "", l.minutes ?? "", l.price ?? "", l.estimated ? 1 : 0, l.carrier ?? "", l.url ?? "", l.note ?? ""]),
    (opts.wishes ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    opts.pace ?? "balanced",
    opts.budget ?? "mid",
  ]);
}

/**
 * A stable short key for "this trip, planned this way": a hash of itineraryCanon. Eleven
 * base-36 characters, used as the cache key and the itinerary's id. Not a security hash: the
 * server keeps a SHA-256 of the same string beside each cached plan and checks it on a hit.
 */
export function itineraryKey(s: Skeleton, opts: { wishes?: string; pace?: Pace; budget?: BudgetTier } = {}): string {
  return hash53(itineraryCanon(s, opts)).toString(36).padStart(11, "0");
}
