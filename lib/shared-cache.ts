// Server-only. Answers shared across every server instance and every visitor, for an hour. The in-process memos
// (lib/memo.ts TtlLru) only help when a repeat lands on the same warm instance; on Vercel two requests a minute apart
// can land on two instances, so the same search ran twice. Here the answer is kept in Postgres (lib/db.ts answers)
// under a hash of its question: the same search, walk or way home asked again within the hour, by anyone, is read
// back in a few tens of milliseconds and runs no engine and no live search. Off without DATABASE_URL.
import { createHash } from "node:crypto";
import { getAnswer, putAnswer } from "./db";

/** How long a shared answer stands: the owner's "the same search three times in the same hour must not re-run". */
export const SHARED_TTL_MS = 60 * 60_000;
/** Answers bigger than this are not shared (a walk with every loop it found stays well under). */
const MAX_BYTES = 2_000_000;
/** A lookup slower than this is given up: the engines answer instead. */
const LOOKUP_CAP_MS = 1_500;

const on = () => !!process.env.DATABASE_URL?.trim() && process.env.ATLAS_SHARED_CACHE?.trim() !== "0";
const hashOf = (kind: string, key: string) => `${kind}:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/** The shared answer to this question, if one was kept within ttlMs; null otherwise (or after LOOKUP_CAP_MS). */
export async function sharedGet<T>(kind: string, key: string, ttlMs = SHARED_TTL_MS): Promise<{ value: T; ageMs: number } | null> {
  if (!on()) return null;
  const hit = await Promise.race([getAnswer(hashOf(kind, key), ttlMs), new Promise<null>((r) => setTimeout(() => r(null), LOOKUP_CAP_MS))]);
  if (!hit) return null;
  return { value: hit.body as T, ageMs: Date.now() - Date.parse(hit.at) };
}

/** Keeps the answer for everyone; never throws, never holds anything up (the caller need not await it). */
export async function sharedPut(kind: string, key: string, value: unknown): Promise<void> {
  if (!on()) return;
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_BYTES) return;
    await putAnswer(hashOf(kind, key), kind, json);
  } catch {
    // a cache that cannot keep is no cache, not an error
  }
}
