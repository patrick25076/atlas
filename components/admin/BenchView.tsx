"use client";

import { Fragment, useEffect, useState } from "react";
import s from "./admin.module.css";

// The benchmark: real questions run through every brain each night (scripts/bench.ts), scored on the cheapest
// door-to-door price found against the best any brain found and the owner's own answer (gold). Regret is how many
// euros above the best a brain's cheapest trip was: 0 means it found the best.

type Score = { count: number; cheapest: number | null; cheapestTitle: string; top: { title: string; door: number; source: string; badges: string[]; engine: string; out: string; back?: string }[]; estimates: number; checkedLive: number; ms: number; searched: number; engines: string[]; note?: string; error?: string };
type Bench = {
  generatedAt: string;
  date: string;
  live: number;
  brains: string[];
  summary: Record<string, { cases: number; answered: number; wins: number; meanRegret: number | null; meanMs: number }>;
  cases: { id: string; label: string; gold?: { price?: number; note?: string }; brains: Record<string, Score>; best: number | null; regret: Record<string, number | null> }[];
};

const BRAIN_NAME: Record<string, string> = { classic: "Classic engines", one: "One brain" };

export default function BenchView() {
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<{ bench: Bench | null; history: { path: string; at: string }[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    fetch(`/api/admin/bench${path ? `?path=${encodeURIComponent(path)}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ bench: null, history: [] }));
  }, [path]);
  const b = data?.bench;
  return (
    <>
      <p className={s.lead}>
        Real questions, asked of every brain each night with stored prices only (no live search), and scored on the <b>cheapest door-to-door price</b> each found. <b>Regret</b> is how
        many euros above the best any brain (or your own answer) found: 0 is a win. Add your own trips to <span className={s.mono}>bench/cases.json</span> with your price as gold, and the
        board measures the engine against you.
      </p>
      {!data && <p className={s.muted}>Loading…</p>}
      {data && !b && <p className={s.muted}>No benchmark stored yet. It runs nightly, or locally with pnpm bench.</p>}
      {b && (
        <>
          <div className={s.stats}>
            {b.brains.map((x) => (
              <div key={x} className={s.stat}>
                <b>
                  {b.summary[x]?.wins ?? 0} / {b.summary[x]?.answered ?? 0}
                </b>
                <span>
                  {BRAIN_NAME[x] ?? x}: found the best · mean regret €{b.summary[x]?.meanRegret ?? "-"} · {((b.summary[x]?.meanMs ?? 0) / 1000).toFixed(1)} s a case
                </span>
              </div>
            ))}
            <div className={s.stat}>
              <b>{b.live || "none"}</b>
              <span>live searches a case ({b.date})</span>
            </div>
          </div>
          <div className={s.card}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>Question</th>
                  <th className={s.num}>Best</th>
                  {b.brains.map((x) => (
                    <th key={x}>{BRAIN_NAME[x] ?? x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.cases.map((c) => (
                  <Fragment key={c.id}>
                    <tr data-click="1" onClick={() => setOpen(open === c.id ? null : c.id)}>
                      <td>
                        {c.label}
                        {c.gold?.price != null && <span className={`${s.tag} ${s.tagAmber}`}>your answer €{c.gold.price}</span>}
                      </td>
                      <td className={s.num}>{c.best != null ? `€${c.best}` : "-"}</td>
                      {b.brains.map((x) => {
                        const sc = c.brains[x];
                        const r = c.regret[x];
                        return (
                          <td key={x}>
                            {sc?.error ? (
                              <span style={{ color: "var(--rose)" }}>error</span>
                            ) : sc?.cheapest != null ? (
                              <>
                                <b style={{ color: r === 0 ? "var(--mint)" : "var(--amber)" }}>€{sc.cheapest}</b> {r ? <span className={s.muted}>+€{r}</span> : <span className={s.muted}>best</span>}
                                <div className={s.small + " " + s.muted}>
                                  {sc.cheapestTitle} · {sc.count} trips · {(sc.ms / 1000).toFixed(1)} s{sc.estimates ? ` · ${sc.estimates} estimates` : ""}
                                  {sc.checkedLive ? ` · ${sc.checkedLive} checked live` : ""}
                                </div>
                              </>
                            ) : (
                              <span className={s.muted}>nothing</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                    {open === c.id && (
                      <tr>
                        <td colSpan={2 + b.brains.length}>
                          {c.gold?.note && <p className={s.small}>Your answer: {c.gold.note}</p>}
                          <div className={s.grid2}>
                            {b.brains.map((x) => (
                              <div key={x}>
                                <div className={s.small + " " + s.muted}>
                                  {BRAIN_NAME[x] ?? x} · engines {c.brains[x]?.engines.join(", ") || "none"} · {c.brains[x]?.searched ?? 0} live searches
                                </div>
                                <ol className={s.notes}>
                                  {(c.brains[x]?.top ?? []).map((t, i) => (
                                    <li key={i}>
                                      €{t.door} {t.title} <span className={s.muted}>({t.out}{t.back ? ` to ${t.back}` : ""}, {t.engine}, {t.source}{t.badges.includes("checked live") ? ", checked live" : ""})</span>
                                    </li>
                                  ))}
                                </ol>
                                {c.brains[x]?.note && <p className={s.small + " " + s.muted}>{c.brains[x]!.note}</p>}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!!data?.history.length && (
        <div className={s.card} style={{ marginTop: 14 }}>
          <h3>Earlier runs</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button className={s.tab} aria-selected={!path} onClick={() => setPath(null)}>
              latest
            </button>
            {data.history.map((h) => (
              <button key={h.path} className={s.tab} aria-selected={path === h.path} onClick={() => setPath(h.path)}>
                {h.path.replace("bench/", "").replace(".json", "")}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
