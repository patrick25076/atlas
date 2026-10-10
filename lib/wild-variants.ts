// Server-only. Not one trip but a few, ranked against each other: the balanced loop, the
// cheapest-at-any-cost loop, the comfortable one (short flights, few stops), the one that
// skips the hub trick and flies straight from home. Each is built in parallel from live
// fares, judged by the model, and ranked by verdict and price per day. All are stored.
import { buildWild, customKey, wildPath, type Tradeoff, type WildParams, type WildTrip } from "./wild";
import { judgeTrip } from "./judge";
import { readJson, writeJson } from "./boards-store";
import { mainGateway } from "./board";

export type Variant = { label: string; tradeoff: Tradeoff; noHubs?: boolean };
export const VARIANTS: Variant[] = [
  { label: "Balanced", tradeoff: "balanced" },
  { label: "Price first", tradeoff: "price" },
  { label: "Comfort first", tradeoff: "comfort" },
  { label: "Home airports only", tradeoff: "balanced", noHubs: true },
];

export type RankedTrip = WildTrip & { variant: string; rank: number; score: number };

export async function buildWildVariants(p: Omit<WildParams, "tradeoff" | "noHubs" | "onProgress">, n = 3, onProgress?: (line: string) => void): Promise<RankedTrip[]> {
  const chosen = VARIANTS.slice(0, Math.max(1, Math.min(VARIANTS.length, n)));
  const gw = mainGateway(p.gateways);
  const results = await Promise.all(
    chosen.map(async (v) => {
      const custom = customKey(p.countries, p.prefer, p.maxStops, p.nightsPerStop, v.tradeoff, v.noHubs);
      const path = wildPath(gw, p.region, p.month, p.nights, p.style, p.budget, custom);
      const stored = await readJson<WildTrip>(path);
      if (stored && stored.ageHours < 24) return { v, trip: stored.body };
      const built = await buildWild({ ...p, tradeoff: v.tradeoff, noHubs: v.noHubs, onProgress: (line) => onProgress?.(`${v.label}: ${line}`) }).catch(() => null);
      if (!built) return { v, trip: null };
      const judge = await judgeTrip(built);
      const trip = { ...built, judge: judge ?? undefined };
      await writeJson(path, trip).catch(() => null);
      return { v, trip };
    }),
  );
  const ok = results.filter((r): r is { v: Variant; trip: WildTrip } => !!r.trip);
  // Score: the judge's verdict first, then cheaper per day, then fewer hours in transit.
  const scored = ok.map(({ v, trip }) => ({ ...trip, variant: v.label, rank: 0, score: Math.round(((trip.judge?.score ?? 50) * 1.0 - trip.totals.perDay * 0.15 - trip.totals.hoursInAir * 0.2) * 10) / 10 }));
  scored.sort((a, b) => b.score - a.score);
  // Two variants that landed on the same chain are one trip.
  const seen = new Set<string>();
  const unique = scored.filter((t) => !seen.has(t.title) && seen.add(t.title));
  return unique.map((t, i) => ({ ...t, rank: i + 1 }));
}
