// Server-only. The deals a server route reasons about: the stored boards of the visitor's
// airports (Vercel Blob), with the committed Romanian file as the fallback when there is no
// store or no board yet. Memoised for ten minutes per gateway.
import dealsJson from "@/public/data/deals.json";
import { readBoard } from "./boards-store";
import type { Deal, DealsFile } from "./types";

const FALLBACK = dealsJson as unknown as DealsFile;
const memo = new Map<string, { at: number; deals: Deal[]; updated: string }>();
const TTL = 10 * 60_000;

export async function dealsFor(gateways: string[], month?: string): Promise<{ deals: Deal[]; updated: string; gateways: string[] }> {
  const wanted = gateways.filter((g) => /^[A-Z]{3}$/.test(g)).slice(0, 4);
  const out: Deal[] = [];
  const found: string[] = [];
  let updated = "";
  for (const gw of wanted) {
    const key = `${gw}|${month ?? ""}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < TTL) {
      out.push(...hit.deals);
      found.push(gw);
      if (hit.updated > updated) updated = hit.updated;
      continue;
    }
    const stored = await readBoard(gw, month);
    if (!stored) continue;
    memo.set(key, { at: Date.now(), deals: stored.board.deals, updated: stored.board.updated });
    out.push(...stored.board.deals);
    found.push(gw);
    if (stored.board.updated > updated) updated = stored.board.updated;
  }
  if (out.length) return { deals: out.sort((a, b) => a.price - b.price), updated, gateways: found };
  const fallback = FALLBACK.deals.filter((d) => !wanted.length || wanted.includes(d.gw));
  return { deals: fallback.length ? fallback : FALLBACK.deals, updated: FALLBACK.updated, gateways: FALLBACK.gateways };
}
