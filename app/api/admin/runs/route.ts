import { adminAllowed, adminRefused } from "@/lib/admin";
import { getRun, listRuns } from "@/lib/db";
import { deviceOf, runLogOn } from "@/lib/run-log";

// GET /api/admin/runs[?after=<id>][&mine=1][&kind=search|chat|walk|way-home][&limit=60]: the newest runs, for the
// engine room's Live tab to poll. `me` is this browser's device tag, so the tab can say which runs were yours.
// GET /api/admin/runs?id=<id>: one run with its steps.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!adminAllowed(request)) return adminRefused();
  const p = new URL(request.url).searchParams;
  const me = deviceOf(request);
  const id = Number(p.get("id"));
  if (Number.isFinite(id) && id > 0) {
    const run = await getRun(id);
    return run ? Response.json({ me, run }) : Response.json({ error: "no such run" }, { status: 404 });
  }
  const after = Number(p.get("after")) || undefined;
  const kind = p.get("kind")?.trim() || undefined;
  const runs = await listRuns({ after, kind, limit: Number(p.get("limit")) || 60, ...(p.get("mine") === "1" ? { device: me } : {}) });
  return Response.json({ me, on: runLogOn(), runs });
}
