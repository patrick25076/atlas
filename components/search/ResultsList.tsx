"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchQuery, TripResult } from "@/lib/trip-result";
import { readNdjson } from "@/lib/boards-client";
import TripCard from "./TripCard";
import s from "./search.module.css";

// The one results list. useSearchStream reads GET /api/search line by line (progress lines,
// result batches merged by id, the graph's instant answer, the summary); the list shows the
// trips as they arrive, sorted, with a shimmer while the first ones come and plain words when
// nothing came or something failed.

export type SearchDone = { count: number; searched: number; engines: string[]; note?: string };
export type SearchStream = {
  status: "idle" | "loading" | "ok" | "error";
  results: TripResult[];
  lines: string[];
  /** The flight graph answered at once (no live search needed for these). */
  graph: boolean;
  done?: SearchDone;
  error?: string;
};
const IDLE: SearchStream = { status: "idle", results: [], lines: [], graph: false };
const MAX_LINES = 4;

type Line = { progress?: string; results?: TripResult[]; graph?: boolean; done?: SearchDone; error?: string };

/**
 * One search at a time: a new run aborts the one before, so a fast second search never has
 * the first one's results land in its list. Results with the same id replace the earlier
 * copy (an engine may confirm a graph price live), so the list never shows a trip twice.
 */
export function useSearchStream() {
  const [state, setState] = useState<SearchStream>(IDLE);
  const ctrl = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
  }, []);

  const run = useCallback(async (q: SearchQuery) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    const byId = new Map<string, TripResult>();
    setState({ status: "loading", results: [], lines: [], graph: false });
    let res: Response;
    try {
      res = await fetch(`/api/search?q=${encodeURIComponent(JSON.stringify(q))}`, { signal: c.signal });
    } catch (err) {
      if (c.signal.aborted || (err as Error)?.name === "AbortError") return;
      setState((st) => ({ ...st, status: "error", error: "Could not reach the search. Check the connection and try again." }));
      return;
    }
    if (!res.ok) {
      let msg = `The search failed (${res.status}).`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        // not JSON: the status line says enough
      }
      if (!c.signal.aborted) setState((st) => ({ ...st, status: "error", error: msg }));
      return;
    }
    const onLine = (m: Line) => {
      if (c.signal.aborted) return;
      if (m.results?.length) for (const t of m.results) byId.set(t.id, t);
      setState((st) => ({
        ...st,
        results: m.results?.length ? [...byId.values()] : st.results,
        lines: m.progress ? [...st.lines, m.progress].slice(-MAX_LINES) : st.lines,
        graph: st.graph || m.graph === true,
        done: m.done ?? st.done,
        status: m.error ? "error" : m.done ? "ok" : st.status,
        error: m.error ?? st.error,
      }));
    };
    try {
      if (res.headers.get("content-type")?.includes("ndjson")) {
        const ended = await readNdjson<Line>(res, onLine, c.signal);
        if (!ended) return;
      } else {
        // A memo hit may come back as one JSON document with the same fields.
        onLine((await res.json()) as Line);
      }
    } catch {
      if (c.signal.aborted) return;
      setState((st) => ({ ...st, status: st.results.length ? "ok" : "error", error: st.results.length ? undefined : "The search stopped early. Try again." }));
      return;
    }
    if (ctrl.current === c) ctrl.current = null;
    // A stream that ended without {done} still counts as finished with what it found.
    setState((st) => (st.status === "loading" ? { ...st, status: "ok" } : st));
  }, []);

  useEffect(() => stop, [stop]);
  const reset = useCallback(() => {
    stop();
    setState(IDLE);
  }, [stop]);
  return { state, run, stop, reset };
}

export type SortKey = "price" | "balanced" | "comfort";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "price", label: "Cheapest" },
  { key: "balanced", label: "Balanced" },
  { key: "comfort", label: "Comfort" },
];
/**
 * Euros an hour of travel is worth to each sort, the same rates the server ranks by
 * (lib/search.ts HOUR_EURO), so the list never reorders what the server ranked: Cheapest is
 * money alone and hours only break ties (the owner: money first); Balanced counts six euros
 * an hour; Comfort eighteen, so a much shorter trip wins over a small saving.
 */
const EURO_PER_HOUR: Record<SortKey, number> = { price: 0, balanced: 6, comfort: 18 };

/** The sort that matches a Trip style tradeoff; the keys are the same words. */
export function sortForTradeoff(tradeoff: string | undefined): SortKey {
  return tradeoff === "comfort" || tradeoff === "balanced" ? tradeoff : "price";
}

