"use client";

import { useEffect, useMemo, useState } from "react";
import type { SearchQuery, TripLeg, TripResult, TripStop } from "@/lib/trip-result";
import type { Hotel, HotelsResult } from "@/lib/liteapi";
import type { Sight, Sights } from "@/lib/sights";
import type { EatsResponse } from "@/app/api/eats/route";
import type { EventItem, EventsResponse } from "@/app/api/events/route";
import { eventsAt, type PlaceEvent } from "@/lib/purpose-events";
import { addDays, countryName, dateRange, euro, kiwiPhoto, shortDate, todayIso, weekday } from "@/lib/format";
import { formatDuration } from "@/lib/geo";
import type { PlaceSummary } from "@/app/api/place/route";
import WaysHome, { getJson, hhmm, useNearView, type WayHomeChoice } from "./WaysHome";
import s from "./TripPage.module.css";

// One trip page for every result the search returns, whatever engine found it: a return, two
// cities, a loop, a long stay, a group trip. It reads only the shared TripResult shape
// (lib/trip-result.ts), so a card from the list, the chat or a shared link opens the same page.
// Top to bottom, in the order a traveller decides: what it is and what it costs (the hero and
// the route strip), what to buy (the tickets, one booking link each), how to come home (Ways
// home, which can swap the way home in this view and reprice the total), what is on while
// there, and where to sleep, see and eat per place. "Make it a plan" hands the trip to the
// shell, which opens the itinerary (with its own save and share).

type Props = {
  trip: TripResult;
  query?: SearchQuery;
  onBack: () => void;
  onFocus?: (p: { lat: number; lon: number; zoom?: number }) => void;
  onItinerary: (t: TripResult) => void;
};

const KIND_LABEL: Record<TripResult["kind"], string> = {
  return: "There and back",
  oneway: "One way",
  "two-city": "Two cities",
  loop: "A loop",
  "long-stay": "Long stay",
  group: "Group trip",
};
const SOURCE_LABEL: Record<TripResult["source"], string> = {
  live: "Live prices, checked just now",
  graph: "From the nightly price map; book to see today's price",
  memory: "Prices seen recently; they may have moved",
  boards: "From the stored deal boards; they may have moved",
  estimate: "Estimated prices",
};
const MODE_WORD: Record<TripLeg["kind"], string> = { fly: "Flight", train: "Train", coach: "Coach", ferry: "Ferry", road: "By road", walk: "Walk" };
const COUNT_WORD = ["No", "One", "Two", "Three", "Four", "Five", "Six"];

const ICON: Record<TripLeg["kind"], string> = {
  fly: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z",
  train: "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM11 10H6V6h5zm2 0V6h5v4zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  coach: "M4 16a2 2 0 0 0 1 1.73V19a1 1 0 0 0 2 0v-1h10v1a1 1 0 0 0 2 0v-1.27A2 2 0 0 0 20 16V6a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3zm3-10h10a1 1 0 0 1 1 1v4H6V7a1 1 0 0 1 1-1zm0 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm10 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  ferry: "M20 21c-1.4 0-2.8-.5-4-1.3a7 7 0 0 1-8 0C6.8 20.5 5.4 21 4 21H2v2h2c1.4 0 2.7-.3 4-1a8.7 8.7 0 0 0 8 0c1.3.7 2.6 1 4 1h2v-2zM3.9 19H4c1.6 0 3-.9 4-2 1 1.1 2.4 2 4 2s3-.9 4-2c1 1.1 2.4 2 4 2h.1l1.9-6.7a1 1 0 0 0-.7-1.2L20 10.6V6a2 2 0 0 0-2-2h-3V1H9v3H6a2 2 0 0 0-2 2v4.6l-1.3.4a1 1 0 0 0-.7 1.3zM6 6h12v4l-6-2-6 2z",
  road: "M18.9 6c-.2-.6-.8-1-1.4-1h-11c-.7 0-1.2.4-1.4 1L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11z",
  walk: "M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2 2 0 0 0-1.7-1c-.3 0-.5.1-.8.1L6 8.3V13h2V9.6z",
};
function ModeIcon({ kind, size = 14 }: { kind: TripLeg["kind"]; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={ICON[kind] ?? ICON.road} />
    </svg>
  );
}

/**
 * A city's photo. The Wikivoyage lead image of a big city is often its district map (Warsaw,
 * Lisbon), which reads as a broken picture on a hero, so a map-like file name is skipped and the
 * first photo of the guide's own listings (/api/sights) is used instead; a Kiwi image id, when
 * the engine sends one, beats both. The hero asks for a larger thumbnail and falls back to the
 * small one when Wikimedia has no such size.
 */
const MAPLIKE = /map|district|region|freguesia|locator|\.svg|\.png/i;
function photoFor(name: string): Promise<string | null> {
  return getJson<PlaceSummary | null>(`/api/place?name=${encodeURIComponent(name)}`)
    .catch(() => null)
    .then((p) => {
      const thumb = p?.thumbnail;
      if (thumb && !MAPLIKE.test(decodeURIComponent(thumb.split("?")[0].split("/").pop() ?? ""))) return thumb;
      return getJson<Sights | null>(`/api/sights?name=${encodeURIComponent(name)}`)
        .catch(() => null)
        .then((sg) => [...(sg?.see ?? []), ...(sg?.do ?? [])].find((x) => x.image)?.image ?? null);
    });
}
function bigger(url: string): string {
  return url.replace(/\/330px-/, "/960px-").replace(/([?&])width=\d+/, "$1width=960");
}
/**
 * The large and small photo for a stop's own image: the converters send a full URL (Kiwi's
 * 600x600 one), older rows a bare Kiwi id. Kiwi's wide size suits the hero; its square one is
 * the fallback every id has. Another full URL is used as given.
 */
