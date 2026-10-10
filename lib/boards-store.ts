// Server-only. Boards live in Vercel Blob (public store, BLOB_READ_WRITE_TOKEN), not in git:
// a hundred airports refreshed nightly would grow the repository by megabytes a day. Without
// the token (a fresh checkout) everything still works, just without a cache.
//
// Every read goes through a ten-minute in-memory cache (bounded, least recently used), so a
// hot board is fetched from Blob once per warm instance, not on every request; a write puts
// the new document straight into that cache. A document that Blob says does not exist (a
// real 404) is remembered as missing for a minute; any other failure (a network blip, a 5xx,
// a timeout) is not cached as missing, because that would turn a two-second Blob hiccup into
// a minute of live rebuilds that then overwrite good stored boards. Instead the last copy
// this instance saw is kept for a day and served when a refresh fails. Also the home of the
// "hotels/" snapshots and the stored wild trips and plans: any JSON document under any path.
import { BlobNotFoundError, head, list, put } from "@vercel/blob";
import type { Board } from "./board";
import { TtlLru } from "./memo";

const READ_TTL_MS = 10 * 60_000;
const READ_MAX = 500;
/** How long the last good copy is kept as a fallback for a failed refresh. */
const STALE_TTL_MS = 24 * 3_600_000;
/** path → the parsed document and the time it was fetched or written. */
const docs = new TtlLru<{ body: unknown; fetchedAt: number }>(READ_MAX, READ_TTL_MS);
/** path → the last good copy, served when Blob cannot be reached (never when it says 404). */
const stale = new TtlLru<{ body: unknown; uploadedAt: Date }>(READ_MAX, STALE_TTL_MS);
/** path → "missing" so a board that does not exist is not asked for again every second. */
const missing = new TtlLru<true>(READ_MAX, 60_000);

export function boardPath(gateway: string, month?: string): string {
  return `boards/${gateway}${month ? `-${month}` : ""}.json`;
}

export function hasStore(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** The time a stored document says it was generated, or when the blob was uploaded. */
function stampOf(body: { generatedAt?: string; updated?: string }, uploadedAt?: Date): number {
  const own = Date.parse(body.generatedAt ?? body.updated ?? "");
  if (Number.isFinite(own)) return own;
  return uploadedAt?.getTime() ?? Date.now();
}

/**
 * Fetches a document from Blob by path; null when missing. Fills the read cache. A 404 is
 * cached as missing for a minute; any other failure returns the last good copy when there
 * is one, else null, and caches nothing (the next caller tries Blob again).
 */
async function fetchDoc<T>(path: string): Promise<{ body: T; uploadedAt: Date } | null> {
  if (!hasStore()) return null;
  if (missing.get(path)) return null;
  const fallback = (): { body: T; uploadedAt: Date } | null => {
    const last = stale.get(path);
    if (!last) return null;
    const got = { body: last.body as T, uploadedAt: last.uploadedAt };
    // Re-arm the short cache with the stale copy so a Blob outage costs one failed call per ten minutes, not one per request.
    docs.set(path, { body: got.body, fetchedAt: Date.now() });
    return got;
  };
  try {
    const meta = await head(path);
    const res = await fetch(meta.url, { cache: "no-store" });
    if (res.status === 404) {
      missing.set(path, true);
      return null;
    }
    if (!res.ok) {
      console.log(`blob: ${path}: ${res.status}, ${stale.get(path) ? "serving the last copy" : "no copy to serve"}`);
      return fallback();
    }
    const body = (await res.json()) as T;
    docs.set(path, { body, fetchedAt: Date.now() });
    stale.set(path, { body, uploadedAt: meta.uploadedAt });
    return { body, uploadedAt: meta.uploadedAt };
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      missing.set(path, true);
      return null;
    }
    console.log(`blob: ${path}: ${err instanceof Error ? err.message.slice(0, 120) : err}, ${stale.get(path) ? "serving the last copy" : "no copy to serve"}`);
    return fallback();
  }
}

/** The stored board and its age in hours, or null when there is none. */
export async function readBoard(gateway: string, month?: string): Promise<{ board: Board; ageHours: number } | null> {
  const path = boardPath(gateway, month);
  const cached = docs.get(path);
  if (cached) {
    const board = cached.body as Board;
    return { board, ageHours: (Date.now() - stampOf(board)) / 3_600_000 };
  }
  const got = await fetchDoc<Board>(path);
  if (!got) return null;
  return { board: got.body, ageHours: (Date.now() - stampOf(got.body, got.uploadedAt)) / 3_600_000 };
}

/** Any JSON document in the store, with its age in hours. */
export async function readJson<T extends { generatedAt?: string; updated?: string }>(path: string): Promise<{ body: T; ageHours: number } | null> {
  const cached = docs.get(path);
  if (cached) {
    const body = cached.body as T;
    return { body, ageHours: (Date.now() - stampOf(body)) / 3_600_000 };
  }
  const got = await fetchDoc<T>(path);
  if (!got) return null;
  return { body: got.body, ageHours: (Date.now() - stampOf(got.body, got.uploadedAt)) / 3_600_000 };
}

/** Forget a cached document (after a write elsewhere, or when a caller wants a fresh read). */
export function forget(path: string): void {
  docs.delete(path);
  stale.delete(path);
  missing.delete(path);
}

export async function writeJson(path: string, body: unknown): Promise<string | null> {
  if (!hasStore()) return null;
  const r = await put(path, JSON.stringify(body), { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json", cacheControlMaxAge: 600 });
  docs.set(path, { body, fetchedAt: Date.now() });
  stale.set(path, { body, uploadedAt: new Date() });
  missing.delete(path);
  return r.url;
}

export async function writeBoard(board: Board): Promise<string | null> {
  return writeJson(boardPath(board.gateway, board.month), board);
}

export type StoredFile = { pathname: string; url: string; uploadedAt: string; size: number };

/**
 * The documents under a prefix, newest upload first. One page of up to `limit` (Blob lists
 * 1,000 a page; snapshots are a few dozen). Empty without a store.
 */
export async function listJson(prefix: string, limit = 100): Promise<StoredFile[]> {
  if (!hasStore()) return [];
  try {
    const r = await list({ prefix, limit: Math.min(1000, Math.max(1, limit)) });
    return r.blobs
      .map((b) => ({ pathname: b.pathname, url: b.url, uploadedAt: new Date(b.uploadedAt).toISOString(), size: b.size }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  } catch (err) {
    console.log(`blob: list ${prefix}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
    return [];
  }
}
