"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Airport, CountryInfo } from "@/lib/types";
import type { Origin } from "@/lib/ui-types";
import type { BeenPrefs } from "@/lib/been";
import { countryName, monthLabel, monthOptions } from "@/lib/format";
import BeenEditor from "./BeenEditor";

type Props = {
  origin: Origin | null;
  airports: Airport[];
  onOrigin: (a: Airport) => void;
  month: string | null;
  onMonth: (m: string | null) => void;
  searching: boolean;
  asking: boolean;
  onAsk: (q: string) => void;
  onShare: () => void;
  copied: boolean;
  /** The "Been" preference: countries already visited, and whether only new ones are wanted. */
  been: BeenPrefs;
  onBeen: (p: BeenPrefs) => void;
  countries: Record<string, CountryInfo>;
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
  const [open, setOpen] = useState<"from" | "when" | "been" | null>(null);
  const [query, setQuery] = useState("");
  const [question, setQuestion] = useState("");
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
      </div>

      <form
        className="askbar desktop"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) {
            p.onAsk(question.trim());
            setQuestion("");
          }
        }}
      >
        <input placeholder="Ask anything: a warm weekend under €60, direct…" value={question} onChange={(e) => setQuestion(e.target.value)} disabled={p.asking} />
        <button type="submit" disabled={p.asking || !question.trim()}>
          {p.asking ? "Thinking…" : "Ask"}
        </button>
      </form>

      <span className="spacer" />
      <button className="pill share" onClick={p.onShare} title="Copy a link to this view">
        {p.copied ? "Link copied" : "Share"}
      </button>
    </header>
  );
}
