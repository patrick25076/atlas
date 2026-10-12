"use client";

// The panel: three tabs (Search, Ask, My trips) and the pages that sit in front of them (the
// trip page, a place page, the itinerary). The Search tab and the chat stay mounted on every
// tab: a search still streaming, or a tool call still running, must land in the same list or
// thread when the traveller comes back. All state lives in Globe.tsx and arrives as props.

import { useRef, type ReactNode } from "react";
import ChatPanel, { type ChatContext } from "./ChatPanel";
import SearchTab from "./search/SearchTab";
import TripPage from "./TripPage";
import MyTrips from "./MyTrips";
import PlaceIntel, { type Intel } from "./PlaceIntel";
import type { PlaceSummary } from "@/app/api/place/route";
import type { Sights } from "@/app/api/sights/route";
import type { EatsResponse } from "@/app/api/eats/route";
import type { Deal } from "@/lib/types";
import type { WildTrip } from "@/lib/wild";
import type { Itinerary } from "@/lib/itinerary";
import type { SearchQuery, TripResult } from "@/lib/trip-result";
import type { Period, PickMode, PickedDetail, PlacePage, SavedSearch, SearchTabProps, Sheet, Tab } from "@/lib/ui-types";
import { countryName, dateRange, localIso, shortDate, todayIso, daysBetween } from "@/lib/format";

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
  sheet: Sheet;
  onSheet: (s: Sheet) => void;
  // the one search, and the trip page any result opens
  search: SearchTabProps;
  trip: TripResult | null;
  tripQuery: SearchQuery | null;
  onTripBack: () => void;
  onTripFocus: (p: { lat: number; lon: number; zoom?: number }) => void;
  onTripItinerary: (t: TripResult) => void;
  // the chat
  chatContext: ChatContext;
  chatSeed: string | null;
  onChatSeedConsumed: () => void;
  onChatDeals: (deals: Deal[]) => void;
  onChatTrip: (trip: WildTrip) => void;
  onChatOpenDeal: (key: string) => void;
  /** A view in front of everything (the itinerary): it brings its own back button. */
  front: ReactNode | null;
  // a place page opened from anywhere (atlas:place, the command line)
  placePage: PlacePage | null;
  onClosePlace: () => void;
  intel: Intel | null;
  summary: PlaceSummary | null;
  sights: Sights | null;
  eats: EatsResponse | null;
  onShowSights: () => void;
  onFindTrips: (pl: PlacePage) => void;
  onPlanPlace: (pl: PlacePage) => void;
  // the chat asking the globe to pick something
  pick: PickMode | null;
  pickPeriod: Period;
  onPickPeriod: (p: Period) => void;
  onPicked: (d: PickedDetail) => void;
  onPickCancel: () => void;
  // my trips: the itineraries this browser saved, and its last searches
  hasSaved: boolean;
  onOpenSaved: (it: Itinerary) => void;
  searches: SavedSearch[];
  onRunSearch: (q: SearchQuery) => void;
  onForgetSearch: (at: number) => void;
};

/**
 * Two dates with quick chips, for when the chat asks for a period. The chips speak the
 * visitor's own calendar: local date parts, never the UTC day.
 */
function PeriodPicker({ value, onChange, onDone }: { value: Period; onChange: (p: Period) => void; onDone: (p: Period) => void }) {
  const today = new Date();
  const day = 86_400_000;
  const toSat = (6 - today.getDay() + 7) % 7 || 7;
  const sat = new Date(today.getTime() + toSat * day);
  // Days until the coming Monday: 1 on a Sunday, 7 on a Monday, never a week more.
  const toMon = (8 - today.getDay()) % 7 || 7;
  const nextMon = new Date(today.getTime() + toMon * day);
  const quick: { label: string; p: Period }[] = [
    { label: "This weekend", p: { from: localIso(new Date(sat.getTime() - day)), to: localIso(new Date(sat.getTime() + 2 * day)) } },
    { label: "Next week", p: { from: localIso(nextMon), to: localIso(new Date(nextMon.getTime() + 6 * day)) } },
    { label: "A month from now", p: { from: localIso(new Date(today.getTime() + 28 * day)), to: localIso(new Date(today.getTime() + 38 * day)) } },
    { label: "Anytime", p: { from: "", to: "" } },
  ];
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
        <button className="chip on" onClick={() => onDone(value)}>
          Use these dates
        </button>
      </div>
      <div className="status muted">{value.from && value.to ? `Between ${dateRange(value.from, value.to)}.` : value.from ? `From ${shortDate(value.from)}.` : "No dates: the cheapest days in the next months."}</div>
    </div>
  );
}

