"use client";

import { doorPrice, type TripLeg, type TripResult } from "@/lib/trip-result";
import { dateRange, euro, hoursLabel, kiwiPhoto, shortDate } from "@/lib/format";
import s from "./search.module.css";

// One trip card for every engine: the one search's list, the globe's selected trip and the
// chat (compact) all render the same card, so a trip looks the same wherever it shows up.
// The whole card is one button: tapping anywhere opens the trip page, hovering or focusing
// it tells the globe which route to draw bold.

type Props = {
  trip: TripResult;
  active?: boolean;
  onOpen: (t: TripResult) => void;
  onHover?: (t: TripResult | null) => void;
  compact?: boolean;
};

// Material-style glyphs, drawn inline so the route line needs no icon font and no emoji
// (emoji render differently on every phone and break the line's rhythm).
const PATHS: Record<TripLeg["kind"], string> = {
  fly: "M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z",
  train:
    "M12 2c-4 0-8 .5-8 4v9.5A3.5 3.5 0 0 0 7.5 19L6 20.5v.5h2.2l2-2H14l2 2h2v-.5L16.5 19a3.5 3.5 0 0 0 3.5-3.5V6c0-3.5-3.6-4-8-4zM7.5 17a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3.5-7H6V6h5zm2 0V6h5v4zm3.5 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  coach:
    "M4 16c0 .9.4 1.7 1 2.2V20a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h8v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4S4 2.5 4 6zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12z",
  ferry:
    "M20 21c-1.4 0-2.8-.5-4-1.3a7 7 0 0 1-8 0c-1.2.8-2.6 1.3-4 1.3H2v2h2c1.4 0 2.7-.4 4-1a8.8 8.8 0 0 0 8 0c1.3.6 2.6 1 4 1h2v-2zM4 19c1.6 0 3-.9 4-2 1 1.1 2.4 2 4 2s3-.9 4-2c1 1.1 2.4 2 4 2l1.9-6.7a1 1 0 0 0-.7-1.3L20 10.6V6c0-1.1-.9-2-2-2h-3V1H9v3H6c-1.1 0-2 .9-2 2v4.6l-1.3.4a1 1 0 0 0-.7 1.3zM6 6h12v4L12 8l-6 2z",
  road: "M18.9 6c-.2-.6-.7-1-1.4-1h-11c-.7 0-1.2.4-1.4 1L3 12v8a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h12v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-8zM6.5 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm11 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM5 11l1.5-4.5h11L19 11z",
  walk: "M13.5 5.5a2 2 0 1 0-2-2 2 2 0 0 0 2 2zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2 2 0 0 0-1.7-1c-.3 0-.5.1-.8.2L6 8.3V13h2V9.6z",
};
const LEG_WORD: Record<TripLeg["kind"], string> = { fly: "fly", train: "train", coach: "coach", ferry: "ferry", road: "by road", walk: "walk" };

/** The glyph of one way of travelling; shared with the trip page and the chat. */
export function LegIcon({ kind, size = 14 }: { kind: TripLeg["kind"]; size?: number }) {
  return (
    <svg className={s.legIcon} data-kind={kind} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[kind] ?? PATHS.road} fill="currentColor" />
    </svg>
  );
}

const NUMBER_WORDS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "two tickets" when the trip is booked in parts; nothing for one ticket. */
export function ticketsLabel(t: TripResult): string | null {
  const n = new Set(t.urls.filter(Boolean)).size;
  if (n < 2) return null;
  return `${NUMBER_WORDS[n] ?? n} tickets`;
}

/** A photo for the first stop: a full URL as given, or a Kiwi image id. */
function stopPhoto(t: TripResult): string | null {
  const img = t.stops.find((x) => x.img)?.img;
  if (!img) return null;
  return /^https?:\/\//.test(img) ? img : kiwiPhoto(img, "300x300");
}

type Hop = { kind: TripLeg["kind"]; to: string };

