"use client";

// The "Been" editor: the countries the visitor has already visited, and whether they want
// only new ones. Rendered inside the top bar's popover. The list comes from
// public/data/countries.json (already loaded by the globe), the flags from the code, and the
// choice lives in the browser only: the top bar saves it with saveBeen on every change.

import { useEffect, useMemo, useRef, useState } from "react";
import type { BeenPrefs } from "@/lib/been";
import { cleanCodes } from "@/lib/been";
import type { CountryInfo } from "@/lib/types";
import { flagEmoji } from "@/lib/format";

type Props = {
  countries: Record<string, CountryInfo>;
  value: BeenPrefs;
  onChange: (p: BeenPrefs) => void;
};

const MAX_ROWS = 12;

export default function BeenEditor({ countries, value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const all = useMemo(
    () =>
      Object.entries(countries)
        .map(([code, c]) => ({ code, name: c.name }))
        .filter((c) => /^[A-Z]{2}$/.test(c.code) && c.name)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [countries],
  );
  const nameOf = (code: string) => countries[code]?.name ?? code;
  const selected = new Set(value.countries);

  // Prefix matches first (typing "it" should put Italy before Haiti), then the rest.
  const hits = useMemo(() => {
    const s = query.trim().toLowerCase();
    if (!s) return [];
    const starts = all.filter((c) => c.name.toLowerCase().startsWith(s) || c.code.toLowerCase() === s);
    const rest = all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(s));
    return [...starts, ...rest].slice(0, MAX_ROWS);
  }, [all, query]);

  // The list keeps the order the visitor added countries in, so Backspace removes the one just
  // added like a tag box would; saveBeen and excludeParam sort it on their side.
  function toggle(code: string) {
    const cc = cleanCodes([code])[0];
    if (!cc) return;
    onChange({ ...value, countries: selected.has(cc) ? value.countries.filter((c) => c !== cc) : [...value.countries, cc] });
  }

  return (
    <div className="been">
      <input
        ref={inputRef}
        className="search"
        placeholder="Add a country you have been to"
        value={query}
        aria-label="Add a country you have been to"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) {
            e.preventDefault();
            toggle(hits[0].code);
            setQuery("");
          }
          // Backspace on an empty box removes the last country, like a tag box.
          if (e.key === "Backspace" && !query && value.countries.length) onChange({ ...value, countries: value.countries.slice(0, -1) });
        }}
      />
      {hits.length > 0 && (
        <div className="list" role="listbox" aria-label="Countries">
          {hits.map((c) => (
            <button
              key={c.code}
              type="button"
              role="option"
              aria-selected={selected.has(c.code)}
              className={`opt${selected.has(c.code) ? " on" : ""}`}
              onClick={() => {
                toggle(c.code);
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <span>
                <span className="flag" aria-hidden="true">
                  {flagEmoji(c.code)}
                </span>
                {c.name}
              </span>
              <small>{selected.has(c.code) ? "remove" : c.code}</small>
            </button>
          ))}
        </div>
      )}
      {query.trim() && hits.length === 0 && <div className="status muted">No country called &ldquo;{query.trim()}&rdquo;.</div>}

      {value.countries.length > 0 ? (
        <div className="chips" aria-label="Countries you have been to">
          {value.countries.map((code) => (
            <button key={code} type="button" className="chip ghost on" onClick={() => toggle(code)} title={`Remove ${nameOf(code)}`}>
              <span className="flag" aria-hidden="true">
                {flagEmoji(code)}
              </span>
              {nameOf(code)} <span className="x">×</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="status muted">Mark the countries you know. Nothing changes until you do.</div>
      )}

      <div className="switch" role="radiogroup" aria-label="Where to go next">
        <button type="button" role="radio" aria-checked={!value.newOnly} className={!value.newOnly ? "on" : ""} onClick={() => onChange({ ...value, newOnly: false })}>
          Revisits are fine
        </button>
        <button type="button" role="radio" aria-checked={value.newOnly} className={value.newOnly ? "on" : ""} onClick={() => onChange({ ...value, newOnly: true })}>
          Only new countries
        </button>
      </div>
      <div className="foot">
        <span className="status muted">
          {value.newOnly
            ? `${value.countries.length} excluded as a destination or a night; a layover through them is fine.`
            : value.countries.length
              ? `${value.countries.length} marked. Deals there get a "been" tag.`
              : "Saved in this browser only."}
        </span>
        {value.countries.length > 0 && (
          <button type="button" className="chip" onClick={() => onChange({ countries: [], newOnly: false })}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