/** The one action every page shares: turn it into a day-by-day itinerary. */
function ItineraryButton({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button className="chip itinbtn" onClick={onClick} title="A day-by-day plan: what to see, where to eat, what it costs; save it, share it, put it in your calendar">
      <span aria-hidden="true">✦</span> {label ?? "Make an itinerary"}
    </button>
  );
}

/** What a place page shows: things to do, where to eat, the guide's festivals, and the facts. */
function PlaceSections({ p }: { p: Props }) {
  return (
    <>
      {p.sights && (p.sights.see.length > 0 || p.sights.do.length > 0) && (
        <div className="section">
          <div className="headline">
            <h2>What to do in {p.sights.title}</h2>
            <button className="chip ghost" onClick={p.onShowSights}>
              Show on the map
            </button>
          </div>
          <div className="sights">
            {[...p.sights.see.slice(0, 6), ...p.sights.do.slice(0, 2)].map((s) => (
              <a key={s.kind + s.name} className="sight" href={s.url ?? p.sights!.url} target="_blank" rel="noreferrer">
                <div className="sightimg" style={s.image ? { backgroundImage: `url(${s.image})` } : undefined}>
                  <span className={`badge ${s.kind === "do" ? "warm" : "heritage"}`}>{s.kind === "do" ? "do" : "see"}</span>
                </div>
                <b>{s.name}</b>
                {s.desc && <p>{s.desc}</p>}
              </a>
            ))}
          </div>
          <div className="status muted">
            From the{" "}
            <a href={p.sights.url} target="_blank" rel="noreferrer">
              Wikivoyage guide ↗
            </a>{" "}
            (CC BY-SA), written by travellers.
          </div>
        </div>
      )}
      {p.eats && p.eats.food.status === "ok" && p.eats.food.places.length > 0 && (
        <div className="section">
          <h2>Eat well, fairly priced</h2>
          {p.eats.food.places.slice(0, 6).map((e) => (
            <a key={e.id} className="row" href={e.url ?? `https://foursquare.com/v/${e.id}`} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
              <span className="code">{e.rating?.toFixed(1)}</span>
              <span>
                <div className="name">
                  {e.name} <span className="muted">{"€".repeat(e.price ?? 1)}</span>
                </div>
                <div className="sub">{[e.category, e.tip].filter(Boolean).join(" · ")}</div>
              </span>
              <span className="meta">{e.distance != null ? `${(e.distance / 1000).toFixed(1)} km` : ""}</span>
            </a>
          ))}
        </div>
      )}
      {p.sights && p.sights.events.length > 0 && (
        <div className="section">
          <h2>Festivals and events</h2>
          {p.sights.events.slice(0, 4).map((e, i) => (
            <p key={i} className="para" style={{ margin: 0 }}>
              {e}
            </p>
          ))}
        </div>
      )}
      {p.intel && <PlaceIntel intel={p.intel} summary={p.summary} />}
    </>
  );
}