/**
 * The route as a line of places joined by how you get between them. A flight with a layover
 * is one leg, so this reads like the traveller would say it: "Brasov, fly Warsaw, train
 * Gdansk, fly Bucharest". Long loops keep the first and last two places and count the middle,
 * so a 16-stop wild loop still fits on two lines of a phone.
 */
function routeLine(t: TripResult, compact: boolean): { start: string; hops: Hop[]; hidden: number } {
  const start = t.legs[0]?.fromName ?? t.stops[0]?.name ?? "";
  // A leg that ends where it started by name (the drive from Brasov to Brasov's airport) says
  // nothing on the line, so it is left out; the trip page still lists it.
  const hops: Hop[] = [];
  let at = start.toLowerCase();
  for (const l of t.legs) {
    const to = l.toName.toLowerCase();
    if (to === at && (l.kind === "road" || l.kind === "walk")) continue;
    hops.push({ kind: l.kind, to: l.toName });
    at = to;
  }
  const limit = compact ? 4 : 7;
  if (hops.length <= limit) return { start, hops, hidden: 0 };
  const keepHead = Math.ceil((limit - 1) / 2);
  const keepTail = limit - 1 - keepHead;
  return { start, hops: [...hops.slice(0, keepHead), ...hops.slice(hops.length - keepTail)], hidden: hops.length - keepHead - keepTail };
}

/**
 * A group trip's legs are each person's way there and back, not one route, so the card shows
 * one line per person travelling ("Ana from CLJ, fly Lisbon") and how many meet. The way
 * back is on the same ticket and says nothing new on a card.
 */
function groupLines(t: TripResult): { people: number; lines: { from: string; kind: TripLeg["kind"]; to: string }[] } {
  const meet = t.stops[0];
  const matched = t.legs.filter((l) => !!meet && (l.toName === meet.name || (!!meet.code && l.to === meet.code)));
  // The group engine writes each person's way there before their way back, so every other leg is a way there.
  const there = matched.length ? matched : t.legs.filter((_, i) => i % 2 === 0);
  const members = (t.raw as { perMember?: unknown[] } | undefined)?.perMember;
  return { people: Array.isArray(members) ? members.length : there.length, lines: there.map((l) => ({ from: l.fromName, kind: l.kind, to: l.toName })) };
}

function datesLabel(t: TripResult): string {
  if (!t.out) return "";
  if (t.back && t.back !== t.out) return dateRange(t.out, t.back);
  return t.back ? shortDate(t.out) : `${shortDate(t.out)}, one way`;
}

/** Nights per place, only the places you sleep in: "Warsaw 3, Gdansk 2". */
function nightsPerPlace(t: TripResult): string {
  const sleeps = t.stops.filter((x) => x.nights > 0);
  if (sleeps.length < 2) return "";
  return sleeps.map((x) => `${x.name} ${x.nights}`).join(", ");
}

const SOURCE_WORD: Partial<Record<TripResult["source"], string>> = {
  graph: "price from the nightly graph",
  memory: "price seen recently",
  boards: "price from tonight's board",
  estimate: "estimated price",
};

/** Known engine badges get a colour; anything else shows plain. */
function badgeTone(b: string): string {
  const k = b.toLowerCase();
  if (k.includes("direct")) return s.toneMint;
  if (k.includes("event")) return s.toneAmber;
  if (k.includes("new")) return s.toneSky;
  if (k.includes("gem")) return s.toneRose;
  return "";
}

