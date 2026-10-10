// Source 17, worldwide: a board of the cheapest return getaways for every popular airport,
// searched on Kiwi.com nightly and stored in Vercel Blob (never in git). Sharded so several
// GitHub runners, each with its own address, share the work.
//
// Usage: pnpm ingest:boards                       (all gateways)
//        BOARDS_SHARD=2/6 pnpm ingest:boards      (one shard of six)
//        BOARDS_GATEWAYS=OTP,CLJ pnpm ingest:boards
import { buildBoard, popularGateways } from "../../lib/board";
import { hasStore, writeBoard } from "../../lib/boards-store";
import { DESTINATIONS } from "./destinations";

/** Home-market airports get the favourite destinations one by one, on top of the countries. */
const HOME = ["OTP", "CLJ", "IAS", "TSR", "SBZ", "GHV", "CRA"];
const LIMIT = Number(process.env.BOARDS_LIMIT) || 150;

if (!hasStore()) {
  console.error("BLOB_READ_WRITE_TOKEN missing: boards are stored in Vercel Blob (SETUP.md §12)");
  process.exit(1);
}

let gateways = process.env.BOARDS_GATEWAYS ? process.env.BOARDS_GATEWAYS.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : [...HOME, ...popularGateways(LIMIT).filter((g) => !HOME.includes(g))];
const shard = process.env.BOARDS_SHARD?.match(/^(\d+)\/(\d+)$/);
if (shard) {
  const [i, n] = [Number(shard[1]), Number(shard[2])];
  gateways = gateways.filter((_, idx) => idx % n === i);
}
console.log(`${gateways.length} gateways${shard ? ` (shard ${shard[0]})` : ""}: ${gateways.join(" ")}`);

let calls = 0;
let failed = 0;
let stored = 0;
const t0 = Date.now();
for (const gw of gateways) {
  const t1 = Date.now();
  try {
    const board = await buildBoard(gw, { extraCities: HOME.includes(gw) ? DESTINATIONS : [], concurrency: 3, pauseMs: 150 });
    calls += board.searched + board.failed;
    failed += board.failed;
    if (board.deals.length === 0) {
      console.log(`  ${gw}: no deals (${board.failed} failed); keeping the old board`);
      continue;
    }
    if (board.partial) console.log(`  ${gw}: partial (throttled), ${board.deals.length} deals`);
    await writeBoard(board);
    stored++;
    console.log(`  ${gw}: ${board.deals.length} deals to ${new Set(board.deals.map((d) => d.dstCity)).size} cities, cheapest €${board.deals[0]?.price}, ${board.searched} searches, ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    if (board.partial) {
      console.log("  throttled; stopping this shard to let the address cool down");
      break;
    }
  } catch (err) {
    console.log(`  ${gw}: ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`boards: ${stored} stored, ${calls} searches (${failed} failed), ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
