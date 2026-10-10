import { NextResponse } from "next/server";
import { bad } from "@/lib/params";
import { itineraryIcs, loadItinerary, PLAN_KEY_RE, SAVED_ID_RE } from "@/lib/itinerary-server";

// GET /api/itinerary/<id>/ics  the itinerary as a calendar file (RFC 5545): one all-day
// event per stop, one event per leg (timed in UTC when the leg has a departure time and the
// city's time zone is known, all-day otherwise). Public, like the share link it comes from.
export const maxDuration = 30;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!SAVED_ID_RE.test(id) && !PLAN_KEY_RE.test(id)) return bad("that is not an itinerary id");
  const got = await loadItinerary(id);
  if (!got) return NextResponse.json({ error: "no itinerary with that id; it may have been deleted" }, { status: 404 });
  const body = itineraryIcs(got.itinerary, id, new URL(request.url).origin);
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="atlas-${id}.ics"`,
      "Cache-Control": "public, max-age=60",
    },
  });
}
