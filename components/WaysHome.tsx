"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchQuery } from "@/lib/trip-result";
import { addDays, euro, shortDate, todayIso, weekday } from "@/lib/format";
import { formatDuration } from "@/lib/geo";
import s from "./TripPage.module.css";

// Ways home: the days around the end of a trip as a calendar strip, each day with its
// cheapest flight home and its cheapest direct one, direct first because that is what people
// ask for once the way out is fixed. Choosing a day hands the flight (and the ground leg from
// the landing airport to the traveller) to the trip page, which swaps it into its own view and
// shows the new total. The data is GET /api/way-home (lib/way-home.ts, the same engine as the
// chat's way_home tool), which spends one to four live searches, so it loads only when the
// section scrolls into view and a good answer is kept for half an hour.

/** One flight home as /api/way-home answers it. depart and arrive may be "HH:MM" or a full timestamp. */
export type WayFlight = {
  price: number;
  direct: boolean;
  depart: string;
  arrive: string;
  carrier: string;
  url: string;
  to: string;
  toName?: string;
  /** True for a fare from the memory (no live search): no times, the price may have moved. */
  remembered?: boolean;
  from?: string;
  date?: string;
  day?: string;
  stops?: number;
  hours?: number;
  minutes?: number;
};
export type WayHomeDay = { date: string; cheapest?: WayFlight; direct?: WayFlight };
/** minutes and price: the ground leg from that home airport to the traveller's door (price is an estimate). */
export type HomeLeg = { airport: string; minutes: number; price: number; name?: string };
export type WayHomeResponse = {
  days: WayHomeDay[];
  bestDirect?: WayFlight;
  cheapest?: WayFlight;
  homeLegs: HomeLeg[];
  searched: number;
  /** Searches that failed for this answer; the answer is partial and worth asking again. */
  failed?: number;
  /** Every search was refused because live prices are rate-limited. */
  refused?: boolean;
  note?: string;
  error?: string;
};
/** What the visitor picked: the day, the flight and the ground leg home when the engine knows it. */
export type WayHomeChoice = { date: string; flight: WayFlight; ground?: HomeLeg };

// ---- small helpers the trip page shares ----

/**
 * GET a JSON body once per URL for half an hour (the server keeps its answers as long):
 * reopening a trip, or two sections asking for the same city, costs no second request, and a
 * page left open all day still asks again for prices. A failure is forgotten so a retry
 * really asks again.
 */
const JSON_TTL_MS = 30 * 60_000;
const jsonCache = new Map<string, { at: number; p: Promise<unknown> }>();
export function getJson<T>(url: string): Promise<T> {
  const hit = jsonCache.get(url);
  if (hit && Date.now() - hit.at < JSON_TTL_MS) return hit.p as Promise<T>;
  const p = fetch(url).then(async (r) => {
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
    return body;
  });
  p.catch(() => forgetJson(url));
  jsonCache.set(url, { at: Date.now(), p });
  return p as Promise<T>;
}
/** Drops a kept answer, for one that resolved but should not be reused (a refusal, a partial answer). */
export function forgetJson(url: string): void {
  jsonCache.delete(url);
}

