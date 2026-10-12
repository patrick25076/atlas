// One shape for every trip any engine finds (docs/plans/one-search.md): the paired one-ways, the
// route finder, the flight graph, the graph walk, the wild walk, the long stay and the group
// search all answer in their own types; the one search turns each answer into a TripResult so
// one card, one list and one trip page render them all.
//
// CLIENT-SAFE on purpose: the chat, the search bar, the trip page and the server all import it.
// Type-only imports, no data files, no Node. A converter that meets a place it cannot locate (a
// Deal knows a city code, not where it is) gives it lat 0, lon 0 and its code, the convention of
// lib/itinerary.ts; lib/search.ts places every result on the server before it is sent, and a
// caller in the browser can pass its own `locate` to do the same.
//
// Honesty rules every converter keeps: `price` is the tickets as the engine found them (flights,
// and any leg sold at a real fare); `groundPrice` is the trains, coaches and drives priced at the
// engines' 0.10 euro a km, never added into `price`; every estimated leg says so; `source` and
// `seen` say where the flight prices came from and how old they are.
import type { Deal } from "./types";
import type { Prefs } from "./prefs";
import type { RouteLeg, RouteOption, RouteResult } from "./route-finder";
import type { WalkLeg, WalkLoop } from "./graph-walk";
import type { EverywhereCity, GraphLeg, GraphTrip } from "./flight-graph";
import type { WildLeg, WildStop, WildTrip } from "./wild";
import type { LongStayBase } from "./longstay";
import type { GroupOption } from "./group";
import type { ItinLeg, ItinPlace, ItinStop, Skeleton } from "./itinerary";

// ---------------------------------------------------------------------------------------
// The contract.

export type SearchQuery = {
  from: { label: string; lat: number; lon: number; airports: string[]; home: string };
  to: { kind: "anywhere" } | { kind: "place"; name: string; code?: string } | { kind: "country"; name: string; code?: string } | { kind: "region"; key: string };
  when: { kind: "dates"; out: string; back?: string } | { kind: "window"; from: string; to: string; include?: string } | { kind: "month"; month: string } | { kind: "anytime" };
  nights?: [number, number];
  oneWay?: boolean;
  shape?: "any" | "return" | "two" | "loop" | "long";
  /** Places every trip must stay in, by name (Samarkand, Machu Picchu), three at the most. */
  must?: string[];
  advanced?: {
    wild?: { region: string; nights: number };
    longStay?: { months: number };
    group?: { members: { name: string; origins: string[]; available: { from: string; to: string }[] }[] };
  };
  filters?: { direct?: boolean; maxLegHours?: number; cities?: 1 | 2 | 3; trainsOk?: boolean; eventsOn?: boolean; newCountries?: boolean; maxPrice?: number };
  prefs?: Prefs;
  exclude?: string[];
  budget?: number;
  /** Which brain answers (docs/plans/one-brain.md): "one" = the price map's search and the live check only, "classic" = every engine. Left out: the server's default (ATLAS_ONE_BRAIN). */
  engine?: "one" | "classic";
};

export type TripLeg = {
  kind: "fly" | "train" | "coach" | "ferry" | "road" | "walk";
  from: string;
  fromName: string;
  to: string;
  toName: string;
  date?: string;
  depart?: string;
  arrive?: string;
  minutes?: number;
  price?: number | null;
  estimated?: boolean;
  carrier?: string;
  stops?: number;
  url?: string;
  note?: string;
  fromLat?: number;
  fromLon?: number;
  toLat?: number;
  toLon?: number;
};

export type TripStop = { name: string; code?: string; country: string; lat: number; lon: number; arrive: string; leave: string; nights: number; img?: string };

export type TripResult = {
  id: string;
  kind: "return" | "oneway" | "two-city" | "loop" | "long-stay" | "group";
  title: string;
  /** The tickets, as found. Never includes groundPrice. */
  price: number;
  /** Trains, coaches and drives at the engines' 0.10 euro a km: an estimate, shown apart. */
  groundPrice?: number;
  /** Travel hours door to door, every leg added. */
  hours?: number;
  stops: TripStop[];
  legs: TripLeg[];
  out: string;
  back?: string;
  nights: number;
  /** Every flight is nonstop. */
  direct: boolean;
  badges: string[];
  why: string[];
  source: "live" | "graph" | "memory" | "boards" | "estimate";
  /** Which engine found it: pairs, returns, route, graph, everywhere, walk, wild, longstay, group, scan. */
  engine: string;
  /** When the oldest flight price was seen (ISO), when the engine says. */
  seen?: string;
  /** One booking link per ticket, in travel order. */
  urls: string[];
  raw?: unknown;
};

/** Where a code is, for converters that only know codes. Returns null when unknown; the place then keeps lat 0, lon 0. */
export type Locate = (code: string) => { name: string; country: string; lat: number; lon: number } | null;
type ConvertOpts = { locate?: Locate; source?: TripResult["source"]; engine?: string; seen?: string };

/** The walk's and the graph's name for the traveller's door in their legs. */
export const HOME_CODE = "HOME";
/** What a kilometre of train, coach or road costs when no fare is known (every engine uses the same rate). */
export const EURO_PER_KM_ESTIMATE = 0.1;

// ---------------------------------------------------------------------------------------
// Small helpers (UTC days, so a time zone never moves a date).

const DAY_MS = 86_400_000;
const dayOf = (s: string | undefined | null): string => (typeof s === "string" ? s.slice(0, 10) : "");
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${dayOf(iso)}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const x = Date.parse(`${dayOf(a)}T00:00:00Z`);
  const y = Date.parse(`${dayOf(b)}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / DAY_MS) : 0;
}
/** "06:10" from a local date-time, undefined when it has no time. */
const timeOf = (s: string | undefined): string | undefined => (typeof s === "string" && /T\d{2}:\d{2}/.test(s) ? s.slice(11, 16) : undefined);
/** "Gdańsk" and "gdansk" are one place in an id. */
export function foldName(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/gi, "o")
    .replace(/ł/gi, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
const round = (n: number) => Math.round(n);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
function photo(img: string | undefined): string | undefined {
  if (!img) return undefined;
  return /^https?:\/\//.test(img) ? img : `https://images.kiwi.com/photos/600x600/${img}.jpg`;
}
/** "1 stop" / "2 stops via IST" / "direct" in a note, as a number; undefined when the note does not say. */
function stopsInNote(note: string | undefined): number | undefined {
  if (!note) return undefined;
  if (/^direct\b/i.test(note)) return 0;
  const m = /^(\d+) (?:stop|change)/i.exec(note);
  return m ? Number(m[1]) : undefined;
}
function stopPlace(name: string, code: string | undefined, country: string, locate?: Locate): Pick<TripStop, "name" | "code" | "country" | "lat" | "lon"> {
  const hit = code && locate ? locate(code) : null;
  return { name: name || hit?.name || code || "", ...(code ? { code } : {}), country: country || hit?.country || "", lat: hit?.lat ?? 0, lon: hit?.lon ?? 0 };
}

/**
 * The trip's identity, which is also how duplicates are found: the stops by name (folded, so the
 * route finder's "Gdańsk" and the finder's GDN-city "Gdansk" agree), the day out and the day back.
 * Two engines that found the same trip give it the same id; the cheaper one is kept.
 */
