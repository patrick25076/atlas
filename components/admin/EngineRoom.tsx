"use client";

import { useMemo, useState } from "react";
import s from "./admin.module.css";
import { GRAPH_TABLE, MACHINE, type Node } from "./machine";
import WalkWatch from "./WalkWatch";
import GraphView from "./GraphView";
import GraphTrips from "./GraphTrips";
import LiveRuns from "./LiveRuns";
import BenchView from "./BenchView";

// The engine room: how Atlas thinks. Five views:
//   Live          what the app did for every search, chat turn, loop and way home, as it happens (the run log)
//   The machine   every front door, engine and source of data, and which uses which
//   Watch a loop  the graph walk with its trace: every candidate weighed, the beam, the loops
//   Price graph   what last night's flight graph and the fare memory hold, city by city
//   One hop       every price ever seen between two places, day by day (the gaps show)
//   Graph trips   the Dijkstra on euros with, for each flight, the flights it was chosen over

const TABS = [
  { key: "live", label: "Live" },
  { key: "machine", label: "The machine" },
  { key: "walk", label: "Watch a loop" },
  { key: "graph", label: "Price graph" },
  { key: "trips", label: "Graph trips" },
  { key: "bench", label: "Benchmark" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default function EngineRoom() {
  const [tab, setTab] = useState<Tab>("live");
  return (
    <div className={s.page}>
      <header className={s.head}>
        <h1>
          Engine room<small>how Atlas thinks</small>
        </h1>
        <div className={s.tabs} role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={s.tab} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <a className={s.back} href="/">
          ← Atlas
        </a>
      </header>
      <main className={s.body}>
        {tab === "live" && <LiveRuns />}
        {tab === "machine" && <Machine />}
        {tab === "walk" && <WalkWatch />}
        {tab === "graph" && <GraphView />}
        {tab === "trips" && <GraphTrips />}
        {tab === "bench" && <BenchView />}
      </main>
    </div>
  );
}

function Machine() {
  const byId = useMemo(() => new Map(MACHINE.map((n) => [n.id, n])), []);
  const [sel, setSel] = useState<string>("search");
  const node = byId.get(sel)!;
  // What the selected one uses, and what uses it: one step each way.
  const near = useMemo(() => {
    const out = new Set<string>([sel, ...(node.uses ?? [])]);
    for (const n of MACHINE) if (n.uses?.includes(sel)) out.add(n.id);
    return out;
  }, [sel, node]);
  const usedBy = MACHINE.filter((n) => n.uses?.includes(sel));
  const col = (kind: Node["kind"], title: string) => (
    <div className={s.col}>
      <h2>{title}</h2>
      {MACHINE.filter((n) => n.kind === kind).map((n) => (
        <button key={n.id} className={s.node} data-kind={n.kind} data-state={n.id === sel ? "on" : near.has(n.id) ? "near" : "off"} onClick={() => setSel(n.id)}>
          <b>{n.name}</b>
          <span>{n.line}</span>
        </button>
      ))}
    </div>
  );
  return (
    <>
      <p className={s.lead}>
        Atlas has four <b>front doors</b> (what you press), a dozen <b>engines</b> (what decides) and the <b>data</b> they read. Click anything: what it uses and what uses it light up, the rest fades.
        The price graph and the walk are the two that think in graphs; the chat thinks in tools, the plan in words.
      </p>
      <div className={s.machine}>
        {col("door", "Front doors")}
        {col("engine", "Engines")}
        {col("data", "Data")}
        <div className={`${s.card} ${s.detail}`}>
          <h2>{node.name}</h2>
          <div className={s.muted}>{node.line}</div>
          {node.how && (
            <ol>
              {node.how.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ol>
          )}
          <dl className={s.kv}>
            {node.algo && (
              <>
                <dt>Algorithm</dt>
                <dd>{node.algo}</dd>
              </>
            )}
            {node.cost && (
              <>
                <dt>It minimises</dt>
                <dd>{node.cost}</dd>
              </>
            )}
            {node.spends && (
              <>
                <dt>Live searches</dt>
                <dd>{node.spends}</dd>
              </>
            )}
            {node.file && (
              <>
                <dt>Code</dt>
                <dd className={s.mono}>{node.file}</dd>
              </>
            )}
            {!!node.uses?.length && (
              <>
                <dt>Uses</dt>
                <dd>{node.uses.map((u) => byId.get(u)?.name ?? u).join(", ")}</dd>
              </>
            )}
            {!!usedBy.length && (
              <>
                <dt>Used by</dt>
                <dd>{usedBy.map((u) => u.name).join(", ")}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className={s.card} style={{ marginTop: 18 }}>
        <h3>Which uses which graph</h3>
        <table className={s.table}>
          <thead>
            <tr>
              <th>What you do</th>
              <th>Price graph</th>
              <th>Ground graph</th>
              <th>Live searches</th>
              <th>Language model</th>
              <th>Algorithm</th>
            </tr>
          </thead>
          <tbody>
            {GRAPH_TABLE.map((r) => (
              <tr key={r.feature}>
                <td>{r.feature}</td>
                <td>{r.priceGraph}</td>
                <td>{r.groundGraph}</td>
                <td>{r.live}</td>
                <td>{r.llm}</td>
                <td>{r.algorithm}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
