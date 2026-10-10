"use client";

import { useRef, useState } from "react";
import { flightMinutes, formatDuration } from "@/lib/geo";
import type { Place, PlaceMode } from "@/lib/places";
import type { TripsResult } from "@/lib/trips";
import type { PlaceSummary } from "@/app/api/place/route";
import type { Deal, Destination, FaresResponse, Gateway, Holiday, ReachResponse, ReachStation } from "@/lib/types";
import { BANDS, dealKey, type AskState, type Band, type BoardState, type DealNights, type LiveSearch, type Origin, type Sheet, type View } from "@/lib/ui-types";
import { changes, countryName, dateRange, kiwiPhoto, monthLabel, shortDate, stops } from "@/lib/format";
import PlaceIntel, { type Intel } from "./PlaceIntel";
import type { Sights } from "@/app/api/sights/route";
import type { CombosResult } from "@/lib/combos";

export type CombosState = { status: "idle" | "loading" | "ok" | "error"; result?: CombosResult; note?: string };

export const MODE_LABEL: Record<PlaceMode, string> = { plane: "Fly", rail: "Train", coach: "Coach", ferry: "Ferry", other: "Ride" };
const MODE_TAG: Record<string, string> = { plane: "FLY", rail: "TRN", coach: "BUS", ferry: "FRY", walk: "WLK", other: "···" };
const GROUND_TAG: Record<string, string> = { rail: "TRN", coach: "BUS", ferry: "FRY", walk: "WLK" };

type Props = {
  view: View;
  onView: (v: View) => void;
  sheet: Sheet;
  onSheet: (s: Sheet) => void;
  origin: Origin | null;
  month: string | null;
  // deals
  boards: BoardState[];
  deals: Deal[];
  totalCities: number;
  deal: Deal | null;
  dealOptions: Deal[];
  onDeal: (key: string | null) => void;
  onHoverDeal: (key: string | null) => void;
  dealNights: DealNights;
  onDealNights: (n: DealNights) => void;
  directOnly: boolean;
  onDirectOnly: (v: boolean) => void;
  warmOnly: boolean;
  onWarmOnly: (v: boolean) => void;
  gemsOnly: boolean;
  onGemsOnly: (v: boolean) => void;
  dealGateway: string;
  onDealGateway: (g: string) => void;
  gemOf: (d: Deal) => boolean;
  whyOf: (d: Deal) => string;
  warmOf: (d: Deal) => number | null;
  thumbs: Record<string, string>;
  live: LiveSearch | null;
  onLive: (from: string, to: string, depart: string, nights: number) => void;
  ask: AskState | null;
  asking: boolean;
  onAsk: (q: string) => void;
  askOnly: boolean;
  onAskOnly: (v: boolean) => void;
  weatherReady: boolean;
  intel: Intel | null;
  summary: PlaceSummary | null;
  sights: Sights | null;
  onShowSights: () => void;
  combos: CombosState;
  onCombos: () => void;
  selectedCombo: string | null;
  onCombo: (code: string | null) => void;
  // explore
  gateways: Gateway[];
  routeCounts: Record<string, number>;
  gatewayIata: string | null;
  onGateway: (iata: string) => void;
  band: Band;
  onBand: (b: Band) => void;
  destinations: Destination[];
  totalDestinations: number;
  selectedDest: string | null;
  onDest: (iata: string | null) => void;
  fares: FaresResponse | null;
  anyFares: boolean;
  fareSource: string;
  airlines: Record<string, string>;
  pricedOnly: boolean;
  onPricedOnly: (v: boolean) => void;
  bigOnly: boolean;
  onBigOnly: (v: boolean) => void;
  reach: ReachResponse | null;
  reachShown: ReachStation[];
  selectedStation: number | null;
  onStation: (id: number | null) => void;
  places: Place[];
  totalPlaces: number;
  selectedPlace: string | null;
  onPlace: (key: string | null) => void;
  // trips
  trips: TripsResult | null;
  selectedTrip: string | null;
  onTrip: (id: string | null) => void;
  days: number;
  onDays: (d: number) => void;
  homeHolidays: Holiday[];
  around: string | null;
  onAround: (d: string | null) => void;
};

