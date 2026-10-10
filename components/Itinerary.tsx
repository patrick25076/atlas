"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { BudgetTier, Itinerary as Itin, ItinBlock, ItinCosts, ItinDay, ItinEvent, ItinFood, ItinLeg, ItinPlace, Pace, Skeleton } from "@/lib/itinerary";
import type { PlaceSummary } from "@/app/api/place/route";
import { countryName, daysBetween, euro, kiwiPhoto, shortDate, weekday } from "@/lib/format";
import { formatDuration, haversineKm } from "@/lib/geo";
import { ownerHeaders } from "@/lib/owner";
import s from "./Itinerary.module.css";

// The itinerary view: a generated, day by day trip that reads like a travel magazine and
// drives the globe as it is read. Given a skeleton (stops, dates, legs) it asks
// /api/itinerary to write the days and renders them as they stream in; given a finished
// itinerary it just shows it. It owns generation, regeneration with new wishes, saving,
// sharing, the calendar export and printing. The shell decides where it sits (the panel,
// the shared page) and listens through onFocus and onRoute.

/** An itinerary opened from 'Your trips' carries the id it was saved under, so it is not saved twice. */
export type SavedItinerary = Itin & { savedId?: string };

/** The share id of an already saved itinerary: the prop when given, else the one MyTrips attached. */
function savedOf(it: Itin | undefined, savedId: string | undefined): { id: string; url: string } | null {
  const id = savedId ?? (it as SavedItinerary | undefined)?.savedId;
  return id ? { id, url: `/i/${id}` } : null;
}

export type ItineraryProps = {
  skeleton?: Skeleton;
  itinerary?: Itin;
  wishes?: string;
  pace?: Pace;
  budget?: BudgetTier;
  readOnly?: boolean;
  onFocus?: (p: { lat: number; lon: number; zoom?: number; stop?: number; day?: number }) => void;
  onRoute?: (it: Skeleton | Itin) => void;
  /** Kept for the contract; the itinerary does not call it (Play walks the days through onFocus). */
  onPlay?: () => void;
  onClose?: () => void;
  onSaved?: (id: string, url: string) => void;
  /** The saved id when the caller already knows it (the shared page), so the calendar and share links work without saving again. */
  savedId?: string;
};

const PACES: { id: Pace; label: string }[] = [
  { id: "slow", label: "Slow" },
  { id: "balanced", label: "Balanced" },
  { id: "packed", label: "Packed" },
];
const BUDGETS: { id: BudgetTier; label: string }[] = [
  { id: "backpacker", label: "Backpacker" },
  { id: "mid", label: "Mid" },
  { id: "comfort", label: "Comfort" },
];
// Keyed by string so a new source kind (the graph walk's) only needs a label, never a type change here.
const SOURCE_LABEL: Partial<Record<Skeleton["source"] | "walk", string>> = {
  deal: "A deal",
  route: "A to B",
  loop: "A short loop",
  wild: "A wild loop",
  longstay: "A long stay",
  group: "A group trip",
  event: "Worth flying for",
  walk: "A smart loop",
  custom: "Your trip",
};
const SLOT_LABEL: Record<ItinBlock["slot"], string> = {
  "all-day": "All day",
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  night: "Night",
};
const MODE_LABEL: Record<ItinLeg["kind"], string> = { fly: "Flight", train: "Train", coach: "Coach", ferry: "Ferry", road: "By road", walk: "Walk" };
const WISH_MAX = 300;

// ---------- small helpers ----------

/** Only the skeleton fields: what the planner needs when a finished itinerary is rewritten. */
function toSkeleton(x: Skeleton | Itin): Skeleton {
  const { title, subtitle, origin, start, end, nights, stops, legs, travellers, source } = x;
  return { title, subtitle, origin, start, end, nights, stops, legs, travellers, source };
}

/** A cheap identity for a route: same stops on the same days means the globe already has it. */
function routeSig(x: Skeleton | null | undefined): string {
  if (!x) return "";
  return `${x.start}|${x.end}|${x.stops.map((p) => `${p.code ?? p.name}@${p.arrive}`).join(",")}|${x.legs.length}`;
}

function samePlace(a: ItinPlace, b: ItinPlace): boolean {
  if (a.code && b.code && a.code === b.code) return true;
  if (a.name && b.name && a.name.toLowerCase() === b.name.toLowerCase()) return true;
  return Number.isFinite(a.lat) && Number.isFinite(b.lat) && haversineKm(a.lat, a.lon, b.lat, b.lon) < 40;
}

function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/** "14 Nov to 19 Nov", with the year when it is not this one. */
function tripDates(start: string, end: string): string {
  const y = yearOf(end);
  const tail = y && y !== new Date().getFullYear() ? ` ${y}` : "";
  return `${shortDate(start)} to ${shortDate(end)}${tail}`;
}

function money(n: number | null | undefined, estimated?: boolean): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n === 0) return "free";
  return `${estimated ? "about " : ""}${euro(n)}`;
}

/** The days the trip spans, first and last included. */
function dayCount(x: Skeleton): number {
  return Math.max(1, daysBetween(x.start, x.end) + 1);
}

/** Reads an NDJSON body line by line; a broken line is skipped, not fatal. */
async function* ndjson(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // A half-written line from a dropped connection: ignore it, the next one may be fine.
      }
    }
  }
  const rest = buf.trim();
  if (rest) {
    try {
      yield JSON.parse(rest);
    } catch {
      /* see above */
    }
  }
}

