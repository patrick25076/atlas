"use client";

import { useMemo, useRef, useState } from "react";
import type { WalkBeamRow, WalkCandidate, WalkEvent, WalkLoop, WalkResult } from "@/lib/graph-walk";
import { WILD_REGIONS } from "@/lib/ui-types";
import AdminMap, { type MapDot, type MapLine } from "./AdminMap";
import s from "./admin.module.css";

// Watch a loop: the graph walk with its trace on. Each depth is a column of states, the beam's kept ones solid and the
// dropped ones faded; click one to see what it weighed: the searches made (or not), and every way out with its cost
// split into price, hours, changes of plane and the place's worth. The map draws every edge found, the chosen ones
// bright, the selected state's path in mint and its candidates fanned out.

type Expand = Extract<WalkEvent, { type: "expand" }>;
type Beam = Extract<WalkEvent, { type: "beam" }>;
type EdgeEv = Extract<WalkEvent, { type: "edge" }>;
type NodeEv = Extract<WalkEvent, { type: "node" }>;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

const HOME = { label: "Brasov", lat: 45.657, lon: 25.601, gateways: "GHV,SBZ,OTP", home: "RO" };
const COLORS = { price: "#6ff0c4", hours: "#7cc4ff", stops: "#ffb454", bonus: "#ff6b8a" };

