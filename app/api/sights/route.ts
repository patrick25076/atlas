import { NextResponse } from "next/server";
import { getSights } from "@/lib/sights";

export type { Sight, Sights } from "@/lib/sights";

// GET /api/sights?name=Gdańsk → what to see and do there, from the Wikivoyage article's
// listings (CC BY-SA 4.0): name, a line of description, coordinates, a photo where the
// article has one, plus the article's own Events section when it has one. Cached a week.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 80) return NextResponse.json({ error: "name required" }, { status: 400 });
  const body = await getSights(name);
  if (!body) return NextResponse.json(null, { headers: { "Cache-Control": "public, max-age=3600" } });
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" } });
}
