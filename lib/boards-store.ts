// Server-only. Boards live in Vercel Blob (public store, BLOB_READ_WRITE_TOKEN), not in git:
// a hundred airports refreshed nightly would grow the repository by megabytes a day. Without
// the token (a fresh checkout) everything still works, just without a cache.
import { head, put } from "@vercel/blob";
import type { Board } from "./board";

export function boardPath(gateway: string, month?: string): string {
  return `boards/${gateway}${month ? `-${month}` : ""}.json`;
}

export function hasStore(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** The stored board and its age in hours, or null when there is none. */
export async function readBoard(gateway: string, month?: string): Promise<{ board: Board; ageHours: number } | null> {
  if (!hasStore()) return null;
  try {
    const meta = await head(boardPath(gateway, month));
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    const board = (await res.json()) as Board;
    return { board, ageHours: (Date.now() - Date.parse(board.updated)) / 3_600_000 };
  } catch {
    return null;
  }
}

/** Any JSON document in the store, with its age in hours. */
export async function readJson<T extends { generatedAt?: string; updated?: string }>(path: string): Promise<{ body: T; ageHours: number } | null> {
  if (!hasStore()) return null;
  try {
    const meta = await head(path);
    const res = await fetch(meta.url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as T;
    const at = Date.parse(body.generatedAt ?? body.updated ?? meta.uploadedAt.toISOString());
    return { body, ageHours: (Date.now() - at) / 3_600_000 };
  } catch {
    return null;
  }
}

export async function writeJson(path: string, body: unknown): Promise<string | null> {
  if (!hasStore()) return null;
  const r = await put(path, JSON.stringify(body), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 600 });
  return r.url;
}

export async function writeBoard(board: Board): Promise<string | null> {
  if (!hasStore()) return null;
  const r = await put(boardPath(board.gateway, board.month), JSON.stringify(board), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 600,
  });
  return r.url;
}
