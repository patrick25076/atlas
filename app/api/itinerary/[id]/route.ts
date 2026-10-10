import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { forget, hasStore, readJson, writeJson } from "@/lib/boards-store";
import { deleteTrip, getTrip } from "@/lib/db";
import { bad } from "@/lib/params";
import { indexPathOf, loadItinerary, ownerHash, ownerOf, PLAN_KEY_RE, SAVED_ID_RE, savedPathOf, type OwnerIndex, type SavedDoc } from "@/lib/itinerary-server";

// GET /api/itinerary/<id>  the itinerary behind a share link, public: anyone with the link
// may read it (that is what sharing means). <id> is a saved id (8 characters) or the key of a
// cached plan (11 characters, the X-Itinerary-Key header of POST /api/itinerary).
// DELETE /api/itinerary/<id>  header x-atlas-owner: only the browser that saved it. Removes
// the Blob copy, the line in the owner's list and the database row. Every instance reads a
// saved itinerary through to the store (loadItinerary), so the link and the /i page go dark
// at once; only the CDN may answer one more time from its 60-second copy.
export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!SAVED_ID_RE.test(id) && !PLAN_KEY_RE.test(id)) return bad("that is not an itinerary id");
  const got = await loadItinerary(id);
  if (!got) return NextResponse.json({ error: "no itinerary with that id; it may have been deleted" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(got.itinerary, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" } });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!SAVED_ID_RE.test(id)) return bad("that is not a saved itinerary id");
  const owner = ownerOf(request);
  if (!owner) return bad("send the x-atlas-owner header: 8 to 64 letters, digits or hyphens");
  const path = savedPathOf(id);
  const doc = await readJson<SavedDoc>(path);
  const row = doc ? null : await getTrip(id);
  if (!doc && !row) return NextResponse.json({ error: "no itinerary with that id" }, { status: 404 });
  const theirs = doc ? doc.body.ownerHash === ownerHash(owner) : row!.owner === owner;
  if (!theirs) return NextResponse.json({ error: "only the browser that saved this itinerary can delete it" }, { status: 403 });
  if (doc && hasStore()) {
    try {
      await del(path);
    } catch (err) {
      console.log(`itinerary delete: blob ${err instanceof Error ? err.message.slice(0, 160) : err}`);
      return NextResponse.json({ error: "the itinerary could not be deleted; try again in a minute" }, { status: 502 });
    }
    forget(path);
    const index = await readJson<OwnerIndex>(indexPathOf(owner));
    if (index?.body?.items?.some((x) => x.id === id)) await writeJson(indexPathOf(owner), { items: index.body.items.filter((x) => x.id !== id), generatedAt: new Date().toISOString() } satisfies OwnerIndex).catch(() => null);
  }
  await deleteTrip(owner, id);
  return NextResponse.json({ deleted: id }, { headers: { "Cache-Control": "no-store" } });
}
