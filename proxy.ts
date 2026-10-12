import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE,
  ACCESS_HEADER,
  WRONG_CODE_DELAY_MS,
  accessCode,
  clientIp,
  codeMatches,
  gateMode,
  headerRetryAfter,
  isPublicPath,
  noteHeaderWrong,
  verifyAccess,
} from "@/lib/access";

// The access gate (Next 16 calls this file proxy.ts; it was middleware.ts before, and it runs
// on the Node.js runtime by default). Every request without a valid `atlas_access` cookie or
// an `x-atlas-access: <code>` header is sent to /access (pages) or answered 401 (API routes),
// except the public paths in lib/access.ts. The rules and the environment are explained
// there and in SETUP.md §16.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STORE = { "Cache-Control": "no-store" };

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Under `next dev` the gate is off unless ATLAS_GATE_DEV=1; the header x-atlas-gate-test: 1
  // turns it on for one request, so the gate can be tested locally without locking out the
  // other scripts that curl the same dev server. It does nothing in a production build.
  const forced = process.env.NODE_ENV === "development" && request.headers.get("x-atlas-gate-test") === "1" && !!accessCode();
  const mode = forced ? "on" : gateMode();
  if (mode === "off") return NextResponse.next();

  if (mode === "misconfigured") {
    // Production without a code: the shared itinerary links and static files still work,
    // everything else (the /access form included, it could not check anything) is closed.
    if (isPublicPath(pathname, request.method) && pathname !== "/access" && pathname !== "/api/access") return NextResponse.next();
    return pathname.startsWith("/api/")
      ? NextResponse.json({ error: "Atlas is not configured" }, { status: 503, headers: NO_STORE })
      : new NextResponse("Atlas is not configured yet.", { status: 503, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (isPublicPath(pathname, request.method)) return NextResponse.next();
  if (await verifyAccess(request.cookies.get(ACCESS_COOKIE)?.value)) return NextResponse.next();
  const header = request.headers.get(ACCESS_HEADER);
  if (header) {
    // The header gets the same protection as the /access form: ten wrong codes a minute per
    // address, then 429, and a pause after every wrong one, so it is no faster way to guess.
    const ip = clientIp(request.headers);
    const wait = headerRetryAfter(ip);
    if (wait) return NextResponse.json({ error: "too many tries, wait a minute" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(wait) } });
    if (await codeMatches(header)) return NextResponse.next();
    noteHeaderWrong(ip);
    await sleep(WRONG_CODE_DELAY_MS);
    return NextResponse.json({ error: "wrong code" }, { status: 401, headers: NO_STORE });
  }

  const isApi = pathname.startsWith("/api/");
  const isPage = !isApi && (request.method === "GET" || request.method === "HEAD");
  if (!isPage) {
    return NextResponse.json({ error: "access code required" }, { status: 401, headers: NO_STORE });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  const next = pathname + request.nextUrl.search;
  if (next !== "/") url.searchParams.set("next", next);
  const res = NextResponse.redirect(url, 307);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = {
  // Next's build assets never need the gate; everything else goes through the function above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
