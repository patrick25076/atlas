"use client";

import { useState } from "react";
import type { Deal, Gateway } from "@/lib/types";
import { formatDuration } from "@/lib/geo";

export type FinderQuery = { origins: string[]; from: string; to: string; include?: string; minNights: number; maxNights: number; direct: boolean; maxHours?: number; where: string; returnTo: string[] };
export type FinderState = { status: "idle" | "loading" | "ok" | "error"; query?: FinderQuery; deals: Deal[]; lines: string[]; note?: string; searched?: number };

const WHERE = ["anywhere", "Europe", "Asia", "Africa", "North America", "South America"];
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The custom search: a period, a must-include date, nights, which of your airports, where, and whether home may be another airport. */
export default function FinderForm({ gateways, defaults, state, onSearch, onClear }: { gateways: Gateway[]; defaults: string[]; state: FinderState; onSearch: (q: FinderQuery) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const [origins, setOrigins] = useState<string[]>([]);
  const [returnTo, setReturnTo] = useState<string[]>([]);
  const [from, setFrom] = useState(iso(new Date(Date.now() + 7 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date(Date.now() + 21 * 86_400_000)));
  const [include, setInclude] = useState("");
  const [minNights, setMinNights] = useState(2);
  const [maxNights, setMaxNights] = useState(6);
  const [direct, setDirect] = useState(false);
  const [maxHours, setMaxHours] = useState(0);
  const [where, setWhere] = useState("anywhere");
  const [country, setCountry] = useState("");
  const chosen = origins.length ? origins : defaults;
  const toggle = (list: string[], set: (v: string[]) => void, code: string, fallback: string[]) => {
    const base = list.length ? list : fallback;
    set(base.includes(code) ? base.filter((x) => x !== code) : [...base, code]);
  };

  if (!open && state.status === "idle") {
    return (
      <div className="chips">
        <button className="chip ghost" onClick={() => setOpen(true)}>
          Custom search: a period, a date to include, your airports, open-jaw
        </button>
      </div>
    );
  }
  if (!open && state.status !== "idle") {
    return (
      <div className="answer">
        <div className="q">
          {state.status === "loading" ? (state.lines.at(-1) ?? "Searching…") : state.status === "error" ? state.note : `${state.deals.length} found: ${state.query?.origins.join(", ")} → ${state.query?.where}, ${state.query?.from} to ${state.query?.to}${state.query?.include ? `, there on ${state.query.include}` : ""}, ${state.query?.minNights} to ${state.query?.maxNights} nights${state.query?.returnTo.length ? `, home via ${state.query.returnTo.join("/")} allowed` : ""}.`}
        </div>
        <div className="chips">
          <button className="chip ghost" onClick={() => setOpen(true)}>
            Change
          </button>
          <button className="chip ghost" onClick={onClear}>
            Back to tonight's deals
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="finder">
      <h2>From which airports</h2>
      <div className="chips">
        {gateways.map((g) => (
          <button key={g.airport.iata} className={`chip${chosen.includes(g.airport.iata) ? " on" : ""}`} onClick={() => toggle(origins, setOrigins, g.airport.iata, defaults)} title={g.airport.name}>
            {g.airport.iata} · {g.airport.city ?? g.airport.name} · {formatDuration(g.driveMin)}
          </button>
        ))}
      </div>
      <h2>When</h2>
      <div className="form">
        <input className="search" type="date" value={from} min={iso(new Date())} onChange={(e) => setFrom(e.target.value)} aria-label="Period start" />
        <input className="search" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Period end" />
      </div>
      <div className="form">
        <input className="search" type="date" value={include} min={from} max={to} onChange={(e) => setInclude(e.target.value)} aria-label="Must include this date" placeholder="Must include" />
        <select className="search" value={minNights} onChange={(e) => setMinNights(Number(e.target.value))} aria-label="Minimum nights">
          {[1, 2, 3, 4, 5, 6, 7, 10, 14].map((n) => (
            <option key={n} value={n}>
              {n}+ nights
            </option>
          ))}
        </select>
        <select className="search" value={maxNights} onChange={(e) => setMaxNights(Number(e.target.value))} aria-label="Maximum nights">
          {[2, 3, 4, 5, 6, 7, 10, 14, 21, 30].map((n) => (
            <option key={n} value={n}>
              up to {n}
            </option>
          ))}
        </select>
      </div>
      <div className="status muted">{include ? `Away on ${include}, ` : ""}anywhere between the two dates, {minNights} to {maxNights} nights.</div>
      <h2>Where and how</h2>
      <div className="chips nowrap">
        {WHERE.map((w) => (
          <button key={w} className={`chip ghost${where === w && !country ? " on" : ""}`} onClick={() => { setWhere(w); setCountry(""); }}>
            {w === "anywhere" ? "Anywhere" : w}
          </button>
        ))}
      </div>
      <div className="form">
        <input className="search" placeholder="or a country: Italy, Morocco, Japan…" value={country} onChange={(e) => setCountry(e.target.value)} />
        <button className={`chip${direct ? " on" : ""}`} onClick={() => setDirect(!direct)}>
          Direct
        </button>
        <select className="search" style={{ flex: "0 0 110px" }} value={maxHours} onChange={(e) => setMaxHours(Number(e.target.value))} aria-label="Max flight hours">
          <option value={0}>any length</option>
          {[3, 4, 6, 8, 12].map((h) => (
            <option key={h} value={h}>
              under {h} h
            </option>
          ))}
        </select>
      </div>
      <h2>Flying home may land at</h2>
      <div className="chips">
        {gateways.map((g) => (
          <button key={g.airport.iata} className={`chip ghost${returnTo.includes(g.airport.iata) || chosen.includes(g.airport.iata) ? " on" : ""}`} disabled={chosen.includes(g.airport.iata)} onClick={() => toggle(returnTo, setReturnTo, g.airport.iata, [])} title={chosen.includes(g.airport.iata) ? "already a departure airport" : "allow the return to land here (open-jaw, two tickets)"}>
            {g.airport.iata}
          </button>
        ))}
      </div>
      <div className="chips">
        <button
          className="chip on"
          disabled={state.status === "loading" || !from || !to || to < from}
          onClick={() => {
            setOpen(false);
            onSearch({ origins: chosen, from, to, include: include || undefined, minNights, maxNights, direct, maxHours: maxHours || undefined, where: country.trim() || where, returnTo: returnTo.filter((x) => !chosen.includes(x)) });
          }}
        >
          {state.status === "loading" ? "Searching…" : "Search live"}
        </button>
        <button className="chip ghost" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="status muted">About twenty live searches on Kiwi.com, half a minute; forty with another airport for the way home.</div>
    </div>
  );
}
