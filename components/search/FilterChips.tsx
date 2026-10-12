"use client";

import { useState } from "react";
import type { SearchQuery } from "@/lib/trip-result";
import { euro } from "@/lib/format";
import s from "./search.module.css";

// Filter chips under the bar: instant, on the results already found (applyFilters in
// lib/trip-result.ts), never a new search. They wrap onto a second line on a phone rather
// than scroll sideways, so every chip is visible and reachable with Tab.

export type Filters = NonNullable<SearchQuery["filters"]>;

type Props = {
  value: Filters | undefined;
  onChange: (f: Filters | undefined) => void;
  /** The countries the traveller has been to; "New countries" needs at least one. */
  been: string[];
  /** The cheapest and dearest price in the results, for the price slider. */
  priceRange?: [number, number];
};

const LEG_HOURS = [2, 3, 4, 6, 8, 12];

/** Any filter set at all, for "Clear filters". trainsOk false ("flights only") is a filter too. */
export function filtersOn(f: Filters | undefined): boolean {
  return !!f && Object.entries(f).some(([k, v]) => v !== undefined && (v !== false || k === "trainsOk"));
}

/** Drops unset keys so the URL stays short and "no filters" is undefined. */
function tidy(f: Filters): Filters | undefined {
  const out: Filters = {};
  for (const [k, v] of Object.entries(f) as [keyof Filters, Filters[keyof Filters]][]) if (v !== undefined && v !== false) (out as Record<string, unknown>)[k] = v;
  // trainsOk false is the one meaningful false: "flights only".
  if (f.trainsOk === false) out.trainsOk = false;
  return Object.keys(out).length ? out : undefined;
}

export default function FilterChips({ value, onChange, been, priceRange }: Props) {
  const f = value ?? {};
  const [picker, setPicker] = useState<"hours" | "price" | null>(null);
  const set = (patch: Partial<Filters>) => onChange(tidy({ ...f, ...patch }));
  const toggle = (k: "direct" | "eventsOn" | "newCountries") => set({ [k]: f[k] ? undefined : true });
  const lo = priceRange ? Math.floor(priceRange[0] / 10) * 10 : 0;
  const hi = priceRange ? Math.max(lo + 10, Math.ceil(priceRange[1] / 10) * 10) : 0;

  const chip = (on: boolean) => `${s.chip} ${on ? s.chipOn : ""}`;
  return (
    <div className={s.filters}>
      <div className={s.chips} role="group" aria-label="Filter the results">
        <button type="button" aria-pressed={!!f.direct} className={chip(!!f.direct)} onClick={() => toggle("direct")}>
          Direct only
        </button>
        <button type="button" aria-expanded={picker === "hours"} className={chip(!!f.maxLegHours)} onClick={() => setPicker(picker === "hours" ? null : "hours")}>
          {f.maxLegHours ? `Legs under ${f.maxLegHours} h` : "Leg length"}
        </button>
        {([1, 2, 3] as const).map((n) => (
          <button key={n} type="button" aria-pressed={f.cities === n} className={chip(f.cities === n)} onClick={() => set({ cities: f.cities === n ? undefined : n })}>
            {n === 1 ? "1 city" : n === 2 ? "2 cities" : "3+ cities"}
          </button>
        ))}
        <button type="button" aria-pressed={f.trainsOk !== false} className={chip(f.trainsOk !== false)} onClick={() => set({ trainsOk: f.trainsOk === false ? undefined : false })} title="Off: flights only">
          Trains OK
        </button>
        <button type="button" aria-pressed={!!f.eventsOn} className={chip(!!f.eventsOn)} onClick={() => toggle("eventsOn")}>
          Events on
        </button>
        <button
          type="button"
          aria-pressed={!!f.newCountries}
          className={chip(!!f.newCountries)}
          disabled={!been.length && !f.newCountries}
          title={been.length ? "Only countries you have not been to" : "Mark the countries you have been to first (Been, in the top bar)"}
          onClick={() => toggle("newCountries")}
        >
          New countries
        </button>
        {priceRange && (
          <button type="button" aria-expanded={picker === "price"} className={chip(!!f.maxPrice)} onClick={() => setPicker(picker === "price" ? null : "price")}>
            {f.maxPrice ? `Under ${euro(f.maxPrice)}` : "Price"}
          </button>
        )}
        {filtersOn(value) && (
          <button
            type="button"
            className={`${s.chip} ${s.chipGhost}`}
            onClick={() => {
              setPicker(null);
              onChange(undefined);
            }}
          >
            Clear
          </button>
        )}
      </div>
      {picker === "hours" && (
        <div className={`${s.picker} ${s.chips}`} role="radiogroup" aria-label="Longest leg">
          {LEG_HOURS.map((h) => (
            <button key={h} type="button" role="radio" aria-checked={f.maxLegHours === h} className={chip(f.maxLegHours === h)} onClick={() => set({ maxLegHours: f.maxLegHours === h ? undefined : h })}>
              {h} h
            </button>
          ))}
          <button type="button" role="radio" aria-checked={!f.maxLegHours} className={chip(!f.maxLegHours)} onClick={() => set({ maxLegHours: undefined })}>
            Any length
          </button>
        </div>
      )}
      {picker === "price" && priceRange && (
        <label className={`${s.picker} ${s.rangeField}`}>
          <span>
            Up to <b>{euro(f.maxPrice ?? hi)}</b>
          </span>
          <input
            type="range"
            min={lo}
            max={hi}
            step={10}
            value={f.maxPrice ?? hi}
            aria-label="Highest price"
            onChange={(e) => {
              const n = Number(e.target.value);
              set({ maxPrice: n >= hi ? undefined : n });
            }}
          />
        </label>
      )}
    </div>
  );
}
