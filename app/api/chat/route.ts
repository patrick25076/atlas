import { convertToModelMessages, hasToolCall, stepCountIs, streamText, type UIMessage } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { atlasTools, chatContext, chatSystem, rememberOutput, TURN_SEARCH_BUDGET, type AgentContext } from "@/lib/agent-tools";
import { allowUsage, chatRateLimit } from "@/lib/usage-caps";

// POST /api/chat { messages: UIMessage[], context: { origin, gateways, home, month, today, been, prefs } }
// The conversation with Atlas: the whole history comes with every turn (the browser keeps it),
// the model streams its answer and calls the tools in lib/agent-tools.ts as it needs them.
// The loop stops after ten steps, or as soon as the agent asks the traveller a question with
// the ask tool: the widget needs the traveller's answer before anything else makes sense.
// One turn may spend TURN_SEARCH_BUDGET Kiwi searches in all (lib/agent-tools.ts counts them).
// walk_trips (the graph walk) and search (the one search, lib/search.ts) stream their progress
// lines to the browser as preliminary tool outputs; only the last answer reaches the model,
// without the raw result (search's raw TripResults draw the chat's trip cards).
export const maxDuration = 300;
/** The browser posts the whole thread; past this many bytes it is not a thread but a payload. */
const MAX_BODY_BYTES = 512 * 1024;
/**
 * What one turn may hand the model. The body cap alone let a single 500 KB message ride through up to ten model
 * steps (about 125k input tokens each), and the daily chat_turn cap counts turns, not that work. A traveller's message
 * is a few sentences: the newest one is refused past MAX_USER_CHARS, older ones are cut there, and the history the
 * model reads is kept under MAX_MODEL_HISTORY_BYTES with the oldest turns dropped first.
 */
const MAX_USER_CHARS = 4_000;
const MAX_MODEL_HISTORY_BYTES = 60 * 1024;

/** Every user text part cut to MAX_USER_CHARS (older turns only reach here; the newest is checked before). */
function capUserText(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "user") return m;
    let changed = false;
    const parts = m.parts.map((p) => {
      if (p.type !== "text" || p.text.length <= MAX_USER_CHARS) return p;
      changed = true;
      return { ...p, text: `${p.text.slice(0, MAX_USER_CHARS)} [cut]` };
    });
    return changed ? { ...m, parts } : m;
  });
}
/** The newest turns that fit in MAX_MODEL_HISTORY_BYTES, starting at a user message; the last message always stays. */
function fitHistory(messages: UIMessage[]): UIMessage[] {
  let out = messages;
  while (out.length > 1 && JSON.stringify(out).length > MAX_MODEL_HISTORY_BYTES) {
    out = out.slice(1);
    while (out.length > 1 && out[0].role !== "user") out = out.slice(1);
  }
  return out;
}
/** The characters of a message's text parts. */
const textLength = (m: UIMessage) => m.parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);

// Abuse limits (lib/usage-caps.ts, the security stream's): chatRateLimit is 30 turns an hour per
// address in this process, allowUsage("chat_turn") the site's daily ceiling on chat turns across
// instances (Postgres when configured). The address check runs first and costs nothing; the
// daily counter is counted only for a request that will really run the model.

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
  const rate = chatRateLimit(ip);
  if (!rate.ok) return Response.json({ error: "Too many messages this hour; try again later." }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.round(rate.retryAfter))) } });

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
  const newest = messages[messages.length - 1];
  if (newest.role === "user" && textLength(newest) > MAX_USER_CHARS) return Response.json({ error: `That message is too long; keep it under ${MAX_USER_CHARS.toLocaleString("en-GB")} characters.` }, { status: 413 });
  // The day's chat ceiling for the whole site: past it nobody's turn runs the model until tomorrow (UTC).
  const day = await allowUsage("chat_turn");
  if (!day.ok) return Response.json({ error: "Atlas has answered as many chats as it can today; try again tomorrow." }, { status: 429 });
  // The context (origin, airports, Been list, the traveller's day, the trip style) and the
  // system prompt are shared with the terminal CLI (scripts/atlas.ts): lib/agent-tools.ts builds
  // both. The trip style is believed only field by field (chatPrefs: nights a place clamped to
  // 1 to 14, each choice from its list, avoid words the walk can read), since anyone can post
  // this body and its words go into the system prompt.
  const ctx: AgentContext = chatContext(body.context as Record<string, unknown> | undefined);
  // CHAT_TURN_SEARCHES lowers the Kiwi searches one turn may spend (never raises it past
  // TURN_SEARCH_BUDGET): a knob for a test server or a day Kiwi is touchy. Every live tool,
  // walk_trips included, spends from this one budget, and a spent turn still answers from memory.
  const turnCap = Number(process.env.CHAT_TURN_SEARCHES);
  if (process.env.CHAT_TURN_SEARCHES?.trim() && Number.isFinite(turnCap) && turnCap >= 0) ctx.budget = { used: 0, max: Math.min(TURN_SEARCH_BUDGET, Math.round(turnCap)) };
  // Under next dev only, a test replay may lower (never raise) this one turn's searches with the header
  // x-atlas-turn-searches, so a scripted conversation stays inside a fixed number of live Kiwi searches.
  const testCap = process.env.NODE_ENV === "development" ? Number(request.headers.get("x-atlas-turn-searches") ?? "") : NaN;
  if (request.headers.has("x-atlas-turn-searches") && Number.isFinite(testCap) && testCap >= 0) ctx.budget = { used: 0, max: Math.min(ctx.budget?.max ?? TURN_SEARCH_BUDGET, Math.round(testCap)) };
  // The thread's latest route, deals and wild trip, replayed from the history before the
  // raw payloads are slimmed away, so "make it an itinerary" in a later turn plans what the
  // traveller saw (make_itinerary's from: last_route, last_deal, last_wild).
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.parts) {
      const tp = part as { type: string; state?: string; output?: unknown };
      if (tp.type.startsWith("tool-") && tp.state === "output-available") rememberOutput(ctx, tp.type.slice(5), tp.output);
    }
  }
  const bedrock = createAmazonBedrock({ region: (process.env.AWS_REGION ?? "us-west-2").trim() || "us-west-2", apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK?.trim() });
  const model = bedrock((process.env.ASK_MODEL ?? "us.openai.gpt-6-astra").trim());
  const system = chatSystem(ctx);

  const tools = atlasTools(ctx);
  // Incomplete tool calls (the traveller pressed Stop, or left the tab mid-search) are dropped
  // from the history instead of failing every later turn of the thread; `tools` lets each
  // tool's toModelOutput strip what the model does not need from past results.
  const result = streamText({
    model,
    system,
    messages: await convertToModelMessages(fitHistory(capUserText(slimHistory(messages))), { ignoreIncompleteToolCalls: true, tools }),
    tools,
    stopWhen: [stepCountIs(10), hasToolCall("ask")],
    maxOutputTokens: 1400,
  });
  return result.toUIMessageStreamResponse({ onError: errorLine });
}
