"use client";

// The Ask tab: a conversation with the Atlas agent. The agent acts first and asks at most one
// question, which arrives as a widget (dates, month, nights, region, choices, people, a pick
// on the globe) rendered here; an answer is sent back as a short message. Results come back
// as cards, a price calendar, bases or group options, and flow to the globe as pins or a
// route. Threads are kept in the browser; voice input uses the Web Speech API when it exists.
//
// Everything the chat finds is a starting point for the rest of the app: a computed route is
// drawn at once (atlas:route-result, no second search), any route option, deal, wild trip or
// event can become an itinerary (atlas:itinerary with a skeleton from lib/itinerary.ts), a
// written itinerary opens in the itinerary view, and an event can be shown on the map
// (atlas:command) or reached (atlas:route). A graph walk (walk_trips) is drawn while it runs
// (its nodes, edges and loops go on as atlas:walk-live) and again the moment it arrives
// (atlas:walk-result); its loops are cards with the route as a line of hops, and its progress
// lines show on the tool's chip while it runs (preliminary tool outputs). The event details
// are built in lib/chat-widgets.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import type { Deal } from "@/lib/types";
import type { WildTrip } from "@/lib/wild";
import type { RouteResult } from "@/lib/route-finder";
import type { WalkResult } from "@/lib/graph-walk";
import { skeletonFromDeal, skeletonFromEvent, skeletonFromRoute, skeletonFromWalk, skeletonFromWild, type BudgetTier, type Itinerary, type ItinPlace, type Pace, type Skeleton } from "@/lib/itinerary";
import { countryName, dateRange, monthLabel, monthOptions } from "@/lib/format";
import { formatDuration } from "@/lib/geo";
import { WILD_REGIONS } from "@/lib/ui-types";
import { FOLLOWUPS, ISO_DAY_RE, LOCAL_DAY, LONG_TOOLS, NIGHT_OPTIONS, ROUTE_KIND_LABEL, TOOL_LABEL, addDays, dispatchAtlas, eventCommand, eventDays, eventRoute, eventTripDays, quickDateRanges, routeDetail, routeResultDetail, toolProgress, walkResultDetail, widgetAnswer, type ChatEvent, type PersonRow, type WalkLiveLine, type WalkQuery, type WidgetKind, type WidgetSpec } from "@/lib/chat-widgets";
import s from "./ChatPanel.module.css";

export type ChatContext = { origin?: { lat: number; lon: number; label: string }; gateways: string[]; home: string; month?: string; today?: string; been?: { countries: string[]; newOnly: boolean } };

type Props = {
  context: ChatContext;
  seed: string | null;
  onSeedConsumed: () => void;
  onDeals: (deals: Deal[]) => void;
  onTrip: (trip: WildTrip) => void;
  onOpenDeal: (key: string) => void;
};

type Thread = { id: string; title: string; updated: number; messages: UIMessage[] };
type Store = { active: string; threads: Thread[] };
type ToolPart = { type: string; toolCallId?: string; state?: string; input?: unknown; output?: unknown; errorText?: string; preliminary?: boolean };
type ScanRow = { month: string; cheapest: number | null; out?: string; back?: string; nights?: number; perNight?: number; stops?: number; airline?: string; from?: string; homeFrom?: string; url?: string; url2?: string; failed?: boolean };
type ScanOut = { to: string; nights: string; oneWay: boolean; searched: number; failed?: number; note?: string; best: ScanRow | null; months: ScanRow[]; openJaw: ScanRow[]; raw?: Deal[] };
type BaseOut = { base: string; country: string; flightIn: string; flightOut: string; rentPerMonth: number; livingPerMonth: number; total: number; perDay: number; why: string[]; sideTrips: string[]; visa?: string | null; urlIn?: string; urlOut?: string };
type GroupOut = { windows: { dates: string; nights: number; everyone: boolean; compromises: string[] }[]; options: { city: string; country: string; dates: string; nights: number; everyone: boolean; total: number; perMember: { name: string; price: number; from: string; out: string; back: string; url: string; note?: string }[] }[] };
type Itin = { price: number; out: string; back?: string; nights: number | null; stops: number; via?: string[]; carriers: string[]; hours: number; url: string };
type InsightOut = { route: string; month: string; typical: number | null; samples: number; low: number | null; verdict: string; note?: string };
type MonthsOut = { city: string; best: string[]; months: { month: string; highC: number; rainMm: number; score: number }[] };
/** One option of cheapest_way as the tool compacts it (the legs are one line each). */
type RouteOptOut = { kind: string; title: string; total: number; hours: number; stops: number; nonstop?: boolean; why: string; legs: string[]; back?: string[]; backTotal?: number; urls: string[]; cheapest?: boolean; fastest?: boolean };
type RouteOut = { from: string; to: string; depart?: string; flex?: number; nights: number | null; searched: number; source?: string; considered?: string[]; note?: string; cheapest: RouteOptOut | null; fastest: RouteOptOut | null; options: RouteOptOut[]; raw?: RouteResult };
/** One day of make_itinerary as the tool compacts it. */
type ItinDayOut = { day: number; date: string; where: string; title: string; plan: string; travel?: string; weather?: string };
type ItinOut = { title: string; start: string; end: string; nights: number; stops: string[]; days: ItinDayOut[]; costs?: { total: number; perDay: number; estimated: boolean }; status?: string; note?: string; skeleton?: Skeleton; wishes?: string; pace?: Pace; budget?: BudgetTier; raw?: Itinerary };
type EventOut = ChatEvent & { kind?: string; note?: string; cheapestTrip: { price: number; dates?: string; from?: string; key?: string } | null };
/** One leg and one loop of walk_trips as the tool compacts them (the names are already the traveller's words). */
type WalkLegOut = { kind: "fly" | "train" | "coach" | "ferry" | "road"; from: string; to: string; date: string; depart?: string; minutes: number; price: number; estimated?: boolean; carrier?: string; source: string; url?: string };
type WalkLoopOut = { title: string; route: string; start: string; end: string; nights: number; total: number; hours: number; stops: { name: string; country: string; nights: number; arrive: string }[]; legs: WalkLegOut[]; why: string[] };
type WalkOut = { from: string; window?: string; nights?: string; nightsPerStop?: string; searched: number; source?: string; count: number; note?: string; corrected?: string; partial?: boolean; considered?: string[]; loops: WalkLoopOut[]; params?: WalkQuery; raw?: WalkResult };
/** walk_trips while it runs: each preliminary output is the walk's latest progress line, and its newest lines for
 * the globe (`live`, from index `at`) with the query that draws them. */
type WalkProgress = { running: true; progress: string; lines?: string[]; loops?: number; edges?: number; searched?: number; live?: { at: number; lines: WalkLiveLine[] }; params?: WalkQuery };
/** A tool part still at work: the input is streaming or waiting, or the output so far is a preliminary one. */
const isRunning = (p: ToolPart) => p.state === "input-streaming" || p.state === "input-available" || (p.state === "output-available" && p.preliminary === true);
/** The traveller's own point as an itinerary place, when the browser knows it. */
const herePlace = (c: ChatContext): ItinPlace | undefined => (c.origin ? { name: c.origin.label, lat: c.origin.lat, lon: c.origin.lon } : undefined);
/** Opens the itinerary view on a skeleton (it generates there). */
const openSkeleton = (skeleton: Skeleton) => dispatchAtlas("atlas:itinerary", { skeleton });

// Threads live in localStorage as one small index plus one key per thread, so a turn writes
// only the thread it changed; the older one-key stores (v2, and the single v1 conversation)
// are moved over once and removed.
const INDEX_KEY = "atlas-chat-threads-v3";
const MSGS_KEY = (id: string) => `atlas-chat-msgs-v3:${id}`;
const V2_STORE = "atlas-chat-threads-v2";
const V1_STORE = "atlas-chat-v1";
const MAX_MESSAGES = 40;
const MAX_THREADS = 30;
/** A thread past this many bytes loses its oldest turns before it is written. */
const MAX_THREAD_BYTES = 200_000;
/** A streamed answer writes at most this often; the end of a turn writes at once. */
const SAVE_DEBOUNCE_MS = 500;
const STARTERS = ["I want to get back to San Francisco", "A 3 to 6 night getaway to a cool autumn place between 20 and 30 October", "Where is warm and cheap for a weekend?", "Two months somewhere warm this winter, mid budget", "Plan a weekend for me and two friends from different cities"];
const RAW_DEAL_TOOLS = new Set(["find_getaways", "cheapest_deals", "scan_cheapest", "long_stay", "group_trip", "events_worth_travelling_for"]);
const STORAGE_NOTE = "This browser's storage is full or off, so this conversation will not be kept after you leave.";

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10));
const blankThread = (): Thread => ({ id: newId(), title: "New chat", updated: Date.now(), messages: [] });
type ThreadMeta = { id: string; title: string; updated: number };

