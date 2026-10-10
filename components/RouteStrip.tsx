"use client";

import { useEffect, useState } from "react";
import type { WildLeg, WildStop } from "@/lib/wild";
import type { PlaceSummary } from "@/app/api/place/route";
import { formatDuration } from "@/lib/geo";
import { countryName, dateRange, euro, hoursLabel, kiwiPhoto, shortDate, stops as stopsLabel } from "@/lib/format";

// The route of a trip as pictures: the loop as a horizontal strip (home, leg, stop, leg,
// ..., home), the stops as cards, the legs as rows with booking links. Wild trips come in
// their own shape; short loops are converted to it by the panel so one set of components
// draws both.

// A guessed Kiwi slug cannot be trusted: a city Kiwi has no photo for redirects to one
// generic picture that loads fine, the browser hides the redirect from both <img> and a
// no-cors fetch (and refuses redirect: "manual" outside a service worker), so there is no
// way to tell the placeholder from a real photo. Kiwi is therefore used only when the
// caller holds a real Kiwi image id (deals carry one); stops, bases and events start from
// the Wikivoyage thumbnail. One lookup per name per page load, shared by the strip and the cards.
const thumbs = new Map<string, Promise<string | null>>();
function wikivoyageThumb(name: string): Promise<string | null> {
  let p = thumbs.get(name);
  if (!p) {
    p = fetch(`/api/place?name=${encodeURIComponent(name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PlaceSummary | null) => j?.thumbnail ?? null)
      .catch(() => null);
    thumbs.set(name, p);
  }
  return p;
}

/** A city photo: Kiwi's when its image id is known, else the Wikivoyage thumbnail, else a quiet gradient. */
export function StopPhoto({ name, country, img, className }: { name: string; country: string; img?: string; className?: string }) {
  // stage 0: looking the thumbnail up; 1: a photo is showing; 2: the gradient only.
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const [src, setSrc] = useState<string | null>(null);
  // country is part of the key for the day the engine sends a Kiwi slug per stop; today it only disambiguates names.
  useEffect(() => {
    let live = true;
    const kiwi = img ? kiwiPhoto(img) : null;
    if (kiwi) {
      setSrc(kiwi);
      setStage(1);
      return;
    }
    setSrc(null);
    setStage(0);
    wikivoyageThumb(name).then((t) => {
      if (!live) return;
      setSrc(t);
      setStage(t ? 1 : 2);
    });
    return () => {
      live = false;
    };
  }, [name, country, img]);
  return (
    <div className={`stopphoto${className ? ` ${className}` : ""}`} data-stage={stage}>
      {stage === 1 && src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => {
            // A broken Kiwi id falls back to the guide's thumbnail; a broken thumbnail to the gradient.
            if (img && src === kiwiPhoto(img)) wikivoyageThumb(name).then((t) => (t ? setSrc(t) : setStage(2)));
            else setStage(2);
          }}
        />
      )}
    </div>
  );
}

const MODE_WORD: Record<string, string> = { road: "by road", rail: "train", train: "train", coach: "coach", bus: "bus", ferry: "ferry", walk: "walk" };
const modeWord = (m: string) => MODE_WORD[m] ?? m;

function LegPill({ leg }: { leg: WildLeg }) {
  if (leg.kind === "fly") {
    return (
      <a className="legpill fly" href={leg.url} target="_blank" rel="noreferrer" title={`${leg.fromName} to ${leg.toName}, ${shortDate(leg.date)}, ${leg.carriers.join(" + ")}, ${stopsLabel(leg.stops)}`}>
        <span className="glyph" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z" />
          </svg>
        </span>
        <b>{euro(leg.price)}</b>
        <small>{hoursLabel(leg.hours)}</small>
      </a>
    );
  }
  return (
    <span className="legpill ground" title={`${leg.fromName} to ${leg.toName}, ${modeWord(leg.mode)}${leg.estimated ? ", estimated" : ""}`}>
      <span className="glyph" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path fill="currentColor" d="M4 16a2 2 0 0 0 1 1.73V19a1 1 0 0 0 2 0v-1h10v1a1 1 0 0 0 2 0v-1.27A2 2 0 0 0 20 16V6a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3zm3-10h10a1 1 0 0 1 1 1v4H6V7a1 1 0 0 1 1-1zm0 7.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm10 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" />
        </svg>
      </span>
      <b>{formatDuration(leg.minutes)}</b>
      <small>{modeWord(leg.mode)}</small>
    </span>
  );
}

type StripProps = {
  stops: WildStop[];
  legs: WildLeg[];
  homeLabel: string;
  /** The stop the camera is on while the route plays; -1 for home, null when idle. */
  activeIndex?: number | null;
  onStop?: (i: number) => void;
};

/** The loop, left to right: home, a leg pill, a stop with its photo and nights, ..., home. */
export function RouteStrip({ stops, legs, homeLabel, activeIndex, onStop }: StripProps) {
  // Legs and stops are both in travel order, so the strip is the legs in order with each
  // stop placed just before the leg that leaves it; whatever is left trails at the end.
  const items: ({ kind: "stop"; stop: WildStop; i: number } | { kind: "leg"; leg: WildLeg })[] = [];
  let si = 0;
  for (const leg of legs) {
    while (si < stops.length && stops[si].code === leg.from) {
      items.push({ kind: "stop", stop: stops[si], i: si });
      si++;
    }
    items.push({ kind: "leg", leg });
  }
  for (; si < stops.length; si++) items.push({ kind: "stop", stop: stops[si], i: si });
  return (
    <div className="routestrip" role="list">
      <div className={`home${activeIndex === -1 ? " active" : ""}`} role="listitem" title="Home">
        <span className="homedot" />
        <span className="homelabel">{homeLabel}</span>
      </div>
      {items.map((it, k) =>
        it.kind === "leg" ? (
          <LegPill key={`l${k}`} leg={it.leg} />
        ) : (
          <button key={`s${k}`} className={`stripstop${activeIndex === it.i ? " active" : ""}`} role="listitem" onClick={() => onStop?.(it.i)} title={`${it.stop.name}, ${countryName(it.stop.country)}: ${dateRange(it.stop.arrive, it.stop.depart)}`}>
            <StopPhoto name={it.stop.name} country={it.stop.country} className="strip" />
            <span className="num">{it.i + 1}</span>
            <span className="stripname">{it.stop.name}</span>
            <span className="stripnights">{it.stop.nights}n</span>
          </button>
        ),
      )}
      <div className={`home${activeIndex != null && activeIndex >= stops.length ? " active" : ""}`} role="listitem" title="Home">
        <span className="homedot" />
        <span className="homelabel">{homeLabel}</span>
      </div>
    </div>
  );
}

/** Vertical cards, one per stop: photo, number, name, country, nights, dates, budget, visa, note. */
export function StopCards({ stops, activeIndex, onStop }: { stops: WildStop[]; activeIndex?: number | null; onStop?: (i: number) => void }) {
  return (
    <div className="stopcards">
      {stops.map((s, i) => (
        <div key={s.code + s.arrive} className={`stopcard${activeIndex === i ? " active" : ""}`} onClick={() => onStop?.(i)}>
          <StopPhoto name={s.name} country={s.country} />
          <div className="stopbody">
            <div className="stoptop">
              <span className="num">{i + 1}</span>
              <span className="stopname">
                {s.name}
                <span className="sub">{countryName(s.country)}</span>
              </span>
              <span className="stopnights">
                {s.nights}
                <small>night{s.nights === 1 ? "" : "s"}</small>
              </span>
            </div>
            <div className="sub">{dateRange(s.arrive, s.depart)}</div>
            <div className="badges">
              {s.perDay > 0 && <span className="badge heritage">about {euro(s.perDay)} a day</span>}
              {s.visa && <span className="badge direct">{s.visa}</span>}
              {s.warning && <span className="badge warm">partial travel warning</span>}
            </div>
            {s.note && <div className="stopnote">{s.note}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The legs as rows with booking links; ground hops say the mode and the time. */
export function LegRows({ legs }: { legs: WildLeg[] }) {
  return (
    <div className="legrows">
      {legs.map((l, i) =>
        l.kind === "fly" ? (
          <a key={i} className="row" href={l.url} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            <span className="code">{euro(l.price)}</span>
            <span>
              <div className="name">
                {l.fromName} → {l.toName}
              </div>
              <div className="sub">
                {shortDate(l.date)} · {hoursLabel(l.hours)} · {stopsLabel(l.stops)}
                {l.stops && l.route.length > 2 ? ` via ${l.route.slice(1, -1).join(", ")}` : ""}
                {l.carriers.length ? ` · ${l.carriers.join(" + ")}` : ""} · Book ↗
              </div>
            </span>
            <span className="meta">FLY</span>
          </a>
        ) : (
          <div key={i} className="row">
            <span className="code">{l.price ? `~${euro(l.price)}` : formatDuration(l.minutes)}</span>
            <span>
              <div className="name">
                {l.fromName} → {l.toName}
              </div>
              <div className="sub">
                {l.date ? `${shortDate(l.date)} · ` : ""}
                {l.mode === "road" ? "by train, bus or car" : modeWord(l.mode)} · about {formatDuration(l.minutes)}
                {l.estimated ? ", estimated" : ""}
              </div>
            </span>
            <span className="meta">HOP</span>
          </div>
        ),
      )}
    </div>
  );
}

/** The big numbers at the top of a trip: all in, per day, nights, countries. */
export function HeroNumbers({ items }: { items: { value: string; label: string; accent?: boolean }[] }) {
  return (
    <div className="heronums">
      {items.map((it) => (
        <div key={it.label} className={`heronum${it.accent ? " accent" : ""}`}>
          <b>{it.value}</b>
          <small>{it.label}</small>
        </div>
      ))}
    </div>
  );
}