/** What a trip costs for ranking, as the server counts it: the tickets plus the ground estimate; a long stay all in. */
export function moneyOf(t: TripResult): number {
  const total = t.kind === "long-stay" ? (t.raw as { total?: unknown } | undefined)?.total : undefined;
  return typeof total === "number" ? total : t.price + (t.groundPrice ?? 0);
}

export function sortTrips(list: TripResult[], key: SortKey): TripResult[] {
  const hours = (t: TripResult) => t.hours ?? 99;
  const w = EURO_PER_HOUR[key] ?? 0;
  return [...list].sort((a, b) => moneyOf(a) + w * hours(a) - (moneyOf(b) + w * hours(b)) || hours(a) - hours(b) || a.id.localeCompare(b.id));
}

type Props = {
  stream: SearchStream;
  /** The results to show: filtered and sorted by the tab. */
  results: TripResult[];
  activeId?: string | null;
  onOpen: (t: TripResult) => void;
  onHover?: (t: TripResult | null) => void;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  /** Filters hide some results: the empty state offers to clear them. */
  hidden: number;
  onClearFilters: () => void;
  onRetry: () => void;
};

function Shimmer() {
  return (
    <ul className={s.list} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className={s.skeleton} style={{ animationDelay: `${i * 120}ms` }}>
          <span className={s.skLine} style={{ width: "62%" }} />
          <span className={s.skLine} style={{ width: "88%" }} />
          <span className={s.skLine} style={{ width: "40%" }} />
        </li>
      ))}
    </ul>
  );
}

export default function ResultsList({ stream, results, activeId, onOpen, onHover, sort, onSort, hidden, onClearFilters, onRetry }: Props) {
  const loading = stream.status === "loading";
  const total = stream.results.length;
  const lastLine = stream.lines[stream.lines.length - 1];

  if (stream.status === "idle") return null;

  return (
    <section className={s.results} aria-label="Trips found" aria-busy={loading}>
      <div className={s.resultsHead}>
        <p className={s.count} aria-live="polite">
          {total === 0 ? (loading ? "Searching" : "No trips") : `${results.length} trip${results.length === 1 ? "" : "s"}${hidden > 0 ? `, ${hidden} hidden by the filters` : ""}`}
          {loading && total > 0 && <span className={s.stillLooking}>, still looking</span>}
        </p>
        {total > 1 && (
          <div className={s.sorts} role="radiogroup" aria-label="Sort">
            {SORTS.map((x) => (
              <button key={x.key} type="button" role="radio" aria-checked={sort === x.key} className={`${s.sortBtn} ${sort === x.key ? s.sortOn : ""}`} onClick={() => onSort(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {(loading || stream.graph) && (
        <div className={s.progress} role="status">
          {stream.graph && <span className={s.graphNote}>Answered from the price graph</span>}
          {loading && lastLine && (
            <span className={s.progressLine} key={lastLine}>
              <span className={s.pulse} aria-hidden="true" />
              {lastLine}
            </span>
          )}
          {loading && !lastLine && (
            <span className={s.progressLine}>
              <span className={s.pulse} aria-hidden="true" />
              Looking for the cheapest trips
            </span>
          )}
        </div>
      )}

      {results.length > 0 && (
        <ul className={s.list}>
          {results.map((t, i) => (
            <li key={t.id} className={s.item} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
              <TripCard trip={t} active={t.id === activeId} onOpen={onOpen} onHover={onHover} />
            </li>
          ))}
        </ul>
      )}

      {loading && total === 0 && <Shimmer />}

      {!loading && stream.status !== "error" && total === 0 && (
        <div className={s.empty}>
          <p>
            <b>Nothing found for this search.</b>
          </p>
          <p>Try Anywhere, a wider window, Anytime, or a different number of nights.</p>
          {stream.done?.note && <p className={s.note}>{stream.done.note}</p>}
        </div>
      )}

      {total > 0 && results.length === 0 && (
        <div className={s.empty}>
          <p>
            <b>The filters hide all {total} trips.</b>
          </p>
          <button type="button" className={s.linkBtn} onClick={onClearFilters}>
            Clear the filters
          </button>
        </div>
      )}

      {stream.status === "error" && (
        <div className={`${s.empty} ${s.error}`} role="alert">
          <p>
            <b>{total ? "The search stopped before it finished." : "The search did not work this time."}</b>
          </p>
          {stream.error && <p>{stream.error}</p>}
          <button type="button" className={s.linkBtn} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {stream.status === "ok" && stream.done && total > 0 && (
        <p className={s.footer}>
          {stream.done.searched > 0 ? `${stream.done.searched} live search${stream.done.searched === 1 ? "" : "es"}` : "No live searches needed"}
          {stream.done.note ? `. ${stream.done.note}` : ""}
        </p>
      )}
    </section>
  );
}
