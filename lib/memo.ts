// Server-only. One bounded memo for every route and library that keeps answers in memory.
// A plain Map grows until the process dies, which on a warm serverless instance is hours of
// unique query strings; this one evicts the least recently used entry past `max` and treats
// anything older than `ttlMs` as missing. Small on purpose: get, set, delete, size.
export class TtlLru<V> {
  private readonly map = new Map<string, { at: number; v: V }>();

  constructor(
    private readonly max = 500,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  /** The value when it exists and is younger than the TTL; touching it makes it most recent. */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so Map iteration order (oldest first) doubles as the LRU order.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.v;
  }

  /** Age of an entry in milliseconds, or null when missing or expired. */
  ageMs(key: string): number | null {
    const hit = this.map.get(key);
    if (!hit || Date.now() - hit.at > this.ttlMs) return null;
    return Date.now() - hit.at;
  }

  set(key: string, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { at: Date.now(), v });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Runs `fn` once per key while it is in flight: a second caller with the same key waits for
 * the first promise instead of starting a second search. The entry is dropped when settled.
 */
export class InFlight<V> {
  private readonly jobs = new Map<string, Promise<V>>();

  run(key: string, fn: () => Promise<V>): { promise: Promise<V>; mine: boolean } {
    const existing = this.jobs.get(key);
    if (existing) return { promise: existing, mine: false };
    const promise = fn().finally(() => this.jobs.delete(key));
    this.jobs.set(key, promise);
    return { promise, mine: true };
  }

  get size(): number {
    return this.jobs.size;
  }
}

/**
 * Sends a keep-alive line while a long job runs, so a streaming response never goes quiet for
 * more than `everyMs` (proxies and Vercel close idle streams). Call `stop()` when done.
 */
export function keepAlive(send: (line: unknown) => void, everyMs = 15_000, text = "Still searching…"): { stop: () => void; touch: () => void } {
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last >= everyMs) {
      send({ progress: text });
      last = Date.now();
    }
  }, Math.max(1000, Math.floor(everyMs / 3)));
  return {
    stop: () => clearInterval(timer),
    // Any real line resets the clock, so the filler only appears during real silence.
    touch: () => {
      last = Date.now();
    },
  };
}
