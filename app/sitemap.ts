import type { MetadataRoute } from "next";
import dealsJson from "@/public/data/deals.json";
import type { DealsFile } from "@/lib/types";

// The home page plus one link per deal city (the cheapest date), so each getaway is its own
// shareable, indexable page.
export default function sitemap(): MetadataRoute.Sitemap {
  const base = "https://atlas-kappa-wheat.vercel.app";
  const file = dealsJson as unknown as DealsFile;
  const seen = new Set<string>();
  const deals = file.deals.filter((d) => !seen.has(d.dstCity) && seen.add(d.dstCity)).slice(0, 200);
  const updated = file.updated ? new Date(file.updated) : new Date();
  return [
    { url: `${base}/`, lastModified: updated, changeFrequency: "daily", priority: 1 },
    ...deals.map((d) => ({
      url: `${base}/?deal=${encodeURIComponent(`${d.gw}|${d.dst}|${d.out}`)}`,
      lastModified: updated,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
  ];
}
