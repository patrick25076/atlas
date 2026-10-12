"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Airport, City, Gateway } from "@/lib/types";
import { formatDuration } from "@/lib/geo";
import { countryName, dateRange, euro, hoursLabel, localIso, shortDate, todayIso } from "@/lib/format";
import { readNdjson } from "@/lib/boards-client";
import { eventsAt } from "@/lib/purpose-events";
import type { EventSpot } from "@/lib/ui-types";
import { searchAirports } from "./TopBar";
import { StopPhoto } from "./RouteStrip";
import type { RouteLeg as EngineLeg, RouteOption as EngineOption, RouteResult } from "@/lib/route-finder";

// The cheapest way from A to B, as a capability of the whole app rather than a mode of one
// tab: a compact card floating on the map (RouteCard, the default export) that the command
// line, the chat (atlas:route, atlas:route-result) and every "Get there" block open; the
// "Get there" block itself (GetThere), shown on deal and place pages; and the events worth
// flying for as cards on the map (EventsCard) and a list on place pages (WorthFlyingFor).
// The route state and the fetch live in Globe.tsx like every other search, so the globe can
// draw the option the visitor taps; this file is the cards.

/**
 * The engine's own types (lib/route-finder.ts, the route stream's file); a type-only import
 * is erased at build time, so none of its server-side imports reach the browser bundle.
 * A leg may carry the coordinates of its ends (a station has no code the globe knows); the
 * engine does not send them yet, and the globe draws from codes and the two ends until it does.
 */
export type RouteLeg = EngineLeg & { fromLat?: number; fromLon?: number; toLat?: number; toLon?: number };
export type RouteOption = Omit<EngineOption, "legs" | "back"> & { legs: RouteLeg[]; back?: RouteLeg[] };
export type RouteOptionKind = RouteOption["kind"];
export type RouteEnd = RouteResult["from"];
export type { RouteResult };

/**
 * The form as the visitor fills it; depart is YYYY-MM-DD, maxHours 0 means no limit. harder
 * raises the live search budget from the gentle default to the engine's own (more hubs
 * tried, more of Kiwi's burst allowance spent).
 */
export type RouteForm = { from: string; to: string; depart: string; flex: number; nights: number; oneWay: boolean; maxHours: number; harder: boolean };
/** budget: the live searches the answer on show was allowed (0 is the fare memory and the timetable graph only), so the card can offer the next step up. */
export type RouteState = { status: "idle" | "loading" | "ok" | "error"; lines: string[]; options: RouteOption[]; result?: RouteResult; note?: string; query?: RouteForm; budget?: number };

/**
 * Live Kiwi searches one click may spend: the main window costs one, every hub two one-ways
 * (four for a return). Twelve covers the main search and two or three hubs; two such clicks
 * stay under Kiwi's burst throttle, which would otherwise shut every tool for five minutes.
 * The first answer anywhere is ROUTE_BUDGET_FREE: the fare memory and the ground graph, no
 * live search at all, in about a second; "Search live" then spends the twelve.
 */
export const ROUTE_BUDGET_FREE = 0;
export const ROUTE_BUDGET = 12;
export const ROUTE_BUDGET_HARDER = 24;

export function emptyRouteForm(): RouteForm {
  return { from: "", to: "", depart: localIso(new Date(Date.now() + 14 * 86_400_000)), flex: 2, nights: 4, oneWay: false, maxHours: 0, harder: false };
}

/** "Brașov", "brasov" and "BRASOV" are one key: lower case, no accents, as the engine folds names. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const KIND_LABEL: Record<RouteOptionKind, string> = {
  direct: "Straight there",
  "nearby-airports": "From or to a nearby airport",
  "ground-then-fly": "Train or coach first, then fly",
  "fly-then-ground": "Fly, then finish by land",
  "via-hub": "Through a hub, two tickets",
  "open-jaw": "Open jaw",
  "ground-only": "No flight at all",
};
const LEG_WORD: Record<RouteLeg["kind"], string> = { fly: "flight", train: "train", coach: "coach", ferry: "ferry", road: "by road", walk: "walk" };

/** Two cities or airports are the same option when the legs match; used to spot the cheapest and fastest in a streaming list. */
export function optionKey(o: RouteOption): string {
  return `${o.kind}|${o.legs.map((l) => `${l.kind}:${l.from}>${l.to}:${l.date ?? ""}`).join(",")}`;
}

type PlaceHit = { label: string; sub: string; value: string };

/**
 * One box for a place: type a city, a town with an airport or an airport code; pick from the
 * list, or press Enter for the first hit. The value sent is what /api/route resolves itself:
 * a city name or an airport code.
 */
