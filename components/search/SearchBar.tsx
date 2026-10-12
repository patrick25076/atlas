"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchQuery } from "@/lib/trip-result";
import { WILD_NIGHTS, WILD_REGIONS } from "@/lib/ui-types";
import { addDays, countryName, dateRange, monthLabel, monthOptions, shortDate, todayIso } from "@/lib/format";
import s from "./search.module.css";

// The one search bar: From (the traveller's airports), To (anywhere, a place, a country or a
// region), When (exact dates, a flexible window, a month or anytime), Nights or one way, and
// Search. After a search it folds into one summary line so the results get the screen; a tap
// on the line opens it again. The bar only edits the query; SearchTab runs it.

type Props = {
  value: SearchQuery;
  onChange: (q: SearchQuery) => void;
  /** Runs the search; gets the query when the bar changed it on the way (a typed To resolved to a country or city). */
  onSubmit: (q?: SearchQuery) => void;
  /** True while the airports are not known yet: Search waits. */
  waiting?: boolean;
  busy?: boolean;
  collapsed?: boolean;
  onExpand?: () => void;
};

export const DEFAULT_NIGHTS: [number, number] = [3, 7];
const NIGHTS_MIN = 1;
const NIGHTS_MAX = 30;

type WhenKind = SearchQuery["when"]["kind"];
const WHEN_TABS: { key: WhenKind; label: string }[] = [
  { key: "dates", label: "Dates" },
  { key: "window", label: "Flexible" },
  { key: "month", label: "Month" },
  { key: "anytime", label: "Anytime" },
];

// ---- Plain words for a query, shared by the folded bar and anyone who wants to say what was searched.

export function toLabel(to: SearchQuery["to"]): string {
  switch (to.kind) {
    case "anywhere":
      return "Anywhere";
    case "place":
      return to.name;
    case "country":
      return to.name;
    case "region":
      return WILD_REGIONS.find((r) => r.key === to.key)?.label ?? to.key;
  }
}

export function whenLabel(w: SearchQuery["when"]): string {
  switch (w.kind) {
    case "dates":
      return w.back ? dateRange(w.out, w.back) : `${shortDate(w.out)}, one way`;
    case "window":
      return `${dateRange(w.from, w.to)}${w.include ? `, with ${shortDate(w.include)}` : ""}`;
    case "month":
      return monthLabel(w.month);
    case "anytime":
      return "Anytime";
  }
}

export function nightsWords(q: SearchQuery): string {
  if (q.oneWay) return "one way";
  if (q.when.kind === "dates" && q.when.back) return "";
  const [a, b] = q.nights ?? DEFAULT_NIGHTS;
  return a === b ? `${a} night${a === 1 ? "" : "s"}` : `${a} to ${b} nights`;
}

/** "Brasov to Anywhere, Anytime, 3 to 7 nights". */
export function describeQuery(q: SearchQuery): string {
  return [`${q.from.label || "Your place"} to ${toLabel(q.to)}`, whenLabel(q.when), nightsWords(q)].filter(Boolean).join(", ");
}

/** What is wrong with the query in plain words, or null when it can run. */
export function queryProblem(q: SearchQuery): string | null {
  const today = todayIso();
  const w = q.when;
  if (w.kind === "dates") {
    if (!w.out) return "Pick the day you leave.";
    if (w.out < today) return "The day you leave is in the past.";
    if (!q.oneWay && !w.back) return "Pick the day you come back, or choose one way.";
    if (w.back && w.back < w.out) return "You come back before you leave.";
  }
  if (w.kind === "window") {
    if (!w.from || !w.to) return "Pick both ends of the window.";
    if (w.to < w.from) return "The window ends before it starts.";
    if (w.to < today) return "The window is in the past.";
    if (w.include && (w.include < w.from || w.include > w.to)) return "The day it must include is outside the window.";
  }
  if (q.to.kind === "place" && !q.to.name.trim()) return "Type where to, or pick Anywhere.";
  // The server refuses a long stay without a target, so the bar says it before Search does.
  if (q.advanced?.longStay && q.to.kind === "anywhere") return "A long stay needs a place, country or region in To.";
  // A group needs two people who can fly from somewhere; saying so beats running a solo search.
  const g = q.advanced?.group;
  if (g && (g.members.length < 2 || g.members.some((m) => !m.origins.some((o) => o.trim())))) return "Add airports for everyone in the group.";
  return null;
}