const ASK_IDEAS = ["Warm weekend under €60", "Somewhere nobody I know has been", "Great food, 4 nights, direct", "A beach in November", "Which airport should I fly from?"];

function Chips(p: { band: Band; onBand: (b: Band) => void; children?: React.ReactNode }) {
  return (
    <div className="chips">
      {BANDS.map((b) => (
        <button key={b.key} className={`chip${p.band === b.key ? " on" : ""}`} onClick={() => p.onBand(b.key)}>
          {b.label}
        </button>
      ))}
      {p.children}
    </div>
  );
}

function DealCard({ d, active, photo, gem, warm, why, onClick, onHover }: { d: Deal; active: boolean; photo: string | null; gem: boolean; warm: number | null; why: string; onClick: () => void; onHover: (on: boolean) => void }) {
  return (
    <div className={`card${active ? " active" : ""}`} onClick={onClick} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <div className="thumb">{photo && <img src={photo} alt="" loading="lazy" />}</div>
      <div className="cardbody">
        <div className="cardtop">
          <span className="cardtitle">
            {d.city}
            <span className="sub">{countryName(d.country)}</span>
          </span>
          <span className="price">
            €{d.price}
            <span className="sub">return</span>
          </span>
        </div>
        <div className="sub">
          {dateRange(d.out, d.back)} · {d.nights} nights · from {d.gw}
        </div>
        <div className="sub">
          {d.carriers[0]} · {formatDuration(d.outMin)}
          {d.stops ? ` · ${stops(d.stops)}` : ""}
        </div>
        <div className="badges">
          {d.stops === 0 && <span className="badge direct">direct</span>}
          {gem && <span className="badge gem">hidden gem</span>}
          {warm != null && warm >= 20 && <span className="badge warm">{warm}° this weekend</span>}
          {why && <span className="badge heritage">{why}</span>}
        </div>
      </div>
    </div>
  );
}