/** The element that scrolls this one: the panel's body in the app, the page wrapper on /i. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ---------- photos ----------

// One photo lookup per name per page load. Wikipedia's lead image first (for a city it is
// nearly always a photo or a montage), then the Wikivoyage thumbnail, which is often a district
// map; anything that looks like a map, a flag or a crest is skipped, so the gradient wins
// over a bad picture. Both thumbnails are small (about 320 px), so the hero asks Wikimedia for
// the 960 px rendition of the same file and falls back to the small one when it is refused.
const NOT_A_PHOTO = /(map|locator|location|flag|coat[_ -]of[_ -]arms|seal|logo|emblem|\.svg)/i;
const thumbs = new Map<string, Promise<string | null>>();
// The words Wikipedia uses for a country when the English short name is not among them.
const COUNTRY_WORDS: Record<string, string[]> = {
  GB: ["England", "Scotland", "Wales", "Northern Ireland", "UK", "British"],
  US: ["U.S.", "American", "United States"],
  CZ: ["Czech"],
  TR: ["Turkey", "Türkiye", "Turkish"],
  NL: ["Netherlands", "Dutch", "Holland"],
  KR: ["South Korea", "Korea"],
  AE: ["Emirates", "UAE"],
  RU: ["Russia"],
  VN: ["Vietnam"],
  BA: ["Bosnia"],
};
/** True when the summary is about a place in the stop's country (or no country is known). */
function inCountry(text: string, country?: string): boolean {
  if (!country) return true;
  const code = country.length === 2 ? country.toUpperCase() : "";
  const name = (code ? countryName(code) : country).replace(/\s*\(.*\)$/, "");
  const words = [name, ...(COUNTRY_WORDS[code] ?? [])].filter((w) => w && w.length > 1);
  const hay = text.toLowerCase();
  return words.some((w) => hay.includes(w.toLowerCase()));
}
/** Wikipedia's lead photo, and whether the page turned out to be a namesake in another country. */
async function wikipediaThumb(name: string, country?: string): Promise<{ thumb: string | null; elsewhere: boolean }> {
  const none = { thumb: null, elsewhere: false };
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`);
    if (!r.ok) return none;
    const j = (await r.json()) as { type?: string; description?: string; extract?: string; thumbnail?: { source?: string } };
    if (j.type === "disambiguation") return none;
    // A bare name can be another place: 'Santiago' is Chile's capital, not Compostela. When the
    // summary never names the stop's country, the guide's own picture is the safer bet.
    if (!inCountry(`${j.description ?? ""} ${j.extract ?? ""}`, country)) return { thumb: null, elsewhere: true };
    const t = j.thumbnail?.source;
    return { thumb: t && !NOT_A_PHOTO.test(t) ? t : null, elsewhere: false };
  } catch {
    return none;
  }
}
function placeThumb(name: string, country?: string): Promise<string | null> {
  const key = `${name}|${country ?? ""}`;
  let p = thumbs.get(key);
  if (!p) {
    p = wikipediaThumb(name, country).then(
      (w) =>
        w.thumb ??
        fetch(`/api/place?name=${encodeURIComponent(name)}`)
          .then((r) => (r.ok ? r.json() : null))
          // The guide is asked by the bare name too, and its 'Santiago' is Chile as well. So when
          // Wikipedia already showed the name belongs to another country, the guide's page must
          // name the stop's country to count. Otherwise (no Wikipedia page, a disambiguation) it
          // is taken as before: guide pages often name only the region ('a city in Texas').
          .then((j: PlaceSummary | null) =>
            j?.thumbnail && !NOT_A_PHOTO.test(j.thumbnail) && (!w.elsewhere || inCountry(`${j.title} ${j.extract}`, country)) ? j.thumbnail : null,
          )
          .catch(() => null),
    );
    thumbs.set(key, p);
  }
  return p;
}
const bigger = (url: string) => url.replace(/\/(\d{2,4})px-/, "/960px-");

/** A place photo: the Kiwi image when the place has one, else the guide's picture, else a gradient. */
function Photo({ place, big, className }: { place: ItinPlace | undefined; big?: boolean; className?: string }) {
  // The candidates still to try, best first; an image that fails to load moves to the next.
  const [list, setList] = useState<string[]>([]);
  const guideTried = useRef(false);
  const name = place?.name;
  const img = place?.img;
  const country = place?.country;
  const fromGuide = useCallback((t: string | null) => (t ? (big && bigger(t) !== t ? [bigger(t), t] : [t]) : []), [big]);
  useEffect(() => {
    let live = true;
    setList([]);
    guideTried.current = false;
    if (!name) return;
    const own = img ? (/^https?:\/\//.test(img) ? img : kiwiPhoto(img)) : null;
    if (own) setList([own]);
    else {
      guideTried.current = true;
      placeThumb(name, country).then((t) => live && setList(fromGuide(t)));
    }
    return () => {
      live = false;
    };
  }, [name, img, country, fromGuide]);
  const onError = () => {
    const rest = list.slice(1);
    setList(rest);
    // A broken Kiwi id still deserves the guide's picture, looked up only when it is needed.
    if (!rest.length && !guideTried.current && name) {
      guideTried.current = true;
      placeThumb(name, country).then((t) => setList(fromGuide(t)));
    }
  };
  const src = list[0];
  return (
    <div className={`${s.photo}${className ? ` ${className}` : ""}`} data-on={src ? "1" : "0"}>
      {src && <img key={src} src={src} alt="" loading="lazy" decoding="async" onError={onError} />}
    </div>
  );
}

// ---------- icons ----------

const ICON_PATHS: Record<string, ReactNode> = {
  fly: <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />,
  train: (
    <>
      <rect x="5" y="3" width="14" height="14" rx="3" />
      <path d="M5 10h14M9 21l2-4M15 21l-2-4" />
      <circle cx="9" cy="13.5" r=".6" />
      <circle cx="15" cy="13.5" r=".6" />
    </>
  ),
  coach: (
    <>
      <path d="M6 17V6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v11zM6 11h12M8 17v3M16 17v3" />
      <circle cx="9" cy="14" r=".6" />
      <circle cx="15" cy="14" r=".6" />
    </>
  ),
  ferry: <path d="M2 20c2 1.2 4 1.2 6 0s4-1.2 6 0 4 1.2 6 0M4.5 16 3 11h18l-1.5 5M6 11V7h12v4M12 3v4" />,
  road: (
    <>
      <path d="M5 16h14v-4l-2-5H7l-2 5zM5 12h14" />
      <circle cx="8" cy="16" r="1.6" />
      <circle cx="16" cy="16" r="1.6" />
    </>
  ),
  walk: <path d="M13 5.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 2.5 2.5V21M9 12l3-4 3 3 2.5 1M12 8l-1.2 5" />,
  see: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  do: <path d="M5 21V4h11l-2 4 2 4H5" />,
  eat: <path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 0-3 2-3 5.5S15 13 17 13v8" />,
  drink: <path d="M7 3h10l-1 7a4 4 0 0 1-8 0L7 3zM12 14v6M8.5 20h7" />,
  stay: <path d="M3 19V7M3 15h18v4M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5M7 12.5a1.5 1.5 0 1 0 0-.01" />,
  event: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6l-5.4 2.9 1.2-6-4.5-4.2 6.1-.7z" />,
  free: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  play: <path d="M7 4.5v15l12-7.5z" />,
  pause: <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />,
  save: <path d="M6 3h12v18l-6-4-6 4z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  print: <path d="M7 9V3h10v6M7 17H4.5A1.5 1.5 0 0 1 3 15.5v-5A1.5 1.5 0 0 1 4.5 9h15a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H17M7 14h10v7H7z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" />
    </>
  ),
};
const FILLED = new Set(["play", "pause"]);

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const filled = FILLED.has(name);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name] ?? ICON_PATHS.spark}
    </svg>
  );
}

// ---------- the route strip ----------

type Segment = { legs: ItinLeg[] };

/** Splits the legs into the hops between stops: everything until a leg lands at the next stop. */
function segmentsOf(x: Skeleton): { before: Segment[]; tail: Segment | null } {
  const segs: Segment[] = x.stops.map(() => ({ legs: [] }));
  let next = 0;
  const tail: Segment = { legs: [] };
  for (const leg of x.legs) {
    if (next < x.stops.length) {
      segs[next].legs.push(leg);
      if (samePlace(leg.to, x.stops[next])) next++;
    } else tail.legs.push(leg);
  }
  return { before: segs, tail: tail.legs.length ? tail : null };
}

/** The main way of a hop (a flight wins over the taxi to the airport), its minutes and price. */
function summarise(seg: Segment): { kind: ItinLeg["kind"]; minutes: number; price: number | null; estimated: boolean } | null {
  if (!seg.legs.length) return null;
  const order: ItinLeg["kind"][] = ["fly", "ferry", "train", "coach", "road", "walk"];
  const kind = order.find((k) => seg.legs.some((l) => l.kind === k)) ?? seg.legs[0].kind;
  const minutes = seg.legs.reduce((a, l) => a + (l.minutes ?? 0), 0);
  const priced = seg.legs.filter((l) => l.price != null);
  const price = priced.length ? priced.reduce((a, l) => a + (l.price ?? 0), 0) : null;
  return { kind, minutes, price, estimated: seg.legs.some((l) => l.estimated) };
}

function HopPill({ seg }: { seg: Segment }) {
  const sum = summarise(seg);
  if (!sum) return <span className={s.hopGap} aria-hidden="true" />;
  const book = seg.legs.find((l) => l.kind === sum.kind && l.url)?.url;
  const body = (
    <>
      <Icon name={sum.kind} size={13} />
      {sum.minutes > 0 && <span>{formatDuration(sum.minutes)}</span>}
      {sum.price != null && <b>{sum.price === 0 ? "free" : `${sum.estimated ? "~" : ""}${euro(sum.price)}`}</b>}
    </>
  );
  return book ? (
    <a className={s.hop} data-kind={sum.kind} href={book} target="_blank" rel="noreferrer" title={`${MODE_LABEL[sum.kind]}: book`}>
      {body}
    </a>
  ) : (
    <span className={s.hop} data-kind={sum.kind} title={MODE_LABEL[sum.kind]}>
      {body}
    </span>
  );
}

function RouteChips({ x, active, onStop }: { x: Skeleton; active: number | null; onStop: (i: number) => void }) {
  const { before, tail } = segmentsOf(x);
  return (
    <div className={s.chips} role="list" aria-label="The route">
      <span className={s.home} role="listitem">
        <span className={s.homeDot} />
        {x.origin.name}
      </span>
      {x.stops.map((st, i) => (
        <span key={`${st.name}${i}`} className={s.chipPair}>
          <HopPill seg={before[i]} />
          <button type="button" className={s.chip} data-active={active === i ? "1" : "0"} onClick={() => onStop(i)} role="listitem" title={`${st.name}: ${tripDates(st.arrive, st.leave)}`}>
            <Photo place={st} className={s.chipPhoto} />
            <span className={s.chipName}>{st.name}</span>
            <span className={s.chipNights}>{st.nights}n</span>
          </button>
        </span>
      ))}
      {tail && (
        <span className={s.chipPair}>
          <HopPill seg={tail} />
          <span className={s.home} role="listitem">
            <span className={s.homeDot} />
            {tail.legs[tail.legs.length - 1].to.name}
          </span>
        </span>
      )}
    </div>
  );
}

// ---------- days ----------

/** The legs of a day in travel order, so each travel block can show its own ticket. */
function legsOn(x: Skeleton, date: string): ItinLeg[] {
  return x.legs.filter((l) => l.date === date);
}

function LegLine({ leg }: { leg: ItinLeg }) {
  const times = leg.depart && leg.arrive ? `${leg.depart} to ${leg.arrive}` : leg.depart ? `leaves ${leg.depart}` : "";
  return (
    <div className={s.leg} data-kind={leg.kind}>
      <span className={s.legMode}>
        <Icon name={leg.kind} size={13} />
        {MODE_LABEL[leg.kind]}
      </span>
      <span className={s.legRoute}>
        {leg.from.name} to {leg.to.name}
      </span>
      <span className={s.legMeta}>
        {[times, leg.minutes ? formatDuration(leg.minutes) : "", leg.carrier ?? ""].filter(Boolean).join(" · ")}
      </span>
      {leg.price != null && <b className={s.legPrice}>{money(leg.price, leg.estimated)}</b>}
      {leg.url && (
        <a className={s.book} href={leg.url} target="_blank" rel="noreferrer">
          Book
        </a>
      )}
      {leg.note && <span className={s.legNote}>{leg.note}</span>}
    </div>
  );
}

function BlockRow({ b, leg }: { b: ItinBlock; leg?: ItinLeg }) {
  const geo = b.lat != null && b.lon != null && Number.isFinite(b.lat) && Number.isFinite(b.lon);
  return (
    <div className={s.block} data-kind={b.kind} {...(geo ? { "data-blat": b.lat, "data-blon": b.lon } : {})}>
      <span className={s.bIcon}>
        <Icon name={b.kind === "travel" ? (leg?.kind ?? "fly") : b.kind} size={15} />
      </span>
      <div className={s.bBody}>
        <div className={s.bTop}>
          {b.time && <span className={s.bTime}>{b.time}</span>}
          <span className={s.bTitle}>
            {b.url ? (
              <a href={b.url} target="_blank" rel="noreferrer">
                {b.title}
              </a>
            ) : (
              b.title
            )}
          </span>
          {b.cost != null && <span className={s.bCost}>{money(b.cost)}</span>}
        </div>
        {b.note && <p className={s.bNote}>{b.note}</p>}
        {leg && <LegLine leg={leg} />}
        {b.source && <span className={s.bSource}>{b.source}</span>}
      </div>
    </div>
  );
}

function eventsOn(events: ItinEvent[], date: string): ItinEvent[] {
  return events.filter((e) => e.date <= date && (e.end ?? e.date) >= date);
}

function DayCard({ day, x, events, index, active }: { day: ItinDay; x: Skeleton; events: ItinEvent[]; index: number; active: boolean }) {
  const stop = x.stops[day.stop];
  const legs = legsOn(x, day.date);
  let travelSeen = 0;
  let lastSlot: string | null = null;
  const evs = eventsOn(events, day.date);
  return (
    <section className={s.day} data-day={index} data-active={active ? "1" : "0"} style={{ "--i": Math.min(index, 6) } as CSSProperties}>
      <span className={s.dayDot} aria-hidden="true" />
      <div className={s.dayCard}>
        <header className={s.dayHead}>
          <span className={s.dayNum}>
            <small>Day</small>
            {day.n}
          </span>
          <span className={s.dayWhen}>
            <b>
              {weekday(day.date)} {shortDate(day.date)}
            </b>
            <span>{stop ? `${stop.name}${stop.country ? `, ${countryName(stop.country)}` : ""}` : ""}</span>
          </span>
          {day.weather && <span className={s.weather}>{day.weather}</span>}
        </header>
        <h3 className={s.dayTitle}>{day.title}</h3>
        {day.summary && <p className={s.daySummary}>{day.summary}</p>}
        {evs.length > 0 && (
          <div className={s.eventBadges}>
            {evs.map((e) => (
              <a key={e.name + e.date} className={s.eventBadge} href={e.url} target="_blank" rel="noreferrer" title={e.why}>
                <Icon name="event" size={12} />
                {e.name}
              </a>
            ))}
          </div>
        )}
        <div className={s.blocks}>
          {day.blocks.map((b, k) => {
            const label = b.slot !== lastSlot ? SLOT_LABEL[b.slot] : null;
            lastSlot = b.slot;
            const leg = b.kind === "travel" ? legs[travelSeen++] : undefined;
            return (
              <div key={k}>
                {label && <div className={s.slot}>{label}</div>}
                <BlockRow b={b} leg={leg} />
              </div>
            );
          })}
        </div>
        {day.cost != null && day.cost > 0 && (
          <footer className={s.dayCost}>
            <span>The day</span>
            <b>{euro(day.cost)}</b>
          </footer>
        )}
      </div>
    </section>
  );
}

function PendingDay({ n }: { n: number }) {
  return (
    <section className={`${s.day} ${s.pending}`} aria-hidden="true">
      <span className={s.dayDot} />
      <div className={s.dayCard}>
        <div className={s.dayHead}>
          <span className={s.dayNum}>
            <small>Day</small>
            {n}
          </span>
          <span className={`${s.shimmer} ${s.shW40}`} />
        </div>
        <span className={`${s.shimmer} ${s.shTitle}`} />
        <span className={`${s.shimmer} ${s.shW90}`} />
        <span className={`${s.shimmer} ${s.shW70}`} />
        <span className={`${s.shimmer} ${s.shW80}`} />
      </div>
    </section>
  );
}

function FoodCard({ food, x }: { food: ItinFood; x: Skeleton }) {
  const stop = x.stops[food.stop];
  if (!food.dishes.length && !food.where.length && !food.dessert) return null;
  return (
    <aside className={s.food}>
      <div className={s.foodHead}>
        <Icon name="eat" size={16} />
        <span>Eating in {stop?.name ?? "town"}</span>
      </div>
      {food.dishes.length > 0 && (
        <div className={s.dishes}>
          {food.dishes.map((d) => (
            <span key={d} className={s.dish}>
              {d}
            </span>
          ))}
        </div>
      )}
      {food.where.length > 0 && (
        <ul className={s.where}>
          {food.where.map((w) => (
            <li key={w.name}>
              <span className={s.whereName}>
                {w.url ? (
                  <a href={w.url} target="_blank" rel="noreferrer">
                    {w.name}
                  </a>
                ) : (
                  w.name
                )}
                {w.note && <small>{w.note}</small>}
              </span>
              {w.price && <span className={s.wherePrice}>{w.price}</span>}
              {w.rating != null && <span className={s.rating}>{w.rating.toFixed(1)}</span>}
            </li>
          ))}
        </ul>
      )}
      {food.dessert && (
        <p className={s.dessert}>
          <b>Sweet:</b> {food.dessert}
        </p>
      )}
    </aside>
  );
}

function CostBreakdown({ c, days }: { c: ItinCosts; days: number }) {
  const rows: [string, number][] = [
    ["Flights", c.flights],
    ["Ground", c.ground],
    ["Stay", c.stay],
    ["Food", c.food],
    ["Activities", c.activities],
  ];
  const max = Math.max(1, ...rows.map(([, v]) => v));
  return (
    <section className={s.costs} aria-label="What it costs">
      <div className={s.costsHead}>
        <div>
          <small>Total</small>
          <b className={s.costTotal}>{euro(c.total)}</b>
        </div>
        <div>
          <small>Per day</small>
          <b>{euro(c.perDay)}</b>
        </div>
        <div>
          <small>Days</small>
          <b>{days}</b>
        </div>
      </div>
      <div className={s.costRows}>
        {rows.map(([k, v]) => (
          <div key={k} className={s.costRow}>
            <span>{k}</span>
            <span className={s.bar}>
              <i style={{ width: `${Math.max(2, (v / max) * 100)}%` }} />
            </span>
            <b>{euro(v)}</b>
          </div>
        ))}
      </div>
      {c.estimated && <p className={s.estimated}>Some of these are estimates: flights and trains are real fares where a booking link is shown, the rest is what such a day usually costs.</p>}
    </section>
  );
}

// ---------- the printable paper version ----------

function Paper({ x, days, food, costs, events }: { x: Skeleton; days: ItinDay[]; food: ItinFood[]; costs: ItinCosts | null; events: ItinEvent[] }) {
  return (
    <article className={s.paper} data-itin-paper="">
      <header>
        <p className={s.paperKicker}>Atlas itinerary</p>
        <h1>{x.title}</h1>
        {x.subtitle && <p>{x.subtitle}</p>}
        <p>
          {tripDates(x.start, x.end)} · {x.nights} nights · from {x.origin.name}
          {costs ? ` · ${euro(costs.total)} in all` : ""}
        </p>
        <p className={s.paperRoute}>{[x.origin.name, ...x.stops.map((p) => `${p.name} (${p.nights}n)`)].join("  >  ")}</p>
      </header>
      {days.map((d) => {
        const stop = x.stops[d.stop];
        const legs = legsOn(x, d.date);
        let t = 0;
        const evs = eventsOn(events, d.date);
        return (
          <section key={d.n} className={s.paperDay}>
            <h2>
              Day {d.n} · {weekday(d.date)} {shortDate(d.date)} · {stop?.name}
            </h2>
            <h3>{d.title}</h3>
            {d.summary && <p>{d.summary}</p>}
            {evs.length > 0 && <p>On: {evs.map((e) => e.name).join(", ")}</p>}
            <table>
              <tbody>
                {d.blocks.map((b, k) => {
                  const leg = b.kind === "travel" ? legs[t++] : undefined;
                  return (
                    <tr key={k}>
                      <td>{b.time ?? SLOT_LABEL[b.slot]}</td>
                      <td>
                        <b>{b.title}</b>
                        {b.note ? ` ${b.note}` : ""}
                        {leg ? ` (${MODE_LABEL[leg.kind]} ${leg.from.name} to ${leg.to.name}${leg.depart ? `, ${leg.depart}` : ""}${leg.carrier ? `, ${leg.carrier}` : ""})` : ""}
                      </td>
                      <td>{b.cost != null ? money(b.cost) : leg?.price != null ? money(leg.price, leg.estimated) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {food
              .filter((f) => f.stop === d.stop && days.findLast((dd) => dd.stop === d.stop)?.n === d.n)
              .map((f) => (
                <p key={f.stop}>
                  <b>Eat:</b> {[...f.dishes, ...f.where.map((w) => w.name)].join(", ")}
                  {f.dessert ? `. Sweet: ${f.dessert}` : ""}
                </p>
              ))}
          </section>
        );
      })}
      {costs && (
        <section className={s.paperDay}>
          <h2>Costs{costs.estimated ? " (partly estimated)" : ""}</h2>
          <p>
            Flights {euro(costs.flights)} · Ground {euro(costs.ground)} · Stay {euro(costs.stay)} · Food {euro(costs.food)} · Activities {euro(costs.activities)}
          </p>
          <p>
            <b>Total {euro(costs.total)}</b>, about {euro(costs.perDay)} a day
          </p>
        </section>
      )}
    </article>
  );
}

// Whatever prints while an itinerary is open is the paper version: the app around it (the
// globe, the panel, a dark page) is hidden for print only. :has keeps this off when no
// itinerary is mounted, so printing the rest of the app is unchanged.
const PRINT_CSS = `@media print {
  html:has(body > [data-itin-paper]), body:has(> [data-itin-paper]) { overflow: visible !important; height: auto !important; background: #fff !important; }
  body:has(> [data-itin-paper]) > *:not([data-itin-paper]) { display: none !important; }
}`;

// ---------- the view ----------

type Phase = "idle" | "writing" | "done" | "error";

export default function Itinerary(props: ItineraryProps) {
  const { skeleton, itinerary, readOnly, onClose } = props;
  const [wishes, setWishes] = useState(props.wishes ?? itinerary?.wishes ?? "");
  const [pace, setPace] = useState<Pace>(props.pace ?? itinerary?.pace ?? "balanced");
  const [budget, setBudget] = useState<BudgetTier>(props.budget ?? itinerary?.budget ?? "mid");
  const [skel, setSkel] = useState<Skeleton | null>(itinerary ? toSkeleton(itinerary) : (skeleton ?? null));
  const [days, setDays] = useState<ItinDay[]>(itinerary?.days ?? []);
  const [itin, setItin] = useState<Itin | null>(itinerary ?? null);
  const [phase, setPhase] = useState<Phase>(itinerary ? "done" : "idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; url: string } | null>(() => savedOf(itinerary, props.savedId));
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tuneOpen, setTuneOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const routedRef = useRef("");
  const usedRef = useRef({ wishes: props.wishes ?? itinerary?.wishes ?? "", pace: props.pace ?? itinerary?.pace ?? "balanced", budget: props.budget ?? itinerary?.budget ?? "mid" });
  // Callbacks in refs: the parent passes new closures every render, and none of them should restart generation or observers.
  const cb = useRef(props);
  cb.current = props;

  useEffect(() => setMounted(true), []);

  /** Tells the shell to draw the route once per distinct route, as early as it is known. */
  const route = useCallback((x: Skeleton | Itin) => {
    const sig = routeSig(x);
    if (!sig || sig === routedRef.current) return;
    routedRef.current = sig;
    cb.current.onRoute?.(x);
  }, []);

  const generate = useCallback(
    async (base: Skeleton, opts: { wishes: string; pace: Pace; budget: BudgetTier; fresh?: boolean }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      usedRef.current = { wishes: opts.wishes, pace: opts.pace, budget: opts.budget };
      setPhase("writing");
      setError("");
      setProgress("Reading the route");
      setDays([]);
      setItin(null);
      setSaved(null);
      setSkel(base);
      let finished = false;
      let gotSkeleton = false;
      try {
        const res = await fetch("/api/itinerary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ skeleton: toSkeleton(base), wishes: opts.wishes.trim() || undefined, pace: opts.pace, budget: opts.budget, fresh: opts.fresh || undefined }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(j?.error ?? (res.status === 404 ? "The planner is not reachable right now." : `The planner answered ${res.status}.`));
        }
        for await (const msg of ndjson(res)) {
          if (ac.signal.aborted) return;
          if (typeof msg.progress === "string") setProgress(msg.progress);
          if (msg.skeleton && typeof msg.skeleton === "object") {
            const sk = msg.skeleton as Skeleton;
            gotSkeleton = true;
            setSkel(sk);
            route(sk);
          }
          if (msg.day && typeof msg.day === "object") {
            const d = msg.day as ItinDay;
            setDays((prev) => [...prev.filter((p) => p.n !== d.n), d].sort((a, b) => a.n - b.n));
          }
          if (msg.done && typeof msg.done === "object") {
            const it = msg.done as Itin;
            finished = true;
            setItin(it);
            setSkel(toSkeleton(it));
            setDays(it.days);
            setPhase("done");
            setProgress("");
            if (!gotSkeleton) route(it);
          }
          if (typeof msg.error === "string") throw new Error(msg.error);
        }
        if (!finished && !ac.signal.aborted) throw new Error("The plan stopped before it was finished. Try again in a minute.");
      } catch (e) {
        if (ac.signal.aborted) return;
        if (!gotSkeleton) route(base);
        setError(e instanceof Error ? e.message : "Something went wrong writing the plan.");
        setPhase("error");
        setProgress("");
      }
    },
    [route],
  );

  // A new input starts over: a finished itinerary is shown as is, a skeleton is planned. The
  // signature keeps a parent that rebuilds the same object every render from re-planning.
  const inputSig = itinerary ? `i:${itinerary.id}:${itinerary.generatedAt}` : skeleton ? `s:${routeSig(skeleton)}:${skeleton.title}` : "";
  useEffect(() => {
    if (itinerary) {
      abortRef.current?.abort();
      setItin(itinerary);
      setSkel(toSkeleton(itinerary));
      setDays(itinerary.days);
      setPhase("done");
      setError("");
      setSaved(savedOf(itinerary, cb.current.savedId));
      route(itinerary);
      return;
    }
    if (skeleton) {
      const p = cb.current;
      generate(skeleton, { wishes: p.wishes ?? "", pace: p.pace ?? "balanced", budget: p.budget ?? "mid" });
    }
    return () => abortRef.current?.abort();
  }, [inputSig]);

  const view = skel;
  const events = itin?.events ?? [];
  const food = itin?.food ?? [];
  const total = view ? dayCount(view) : 0;
  const dirty = wishes.trim() !== usedRef.current.wishes.trim() || pace !== usedRef.current.pace || budget !== usedRef.current.budget;

  const focusDay = useCallback(
    (i: number) => {
      const d = days[i];
      const st = d && view ? view.stops[d.stop] : undefined;
      if (!d || !st) return;
      setActive(d.stop);
      cb.current.onFocus?.({ lat: st.lat, lon: st.lon, zoom: 10, stop: d.stop, day: d.n });
    },
    [days, view],
  );

  // Scroll sync: the day (or a placed block) crossing the middle of the scroller moves the globe.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !days.length) return;
    const scroller = scrollParent(root);
    let last = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (!hit) return;
        const el = hit.target as HTMLElement;
        const key = el.dataset.day ?? `${el.dataset.blat},${el.dataset.blon}`;
        if (key === last) return;
        last = key;
        if (timer) clearTimeout(timer);
        // A short settle so a fast scroll past five days moves the globe once, not five times.
        timer = setTimeout(() => {
          if (el.dataset.day != null) focusDay(Number(el.dataset.day));
          else {
            const lat = Number(el.dataset.blat);
            const lon = Number(el.dataset.blon);
            const dayEl = el.closest<HTMLElement>("[data-day]");
            const d = dayEl ? days[Number(dayEl.dataset.day)] : undefined;
            if (Number.isFinite(lat) && Number.isFinite(lon)) cb.current.onFocus?.({ lat, lon, zoom: 13, stop: d?.stop, day: d?.n });
          }
        }, 220);
      },
      { root: scroller, rootMargin: "-45% 0px -50% 0px", threshold: 0 },
    );
    root.querySelectorAll("[data-day], [data-blat]").forEach((el) => io.observe(el));
    return () => {
      io.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [days, focusDay]);

  // Play: a calm walk through the days, longer on the full ones; any scroll by hand stops it.
  useEffect(() => {
    if (!playing) return;
    const root = rootRef.current;
    if (!root) return;
    const scroller = scrollParent(root) ?? window;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-day]"));
    if (!cards.length) {
      setPlaying(false);
      return;
    }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const smooth = reducedMotion() ? "auto" : "smooth";
    const step = () => {
      if (i >= cards.length) {
        setPlaying(false);
        return;
      }
      cards[i].scrollIntoView({ behavior: smooth, block: "start" });
      focusDay(i);
      const blocks = days[i]?.blocks.length ?? 3;
      i++;
      timer = setTimeout(step, Math.min(7000, 2600 + blocks * 600));
    };
    step();
    const stop = () => setPlaying(false);
    scroller.addEventListener("wheel", stop, { passive: true });
    scroller.addEventListener("touchstart", stop, { passive: true });
    return () => {
      clearTimeout(timer);
      scroller.removeEventListener("wheel", stop);
      scroller.removeEventListener("touchstart", stop);
    };
  }, [playing]);

  // The walk drives the globe itself through onFocus, day by day. It does not also start the
  // shell's route flight (onPlay): the first onFocus would cancel that flight at once, and on a
  // phone the flight drops the sheet to a peek, hiding the days the walk is scrolling through.
  const play = () => {
    if (playing) return setPlaying(false);
    setPlaying(true);
  };

  const regenerate = () => {
    if (!view) return;
    generate(view, { wishes: wishes.slice(0, WISH_MAX), pace, budget, fresh: !dirty });
  };

  const save = async (): Promise<{ id: string; url: string } | null> => {
    if (saved) return saved;
    if (!itin || saving) return null;
    setSaving(true);
    try {
      const res = await fetch("/api/itinerary/save", {
        method: "POST",
        headers: { "content-type": "application/json", ...ownerHeaders() },
        body: JSON.stringify({ itinerary: itin }),
      });
      const j = (await res.json().catch(() => null)) as { id?: string; url?: string; error?: string } | null;
      if (!res.ok || !j?.id) throw new Error(j?.error ?? "Could not save it just now.");
      const got = { id: j.id, url: j.url ?? `/i/${j.id}` };
      setSaved(got);
      cb.current.onSaved?.(got.id, got.url);
      // MyTrips listens, so the strip shows the new trip without a reload.
      window.dispatchEvent(new CustomEvent("atlas:itinerary-saved", { detail: got }));
      return got;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it just now.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const absolute = (url: string) => (typeof location !== "undefined" ? new URL(url, location.origin).toString() : url);

  const share = async () => {
    const got = await save();
    if (!got) return;
    const url = absolute(got.url);
    try {
      if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: view?.title ?? "Atlas itinerary", url });
        return;
      }
    } catch {
      // The share sheet was dismissed; copying is the fallback.
    }
    copy(url);
  };

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => undefined,
    );
  };

  const calendar = async () => {
    const got = await save();
    if (got) window.location.href = `/api/itinerary/${encodeURIComponent(got.id)}/ics`;
  };

  // Which stop each day's food card follows: the last day spent there.
  const foodAfter = useMemo(() => {
    const m = new Map<number, ItinFood>();
    for (const f of food) {
      const lastDay = [...days].reverse().find((d) => d.stop === f.stop);
      if (lastDay) m.set(lastDay.n, f);
    }
    return m;
  }, [food, days]);

  if (!view) {
    return (
      <div className={s.root} ref={rootRef}>
        <p className={s.empty}>Nothing to plan yet. Pick a deal, a route or a loop and choose Make it a trip.</p>
      </div>
    );
  }

  const flightsSoFar = view.legs.reduce((a, l) => a + (l.price ?? 0), 0);
  const costs = itin?.costs ?? null;
  const pendingCount = phase === "writing" ? Math.max(0, total - days.length) : 0;
  const shareUrl = saved ? absolute(saved.url) : "";
  const ready = phase === "done" && !!itin;

  return (
    <div className={s.root} ref={rootRef} data-phase={phase}>
      <header className={s.hero}>
        <Photo place={view.stops[0] ?? view.origin} big className={s.cover} />
        <div className={s.heroShade} />
        {onClose && (
          <button type="button" className={s.close} onClick={onClose} aria-label="Close the itinerary">
            <Icon name="close" size={16} />
          </button>
        )}
        <div className={s.heroText}>
          <span className={s.kicker}>
            {SOURCE_LABEL[view.source as Skeleton["source"] | "walk"] ?? "A trip"} from {view.origin.name}
          </span>
          <h1 className={s.title}>{view.title}</h1>
          {view.subtitle && <p className={s.subtitle}>{view.subtitle}</p>}
          <span className={s.dates}>{tripDates(view.start, view.end)}</span>
        </div>
      </header>

      <div className={s.stats}>
        <div className={s.statTotal}>
          <span>
            {costs ? <b>{euro(costs.total)}</b> : flightsSoFar > 0 ? <b className={s.soft}>{euro(flightsSoFar)}</b> : <b className={s.soft}>...</b>}
            <small>{costs ? (costs.estimated ? "in all, partly estimated" : "in all") : flightsSoFar > 0 ? "travel so far, the rest is being worked out" : "being worked out"}</small>
          </span>
          {costs && (
            <span className={s.perDay}>
              <b>{euro(costs.perDay)}</b>
              <small>a day</small>
            </span>
          )}
        </div>
        <div className={s.statRow}>
          <div>
            <b>{view.nights}</b>
            <small>{view.nights === 1 ? "night" : "nights"}</small>
          </div>
          <div>
            <b>{view.stops.length}</b>
            <small>{view.stops.length === 1 ? "place" : "places"}</small>
          </div>
          <div>
            <b>{total}</b>
            <small>days</small>
          </div>
          {view.travellers != null && view.travellers > 1 && (
            <div>
              <b>{view.travellers}</b>
              <small>{view.travellers === 1 ? "person" : "people"}</small>
            </div>
          )}
        </div>
      </div>

      <RouteChips
        x={view}
        active={active}
        onStop={(i) => {
          const st = view.stops[i];
          setActive(i);
          const di = days.findIndex((d) => d.stop === i);
          if (di >= 0) rootRef.current?.querySelector<HTMLElement>(`[data-day="${di}"]`)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
          if (st) cb.current.onFocus?.({ lat: st.lat, lon: st.lon, zoom: 10, stop: i });
        }}
      />

      <div className={s.toolbar}>
        <button type="button" className={`${s.tool} ${s.primary}`} onClick={play} disabled={!days.length} aria-pressed={playing}>
          <Icon name={playing ? "pause" : "play"} size={13} />
          {playing ? "Pause" : "Play"}
        </button>
        {!readOnly && (
          <button type="button" className={s.tool} onClick={() => save()} disabled={!ready || saving || !!saved}>
            <Icon name="save" size={14} />
            {saved ? "Saved" : saving ? "Saving" : "Save"}
          </button>
        )}
        <button type="button" className={s.tool} onClick={share} disabled={!saved && (!ready || readOnly)}>
          <Icon name="link" size={14} />
          {copied ? "Copied" : "Share"}
        </button>
        <button type="button" className={s.tool} onClick={calendar} disabled={!saved && (!ready || readOnly)}>
          <Icon name="calendar" size={14} />
          Calendar
        </button>
        <button type="button" className={`${s.tool} ${s.iconOnly}`} onClick={() => window.print()} disabled={!days.length} aria-label="Print" title="Print a paper copy">
          <Icon name="print" size={15} />
        </button>
      </div>

      {saved && !readOnly && (
        <div className={s.shareBox}>
          <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
          <button type="button" onClick={() => copy(shareUrl)}>
            <Icon name="copy" size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {!readOnly && (
        <div className={s.tune} data-open={tuneOpen ? "1" : "0"}>
          <button type="button" className={s.tuneToggle} onClick={() => setTuneOpen((o) => !o)} aria-expanded={tuneOpen}>
            <Icon name="spark" size={14} />
            <span>Make it yours</span>
            <small>
              {PACES.find((p) => p.id === pace)?.label} pace, {BUDGETS.find((b) => b.id === budget)?.label.toLowerCase()} budget
              {wishes.trim() ? ", with wishes" : ""}
            </small>
          </button>
          {tuneOpen && (
            <div className={s.tuneBody}>
              <label className={s.wishes}>
                <span>Wishes</span>
                <textarea
                  value={wishes}
                  maxLength={WISH_MAX}
                  rows={3}
                  placeholder="Slow mornings, one proper hike, no museums, vegetarian, a rooftop for the last night"
                  onChange={(e) => setWishes(e.target.value.slice(0, WISH_MAX))}
                />
                <small>
                  {wishes.length}/{WISH_MAX}
                </small>
              </label>
              <div className={s.chipRow}>
                <span>Pace</span>
                {PACES.map((p) => (
                  <button type="button" key={p.id} className={s.pick} data-on={pace === p.id ? "1" : "0"} onClick={() => setPace(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className={s.chipRow}>
                <span>Budget</span>
                {BUDGETS.map((b) => (
                  <button type="button" key={b.id} className={s.pick} data-on={budget === b.id ? "1" : "0"} onClick={() => setBudget(b.id)}>
                    {b.label}
                  </button>
                ))}
              </div>
              <button type="button" className={`${s.tool} ${s.primary} ${s.regen}`} onClick={regenerate} disabled={phase === "writing"}>
                <Icon name="spark" size={14} />
                {phase === "writing" ? "Writing" : dirty ? "Rewrite the plan" : "Regenerate"}
              </button>
            </div>
          )}
        </div>
      )}

      {phase === "writing" && (
        <div className={s.progress} role="status" aria-live="polite">
          <span className={s.pulse} />
          {progress || "Writing the days"}
          <small>
            {days.length}/{total} days
          </small>
        </div>
      )}
      {error && (
        <div className={s.error} role="alert">
          {error}
          {!readOnly && phase === "error" && (
            <button type="button" onClick={regenerate}>
              Try again
            </button>
          )}
        </div>
      )}
      {itin?.status === "partial" && phase === "done" && <div className={s.note}>Some days are thinner than they should be: the research ran short. Regenerate to fill them in.</div>}

      <div className={s.days}>
        {days.map((d, i) => (
          <div key={d.n} className={s.dayWrap}>
            <DayCard day={d} x={view} events={events} index={i} active={active === d.stop} />
            {foodAfter.get(d.n) && <FoodCard food={foodAfter.get(d.n)!} x={view} />}
          </div>
        ))}
        {pendingCount > 0 &&
          Array.from({ length: Math.min(2, pendingCount) }, (_, k) => <PendingDay key={`p${k}`} n={days.length + k + 1} />)}
        {pendingCount > 2 && <p className={s.more}>{pendingCount - 2} more days on the way</p>}
      </div>

      {costs && <CostBreakdown c={costs} days={total} />}
      {itin && itin.sources.length > 0 && <p className={s.sources}>Sources: {itin.sources.join(", ")}</p>}

      {mounted &&
        days.length > 0 &&
        createPortal(
          <>
            <style>{PRINT_CSS}</style>
            <Paper x={view} days={days} food={food} costs={costs} events={events} />
          </>,
          document.body,
        )}
    </div>
  );
}