function ownPhoto(img: string | undefined, big?: boolean): { src: string; small: string } | null {
  if (!img) return null;
  if (/^https?:\/\//.test(img)) {
    const large = !big ? img : img.includes("images.kiwi.com/photos/") ? img.replace(/\/photos\/\d+x\d+\//, "/photos/1280x720/") : bigger(img);
    return { src: large, small: img };
  }
  const small = kiwiPhoto(img, "600x600");
  return small ? { src: big ? (kiwiPhoto(img, "1280x720") ?? small) : small, small } : null;
}
function CityPhoto({ stop, big, className }: { stop: TripStop; big?: boolean; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [small, setSmall] = useState<string | null>(null);
  // Set when the stop's own image failed in both sizes: the guide's photo is tried instead.
  const [ownFailed, setOwnFailed] = useState<string | null>(null);
  const ownKey = `${stop.name}|${stop.img ?? ""}`;
  const own = ownFailed === ownKey ? null : ownPhoto(stop.img, big);
  useEffect(() => {
    let live = true;
    if (own) {
      setSrc(own.src);
      setSmall(own.small);
      return;
    }
    setSrc(null);
    setSmall(null);
    photoFor(stop.name).then((u) => {
      if (!live || !u) return;
      setSmall(u);
      setSrc(big ? bigger(u) : u);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop.name, own?.src, own?.small, big]);
  const onError = () => {
    if (small && src !== small) setSrc(small);
    else if (own) setOwnFailed(ownKey);
    else setSrc(null);
  };
  return (
    <div className={`${s.photo}${className ? ` ${className}` : ""}`}>
      {src && <img src={src} alt="" loading="lazy" onError={onError} />}
    </div>
  );
}

/** Lower case, no accents: "Gdańsk" and "gdansk" are one place. */
function fold(x: string | undefined): string {
  return (x ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
const day10 = (x: string | undefined) => (x ?? "").slice(0, 10);
const stopMatches = (st: TripStop, code: string | undefined, name: string | undefined) => (!!st.code && !!code && st.code === code) || (!!name && fold(st.name) === fold(name));

/** A leg's time line: "Tue 3 Nov · 06:10 to 08:40 · 2h 30". */
function legWhen(l: TripLeg): string {
  const d = day10(l.date ?? l.depart);
  const parts: string[] = [];
  if (d) parts.push(`${weekday(d)} ${shortDate(d)}`);
  const dep = hhmm(l.depart);
  const arr = hhmm(l.arrive);
  if (dep) parts.push(arr ? `${dep} to ${arr}` : dep);
  // Non-breaking spaces keep "2h 10" and "06:10 to 07:20" on one line on a narrow phone.
  if (l.minutes) parts.push(formatDuration(Math.round(l.minutes)).replace(/ /g, "\u00a0"));
  return parts.map((p) => p.replace(/ to /g, "\u00a0to\u00a0")).join(" · ");
}

/** A leg's departure as epoch ms, when the day and the time are both known; for spotting tight self-transfers. */
function legTime(l: TripLeg, which: "depart" | "arrive"): number | null {
  const t = l[which];
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return Date.parse(t.slice(0, 16) + ":00Z");
  const d = day10(l.date);
  const h = hhmm(t);
  if (!d || !h) return null;
  let ms = Date.parse(`${d}T${h}:00Z`);
  // An arrival time earlier than the departure is the next day.
  if (which === "arrive" && l.depart) {
    const dep = legTime(l, "depart");
    if (dep != null && ms < dep) ms += 86_400_000;
  }
  return ms;
}

type Ticket = { url: string | null; legs: number[]; price: number | null; estimated: boolean; ground: boolean };

/**
 * The tickets to buy: legs sharing a booking link are one ticket (a return on one ticket has
 * its way out and its way home under one link, not side by side); a leg with no link is a
 * ticket of its own, bought on the day (a train, a coach, a drive).
 */
function ticketsOf(legs: TripLeg[]): Ticket[] {
  const byUrl = new Map<string, Ticket>();
  const out: Ticket[] = [];
  legs.forEach((l, i) => {
    const ground = l.kind !== "fly";
    if (l.url) {
      const t = byUrl.get(l.url);
      if (t) {
        t.legs.push(i);
        if (l.price != null) t.price = (t.price ?? 0) + l.price;
        t.ground &&= ground;
        return;
      }
      const nt: Ticket = { url: l.url, legs: [i], price: l.price ?? null, estimated: !!l.estimated, ground };
      byUrl.set(l.url, nt);
      out.push(nt);
    } else out.push({ url: null, legs: [i], price: l.price ?? null, estimated: !!l.estimated || l.price == null, ground });
  });
  return out;
}

/** The stops the page knows each leg arrives at, so the route strip can put a photo after the leg. */
function routeItems(stops: TripStop[], legs: TripLeg[], originLabel: string) {
  type Item = { kind: "end"; label: string } | { kind: "leg"; leg: TripLeg } | { kind: "stop"; stop: TripStop; i: number };
  const items: Item[] = [{ kind: "end", label: originLabel }];
  const placed = new Set<number>();
  for (const leg of legs) {
    items.push({ kind: "leg", leg });
    const i = stops.findIndex((st, k) => !placed.has(k) && stopMatches(st, leg.to, leg.toName));
    if (i >= 0) {
      placed.add(i);
      items.push({ kind: "stop", stop: stops[i], i });
    }
  }
  // Stops the legs never name (a trip from the graph may carry no ground legs) still show, in order.
  stops.forEach((st, i) => !placed.has(i) && items.push({ kind: "stop", stop: st, i }));
  const last = legs[legs.length - 1];
  if (last && !stops.some((st) => stopMatches(st, last.to, last.toName))) items.push({ kind: "end", label: last.toName || last.to });
  return items;
}

/**
 * The chosen way home lives in sessionStorage by trip id: the page unmounts while the plan is
 * in front, and coming back must not lose the choice. Storage can be missing or blocked (a
 * private window), so every access is guarded and the page works without it.
 */
const CHOICE_KEY = "atlas-wayhome-choice-v1:";
function loadChoice(id: string): WayHomeChoice | null {
  try {
    const raw = sessionStorage.getItem(CHOICE_KEY + id);
    const c = raw ? (JSON.parse(raw) as WayHomeChoice) : null;
    return c && typeof c.date === "string" && typeof c.flight?.price === "number" && typeof c.flight.url === "string" ? c : null;
  } catch {
    return null;
  }
}
function saveChoice(id: string, c: WayHomeChoice | null): void {
  try {
    if (c) sessionStorage.setItem(CHOICE_KEY + id, JSON.stringify(c));
    else sessionStorage.removeItem(CHOICE_KEY + id);
  } catch {
    // Storage blocked: the choice just lasts while the page is open.
  }
}

/**
 * Stops rebuilt from a compact chat row arrive with lat and lon 0. They are placed again from
 * the public city list, by code (a city or one of its airports) or by name, so the globe, the
 * hotels and the events look in the right place. The list is fetched only when needed.
 */
type CityRow = { name: string; country: string; lat: number; lon: number; airports?: string[] };
function useStopsPlaced(stops: TripStop[]): TripStop[] {
  const missing = stops.some((st) => st.lat === 0 && st.lon === 0);
  const [cities, setCities] = useState<Record<string, CityRow> | null>(null);
  useEffect(() => {
    if (missing && !cities) getJson<Record<string, CityRow>>("/data/cities.json").then(setCities, () => undefined);
  }, [missing, cities]);
  return useMemo(() => {
    if (!missing || !cities) return stops;
    const rows = Object.entries(cities);
    return stops.map((st) => {
      if (st.lat !== 0 || st.lon !== 0) return st;
      const hit = (st.code && (cities[st.code] ?? rows.find(([, c]) => c.airports?.includes(st.code!))?.[1])) || rows.find(([, c]) => fold(c.name) === fold(st.name))?.[1];
      return hit ? { ...st, lat: hit.lat, lon: hit.lon, country: st.country || hit.country } : st;
    });
  }, [stops, cities, missing]);
}

export default function TripPage({ trip: given, query, onBack, onFocus, onItinerary }: Props) {
  const placedStops = useStopsPlaced(given.stops);
  const trip = useMemo(() => (placedStops === given.stops ? given : { ...given, stops: placedStops }), [given, placedStops]);
  const [chosen, setChosenState] = useState<WayHomeChoice | null>(null);
  const [stopIdx, setStopIdx] = useState(0);
  // A new trip on the same page starts clean, or with the way home chosen for it earlier.
  useEffect(() => {
    setChosenState(loadChoice(trip.id));
    setStopIdx(0);
  }, [trip.id]);
  const setChosen = (c: WayHomeChoice | null) => {
    setChosenState(c);
    saveChoice(trip.id, c);
  };

  const lastStop = trip.stops[trip.stops.length - 1];
  const legs = trip.legs ?? [];

  // The way home as the trip has it: every leg after the one that reaches the last stop. A
  // one-way trip has none, so a chosen flight home is simply added.
  const homeStart = useMemo(() => {
    if (trip.kind === "oneway" || !lastStop) return legs.length;
    let idx = -1;
    legs.forEach((l, i) => stopMatches(lastStop, l.to, l.toName) && (idx = i));
    return idx >= 0 ? idx + 1 : legs.length;
  }, [legs, lastStop, trip.kind]);
  const homeLegs = legs.slice(homeStart);
  const homeFlights = homeLegs.filter((l) => l.kind === "fly");
  // How the way home is paid for decides what a swap costs:
  // - "own": its own price (and no link shared with the way out); swapping it takes that price off.
  // - "unpriced": a ticket of its own, but priced together with the way out (paired one-ways);
  //   its share is not known, so the new total is only known as an upper bound.
  // - "return": on the same ticket as the way out; keeping that ticket and skipping its way
  //   home is the upper bound, and a one way out may cost less or more.
  // - "none": no flight home on the trip (a one way): the chosen flight is simply added.
  const outUrls = new Set(legs.slice(0, homeStart).map((l) => l.url).filter(Boolean));
  const homeMode: "own" | "unpriced" | "return" | "none" = !homeFlights.length
    ? "none"
    : homeFlights.some((l) => l.url && outUrls.has(l.url))
      ? "return"
      : homeFlights.every((l) => l.price != null)
        ? "own"
        : "unpriced";
  const currentHomePrice = homeMode === "own" ? homeFlights.reduce((a, l) => a + (l.price ?? 0), 0) : homeMode === "none" ? 0 : null;
  const currentHomeDay = homeFlights[0] ? day10(homeFlights[0].date ?? homeFlights[0].depart) : undefined;

  // The legs on show: the trip's own, or its way out with the chosen flight home (and the ground leg after it).
  const shownLegs = useMemo<TripLeg[]>(() => {
    if (!chosen || !lastStop) return legs;
    const f = chosen.flight;
    const fly: TripLeg = {
      kind: "fly",
      from: f.from ?? lastStop.code ?? lastStop.name,
      fromName: lastStop.name,
      to: f.to,
      toName: f.toName ?? chosen.ground?.name ?? f.to,
      date: chosen.date,
      depart: f.depart,
      arrive: f.arrive,
      price: f.price,
      carrier: f.carrier,
      stops: f.direct ? 0 : (f.stops ?? 1),
      url: f.url,
      note: "your chosen way home",
    };
    const flyMinutes = f.minutes ?? (f.hours ? f.hours * 60 : undefined);
    if (flyMinutes) fly.minutes = Math.round(flyMinutes);
    const ground: TripLeg[] =
      chosen.ground && chosen.ground.minutes > 0
        ? [{ kind: "road", from: f.to, fromName: f.toName ?? chosen.ground.name ?? f.to, to: "home", toName: query?.from.label ?? "home", minutes: chosen.ground.minutes, price: chosen.ground.price || null, estimated: true, note: "train, coach or drive to your door" }]
        : [];
    return [...legs.slice(0, homeStart), fly, ...ground];
  }, [chosen, legs, homeStart, lastStop, query?.from.label]);

  // The total: flights and tickets as the trip has them, or with the chosen way home swapped in.
  // When the old way home's share of the price is not known, the honest figure is the most it
  // can cost: the ticket out as priced (old way home included) plus the new flight.
  const totalIsUpper = !!chosen && currentHomePrice == null;
  const total = !chosen ? trip.price : currentHomePrice != null ? trip.price - currentHomePrice + chosen.flight.price : trip.price + chosen.flight.price;
  // The ticket out that carries the old way home's price, shown as "up to" once it is swapped.
  const outLegs = legs.slice(0, homeStart);
  const bundledIdx = totalIsUpper ? outLegs.findIndex((l) => l.kind === "fly" && l.price != null && (homeMode === "unpriced" || homeFlights.some((h) => h.url === l.url))) : -1;
  // The ground estimate: the trip's own, with the old way home's ground legs taken out and the
  // new one put in, so the figure matches the legs on show.
  const sumPrice = (ls: TripLeg[]) => ls.reduce((a, l) => a + (l.kind !== "fly" && l.price != null ? l.price : 0), 0);
  const newGround = chosen?.ground && chosen.ground.minutes > 0 ? chosen.ground.price || 0 : 0;
  const groundExtra = chosen ? Math.max(0, (trip.groundPrice ?? 0) - sumPrice(homeLegs)) + newGround : (trip.groundPrice ?? 0);
  // Hours travelling, with the old way home's minutes swapped for the new one's.
  const sumMin = (ls: TripLeg[]) => ls.reduce((a, l) => a + (l.minutes ?? 0), 0);
  const shownHours = chosen && trip.hours != null ? Math.max(0, trip.hours + (sumMin(shownLegs.slice(homeStart)) - sumMin(homeLegs)) / 60) : trip.hours;
  // A chosen day moves the end of the trip, and with it the nights.
  const shownBack = chosen?.date ?? trip.back;
  const origEnd = day10(trip.back ?? lastStop?.leave);
  // The stops as the traveller now has them: the last one ends on the chosen day, so the hotels,
  // the events and the plan all use the right nights.
  const shownStops = useMemo(() => (chosen ? endStopsOn(trip.stops, chosen.date) : trip.stops), [chosen, trip.stops]);
  const shownNights = chosen && origEnd ? Math.max(0, trip.nights + Math.round((Date.parse(chosen.date) - Date.parse(origEnd)) / 86_400_000)) : trip.nights;

  const tickets = useMemo(() => ticketsOf(shownLegs), [shownLegs]);
  const bookable = tickets.filter((t) => t.url);
  const flightTickets = tickets.filter((t) => t.url && !t.ground);

  // Separate tickets with too little time between them: the next one will not wait.
  const tight = useMemo(() => {
    const out = new Set<number>();
    for (let i = 1; i < shownLegs.length; i++) {
      const a = shownLegs[i - 1];
      const b = shownLegs[i];
      if (!a.url || !b.url || a.url === b.url) continue;
      const arr = legTime(a, "arrive");
      const dep = legTime(b, "depart");
      if (arr != null && dep != null && dep - arr < 3 * 3_600_000) out.add(i);
    }
    return out;
  }, [shownLegs]);

  // Separate tickets changed on the same day: only then is a missed connection a real risk.
  // A flight out on the 5th and home on the 10th, or a group's own tickets, never connect.
  const sameDayChange = useMemo(
    () => shownLegs.some((b, i) => i > 0 && !!b.url && !!shownLegs[i - 1].url && b.url !== shownLegs[i - 1].url && !!day10(b.date) && day10(b.date) === day10(shownLegs[i - 1].date)),
    [shownLegs],
  );
  const showRisk = trip.kind !== "group" && flightTickets.length > 1 && (tight.size > 0 || sameDayChange);

  const originLabel = query?.from.label ?? legs[0]?.fromName ?? "Home";
  const items = useMemo(() => routeItems(shownStops, shownLegs, originLabel), [shownStops, shownLegs, originLabel]);
  const cover = trip.stops[0];
  const end = trip.back ?? lastStop?.leave ?? trip.out;
  const focusStop = (i: number) => {
    const st = trip.stops[i];
    if (!st) return;
    setStopIdx(i);
    // A stop that could not be placed (lat and lon 0) does not send the globe to the ocean.
    if (st.lat !== 0 || st.lon !== 0) onFocus?.({ lat: st.lat, lon: st.lon, zoom: 9 });
  };

  return (
    <article className={s.root} aria-label={`Trip: ${trip.title}`}>
      <div className={s.topBar}>
        <button className={s.back} onClick={onBack} aria-label="Back to the results">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" />
          </svg>
          <span>Results</span>
        </button>
        <span className={s.topTitle}>{trip.title}</span>
      </div>

      {/* ---------- hero ---------- */}
      <header className={s.hero}>
        {cover && <CityPhoto stop={cover} big className={s.cover} />}
        <div className={s.heroShade} />
        <div className={s.heroText}>
          <span className={s.kicker}>{KIND_LABEL[trip.kind] ?? "Trip"}</span>
          <h2 className={s.title}>{trip.title}</h2>
          <div className={s.heroFacts}>
            <span>{shownBack ? dateRange(day10(trip.out), day10(shownBack)) : `from ${shortDate(day10(trip.out))}`}</span>
            <span>
              {shownNights} night{shownNights === 1 ? "" : "s"}
            </span>
            {shownHours != null && shownHours > 0 && <span>{formatDuration(Math.round(shownHours * 60))} travelling</span>}
            {trip.direct && <span className={s.directTag}>direct</span>}
          </div>
          <div className={s.priceRow}>
            <b className={s.price}>
              {totalIsUpper ? "at most " : ""}
              {euro(total)}
            </b>
            {!totalIsUpper && total !== trip.price && <del className={s.was}>{euro(trip.price)}</del>}
            <span className={s.priceSub}>
              {flightTickets.length > 1 ? "all tickets" : "the ticket"}
              {groundExtra > 0 ? `, plus about ${euro(groundExtra)} on the ground` : ""}
            </span>
          </div>
          {totalIsUpper && (
            <span className={s.warnLine}>
              {homeMode === "return"
                ? `Your way out is on a return ticket. Keep it and skip its way home, and the most it costs is ${euro(total)}; a one way out may cost less. Price it again before you book.`
                : `The way out was priced together with the old way home, so its own price is not known. Buy only the ticket out plus this flight, and the most it costs is ${euro(total)}. Price the way out again before you book.`}
            </span>
          )}
        </div>
      </header>

      {/* ---------- the route as pictures ---------- */}
      <div className={s.strip} role="list" aria-label="The route">
        {items.map((it, k) =>
          it.kind === "end" ? (
            <div key={`e${k}`} className={s.stripEnd} role="listitem">
              <span className={s.homeDot} />
              <span>{it.label}</span>
            </div>
          ) : it.kind === "leg" ? (
            <span key={`l${k}`} className={`${s.stripLeg}${it.leg.estimated ? ` ${s.est}` : ""}`} role="listitem" title={`${MODE_WORD[it.leg.kind]}: ${it.leg.fromName} to ${it.leg.toName}`}>
              <ModeIcon kind={it.leg.kind} />
              {it.leg.price != null ? (
                <b>
                  {bundledIdx >= 0 && it.leg === shownLegs[bundledIdx] ? "up to " : it.leg.estimated ? "~" : ""}
                  {euro(it.leg.price)}
                </b>
              ) : it.leg.minutes ? (
                <b>{formatDuration(Math.round(it.leg.minutes))}</b>
              ) : null}
            </span>
          ) : (
            <button key={`s${k}`} className={`${s.stripStop}${stopIdx === it.i ? ` ${s.stripOn}` : ""}`} role="listitem" onClick={() => focusStop(it.i)} title={`${it.stop.name}, ${countryName(it.stop.country)}: ${dateRange(day10(it.stop.arrive), day10(it.stop.leave))}`}>
              <CityPhoto stop={it.stop} className={s.stripPhoto} />
              <span className={s.stripName}>{it.stop.name}</span>
              <span className={s.stripNights}>{it.stop.nights}n</span>
            </button>
          ),
        )}
      </div>

      {(trip.badges.length > 0 || trip.why.length > 0) && (
        <div className={s.why}>
          {trip.badges.length > 0 && (
            <div className={s.badges}>
              {trip.badges.map((b) => (
                <span key={b} className={s.badge}>
                  {b}
                </span>
              ))}
            </div>
          )}
          {trip.why.map((w, i) => (
            <p key={i} className={s.whyLine}>
              {w}
            </p>
          ))}
        </div>
      )}

      {/* ---------- tickets ---------- */}
      <section className={s.section} aria-labelledby="tickets-h">
        <div className={s.sectionHead}>
          <h3 id="tickets-h" className={s.h3}>
            {bookable.length === 0 ? "Nothing to book ahead" : bookable.length === 1 ? "One ticket" : `${COUNT_WORD[bookable.length] ?? bookable.length} tickets`}
          </h3>
          <span className={s.sectionSub}>{SOURCE_LABEL[trip.source]}{trip.seen ? `, seen ${shortDate(day10(trip.seen))}` : ""}</span>
        </div>
        {showRisk && (
          <p className={s.risk}>
            {COUNT_WORD[flightTickets.length] ?? flightTickets.length} separate tickets, bought one by one. If one is late, the next will not wait and will not refund you: that is your own risk. Leave three hours or a night between them.
          </p>
        )}
        <ol className={s.legs}>
          {shownLegs.map((l, i) => {
            const t = tickets.find((x) => x.legs.includes(i));
            const firstOfTicket = t && t.legs[0] === i;
            const sameAs = t && !firstOfTicket ? t.legs[0] : -1;
            const isHome = i >= homeStart && !!chosen;
            const bundled = bundledIdx >= 0 && !!t?.legs.includes(bundledIdx);
            return (
              <li key={i} className={`${s.leg}${isHome ? ` ${s.legNew}` : ""}`}>
                <span className={`${s.legIcon} ${l.kind === "fly" ? s.fly : s.ground}`}>
                  <ModeIcon kind={l.kind} size={16} />
                </span>
                <div className={s.legBody}>
                  <div className={s.legRoute}>
                    {l.fromName || l.from} to {l.toName || l.to}
                  </div>
                  <div className={s.legMeta}>
                    {legWhen(l)}
                    {l.kind === "fly" && l.stops != null ? ` · ${l.stops ? `${l.stops} stop${l.stops === 1 ? "" : "s"}` : "direct"}` : ""}
                    {l.carrier ? ` · ${l.carrier}` : ""}
                  </div>
                  {(l.note || l.estimated || tight.has(i) || (bundled && firstOfTicket)) && (
                    <div className={s.legNotes}>
                      {l.estimated && <span className={s.estTag}>estimated</span>}
                      {bundled && firstOfTicket && <span className={s.tightTag}>priced with the old way home; on its own it may cost less</span>}
                      {tight.has(i) && <span className={s.tightTag}>tight change, separate ticket</span>}
                      {l.note && <span>{l.note}</span>}
                    </div>
                  )}
                </div>
                <div className={s.legSide}>
                  {firstOfTicket && t?.price != null ? (
                    <b className={s.legPrice}>
                      {bundled ? "up to " : t.estimated ? "~" : ""}
                      {euro(t.price)}
                    </b>
                  ) : l.price != null && !t?.url ? (
                    <b className={s.legPrice}>~{euro(l.price)}</b>
                  ) : null}
                  {l.url && firstOfTicket ? (
                    <a className={s.book} href={l.url} target="_blank" rel="noreferrer">
                      Book ↗
                    </a>
                  ) : sameAs >= 0 && l.url ? (
                    <small className={s.same}>same ticket as leg {sameAs + 1}</small>
                  ) : !l.url && l.kind !== "fly" ? (
                    <small className={s.same}>buy on the day</small>
                  ) : !l.url ? (
                    // A flight with no booking link still gets a way to buy it: a search for that day.
                    <a className={s.book} href={`https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from ${l.from || l.fromName} to ${l.to || l.toName}${day10(l.date) ? ` on ${day10(l.date)}` : ""}`)}`} target="_blank" rel="noreferrer">
                      Search ↗
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {/* ---------- ways home ---------- */}
      {lastStop && trip.kind !== "group" && (
        <WaysHome
          from={{ name: lastStop.name, code: lastStop.code, country: lastStop.country, lat: lastStop.lat, lon: lastStop.lon }}
          around={day10(end)}
          notBefore={lastStop.arrive ? addDays(day10(lastStop.arrive), 1) : undefined}
          query={query}
          currentDay={currentHomeDay}
          currentPrice={currentHomePrice}
          chosen={chosen}
          onChoose={setChosen}
        />
      )}

      {/* ---------- events on during the stay ---------- */}
      <EventsOn key={`${trip.id}|${shownStops[shownStops.length - 1]?.leave ?? ""}`} stops={shownStops} />

      {/* ---------- per place: hotels, sights, food ---------- */}
      {trip.stops.length > 0 && (
        <section className={s.section} aria-labelledby="places-h">
          <div className={s.sectionHead}>
            <h3 id="places-h" className={s.h3}>
              Stay, see and eat
            </h3>
          </div>
          {shownStops.length > 1 && (
            <div className={s.chips} role="tablist">
              {shownStops.map((st, i) => (
                <button key={`${st.name}${i}`} role="tab" aria-selected={stopIdx === i} className={`${s.chip}${stopIdx === i ? ` ${s.chipOn}` : ""}`} onClick={() => focusStop(i)}>
                  {st.name}
                  <small>{st.nights}n</small>
                </button>
              ))}
            </div>
          )}
          {shownStops[stopIdx] && <PlaceBlock key={`${trip.id}|${stopIdx}|${shownStops[stopIdx].leave}`} stop={shownStops[stopIdx]} nat={query?.from.home} />}
        </section>
      )}

      <div className={s.spacer} />

      {/* ---------- make it a plan ---------- */}
      <div className={s.dock}>
        <div className={s.dockPrice}>
          <b>
            {totalIsUpper ? "at most " : ""}
            {euro(Math.round(total + groundExtra))}
          </b>
          <small>
            {groundExtra > 0 ? "door to door, " : ""}
            {shownNights} night{shownNights === 1 ? "" : "s"}, {trip.stops.length} place{trip.stops.length === 1 ? "" : "s"}
          </small>
        </div>
        <button className={s.plan} onClick={() => onItinerary(chosen ? withChosenHome(trip, shownLegs, chosen, { price: total, upper: totalIsUpper, nights: shownNights, ground: groundExtra, hours: shownHours }) : trip)}>
          Make it a plan
        </button>
      </div>
      <p className={s.dockNote}>The plan is day by day, with save and share.</p>
    </article>
  );
}

/** The stops with the last one ending on another day (a chosen way home), its nights counted again. */
function endStopsOn(stops: TripStop[], day: string): TripStop[] {
  return stops.map((st, i) => (i === stops.length - 1 ? { ...st, leave: day, nights: Math.max(0, Math.round((Date.parse(day) - Date.parse(day10(st.arrive))) / 86_400_000)) } : st));
}

/** The trip as the traveller now sees it, so the plan starts from their chosen way home. */
function withChosenHome(trip: TripResult, legs: TripLeg[], c: WayHomeChoice, v: { price: number; upper: boolean; nights: number; ground: number; hours?: number }): TripResult {
  const urls = [...new Set(legs.map((l) => l.url).filter((u): u is string => !!u))];
  const stops = endStopsOn(trip.stops, c.date);
  const why = [...trip.why, `Way home chosen: ${shortDate(c.date)}, ${euro(c.flight.price)}`];
  if (v.upper) why.push(`${euro(v.price)} is the most it costs: price the way out again on its own before you book`);
  return { ...trip, legs, stops, price: Math.round(v.price), groundPrice: Math.round(v.ground), ...(v.hours != null ? { hours: Math.round(v.hours * 10) / 10 } : {}), back: c.date, nights: v.nights, urls, why };
}

// ---------------------------------------------------------------- events

type EventRow = { key: string; name: string; start: string; end?: string; where: string; kind?: string; why?: string; url?: string; time?: string; price?: string };

/**
 * What is on while the traveller is there, across every stop: the curated events worth flying
 * for (lib/purpose-events.ts, in the browser, no request), the same list as the server dates
 * it for a city by name (/api/purpose?city=, which also knows city names the browser cannot
 * resolve to a code), and the city's own listings (/api/events) for stays within its 90-day
 * reach. Each list is filtered to the nights at that stop.
 */
function EventsOn({ stops }: { stops: TripStop[] }) {
  // Keyed by the trip id where it is mounted, so another trip starts with a fresh fetch.
  const list = stops.slice(0, 6);
  const curated = useMemo<EventRow[]>(
    () =>
      list.flatMap((st) =>
        eventsAt({ city: st.code, lat: st.lat, lon: st.lon, km: 80 }, day10(st.arrive), day10(st.leave) || day10(st.arrive)).map((e) => fromPlaceEvent(e, st)),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list.map((st) => `${st.name}|${st.arrive}|${st.leave}`).join(",")],
  );
  const [more, setMore] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const ref = useNearView<HTMLElement>(() => {
    setLoading(true);
    const today = todayIso();
    const jobs = list.flatMap((st) => {
      const from = day10(st.arrive);
      const to = day10(st.leave) || from;
      if (!from) return [];
      const purpose = getJson<{ events?: PlaceEvent[] }>(`/api/purpose?${new URLSearchParams({ city: st.name, from, to })}`)
        .then((r) => (r.events ?? []).map((e) => fromPlaceEvent(e, st)))
        .catch(() => [] as EventRow[]);
      // The city feeds only look 90 days ahead from today; a later stay has nothing to ask yet.
      const daysAhead = Math.ceil((Date.parse(to) - Date.parse(today)) / 86_400_000) + 1;
      const feeds =
        to >= today && daysAhead <= 90
          ? getJson<EventsResponse>(`/api/events?lat=${st.lat.toFixed(3)}&lon=${st.lon.toFixed(3)}&days=${Math.max(1, daysAhead)}`)
              .then((r) => (r.events ?? []).filter((e) => e.date.slice(0, 10) <= to && (e.end ?? e.date).slice(0, 10) >= from).map((e) => fromFeedEvent(e, st)))
              .catch(() => [] as EventRow[])
          : Promise.resolve([] as EventRow[]);
      return [purpose, feeds];
    });
    Promise.all(jobs).then((rows) => {
      setMore(rows.flat());
      setLoading(false);
    });
  }, list.length > 0);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return [...curated, ...more]
      .filter((r) => {
        const k = `${fold(r.name)}|${r.start}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, 12);
  }, [curated, more]);

  if (!list.length) return null;
  return (
    <section ref={ref} className={s.section} aria-labelledby="events-h">
      <div className={s.sectionHead}>
        <h3 id="events-h" className={s.h3}>
          On while you are there
        </h3>
        {loading && <span className={s.sectionSub}>checking local listings</span>}
      </div>
      {rows.length ? (
        <ul className={s.events}>
          {rows.map((r) => (
            <li key={r.key} className={s.event}>
              <span className={s.eventDate}>
                <b>{shortDate(r.start)}</b>
                {r.end && r.end !== r.start ? <small>to {shortDate(r.end)}</small> : r.time ? <small>{r.time}</small> : null}
              </span>
              <span className={s.eventBody}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer" className={s.eventName}>
                    {r.name}
                  </a>
                ) : (
                  <span className={s.eventName}>{r.name}</span>
                )}
                <small>
                  {r.where}
                  {r.kind ? ` · ${r.kind}` : ""}
                  {r.price ? ` · ${r.price}` : ""}
                </small>
                {r.why && <small className={s.eventWhy}>{r.why}</small>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        !loading && <p className={s.muted}>Nothing big on that we know of. Local listings fill in closer to the dates.</p>
      )}
    </section>
  );
}

function fromPlaceEvent(e: PlaceEvent, st: TripStop): EventRow {
  return { key: `p|${e.name}|${e.start}`, name: e.name, start: e.start, end: e.end, where: e.cityName || st.name, kind: e.kind, why: e.why, url: e.url };
}
function fromFeedEvent(e: EventItem, st: TripStop): EventRow {
  const price = e.free ? "free" : e.priceFrom != null ? `from ${e.currency && e.currency !== "EUR" ? `${Math.round(e.priceFrom)} ${e.currency}` : euro(e.priceFrom)}` : undefined;
  return { key: `f|${e.url}|${e.date}`, name: e.name, start: e.date.slice(0, 10), end: e.end?.slice(0, 10), where: e.venue ? `${e.venue}, ${e.city ?? st.name}` : (e.city ?? st.name), kind: e.kind, url: e.url, time: e.time, price };
}

// ---------------------------------------------------------------- one place

/** Hotels for the nights at this stop, then what to see and where to eat: compact, one place at a time. */
function PlaceBlock({ stop, nat }: { stop: TripStop; nat?: string }) {
  const checkin = day10(stop.arrive);
  const checkout = day10(stop.leave);
  const canHotel = stop.nights > 0 && !!checkin && checkout > checkin && checkin >= todayIso() && stop.nights <= 30;
  const [hotels, setHotels] = useState<HotelsResult | "loading" | "error" | null>(null);
  const [sights, setSights] = useState<Sights | null | "loading">("loading");
  const [eats, setEats] = useState<EatsResponse | null | "loading">("loading");

  const ref = useNearView<HTMLDivElement>(() => {
    if (canHotel) {
      setHotels("loading");
      const p = new URLSearchParams({ lat: stop.lat.toFixed(4), lon: stop.lon.toFixed(4), checkin, checkout });
      if (nat && /^[A-Z]{2}$/.test(nat)) p.set("nat", nat);
      getJson<HotelsResult>(`/api/hotels?${p}`).then(setHotels, () => setHotels("error"));
    }
    getJson<Sights | null>(`/api/sights?name=${encodeURIComponent(stop.name)}`).then(setSights, () => setSights(null));
    getJson<EatsResponse>(`/api/eats?lat=${stop.lat.toFixed(3)}&lon=${stop.lon.toFixed(3)}`).then(setEats, () => setEats(null));
  });

  const bookingSearch = `https://www.booking.com/searchresults.html?${new URLSearchParams({ ss: `${stop.name}, ${countryName(stop.country)}`, ...(canHotel ? { checkin, checkout } : {}), group_adults: "1", no_rooms: "1" })}`;
  const see: Sight[] = sights && sights !== "loading" ? [...sights.see.slice(0, 4), ...sights.do.slice(0, 2)] : [];
  const food = eats && eats !== "loading" && eats.food.status === "ok" ? eats.food.places.slice(0, 4) : [];
  const sweet = eats && eats !== "loading" && eats.sweet.status === "ok" ? eats.sweet.places.slice(0, 2) : [];

  return (
    <div ref={ref} className={s.place}>
      <div className={s.placeHead}>
        <b>{stop.name}</b>
        <small>
          {countryName(stop.country)} · {checkin && checkout ? dateRange(checkin, checkout) : ""} · {stop.nights} night{stop.nights === 1 ? "" : "s"}
        </small>
      </div>

      <h4 className={s.h4}>Hotels for your nights</h4>
      {!canHotel ? (
        <p className={s.muted}>{stop.nights > 30 ? "A long stay: look for a monthly rental. " : ""}
          <a href={bookingSearch} target="_blank" rel="noreferrer">
            Search stays in {stop.name} ↗
          </a>
        </p>
      ) : hotels === "loading" || hotels === null ? (
        <div className={s.hotels}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${s.hotel} ${s.shimmer}`} />
          ))}
        </div>
      ) : hotels === "error" || hotels.status === "error" || hotels.status === "no-key" ? (
        <p className={s.muted}>
          No hotel prices right now.{" "}
          <a href={bookingSearch} target="_blank" rel="noreferrer">
            Search stays for these nights ↗
          </a>
        </p>
      ) : (
        <>
          <div className={s.hotels}>
            {hotels.hotels.slice(0, 6).map((h) => (
              <HotelCard key={h.id} h={h} showPrice={hotels.status === "ok"} />
            ))}
          </div>
          {hotels.status === "sandbox" && <p className={s.muted}>Hotel prices show once the live hotel key is on.</p>}
          {!hotels.hotels.length && <p className={s.muted}>No well rated hotels found nearby for these nights.</p>}
          <a className={s.more} href={bookingSearch} target="_blank" rel="noreferrer">
            More stays for these nights ↗
          </a>
        </>
      )}

      <h4 className={s.h4}>See and do</h4>
      {sights === "loading" ? (
        <div className={`${s.lineSkel} ${s.shimmer}`} />
      ) : see.length ? (
        <ul className={s.pois}>
          {see.map((x) => (
            <li key={`${x.kind}|${x.name}`}>
              {x.url ? (
                <a href={x.url} target="_blank" rel="noreferrer">
                  {x.name}
                </a>
              ) : (
                <b>{x.name}</b>
              )}
              {x.desc && <span>{x.desc.length > 140 ? `${x.desc.slice(0, 137)}...` : x.desc}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.muted}>No guide listings for {stop.name}.</p>
      )}
      {sights && sights !== "loading" && (
        <small className={s.credit}>
          <a href={sights.url} target="_blank" rel="noreferrer">
            {sights.licence}
          </a>
        </small>
      )}

      <h4 className={s.h4}>Eat well, not at tourist prices</h4>
      {eats === "loading" ? (
        <div className={`${s.lineSkel} ${s.shimmer}`} />
      ) : food.length || sweet.length ? (
        <ul className={s.pois}>
          {[...food, ...sweet].map((e) => (
            <li key={e.id}>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer">
                  {e.name}
                </a>
              ) : (
                <b>{e.name}</b>
              )}
              <span>
                {[e.category, e.rating != null ? `${e.rating.toFixed(1)}/10` : "", e.price ? "€".repeat(e.price) : "", e.distance != null ? `${(e.distance / 1000).toFixed(1)} km` : ""].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.muted}>{eats && eats.food.status !== "ok" ? "Food picks are not available right now." : `No food picks for ${stop.name} yet.`}</p>
      )}
    </div>
  );
}

function HotelCard({ h, showPrice }: { h: Hotel; showPrice: boolean }) {
  return (
    <div className={s.hotel}>
      <div className={s.hotelPhoto}>{h.image && <img src={h.image} alt="" loading="lazy" />}</div>
      <div className={s.hotelBody}>
        <b title={h.name}>{h.name}</b>
        <small>
          {h.stars ? `${"★".repeat(Math.round(h.stars))} ` : ""}
          {h.rating ? `${h.rating.toFixed(1)}` : ""}
        </small>
        {showPrice && h.total != null && (
          <span className={s.hotelPrice}>
            {euro(h.total)} <small>{h.perNight != null ? `${euro(h.perNight)} a night` : "in all"}</small>
          </span>
        )}
      </div>
    </div>
  );
}
