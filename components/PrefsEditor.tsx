"use client";

// The "Trip style" editor in the top bar's popover: nights a place, pace, money against
// comfort, famous or unusual, what to avoid, the longest flight, and trains and coaches
// between places. Every change is saved at once and announced with the 'atlas:prefs' window
// event (publishPrefs), which the globe listens to: it makes the new style the default of
// every builder. Nothing here searches; the forms still take their own overrides per search.

import { useMemo, useState } from "react";
import type { CountryInfo } from "@/lib/types";
import { AVOID_GROUPS, DEFAULT_PREFS, nightsLabel, publishPrefs, sameAsDefault, type Pace, type Prefs, type Taste, type Tradeoff } from "@/lib/prefs";
import { flagEmoji } from "@/lib/format";

type Props = {
  value: Prefs;
  countries: Record<string, CountryInfo>;
};

const PACES: { key: Pace; label: string; hint: string }[] = [
  { key: "slow", label: "Slow", hint: "Late starts, one or two things a day" },
  { key: "balanced", label: "Balanced", hint: "A full day with room to breathe" },
  { key: "packed", label: "Packed", hint: "See as much as the days allow" },
];
const TRADEOFFS: { key: Tradeoff; label: string; hint: string }[] = [
  { key: "price", label: "Cheapest", hint: "The lowest total; a longer journey is fine" },
  { key: "balanced", label: "Balanced", hint: "Money and hours weighed evenly" },
  { key: "comfort", label: "Comfort", hint: "Shorter journeys and fewer changes, even when they cost more" },
];
const TASTES: { key: Taste; label: string; hint: string }[] = [
  { key: "popular", label: "Popular", hint: "The famous places first" },
  { key: "mixed", label: "Mixed", hint: "Some of each" },
  { key: "unique", label: "Unique", hint: "Smaller cities and hidden gems over the big hubs" },
];
const FLIGHT_HOURS = [3, 4, 6, 8, 10, 12, 16];
const MAX_ROWS = 8;

/** Plain lower case without accents, so "Österreich" and "osterreich" meet. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

/** Two small minus and plus buttons around a number, for the nights a place. */
function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (n: number) => void; label: string }) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={`${label}: one less`}>
        −
      </button>
      <b aria-live="polite">{value}</b>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`${label}: one more`}>
        +
      </button>
    </span>
  );
}

