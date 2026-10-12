"use client";

import { useEffect, useMemo, useState } from "react";
import AdminMap, { type MapDot, type MapLine } from "./AdminMap";
import s from "./admin.module.css";

// The price graph as the engines see it: last night's flights (164 airports, six weeks) plus the fare memory (every
// live search's answers from the last day), merged into one set of one-way flights by (from, to, day). A city with
// few flights out is a city the search cannot be clever about: every hop out of it is whatever happened to be seen.

type Stats = {
  graphDate: string;
  loadedAt: string;
  loadMs: number;
  shards: number;
  edges: number;
  fromGraph: number;
  fromMemory: number;
  thin: boolean;
  days: { from: string; to: string } | null;
  perDay: { date: string; edges: number }[];
  cities: { code: string; name: string; country: string; lat: number; lon: number; edges: number; days: number; destinations: number; fromMemory: number }[];
};
type EdgeRow = { from: string; fromCity: string; to: string; toCity: string; toName: string; date: string; depart?: string; price: number; minutes: number; stops: number; carrier?: string; url?: string; source: "graph" | "memory"; seen?: string };
type FareSeen = { src: string; dst: string; out: string; price: number; stops: number; carriers: string[]; hours: number; url: string; seenAt: string };

const price = (p: number, lo: number, hi: number) => {
  const t = hi > lo ? (p - lo) / (hi - lo) : 0;
  // mint (cheap) to rose (dear)
  const a = [111, 240, 196];
  const b = [255, 107, 138];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * t));
  return `rgba(${c[0]},${c[1]},${c[2]},0.35)`;
};

