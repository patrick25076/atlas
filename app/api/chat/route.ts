import { convertToModelMessages, hasToolCall, stepCountIs, streamText, type UIMessage } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { atlasTools, OPEN_JAW_COUNTRIES, TURN_SEARCH_BUDGET, type AgentContext } from "@/lib/agent-tools";
import { nearestGateways } from "@/lib/geo";
import { beenLine, cleanCodes, excludedCountries, type BeenPrefs } from "@/lib/been";
import { TtlLru } from "@/lib/memo";
import airportsJson from "@/public/data/airports.json";
import countriesJson from "@/public/data/countries.json";
import type { Airport, CountryInfo } from "@/lib/types";

// POST /api/chat { messages: UIMessage[], context: { origin, gateways, home, month, today, been } }
// The conversation with Atlas: the whole history comes with every turn (the browser keeps it),
// the model streams its answer and calls the tools in lib/agent-tools.ts as it needs them.
// The loop stops after ten steps, or as soon as the agent asks the traveller a question with
// the ask tool: the widget needs the traveller's answer before anything else makes sense.
// One turn may spend TURN_SEARCH_BUDGET Kiwi searches in all (lib/agent-tools.ts counts them).
export const maxDuration = 300;
const AIRPORTS = airportsJson as unknown as Airport[];
const COUNTRIES = countriesJson as unknown as Record<string, CountryInfo>;
/** The browser posts the whole thread; past this many bytes it is not a thread but a payload. */
const MAX_BODY_BYTES = 512 * 1024;

/** Messages per address per hour. Bounded: ten thousand addresses at most, each forgotten an
 * hour after its first message (the entry is counted in place, so the hour runs from then). */
const MESSAGES_PER_HOUR = 80;
const hits = new TtlLru<{ n: number }>(10_000, 3_600_000);
function limited(ip: string): boolean {
  const h = hits.get(ip);
  if (!h) {
    hits.set(ip, { n: 1 });
    return false;
  }
  h.n++;
  return h.n > MESSAGES_PER_HOUR;
}

const monthName = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** Older tool outputs lose their `raw` payload (Deal arrays, a whole trip) before they reach
 * the model: the compact fields say the same, and the browser already has its copy. */
function slimHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      const tp = p as { type: string; state?: string; output?: unknown };
      if (!tp.type.startsWith("tool-") || tp.state !== "output-available" || !tp.output || typeof tp.output !== "object" || !("raw" in tp.output)) return p;
      changed = true;
      const { raw: _raw, ...rest } = tp.output as Record<string, unknown>;
      void _raw;
      return { ...p, output: rest } as typeof p;
    });
    return changed ? { ...m, parts } : m;
  });
}

/** What the browser shows when a turn fails: the reason, in one line, never a stack. */
function errorLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const flat = msg.replace(/\s+/g, " ").trim();
  if (!flat) return "The model did not answer; try again.";
  if (/throttl|429|too many/i.test(flat)) return "The model is busy right now; try again in a moment.";
  if (/credential|unauthori|403|401/i.test(flat)) return "The chat's model key was refused; the site owner needs to check it.";
  return flat.slice(0, 200);
}

