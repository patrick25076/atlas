// The access gate: Atlas is private until it is ready, so every page and API route asks for
// an access code first (proxy.ts at the repo root runs this on every request). Only Web
// Crypto and plain strings here, no Node modules and no imports from the rest of lib, because
// the proxy runs before any route and must stay small and dependency free.
//
// Environment:
//   ATLAS_ACCESS_CODE    the code a visitor types. Not set: the gate is OFF (a fresh clone and
//                        the dev server keep working) and a warning is logged once. On the
//                        production deployment (VERCEL_ENV=production) a missing code fails
//                        closed instead: everything but the public paths answers 503, so a
//                        dropped env var can never quietly make the live site public.
//   ATLAS_GATE_OFF=1     the deliberate way to run production with no gate at all.
//   ATLAS_COOKIE_SECRET  signs the cookie. Not set while a code is: a key derived from the
//                        code is used and a warning logged, so the gate still works.
//   ATLAS_GATE_DEV=1     turns the gate on under `next dev` too. Off by default, since
//                        localhost is not public and other scripts curl the dev server.
//
// The cookie `atlas_access` is "<timestamp>.<hex HMAC-SHA256>" over the timestamp and the
// code, so it expires after 90 days and changing the code signs everyone out. Scripts can
// send the header `x-atlas-access: <code>` instead of a cookie.

export const ACCESS_COOKIE = "atlas_access";
export const ACCESS_HEADER = "x-atlas-access";
export const ACCESS_MAX_AGE_S = 90 * 24 * 3600;

const enc = new TextEncoder();

export function accessCode(): string | null {
  return process.env.ATLAS_ACCESS_CODE?.trim() || null;
}

let warned = false;
/**
 * What the gate does on this deployment. "on": check the code. "off": let everyone in.
 * "misconfigured": production has no code, so everything except the public paths answers
 * 503. Logs once when the gate is off or misconfigured by omission.
 */
export function gateMode(): "on" | "off" | "misconfigured" {
  const code = accessCode();
  if (!code) {
    const prod = process.env.VERCEL_ENV === "production";
    // A public production site has to be a written choice (ATLAS_GATE_OFF=1), never the
    // accident of a dropped env var: without the code the live site fails closed.
    if (prod && process.env.ATLAS_GATE_OFF !== "1") {
      if (!warned) {
        warned = true;
        console.error("ACCESS GATE NOT CONFIGURED IN PRODUCTION: ATLAS_ACCESS_CODE is not set, answering 503 (SETUP.md §16)");
      }
      return "misconfigured";
    }
    if (!warned) {
      warned = true;
      console.warn(prod ? "access gate off in production: ATLAS_GATE_OFF=1" : "access gate off: ATLAS_ACCESS_CODE is not set");
    }
    return "off";
  }
  // `next dev` sets NODE_ENV=development; the gate stays off there unless asked for.
  if (process.env.NODE_ENV === "development" && process.env.ATLAS_GATE_DEV !== "1") return "off";
  return "on";
}

/** Whether requests must pass the gate (a misconfigured production counts as gated). */
export function gateEnabled(): boolean {
  return gateMode() !== "off";
}

/** The pause after every wrong code, typed or sent in the header: guessing is slow, no lockout. */
export const WRONG_CODE_DELAY_MS = 600;

// Wrong codes sent in the x-atlas-access header, per address. /api/access has its own limit;
// without this one the header would be a way around it, guessing at full request speed on
// any API path. A plain Map, pruned and bounded here, so this file stays import free.
const HEADER_TRIES_PER_MINUTE = 10;
const HEADER_WINDOW_MS = 60_000;
const HEADER_MAX_ADDRESSES = 5_000;
const headerWrong = new Map<string, { start: number; n: number }>();

/** Seconds this address must wait before its header is checked again; 0 when it may try now. */
export function headerRetryAfter(ip: string, now = Date.now()): number {
  const t = headerWrong.get(ip);
  if (!t || now - t.start >= HEADER_WINDOW_MS || t.n < HEADER_TRIES_PER_MINUTE) return 0;
  return Math.max(1, Math.ceil((t.start + HEADER_WINDOW_MS - now) / 1000));
}

