"use client";

import type { WalkLeg, WalkLoop } from "@/lib/graph-walk";
import { dateRange, euro } from "@/lib/format";
import type { WalkState } from "@/lib/ui-types";

// The graph walk's card on the map, floating with the route card (never over the panel): what
// the walk is doing as it does it (its progress lines), the loops it closed as rows (the route
// with a plane, train or coach between the cities, the total, the nights, why), and the two
// things to do next: make an itinerary of the loop on show, or search again with a bigger
// budget of live searches. The globe draws the same walk (see Globe.tsx, atlas:walk).

/** The budget "Search again with more budget" asks for: enough live searches for a second look from every stop. */
export const WALK_MORE_BUDGET = 20;

const PATHS: Record<WalkLeg["kind"], string> = {
  // A plane seen from above, pointing right.
  fly: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z",
  // A train front: body, windows, wheels.
  train: "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2h3.6l2 2H18v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-4-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3.5-7H6V6h5v4zm2 0V6h5v4h-5zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  // A coach front.
  coach: "M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4s-8 .5-8 4v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm1.5-6H6V6h12v5z",
  // A boat on a wave.
  ferry: "M20 21c-1.4 0-2.8-.5-4-1.3a7 7 0 0 1-8 0A7 7 0 0 1 4 21H2v2h2a8.7 8.7 0 0 0 4-1 8.8 8.8 0 0 0 8 0 8.7 8.7 0 0 0 4 1h2v-2h-2zM3.9 19H4c1.6 0 3-.9 4-2 1 1.1 2.4 2 4 2s3-.9 4-2c1 1.1 2.4 2 4 2h.1l1.9-6.7a1 1 0 0 0-.7-1.2L20 10.6V6a2 2 0 0 0-2-2h-3V1H9v3H6a2 2 0 0 0-2 2v4.6l-1.3.5a1 1 0 0 0-.7 1.2L3.9 19zM6 6h12v4l-6-2-6 2V6z",
  // A car, for the drive to and from the airport.
  road: "M18.9 6c-.2-.6-.8-1-1.4-1h-11c-.7 0-1.2.4-1.4 1L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8l-2.1-6zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11H5z",
};
const WORD: Record<WalkLeg["kind"], string> = { fly: "plane", train: "train", coach: "coach", ferry: "ferry", road: "drive" };

/** A small icon for a leg's kind: plane, train, coach, ferry or car. */
export function LegIcon({ kind }: { kind: WalkLeg["kind"] }) {
  return (
    <svg className={`legicon ${kind}`} viewBox="0 0 24 24" width="13" height="13" role="img" aria-label={WORD[kind]}>
      <path d={PATHS[kind]} fill="currentColor" />
    </svg>
  );
}

/** The loop as a line: Brasov, plane, Warsaw, train, Gdansk, plane, home. The drive to the airport is a small car. */
export function WalkRouteLine({ loop, homeLabel }: { loop: WalkLoop; homeLabel: string }) {
  const first = loop.legs[0];
  const start = !first || first.from === "HOME" ? homeLabel : first.fromName;
  return (
    <span className="walkline">
      <span>{start}</span>
      {loop.legs.map((l, i) => (
        <span key={i} className={`walkhop ${l.kind}`}>
          <LegIcon kind={l.kind} />
          <span>{l.to === "HOME" ? "home" : l.toName}</span>
        </span>
      ))}
    </span>
  );
}

/** The loops as rows, best first; the one on the globe is lit and shows its reasons. */
export function WalkLoopList({ loops, selected, onSelect, homeLabel }: { loops: WalkLoop[]; selected: number; onSelect: (i: number) => void; homeLabel: string }) {
  return (
    <div className="walkloops">
      {loops.map((l, i) => (
        <button key={l.id} className={`walkloop${i === selected ? " on" : ""}`} onClick={() => onSelect(i)} aria-pressed={i === selected}>
          <span className="walkloophead">
            <span className="walktotal">{euro(l.total)}</span>
            <WalkRouteLine loop={l} homeLabel={homeLabel} />
          </span>
          <span className="sub">
            {l.nights} nights · {dateRange(l.start, l.end)} · flights {euro(l.flights)}
            {l.ground ? `, by land about ${euro(l.ground)}` : ""}
          </span>
          {i === selected && l.why.length > 0 && (
            <ul className="walkwhy">
              {l.why.slice(0, 6).map((w, k) => (
                <li key={k}>{w}</li>
              ))}
            </ul>
          )}
        </button>
      ))}
    </div>
  );
}

