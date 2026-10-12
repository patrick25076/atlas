import { adminAllowed, adminRefused } from "@/lib/admin";
import { listJson, readJson } from "@/lib/boards-store";

// GET /api/admin/bench: the newest benchmark (scripts/bench.ts, stored in Blob as bench/latest.json) and the list of
// earlier runs. GET /api/admin/bench?path=bench/2026-10-12.json: one earlier run.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!adminAllowed(request)) return adminRefused();
  const p = new URL(request.url).searchParams.get("path");
  const path = p && /^bench\/[\w.-]+\.json$/.test(p) ? p : "bench/latest.json";
  const [doc, files] = await Promise.all([readJson<{ generatedAt?: string }>(path), listJson("bench/", 100).catch(() => [])]);
  const history = files
    .map((f) => ({ path: f.pathname, at: f.uploadedAt }))
    .filter((f) => f.path !== "bench/latest.json")
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, 30);
  return Response.json({ path, bench: doc?.body ?? null, history });
}
