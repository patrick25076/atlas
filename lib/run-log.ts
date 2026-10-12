// Server-only. The run log: what Atlas did for each request, for the owner's engine room (Live tab). A route starts
// a run (a search, a chat turn, a walk, a way home) and every engine it calls adds steps to it on the way, without
// being handed anything: the run rides along in an AsyncLocalStorage, so lib/search.ts, lib/graph-walk.ts and the
// chat's tools just call step(). When the request is done the route saves the run as one row (lib/db.ts runs).
//
// What is kept: the question (places rounded to a town, no exact coordinates), the steps with their timings and
// errors, a short summary of the answer, and for a walk its trace (the beam and every way out it weighed). Rows older
// than seven days are dropped as new ones come in. Off without DATABASE_URL, or with ATLAS_RUN_LOG=0.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { ACCESS_COOKIE } from "./access";
import { insertRun } from "./db";

export type RunStep = { t: number; kind: string; title: string; ms?: number; error?: string; data?: unknown };
export type RunRecord = {
  kind: "search" | "chat" | "walk" | "way-home" | "route" | "other";
  source: string;
  device: string;
  title: string;
  input?: unknown;
  startedAt: number;
  steps: RunStep[];
  result?: unknown;
  error?: string;
};

const als = new AsyncLocalStorage<RunRecord>();
const MAX_STEPS = 400;

export function runLogOn(): boolean {
  return !!process.env.DATABASE_URL?.trim() && process.env.ATLAS_RUN_LOG?.trim() !== "0";
}

/** Which browser asked: a short hash of its access cookie (never the cookie), "local" under the dev server. */
export function deviceOf(request: Request): string {
  const raw = request.headers.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${ACCESS_COOKIE}=([^;]+)`).exec(raw);
  if (!m) return process.env.NODE_ENV === "production" ? "script" : "local";
  return createHash("sha256").update(m[1]).digest("hex").slice(0, 8);
}

/** A new run for this request; null when the log is off. */
export function newRun(request: Request, init: Pick<RunRecord, "kind" | "source" | "title"> & { input?: unknown }): RunRecord | null {
  if (!runLogOn()) return null;
  return { ...init, device: deviceOf(request), startedAt: Date.now(), steps: [] };
}

/** Runs fn with the run as the current one, so every step() inside lands in it. */
export function withRun<T>(rec: RunRecord | null, fn: () => T): T {
  return rec ? als.run(rec, fn) : fn();
}

export function currentRun(): RunRecord | undefined {
  return als.getStore();
}

/** Adds a step to the current run (a no-op outside one). ms: how long it took; data: kept small (see small()). */
export function step(kind: string, title: string, opts: { ms?: number; error?: string; data?: unknown } = {}, rec = currentRun()): void {
  if (!rec || rec.steps.length >= MAX_STEPS) return;
  rec.steps.push({ t: Date.now() - rec.startedAt, kind, title: title.slice(0, 300), ...(opts.ms != null ? { ms: Math.round(opts.ms) } : {}), ...(opts.error ? { error: opts.error.slice(0, 500) } : {}), ...(opts.data !== undefined ? { data: opts.data } : {}) });
}

/** Saves the run, never throwing and never holding the answer up for long. */
export async function saveRun(rec: RunRecord | null): Promise<void> {
  if (!rec) return;
  try {
    const ms = Date.now() - rec.startedAt;
    const errors = rec.steps.filter((x) => x.error).length + (rec.error ? 1 : 0);
    let body = JSON.stringify({ input: rec.input, steps: rec.steps, result: rec.result, error: rec.error });
    // A very long run (a big walk) keeps its steps but not their bulky data.
    if (body.length > 1_500_000) body = JSON.stringify({ input: rec.input, steps: rec.steps.map(({ data, ...x }) => ({ ...x, ...(x.kind === "walk" ? { data: "(trace too large to keep)" } : {}) })), result: rec.result, error: rec.error, trimmed: true });
    await insertRun({ kind: rec.kind, source: rec.source, device: rec.device, title: rec.title.slice(0, 200), ms, errors, body });
  } catch (err) {
    console.log(`run log: ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
}

/**
 * A value cut down to what a person reads: strings to 300 characters, arrays to their first 6 (with the count),
 * objects to 4 levels, `raw` payloads dropped. For tool inputs and outputs, which can be large.
 */
export function small(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (depth >= 4) return Array.isArray(v) ? `[${v.length} items]` : "{…}";
  if (Array.isArray(v)) {
    const head = v.slice(0, 6).map((x) => small(x, depth + 1));
    return v.length > 6 ? [...head, `…${v.length - 6} more`] : head;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "raw" || typeof x === "function") continue;
      out[k] = small(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/**
 * The chat's tools, each wrapped so its call lands in the run: the input, a short form of the output, how long it
 * took, and a failure (thrown, or an `error` in its answer). The tool runs with the run as the current one, so a walk
 * inside it adds its own trace. Tools that stream (async generators) are followed to their last value.
 */
export function recordTools<T extends Record<string, unknown>>(tools: T, rec: RunRecord | null): T {
  if (!rec) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(tools)) {
    const tool = t as { execute?: (input: unknown, opts: unknown) => unknown };
    if (typeof tool?.execute !== "function") {
      out[name] = t;
      continue;
    }
    const ex = tool.execute.bind(tool);
    const done = (input: unknown, t0: number, value: unknown, thrown?: unknown) => {
      const answerError = value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string" ? (value as { error: string }).error : undefined;
      const err = thrown != null ? (thrown instanceof Error ? thrown.message : String(thrown)) : answerError;
      step("tool", name, { ms: Date.now() - t0, ...(err ? { error: err } : {}), data: { input: small(input), output: small(value) } }, rec);
    };
    out[name] = {
      ...tool,
      execute: (input: unknown, opts: unknown) => {
        const t0 = Date.now();
        let result: unknown;
        try {
          result = withRun(rec, () => ex(input, opts));
        } catch (e) {
          done(input, t0, undefined, e);
          throw e;
        }
        if (result && typeof result === "object" && Symbol.asyncIterator in (result as object)) {
          const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
          return (async function* () {
            let last: unknown;
            try {
              for (;;) {
                const r = await withRun(rec, () => it.next());
                if (r.done) break;
                last = r.value;
                yield r.value;
              }
              done(input, t0, last);
            } catch (e) {
              done(input, t0, last, e);
              throw e;
            }
          })();
        }
        return Promise.resolve(result).then(
          (v) => {
            done(input, t0, v);
            return v;
          },
          (e) => {
            done(input, t0, undefined, e);
            throw e;
          },
        );
      },
    };
  }
  return out as T;
}

/** A place to a town, never a doorstep: coordinates rounded to about 10 km. */
export const roughly = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined);
