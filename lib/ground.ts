// Server-only. Where can you get by train and coach from a point: Dijkstra over the ground
// graph built by scripts/ingest/gtfs.ts. Times are in-vehicle minutes plus an expected wait per
// leg derived from how often the service runs (half the headway, 5 to 60 min; the first leg
// at most 15 because people plan their departure). Not a timetable, and labelled as such.
import graphJson from "@/public/data/ground-graph.json";
import { driveMinutes, haversineKm } from "./geo";

type Graph = {
  generatedAt: string;
  feeds: { id: string; name: string; licence: string; attribution: string }[];
  modes: string[];
  /** [name, lat, lon, neighbouring stations, departures per day, population, town when it differs] */
  stations: [string, number, number, number, number, number?, string?][];
  edges: [number, number, number, number, number][];
};
const graph = graphJson as unknown as Graph;

type Adj = { to: number; minutes: number; wait: number; mode: number };
const WALK = graph.modes.indexOf("walk");
const MINUTES_PER_WEEK = 7 * 24 * 60;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const adjacency: Adj[][] = graph.stations.map(() => []);
for (const [from, to, minutes, tripsPerWeek, mode] of graph.edges) {
  const wait = mode === WALK ? 0 : clamp(MINUTES_PER_WEEK / Math.max(1, tripsPerWeek) / 2, 5, 60);
  adjacency[from].push({ to, minutes, wait, mode });
}

class MinHeap {
  private cost: number[] = [];
  private node: number[] = [];
  get size() {
    return this.cost.length;
  }
  push(c: number, n: number) {
    this.cost.push(c);
    this.node.push(n);
    let i = this.cost.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.cost[0], this.node[0]];
    const lc = this.cost.pop()!;
    const ln = this.node.pop()!;
    if (this.cost.length) {
      this.cost[0] = lc;
      this.node[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.cost.length && this.cost[l] < this.cost[m]) m = l;
        if (r < this.cost.length && this.cost[r] < this.cost[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.cost[a], this.cost[b]] = [this.cost[b], this.cost[a]];
    [this.node[a], this.node[b]] = [this.node[b], this.node[a]];
  }
}

export type Reached = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  minutes: number;
  changes: number;
  mode: string;
  prev: number;
  links: number;
  depDay: number;
  pop: number;
  town?: string;
};

export type ReachResult = {
  starts: { id: number; name: string; lat: number; lon: number; minutes: number }[];
  reached: Reached[];
  generatedAt: string;
  feeds: Graph["feeds"];
  stations: number;
};

export function reachFrom(lat: number, lon: number, maxMinutes = 600, accessKm = 40): ReachResult {
  const n = graph.stations.length;
  const best = new Float64Array(n).fill(Infinity);
  const legs = new Int16Array(n);
  const prev = new Int32Array(n).fill(-1);
  const lastMode = new Int8Array(n).fill(-1);
  const heap = new MinHeap();
  const starts: ReachResult["starts"] = [];

  graph.stations.forEach(([name, slat, slon], i) => {
    const km = haversineKm(lat, lon, slat, slon);
    if (km > accessKm) return;
    const cost = driveMinutes(km);
    best[i] = cost;
    heap.push(cost, i);
    starts.push({ id: i, name, lat: slat, lon: slon, minutes: cost });
  });

  while (heap.size) {
    const [cost, u] = heap.pop();
    if (cost > best[u]) continue;
    if (cost > maxMinutes) break;
    for (const e of adjacency[u]) {
      const vehicle = e.mode !== WALK;
      const wait = !vehicle ? 0 : legs[u] === 0 ? Math.min(e.wait, 15) : e.wait;
      const c = cost + wait + e.minutes;
      if (c < best[e.to]) {
        best[e.to] = c;
        legs[e.to] = legs[u] + (vehicle ? 1 : 0);
        prev[e.to] = u;
        lastMode[e.to] = e.mode;
        heap.push(c, e.to);
      }
    }
  }

  const reached: Reached[] = [];
  for (let i = 0; i < n; i++) {
    if (best[i] > maxMinutes || legs[i] === 0) continue;
    const [name, slat, slon, links, depDay, pop, town] = graph.stations[i];
    reached.push({
      id: i,
      name,
      lat: slat,
      lon: slon,
      minutes: Math.round(best[i]),
      changes: Math.max(0, legs[i] - 1),
      mode: graph.modes[lastMode[i]] ?? "rail",
      prev: prev[i],
      links: links ?? 0,
      depDay: depDay ?? 0,
      pop: pop ?? 0,
      town: town || undefined,
    });
  }
  reached.sort((a, b) => a.minutes - b.minutes);
  starts.sort((a, b) => a.minutes - b.minutes);
  return { starts, reached, generatedAt: graph.generatedAt, feeds: graph.feeds, stations: n };
}

/** Station coordinates by id, for drawing a path the client reconstructs from `prev`. */
export function stationPoint(id: number): [number, number] | null {
  const s = graph.stations[id];
  return s ? [s[2], s[1]] : null;
}
