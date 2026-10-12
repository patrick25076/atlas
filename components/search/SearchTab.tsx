"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyFilters, doorPrice, oneEachRoute, type SearchQuery, type TripResult } from "@/lib/trip-result";
import type { SearchTabProps } from "@/lib/ui-types";
import { avoidCodes } from "@/lib/prefs";
import { excludedCountries } from "@/lib/been";
import { addDays, monthOptions, todayIso } from "@/lib/format";
import SearchBar, { DEFAULT_NIGHTS, queryProblem } from "./SearchBar";
import AdvancedDrawer, { advancedCount, cleanGroup } from "./AdvancedDrawer";
import FilterChips, { filtersOn, type Filters } from "./FilterChips";
import ResultsList, { sortForTradeoff, sortTrips, useSearchStream, type SortKey } from "./ResultsList";
import s from "./search.module.css";

// The Search tab: the one search bar, the Advanced drawer, the filter chips and the one
// results list. The tab owns the query being edited, the /api/search stream and the list on
// show. The shell (components/Globe.tsx) owns the rest, through SearchTabProps in
// lib/ui-types.ts: where the traveller is, the globe (onResults draws the list, onHover the
// hovered route), the trip page (onOpen), the address bar and the saved searches (onQuery),
// and queries from outside the bar ('atlas:search', the command line, old links), which it
// hands over as `run`. So this tab never writes the URL and never listens to the window bus
// itself: one writer, one listener, no search run twice.

export type { SearchTabProps };

/** The search a fresh tab starts from: anywhere, anytime, 3 to 7 nights. Money first. */
function blankQuery(from: SearchQuery["from"]): SearchQuery {
  return { from, to: { kind: "anywhere" }, when: { kind: "anytime" }, nights: [...DEFAULT_NIGHTS] };
}

/** A few searches worth one tap on an empty tab, so the first screen is never a blank form. */
function suggestions(from: SearchQuery["from"]): { label: string; q: SearchQuery }[] {
  const today = todayIso();
  const next = monthOptions()[1];
  return [
    { label: "Anywhere, anytime", q: blankQuery(from) },
    { label: "A long weekend this month", q: { from, to: { kind: "anywhere" }, when: { kind: "window", from: addDays(today, 3), to: addDays(today, 30) }, nights: [2, 3] } },
    { label: "A week next month", q: { from, to: { kind: "anywhere" }, when: { kind: "month", month: next }, nights: [6, 8] } },
    { label: "Two cities, one trip", q: { from, to: { kind: "anywhere" }, when: { kind: "anytime" }, nights: [4, 7], shape: "two" } },
  ];
}

const NO_FROM: SearchQuery["from"] = { label: "", lat: 0, lon: 0, airports: [], home: "" };

/** The query key that decides whether a search is the same search: filters are client side, so they are left out. */
const runKey = (q: SearchQuery) => JSON.stringify({ ...q, filters: undefined });

/**
 * The query as the bar edits it: without the per-run extras. Exclusions (Been and the Trip
 * style's avoid list), the Trip style itself, a search budget and the filter chips are added
 * fresh on every run from what is on screen now. Kept in the draft, they would stick: a
 * country un-ticked in Been would stay excluded, a chip cleared by hand would come back.
 */
function barQuery(q: SearchQuery): SearchQuery {
  const rest = { ...q };
  delete rest.exclude;
  delete rest.prefs;
  delete rest.budget;
  delete rest.filters;
  return rest;
}

/** Where a query came from: the bar's own draft, or a hand-over (chat, command line, link, retry) whose extras count once. */
type Origin = { force?: boolean; external?: boolean };