export function tripId(kind: TripResult["kind"], stops: { name: string }[], out: string, back?: string, extra = ""): string {
  const names = stops.map((s) => foldName(s.name)).filter(Boolean).join("+") || "trip";
  const k = kind === "long-stay" ? "ls" : kind === "group" ? "grp" : "t";
  return `${k}:${names}:${out || "-"}:${back || "-"}${extra ? `:${extra}` : ""}`;
}

function kindOf(stops: number, back: string | undefined): TripResult["kind"] {
  if (!back) return "oneway";
  if (stops >= 3) return "loop";
  if (stops === 2) return "two-city";
  return "return";
}

/** Sums, hours, direct and links from the legs, the same way for every engine. */
function totals(legs: TripLeg[]): { price: number; ground: number; hours: number; direct: boolean; urls: string[] } {
  let price = 0;
  let ground = 0;
  let minutes = 0;
  for (const l of legs) {
    const p = typeof l.price === "number" && Number.isFinite(l.price) ? l.price : 0;
    // A flight is a ticket even when its fare is remembered or read off a board (estimated):
    // only trains, coaches and drives belong in the ground estimate.
    if (l.estimated && l.kind !== "fly") ground += p;
    else price += p;
    minutes += l.minutes ?? 0;
  }
  const flights = legs.filter((l) => l.kind === "fly");
  const direct = flights.length > 0 && flights.every((l) => l.stops === 0);
  return { price: round(price), ground: round(ground), hours: Math.round((minutes / 60) * 10) / 10, direct, urls: uniq(legs.map((l) => l.url).filter((u): u is string => !!u)) };
}

/**
 * A trip with some legs re-priced (Search's live check): the same id (its cities and days did not change), the
 * tickets, ground, hours, nonstop flag and booking links counted again from the new legs, badges added.
 */
export function repriced(t: TripResult, legs: TripLeg[], badges: string[], source?: TripResult["source"]): TripResult {
  const x = totals(legs);
  const r: TripResult = { ...t, legs, price: x.price, hours: x.hours || t.hours, direct: x.direct, urls: x.urls, badges: uniq([...t.badges, ...badges]), ...(source ? { source } : {}) };
  if (x.ground > 0) r.groundPrice = x.ground;
  else delete r.groundPrice;
  return r;
}

/**
 * A train, coach or ferry between two different places of the trip. The train from a city to
 * another airport for the flight home (Krakow to Katowice airport on a Krakow return) is the way
 * to a flight, not a second city, so it does not count.
 */
export function isGroundHop(t: Pick<TripResult, "stops">, l: TripLeg): boolean {
  if (l.kind !== "train" && l.kind !== "coach" && l.kind !== "ferry") return false;
  const at = (code: string, name: string) => t.stops.findIndex((s) => (!!s.code && s.code === code) || (!!name && foldName(s.name) === foldName(name)));
  const a = at(l.from, l.fromName);
  const b = at(l.to, l.toName);
  return a >= 0 && b >= 0 && a !== b;
}

function badgesFor(t: Pick<TripResult, "direct" | "stops" | "legs" | "back">): string[] {
  const out: string[] = [];
  if (t.direct) out.push("direct");
  if (!t.back) out.push("one way");
  const hops = t.legs.filter((l) => isGroundHop(t, l));
  if (hops.length) out.push(hops.some((l) => l.kind === "train") ? "train between cities" : "overland between cities");
  return out;
}

function finish(base: Omit<TripResult, "id" | "badges" | "price" | "hours" | "direct" | "urls" | "kind"> & { kind?: TripResult["kind"]; price?: number; groundPrice?: number; badges?: string[]; direct?: boolean; idExtra?: string }): TripResult {
  const t = totals(base.legs);
  const kind = base.kind ?? kindOf(base.stops.length, base.back);
  const groundPrice = base.groundPrice ?? t.ground;
  const direct = base.direct ?? t.direct;
  const { idExtra, ...rest } = base;
  const r: TripResult = {
    ...rest,
    id: tripId(kind, base.stops, base.out, base.back, idExtra),
    kind,
    price: round(base.price ?? t.price),
    ...(groundPrice > 0 ? { groundPrice: round(groundPrice) } : {}),
    hours: t.hours || undefined,
    direct,
    urls: t.urls,
    badges: [],
  };
  if (!r.groundPrice) delete r.groundPrice;
  if (r.hours == null) delete r.hours;
  r.badges = uniq([...badgesFor(r), ...(base.badges ?? [])]);
  return r;
}

// ---------------------------------------------------------------------------------------
// The converters.

/**
 * A deal: a Kiwi return, or two one-way tickets paired by lib/pairs.ts (pair), maybe with a second
 * city by land (backFromCity) or by air (hop), maybe landing home at another airport with the trip
 * from there to the traveller (homeGapMin). The deal's price is the flights; the way out carries it
 * (minus the hop, which has its own), the way home says it is included.
 */
