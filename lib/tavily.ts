// Server-only. Live web research through Tavily (TAVILY_API_KEY, free developer tier): the
// planner and the Ask agent read current pages about food and experiences instead of relying
// on the model's memory. Results are cached a day per query. Every search counts against the
// daily Tavily cap (lib/usage-caps.ts); past it the answer is empty, as without a key.
import { allowUsage } from "./usage-caps";

export type WebHit = { title: string; url: string; content: string };

export function hasTavily(): boolean {
  return !!process.env.TAVILY_API_KEY?.trim();
}

export async function webSearch(query: string, max = 5): Promise<WebHit[]> {
  return (await webSearchWithReason(query, max)).hits;
}

/** The same search, with the reason when nothing could be searched ("daily limit reached", "no key"). */
export async function webSearchWithReason(query: string, max = 5): Promise<{ hits: WebHit[]; reason?: string }> {
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return { hits: [], reason: "no key" };
  const cap = await allowUsage("tavily");
  if (!cap.ok) return { hits: [], reason: "daily limit reached" };
  return { hits: await tavilySearch(key, query, max) };
}

async function tavilySearch(key: string, query: string, max: number): Promise<WebHit[]> {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: max, search_depth: "basic", include_answer: false }),
      next: { revalidate: 86_400 },
    });
    if (!r.ok) {
      console.log(`tavily: ${r.status} for "${query.slice(0, 60)}"`);
      return [];
    }
    const j = (await r.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (j.results ?? [])
      .filter((x) => x.url && x.content)
      .map((x) => ({ title: (x.title ?? "").slice(0, 120), url: x.url!, content: (x.content ?? "").replace(/\s+/g, " ").slice(0, 900) }));
  } catch (err) {
    console.log(`tavily: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