/** "today", "3 days ago": when a saved search was last run. */
function ago(at: number): string {
  const d = daysBetween(localIso(new Date(at)), todayIso());
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/** My trips: the itineraries saved in this browser, then the last ten searches, each one tap from running again. */
function MyTripsTab({ p }: { p: Props }) {
  return (
    <div className="scroll mytrips">
      {p.hasSaved ? <MyTrips onOpen={p.onOpenSaved} /> : <div className="status muted">Open any trip, press Make an itinerary, then Save: your plans are kept here.</div>}
      <div className="section">
        <h2>Your searches</h2>
        {p.searches.length === 0 && <div className="status muted">The searches you run show up here, newest first, so you can run one again with the prices of the day.</div>}
        {p.searches.map((s) => (
          <div key={s.at} className="row savedsearch" role="button" tabIndex={0} onClick={() => p.onRunSearch(s.query)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && p.onRunSearch(s.query)} title="Run this search again">
            <span className="code" aria-hidden="true">
              ⌕
            </span>
            <span>
              <div className="name">{s.label}</div>
              <div className="sub">
                from {s.query.from?.label ?? "your place"} · {ago(s.at)}
              </div>
            </span>
            <span className="meta">
              <button
                className="iconbtn"
                aria-label={`Forget the search ${s.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onForgetSearch(s.at);
                }}
              >
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const TABS: { key: Tab; label: string }[] = [
  { key: "search", label: "Search" },
  { key: "chat", label: "Ask" },
  { key: "trips", label: "My trips" },
];

export default function Panel(p: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  /** A drag of the sheet on a phone: where the finger and the sheet started, and the last move for its speed. */
  const drag = useRef<{ y0: number; h0: number; y: number; t: number; v: number } | null>(null);
  // A page in front of the tabs: the itinerary, a place page, the trip page. The tabs stay mounted underneath.
  const covered = !!p.front || !!p.placePage || !!p.trip;
  const step = (dir: 1 | -1) => {
    const order: Sheet[] = ["peek", "half", "full"];
    const i = order.indexOf(p.sheet);
    p.onSheet(order[Math.max(0, Math.min(2, i + dir))]);
  };
  // The sheet follows the finger and, on release, settles on the nearest of its three heights,
  // or on the next one in the direction of a quick flick. Its CSS transition does the settling.
  const sheetHeights = (): Record<Sheet, number> => {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar")) || 56;
    return { peek: 150, half: Math.round(vh * 0.6), full: Math.round(vh - top - 8) };
  };
  const onDragStart = (e: React.TouchEvent) => {
    const el = panelRef.current;
    if (!el) return;
    const y = e.touches[0].clientY;
    drag.current = { y0: y, h0: el.getBoundingClientRect().height, y, t: performance.now(), v: 0 };
    el.style.transition = "none";
  };
  const onDragMove = (e: React.TouchEvent) => {
    const d = drag.current;
    const el = panelRef.current;
    if (!d || !el) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    // The speed, smoothed over the last moves so one jittery sample does not decide a flick.
    d.v = 0.6 * ((y - d.y) / Math.max(1, now - d.t)) + 0.4 * d.v;
    d.y = y;
    d.t = now;
    const hs = sheetHeights();
    el.style.height = `${Math.round(Math.max(hs.peek - 30, Math.min(hs.full + 10, d.h0 - (y - d.y0))))}px`;
  };
  const onDragEnd = () => {
    const d = drag.current;
    const el = panelRef.current;
    drag.current = null;
    if (!d || !el) return;
    const moved = d.y - d.y0;
    el.style.transition = "";
    el.style.height = "";
    // A tap on the handle opens the sheet fully, or brings a full one back to half.
    if (Math.abs(moved) < 8) return p.onSheet(p.sheet === "full" ? "half" : "full");
    const hs = sheetHeights();
    const h = d.h0 - moved;
    const order: Sheet[] = ["peek", "half", "full"];
    // A finger that stopped before lifting is a placement, not a flick.
    const v = performance.now() - d.t > 100 ? 0 : d.v;
    if (Math.abs(v) > 0.45) {
      // A flick: one step past the height the drag is nearest to, in the flick's direction.
      const nearest = order.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
      const i = order.indexOf(nearest);
      const up = v < 0;
      const target = up ? (hs[nearest] > h ? nearest : order[Math.min(2, i + 1)]) : hs[nearest] < h ? nearest : order[Math.max(0, i - 1)];
      return p.onSheet(target);
    }
    p.onSheet(order.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a)));
  };

  return (
    <aside className={`panel ${p.sheet}`} ref={panelRef}>
      <div className="handle" role="button" aria-label={p.sheet === "full" ? "Show more of the globe" : "Open the panel"} tabIndex={-1} onTouchStart={onDragStart} onTouchMove={onDragMove} onTouchEnd={onDragEnd} onTouchCancel={onDragEnd} onClick={(e) => e.detail === 0 && step(p.sheet === "full" ? -1 : 1)} />

      {!covered && (
        <div className="tabs" role="tablist" aria-label="Atlas">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={p.tab === t.key} className={`tab${p.tab === t.key ? " on" : ""}`} onClick={() => p.onTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {p.pick && (
        <div className="pickbox">
          {p.pick === "dates" ? (
            <>
              <div className="pickhead">
                <b>When do you want to go?</b>
                <button className="chip ghost" onClick={p.onPickCancel}>
                  Cancel
                </button>
              </div>
              <PeriodPicker value={p.pickPeriod} onChange={p.onPickPeriod} onDone={(v) => p.onPicked({ mode: "dates", from: v.from || undefined, to: v.to || undefined })} />
            </>
          ) : (
            <div className="pickhead">
              <b>{p.pick === "region" ? "Tap a region on the globe" : "Tap a place on the globe"}</b>
              <span className="sub">{p.pick === "region" ? "the tags show the regions" : "a price tag or any city"}</span>
              <button className="chip ghost" onClick={p.onPickCancel}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* The search and the chat stay mounted on every tab. The search's wrapper is the scroller
          of the bar, the drawer, the chips and the list together; the chat's uses display:contents
          so its own flex layout runs as if the wrapper were not there. */}
      <div className="searchwrap" style={p.tab === "search" && !covered ? undefined : { display: "none" }} aria-hidden={p.tab !== "search" || covered}>
        <SearchTab {...p.search} />
      </div>
      <div className="chatwrap" style={{ display: p.tab === "chat" && !covered ? "contents" : "none" }} aria-hidden={p.tab !== "chat" || covered}>
        <ChatPanel context={p.chatContext} seed={p.chatSeed} onSeedConsumed={p.onChatSeedConsumed} onDeals={p.onChatDeals} onTrip={p.onChatTrip} onOpenDeal={p.onChatOpenDeal} />
      </div>

      {p.front}

      {!p.front && p.placePage && (
        <>
          <div className="heroimg" style={{ backgroundImage: p.summary?.thumbnail ? `url(${p.summary.thumbnail})` : undefined }}>
            <button className="back" onClick={p.onClosePlace} aria-label="Back">
              ← Back
            </button>
            <div className="title">
              <h3>
                {p.placePage.name}
                <small>{p.placePage.country ? countryName(p.placePage.country) : "a place"}</small>
              </h3>
            </div>
          </div>
          <div className="scroll" style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}>
            <div className="chips">
              <button className="chip on" onClick={() => p.onFindTrips(p.placePage!)}>
                Find trips to {p.placePage.name}
              </button>
              <ItineraryButton label="Plan a few nights here" onClick={() => p.onPlanPlace(p.placePage!)} />
            </div>
            <PlaceSections p={p} />
          </div>
        </>
      )}

      {!p.front && !p.placePage && p.trip && (
        <div className="trippagewrap">
          <TripPage key={p.trip.id} trip={p.trip} query={p.tripQuery ?? undefined} onBack={p.onTripBack} onFocus={p.onTripFocus} onItinerary={p.onTripItinerary} />
        </div>
      )}

      {!covered && p.tab === "trips" && <MyTripsTab p={p} />}
    </aside>
  );
}