export default function GraphView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [city, setCity] = useState<string>("HAN");
  const [filter, setFilter] = useState("");
  const [out, setOut] = useState<EdgeRow[] | null>(null);
  const [pair, setPair] = useState({ a: "HAN", b: "VTE", from: "2026-11-25", to: "2026-12-20" });
  const [pairRes, setPairRes] = useState<{ graph: EdgeRow[]; memory: FareSeen[] } | null>(null);

  useEffect(() => {
    fetch("/api/admin/graph?op=stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setStats)
      .catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    if (!city) return;
    setOut(null);
    fetch(`/api/admin/graph?op=from&code=${encodeURIComponent(city)}`)
      .then((r) => r.json())
      .then((j) => setOut(j.edges ?? []))
      .catch(() => setOut([]));
  }, [city]);
  const runPair = () => {
    setPairRes(null);
    fetch(`/api/admin/graph?op=pair&a=${pair.a}&b=${pair.b}&from=${pair.from}&to=${pair.to}`)
      .then((r) => r.json())
      .then(setPairRes)
      .catch(() => setPairRes({ graph: [], memory: [] }));
  };
  useEffect(runPair, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = stats?.cities.find((c) => c.code === city);
  const { dots, lines } = useMemo(() => {
    const dots: MapDot[] = [];
    const lines: MapLine[] = [];
    if (!stats) return { dots, lines };
    for (const c of stats.cities) {
      if (!c.lat && !c.lon) continue;
      const memOnly = c.fromMemory === c.edges;
      dots.push({ id: c.code, lat: c.lat, lon: c.lon, color: c.code === city ? "#ffffff" : memOnly ? "#ffb454" : "#6ff0c4", size: Math.max(2.5, Math.min(11, Math.sqrt(c.edges) / 2.2)), label: c.edges > 250 || c.code === city ? c.name : undefined });
    }
    if (sel && out) {
      const best = new Map<string, EdgeRow>();
      for (const e of out) if (!best.has(e.toCity) || best.get(e.toCity)!.price > e.price) best.set(e.toCity, e);
      const ps = [...best.values()].map((e) => e.price);
      const lo = Math.min(...ps);
      const hi = Math.max(...ps);
      for (const e of best.values()) {
        const t = stats.cities.find((c) => c.code === e.toCity) ?? null;
        const to = t ? ([t.lon, t.lat] as [number, number]) : null;
        if (to) lines.push({ id: e.toCity, from: [sel.lon, sel.lat], to, color: price(e.price, lo, hi).replace("0.35", "1"), width: 1.4, opacity: 0.8 });
      }
    }
    return { dots, lines };
  }, [stats, city, sel, out]);

  // The flights out, as a grid: destinations down, days across, the cheapest price per cell.
  const grid = useMemo(() => {
    if (!out?.length) return null;
    const days = [...new Set(out.map((e) => e.date))].sort();
    const byDest = new Map<string, { name: string; cells: Map<string, EdgeRow>; min: number }>();
    for (const e of out) {
      const d = byDest.get(e.toCity) ?? { name: e.toName, cells: new Map(), min: Infinity };
      const cur = d.cells.get(e.date);
      if (!cur || cur.price > e.price) d.cells.set(e.date, e);
      d.min = Math.min(d.min, e.price);
      byDest.set(e.toCity, d);
    }
    const rows = [...byDest.entries()].sort((a, b) => a[1].min - b[1].min).slice(0, 40);
    const all = out.map((e) => e.price);
    return { days, rows, lo: Math.min(...all), hi: Math.max(...all) };
  }, [out]);

  const shownCities = (stats?.cities ?? []).filter((c) => !filter || `${c.name} ${c.code} ${c.country}`.toLowerCase().includes(filter.toLowerCase()));

  // One hop: a strip of days with what the graph holds and every sighting in the fare memory.
  const pairDays = useMemo(() => {
    if (!pairRes) return [];
    const out: { date: string; graph: EdgeRow[]; memory: FareSeen[] }[] = [];
    for (let d = pair.from; d <= pair.to; d = new Date(Date.parse(d + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10)) {
      out.push({ date: d, graph: pairRes.graph.filter((e) => e.date === d), memory: pairRes.memory.filter((m) => m.out === d) });
    }
    return out;
  }, [pairRes, pair.from, pair.to]);

  if (err) return <p className={s.warn}>{err}</p>;
  return (
    <>
      <p className={s.lead}>
        The price graph is every one-way flight Atlas knows <b>without asking Kiwi</b>: last night&apos;s job (one search per airport per three days, the 15 cheapest answers) plus the fare
        memory (whatever any live search found in the last day). The Search tab&apos;s Dijkstra runs on this. A city drawn <b style={{ color: "var(--amber)" }}>amber</b> is not searched
        at night: everything known about leaving it came from someone&apos;s live search, so its hops are whatever happened to be seen.
      </p>
      {stats && (
        <div className={s.stats}>
          <div className={s.stat}>
            <b>{stats.edges.toLocaleString("en-GB")}</b>
            <span>flights in the graph</span>
          </div>
          <div className={s.stat}>
            <b>{stats.fromGraph.toLocaleString("en-GB")}</b>
            <span>from last night ({stats.graphDate}, {stats.shards} shards)</span>
          </div>
          <div className={s.stat}>
            <b>{stats.fromMemory.toLocaleString("en-GB")}</b>
            <span>from the fare memory</span>
          </div>
          <div className={s.stat}>
            <b>{stats.cities.length}</b>
            <span>cities with a flight out</span>
          </div>
          <div className={s.stat}>
            <b>{stats.days ? `${stats.days.from.slice(5)} → ${stats.days.to.slice(5)}` : "none"}</b>
            <span>days covered</span>
          </div>
          <div className={s.stat}>
            <b>{stats.loadMs} ms</b>
            <span>to load ({(stats.thin ? "thin, " : "") + new Date(stats.loadedAt).toLocaleTimeString("en-GB")})</span>
          </div>
        </div>
      )}
      <div className={s.grid2}>
        <div>
          <AdminMap dots={dots} lines={lines} height={420} fitKey={city} />
          <div className={s.legend}>
            <span>
              <i style={{ background: "#6ff0c4" }} />
              searched every night
            </span>
            <span>
              <i style={{ background: "#ffb454" }} />
              known only from live searches
            </span>
            <span>dot size: flights out · lines: the selected city&apos;s cheapest flight to each place (mint cheap, rose dear)</span>
          </div>
          {stats && (
            <div className={s.card} style={{ marginTop: 10 }}>
              <h3>Flights by day of departure</h3>
              <div className={s.days}>
                {stats.perDay.map((d) => (
                  <i key={d.date} title={`${d.date}: ${d.edges}`} style={{ height: `${(d.edges / Math.max(...stats.perDay.map((x) => x.edges))) * 100}%` }} />
                ))}
              </div>
              <div className={s.small + " " + s.muted}>
                {stats.perDay[0]?.date} to {stats.perDay.at(-1)?.date}: the nightly job covers six weeks; past that, only what live searches left behind.
              </div>
            </div>
          )}
        </div>
        <div className={s.card}>
          <h3>Cities · click one</h3>
          <input placeholder="filter: Hanoi, VN, BKK" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", height: 32, marginBottom: 8, borderRadius: 8, border: "1px solid var(--line-2)", background: "transparent", color: "var(--ink)", padding: "0 10px" }} />
          <div className={s.scroll} style={{ maxHeight: 400 }}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th>City</th>
                  <th className={s.num}>Flights out</th>
                  <th className={s.num}>Days</th>
                  <th className={s.num}>Places</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {shownCities.slice(0, 300).map((c) => (
                  <tr key={c.code} data-click="1" data-best={c.code === city ? 1 : 0} onClick={() => setCity(c.code)}>
                    <td>
                      {c.name} <span className={s.muted}>{c.code} {c.country}</span>
                    </td>
                    <td className={s.num}>{c.edges}</td>
                    <td className={s.num}>{c.days}</td>
                    <td className={s.num}>{c.destinations}</td>
                    <td>{c.fromMemory === c.edges ? <span className={`${s.tag} ${s.tagAmber}`}>live only</span> : c.fromMemory ? <span className={s.tag}>night + live</span> : <span className={`${s.tag} ${s.tagMint}`}>nightly</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className={s.card} style={{ marginTop: 16 }}>
        <h3>
          Flights out of {sel?.name ?? city} · {out ? `${out.length} known` : "loading"} · the cheapest per day and place
        </h3>
        {grid ? (
          <div className={s.scroll}>
            <table className={s.heat}>
              <thead>
                <tr>
                  <th>to \ day</th>
                  {grid.days.map((d) => (
                    <th key={d}>{d.slice(5)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(([code, r]) => (
                  <tr key={code}>
                    <td>
                      {r.name} <span className={s.muted}>from €{r.min}</span>
                    </td>
                    {grid.days.map((d) => {
                      const e = r.cells.get(d);
                      return (
                        <td key={d} style={e ? { background: price(e.price, grid.lo, grid.hi) } : undefined} title={e ? `${e.toName} ${e.date} €${e.price} ${e.stops ? e.stops + " stop" : "direct"} ${e.carrier ?? ""} (${e.source}${e.seen ? ", seen " + e.seen : ""})` : "nothing known"}>
                          {e ? e.price : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={s.muted}>{out ? "Nothing known out of this city." : "Loading…"}</p>
        )}
      </div>

      <div className={s.card} style={{ marginTop: 16 }}>
        <h3>One hop, day by day · every price ever seen</h3>
        <div className={s.form}>
          <label className={s.field}>
            From
            <input value={pair.a} onChange={(e) => setPair({ ...pair, a: e.target.value.toUpperCase() })} style={{ width: 80 }} />
          </label>
          <label className={s.field}>
            To
            <input value={pair.b} onChange={(e) => setPair({ ...pair, b: e.target.value.toUpperCase() })} style={{ width: 80 }} />
          </label>
          <label className={s.field}>
            Days from
            <input type="date" value={pair.from} onChange={(e) => setPair({ ...pair, from: e.target.value })} />
          </label>
          <label className={s.field}>
            to
            <input type="date" value={pair.to} onChange={(e) => setPair({ ...pair, to: e.target.value })} />
          </label>
          <button className={s.go} onClick={runPair}>
            Show
          </button>
          <span className={s.small + " " + s.muted}>A grey day is a day nobody searched: the engines cannot choose it, however cheap it may be.</span>
        </div>
        <div className={s.strip}>
          {pairDays.map((d) => {
            const empty = !d.graph.length && !d.memory.length;
            return (
              <div key={d.date} className={s.day} data-empty={empty ? 1 : 0}>
                <b>{new Date(d.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</b>
                {d.graph.map((e, i) => (
                  <p key={`g${i}`}>
                    €{e.price} <span className={s.muted}>{e.source === "graph" ? "night" : "memory"}</span>
                  </p>
                ))}
                {d.memory.map((m, i) => (
                  <p key={`m${i}`} title={`${m.src} to ${m.dst}, ${m.carriers.join(", ")}, ${m.stops ? m.stops + " stop" : "direct"}, seen ${m.seenAt}`}>
                    €{m.price} <span className={s.muted}>seen {m.seenAt.slice(5, 10)}</span>
                  </p>
                ))}
                {empty && <p className={s.muted}>never searched</p>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
