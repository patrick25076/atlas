import citiesJson from "@/public/data/cities.json";
import { adminAllowed, adminRefused } from "@/lib/admin";
import { fareSightings } from "@/lib/db";
import { cheapestTripsIn, loadFlightGraph, placeOf, type FlightEdge, type TripsQuery } from "@/lib/flight-graph";
import type { City } from "@/lib/types";

// GET /api/admin/graph?op=…: the nightly price graph as the engines see it (the admin's engine room).
//   op=stats                                   what the graph holds: edges, sources, days, every city with flights out
//   op=from&code=HAN[&from=&to=]               the flights out of a city (or airport), by day, cheapest first
//   op=pair&a=HAN&b=VTE[&from=&to=]            one hop: what the graph holds and every sighting in the fare memory
//   op=trips&q=<TripsQuery json>               the label-setting search with its trace (alternatives per flight)
// Reads only: the graph from Blob (cached), the fare memory from Postgres. No live search.
export const maxDuration = 60;

const CITIES = citiesJson as unknown as Record<string, City>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayIso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const code = (v: string | null) => (v ?? "").trim().toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
const edgeRow = (e: FlightEdge) => ({ from: e.f, fromCity: e.fc, to: e.t, toCity: e.tc, toName: placeOf(e.tc)?.name ?? e.t, date: e.d, depart: e.h || undefined, price: e.p, minutes: e.m, stops: e.s, carrier: e.c || undefined, url: e.u || undefined, source: e.src, seen: e.w || undefined });
const airportsOf = (c: string) => (CITIES[c]?.airports?.length ? CITIES[c].airports : [c]);

export async function GET(request: Request) {
  if (!adminAllowed(request)) return adminRefused();
  const p = new URL(request.url).searchParams;
  const op = p.get("op") ?? "stats";
  const g = await loadFlightGraph();
  const from = DAY.test(p.get("from") ?? "") ? p.get("from")! : null;
  const to = DAY.test(p.get("to") ?? "") ? p.get("to")! : null;
  const inWindow = (e: FlightEdge) => (!from || e.d >= from) && (!to || e.d <= to);

  if (op === "stats") {
    const byCity = new Map<string, { n: number; days: Set<number>; dests: Set<string>; memory: number }>();
    const perDay = new Map<string, number>();
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of g.edges) {
      const c = byCity.get(e.fc) ?? { n: 0, days: new Set<number>(), dests: new Set<string>(), memory: 0 };
      c.n++;
      c.days.add(e.dn);
      c.dests.add(e.tc);
      if (e.src === "memory") c.memory++;
      byCity.set(e.fc, c);
      perDay.set(e.d, (perDay.get(e.d) ?? 0) + 1);
      lo = Math.min(lo, e.dn);
      hi = Math.max(hi, e.dn);
    }
    const cities = [...byCity.entries()]
      .map(([k, v]) => {
        const pl = placeOf(k);
        return { code: k, name: pl?.name ?? k, country: pl?.country ?? "", lat: pl?.lat ?? 0, lon: pl?.lon ?? 0, edges: v.n, days: v.days.size, destinations: v.dests.size, fromMemory: v.memory };
      })
      .sort((a, b) => b.edges - a.edges);
    return Response.json({
      graphDate: g.graphDate,
      loadedAt: g.loadedAt,
      loadMs: g.loadMs,
      shards: g.shards,
      bytes: g.bytes,
      edges: g.edges.length,
      fromGraph: g.fromGraph,
      fromMemory: g.fromMemory,
      thin: !!g.thin,
      days: Number.isFinite(lo) ? { from: dayIso(lo), to: dayIso(hi) } : null,
      perDay: [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ date: d, edges: n })),
      cities,
    });
  }

  if (op === "from") {
    const c = code(p.get("code"));
    if (!c) return Response.json({ error: "code is needed" }, { status: 400 });
    const rows = g.edges.filter((e) => (e.fc === c || e.f === c) && inWindow(e)).sort((a, b) => a.d.localeCompare(b.d) || a.p - b.p);
    return Response.json({ code: c, place: placeOf(c), count: rows.length, edges: rows.slice(0, 1500).map(edgeRow) });
  }

  if (op === "pair") {
    const a = code(p.get("a"));
    const b = code(p.get("b"));
    if (!a || !b) return Response.json({ error: "a and b are needed" }, { status: 400 });
    const graph = g.edges.filter((e) => (e.fc === a || e.f === a) && (e.tc === b || e.t === b) && inWindow(e)).sort((x, y) => x.d.localeCompare(y.d) || x.p - y.p);
    const today = new Date().toISOString().slice(0, 10);
    const memory = await fareSightings(airportsOf(a), airportsOf(b), from ?? today, to ?? dayIso(Math.floor(Date.now() / 86_400_000) + 180));
    return Response.json({ a: placeOf(a), b: placeOf(b), graph: graph.map(edgeRow), memory });
  }

  if (op === "trips") {
    let q: TripsQuery;
    try {
      q = JSON.parse(p.get("q") ?? "");
    } catch {
      return Response.json({ error: "q must be a TripsQuery as JSON" }, { status: 400 });
    }
    const r = cheapestTripsIn(g, { ...q, trace: true });
    return Response.json(r);
  }

  return Response.json({ error: "op is stats, from, pair or trips" }, { status: 400 });
}