export function tripFromDeal(d: Deal, opts: ConvertOpts = {}): TripResult {
  const locate = opts.locate;
  const out = dayOf(d.out);
  const back = dayOf(d.back) || undefined;
  const nights = back ? Math.max(0, daysBetween(out, back)) : 0;
  const carrier = d.carriers.join(", ") || undefined;
  const allDirect = d.stops === 0 ? 0 : undefined;
  const first = stopPlace(d.city, d.dstCity || d.dst, d.country, locate);
  const img = photo(d.img);
  const stops: TripStop[] = [];
  const legs: TripLeg[] = [];
  const homeAirport = d.backTo ?? d.gw;
  const outPrice = d.price - (d.hop?.price ?? 0);
  legs.push({
    kind: "fly",
    from: d.gw,
    fromName: d.gw,
    to: d.dst,
    toName: d.city,
    date: out,
    ...(d.outMin ? { minutes: d.outMin } : {}),
    price: outPrice,
    ...(carrier ? { carrier } : {}),
    ...(allDirect === 0 ? { stops: 0 } : {}),
    url: d.url,
    note: d.pair ? `with the flight home, ${d.hop ? "two of three" : "both"} one-way tickets` : back ? "return ticket" : "one way",
  });
  let groundGuess = 0;
  if (d.hop && back) {
    const firstNights = Math.max(0, d.hop.nights);
    stops.push({ ...first, arrive: out, leave: d.hop.date, nights: firstNights, ...(img ? { img } : {}) });
    const second = stopPlace(d.hop.city, d.hop.to, d.hop.country, locate);
    stops.push({ ...second, arrive: d.hop.date, leave: back, nights: Math.max(0, daysBetween(d.hop.date, back)) });
    legs.push({ kind: "fly", from: d.hop.from, fromName: d.city, to: d.hop.to, toName: d.hop.city, date: d.hop.date, minutes: d.hop.min, price: d.hop.price, stops: d.hop.stops, url: d.hop.url, note: "one-way ticket" });
    legs.push({ kind: "fly", from: d.backFrom ?? d.hop.to, fromName: d.hop.city, to: homeAirport, toName: homeAirport, date: back, ...(d.backMin ? { minutes: d.backMin } : {}), price: null, ...(allDirect === 0 ? { stops: 0 } : {}), url: d.url2 ?? d.url, note: "priced with the way out" });
  } else if (back && d.backFrom && d.backFromCity && nights >= 1) {
    // In to one city, home from another nearby: the nights are shared, the trip between is by land.
    const firstNights = Math.ceil(nights / 2);
    const hopDay = addDays(out, firstNights);
    stops.push({ ...first, arrive: out, leave: hopDay, nights: firstNights, ...(img ? { img } : {}) });
    const second = stopPlace(d.backFromCity, d.backFrom, d.country, locate);
    stops.push({ ...second, arrive: hopDay, leave: back, nights: nights - firstNights });
    const gapPrice = d.gapKm != null ? Math.max(3, round(d.gapKm * EURO_PER_KM_ESTIMATE)) : null;
    if (gapPrice) groundGuess += gapPrice;
    legs.push({ kind: "road", from: d.dst, fromName: d.city, to: d.backFrom, toName: d.backFromCity, date: hopDay, ...(d.gapMin ? { minutes: d.gapMin } : {}), price: gapPrice, estimated: true, note: `${d.gapKm != null ? `about ${d.gapKm} km ` : ""}by train, coach or road, not on the ticket; fare estimated` });
    legs.push({ kind: "fly", from: d.backFrom, fromName: d.backFromCity, to: homeAirport, toName: homeAirport, date: back, ...(d.backMin ? { minutes: d.backMin } : {}), price: null, ...(allDirect === 0 ? { stops: 0 } : {}), url: d.url2 ?? d.url, note: d.url2 ? "separate ticket, priced with the way out" : "on the same ticket" });
  } else {
    stops.push({ ...first, arrive: out, leave: back ?? out, nights, ...(img ? { img } : {}) });
    if (back) {
      const leaveFrom = d.backFrom ?? d.dst;
      legs.push({ kind: "fly", from: leaveFrom, fromName: d.city, to: homeAirport, toName: homeAirport, date: back, ...(d.backMin ? { minutes: d.backMin } : {}), price: null, ...(allDirect === 0 ? { stops: 0 } : {}), url: d.url2 ?? d.url, note: d.url2 ? "separate ticket, priced with the way out" : "on the same ticket" });
    }
  }
  // The way home landed at another airport of the home country: the train, coach or drive from it.
  if (back && d.homeGapMin && d.backTo) {
    const rest = d.groundPrice != null ? Math.max(0, d.groundPrice - groundGuess) : null;
    legs.push({ kind: "road", from: d.backTo, fromName: d.backTo, to: HOME_CODE, toName: "home", date: back, minutes: d.homeGapMin, price: rest || null, estimated: true, note: "train, coach or road home from the airport; fare estimated" });
  }
  const title = d.hop ? `${d.city}, ${d.hop.city}` : d.backFromCity && back ? `${d.city}, ${d.backFromCity}` : d.city;
  const why = [d.pairNote, d.trick ? `the ticket continues past ${d.city}; one way, cabin bag only, against airline rules` : "", d.bags ? `includes a ${d.bags}` : ""].filter(Boolean) as string[];
  const r = finish({
    title,
    stops,
    legs,
    out,
    back,
    nights,
    price: d.price,
    groundPrice: d.groundPrice ?? groundGuess,
    direct: d.stops === 0,
    why,
    source: opts.source ?? "live",
    engine: opts.engine ?? (d.pair ? "pairs" : "returns"),
    ...(opts.seen ? { seen: opts.seen } : {}),
    badges: d.trick ? ["hidden city"] : [],
    raw: d,
  });
  return r;
}

function routeLegToTrip(l: RouteLeg): TripLeg {
  const stops = l.kind === "fly" ? stopsInNote(l.note) : undefined;
  return {
    kind: l.kind,
    from: l.from,
    fromName: l.fromName,
    to: l.to,
    toName: l.toName,
    ...(l.date ? { date: l.date } : {}),
    ...(l.depart ? { depart: l.depart } : {}),
    ...(l.arrive ? { arrive: l.arrive } : {}),
    minutes: l.minutes,
    price: l.price,
    ...(l.estimated ? { estimated: true } : {}),
    ...(l.carrier ? { carrier: l.carrier } : {}),
    ...(stops != null ? { stops } : {}),
    ...(l.url ? { url: l.url } : {}),
    ...(l.note || l.remembered ? { note: [l.note, l.remembered ? "a fare seen this week; times not known" : ""].filter(Boolean).join("; ") } : {}),
  };
}

/**
 * One option of the route finder (A to B): the destination as one stop for the nights between the
 * way out and the way back (a one-way answer is a pass-through). The legs keep their prices,
 * estimates and links; a remembered fare makes the source "memory", a ground-only way "estimate".
 */
export function tripFromRouteOption(r: Pick<RouteResult, "from" | "to" | "generatedAt">, o: RouteOption, opts: ConvertOpts & { asked?: { depart?: string; nights?: number } } = {}): TripResult {
  const outLegs = o.legs.map(routeLegToTrip);
  const backLegs = (o.back ?? []).map(routeLegToTrip);
  // Undated ground legs take the date of the leg next to them (the drive to the airport is that morning).
  const fill = (ls: TripLeg[], fallback?: string) => {
    let last = ls.find((l) => l.date)?.date ?? fallback;
    for (const l of ls) {
      if (l.date) last = l.date;
      else if (last) l.date = last;
    }
  };
  const asked = opts.asked ?? {};
  fill(outLegs, asked.depart);
  const arrive = dayOf([...outLegs].reverse().find((l) => l.date)?.date) || dayOf(asked.depart) || "";
  fill(backLegs, arrive && asked.nights != null ? addDays(arrive, asked.nights) : undefined);
  const out = dayOf(outLegs.find((l) => l.date)?.date) || arrive;
  const back = backLegs.length ? dayOf(backLegs.find((l) => l.kind === "fly")?.date ?? backLegs[0].date) || undefined : undefined;
  const nights = back ? Math.max(0, daysBetween(arrive, back)) : 0;
  const dest: TripStop = { name: r.to.label, ...(r.to.airports[0] ? { code: r.to.airports[0] } : {}), country: opts.locate && r.to.airports[0] ? (opts.locate(r.to.airports[0])?.country ?? "") : "", lat: r.to.lat, lon: r.to.lon, arrive, leave: back ?? arrive, nights };
  const legs = [...outLegs, ...backLegs];
  const remembered = [...o.legs, ...(o.back ?? [])].some((l) => l.remembered);
  const source: TripResult["source"] = o.kind === "ground-only" ? "estimate" : remembered ? "memory" : "live";
  return finish({
    title: r.to.label,
    stops: [dest],
    legs,
    out,
    back,
    nights,
    direct: o.nonstop === true,
    why: [o.title, o.why].filter(Boolean),
    source: opts.source ?? source,
    engine: opts.engine ?? "route",
    seen: opts.seen ?? r.generatedAt,
    badges: o.kind === "ground-only" ? ["no flight"] : o.kind === "open-jaw" ? ["open jaw"] : [],
    raw: o,
  });
}

