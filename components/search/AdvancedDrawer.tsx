"use client";

import { useId } from "react";
import type { SearchQuery } from "@/lib/trip-result";
import { LONGSTAY_MONTHS, WILD_NIGHTS, WILD_REGIONS } from "@/lib/ui-types";
import { prefsSummary, type Prefs } from "@/lib/prefs";
import { addDays, todayIso } from "@/lib/format";
import s from "./search.module.css";

// The Advanced drawer under the search bar, closed by default: the trip's shape, a wild loop
// through a far region, a long stay, a group, and a link to the Trip style. Everything here
// lives in the query (shape and advanced), so it rides in the URL and the chat can set it.
// Wild, long stay and group are three different engines, so only one is on at a time:
// turning one on turns the others off, and the drawer says so by showing only one open.

type Props = {
  value: SearchQuery;
  onChange: (q: SearchQuery) => void;
  prefs: Prefs;
  open: boolean;
  onToggle: () => void;
};

type Shape = NonNullable<SearchQuery["shape"]>;
type Advanced = NonNullable<SearchQuery["advanced"]>;
type Member = NonNullable<Advanced["group"]>["members"][number];

const SHAPES: { key: Shape; label: string }[] = [
  { key: "any", label: "Any" },
  { key: "return", label: "Return to one place" },
  { key: "two", label: "Two cities" },
  { key: "loop", label: "A loop of 3+" },
  { key: "long", label: "Long stay" },
];

/** How many advanced choices differ from the plain search, for the toggle's count. */
export function advancedCount(q: SearchQuery): number {
  let n = 0;
  if (q.shape && q.shape !== "any") n += 1;
  if (q.advanced?.wild) n += 1;
  if (q.advanced?.group) n += 1;
  if (q.advanced?.longStay && q.shape !== "long") n += 1;
  return n;
}

/**
 * The group as the engine should get it: empty airports and empty windows dropped. The bar's
 * queryProblem keeps Search off until everyone has airports, so in practice nobody is dropped
 * here; the guard against a group of one stays for queries from links and the chat.
 */
export function cleanGroup(q: SearchQuery): SearchQuery {
  const g = q.advanced?.group;
  if (!g) return q;
  const members = g.members
    .map((m) => ({ name: m.name.trim() || "Someone", origins: m.origins.map((o) => o.trim()).filter(Boolean), available: m.available.filter((a) => a.from && a.to && a.to >= a.from) }))
    .filter((m) => m.origins.length);
  const advanced = { ...q.advanced };
  if (members.length >= 2) advanced.group = { members };
  else delete advanced.group;
  return { ...q, advanced: Object.keys(advanced).length ? advanced : undefined };
}

function withAdvanced(q: SearchQuery, patch: Partial<Advanced>, drop: (keyof Advanced)[] = []): SearchQuery {
  const advanced: Advanced = { ...q.advanced, ...patch };
  for (const k of drop) delete advanced[k];
  for (const k of Object.keys(advanced) as (keyof Advanced)[]) if (advanced[k] === undefined) delete advanced[k];
  return { ...q, advanced: Object.keys(advanced).length ? advanced : undefined };
}

/** The window the query names, for a new group member's free dates. */
function queryWindow(q: SearchQuery): { from: string; to: string } {
  const w = q.when;
  if (w.kind === "dates") return { from: w.out, to: w.back ?? addDays(w.out, 7) };
  if (w.kind === "window") return { from: w.from, to: w.to };
  if (w.kind === "month") return { from: `${w.month}-01`, to: addDays(`${w.month}-01`, 27) };
  const start = addDays(todayIso(), 14);
  return { from: start, to: addDays(start, 14) };
}