export default function TripCard({ trip: t, active, onOpen, onHover, compact }: Props) {
  const group = t.kind === "group" ? groupLines(t) : null;
  const line = routeLine(t, !!compact);
  const tickets = ticketsLabel(t);
  const perPlace = compact ? "" : nightsPerPlace(t);
  const photo = compact ? null : stopPhoto(t);
  const badges = [...t.badges];
  if (t.direct && !badges.some((b) => b.toLowerCase().includes("direct"))) badges.unshift("direct");
  const sourceNote = SOURCE_WORD[t.source];
  const facts = [datesLabel(t), t.nights > 0 ? `${t.nights} night${t.nights === 1 ? "" : "s"}` : "", t.hours ? `${hoursLabel(t.hours)} travelling` : ""].filter(Boolean);
  // Read aloud as one sentence; the visible card is a layout of the same facts.
  const spoken = `${t.title}, ${euro(doorPrice(t))} door to door${t.groundPrice ? `, ${euro(t.price)} in tickets and about ${euro(t.groundPrice)} on the ground` : ""}. ${facts.join(", ")}.${tickets ? ` ${tickets}.` : ""}`;

  return (
    <button
      type="button"
      className={`${s.card} ${active ? s.cardActive : ""} ${compact ? s.cardCompact : ""}`}
      aria-current={active ? "true" : undefined}
      aria-label={spoken}
      onClick={() => onOpen(t)}
      onMouseEnter={onHover ? () => onHover(t) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      onFocus={onHover ? () => onHover(t) : undefined}
      onBlur={onHover ? () => onHover(null) : undefined}
    >
      {photo && (
        <span className={s.cardPhoto} aria-hidden="true">
          {/* eslint-disable-next-line @next/next/no-img-element -- a remote thumbnail, sized by CSS; next/image would need every photo host configured */}
          <img src={photo} alt="" loading="lazy" decoding="async" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = "none")} />
        </span>
      )}
      <span className={s.cardBody} aria-hidden="true">
        <span className={s.cardTop}>
          <span className={s.cardTitle}>{t.title}</span>
          <span className={s.cardPrice}>
            {euro(doorPrice(t))}
            {t.groundPrice ? <small className={s.cardGround}>{euro(t.price)} tickets + about {euro(t.groundPrice)} ground</small> : null}
          </span>
        </span>
        {group ? (
          <span className={s.routeGroup}>
            {group.people > 1 && <span className={s.routeGroupCount}>{group.people} people meet here</span>}
            {group.lines.slice(0, compact ? 3 : 8).map((g, i) => (
              <span key={i} className={s.route}>
                <span className={s.routePlace}>{g.from}</span>
                <span className={s.routeHop}>
                  <span className={s.routeMode} title={LEG_WORD[g.kind]}>
                    <LegIcon kind={g.kind} />
                  </span>
                  <span className={s.routePlace}>{g.to}</span>
                </span>
              </span>
            ))}
          </span>
        ) : (
          <span className={s.route}>
            <span className={s.routePlace}>{line.start}</span>
            {line.hops.map((h, i) => (
              <span key={i} className={s.routeHop}>
                {line.hidden > 0 && i === Math.ceil(line.hops.length / 2) && <span className={s.routeMore}>+{line.hidden} more</span>}
                <span className={s.routeMode} title={LEG_WORD[h.kind]}>
                  <LegIcon kind={h.kind} />
                </span>
                <span className={s.routePlace}>{h.to}</span>
              </span>
            ))}
          </span>
        )}
        <span className={s.facts}>{facts.join(" · ")}</span>
        {perPlace && <span className={s.perPlace}>Nights: {perPlace}</span>}
        {(badges.length > 0 || tickets) && (
          <span className={s.badges}>
            {badges.slice(0, compact ? 3 : 5).map((b) => (
              <span key={b} className={`${s.badge} ${badgeTone(b)}`}>
                {b}
              </span>
            ))}
            {tickets && <span className={`${s.badge} ${s.badgeTickets}`}>{tickets}</span>}
          </span>
        )}
        {!compact && t.why[0] && <span className={s.why}>{t.why[0]}</span>}
        {!compact && sourceNote && (
          <span className={s.source}>
            {sourceNote}
            {t.seen ? `, ${shortDate(t.seen)}` : ""}
          </span>
        )}
      </span>
    </button>
  );
}
