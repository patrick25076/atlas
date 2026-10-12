// The benchmark (docs/plans/one-brain.md, step 3): every case of bench/cases.json through each brain (the classic
// engines and the one brain), scored on the cheapest door-to-door price found against the best any brain found and
// the owner's own answer (gold). Runs the search in this process, no cache (each case is asked fresh), and by default
// with no live search at all (budget 0: the price map only), so it costs nothing and can run every night.
//
// Usage: pnpm bench                       budget 0, both brains, prints the table and stores bench/latest.json in Blob
//        pnpm bench --live=12             each case may spend 12 live searches per brain (the live check runs)
//        pnpm bench --only=sea-wild,lisbon-exact  --brains=one  --no-store
import fs from "node:fs";
import path from "node:path";

process.env.ATLAS_SHARED_CACHE = "0";
process.env.ATLAS_RUN_LOG = "0";
const { runSearch } = await import("../lib/search");
const { doorPrice } = await import("../lib/trip-result");
const { hasStore, writeJson } = await import("../lib/boards-store");
type SearchQuery = import("../lib/trip-result").SearchQuery;
type TripResult = import("../lib/trip-result").TripResult;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "1"]));
const live = Math.max(0, Math.min(40, Number(args.live ?? 0) || 0));
const brains = String(args.brains ?? "classic,one").split(",").filter((b) => b === "classic" || b === "one") as ("classic" | "one")[];
const only = args.only ? new Set(String(args.only).split(",")) : null;

const spec = JSON.parse(fs.readFileSync(path.join(process.cwd(), "bench", "cases.json"), "utf8")) as {
  from: SearchQuery["from"];
  cases: { id: string; label: string; from?: SearchQuery["from"]; query: Record<string, unknown>; gold?: { price?: number; note?: string } }[];
};

const today = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
/** "+12d" to a day from today, "next" to next month; anything else as written. */
function resolve(v: unknown): unknown {
  if (typeof v === "string") {
    const m = /^\+(\d+)d$/.exec(v);
    if (m) return addDays(today, Number(m[1]));
    if (v === "next") {
      const d = new Date(today + "T00:00:00Z");
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
    }
    return v;
  }
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
  return v;
}

type Score = { count: number; cheapest: number | null; cheapestTitle: string; top: { title: string; door: number; source: string; badges: string[]; engine: string; out: string; back?: string }[]; estimates: number; checkedLive: number; ms: number; searched: number; engines: string[]; note?: string; error?: string };
const out: { id: string; label: string; gold?: { price?: number; note?: string }; query: unknown; brains: Record<string, Score>; best: number | null; regret: Record<string, number | null> }[] = [];

for (const c of spec.cases) {
  if (only && !only.has(c.id)) continue;
  const query = { from: c.from ?? spec.from, ...(resolve(c.query) as object), budget: live } as SearchQuery;
  const row: (typeof out)[number] = { id: c.id, label: c.label, gold: c.gold, query, brains: {}, best: null, regret: {} };
  for (const brain of brains) {
    const t0 = Date.now();
    const seen = new Map<string, TripResult>();
    try {
      const done = await runSearch({ ...query, engine: brain }, (line) => {
        if ("results" in line) for (const r of line.results) seen.set(r.id, r);
      });
      const list = [...seen.values()].sort((a, b) => doorPrice(a) - doorPrice(b));
      row.brains[brain] = {
        count: list.length,
        cheapest: list.length ? doorPrice(list[0]) : null,
        cheapestTitle: list[0]?.title ?? "",
        top: list.slice(0, 5).map((t) => ({ title: t.title, door: doorPrice(t), source: t.source, badges: t.badges, engine: t.engine, out: t.out, ...(t.back ? { back: t.back } : {}) })),
        estimates: list.filter((t) => t.source === "estimate").length,
        checkedLive: list.filter((t) => t.badges.includes("checked live")).length,
        ms: Date.now() - t0,
        searched: done.searched,
        engines: done.engines,
        ...(done.note ? { note: done.note.slice(0, 400) } : {}),
      };
    } catch (err) {
      row.brains[brain] = { count: 0, cheapest: null, cheapestTitle: "", top: [], estimates: 0, checkedLive: 0, ms: Date.now() - t0, searched: 0, engines: [], error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }
  const prices = Object.values(row.brains).map((b) => b.cheapest).filter((x): x is number => x != null);
  if (c.gold?.price != null) prices.push(c.gold.price);
  row.best = prices.length ? Math.min(...prices) : null;
  for (const b of brains) row.regret[b] = row.best != null && row.brains[b].cheapest != null ? row.brains[b].cheapest! - row.best : null;
  out.push(row);
  const cells = brains.map((b) => {
    const s = row.brains[b];
    return `${b}: ${s.error ? "ERROR " + s.error.slice(0, 60) : s.cheapest != null ? `€${s.cheapest} ${s.cheapestTitle} (${s.count} trips, ${(s.ms / 1000).toFixed(1)} s, ${s.estimates} estimates, ${s.checkedLive} live)` : "nothing"}`;
  });
  console.log(`${c.id.padEnd(22)} best €${row.best ?? "-"}${c.gold?.price != null ? ` (gold €${c.gold.price})` : ""}\n   ${cells.join("\n   ")}`);
}

const summary = Object.fromEntries(
  brains.map((b) => {
    const rows = out.filter((r) => r.regret[b] != null);
    return [b, { cases: out.length, answered: rows.length, wins: out.filter((r) => r.regret[b] === 0).length, meanRegret: rows.length ? Math.round(rows.reduce((a, r) => a + (r.regret[b] ?? 0), 0) / rows.length) : null, meanMs: Math.round(out.reduce((a, r) => a + (r.brains[b]?.ms ?? 0), 0) / Math.max(1, out.length)) }];
  }),
);
const result = { generatedAt: new Date().toISOString(), date: today, live, brains, summary, cases: out };
console.log("\nsummary:", JSON.stringify(summary));
fs.mkdirSync(path.join(process.cwd(), "bench", "results"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "bench", "results", "latest.json"), JSON.stringify(result, null, 2));
if (!args["no-store"] && hasStore()) {
  await writeJson("bench/latest.json", result);
  await writeJson(`bench/${today}${live ? `-live${live}` : ""}.json`, result);
  console.log("stored bench/latest.json in Blob");
}
process.exit(0);