/** "06:10" from "06:10", "2026-11-03T06:10:00" or "2026-11-03 06:10"; empty when there is no time. */
export function hhmm(t: string | undefined): string {
  if (!t) return "";
  const m = /(\d{2}):(\d{2})/.exec(t.length > 8 ? t.slice(10) : t);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** The day of a flight: its own date field, else the date part of a full timestamp. */
export function dayOf(f: { date?: string; day?: string; depart?: string }, fallback = ""): string {
  if (f.date) return f.date.slice(0, 10);
  if (f.day) return f.day.slice(0, 10);
  if (f.depart && /^\d{4}-\d{2}-\d{2}/.test(f.depart)) return f.depart.slice(0, 10);
  return fallback;
}

/** Calls a function once the element is near the viewport (or at once where IntersectionObserver is missing). */
export function useNearView<T extends Element>(onNear: () => void, enabled = true) {
  const ref = useRef<T | null>(null);
  const fired = useRef(false);
  const cb = useRef(onNear);
  cb.current = onNear;
  useEffect(() => {
    if (!enabled) return;
    // Enabled again (a new trip, a new window): the next time it is near, it fires again.
    fired.current = false;
    const el = ref.current;
    const fire = () => {
      if (fired.current) return;
      fired.current = true;
      cb.current();
    };
    if (!el || typeof IntersectionObserver === "undefined") {
      fire();
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (fire(), io.disconnect()), { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

type Props = {
  /** The place the traveller flies home from: the trip's last stop. */
  from: { name: string; code?: string; country?: string; lat: number; lon: number };
  /** The trip's own last day, YYYY-MM-DD: the window is the days around it. */
  around: string;
  query?: SearchQuery;
  /** The first day it makes sense to leave: the day after reaching the last stop, so it keeps a night. */
  notBefore?: string;
  /** The day the trip already flies home on, marked in the strip; absent for a one-way trip. */
  currentDay?: string;
  /** The price of the way home the trip has now, when it is a ticket of its own; the strip shows the difference. */
  currentPrice?: number | null;
  chosen: WayHomeChoice | null;
  onChoose: (c: WayHomeChoice | null) => void;
};

/** Days either side of the trip's end the strip covers; a week in all keeps it to one or two searches. */
const SPAN_BEFORE = 3;
const SPAN_AFTER = 3;

export default function WaysHome({ from, around, notBefore, query, currentDay, currentPrice, chosen, onChoose }: Props) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ok" | "error"; data?: WayHomeResponse; note?: string }>({ status: "idle" });
  const [day, setDay] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The window: three days either side of the trip's end, never before tomorrow nor before the
  // traveller has had a night at the last stop; a window cut at the start runs on at the end, so
  // the strip keeps its week.
  const tomorrow = addDays(todayIso(), 1);
  const floor = notBefore && notBefore > tomorrow ? notBefore : tomorrow;
  const end = around && around >= floor ? around : floor;
  const fromDate = addDays(end, -SPAN_BEFORE) < floor ? floor : addDays(end, -SPAN_BEFORE);
  const toDate = addDays(fromDate, SPAN_BEFORE + SPAN_AFTER) > addDays(end, SPAN_AFTER) ? addDays(fromDate, SPAN_BEFORE + SPAN_AFTER) : addDays(end, SPAN_AFTER);

  const url = useMemo(() => {
    const p = new URLSearchParams({ from: from.name, fromDate, toDate });
    // The stop's own city and country, so a name two cities share (Sydney) is the one the trip went to.
    if (from.code && /^[A-Z]{3}$/.test(from.code)) p.set("code", from.code);
    if (from.country && /^[A-Z]{2}$/.test(from.country)) p.set("cc", from.country);
    if (query?.filters?.direct) p.set("direct", "1");
    if (query?.from) {
      if (query.from.home) p.set("home", query.from.home);
      if (Number.isFinite(query.from.lat) && Number.isFinite(query.from.lon)) {
        p.set("lat", query.from.lat.toFixed(4));
        p.set("lon", query.from.lon.toFixed(4));
        // The name of the door, so the engine's notes say "to Brasov" rather than "home".
        const label = query.from.label?.replace(/[^\p{L}\p{N} ,.'()&-]/gu, "").trim().slice(0, 60);
        if (label) p.set("label", label);
      }
      // The traveller's own airports, so the strip searches home to them and not to a guess.
      const g = (query.from.airports ?? []).filter((a) => /^[A-Z]{3}$/.test(a)).slice(0, 5);
      if (g.length) p.set("g", g.join(","));
    }
    return `/api/way-home?${p}`;
  }, [from.name, from.code, from.country, fromDate, toDate, query?.filters?.direct, query?.from]);

  const load = () => {
    setState({ status: "loading" });
    getJson<WayHomeResponse>(url)
      .then((data) => {
        if (data?.error) throw new Error(data.error);
        const days = Array.isArray(data?.days) ? data.days : [];
        // A refusal, a partial answer or an empty one is not kept: asking again later may do better.
        if (data?.refused || (data?.failed ?? 0) > 0 || !days.some((d) => d.cheapest || d.direct)) forgetJson(url);
        if (data?.refused) throw new Error(data.note ?? "live prices are rate-limited right now; try again in a few minutes");
        setState({ status: "ok", data: { ...data, days, homeLegs: Array.isArray(data?.homeLegs) ? data.homeLegs : [] } });
      })
      .catch((err: unknown) => setState({ status: "error", note: err instanceof Error ? err.message : "the search failed" }));
  };
  // A new place or window (another trip) starts over.
  useEffect(() => {
    setState({ status: "idle" });
    setDay(null);
  }, [url]);
  const ref = useNearView<HTMLElement>(load, state.status === "idle");
  // Retry after an error: the cache forgot the failure, so this really asks again.
  useEffect(() => {
    if (attempt > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const data = state.data;
  const days = useMemo(() => (data?.days ?? []).filter((d) => d.cheapest || d.direct).sort((a, b) => a.date.localeCompare(b.date)), [data]);
  const allDays = useMemo(() => {
    // Every day of the window gets a cell, so an empty day reads as "nothing" rather than vanishing.
    const out: WayHomeDay[] = [];
    const byDate = new Map(days.map((d) => [d.date.slice(0, 10), d]));
    for (let d = fromDate; d <= toDate; d = addDays(d, 1)) out.push(byDate.get(d) ?? { date: d });
    return out;
  }, [days, fromDate, toDate]);
  const cheapestPrice = Math.min(...days.map((d) => d.cheapest?.price ?? Infinity));
  const cheapestDirect = Math.min(...days.map((d) => d.direct?.price ?? Infinity));
  const groundFor = (airport: string) => data?.homeLegs.find((h) => h.airport === airport);
  const selected = day ? allDays.find((d) => d.date === day) : undefined;

  const choose = (date: string, flight: WayFlight) => onChoose({ date, flight, ground: groundFor(flight.to) });
  const pickDay = (d: WayHomeDay) => {
    setDay(d.date);
    // Direct first: a day with a direct flight picks it, else the cheapest.
    const f = d.direct ?? d.cheapest;
    if (f) choose(d.date, f);
  };
  const diff = (p: number) => (currentPrice != null ? p - currentPrice : null);

  const bestDirect = data?.bestDirect;
  const bestDirectDay = bestDirect ? dayOf(bestDirect) : "";

  return (
    <section ref={ref} className={s.section} aria-labelledby="wayshome-h">
      <div className={s.sectionHead}>
        <h3 id="wayshome-h" className={s.h3}>
          Ways home
        </h3>
        <span className={s.sectionSub}>
          from {from.name}, {shortDate(fromDate)} to {shortDate(toDate)}, direct first
        </span>
      </div>

      {(state.status === "idle" || state.status === "loading") && (
        <div className={s.dayStrip} aria-busy="true">
          {Array.from({ length: SPAN_BEFORE + SPAN_AFTER + 1 }, (_, i) => (
            <div key={i} className={`${s.dayCell} ${s.shimmer}`} />
          ))}
        </div>
      )}
      {state.status === "loading" && <p className={s.muted}>Checking a week of flights home from {from.name}.</p>}

      {state.status === "error" && (
        <div className={s.notice}>
          <span>Could not check the ways home right now{state.note ? ` (${state.note})` : ""}.</span>
          <button className={s.linkBtn} onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ok" && data && (
        <>
          {!days.length ? (
            <p className={s.muted}>{data.note ?? `No flights home found from ${from.name} on these days.`}</p>
          ) : (
            <>
              <div className={s.dayStrip} role="listbox" aria-label="Days to fly home">
                {allDays.map((d) => {
                  const empty = !d.cheapest && !d.direct;
                  const isSel = (chosen?.date ?? day) === d.date;
                  const isCheapest = d.cheapest?.price === cheapestPrice;
                  return (
                    <button
                      key={d.date}
                      role="option"
                      aria-selected={isSel}
                      disabled={empty}
                      className={`${s.dayCell}${isSel ? ` ${s.daySel}` : ""}${empty ? ` ${s.dayEmpty}` : ""}`}
                      onClick={() => pickDay(d)}
                      title={empty ? "No flight home found that day" : undefined}
                    >
                      <span className={s.dayWk}>{weekday(d.date)}</span>
                      <span className={s.dayNum}>{shortDate(d.date)}</span>
                      {d.direct ? (
                        <span className={`${s.dayDirect}${d.direct.price === cheapestDirect ? ` ${s.best}` : ""}`}>{euro(d.direct.price)}</span>
                      ) : (
                        <span className={s.dayNone}>{empty ? "none" : "no direct"}</span>
                      )}
                      {d.cheapest && (!d.direct || d.cheapest.price < d.direct.price) && <span className={`${s.dayCheap}${isCheapest ? ` ${s.best}` : ""}`}>{euro(d.cheapest.price)}</span>}
                      {currentDay === d.date && <span className={s.dayYours}>your day</span>}
                    </button>
                  );
                })}
              </div>
              <div className={s.legend}>
                <span>
                  <i className={s.dotDirect} /> direct
                </span>
                <span>
                  <i className={s.dotCheap} /> cheapest with a stop
                </span>
              </div>

              {!selected && bestDirect && (
                <button className={s.suggest} onClick={() => choose(bestDirectDay || end, bestDirect)}>
                  Best direct: {bestDirectDay ? `${weekday(bestDirectDay)} ${shortDate(bestDirectDay)}, ` : ""}
                  {hhmm(bestDirect.depart) ? `${hhmm(bestDirect.depart)} ` : ""}
                  {bestDirect.carrier ? `with ${bestDirect.carrier}, ` : ""}
                  <b>{euro(bestDirect.price)}</b>
                </button>
              )}

              {selected && (
                <div className={s.dayOptions}>
                  {[selected.direct, selected.cheapest && selected.cheapest.url !== selected.direct?.url ? selected.cheapest : undefined]
                    .filter((f): f is WayFlight => !!f)
                    .map((f) => {
                      const on = chosen?.flight.url === f.url && chosen.date === selected.date;
                      const g = groundFor(f.to);
                      const delta = diff(f.price);
                      return (
                        <div key={f.url} className={`${s.option}${on ? ` ${s.optionOn}` : ""}`}>
                          <button className={s.optionMain} onClick={() => choose(selected.date, f)} aria-pressed={on}>
                            <span className={s.optionKind}>{f.direct ? "Direct" : `${f.stops ?? 1} stop${(f.stops ?? 1) === 1 ? "" : "s"}`}</span>
                            <span className={s.optionTimes}>
                              {[hhmm(f.depart) && (hhmm(f.arrive) ? `${hhmm(f.depart)} to ${hhmm(f.arrive)}` : hhmm(f.depart)), `${f.from ?? from.code ?? from.name} to ${f.toName ?? f.to}`, f.hours ? `${Math.round(f.hours * 10) / 10} h` : "", f.carrier, f.remembered ? "a price seen recently" : ""].filter(Boolean).join(" · ")}
                            </span>
                            <b className={s.optionPrice}>{euro(f.price)}</b>
                            {delta != null && Math.abs(delta) >= 1 && <small className={delta < 0 ? s.cheaper : s.dearer}>{delta < 0 ? `${euro(-delta)} less` : `${euro(delta)} more`}</small>}
                          </button>
                          {g && (
                            <span className={s.optionGround}>
                              then {g.name ?? g.airport} to you, about {formatDuration(Math.round(g.minutes))}
                              {g.price ? `, about ${euro(g.price)} (estimate)` : ""}
                            </span>
                          )}
                          <a className={s.book} href={f.url} target="_blank" rel="noreferrer">
                            Book ↗
                          </a>
                        </div>
                      );
                    })}
                </div>
              )}

              {chosen && (
                <button
                  className={s.linkBtn}
                  onClick={() => {
                    setDay(null);
                    onChoose(null);
                  }}
                >
                  Keep the original way home
                </button>
              )}
              {data.note && <p className={s.muted}>{data.note}</p>}
            </>
          )}
          {(data.failed ?? 0) > 0 && (
            <button className={s.linkBtn} onClick={() => setAttempt((n) => n + 1)}>
              Some searches failed. Try again
            </button>
          )}

          {data.homeLegs.length > 1 && (
            <details className={s.homeAirports}>
              <summary>Home airports searched ({data.homeLegs.length})</summary>
              <ul>
                {data.homeLegs.map((h) => (
                  <li key={h.airport}>
                    <b>{h.airport}</b>
                    {h.name ? ` ${h.name}` : ""}: {h.minutes > 0 ? `about ${formatDuration(Math.round(h.minutes))} to you` : "at home"}
                    {h.price ? `, about ${euro(h.price)}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