export async function POST(request: Request) {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) return Response.json({ error: "The chat needs a model key (AWS_BEARER_TOKEN_BEDROCK)." }, { status: 503 });
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (limited(ip)) return Response.json({ error: "Too many messages this hour; try again later." }, { status: 429 });

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "The conversation is too large to send; start a new chat." }, { status: 413 });
  let body: { messages?: UIMessage[]; context?: Partial<AgentContext> };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ error: "The conversation is too large to send; start a new chat." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "JSON body with messages required" }, { status: 400 });
  }
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter((m) => m && typeof m === "object" && Array.isArray(m.parts)).slice(-40);
  if (!messages.length) return Response.json({ error: "messages required" }, { status: 400 });
  const c = body.context ?? {};
  const origin = c.origin && Number.isFinite(c.origin.lat) && Number.isFinite(c.origin.lon) ? { lat: c.origin.lat, lon: c.origin.lon, label: String(c.origin.label ?? "their location").slice(0, 60) } : undefined;
  const gateways = (Array.isArray(c.gateways) ? c.gateways : []).filter((g) => typeof g === "string" && /^[A-Z]{3}$/.test(g)).slice(0, 4);
  const home = /^[A-Z]{2}$/.test(c.home ?? "") ? c.home! : "RO";
  const month = c.month && /^\d{4}-\d{2}$/.test(c.month) ? c.month : undefined;
  // "Today" is the traveller's calendar day, which the browser sends (its local clock): in the
  // evening west of UTC the server is already on tomorrow, and a date widget would be rejected
  // as past. Only a day within one of the server's own is believed; else the server's day.
  const serverDay = new Date().toISOString().slice(0, 10);
  const given = typeof c.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.today) ? c.today : "";
  const today = given && Math.abs(Date.parse(given) - Date.parse(serverDay)) <= 86_400_000 ? given : serverDay;
  // The Been list (lib/been.ts) comes from the browser and is believed only as clean ISO2
  // codes; an empty list is no list. It is never stored here: it lives in the traveller's
  // browser and rides along with each turn.
  const rawBeen = c.been && typeof c.been === "object" ? (c.been as Partial<BeenPrefs>) : undefined;
  const beenCodes = rawBeen ? cleanCodes(rawBeen.countries) : [];
  const been: BeenPrefs | undefined = beenCodes.length ? { countries: beenCodes, newOnly: rawBeen?.newOnly === true } : undefined;
  const exclude = excludedCountries(been);
  const ctx: AgentContext = { origin, gateways, home, month, today, budget: { used: 0, max: TURN_SEARCH_BUDGET }, been, exclude };

  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());
  const airports = origin ? nearestGateways(AIRPORTS, origin.lat, origin.lon, { maxKm: 350, limit: 6 }).map((g) => `${g.airport.iata} ${g.airport.city ?? g.airport.name} (${g.driveMin} min drive${gateways.includes(g.airport.iata) ? ", searched nightly" : ""})`) : gateways;
  const mainAirports = (gateways.length ? gateways : ["OTP"]).join(", ");
  // The been line names the countries (not codes) so the model can talk about them; the rule
  // after it covers the thread. A "been there" said in the chat becomes an exclusion only
  // when the traveller wants new countries (the chip's "only new", or asked for in words):
  // with revisits fine, it is a record to mention, never a filter. A tool's exclude ADDS to
  // the chip's list, so the model can only ever narrow the search, and `allow` lifts named
  // countries for one search.
  const newOnly = !!been?.newOnly;
  const chatRule = newOnly
    ? "When the traveller says in the chat that they have been somewhere else too, pass those countries (ISO2 codes) as exclude to every search tool for the rest of the thread: exclude ADDS to their Been list, which always applies on its own, so pass only the new ones. When they say a country is fine again this time, pass it in allow for that search."
    : "When the traveller says in the chat that they have been somewhere, remember it as a record for the thread and mention when a suggestion is somewhere new to them; do NOT pass it as exclude, revisits are fine. Only when they ask for new countries ('somewhere new', 'nowhere I have been') pass the countries they named (ISO2 codes) as exclude to every search tool for the rest of the thread; when they say a country is fine again this time, pass it in allow for that search.";
  const beenRule = `${beenLine(been, (cc) => COUNTRIES[cc]?.name ?? cc)}${been ? " " : ""}${chatRule} Never propose a destination or an overnight stop in an excluded country; a layover or connection through one is fine and never a reason to drop a route. For a lasting setting, suggest the Been chip in the top bar once, in one short line.`;

  const system = `You are Atlas, a travel agent in a chat, and you act before you ask. Today is ${today} (${monthName(today)}). The traveller is in ${origin?.label ?? "an unknown place"}, home country ${COUNTRIES[home]?.name ?? home} (passport ${home}). Their airports: ${airports.join("; ") || "unknown"}. The airports searched nightly: ${mainAirports}.${month ? ` They have the month ${month} selected in the app.` : ""}

${beenRule}

The rule that matters most: when something is unsaid, assume the sensible default, state the assumption in one line, search, show results, and only then ask at most ONE question, always through the ask tool (a widget), never as prose. Never ask two things. Never answer about prices without a tool result from this turn. Never say "no deals in the data" without a live search.

Defaults when the traveller does not say:
- When: open or "anytime" means a price calendar, the next 6 months month by month (scan_cheapest). A period of dates means find_getaways with those dates. A single month means that month.
- How long: 2 to 4 nights for a weekend, 3 to 7 nights inside Europe, 7 to 14 nights long-haul (another continent), 14 nights for a wild loop, 2 months for a long stay. The tools pick these by distance when you leave nights out.
- Where from: all their nightly airports at once (the tools take several origins). Mention a nearby airport only when it beats theirs by a clear margin.
- Named destination not on the boards (San Francisco, Tokyo, Bali, a country): ONE scan_cheapest call. When the destination is in a big country (${OPEN_JAW_COUNTRIES.join(", ")}) set openJawFrom to that country in that same single call, so coming home from another big city is priced too; never a second scan_cheapest for the open-jaw. Then reprice_route on the best month if a precise day matters.
- Where is cheap to stay, hotel deals, hotels in general with no city named: hotel_deals (instant, from the nightly hotel snapshots). When it says it is warming up, say plainly that the hotel history is not there yet and how many nights it has; for a named city and dates use hotels_near.
- "Return from another city": open-jaw via openJawFrom (a country or city), not a question.
- A region word (Southeast Asia, the Balkans), "a loop", "a trip through": wild_trip with 14 nights unless told. A month or more somewhere: long_stay.
- Several people from different cities: group_trip at once with what is known, each person from their OWN city or airport; when a person's dates or airport are missing or the tool says a place is unknown, show the result for the others and ask with ONE people widget prefilled with what you know.
- Open "where could I go": cheapest_deals (tonight's boards, instant), then follow with find_getaways only when they give dates.
- Cool autumn, warm winter, beaches, food: pick the countries yourself (where as a comma list of at most four) rather than asking; use best_months when the traveller is flexible on when.

Working with results:
- Rank by price per night for comparable trips, and say why the winner wins (price, direct, better dates, the right airport). Show the best three, never ten.
- When the dates are open, show the price calendar: the months with their cheapest fare. The client draws it from the scan_cheapest result; you name the best month and the best dates in words.
- Name the one or two tradeoffs that matter: a better layover or direct for €20 more, a stopover programme when the route goes through Istanbul, Doha, Lisbon, Reykjavik, Helsinki or Singapore (stopover_programmes), a nearby airport, open-jaw home from another city.
- Mention the fare memory's verdict (price_insight on the winning route and month, with the price in hand) when it has history; skip it when it says unknown.
- Remember stated preferences for the whole thread: "that one", "the second", "make it direct", "from Cluj too" refer to what you showed. Keep them for later searches too.
- Prices are return fares in euros unless you say one-way; say when a price is live versus searched nightly. Be honest about gaps (events only in 20 cities, trains only in Europe, hotels in sandbox).
- A tool answering with { error } is a fact to state in one line, then carry on with the next best tool; never retry the same call unchanged more than once.
- plan_days takes the key object wild_trip returned, unchanged.

Searches cost: every live tool says how many Kiwi searches it makes, and a turn has ${TURN_SEARCH_BUDGET} in all; when a tool says the budget is used up, answer with what you have. Prefer one scan over many reprices; never call the same live tool twice with the same input in one turn.

Before a slow tool (scan_cheapest, find_getaways, wild_trip, long_stay, group_trip, plan_days) write one short line saying what you are searching and the assumption you made, then call it.

Style: plain words, short paragraphs, no bullet symbols, no headings, no em dashes (use commas or full stops), links as [text](url). Name the city, the price, the dates and the airport. End with the one question, if any, through the ask tool, and nothing after it.`;

  const tools = atlasTools(ctx);
  // Incomplete tool calls (the traveller pressed Stop, or left the tab mid-search) are dropped
  // from the history instead of failing every later turn of the thread; `tools` lets each
  // tool's toModelOutput strip what the model does not need from past results.
  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(slimHistory(messages), { ignoreIncompleteToolCalls: true, tools }),
    tools,
    stopWhen: [stepCountIs(10), hasToolCall("ask")],
    maxOutputTokens: 1400,
  });
  return result.toUIMessageStreamResponse({ onError: errorLine });
}
