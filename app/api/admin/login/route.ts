import { NextResponse } from "next/server";
import { ADMIN_COOKIE, ADMIN_MAX_AGE_S, adminExists, adminKeyMatches, adminRefused, signAdmin } from "@/lib/admin";

// POST /api/admin/login  { key }: the owner's key (ATLAS_ADMIN_KEY) opens the engine room on this browser for 90 days
// (an httpOnly cookie). A wrong key waits 600 ms and answers 401. No engine room on this deployment: 404.
export async function POST(request: Request) {
  if (!adminExists()) return adminRefused();
  let typed: unknown = null;
  try {
    typed = ((await request.json()) as { key?: unknown })?.key;
  } catch {
    return NextResponse.json({ error: "send JSON: { key }" }, { status: 400 });
  }
  if (!adminKeyMatches(typed)) {
    await new Promise((r) => setTimeout(r, 600));
    return NextResponse.json({ error: "That is not the owner's key." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, signAdmin(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: ADMIN_MAX_AGE_S });
  return res;
}
