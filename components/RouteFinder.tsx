"use client";

import { useEffect, useMemo, useState } from "react";
import type { Airport, City, Gateway } from "@/lib/types";
import { formatDuration } from "@/lib/geo";
import { countryName, euro, hoursLabel, localIso, shortDate, todayIso } from "@/lib/format";
import { searchAirports } from "./TopBar";
import type { RouteLeg as EngineLeg, RouteOption as EngineOption, RouteResult } from "@/lib/route-finder";

// The A to B mode of the Trips tab: the cheapest way from one place to another, every way
// the engine knows (a direct flight, a nearby airport, a train or coach to a better airport,
// a hub, an open jaw, the ground only). The state and the fetch live in Globe.tsx like every
// other search, so the globe can draw the option the visitor taps; this file is the form and
// the cards. The types below mirror the shared contract of lib/route-finder.ts field for
// field (the route stream owns that file); switch to `import type` from it once it lands.

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
export type RouteState = { status: "idle" | "loading" | "ok" | "error"; lines: string[]; options: RouteOption[]; result?: RouteResult; note?: string; query?: RouteForm };

/**
 * Live Kiwi searches one click may spend: the main window costs one, every hub two one-ways
 * (four for a return). Twelve covers the main search and two or three hubs; two such clicks
 * stay under Kiwi's burst throttle, which would otherwise shut every tool for five minutes.
 */
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
const KIND_ORDER: RouteOptionKind[] = ["direct", "nearby-airports", "ground-then-fly", "fly-then-ground", "via-hub", "open-jaw", "ground-only"];
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

function OptionCard({ o, active, cheapest, fastest, onClick }: { o: RouteOption; active: boolean; cheapest: boolean; fastest: boolean; onClick: () => void }) {
  // Only a leg the engine marked is an estimate: a return flight on the same ticket has no
  // price of its own (its fare is in the outbound leg) and is still a real fare.
  const est = [...o.legs, ...(o.back ?? [])].some((l) => l.estimated);
  return (
    <div className={`routecard${active ? " active" : ""}`} onClick={onClick}>
      <div className="cardtop">
        <span className="cardtitle">
          {o.title}
          <span className="sub">
            {hoursLabel(o.hours)} door to door · {o.stops === 0 ? "no change" : `${o.stops} change${o.stops === 1 ? "" : "s"}`}
            {o.legs.length > 1 ? ` · ${o.legs.length} legs` : ""}
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
        {est && <span className="badge heritage">some legs estimated</span>}
      </div>
      <LegStrip legs={o.legs} />
      {o.back && o.back.length > 0 && (
        <>
          <div className="sub">The way back</div>
          <LegStrip legs={o.back} />
        </>
      )}
      {o.why && <div className="sub why">{o.why}</div>}
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
    </div>
  );
}

export type RouteFinderProps = {
  form: RouteForm;
  onForm: (f: RouteForm) => void;
  state: RouteState;
  onSearch: (f: RouteForm) => void;
  onCancel: () => void;
  selected: number | null;
  onSelect: (i: number | null) => void;
  /** Ask the globe for a tap; the picked place lands in "to" through the atlas:picked event. */
  onTapGlobe: () => void;
  tapping: boolean;
  airports: Airport[];
  cities: Record<string, City>;
  gateways: Gateway[];
  homeLabel: string;
  excludedCount: number;
};