function walkLegToTrip(l: WalkLeg, origin: string): TripLeg {
  const name = (code: string, n: string) => (code === HOME_CODE ? origin : n);
  return {
    kind: l.kind,
    from: l.from,
    fromName: name(l.from, l.fromName),
    to: l.to,
    toName: name(l.to, l.toName),
    date: l.date,
    ...(l.depart ? { depart: l.depart } : {}),
    ...(l.arrive ? { arrive: l.arrive } : {}),
    minutes: l.minutes,
    price: l.price,
    // A board fare is half a return: an estimate. Ground legs are always estimates.
    ...(l.estimated || l.kind !== "fly" ? { estimated: true } : {}),
    ...(l.carrier ? { carrier: l.carrier } : {}),
    ...(l.stops != null ? { stops: l.stops } : {}),
    ...(l.url ? { url: l.url } : {}),
    ...(l.source === "memory" ? { note: "fare seen in the last day; check the link" } : l.source === "boards" ? { note: "about half a return fare on tonight's board" } : l.source === "given" ? { note: "your own flight, as you gave it" } : l.kind !== "fly" ? { note: `${l.kind}, fare estimated from the distance` } : {}),
  };
}

/** A loop of the graph walk (lib/graph-walk.ts): its stops with their nights, its legs as walked. */
export function tripFromWalkLoop(loop: WalkLoop, opts: ConvertOpts & { origin?: string } = {}): TripResult {
  const origin = opts.origin ?? "home";
  const legs = loop.legs.map((l) => walkLegToTrip(l, origin));
  const stops: TripStop[] = loop.stops.map((s) => ({ name: s.name, code: s.code, country: s.country, lat: s.lat, lon: s.lon, arrive: s.arrive, leave: s.leave, nights: s.nights, ...(photo(s.img) ? { img: photo(s.img) } : {}) }));
  const flights = loop.legs.filter((l) => l.kind === "fly");
  const source: TripResult["source"] = flights.some((l) => l.source === "boards") ? "boards" : flights.some((l) => l.source === "memory") ? "memory" : "live";
  return finish({
    title: loop.stops.map((s) => s.name).join(", "),
    stops,
    legs,
    out: loop.start,
    back: loop.end,
    nights: loop.nights,
    price: loop.flights,
    groundPrice: loop.ground,
    why: loop.why,
    source: opts.source ?? source,
    engine: opts.engine ?? "walk",
    ...(opts.seen ? { seen: opts.seen } : {}),
    raw: loop,
  });
}

function graphLegToTrip(l: GraphLeg, origin: string): TripLeg {
  const name = (code: string, n: string) => (code === HOME_CODE ? origin : n);
  return {
    kind: l.kind === "ground" ? "road" : l.kind,
    from: l.from,
    fromName: name(l.from, l.fromName),
    to: l.to,
    toName: name(l.to, l.toName),
    date: l.date,
    ...(l.depart ? { depart: l.depart } : {}),
    minutes: l.minutes,
    price: l.price,
    // A bus, train or ferry at a typical fare is a ticket you buy (counted with the tickets), not a ground estimate.
    ...(l.source !== "overland" && (l.estimated || l.kind !== "fly") ? { estimated: true } : {}),
    ...(l.carrier ? { carrier: l.carrier } : {}),
    ...(l.stops != null ? { stops: l.stops } : {}),
    ...(l.url ? { url: l.url } : {}),
    note: l.source === "overland" ? `${l.carrier ? `${l.carrier}, ` : ""}${l.kind} at a typical fare; check and book before you go` : l.source === "tp" ? `a recent Aviasales fare${l.offDay ? " a day from this one" : ""}${l.seen ? `, seen ${l.seen.slice(0, 10)}` : ""}; an estimate, not checked live` : l.source === "graph" ? `price from the nightly graph${l.seen ? `, seen ${l.seen.slice(0, 10)}` : ""}; confirm before booking` : l.source === "memory" ? `a fare seen${l.seen ? ` ${l.seen.slice(0, 10)}` : " in the last three days"}; confirm before booking` : l.kind === "ground" ? "to or from the airport or station; fare estimated" : `${l.kind}, fare estimated from the distance`,
  };
}
function oldestSeen(legs: GraphLeg[]): string | undefined {
  const seen = legs.map((l) => l.seen).filter((s): s is string => !!s).sort();
  return seen[0];
}

/** A trip of the flight graph (lib/flight-graph.ts cheapestTrips): prices up to a day old, every leg says when it was seen. */
export function tripFromGraphTrip(t: GraphTrip, opts: ConvertOpts & { origin?: string } = {}): TripResult {
  const origin = opts.origin ?? "home";
  const legs = t.legs.map((l) => graphLegToTrip(l, origin));
  const stops: TripStop[] = t.stops.map((s) => ({ name: s.name, code: s.code, country: s.country, lat: s.lat, lon: s.lon, arrive: s.arrive, leave: s.leave, nights: s.nights }));
  const flights = t.legs.filter((l) => l.kind === "fly");
  const source: TripResult["source"] = t.legs.some((l) => l.source === "tp" || l.source === "overland") ? "estimate" : flights.length && flights.every((l) => l.source === "memory") ? "memory" : "graph";
  return finish({
    title: t.stops.map((s) => s.name).join(", "),
    stops,
    legs,
    out: t.start,
    back: t.end,
    nights: t.nights,
    price: t.flights,
    groundPrice: t.ground,
    why: t.why,
    source: opts.source ?? source,
    engine: opts.engine ?? "graph",
    seen: opts.seen ?? oldestSeen(t.legs),
    raw: t,
  });
}

/** One city of the graph's "everywhere on a date": the flight there and, with a day back, the cheapest way home. */
export function tripFromEverywhereCity(c: EverywhereCity, opts: ConvertOpts & { origin?: string } = {}): TripResult {
  const origin = opts.origin ?? "home";
  const outLegs = c.out.map((l) => graphLegToTrip(l, origin));
  const backLegs = (c.back ?? []).map((l) => graphLegToTrip(l, origin));
  const arrive = dayOf([...c.out].reverse().find((l) => l.kind === "fly")?.arrive ?? c.out.at(-1)?.arrive ?? c.out[0]?.date);
  const back = backLegs.length ? dayOf(c.back?.find((l) => l.kind === "fly")?.date ?? c.back?.[0]?.date) : undefined;
  const stops: TripStop[] = [{ name: c.name, code: c.code, country: c.country, lat: c.lat, lon: c.lon, arrive, leave: back ?? arrive, nights: back ? Math.max(0, daysBetween(arrive, back)) : 0 }];
  // A way home through a neighbour by land: the neighbour is a second place, passed through on the day.
  return finish({
    title: c.name,
    stops,
    legs: [...outLegs, ...backLegs],
    out: dayOf(c.out[0]?.date) || arrive,
    back,
    nights: stops[0].nights,
    why: [back ? `there and back${(c.back ?? []).some((l) => l.kind !== "fly" && l.from !== HOME_CODE && l.to !== HOME_CODE) ? ", home from a neighbour by land" : ""}` : "one way", "prices from the nightly graph and the fare memory; confirm before booking"],
    source: opts.source ?? ([...c.out, ...(c.back ?? [])].some((l) => l.source === "tp" || l.source === "overland") ? "estimate" : [...c.out, ...(c.back ?? [])].filter((l) => l.kind === "fly").every((l) => l.source === "memory") ? "memory" : "graph"),
    engine: opts.engine ?? "everywhere",
    seen: opts.seen ?? oldestSeen([...c.out, ...(c.back ?? [])]),
    raw: c,
  });
}

