// Browser side of /api/board: a stored board arrives as one JSON document, a live search as
// NDJSON lines. Either way the caller gets deals as they come and a final summary.
import type { Board } from "./board";
import type { Deal } from "./types";

export type BoardMeta = Omit<Board, "deals">;

export async function fetchBoard(
  gateway: string,
  month: string | null,
  on: { deals: (deals: Deal[]) => void; done: (meta: BoardMeta, source: "stored" | "live") => void; error: (note: string) => void },
  signal?: AbortSignal,
): Promise<void> {
  const url = `/api/board?from=${gateway}${month ? `&month=${month}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if ((err as Error).name !== "AbortError") on.error("network");
    return;
  }
  if (!res.ok) {
    on.error(`search failed (${res.status})`);
    return;
  }
  if (!res.headers.get("content-type")?.includes("ndjson")) {
    const board = (await res.json()) as Board;
    on.deals(board.deals);
    const { deals: _deals, ...meta } = board;
    void _deals;
    on.done(meta, "stored");
    return;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    on.error("no stream");
    return;
  }
  const decoder = new TextDecoder();
  let buf = "";
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      let msg: { deals?: Deal[]; done?: BoardMeta; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.deals) on.deals(msg.deals);
      if (msg.done) {
        finished = true;
        on.done(msg.done, "live");
      }
      if (msg.error) {
        finished = true;
        on.error(msg.error);
      }
    }
  }
  if (!finished) on.error("the search stopped early");
}
