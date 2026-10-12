"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Airport, CountryInfo } from "@/lib/types";
import type { Origin } from "@/lib/ui-types";
import type { BeenPrefs } from "@/lib/been";
import { countryName, monthLabel, monthOptions } from "@/lib/format";
import BeenEditor from "./BeenEditor";
import CommandBar from "./CommandBar";
import PrefsEditor from "./PrefsEditor";
import Guide from "./Guide";
import type { Command } from "@/lib/command";
import { nightsLabel, sameAsDefault, type Prefs } from "@/lib/prefs";

type Props = {
  origin: Origin | null;
  airports: Airport[];
  onOrigin: (a: Airport) => void;
  month: string | null;
  onMonth: (m: string | null) => void;
  searching: boolean;
  /** Something is searching anywhere in the app: the command line shows a spinner. */
  busy: boolean;
  /** Run a command from the command line (the globe runs it, like an atlas:command event). */
  onCommand: (c: Command) => void;
  onShare: () => void;
  copied: boolean;
  /** The "Been" preference: countries already visited, and whether only new ones are wanted. */
  been: BeenPrefs;
  onBeen: (p: BeenPrefs) => void;
  countries: Record<string, CountryInfo>;
  /** The trip style: the pill shows its nights a place, the editor changes it (and announces it with 'atlas:prefs'). */
  prefs: Prefs;
};

/** Airports matching a typed code, city or name; exact code first, then the biggest. Shared with the group editor. */
export function searchAirports(airports: Airport[], q: string): Airport[] {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const exact = airports.filter((a) => a.iata.toLowerCase() === s);
  const rest = airports.filter((a) => a.iata.toLowerCase() !== s && (a.name.toLowerCase().includes(s) || (a.city ?? "").toLowerCase().includes(s)));
  const rank = (a: Airport) => (a.size === "large" ? 0 : a.size === "medium" ? 1 : 2);
  rest.sort((a, b) => rank(a) - rank(b) || (a.city ?? a.name).localeCompare(b.city ?? b.name));
  return [...exact, ...rest].slice(0, 8);
}