function wildLegToTrip(l: WildLeg): TripLeg {
  if (l.kind === "fly")
    return { kind: "fly", from: l.from, fromName: l.fromName, to: l.to, toName: l.toName, date: l.date, ...(timeOf(l.departAt) ? { depart: timeOf(l.departAt) } : {}), ...(timeOf(l.arriveAt) ? { arrive: timeOf(l.arriveAt) } : {}), minutes: Math.round(l.hours * 60), price: l.price, ...(l.carriers.length ? { carrier: l.carriers.join(", ") } : {}), stops: l.stops, url: l.url, note: l.stops ? `${l.stops} stop${l.stops > 1 ? "s" : ""}${l.route.length > 2 ? ` via ${l.route.slice(1, -1).join(", ")}` : ""}` : "direct" };
  const m = l.mode.toLowerCase();
  const kind: TripLeg["kind"] = /rail|train/.test(m) ? "train" : /ferry|boat/.test(m) ? "ferry" : /bus|coach/.test(m) ? "coach" : "road";
  return { kind, from: l.from, fromName: l.fromName, to: l.to, toName: l.toName, date: l.date, minutes: l.minutes, price: l.price, estimated: true, note: `${l.mode}, fare estimated from the distance` };
}
function wildStops(stops: WildStop[]): TripStop[] {
  return stops.map((s) => ({ name: s.name, code: s.code, country: s.country, lat: s.lat, lon: s.lon, arrive: s.arrive, leave: s.depart, nights: s.nights }));
}

/**
 * A wild trip (lib/wild-walk.ts or the classic chain) and its alternatives, one result each. The
 * price is the flights; the ground legs are the estimate; the living costs are in the why lines,
 * never in the price, since they are an estimate of a different kind.
 */
export function tripFromWildTrip(t: WildTrip, opts: ConvertOpts = {}): TripResult[] {
  const versions = [{ title: t.title, legs: t.legs, stops: t.stops, totals: t.totals, judge: t.judge, outDate: t.outDate, backDate: t.backDate, variant: t.variant ?? "best" }, ...(t.alternatives ?? []).map((a) => ({ ...a }))];
  return versions.map((v, i) => {
    const legs = v.legs.map(wildLegToTrip);
    const stops = wildStops(v.stops);
    const why = [
      v.judge?.verdict ?? "",
      `about ${v.totals.living} euros to live there for ${v.totals.nights} nights (an estimate, not in the price)`,
      ...(i === 0 ? (t.constraints ?? []) : []),
    ].filter(Boolean);
    return finish({
      title: stops.map((s) => s.name).join(", ") || v.title,
      stops,
      legs,
      out: dayOf(v.outDate),
      back: dayOf(v.backDate),
      nights: v.totals.nights,
      price: v.totals.flights,
      groundPrice: v.totals.ground,
      why,
      source: opts.source ?? "live",
      engine: opts.engine ?? (t.engine === "classic" ? "wild-classic" : "wild"),
      seen: opts.seen ?? t.generatedAt,
      badges: [`${v.totals.countries} ${v.totals.countries === 1 ? "country" : "countries"}`, ...(t.partial ? ["partial"] : [])],
      raw: i === 0 ? { ...t, alternatives: undefined } : v,
    });
  });
}

/**
 * One long-stay base: the flight in and the flight out, the days between. The price is the two
 * flights as found; rent and living are estimates in the why lines (the engine ranks bases by
 * what a day costs all in, which lib/search.ts keeps as the order).
 */
export function tripFromLongStayBase(b: LongStayBase, opts: ConvertOpts = {}): TripResult {
  const days = b.days ?? b.months * 30;
  const arrive = b.flightIn?.date ? dayOf(b.flightIn.date) : b.flightOut?.date ? addDays(b.flightOut.date, -days) : "";
  const leave = b.flightOut?.date ? dayOf(b.flightOut.date) : arrive ? addDays(arrive, days) : "";
  const legs: TripLeg[] = [];
  if (b.flightIn) legs.push({ kind: "fly", from: b.flightIn.from, fromName: b.flightIn.from, to: b.code, toName: b.name, date: dayOf(b.flightIn.date), price: b.flightIn.price, url: b.flightIn.url, note: "one-way ticket" });
  if (b.flightOut) legs.push({ kind: "fly", from: b.code, fromName: b.name, to: b.flightOut.to, toName: b.flightOut.to, date: dayOf(b.flightOut.date), price: b.flightOut.price, url: b.flightOut.url, note: "one-way ticket" });
  const nights = arrive && leave ? Math.max(0, daysBetween(arrive, leave)) : days;
  const why = [
    `about ${b.monthlyLiving} euros a month to live there and ${b.rent} rent (estimates); about ${b.total} euros all in, ${b.perDay} a day`,
    ...b.why,
    ...(b.visa ? [`visa: ${b.visa}`] : []),
    ...(!b.flightIn || !b.flightOut ? [b.failed ? "a flight search was refused, so a flight is unknown, not missing" : "no flight found for one way; priced without it"] : []),
  ];
  return finish({
    kind: "long-stay",
    title: b.name,
    stops: [{ name: b.name, code: b.code, country: b.country, lat: b.lat, lon: b.lon, arrive, leave, nights, ...(photo(b.img) ? { img: photo(b.img) } : {}) }],
    legs,
    out: arrive,
    back: leave || undefined,
    nights,
    why,
    source: opts.source ?? (legs.length ? "live" : "estimate"),
    engine: opts.engine ?? "longstay",
    ...(opts.seen ? { seen: opts.seen } : {}),
    badges: [`${b.months} month${b.months === 1 ? "" : "s"}`],
    raw: b,
  });
}

/** A group option: everyone meets in one city; one return ticket per member, the price is the group's sum. */
export function tripFromGroupOption(o: GroupOption, opts: ConvertOpts = {}): TripResult {
  const place = stopPlace(o.city, o.dstCity, o.country, opts.locate);
  const legs: TripLeg[] = [];
  for (const m of o.perMember) {
    if (!m.url) continue; // a member already in the city flies nowhere
    legs.push({ kind: "fly", from: m.from, fromName: `${m.name} from ${m.from}`, to: o.dstCity, toName: o.city, date: dayOf(m.out), price: m.price, url: m.url, note: `${m.name}'s return ticket${m.note ? `; ${m.note}` : ""}` });
    legs.push({ kind: "fly", from: o.dstCity, fromName: o.city, to: m.from, toName: `${m.name} home`, date: dayOf(m.back), price: null, url: m.url, note: "on the same ticket" });
  }
  const at = o.perMember.filter((m) => !m.url).map((m) => m.name);
  return finish({
    kind: "group",
    title: `Meet in ${o.city}`,
    stops: [{ ...place, arrive: o.window.from, leave: o.window.to, nights: o.window.nights }],
    legs,
    out: o.window.from,
    back: o.window.to,
    nights: o.window.nights,
    price: o.total,
    why: [`${o.total} euros for the group in flights: ${o.perMember.map((m) => `${m.name} ${m.url ? `${m.price}` : "at home"}`).join(", ")}`, ...(at.length ? [`${at.join(", ")} already ${at.length === 1 ? "lives" : "live"} there`] : []), ...o.window.compromises],
    source: opts.source ?? "live",
    engine: opts.engine ?? "group",
    ...(opts.seen ? { seen: opts.seen } : {}),
    badges: [o.window.everyone ? "everyone free" : "a compromise on dates"],
    idExtra: o.perMember.map((m) => m.from).join("-"),
    raw: o,
  });
}