function PlacePick({ value, onChange, placeholder, airports, cities, label }: { value: string; onChange: (v: string) => void; placeholder: string; airports: Airport[]; cities: Record<string, City>; label: string }) {
  const [q, setQ] = useState(value);
  const [open, setOpen] = useState(false);
  // Set by a pick, cleared by typing: the list hides after a choice, never while the visitor types.
  const [chosen, setChosen] = useState(false);
  useEffect(() => setQ(value), [value]);
  const cityList = useMemo(() => Object.entries(cities).map(([code, c]) => ({ code, ...c })), [cities]);
  const hits = useMemo<PlaceHit[]>(() => {
    const s = fold(q);
    if (s.length < 2 || chosen) return [];
    const byCity = cityList
      .filter((c) => {
        const n = fold(c.name);
        return n.startsWith(s) || n.includes(` ${s}`);
      })
      .sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0))
      .slice(0, 5)
      .map((c) => ({ label: c.name, sub: `${countryName(c.country)} · ${c.airports.slice(0, 2).join(", ")}`, value: c.name }));
    const byAirport = searchAirports(airports, q)
      .slice(0, 4)
      .map((a) => ({ label: `${a.iata} · ${a.city ?? a.name}`, sub: `${a.name}, ${countryName(a.country)}`, value: a.iata }));
    const seen = new Set<string>();
    return [...byCity, ...byAirport].filter((h) => (seen.has(h.value) ? false : (seen.add(h.value), true))).slice(0, 7);
  }, [q, chosen, cityList, airports]);
  const pick = (h: PlaceHit) => {
    onChange(h.value);
    setQ(h.value);
    setChosen(true);
    setOpen(false);
  };
  return (
    <div className="airportpick placepick">
      <input
        className="search"
        placeholder={placeholder}
        value={q}
        aria-label={label}
        onChange={(e) => {
          setQ(e.target.value);
          setChosen(false);
          setOpen(true);
          // Free text is a valid answer too: the route resolves names and codes itself.
          onChange(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            pick(hits[0]);
          }
        }}
      />
      {open && hits.length > 0 && (
        <div className="hits">
          {hits.map((h) => (
            <button key={h.value} className="hit" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
              <span className="code">{h.label}</span> <span className="muted">{h.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A leg as a pill in the strip: the mode, the price (or the time for an unpriced ground hop), estimated marked. */
function LegPill({ leg }: { leg: RouteLeg }) {
  const fly = leg.kind === "fly";
  const title = `${leg.fromName} to ${leg.toName}, ${LEG_WORD[leg.kind]}${leg.date ? `, ${shortDate(leg.date)}` : ""}${leg.carrier ? `, ${leg.carrier}` : ""}${leg.estimated ? ", estimated" : ""}${leg.note ? `. ${leg.note}` : ""}`;
  const body = (
    <>
      <span className="glyph" aria-hidden="true">
        {fly ? (
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
          </svg>
        ) : leg.kind === "ferry" ? (
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M20 21c-1.4 0-2.6-.5-3.5-1.2-.9.7-2.1 1.2-3.5 1.2s-2.6-.5-3.5-1.2C8.6 20.5 7.4 21 6 21H4v-2h2c1.4 0 2.6-.6 3.5-1.5.9.9 2.1 1.5 3.5 1.5s2.6-.6 3.5-1.5c.9.9 2.1 1.5 3.5 1.5h2v2h-2zM3.9 16.3L2 10.7l1.9-.6L6 11.3V6a1 1 0 0 1 1-1h3V3h4v2h3a1 1 0 0 1 1 1v5.3l2.1-1.2 1.9.6-1.9 5.6c-1.6-.3-3-1-4.1-2-1.1 1-2.5 1.7-4 1.7s-2.9-.7-4-1.7c-1.1 1-2.5 1.7-4.1 2zM8 7v3.6l4-1.4 4 1.4V7H8z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M4 16a2 2 0 0 0 1 1.73V19a1 1 0 0 0 2 0v-1h10v1a1 1 0 0 0 2 0v-1.27A2 2 0 0 0 20 16V6a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3zm3-10h10a1 1 0 0 1 1 1v4H6V7a1 1 0 0 1 1-1zm0 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm10 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
          </svg>
        )}
      </span>
      <b>{leg.price != null ? `${leg.estimated ? "~" : ""}${euro(leg.price)}` : formatDuration(leg.minutes)}</b>
      <small>
        {leg.price != null ? formatDuration(leg.minutes) : LEG_WORD[leg.kind]}
        {leg.estimated ? " est." : ""}
      </small>
    </>
  );
  return leg.url ? (
    <a className={`legpill ${fly ? "fly" : "ground"}`} href={leg.url} target="_blank" rel="noreferrer" title={title}>
      {body}
    </a>
  ) : (
    <span className={`legpill ${fly ? "fly" : "ground"}`} title={title}>
      {body}
    </span>
  );
}

/** The whole option as a strip: place, pill, place, pill, place. */
function LegStrip({ legs }: { legs: RouteLeg[] }) {
  return (
    <div className="routestrip compact" role="list">
      {legs.map((l, i) => (
        <span key={i} className="legseq" role="listitem">
          {i === 0 && <span className="place">{l.fromName}</span>}
          <LegPill leg={l} />
          <span className="place">{l.toName}</span>
        </span>
      ))}
    </div>
  );
}

function OptionCard({ o, active, cheapest, fastest, onClick, onItinerary }: { o: RouteOption; active: boolean; cheapest: boolean; fastest: boolean; onClick: () => void; onItinerary?: () => void }) {
  // Only a leg the engine marked is an estimate: a return flight on the same ticket has no
  // price of its own (its fare is in the outbound leg) and is still a real fare.
  const est = [...o.legs, ...(o.back ?? [])].some((l) => l.estimated);
  const remembered = o.legs.some((l) => l.remembered);
  return (
    <div className={`routecard${active ? " active" : ""}`} onClick={onClick}>
      <div className="cardtop">
        <span className="cardtitle">
          {o.title}
          <span className="sub">
            {KIND_LABEL[o.kind]} · {hoursLabel(o.hours)} door to door · {o.stops === 0 ? "no change" : `${o.stops} change${o.stops === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="price">
          {est ? "~" : ""}
          {euro(o.total)}
          {/* total is the whole trip: both ways when the option has a way back. backTotal is
              not shown, the engine gives it a different meaning per kind. */}
          <span className="sub">{o.back ? "return" : "one way"}</span>
        </span>
      </div>
      <div className="badges">
        {cheapest && <span className="badge direct">cheapest</span>}
        {fastest && <span className="badge warm">fastest</span>}
        {remembered && <span className="badge heritage">a fare seen this week</span>}
        {est && !remembered && <span className="badge heritage">some legs estimated</span>}
      </div>
      <LegStrip legs={o.legs} />
      {o.back && o.back.length > 0 && active && (
        <>
          <div className="sub">The way back</div>
          <LegStrip legs={o.back} />
        </>
      )}
      {o.why && active && <div className="sub why">{o.why}</div>}
      {active && (
        <div className="legrows">
          {[...o.legs, ...(o.back ?? [])].map((l, i) => (
            <div key={i} className="row" style={{ cursor: "default" }}>
              <span className="code">{l.price != null ? `${l.estimated ? "~" : ""}${euro(l.price)}` : "?"}</span>
              <span>
                <div className="name">
                  {l.fromName} → {l.toName}
                </div>
                <div className="sub">
                  {l.date ? `${shortDate(l.date)} · ` : ""}
                  {LEG_WORD[l.kind]} · {formatDuration(l.minutes)}
                  {l.carrier ? ` · ${l.carrier}` : ""}
                  {l.estimated ? " · estimated" : ""}
                  {l.note ? ` · ${l.note}` : ""}
                </div>
              </span>
              <span className="meta">
                {l.url ? (
                  <a href={l.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                    Book ↗
                  </a>
                ) : (
                  l.kind.toUpperCase().slice(0, 4)
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {active && onItinerary && (
        <div className="chips">
          <button
            className="chip itinbtn"
            onClick={(e) => {
              e.stopPropagation();
              onItinerary();
            }}
          >
            <span aria-hidden="true">✦</span> Make an itinerary
          </button>
        </div>
      )}
    </div>
  );
}

export type RouteCardProps = {
  form: RouteForm;
  onForm: (f: RouteForm) => void;
  state: RouteState;
  /** budget: undefined lets the globe choose (the free answer first, live only when it found nothing). */
  onSearch: (f: RouteForm, budget?: number) => void;
  onCancel: () => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  /** An option of state.options as an itinerary. */
  onItinerary: (i: number) => void;
  collapsed: boolean;
  onCollapse: (c: boolean) => void;
  onClose: () => void;
  /** Ask the globe for a tap; the picked place lands in "to" through the atlas:picked event. */
  onTapGlobe: () => void;
  tapping: boolean;
  airports: Airport[];
  cities: Record<string, City>;
  gateways: Gateway[];
  homeLabel: string;
  excludedCount: number;
  /** The trip style's tradeoff (lib/prefs.ts): the order of the ways shown. Cheapest first when absent. */
  tradeoff?: "price" | "balanced" | "comfort";
};

/** Euros an hour door to door is worth when the ways are ordered for balance (the walk's balanced hop value) and for comfort. */
const HOUR_EURO = { balanced: 11, comfort: 24 } as const;

/** The route card floating on the map: what was asked, the answer as it streams, the options, a small edit row. */
export default function RouteCard(p: RouteCardProps) {
  const { form, onForm, state } = p;
  const set = (patch: Partial<RouteForm>) => onForm({ ...form, ...patch });
  // The edit row opens by itself when there is nothing to show yet (the card opened empty).
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(false);
  const empty = state.status === "idle";
  // The globe answers a tap with atlas:picked; while the card waits for one, the place goes into "to".
  useEffect(() => {
    if (!p.tapping) return;
    const onPicked = (e: Event) => {
      const det = (e as CustomEvent<{ mode?: string; place?: string }>).detail ?? {};
      if (det.place) onForm({ ...form, to: det.place });
    };
    window.addEventListener("atlas:picked", onPicked);
    return () => window.removeEventListener("atlas:picked", onPicked);
  }, [p.tapping, form, onForm]);
  // A new question (from the command line, the chat or a Get there block) folds the "all ways" list again.
  const asked = `${state.query?.from}|${state.query?.to}|${state.query?.depart}`;
  useEffect(() => setAll(false), [asked]);

  const ready = form.from.trim().length > 1 && form.to.trim().length > 1 && !!form.depart;
  const options = state.options;
  // While the stream runs the cheapest and fastest are read off what has arrived; the final
  // result names them itself.
  const cheapestKey = useMemo(() => {
    const c = state.result?.cheapest ?? (options.length ? options.reduce((a, b) => (b.total < a.total ? b : a)) : null);
    return c ? optionKey(c) : null;
  }, [state.result, options]);
  const fastestKey = useMemo(() => {
    const f = state.result?.fastest ?? (options.length ? options.reduce((a, b) => (b.hours < a.hours ? b : a)) : null);
    return f ? optionKey(f) : null;
  }, [state.result, options]);
  // In the trip style's order: cheapest first, or the total plus the hours at what an hour is
  // worth for balance or comfort. The fastest and the chosen one are always among those shown,
  // the rest behind "all".
  const order = p.tradeoff ?? "price";
  const ranked = useMemo(() => {
    const cost = (o: RouteOption) => (order === "price" ? o.total : o.total + o.hours * HOUR_EURO[order]);
    return options.map((o, i) => ({ o, i })).sort((a, b) => cost(a.o) - cost(b.o) || a.o.total - b.o.total);
  }, [options, order]);
  const shown = all ? ranked : ranked.filter((x, k) => k < 4 || optionKey(x.o) === fastestKey || x.i === p.selected);
  const q = state.query ?? form;
  const fromLabel = state.result?.from.label ?? q.from;
  const toLabel = state.result?.to.label ?? q.to;
  const free = state.budget === 0;
  const loading = state.status === "loading";
  const qReady = q.from.trim().length > 1 && q.to.trim().length > 1;

  return (
    <section className={`mapcard routecardx${p.collapsed ? " collapsed" : ""}`} aria-label="The cheapest way from A to B">
      <header className="mapcardhead">
        <button className="mapcardtitle" onClick={() => p.onCollapse(!p.collapsed)} title={p.collapsed ? "Open the card" : "Fold the card"}>
          <span className="kicker">A to B</span>
          <b>{empty ? "Where to?" : `${fromLabel || "?"} → ${toLabel || "?"}`}</b>
          {!empty && (
            <small>
              {q.depart ? shortDate(q.depart) : ""}
              {q.flex ? ` ±${q.flex}` : ""} · {q.oneWay ? "one way" : `${q.nights} night${q.nights === 1 ? "" : "s"}`}
              {state.status === "ok" && options.length ? ` · ${options.length} option${options.length === 1 ? "" : "s"} from ${euro(Math.min(...options.map((o) => o.total)))}` : ""}
            </small>
          )}
        </button>
        <button className={`iconbtn${editing ? " on" : ""}`} onClick={() => setEditing(!editing)} title="Change the places or dates" aria-pressed={editing}>
          ✎
        </button>
        <button className="iconbtn" onClick={() => p.onCollapse(!p.collapsed)} title={p.collapsed ? "Open" : "Fold"}>
          {p.collapsed ? "▴" : "▾"}
        </button>
        <button className="iconbtn" onClick={p.onClose} title="Close the route card">
          ×
        </button>
      </header>
      {loading && <div className="mapcardbar" aria-hidden="true" />}
      {!p.collapsed && (
        <div className="mapcardbody">
          {(editing || empty) && (
            <div className="routeedit">
              <div className="form">
                <PlacePick value={form.from} onChange={(v) => set({ from: v })} placeholder={p.homeLabel ? `from ${p.homeLabel}` : "from"} airports={p.airports} cities={p.cities} label="From" />
                <PlacePick value={form.to} onChange={(v) => set({ to: v })} placeholder="to: a city, airport or lat,lon" airports={p.airports} cities={p.cities} label="To" />
              </div>
              <div className="form wrap">
                <input className="search" type="date" value={form.depart} min={todayIso()} onChange={(e) => set({ depart: e.target.value })} aria-label="Departure date" style={{ flex: "1 1 130px" }} />
                <select className="search slim" value={form.flex} onChange={(e) => set({ flex: Number(e.target.value) })} aria-label="Days of flexibility">
                  {[0, 1, 2, 3].map((d) => (
                    <option key={d} value={d}>
                      {d === 0 ? "that day" : `± ${d} day${d === 1 ? "" : "s"}`}
                    </option>
                  ))}
                </select>
                <select className="search slim" value={form.oneWay ? 0 : form.nights} onChange={(e) => (Number(e.target.value) === 0 ? set({ oneWay: true }) : set({ oneWay: false, nights: Number(e.target.value) }))} aria-label="Nights there, or one way">
                  <option value={0}>one way</option>
                  {[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} night{n === 1 ? "" : "s"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="chips">
                <button
                  className="chip on"
                  disabled={!ready || loading}
                  onClick={() => {
                    setEditing(false);
                    p.onSearch(form);
                  }}
                >
                  Find the way
                </button>
                <button className={`chip ghost${p.tapping ? " on" : ""}`} onClick={p.onTapGlobe} title="Then tap any city on the globe">
                  {p.tapping ? "Tap the globe…" : "Pick on the globe"}
                </button>
              </div>
            </div>
          )}
          {p.excludedCount > 0 && !empty && <div className="status muted been-note">Only new countries: {p.excludedCount} excluded; connections still allowed.</div>}
          {loading && (
            <div className="answer compact">
              {state.lines.slice(-2).map((l, i, arr) => (
                <p key={i} className={i === arr.length - 1 ? "" : "muted"}>
                  {l}
                </p>
              ))}
              {state.lines.length === 0 && <p className="muted">{state.budget === 0 ? "Reading the fare memory and the timetables…" : "Resolving both places and their airports…"}</p>}
            </div>
          )}
          {state.status === "error" && <div className="status">{state.note ?? "The route search failed."}</div>}
          {state.result?.note && <div className="status">{state.result.note}</div>}
          {options.length === 0 && state.status === "ok" && <div className="status">{free ? "Nothing in the fare memory or the timetables for that. Search the live fares." : "No way found between those two for that date. Widen the flexibility or try the next days."}</div>}
          {options.length > 1 && order !== "price" && <div className="status muted small">Ordered for {order === "comfort" ? "comfort: shorter journeys first" : "balance: money and hours weighed evenly"}, as your trip style says.</div>}
          {shown.map(({ o, i }) => (
            <OptionCard key={optionKey(o) + i} o={o} active={p.selected === i} cheapest={optionKey(o) === cheapestKey} fastest={optionKey(o) === fastestKey} onClick={() => p.onSelect(p.selected === i ? null : i)} onItinerary={() => p.onItinerary(i)} />
          ))}
          {ranked.length > shown.length && (
            <button className="linkbtn" onClick={() => setAll(true)}>
              all {ranked.length} ways
            </button>
          )}
          {!empty && !loading && (
            <div className="chips">
              {(state.budget ?? 0) < ROUTE_BUDGET && (
                <button className="chip on" disabled={!qReady} onClick={() => p.onSearch({ ...form, ...q }, ROUTE_BUDGET)} title={`Up to ${ROUTE_BUDGET} live fare searches on Kiwi.com, about half a minute`}>
                  Search live fares
                </button>
              )}
              {(state.budget ?? 0) >= ROUTE_BUDGET && (state.budget ?? 0) < ROUTE_BUDGET_HARDER && (
                <button className="chip ghost" disabled={!qReady} onClick={() => p.onSearch({ ...form, ...q }, ROUTE_BUDGET_HARDER)} title={`Up to ${ROUTE_BUDGET_HARDER} live searches: more hubs tried, slower, and Kiwi may refuse the next search for a while`}>
                  Search harder
                </button>
              )}
            </div>
          )}
          {loading && (
            <div className="chips">
              <button className="chip ghost" onClick={p.onCancel}>
                Stop
              </button>
            </div>
          )}
          {state.result && !loading && (
            <div className="status muted small">
              {free ? "From the fare memory and the timetable graph, no live search." : `${state.result.searched} live search${state.result.searched === 1 ? "" : "es"}${state.result.failed ? `, ${state.result.failed} refused` : ""}.`} Considered: {state.result.considered.length ? state.result.considered.join(", ") : "nothing beyond the two places"}. Ground prices marked ~ are estimates.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---- Get there: the best way to a place, on every deal and place page ----

/** The query string /api/route reads; budget 0 is the free answer (memory and timetables). */
export function routeParams(q: { from: string; to: string; depart?: string; nights?: number; oneWay?: boolean; flex?: number; maxHours?: number; exclude?: string; budget: number }): URLSearchParams {
  const params = new URLSearchParams({ from: q.from.trim(), to: q.to.trim(), flex: String(q.flex ?? 2), budget: String(q.budget) });
  if (q.depart) params.set("depart", q.depart);
  if (q.oneWay) params.set("oneWay", "1");
  else params.set("nights", String(q.nights ?? 4));
  if (q.maxHours) params.set("maxHours", String(q.maxHours));
  if (q.exclude) params.set("exclude", q.exclude);
  return params;
}

/** One /api/route answer, the stream read to its {done} line; result null when it ended without one. */
export async function fetchRoute(params: URLSearchParams, signal?: AbortSignal, onProgress?: (line: string) => void): Promise<{ result: RouteResult | null; error?: string }> {
  const r = await fetch(`/api/route?${params}`, { signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { result: null, error: j.error ?? `the route search failed (${r.status})` };
  }
  if (!r.headers.get("content-type")?.includes("ndjson")) return { result: (await r.json()) as RouteResult };
  let result: RouteResult | null = null;
  let error: string | undefined;
  await readNdjson<{ progress?: string; done?: RouteResult; error?: string }>(
    r,
    (m) => {
      if (m.progress) onProgress?.(m.progress);
      if (m.done) result = m.done;
      if (m.error) error = m.error;
    },
    signal,
  );
  return { result, error };
}

/** A day the route search accepts: the date asked, or tomorrow when that is today or gone (an event already running). */
function futureDay(d?: string): string | undefined {
  if (!d) return undefined;
  const tomorrow = localIso(new Date(Date.now() + 86_400_000));
  return d < tomorrow ? tomorrow : d;
}

/**
 * The best way from where the traveller is to this place: asked on open with budget 0 (the
 * fare memory and the ground graph, zero live searches, about a second), so every page
 * answers at once; "Search live" spends the card's usual twelve in place; "Open in the route
 * card" hands the answer (or the question) to the card on the map.
 */
export function GetThere({ from, to, toLabel, depart, nights, oneWay, exclude, onOpen }: { from: string; to: string; toLabel?: string; depart?: string; nights?: number; oneWay?: boolean; exclude?: string; onOpen: (q: { from: string; to: string; depart?: string; nights?: number; oneWay?: boolean }, result: RouteResult | null) => void }) {
  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; result?: RouteResult | null; note?: string; budget: number; line?: string }>({ status: "loading", budget: 0 });
  const ctrl = useRef<AbortController | null>(null);
  // No date given (a place page): the card's own default, two weeks out, so the answer is dated like the card's.
  const day = futureDay(depart) ?? emptyRouteForm().depart;
  const same = !from.trim() || !to.trim() || from.trim().toLowerCase() === to.trim().toLowerCase();
  const ask = async (budget: number) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => ({ status: "loading", budget, result: s.result }));
    try {
      const { result, error } = await fetchRoute(routeParams({ from, to, depart: day, nights, oneWay, exclude, budget }), c.signal, (line) => setState((s) => ({ ...s, line })));
      if (c.signal.aborted) return;
      setState({ status: result ? "ok" : "error", result, note: error ?? (result ? undefined : "no answer"), budget });
    } catch (err) {
      if ((err as Error | undefined)?.name === "AbortError") return;
      setState({ status: "error", note: "network", budget });
    }
  };
  useEffect(() => {
    if (same) return;
    setState({ status: "loading", budget: 0 });
    void ask(0);
    return () => ctrl.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, day, nights, oneWay, exclude, same]);
  if (same) return null;
  const r = state.result;
  const best = r?.cheapest ?? r?.options[0] ?? null;
  const fastest = r?.fastest && best && optionKey(r.fastest) !== optionKey(best) ? r.fastest : null;
  const est = best ? [...best.legs, ...(best.back ?? [])].some((l) => l.estimated) : false;
  return (
    <div className="section getthere">
      <div className="headline">
        <h2>Get there</h2>
        <span className="sub">
          from {r?.from.label ?? from}
          {day ? ` · ${shortDate(day)}` : ""}
        </span>
      </div>
      {state.status === "loading" && !best && <div className="status muted">{state.line ?? (state.budget ? "Searching live fares…" : "Reading the fare memory and the timetables…")}</div>}
      {state.status === "error" && !best && <div className="status">{state.note === "network" ? "Could not reach the route search." : state.note}</div>}
      {best && (
        <div className="getbest">
          <div className="cardtop">
            <span className="cardtitle">
              {best.title}
              <span className="sub">
                {hoursLabel(best.hours)} door to door · {best.stops === 0 ? "no change" : `${best.stops} change${best.stops === 1 ? "" : "s"}`}
              </span>
            </span>
            <span className="price">
              {est ? "~" : ""}
              {euro(best.total)}
              <span className="sub">{best.back ? "return" : "one way"}</span>
            </span>
          </div>
          <LegStrip legs={best.legs} />
          {fastest && (
            <div className="sub">
              Fastest: {fastest.title}, {hoursLabel(fastest.hours)}, {euro(fastest.total)}
            </div>
          )}
        </div>
      )}
      {state.status === "ok" && !best && <div className="status muted">{state.budget ? "No way found for those dates." : "Nothing remembered for this route yet: search the live fares."}</div>}
      <div className="chips">
        {state.budget === 0 && (
          <button className="chip on" disabled={state.status === "loading"} onClick={() => void ask(ROUTE_BUDGET)} title={`Up to ${ROUTE_BUDGET} live fare searches on Kiwi.com`}>
            Search live
          </button>
        )}
        {state.status === "loading" && state.budget > 0 && <span className="status muted">{state.line ?? "Searching live fares…"}</span>}
        <button className="chip ghost" onClick={() => onOpen({ from, to: toLabel ?? to, depart: day, nights, oneWay }, r ?? null)}>
          Open in the route card
        </button>
      </div>
      {r && state.status !== "loading" && <div className="status muted small">{state.budget ? `${r.searched} live search${r.searched === 1 ? "" : "es"}.` : "From the fare memory and the timetable graph, no live search."}</div>}
    </div>
  );
}

// ---- Events worth flying for: the card on the map and the list on place pages ----

const KIND_GLYPH: Record<string, string> = { festival: "✺", sport: "◎", culture: "❖", season: "❄", music: "♫", food: "◆" };
export function eventGlyph(kind: string): string {
  return KIND_GLYPH[kind] ?? "✺";
}

type OpenRoute = (q: { from: string; to: string; depart?: string; nights?: number; oneWay?: boolean }, r: RouteResult | null) => void;

/**
 * The events layer's card: the list of events in the window, or one event with its dates,
 * why it is worth the trip, its link, "Get there" and "Make an itinerary".
 */
export function EventsCard({ events, from, to, selected, onSelect, onClose, fromPlace, exclude, onOpenRoute, onItinerary, onPlace, startCollapsed, pricing, onPriceLive }: { events: EventSpot[]; from: string; to: string; selected: EventSpot | null; onSelect: (e: EventSpot | null) => void; onClose: () => void; fromPlace: string; exclude?: string; onOpenRoute: OpenRoute; onItinerary: (e: EventSpot) => void; onPlace: (e: EventSpot) => void; startCollapsed?: boolean; pricing?: { status: "idle" | "loading" | "done"; searched?: number; note?: string }; onPriceLive?: () => void }) {
  // On a phone the list starts folded: the markers on the globe are the point, the list is one tap away.
  const [collapsed, setCollapsed] = useState(!!startCollapsed);
  if (selected) {
    const e = selected;
    const nights = Math.max(2, Math.min(5, Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86_400_000) + 1));
    // An event that ends today or earlier cannot be reached in time: no plan is offered for it.
    const over = e.end < localIso(new Date(Date.now() + 86_400_000));
    return (
      <section className="mapcard eventmapcard" aria-label={e.name}>
        <div className="eventhero">
          <StopPhoto name={e.cityName} country={e.country} className="eventhero-img" />
          <div className="eventhero-text">
            <span className="kicker">
              {eventGlyph(e.kind)} {e.kind} · worth flying for
            </span>
            <b>{e.name}</b>
            <small>
              {e.cityName}, {countryName(e.country)} · {dateRange(e.start, e.end)}
            </small>
          </div>
          <div className="eventhero-btns">
            {events.length > 1 && (
              <button className="iconbtn" onClick={() => onSelect(null)} title="Back to the list">
                ←
              </button>
            )}
            <button className="iconbtn" onClick={onClose} title="Close">
              ×
            </button>
          </div>
        </div>
        <div className="mapcardbody">
          {e.why && <p className="para">{e.why}</p>}
          {e.deal && (
            <div className="status small">
              A stored fare: {euro(e.deal.price)} return from {e.deal.gw}, {shortDate(e.deal.out)} to {shortDate(e.deal.back)}. The itinerary uses it.
            </div>
          )}
          <div className="chips">
            {over ? (
              <span className="status muted small">This edition is ending; the next one shows when its dates come into view.</span>
            ) : (
              <button className="chip itinbtn" onClick={() => onItinerary(e)}>
                <span aria-hidden="true">✦</span> Make an itinerary
              </button>
            )}
            <button className="chip ghost" onClick={() => onPlace(e)}>
              About {e.cityName}
            </button>
            {e.url && (
              <a className="chip ghost" href={e.url} target="_blank" rel="noreferrer">
                Official site ↗
              </a>
            )}
          </div>
          <GetThere from={fromPlace} to={e.cityName} depart={e.start} nights={nights} exclude={exclude} onOpen={onOpenRoute} />
          <div className="status muted small">Usual dates for this edition; check the official site before booking.</div>
        </div>
      </section>
    );
  }
  return (
    <section className={`mapcard${collapsed ? " collapsed" : ""}`} aria-label="Events worth flying for">
      <header className="mapcardhead">
        <button className="mapcardtitle" onClick={() => setCollapsed(!collapsed)}>
          <span className="kicker">Events worth flying for</span>
          <b>
            {events.length} from {dateRange(from, to)}
          </b>
        </button>
        <button className="iconbtn" onClick={() => setCollapsed(!collapsed)} title={collapsed ? "Open" : "Fold"}>
          {collapsed ? "▴" : "▾"}
        </button>
        <button className="iconbtn" onClick={onClose} title="Close the list (the layer stays on)">
          ×
        </button>
      </header>
      {!collapsed && (
        <div className="mapcardbody">
          {events.length === 0 && <div className="status">Nothing on the list in that window. Try another month.</div>}
          {onPriceLive && events.some((e) => !e.deal) && (
            <div className="chips">
              {pricing?.status === "loading" ? (
                <span className="status muted small">Pricing the nearest events live…</span>
              ) : pricing?.status === "done" ? (
                <span className="status muted small">{pricing.note ?? `${pricing.searched ?? 0} live search${pricing.searched === 1 ? "" : "es"}; events still without a price had no fare in their dates.`}</span>
              ) : (
                <button className="chip ghost" onClick={onPriceLive} title="Up to four live fare searches on Kiwi.com, for the nearest events here without a stored fare">
                  Price the nearest live
                </button>
              )}
            </div>
          )}
          {events.map((e) => (
            <button key={e.key} className="eventrow" onClick={() => onSelect(e)}>
              <span className="glyph" aria-hidden="true">
                {eventGlyph(e.kind)}
              </span>
              <span>
                <b>{e.name}</b>
                <small>
                  {e.cityName}, {countryName(e.country)}
                </small>
              </span>
              <EventWhen e={e} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** An event row's right side: its dates, and the stored fare there when one is known (as deal cards show theirs). */
function EventWhen({ e }: { e: EventSpot }) {
  return (
    <span className="when">
      {dateRange(e.start, e.end)}
      {e.deal ? <small className="fare">from {euro(e.deal.price)}</small> : null}
    </span>
  );
}

/** What the curated list may carry; the engine adds cityName, coordinates, why and url, so every field past the core is optional here. */
export type RawEvent = { name: string; city?: string; code?: string; cityName?: string; country: string; lat?: number; lon?: number; start: string; end: string; kind: string; why?: string; note?: string; url?: string };

/** A curated event as an EventSpot; coordinates from the event or the city table, null when neither knows the place. */
export function toEventSpot(e: RawEvent, cities?: Record<string, City>): EventSpot | null {
  // The first shape had the readable name in `city` and the code in `code`; the contract has the code in `city` and the name in `cityName`.
  const code = e.code ?? e.city ?? "";
  const c = cities?.[code];
  const lat = e.lat ?? c?.lat;
  const lon = e.lon ?? c?.lon;
  if (lat == null || lon == null) return null;
  const cityName = e.cityName ?? (e.code ? e.city : undefined) ?? c?.name ?? code;
  return { key: `${e.name}|${e.start}`, name: e.name, city: code, cityName, country: e.country, lat, lon, start: e.start, end: e.end, kind: e.kind, why: e.why ?? (e.note || undefined), url: e.url };
}

/** The curated events at a place (eventsAt, no fetch), for "Worth flying for here" on place pages and the badges on deal cards. */
export function eventsHere(q: { code?: string; country?: string; lat?: number; lon?: number; km?: number }, from: string, to: string, exclude: string[], cities?: Record<string, City>): EventSpot[] {
  // The narrowest locator wins: a city code, else a point and a radius; a country alone only when nothing else is known (it lists the whole country).
  const point = q.lat != null && q.lon != null && !(q.lat === 0 && q.lon === 0);
  const raw = eventsAt({ city: q.code, country: q.code || point ? undefined : q.country, lat: point ? q.lat : undefined, lon: point ? q.lon : undefined, km: q.km ?? 80 }, from, to) as unknown as RawEvent[];
  return raw.map((e) => toEventSpot(e, cities)).filter((e): e is EventSpot => !!e && !exclude.includes(e.country));
}

/** "Worth flying for here": the curated events at this place in the next year, each opening its card on the map. */
export function WorthFlyingFor({ events, onEvent }: { events: EventSpot[]; onEvent: (e: EventSpot) => void }) {
  if (!events.length) return null;
  return (
    <div className="section">
      <h2>Worth flying for here</h2>
      {events.slice(0, 4).map((e) => (
        <button key={e.key} className="eventrow" onClick={() => onEvent(e)}>
          <span className="glyph" aria-hidden="true">
            {eventGlyph(e.kind)}
          </span>
          <span>
            <b>{e.name}</b>
            <small>{e.why ?? e.kind}</small>
          </span>
          <EventWhen e={e} />
        </button>
      ))}
    </div>
  );
}
