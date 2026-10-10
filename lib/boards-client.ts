// Browser side of /api/board: a stored board arrives as one JSON document, a live search as
// NDJSON lines. Either way the caller gets deals as they come and a final summary.
import type { Board } from "./board";
import type { Deal } from "./types";

/** The board without its deals, plus the route's note on a live run that found nothing (rate-limited). */
export type BoardMeta = Omit<Board, "deals"> & { note?: string };

const isAbort = (err: unknown) => (err as Error | undefined)?.name === "AbortError";

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
    if (!isAbort(err)) on.error("network");
    return;
  }
  if (!res.ok) {
    on.error(`search failed (${res.status})`);
    return;
  }
  if (!res.headers.get("content-type")?.includes("ndjson")) {
    let board: Board;
    try {
      board = (await res.json()) as Board;
    } catch (err) {
      // An aborted body read (the visitor changed month or airport) is not an error to show.
      if (!isAbort(err)) on.error("the board could not be read");
      return;
    }
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
  try {
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
  } catch (err) {
    // reader.read() rejects with AbortError when the controller aborts mid-stream. That is the
    // caller leaving, not a failure: no callback, no unhandled rejection in the console.
    if (isAbort(err) || signal?.aborted) return;
    on.error("the search stopped early");
    return;
  }
  if (!finished && !signal?.aborted) on.error("the search stopped early");
}

/**
 * Reads an NDJSON body line by line and hands every parsed object to `onLine`. Shared by the
 * finder, the wild builder and the A to B route search, which all stream progress lines and
 * results the same way. Resolves true when the stream ended on its own, false when it was
 * aborted; a partial last line (the connection cut mid-object) is dropped, never thrown.
 */
export async function readNdjson<T>(res: Response, onLine: (msg: T) => void, signal?: AbortSignal): Promise<boolean> {
  const reader = res.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let buf = "";
  try {
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
        // Only the parse is guarded: a partial or malformed line is skipped, the next one is
        // whole. An error thrown by the handler itself is the caller's to see, never swallowed.
        let msg: T;
        try {
          msg = JSON.parse(line) as T;
        } catch {
          continue;
        }
        onLine(msg);
      }
    }
  } catch (err) {
    if (isAbort(err) || signal?.aborted) return false;
    throw err;
  }
  return !signal?.aborted;
}
