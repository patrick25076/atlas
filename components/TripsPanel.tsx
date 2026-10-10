"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import type { Trip, TripsResult } from "@/lib/trips";
import type { WildLeg, WildStop, WildTrip } from "@/lib/wild";
import type { Plan } from "@/lib/plan";
import type { Airport, City, CountryInfo, Gateway, Holiday } from "@/lib/types";
import { formatDuration } from "@/lib/geo";
import { addDays, countryName, dateRange, daysBetween, euro, hoursLabel, localIso, monthLabel, monthOptions, shortDate, todayIso } from "@/lib/format";
import { climateScore, MONTH_LETTERS, newId, TRIP_MODES, WILD_BUDGETS, WILD_REGIONS, WILD_STYLES, type GroupForm, type GroupMemberForm, type GroupQuery, type GroupState, type LongStayBase, type LongStayForm, type LongStayState, type Period, type TripMode, type WalkState } from "@/lib/ui-types";
import { HeroNumbers, LegRows, RouteStrip, StopCards, StopPhoto } from "./RouteStrip";
import { skeletonFromGroup, skeletonFromLongStay, skeletonFromTrip, skeletonFromWild, type ItinPlace, type Skeleton } from "@/lib/itinerary";
import { searchAirports } from "./TopBar";
import { WalkLoopList } from "./WalkCard";

// The Trips tab: the trip builders, with a mode row. Short loops and wild loops share the
// route components; long stay and group have their own forms and cards. "A to B" and the
// events worth flying for are not modes: they are capabilities of the whole app (the command
// line, the route card on the map, the Events layer). All state lives in Globe.tsx and
// arrives as props, so the globe can draw the same trip the panel describes. Every result
// can become an itinerary (onItinerary), which the globe opens in the panel.

export type PlanState = { status: "idle" | "loading" | "ok" | "error"; plan?: Plan; note?: string };
/** The query a wild trip was built with, kept so "Plan the days" asks for the same stored trip even after the form changed. */
export type WildQuery = Record<string, string>;
export type WildState = { status: "idle" | "loading" | "ok" | "error"; lines: string[]; trip?: WildTrip; note?: string; source?: "stored" | "live"; query?: WildQuery };
/** The fewest nights the Wild form offers; /api/wild clamps anything under its own floor (seven today), so a shorter ask is never refused. */
export const WILD_MIN_NIGHTS = 5;
export const WILD_MAX_NIGHTS = 90;
/** The wishes text the engines keep (/api/wild and /api/longstay cut at 300); the box stops there so nothing is lost without a word. */
export const WISHES_MAX = 300;

/** The panel's modes are the trip builders of lib/ui-types; the aliases keep older imports compiling. */
export type PanelMode = TripMode;
export const PANEL_MODES: { key: PanelMode; label: string; hint: string }[] = TRIP_MODES;

/** The free-form extras of every Trips mode: nothing here constrains the visitor to the chips. They live in Globe state like the forms, so a tab switch keeps them. */
export type WildForm = {
  /** Only these countries (ISO2); when any is chosen the region is "custom". */
  countries: string[];
  /** City codes (cities.json keys) the loop must pass through. */
  mustInclude: string[];
  /** Longest single flight in hours; 0 means no limit. */
  maxHours: number;
  /** Airports the loop may start from (IATA, three at most, as /api/wild reads); empty means the visitor's own. */
  startFrom: string[];
  /** What matters, in the visitor's words; sent as wishes=. */
  wishes: string;
  /** Nights a stop, least and most; null leaves it to the engine. */
  stopNights: [number, number] | null;
  /** "Walk the region": the graph walk (one explore from home, cheap hops, the cheapest way home) instead of the classic builder. */
  walk: boolean;
};
/** The style chips of the Smart loop: what the walk trades for (cheapest: price per hour low; unique: smaller places weighted up). */
export type SmartStyle = "cheapest" | "unique" | "balanced";
/**
 * The Smart loop: the graph walk from where the traveller is, the way the owner searches by
 * hand with Skyscanner Explore. Empty dates follow the When pill (or the next three weeks).
 * perStop is the route's nightsPerStop, a number of nights or a range ("2-3").
 */
export type SmartForm = { minNights: number; maxNights: number; perStop: string; cities: number; style: SmartStyle; avoid: string[]; /** Skip the countries like the picked ones too ("like Germany": Austria, Switzerland). */ avoidLike?: boolean; mustInclude: string[]; from: string; to: string; /** Live Kiwi searches the walk may spend; 0 answers from the fare memory alone. */ budget: number };
export type ShortForm = { cities: number; mustInclude: string[]; countries: string[]; maxGroundHours: number };
export type TripsExtra = {
  wild: WildForm;
  short: ShortForm;
  smart: SmartForm;
  longStay: { wishes: string; cities: string[] };
  group: { budgetPerPerson: number };
};
export const EMPTY_TRIPS_EXTRA: TripsExtra = {
  wild: { countries: [], mustInclude: [], maxHours: 0, startFrom: [], wishes: "", stopNights: null, walk: false },
  short: { cities: 3, mustInclude: [], countries: [], maxGroundHours: 5 },
  smart: { minNights: 5, maxNights: 6, perStop: "2", cities: 3, style: "cheapest", avoid: [], mustInclude: [], from: "", to: "", budget: 12 },
  longStay: { wishes: "", cities: [] },
  group: { budgetPerPerson: 0 },
};
/** The group query plus the budget a person, which lib/ui-types.GroupQuery (another stream's) does not carry yet. */
export type GroupSearch = GroupQuery & { budgetPerPerson?: number };
/** Short loop lengths the chips offer; /api/trips clamps at its own ceiling (14 today). */
export const SHORT_DAYS = [3, 5, 7, 10, 14, 21];
/** The engine searches at most this many departure days of a window; the form clips before asking. */
export const WILD_WINDOW_DAYS = 10;
export type LongStayQuery = { months: number; startMonth?: string; budget: string; countries?: string[]; cities?: string[]; wishes?: string };

/** A free window two to six weeks out, the usual case for a meet-up; the visitor edits it. */
function defaultWindow(): { id: string; from: string; to: string } {
  return { id: newId(), from: localIso(new Date(Date.now() + 14 * 86_400_000)), to: localIso(new Date(Date.now() + 45 * 86_400_000)) };
}
/** The group form as a visitor first sees it: two people, the first one's airports filled in once they are known. */
export function emptyGroupForm(): GroupForm {
  return {
    members: [
      { id: newId(), name: "You", origins: [], available: [defaultWindow()] },
      { id: newId(), name: "Ana", origins: [], available: [defaultWindow()] },
    ],
    minNights: 3,
    maxNights: 5,
    where: "",
    direct: false,
    defaultsApplied: false,
  };
}
export const EMPTY_LONGSTAY_FORM: LongStayForm = { months: 2, start: null, budget: "mid", countries: "" };