/**
 * A new To, with the wild loop's region following it: the server walks advanced.wild.region,
 * so a region picked in To while the wild loop is on must move the loop too, or the summary
 * line and the search would name different regions.
 */
export function withTo(q: SearchQuery, to: SearchQuery["to"]): SearchQuery {
  const wild = q.advanced?.wild;
  if (wild && to.kind === "region" && wild.region !== to.key && WILD_REGIONS.some((r) => r.key === to.key)) return { ...q, to, advanced: { ...q.advanced, wild: { ...wild, region: to.key } } };
  return { ...q, to };
}

// ---- The To typeahead. The lists are the same static files the globe loads, so the browser
// usually has them cached; towns (1.4 MB) load only when a typed name finds few cities.

type CityRow = { code: string; name: string; country: string; pop: number; f: string };
type TownRow = { name: string; country: string; pop: number; f: string };
type CountryRow = { code: string; name: string; f: string };

/** "Brașov" and "brasov" are one key: accents gone, lower case. */
function fold(x: string): string {
  return x
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

const cache: { cities?: Promise<CityRow[]>; towns?: Promise<TownRow[]>; countries?: Promise<CountryRow[]> } = {};
async function loadJson<T>(file: string): Promise<T | null> {
  try {
    const r = await fetch(`/data/${file}`, { cache: "force-cache" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
function citiesList(): Promise<CityRow[]> {
  cache.cities ??= loadJson<Record<string, { name: string; country: string; pop?: number }>>("cities.json").then((j) =>
    Object.entries(j ?? {})
      .map(([code, c]) => ({ code, name: c.name, country: c.country, pop: c.pop ?? 0, f: fold(c.name) }))
      .sort((a, b) => b.pop - a.pop),
  );
  return cache.cities;
}
function townsList(): Promise<TownRow[]> {
  cache.towns ??= loadJson<[string, number, number, string, number][]>("towns.json").then((j) => (j ?? []).map(([name, , , country, pop]) => ({ name, country, pop, f: fold(name) })));
  return cache.towns;
}
function countriesList(): Promise<CountryRow[]> {
  cache.countries ??= loadJson<Record<string, { name?: string }>>("countries.json").then((j) =>
    Object.entries(j ?? {}).map(([code, c]) => {
      const name = c.name || countryName(code);
      return { code, name, f: fold(name) };
    }),
  );
  return cache.countries;
}

type Hit = { key: string; label: string; sub: string; to: SearchQuery["to"] };

/** Names people type for a country that are not its name in countries.json. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US",
  us: "US",
  america: "US",
  "united states of america": "US",
  uk: "GB",
  britain: "GB",
  "great britain": "GB",
  england: "GB",
  czechia: "CZ",
  holland: "NL",
  "the netherlands": "NL",
  turkey: "TR",
  uae: "AE",
  korea: "KR",
};

/** What a typed To turns into on Search: a To to run, or what to tell the traveller. */
export type ToResolved = { to: SearchQuery["to"] } | { problem: string };

const ANYWHERE: Hit = { key: "anywhere", label: "Anywhere", sub: "The cheapest places first", to: { kind: "anywhere" } };

/** A name matches when it starts with what was typed, or a later word does ("lumpur" finds Kuala Lumpur). */
const matches = (f: string, q: string) => f.startsWith(q) || f.includes(` ${q}`) || f.includes(`-${q}`);

function ToField({ value, onChange, resolver }: { value: SearchQuery["to"]; onChange: (to: SearchQuery["to"]) => void; resolver: { current: (() => Promise<ToResolved>) | null } }) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  /** The place name typed by hand and not yet picked from the list; null once it is settled. */
  const looseName = useRef<string | null>(null);
  const listId = `${id}-list`;
  const [text, setText] = useState(value.kind === "anywhere" ? "" : toLabel(value));
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [lists, setLists] = useState<{ cities: CityRow[]; countries: CountryRow[]; towns: TownRow[] }>({ cities: [], countries: [], towns: [] });
  const wantTowns = useRef(false);

  // The field follows the query when someone else sets it (the chat, the command line, a suggestion).
  useEffect(() => {
    const label = value.kind === "anywhere" ? "" : toLabel(value);
    setText((t) => (fold(t) === fold(label) ? t : label));
    // A To set from elsewhere (a pick, the chat, a link) is settled; only our own typing is loose.
    if (value.kind !== "place" || value.name !== looseName.current) looseName.current = null;
  }, [value]);

  const ensureLists = () => {
    if (lists.cities.length) return;
    void Promise.all([citiesList(), countriesList()]).then(([cities, countries]) => setLists((l) => ({ ...l, cities, countries })));
  };

  const q = fold(text);
  const hits = useMemo<Hit[]>(() => {
    const regions = WILD_REGIONS.map((r) => ({ key: `r:${r.key}`, label: r.label, sub: "Region", to: { kind: "region", key: r.key } as const, f: fold(r.label) }));
    if (!q) return [ANYWHERE, ...regions.slice(0, 5)];
    const out: Hit[] = [];
    if ("anywhere".startsWith(q) || "everywhere".startsWith(q)) out.push(ANYWHERE);
    for (const r of regions) if (matches(r.f, q)) out.push(r);
    for (const c of lists.countries) if (matches(c.f, q) && out.length < 6) out.push({ key: `c:${c.code}`, label: c.name, sub: "Country", to: { kind: "country", name: c.name, code: c.code } });
    const cityHits = lists.cities.filter((c) => matches(c.f, q)).slice(0, 6);
    for (const c of cityHits) out.push({ key: `p:${c.code}`, label: c.name, sub: `City, ${countryName(c.country)}`, to: { kind: "place", name: c.name } });
    if (q.length >= 3 && cityHits.length < 3) {
      const seen = new Set(cityHits.map((c) => c.f));
      for (const t of lists.towns) {
        if (out.length >= 10) break;
        if (matches(t.f, q) && !seen.has(t.f)) {
          seen.add(t.f);
          out.push({ key: `t:${t.name}:${t.country}`, label: t.name, sub: `Town, ${countryName(t.country)}`, to: { kind: "place", name: t.name } });
        }
      }
    }
    return out.slice(0, 10);
  }, [q, lists]);

  // Towns load once a typed name finds few cities: most searches never need the big file.
  useEffect(() => {
    if (q.length < 3 || wantTowns.current || !lists.cities.length) return;
    if (lists.cities.filter((c) => matches(c.f, q)).length >= 3) return;
    wantTowns.current = true;
    void townsList().then((towns) => setLists((l) => ({ ...l, towns })));
  }, [q, lists.cities]);

  useEffect(() => setCursor(0), [q]);

  /**
   * Text typed and never picked is checked on Search, once the lists have loaded: an exact
   * country name (or a common alias such as USA or UK) becomes the country, an exact city or
   * town name stays a place, and partial text becomes the one thing it matches. Anything else
   * asks for a pick, so "pol" never runs as a place called "pol" and comes back empty.
   */
  const resolve = async (): Promise<ToResolved> => {
    const loose = looseName.current;
    if (value.kind !== "place" || loose === null || loose !== value.name) return { to: value };
    const [cities, countries] = await Promise.all([citiesList(), countriesList()]);
    const f = fold(loose);
    const alias = COUNTRY_ALIASES[f];
    const country = countries.find((c) => c.f === f || (alias && c.code === alias));
    if (country) return { to: { kind: "country", name: country.name, code: country.code } };
    if (cities.some((c) => c.f === f)) return { to: value };
    const towns = await townsList();
    if (towns.some((t) => t.f === f)) return { to: value };
    const regionHits = WILD_REGIONS.filter((r) => matches(fold(r.label), f));
    const countryHits = countries.filter((c) => matches(c.f, f));
    const cityHits = cities.filter((c) => matches(c.f, f));
    const townHits = cityHits.length ? [] : towns.filter((t) => matches(t.f, f)).slice(0, 2);
    const only: SearchQuery["to"][] = [
      ...regionHits.map((r) => ({ kind: "region", key: r.key }) as const),
      ...countryHits.map((c) => ({ kind: "country", name: c.name, code: c.code }) as const),
      ...cityHits.slice(0, 2).map((c) => ({ kind: "place", name: c.name }) as const),
      ...townHits.map((t) => ({ kind: "place", name: t.name }) as const),
    ];
    if (only.length === 1) return { to: only[0] };
    setOpen(true);
    inputRef.current?.focus();
    return { problem: only.length ? "Pick a place from the list." : `Nothing called "${loose.trim()}". Pick a place from the list, or Anywhere.` };
  };
  // The bar asks through this on Search; refreshed every render so it sees the current value.
  useEffect(() => {
    resolver.current = resolve;
  });

  const pick = (h: Hit) => {
    looseName.current = null;
    onChange(h.to);
    setText(h.to.kind === "anywhere" ? "" : h.label);
    setOpen(false);
  };
  /**
   * Typed text counts at once, not on blur, so pressing Search straight after typing searches
   * what is in the box. A name that is exactly a region or a country is read as one; any
   * other text is a place, which the engines resolve by name.
   */
  const typed = (raw: string) => {
    setText(raw);
    const t = raw.trim();
    const f = fold(t);
    if (!t || f === "anywhere" || f === "everywhere") return onChange({ kind: "anywhere" });
    const region = WILD_REGIONS.find((r) => fold(r.label) === f || r.key === f);
    if (region) return onChange({ kind: "region", key: region.key });
    const country = lists.countries.find((c) => c.f === f);
    if (country) return onChange({ kind: "country", name: country.name, code: country.code });
    looseName.current = t;
    onChange({ kind: "place", name: t });
  };

  const showList = open && hits.length > 0;
  return (
    <div className={s.field}>
      <label className={s.fieldLabel} htmlFor={`${id}-in`}>
        To
      </label>
      <div className={s.combo}>
        <input
          ref={inputRef}
          id={`${id}-in`}
          className={s.input}
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${id}-o${cursor}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Anywhere"
          value={text}
          onChange={(e) => {
            typed(e.target.value);
            setOpen(true);
            ensureLists();
          }}
          onFocus={() => {
            setOpen(true);
            ensureLists();
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if (e.key === "Enter" && showList && hits[cursor]) {
              e.preventDefault();
              pick(hits[cursor]);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              setOpen(false);
            }
          }}
        />
        {text && (
          <button
            type="button"
            className={s.clearBtn}
            aria-label="Clear, search anywhere"
            onClick={() => {
              setText("");
              onChange({ kind: "anywhere" });
            }}
          >
            ×
          </button>
        )}
        {showList && (
          <ul className={s.options} id={listId} role="listbox" aria-label="Where to">
            {hits.map((h, i) => (
              <li
                key={h.key}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={i === cursor}
                className={`${s.option} ${i === cursor ? s.optionOn : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(h)}
              >
                <span>{h.label}</span>
                <small>{h.sub}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A small minus and plus around a number, for nights; touch friendly and keyboard reachable. */
function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <span className={s.stepper} role="group" aria-label={label}>
      <button type="button" aria-label={`${label}, fewer`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label={`${label}, more`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))}>
        +
      </button>
    </span>
  );
}

/** Switching the When kind keeps what it can: a window's start becomes the day out, and so on. */
function switchWhen(q: SearchQuery, kind: WhenKind): SearchQuery["when"] {
  const w = q.when;
  const start = w.kind === "dates" ? w.out : w.kind === "window" ? w.from : addDays(todayIso(), 14);
  switch (kind) {
    case "dates":
      return { kind: "dates", out: start, back: q.oneWay ? undefined : addDays(start, (q.nights ?? DEFAULT_NIGHTS)[0]) };
    case "window":
      return { kind: "window", from: start, to: addDays(start, 10) };
    case "month":
      return { kind: "month", month: start.slice(0, 7) < todayIso().slice(0, 7) ? todayIso().slice(0, 7) : start.slice(0, 7) };
    case "anytime":
      return { kind: "anytime" };
  }
}

export default function SearchBar({ value: q, onChange, onSubmit, waiting, busy, collapsed, onExpand }: Props) {
  const id = useId();
  const months = useMemo(monthOptions, []);
  const [include, setInclude] = useState(q.when.kind === "window" && !!q.when.include);
  /** What the typed To needs (a pick from the list), shown until To changes. */
  const [toProblem, setToProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const resolver = useRef<(() => Promise<ToResolved>) | null>(null);
  const problem = queryProblem(q);
  const today = todayIso();
  const set = (patch: Partial<SearchQuery>) => onChange({ ...q, ...patch });
  // New nights; with the wild loop on, its nights follow the bar's most (one number for the trip, never two).
  const setNights = (n: [number, number]) => {
    const wild = q.advanced?.wild;
    set(wild ? { nights: n, advanced: { ...q.advanced, wild: { ...wild, nights: Math.max(WILD_NIGHTS.min, n[1]) } } } : { nights: n });
  };
  const nights = q.nights ?? DEFAULT_NIGHTS;

  if (collapsed) {
    return (
      <button type="button" className={s.summary} onClick={onExpand} aria-label={`Change the search: ${describeQuery(q)}`}>
        <span className={s.summaryIcon} aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24">
            <path fill="currentColor" d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
          </svg>
        </span>
        <span className={s.summaryText}>
          <b>
            {q.from.label || "Your place"} to {toLabel(q.to)}
          </b>
          <span>{[whenLabel(q.when), nightsWords(q)].filter(Boolean).join(", ")}</span>
        </span>
        <span className={s.summaryEdit}>Change</span>
      </button>
    );
  }

  const w = q.when;
  return (
    <form
      className={s.bar}
      aria-label="Search trips"
      onSubmit={async (e) => {
        e.preventDefault();
        if (problem || waiting || checking) return;
        setChecking(true);
        let r: ToResolved;
        try {
          r = resolver.current ? await resolver.current() : { to: q.to };
        } finally {
          setChecking(false);
        }
        if ("problem" in r) return setToProblem(r.problem);
        if (r.to === q.to) return onSubmit();
        const next = withTo(q, r.to);
        onChange(next);
        onSubmit(next);
      }}
    >
      <div className={s.field}>
        <span className={s.fieldLabel} id={`${id}-from`}>
          From
        </span>
        <div className={s.fromBox} aria-labelledby={`${id}-from`} title="Change your place in the top bar">
          <span className={s.fromPlace}>{q.from.label || "Finding your place"}</span>
          <span className={s.fromAirports}>{q.from.airports.length ? q.from.airports.slice(0, 5).join(" · ") : "airports loading"}</span>
        </div>
      </div>

      <ToField
        value={q.to}
        resolver={resolver}
        onChange={(to) => {
          setToProblem(null);
          onChange(withTo(q, to));
        }}
      />

      <div className={s.field}>
        <span className={s.fieldLabel} id={`${id}-when`}>
          When
        </span>
        <div className={s.segment} role="radiogroup" aria-labelledby={`${id}-when`}>
          {WHEN_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={w.kind === t.key}
              className={`${s.segBtn} ${w.kind === t.key ? s.segOn : ""}`}
              onClick={() => w.kind !== t.key && set({ when: switchWhen(q, t.key) })}
            >
              {t.label}
            </button>
          ))}
        </div>
        {w.kind === "dates" && (
          <div className={s.row}>
            <label className={s.dateField}>
              <span>Out</span>
              <input type="date" className={s.input} min={today} value={w.out} onChange={(e) => set({ when: { ...w, out: e.target.value } })} />
            </label>
            {!q.oneWay && (
              <label className={s.dateField}>
                <span>Back</span>
                <input type="date" className={s.input} min={w.out || today} value={w.back ?? ""} onChange={(e) => set({ when: { ...w, back: e.target.value || undefined } })} />
              </label>
            )}
          </div>
        )}
        {w.kind === "window" && (
          <>
            <div className={s.row}>
              <label className={s.dateField}>
                <span>Leave from</span>
                <input type="date" className={s.input} min={today} value={w.from} onChange={(e) => set({ when: { ...w, from: e.target.value } })} />
              </label>
              <label className={s.dateField}>
                <span>to</span>
                <input type="date" className={s.input} min={w.from || today} value={w.to} onChange={(e) => set({ when: { ...w, to: e.target.value } })} />
              </label>
            </div>
            {include ? (
              <div className={s.row}>
                <label className={s.dateField}>
                  <span>Must include</span>
                  <input type="date" className={s.input} min={w.from} max={w.to} value={w.include ?? ""} onChange={(e) => set({ when: { ...w, include: e.target.value || undefined } })} />
                </label>
                <button
                  type="button"
                  className={s.linkBtn}
                  onClick={() => {
                    setInclude(false);
                    set({ when: { ...w, include: undefined } });
                  }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <button type="button" className={s.linkBtn} onClick={() => setInclude(true)}>
                + A day the trip must include
              </button>
            )}
          </>
        )}
        {w.kind === "month" && (
          <div className={s.chips} role="radiogroup" aria-label="Month">
            {months.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={w.month === m} className={`${s.chip} ${w.month === m ? s.chipOn : ""}`} onClick={() => set({ when: { kind: "month", month: m } })}>
                {monthLabel(m)}
              </button>
            ))}
          </div>
        )}
        {w.kind === "anytime" && <p className={s.hint}>The cheapest dates in the next six months.</p>}
      </div>

      <div className={s.nightsRow}>
        {!q.oneWay && !(w.kind === "dates" && w.back) && (
          <div className={s.nights}>
            <span className={s.fieldLabel}>Nights</span>
            <Stepper label="Fewest nights" value={nights[0]} min={NIGHTS_MIN} max={NIGHTS_MAX} onChange={(n) => setNights([n, Math.max(n, nights[1])])} />
            <span className={s.to}>to</span>
            <Stepper label="Most nights" value={nights[1]} min={NIGHTS_MIN} max={NIGHTS_MAX} onChange={(n) => setNights([Math.min(n, nights[0]), n])} />
          </div>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={!!q.oneWay}
          className={`${s.chip} ${q.oneWay ? s.chipOn : ""}`}
          onClick={() => {
            const oneWay = !q.oneWay;
            // One way drops the day back; a return gets one back from the nights.
            const when = w.kind === "dates" ? { ...w, back: oneWay ? undefined : addDays(w.out, nights[0]) } : w;
            set({ oneWay: oneWay || undefined, when });
          }}
        >
          One way
        </button>
      </div>

      {(problem || toProblem) && (
        <p className={s.problem} role="status">
          {problem ?? toProblem}
        </p>
      )}
      <button type="submit" className={s.go} disabled={!!problem || waiting}>
        {waiting ? "Finding your airports" : busy ? "Search again" : "Search"}
      </button>
    </form>
  );
}