function MemberEditor({ m, index, onChange, onRemove, canRemove }: { m: Member; index: number; onChange: (m: Member) => void; onRemove: () => void; canRemove: boolean }) {
  const id = useId();
  return (
    <fieldset className={s.member}>
      <legend className={s.srOnly}>Person {index + 1}</legend>
      <div className={s.row}>
        <label className={s.dateField}>
          <span>Name</span>
          <input className={s.input} value={m.name} placeholder={`Person ${index + 1}`} maxLength={30} onChange={(e) => onChange({ ...m, name: e.target.value })} />
        </label>
        <label className={s.dateField}>
          <span>Airports</span>
          <input
            className={s.input}
            value={m.origins.join(", ")}
            placeholder="OTP, CLJ"
            autoCapitalize="characters"
            spellCheck={false}
            // Kept as typed, empty last entry included, so a comma can be typed; empties are dropped before the search.
            onChange={(e) => onChange({ ...m, origins: e.target.value.split(",").map((x) => x.trim().toUpperCase()) })}
          />
        </label>
      </div>
      <span className={s.fieldLabel} id={`${id}-free`}>
        Free
      </span>
      <div role="group" aria-labelledby={`${id}-free`}>
        {m.available.map((a, i) => (
          <div className={s.row} key={i}>
            <label className={s.dateField}>
              <span className={s.srOnly}>Free from</span>
              <input type="date" className={s.input} value={a.from} onChange={(e) => onChange({ ...m, available: m.available.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })} />
            </label>
            <label className={s.dateField}>
              <span className={s.srOnly}>Free until</span>
              <input type="date" className={s.input} min={a.from} value={a.to} onChange={(e) => onChange({ ...m, available: m.available.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })} />
            </label>
            {m.available.length > 1 && (
              <button type="button" className={s.iconBtn} aria-label={`Remove these dates for ${m.name || `person ${index + 1}`}`} onClick={() => onChange({ ...m, available: m.available.filter((_, j) => j !== i) })}>
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <div className={s.memberActions}>
        <button type="button" className={s.linkBtn} onClick={() => onChange({ ...m, available: [...m.available, m.available[m.available.length - 1] ?? { from: "", to: "" }] })}>
          + Other dates
        </button>
        {canRemove && (
          <button type="button" className={s.linkBtn} onClick={onRemove}>
            Remove {m.name || `person ${index + 1}`}
          </button>
        )}
      </div>
    </fieldset>
  );
}

export default function AdvancedDrawer({ value: q, onChange, prefs, open, onToggle }: Props) {
  const id = useId();
  const shape = q.shape ?? "any";
  const adv = q.advanced ?? {};
  const count = advancedCount(q);

  const setShape = (k: Shape) => {
    // Long stay is a shape and an engine: picking it brings the months, leaving it drops them.
    if (k === "long") onChange({ ...withAdvanced(q, { longStay: adv.longStay ?? { months: 1 } }, ["wild", "group"]), shape: "long" });
    else onChange({ ...withAdvanced(q, {}, ["longStay"]), shape: k === "any" ? undefined : k });
  };
  /**
   * The wild loop and To always name the same region: the server walks advanced.wild.region,
   * so switching the loop on starts from the region already in To, and picking a region here
   * moves To with it. Otherwise the bar could say "to Balkans" while the search walks Asia.
   */
  const wildRegion = (region: string, nights: number): SearchQuery => ({ ...withAdvanced(q, { wild: { region, nights } }, ["longStay", "group"]), to: { kind: "region", key: region } });
  const toggleWild = () => {
    if (adv.wild) return onChange(withAdvanced(q, {}, ["wild"]));
    const fromTo = q.to.kind === "region" ? q.to.key : "";
    const region = WILD_REGIONS.some((r) => r.key === fromTo) ? fromTo : WILD_REGIONS[0].key;
    // The loop starts from the bar's most nights (two weeks when the bar's are shorter than a loop), and the bar follows.
    const n = Math.min(WILD_NIGHTS.max, Math.max(q.nights?.[1] ?? 14, 7));
    onChange({ ...wildRegion(region, n), nights: [Math.min(q.nights?.[0] ?? n, n), n], shape: q.shape === "long" ? undefined : q.shape });
  };
  const toggleGroup = () => {
    if (adv.group) {
      onChange(withAdvanced(q, {}, ["group"]));
      return;
    }
    const win = queryWindow(q);
    const members: Member[] = [
      { name: "You", origins: [...q.from.airports.slice(0, 3)], available: [win] },
      { name: "", origins: [""], available: [win] },
    ];
    onChange({ ...withAdvanced(q, { group: { members } }, ["wild", "longStay"]), shape: q.shape === "long" ? undefined : q.shape });
  };
  const setMembers = (members: Member[]) => onChange(withAdvanced(q, { group: { members } }));

  return (
    <div className={s.advanced}>
      <button type="button" className={s.advToggle} aria-expanded={open} aria-controls={`${id}-drawer`} onClick={onToggle}>
        <span>Advanced</span>
        {count > 0 && <span className={s.advCount}>{count} on</span>}
        <svg className={s.chevron} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z" />
        </svg>
      </button>
      <div className={`${s.drawer} ${open ? s.drawerOpen : ""}`} id={`${id}-drawer`}>
        <div className={s.drawerInner}>
          <section className={s.advSection} aria-labelledby={`${id}-shape`}>
            <h4 id={`${id}-shape`}>Trip shape</h4>
            <div className={s.chips} role="radiogroup" aria-labelledby={`${id}-shape`}>
              {SHAPES.map((x) => (
                <button key={x.key} type="button" role="radio" aria-checked={shape === x.key} className={`${s.chip} ${shape === x.key ? s.chipOn : ""}`} onClick={() => setShape(x.key)}>
                  {x.label}
                </button>
              ))}
            </div>
            {shape === "long" && (
              <div className={s.subRow}>
                <span className={s.fieldLabel} id={`${id}-months`}>
                  Months in one base
                </span>
                <div className={s.chips} role="radiogroup" aria-labelledby={`${id}-months`}>
                  {Array.from({ length: LONGSTAY_MONTHS.max - LONGSTAY_MONTHS.min + 1 }, (_, i) => LONGSTAY_MONTHS.min + i).map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={adv.longStay?.months === m} className={`${s.chip} ${adv.longStay?.months === m ? s.chipOn : ""}`} onClick={() => onChange(withAdvanced(q, { longStay: { months: m } }))}>
                      {m}
                    </button>
                  ))}
                </div>
                <p className={s.hint}>Bases priced all in: flights, rent and living.</p>
                {q.to.kind === "anywhere" && <p className={s.problem}>A long stay needs a place, country or region in To.</p>}
              </div>
            )}
          </section>

          <section className={s.advSection} aria-labelledby={`${id}-wild`}>
            <div className={s.advHead}>
              <h4 id={`${id}-wild`}>Wild loop through a region</h4>
              <button type="button" role="switch" aria-checked={!!adv.wild} aria-labelledby={`${id}-wild`} className={`${s.switch} ${adv.wild ? s.switchOn : ""}`} onClick={toggleWild}>
                <span />
              </button>
            </div>
            {adv.wild ? (
              <div className={s.subRow}>
                <div className={s.chips} role="radiogroup" aria-label="Region">
                  {WILD_REGIONS.map((r) => (
                    <button key={r.key} type="button" role="radio" aria-checked={adv.wild?.region === r.key} className={`${s.chip} ${adv.wild?.region === r.key ? s.chipOn : ""}`} onClick={() => onChange(wildRegion(r.key, adv.wild?.nights ?? 14))}>
                      {r.label}
                    </button>
                  ))}
                </div>
                <label className={s.rangeField}>
                  <span>
                    <b>{adv.wild.nights}</b> nights
                  </span>
                  <input
                    type="range"
                    min={WILD_NIGHTS.min}
                    max={WILD_NIGHTS.max}
                    value={adv.wild.nights}
                    aria-label="Nights of the wild loop"
                    onChange={(e) => {
                      // The bar's nights follow the loop's: one number for the trip, never two (a 59 here and 12 to 30 in
                      // the bar walked 59 nights and found nothing).
                      const n = Number(e.target.value);
                      onChange({ ...withAdvanced(q, { wild: { region: adv.wild?.region ?? WILD_REGIONS[0].key, nights: n } }), nights: [n, n] });
                    }}
                  />
                </label>
              </div>
            ) : (
              <p className={s.hint}>Many stops in a far region on live fares, 5 to 90 nights.</p>
            )}
          </section>

          <section className={s.advSection} aria-labelledby={`${id}-group`}>
            <div className={s.advHead}>
              <h4 id={`${id}-group`}>Group</h4>
              <button type="button" role="switch" aria-checked={!!adv.group} aria-labelledby={`${id}-group`} className={`${s.switch} ${adv.group ? s.switchOn : ""}`} onClick={toggleGroup}>
                <span />
              </button>
            </div>
            {adv.group ? (
              <div className={s.subRow}>
                {adv.group.members.some((m) => !m.origins.some((o) => o.trim())) && <p className={s.problem}>Add airports for everyone in the group.</p>}
                {adv.group.members.map((m, i) => (
                  <MemberEditor
                    key={i}
                    m={m}
                    index={i}
                    canRemove={adv.group!.members.length > 2}
                    onChange={(next) => setMembers(adv.group!.members.map((x, j) => (j === i ? next : x)))}
                    onRemove={() => setMembers(adv.group!.members.filter((_, j) => j !== i))}
                  />
                ))}
                {adv.group.members.length < 8 && (
                  <button type="button" className={s.linkBtn} onClick={() => setMembers([...adv.group!.members, { name: "", origins: [""], available: [queryWindow(q)] }])}>
                    + Add someone
                  </button>
                )}
              </div>
            ) : (
              <p className={s.hint}>Friends from different cities meet somewhere cheap for everyone.</p>
            )}
          </section>

          <section className={`${s.advSection} ${s.styleLink}`}>
            <span>
              <b>Trip style</b> {prefsSummary(prefs)}
            </span>
            <button type="button" className={s.linkBtn} onClick={() => window.dispatchEvent(new CustomEvent("atlas:open-prefs"))}>
              Edit
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