type Props = {
  walk: WalkState;
  homeLabel: string;
  onSelect: (i: number) => void;
  /** Make an itinerary of a loop; absent while lib/itinerary.ts has no converter for a walk. */
  onItinerary?: (i: number) => void;
  onMoreBudget: () => void;
  onCancel: () => void;
  onClose: () => void;
  onCollapse: (c: boolean) => void;
};

export default function WalkCard({ walk, homeLabel, onSelect, onItinerary, onMoreBudget, onCancel, onClose, onCollapse }: Props) {
  const q = walk.params ?? {};
  const loading = walk.status === "loading";
  const label = String(q.label ?? homeLabel);
  const budget = Number(q.budget ?? 12);
  const r = walk.result;
  // The loops are ranked by the walk's score (money, hours and what a place is worth), so the cheapest is not always first.
  const cheapest = walk.loops.length ? Math.min(...walk.loops.map((l) => l.total)) : 0;
  const minN = q.minNights != null ? Number(q.minNights) : null;
  const maxN = q.maxNights != null ? Number(q.maxNights) : null;
  const nights = minN && maxN && minN !== maxN ? `${minN} to ${maxN} nights` : minN || maxN ? `${minN ?? maxN} nights` : "";
  const span = q.from && q.to ? dateRange(String(q.from), String(q.to)) : "";
  const lines = walk.lines.slice(-4);
  return (
    <section className={`mapcard walkcard${walk.collapsed ? " collapsed" : ""}`} aria-label="Loops found the way you would search by hand">
      <header className="mapcardhead">
        <button className="mapcardtitle" onClick={() => onCollapse(!walk.collapsed)} title={walk.collapsed ? "Open the card" : "Fold the card"}>
          <span className="kicker">Cheapest loops</span>
          <b>From {label}</b>
          <small>
            {[span, nights].filter(Boolean).join(" · ")}
            {walk.loops.length ? ` · ${walk.loops.length} loop${walk.loops.length === 1 ? "" : "s"} from ${euro(cheapest)}` : ""}
          </small>
        </button>
        <button className="iconbtn" onClick={() => onCollapse(!walk.collapsed)} title={walk.collapsed ? "Open" : "Fold"}>
          {walk.collapsed ? "▴" : "▾"}
        </button>
        <button className="iconbtn" onClick={onClose} title="Close and clear the walk from the globe">
          ×
        </button>
      </header>
      {loading && <div className="mapcardbar" aria-hidden="true" />}
      {!walk.collapsed && (
        <div className="mapcardbody">
          {(loading || (lines.length > 0 && !walk.loops.length)) && (
            <div className="answer compact walklines" aria-live="polite">
              {lines.length === 0 && <p className="muted">Asking where the cheap flights go from your airports…</p>}
              {lines.map((l, i) => (
                <p key={walk.lines.length - lines.length + i} className={i === lines.length - 1 ? "" : "muted"}>
                  {l}
                </p>
              ))}
            </div>
          )}
          {walk.status === "error" && <div className="status">{walk.note ?? "The walk failed."}</div>}
          {walk.loops.length > 0 && <WalkLoopList loops={walk.loops} selected={walk.selected} onSelect={onSelect} homeLabel={label} />}
          {walk.status === "ok" && !walk.loops.length && <div className="status">{r?.note ?? "No loop closed inside these dates. Try more nights, another window, or more budget."}</div>}
          {r && (
            <div className="status small muted">
              {r.searched} live search{r.searched === 1 ? "" : "es"}, {r.fromMemory} from the fare memory, {r.expanded} cit{r.expanded === 1 ? "y" : "ies"} explored.
              {r.partial ? " Cut short, so this is what was found so far." : ""}
              {r.note && walk.loops.length ? ` ${r.note}` : ""} Flights are one-way fares as found; train and coach prices are estimates.
            </div>
          )}
          <div className="chips">
            {loading ? (
              <button className="chip ghost" onClick={onCancel}>
                Stop
              </button>
            ) : (
              <>
                <button className="chip on" disabled={!walk.loops.length || !onItinerary} onClick={() => onItinerary?.(walk.selected)} title={onItinerary ? "A day by day plan of the loop on the globe" : "Itineraries from a walk are not wired yet (skeletonFromWalk in lib/itinerary.ts)"}>
                  Make an itinerary
                </button>
                <button className="chip ghost" disabled={budget >= WALK_MORE_BUDGET} onClick={onMoreBudget} title={budget >= WALK_MORE_BUDGET ? "This walk already had the larger budget" : `Up to ${WALK_MORE_BUDGET} live searches instead of ${budget}`}>
                  Search again with more budget
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
