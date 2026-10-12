"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WalkEvent } from "@/lib/graph-walk";
import { WalkTrace, traceFromEvents, type LoopLite } from "./WalkWatch";
import s from "./admin.module.css";

// Live: what Atlas did for every search, chat turn, loop and way home, as it happens. The app writes one run per
// request (lib/run-log.ts); this tab polls for new ones every few seconds. Use the app in one tab (or on the phone),
// keep this open in another: each run lands here with its steps, their timings and every error in red. A chat turn
// shows each tool the model called with what it asked and what came back; a loop replays with its beam and every way
// out it weighed.

type Row = { id: number; at: string; kind: string; source: string; device: string; title: string; ms: number | null; errors: number };
type Step = { t: number; kind: string; title: string; ms?: number; error?: string; data?: unknown };
type Run = Row & { body: { input?: unknown; steps?: Step[]; result?: unknown; error?: string; trimmed?: boolean } };

const KINDS = [
  { key: "", label: "Everything" },
  { key: "search", label: "Searches" },
  { key: "chat", label: "Chat turns" },
  { key: "walk", label: "Loops" },
  { key: "way-home", label: "Ways home" },
];
const KIND_COLOR: Record<string, string> = { search: "#6ff0c4", chat: "#7cc4ff", walk: "#ffb454", "way-home": "#c9a7ff", tool: "#7cc4ff", engine: "#6ff0c4", graph: "#6ff0c4", plan: "#c9a7ff", rank: "#6ff0c4", say: "#eef2ff", skip: "#888", memo: "#888", shared: "#888" };
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB");
const secs = (ms?: number | null) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default function LiveRuns() {
  const [runs, setRuns] = useState<Row[]>([]);
  const [me, setMe] = useState("");
  const [on, setOn] = useState(true);
  const [mine, setMine] = useState(true);
  const [kind, setKind] = useState("");
  const [follow, setFollow] = useState(true);
  const [sel, setSel] = useState<number | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const top = useRef(0);

  // The list: the newest 60, then every few seconds what came after.
  useEffect(() => {
    let alive = true;
    top.current = 0;
    setRuns([]);
    const q = (after?: number) => `/api/admin/runs?limit=60${after ? `&after=${after}` : ""}${mine ? "&mine=1" : ""}${kind ? `&kind=${kind}` : ""}`;
    const pull = async () => {
      try {
        const r = await fetch(q(top.current || undefined), { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { me: string; on: boolean; runs: Row[] };
        if (!alive) return;
        setMe(j.me);
        setOn(j.on);
        setErr(null);
        if (j.runs.length) {
          top.current = Math.max(top.current, ...j.runs.map((x) => x.id));
          setRuns((old) => [...j.runs, ...old.filter((o) => !j.runs.some((n) => n.id === o.id))].slice(0, 300));
        }
      } catch (e) {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void pull();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [mine, kind]);

  // Following: the newest run opens by itself as it lands.
  useEffect(() => {
    if (follow && runs[0] && runs[0].id !== sel) setSel(runs[0].id);
  }, [runs, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sel == null) return;
    setRun(null);
    fetch(`/api/admin/runs?id=${sel}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setRun(j.run ?? null))
      .catch(() => setRun(null));
  }, [sel]);

  return (
    <>
      <p className={s.lead}>
        Everything Atlas did, as it happens. Use the app in another tab or on your phone: every <b>search</b>, <b>chat turn</b>, <b>loop</b> and <b>way home</b> lands here a moment
        after it finishes, with each step, how long it took and every error in red. A chat turn lists each tool the model called, what it asked and what came back.
      </p>
      <div className={s.form}>
        <div className={s.tabs}>
          {KINDS.map((k) => (
            <button key={k.key} className={s.tab} aria-selected={kind === k.key} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
        <label className={s.small}>
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> only this browser ({me || "…"})
        </label>
        <label className={s.small}>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> open each new run as it lands
        </label>
        {!on && <span className={s.warn}>The run log is off here (no DATABASE_URL, or ATLAS_RUN_LOG=0).</span>}
        {err && <span className={s.warn}>{err}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "360px minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <div className={s.card} style={{ position: "sticky", top: 76, maxHeight: "calc(100vh - 110px)", overflow: "auto", padding: 8 }}>
          {!runs.length && <p className={s.muted} style={{ padding: 8 }}>Nothing yet. {mine ? "Use the app in this browser (the same access cookie), or untick “only this browser”." : "Use the app and it appears here."}</p>}
          {runs.map((r) => (
            <button key={r.id} className={s.state} data-sel={sel === r.id ? 1 : 0} data-kept="1" onClick={() => (setFollow(false), setSel(r.id))}>
              <b style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <span style={{ color: KIND_COLOR[r.kind] ?? "#eef2ff", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em" }}>{r.kind}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
              </b>
              <small>
                {clock(r.at)} · {secs(r.ms)}
                {r.device === me ? " · you" : ` · ${r.device}`}
                {r.errors ? <span style={{ color: "var(--rose)" }}> · {r.errors} error{r.errors > 1 ? "s" : ""}</span> : null}
              </small>
            </button>
          ))}
        </div>
        <div>{sel == null ? <p className={s.muted}>Pick a run.</p> : !run ? <p className={s.muted}>Loading…</p> : <RunView run={run} />}</div>
      </div>
    </>
  );
}

function Json({ v, max = 320 }: { v: unknown; max?: number }) {
  return <pre style={{ margin: "6px 0 0", padding: 10, borderRadius: 10, background: "rgba(255,255,255,0.03)", border: "1px solid var(--line)", fontFamily: "var(--mono)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: max, overflow: "auto" }}>{JSON.stringify(v, null, 2)}</pre>;
}

type TripLine = { title: string; price?: number; door?: number; tickets?: number; ground?: number; out?: string; back?: string; nights?: number; engine?: string; source?: string; stops?: string };
function Trips({ list }: { list: TripLine[] }) {
  return (
    <table className={s.table} style={{ marginTop: 6 }}>
      <thead>
        <tr>
          <th>Trip</th>
          <th className={s.num}>Door to door</th>
          <th>Dates</th>
          <th>Engine</th>
        </tr>
      </thead>
      <tbody>
        {list.map((t, i) => (
          <tr key={i}>
            <td>
              {t.title}
              {t.stops ? <div className={s.small + " " + s.muted}>{t.stops}</div> : null}
            </td>
            <td className={s.num}>€{t.door ?? (t.price ?? 0) + (t.ground ?? 0)}</td>
            <td className={s.mono}>
              {t.out}
              {t.back ? ` → ${t.back}` : ""}
            </td>
            <td>
              {t.engine} <span className={s.muted}>{t.source}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StepView({ st, open }: { st: Step; open: boolean }) {
  const [show, setShow] = useState(open);
  const d = st.data as Record<string, unknown> | undefined;
  const trips = (d?.trips ?? d?.top) as TripLine[] | undefined;
  const walk = st.kind === "walk" && d && Array.isArray(d.trace) ? d : null;
  const trace = useMemo(() => {
    if (!walk) return null;
    const places = walk.places as Record<string, [number, number, string]> | undefined;
    const home = places?.HOME;
    return traceFromEvents(walk.trace as WalkEvent[], { lat: home?.[1] ?? 0, lon: home?.[0] ?? 0 }, (walk.loops as LoopLite[]) ?? [], places);
  }, [walk]);
  return (
    <div className={s.leg} style={{ borderLeftColor: st.error ? "var(--rose)" : KIND_COLOR[st.kind] ?? "var(--sky)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", cursor: d ? "pointer" : "default" }} onClick={() => d && setShow((x) => !x)}>
        <span className={s.mono + " " + s.muted} style={{ minWidth: 52 }}>
          +{(st.t / 1000).toFixed(1)}s
        </span>
        <span style={{ color: KIND_COLOR[st.kind] ?? "#eef2ff", fontSize: 11.5, textTransform: "uppercase", letterSpacing: "0.05em", minWidth: 54 }}>{st.kind}</span>
        <span style={{ flex: 1 }}>{st.title}</span>
        <span className={s.muted + " " + s.small}>{secs(st.ms)}</span>
        {d ? <span className={s.muted}>{show ? "▾" : "▸"}</span> : null}
      </div>
      {st.error && <div style={{ color: "var(--rose)", marginTop: 4 }}>{st.error}</div>}
      {show && d && (
        <div style={{ marginTop: 6 }}>
          {st.kind === "tool" ? (
            <div className={s.grid2}>
              <div>
                <div className={s.small + " " + s.muted}>What the model asked</div>
                <Json v={d.input} />
              </div>
              <div>
                <div className={s.small + " " + s.muted}>What came back</div>
                <Json v={d.output} />
              </div>
            </div>
          ) : walk && trace ? (
            <WalkTrace t={trace} fitKey={String(st.t)} status={`${(walk.loops as unknown[]).length} loops · ${walk.searched} live searches · ${walk.expanded} states`} empty={String(walk.note ?? "No loop closed.")} lines={walk.considered as string[]} />
          ) : trips?.length ? (
            <>
              <Trips list={trips} />
              {Array.isArray(d.notes) && d.notes.length ? (
                <ol className={s.notes}>
                  {(d.notes as string[]).map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ol>
              ) : null}
            </>
          ) : (
            <Json v={d} />
          )}
        </div>
      )}
    </div>
  );
}

function RunView({ run }: { run: Run }) {
  const b = run.body ?? {};
  const steps = b.steps ?? [];
  const result = b.result as Record<string, unknown> | undefined;
  const failedTools = steps.filter((x) => x.kind === "tool" && x.error).length;
  return (
    <div className={s.card}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>{run.title}</h2>
      <div className={s.muted + " " + s.small}>
        {run.kind} · {run.source} · {new Date(run.at).toLocaleString("en-GB")} · {secs(run.ms)} · {steps.length} steps
        {failedTools ? <span style={{ color: "var(--rose)" }}> · {failedTools} tool{failedTools > 1 ? "s" : ""} failed</span> : null}
        {b.trimmed ? " · trace trimmed (too large)" : ""}
      </div>
      {b.error && <p style={{ color: "var(--rose)" }}>{b.error}</p>}
      <details style={{ margin: "10px 0" }}>
        <summary className={s.small + " " + s.muted} style={{ cursor: "pointer" }}>
          The question as the server got it
        </summary>
        <Json v={b.input} />
      </details>
      <h3 style={{ margin: "12px 0 4px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-3)" }}>What it did, in order</h3>
      {steps.map((st, i) => (
        <StepView key={i} st={st} open={!!st.error || st.kind === "walk" || st.kind === "rank"} />
      ))}
      {result && (
        <>
          <h3 style={{ margin: "14px 0 4px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--ink-3)" }}>What it answered</h3>
          {typeof result.text === "string" ? <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{result.text}</p> : null}
          {Array.isArray(result.top) ? <Trips list={result.top as TripLine[]} /> : null}
          {!result.text && !result.top ? <Json v={result} /> : null}
        </>
      )}
    </div>
  );
}