export default function RouteFinder(p: RouteFinderProps) {
  const { form, onForm, state } = p;
  const set = (patch: Partial<RouteForm>) => onForm({ ...form, ...patch });
  // The globe answers a tap with atlas:picked; while this mode waits for one, the place goes into "to".
  useEffect(() => {
    if (!p.tapping) return;
    const onPicked = (e: Event) => {
      const det = (e as CustomEvent<{ mode?: string; place?: string }>).detail ?? {};
      if (det.place) onForm({ ...form, to: det.place });
    };
    window.addEventListener("atlas:picked", onPicked);
    return () => window.removeEventListener("atlas:picked", onPicked);
  }, [p.tapping, form, onForm]);

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
  const groups = useMemo(() => {
    const by = new Map<RouteOptionKind, { o: RouteOption; i: number }[]>();
    options.forEach((o, i) => {
      const list = by.get(o.kind) ?? [];
      list.push({ o, i });
      by.set(o.kind, list);
    });
    return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, items: by.get(k)!.sort((a, b) => a.o.total - b.o.total) }));
  }, [options]);

  return (
    <>
      <div className="status">The cheapest way from one place to another, every way: the direct flight, a nearby airport, a train or coach to a better airport, a hub with two tickets, or no flight at all. Live fares where there are any, ground times from the timetable graph.</div>
      {p.excludedCount > 0 && <div className="status muted been-note">Only new countries: {p.excludedCount} excluded; connections still allowed.</div>}
      <h2>From</h2>
      <div className="form wrap">
        <PlacePick value={form.from} onChange={(v) => set({ from: v })} placeholder={p.homeLabel ? `${p.homeLabel}, or another place` : "city or airport"} airports={p.airports} cities={p.cities} label="From" />
        {p.gateways.slice(0, 3).map((g) => (
          <button key={g.airport.iata} className={`chip ghost${form.from === g.airport.iata ? " on" : ""}`} onClick={() => set({ from: g.airport.iata })} title={g.airport.name}>
            {g.airport.iata}
          </button>
        ))}
      </div>
      <h2>To</h2>
      <div className="form wrap">
        <PlacePick value={form.to} onChange={(v) => set({ to: v })} placeholder="city, airport or 'lat,lon'" airports={p.airports} cities={p.cities} label="To" />
        <button className={`chip ghost${p.tapping ? " on" : ""}`} onClick={p.onTapGlobe} title="Then tap any city on the globe">
          {p.tapping ? "Tap the globe…" : "Tap the globe"}
        </button>
      </div>
      <h2>When</h2>
      <div className="form wrap">
        <input className="search" type="date" value={form.depart} min={todayIso()} onChange={(e) => set({ depart: e.target.value })} aria-label="Departure date" style={{ flex: "1 1 150px" }} />
        <select className="search" style={{ flex: "0 0 120px" }} value={form.flex} onChange={(e) => set({ flex: Number(e.target.value) })} aria-label="Days of flexibility">
          {[0, 1, 2, 3].map((d) => (
            <option key={d} value={d}>
              {d === 0 ? "that day" : `± ${d} day${d === 1 ? "" : "s"}`}
            </option>
          ))}
        </select>
      </div>
      <div className="chips">
        <button className={`chip${form.oneWay ? " on" : ""}`} onClick={() => set({ oneWay: true })}>
          One way
        </button>
        <button className={`chip${!form.oneWay ? " on" : ""}`} onClick={() => set({ oneWay: false })}>
          And back
        </button>
        {!form.oneWay && (
          <select className="search" style={{ flex: "0 0 120px", padding: "7px 10px", fontSize: 13.5 }} value={form.nights} onChange={(e) => set({ nights: Number(e.target.value) })} aria-label="Nights there">
            {[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30].map((n) => (
              <option key={n} value={n}>
                {n} night{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        )}
        <select className="search" style={{ flex: "0 0 130px", padding: "7px 10px", fontSize: 13.5 }} value={form.maxHours} onChange={(e) => set({ maxHours: Number(e.target.value) })} aria-label="Longest door to door">
          <option value={0}>any length</option>
          {[4, 6, 8, 12, 18, 24, 36].map((h) => (
            <option key={h} value={h}>
              under {h} h
            </option>
          ))}
        </select>
      </div>
      <div className="chips">
        <button className="chip on" disabled={!ready || state.status === "loading"} onClick={() => p.onSearch(form)}>
          {state.status === "loading" ? "Searching…" : state.status === "ok" ? "Search again" : "Find the cheapest way"}
        </button>
        {state.status === "loading" && (
          <button className="chip ghost" onClick={p.onCancel}>
            Stop
          </button>
        )}
        <button className={`chip ghost${form.harder ? " on" : ""}`} onClick={() => set({ harder: !form.harder })} title={`Spend up to ${ROUTE_BUDGET_HARDER} live fare searches instead of ${ROUTE_BUDGET}: more hubs tried, slower, and Kiwi may refuse the next search for a while`}>
          {form.harder ? "Searching harder" : "Search harder"}
        </button>
      </div>
      {state.status === "idle" && (
        <div className="status muted">
          Live fare searches around your date: one for the two places with all their airports, then two a hub (four for a return) until the budget of {form.harder ? ROUTE_BUDGET_HARDER : ROUTE_BUDGET} is spent, so {form.harder ? "up to about 17 for a return, 9 one way" : "up to about 12"}. The ground graph gives the way to and from the airports. Half a minute, less when the fares are already known.
        </div>
      )}
      {state.status === "loading" && (
        <div className="answer">
          {state.lines.slice(-6).map((l, i, arr) => (
            <p key={i} className={i === arr.length - 1 ? "" : "muted"}>
              {l}
            </p>
          ))}
          {state.lines.length === 0 && <p className="muted">Resolving both places and their airports…</p>}
        </div>
      )}
      {state.status === "error" && <div className="status">{state.note ?? "The route search failed."}</div>}
      {state.result?.note && <div className="status">{state.result.note}</div>}
      {options.length === 0 && state.status === "ok" && <div className="status">No way found between those two for that date. Widen the flexibility or try the next days.</div>}
      {groups.map((g) => (
        <div key={g.kind} className="section">
          <h2>
            {KIND_LABEL[g.kind]} · {g.items.length}
          </h2>
          {g.items.map(({ o, i }) => (
            <OptionCard key={optionKey(o) + i} o={o} active={p.selected === i} cheapest={optionKey(o) === cheapestKey} fastest={optionKey(o) === fastestKey} onClick={() => p.onSelect(p.selected === i ? null : i)} />
          ))}
        </div>
      ))}
      {state.result && (
        <div className="status muted">
          {state.result.searched} live search{state.result.searched === 1 ? "" : "es"}
          {state.result.failed ? `, ${state.result.failed} refused` : ""}. Considered: {state.result.considered.length ? state.result.considered.join(", ") : "nothing beyond the two places"}. Fares as found on Kiwi.com; ground prices marked ~ are estimates, tickets come on top.
        </div>
      )}
    </>
  );
}
