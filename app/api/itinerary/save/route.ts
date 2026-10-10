import { NextResponse } from "next/server";
import { hasStore, readJson, writeJson } from "@/lib/boards-store";
import { hasDb, saveTrip } from "@/lib/db";
import { bad } from "@/lib/params";
import { indexPathOf, ItineraryInputError, newSavedId, normaliseItinerary, ownerHash, ownerOf, savedItem, savedPathOf, type OwnerIndex, type SavedDoc } from "@/lib/itinerary-server";

// POST /api/itinerary/save  header x-atlas-owner: <the browser's id>  body { itinerary: Itinerary }
// Saves an itinerary under a new share id: { id, url: "/i/<id>" }. The itinerary is checked
// and capped the way the engine would have produced it (normaliseItinerary) before it is
// stored. Blob keeps it at itin/saved/<id>.json with a hash of the owner (the share link is
// public, the right to delete is not) and adds it to the owner's list; with DATABASE_URL the
// trips table keeps it too (kind "itinerary"). Saving twice makes two links; that is the
// point of a link. 0 Kiwi searches, no model calls.
export const maxDuration = 30;
const MAX_BODY = 600_000;
const MAX_INDEX = 100;

export async function POST(request: Request) {
  const owner = ownerOf(request);
  if (!owner) return bad("send the x-atlas-owner header: 8 to 64 letters, digits or hyphens");
  if (!hasStore() && !hasDb()) return NextResponse.json({ error: "saving needs storage, and none is configured here" }, { status: 503 });
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return bad("the itinerary is too large to save");
  let raw: unknown;
  try {
    raw = (JSON.parse(text) as { itinerary?: unknown })?.itinerary;
  } catch {
    return bad("send JSON: { itinerary }");
  }
  if (!raw || typeof raw !== "object") return bad("send JSON: { itinerary }");
  let itinerary;
  try {
    itinerary = normaliseItinerary(raw);
  } catch (err) {
    if (err instanceof ItineraryInputError) return bad(err.message);
    throw err;
  }
  if (!itinerary.days.length) return bad("the itinerary has no days yet; save it when it is written");
  const id = newSavedId();
  const savedAt = new Date().toISOString();
  let stored = false;
  try {
    if (hasStore()) {
      const doc: SavedDoc = { itinerary, ownerHash: ownerHash(owner), savedAt, generatedAt: savedAt };
      await writeJson(savedPathOf(id), doc);
      // The owner's list: read, add on top, write. Two saves in the same second from one
      // browser could race and drop one line from the list (never the itinerary itself).
      const index = await readJson<OwnerIndex>(indexPathOf(owner));
      const items = [savedItem(id, itinerary, savedAt), ...(index?.body?.items ?? []).filter((x) => x.id !== id)].slice(0, MAX_INDEX);
      await writeJson(indexPathOf(owner), { items, generatedAt: savedAt } satisfies OwnerIndex);
      stored = true;
    }
  } catch (err) {
    console.log(`itinerary save: blob ${err instanceof Error ? err.message.slice(0, 160) : err}`);
  }
  const inDb = hasDb() ? await saveTrip({ id, owner, kind: "itinerary", title: itinerary.title, body: itinerary }) : false;
  if (!stored && !inDb) return NextResponse.json({ error: "the itinerary could not be saved; try again in a minute" }, { status: 502 });
  return NextResponse.json({ id, url: `/i/${id}` }, { headers: { "Cache-Control": "no-store" } });
}