/** Counts one wrong header code for this address. */
export function noteHeaderWrong(ip: string, now = Date.now()): void {
  const t = headerWrong.get(ip);
  if (t && now - t.start < HEADER_WINDOW_MS) t.n++;
  else {
    // Re-insert, so Map order stays oldest window first and the pruning below can stop early.
    headerWrong.delete(ip);
    headerWrong.set(ip, { start: now, n: 1 });
  }
  for (const [k, v] of headerWrong) {
    if (headerWrong.size <= HEADER_MAX_ADDRESSES && now - v.start < HEADER_WINDOW_MS) break;
    headerWrong.delete(k);
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
  let out = "";
  for (const b of sig) out += b.toString(16).padStart(2, "0");
  return out;
}

let warnedSecret = false;
function cookieSecret(code: string): string {
  const s = process.env.ATLAS_COOKIE_SECRET?.trim();
  if (s) return s;
  if (!warnedSecret) {
    warnedSecret = true;
    console.warn("access gate: ATLAS_COOKIE_SECRET is not set, signing cookies with a key derived from the code");
  }
  return `atlas-derived:${code}`;
}

/** A random key per process: both sides are signed with it, so comparing the two digests takes the same time whatever the inputs are, and their lengths leak nothing. */
let compareKey: Promise<CryptoKey> | null = null;
export async function safeEqual(a: string, b: string): Promise<boolean> {
  compareKey ??= crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const key = await compareKey;
  const [x, y] = await Promise.all([crypto.subtle.sign("HMAC", key, enc.encode(a)), crypto.subtle.sign("HMAC", key, enc.encode(b))]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

/** Whether the typed code is the access code (constant time). False when no code is set. */
export async function codeMatches(typed: string | null | undefined): Promise<boolean> {
  const code = accessCode();
  if (!code || typeof typed !== "string" || !typed.trim() || typed.length > 200) return false;
  return safeEqual(typed.trim().toLowerCase(), code.toLowerCase());
}

/** A fresh cookie value for a visitor who just typed the right code. */
export async function signAccess(now = Date.now()): Promise<string> {
  const code = accessCode();
  if (!code) throw new Error("no access code configured");
  const ts = String(now);
  return `${ts}.${await hmacHex(cookieSecret(code), `atlas-access:${ts}:${code}`)}`;
}

/** Whether a cookie value is ours, unexpired and signed for the current code. */
export async function verifyAccess(value: string | null | undefined, now = Date.now()): Promise<boolean> {
  const code = accessCode();
  if (!code || !value) return false;
  const m = /^(\d{10,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const ts = Number(m[1]);
  // A cookie from the future (clock skew aside) or older than its lifetime is refused.
  if (ts > now + 5 * 60_000 || now - ts > ACCESS_MAX_AGE_S * 1000) return false;
  return safeEqual(m[2], await hmacHex(cookieSecret(code), `atlas-access:${m[1]}:${code}`));
}

/**
 * Paths that stay open without the code: the gate itself, the read-only shared itinerary
 * pages and their images and calendar files (people open those from a chat, on a phone,
 * with no code), the place photos those pages ask for, Next's own assets and static files.
 */
export function isPublicPath(pathname: string, method: string): boolean {
  if (pathname === "/access" || pathname === "/api/access") return true;
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return true;
  // A shared itinerary: /i/<id> and its opengraph or twitter image (Next may add a suffix).
  if (/^\/i\/[A-Za-z0-9_-]{1,80}(\/(opengraph|twitter)-image[^/]*)?\/?$/.test(pathname)) return true;
  // The site's own preview image, so a link to the gate still unfurls.
  if (/^\/(opengraph|twitter)-image[^/]*$/.test(pathname)) return true;
  const read = method === "GET" || method === "HEAD";
  if (read && /^\/api\/itinerary\/[A-Za-z0-9_-]{1,80}(\/ics)?\/?$/.test(pathname) && !pathname.startsWith("/api/itinerary/save")) return true;
  // The shared page's photos come from here: a Wikivoyage summary cached a day, no paid API.
  if (read && pathname === "/api/place") return true;
  // Static files from public/ and the app's icon, manifest and robots: the last segment has
  // an extension. Never under /api, so an API route cannot be reached by adding ".json".
  if (!pathname.startsWith("/api/") && /\/[^/]+\.[A-Za-z0-9]{1,8}$/.test(pathname)) return true;
  return false;
}

/** Only same-origin paths: "/x?y" yes, "//evil.com", "https://...", "/\evil" or "/<TAB>/evil.com" no. */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string" || next.length > 2000) return "/";
  // The URL parser drops tabs and newlines and reads a backslash as a slash, so "/\t/evil.com"
  // would turn into "//evil.com", another site. Refuse any control character, whitespace or
  // backslash outright instead of guessing how a browser will read it.
  if (!next.startsWith("/") || next.startsWith("//") || /[\u0000-\u001f\u007f\s\\]/.test(next)) return "/";
  // Then resolve it the way the redirect will, and refuse anything that leaves our origin.
  let url: URL;
  try {
    url = new URL(next, "http://x");
  } catch {
    return "/";
  }
  if (url.origin !== "http://x") return "/";
  const path = url.pathname + url.search;
  if (path.startsWith("/access") || path.startsWith("/api/")) return "/";
  return path;
}

/** The caller's address as Vercel reports it (the first x-forwarded-for entry). */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "local";
}