export default function Panel(p: Props) {
  const [question, setQuestion] = useState("");
  const [liveDate, setLiveDate] = useState("");
  const [liveNights, setLiveNights] = useState(4);
  const touchY = useRef<number | null>(null);
  const selected = p.selectedDest ? p.destinations.find((d) => d.airport.iata === p.selectedDest) : null;
  const place = p.selectedPlace ? p.places.find((x) => x.key === p.selectedPlace) : null;
  const tab: "deals" | "explore" | "trips" = p.view === "deals" ? "deals" : p.view === "trips" ? "trips" : "explore";
  const loading = p.boards.filter((b) => b.status === "loading");
  const liveBoards = p.boards.filter((b) => b.source === "live");
  const okBoards = p.boards.filter((b) => b.status === "ok");
  const newest = okBoards.map((b) => b.meta?.updated ?? "").sort().at(-1);
  const win = okBoards[0]?.meta?.window;

  const step = (dir: 1 | -1) => {
    const order: Sheet[] = ["peek", "half", "full"];
    const i = order.indexOf(p.sheet);
    p.onSheet(order[Math.max(0, Math.min(2, i + dir))]);
  };

  return (
    <aside className={`panel ${p.sheet}`}>
      <div
        className="handle"
        onTouchStart={(e) => (touchY.current = e.touches[0].clientY)}
        onTouchEnd={(e) => {
          const y0 = touchY.current;
          touchY.current = null;
          if (y0 == null) return;
          const dy = e.changedTouches[0].clientY - y0;
          if (dy < -30) step(1);
          else if (dy > 30) step(-1);
          else p.onSheet(p.sheet === "full" ? "half" : "full");
        }}
      />

      {!(tab === "deals" && p.deal) && (
        <div className="tabs">
          <button className={`tab${tab === "deals" ? " on" : ""}`} onClick={() => p.onView("deals")}>
            Deals
          </button>
          <button className={`tab${tab === "explore" ? " on" : ""}`} onClick={() => p.onView("all")}>
            Explore
          </button>
          <button className={`tab${tab === "trips" ? " on" : ""}`} onClick={() => p.onView("trips")}>
            Trips
          </button>
        </div>
      )}

      {tab === "deals" && p.deal && (
        <>
          <div className="heroimg" style={{ backgroundImage: `url(${kiwiPhoto(p.deal.img) ?? p.thumbs[p.deal.city] ?? ""})` }}>
            <button className="back" onClick={() => p.onDeal(null)}>
              ← Deals
            </button>
            <div className="title">
              <h3>
                {p.deal.city}
                <small>
                  {countryName(p.deal.country)} · {dateRange(p.deal.out, p.deal.back)} · {p.deal.nights} nights
                </small>
              </h3>
              <span className="price">€{p.deal.price}</span>
            </div>
          </div>
          <div className="scroll" style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}>
            <a className="book" href={p.deal.url} target="_blank" rel="noreferrer">
              Book on Kiwi.com <small>€{p.deal.price} return ↗</small>
            </a>
            <div className="status">
              From {p.deal.gw}, {stops(p.deal.stops)} with {p.deal.carriers.join(" + ")}: {formatDuration(p.deal.outMin)} out, {formatDuration(p.deal.backMin)} back.
              {p.deal.bags ? ` ${p.deal.bags[0].toUpperCase()}${p.deal.bags.slice(1)} included.` : ""} Found on Kiwi.com {newest ? shortDate(newest) : "recently"}; the booking page shows the live price.
            </div>
            {p.dealOptions.length > 1 && (
              <div className="section">
                <h2>Other dates</h2>
                <div className="chips">
                  {p.dealOptions.map((d) => (
                    <button key={dealKey(d)} className={`chip ghost${dealKey(d) === dealKey(p.deal!) ? " on" : ""}`} onClick={() => p.onDeal(dealKey(d))} title={`${d.nights} nights from ${d.gw}, ${stops(d.stops)}`}>
                      €{d.price} · {dateRange(d.out, d.back)} · {d.gw}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="section">
              <h2>Pick your own dates</h2>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (p.deal) p.onLive(p.deal.gw, p.deal.dst, liveDate || p.deal.out, liveNights);
                }}
              >
                <input className="search" type="date" value={liveDate || p.deal.out} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setLiveDate(e.target.value)} aria-label="Departure date" />
                <select className="search" style={{ flex: "0 0 104px" }} value={liveNights} onChange={(e) => setLiveNights(Number(e.target.value))} aria-label="Nights">
                  {[2, 3, 4, 5, 6, 7, 10, 14].map((n) => (
                    <option key={n} value={n}>
                      {n} nights
                    </option>
                  ))}
                </select>
                <button className="chip on" type="submit" disabled={p.live?.status === "loading"}>
                  {p.live?.status === "loading" ? "Searching…" : "Check"}
                </button>
              </form>
              <div className="status muted">Searches Kiwi.com live, ±2 days around your dates.</div>
              {p.live?.status === "error" && <div className="status">Live search failed: {p.live.note}. Try again in a minute.</div>}
              {p.live?.status === "ok" && (
                <div>
                  {p.live.itineraries.length === 0 && <div className="status">No flights found for those dates.</div>}
                  {p.live.itineraries.slice(0, 6).map((it, i) => (
                    <a key={i} className="row" href={it.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                      <span className="code">€{it.price}</span>
                      <span>
                        <div className="name">
                          {shortDate(it.out)}
                          {it.back ? ` to ${shortDate(it.back)}` : ""}
                          {it.nights != null ? ` · ${it.nights} nights` : ""}
                        </div>
                        <div className="sub">
                          {stops(it.stops)} · {it.carriers.join(" + ")} · {formatDuration(it.outMin)} out{it.backMin ? `, ${formatDuration(it.backMin)} back` : ""}
                        </div>
                      </span>
                      <span className="meta">Book ↗</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
            <div className="section">
              <h2>See two cities for less</h2>
              {p.combos.status === "idle" && (
                <>
                  <button className="chip on" onClick={p.onCombos}>
                    Fly in, train on, fly home from the next city
                  </button>
                  <div className="status muted">Six live searches on Kiwi.com, about ten seconds. Often cheaper than the return, and you see a second place.</div>
                </>
              )}
              {p.combos.status === "loading" && <div className="status">Searching one-way fares and train times…</div>}
              {p.combos.status === "error" && <div className="status">Could not search combos: {p.combos.note}</div>}
              {p.combos.status === "ok" && p.combos.result && (
                <>
                  {p.combos.result.combos.length === 0 && <div className="status">No flights home from the neighbouring cities on those dates.</div>}
                  {p.combos.result.combos.slice(0, 4).map((c) => (
                    <div key={c.code} className={`row${p.selectedCombo === c.code ? " active" : ""}`} onClick={() => p.onCombo(p.selectedCombo === c.code ? null : c.code)}>
                      <span className="code">€{c.total}</span>
                      <span>
                        <div className="name">
                          {p.deal!.city} → {c.name}
                        </div>
                        <div className="sub">
                          {c.groundMode === "road" ? "by road" : c.groundMode} {formatDuration(c.groundMin)}
                          {c.estimated ? " (est.)" : ""} · fly home {shortDate(c.inDate)} for €{c.inPrice}
                          {c.inStops ? ` (${stops(c.inStops)})` : ""}
                        </div>
                      </span>
                      <span className="meta">
                        <strong style={{ color: c.saves > 0 ? "var(--mint)" : "var(--ink-3)" }}>{c.saves > 0 ? `saves €${c.saves}` : `€${-c.saves} more`}</strong>
                        <a href={p.combos.result!.outUrl ?? "#"} target="_blank" rel="noreferrer">
                          out €{p.combos.result!.outPrice} ↗
                        </a>{" "}
                        <a href={c.inUrl} target="_blank" rel="noreferrer">
                          home ↗
                        </a>
                      </span>
                    </div>
                  ))}
                  <div className="status muted">One-way fares as found just now; train and coach tickets come on top. Ground times are expected door-to-door estimates.</div>
                </>
              )}
            </div>
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
            {p.sights && p.sights.events.length > 0 && (
              <div className="section">
                <h2>Festivals and events there</h2>
                {p.sights.events.slice(0, 5).map((e, i) => (
                  <p key={i} className="para" style={{ margin: 0 }}>
                    {e}
                  </p>
                ))}
              </div>
            )}
            {p.intel && <PlaceIntel intel={p.intel} summary={p.summary} />}
          </div>
        </>
      )}

      {tab === "deals" && !p.deal && (
        <>
          <form
            className="form mobile-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) {
                p.onAsk(question.trim());
                setQuestion("");
              }
            }}
          >
            <input className="search" placeholder="Ask anything: warm weekend under €60, direct?" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={p.asking} />
            <button className="chip on" type="submit" disabled={p.asking || !question.trim()}>
              {p.asking ? "…" : "Ask"}
            </button>
          </form>
          {!p.ask && !p.asking && (
            <div className="chips nowrap ideas">
              {ASK_IDEAS.map((q) => (
                <button key={q} className="chip" onClick={() => p.onAsk(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          {p.asking && <div className="status">Thinking about it…</div>}
          {p.ask && (
            <div className="answer">
              <div className="q">You asked: {p.ask.question}</div>
              {p.ask.status === "ok" ? (
                <>
                  <p>{p.ask.text}</p>
                  {p.ask.used.length > 0 && (
                    <div className="chips">
                      <button className={`chip ghost${p.askOnly ? " on" : ""}`} onClick={() => p.onAskOnly(true)}>
                        Its picks
                      </button>
                      <button className={`chip ghost${!p.askOnly ? " on" : ""}`} onClick={() => p.onAskOnly(false)}>
                        All deals
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <p className="muted">{p.ask.note ?? "No answer."}</p>
              )}
            </div>
          )}

          <div className="headline">
            <h3>
              <b>{p.totalCities}</b> getaways{p.month ? ` in ${monthLabel(p.month)}` : ""}
            </h3>
            {loading.length > 0 ? (
              <span className="sub">searching {loading.map((b) => b.gateway).join(", ")}…</span>
            ) : win ? (
              <span className="sub">
                {dateRange(win.from, win.to)}, 2 to 7 nights
              </span>
            ) : null}
          </div>
          {liveBoards.length > 0 && loading.length === 0 && (
            <div className="status muted">
              {liveBoards.map((b) => b.gateway).join(", ")} searched live just now: anyone opening Atlas here from now on gets it instantly.
            </div>
          )}
          {p.boards.some((b) => b.status === "error") && (
            <div className="status">
              {p.boards
                .filter((b) => b.status === "error")
                .map((b) => `${b.gateway}: ${b.note}`)
                .join(" · ")}
            </div>
          )}

          <div className="chips nowrap">
            {(["any", "2-3", "4-5", "6-7"] as DealNights[]).map((n) => (
              <button key={n} className={`chip${p.dealNights === n ? " on" : ""}`} onClick={() => p.onDealNights(n)}>
                {n === "any" ? "Any length" : `${n} nights`}
              </button>
            ))}
            <button className={`chip${p.directOnly ? " on" : ""}`} onClick={() => p.onDirectOnly(!p.directOnly)}>
              Direct
            </button>
            {p.weatherReady && (
              <button className={`chip${p.warmOnly ? " on" : ""}`} onClick={() => p.onWarmOnly(!p.warmOnly)} title="At least 20 °C this weekend">
                Warm
              </button>
            )}
            <button className={`chip${p.gemsOnly ? " on" : ""}`} onClick={() => p.onGemsOnly(!p.gemsOnly)} title="A lot to see, few tourists">
              Hidden gems
            </button>
          </div>
          {p.boards.length > 1 && (
            <div className="chips nowrap">
              <button className={`chip ghost${p.dealGateway === "all" ? " on" : ""}`} onClick={() => p.onDealGateway("all")}>
                Any airport
              </button>
              {p.boards.map((b) => (
                <button key={b.gateway} className={`chip ghost${p.dealGateway === b.gateway ? " on" : ""}`} onClick={() => p.onDealGateway(b.gateway)} title={b.label}>
                  {b.gateway} · {b.label}
                </button>
              ))}
            </div>
          )}

          <div className="scroll cards">
            {p.deals.map((d) => (
              <DealCard
                key={dealKey(d)}
                d={d}
                active={false}
                photo={kiwiPhoto(d.img, "600x600") ?? p.thumbs[d.city] ?? null}
                gem={p.gemOf(d)}
                warm={p.warmOf(d)}
                why={p.whyOf(d)}
                onClick={() => p.onDeal(dealKey(d))}
                onHover={(on) => p.onHoverDeal(on ? dealKey(d) : null)}
              />
            ))}
            {loading.length > 0 && p.deals.length < 6 && [0, 1, 2].map((i) => <div key={`sk${i}`} className="skeleton" />)}
            {loading.length === 0 && p.deals.length === 0 && p.boards.length > 0 && <div className="status">Nothing matches these filters. Loosen one.</div>}
            {p.boards.length === 0 && <div className="status">Finding your airports…</div>}
          </div>
        </>
      )}

      {tab === "trips" && (
        <>
          <div className="status">Fly out, hop between cities by train or coach, fly home from the last one. Ranked by countries and cities per euro and hour.</div>
          <div className="chips nowrap">
            {[3, 5, 7, 10].map((d) => (
              <button key={d} className={`chip${p.days === d ? " on" : ""}`} onClick={() => p.onDays(d)}>
                {d} nights
              </button>
            ))}
            {p.homeHolidays.map((h) => (
              <button key={h.date} className={`chip ghost${p.around === h.date ? " on" : ""}`} onClick={() => p.onAround(p.around === h.date ? null : h.date)} title={h.name}>
                {shortDate(h.date)} · {h.localName}
              </button>
            ))}
          </div>
          {(() => {
            const trip = p.selectedTrip ? p.trips?.trips.find((t) => t.id === p.selectedTrip) : null;
            if (!trip) return null;
            return (
              <div className="section">
                <h3>
                  {trip.cities.map((c) => c.name).join(" → ")} · <span style={{ color: "var(--mint)" }}>€{trip.price}</span>
                </h3>
                <div className="status">
                  {trip.nights} nights, {dateRange(trip.outDate, trip.backDate)}. {trip.countries} countr{trip.countries === 1 ? "y" : "ies"}, {trip.travelHours} h of travel door to door. Flights are one-way fares as found; train and coach tickets come on top.
                </div>
                <div>
                  {trip.legs.map((l, i) =>
                    l.kind === "fly" ? (
                      <a key={i} className="row" href={l.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                        <span className="code">FLY</span>
                        <span>
                          <div className="name">
                            {l.fromName} → {l.toName}
                          </div>
                          <div className="sub">
                            {shortDate(l.date)}
                            {l.airline ? ` · ${p.airlines[l.airline] ?? l.airline}` : ""} · {stops(l.transfers)} · Book ↗
                          </div>
                        </span>
                        <span className="meta">
                          <strong>€{l.price}</strong>~{formatDuration(l.minutes)}
                        </span>
                      </a>
                    ) : (
                      <div key={i} className="row">
                        <span className="code">{GROUND_TAG[l.mode] ?? "RID"}</span>
                        <span>
                          <div className="name">
                            {l.fromName} → {l.toName}
                          </div>
                          <div className="sub">
                            {changes(l.changes)} · {l.mode}
                          </div>
                        </span>
                        <span className="meta">
                          <strong>{formatDuration(l.minutes)}</strong>
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })()}
          <h2>Trips · {p.trips?.trips.length ?? 0}</h2>
          <div className="status">
            {!p.trips
              ? "Searching flights out, trains between, flights home…"
              : p.trips.status === "no-token"
                ? "Multi-city trips need one-way fares for your airports; they exist for Romania so far."
                : p.trips.status === "error"
                  ? `Trip search failed: ${p.trips.note}`
                  : p.trips.trips.length === 0
                    ? "No trip found for these nights. Try another length."
                    : ""}
          </div>
          <div className="scroll">
            {p.trips?.trips.map((t) => (
              <div key={t.id} className={`row${t.id === p.selectedTrip ? " active" : ""}`} onClick={() => p.onTrip(t.id === p.selectedTrip ? null : t.id)}>
                <span className="code">€{t.price}</span>
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
        </>
      )}

      {tab === "explore" && (
        <div className="chips">
          <button className={`chip${p.view === "all" ? " on" : ""}`} onClick={() => p.onView("all")}>
            Any way
          </button>
          <button className={`chip${p.view === "fly" ? " on" : ""}`} onClick={() => p.onView("fly")}>
            By air
          </button>
          <button className={`chip${p.view === "ground" ? " on" : ""}`} onClick={() => p.onView("ground")}>
            By land and sea
          </button>
        </div>
      )}

      {p.view === "all" && (
        <>
          {place && (
            <>
              <div className="row active" onClick={() => p.onPlace(null)}>
                <span className="code">{MODE_TAG[place.mode]}</span>
                <span>
                  <div className="name">{place.name}</div>
                  <div className="sub">{place.country ? countryName(place.country) : place.ground?.mode}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(place.minutes)}</strong>
                  {place.price != null ? `from €${place.price}` : ""}
                </span>
              </div>
              <div className="status">
                {place.mode === "plane" && place.air ? (
                  <>
                    Drive to {place.air.gateway.iata}, ~{formatDuration(flightMinutes(place.air.km))} in the air, plus airport time.
                    {place.air.fare ? (
                      <>
                        {" "}
                        €{place.air.fare.price} one way on {shortDate(place.air.fare.departureAt)}
                        {place.air.fare.airline ? ` with ${p.airlines[place.air.fare.airline] ?? place.air.fare.airline}` : ""}.{" "}
                        <a href={place.air.fare.url} target="_blank" rel="noreferrer">
                          Book ↗
                        </a>
                      </>
                    ) : (
                      <>
                        {" "}
                        <a href={`https://www.google.com/travel/flights?q=flights+from+${place.air.gateway.iata}+to+${place.air.airport.iata}`} target="_blank" rel="noreferrer">
                          Check fares ↗
                        </a>
                      </>
                    )}
                    {place.ground ? ` Or ${formatDuration(place.ground.minutes)} by ${place.ground.mode}, ${changes(place.ground.changes)}.` : ""}
                  </>
                ) : (
                  <>
                    {changes(place.changes)} by {place.ground?.mode ?? place.mode}, in-vehicle time plus expected waits.
                    {place.air ? ` Or fly via ${place.air.gateway.iata} in ~${formatDuration(place.air.minutes)} door to door${place.price != null ? ` from €${place.price}` : ""}.` : ""}
                  </>
                )}
              </div>
            </>
          )}
          <div className="headline">
            <h3>
              <b>{p.places.length}</b> places{p.places.length !== p.totalPlaces ? ` of ${p.totalPlaces}` : ""}
            </h3>
            <span className="sub">within 10 h door to door</span>
          </div>
          <div className="status muted">
            {!p.origin ? "" : !p.reach && p.totalPlaces === 0 ? "Searching flights, trains and coaches…" : `Estimates by air, train, coach and ferry.${p.anyFares ? ` Prices: ${p.fareSource}.` : ""}`}
          </div>
          <Chips band={p.band} onBand={p.onBand}>
            <button className={`chip${p.bigOnly ? " on" : ""}`} onClick={() => p.onBigOnly(!p.bigOnly)}>
              Big places
            </button>
            {p.anyFares && (
              <button className={`chip${p.pricedOnly ? " on" : ""}`} onClick={() => p.onPricedOnly(!p.pricedOnly)}>
                Priced only
              </button>
            )}
            {p.weatherReady && (
              <button className={`chip${p.warmOnly ? " on" : ""}`} onClick={() => p.onWarmOnly(!p.warmOnly)} title="At least 20 °C on Saturday or Sunday">
                Warm this weekend
              </button>
            )}
          </Chips>
          <div className="scroll">
            {place && p.intel && (
              <div style={{ paddingBottom: 12 }}>
                <PlaceIntel intel={p.intel} summary={p.summary} />
              </div>
            )}
            {p.places.map((x) => (
              <div key={x.key} className={`row${x.key === p.selectedPlace ? " active" : ""}`} onClick={() => p.onPlace(x.key === p.selectedPlace ? null : x.key)}>
                <span className="code">{MODE_TAG[x.mode]}</span>
                <span>
                  <div className="name">{x.name}</div>
                  <div className="sub">{x.mode === "plane" ? `via ${x.air?.gateway.iata}${x.country ? ` · ${countryName(x.country)}` : ""}` : `${changes(x.changes)}${x.country ? ` · ${countryName(x.country)}` : ""}`}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(x.minutes)}</strong>
                  {x.price != null ? `from €${x.price}` : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {p.view === "ground" && (
        <>
          <h2>Nearest stations</h2>
          <div>
            {!p.reach && <div className="status">Searching the rail, coach and ferry network…</div>}
            {p.reach?.starts.slice(0, 3).map((s) => (
              <div key={s.id} className="row">
                <span className="code">{formatDuration(s.minutes)}</span>
                <span>
                  <div className="name">{s.name}</div>
                  <div className="sub">drive, estimated</div>
                </span>
                <span className="meta" />
              </div>
            ))}
            {p.reach && p.reach.starts.length === 0 && <div className="status">No station within 40 km in the feeds loaded so far.</div>}
          </div>
          <h2>Places · {p.reachShown.length}</h2>
          <div className="status muted">{p.reach ? `${p.reach.reached.length} stations within 10 h. In-vehicle time plus an expected wait per leg, not a timetable.` : ""}</div>
          <Chips band={p.band} onBand={p.onBand} />
          <div className="scroll">
            {p.reachShown.map((s) => (
              <div key={s.id} className={`row${s.id === p.selectedStation ? " active" : ""}`} onClick={() => p.onStation(s.id === p.selectedStation ? null : s.id)}>
                <span className="code">{MODE_TAG[s.mode] ?? s.mode}</span>
                <span>
                  <div className="name">{s.town || s.name}</div>
                  <div className="sub">
                    {s.town && s.town !== s.name ? `${s.name} · ` : ""}
                    {changes(s.changes)}
                  </div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(s.minutes)}</strong>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {p.view === "fly" && (
        <>
          <h2>Your airports</h2>
          <div>
            {p.gateways.length === 0 && <div className="status">No airport with scheduled flights within reach.</div>}
            {p.gateways.map((g) => (
              <div key={g.airport.iata} className={`row${g.airport.iata === p.gatewayIata ? " active" : ""}`} onClick={() => p.onGateway(g.airport.iata)}>
                <span className="code">{g.airport.iata}</span>
                <span>
                  <div className="name">{g.airport.name}</div>
                  <div className="sub">{[g.airport.city, countryName(g.airport.country)].filter(Boolean).join(", ")}</div>
                </span>
                <span className="meta">
                  <strong>{formatDuration(g.driveMin)}</strong>
                  {Math.round(g.km)} km · {p.routeCounts[g.airport.iata] ?? 0} routes
                </span>
              </div>
            ))}
          </div>
          {selected && (
            <>
              <div className="row active" onClick={() => p.onDest(null)}>
                <span className="code">{selected.airport.iata}</span>
                <span>
                  <div className="name">{selected.airport.name}</div>
                  <div className="sub">{[selected.airport.city, countryName(selected.airport.country)].filter(Boolean).join(", ")}</div>
                </span>
                <span className="meta">
                  {selected.fare ? (
                    <>
                      <strong>from €{selected.fare.price}</strong>
                      {shortDate(selected.fare.departureAt)} · {stops(selected.fare.transfers)}
                    </>
                  ) : (
                    <>
                      <strong>~{formatDuration(flightMinutes(selected.km))}</strong>
                      {Math.round(selected.km)} km
                    </>
                  )}
                </span>
              </div>
              <div className="status">
                {selected.fare ? (
                  <>
                    €{selected.fare.price} one way on {shortDate(selected.fare.departureAt)}
                    {selected.fare.airline ? ` with ${p.airlines[selected.fare.airline] ?? selected.fare.airline}` : ""}, {stops(selected.fare.transfers)}.{" "}
                    <a href={selected.fare.url} target="_blank" rel="noreferrer">
                      Book ↗
                    </a>
                  </>
                ) : (
                  <>
                    {selected.airlines ? `${selected.airlines} airline${selected.airlines === 1 ? "" : "s"} flew this in the 2014 network. ` : ""}
                    <a href={`https://www.google.com/travel/flights?q=flights+from+${selected.from.iata}+to+${selected.airport.iata}`} target="_blank" rel="noreferrer">
                      Check fares ↗
                    </a>
                  </>
                )}
              </div>
            </>
          )}
          <h2>
            Destinations · {p.destinations.length}
            {p.destinations.length !== p.totalDestinations ? ` of ${p.totalDestinations}` : ""}
          </h2>
          <div className="status muted">
            {p.fares === null ? "Checking fares…" : p.fares.status === "ok" ? `Cheapest one-way fares (${p.fareSource}): ${p.fares.fares.length} priced.` : p.fares.status === "no-token" ? "Route map from the 2014 network. For priced getaways use the Deals tab." : `Fares unavailable: ${p.fares.note ?? "error"}`}
          </div>
          <Chips band={p.band} onBand={p.onBand}>
            {p.fares?.status === "ok" && (
              <button className={`chip${p.pricedOnly ? " on" : ""}`} onClick={() => p.onPricedOnly(!p.pricedOnly)}>
                Priced only
              </button>
            )}
          </Chips>
          <div className="scroll">
            {p.destinations.map((d) => (
              <div key={d.airport.iata} className={`row${d.airport.iata === p.selectedDest ? " active" : ""}`} onClick={() => p.onDest(d.airport.iata)}>
                <span className="code">{d.airport.iata}</span>
                <span>
                  <div className="name">{d.airport.city ?? d.airport.name}</div>
                  <div className="sub">{countryName(d.airport.country)}</div>
                </span>
                <span className="meta">
                  {d.fare ? (
                    <>
                      <strong>from €{d.fare.price}</strong>
                      {shortDate(d.fare.departureAt)} · {stops(d.fare.transfers)}
                    </>
                  ) : (
                    <>
                      <strong>~{formatDuration(flightMinutes(d.km))}</strong>
                      {Math.round(d.km)} km
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
