// Server-only. What to see, do and eat somewhere, from the Wikivoyage guides (CC BY-SA 4.0):
// listings with coordinates and photos, the article's events section, and a country's "Do"
// section (the experiences a country is known for: the loops, cruises, treks, cooking classes).
const UA = "atlas travel globe (https://github.com/patrick25076/atlas)";

export type Sight = { kind: "see" | "do" | "eat" | "drink"; name: string; desc: string; lat?: number; lon?: number; image?: string; url?: string; wikidata?: string };
export type Sights = { title: string; url: string; see: Sight[]; do: Sight[]; eat: Sight[]; events: string[]; licence: string };

export function clean(wikitext: string): string {
  return wikitext
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+ ([^\]]+)\]/g, "$1")
    .replace(/\[https?:\/\/\S+\]/g, "")
    .replace(/'''?/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<ref[^/]*\/>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseListings(wikitext: string): Sight[] {
  const out: Sight[] = [];
  for (const m of wikitext.matchAll(/\{\{(see|do|eat|drink)\s*\|([\s\S]*?)\}\}(?=\s*(?:\n|\*|$))/gi)) {
    const kind = m[1].toLowerCase() as Sight["kind"];
    const fields: Record<string, string> = {};
    let depth = 0;
    let cur = "";
    const parts: string[] = [];
    const body = m[2];
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      const two = body.slice(i, i + 2);
      if (two === "[[" || two === "{{") depth++;
      if (two === "]]" || two === "}}") depth = Math.max(0, depth - 1);
      if (ch === "|" && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
    }
    const name = clean(fields.name ?? "");
    if (!name) continue;
    const lat = Number(fields.lat);
    const lon = Number(fields.long);
    const image = fields.image?.trim();
    out.push({
      kind,
      name,
      desc: clean(fields.content ?? "").slice(0, 220),
      lat: Number.isFinite(lat) && fields.lat ? lat : undefined,
      lon: Number.isFinite(lon) && fields.long ? lon : undefined,
      image: image ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(image.replace(/^File:/i, ""))}?width=360` : undefined,
      url: fields.url?.trim() || undefined,
      wikidata: fields.wikidata?.trim() || undefined,
    });
  }
  return out;
}

export function eventsSection(wikitext: string): string[] {
  const m = wikitext.match(/\n==+\s*(?:Events|Festivals|Events and festivals|Festivals and events|Annual events)\s*==+\n([\s\S]*?)(?=\n==[^=])/i);
  if (!m) return [];
  const text = m[1]
    .replace(/\{\{(?:do|see|listing|event)\s*\|([\s\S]*?)\}\}/gi, (_, body: string) => {
      const f: Record<string, string> = {};
      for (const part of body.split("|")) {
        const eq = part.indexOf("=");
        if (eq > 0) f[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
      }
      const when = [f.date, f.month].filter(Boolean).join(" ");
      return f.name ? `${f.name}${when ? ` (${when})` : ""}: ${f.content ?? ""}` : (f.content ?? "");
    })
    .replace(/\{\{[\s\S]*?\}\}/g, "");
  return text
    .split("\n")
    .map((l) => clean(l.replace(/^\*+\s*/, "")))
    .filter((l) => l.length > 20 && !/^\|/.test(l))
    .slice(0, 8);
}

/** A top-level section's prose, templates and listings flattened to lines. */
export function section(wikitext: string, names: string[]): string[] {
  const re = new RegExp(`\\n==\\s*(?:${names.join("|")})\\s*==\\n([\\s\\S]*?)(?=\\n==[^=]|$)`, "i");
  const m = wikitext.match(re);
  if (!m) return [];
  const text = m[1]
    .replace(/\{\{(?:do|see|listing)\s*\|([\s\S]*?)\}\}/gi, (_, body: string) => {
      const f: Record<string, string> = {};
      for (const part of body.split("|")) {
        const eq = part.indexOf("=");
        if (eq > 0) f[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
      }
      return f.name ? `${f.name}: ${f.content ?? ""}` : (f.content ?? "");
    })
    .replace(/\{\{[\s\S]*?\}\}/g, "");
  return text
    .split("\n")
    .map((l) => clean(l.replace(/^[=*#;:]+\s*/, "")))
    .filter((l) => l.length > 30 && !/^(thumb|thumbnail|left|right|upright)\b|\d+px\|/.test(l));
}

export async function wikitext(title: string): Promise<{ title: string; text: string } | null> {
  const res = await fetch(`https://en.wikivoyage.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&redirects=1`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    next: { revalidate: 7 * 86_400 },
  });
  if (!res.ok) {
    console.log(`sights: wikivoyage ${res.status} for ${title}`);
    return null;
  }
  const j = (await res.json()) as { parse?: { title: string; wikitext: { "*": string } }; error?: { code: string } };
  const text = j.parse?.wikitext["*"];
  if (!text || !j.parse) return null;
  return { title: j.parse.title, text };
}

/** Big cities are split into district articles ("Paris/1st arrondissement"); the listings live there. */
function districtTitles(text: string, title: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
    const t = m[1].trim();
    if (t.startsWith(`${title}/`)) out.add(t);
  }
  return [...out].slice(0, 6);
}

export async function getSights(name: string): Promise<Sights | null> {
  const page = await wikitext(name);
  if (!page) return null;
  let wt = page.text;
  let all = parseListings(wt);
  if (all.filter((s) => s.kind === "see").length < 4) {
    const districts = districtTitles(wt, page.title);
    const pages = await Promise.all(districts.map((d) => wikitext(d).catch(() => null)));
    for (const d of pages) {
      if (!d) continue;
      all = all.concat(parseListings(d.text));
      if (!wt.match(/\n==+\s*(?:Events|Festivals)/i) && d.text.match(/\n==+\s*(?:Events|Festivals)/i)) wt = d.text;
    }
  }
  const rank = (s: Sight) => (s.image ? 2 : 0) + (s.lat != null ? 1 : 0) + Math.min(1, s.desc.length / 120);
  const pick = (kind: Sight["kind"], n: number) => all.filter((s) => s.kind === kind).sort((a, b) => rank(b) - rank(a)).slice(0, n);
  return {
    title: page.title.split("/")[0],
    url: `https://en.wikivoyage.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    see: pick("see", 10),
    do: pick("do", 6),
    eat: pick("eat", 4),
    events: eventsSection(wt),
    licence: "Wikivoyage, CC BY-SA 4.0",
  };
}

/** What a country is known for doing and eating, from its Wikivoyage article: a few lines each. */
export async function countryGuide(countryName: string): Promise<{ do: string[]; eat: string[]; drink: string[]; respect: string[] } | null> {
  const page = await wikitext(countryName);
  if (!page) return null;
  const take = (lines: string[], n: number, max = 320) => lines.slice(0, n).map((l) => (l.length > max ? `${l.slice(0, max).replace(/\s+\S*$/, "")}…` : l));
  return {
    do: take(section(page.text, ["Do"]), 8),
    eat: take(section(page.text, ["Eat"]), 8),
    drink: take(section(page.text, ["Drink"]), 3),
    respect: take(section(page.text, ["Respect"]), 3, 240),
  };
}
