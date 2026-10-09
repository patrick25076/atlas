import { NextResponse } from "next/server";

// GET /api/place?name=Bucharest → one paragraph about the place from Wikivoyage (CC BY-SA 4.0),
// fetched live and cached a day. Attribution and a link back are part of the answer.
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";

export type PlaceSummary = {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
  licence: string;
};

export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (!name || name.length > 80) return NextResponse.json({ error: "name required" }, { status: 400 });
  const title = encodeURIComponent(name.replace(/ /g, "_"));
  const res = await fetch(`https://en.wikivoyage.org/api/rest_v1/page/summary/${title}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: 86_400 },
  });
  if (!res.ok) return NextResponse.json(null, { headers: { "Cache-Control": "public, max-age=3600" } });
  const j = (await res.json()) as {
    title?: string;
    extract?: string;
    type?: string;
    content_urls?: { desktop?: { page?: string } };
    thumbnail?: { source?: string };
  };
  if (!j.extract || j.type === "disambiguation") return NextResponse.json(null, { headers: { "Cache-Control": "public, max-age=3600" } });
  const body: PlaceSummary = {
    title: j.title ?? name,
    extract: j.extract,
    url: j.content_urls?.desktop?.page ?? `https://en.wikivoyage.org/wiki/${title}`,
    thumbnail: j.thumbnail?.source,
    licence: "Wikivoyage, CC BY-SA 4.0",
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" } });
}