// ---------------------------------------------------------------------------------------
// Filters (the chips under the bar), instant and client side; the server applies the same.

/**
 * The results that pass the filter chips. been: the countries the traveller has been to, for
 * "New countries" (every stop somewhere new). trainsOk false drops trips with a train, coach or
 * ferry between two of their places. maxPrice compares the door-to-door price (doorPrice), the number on the card.
 */
/**
 * What a trip costs door to door: the tickets plus the trains, coaches and drives priced as an
 * estimate (to the airport, between places, home). The big number on a card and a globe tag, so
 * the Cheapest list reads in order: it ranks by this same sum.
 */
export function doorPrice(t: Pick<TripResult, "price" | "groundPrice">): number {
  return Math.round(t.price + (t.groundPrice ?? 0));
}

/**
 * One card per route for a search with flexible dates: the same cities in the same order on
 * other days fold into the cheapest of them (the list must already be sorted, cheapest first),
 * which carries an "N more dates" badge. The other days stay one tap away on the trip page
 * (Ways home). A search on exact dates is returned as it is.
 */
export function oneEachRoute(sorted: TripResult[], when?: SearchQuery["when"]): TripResult[] {
  if (!when || when.kind === "dates") return sorted;
  const firstOf = new Map<string, number>();
  const more = new Map<number, number>();
  const out: TripResult[] = [];
  for (const t of sorted) {
    const key = `${t.kind}|${t.stops.map((x) => x.name.trim().toLowerCase()).join(">")}`;
    const at = firstOf.get(key);
    if (at == null) {
      firstOf.set(key, out.length);
      out.push(t);
    } else more.set(at, (more.get(at) ?? 0) + 1);
  }
  return out.map((t, i) => {
    const n = more.get(i);
    return n ? { ...t, badges: [...t.badges, `${n} more date${n === 1 ? "" : "s"}`] } : t;
  });
}