/** Closes a popover on a click outside or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export default function TopBar(p: Props) {
  const [open, setOpen] = useState<"from" | "when" | "been" | "style" | null>(null);
  // "How Atlas works": the "?" button, "/help" on the command line, or anyone through 'atlas:guide'.
  const [guide, setGuide] = useState(false);
  const closeGuide = useCallback(() => setGuide(false), []);
  // A form's "edit" link next to "Using your trip style" opens the editor here ('atlas:open-prefs').
  useEffect(() => {
    const onOpenPrefs = () => setOpen("style");
    const onGuide = () => setGuide(true);
    window.addEventListener("atlas:open-prefs", onOpenPrefs);
    window.addEventListener("atlas:guide", onGuide);
    return () => {
      window.removeEventListener("atlas:open-prefs", onOpenPrefs);
      window.removeEventListener("atlas:guide", onGuide);
    };
  }, []);
  const styleSet = !sameAsDefault(p.prefs);
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchAirports(p.airports, query), [p.airports, query]);
  const ref = useDismiss(open !== null, () => setOpen(null));
  const months = useMemo(monthOptions, []);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open === "from") inputRef.current?.focus();
  }, [open]);
  const beenCount = p.been.countries.length;

  return (
    <header className="topbar">
      <div className="brand">
        <h1>
          atlas<span>.</span>
        </h1>
        <small>cheapest getaways from wherever you are</small>
      </div>

      <div ref={open ? ref : undefined} style={{ display: "contents" }}>
        <button className={`pill${open === "from" ? " on" : ""}`} onClick={() => setOpen(open === "from" ? null : "from")} title="Where you start from">
          <span className={`dot${p.searching ? " busy" : ""}`} />
          <span className="k">From</span>
          {p.origin ? p.origin.label : "finding you…"}
          <span className="caret">▾</span>
          {open === "from" && (
            <div className="popover" onClick={(e) => e.stopPropagation()}>
              <input
                ref={inputRef}
                className="search"
                placeholder="City, airport or code (Lisbon, JFK, Brașov)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hits[0]) {
                    p.onOrigin(hits[0]);
                    setQuery("");
                    setOpen(null);
                  }
                }}
              />
              {hits.length === 0 && (
                <div className="status" style={{ padding: "6px 10px 8px" }}>
                  {p.origin?.source === "ip" && "Placed roughly from your network. "}
                  {p.origin?.source === "gps" && "Placed by your device. "}
                  Type a city or airport anywhere on earth to start from there.
                </div>
              )}
              {hits.map((a) => (
                <div
                  key={a.iata}
                  className="row"
                  onClick={() => {
                    p.onOrigin(a);
                    setQuery("");
                    setOpen(null);
                  }}
                >
                  <span className="code">{a.iata}</span>
                  <span>
                    <div className="name">{a.city ?? a.name}</div>
                    <div className="sub">
                      {a.name}, {countryName(a.country)}
                    </div>
                  </span>
                  <span className="meta">{a.size}</span>
                </div>
              ))}
            </div>
          )}
        </button>

        <button className={`pill${open === "when" ? " on" : ""}`} onClick={() => setOpen(open === "when" ? null : "when")} title="When">
          <span className="k">When</span>
          {p.month ? monthLabel(p.month) : "Next 6 weeks"}
          <span className="caret">▾</span>
          {open === "when" && (
            <div className="popover" style={{ minWidth: 220 }} onClick={(e) => e.stopPropagation()}>
              <button
                className={`opt${p.month == null ? " on" : ""}`}
                onClick={() => {
                  p.onMonth(null);
                  setOpen(null);
                }}
              >
                Next 6 weeks <small>searched nightly</small>
              </button>
              {months.map((m) => (
                <button
                  key={m}
                  className={`opt${p.month === m ? " on" : ""}`}
                  onClick={() => {
                    p.onMonth(m);
                    setOpen(null);
                  }}
                >
                  {monthLabel(m)} <small>live search</small>
                </button>
              ))}
            </div>
          )}
        </button>

        {/* The editor holds inputs and buttons, so it sits next to the pill rather than inside it: a button cannot contain buttons. */}
        <div className="pillwrap">
          <button
            className={`pill beenpill${open === "been" ? " on" : ""}${beenCount ? " set" : ""}`}
            onClick={() => setOpen(open === "been" ? null : "been")}
            title="Countries you have already been to"
            aria-haspopup="dialog"
            aria-expanded={open === "been"}
          >
            <span className="k">Been</span>
            <span className={`v${beenCount ? "" : " empty"}`}>{beenCount ? `${beenCount}${p.been.newOnly ? " · only new" : ""}` : "add countries"}</span>
            <span className="caret">▾</span>
          </button>
          {open === "been" && (
            <div className="popover" role="dialog" aria-label="Countries you have been to">
              <BeenEditor countries={p.countries} value={p.been} onChange={p.onBeen} />
            </div>
          )}
        </div>

        {/* The trip style: nights a place and the rest, the default of every builder. A sibling popover, like Been's. */}
        <div className="pillwrap">
          <button
            className={`pill stylepill${open === "style" ? " on" : ""}${styleSet ? " set" : ""}`}
            onClick={() => setOpen(open === "style" ? null : "style")}
            title="Your trip style: nights in each place, pace, cheapest or comfort, places to avoid"
            aria-haspopup="dialog"
            aria-expanded={open === "style"}
          >
            <span className="k">Trip style</span>
            <span className="v">{nightsLabel(p.prefs)}</span>
            {styleSet && <span className="setdot" aria-label="changed from the defaults" />}
            <span className="caret">▾</span>
          </button>
          {open === "style" && (
            <div className="popover prefspop" role="dialog" aria-label="Your trip style">
              <PrefsEditor value={p.prefs} countries={p.countries} />
            </div>
          )}
        </div>
      </div>

      {/* The command line: routes, events, trips, places and questions, all from one box. */}
      <CommandBar onRun={p.onCommand} busy={p.busy} onHelp={() => setGuide(true)} />

      <span className="spacer" />
      <button className="pill helpbtn" onClick={() => setGuide(true)} title="How Atlas works" aria-label="How Atlas works">
        ?
      </button>
      <button className="pill share" onClick={p.onShare} title="Copy a link to this view">
        {p.copied ? "Link copied" : "Share"}
      </button>
      <Guide open={guide} onClose={closeGuide} />
    </header>
  );
}