export default function PrefsEditor({ value, countries }: Props) {
  const [query, setQuery] = useState("");
  const set = (patch: Partial<Prefs>) => publishPrefs({ ...value, ...patch });
  const [lo, hi] = value.nightsPerPlace;

  const all = useMemo(
    () =>
      Object.entries(countries)
        .map(([code, c]) => ({ code, name: c.name }))
        .filter((c) => /^[A-Z]{2}$/.test(c.code) && c.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [countries],
  );
  // Typed text to what it could mean: a group word first (nordics, dach), then countries by name or code.
  const hits = useMemo(() => {
    const s = fold(query);
    if (!s) return [];
    const groups = Object.entries(AVOID_GROUPS)
      .filter(([k, g]) => k.startsWith(s) || fold(g.label).includes(s))
      .map(([k, g]) => ({ key: k, label: g.label, sub: "group" }));
    const starts = all.filter((c) => fold(c.name).startsWith(s) || c.code.toLowerCase() === s);
    const rest = all.filter((c) => !starts.includes(c) && fold(c.name).includes(s));
    return [...groups, ...[...starts, ...rest].map((c) => ({ key: c.code, label: c.name, sub: c.code }))].slice(0, MAX_ROWS);
  }, [all, query]);
  const labelOf = (a: string) => AVOID_GROUPS[a]?.label ?? countries[a]?.name ?? a;
  const toggleAvoid = (a: string) => set({ avoid: value.avoid.includes(a) ? value.avoid.filter((x) => x !== a) : [...value.avoid, a] });

  return (
    <div className="prefs">
      <section>
        <h3>Nights in each place</h3>
        <div className="prefsrow">
          <Stepper value={lo} min={1} max={14} label="Fewest nights a place" onChange={(n) => set({ nightsPerPlace: [n, Math.max(n, hi)] })} />
          <span className="muted">to</span>
          <Stepper value={hi} min={1} max={14} label="Most nights a place" onChange={(n) => set({ nightsPerPlace: [Math.min(lo, n), n] })} />
          <span className="muted">nights</span>
        </div>
        <p className="status muted">Wild loops, Smart loops and the chat stay {nightsLabel(value)} in each place unless you change it on the form.</p>
      </section>

      <section>
        <h3>Pace</h3>
        <div className="switch three" role="radiogroup" aria-label="Pace">
          {PACES.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={value.pace === x.key} className={value.pace === x.key ? "on" : ""} onClick={() => set({ pace: x.key })} title={x.hint}>
              {x.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Money or comfort</h3>
        <div className="switch three" role="radiogroup" aria-label="Money or comfort">
          {TRADEOFFS.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={value.tradeoff === x.key} className={value.tradeoff === x.key ? "on" : ""} onClick={() => set({ tradeoff: x.key })} title={x.hint}>
              {x.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Places</h3>
        <div className="switch three" role="radiogroup" aria-label="Famous or unusual places">
          {TASTES.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={value.taste === x.key} className={value.taste === x.key ? "on" : ""} onClick={() => set({ taste: x.key })} title={x.hint}>
              {x.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Never stop in</h3>
        <input
          className="search"
          placeholder="A country or a group: Germany, nordics"
          value={query}
          aria-label="A country or group to avoid"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              if (!value.avoid.includes(hits[0].key)) toggleAvoid(hits[0].key);
              setQuery("");
            }
            if (e.key === "Backspace" && !query && value.avoid.length) set({ avoid: value.avoid.slice(0, -1) });
          }}
        />
        {hits.length > 0 && (
          <div className="list" role="listbox" aria-label="Countries and groups">
            {hits.map((h) => (
              <button
                key={h.key}
                type="button"
                role="option"
                aria-selected={value.avoid.includes(h.key)}
                className={`opt${value.avoid.includes(h.key) ? " on" : ""}`}
                onClick={() => {
                  toggleAvoid(h.key);
                  setQuery("");
                }}
              >
                <span>
                  {/^[A-Z]{2}$/.test(h.key) && (
                    <span className="flag" aria-hidden="true">
                      {flagEmoji(h.key)}
                    </span>
                  )}
                  {h.label}
                </span>
                <small>{value.avoid.includes(h.key) ? "remove" : h.sub}</small>
              </button>
            ))}
          </div>
        )}
        {query.trim() && hits.length === 0 && <div className="status muted">Nothing called &ldquo;{query.trim()}&rdquo;.</div>}
        {value.avoid.length > 0 && (
          <div className="chips" aria-label="Avoided">
            {value.avoid.map((a) => (
              <button key={a} type="button" className="chip ghost on" onClick={() => toggleAvoid(a)} title={`Remove ${labelOf(a)}`}>
                {labelOf(a)} <span className="x">×</span>
              </button>
            ))}
          </div>
        )}
        {value.avoid.length === 0 && <p className="status muted">A connection through them is still fine; you never sleep there.</p>}
      </section>

      <section>
        <h3>Flights and the ground</h3>
        <div className="prefsrow">
          <select className="search slim" value={value.maxFlightHours ?? 0} onChange={(e) => set({ maxFlightHours: Number(e.target.value) || undefined })} aria-label="Longest single flight">
            <option value={0}>flights of any length</option>
            {FLIGHT_HOURS.map((h) => (
              <option key={h} value={h}>
                no flight over {h} h
              </option>
            ))}
          </select>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={value.groundOk} onChange={(e) => set({ groundOk: e.target.checked })} />
          <span>Trains and coaches between places</span>
        </label>
      </section>

      <div className="foot">
        <span className="status muted">Saved in this browser. Every builder starts from it.</span>
        <button type="button" className="chip" disabled={sameAsDefault(value)} onClick={() => publishPrefs({ ...DEFAULT_PREFS, avoid: [] })}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
