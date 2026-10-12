import { NextResponse } from "next/server";
import { ACCESS_COOKIE, ACCESS_MAX_AGE_S, WRONG_CODE_DELAY_MS, accessCode, clientIp, codeMatches, safeNext, signAccess } from "@/lib/access";
import { TtlLru } from "@/lib/memo";

// POST /api/access  body JSON { code, next? } or a form post (code, next) from /access.
// The right code sets the `atlas_access` cookie (90 days): JSON gets { ok, next }, a form
// gets a 303 to `next` (same-origin paths only). A wrong code waits 600 ms and answers 401
// (JSON) or sends the form back with an error. Ten tries a minute per address, then 429.
// DELETE /api/access clears the cookie. 0 Kiwi searches, no model calls.
export const maxDuration = 30;

const WRONG_DELAY_MS = WRONG_CODE_DELAY_MS;
const TRIES_PER_MINUTE = 10;
// Bounded: an address that stops trying falls out after a minute, the map never grows past 5,000.
const tries = new TtlLru<{ start: number; n: number }>(5_000, 60_000);

function tooMany(ip: string): number {
  const now = Date.now();
  const t = tries.get(ip);
  if (!t || now - t.start >= 60_000) {
    tries.set(ip, { start: now, n: 1 });
    return 0;
  }
  t.n++;
  tries.set(ip, t);
  return t.n > TRIES_PER_MINUTE ? Math.ceil((t.start + 60_000 - now) / 1000) : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  const isForm = type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data");
  let code = "";
  let next = "/";
  try {
    if (isForm) {
      const f = await request.formData();
      code = String(f.get("code") ?? "");
      next = safeNext(String(f.get("next") ?? "/"));
    } else {
      const j = (await request.json()) as { code?: unknown; next?: unknown };
      code = typeof j.code === "string" ? j.code : "";
      next = safeNext(typeof j.next === "string" ? j.next : "/");
    }
  } catch {
    return NextResponse.json({ error: "send JSON: { code }" }, { status: 400 });
  }

  const back = (error: string) => {
    const u = new URL("/access", request.url);
    if (next !== "/") u.searchParams.set("next", next);
    u.searchParams.set("e", error);
    return NextResponse.redirect(u, 303);
  };

  const wait = tooMany(clientIp(request.headers));
  if (wait) {
    if (isForm) return back("slow");
    return NextResponse.json({ error: "too many tries, wait a minute" }, { status: 429, headers: { "Retry-After": String(wait) } });
  }
  if (!accessCode()) {
    // No code configured: the gate is off, there is nothing to unlock.
    return isForm ? NextResponse.redirect(new URL(next, request.url), 303) : NextResponse.json({ ok: true, next, gate: "off" });
  }
  if (!(await codeMatches(code))) {
    // The same pause for every wrong code makes guessing slow without a lockout.
    await sleep(WRONG_DELAY_MS);
    return isForm ? back("wrong") : NextResponse.json({ error: "wrong code" }, { status: 401 });
  }

  const res = isForm ? NextResponse.redirect(new URL(next, request.url), 303) : NextResponse.json({ ok: true, next });
  res.cookies.set(ACCESS_COOKIE, await signAccess(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ACCESS_MAX_AGE_S,
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