function readKey<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function writeKey(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}
const isToolPart = (p: unknown): p is ToolPart => !!p && typeof p === "object" && typeof (p as ToolPart).type === "string" && (p as ToolPart).type.startsWith("tool-");

/** The scan_cheapest parts of one assistant message whose calendar is NOT drawn: when the model
 * scanned the same destination over the same months twice (once plain, once with the open-jaw),
 * the two tables would say the same thing, so only one is kept, the one that has the open-jaw
 * rows (else the first). Keyed by the part's position in the message. */
function duplicateCalendars(m: UIMessage): Set<number> {
  const skip = new Set<number>();
  const groups = new Map<string, number[]>();
  m.parts.forEach((part, i) => {
    if (!isToolPart(part) || part.type !== "tool-scan_cheapest" || part.state !== "output-available") return;
    const out = part.output as (Partial<ScanOut> & { error?: unknown }) | undefined;
    if (!out || !Array.isArray(out.months) || typeof out.error === "string") return;
    const key = `${out.to ?? ""}|${out.oneWay ? 1 : 0}|${out.months.map((r) => r.month).join(",")}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const withJaw = idx.find((i) => ((m.parts[i] as ToolPart).output as Partial<ScanOut>).openJaw?.length);
    const keep = withJaw ?? idx[0];
    for (const i of idx) if (i !== keep) skip.add(i);
  }
  return skip;
}

/** A tool call that never got its answer (Stop, a tab switch mid-search, a closed tab) becomes a
 * plain error part, so the thread can go on: the server also drops such calls, but a part left
 * in "input-available" would otherwise spin forever in the list. */
function settle(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (!isToolPart(p) || !isRunning(p)) return p;
      changed = true;
      const { preliminary: _pre, output: _out, ...rest } = p as ToolPart;
      void _pre;
      void _out;
      return { ...rest, state: "output-error", errorText: "stopped before it finished", input: p.input ?? {} } as unknown as typeof p;
    });
    return changed ? { ...m, parts } : m;
  });
}

/** The thread as sent to the server: make_itinerary answers lose their raw itinerary (the skeleton stays). */
function withoutItineraries(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.parts.some((p) => isToolPart(p) && p.type === "tool-make_itinerary")) return m;
    const parts = m.parts.map((p) => {
      if (!isToolPart(p) || p.type !== "tool-make_itinerary" || !p.output || typeof p.output !== "object" || !("raw" in p.output)) return p;
      const { raw: _raw, ...rest } = p.output as Record<string, unknown>;
      void _raw;
      return { ...p, output: rest } as typeof p;
    });
    return { ...m, parts };
  });
}

/** What is written to the browser: settled, without the raw payloads (the cards redraw from the
 * compact rows), at most MAX_MESSAGES, and under MAX_THREAD_BYTES with the oldest turns dropped. */
function slim(messages: UIMessage[]): UIMessage[] {
  let out = settle(messages.slice(-MAX_MESSAGES)).map((m) => {
    if (m.role !== "assistant") return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (!isToolPart(p) || !p.output || typeof p.output !== "object" || !("raw" in p.output)) return p;
      changed = true;
      const { raw: _raw, ...rest } = p.output as Record<string, unknown>;
      void _raw;
      return { ...p, output: rest } as typeof p;
    });
    return changed ? { ...m, parts } : m;
  });
  while (out.length > 2 && JSON.stringify(out).length > MAX_THREAD_BYTES) {
    out = out.slice(1);
    while (out.length && out[0].role !== "user") out = out.slice(1);
  }
  return out;
}

/** Threads from the browser; an older store is moved into the per-thread keys once. */
function loadStore(): Store {
  try {
    const idx = readKey<{ active: string; threads: ThreadMeta[] }>(INDEX_KEY);
    if (idx && Array.isArray(idx.threads) && idx.threads.length) {
      const threads: Thread[] = idx.threads
        .filter((t) => t && typeof t.id === "string")
        .slice(0, MAX_THREADS)
        .map((t) => ({ id: t.id, title: String(t.title ?? "New chat"), updated: Number(t.updated) || 0, messages: settle((readKey<UIMessage[]>(MSGS_KEY(t.id)) ?? []).filter((m) => m && Array.isArray(m.parts))) }));
      if (threads.length) return { active: threads.some((t) => t.id === idx.active) ? idx.active : threads[0].id, threads };
    }
    let moved: Store | null = null;
    const v2 = readKey<Store>(V2_STORE);
    if (v2 && Array.isArray(v2.threads) && v2.threads.length) {
      const threads = v2.threads.filter((t) => t && typeof t.id === "string").slice(0, MAX_THREADS).map((t) => ({ id: t.id, title: t.title || "New chat", updated: t.updated || 0, messages: slim(Array.isArray(t.messages) ? t.messages : []) }));
      if (threads.length) moved = { active: threads.some((t) => t.id === v2.active) ? v2.active : threads[0].id, threads };
    }
    if (!moved) {
      const v1 = readKey<{ messages?: UIMessage[] }>(V1_STORE);
      const msgs = slim(Array.isArray(v1?.messages) ? v1!.messages! : []);
      if (msgs.length) {
        const t: Thread = { ...blankThread(), title: titleOf(msgs) ?? "Earlier chat", messages: msgs };
        moved = { active: t.id, threads: [t] };
      }
    }
    if (moved) {
      for (const t of moved.threads) writeKey(MSGS_KEY(t.id), t.messages);
      writeKey(INDEX_KEY, { active: moved.active, threads: moved.threads.map(({ id, title, updated }) => ({ id, title, updated })) });
      try {
        localStorage.removeItem(V2_STORE);
        localStorage.removeItem(V1_STORE);
      } catch {
        // storage off
      }
      return moved;
    }
  } catch {
    // storage off or unreadable
  }
  const t = blankThread();
  return { active: t.id, threads: [t] };
}
/** Writes the index and, when given, one thread's messages. False when the browser refused. */
function saveStore(st: Store, threadId?: string): boolean {
  let ok = writeKey(INDEX_KEY, { active: st.active, threads: st.threads.map(({ id, title, updated }) => ({ id, title, updated })) });
  if (threadId) {
    const t = st.threads.find((x) => x.id === threadId);
    if (t) ok = writeKey(MSGS_KEY(t.id), slim(t.messages)) && ok;
  }
  return ok;
}
function dropThreadKey(id: string) {
  try {
    localStorage.removeItem(MSGS_KEY(id));
  } catch {
    // storage off
  }
}

type CompactDeal = { key: string; city: string; country: string; price: number; dates?: string; nights?: number; from?: string; stops?: number; url?: string; homeVia?: string; flightMinutes?: number };
/** The deals of a tool result for the cards: the raw ones while this session has them, else the
 * compact rows (what a restored thread keeps) turned back into the Deal shape the cards read. */
function cardDeals(out: Record<string, unknown>): Deal[] {
  if (Array.isArray(out.raw) && out.raw.length) return out.raw as Deal[];
  const rows = Array.isArray(out.deals) ? (out.deals as CompactDeal[]) : [];
  return rows
    .filter((r) => r && typeof r.key === "string" && typeof r.price === "number")
    .map((r) => {
      const [gw = "", dst = "", outDay = ""] = r.key.split("|");
      const [o, b] = String(r.dates ?? "").split(" to ");
      return { gw, dst, dstCity: dst, city: String(r.city ?? dst), country: String(r.country ?? ""), price: r.price, out: o || outDay, back: b ?? "", nights: r.nights ?? 0, stops: r.stops ?? 0, carriers: [], outMin: r.flightMinutes ?? 0, backMin: 0, url: String(r.url ?? ""), ...(r.homeVia ? { backTo: r.homeVia } : {}) };
    });
}
function titleOf(msgs: UIMessage[]): string | null {
  const first = msgs.find((m) => m.role === "user");
  const text = first?.parts.find((p) => p.type === "text") as { text?: string } | undefined;
  const t = text?.text?.trim();
  return t ? (t.length > 48 ? t.slice(0, 46) + "…" : t) : null;
}
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 2 ? "now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const euro = (n: number | null | undefined) => (n == null ? "" : `€${Math.round(n)}`);

/** Light markdown: paragraphs, **bold**, [links](url) and bare urls. */
function Text({ text }: { text: string }) {
  const paras = text.split(/\n{2,}/).filter((p) => p.trim());
  const render = (str: string) =>
    str.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+)/).map((bit, k) => {
      if (bit.startsWith("**") && bit.endsWith("**")) return <b key={k}>{bit.slice(2, -2)}</b>;
      const link = bit.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (link)
        return (
          <a key={k} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      if (/^https?:\/\//.test(bit))
        return (
          <a key={k} href={bit} target="_blank" rel="noreferrer">
            {bit.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
          </a>
        );
      return <span key={k}>{bit}</span>;
    });
  return (
    <div className={s.text}>
      {paras.map((para, i) => (
        <p key={i}>{render(para.replace(/\n/g, " "))}</p>
      ))}
    </div>
  );
}

function DealCards({ deals, onOpen, origin }: { deals: Deal[]; onOpen: (key: string) => void; origin?: ItinPlace }) {
  return (
    <div className={s.cards}>
      {deals.slice(0, 6).map((d) => (
        <div key={`${d.gw}|${d.dst}|${d.out}|${d.backTo ?? ""}`} className={s.dealRow}>
        <button className={s.card} onClick={() => onOpen(`${d.gw}|${d.dst}|${d.out}`)}>
          <span className={s.price}>€{d.price}</span>
          <span className={s.body}>
            <b>
              {d.city} <span className={s.sub}>{countryName(d.country)}</span>
            </b>
            <span className={s.sub}>
              {d.back ? dateRange(d.out, d.back) : d.out}
              {d.nights ? ` · ${d.nights}n` : ""} · {d.gw}
              {d.backFromCity ? ` · home from ${d.backFromCity}` : ""}
              {d.backTo ? ` → ${d.backTo}` : ""} · {d.stops ? `${d.stops} stop` : "direct"}
              {d.outMin ? ` · ${formatDuration(d.outMin)}` : ""}
            </span>
          </span>
        </button>
        <button className={s.mini} title="Plan the days of this trip" onClick={() => openSkeleton(skeletonFromDeal(d, origin))}>
          Make an itinerary
        </button>
        </div>
      ))}
    </div>
  );
}

/** A written itinerary in short: a timeline of the days, the estimated total, and the button that opens the full view. */
function ItineraryCard({ out }: { out: ItinOut }) {
  const days = out.days ?? [];
  const open = () => {
    // A plan the tool cut short (its time ran out, days are missing) is opened from its
    // skeleton, so the view writes the whole trip; opening the partial plan would show the
    // missing days as done. A partial plan with every day (some from the guides) opens as is.
    const r = out.raw;
    const span = r?.start && r.end ? Math.round((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000) + 1 : 0;
    const cut = !!r && r.status === "partial" && r.days.length < span;
    if (r && !(cut && out.skeleton)) dispatchAtlas("atlas:itinerary", { itinerary: r });
    else if (out.skeleton) dispatchAtlas("atlas:itinerary", { skeleton: out.skeleton, ...(out.wishes ? { wishes: out.wishes } : {}), ...(out.pace ? { pace: out.pace } : {}), ...(out.budget ? { budget: out.budget } : {}) });
  };
  const canOpen = !!(out.raw || out.skeleton);
  return (
    <div className={`${s.base} ${s.itin}`}>
      <div className={s.row}>
        <b>{out.title}</b>
        {out.costs && <span className={s.price}>{euro(out.costs.total)}</span>}
      </div>
      <span className={s.sub}>
        {out.start ? dateRange(out.start, out.end) : ""} · {out.nights} night{out.nights === 1 ? "" : "s"}
        {out.costs ? ` · about ${euro(out.costs.perDay)} a day${out.costs.estimated ? ", estimated" : ""}` : ""}
        {out.status === "partial" ? " · partly written" : ""}
      </span>
      <ol className={s.days}>
        {days.slice(0, 8).map((d, i) => (
          <li key={d.day} style={{ animationDelay: `${i * 60}ms` }}>
            <span className={s.dayHead}>
              Day {d.day} · {d.date} · {d.where}
              {d.weather ? ` · ${d.weather}` : ""}
            </span>
            <span className={s.dayTitle}>{d.title}</span>
            {d.travel && <span className={s.sub}>{d.travel}</span>}
            {d.plan && <span className={s.sub}>{d.plan}</span>}
          </li>
        ))}
      </ol>
      {days.length > 8 && <p className={s.caption}>And {days.length - 8} more days in the full itinerary.</p>}
      {canOpen && (
        <div className={s.actions}>
          <button className={s.go} onClick={open}>
            Open the itinerary
          </button>
        </div>
      )}
    </div>
  );
}

/** Events worth the trip: each with its fare when priced, shown on the map, reached, or planned. */
function EventCards({ events, origin }: { events: EventOut[]; origin?: ItinPlace }) {
  return (
    <div className={s.cards}>
      {events.slice(0, 6).map((e, i) => {
        const days = eventDays(e);
        // The trip's days, not the event's: an event already on is joined from tomorrow.
        const trip = eventTripDays(e, LOCAL_DAY(new Date()));
        const plannable = trip && typeof e.lat === "number" && typeof e.lon === "number";
        return (
          <div key={`${e.event}-${i}`} className={s.base}>
            <div className={s.row}>
              <b>
                {e.event} <span className={s.sub}>{e.city}</span>
              </b>
              {e.cheapestTrip && <span className={s.price}>{euro(e.cheapestTrip.price)}</span>}
            </div>
            <span className={s.sub}>
              {days ? (days.start === days.end ? days.start : dateRange(days.start, days.end)) : e.dates}
              {e.kind ? ` · ${e.kind}` : ""}
              {e.cheapestTrip ? ` · return from ${e.cheapestTrip.from ?? "your airports"}${e.cheapestTrip.dates ? `, ${e.cheapestTrip.dates}` : ""}` : " · not priced yet"}
            </span>
            {e.note && <span className={s.sub}>{e.note}</span>}
            <div className={s.actions}>
              <button className={s.mini} onClick={() => dispatchAtlas("atlas:command", eventCommand(e))}>
                Show on the map
              </button>
              <button className={s.mini} onClick={() => dispatchAtlas("atlas:route", eventRoute(e, LOCAL_DAY(new Date())))}>
                Get there
              </button>
              {plannable && (
                <button className={s.mini} onClick={() => openSkeleton(skeletonFromEvent({ name: e.event, city: e.city, country: e.country ?? "", lat: e.lat!, lon: e.lon!, from: trip!.start, to: trip!.end }, origin))}>
                  Make an itinerary
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The price calendar: one row per month, the cheapest highlighted, a bar for the price. */
function Calendar({ out }: { out: ScanOut }) {
  const rows = out.months ?? [];
  const prices = rows.map((r) => r.cheapest).filter((p): p is number => p != null);
  if (!prices.length) return <p className={s.caption}>{out.failed ? `The searches failed (Kiwi refused ${out.failed} of them); nothing is known about these ${rows.length} months yet.` : `No fares found in ${rows.length} months from these airports.`}</p>;
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  return (
    <>
      <table className={s.calendar}>
        <thead>
          <tr>
            <th>Month</th>
            <th></th>
            <th className={s.num}>{out.oneWay ? "One way" : "Return"}</th>
            <th>Dates</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className={r.cheapest != null && r.cheapest === min ? s.best : undefined}>
              <td>{monthLabel(r.month)}</td>
              <td style={{ width: "26%" }}>{r.cheapest != null && <i className={s.bar} style={{ width: `${Math.max(8, Math.round((r.cheapest / max) * 100))}%` }} />}</td>
              <td className={s.num}>{r.cheapest != null ? euro(r.cheapest) : r.failed ? "search failed" : "no fare"}</td>
              <td>
                {r.out ? (r.back ? dateRange(r.out, r.back) : r.out) : ""}
                {r.nights ? ` · ${r.nights}n` : ""}
                {r.from ? ` · ${r.from}` : ""}
                {r.stops != null ? ` · ${r.stops ? `${r.stops} stop` : "direct"}` : ""}
              </td>
              <td>
                {r.url && (
                  <a href={r.url} target="_blank" rel="noreferrer">
                    Book
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {out.openJaw?.length > 0 && (
        <>
          <p className={s.caption}>Open-jaw: in to {out.to}, home from another city.</p>
          <table className={s.calendar}>
            <tbody>
              {out.openJaw.map((r, i) => (
                <tr key={`${r.month}-${r.homeFrom}-${i}`}>
                  <td>{monthLabel(r.month)}</td>
                  <td>home from {r.homeFrom ?? "?"}</td>
                  <td className={s.num}>{euro(r.cheapest)}</td>
                  <td>
                    {r.out ? (r.back ? dateRange(r.out, r.back) : r.out) : ""}
                    {r.nights ? ` · ${r.nights}n` : ""}
                  </td>
                  <td>
                    {r.url && (
                      <a href={r.url} target="_blank" rel="noreferrer">
                        Out
                      </a>
                    )}
                    {r.url2 && (
                      <>
                        {" "}
                        <a href={r.url2} target="_blank" rel="noreferrer">
                          Home
                        </a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className={s.caption}>
        {out.searched} live searches, {out.nights} nights.{out.failed ? ` ${out.failed} failed: those months are unknown, not empty.` : ""}
      </p>
    </>
  );
}

function Bases({ bases }: { bases: BaseOut[] }) {
  return (
    <div className={s.cards}>
      {bases.slice(0, 5).map((b) => (
        <div key={b.base} className={s.base}>
          <div className={s.row}>
            <b>
              {b.base} <span className={s.sub}>{b.country}</span>
            </b>
            <span className={s.price}>{euro(b.total)}</span>
          </div>
          <span className={s.sub}>
            about €{b.perDay} a day · rent €{b.rentPerMonth} a month · living €{b.livingPerMonth}
            {b.visa ? ` · ${b.visa}` : ""}
          </span>
          <span className={s.sub}>
            In {b.flightIn}
            {b.urlIn && (
              <>
                {" "}
                <a href={b.urlIn} target="_blank" rel="noreferrer">
                  book
                </a>
              </>
            )}
            . Out {b.flightOut}
            {b.urlOut && (
              <>
                {" "}
                <a href={b.urlOut} target="_blank" rel="noreferrer">
                  book
                </a>
              </>
            )}
          </span>
          {b.why?.length > 0 && <span className={s.sub}>{b.why.slice(0, 2).join(". ")}</span>}
        </div>
      ))}
    </div>
  );
}

function GroupOptions({ out }: { out: GroupOut }) {
  return (
    <div className={s.cards}>
      {(out.options ?? []).slice(0, 4).map((o) => (
        <div key={`${o.city}-${o.dates}`} className={s.base}>
          <div className={s.row}>
            <b>
              {o.city} <span className={s.sub}>{o.country}</span>
            </b>
            <span className={s.price}>{euro(o.total)}</span>
          </div>
          <span className={s.sub}>
            {o.dates} · {o.nights}n · {o.everyone ? "everyone can" : "not everyone"}
          </span>
          <ul className={s.members}>
            {o.perMember.map((m) => (
              <li key={m.name}>
                <span>
                  {m.name} from {m.from}
                  {m.note ? `, ${m.note}` : ""}
                </span>
                <span>
                  {euro(m.price)}{" "}
                  {m.url && (
                    <a href={m.url} target="_blank" rel="noreferrer">
                      book
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Itineraries({ items }: { items: Itin[] }) {
  return (
    <div className={s.cards}>
      {items.slice(0, 4).map((it, i) => (
        <a key={i} className={s.card} href={it.url} target="_blank" rel="noreferrer">
          <span className={s.price}>€{it.price}</span>
          <span className={s.body}>
            <b>
              {it.out.slice(0, 10)}
              {it.back ? ` to ${it.back.slice(0, 10)}` : ", one way"}
            </b>
            <span className={s.sub}>
              {it.nights != null ? `${it.nights}n · ` : ""}
              {it.stops ? `${it.stops} stop${it.via?.length ? ` via ${it.via.join(", ")}` : ""}` : "direct"} · {it.hours} h · {it.carriers.slice(0, 2).join(", ")}
            </span>
          </span>
        </a>
      ))}
    </div>
  );
}

const HOP_ICON: Record<WalkLegOut["kind"], string> = { fly: "✈", train: "🚆", coach: "🚌", ferry: "⛴", road: "🚗" };
const HOP_WORD: Record<WalkLegOut["kind"], string> = { fly: "plane", train: "train", coach: "coach", ferry: "ferry", road: "car" };
const hoursOf = (min: number) => (min >= 90 ? `${Math.round(min / 6) / 10} h` : `${Math.round(min)} min`);

/** A walk's loops as cards: the route as a line of hops with their icons (Brasov, plane, Warsaw, train, Gdansk,
 * plane, Bucharest), the total and the hours, the nights per stop, the why lines, the legs with a booking link per
 * flight, and two buttons: "Show on the map" (atlas:walk-result with this loop first) and "Make an itinerary"
 * (skeletonFromWalk, atlas:itinerary). A restored thread has no raw result: the map then runs the same walk again
 * through /api/walk at budget 0 (the chat's walk never went through that route, so there is no memo to hit; the
 * fare memory and the ground graph redraw it without a live search), and only while its window has not begun to
 * pass. The itinerary is then asked of the agent. */
function WalkCards({ out, origin, onAsk }: { out: WalkOut; origin?: ItinPlace; onAsk: (text: string) => void }) {
  const loops = out.loops ?? [];
  const raw = out.raw && Array.isArray(out.raw.loops) && out.raw.loops.length ? out.raw : null;
  // The compact loops are the engine's first ones, in its order, so index i is raw loop i.
  // The window of a restored walk is stale once its first day is past: /api/walk refuses it, so the button rests.
  const stale = !raw && !!out.params && String(out.params.from) < LOCAL_DAY(new Date());
  const show = (i: number) => {
    if (raw) dispatchAtlas("atlas:walk-result", walkResultDetail(raw, i, out.params));
    else if (out.params && !stale) dispatchAtlas("atlas:walk", { params: { ...out.params, budget: 0 } });
  };
  const plan = (i: number) => {
    const loop = raw?.loops[i];
    if (!loop) return onAsk(`Make loop ${i + 1} an itinerary`);
    // The start is the traveller's own point when the loop starts there, else the place the walk started from.
    const p = out.params;
    const start: ItinPlace = origin && (!p || p.label === origin.name) ? origin : p ? { name: p.label, lat: p.lat, lon: p.lon } : (origin ?? { name: out.from, lat: 0, lon: 0 });
    openSkeleton(skeletonFromWalk(loop, start));
  };
  return (
    <div className={s.cards}>
      {loops.slice(0, 4).map((l, i) => {
        const hops = l.legs.filter((g) => g.kind !== "road");
        const flights = l.legs.filter((g) => g.kind === "fly" && g.url);
        return (
          <div key={i} className={s.base}>
            <div className={s.row}>
              <b>{l.title}</b>
              <span className={s.price}>{euro(l.total)}</span>
            </div>
            <div className={s.hops} aria-label={l.route}>
              <span className={s.hopPlace}>{out.from}</span>
              {hops.map((g, k) => (
                <span key={k} className={s.hop}>
                  <span className={s.hopKind} title={`${HOP_WORD[g.kind]}, ${hoursOf(g.minutes)}, ${euro(g.price)}${g.estimated ? " (estimate)" : ""}`}>
                    {HOP_ICON[g.kind]} {HOP_WORD[g.kind]}
                  </span>
                  <span className={s.hopPlace}>{g.to}</span>
                </span>
              ))}
            </div>
            <span className={s.sub}>
              {dateRange(l.start, l.end)} · {l.nights} night{l.nights === 1 ? "" : "s"} · {l.hours} h of travel · {l.stops.map((st) => `${st.name} ${st.nights}n`).join(", ")}
            </span>
            {l.why?.length > 0 && (
              <ul className={s.why}>
                {l.why.slice(0, 3).map((w, k) => (
                  <li key={k}>{w}</li>
                ))}
              </ul>
            )}
            <details className={s.legs}>
              <summary>The legs</summary>
              <ol>
                {l.legs.map((g, k) => (
                  <li key={k}>
                    {HOP_ICON[g.kind]} {g.from} to {g.to}, {g.date}
                    {g.depart ? ` ${g.depart}` : ""}, {hoursOf(g.minutes)}, {euro(g.price)}
                    {g.estimated ? " (estimate)" : ""}
                    {g.carrier ? `, ${g.carrier}` : ""}
                    {g.source === "memory" ? ", a remembered fare" : ""}
                    {g.url ? (
                      <>
                        {" "}
                        <a href={g.url} target="_blank" rel="noreferrer">
                          book
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ol>
            </details>
            <div className={s.actions}>
              <button className={s.mini} onClick={() => show(i)} disabled={!raw && (!out.params || stale)} title={stale ? "These dates have passed; ask again for new ones" : undefined}>
                Show on the map
              </button>
              <button className={s.mini} onClick={() => plan(i)}>
                Make an itinerary
              </button>
              {flights.slice(0, 3).map((g, k) => (
                <a key={k} className={s.mini} href={g.url} target="_blank" rel="noreferrer">
                  Book {g.from} to {g.to}
                </a>
              ))}
            </div>
          </div>
        );
      })}
      {(out.considered?.length || out.note || out.corrected) && (
        <p className={s.caption}>
          {out.corrected ? `${out.corrected}. ` : ""}
          {out.searched ? `${out.searched} live search${out.searched === 1 ? "" : "es"}. ` : "No live search. "}
          {out.note ?? ""}
        </p>
      )}
    </div>
  );
}

/** The ways from A to B as cards: a kind badge, the title, the total and the hours, the legs
 * as small pills, cheapest and fastest marked, and one button that asks the globe to draw the
 * route (the UI's A-to-B mode listens for atlas:route). */
function RouteCards({ out, onAsk }: { out: RouteOut; onAsk: (text: string) => void }) {
  const options = out.options ?? [];
  // The computed result is drawn as it is (no second search) while this session has it; a
  // restored thread has only the compact rows, so the globe searches the same question again:
  // a one-way answer (nights null) stays one way, on the day the engine priced.
  const raw = out.raw && Array.isArray(out.raw.options) && out.raw.options.length ? out.raw : null;
  // The compact options are the engine's first six, in its order, so index i is raw option i.
  const show = (i?: number) => (raw ? dispatchAtlas("atlas:route-result", routeResultDetail(raw, i)) : dispatchAtlas("atlas:route", routeDetail(out)));
  const plan = (i: number) => (raw ? openSkeleton(skeletonFromRoute(raw, i)) : onAsk(`Make option ${i + 1} an itinerary`));
  const pill: React.CSSProperties = { fontSize: 12, padding: "3px 9px", cursor: "default" };
  return (
    <div className={s.cards}>
      {options.slice(0, 5).map((o, i) => (
        <div key={i} className={s.base}>
          <div className={s.row}>
            <b>
              <span className={s.verdict} style={{ marginTop: 0, marginRight: 6 }}>
                {ROUTE_KIND_LABEL[o.kind] ?? o.kind}
              </span>
              {o.title}
            </b>
            <span className={s.price}>{euro(o.total)}</span>
          </div>
          <span className={s.sub}>
            {/* nonstop is the engine's word for a flight with no stop; the kind "direct" only means the nearest airports */}
            {o.hours} h door to door · {o.nonstop ? "nonstop" : o.stops ? `${o.stops} stop${o.stops > 1 ? "s" : ""}` : "direct"}
            {o.backTotal != null ? ` · back ${euro(o.backTotal)}` : ""}
            {o.cheapest && (
              <>
                {" "}
                <span className={`${s.verdict} ${s.good}`} style={{ marginTop: 0 }}>
                  cheapest
                </span>
              </>
            )}
            {o.fastest && (
              <>
                {" "}
                <span className={`${s.verdict} ${s.good}`} style={{ marginTop: 0 }}>
                  fastest
                </span>
              </>
            )}
          </span>
          <div className={s.chips}>
            {(o.legs ?? []).map((l, k) => (
              <span key={k} className={s.chip} style={pill}>
                {l}
              </span>
            ))}
          </div>
          {o.why && <span className={s.sub}>{o.why}</span>}
          <div className={s.actions}>
            <button className={s.mini} onClick={() => show(i)}>
              On the map
            </button>
            <button className={s.mini} onClick={() => plan(i)}>
              Make an itinerary
            </button>
          </div>
          {o.urls?.length > 0 && (
            <span className={s.sub}>
              {o.urls.slice(0, 3).map((u, k) => (
                <span key={k}>
                  {k ? " · " : ""}
                  <a href={u} target="_blank" rel="noreferrer">
                    {o.urls.length > 1 ? `book leg ${k + 1}` : "book"}
                  </a>
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
      {options.length > 0 && (
        <div className={s.chips}>
          <button className={s.go} onClick={() => show()}>
            Show the route
          </button>
        </div>
      )}
      {(out.considered?.length || out.note) && (
        <p className={s.caption}>
          {out.considered?.length ? `Considered: ${out.considered.slice(0, 8).join(", ")}. ` : ""}
          {out.searched ? `${out.searched} live searches. ` : ""}
          {out.note ?? ""}
        </p>
      )}
    </div>
  );
}

function MonthStrip({ out }: { out: MonthsOut }) {
  const max = Math.max(...out.months.map((m) => m.score), 1);
  return (
    <div className={s.months}>
      {out.months.map((m) => (
        <div key={m.month} className={`${s.month} ${out.best.includes(m.month) ? s.good : ""}`} title={`${m.month}: ${m.highC} C, ${m.rainMm} mm`}>
          <i style={{ height: `${Math.max(4, Math.round((m.score / max) * 28))}px` }} />
          {m.month.slice(0, 1)}
        </div>
      ))}
    </div>
  );
}

/** The one question, as a component. Answered widgets stay visible but inert. */
function Widget({ spec, answered, disabled, onAnswer }: { spec: WidgetSpec; answered: boolean; disabled: boolean; onAnswer: (text: string) => void }) {
  const d = (spec.defaults ?? {}) as Record<string, unknown>;
  // The visitor's own calendar day (local clock, not UTC): the pickers' minimum and the quick chips start from it.
  const today = LOCAL_DAY(new Date());
  const [from, setFrom] = useState(typeof d.from === "string" ? d.from : "");
  const [to, setTo] = useState(typeof d.to === "string" ? d.to : "");
  const [people, setPeople] = useState<PersonRow[]>(() => {
    // Whatever the model put in defaults: only objects, only string fields, so a stray number
    // or a null row never reaches .trim() in the render below.
    const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
    const given = Array.isArray(d.people) ? d.people.filter((p): p is Record<string, unknown> => !!p && typeof p === "object") : [];
    const rows = given.slice(0, 8).map((p) => ({ name: str(p.name).slice(0, 40), origin: str(p.origin).slice(0, 40), from: ISO_DAY_RE.test(str(p.from)) ? str(p.from) : "", to: ISO_DAY_RE.test(str(p.to)) ? str(p.to) : "" }));
    while (rows.length < 2) rows.push({ name: "", origin: "", from: "", to: "" });
    return rows;
  });
  const [picking, setPicking] = useState(false);
  const inert = answered || disabled;

  // The globe answers a map pick with an atlas:picked event; the first one after our request wins.
  useEffect(() => {
    if (!picking) return;
    const onPicked = (e: Event) => {
      const det = (e as CustomEvent<{ mode?: string; region?: string; from?: string; to?: string; place?: string }>).detail ?? {};
      setPicking(false);
      if (det.region) {
        const label = WILD_REGIONS.find((r) => r.key === det.region)?.label ?? det.region;
        onAnswer(widgetAnswer("map-region", `${label} (${det.region})`));
      } else if (det.place) onAnswer(widgetAnswer("map-place", det.place));
      else if (det.from || det.to) onAnswer(widgetAnswer("dates", { from: det.from, to: det.to }));
    };
    window.addEventListener("atlas:picked", onPicked);
    return () => window.removeEventListener("atlas:picked", onPicked);
  }, [picking, onAnswer]);

  const chips = (items: string[], send: (v: string) => string) => (
    <div className={s.chips}>
      {items.map((o) => (
        <button key={o} className={s.chip} disabled={inert} onClick={() => onAnswer(send(o))}>
          {o}
        </button>
      ))}
    </div>
  );

  let body: React.ReactNode = null;
  switch (spec.kind) {
    case "dates":
      body = (
        <>
          <div className={s.chips}>
            {quickDateRanges(today).map((q) => (
              <button key={q.label} className={s.chip} disabled={inert} onClick={() => onAnswer(widgetAnswer("dates", q.from ? { from: q.from, to: q.to } : {}))}>
                {q.label}
              </button>
            ))}
          </div>
          <div className={s.dates}>
            <input className={s.field} type="date" min={today} value={from} disabled={inert} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input className={s.field} type="date" min={from || today} value={to} disabled={inert} onChange={(e) => setTo(e.target.value)} aria-label="To" />
            <button className={s.go} disabled={inert || !from} onClick={() => onAnswer(widgetAnswer("dates", { from, to: to || addDays(from, 7) }))}>
              Use these
            </button>
          </div>
        </>
      );
      break;
    case "month":
      body = chips([...(spec.options?.length ? spec.options : monthOptions().map(monthLabel)), "Anytime"], (o) => widgetAnswer("month", o));
      break;
    case "nights":
      body = chips(spec.options?.length ? spec.options : NIGHT_OPTIONS, (o) => widgetAnswer("nights", o));
      break;
    case "region":
      body = chips(
        WILD_REGIONS.map((r) => r.label),
        (o) => widgetAnswer("region", `${o} (${WILD_REGIONS.find((r) => r.label === o)?.key ?? ""})`),
      );
      break;
    case "choices":
      body = chips(spec.options?.length ? spec.options : ["Yes", "No"], (o) => widgetAnswer("choices", o));
      break;
    case "people": {
      const set = (i: number, patch: Partial<PersonRow>) => setPeople((rows) => rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
      const ok = people.filter((p) => p.name.trim() && p.origin.trim()).length >= 2;
      body = (
        <div className={s.people}>
          {people.map((p, i) => (
            <div key={i} className={s.person}>
              <input className={s.field} placeholder="Name" value={p.name} disabled={inert} onChange={(e) => set(i, { name: e.target.value })} />
              <input className={s.field} placeholder="Airport or city" value={p.origin} disabled={inert} onChange={(e) => set(i, { origin: e.target.value })} />
              <input className={s.field} type="date" value={p.from} min={today} disabled={inert} onChange={(e) => set(i, { from: e.target.value })} aria-label="Free from" />
              <input className={s.field} type="date" value={p.to} min={p.from || today} disabled={inert} onChange={(e) => set(i, { to: e.target.value })} aria-label="Free to" />
              <button className={s.tiny} disabled={inert || people.length <= 2} title="Remove" onClick={() => setPeople((rows) => rows.filter((_, k) => k !== i))}>
                ×
              </button>
            </div>
          ))}
          <div className={s.chips}>
            <button className={s.chip} disabled={inert || people.length >= 8} onClick={() => setPeople((rows) => [...rows, { name: "", origin: "", from: "", to: "" }])}>
              + Add a person
            </button>
            <button className={s.go} disabled={inert || !ok} onClick={() => onAnswer(widgetAnswer("people", people))}>
              Find our weekend
            </button>
          </div>
        </div>
      );
      break;
    }
    case "map-region":
    case "map-place":
      body = picking ? (
        <span className={s.picking}>
          <i className={s.spinner} /> {spec.kind === "map-region" ? "Pick a region on the globe" : "Tap any city on the globe"}, or{" "}
          <button className={s.tiny} onClick={() => setPicking(false)}>
            cancel
          </button>
        </span>
      ) : (
        <div className={s.chips}>
          <button
            className={s.go}
            disabled={inert}
            onClick={() => {
              setPicking(true);
              window.dispatchEvent(new CustomEvent("atlas:pick", { detail: { mode: spec.kind === "map-region" ? "region" : "place" } }));
            }}
          >
            {spec.kind === "map-region" ? "Pick a region on the globe" : "Tap any city on the globe"}
          </button>
          {spec.kind === "map-region" && chips(WILD_REGIONS.slice(0, 5).map((r) => r.label), (o) => widgetAnswer("region", `${o} (${WILD_REGIONS.find((r) => r.label === o)?.key ?? ""})`))}
        </div>
      );
      break;
  }
  return (
    <div className={`${s.widget} ${answered ? s.answered : ""}`}>
      <p className={s.question}>{spec.question}</p>
      {body}
    </div>
  );
}

type Recognizer = { start: () => void; stop: () => void; abort: () => void; lang: string; interimResults: boolean; continuous: boolean; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
function speechCtor(): (new () => Recognizer) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export default function ChatPanel(p: Props) {
  const [store, setStore] = useState<Store>(() => (typeof window === "undefined" ? { active: "ssr", threads: [{ id: "ssr", title: "New chat", updated: 0, messages: [] }] } : loadStore()));
  const storeRef = useRef(store);
  storeRef.current = store;
  const activeRef = useRef(store.active);
  const contextRef = useRef(p.context);
  contextRef.current = p.context;
  // What goes to the server: the thread settled (a stopped tool call is an error, not a call
  // still waiting), so a turn after Stop never fails on the half-finished one, and the
  // visitor's own calendar day, so the agent and the date widgets agree on what "today" is.
  // A written itinerary (make_itinerary's raw) is the largest payload a thread holds and the
  // server never reads it back, so it stays in the browser; the routes, deals and trips do
  // travel, because "make it an itinerary" in a later turn plans from them.
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest: ({ messages }) => ({ body: { messages: withoutItineraries(settle(messages)), context: { ...contextRef.current, today: LOCAL_DAY(new Date()) } } }) }), []);
  const initial = useMemo(() => store.threads.find((t) => t.id === store.active)?.messages ?? [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const { messages, sendMessage, status, stop, setMessages, error, regenerate, clearError } = useChat({ transport, messages: initial });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [draft, setDraft] = useState("");
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [storageNote, setStorageNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recRef = useRef<Recognizer | null>(null);
  // Tool outputs already shown on the globe. A restored thread starts fully applied: only
  // results produced in this session move the camera or pin deals.
  const applied = useRef(new Set<string>(initial.flatMap((m) => m.parts.map((part) => (isToolPart(part) && part.toolCallId) || "")).filter(Boolean)));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickToBottom = useRef(true);
  const busy = status === "submitted" || status === "streaming";
  const canSpeak = !!speechCtor();
  // When each running tool call was first seen, so a long tool's chip can say "48 s"; a
  // once-a-second tick redraws the chips only while a tool is running.
  const startedAt = useRef(new Map<string, number>());
  /** A running walk's live lines already sent to the globe, per tool call: the index of the next one to send. */
  const liveSent = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const anyRunning = busy && messages.some((m) => m.role === "assistant" && m.parts.some((part) => isToolPart(part) && isRunning(part)));
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyRunning]);

  // The active thread is written to the browser at most twice a second while an answer
  // streams, and at once when a turn ends; only that thread's key is rewritten.
  const persist = useCallback((now = false) => {
    const run = () => {
      saveTimer.current = null;
      const id = activeRef.current;
      const msgs = messagesRef.current;
      const threads = storeRef.current.threads.map((t) => (t.id === id ? { ...t, messages: msgs, title: t.title === "New chat" ? titleOf(msgs) ?? t.title : t.title, updated: msgs.length ? Date.now() : t.updated } : t));
      const next = { ...storeRef.current, threads };
      storeRef.current = next;
      setStore(next);
      setStorageNote(saveStore(next, id) ? null : STORAGE_NOTE);
    };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (now) run();
    else saveTimer.current = setTimeout(run, SAVE_DEBOUNCE_MS);
  }, []);
  useEffect(() => {
    persist(false);
    if (stickToBottom.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, persist]);
  // A turn that ended (finished, stopped, or failed) is written at once, and any tool call it
  // left without an answer is settled so the thread can continue.
  useEffect(() => {
    if (busy) return;
    const settled = settle(messagesRef.current);
    if (settled.some((m, i) => m !== messagesRef.current[i])) setMessages(settled);
    else persist(true);
  }, [busy, persist, setMessages]);
  // Leaving the page or the tab (the panel unmounts on a tab switch) writes what is there.
  useEffect(() => {
    const flush = () => persist(true);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persist]);

  // A question typed in the top bar lands here. While a turn is streaming the seed waits (the
  // panel keeps it until it is sent) and goes out the moment the turn ends: the effect runs
  // again when busy flips, and the seed is marked consumed only once it has been sent.
  useEffect(() => {
    if (!p.seed || busy) return;
    stickToBottom.current = true;
    sendMessage({ text: p.seed });
    p.onSeedConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.seed, busy]);

  // Results flow to the globe: deals as pins and cards, a trip as a route.
  useEffect(() => {
    for (const m of messages) {
      for (const part of m.parts) {
        if (isToolPart(part) && part.toolCallId && isRunning(part) && !startedAt.current.has(part.toolCallId)) startedAt.current.set(part.toolCallId, Date.now());
        // A walk the chat runs is drawn on the globe while it thinks: each preliminary output holds its newest
        // nodes, edges and loops (with some overlap, by index), and only the ones not yet sent go on the bus.
        if (isToolPart(part) && part.type === "tool-walk_trips" && part.toolCallId && part.state === "output-available" && part.preliminary && !applied.current.has(part.toolCallId)) {
          const pre = part.output as Partial<WalkProgress> | undefined;
          if (pre?.live && Array.isArray(pre.live.lines)) {
            const next = liveSent.current.get(part.toolCallId);
            const skip = Math.max(0, (next ?? 0) - pre.live.at);
            const fresh = pre.live.lines.slice(skip);
            if (fresh.length || next == null) {
              liveSent.current.set(part.toolCallId, pre.live.at + pre.live.lines.length);
              dispatchAtlas("atlas:walk-live", { id: part.toolCallId, ...(next == null && pre.params ? { params: pre.params } : {}), lines: fresh });
            }
          }
        }
        if (!isToolPart(part) || part.state !== "output-available" || part.preliminary || !part.toolCallId || applied.current.has(part.toolCallId)) continue;
        const name = part.type.slice(5);
        const out = part.output as { raw?: unknown } | undefined;
        if (RAW_DEAL_TOOLS.has(name) && Array.isArray(out?.raw) && out!.raw.length) {
          applied.current.add(part.toolCallId);
          p.onDeals(out!.raw as Deal[]);
        }
        if (name === "wild_trip" && out?.raw && typeof out.raw === "object") {
          applied.current.add(part.toolCallId);
          p.onTrip(out.raw as WildTrip);
        }
        // The way from A to B is drawn the moment it arrives, from the result itself: the
        // globe's route view shows it without searching again.
        if (name === "cheapest_way" && out?.raw && typeof out.raw === "object" && Array.isArray((out.raw as RouteResult).options) && (out.raw as RouteResult).options.length) {
          applied.current.add(part.toolCallId);
          dispatchAtlas("atlas:route-result", routeResultDetail(out.raw as RouteResult));
        }
        if (name === "walk_trips" && out?.raw && typeof out.raw === "object" && Array.isArray((out.raw as WalkResult).loops) && (out.raw as WalkResult).loops.length) {
          applied.current.add(part.toolCallId);
          dispatchAtlas("atlas:walk-result", walkResultDetail(out.raw as WalkResult, undefined, (out as { params?: WalkQuery }).params));
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || busy) return;
      stickToBottom.current = true;
      sendMessage({ text: t });
      setDraft("");
      if (taRef.current) taRef.current.style.height = "auto";
    },
    [busy, sendMessage],
  );

  /** Replaces the store in memory and in the browser; `threadId` names the thread whose messages changed. */
  const commit = (st: Store, threadId?: string) => {
    storeRef.current = st;
    setStore(st);
    setStorageNote(saveStore(st, threadId) ? null : STORAGE_NOTE);
  };
  const switchThread = (id: string) => {
    if (busy || id === activeRef.current) return setThreadsOpen(false);
    persist(true);
    const t = storeRef.current.threads.find((x) => x.id === id);
    if (!t) return;
    activeRef.current = id;
    for (const m of t.messages) for (const part of m.parts) if (isToolPart(part) && part.toolCallId) applied.current.add(part.toolCallId);
    commit({ ...storeRef.current, active: id });
    setMessages(t.messages);
    setThreadsOpen(false);
  };
  const newThread = () => {
    if (busy) return;
    persist(true);
    const t = blankThread();
    activeRef.current = t.id;
    const dropped = storeRef.current.threads.filter((x) => !x.messages.length);
    for (const d of dropped) dropThreadKey(d.id);
    commit({ active: t.id, threads: [t, ...storeRef.current.threads.filter((x) => x.messages.length)].slice(0, MAX_THREADS) }, t.id);
    setMessages([]);
    setThreadsOpen(false);
  };
  const deleteThread = (id: string) => {
    if (busy) return;
    dropThreadKey(id);
    const rest = storeRef.current.threads.filter((t) => t.id !== id);
    if (id === activeRef.current) {
      const next = rest[0] ?? blankThread();
      activeRef.current = next.id;
      setMessages(next.messages);
      commit({ active: next.id, threads: rest.length ? rest : [next] }, rest.length ? undefined : next.id);
    } else commit({ ...storeRef.current, threads: rest });
  };
  const renameThread = (id: string, title: string) => {
    commit({ ...storeRef.current, threads: storeRef.current.threads.map((t) => (t.id === id ? { ...t, title: title.trim() || t.title } : t)) });
    setRenaming(null);
  };

  const toggleVoice = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-GB";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onresult = (e) => {
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      setDraft((finalText + interim).trim());
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      if (finalText.trim()) send(finalText);
    };
    rec.onerror = () => {
      setListening(false);
      recRef.current = null;
    };
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const active = store.threads.find((t) => t.id === store.active);
  const last = messages.at(-1);
  const lastUserIndex = messages.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
  const lastTool = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      const tools = (messages[i].parts as ToolPart[]).filter((x) => x.type.startsWith("tool-") && x.type !== "tool-ask");
      if (tools.length) return tools.at(-1)!.type.slice(5);
    }
    return null;
  }, [messages]);
  const openWidget = !busy && last?.role === "assistant" && (last.parts as ToolPart[]).some((x) => x.type === "tool-ask" && x.state === "output-available");
  const followups = FOLLOWUPS[lastTool ?? ""] ?? FOLLOWUPS.default;

  const renderTool = (tp: ToolPart, i: number, answered: boolean, skipCalendar = false) => {
    const name = tp.type.slice(5);
    const out = tp.output as Record<string, unknown> | undefined;
    const running = isRunning(tp);
    const failed = tp.state === "output-error";
    const soft = tp.state === "output-available" && out && typeof out === "object" && typeof out.error === "string";
    if (name === "ask") {
      if (tp.state !== "output-available" || !out) return null;
      return <Widget key={tp.toolCallId ?? i} spec={out as unknown as WidgetSpec} answered={answered} disabled={busy} onAnswer={send} />;
    }
    const count = out && typeof out === "object" ? ((out.found as number | undefined) ?? (Array.isArray(out.bases) ? out.bases.length : undefined) ?? (Array.isArray(out.options) ? out.options.length : undefined) ?? (out.count as number | undefined)) : undefined;
    const searched = out && typeof out === "object" ? (out.searched as number | undefined) : undefined;
    // Something to show under the chip: a count, any non-empty list (months, itineraries,
    // deals, towns, a ranked list of trips), a verdict from the fare memory or a built trip.
    const payload = !!out && typeof out === "object" && (count != null || Object.values(out).some((v) => Array.isArray(v) && v.length > 0) || (typeof out.verdict === "string" && out.verdict !== "unknown") || typeof out.title === "string" || typeof out.widget === "boolean");
    // A note without data (live prices off, nothing stored, an unknown place, a build with
    // nothing to show) is shown on the chip in amber, like a soft error, so the thread says
    // plainly why there is no card; a tick is only for a result with something underneath.
    const noted = tp.state === "output-available" && !soft && !!out && typeof out.note === "string" && (count === 0 || (count == null && !payload));
    const secs = running && tp.toolCallId && startedAt.current.has(tp.toolCallId) ? Math.round((Date.now() - startedAt.current.get(tp.toolCallId)!) / 1000) : 0;
    const live = running && tp.preliminary && out && typeof (out as Partial<WalkProgress>).progress === "string" ? (out as unknown as WalkProgress) : null;
    const progress = running ? `${live ? live.progress.replace(/[.…]+$/, "") : toolProgress(name, tp.input).replace(/\.\.\.$/, "")}${LONG_TOOLS.has(name) && secs >= 3 ? `, ${secs} s` : "..."}` : "";
    return (
      <div key={tp.toolCallId ?? i} className={s.toolwrap}>
        <div className={`${s.toolchip} ${failed ? s.fail : soft || noted ? s.warn : running ? "" : s.done}`} title={!running && out && typeof out.note === "string" ? out.note : undefined}>
          {running ? <i className={s.spinner} /> : failed || soft || noted ? "!" : "✓"}
          <span>
            {running ? progress : TOOL_LABEL[name] ?? name}
            {!running && !failed && !soft && !noted && count != null ? `: ${count} found` : ""}
            {!running && !failed && !soft && !noted && searched != null && count == null ? `: ${searched} searches` : ""}
            {!running && !failed && !soft && !noted && out && typeof out.source === "string" && out.source !== "live" && searched === 0 ? ` (${out.source})` : ""}
            {failed ? `: ${tp.errorText === "stopped before it finished" ? "stopped" : tp.errorText ?? "failed"}` : soft ? `: ${String(out!.error)}` : noted ? `: ${String(out!.note).slice(0, 120)}` : ""}
          </span>
        </div>
        {live && (live.loops || live.searched) ? (
          <p className={s.caption}>
            {live.loops ? `${live.loops} loop${live.loops === 1 ? "" : "s"} closed so far` : "No loop closed yet"}
            {live.edges ? `, ${live.edges} edges looked at` : ""}
            {live.searched ? `, ${live.searched} live search${live.searched === 1 ? "" : "es"}` : ""}
          </p>
        ) : null}
        {tp.state === "output-available" && !running && out && !soft && (
          <>
            {name === "scan_cheapest" && !skipCalendar && <Calendar out={out as unknown as ScanOut} />}
            {name === "long_stay" && Array.isArray(out.bases) && <Bases bases={out.bases as BaseOut[]} />}
            {name === "group_trip" && Array.isArray(out.options) && <GroupOptions out={out as unknown as GroupOut} />}
            {name === "reprice_route" && Array.isArray(out.itineraries) && <Itineraries items={out.itineraries as Itin[]} />}
            {name === "best_months" && Array.isArray(out.months) && <MonthStrip out={out as unknown as MonthsOut} />}
            {name === "cheapest_way" && Array.isArray(out.options) && <RouteCards out={out as unknown as RouteOut} onAsk={send} />}
            {name === "walk_trips" && Array.isArray(out.loops) && out.loops.length > 0 && <WalkCards out={out as unknown as WalkOut} origin={herePlace(p.context)} onAsk={send} />}
            {name === "make_itinerary" && Array.isArray(out.days) && <ItineraryCard out={out as unknown as ItinOut} />}
            {name === "wild_trip" && out.raw && typeof out.raw === "object" && Array.isArray((out.raw as WildTrip).stops) && (
              <div className={s.actions}>
                <button className={s.mini} onClick={() => p.onTrip(out.raw as WildTrip)}>
                  Show the loop
                </button>
                <button className={s.mini} onClick={() => openSkeleton(skeletonFromWild(out.raw as WildTrip))}>
                  Make an itinerary
                </button>
              </div>
            )}
            {name === "events_worth_travelling_for" && Array.isArray(out.events) && out.events.length > 0 && <EventCards events={out.events as EventOut[]} origin={herePlace(p.context)} />}
            {name === "price_insight" && (
              <span className={`${s.verdict} ${s[(out as unknown as InsightOut).verdict] ?? ""}`}>
                {(out as unknown as InsightOut).verdict === "unknown" ? "No fare history yet for this route" : `Fare memory: ${(out as unknown as InsightOut).verdict}${(out as unknown as InsightOut).typical != null ? `, usually ${euro((out as unknown as InsightOut).typical)}` : ""}${(out as unknown as InsightOut).low != null ? `, lowest seen ${euro((out as unknown as InsightOut).low)}` : ""}`}
              </span>
            )}
            {(name === "find_getaways" || name === "cheapest_deals") && cardDeals(out).length > 0 && <DealCards deals={cardDeals(out)} onOpen={p.onOpenDeal} origin={herePlace(p.context)} />}
          </>
        )}
      </div>
    );
  };

  return (
    <div className={s.chat}>
      <div className={s.top}>
        <button className={s.threadBtn} onClick={() => setThreadsOpen((v) => !v)} title="Your conversations">
          <span>{active?.title ?? "New chat"}</span>
          <small>{store.threads.length > 1 ? `${store.threads.length} chats` : ""} ▾</small>
        </button>
        <button className={s.iconBtn} onClick={newThread} disabled={busy} title="New conversation (the old ones are kept)">
          +
        </button>
        {threadsOpen && (
          <div className={s.threadList}>
            {store.threads.map((t) => (
              <div key={t.id} className={`${s.threadRow} ${t.id === store.active ? s.active : ""}`} onClick={() => renaming !== t.id && switchThread(t.id)}>
                {renaming === t.id ? (
                  <input
                    className={s.rename}
                    autoFocus
                    defaultValue={t.title}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameThread(t.id, (e.target as HTMLInputElement).value);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={(e) => renameThread(t.id, e.target.value)}
                  />
                ) : (
                  <span>
                    {t.title}
                    <small>{t.updated ? ago(t.updated) : ""}</small>
                  </span>
                )}
                <button
                  className={s.tiny}
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming(t.id);
                  }}
                >
                  rename
                </button>
                <button
                  className={s.tiny}
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteThread(t.id);
                  }}
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        ref={listRef}
        className={s.msgs}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {messages.length === 0 && (
          <div className={s.intro}>
            <p>Say where, when or how long, in any order. I search the real fares first, show the cheapest months and the best three options, and ask one thing at most. I know where you are and your airports.</p>
            <div className={s.chips}>
              {STARTERS.map((st) => (
                <button key={st} className={s.chip} onClick={() => send(st)}>
                  {st}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, mi) => {
          const dupes = m.role === "assistant" ? duplicateCalendars(m) : null;
          return (
            <div key={m.id} className={`${s.bubble} ${m.role === "user" ? s.user : s.ai}`}>
              {m.parts.map((part, i) => {
                if (part.type === "text") return m.role === "user" ? <span key={i}>{part.text}</span> : <Text key={i} text={part.text} />;
                const tp = part as ToolPart;
                if (!tp.type.startsWith("tool-")) return null;
                return renderTool(tp, i, mi < lastUserIndex, dupes?.has(i) ?? false);
              })}
            </div>
          );
        })}
        {busy && last?.role === "user" && (
          <div className={`${s.bubble} ${s.ai}`}>
            <span className={s.thinking}>
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        {!busy && !error && messages.length > 0 && last?.role === "assistant" && !openWidget && (
          <div className={`${s.chips} ${s.followups}`}>
            {followups.map((f) => (
              <button key={f} className={s.chip} onClick={() => send(f)}>
                {f}
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className={`${s.bubble} ${s.ai} ${s.err}`}>
            <span>The chat failed: {error.message.slice(0, 160)}.</span>
            <button
              className={s.chip}
              onClick={() => {
                clearError();
                regenerate();
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {storageNote && <p className={s.note}>{storageNote}</p>}
      {busy && p.seed && <p className={s.note}>Next, when this answer is done: {p.seed}</p>}
      <form
        className={s.inputBar}
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          ref={taRef}
          className={s.textarea}
          rows={1}
          placeholder={listening ? "Listening…" : busy ? "Searching… you can type the next thing" : "Where, when, how long, in any order"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {canSpeak && (
          <button type="button" className={`${s.iconBtn} ${listening ? s.listening : ""}`} onClick={toggleVoice} title={listening ? "Stop listening" : "Speak"} aria-pressed={listening}>
            {listening ? "■" : "🎙"}
          </button>
        )}
        {busy ? (
          <button type="button" className={`${s.send} ${s.stop}`} onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" className={s.send} disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