/** "Türkiye", "turkiye", " TURKEY " all read the same: lower case, no accents, single spaces. */
function plain(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
const CODE = /^[a-z]{2}$/i;

/**
 * The countries box, as typed, to ISO codes. Tokens are separated by commas, semicolons or
 * line breaks (country names contain spaces); a token of space-separated two-letter codes
 * also works ("TH VN"). Names are matched against public/data/countries.json and the
 * browser's own country names, case and diacritic insensitive. Unresolved tokens come back
 * so the panel can say which, and the search is blocked when nothing resolved at all.
 */
export function resolveCountries(text: string, index: Map<string, string>, known: Set<string>): { codes: string[]; unresolved: string[] } {
  const codes: string[] = [];
  const unresolved: string[] = [];
  const add = (c: string) => {
    if (!codes.includes(c)) codes.push(c);
  };
  // A code is accepted when the data knows it, or when the data has not arrived yet.
  const isCode = (t: string) => CODE.test(t) && (known.size === 0 || known.has(t.toUpperCase()));
  for (const raw of text.split(/[,;\n]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (isCode(token)) {
      add(token.toUpperCase());
      continue;
    }
    const byName = index.get(plain(token));
    if (byName) {
      add(byName);
      continue;
    }
    const pieces = token.split(/\s+/);
    if (pieces.length > 1 && pieces.every(isCode)) {
      for (const piece of pieces) add(piece.toUpperCase());
      continue;
    }
    unresolved.push(token);
  }
  return { codes, unresolved };
}

/** Country names and codes to ISO2, for resolveCountries: the data file's names and the browser's own English names, both plain. Shared with the command line. */
export function countryIndexOf(countries: Record<string, CountryInfo>): { index: Map<string, string>; known: Set<string> } {
  const index = new Map<string, string>();
  const known = new Set<string>();
  for (const [code, info] of Object.entries(countries)) {
    known.add(code);
    if (info.name) index.set(plain(info.name), code);
    const intl = countryName(code);
    if (intl && intl !== code) index.set(plain(intl), code);
  }
  return { index, known };
}

export type TripsPanelProps = {
  mode: PanelMode;
  onMode: (m: PanelMode) => void;
  month: string | null;
  airports: Airport[];
  gateways: Gateway[];
  /** Country facts by ISO code (public/data/countries.json), for resolving names typed in the long-stay box. */
  countries: Record<string, CountryInfo>;
  /** Cities with an airport (public/data/cities.json), for the "must include" and "only these cities" pickers. */
  cities: Record<string, City>;
  /** The free-form extras of every mode (see TripsExtra). */
  extra: TripsExtra;
  onExtra: (e: TripsExtra) => void;
  homeLabel: string;
  /** Where the traveller starts, as an itinerary place: the converters put it first and last. */
  originPlace?: ItinPlace;
  /** Turn a result into an itinerary: the globe opens the itinerary view with this skeleton. */
  onItinerary: (s: Skeleton) => void;
  /** Shown above the mode row: the visitor's saved itineraries, when there are any. */
  top?: ReactNode;
  airlines: Record<string, string>;
  // the camera along the route
  playing: number | null;
  onPlay: () => void;
  onStopPlay: () => void;
  onFocusStop: (i: number) => void;
  // short loops
  trips: TripsResult | null;
  selectedTrip: string | null;
  onTrip: (id: string | null) => void;
  days: number;
  onDays: (d: number) => void;
  homeHolidays: Holiday[];
  around: string | null;
  onAround: (d: string | null) => void;
  // wild loops
  wild: WildState;
  wildRegion: string;
  onWildRegion: (r: string) => void;
  wildNights: number;
  onWildNights: (n: number) => void;
  wildStyle: string;
  onWildStyle: (s: string) => void;
  wildBudget: string;
  onWildBudget: (b: string) => void;
  wildTradeoff: string;
  onWildTradeoff: (t: string) => void;
  wildVariants: number;
  onWildVariants: (n: number) => void;
  wildPeriod: Period;
  onWildPeriod: (p: Period) => void;
  onWild: () => void;
  onWildAlternative: (i: number) => void;
  plan: PlanState;
  onPlan: () => void;
  // long stay: the form lives in Globe state, so coming back to the mode shows what produced the results
  longStay: LongStayState;
  longStayForm: LongStayForm;
  onLongStayForm: (f: LongStayForm) => void;
  onLongStay: (q: LongStayQuery) => void;
  selectedBase: string | null;
  onBase: (code: string | null) => void;
  // group: the same, the members and windows carry ids used as keys
  group: GroupState;
  groupForm: GroupForm;
  onGroupForm: (f: GroupForm) => void;
  onGroup: (q: GroupSearch) => void;
  selectedOption: number | null;
  onOption: (i: number | null) => void;
  /** How many countries the Been filter excludes (0 when off): the forms show a one-line note. */
  excludedCount: number;
  // the graph walk: the Smart loop of Short loops and "Walk the region" of Wild loops run it; the globe draws it live
  walk: WalkState;
  onSmartLoop: () => void;
  onWildWalk: () => void;
  /** Whether the walk can reach the Wild region: its first search is the cheapest fares out of home, which stay near home, so a far region gets the classic builder. */
  wildWalkReach: boolean;
  onWalkSelect: (i: number) => void;
};

/** A short loop in the shape of a wild trip, so the strip, cards and rows draw both. */
export function shortLoopRoute(trip: Trip, homeLabel: string): { stops: WildStop[]; legs: WildLeg[] } {
  const n = trip.cities.length;
  const total = Math.max(n, trip.nights);
  // The trip only knows its total nights: share them out, the remainder to the first city.
  const per = Math.floor(total / n);
  let date = trip.outDate.slice(0, 10);
  const stops: WildStop[] = trip.cities.map((c, i) => {
    const nights = per + (i < total - per * n ? 1 : 0);
    const arrive = date;
    date = addDays(date, nights);
    return { code: c.code, name: c.name, country: c.country, lat: c.lat, lon: c.lon, arrive, depart: date, nights, perDay: 0 };
  });
  const legs: WildLeg[] = trip.legs.map((l, i): WildLeg => {
    if (l.kind === "fly") {
      const first = i === 0;
      return { kind: "fly", from: l.from, to: l.to, fromName: first ? homeLabel : l.fromName, toName: first ? l.toName : homeLabel, date: l.date.slice(0, 10), departAt: l.date, arriveAt: l.date, price: l.price, hours: Math.round(l.minutes / 6) / 10, stops: l.transfers, route: [l.from, l.to], carriers: l.airline ? [l.airline] : [], url: l.url };
    }
    const from = stops.find((s) => s.code === l.from);
    return { kind: "ground", from: l.from, to: l.to, fromName: l.fromName, toName: l.toName, date: from?.depart ?? "", minutes: l.minutes, mode: l.mode, estimated: false, price: 0 };
  });
  return { stops, legs };
}

// Chips and inputs speak the visitor's calendar: local date parts, never the UTC day.
const iso = localIso;

/**
 * Two dates with quick chips. Used by the Wild mode and when the chat asks for a period.
 * windowDays: when set, a window wider than that says so (the Wild engine searches the first
 * ten departure days); the chat's pick passes nothing, its dates mean what they say.
 */
export function PeriodPicker({ value, onChange, onDone, doneLabel, windowDays }: { value: Period; onChange: (p: Period) => void; onDone?: (p: Period) => void; doneLabel?: string; windowDays?: number }) {
  const today = new Date();
  const toSat = (6 - today.getDay() + 7) % 7 || 7;
  const sat = new Date(today.getTime() + toSat * 86_400_000);
  // Days until the coming Monday: 1 on a Sunday, 7 on a Monday, never a week more.
  const toMon = (8 - today.getDay()) % 7 || 7;
  const nextMon = new Date(today.getTime() + toMon * 86_400_000);
  const quick: { label: string; p: Period }[] = [
    { label: "This weekend", p: { from: iso(new Date(sat.getTime() - 86_400_000)), to: iso(new Date(sat.getTime() + 2 * 86_400_000)) } },
    { label: "Next week", p: { from: iso(nextMon), to: iso(new Date(nextMon.getTime() + 6 * 86_400_000)) } },
    // Ten days wide, the most the Wild engine searches, so the chip never promises more than it looks at.
    { label: "A month from now", p: { from: iso(new Date(today.getTime() + 28 * 86_400_000)), to: iso(new Date(today.getTime() + 38 * 86_400_000)) } },
    { label: "Anytime", p: { from: "", to: "" } },
  ];
  const wide = !!windowDays && !!value.from && !!value.to && daysBetween(value.from, value.to) > windowDays;
  const same = (a: Period, b: Period) => a.from === b.from && a.to === b.to;
  return (
    <div className="period">
      <div className="chips">
        {quick.map((q) => (
          <button key={q.label} className={`chip ghost${same(value, q.p) ? " on" : ""}`} onClick={() => onChange(q.p)}>
            {q.label}
          </button>
        ))}
      </div>
      <div className="form">
        <input className="search" type="date" value={value.from} min={todayIso()} onChange={(e) => onChange({ from: e.target.value, to: value.to && value.to < e.target.value ? e.target.value : value.to })} aria-label="Leave from" />
        <input className="search" type="date" value={value.to} min={value.from || todayIso()} onChange={(e) => onChange({ from: value.from, to: e.target.value })} aria-label="Leave by" />
        {onDone && (
          <button className="chip on" onClick={() => onDone(value)}>
            {doneLabel ?? "Use these dates"}
          </button>
        )}
      </div>
      <div className="status muted">{value.from && value.to ? `Leave between ${dateRange(value.from, value.to)}${wide ? `; only the first ${windowDays} days are searched` : ""}.` : value.from ? `Leave on ${shortDate(value.from)} or ${windowDays ? `in the ${windowDays} days after` : "later"}.` :"No dates: the cheapest departure in the next weeks, or the month from the When pill."}</div>
    </div>
  );
}

/** Which months a base is pleasant, from its monthly highs and rain. */
function ClimateStrip({ climate }: { climate: NonNullable<LongStayBase["climate"]> }) {
  // Rain arrives as mm a day from some sources and mm a month from others; a year whose
  // wettest month is under 30 can only be the daily kind.
  const perDay = Math.max(...climate.rain) < 30;
  const scores = climate.tmax.map((t, i) => climateScore(t, (climate.rain[i] ?? 0) * (perDay ? 30 : 1)));
  const best = new Set(scores.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 4).filter(([s]) => s >= 0.6).map(([, i]) => i));
  return (
    <div className="climate" title="Best months to be there, from monthly highs and rain">
      {MONTH_LETTERS.map((m, i) => (
        <span key={i} className={`cm${best.has(i) ? " best" : ""}`} style={{ opacity: 0.35 + 0.65 * (scores[i] ?? 0) }} title={`${climate.tmax[i]}°, ${climate.rain[i]} mm`}>
          {m}
        </span>
      ))}
    </div>
  );
}

function BaseCard({ b, active, onClick, onItinerary, itinLabel }: { b: LongStayBase; active: boolean; onClick: () => void; onItinerary: () => void; itinLabel?: string }) {
  return (
    <div className={`basecard${active ? " active" : ""}`} onClick={onClick}>
      <StopPhoto name={b.name} country={b.country} className="base" />
      <div className="basebody">
        <div className="cardtop">
          <span className="cardtitle">
            {b.name}
            <span className="sub">{countryName(b.country)}</span>
          </span>
          <span className="price">
            {euro(b.total)}
            <span className="sub">
              {b.months} month{b.months === 1 ? "" : "s"}
            </span>
          </span>
        </div>
        <div className="basegrid">
          <span>
            <b>{euro(b.perDay)}</b> a day
          </span>
          <span>
            <b>{euro(b.rent)}</b> rent a month
          </span>
          <span>
            <b>{euro(b.monthlyLiving)}</b> living a month
          </span>
          <span>
            <b>{b.flightIn && b.flightOut ? euro(b.flightIn.price + b.flightOut.price) : "?"}</b> flights
          </span>
        </div>
        {(b.flightIn || b.flightOut) && (
          <div className="sub" style={{ whiteSpace: "normal" }}>
            {b.flightIn && (
              <a href={b.flightIn.url} target="_blank" rel="noreferrer">
                In {shortDate(b.flightIn.date)} from {b.flightIn.from} {euro(b.flightIn.price)} ↗
              </a>
            )}
            {b.flightIn && b.flightOut ? " · " : ""}
            {b.flightOut && (
              <a href={b.flightOut.url} target="_blank" rel="noreferrer">
                Out {shortDate(b.flightOut.date)} to {b.flightOut.to} {euro(b.flightOut.price)} ↗
              </a>
            )}
          </div>
        )}
        {b.climate && <ClimateStrip climate={b.climate} />}
        <div className="badges">
          {b.visa && <span className="badge direct">{b.visa}</span>}
          {b.why.slice(0, 3).map((w) => (
            <span key={w} className="badge heritage">
              {w}
            </span>
          ))}
        </div>
        {active && b.sideTrips.length > 0 && (
          <div className="sidetrips">
            <span className="muted">Side trips: </span>
            {b.sideTrips.slice(0, 5).map((s) => `${s.name} ${formatDuration(s.minutes)} ${s.mode === "plane" ? "flight" : s.mode}`).join(" · ")}
          </div>
        )}
        {active && (
          <div className="chips">
            <ItineraryButton onClick={onItinerary} label={itinLabel} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A row of chips that wraps. Past `max` chips the rest hide behind a "more" chip, so a long
 * row (fourteen regions) never pushes the form down a screen; a chosen chip is always shown.
 */
export function MoreChips({ chips, max = 8 }: { chips: { key: string; label: string; on?: boolean; ghost?: boolean; title?: string; onClick: () => void }[]; max?: number }) {
  const [all, setAll] = useState(false);
  const hidden = chips.length - max;
  const shown = all || hidden <= 1 ? chips : chips.filter((c, i) => i < max || c.on);
  return (
    <div className="chips">
      {shown.map((c) => (
        <button key={c.key} className={`chip${c.ghost ? " ghost" : ""}${c.on ? " on" : ""}`} onClick={c.onClick} title={c.title}>
          {c.label}
        </button>
      ))}
      {hidden > 1 && (
        <button className="chip ghost more" onClick={() => setAll(!all)}>
          {all ? "fewer" : `${chips.length - shown.length} more`}
        </button>
      )}
    </div>
  );
}

/** Chosen things as chips with a cross, before a search box. */
function ChosenChips({ items, onRemove }: { items: { key: string; label: string }[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="chips">
      {items.map((it) => (
        <button key={it.key} className="chip ghost on" onClick={() => onRemove(it.key)} title="remove">
          {it.label} ×
        </button>
      ))}
    </div>
  );
}

/** A country multi-select by name: type, pick from the list, the chosen ones become chips. Codes are ISO2. */
export function CountryPick({ countries, value, onChange, placeholder, max = 8, inputRef }: { countries: Record<string, CountryInfo>; value: string[]; onChange: (codes: string[]) => void; placeholder?: string; max?: number; inputRef?: Ref<HTMLInputElement> }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const s = plain(q);
    if (s.length < 2) return [];
    const out: { code: string; name: string }[] = [];
    for (const [code, info] of Object.entries(countries)) {
      if (value.includes(code)) continue;
      const name = info.name || countryName(code);
      const intl = countryName(code);
      if (code.toLowerCase() === s || plain(name).startsWith(s) || plain(intl).startsWith(s) || plain(name).includes(` ${s}`)) out.push({ code, name });
      if (out.length >= 6) break;
    }
    return out;
  }, [q, countries, value]);
  const add = (code: string) => {
    if (value.length < max && !value.includes(code)) onChange([...value, code]);
    setQ("");
  };
  return (
    <div className="pickbox-inline">
      <ChosenChips items={value.map((c) => ({ key: c, label: countryName(c) }))} onRemove={(c) => onChange(value.filter((x) => x !== c))} />
      <div className="airportpick">
        <input
          ref={inputRef}
          className="search"
          placeholder={placeholder ?? "add a country: Vietnam, Georgia, Peru"}
          value={q}
          aria-label="Add a country"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              add(hits[0].code);
            }
          }}
        />
        {hits.length > 0 && (
          <div className="hits">
            {hits.map((h) => (
              <button key={h.code} className="hit" onClick={() => add(h.code)}>
                <span className="code">{h.code}</span> {h.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A city multi-select by name from cities.json: the chosen ones become chips, the value is their codes. */
export function CityPick({ cities, value, onChange, placeholder, max = 6 }: { cities: Record<string, City>; value: string[]; onChange: (codes: string[]) => void; placeholder?: string; max?: number }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => {
    const s = plain(q);
    if (s.length < 2) return [];
    const out: { code: string; name: string; country: string; pop: number }[] = [];
    for (const [code, c] of Object.entries(cities)) {
      if (value.includes(code)) continue;
      const n = plain(c.name);
      if (n.startsWith(s) || n.includes(` ${s}`) || code.toLowerCase() === s) out.push({ code, name: c.name, country: c.country, pop: c.pop ?? 0 });
    }
    return out.sort((a, b) => b.pop - a.pop).slice(0, 6);
  }, [q, cities, value]);
  const add = (code: string) => {
    if (value.length < max && !value.includes(code)) onChange([...value, code]);
    setQ("");
  };
  return (
    <div className="pickbox-inline">
      <ChosenChips items={value.map((c) => ({ key: c, label: cities[c]?.name ?? c }))} onRemove={(c) => onChange(value.filter((x) => x !== c))} />
      <div className="airportpick">
        <input
          className="search"
          placeholder={placeholder ?? "add a city: Hanoi, Tbilisi, Cusco"}
          value={q}
          aria-label="Add a city"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              add(hits[0].code);
            }
          }}
        />
        {hits.length > 0 && (
          <div className="hits">
            {hits.map((h) => (
              <button key={h.code} className="hit" onClick={() => add(h.code)}>
                <span className="code">{h.code}</span> {h.name} <span className="muted">{countryName(h.country)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A small airport search: type a code or city, pick from the list. */
function AirportPick({ airports, onPick }: { airports: Airport[]; onPick: (a: Airport) => void }) {
  const [q, setQ] = useState("");
  const hits = useMemo(() => searchAirports(airports, q), [airports, q]);
  return (
    <div className="airportpick">
      <input
        className="search"
        placeholder="add an airport: Cluj, BCN, Lisbon"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            onPick(hits[0]);
            setQ("");
          }
        }}
      />
      {hits.length > 0 && (
        <div className="hits">
          {hits.slice(0, 5).map((a) => (
            <button
              key={a.iata}
              className="hit"
              onClick={() => {
                onPick(a);
                setQ("");
              }}
            >
              <span className="code">{a.iata}</span> {a.city ?? a.name} <span className="muted">{countryName(a.country)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupEditor({ airports, defaults, form, onForm, state, onSearch, budget, onBudget }: { airports: Airport[]; defaults: string[]; form: GroupForm; onForm: (f: GroupForm) => void; state: GroupState; onSearch: (q: GroupSearch) => void; budget: number; onBudget: (n: number) => void }) {
  const { members, minNights, maxNights, where, direct } = form;
  // The visitor's airports fill the first member once, when they are known. The flag lives in
  // the form, so a member the visitor emptied on purpose is never refilled, not on a later
  // render and not on coming back to this mode.
  const defaultsKey = defaults.join(",");
  useEffect(() => {
    if (form.defaultsApplied || !defaults.length || !form.members[0]) return;
    const first = form.members[0];
    const filled = first.origins.length ? first : { ...first, origins: defaults.slice(0, 2) };
    onForm({ ...form, members: [filled, ...form.members.slice(1)], defaultsApplied: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultsKey, form.defaultsApplied]);
  const set = (patch: Partial<GroupForm>) => onForm({ ...form, ...patch });
  const update = (id: string, m: Partial<GroupMemberForm>) => set({ members: members.map((x) => (x.id === id ? { ...x, ...m } : x)) });
  const ready = members.length >= 2 && members.every((m) => m.name.trim() && m.origins.length && m.available.every((w) => w.from && w.to && w.to >= w.from));
  return (
    <div className="groupeditor">
      {members.map((m) => (
        <div key={m.id} className="member">
          <div className="form">
            <input className="search" value={m.name} onChange={(e) => update(m.id, { name: e.target.value })} placeholder="Name" aria-label="Member name" style={{ flex: "0 0 120px" }} />
            <div className="chips" style={{ flex: 1, alignItems: "center" }}>
              {m.origins.map((o) => (
                <button key={o} className="chip ghost on" onClick={() => update(m.id, { origins: m.origins.filter((x) => x !== o) })} title="remove">
                  {o} ×
                </button>
              ))}
              {m.origins.length < 3 && <AirportPick airports={airports} onPick={(a) => update(m.id, { origins: [...new Set([...m.origins, a.iata])] })} />}
            </div>
            {members.length > 2 && (
              <button className="chip ghost" onClick={() => set({ members: members.filter((x) => x.id !== m.id) })} title="Remove this person">
                ×
              </button>
            )}
          </div>
          {m.available.map((w, k) => (
            <div key={w.id} className="form">
              <span className="muted" style={{ alignSelf: "center", fontSize: 13, flex: "0 0 60px" }}>
                {k === 0 ? "free" : "or"}
              </span>
              <input className="search" type="date" value={w.from} min={todayIso()} onChange={(e) => update(m.id, { available: m.available.map((x) => (x.id === w.id ? { ...x, from: e.target.value, to: x.to < e.target.value ? e.target.value : x.to } : x)) })} aria-label="Available from" />
              <input className="search" type="date" value={w.to} min={w.from} onChange={(e) => update(m.id, { available: m.available.map((x) => (x.id === w.id ? { ...x, to: e.target.value } : x)) })} aria-label="Available to" />
              {m.available.length > 1 && (
                <button className="chip ghost" onClick={() => update(m.id, { available: m.available.filter((x) => x.id !== w.id) })}>
                  ×
                </button>
              )}
            </div>
          ))}
          {m.available.length < 3 && (
            <button className="linkbtn" onClick={() => update(m.id, { available: [...m.available, defaultWindow()] })}>
              + another free window
            </button>
          )}
        </div>
      ))}
      <div className="chips">
        {members.length < 6 && (
          <button className="chip ghost" onClick={() => set({ members: [...members, { id: newId(), name: "", origins: [], available: [defaultWindow()] }] })}>
            + Add a person
          </button>
        )}
      </div>
      <div className="form wrap">
        <select className="search" style={{ flex: "1 1 110px" }} value={minNights} onChange={(e) => set({ minNights: Number(e.target.value) })} aria-label="Minimum nights">
          {[1, 2, 3, 4, 5, 6, 7, 10, 14].map((n) => (
            <option key={n} value={n}>
              {n}+ nights
            </option>
          ))}
        </select>
        <select className="search" style={{ flex: "1 1 110px" }} value={maxNights} onChange={(e) => set({ maxNights: Number(e.target.value) })} aria-label="Maximum nights">
          {[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30].map((n) => (
            <option key={n} value={n}>
              up to {n}
            </option>
          ))}
        </select>
        <button className={`chip${direct ? " on" : ""}`} onClick={() => set({ direct: !direct })}>
          Direct
        </button>
      </div>
      <div className="form wrap">
        <input className="search" style={{ flex: "2 1 180px" }} placeholder="where: anywhere, Italy, Lisbon, the Balkans" value={where} onChange={(e) => set({ where: e.target.value })} aria-label="Where to meet" />
        <input className="search" style={{ flex: "1 1 130px" }} type="number" min={0} step={10} placeholder="budget a person, €" value={budget || ""} onChange={(e) => onBudget(Math.max(0, Number(e.target.value) || 0))} aria-label="Budget per person in euros" />
      </div>
      <div className="chips">
        <button
          className="chip on"
          disabled={!ready || state.status === "loading"}
          onClick={() =>
            // The engine gets plain members: the ids are the editor's own.
            onSearch({ members: members.map((m) => ({ name: m.name.trim(), origins: m.origins, available: m.available.map(({ from, to }) => ({ from, to })) })), minNights, maxNights: Math.max(minNights, maxNights), where: where.trim() || undefined, direct: direct || undefined, ...(budget > 0 ? { budgetPerPerson: budget } : {}) })
          }
        >
          {state.status === "loading" ? "Searching…" : "Find where to meet"}
        </button>
      </div>
      <div className="status muted">Everyone's airports and free windows; the search finds the dates when all can go (or the fewest compromises) and the cities cheapest for the whole group. One live search per person per place, bounded.</div>
    </div>
  );
}

/** The one action every result shares: turn it into a day-by-day itinerary. stopPropagation keeps a card's own click (select or close) out of it. */
/** The longest trip one plan holds: the planner (lib/itinerary-server.ts MAX_DAYS) writes at most 60 days, so 59 nights. */
export const PLAN_MAX_NIGHTS = 59;
/** Whether a trip is longer than one plan holds (a long stay of two months or more, a long wild loop). */
export function overPlanLimit(sk: Skeleton): boolean {
  return !!sk.start && !!sk.end && daysBetween(sk.start, sk.end) > PLAN_MAX_NIGHTS;
}
/**
 * A trip too long for one plan, cut to its first four weeks so the planner can write it:
 * the stops that begin inside them (the last one shortened), the legs dated inside them,
 * and a title that says so. Anything that fits is returned as it is.
 */
export function firstWeeks(sk: Skeleton): Skeleton {
  if (!overPlanLimit(sk)) return sk;
  const end = addDays(sk.start, 28);
  const stops = sk.stops.filter((st) => st.arrive < end).map((st) => (st.leave > end ? { ...st, leave: end, nights: daysBetween(st.arrive, end) } : st));
  const legs = sk.legs.filter((l) => (l.date || sk.start) < end);
  return { ...sk, title: `${sk.title}: the first four weeks`, end, nights: daysBetween(sk.start, end), stops, legs };
}
/** The button's words for a trip: a long one says it plans the first four weeks. */
function itinLabel(sk: Skeleton): string | undefined {
  return overPlanLimit(sk) ? "Plan the first four weeks" : undefined;
}

export function ItineraryButton({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      className="chip itinbtn"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="A day-by-day plan: what to see, where to eat, what it costs; save it, share it, put it in your calendar"
    >
      <span aria-hidden="true">✦</span> {label ?? "Make an itinerary"}
    </button>
  );
}

function PlayButton({ playing, onPlay, onStop }: { playing: number | null; onPlay: () => void; onStop: () => void }) {
  return playing == null ? (
    <button className="chip on play" onClick={onPlay} title="Fly the camera from home through every stop">
      ▶ Play the route
    </button>
  ) : (
    <button className="chip ghost play" onClick={onStop}>
      ■ Stop
    </button>
  );
}

const SMART_STYLES: { key: SmartStyle; label: string; hint: string }[] = [
  { key: "cheapest", label: "Cheapest", hint: "The lowest total; an hour on a train or a plane counts for little" },
  { key: "unique", label: "Unique", hint: "Smaller cities and hidden gems weighted up, the biggest hubs weighted down" },
  { key: "balanced", label: "Balanced", hint: "Money and hours weighed evenly" },
];
const PER_STOP: { key: string; label: string }[] = [
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "2-3", label: "2 to 3" },
];

/** What a walk started from this builder is doing: its last progress lines while it runs, then its loops as rows. */
function WalkStatus({ walk, mine, onSelect, homeLabel, idle }: { walk: WalkState; mine: boolean; onSelect: (i: number) => void; homeLabel: string; idle: string }) {
  if (!mine || walk.status === "idle") return <div className="status muted">{idle}</div>;
  const lines = walk.lines.slice(-3);
  return (
    <>
      {walk.status === "loading" && (
        <div className="answer compact" aria-live="polite">
          {lines.length === 0 && <p className="muted">Asking where the cheap flights go from your airports…</p>}
          {lines.map((l, i) => (
            <p key={walk.lines.length - lines.length + i} className={i === lines.length - 1 ? "" : "muted"}>
              {l}
            </p>
          ))}
        </div>
      )}
      {walk.status === "error" && <div className="status">{walk.note ?? "The walk failed."}</div>}
      {walk.status === "ok" && !walk.loops.length && <div className="status">{walk.result?.note ?? "No loop closed inside these dates. Try more nights or another window."}</div>}
      {walk.loops.length > 0 && <WalkLoopList loops={walk.loops} selected={walk.selected} onSelect={onSelect} homeLabel={homeLabel} />}
    </>
  );
}

/**
 * The Smart loop: the graph walk from the traveller's door, the way the owner searches by
 * hand (an explore search from home, the cheapest next hops from each stop, the cheapest way
 * home to any of his airports). The form lives in Globe state (TripsExtra.smart); the globe
 * runs the walk and draws it as it thinks.
 */
function SmartLoop({ form, onForm, walk, onRun, onSelect, countries, cities, homeLabel, month }: { form: SmartForm; onForm: (patch: Partial<SmartForm>) => void; walk: WalkState; onRun: () => void; onSelect: (i: number) => void; countries: Record<string, CountryInfo>; cities: Record<string, City>; homeLabel: string; month: string | null }) {
  const mine = walk.source === "short";
  const loading = mine && walk.status === "loading";
  const today = todayIso();
  const when = form.from && form.to ? null : month ? `Leaving in ${monthLabel(month)} (the When pill); pick dates to choose.` : "Leaving in the next three weeks; pick dates to choose.";
  const perStopMin = Number(form.perStop.split("-")[0]) || 2;
  const short = form.cities * Number(form.perStop.split("-").pop() || perStopMin) < form.minNights;
  return (
    <div className="smartloop">
      <h2>Smart loop</h2>
      <div className="status">The cheapest places from your airports, then cheap hops by plane, train or coach from each, and the cheapest way home to any of your airports. Watch the globe while it thinks.</div>
      <div className="chips">
        <select className="search slim" value={form.minNights} onChange={(e) => { const n = Number(e.target.value); onForm({ minNights: n, maxNights: Math.max(n, form.maxNights) }); }} aria-label="Fewest nights">
          {[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14].map((n) => (
            <option key={n} value={n}>
              {n} nights
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12.5, alignSelf: "center" }}>
          to
        </span>
        <select className="search slim" value={form.maxNights} onChange={(e) => { const n = Number(e.target.value); onForm({ maxNights: n, minNights: Math.min(n, form.minNights) }); }} aria-label="Most nights">
          {[2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16].map((n) => (
            <option key={n} value={n}>
              {n} nights
            </option>
          ))}
        </select>
      </div>
      <div className="chips">
        <span className="muted" style={{ fontSize: 12.5, alignSelf: "center" }}>
          Nights a stop:
        </span>
        {PER_STOP.map((x) => (
          <button key={x.key} className={`chip ghost${form.perStop === x.key ? " on" : ""}`} onClick={() => onForm({ perStop: x.key })}>
            {x.label}
          </button>
        ))}
      </div>
      <div className="chips">
        {[2, 3, 4].map((n) => (
          <button key={n} className={`chip ghost${form.cities === n ? " on" : ""}`} onClick={() => onForm({ cities: n })} title="The most cities the loop visits">
            up to {n} cities
          </button>
        ))}
      </div>
      <div className="chips" role="radiogroup" aria-label="What to favour">
        {SMART_STYLES.map((st) => (
          <button key={st.key} role="radio" aria-checked={form.style === st.key} className={`chip ghost${form.style === st.key ? " on" : ""}`} onClick={() => onForm({ style: st.key })} title={st.hint}>
            {st.label}
          </button>
        ))}
      </div>
      <div className="form wrap">
        <input className="search" type="date" value={form.from} min={today} onChange={(e) => onForm({ from: e.target.value, to: form.to && form.to < e.target.value ? "" : form.to })} aria-label="Leave from" style={{ flex: "1 1 130px" }} />
        <input className="search" type="date" value={form.to} min={form.from || today} onChange={(e) => onForm({ to: e.target.value })} aria-label="Back by" style={{ flex: "1 1 130px" }} />
      </div>
      {when && <div className="status muted">{when}</div>}
      <CountryPick countries={countries} value={form.avoid} onChange={(v) => onForm({ avoid: v })} placeholder="countries to skip: Germany, Austria" max={8} />
      {form.avoid.length > 0 && (
        <div className="chips">
          <button className={`chip ghost${form.avoidLike ? " on" : ""}`} aria-pressed={!!form.avoidLike} onClick={() => onForm({ avoidLike: !form.avoidLike })} title="Germany brings Austria and Switzerland with it, Belgium the Netherlands and Luxembourg, Sweden the other Nordics.">
            and countries like them
          </button>
        </div>
      )}
      <CityPick cities={cities} value={form.mustInclude} onChange={(v) => onForm({ mustInclude: v })} placeholder="a city to pass through: Gdansk, Porto" max={2} />
      <select className="search slim" value={form.budget} onChange={(e) => onForm({ budget: Number(e.target.value) })} aria-label="Live searches">
        {[
          [0, "fares already seen only, no live search"],
          [6, "up to 6 live searches"],
          [12, "up to 12 live searches"],
          [20, "up to 20 live searches"],
        ].map(([n, label]) => (
          <option key={n} value={n}>
            {label}
          </option>
        ))}
      </select>
      {short && <div className="status muted">{form.cities} cities of {form.perStop.replace("-", " to ")} nights cannot fill {form.minNights} nights; the walk will say so. Allow more cities or more nights a stop.</div>}
      <div className="chips">
        <button className="chip on" onClick={onRun} disabled={loading}>
          {loading ? "Walking…" : mine && walk.status === "ok" ? "Walk again" : "Find my loop"}
        </button>
      </div>
      <WalkStatus walk={walk} mine={mine} onSelect={onSelect} homeLabel={homeLabel} idle="Fewer live searches when the fare memory already knows the way; the loops draw on the globe as they close." />
    </div>
  );
}

export default function TripsPanel(p: TripsPanelProps) {
  const months = useMemo(monthOptions, []);
  // The long-stay form is Globe state (see TripsPanelProps); this is only a short hand.
  const ls = p.longStayForm;
  const setLs = (patch: Partial<LongStayForm>) => p.onLongStayForm({ ...ls, ...patch });
  // Country names to codes: the data file's names and the browser's own English names, both
  // plain (lower case, no accents), so "Türkiye", "Turkey" and "turkiye" all resolve to TR.
  const countryIndex = useMemo(() => countryIndexOf(p.countries), [p.countries]);
  const lsCountries = useMemo(() => resolveCountries(ls.countries, countryIndex.index, countryIndex.known), [ls.countries, countryIndex]);
  // Typed something, recognised nothing: the box says so and the search waits.
  const lsBlocked = ls.countries.trim().length > 0 && lsCountries.codes.length === 0;
  // Tri-state start: null follows the When pill, "" is "whenever is cheapest" chosen on purpose.
  const lsStart = ls.start ?? p.month ?? "";
  const shortTrip = p.mode === "short" && p.selectedTrip ? (p.trips?.trips.find((t) => t.id === p.selectedTrip) ?? null) : null;
  const shortRoute = useMemo(() => (shortTrip ? shortLoopRoute(shortTrip, p.homeLabel) : null), [shortTrip, p.homeLabel]);
  const wt = p.wild.trip;
  const ex = p.extra;
  const setWildForm = (patch: Partial<WildForm>) => p.onExtra({ ...ex, wild: { ...ex.wild, ...patch } });
  // "My own countries" has nothing to set; it puts the cursor in the country box below.
  const wildCountryBox = useRef<HTMLInputElement>(null);
  const setShortForm = (patch: Partial<ShortForm>) => p.onExtra({ ...ex, short: { ...ex.short, ...patch } });
  const setSmartForm = (patch: Partial<SmartForm>) => p.onExtra({ ...ex, smart: { ...ex.smart, ...patch } });
  // A far region keeps the classic builder even with the toggle on: the walk could not reach it.
  const wildWalkOn = ex.wild.walk && p.wildWalkReach;
  const wildWalking = wildWalkOn && p.walk.source === "wild";
  // Shown on every form that searches with the exclude list, so the visitor knows why a country is missing.
  const beenNote = p.excludedCount > 0 ? <div className="status muted been-note">Only new countries: {p.excludedCount} excluded; layovers still allowed.</div> : null;

  return (
    <>
      {p.top}
      <div className="modes" role="tablist">
        {TRIP_MODES.map((m) => (
          <button key={m.key} role="tab" aria-selected={p.mode === m.key} className={`mode${p.mode === m.key ? " on" : ""}`} onClick={() => p.onMode(m.key)} title={m.hint}>
            {m.label}
          </button>
        ))}
      </div>

      {p.mode === "short" && (
        <div className="scroll fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {beenNote}
          <SmartLoop form={ex.smart} onForm={setSmartForm} walk={p.walk} onRun={p.onSmartLoop} onSelect={p.onWalkSelect} countries={p.countries} cities={p.cities} homeLabel={p.homeLabel} month={p.month} />
          <h2>From tonight&apos;s fares</h2>
          <div className="status">Fly out, hop between cities by train or coach, fly home from the last one. Ranked by countries and cities per euro and hour.</div>
          <div className="chips">
            {SHORT_DAYS.map((d) => (
              <button key={d} className={`chip${p.days === d ? " on" : ""}`} onClick={() => p.onDays(d)}>
                {d} nights
              </button>
            ))}
          </div>
          {p.homeHolidays.length > 0 && (
            <div className="chips">
              {p.homeHolidays.map((h) => (
                <button key={h.date} className={`chip ghost${p.around === h.date ? " on" : ""}`} onClick={() => p.onAround(p.around === h.date ? null : h.date)} title={h.name}>
                  {shortDate(h.date)} · {h.localName}
                </button>
              ))}
            </div>
          )}
          <div className="chips">
            {[2, 3, 4].map((n) => (
              <button key={n} className={`chip ghost${ex.short.cities === n ? " on" : ""}`} onClick={() => setShortForm({ cities: n })} title="How many cities the loop visits">
                {n} cities
              </button>
            ))}
            <select className="search slim" value={ex.short.maxGroundHours} onChange={(e) => setShortForm({ maxGroundHours: Number(e.target.value) })} aria-label="Longest ground hop">
              {[2, 3, 4, 5, 6, 8, 10].map((h) => (
                <option key={h} value={h}>
                  hops under {h} h
                </option>
              ))}
            </select>
          </div>
          <h2>Must include · only these countries</h2>
          <CityPick cities={p.cities} value={ex.short.mustInclude} onChange={(v) => setShortForm({ mustInclude: v })} placeholder="a city the loop must pass: Porto, Kraków" max={1} />
          <CountryPick countries={p.countries} value={ex.short.countries} onChange={(v) => setShortForm({ countries: v })} placeholder="only these countries: Portugal, Spain" max={6} />
          {shortTrip && shortRoute && (
            <div className="tripview">
              <HeroNumbers
                items={[
                  { value: euro(shortTrip.price), label: "flights", accent: true },
                  { value: String(shortTrip.nights), label: "nights" },
                  { value: String(shortTrip.countries), label: shortTrip.countries === 1 ? "country" : "countries" },
                  { value: hoursLabel(shortTrip.travelHours), label: "door to door" },
                ]}
              />
              <RouteStrip stops={shortRoute.stops} legs={shortRoute.legs} homeLabel={p.homeLabel} activeIndex={p.playing} onStop={p.onFocusStop} />
              <div className="chips">
                <PlayButton playing={p.playing} onPlay={p.onPlay} onStop={p.onStopPlay} />
                <ItineraryButton onClick={() => p.onItinerary(skeletonFromTrip(shortTrip, p.originPlace))} />
                <button className="chip ghost" onClick={() => p.onTrip(null)}>
                  Close
                </button>
              </div>
              <div className="status">
                {dateRange(shortTrip.outDate, shortTrip.backDate)}. Flights are one-way fares as found; train and coach tickets come on top.
              </div>
              <LegRows legs={shortRoute.legs} />
            </div>
          )}
          <h2>Trips · {p.trips?.trips.length ?? 0}</h2>
          <div className="status">
            {!p.trips
              ? "Searching flights out, trains between, flights home…"
              : p.trips.status === "no-token"
                ? "Multi-city trips need cached one-way fares for these airports; none yet."
                : p.trips.status === "error"
                  ? `Trip search failed: ${p.trips.note}`
                  : p.trips.trips.length === 0
                    ? "No trip found for these nights. Try another length."
                    : ""}
          </div>
          {p.trips?.trips.map((t) => (
            <div key={t.id} className={`row${t.id === p.selectedTrip ? " active" : ""}`} onClick={() => p.onTrip(t.id === p.selectedTrip ? null : t.id)}>
              <span className="code">{euro(t.price)}</span>
              <span>
                <div className="name">{t.cities.map((c) => c.name).join(" → ")}</div>
                <div className="sub">
                  {t.nights} nights · {t.countries} countr{t.countries === 1 ? "y" : "ies"} · {t.travelHours} h travel
                </div>
              </span>
              <span className="meta">
                <strong>{shortDate(t.outDate)}</strong>
              </span>
            </div>
          ))}
        </div>
      )}

      {p.mode === "wild" && (
        <div className="scroll fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="status">Fly out (through a cheaper hub when that wins), chain cheap one-way flights and border hops through a far region, fly home from the last city. Live fares, estimated living costs, a second opinion.</div>
          {beenNote}
          <h2>Where · tap a region on the globe, or here</h2>
          <MoreChips
            max={8}
            chips={[
              ...WILD_REGIONS.map((r) => ({ key: r.key, label: r.label, on: p.wildRegion === r.key && ex.wild.countries.length === 0, onClick: () => p.onWildRegion(r.key) })),
              { key: "custom", label: "My own countries", ghost: true, on: ex.wild.countries.length > 0, title: "Pick the countries below instead of a region", onClick: () => wildCountryBox.current?.focus() },
            ]}
          />
          <CountryPick countries={p.countries} value={ex.wild.countries} onChange={(v) => setWildForm({ countries: v })} placeholder="or only these countries: Vietnam, Laos, Cambodia" max={8} inputRef={wildCountryBox} />
          {ex.wild.countries.length > 0 && <div className="status muted">Region: custom, {ex.wild.countries.map(countryName).join(", ")}. Clear the chips to go back to a region.</div>}
          <h2>Must include</h2>
          <CityPick cities={p.cities} value={ex.wild.mustInclude} onChange={(v) => setWildForm({ mustInclude: v })} placeholder="a city the loop must pass: Hanoi, Luang Prabang" max={4} />
          <h2>What you are after</h2>
          <div className="chips">
            {WILD_STYLES.map((st) => (
              <button key={st.key} className={`chip ghost${p.wildStyle === st.key ? " on" : ""}`} onClick={() => p.onWildStyle(st.key)} title={st.hint}>
                {st.label}
              </button>
            ))}
          </div>
          <textarea className="search wishes" rows={2} maxLength={WISHES_MAX} placeholder="what matters to you, in your words: slow mornings, a night train, no hostels, one beach week" value={ex.wild.wishes} onChange={(e) => setWildForm({ wishes: e.target.value.slice(0, WISHES_MAX) })} aria-label="What matters to you" />
          {ex.wild.wishes.length >= WISHES_MAX - 60 && <div className="status muted">{WISHES_MAX - ex.wild.wishes.length} characters left</div>}
          <div className="chips">
            {WILD_BUDGETS.map((b) => (
              <button key={b.key} className={`chip ghost${p.wildBudget === b.key ? " on" : ""}`} onClick={() => p.onWildBudget(b.key)}>
                {b.label}
              </button>
            ))}
            {[
              ["price", "Cheapest"],
              ["balanced", "Balanced"],
              ["comfort", "Comfort"],
            ].map(([k, label]) => (
              <button key={k} className={`chip ghost${p.wildTradeoff === k ? " on" : ""}`} onClick={() => p.onWildTradeoff(k)} title="How to trade euros for hours: comfort pays more for short flights and few stops">
                {label}
              </button>
            ))}
            <button className={`chip ghost${p.wildVariants > 1 ? " on" : ""}`} onClick={() => p.onWildVariants(p.wildVariants > 1 ? 1 : 3)} title="Build the balanced, cheapest and comfortable versions and rank them">
              {p.wildVariants > 1 ? "3 versions, ranked" : "1 version"}
            </button>
          </div>
          <h2>Flights and airports</h2>
          <div className="chips">
            <select className="search slim" value={ex.wild.maxHours} onChange={(e) => setWildForm({ maxHours: Number(e.target.value) })} aria-label="Longest single flight">
              <option value={0}>flights of any length</option>
              {[3, 4, 6, 8, 10, 12, 16].map((h) => (
                <option key={h} value={h}>
                  no flight over {h} h
                </option>
              ))}
            </select>
            {p.gateways.slice(0, 4).map((g) => (
              <button key={g.airport.iata} className={`chip ghost${ex.wild.startFrom.includes(g.airport.iata) ? " on" : ""}`} onClick={() => setWildForm({ startFrom: ex.wild.startFrom.includes(g.airport.iata) ? ex.wild.startFrom.filter((x) => x !== g.airport.iata) : [...ex.wild.startFrom, g.airport.iata].slice(0, 3) })} title={`start from ${g.airport.name}`}>
                {g.airport.iata}
              </button>
            ))}
            {ex.wild.startFrom
              .filter((c) => !p.gateways.slice(0, 4).some((g) => g.airport.iata === c))
              .map((c) => (
                <button key={c} className="chip ghost on" onClick={() => setWildForm({ startFrom: ex.wild.startFrom.filter((x) => x !== c) })} title="remove">
                  {c} ×
                </button>
              ))}
            {ex.wild.startFrom.length < 3 && <AirportPick airports={p.airports} onPick={(a) => setWildForm({ startFrom: [...new Set([...ex.wild.startFrom, a.iata])].slice(0, 3) })} />}
          </div>
          <div className="status muted">{ex.wild.startFrom.length ? `Starts from ${ex.wild.startFrom.join(", ")}.` : "Starts from your own airports; pick others to start elsewhere."}</div>
          <h2>How long</h2>
          <div className="slider">
            <input type="range" min={WILD_MIN_NIGHTS} max={WILD_MAX_NIGHTS} step={1} value={p.wildNights} onChange={(e) => p.onWildNights(Number(e.target.value))} aria-label="Nights" />
            <b>
              {p.wildNights}
              <small> nights</small>
            </b>
          </div>
          <div className="chips">
            {[7, 10, 14, 21, 30, 45, 60, 90].map((n) => (
              <button key={n} className={`chip ghost${p.wildNights === n ? " on" : ""}`} onClick={() => p.onWildNights(n)}>
                {n}
              </button>
            ))}
          </div>
          <div className="status muted">{p.wildNights >= 45 ? "Long trips: 5 to 7 bases of 8 to 12 nights." : p.wildNights >= 21 ? "About four to five stops." : "Two or three nights a stop."}</div>
          <div className="chips">
            <span className="muted" style={{ fontSize: 12.5, alignSelf: "center" }}>
              Nights a stop:
            </span>
            <button className={`chip ghost${ex.wild.stopNights === null ? " on" : ""}`} onClick={() => setWildForm({ stopNights: null })}>
              let the engine choose
            </button>
            {(
              [
                [2, 3],
                [3, 5],
                [5, 8],
                [8, 12],
              ] as [number, number][]
            ).map(([a, b]) => (
              <button key={a} className={`chip ghost${ex.wild.stopNights?.[0] === a && ex.wild.stopNights?.[1] === b ? " on" : ""}`} onClick={() => setWildForm({ stopNights: [a, b] })}>
                {a} to {b}
              </button>
            ))}
          </div>
          <h2>When to leave</h2>
          <PeriodPicker value={p.wildPeriod} onChange={p.onWildPeriod} windowDays={WILD_WINDOW_DAYS} />
          <div className="chips">
            <button
              className={`chip ghost${wildWalkOn ? " on" : ""}`}
              aria-pressed={wildWalkOn}
              disabled={!p.wildWalkReach}
              onClick={() => setWildForm({ walk: !ex.wild.walk })}
              title={p.wildWalkReach ? "Search the way you would by hand: the cheapest places from home, cheap hops between the region's cities by plane, train or coach, the cheapest way home. Up to six stops." : "This region is too far for the walk: it starts from the cheapest fares out of home, and those stay close to home. Build the loop instead."}
            >
              Walk the region
            </button>
            {wildWalkOn ? (
              <button className="chip on" onClick={p.onWildWalk} disabled={wildWalking && p.walk.status === "loading"}>
                {wildWalking && p.walk.status === "loading" ? "Walking…" : wildWalking && p.walk.status === "ok" ? "Walk again" : "Find the loop"}
              </button>
            ) : (
              <button className="chip on" onClick={p.onWild} disabled={p.wild.status === "loading"}>
                {p.wild.status === "loading" ? "Building…" : p.wild.status === "ok" ? "Build again" : "Build the loop"}
              </button>
            )}
            {!wildWalkOn && p.wild.status === "ok" && wt && <PlayButton playing={p.playing} onPlay={p.onPlay} onStop={p.onStopPlay} />}
            {!wildWalkOn && p.wild.status === "ok" && wt && <ItineraryButton onClick={() => p.onItinerary(skeletonFromWild(wt))} label={itinLabel(skeletonFromWild(wt))} />}
          </div>
          {wildWalkOn && <WalkStatus walk={p.walk} mine={wildWalking} onSelect={p.onWalkSelect} homeLabel={p.homeLabel} idle="The walk keeps to the region's countries after the way in, which may land in a big hub outside them. Up to six stops; the loops draw on the globe as they are found." />}
          {ex.wild.walk && !p.wildWalkReach && <div className="status muted">This region is too far for the walk, which starts from the cheapest fares out of home. The loop is built the classic way.</div>}
          {!wildWalkOn && p.wild.status === "loading" && (
            <div className="answer">
              {p.wild.lines.map((l, i) => (
                <p key={i} className={i === p.wild.lines.length - 1 ? "" : "muted"}>
                  {l}
                </p>
              ))}
              {p.wild.lines.length === 0 && <p className="muted">Starting the search: about forty live fare searches, one to two minutes.</p>}
            </div>
          )}
          {!wildWalkOn && p.wild.status === "error" && <div className="status">{p.wild.note}</div>}
          {!wildWalkOn && p.wild.status === "idle" && <div className="status muted">The first build of a loop takes a minute or two; the next visitor asking the same gets it at once.</div>}
          {!wildWalkOn && p.wild.status === "ok" && wt && (
            <div className="tripview">
              <HeroNumbers
                items={[
                  { value: euro(wt.totals.all), label: "all in", accent: true },
                  { value: euro(wt.totals.perDay), label: "a day" },
                  { value: String(wt.totals.nights), label: "nights" },
                  { value: String(wt.totals.countries), label: wt.totals.countries === 1 ? "country" : "countries" },
                  { value: `${wt.totals.hoursInAir} h`, label: "in transit" },
                ]}
              />
              <RouteStrip stops={wt.stops} legs={wt.legs} homeLabel={p.homeLabel} activeIndex={p.playing} onStop={p.onFocusStop} />
              <div className="status">
                {wt.title}. {dateRange(wt.outDate, wt.backDate)}. Flights {euro(wt.totals.flights)}
                {wt.totals.ground ? `, border hops about ${euro(wt.totals.ground)}` : ""}, living about {euro(wt.totals.living)} (hotel, food, local transport, one activity a day, from the country's price level).
              </div>
              {wt.judge && (
                <div className="judge">
                  <div className="scorebox">
                    <span className={`score ${wt.judge.score >= 70 ? "good" : wt.judge.score >= 45 ? "mid" : "low"}`}>{wt.judge.score}</span>
                    <span className="sub">worth it?</span>
                  </div>
                  <div className="verdict">
                    <p>{wt.judge.verdict}</p>
                    <ul>
                      {wt.judge.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                    {wt.judge.tweaks.length > 0 && (
                      <ul className="tweaks">
                        {wt.judge.tweaks.map((r, i) => (
                          <li key={i}>{r}</li>
                        ))}
                      </ul>
                    )}
                    <div className="sub">Best for: {wt.judge.bestFor}</div>
                  </div>
                </div>
              )}
              {wt.alternatives && wt.alternatives.length > 0 && (
                <div className="section">
                  <h2>Ranked against each other</h2>
                  <div className="row active">
                    <span className="code">#1</span>
                    <span>
                      <div className="name">
                        {wt.variant ?? "Best"}: {wt.title}
                      </div>
                      <div className="sub">
                        {euro(wt.totals.all)} · {euro(wt.totals.perDay)} a day · {wt.totals.hoursInAir} h in transit · judge {wt.judge?.score ?? "?"}
                      </div>
                    </span>
                    <span className="meta">shown</span>
                  </div>
                  {wt.alternatives.map((alt, i) => (
                    <div key={alt.variant} className="row" onClick={() => p.onWildAlternative(i)}>
                      <span className="code">#{alt.rank}</span>
                      <span>
                        <div className="name">
                          {alt.variant}: {alt.title}
                        </div>
                        <div className="sub">
                          {euro(alt.totals.all)} · {euro(alt.totals.perDay)} a day · {alt.totals.hoursInAir} h in transit · judge {alt.judge?.score ?? "?"}
                        </div>
                      </span>
                      <span className="meta">open</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="section">
                <h2>The stops</h2>
                <StopCards stops={wt.stops} activeIndex={p.playing} onStop={p.onFocusStop} />
              </div>
              <div className="section">
                <h2>The route</h2>
                <LegRows legs={wt.legs} />
                <div className="status muted">Fares found on Kiwi.com just now ({wt.searched} searches); they move. Living costs are estimates for a careful traveller, not quotes.</div>
              </div>
              <div className="section">
                <h2>The days</h2>
                {p.plan.status === "idle" && (
                  <>
                    <button className="chip on" onClick={p.onPlan}>
                      Plan the days: experiences, food, costs
                    </button>
                    <div className="status muted">What you actually do at each stop, what to eat and where, what each day costs, and what a month there would cost. From the Wikivoyage guides, the live web and the model; about a minute.</div>
                  </>
                )}
                {p.plan.status === "loading" && <div className="status">Reading the guides for every stop and writing the days…</div>}
                {p.plan.status === "error" && <div className="status">{p.plan.note}</div>}
                {p.plan.status === "ok" && p.plan.plan && (
                  <>
                    <div className="answer">
                      {p.plan.plan.highlights.map((h, i) => (
                        <p key={i}>{h}</p>
                      ))}
                    </div>
                    <div className="days">
                      {p.plan.plan.days.map((d) => (
                        <div key={d.date} className="day">
                          <div className="dayhead">
                            <span className="code">{shortDate(d.date)}</span>
                            <b>{d.city}</b>
                            <span className="sub">{d.title}</span>
                          </div>
                          {d.items.map((it, i) => (
                            <div key={i} className={`item ${it.kind}`}>
                              <span className="when">{it.when ?? ""}</span>
                              <span className="what">
                                {it.what}
                                {it.note && <span className="note"> {it.note}</span>}
                              </span>
                              <span className="cost">{it.cost != null ? (it.cost ? `€${it.cost}` : "free") : ""}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <h2>Eat like a local</h2>
                    {p.plan.plan.food.map((f) => (
                      <div key={f.city} className="foodcard">
                        <b>
                          {f.city}, {f.country}
                        </b>
                        <p>{f.dishes.join(" · ")}</p>
                        <p className="muted">Where: {f.where.join(" · ")}</p>
                        {f.dessert && <p className="muted">Sweet: {f.dessert}</p>}
                        {f.priceNote && <p className="muted">{f.priceNote}</p>}
                      </div>
                    ))}
                    <h2>If you stayed a month</h2>
                    {p.plan.plan.monthly.map((m) => (
                      <div key={m.city} className="row">
                        <span className="code">€{m.total}</span>
                        <span>
                          <div className="name">
                            {m.city}, {m.country}
                          </div>
                          <div className="sub">
                            rent about €{m.rent} · food about €{m.food}
                            {m.note ? ` · ${m.note}` : ""}
                          </div>
                        </span>
                        <span className="meta">a month</span>
                      </div>
                    ))}
                    <div className="status muted">Plan total about €{p.plan.plan.total} on the ground, flights aside. Sources: {p.plan.plan.sources.join("; ")}. Items marked verify are the model's memory, not the guide.</div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {p.mode === "longstay" && (
        <div className="scroll fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="status">One base for a month or more: the flight in, the flight out, rent, living, all in and per day, ranked. Side trips from the base and the months when it is pleasant.</div>
          {beenNote}
          <h2>Where · tap a region on the globe, or here</h2>
          <MoreChips max={8} chips={WILD_REGIONS.map((r) => ({ key: r.key, label: r.label, on: p.wildRegion === r.key, onClick: () => p.onWildRegion(r.key) }))} />
          <input className="search" placeholder="or only these countries: Thailand, Vietnam (names or codes)" value={ls.countries} onChange={(e) => setLs({ countries: e.target.value })} aria-label="Only these countries" />
          {ls.countries.trim() && (
            <div className={`status${lsBlocked ? "" : " muted"}`}>
              {lsBlocked
                ? `No country recognised in "${ls.countries.trim()}". Type names (Thailand, Vietnam) or codes (TH, VN), separated by commas.`
                : `${lsCountries.codes.map(countryName).join(", ")}${lsCountries.unresolved.length ? `; not recognised: ${lsCountries.unresolved.join(", ")}` : ""}`}
            </div>
          )}
          <h2>Only these cities · what matters</h2>
          <CityPick cities={p.cities} value={ex.longStay.cities} onChange={(v) => p.onExtra({ ...ex, longStay: { ...ex.longStay, cities: v } })} placeholder="only these cities: Chiang Mai, Da Nang" max={6} />
          <textarea className="search wishes" rows={2} maxLength={WISHES_MAX} placeholder="what matters: fast wifi, a beach in walking distance, cool nights, a gym" value={ex.longStay.wishes} onChange={(e) => p.onExtra({ ...ex, longStay: { ...ex.longStay, wishes: e.target.value.slice(0, WISHES_MAX) } })} aria-label="What matters to you" />
          {ex.longStay.wishes.length >= WISHES_MAX - 60 && <div className="status muted">{WISHES_MAX - ex.longStay.wishes.length} characters left</div>}
          <h2>How long and when</h2>
          <div className="chips">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <button key={n} className={`chip${ls.months === n ? " on" : ""}`} onClick={() => setLs({ months: n })}>
                {n} month{n === 1 ? "" : "s"}
              </button>
            ))}
          </div>
          <div className="form wrap">
            <select className="search" style={{ flex: "1 1 170px" }} value={lsStart} onChange={(e) => setLs({ start: e.target.value })} aria-label="Start month">
              <option value="">start whenever is cheapest</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  from {monthLabel(m)}
                </option>
              ))}
            </select>
            {WILD_BUDGETS.map((b) => (
              <button key={b.key} className={`chip ghost${ls.budget === b.key ? " on" : ""}`} onClick={() => setLs({ budget: b.key })}>
                {b.label}
              </button>
            ))}
          </div>
          <div className="chips">
            <button className="chip on" disabled={p.longStay.status === "loading" || lsBlocked} onClick={() => p.onLongStay({ months: ls.months, startMonth: lsStart || undefined, budget: ls.budget, countries: lsCountries.codes, cities: ex.longStay.cities, wishes: ex.longStay.wishes.trim() || undefined })}>
              {p.longStay.status === "loading" ? "Pricing bases…" : p.longStay.status === "ok" ? "Search again" : "Find my base"}
            </button>
          </div>
          {p.longStay.status === "idle" && <div className="status muted">A handful of live fare searches per country, half a minute or so.</div>}
          {p.longStay.status === "loading" && <div className="answer">Pricing the way in and out of each candidate base, the rent and the living costs…</div>}
          {p.longStay.status === "error" && <div className="status">{p.longStay.note}</div>}
          {p.longStay.status === "ok" && p.longStay.result && (
            <>
              {p.longStay.result.bases.length === 0 && <div className="status">No base priced for this region and start. Try another month.</div>}
              {p.longStay.result.partial && (
                <div className="status">
                  {p.longStay.result.failed} live search{p.longStay.result.failed === 1 ? " was" : "es were"} refused (prices rate-limited right now), so a base may be missing a flight. Try again in a few minutes.
                </div>
              )}
              {p.longStay.result.bases.map((b) => {
                // A stay over 59 nights is planned for its first four weeks (the globe cuts it the same way on open).
                const sk = skeletonFromLongStay(b, p.originPlace);
                return <BaseCard key={b.code} b={b} active={p.selectedBase === b.code} onClick={() => p.onBase(p.selectedBase === b.code ? null : b.code)} onItinerary={() => p.onItinerary(sk)} itinLabel={itinLabel(sk)} />;
              })}
              {p.longStay.result.skipped && p.longStay.result.skipped.length > 0 && (
                <div className="status muted">Left out: {p.longStay.result.skipped.map((s) => `${countryName(s.country)} (${s.reason})`).join(" · ")}.</div>
              )}
              <div className="status muted">
                {p.longStay.result.searched} live searches on Kiwi.com. {p.longStay.result.note ?? "Rent and living are estimates from price levels, not quotes."}
              </div>
            </>
          )}
        </div>
      )}

      {p.mode === "group" && (
        <div className="scroll fade" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="status">Friends in different cities, one place to meet: the dates everyone can make and the cities cheapest for the whole group, with each person's fare.</div>
          {beenNote}
          <GroupEditor airports={p.airports} defaults={p.gateways.slice(0, 2).map((g) => g.airport.iata)} form={p.groupForm} onForm={p.onGroupForm} state={p.group} onSearch={p.onGroup} budget={ex.group.budgetPerPerson} onBudget={(n) => p.onExtra({ ...ex, group: { budgetPerPerson: n } })} />
          {p.group.status === "error" && <div className="status">{p.group.note}</div>}
          {p.group.status === "ok" && p.group.result && (
            <>
              <h2>When everyone can</h2>
              {p.group.result.windows.length === 0 && <div className="status">No shared window. Loosen someone's dates.</div>}
              {p.group.result.partial && (
                <div className="status">
                  {p.group.result.failed} live search{p.group.result.failed === 1 ? " was" : "es were"} refused (prices rate-limited right now), so a city or a fare may be missing. Try again in a few minutes.
                </div>
              )}
              {p.group.result.windows.slice(0, 6).map((w, i) => (
                <div key={i} className="row" style={{ cursor: "default" }}>
                  <span className="code">{w.nights}n</span>
                  <span>
                    <div className="name">{dateRange(w.from, w.to)}</div>
                    <div className="sub">{w.everyone ? "everyone is free" : w.compromises.join("; ")}</div>
                    {(w.late?.length || w.early?.length) ? (
                      <div className="badges">
                        {w.late?.map((n) => (
                          <span key={`late-${n}`} className="badge warm" title="free from the second day">
                            late: {n}
                          </span>
                        ))}
                        {w.early?.map((n) => (
                          <span key={`early-${n}`} className="badge warm" title="free until the day before the end">
                            early: {n}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </span>
                  <span className="meta">{w.everyone ? "all" : "compromise"}</span>
                </div>
              ))}
              <h2>Where to meet · {p.group.result.options.length}</h2>
              {p.group.result.options.length === 0 && <div className="status">No city priced for everyone in those windows.</div>}
              {p.group.result.options.map((o, i) => (
                <div key={`${o.dstCity}|${o.window.from}|${o.window.to}`} className={`groupcard${p.selectedOption === i ? " active" : ""}`} onClick={() => p.onOption(p.selectedOption === i ? null : i)}>
                  <StopPhoto name={o.city} country={o.country} className="base" />
                  <div className="basebody">
                    <div className="cardtop">
                      <span className="cardtitle">
                        {o.city}
                        <span className="sub">{countryName(o.country)}</span>
                      </span>
                      <span className="price">
                        {euro(o.total)}
                        <span className="sub">all together</span>
                      </span>
                    </div>
                    <div className="sub">
                      {dateRange(o.window.from, o.window.to)} · {o.window.nights} nights{o.window.everyone ? "" : " · a compromise"}
                    </div>
                    <div className="members">
                      {/* Keyed by index: two members may share a name, and the rows never reorder. */}
                      {o.perMember.map((m, k) =>
                        m.url ? (
                          <a key={k} className="memberrow" href={m.url} target="_blank" rel="noreferrer">
                            <b>{m.name}</b>
                            <span className="sub">
                              {m.from} · {dateRange(m.out, m.back)}
                              {m.note ? ` · ${m.note}` : ""}
                            </span>
                            <span className="fare">{euro(m.price)} ↗</span>
                          </a>
                        ) : (
                          // Already in the city ("at home"): nothing to book, nothing to pay, no link.
                          <div key={k} className="memberrow home">
                            <b>{m.name}</b>
                            <span className="sub">
                              {m.from}
                              {m.note ? ` · ${m.note}` : ""}
                            </span>
                            <span className="fare">{euro(m.price)}</span>
                          </div>
                        ),
                      )}
                    </div>
                    {p.selectedOption === i && (
                      <div className="chips">
                        {/* The first member is the visitor ("You" by default): the itinerary follows their fare. */}
                        <ItineraryButton onClick={() => p.onItinerary(skeletonFromGroup(o, 0))} />
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div className="status muted">{p.group.result.searched} live searches on Kiwi.com; fares move. A note such as "leaves a day earlier" means that person's cheapest fare sits a day outside the shared window.</div>
            </>
          )}
        </div>
      )}

    </>
  );
}