export default function WalkWatch() {
  const [f, setF] = useState({
    ...HOME,
    from: addDays(today(), 39),
    to: addDays(today(), 69),
    minNights: 14,
    maxNights: 16,
    nppLo: 2,
    nppHi: 3,
    region: "sea",
    tradeoff: "price",
    budget: 0,
    must: "",
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [running, setRunning] = useState(false);
  const [knobs, setKnobs] = useState<Record<string, string | number> | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [expands, setExpands] = useState<Map<number, Expand>>(new Map());
  const [beams, setBeams] = useState<Beam[]>([]);
  const [edges, setEdges] = useState<EdgeEv[]>([]);
  const [nodes, setNodes] = useState<Map<string, NodeEv>>(new Map());
  const [loops, setLoops] = useState<WalkLoop[]>([]);
  const [done, setDone] = useState<{ ms: number; result: WalkResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [selLoop, setSelLoop] = useState<string | null>(null);
  const [runKey, setRunKey] = useState("");
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);
    setKnobs(null);
    setProgress([]);
    setExpands(new Map());
    setBeams([]);
    setEdges([]);
    setNodes(new Map());
    setLoops([]);
    setDone(null);
    setError(null);
    setSel(null);
    setSelLoop(null);
    setRunKey(String(Date.now()));
    const q = {
      origin: { lat: Number(f.lat), lon: Number(f.lon), label: f.label },
      gateways: f.gateways.split(",").map((x) => x.trim()).filter(Boolean),
      home: f.home,
      from: f.from,
      to: f.to,
      minNights: f.minNights,
      maxNights: f.maxNights,
      nightsPerStop: [f.nppLo, f.nppHi],
      ...(f.region ? { region: f.region } : {}),
      tradeoff: f.tradeoff,
      budget: f.budget,
      ...(f.must.trim() ? { mustInclude: f.must.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    };
    try {
      const r = await fetch(`/api/admin/walk?q=${encodeURIComponent(JSON.stringify(q))}`, { signal: ac.signal });
      if (!r.ok || !r.body) throw new Error((await r.text()) || `HTTP ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line) as WalkEvent | { type: "done"; ms: number; result: WalkResult } | { type: "error"; error: string };
          if (e.type === "knobs") setKnobs(e.values);
          else if (e.type === "progress") setProgress((p) => [...p, e.text]);
          else if (e.type === "expand") setExpands((m) => new Map(m).set(e.id, e));
          else if (e.type === "beam") setBeams((b) => [...b, e]);
          else if (e.type === "edge") setEdges((x) => (x.length > 3000 ? x : [...x, e]));
          else if (e.type === "node") setNodes((m) => new Map(m).set(e.code, e));
          else if (e.type === "loop") setLoops((l) => [...l.filter((x) => x.id !== e.loop.id), e.loop].sort((a, b) => a.score - b.score));
          else if (e.type === "done") setDone({ ms: e.ms, result: e.result });
          else if (e.type === "error") setError(e.error);
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  // Every state seen (beam rows and expansions), for paths and the columns.
  const states = useMemo(() => {
    const m = new Map<number, WalkBeamRow & { kept: boolean; depth: number }>();
    for (const b of beams) {
      for (const r of b.dropped) if (!m.has(r.id)) m.set(r.id, { ...r, kept: false, depth: b.depth });
      for (const r of b.kept) m.set(r.id, { ...r, kept: true, depth: b.depth });
    }
    return m;
  }, [beams]);
  // Where a city is: the nodes the walk expanded, the far ends of the edges it found, home.
  const where = useMemo(() => {
    const m = new Map<string, [number, number]>();
    m.set("HOME", [Number(f.lon), Number(f.lat)]);
    for (const e of edges) if (e.lat || e.lon) m.set(e.to, [e.lon, e.lat]);
    for (const [k, n] of nodes) m.set(k, [n.lon, n.lat]);
    return m;
  }, [edges, nodes, f.lat, f.lon]);

  const pathIds = (id: number | null): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let x = id; x != null && x >= 0 && !seen.has(x); x = states.get(x)?.parent ?? expands.get(x)?.parent ?? null) {
      seen.add(x);
      out.unshift(x);
    }
    return out;
  };
  const selExpand = sel != null ? expands.get(sel) : undefined;
  const selPath = useMemo(() => pathIds(sel), [sel, states, expands]); // eslint-disable-line react-hooks/exhaustive-deps

  const { dots, lines } = useMemo(() => {
    const dots: MapDot[] = [];
    const lines: MapLine[] = [];
    const seenDot = new Set<string>();
    const dot = (code: string, color: string, size: number, label?: string) => {
      const p = where.get(code);
      if (!p || seenDot.has(code + color)) return;
      seenDot.add(code + color);
      dots.push({ id: code + color, lon: p[0], lat: p[1], color, size, label });
    };
    for (const e of edges.slice(0, 1500)) {
      const a = where.get(e.from);
      const b = e.home ? where.get("HOME") : where.get(e.to);
      if (!a || !b) continue;
      lines.push({ id: `${e.from}>${e.to}`, from: a, to: b, color: e.chosen ? "#7cc4ff" : "#7cc4ff", width: e.chosen ? 1.8 : 0.6, opacity: e.chosen ? 0.75 : 0.18, dashed: e.kind !== "fly" });
    }
    for (const [code, n] of nodes) dot(code, "#7cc4ff", 4, n.name);
    // The selected loop, else the selected state's path, in mint.
    const loop = selLoop ? loops.find((l) => l.id === selLoop) : undefined;
    if (loop) {
      const pts: [number, number][] = [[Number(f.lon), Number(f.lat)], ...loop.stops.map((x) => [x.lon, x.lat] as [number, number]), [Number(f.lon), Number(f.lat)]];
      pts.slice(1).forEach((p, i) => lines.push({ id: `loop${i}`, from: pts[i], to: p, color: "#6ff0c4", width: 3, opacity: 1 }));
      loop.stops.forEach((x) => dots.push({ id: `l${x.code}`, lon: x.lon, lat: x.lat, color: "#6ff0c4", size: 6, label: `${x.name} ${x.nights}n` }));
    } else if (selPath.length) {
      const codes = selPath.map((id) => states.get(id)?.city ?? expands.get(id)?.city ?? "");
      for (let i = 1; i < codes.length; i++) {
        const a = where.get(codes[i - 1]);
        const b = where.get(codes[i]);
        if (a && b) lines.push({ id: `p${i}`, from: a, to: b, color: "#6ff0c4", width: 3, opacity: 1 });
      }
      codes.forEach((c) => dot(c, "#6ff0c4", 6));
      // Its candidates, fanned out: the winners per city brighter.
      if (selExpand) {
        const a = where.get(selExpand.city);
        for (const c of selExpand.candidates) {
          const b = where.get(c.to);
          if (a && b) lines.push({ id: `c${c.to}${c.date}${c.price}`, from: a, to: b, color: c.best ? "#ffb454" : "#ff6b8a", width: c.best ? 1.6 : 0.8, opacity: c.best ? 0.9 : 0.4, dashed: c.kind !== "fly" });
        }
      }
    }
    return { dots, lines };
  }, [edges, nodes, where, selPath, selExpand, selLoop, loops, states, expands, f.lat, f.lon]);

  const depths = useMemo(() => {
    const out: (WalkBeamRow & { kept: boolean; depth: number })[][] = [];
    for (const st of states.values()) (out[st.depth] ??= []).push(st);
    return out.map((col) => (col ?? []).sort((a, b) => Number(b.kept) - Number(a.kept) || a.priority - b.priority));
  }, [states]);

  return (
    <>
      <p className={s.lead}>
        The loop builder, step by step. From home it asks one question, <b>where is cheap from here</b>, then asks it again from each place it lands, keeps the best few half-built trips (the
        beam) and closes the ones that can still get home. Every way out gets a cost: <b>price + hours + changes of plane − what the place is worth</b>. Budget 0 replays it on what the fare
        memory already knows, so it costs nothing; give it searches to see it ask Kiwi live.
      </p>
      <div className={s.form}>
        <label className={s.field}>
          From
          <input value={f.label} onChange={(e) => set({ label: e.target.value })} style={{ width: 110 }} />
        </label>
        <label className={s.field}>
          Airports
          <input value={f.gateways} onChange={(e) => set({ gateways: e.target.value.toUpperCase() })} style={{ width: 120 }} />
        </label>
        <label className={s.field}>
          Window from
          <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className={s.field}>
          to
          <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <label className={s.field}>
          Nights
          <span>
            <input type="number" value={f.minNights} min={1} max={90} onChange={(e) => set({ minNights: +e.target.value })} /> to{" "}
            <input type="number" value={f.maxNights} min={1} max={90} onChange={(e) => set({ maxNights: +e.target.value })} />
          </span>
        </label>
        <label className={s.field}>
          A stop
          <span>
            <input type="number" value={f.nppLo} min={1} max={14} onChange={(e) => set({ nppLo: +e.target.value })} /> to{" "}
            <input type="number" value={f.nppHi} min={1} max={14} onChange={(e) => set({ nppHi: +e.target.value })} />
          </span>
        </label>
        <label className={s.field}>
          Region
          <select value={f.region} onChange={(e) => set({ region: e.target.value })}>
            <option value="">anywhere</option>
            {WILD_REGIONS.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className={s.field}>
          Style
          <select value={f.tradeoff} onChange={(e) => set({ tradeoff: e.target.value })}>
            <option value="price">Cheapest</option>
            <option value="balanced">Balanced</option>
            <option value="comfort">Comfort</option>
          </select>
        </label>
        <label className={s.field}>
          Must pass
          <input value={f.must} placeholder="Hanoi, Vientiane" onChange={(e) => set({ must: e.target.value })} style={{ width: 140 }} />
        </label>
        <label className={s.field}>
          Live searches
          <input type="number" value={f.budget} min={0} max={40} onChange={(e) => set({ budget: Math.max(0, Math.min(40, +e.target.value)) })} />
        </label>
        <button className={s.go} onClick={run} disabled={running}>
          {running ? "Thinking…" : "Watch it think"}
        </button>
        {f.budget > 0 && <span className={s.warn}>spends up to {f.budget} live Kiwi searches</span>}
      </div>
      {error && <p className={s.warn}>{error}</p>}

      {knobs && (
        <div className={s.card} style={{ marginBottom: 14 }}>
          <h3>The knobs this run used</h3>
          <div className={s.knobs}>
            {Object.entries(knobs).map(([k, v]) => (
              <div key={k}>
                <span className={s.muted}>{k}</span>
                <b>{String(v)}</b>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={s.grid2}>
        <div>
          <AdminMap dots={dots} lines={lines} height={420} fitKey={runKey + (selLoop ?? "") + (sel ?? "")} />
          <div className={s.legend}>
            <span>
              <i style={{ background: "#7cc4ff" }} />
              every edge found (dashed: train or coach)
            </span>
            <span>
              <i style={{ background: "#6ff0c4" }} />
              the selected path or loop
            </span>
            <span>
              <i style={{ background: "#ffb454" }} />
              its best way to each city
            </span>
            <span>
              <i style={{ background: "#ff6b8a" }} />
              ways it weighed and lost
            </span>
          </div>
        </div>
        <div className={s.card}>
          <h3>Loops closed {done ? `· ${done.result.loops.length} kept · ${done.result.searched} live searches · ${done.result.expanded} states · ${(done.ms / 1000).toFixed(1)} s` : ""}</h3>
          {!loops.length && <p className={s.muted}>{running ? "Walking…" : done?.result.note ?? "Run it to see."}</p>}
          {loops.map((l) => (
            <button key={l.id} className={s.loop} data-sel={selLoop === l.id ? 1 : 0} onClick={() => setSelLoop(selLoop === l.id ? null : l.id)}>
              <b>€{l.total}</b>
              {l.title}
              <div className={s.small + " " + s.muted}>
                {l.start} to {l.end} · {l.nights} nights · {l.hours} h · score {l.score} (cost after hours, stops and worth)
              </div>
              {selLoop === l.id && (
                <ol className={s.notes}>
                  {l.why.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ol>
              )}
            </button>
          ))}
          <h3 style={{ marginTop: 12 }}>What it said</h3>
          <div className={s.progress}>
            {progress.map((p, i) => (
              <div key={i}>{p}</div>
            ))}
            {done?.result.considered.map((c, i) => (
              <div key={`c${i}`} className={s.muted}>
                {c}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={s.card} style={{ marginTop: 16 }}>
        <h3>The beam, depth by depth · click a state to see what it weighed</h3>
        {!depths.length && <p className={s.muted}>Nothing yet.</p>}
        <div className={s.depths}>
          {depths.map((col, d) => (
            <div key={d} className={s.depth}>
              <h4>
                Depth {d} {d === 0 ? "(home)" : `· ${col.filter((x) => x.kept).length} kept of ${col.length}`}
              </h4>
              {col.map((st) => (
                <button key={st.id} className={s.state} data-kept={st.kept ? 1 : 0} data-sel={sel === st.id ? 1 : 0} onClick={() => setSel(st.id)}>
                  <b>{st.name}</b>
                  <small>
                    {st.date} · €{st.money} spent · cost {st.cost}
                    {!st.kept ? " · dropped" : expands.has(st.id) ? "" : " · not expanded"}
                  </small>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {selExpand && <Candidates e={selExpand} />}
      {sel != null && !selExpand && <p className={s.muted}>That state was not expanded (dropped by the beam, or the walk stopped first).</p>}
    </>
  );
}

function Candidates({ e }: { e: Expand }) {
  const max = Math.max(1, ...e.candidates.map((c) => c.price + c.hoursCost + c.stopsCost));
  const [all, setAll] = useState(false);
  const shown = all ? e.candidates : e.candidates.slice(0, 25);
  return (
    <div className={s.card} style={{ marginTop: 16 }}>
      <h3>
        {e.path} · leaving {e.window ? `${e.window[0]} to ${e.window[1]}` : "no day left"} · cost so far {e.cost}
      </h3>
      <ol className={s.notes}>
        {e.notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ol>
      <div className={s.legend}>
        <span>
          <i style={{ background: COLORS.price }} />
          ticket
        </span>
        <span>
          <i style={{ background: COLORS.hours }} />
          hours × the style&apos;s euro an hour
        </span>
        <span>
          <i style={{ background: COLORS.stops }} />
          changes of plane
        </span>
        <span>
          <i style={{ background: COLORS.bonus }} />
          minus what the place is worth (capped)
        </span>
        <span>★ the cheapest way to that city, the one that goes on</span>
      </div>
      <table className={s.table}>
        <thead>
          <tr>
            <th />
            <th>To</th>
            <th>How</th>
            <th>Day</th>
            <th className={s.num}>Ticket</th>
            <th className={s.num}>Hours</th>
            <th className={s.num}>Stops</th>
            <th className={s.num}>− Worth</th>
            <th className={s.num}>= Cost</th>
            <th>Split</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c: WalkCandidate, i) => (
            <tr key={i} data-best={c.best ? 1 : 0}>
              <td>{c.best ? "★" : ""}</td>
              <td>
                {c.name}
                <span className={s.muted}> {c.country}</span>
                {c.layover && <span className={`${s.tag} ${s.tagMint}`}>free night in {c.layover.name} ({c.layover.hours} h layover)</span>}
              </td>
              <td>
                {c.kind}
                <span className={`${s.tag} ${c.source === "live" ? s.tagMint : c.source === "memory" ? "" : s.tagAmber}`}>{c.source}</span>
                {c.kind === "fly" && <span className={s.tag}>{c.stops ? `${c.stops} stop${c.stops > 1 ? "s" : ""}` : "direct"}</span>}
              </td>
              <td className={s.mono}>{c.date}</td>
              <td className={s.num}>€{c.price}</td>
              <td className={s.num}>{c.hoursCost}</td>
              <td className={s.num}>{c.stopsCost || ""}</td>
              <td className={s.num}>−{c.bonus}</td>
              <td className={s.num}>
                <b>{c.cost}</b>
              </td>
              <td>
                <div className={s.bar} title={`${c.price} + ${c.hoursCost} + ${c.stopsCost} − ${c.bonus}`}>
                  <i style={{ width: `${(c.price / max) * 100}%`, background: COLORS.price }} />
                  <i style={{ width: `${(c.hoursCost / max) * 100}%`, background: COLORS.hours }} />
                  <i style={{ width: `${(c.stopsCost / max) * 100}%`, background: COLORS.stops }} />
                </div>
                <div className={s.bar} style={{ marginTop: 2, background: "transparent" }}>
                  <i style={{ width: `${(c.bonus / max) * 100}%`, background: COLORS.bonus, opacity: 0.7 }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {e.candidates.length > 25 && (
        <button className={s.tab} onClick={() => setAll((x) => !x)}>
          {all ? "Fewer" : `All ${e.candidates.length}`}
        </button>
      )}
    </div>
  );
}
