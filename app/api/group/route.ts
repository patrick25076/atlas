import { cleanCodes } from "@/lib/been";
import { logSearch } from "@/lib/db";
import { GroupInputError, groupTrip, type GroupMember } from "@/lib/group";
import { bad, intIn, isoDay } from "@/lib/params";

// POST /api/group  body { members: [{ name, origins: ["BBU","OTP"], available: [{ from, to }] }],
//                        minNights, maxNights, where?, direct?, exclude? }
// exclude is the "Been" list (ISO2, an array or a comma string): no option lands in those
// countries and no search is spent on them; a connection through one is fine.
// Friends from different cities meet somewhere: the windows that fit everyone (or all but one
// by a day), then for the best windows the cities where the sum of everyone's fares is lowest,
// including each member's own city as a host. Live searches per window: airport groups (at
// most 4) x targets (at most 4) + a few fill-in and host searches; three windows (two with
// four groups): 25 to 45 searches in practice, never more than about 55. Answers are kept in
// memory for half an hour, except an empty one caused by refused searches (failed > 0).
export const maxDuration = 180;
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * A calendar day from a JSON value. A real date passes lib/params.isoDay (its round trip
 * refuses 2026-02-31, which Date.parse would roll to March). A value shaped like a date
 * that is not one is handed to the engine as is, so GroupInputError can name it instead of
 * the window vanishing in silence; anything else is dropped.
 */
const dayOf = (s: unknown): string | null => (typeof s === "string" ? (isoDay(s) ?? (DAY_SHAPE.test(s) ? s : null)) : null);

export async function POST(request: Request) {
  let body: { members?: unknown; minNights?: unknown; maxNights?: unknown; where?: unknown; direct?: unknown; exclude?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("a JSON body is required");
  }
  const raw = Array.isArray(body.members) ? (body.members as Record<string, unknown>[]).slice(0, 8) : [];
  const members: GroupMember[] = raw.map((m) => ({
    name: String(m.name ?? "").trim().slice(0, 40) || "someone",
    origins: Array.isArray(m.origins) ? (m.origins as unknown[]).map((o) => String(o).trim().toUpperCase()).filter((o) => /^[A-Z]{3}$/.test(o)).slice(0, 3) : [],
    available: Array.isArray(m.available)
      ? (m.available as Record<string, unknown>[])
          .map((w) => ({ from: dayOf(w.from), to: dayOf(w.to) }))
          .filter((w): w is { from: string; to: string } => !!w.from && !!w.to && w.to >= w.from)
          .slice(0, 6)
      : [],
  }));
  if (members.length < 2) return bad("at least two members, each with origins (airport codes) and available windows (YYYY-MM-DD from and to)");
  const incomplete = members.find((m) => !m.origins.length || !m.available.length);
  if (incomplete) return bad(`${incomplete.name} needs airport codes and at least one available window`);
  const minNights = intIn(body.minNights == null ? null : String(body.minNights), 1, 30, 2);
  const maxNights = intIn(body.maxNights == null ? null : String(body.maxNights), minNights, 30, Math.max(minNights, 4));
  const where = typeof body.where === "string" ? body.where.trim().slice(0, 80) || undefined : undefined;
  const direct = body.direct === true || body.direct === 1 || body.direct === "1";
  const exclude = cleanCodes(body.exclude);
  const t0 = Date.now();
  try {
    const r = await groupTrip({ members, minNights, maxNights, where, direct, exclude });
    // The usage log, never awaited; the members' names stay out of it, only their airports and how many windows each gave.
    void logSearch("group", { members: members.length, origins: members.map((m) => m.origins), windows: members.map((m) => m.available.length), minNights, maxNights, where, direct, excluded: exclude.length }, r.options.length, Date.now() - t0).catch(() => null);
    if (!r.options.length && r.searched === 0 && r.failed > 0) return Response.json({ error: "The flight search refused every request just now (Kiwi is throttling this address). Try again in a few minutes.", ...r }, { status: 502, headers: { "Cache-Control": "no-store" } });
    return Response.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof GroupInputError) return bad(err.message);
    return Response.json({ error: err instanceof Error ? err.message : "group search failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
