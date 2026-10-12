"use client";

import { useMemo, useState } from "react";
import type { GraphTrip, TripsResult } from "@/lib/flight-graph";
import AdminMap, { type MapDot, type MapLine } from "./AdminMap";
import s from "./admin.module.css";

// The Search tab's first step, alone: the label-setting search (a Dijkstra on euros) over the price graph. Nodes are
// (city, day); a label is a half-built trip (where, which day, which cities so far, what it cost); the cheapest open
// label is always extended next, so the first trips closed are the cheapest the graph holds. For every flight of a
// trip, the trace lists the other flights out of the same city a day either side: what it was chosen over.

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

export default function GraphTrips() {
  const [f, setF] = useState({ label: "Brasov", lat: 45.657, lon: 25.601, home: "RO", from: addDays(today(), 10), to: addDays(today(), 40), minNights: 4, maxNights: 6, nppLo: 2, nppHi: 3, minPlaces: 2, maxPlaces: 3, tradeoff: "price", ground: 330 });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [res, setRes] = useState<TripsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    setSel(0);
    const q = { origin: { lat: f.lat, lon: f.lon, label: f.label }, homeCountry: f.home, from: f.from, to: f.to, minNights: f.minNights, maxNights: f.maxNights, nightsPerPlace: [f.nppLo, f.nppHi], minPlaces: f.minPlaces, maxPlaces: f.maxPlaces, top: 15, tradeoff: f.tradeoff, groundMaxMin: f.ground };
    try {
      const r = await fetch(`/api/admin/graph?op=trips&q=${encodeURIComponent(JSON.stringify(q))}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setRes(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const trip: GraphTrip | undefined = res?.trips[sel];
  const { dots, lines } = useMemo(() => {
    const dots: MapDot[] = [];
    const lines: MapLine[] = [];
    if (!trip) return { dots, lines };
    const pts: [number, number][] = [[f.lon, f.lat], ...trip.stops.map((x) => [x.lon, x.lat] as [number, number]), [f.lon, f.lat]];
    pts.slice(1).forEach((p, i) => lines.push({ id: `t${i}`, from: pts[i], to: p, color: "#6ff0c4", width: 3, opacity: 1 }));
    dots.push({ id: "home", lat: f.lat, lon: f.lon, color: "#7cc4ff", size: 6, label: f.label });
    trip.stops.forEach((x) => dots.push({ id: x.code, lat: x.lat, lon: x.lon, color: "#6ff0c4", size: 6, label: `${x.name} ${x.nights}n` }));
    return { dots, lines };
  }, [trip, f.lat, f.lon, f.label]);

  return (
    <>
      <p className={s.lead}>
        What the Search tab does first, alone. Every flight in the price graph is an edge from (city, day) to (city, day); trains and coaches from the ground graph join them; a stay is
        an edge of 2 to 3 nights. The search always grows the <b>cheapest half-built trip</b> next, so the first trips it closes are the cheapest the graph can make: exact, but only over
        what the graph knows. Cost = <b>euros + hours × the style&apos;s rate + 12 euro a change of plane</b>.
      </p>
      <div className={s.form}>
        <label className={s.field}>
          From
          <input value={f.label} onChange={(e) => set({ label: e.target.value })} style={{ width: 100 }} />
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
            <input type="number" value={f.minNights} onChange={(e) => set({ minNights: +e.target.value })} /> to <input type="number" value={f.maxNights} onChange={(e) => set({ maxNights: +e.target.value })} />
          </span>
        </label>
        <label className={s.field}>
          A place
          <span>
            <input type="number" value={f.nppLo} onChange={(e) => set({ nppLo: +e.target.value })} /> to <input type="number" value={f.nppHi} onChange={(e) => set({ nppHi: +e.target.value })} />
          </span>
        </label>
        <label className={s.field}>
          Places
          <span>
            <input type="number" value={f.minPlaces} min={1} onChange={(e) => set({ minPlaces: +e.target.value })} /> to <input type="number" value={f.maxPlaces} min={1} onChange={(e) => set({ maxPlaces: +e.target.value })} />
          </span>
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
          Train or coach up to (min)
          <input type="number" value={f.ground} onChange={(e) => set({ ground: +e.target.value })} />
        </label>
        <button className={s.go} onClick={run} disabled={busy}>
          {busy ? "Searching…" : "Find the cheapest"}
        </button>
        <span className={s.small + " " + s.muted}>No live search: the graph only.</span>
      </div>
      {err && <p className={s.warn}>{err}</p>}
      {res && (
        <p className={s.small + " " + s.muted}>
          {res.trips.length} trips · {res.explored.toLocaleString("en-GB")} labels explored over {res.edges.toLocaleString("en-GB")} flights · {res.ms} ms · home airports {res.homeAirports.map((h) => `${h.code} (${Math.round(h.minutes)} min, ~€${h.price})`).join(", ")}
          {res.note ? ` · ${res.note}` : ""}
        </p>
      )}
      <div className={s.grid2}>
        <div className={s.card}>
          <h3>The cheapest trips, in order</h3>
          {res?.trips.map((t, i) => (
            <button key={i} className={s.loop} data-sel={sel === i ? 1 : 0} onClick={() => setSel(i)}>
              <b>€{t.total}</b>
              {t.stops.map((x) => x.name).join(" → ")}
              <div className={s.small + " " + s.muted}>
                {t.start} to {t.end} · {t.nights} nights · €{t.flights} flights + €{t.ground} ground · {t.hours} h
              </div>
            </button>
          ))}
          {res && !res.trips.length && <p className={s.muted}>No trip closes inside this window with what the graph holds.</p>}
        </div>
        <div>
          <AdminMap dots={dots} lines={lines} height={380} fitKey={`${sel}-${res?.ms ?? ""}`} />
        </div>
      </div>
      {trip && (
        <div className={s.card} style={{ marginTop: 16 }}>
          <h3>Why this trip · each leg and what it beat</h3>
          <ol className={s.notes}>
            {trip.why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
          {trip.legs.map((l, i) => (
            <div key={i} className={s.leg} data-kind={l.kind}>
              <b>
                {l.fromName} → {l.toName}
              </b>{" "}
              <span className={s.muted}>
                {l.date}
                {l.depart ? ` ${l.depart}` : ""} · {l.kind} · {Math.round(l.minutes / 6) / 10} h · €{l.price}
                {l.kind === "fly" ? ` · ${l.stops ? `${l.stops} stop` : "direct"} · ${l.source}${l.seen ? `, seen ${l.seen.slice(0, 16).replace("T", " ")}` : ""}` : " (estimated, 0.10 euro a km)"}
              </span>
              {l.alternatives && l.alternatives.length > 0 && (
                <table className={s.table} style={{ marginTop: 6 }}>
                  <thead>
                    <tr>
                      <th>Other flights out of {l.fromName}, a day either side</th>
                      <th>Day</th>
                      <th className={s.num}>Price</th>
                      <th className={s.num}>Hours</th>
                      <th>Stops</th>
                      <th>Why not this one</th>
                    </tr>
                  </thead>
                  <tbody>
                    {l.alternatives.map((a, j) => (
                      <tr key={j}>
                        <td>{a.toName}</td>
                        <td className={s.mono}>{a.date}</td>
                        <td className={s.num}>€{a.price}</td>
                        <td className={s.num}>{Math.round(a.minutes / 6) / 10}</td>
                        <td>{a.stops ? a.stops : "direct"}</td>
                        <td className={s.small + " " + s.muted}>
                          {a.same ? (a.price < l.price ? "same place, cheaper on another day: the days around it did not fit the nights" : a.price === l.price ? "same place, same price, another day" : "same place, dearer") : a.price < l.price ? "cheaper, but the rest of the trip from there cost more (or did not close)" : a.price === l.price ? "same price, but the rest of the trip from there cost more" : "dearer"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
