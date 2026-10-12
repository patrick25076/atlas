// Server-only. Query parameter checks shared by the API routes, so every route answers a bad
// request with a 400 and a plain sentence instead of searching Kiwi with garbage. Each helper
// returns the cleaned value or null; the route decides the message.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

/** YYYY-MM-DD that is a real calendar date. */
export function isoDay(v: string | null | undefined): string | null {
  if (!v || !DAY.test(v)) return null;
  const t = Date.parse(v + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  // Date.parse accepts 2026-02-31 and rolls it over; compare the round trip.
  return new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** YYYY-MM with a real month. */
export function isoMonth(v: string | null | undefined): string | null {
  if (!v || !MONTH.test(v)) return null;
  const m = Number(v.slice(5, 7));
  return m >= 1 && m <= 12 ? v : null;
}

/** A three-letter IATA airport or city code, upper-cased. */
export function iata(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  return CODE.test(s) ? s : null;
}

/** A comma list of IATA codes, de-duplicated, at most `max`; empty when none is valid. */
export function iataList(v: string | null | undefined, max = 5): string[] {
  const out: string[] = [];
  for (const part of (v ?? "").split(",")) {
    const c = iata(part);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** A two-letter country code, upper-cased. */
export function iso2(v: string | null | undefined): string | null {
  const s = (v ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

/** A point on Earth. */
export function latLon(lat: string | null | undefined, lon: string | null | undefined): { lat: number; lon: number } | null {
  // Number(null) and Number("") are 0: a missing point must not become the Gulf of Guinea.
  if (lat == null || lon == null || String(lat).trim() === "" || String(lon).trim() === "") return null;
  const a = Number(lat);
  const b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lon: b };
}

/** An integer clamped into [min, max]; `fallback` when absent or not a number. */
export function intIn(v: string | null | undefined, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** One of a fixed set of words, or the default. */
export function oneOf<T extends string>(v: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

/** Today in UTC as YYYY-MM-DD. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A JSON 400 with a plain message. */
export function bad(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}
