// The engine room (app/admin, app/api/admin/*) is the owner's own view of how Atlas decides: the walk's every
// candidate, the beam, the price graph, and the Live tab's record of what every search and chat turn did. Open under
// `next dev`. On a deployment it needs the owner's key (ATLAS_ADMIN_KEY), typed once at /admin, which sets a signed
// cookie for 90 days; without the key set the engine room does not exist there (404). It sits behind the access gate
// too, so a visitor needs the access code first and the owner's key on top.
import { createHmac, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "atlas_admin";
export const ADMIN_MAX_AGE_S = 90 * 24 * 3600;

const dev = () => process.env.NODE_ENV !== "production";
const key = () => process.env.ATLAS_ADMIN_KEY?.trim() || "";
/** The shortest key that opens anything (the owner chose a short one; shorter than this counts as not set). */
const MIN_KEY = 6;

/** Whether this deployment has an engine room at all: always under dev, with a key elsewhere. */
export function adminExists(): boolean {
  return dev() || key().length >= MIN_KEY;
}

const sign = (ts: string) => createHmac("sha256", key()).update(`atlas-admin:${ts}`).digest("hex");
const same = (a: string, b: string) => {
  const x = createHmac("sha256", "cmp").update(a).digest();
  const y = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(x, y);
};

/** A fresh cookie value after the right key was typed. */
export function signAdmin(now = Date.now()): string {
  const ts = String(now);
  return `${ts}.${sign(ts)}`;
}

/** Whether the typed key is the owner's (constant time). */
export function adminKeyMatches(typed: unknown): boolean {
  const k = key();
  return k.length >= MIN_KEY && typeof typed === "string" && typed.length <= 200 && same(typed.trim(), k);
}

/** Whether a cookie header carries a valid owner cookie (or this is the dev server). */
export function adminFromCookieHeader(header: string | null | undefined): boolean {
  if (dev()) return true;
  if (!adminExists() || !header) return false;
  const m = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=(\\d{10,16})\\.([0-9a-f]{64})`).exec(header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (ts > Date.now() + 5 * 60_000 || Date.now() - ts > ADMIN_MAX_AGE_S * 1000) return false;
  return same(m[2], sign(m[1]));
}

/** For route handlers: may this request use the engine room? */
export function adminAllowed(request?: Request): boolean {
  if (dev()) return true;
  return !!request && adminFromCookieHeader(request.headers.get("cookie"));
}

/** The answer when it may not: a plain 404, so the route does not even say it exists. */
export function adminRefused(): Response {
  return new Response("Not found", { status: 404 });
}
