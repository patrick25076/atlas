import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { atlasTools, type AgentContext } from "@/lib/agent-tools";
import { nearestGateways } from "@/lib/geo";
import airportsJson from "@/public/data/airports.json";
import countriesJson from "@/public/data/countries.json";
import type { Airport, CountryInfo } from "@/lib/types";

// POST /api/chat { messages: UIMessage[], context: { origin, gateways, home, month } }
// The conversation with Atlas: the whole history comes with every turn (the browser keeps it),
// the model streams its answer and calls the tools in lib/agent-tools.ts as it needs them.
export const maxDuration = 300;
const AIRPORTS = airportsJson as unknown as Airport[];
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;

const hits = new Map<string, { n: number; at: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.at > 3_600_000) {
    hits.set(ip, { n: 1, at: now });
    return false;
  }
  h.n++;
  return h.n > 80;
}

export async function POST(request: Request) {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) return Response.json({ error: "The chat needs a model key (AWS_BEARER_TOKEN_BEDROCK)." }, { status: 503 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return Response.json({ error: "Too many messages this hour; try again later." }, { status: 429 });

  let body: { messages?: UIMessage[]; context?: Partial<AgentContext> };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON body with messages required" }, { status: 400 });
  }
  const messages = (body.messages ?? []).slice(-40);
  if (!messages.length) return Response.json({ error: "messages required" }, { status: 400 });
  const c = body.context ?? {};
  const origin = c.origin && Number.isFinite(c.origin.lat) && Number.isFinite(c.origin.lon) ? { lat: c.origin.lat, lon: c.origin.lon, label: String(c.origin.label ?? "their location").slice(0, 60) } : undefined;
  const gateways = (c.gateways ?? []).filter((g) => /^[A-Z]{3}$/.test(g)).slice(0, 4);
  const home = /^[A-Z]{2}$/.test(c.home ?? "") ? c.home! : "RO";
  const month = c.month && /^\d{4}-\d{2}$/.test(c.month) ? c.month : undefined;
  const today = new Date().toISOString().slice(0, 10);
  const ctx: AgentContext = { origin, gateways, home, month, today };

  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());
  const airports = origin ? nearestGateways(AIRPORTS, origin.lat, origin.lon, { maxKm: 350, limit: 6 }).map((g) => `${g.airport.iata} ${g.airport.city ?? g.airport.name} (${g.driveMin} min drive${gateways.includes(g.airport.iata) ? ", searched nightly" : ""})`) : gateways;

  const system = `You are Atlas, a travel agent in a chat. Today is ${today}. The traveller is in ${origin?.label ?? "an unknown place"}, home country ${COUNTRIES[home]?.name ?? home} (passport ${home}). Their airports: ${airports.join("; ") || "unknown"}.${month ? ` They have the month ${month} selected in the app.` : ""}

How to work:
- Understand the intent and keep the thread: "that one", "the second", "make it direct" refer to what you showed before. Remember stated preferences for the whole conversation.
- Use the tools for every fact and price; never invent a fare, date or rating. A period of dates means find_getaways with those exact dates (interpret "20 to 30 October" in the nearest future year). Open "where could I go" means cheapest_deals. Long far trips mean wild_trip, then plan_days when they want the days. "What to do, what to eat" means sights, eats_near, web_search. Combine tools freely in one turn.
- Before a slow tool (find_getaways, wild_trip, plan_days) say in one short line that you are searching live, then call it.
- Answer in plain words, short paragraphs, no bullet symbols, no headings, no em dashes (use commas or full stops). Links as [text](url). Name the city, the price, the dates and the airport. Prefer three strong options to a list of ten. After results, offer one or two useful refinements (direct only, other airport, another week, two cities). Ask a clarifying question only when the answer would change the search.
- Prices are return fares in euros unless you say one-way; say when a price is live versus searched nightly. Be honest when the data has a gap (events only in 20 cities, trains only in Europe, hotels in sandbox).`;

  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(messages),
    tools: atlasTools(ctx),
    stopWhen: stepCountIs(8),
    maxOutputTokens: 1200,
  });
  return result.toUIMessageStreamResponse();
}