export function applyFilters(results: TripResult[], f?: SearchQuery["filters"], been?: string[]): TripResult[] {
  if (!f) return results;
  const beenSet = new Set((been ?? []).map((c) => c.toUpperCase()));
  return results.filter((t) => {
    if (f.direct && !t.direct) return false;
    if (f.maxLegHours && f.maxLegHours > 0 && t.legs.some((l) => l.kind === "fly" && (l.minutes ?? 0) > f.maxLegHours! * 60)) return false;
    if (f.cities === 1 && t.stops.length !== 1) return false;
    if (f.cities === 2 && t.stops.length !== 2) return false;
    if (f.cities === 3 && t.stops.length < 3) return false;
    if (f.trainsOk === false && t.legs.some((l) => isGroundHop(t, l))) return false;
    if (f.eventsOn && !t.badges.includes("events on")) return false;
    if (f.newCountries && beenSet.size && t.stops.some((s) => s.country && beenSet.has(s.country.toUpperCase()))) return false;
    if (f.maxPrice && f.maxPrice > 0 && doorPrice(t) > f.maxPrice) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------
// The query: checked, and written into a URL and back.

const IATA = /^[A-Z]{3}$/;
const ISO2 = /^[A-Z]{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A place name or label: letters in any script, digits, spaces and a little punctuation. */
const TEXT = /^[\p{L}\p{N} ,.'()&/-]{1,80}$/u;
const SHAPES = ["any", "return", "two", "loop", "long"] as const;
const MAX_MEMBERS = 8;

type Parsed = { query: SearchQuery } | { error: string };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" && TEXT.test(v.trim()) ? v.trim() : null);

/**
 * Any value to a SearchQuery, or the first thing wrong with it in plain words. Checks shapes,
 * codes, real dates and bounds; whether a date is in the past is the server's question (it
 * depends on the day), not this one's. Prefs are passed through as an object for the server to
 * clean (lib/prefs.ts cleanPrefs).
 */
export function parseSearchQuery(raw: unknown): Parsed {
  const q = obj(raw);
  if (!q) return { error: "the search must be a JSON object" };
  const f = obj(q.from);
  if (!f) return { error: "from is needed: { label, lat, lon, airports, home }" };
  const label = text(f.label);
  const lat = num(f.lat);
  const lon = num(f.lon);
  if (!label) return { error: "from.label must be a short place name" };
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: "from.lat and from.lon must be a point on Earth" };
  const airports = Array.isArray(f.airports) ? uniq(f.airports.map((a) => String(a ?? "").trim().toUpperCase()).filter((a) => IATA.test(a))).slice(0, 5) : [];
  if (!airports.length) return { error: "from.airports must list one to five airport codes, such as GHV, OTP" };
  const home = String(f.home ?? "").trim().toUpperCase();
  if (!ISO2.test(home)) return { error: "from.home must be a two-letter country code, such as RO" };

  const t = obj(q.to) ?? { kind: "anywhere" };
  let to: SearchQuery["to"];
  if (t.kind === "anywhere") to = { kind: "anywhere" };
  else if (t.kind === "place") {
    const name = text(t.name);
    if (!name) return { error: "to.name must be a city, town or airport" };
    // The code of the city or airport picked, so two places of one name (Cordoba in Spain and in Argentina) stay apart.
    const code = typeof t.code === "string" && IATA.test(t.code.trim().toUpperCase()) ? t.code.trim().toUpperCase() : undefined;
    to = { kind: "place", name, ...(code ? { code } : {}) };
  } else if (t.kind === "country") {
    const name = text(t.name);
    if (!name) return { error: "to.name must be a country" };
    const code = typeof t.code === "string" && ISO2.test(t.code.trim().toUpperCase()) ? t.code.trim().toUpperCase() : undefined;
    to = { kind: "country", name, ...(code ? { code } : {}) };
  } else if (t.kind === "region") {
    // A region key (sea, balkans), or a few countries together: "countries:pe,bo" (Peru and Bolivia).
    const key = typeof t.key === "string" && /^(?:[a-z][a-z -]{1,30}|countries:[a-z]{2}(?:,[a-z]{2}){1,11})$/.test(t.key.trim().toLowerCase()) ? t.key.trim().toLowerCase() : null;
    if (!key) return { error: "to.key must be a region key, such as sea or balkans, or countries:pe,bo" };
    to = { kind: "region", key };
  } else return { error: "to.kind must be anywhere, place, country or region" };

  const w = obj(q.when) ?? { kind: "anytime" };
  let when: SearchQuery["when"];
  if (w.kind === "dates") {
    if (!isDay(w.out)) return { error: "when.out must be a real date, YYYY-MM-DD" };
    if (w.back != null && w.back !== "" && !isDay(w.back)) return { error: "when.back must be a real date, YYYY-MM-DD" };
    const back = isDay(w.back) ? w.back : undefined;
    if (back && back < w.out) return { error: "when.back must not be before when.out" };
    if (back && daysBetween(w.out, back) > 200) return { error: "when.out and when.back may be at most 200 days apart" };
    when = { kind: "dates", out: w.out, ...(back ? { back } : {}) };
  } else if (w.kind === "window") {
    if (!isDay(w.from) || !isDay(w.to)) return { error: "when.from and when.to must be real dates, YYYY-MM-DD" };
    if (w.to < w.from) return { error: "when.to must not be before when.from" };
    if (daysBetween(w.from, w.to) > 366) return { error: "the window must be a year or less" };
    const include = w.include != null && w.include !== "" ? w.include : undefined;
    if (include !== undefined && (!isDay(include) || include < w.from || include > w.to)) return { error: "when.include must be a date between when.from and when.to" };
    when = { kind: "window", from: w.from, to: w.to, ...(include ? { include } : {}) };
  } else if (w.kind === "month") {
    if (typeof w.month !== "string" || !MONTH.test(w.month)) return { error: "when.month must be YYYY-MM" };
    when = { kind: "month", month: w.month };
  } else if (w.kind === "anytime") when = { kind: "anytime" };
  else return { error: "when.kind must be dates, window, month or anytime" };

  const query: SearchQuery = { from: { label, lat, lon, airports, home }, to, when };
  if (q.nights != null) {
    const n = Array.isArray(q.nights) ? q.nights.map(num) : [];
    if (n.length !== 2 || n[0] == null || n[1] == null) return { error: "nights must be [least, most]" };
    const lo = Math.round(Math.min(n[0], n[1]));
    const hi = Math.round(Math.max(n[0], n[1]));
    if (lo < 1 || hi > 90) return { error: "nights must be between 1 and 90" };
    query.nights = [lo, hi];
  }
  if (q.oneWay === true) query.oneWay = true;
  if (q.shape != null) {
    if (!(SHAPES as readonly unknown[]).includes(q.shape)) return { error: `shape must be one of ${SHAPES.join(", ")}` };
    query.shape = q.shape as SearchQuery["shape"];
  }
  if (q.must != null) {
    const list = Array.isArray(q.must) ? q.must.map((x) => text(x)).filter((x): x is string => !!x && x.length <= 60) : [];
    if (!list.length || list.length > 3) return { error: "must is one to three place names" };
    query.must = [...new Set(list)];
  }
  const adv = obj(q.advanced);
  if (adv) {
    const a: NonNullable<SearchQuery["advanced"]> = {};
    const wild = obj(adv.wild);
    if (wild) {
      const region = typeof wild.region === "string" ? wild.region.trim().toLowerCase() : "";
      const nights = num(wild.nights);
      if (!/^[a-z][a-z-]{1,30}$/.test(region)) return { error: "advanced.wild.region must be a region key, such as sea" };
      if (nights == null || nights < 5 || nights > 90) return { error: "advanced.wild.nights must be 5 to 90" };
      a.wild = { region, nights: Math.round(nights) };
    }
    const ls = obj(adv.longStay);
    if (ls) {
      const months = num(ls.months);
      if (months == null || months < 1 || months > 6) return { error: "advanced.longStay.months must be 1 to 6" };
      a.longStay = { months: Math.round(months) };
    }
    const g = obj(adv.group);
    if (g) {
      const members = Array.isArray(g.members) ? g.members : [];
      if (members.length < 2 || members.length > MAX_MEMBERS) return { error: `advanced.group.members must list 2 to ${MAX_MEMBERS} people` };
      const out: NonNullable<NonNullable<SearchQuery["advanced"]>["group"]>["members"] = [];
      for (const [i, raw] of members.entries()) {
        const m = obj(raw);
        const name = m ? text(m.name) : null;
        const origins = m && Array.isArray(m.origins) ? uniq(m.origins.map((x) => String(x ?? "").trim().toUpperCase()).filter((x) => IATA.test(x))).slice(0, 3) : [];
        const available = m && Array.isArray(m.available) ? m.available.map(obj).filter((x): x is Record<string, unknown> => !!x && isDay(x.from) && isDay(x.to) && String(x.to) >= String(x.from)).map((x) => ({ from: String(x.from), to: String(x.to) })).slice(0, 6) : [];
        if (!name) return { error: `member ${i + 1} needs a short name` };
        if (!origins.length) return { error: `${name} needs one to three airport codes` };
        if (!available.length) return { error: `${name} needs at least one free window, from and to as YYYY-MM-DD` };
        out.push({ name, origins, available });
      }
      a.group = { members: out };
    }
    if (Object.keys(a).length) query.advanced = a;
  }
  const fl = obj(q.filters);
  if (fl) {
    const filters: NonNullable<SearchQuery["filters"]> = {};
    for (const k of ["direct", "trainsOk", "eventsOn", "newCountries"] as const) if (typeof fl[k] === "boolean") filters[k] = fl[k] as boolean;
    const h = num(fl.maxLegHours);
    if (h != null && h > 0) filters.maxLegHours = Math.min(48, Math.ceil(h));
    const c = num(fl.cities);
    if (c === 1 || c === 2 || c === 3) filters.cities = c;
    const p = num(fl.maxPrice);
    if (p != null && p > 0) filters.maxPrice = Math.round(p);
    if (Object.keys(filters).length) query.filters = filters;
  }
  if (obj(q.prefs)) query.prefs = q.prefs as Prefs;
  if (Array.isArray(q.exclude)) {
    const ex = uniq(q.exclude.map((x) => String(x ?? "").trim().toUpperCase()).filter((x) => ISO2.test(x))).slice(0, 250);
    if (ex.length) query.exclude = ex;
  }
  if (q.engine != null) {
    if (q.engine !== "one" && q.engine !== "classic") return { error: "engine must be one or classic" };
    query.engine = q.engine;
  }
  if (q.budget != null) {
    const b = num(q.budget);
    if (b == null || b < 0 || b > 60) return { error: "budget must be 0 to 60 searches" };
    query.budget = Math.round(b);
  }
  return { query };
}

/**
 * The query as URL parameters, readable and short enough to share: from, at, ap, home, to,
 * when, nights, oneway, shape, plus adv and f (JSON) for the drawer and the chips. The trip
 * style and the been list stay in the browser that holds them, so they are left out.
 */
export function searchQueryToParams(q: SearchQuery): string {
  const p = new URLSearchParams();
  p.set("from", q.from.label);
  p.set("at", `${Math.round(q.from.lat * 1000) / 1000},${Math.round(q.from.lon * 1000) / 1000}`);
  p.set("ap", q.from.airports.join(","));
  p.set("home", q.from.home);
  const t = q.to;
  p.set("to", t.kind === "anywhere" ? "anywhere" : t.kind === "place" ? `place:${t.name}${t.code ? `:${t.code}` : ""}` : t.kind === "country" ? `country:${t.name}${t.code ? `:${t.code}` : ""}` : `region:${t.key}`);
  const w = q.when;
  p.set("when", w.kind === "dates" ? `dates:${w.out}${w.back ? `..${w.back}` : ""}` : w.kind === "window" ? `window:${w.from}..${w.to}${w.include ? `@${w.include}` : ""}` : w.kind === "month" ? `month:${w.month}` : "anytime");
  if (q.nights) p.set("nights", `${q.nights[0]}-${q.nights[1]}`);
  if (q.oneWay) p.set("oneway", "1");
  if (q.shape && q.shape !== "any") p.set("shape", q.shape);
  if (q.must?.length) p.set("must", q.must.join("|"));
  if (q.advanced && Object.keys(q.advanced).length) p.set("adv", JSON.stringify(q.advanced));
  if (q.filters && Object.keys(q.filters).length) p.set("f", JSON.stringify(q.filters));
  if (q.budget != null) p.set("b", String(q.budget));
  return p.toString();
}

/** A query back from the URL: the readable form above, or q=<the JSON> as /api/search takes it. Null when it does not read. */
export function searchQueryFromParams(s: string): SearchQuery | null {
  try {
    const p = new URLSearchParams(s.startsWith("?") ? s.slice(1) : s);
    const json = p.get("q");
    if (json) {
      const r = parseSearchQuery(JSON.parse(json));
      return "query" in r ? r.query : null;
    }
    if (!p.get("from") || !p.get("at")) return null;
    const [lat, lon] = (p.get("at") ?? "").split(",").map(Number);
    const raw: Record<string, unknown> = { from: { label: p.get("from"), lat, lon, airports: (p.get("ap") ?? "").split(","), home: p.get("home") ?? "" } };
    const to = p.get("to") ?? "anywhere";
    if (to === "anywhere") raw.to = { kind: "anywhere" };
    else if (to.startsWith("place:")) {
      const m = /^(.*):([A-Z]{3})$/.exec(to.slice(6));
      raw.to = m ? { kind: "place", name: m[1], code: m[2] } : { kind: "place", name: to.slice(6) };
    }
    else if (to.startsWith("country:")) {
      const [name, code] = to.slice(8).split(":");
      raw.to = { kind: "country", name, ...(code ? { code } : {}) };
    } else if (to.startsWith("region:")) raw.to = { kind: "region", key: to.slice(7) };
    const when = p.get("when") ?? "anytime";
    let m: RegExpExecArray | null;
    if ((m = /^dates:(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?$/.exec(when))) raw.when = { kind: "dates", out: m[1], ...(m[2] ? { back: m[2] } : {}) };
    else if ((m = /^window:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})(?:@(\d{4}-\d{2}-\d{2}))?$/.exec(when))) raw.when = { kind: "window", from: m[1], to: m[2], ...(m[3] ? { include: m[3] } : {}) };
    else if ((m = /^month:(\d{4}-\d{2})$/.exec(when))) raw.when = { kind: "month", month: m[1] };
    else raw.when = { kind: "anytime" };
    const nights = /^(\d{1,2})-(\d{1,2})$/.exec(p.get("nights") ?? "");
    if (nights) raw.nights = [Number(nights[1]), Number(nights[2])];
    if (p.get("oneway") === "1") raw.oneWay = true;
    if (p.get("shape")) raw.shape = p.get("shape");
    if (p.get("must")) raw.must = p.get("must")!.split("|");
    if (p.get("adv")) raw.advanced = JSON.parse(p.get("adv")!);
    if (p.get("f")) raw.filters = JSON.parse(p.get("f")!);
    if (p.get("b")) raw.budget = Number(p.get("b"));
    const r = parseSearchQuery(raw);
    return "query" in r ? r.query : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Any trip becomes an itinerary skeleton (lib/itinerary.ts), for "Make it a plan".

/**
 * The trip as a Skeleton: its stops with their dates, its legs with prices, links and estimates.
 * The traveller's door (HOME in the walk's and the graph's legs) is `origin` when given, else the
 * first leg's start. A place without coordinates keeps lat 0, lon 0 and its code; the server
 * places it (normaliseSkeleton).
 */
export function skeletonFromTrip(t: TripResult, origin?: ItinPlace): Skeleton {
  const stopByCode = new Map<string, ItinPlace>();
  for (const s of t.stops) if (s.code) stopByCode.set(s.code, { name: s.name, code: s.code, country: s.country, lat: s.lat, lon: s.lon, ...(s.img ? { img: s.img } : {}) });
  const first = t.legs[0];
  const home: ItinPlace = origin ?? { name: first?.fromName ?? "home", ...(first && first.from !== HOME_CODE ? { code: first.from } : {}), lat: first?.fromLat ?? 0, lon: first?.fromLon ?? 0 };
  const place = (code: string, name: string, lat?: number, lon?: number): ItinPlace => {
    if (code === HOME_CODE) return home;
    const hit = stopByCode.get(code);
    if (hit) return hit;
    return { name: name || code, ...(code ? { code } : {}), lat: lat ?? 0, lon: lon ?? 0 };
  };
  const legs: ItinLeg[] = t.legs.map((l) => ({
    kind: l.kind,
    from: place(l.from, l.fromName, l.fromLat, l.fromLon),
    to: place(l.to, l.toName, l.toLat, l.toLon),
    ...(l.date ? { date: l.date } : {}),
    ...(l.depart ? { depart: l.depart } : {}),
    ...(l.arrive ? { arrive: l.arrive } : {}),
    ...(l.minutes != null ? { minutes: l.minutes } : {}),
    price: l.price ?? null,
    ...(l.estimated ? { estimated: true } : {}),
    ...(l.carrier ? { carrier: l.carrier } : {}),
    ...(l.url ? { url: l.url } : {}),
    ...(l.note ? { note: l.note } : {}),
  }));
  const stops: ItinStop[] = t.stops.map((s, i) => ({ name: s.name, ...(s.code ? { code: s.code } : {}), country: s.country, lat: s.lat, lon: s.lon, ...(s.img ? { img: s.img } : {}), arrive: s.arrive, leave: s.leave, nights: s.nights, ...(i === 0 && t.why[0] ? { why: t.why[0].slice(0, 200) } : {}) }));
  const dates = [...stops.flatMap((s) => [s.arrive, s.leave]), ...legs.map((l) => dayOf(l.date))].filter(isDay).sort();
  const source: Skeleton["source"] = t.kind === "long-stay" ? "longstay" : t.kind === "group" ? "group" : t.engine.startsWith("wild") ? "wild" : t.stops.length > 1 ? "loop" : t.engine === "route" ? "route" : "deal";
  const nightsLine = `${t.nights} night${t.nights === 1 ? "" : "s"}`;
  return {
    title: t.title,
    subtitle: `${nightsLine}, ${t.price} euros in tickets${t.groundPrice ? ` and about ${t.groundPrice} on the ground` : ""}${origin ? ` from ${origin.name}` : ""}`,
    origin: home,
    start: dates[0] ?? t.out,
    end: dates[dates.length - 1] ?? t.back ?? t.out,
    nights: t.nights,
    stops,
    legs,
    ...(t.kind === "group" ? { travellers: Math.max(1, t.legs.filter((l) => l.kind === "fly" && l.price != null).length) } : {}),
    source,
  };
}