export default function SearchTab({ from: fromProp, prefs, been, run, active, onResults, onQuery, onOpen, onHover }: SearchTabProps) {
  // Keyed by value, not identity: a shell that builds a new From every render must not make
  // every search look new or reset the bar.
  const fromKey = fromProp ? JSON.stringify(fromProp) : "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fromKey is fromProp by value
  const from = useMemo<SearchQuery["from"]>(() => fromProp ?? NO_FROM, [fromKey]);
  const [draft, setDraft] = useState<SearchQuery>(() => (run?.query ? barQuery({ ...run.query, from: run.query.from ?? from }) : blankQuery(from)));
  const [ran, setRan] = useState<SearchQuery | null>(null);
  const [filters, setFilters] = useState<Filters | undefined>(run?.query.filters);
  const [sort, setSortState] = useState<SortKey>(() => sortForTradeoff(prefs.tradeoff));
  /** True once the traveller picked a sort by hand: the Trip style no longer moves it. */
  const sortPicked = useRef(false);
  const setSort = useCallback((k: SortKey) => {
    sortPicked.current = true;
    setSortState(k);
  }, []);
  // The shell loads the saved Trip style after the first render, and the traveller can change
  // it at any time; the default sort follows it until a sort is picked by hand.
  useEffect(() => {
    if (!sortPicked.current) setSortState(sortForTradeoff(prefs.tradeoff));
  }, [prefs.tradeoff]);
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [advOpen, setAdvOpen] = useState(() => !!run?.query && advancedCount(run.query) > 0);
  const [opened, setOpened] = useState<string | null>(null);
  const { state: stream, run: runStream } = useSearchStream();
  const lastKey = useRef<string>("");
  /** A query waiting for the airports (a link opened before the traveller's place is known). */
  const pending = useRef<{ q: SearchQuery; external: boolean } | null>(null);
  const waiting = !from.airports.length;

  // Been's "only new countries" and the trip style's places to avoid, as the engines read them.
  const exclude = useMemo(() => [...new Set([...excludedCountries(been), ...avoidCodes(prefs)])], [been, prefs]);
  const beenList = been.countries;

  // The traveller's place is the From of every search: when it arrives or changes (the top
  // bar's place picker), the draft follows.
  useEffect(() => {
    setDraft((d) => (d.from === from ? d : { ...d, from }));
  }, [from]);

  // The chips on screen, read by go() without making it a new function on every chip tap.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const go = useCallback(
    (raw: SearchQuery, opts: Origin = {}) => {
      const external = !!opts.external;
      // A query from a link or the chat may carry no From: the traveller's own fills it.
      const withFrom: SearchQuery = { ...raw, from: raw.from?.airports?.length ? raw.from : from };
      const bar = barQuery(withFrom);
      if (!withFrom.from.airports.length) {
        pending.current = { q: withFrom, external };
        setDraft(bar);
        return;
      }
      pending.current = null;
      // Exclusions come from Been and the Trip style as they are now; a hand-over may add its
      // own once (the chat's "not Italy"), the bar's draft never carries any.
      const skip = [...new Set([...exclude, ...(external ? (raw.exclude ?? []) : [])])];
      const extras = { prefs, exclude: skip.length ? skip : undefined, budget: external ? raw.budget : undefined };
      if (queryProblem(bar)) {
        setDraft(bar);
        setCollapsed(false);
        return;
      }
      const q = cleanGroup({ ...bar, ...extras });
      setDraft(bar);
      // Chips from a hand-over replace the ones on screen; a bar search keeps what is on screen.
      const chips = external && raw.filters !== undefined ? raw.filters : filtersRef.current;
      if (external && raw.filters !== undefined) setFilters(raw.filters);
      setCollapsed(true);
      // The bar folds to a summary line: start the list from the top, not from wherever the
      // form was scrolled to (on a phone that left the chips half under the tabs).
      requestAnimationFrame(() => rootRef.current?.closest(".searchwrap")?.scrollTo({ top: 0, behavior: "smooth" }));
      const key = runKey(q);
      if (key === lastKey.current && !opts.force) return;
      lastKey.current = key;
      setRan(q);
      setOpened(null);
      onQuery({ ...q, filters: chips });
      // The engines get the search without the chips: the chips filter what comes back, instantly.
      void runStream({ ...q, filters: undefined });
    },
    [from, prefs, exclude, runStream, onQuery],
  );

  // A query from outside the bar: n changes on every hand-over, so the same query twice runs
  // twice; auto false only fills the bar (and opens Advanced when the query uses it).
  const lastRun = useRef<number | null>(null);
  useEffect(() => {
    if (!run || run.n === lastRun.current) return;
    lastRun.current = run.n;
    if (advancedCount(run.query) > 0) setAdvOpen(true);
    if (run.auto) go(run.query, { force: true, external: true });
    else {
      setDraft(barQuery({ ...run.query, from: run.query.from?.airports?.length ? run.query.from : from }));
      if (run.query.filters !== undefined) setFilters(run.query.filters);
      setCollapsed(false);
    }
  }, [run, go, from]);

  // A query waiting for the airports runs as soon as they arrive.
  useEffect(() => {
    if (!waiting && pending.current) go(pending.current.q, { force: true, external: pending.current.external });
  }, [waiting, go]);

  // The list on show: the chips over what came back, then the sort.
  // With flexible dates one card per route (the cheapest day), as an explore page lists them.
  const filtered = useMemo(() => applyFilters(stream.results, filters, beenList), [stream.results, filters, beenList]);
  const shown = useMemo(() => oneEachRoute(sortTrips(filtered, sort), ran?.when), [filtered, sort, ran?.when]);

  // The globe draws the same list. The callback is read through a ref so a new function from
  // the shell on every render does not redraw the globe.
  const onResultsRef = useRef(onResults);
  useEffect(() => {
    onResultsRef.current = onResults;
  }, [onResults]);
  const { status, done, graph, error } = stream;
  useEffect(() => {
    onResultsRef.current(shown, { status, graph, searched: done?.searched, note: error ?? done?.note });
  }, [shown, status, graph, done, error]);

  const priceRange = useMemo<[number, number] | undefined>(() => {
    if (stream.results.length < 2) return undefined;
    let lo = Infinity;
    let hi = 0;
    for (const t of stream.results) {
      lo = Math.min(lo, doorPrice(t));
      hi = Math.max(hi, doorPrice(t));
    }
    return hi > lo ? [lo, hi] : undefined;
  }, [stream.results]);

  const open = useCallback(
    (t: TripResult) => {
      setOpened(t.id);
      onOpen(t);
    },
    [onOpen],
  );

  const idle = stream.status === "idle";
  return (
    <div className={s.tab} ref={rootRef}>
      <SearchBar value={draft} onChange={setDraft} onSubmit={(q) => go(q ?? draft, { force: true })} waiting={waiting} busy={!!ran && runKey(draft) === runKey(barQuery(ran))} collapsed={collapsed} onExpand={() => setCollapsed(false)} />
      {!collapsed && <AdvancedDrawer value={draft} onChange={setDraft} prefs={prefs} open={advOpen} onToggle={() => setAdvOpen((o) => !o)} />}
      {!idle && <FilterChips value={filters} onChange={setFilters} been={beenList} priceRange={priceRange} />}
      {idle ? (
        <div className={s.start}>
          <p className={s.startLead}>Where to, and when? Or start from one of these.</p>
          <div className={s.chips}>
            {suggestions(from).map((x) => (
              <button key={x.label} type="button" className={`${s.chip} ${s.chipSuggest}`} disabled={waiting} onClick={() => go(x.q)}>
                {x.label}
              </button>
            ))}
          </div>
          <p className={s.hint}>Cheapest first. Trains and coaches between places count, priced apart.</p>
        </div>
      ) : (
        <ResultsList
          stream={stream}
          results={shown}
          activeId={active ?? opened}
          onOpen={open}
          onHover={onHover}
          sort={sort}
          onSort={setSort}
          hidden={filtersOn(filters) ? stream.results.length - filtered.length : 0}
          onClearFilters={() => setFilters(undefined)}
          onRetry={() => ran && go(ran, { force: true, external: true })}
        />
      )}
    </div>
  );
}
